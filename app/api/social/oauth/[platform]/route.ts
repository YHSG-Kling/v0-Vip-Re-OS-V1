// ============================================================
// SYSTEM: L9.2 — Social Media OAuth Routes
// VIP Real Estate AI OS — Layer 9
// ============================================================
// GET: Handles both OAuth initiation and callback for social platforms
// - Without code param: Initiates OAuth flow (redirect to provider)
// - With code param: Handles OAuth callback (exchanges code for tokens)
// Stores tokens to: social_media_accounts (not platform_credentials)
// Supports: meta, linkedin, twitter, tiktok, youtube, pinterest, google_business

import { NextRequest, NextResponse } from "next/server"
import { cookies } from "next/headers"
import { createClient } from "@/lib/supabase/server"

// ─── TYPES ────────────────────────────────────────────────────────────────────

type SocialPlatform =
  | "meta"
  | "linkedin"
  | "twitter"
  | "tiktok"
  | "youtube"
  | "pinterest"
  | "google_business"

interface SocialOAuthConfig {
  displayName: string
  clientIdEnv: string
  clientSecretEnv: string
  authUrl: string
  tokenUrl: string
  scopes: string[]
  usePKCE?: boolean
  additionalParams?: Record<string, string>
}

// ─── PLATFORM CONFIGS ─────────────────────────────────────────────────────────

const SOCIAL_OAUTH_CONFIGS: Record<SocialPlatform, SocialOAuthConfig> = {
  meta: {
    displayName: "Meta (Facebook & Instagram)",
    clientIdEnv: "FACEBOOK_APP_ID",
    clientSecretEnv: "FACEBOOK_APP_SECRET",
    authUrl: "https://www.facebook.com/v18.0/dialog/oauth",
    tokenUrl: "https://graph.facebook.com/v18.0/oauth/access_token",
    scopes: [
      "pages_show_list",
      "pages_manage_posts",
      "pages_read_engagement",
      "instagram_basic",
      "instagram_content_publish",
    ],
  },
  linkedin: {
    displayName: "LinkedIn",
    clientIdEnv: "LINKEDIN_CLIENT_ID",
    clientSecretEnv: "LINKEDIN_CLIENT_SECRET",
    authUrl: "https://www.linkedin.com/oauth/v2/authorization",
    tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken",
    scopes: ["w_member_social", "r_liteprofile"],
  },
  twitter: {
    displayName: "Twitter / X",
    clientIdEnv: "TWITTER_CLIENT_ID",
    clientSecretEnv: "TWITTER_CLIENT_SECRET",
    authUrl: "https://twitter.com/i/oauth2/authorize",
    tokenUrl: "https://api.twitter.com/2/oauth2/token",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    usePKCE: true,
  },
  tiktok: {
    displayName: "TikTok",
    clientIdEnv: "TIKTOK_CLIENT_KEY",
    clientSecretEnv: "TIKTOK_CLIENT_SECRET",
    authUrl: "https://www.tiktok.com/v2/auth/authorize",
    tokenUrl: "https://open.tiktokapis.com/v2/oauth/token/",
    scopes: ["user.info.basic", "video.publish", "video.upload"],
  },
  youtube: {
    displayName: "YouTube",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    additionalParams: { access_type: "offline", prompt: "consent" },
  },
  pinterest: {
    displayName: "Pinterest",
    clientIdEnv: "PINTEREST_APP_ID",
    clientSecretEnv: "PINTEREST_APP_SECRET",
    authUrl: "https://www.pinterest.com/oauth/",
    tokenUrl: "https://api.pinterest.com/v5/oauth/token",
    scopes: ["boards:read", "pins:read", "pins:write"],
  },
  google_business: {
    displayName: "Google Business Profile",
    clientIdEnv: "GOOGLE_CLIENT_ID",
    clientSecretEnv: "GOOGLE_CLIENT_SECRET",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    scopes: ["https://www.googleapis.com/auth/business.manage"],
    additionalParams: { access_type: "offline", prompt: "consent" },
  },
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
  const platform = platformParam as SocialPlatform
  const config = SOCIAL_OAUTH_CONFIGS[platform]

  if (!config) {
    return NextResponse.json({ error: `Unknown social platform: ${platform}` }, { status: 400 })
  }

  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get("code")
  const state = searchParams.get("state")
  const oauthError = searchParams.get("error")
  const errorDescription = searchParams.get("error_description")
  const baseUrl = getBaseUrl(request)

  const supabase = await createClient()

  // ─── CALLBACK: Handle OAuth response ──────────────────────────────────────
  if (code || oauthError) {
    if (oauthError) {
      console.error(`[Social OAuth] Error from ${platform}: ${oauthError} — ${errorDescription}`)
      return redirectWithResult(baseUrl, false, platform, errorDescription || oauthError)
    }

    if (!state) {
      return redirectWithResult(baseUrl, false, platform, "Invalid callback — missing state")
    }

    // Verify CSRF state
    const cookieStore = await cookies()
    const storedState = cookieStore.get("social_oauth_state")?.value
    if (!storedState || storedState !== state) {
      return redirectWithResult(baseUrl, false, platform, "Security validation failed — please try again")
    }
    cookieStore.delete("social_oauth_state")

    // Decode state
    let stateData: { platform: string; userId: string; nonce: string }
    try {
      stateData = JSON.parse(Buffer.from(state, "base64url").toString())
    } catch {
      return redirectWithResult(baseUrl, false, platform, "Invalid state format")
    }

    const clientId = process.env[config.clientIdEnv]
    const clientSecret = process.env[config.clientSecretEnv]
    if (!clientId || !clientSecret) {
      return redirectWithResult(baseUrl, false, platform, `${config.displayName} OAuth not configured`)
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
      return redirectWithResult(
        baseUrl,
        false,
        platform,
        errData.error_description || errData.message || "Failed to exchange code for tokens"
      )
    }

    const tokens = await tokenResponse.json()

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

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return redirectWithResult(baseUrl, false, platform, "Please log in to connect social accounts")
  }

  const clientId = process.env[config.clientIdEnv]
  if (!clientId) {
    console.error(`[Social OAuth] Missing ${config.clientIdEnv} env var`)
    return redirectWithResult(baseUrl, false, platform, `${config.displayName} OAuth not configured. Contact your administrator.`)
  }

  // CSRF state
  const newState = Buffer.from(
    JSON.stringify({ platform, userId: user.id, nonce: crypto.randomUUID() })
  ).toString("base64url")

  const cookieStore = await cookies()
  cookieStore.set("social_oauth_state", newState, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 600, // 10 minutes
    path: "/",
  })

  const redirectUri = `${baseUrl}/api/social/oauth/${platform}`

  const authParams = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: config.scopes.join(config.usePKCE ? " " : ","),
    state: newState,
    ...(config.additionalParams ?? {}),
  })

  // PKCE for Twitter
  if (config.usePKCE) {
    const codeVerifier = generateCodeVerifier()
    const codeChallenge = await generateCodeChallenge(codeVerifier)
    authParams.set("code_challenge", codeChallenge)
    authParams.set("code_challenge_method", "S256")
    cookieStore.set("social_oauth_verifier", codeVerifier, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 600,
      path: "/",
    })
  }

  const authUrl = `${config.authUrl}?${authParams.toString()}`
  console.log(`[Social OAuth] Initiating ${platform} OAuth for user ${user.id}`)
  return NextResponse.redirect(authUrl)
}
