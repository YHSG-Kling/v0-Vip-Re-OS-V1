// ============================================================
// SYSTEM: L9.2 — Social Media OAuth Routes
// VIP Real Estate AI OS — Layer 9
// ============================================================
// GET: Handles both OAuth initiation and callback for social platforms
// - Without code param: Initiates OAuth flow (redirect to provider)
// - With code param: Handles OAuth callback (exchanges code for tokens)
// Stores tokens to: social_media_accounts (not platform_credentials)
// Supports: meta, linkedin, twitter, tiktok, youtube, pinterest, google_business
//
// PLATFORM SCOPE (company channels): the SAME route also connects the OS's OWN
// social accounts (the growth board's "Company channels"). Initiation carries
// ?platform_scope=<channel> (facebook|instagram|linkedin|youtube|x|tiktok),
// gated by the platform 'marketing' capability; the scope rides the CSRF state,
// and the callback stores tokens under platform scope in platform_credentials
// (owner_type='platform', platform='platform_social_<channel>' — m273) via
// lib/platform/platform-social.ts, then flips platform_social_accounts to
// 'connected'. One handshake implementation, two credential homes.
//
// Provider configs + authorize-URL building live in lib/social/oauth-config.ts
// (shared with the platform connect flow — no forked copies).

import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  SOCIAL_OAUTH_CONFIGS,
  buildSocialAuthorizeUrl,
  isSocialOAuthProvider,
  type SocialOAuthProvider,
} from "@/lib/social/oauth-config"
import {
  CHANNEL_OAUTH_PROVIDER,
  completePlatformChannelConnect,
  isPlatformSocialChannel,
} from "@/lib/platform/platform-social"
import { requirePlatformCapability } from "@/lib/platform/require-capability"
import { platformStaffCan } from "@/lib/platform/platform-staff-roster"

type SocialPlatform = SocialOAuthProvider

interface OAuthStateData {
  platform: string
  userId: string
  nonce: string
  /** 'platform' when connecting a COMPANY channel (superadmin growth board). */
  scope?: "platform"
  /** The company channel key when scope === 'platform'. */
  channel?: string
}

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function getBaseUrl(request: NextRequest): string {
  const host = request.headers.get("host") || "localhost:3000"
  const protocol = host.includes("localhost") ? "http" : "https"
  return `${protocol}://${host}`
}

function redirectWithResult(
  baseUrl: string,
  success: boolean,
  platform: string,
  error?: string
): NextResponse {
  const url = new URL("/dashboard/profile", baseUrl)
  url.searchParams.set("tab", "social")
  if (success) {
    url.searchParams.set("oauth_success", platform)
  } else {
    url.searchParams.set("oauth_error", error || "Connection failed")
    url.searchParams.set("provider", platform)
  }
  return NextResponse.redirect(url)
}

/** Platform-scope results land back on the growth board, not the tenant profile. */
function redirectPlatformResult(
  baseUrl: string,
  success: boolean,
  channel: string,
  error?: string
): NextResponse {
  const url = new URL("/dashboard/superadmin/growth", baseUrl)
  if (success) {
    url.searchParams.set("channel_connected", channel)
  } else {
    url.searchParams.set("channel_error", error || "Connection failed")
    url.searchParams.set("channel", channel)
  }
  return NextResponse.redirect(url)
}

/** Best-effort state decode (NOT trusted — only used to route error redirects
 *  to the right surface before CSRF verification happens). */
function tryDecodeState(state: string | null): OAuthStateData | null {
  if (!state) return null
  try {
    return JSON.parse(Buffer.from(state, "base64url").toString())
  } catch {
    return null
  }
}

// PKCE helpers (Twitter requires this)
function generateCodeVerifier(): string {
  const array = new Uint8Array(32)
  crypto.getRandomValues(array)
  return Buffer.from(array).toString("base64url")
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Buffer.from(digest).toString("base64url")
}

// ─── GET: OAuth Flow (Initiate or Callback) ───────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ platform: string }> }
) {
  const { platform: platformParam } = await params
  if (!isSocialOAuthProvider(platformParam)) {
    return NextResponse.json({ error: `Unknown social platform: ${platformParam}` }, { status: 400 })
  }
  const platform: SocialPlatform = platformParam
  const config = SOCIAL_OAUTH_CONFIGS[platform]

  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const oauthError = searchParams.get("error")
  const errorDescription = searchParams.get("error_description")
  const baseUrl = getBaseUrl(request)

  const supabase = await createClient()

  // ─── CALLBACK: Handle OAuth response ──────────────────────────────────────
  if (code || oauthError) {
    // Route error/failure redirects to the surface that STARTED the flow.
    const peek = tryDecodeState(state)
    const failRedirect = (error: string) =>
      peek?.scope === "platform" && peek.channel
        ? redirectPlatformResult(baseUrl, false, peek.channel, error)
        : redirectWithResult(baseUrl, false, platform, error)

    if (oauthError) {
      console.error(`[Social OAuth] Error from ${platform}: ${oauthError} — ${errorDescription}`)
      return failRedirect(errorDescription || oauthError)
    }

    if (!state) {
      return redirectWithResult(baseUrl, false, platform, "Invalid callback — missing state")
    }

    // Verify CSRF state
    const cookieStore = await cookies()
    const storedState = cookieStore.get("social_oauth_state")?.value
    if (!storedState || storedState !== state) {
      return failRedirect("Security validation failed — please try again")
    }
    cookieStore.delete("social_oauth_state")

    // Decode state
    let stateData: OAuthStateData
    try {
      stateData = JSON.parse(Buffer.from(state, "base64url").toString())
    } catch {
      return failRedirect("Invalid state format")
    }

    const clientId = process.env[config.clientIdEnv]
    const clientSecret = process.env[config.clientSecretEnv]
    if (!clientId || !clientSecret) {
      return failRedirect(`${config.displayName} OAuth not configured`)
    }

    const redirectUri = `${baseUrl}/api/social/oauth/${platform}`

    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: redirectUri,
      client_id: clientId,
      client_secret: clientSecret,
    })

    // Twitter PKCE: include code_verifier
    if (config.usePKCE) {
      const codeVerifier = cookieStore.get("social_oauth_verifier")?.value
      if (codeVerifier) {
        tokenParams.set("code_verifier", codeVerifier)
        cookieStore.delete("social_oauth_verifier")
      }
    }

    const tokenResponse = await fetch(config.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        // Twitter requires Basic Auth for token exchange
        ...(config.usePKCE && {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        }),
      },
      body: tokenParams.toString(),
    })

    if (!tokenResponse.ok) {
      const errData = await tokenResponse.json().catch(() => ({}))
      console.error(`[Social OAuth] Token exchange failed for ${platform}:`, errData)
      return failRedirect(
        errData.error_description || errData.message || "Failed to exchange code for tokens"
      )
    }

    const tokens = await tokenResponse.json()

    // ── PLATFORM SCOPE: store under the company's credential home ───────────
    if (stateData.scope === "platform") {
      const channel = stateData.channel
      if (!isPlatformSocialChannel(channel) || CHANNEL_OAUTH_PROVIDER[channel] !== platform) {
        return redirectWithResult(baseUrl, false, platform, "Invalid platform-scope state")
      }
      const svc = createServiceClient()
      // Defense in depth: the connecting user must STILL hold platform marketing.
      const { data: staffRow } = await svc
        .from("users").select("user_type, platform_role, email").eq("id", stateData.userId).maybeSingle()
      const role = (staffRow as any)?.platform_role ?? ((staffRow as any)?.user_type === "superadmin" ? "superadmin" : null)
      if (!platformStaffCan(role, "marketing")) {
        return redirectPlatformResult(baseUrl, false, channel, "Platform marketing access required")
      }

      const done = await completePlatformChannelConnect(svc, {
        channel,
        connectedBy: stateData.userId,
        tokens: {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? null,
          expiresInSeconds: tokens.expires_in ?? null,
        },
      })
      if (!done.ok) {
        console.error(`[Social OAuth] Platform-channel store failed for ${channel}:`, done.error)
        return redirectPlatformResult(baseUrl, false, channel, done.error)
      }

      // Audit the connect (append-only superadmin ledger; best-effort but
      // sentinel-ledgered — the silencer ratchet forbids swallowing losses).
      // A multi-Page Meta connect isn't done yet — the Page picker still has to
      // choose — so it audits (and redirects) as pending, never as connected.
      const { sentinelWrite } = await import("@/lib/kernel/write-sentinel")
      await sentinelWrite(svc, svc.from("superadmin_audit_log").insert({
        actor_user_id: stateData.userId,
        actor_email: (staffRow as any)?.email ?? "",
        action: done.pendingSelection ? "platform_social.connect_pending_page" : "platform_social.connected",
        target_type: "platform_social_account",
        target_id: channel,
        details: { provider: platform, accountName: done.accountName, ...(done.pendingSelection ? { pendingSelection: true } : {}) },
      }), { flow: "platform_social_connect", table: "superadmin_audit_log" })

      if (done.pendingSelection) {
        console.log(`[Social OAuth] COMPANY channel ${channel} (${platform}) awaits Page selection by ${stateData.userId}`)
        const url = new URL("/dashboard/superadmin/growth", baseUrl)
        url.searchParams.set("channel_pending", channel)
        return NextResponse.redirect(url)
      }

      console.log(`[Social OAuth] Connected COMPANY channel ${channel} (${platform}) by ${stateData.userId}`)
      return redirectPlatformResult(baseUrl, true, channel)
    }

    // ── TENANT SCOPE (original flow): social_media_accounts ─────────────────
    // pass 10: the live unique is (brokerage_id, platform, account_id) — the
    // old onConflict "user_id,platform" matched no index and errored on every
    // callback. Resolve the connecting user's brokerage; account_id keeps the
    // userId placeholder (the publisher fills the real one on first use), so
    // (brokerage_id, platform, account_id=userId) is unique per user.
    const { data: connectingUser } = await supabase
      .from("users").select("brokerage_id").eq("id", stateData.userId).maybeSingle()

    // Upsert into social_media_accounts
    const { error: upsertError } = await supabase
      .from("social_media_accounts")
      .upsert(
        {
          brokerage_id: (connectingUser as any)?.brokerage_id ?? null,
          user_id: stateData.userId,
          platform,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token ?? null,
          token_expires_at: tokens.expires_in
            ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
            : null,
          account_id: stateData.userId, // placeholder; real account_id fetched by publisher on first use
          account_name: config.displayName,
          is_active: true,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "brokerage_id,platform,account_id" }
      )

    if (upsertError) {
      console.error(`[Social OAuth] Failed to store ${platform} credentials:`, upsertError)
      return redirectWithResult(baseUrl, false, platform, "Failed to save credentials")
    }

    console.log(`[Social OAuth] Successfully connected ${platform} for user ${stateData.userId}`)
    return redirectWithResult(baseUrl, true, platform)
  }

  // ─── INITIATE: Start OAuth flow ───────────────────────────────────────────

  // Company-channel connect? (?platform_scope=<channel>) — capability-gated.
  const platformScopeChannel = searchParams.get("platform_scope")

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return platformScopeChannel
      ? redirectPlatformResult(baseUrl, false, platformScopeChannel, "Please log in to connect company channels")
      : redirectWithResult(baseUrl, false, platform, "Please log in to connect social accounts")
  }

  let stateScope: Pick<OAuthStateData, "scope" | "channel"> = {}
  if (platformScopeChannel) {
    if (!isPlatformSocialChannel(platformScopeChannel) || CHANNEL_OAUTH_PROVIDER[platformScopeChannel] !== platform) {
      return redirectPlatformResult(baseUrl, false, platformScopeChannel, `Channel '${platformScopeChannel}' does not ride the ${platform} OAuth app`)
    }
    const gate = await requirePlatformCapability("marketing", { requireWrite: true })
    if (!gate.ok) {
      return redirectPlatformResult(baseUrl, false, platformScopeChannel, gate.error ?? "Platform marketing access required")
    }
    stateScope = { scope: "platform", channel: platformScopeChannel }
  }

  const clientId = process.env[config.clientIdEnv]
  if (!clientId) {
    console.error(`[Social OAuth] Missing ${config.clientIdEnv} env var`)
    return platformScopeChannel
      ? redirectPlatformResult(baseUrl, false, platformScopeChannel, `${config.displayName} OAuth not configured — set ${config.clientIdEnv} / ${config.clientSecretEnv}`)
      : redirectWithResult(baseUrl, false, platform, `${config.displayName} OAuth not configured. Contact your administrator.`)
  }

  // CSRF state
  const stateData: OAuthStateData = { platform, userId: user.id, nonce: crypto.randomUUID(), ...stateScope }
  const newState = Buffer.from(JSON.stringify(stateData)).toString("base64url")

  const cookieStore = await cookies()
  cookieStore.set("social_oauth_state", newState, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  })

  const redirectUri = `${baseUrl}/api/social/oauth/${platform}`

  // PKCE for Twitter
  let codeChallenge: string | undefined
  if (config.usePKCE) {
    const codeVerifier = generateCodeVerifier()
    codeChallenge = await generateCodeChallenge(codeVerifier)
    cookieStore.set("social_oauth_verifier", codeVerifier, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    })
  }

  const authUrl = buildSocialAuthorizeUrl(platform, { clientId, redirectUri, state: newState, codeChallenge })
  console.log(`[Social OAuth] Initiating ${platform} OAuth for user ${user.id}${platformScopeChannel ? ` (company channel ${platformScopeChannel})` : ""}`)
  return NextResponse.redirect(authUrl)
}
