// lib/social/oauth-config.ts
// ─────────────────────────────────────────────────────────────────────────────
// SINGLE source of truth for social OAuth provider config — extracted from
// app/api/social/oauth/[platform]/route.ts so the PLATFORM's own channel
// connections (lib/platform/platform-social.ts) reuse the exact same provider
// definitions and URL-building instead of forking a divergent copy. Pure module:
// no I/O beyond process.env reads in the env-status helper.

export type SocialOAuthProvider =
  | "meta"
  | "linkedin"
  | "twitter"
  | "tiktok"
  | "youtube"
  | "pinterest"
  | "google_business"

export interface SocialOAuthConfig {
  displayName: string
  clientIdEnv: string
  clientSecretEnv: string
  authUrl: string
  tokenUrl: string
  scopes: string[]
  usePKCE?: boolean
  additionalParams?: Record<string, string>
}

export const SOCIAL_OAUTH_CONFIGS: Record<SocialOAuthProvider, SocialOAuthConfig> = {
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

export function isSocialOAuthProvider(p: string): p is SocialOAuthProvider {
  return p in SOCIAL_OAUTH_CONFIGS
}

/** HONEST env readiness for a provider's OAuth app: which env vars are missing.
 *  ready === true means both the client id and secret are present at runtime. */
export function socialOAuthEnvStatus(provider: SocialOAuthProvider): { ready: boolean; missingEnv: string[] } {
  const config = SOCIAL_OAUTH_CONFIGS[provider]
  const missingEnv = [config.clientIdEnv, config.clientSecretEnv].filter((name) => !process.env[name])
  return { ready: missingEnv.length === 0, missingEnv }
}

/** PURE: build a provider authorize URL. The caller supplies clientId / redirectUri /
 *  state (and the PKCE code challenge when the provider requires it). Shared by the
 *  tenant OAuth route AND the platform company-channel connect flow. */
export function buildSocialAuthorizeUrl(
  provider: SocialOAuthProvider,
  opts: { clientId: string; redirectUri: string; state: string; codeChallenge?: string },
): string {
  const config = SOCIAL_OAUTH_CONFIGS[provider]
  const authParams = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: config.scopes.join(config.usePKCE ? " " : ","),
    state: opts.state,
    ...(config.additionalParams ?? {}),
  })
  if (config.usePKCE && opts.codeChallenge) {
    authParams.set("code_challenge", opts.codeChallenge)
    authParams.set("code_challenge_method", "S256")
  }
  return `${config.authUrl}?${authParams.toString()}`
}
