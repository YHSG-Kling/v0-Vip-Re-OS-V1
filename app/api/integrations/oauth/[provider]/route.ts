// ============================================================
// SYSTEM: L11-S03 — OAuth Integration Routes
// VIP Real Estate AI OS — Layer 11
// ============================================================
// GET: Handles both OAuth initiation and callback
// - Without code param: Initiates OAuth flow (redirect to provider)
// - With code param: Handles OAuth callback (exchanges code for tokens)
// Auth-gated, supports Google, Microsoft, DocuSign, QuickBooks, Xero

import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { createClient } from "@/lib/supabase/server"
import { processKernelEvent } from "@/lib/kernel/notification-engine"
import { KernelEvent } from "@/lib/kernel/events"
import { PROVIDER_METADATA, type ProviderName } from "@/lib/onboarding/integration-tester"
import { connectionScopeForUserType } from "@/lib/connections/field-spec"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

// ─── TYPES ────────────────────────────────────────────────────────────────────

type OAuthProvider = "google" | "microsoft" | "docusign" | "quickbooks" | "xero" | "linkedin"

interface OAuthConfig {
  clientIdEnv: string
  clientSecretEnv: string
  authUrl: string
  tokenUrl: string
  scopes: string[]
  additionalParams?: Record<string, string>
}

// ─── OAUTH PROVIDER CONFIGS ───────────────────────────────────────────────────

const OAUTH_CONFIGS: Record<OAuthProvider, OAuthConfig> = {
  google: {
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    // Calendar + Gmail send/read for agent personal mailbox integration.
    // openid/email/profile let us identify the connecting account address.
    scopes: [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/calendar.events",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
    additionalParams: {
      access_type: "offline",
      prompt: "consent",
    },
  },
  microsoft: {
    clientIdEnv: "MICROSOFT_CLIENT_ID",
    clientSecretEnv: "MICROSOFT_CLIENT_SECRET",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    scopes: [
      "offline_access",
      "User.Read",
      "Calendars.ReadWrite",
      "Mail.Send",
      "Mail.ReadWrite",
    ],
  },
  docusign: {
    clientIdEnv: "DOCUSIGN_INTEGRATION_KEY",
    clientSecretEnv: "DOCUSIGN_SECRET_KEY",
    authUrl: "https://account-d.docusign.com/oauth/auth", // Demo environment
    tokenUrl: "https://account-d.docusign.com/oauth/token",
    scopes: ["signature", "extended"],
  },
  quickbooks: {
    clientIdEnv: "QUICKBOOKS_CLIENT_ID",
    clientSecretEnv: "QUICKBOOKS_CLIENT_SECRET",
    authUrl: "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    scopes: ["com.intuit.quickbooks.accounting"],
  },
  xero: {
    clientIdEnv: "XERO_CLIENT_ID",
    clientSecretEnv: "XERO_CLIENT_SECRET",
    authUrl: "https://login.xero.com/identity/connect/authorize",
    tokenUrl: "https://identity.xero.com/connect/token",
    scopes: ["offline_access", "accounting.transactions", "accounting.contacts"],
  },
  linkedin: {
    clientIdEnv: "LINKEDIN_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    // w_member_social: publish posts; r_basicprofile + r_emailaddress: identity
    scopes: ["r_basicprofile", "r_emailaddress", "w_member_social"],
  },
}

// ─── HELPER: Get base URL ─────────────────────────────────────────────────────

function getBaseUrl(request: NextRequest): string {
  const host = request.headers.get("host") || "localhost:3000"
  const protocol = host.includes("localhost") ? "http" : "https"
  return `${protocol}://${host}`
}

// ─── HELPER: Redirect with result ─────────────────────────────────────────────

function redirectWithResult(
  baseUrl: string,
  success: boolean,
  provider: string,
  error?: string
): NextResponse {
  const redirectUrl = new URL("/dashboard/onboarding/tech-stack", baseUrl)
  if (success) {
    redirectUrl.searchParams.set("oauth_success", "true")
    redirectUrl.searchParams.set("provider", provider)
  } else {
    redirectUrl.searchParams.set("oauth_error", error || "Connection failed")
    redirectUrl.searchParams.set("provider", provider)
  }
  return NextResponse.redirect(redirectUrl)
}

// ─── GET: OAuth Flow (Initiate or Callback) ───────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  try {
    const { provider: providerParam } = await params
    const provider = providerParam as ProviderName
    const searchParams = request.nextUrl.searchParams
    const code = searchParams.get("code")
    const state = searchParams.get("state")
    const oauthError = searchParams.get("error")
    const errorDescription = searchParams.get("error_description")
    const baseUrl = getBaseUrl(request)

    const supabase = await createClient()

    // Validate provider
    const metadata = PROVIDER_METADATA[provider]
    if (!metadata || !metadata.isOAuth || !metadata.oauthProvider) {
      return NextResponse.json(
        { error: `Provider ${provider} does not support OAuth` },
        { status: 400 }
      )
    }

    const oauthProvider = metadata.oauthProvider as OAuthProvider
    const config = OAUTH_CONFIGS[oauthProvider]

    // ─── CALLBACK: Handle OAuth response ──────────────────────────────────────
    if (code || oauthError) {
      // Handle OAuth errors
      if (oauthError) {
        console.error(`[OAuth] Error from provider: ${oauthError} - ${errorDescription}`)
        return redirectWithResult(baseUrl, false, provider, errorDescription || oauthError)
      }

      if (!state) {
        console.error("[OAuth] Missing state parameter in callback")
        return redirectWithResult(baseUrl, false, provider, "Invalid callback - missing state")
      }

      // Verify state from cookie
      const cookieStore = await cookies()
      const storedState = cookieStore.get("oauth_state")?.value

      if (!storedState || storedState !== state) {
        console.error("[OAuth] State mismatch - possible CSRF attack")
        return redirectWithResult(baseUrl, false, provider, "Security validation failed - please try again")
      }

      // Clear state cookie
      cookieStore.delete("oauth_state")

      // Decode state
      let stateData: { provider: string; brokerageId: string; userId: string }
      try {
        stateData = JSON.parse(Buffer.from(state, "base64url").toString())
      } catch {
        return redirectWithResult(baseUrl, false, provider, "Invalid state format")
      }

      // Get client credentials
      const clientId = process.env[config.clientIdEnv]
      const clientSecret = process.env[config.clientSecretEnv]

      if (!clientId || !clientSecret) {
        console.error(`[OAuth] Missing credentials for ${oauthProvider}`)
        return redirectWithResult(baseUrl, false, provider, "OAuth not properly configured")
      }

      // Build redirect URI (must match what was used in auth request)
      const redirectUri = `${baseUrl}/api/integrations/oauth/${provider}`

      // Exchange code for tokens (through the connector-gateway). config.tokenUrl is a full URL —
      // split into origin + pathname so the gateway hits the exact endpoint (no trailing-slash drift).
      const tokenUrl = new URL(config.tokenUrl)
      const tokenResponse = await callConnector<{ expires_in?: number; error_description?: string }>({
        connector: `${provider}-oauth`,
        baseUrl: tokenUrl.origin,
        path: tokenUrl.pathname,
        method: "POST",
        auth: { style: "none" },
        bodyType: "form",
        body: {
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        },
      })

      if (!tokenResponse.ok) {
        console.error("[OAuth] Token exchange failed:", tokenResponse.error)
        return redirectWithResult(
          baseUrl,
          false,
          provider,
          tokenResponse.error || "Failed to exchange code for tokens"
        )
      }

      const tokens = tokenResponse.data as any

      // Calculate token expiry
      const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null

      // CANONICAL platform id every resolver reads: google→gmail, microsoft→outlook (the route
      // param `provider` is google_calendar/outlook_calendar); QuickBooks/others keep their id.
      const storedPlatform =
        oauthProvider === "google" ? "gmail"
        : oauthProvider === "microsoft" ? "outlook"
        : provider

      // For Google/Microsoft, resolve the connected mailbox address up front so it is stored on the
      // owner-scoped row (used as the From address) AND mirrored to the agent row below.
      let connectedEmail: string | null = null
      if (oauthProvider === "google" || oauthProvider === "microsoft") {
        try {
          if (oauthProvider === "google") {
            const ui = await callConnector<{ email?: string }>({
              connector: "google-userinfo", baseUrl: "https://openidconnect.googleapis.com", path: "/v1/userinfo",
              method: "GET", auth: { style: "bearer", token: tokens.access_token },
            })
            if (ui.ok) connectedEmail = ui.data?.email ?? null
          } else {
            const ui = await callConnector<{ mail?: string; userPrincipalName?: string }>({
              connector: "microsoft-graph", baseUrl: "https://graph.microsoft.com", path: "/v1.0/me",
              method: "GET", auth: { style: "bearer", token: tokens.access_token },
            })
            if (ui.ok) connectedEmail = ui.data?.mail ?? ui.data?.userPrincipalName ?? null
          }
        } catch {}
      }

      // Store tokens OWNER-SCOPED in platform_credentials (owner_type/owner_id from the state the
      // initiate resolved from the connecting user's role) so a vendor/contact/agent connects their
      // OWN mailbox and it resolves via the owner cascade. Canonical token columns are what every
      // resolver reads; account_id carries the QBO realmId; config keeps the same fields for compat.
      const ownerType = (stateData as any).ownerType ?? "brokerage"
      const ownerId = (stateData as any).ownerId ?? stateData.brokerageId
      const credRow = {
        brokerage_id: stateData.brokerageId,
        owner_type: ownerType,
        owner_id: ownerId,
        agent_user_id: ownerType === "agent" ? stateData.userId : null,
        platform: storedPlatform,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        ...(tokens.realmId ? { account_id: tokens.realmId } : {}),
        config: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_type: tokens.token_type,
          scope: tokens.scope,
          ...(connectedEmail ? { email: connectedEmail } : {}),
          ...(tokens.realmId && { realm_id: tokens.realmId }),
          ...(tokens.x_refresh_token_expires_in && { refresh_token_expires_in: tokens.x_refresh_token_expires_in }),
        },
        token_expires_at: expiresAt,
        is_active: true,
        test_status: "pass", // OAuth success = connection verified
        last_tested_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      // Owner-keyed update-or-insert (the unique key is (owner_type, owner_id, platform)).
      const { data: existingCred } = await supabase
        .from("platform_credentials")
        .select("id")
        .eq("owner_type", ownerType).eq("owner_id", ownerId).eq("platform", storedPlatform)
        .maybeSingle()
      const { error: credError } = existingCred
        ? await supabase.from("platform_credentials").update(credRow).eq("id", existingCred.id)
        : await supabase.from("platform_credentials").insert(credRow)

      if (credError) {
        console.error("[OAuth] Failed to store credentials:", credError)
        return redirectWithResult(baseUrl, false, provider, "Failed to store credentials")
      }

      // For an AGENT connecting Google/Microsoft, ALSO mirror to agent_api_credentials so the
      // personal-email adapter's agent path sends from their mailbox. ONLY for owner_type 'agent'
      // — a vendor/contact/team/brokerage owner must NOT get a personal agent mailbox row.
      if ((oauthProvider === "google" || oauthProvider === "microsoft") && ownerType === "agent") {
        try {
          const { data: agentRow } = await supabase.from("agents").select("id").eq("user_id", stateData.userId).maybeSingle()
          if (agentRow?.id) {
            await supabase
              .from("agent_api_credentials")
              .upsert(
                {
                  agent_id: agentRow.id,
                  brokerage_id: stateData.brokerageId,
                  service_name: storedPlatform,
                  service_type: "personal_email",
                  access_token: tokens.access_token,
                  refresh_token: tokens.refresh_token,
                  token_expires_at: expiresAt,
                  config: { email: connectedEmail, scope: tokens.scope },
                  is_active: true,
                  updated_at: new Date().toISOString(),
                },
                { onConflict: "agent_id,service_name" }
              )
          }
        } catch (agentCredErr) {
          console.error("[OAuth] Failed to mirror agent-scoped credential:", agentCredErr)
          // Non-fatal — owner-scoped token is still saved
        }
      }

      // Update brokerage_integrations
      await supabase
        .from("brokerage_integrations")
        .upsert({
          brokerage_id: stateData.brokerageId,
          provider_type: metadata.providerType,
          provider_name: provider,
          status: "connected",
          last_health_check_at: new Date().toISOString(),
          last_error: null,
          updated_at: new Date().toISOString(),
        }, {
          onConflict: "brokerage_id,provider_name",
        })

      // Fire kernel event
      await processKernelEvent({
        event: KernelEvent.INTEGRATION_CONNECTED,
        brokerageId: stateData.brokerageId,
        entityType: "platform_credentials",
        entityId: stateData.brokerageId,
        
      }).catch(err => {
        console.error("[OAuth] Kernel event failed (non-blocking):", err)
      })

      console.log(`[OAuth] Successfully connected ${provider} for brokerage ${stateData.brokerageId}`)
      return redirectWithResult(baseUrl, true, provider)
    }

    // ─── INITIATE: Start OAuth flow ───────────────────────────────────────────

    // Verify session
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return redirectWithResult(baseUrl, false, provider, "Please log in to connect integrations")
    }

    // Get client credentials from environment
    const clientId = process.env[config.clientIdEnv]
    if (!clientId) {
      console.error(`[OAuth] Missing ${config.clientIdEnv} environment variable`)
      return redirectWithResult(baseUrl, false, provider, `OAuth not configured for ${metadata.displayName}`)
    }

    // Resolve the connecting actor's OWNER scope so the callback stores tokens owner-scoped
    // (agent/team/brokerage/staff/vendor/contact) — not always brokerage. This is what lets a
    // vendor/contact connect their OWN email/calendar and have it resolve via the owner cascade.
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id, user_type, team_id")
      .eq("id", user.id)
      .maybeSingle()

    const { scope } = connectionScopeForUserType((userData?.user_type as string) ?? "")
    let ownerType: string = scope
    let ownerId: string | null = null
    let brokerageId: string | null = (userData?.brokerage_id as string | null) ?? null

    if (scope === "vendor") {
      const { data: v } = await supabase.from("vendors").select("id, brokerage_id").eq("user_id", user.id).maybeSingle()
      ownerId = (v?.id as string | null) ?? null
      brokerageId = brokerageId ?? ((v?.brokerage_id as string | null) ?? null)
    } else if (scope === "contact") {
      const { data: c } = await supabase.from("contacts").select("id, brokerage_id").eq("contact_user_id", user.id).maybeSingle()
      ownerId = (c?.id as string | null) ?? null
      brokerageId = brokerageId ?? ((c?.brokerage_id as string | null) ?? null)
    } else if (scope === "team") {
      ownerId = (userData?.team_id as string | null) ?? null
    } else if (scope === "brokerage" || scope === "platform") {
      ownerId = brokerageId
    } else {
      ownerId = user.id // agent / staff → personal (owner_type 'agent')
    }

    if (!brokerageId) {
      return redirectWithResult(baseUrl, false, provider, "User not associated with a brokerage")
    }
    if (!ownerId) {
      return redirectWithResult(baseUrl, false, provider, "Could not resolve your account for this connection")
    }

    // Generate state for CSRF protection (carries the resolved owner scope through the callback).
    const newState = Buffer.from(JSON.stringify({
      provider,
      brokerageId,
      userId: user.id,
      ownerType,
      ownerId,
      nonce: crypto.randomUUID(),
    })).toString("base64url")

    // Store state in cookie for verification
    const cookieStore = await cookies()
    cookieStore.set("oauth_state", newState, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600, // 10 minutes
      path: "/",
    })

    // Build redirect URI
    const redirectUri = `${baseUrl}/api/integrations/oauth/${provider}`

    // Build authorization URL
    const authParams = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: config.scopes.join(" "),
      state: newState,
      ...config.additionalParams,
    })

    const authUrl = `${config.authUrl}?${authParams.toString()}`

    console.log(`[OAuth] Redirecting to ${oauthProvider} for ${provider}`)
    return NextResponse.redirect(authUrl)
  } catch (error) {
    console.error("[OAuth] Error:", error)
    const baseUrl = getBaseUrl(request)
    const { provider } = await params
    return redirectWithResult(baseUrl, false, provider, "Internal server error")
  }
}
