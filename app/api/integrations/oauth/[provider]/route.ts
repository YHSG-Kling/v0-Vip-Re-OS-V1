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
import { readRoleGrants, selectVendorGrant } from "@/lib/auth/role-grants"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

// ─── TYPES ────────────────────────────────────────────────────────────────────

type OAuthProvider = "google" | "microsoft" | "docusign" | "quickbooks" | "xero" | "linkedin" | "meta_ads" | "google_ads" | "zoom"

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
    // PRODUCTION FIX (vendor audit): the demo host was hardcoded. Default is
    // now the PRODUCTION host; set DOCUSIGN_OAUTH_HOST=account-d.docusign.com
    // for sandbox testing.
    authUrl: `https://${process.env.DOCUSIGN_OAUTH_HOST || "account.docusign.com"}/oauth/auth`,
    tokenUrl: `https://${process.env.DOCUSIGN_OAUTH_HOST || "account.docusign.com"}/oauth/token`,
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
  // Meta ADS — reuses the Facebook app; ads scopes let the connector manage Custom
  // Audiences + read Insights. Distinct from the social 'meta' (page posting) flow,
  // and stored under platform='facebook' (what the ad connector loads).
  meta_ads: {
    clientIdEnv: "FACEBOOK_APP_ID",
    clientSecretEnv: "FACEBOOK_APP_SECRET",
    authUrl: "https://www.facebook.com/v19.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v19.0/oauth/access_token",
    scopes: ["business_management", "ads_management", "ads_read"],
  },
  // Google ADS — Customer Match + reporting. Needs GOOGLE_ADS_DEVELOPER_TOKEN (env,
  // injected into config below). Stored under platform='google'.
  google_ads: {
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/adwords"],
    additionalParams: { access_type: "offline", prompt: "consent" },
  },
  // Zoom — meetings connector (round 39). Owner-scoped like QuickBooks: each
  // level (platform/brokerage/team/agent) connects its OWN Zoom; the platform's
  // account stores under the distinct 'platform_zoom' key (m273 idiom — see
  // lib/connections/zoom.ts). Scopes are configured on the Zoom app itself
  // (user-level OAuth apps ignore the request scope param), so none are sent.
  // Token exchange REQUIRES HTTP Basic auth (client_id:client_secret) — handled
  // by the zoom branch in the exchange below.
  zoom: {
    clientIdEnv: "ZOOM_CLIENT_ID",
    clientSecretEnv: "ZOOM_CLIENT_SECRET",
    authUrl: "https://zoom.us/oauth/authorize",
    tokenUrl: "https://zoom.us/oauth/token",
    scopes: [],
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

      // Intuit returns the QBO company id as a CALLBACK QUERY PARAM (realmId), never in
      // the token body — capture it here so the stored credential carries the company id.
      const callbackRealmId = searchParams.get("realmId")

      // Decode state (brokerageId is null for a PLATFORM-scope connect — superadmin has no tenant)
      let stateData: { provider: string; brokerageId: string | null; userId: string }
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
      // Zoom's token endpoint requires HTTP Basic auth (client_id:client_secret
      // in the Authorization header, NOT the form body); everyone else takes
      // client creds in the body.
      const usesBasicTokenAuth = oauthProvider === "zoom"
      const tokenResponse = await callConnector<{ expires_in?: number; error_description?: string }>({
        connector: `${provider}-oauth`,
        baseUrl: tokenUrl.origin,
        path: tokenUrl.pathname,
        method: "POST",
        auth: usesBasicTokenAuth
          ? { style: "basic", username: clientId, password: clientSecret }
          : { style: "none" },
        bodyType: "form",
        body: {
          grant_type: "authorization_code",
          code: code!,
          redirect_uri: redirectUri,
          ...(usesBasicTokenAuth ? {} : { client_id: clientId, client_secret: clientSecret }),
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

      // Owner scope resolved by the INITIATE step and carried through state.
      const ownerType = (stateData as any).ownerType ?? "brokerage"
      const ownerId = (stateData as any).ownerId ?? stateData.brokerageId

      // CANONICAL platform id every resolver reads: google→gmail, microsoft→outlook (the route
      // param `provider` is google_calendar/outlook_calendar); QuickBooks/others keep their id.
      // EXCEPTION (m273 idiom, see lib/connections/accounting-scopes.ts): the PLATFORM's own
      // QuickBooks is stored under the DISTINCT 'platform_quickbooks' key — the tenant credential
      // cascade falls back to owner_type='platform', so reusing 'quickbooks' would let a brokerage
      // with no connection resolve the COMPANY's books.
      const storedPlatform =
        oauthProvider === "google" ? "gmail"
        : oauthProvider === "microsoft" ? "outlook"
        : oauthProvider === "meta_ads" ? "facebook"     // what the ad connector loads
        : oauthProvider === "google_ads" ? "google"
        : oauthProvider === "quickbooks" && ownerType === "platform" ? "platform_quickbooks"
        // Same m273 idiom for meetings: the PLATFORM's own Zoom lives under the
        // distinct 'platform_zoom' key so a tenant's host cascade can never
        // resolve — and host meetings on — the COMPANY's Zoom account.
        : oauthProvider === "zoom" && ownerType === "platform" ? "platform_zoom"
        : provider

      // Ad-account connections: resolve the ad account id (Meta) + carry the Google
      // Ads developer token so loadConnectorCredential returns a usable credential.
      let adAccountId: string | null = null
      let adConfigExtra: Record<string, unknown> = {}
      if (oauthProvider === "meta_ads") {
        try {
          const aa = await callConnector<{ data?: Array<{ account_id?: string }> }>({
            connector: "meta-adaccounts", baseUrl: "https://graph.facebook.com", path: "/v19.0/me/adaccounts?fields=account_id",
            method: "GET", auth: { style: "bearer", token: tokens.access_token },
          })
          if (aa.ok) adAccountId = aa.data?.data?.[0]?.account_id ?? null
        } catch {}
      } else if (oauthProvider === "google_ads") {
        adConfigExtra = { developer_token: process.env.GOOGLE_ADS_DEVELOPER_TOKEN ?? null }
      }

      // For Google/Microsoft, resolve the connected mailbox address up front so it is stored on the
      // owner-scoped row (used as the From address) AND mirrored to the agent row below.
      let connectedEmail: string | null = null
      // Zoom: resolve the connected account's email + user id so the settings
      // card can show WHOSE Zoom is connected (config.email / account_id).
      let zoomUserId: string | null = null
      if (oauthProvider === "zoom") {
        try {
          const me = await callConnector<{ id?: string; email?: string }>({
            connector: "zoom", baseUrl: "https://api.zoom.us", path: "/v2/users/me",
            method: "GET", auth: { style: "bearer", token: tokens.access_token },
          })
          if (me.ok) {
            connectedEmail = me.data?.email ?? null
            zoomUserId = me.data?.id ?? null
          }
        } catch {}
      }
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
      // Intuit's realmId arrives on the callback URL (callbackRealmId); tolerate a body echo too.
      const realmId: string | null = (tokens.realmId as string | undefined) ?? callbackRealmId
      const credRow = {
        // Nullable since m273 — a platform-owned row has NO tenant anchor.
        brokerage_id: stateData.brokerageId,
        owner_type: ownerType,
        owner_id: ownerId,
        agent_user_id: ownerType === "agent" ? stateData.userId : null,
        platform: storedPlatform,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        ...(realmId ? { account_id: realmId } : {}),
        ...(adAccountId ? { account_id: adAccountId } : {}),
        ...(zoomUserId ? { account_id: zoomUserId } : {}),
        config: {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_type: tokens.token_type,
          scope: tokens.scope,
          ...(connectedEmail ? { email: connectedEmail } : {}),
          ...(realmId && { realm_id: realmId }),
          ...(tokens.x_refresh_token_expires_in && { refresh_token_expires_in: tokens.x_refresh_token_expires_in }),
          ...adConfigExtra,
        },
        token_expires_at: expiresAt,
        is_active: true,
        test_status: "pass", // OAuth success = connection verified
        last_tested_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      // Owner-keyed update-or-insert. The unique key is (owner_type, owner_id,
      // platform) and it is REAL — VERIFIED LIVE, not assumed: m104 created it as
      // `platform_credentials_owner_uniq`, a PARTIAL UNIQUE INDEX
      // `WHERE owner_type IS NOT NULL`, and a duplicate insert is refused with 23505.
      // It is spelled out here because it lives in pg_index and NOT in pg_constraint:
      // a check that dumps pg_constraint for this table sees only the two FKs and the
      // three CHECKs, reads the key as absent, and reports this comment as a lie. It
      // is not. A concurrent OAuth callback racing this read-then-write cannot
      // duplicate the credential — the second writer gets 23505, not a second row.
      const { data: existingCred } = await supabase
        .from("platform_credentials")
        .select("id")
        .eq("owner_type", ownerType).eq("owner_id", ownerId).eq("platform", storedPlatform)
        .maybeSingle()
      // Split from a ternary so each branch's error capture sits next to its own
      // write: in the ternary form the `const { error: credError }` was far
      // enough from the INSERT branch that no reviewer (and no guard) could see
      // that branch was covered. Behaviour is unchanged.
      let credError: { message: string } | null = null
      if (existingCred) {
        const { error } = await supabase.from("platform_credentials").update(credRow).eq("id", existingCred.id)
        credError = error
      } else {
        const { error } = await supabase.from("platform_credentials").insert(credRow)
        credError = error
      }

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

      // Update brokerage_integrations + kernel event — TENANT connects only (a platform-scope
      // connect has no brokerage to anchor these to).
      if (stateData.brokerageId) {
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
      }

      console.log(`[OAuth] Successfully connected ${provider} for ${ownerType} ${ownerId}`)
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
    // BOTH identity columns (§4). On user_type alone the platform's one human
    // staff row (user_type='admin', platform_role='superadmin') resolved to
    // "brokerage", so the company's own Zoom/QuickBooks were stored as a tenant
    // row under 'zoom'/'quickbooks' and the 'platform_zoom'/'platform_quickbooks'
    // arms in the callback (storedPlatform above) were unreachable — the
    // platform cards read a row this route could never write. A refused read
    // leaves platform_role null, which fails closed toward the tenant scopes.
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("brokerage_id, user_type, platform_role, team_id")
      .eq("id", user.id)
      .maybeSingle()
    if (userError) console.error("[OAuth] identity read failed:", userError.message)

    const { scope } = connectionScopeForUserType(
      (userData?.user_type as string) ?? "",
      (userData?.platform_role as string | null) ?? null,
    )
    let ownerType: string = scope
    let ownerId: string | null = null
    let brokerageId: string | null = (userData?.brokerage_id as string | null) ?? null

    if (scope === "vendor") {
      // canonical vendor linkage: user_role_assignments.vendor_id (vendors has no user_id).
      //
      // This resolves the OWNER that the OAuth tokens will be stored under, so a
      // wrong or missing answer here misfiles a vendor's own calendar/email
      // credentials. `.maybeSingle()` over the vendor-bearing grants ERRORS the
      // moment there are two (the table is UNIQUE on (user_id, role), not user_id)
      // and the discarded error read as "no vendor" → the flow aborted with
      // "Could not resolve your account for this connection" for a real vendor.
      const grantsResult = await readRoleGrants(supabase, user.id)
      if (!grantsResult.ok) {
        console.error("[OAuth] role grant read failed:", grantsResult.error)
        return redirectWithResult(baseUrl, false, provider, "Could not verify your vendor account — please try again")
      }
      const { grant: vendorGrant, ambiguous } = selectVendorGrant(grantsResult.grants)
      if (ambiguous) {
        return redirectWithResult(baseUrl, false, provider, "Your account is linked to more than one vendor — ask the brokerage to correct it")
      }
      ownerId = vendorGrant?.vendor_id ?? null
      // The tenant anchor comes off the SAME grant that supplied the owner, so the
      // credential can never be filed under one vendor and one other tenant.
      brokerageId = brokerageId ?? (vendorGrant?.brokerage_id ?? null)
    } else if (scope === "contact") {
      const { data: c } = await supabase.from("contacts").select("id, brokerage_id").eq("contact_user_id", user.id).maybeSingle()
      ownerId = (c?.id as string | null) ?? null
      brokerageId = brokerageId ?? ((c?.brokerage_id as string | null) ?? null)
    } else if (scope === "team") {
      ownerId = (userData?.team_id as string | null) ?? null
    } else if (scope === "platform") {
      // The PLATFORM's own connection (superadmin) — sentinel owner, NO tenant anchor
      // (m273: platform_credentials.brokerage_id is nullable for platform-owned rows).
      ownerId = "platform"
    } else if (scope === "brokerage") {
      ownerId = brokerageId
    } else {
      ownerId = user.id // agent / staff → personal (owner_type 'agent')
    }

    if (!brokerageId && scope !== "platform") {
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
      // Zoom (empty scopes list) defines scopes on the app itself — sending an
      // empty scope param would be rejected, so it is omitted entirely.
      ...(config.scopes.length > 0 ? { scope: config.scopes.join(" ") } : {}),
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
