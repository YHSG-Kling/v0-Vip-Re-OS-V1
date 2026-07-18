// lib/platform/platform-social.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE PLATFORM'S OWN SOCIAL ACCOUNT CONNECTIONS — the missing half of the
// product-content pipeline. The growth board composes posts for the COMPANY
// channels (platform_social_drafts); this module owns connecting those channels:
//
//   platform_social_accounts  — one row per channel (facebook/instagram/linkedin/
//                               youtube/x/tiktok), STATUS ONLY. Tokens NEVER
//                               live here; credential_ref points at the token row.
//   platform_credentials      — the single credential home, owner_type='platform',
//                               owner_id='platform', platform='platform_social_<channel>'
//                               (distinct keys on purpose: the tenant scope-cascade
//                               falls back to platform scope, so reusing tenant
//                               provider ids would let a brokerage resolve — and
//                               post through — the company's account; m273).
//
// The OAuth handshake REUSES the tenant social route (app/api/social/oauth/
// [platform]/route.ts) end to end: connect returns that route's initiate URL with
// a ?platform_scope=<channel> marker, the route carries scope through the CSRF
// state, and its callback hands the exchanged tokens to
// completePlatformChannelConnect below. No forked OAuth code.
//
// HONESTY RULES: a provider whose OAuth app env creds are absent reports
// { needsCreds, missingEnv } — never a dead button. verify() actually pings the
// provider. Dispatch capability is stated per channel (LinkedIn member posts and
// X tweets work with the tokens the OAuth flow grants; Facebook/Instagram need a
// Page/IG-business selection flow that is NOT built, so they stay copy-&-post).

import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import {
  SOCIAL_OAUTH_CONFIGS,
  socialOAuthEnvStatus,
  type SocialOAuthProvider,
} from "@/lib/social/oauth-config"

type ServiceClient = ReturnType<typeof import("@/lib/supabase/service").createServiceClient>

// ── Channel catalog ───────────────────────────────────────────────────────────

export const PLATFORM_SOCIAL_CHANNELS = ["facebook", "instagram", "linkedin", "youtube", "x", "tiktok"] as const
export type PlatformSocialChannel = (typeof PLATFORM_SOCIAL_CHANNELS)[number]

export function isPlatformSocialChannel(c: string | null | undefined): c is PlatformSocialChannel {
  return !!c && (PLATFORM_SOCIAL_CHANNELS as readonly string[]).includes(c)
}

/** Which OAuth app (tenant social route config) a company channel rides. */
export const CHANNEL_OAUTH_PROVIDER: Record<PlatformSocialChannel, SocialOAuthProvider> = {
  facebook: "meta",
  instagram: "meta",
  linkedin: "linkedin",
  youtube: "youtube",
  x: "twitter",
  tiktok: "tiktok",
}

export const CHANNEL_LABELS: Record<PlatformSocialChannel, string> = {
  facebook: "Facebook",
  instagram: "Instagram",
  linkedin: "LinkedIn",
  youtube: "YouTube",
  x: "X (Twitter)",
  tiktok: "TikTok",
}

/** The platform_credentials.platform key for a company channel (see header — the
 *  keys are DISTINCT from tenant provider ids so the tenant cascade can't hit them). */
export function credentialPlatformKey(channel: PlatformSocialChannel): string {
  return `platform_social_${channel}`
}

// ── Dispatch capability (pure, honest) ────────────────────────────────────────

export interface ChannelDispatchSupport {
  supported: boolean
  /** lib/social/publisher.ts platform key when supported. */
  publisherPlatform?: "linkedin" | "twitter"
  /** Honest reason when NOT supported (shown verbatim in the UI). */
  reason?: string
}

/** What the existing lib/social publisher can ACTUALLY send with the tokens the
 *  OAuth flow grants. Only claims what works; everything else states why not. */
export function channelDispatchSupport(channel: PlatformSocialChannel): ChannelDispatchSupport {
  switch (channel) {
    case "linkedin":
      return { supported: true, publisherPlatform: "linkedin" } // member UGC post (w_member_social)
    case "x":
      return { supported: true, publisherPlatform: "twitter" } // POST /2/tweets with the user token
    case "facebook":
      return { supported: false, reason: "Facebook publishing needs a Page token (a Page-selection step that isn't built) — copy & post manually." }
    case "instagram":
      return { supported: false, reason: "Instagram publishing needs an IG business-account id and media — copy & post manually." }
    case "youtube":
      return { supported: false, reason: "YouTube takes video uploads only — render the video, then upload and record the permalink manually." }
    case "tiktok":
      return { supported: false, reason: "TikTok takes video posts only — post the rendered video manually." }
  }
}

// ── Account list (lazy-seeded, one row per channel) ──────────────────────────

export interface PlatformSocialAccountView {
  id: string | null
  platform: PlatformSocialChannel
  label: string
  status: "pending" | "connected" | "error" | "disconnected"
  accountName: string | null
  connectedAt: string | null
  lastVerifiedAt: string | null
  /** OAuth app env readiness — false means Connect can't start yet. */
  envReady: boolean
  missingEnv: string[]
  oauthProvider: SocialOAuthProvider
  dispatch: ChannelDispatchSupport
}

/** One row per channel, seeded lazily (status 'pending' until a real connect). */
export async function getPlatformSocialAccounts(svc: ServiceClient): Promise<PlatformSocialAccountView[]> {
  const { data: rows } = await svc
    .from("platform_social_accounts")
    .select("id, platform, account_name, status, credential_ref, connected_at, last_verified_at")
  const byChannel = new Map<string, any>(((rows ?? []) as any[]).map((r) => [r.platform, r]))

  // Lazy seed: insert missing channels (unique(platform) makes races harmless).
  const missing = PLATFORM_SOCIAL_CHANNELS.filter((c) => !byChannel.has(c))
  if (missing.length > 0) {
    const { data: seeded } = await svc
      .from("platform_social_accounts")
      .insert(missing.map((platform) => ({ platform })))
      .select("id, platform, account_name, status, credential_ref, connected_at, last_verified_at")
    for (const r of (seeded ?? []) as any[]) byChannel.set(r.platform, r)
  }

  return PLATFORM_SOCIAL_CHANNELS.map((channel) => {
    const row = byChannel.get(channel)
    const env = socialOAuthEnvStatus(CHANNEL_OAUTH_PROVIDER[channel])
    return {
      id: row?.id ?? null,
      platform: channel,
      label: CHANNEL_LABELS[channel],
      status: (row?.status ?? "pending") as PlatformSocialAccountView["status"],
      accountName: row?.account_name ?? null,
      connectedAt: row?.connected_at ?? null,
      lastVerifiedAt: row?.last_verified_at ?? null,
      envReady: env.ready,
      missingEnv: env.missingEnv,
      oauthProvider: CHANNEL_OAUTH_PROVIDER[channel],
      dispatch: channelDispatchSupport(channel),
    }
  })
}

// ── Connect (start) ───────────────────────────────────────────────────────────

export type StartConnectResult =
  | { ok: true; url: string }
  | { ok: true; needsCreds: true; missingEnv: string[]; provider: SocialOAuthProvider }

/** If the provider's OAuth app env creds exist, the REAL authorize flow starts at
 *  the tenant social route with a platform-scope marker (the route builds the
 *  provider URL + CSRF state + PKCE exactly as it does for tenants). Otherwise an
 *  honest needsCreds with the exact env var names to set. */
export function startPlatformSocialConnect(channel: PlatformSocialChannel): StartConnectResult {
  const provider = CHANNEL_OAUTH_PROVIDER[channel]
  const env = socialOAuthEnvStatus(provider)
  if (!env.ready) return { ok: true, needsCreds: true, missingEnv: env.missingEnv, provider }
  return { ok: true, url: `/api/social/oauth/${provider}?platform_scope=${channel}` }
}

// ── Connect (complete — called by the OAuth route's callback) ────────────────

export interface PlatformTokenPayload {
  accessToken: string
  refreshToken: string | null
  expiresInSeconds: number | null
}

/** Store exchanged tokens under platform scope in platform_credentials and mark
 *  the channel connected. credential_ref points at the token row — the token
 *  itself never touches platform_social_accounts. */
export async function completePlatformChannelConnect(
  svc: ServiceClient,
  args: { channel: PlatformSocialChannel; connectedBy: string; tokens: PlatformTokenPayload },
): Promise<{ ok: true; accountName: string | null } | { ok: false; error: string }> {
  const { channel, connectedBy, tokens } = args
  const nowIso = new Date().toISOString()

  // Best-effort profile ping — the honest account name + provider account id.
  const profile = await fetchChannelProfile(channel, tokens.accessToken)
  const accountName = profile.ok ? (profile.name ?? SOCIAL_OAUTH_CONFIGS[CHANNEL_OAUTH_PROVIDER[channel]].displayName) : SOCIAL_OAUTH_CONFIGS[CHANNEL_OAUTH_PROVIDER[channel]].displayName

  // Owner-keyed update-or-insert (m104 unique: owner_type, owner_id, platform).
  const credKey = credentialPlatformKey(channel)
  const credRow: Record<string, unknown> = {
    owner_type: "platform",
    owner_id: "platform",
    platform: credKey,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_expires_at: tokens.expiresInSeconds ? new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString() : null,
    account_id: profile.ok ? (profile.accountId ?? null) : null,
    account_name: accountName,
    is_active: true,
    updated_at: nowIso,
  }
  const { data: existingCred } = await svc
    .from("platform_credentials")
    .select("id")
    .eq("owner_type", "platform").eq("owner_id", "platform").eq("platform", credKey)
    .maybeSingle()
  const credWrite = existingCred?.id
    ? await svc.from("platform_credentials").update(credRow).eq("id", existingCred.id).select("id").single()
    : await svc.from("platform_credentials").insert(credRow).select("id").single()
  if (credWrite.error || !credWrite.data?.id) {
    return { ok: false, error: credWrite.error?.message ?? "Failed to store the credential" }
  }

  // Mark the channel connected (row may not be seeded yet — update-or-insert on unique(platform)).
  const accountPatch = {
    platform: channel,
    account_name: accountName,
    status: "connected",
    credential_ref: String(credWrite.data.id),
    connected_by: connectedBy,
    connected_at: nowIso,
    last_verified_at: profile.ok ? nowIso : null,
    updated_at: nowIso,
  }
  const { error: upsertError } = await svc
    .from("platform_social_accounts")
    .upsert(accountPatch, { onConflict: "platform" })
  if (upsertError) return { ok: false, error: upsertError.message }

  return { ok: true, accountName }
}

// ── Verify (honest provider ping) ─────────────────────────────────────────────

export interface VerifyResult {
  ok: boolean
  status: "connected" | "error" | "pending" | "disconnected"
  accountName?: string | null
  error?: string
}

/** Ping the provider with the stored token; update status/last_verified_at to
 *  match REALITY. Never fakes a green check. */
export async function verifyPlatformChannel(svc: ServiceClient, channel: PlatformSocialChannel): Promise<VerifyResult> {
  const { data: account } = await svc
    .from("platform_social_accounts")
    .select("id, status, credential_ref")
    .eq("platform", channel)
    .maybeSingle()
  if (!account) return { ok: false, status: "pending", error: "Channel not connected yet" }
  if (account.status !== "connected" && account.status !== "error") {
    return { ok: false, status: account.status as VerifyResult["status"], error: `Channel is ${account.status} — connect it first` }
  }

  const markError = async (error: string): Promise<VerifyResult> => {
    await svc.from("platform_social_accounts")
      .update({ status: "error", updated_at: new Date().toISOString() })
      .eq("id", account.id)
    return { ok: false, status: "error", error }
  }

  if (!account.credential_ref) return markError("No credential on file — reconnect")
  const { data: cred } = await svc
    .from("platform_credentials")
    .select("id, access_token, token_expires_at, is_active")
    .eq("id", account.credential_ref)
    .maybeSingle()
  if (!cred?.access_token || cred.is_active === false) return markError("Stored credential is missing or inactive — reconnect")
  if (cred.token_expires_at && new Date(cred.token_expires_at).getTime() < Date.now()) {
    return markError(`Token expired ${new Date(cred.token_expires_at).toLocaleDateString()} — reconnect`)
  }

  const profile = await fetchChannelProfile(channel, cred.access_token)
  if (!profile.ok) return markError(profile.error)

  const nowIso = new Date().toISOString()
  const patch: Record<string, unknown> = { status: "connected", last_verified_at: nowIso, updated_at: nowIso }
  if (profile.name) patch.account_name = profile.name
  await svc.from("platform_social_accounts").update(patch).eq("id", account.id)
  if (profile.accountId) {
    await svc.from("platform_credentials")
      .update({ account_id: profile.accountId, account_name: profile.name ?? undefined, last_tested_at: nowIso, test_status: "pass", updated_at: nowIso })
      .eq("id", cred.id)
  }
  return { ok: true, status: "connected", accountName: profile.name ?? null }
}

// ── Disconnect ────────────────────────────────────────────────────────────────

export async function disconnectPlatformChannel(svc: ServiceClient, channel: PlatformSocialChannel): Promise<{ ok: boolean; error?: string }> {
  const { data: account } = await svc
    .from("platform_social_accounts")
    .select("id, credential_ref")
    .eq("platform", channel)
    .maybeSingle()
  if (!account) return { ok: false, error: "Channel row not found" }
  if (account.credential_ref) {
    await svc.from("platform_credentials")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", account.credential_ref)
  }
  const { error } = await svc.from("platform_social_accounts")
    .update({ status: "disconnected", credential_ref: null, updated_at: new Date().toISOString() })
    .eq("id", account.id)
  return error ? { ok: false, error: error.message } : { ok: true }
}

// ── Publishing credential (for the growth-board dispatch) ────────────────────

/** The live token + provider account id for a CONNECTED, dispatch-capable channel.
 *  Honest failures for every not-ready state. */
export async function getChannelPublishCredential(
  svc: ServiceClient,
  channel: PlatformSocialChannel,
): Promise<{ ok: true; accessToken: string; accountId: string | null } | { ok: false; error: string }> {
  const { data: account } = await svc
    .from("platform_social_accounts")
    .select("id, status, credential_ref")
    .eq("platform", channel)
    .maybeSingle()
  if (!account || account.status !== "connected") {
    return { ok: false, error: `${CHANNEL_LABELS[channel]} is not connected — connect it in Company channels, or copy & post manually` }
  }
  if (!account.credential_ref) return { ok: false, error: `${CHANNEL_LABELS[channel]} has no credential on file — reconnect` }
  const { data: cred } = await svc
    .from("platform_credentials")
    .select("id, access_token, account_id, token_expires_at, is_active")
    .eq("id", account.credential_ref)
    .maybeSingle()
  if (!cred?.access_token || cred.is_active === false) {
    return { ok: false, error: `${CHANNEL_LABELS[channel]} credential is missing or inactive — reconnect` }
  }
  if (cred.token_expires_at && new Date(cred.token_expires_at).getTime() < Date.now()) {
    return { ok: false, error: `${CHANNEL_LABELS[channel]} token has expired — reconnect, or copy & post manually` }
  }
  return { ok: true, accessToken: cred.access_token, accountId: cred.account_id ?? null }
}

// ── Provider profile ping (the verify primitive) ─────────────────────────────

type ProfileResult = { ok: true; accountId?: string; name?: string } | { ok: false; error: string }

/** One authenticated read per provider — proves the token works and returns the
 *  real account identity. All egress rides the connector gateway. */
export async function fetchChannelProfile(channel: PlatformSocialChannel, accessToken: string): Promise<ProfileResult> {
  const provider = CHANNEL_OAUTH_PROVIDER[channel]
  try {
    if (provider === "meta") {
      const res = await callConnector<{ id?: string; name?: string }>({
        connector: "meta", baseUrl: "https://graph.facebook.com", path: "/v18.0/me", method: "GET",
        query: { fields: "id,name" }, auth: { style: "query", name: "access_token", value: accessToken },
      })
      if (!res.ok || !res.data?.id) return { ok: false, error: res.error || "Meta rejected the token" }
      return { ok: true, accountId: res.data.id, name: res.data.name }
    }
    if (provider === "linkedin") {
      const res = await callConnector<{ id?: string; localizedFirstName?: string; localizedLastName?: string }>({
        connector: "linkedin", baseUrl: "https://api.linkedin.com", path: "/v2/me", method: "GET",
        auth: { style: "bearer", token: accessToken },
      })
      if (!res.ok || !res.data?.id) return { ok: false, error: res.error || "LinkedIn rejected the token" }
      const name = [res.data.localizedFirstName, res.data.localizedLastName].filter(Boolean).join(" ")
      return { ok: true, accountId: res.data.id, name: name || undefined }
    }
    if (provider === "twitter") {
      const res = await callConnector<{ data?: { id?: string; name?: string; username?: string } }>({
        connector: "twitter", baseUrl: "https://api.twitter.com", path: "/2/users/me", method: "GET",
        auth: { style: "bearer", token: accessToken },
      })
      if (!res.ok || !res.data?.data?.id) return { ok: false, error: res.error || "X rejected the token" }
      const u = res.data.data
      return { ok: true, accountId: u.id, name: u.username ? `@${u.username}` : u.name }
    }
    if (provider === "tiktok") {
      const res = await callConnector<{ data?: { user?: { open_id?: string; display_name?: string } }; error?: { code?: string; message?: string } }>({
        connector: "tiktok", baseUrl: "https://open.tiktokapis.com", path: "/v2/user/info/", method: "GET",
        query: { fields: "open_id,display_name" }, auth: { style: "bearer", token: accessToken },
      })
      const tkCode = res.data?.error?.code
      if (!res.ok || (tkCode && tkCode !== "ok") || !res.data?.data?.user?.open_id) {
        return { ok: false, error: res.data?.error?.message || res.error || "TikTok rejected the token" }
      }
      return { ok: true, accountId: res.data.data.user.open_id, name: res.data.data.user.display_name }
    }
    // youtube
    const res = await callConnector<{ items?: Array<{ id?: string; snippet?: { title?: string } }> }>({
      connector: "youtube", baseUrl: "https://www.googleapis.com", path: "/youtube/v3/channels", method: "GET",
      query: { part: "snippet", mine: "true" }, auth: { style: "bearer", token: accessToken },
    })
    if (!res.ok) return { ok: false, error: res.error || "YouTube rejected the token" }
    const item = res.data?.items?.[0]
    if (!item?.id) return { ok: false, error: "Token accepted but no YouTube channel found on this Google account" }
    return { ok: true, accountId: item.id, name: item.snippet?.title }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? "Provider ping failed" }
  }
}
