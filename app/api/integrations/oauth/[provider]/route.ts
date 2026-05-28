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

      // Exchange code for tokens
      const tokenParams = new URLSearchParams({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
      })

      const tokenResponse = await fetch(config.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: tokenParams.toString(),
      })

      if (!tokenResponse.ok) {
        const errorData = await tokenResponse.json().catch(() => ({}))
        console.error("[OAuth] Token exchange failed:", errorData)
        return redirectWithResult(
          baseUrl, 
          false, 
          provider, 
          errorData.error_description || "Failed to exchange code for tokens"
        )
      }

      const tokens = await tokenResponse.json()

      // Calculate token expiry
      const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : null

      // Store tokens in platform_credentials
      const { error: credError } = await supabase
        .from("platform_credentials")
        .upsert({
          brokerage_id: stateData.brokerageId,
          owner_type: "brokerage",
          owner_id: stateData.brokerageId,
          platform: provider,
          // Canonical token columns — what every resolver (resolveScopedConnection / connection-
          // manager) reads. account_id carries the QBO realmId (company id). config keeps the same
          // fields for back-compat + provider extras.
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          ...(tokens.realmId ? { account_id: tokens.realmId } : {}),
          config: {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            token_type: tokens.token_type,
            scope: tokens.scope,
            // Provider-specific fields
            ...(tokens.realmId && { realm_id: tokens.realmId }),
            ...(tokens.x_refresh_token_expires_in && {
              refresh_token_expires_in: tokens.x_refresh_token_expires_in
            }),
          },
          token_expires_at: expiresAt,
          is_active: true,
          test_status: "pass", // OAuth success = connection verified
          last_tested_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, {
          onConflict: "brokerage_id,platform",
        })

      if (credError) {
        console.error("[OAuth] Failed to store credentials:", credError)
        return redirectWithResult(baseUrl, false, provider, "Failed to store credentials")
      }

      // For Google + Microsoft: ALSO persist agent-scoped tokens to
      // agent_api_credentials so the personal-email adapter can send
      // mail through this agent's actual mailbox. Each agent connects
      // their own account, so this is per-agent (not per-brokerage).
      const oauthProvKey = String(provider)
      if (oauthProvKey === "google" || oauthProvKey === "microsoft") {
        try {
          const { data: agentRow } = await supabase
            .from("agents")
            .select("id")
            .eq("user_id", stateData.userId)
            .maybeSingle()

          // Resolve the email address from a userinfo lookup so the agent
          // sees which mailbox is connected
          let connectedEmail: string | null = null
          try {
            if (oauthProvKey === "google") {
              const ui = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
              })
              if (ui.ok) connectedEmail = (await ui.json())?.email ?? null
            } else {
              const ui = await fetch("https://graph.microsoft.com/v1.0/me", {
                headers: { Authorization: `Bearer ${tokens.access_token}` },
              })
              if (ui.ok) {
                const me = await ui.json()
                connectedEmail = me?.mail ?? me?.userPrincipalName ?? null
              }
            }
          } catch {}

          if (agentRow?.id) {
            const serviceName = oauthProvKey === "google" ? "gmail" : "outlook"
            await supabase
              .from("agent_api_credentials")
              .upsert(
                {
                  agent_id: agentRow.id,
                  brokerage_id: stateData.brokerageId,
                  service_name: serviceName,
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
          // Non-fatal — brokerage-level token is still saved
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

    // Get user's brokerage_id
    const { data: userData } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", user.id)
      .single()

    if (!userData?.brokerage_id) {
      return redirectWithResult(baseUrl, false, provider, "User not associated with a brokerage")
    }

    // Generate state for CSRF protection
    const newState = Buffer.from(JSON.stringify({
      provider,
      brokerageId: userData.brokerage_id,
      userId: user.id,
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
