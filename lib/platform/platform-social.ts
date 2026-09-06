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
// provider. Dispatch capability is stated per channel: LinkedIn member posts and
// X tweets work with the tokens the OAuth flow grants; Facebook posts as a PAGE
// (the Meta callback runs the page-token leg below — /me/accounts, auto-select a
// single Page or store pending_pages for the picker); Instagram rides the same
// Page's instagram_business_account and REQUIRES an image (the Graph API cannot
// post text-only — the publish action asks for an image URL, never fakes it).
// Page data (page id/name, IG business id, pending page list) lives in the
// credential row's `config` json — no new tables.

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
  publisherPlatform?: "linkedin" | "twitter" | "facebook" | "instagram"
  /** The Graph API cannot post text-only to this channel — publish must carry an image. */
  requiresImage?: boolean
  /** Honest reason/caveat (shown verbatim in the UI). */
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
      return { supported: true, publisherPlatform: "facebook" } // Page feed post with the stored PAGE token
    case "instagram":
      // Container flow works with the Page-derived token + IG business id, but IG
      // Graph refuses text-only posts — publish must supply an image URL.
      return {
        supported: true,
        publisherPlatform: "instagram",
        requiresImage: true,
        reason: "Instagram posts need an image — auto-publish asks for an image URL (use the Image library above); text-only posts are impossible via the API.",
      }
    case "youtube":
      return { supported: false, reason: "YouTube takes video uploads only — render the video, then upload and record the permalink manually." }
    case "tiktok":
      return { supported: false, reason: "TikTok takes video posts only — post the rendered video manually." }
  }
}

// ── Account list (lazy-seeded, one row per channel) ──────────────────────────

/** One managed Facebook Page awaiting selection (Meta grants access to several). */
export interface PendingMetaPage {
  id: string
  name: string
  igUsername: string | null
  hasInstagram: boolean
}

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
  /** Meta connect found several managed Pages — the picker must choose one. */
  pendingPages: PendingMetaPage[] | null
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

  // A Meta connect that found SEVERAL managed Pages parks the list in the
  // credential row's config (pending_pages) and leaves the account 'pending' —
  // surface that list so the growth card can render the Page picker.
  const pendingRefs = (["facebook", "instagram"] as const)
    .map((c) => byChannel.get(c))
    .filter((r) => r && r.status === "pending" && r.credential_ref)
    .map((r) => String(r.credential_ref))
  const pendingByCred = new Map<string, PendingMetaPage[]>()
  if (pendingRefs.length > 0) {
    const { data: creds } = await svc.from("platform_credentials").select("id, config").in("id", pendingRefs)
    for (const c of (creds ?? []) as any[]) {
      const list = Array.isArray(c?.config?.pending_pages) ? c.config.pending_pages : []
      if (list.length > 0) {
        pendingByCred.set(String(c.id), list.map((p: any): PendingMetaPage => ({
          id: String(p?.id ?? ""),
          name: String(p?.name ?? p?.id ?? ""),
          igUsername: p?.ig_username ?? null,
          hasInstagram: !!(p?.has_instagram || p?.ig_username),
        })).filter((p: PendingMetaPage) => p.id))
      }
    }
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
      pendingPages: row?.credential_ref ? (pendingByCred.get(String(row.credential_ref)) ?? null) : null,
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

/** Owner-keyed update-or-insert on platform_credentials (m104 unique:
 *  owner_type, owner_id, platform). Returns the credential row id.
 *
 *  brokerage_id IS DELIBERATELY ABSENT AND MUST STAY ABSENT. These rows hold the
 *  PLATFORM's own company social tokens — the OS marketing itself — and the
 *  platform is not a tenant. m273 dropped NOT NULL from
 *  platform_credentials.brokerage_id for exactly this row class ("platform-owned
 *  rows have NO tenant"), and m102/m104 made (owner_type, owner_id, platform) the
 *  real key, which is why this function writes owner_type='platform' /
 *  owner_id='platform' instead. Nothing here is hidden by a tenant-narrowed
 *  reader: the scope cascade (lib/connections/resolve-scoped.ts) reaches these
 *  rows by owner_type, never by brokerage_id, and m273 gave the platform channels
 *  DISTINCT platform keys ('platform_social_<channel>') precisely so a tenant's
 *  cascade can never resolve them. Stamping a brokerage_id here would invent a
 *  tenant for the company's own account and hand it a credential it does not own.
 *  A tenant social connection is a different code path and does carry the stamp. */
async function upsertPlatformCredential(
  svc: ServiceClient,
  channel: PlatformSocialChannel,
  fields: Record<string, unknown>,
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const credKey = credentialPlatformKey(channel)
  const credRow: Record<string, unknown> = {
    owner_type: "platform",
    owner_id: "platform",
    platform: credKey,
    updated_at: new Date().toISOString(),
    ...fields,
  }
  const { data: existingCred } = await svc
    .from("platform_credentials")
    .select("id")
    .eq("owner_type", "platform").eq("owner_id", "platform").eq("platform", credKey)
    .maybeSingle()
  // Split from a ternary so each branch's error capture sits beside its own
  // write — in the ternary form the shared capture was too far from the INSERT
  // branch to be read as covering it. Behaviour is unchanged.
  let credId: string | null = null
  let credWriteError: { message: string } | null = null
  if (existingCred?.id) {
    const { data, error } = await svc.from("platform_credentials").update(credRow).eq("id", existingCred.id).select("id").single()
    credId = (data as { id?: string } | null)?.id ?? null
    credWriteError = error
  } else {
    const { data, error } = await svc.from("platform_credentials").insert(credRow).select("id").single()
    credId = (data as { id?: string } | null)?.id ?? null
    credWriteError = error
  }
  if (credWriteError || !credId) {
    return { ok: false, error: credWriteError?.message ?? "Failed to store the credential" }
  }
  return { ok: true, id: String(credId) }
}

/** Update-or-insert the channel status row (unique(platform)). */
async function upsertChannelAccount(
  svc: ServiceClient,
  patch: Record<string, unknown> & { platform: PlatformSocialChannel },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { error } = await svc.from("platform_social_accounts").upsert(patch, { onConflict: "platform" })
  return error ? { ok: false, error: error.message } : { ok: true }
}

/** Store exchanged tokens under platform scope in platform_credentials and mark
 *  the channel connected. credential_ref points at the token row — the token
 *  itself never touches platform_social_accounts. Meta channels (facebook /
 *  instagram) run the extra page-token leg: the user token alone cannot post. */
export async function completePlatformChannelConnect(
  svc: ServiceClient,
  args: { channel: PlatformSocialChannel; connectedBy: string; tokens: PlatformTokenPayload },
): Promise<{ ok: true; accountName: string | null; pendingSelection?: boolean } | { ok: false; error: string }> {
  const { channel, connectedBy, tokens } = args

  if (channel === "facebook" || channel === "instagram") {
    return completeMetaChannelConnect(svc, { channel, connectedBy, tokens })
  }

  const nowIso = new Date().toISOString()

  // Best-effort profile ping — the honest account name + provider account id.
  const profile = await fetchChannelProfile(channel, tokens.accessToken)
  const accountName = profile.ok ? (profile.name ?? SOCIAL_OAUTH_CONFIGS[CHANNEL_OAUTH_PROVIDER[channel]].displayName) : SOCIAL_OAUTH_CONFIGS[CHANNEL_OAUTH_PROVIDER[channel]].displayName

  const credWrite = await upsertPlatformCredential(svc, channel, {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_expires_at: tokens.expiresInSeconds ? new Date(Date.now() + tokens.expiresInSeconds * 1000).toISOString() : null,
    account_id: profile.ok ? (profile.accountId ?? null) : null,
    account_name: accountName,
    is_active: true,
  })
  if (!credWrite.ok) return credWrite

  // Mark the channel connected (row may not be seeded yet — update-or-insert on unique(platform)).
  const marked = await upsertChannelAccount(svc, {
    platform: channel,
    account_name: accountName,
    status: "connected",
    credential_ref: credWrite.id,
    connected_by: connectedBy,
    connected_at: nowIso,
    last_verified_at: profile.ok ? nowIso : null,
    updated_at: nowIso,
  })
  if (!marked.ok) return marked

  return { ok: true, accountName }
}

// ── Meta page-token leg (facebook + instagram ride a Facebook PAGE) ──────────
//
// The OAuth callback hands us a USER token; posting happens as a PAGE. The leg:
//   1. exchange the user token for a long-lived one (best-effort — page tokens
//      minted from a long-lived user token never expire),
//   2. GET /me/accounts to list managed Pages (with each Page's token and any
//      linked instagram_business_account),
//   3. exactly one Page → auto-select; several → store pending_pages in the
//      credential config and let selectPlatformFacebookPageAction finish;
//      zero → honest error, nothing stored.
// Instagram NEVER gets its own OAuth material — it rides the selected Page's
// token + instagram_business_account id. A Page with no linked IG business
// account is an honest connect failure for the instagram channel.

interface MetaPage {
  id: string
  name: string
  access_token?: string
  instagram_business_account?: { id?: string; username?: string } | null
}

const META_PAGE_FIELDS = "id,name,access_token,instagram_business_account{id,username}"

/** Best-effort long-lived user-token exchange (fb_exchange_token). */
async function exchangeMetaLongLivedToken(
  userToken: string,
): Promise<{ ok: true; token: string; expiresInSeconds: number | null } | { ok: false }> {
  const cfg = SOCIAL_OAUTH_CONFIGS.meta
  const clientId = process.env[cfg.clientIdEnv]
  const clientSecret = process.env[cfg.clientSecretEnv]
  if (!clientId || !clientSecret) return { ok: false }
  const res = await callConnector<{ access_token?: string; expires_in?: number }>({
    connector: "meta", baseUrl: "https://graph.facebook.com", path: "/v18.0/oauth/access_token", method: "GET",
    query: { grant_type: "fb_exchange_token", client_id: clientId, client_secret: clientSecret, fb_exchange_token: userToken },
    auth: { style: "none" },
  })
  if (!res.ok || !res.data?.access_token) return { ok: false }
  return { ok: true, token: res.data.access_token, expiresInSeconds: res.data.expires_in ?? null }
}

/** The Pages this user token manages (each with its Page token + linked IG). */
async function listMetaPages(userToken: string): Promise<{ ok: true; pages: MetaPage[] } | { ok: false; error: string }> {
  const res = await callConnector<{ data?: MetaPage[]; error?: { message?: string } }>({
    connector: "meta", baseUrl: "https://graph.facebook.com", path: "/v18.0/me/accounts", method: "GET",
    query: { fields: META_PAGE_FIELDS, limit: "100" },
    auth: { style: "query", name: "access_token", value: userToken },
  })
  if (!res.ok) return { ok: false, error: res.data?.error?.message || res.error || "Meta rejected the Pages request" }
  return { ok: true, pages: ((res.data?.data ?? []) as MetaPage[]).filter((p) => p?.id) }
}

/** One Page (fresh Page token + IG link) via the stored long-lived user token. */
async function fetchMetaPage(pageId: string, userToken: string): Promise<{ ok: true; page: MetaPage } | { ok: false; error: string }> {
  const res = await callConnector<MetaPage & { error?: { message?: string } }>({
    connector: "meta", baseUrl: "https://graph.facebook.com", path: `/v18.0/${pageId}`, method: "GET",
    query: { fields: META_PAGE_FIELDS },
    auth: { style: "query", name: "access_token", value: userToken },
  })
  if (!res.ok || !res.data?.id) return { ok: false, error: (res.data as any)?.error?.message || res.error || "Meta rejected the Page lookup" }
  return { ok: true, page: res.data }
}

/** Commit a chosen Page: store the PAGE token as the facebook credential and,
 *  when the Page has a linked instagram_business_account, connect instagram off
 *  the same Page token (IG rides the FB Page — one Meta login, two channels). */
async function finalizeMetaPageSelection(
  svc: ServiceClient,
  args: {
    requestedChannel: "facebook" | "instagram"
    page: MetaPage
    userToken: string
    userTokenExpiresAt: string | null
    connectedBy: string
  },
): Promise<{ ok: true; accountName: string | null } | { ok: false; error: string }> {
  const { requestedChannel, page, userToken, userTokenExpiresAt, connectedBy } = args
  const ig = page.instagram_business_account
  if (requestedChannel === "instagram" && !ig?.id) {
    return { ok: false, error: "This Facebook Page has no linked Instagram business account — link it in Meta Business Suite, then Reconnect." }
  }
  if (!page.access_token) {
    return { ok: false, error: `Meta returned no access token for Page "${page.name}" — the connecting user must have full control of the Page. Fix the role in Meta Business Suite, then Reconnect.` }
  }

  const nowIso = new Date().toISOString()

  // Facebook leg — both channels ride this Page, so it always lands. Page tokens
  // minted from a long-lived user token do not expire (token_expires_at null);
  // the user token is kept in config for later re-selection without re-OAuth.
  const fbCred = await upsertPlatformCredential(svc, "facebook", {
    access_token: page.access_token,
    refresh_token: null,
    token_expires_at: null,
    account_id: page.id,
    account_name: page.name,
    is_active: true,
    config: {
      page_id: page.id,
      page_name: page.name,
      ig_business_account_id: ig?.id ?? null,
      ig_username: ig?.username ?? null,
      user_access_token: userToken,
      user_token_expires_at: userTokenExpiresAt,
    },
  })
  if (!fbCred.ok) return fbCred
  const fbMarked = await upsertChannelAccount(svc, {
    platform: "facebook",
    account_name: page.name,
    status: "connected",
    credential_ref: fbCred.id,
    connected_by: connectedBy,
    connected_at: nowIso,
    last_verified_at: nowIso,
    updated_at: nowIso,
  })
  if (!fbMarked.ok) return fbMarked

  let igName: string | null = null
  if (ig?.id) {
    igName = ig.username ? `@${ig.username}` : page.name
    const igCred = await upsertPlatformCredential(svc, "instagram", {
      access_token: page.access_token,
      refresh_token: null,
      token_expires_at: null,
      account_id: ig.id,
      account_name: igName,
      is_active: true,
      config: { page_id: page.id, page_name: page.name, ig_business_account_id: ig.id, ig_username: ig.username ?? null },
    })
    if (!igCred.ok) return igCred
    const igMarked = await upsertChannelAccount(svc, {
      platform: "instagram",
      account_name: igName,
      status: "connected",
      credential_ref: igCred.id,
      connected_by: connectedBy,
      connected_at: nowIso,
      last_verified_at: nowIso,
      updated_at: nowIso,
    })
    if (!igMarked.ok) return igMarked
  }

  return { ok: true, accountName: requestedChannel === "instagram" ? igName : page.name }
}

/** The Meta half of completePlatformChannelConnect (see leg comment above). */
async function completeMetaChannelConnect(
  svc: ServiceClient,
  args: { channel: "facebook" | "instagram"; connectedBy: string; tokens: PlatformTokenPayload },
): Promise<{ ok: true; accountName: string | null; pendingSelection?: boolean } | { ok: false; error: string }> {
  const { channel, connectedBy, tokens } = args

  // 1. Long-lived user token (best-effort — fall back to the short one honestly,
  //    keeping its real expiry).
  const exchanged = await exchangeMetaLongLivedToken(tokens.accessToken)
  const userToken = exchanged.ok ? exchanged.token : tokens.accessToken
  const expiresInSeconds = exchanged.ok ? exchanged.expiresInSeconds : tokens.expiresInSeconds
  const userTokenExpiresAt = expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000).toISOString() : null

  // 2. Managed Pages.
  const listed = await listMetaPages(userToken)
  if (!listed.ok) return listed
  if (listed.pages.length === 0) {
    return { ok: false, error: "This Meta login manages no Facebook Pages — the company posts as a Page. Get admin access to the company Page in Meta Business Suite, then Reconnect." }
  }

  // 3a. Exactly one Page → auto-select it.
  if (listed.pages.length === 1) {
    return finalizeMetaPageSelection(svc, {
      requestedChannel: channel, page: listed.pages[0], userToken, userTokenExpiresAt, connectedBy,
    })
  }

  // 3b. Several Pages → park the list (pending_pages) and let the growth card's
  //     picker finish via completePlatformFacebookPageSelection. The credential
  //     row holds the (long-lived) USER token for that later exchange.
  const nowIso = new Date().toISOString()
  const credWrite = await upsertPlatformCredential(svc, channel, {
    access_token: userToken,
    refresh_token: null,
    token_expires_at: userTokenExpiresAt,
    account_id: null,
    account_name: null,
    is_active: true,
    config: {
      pending_for: channel,
      pending_pages: listed.pages.map((p) => ({
        id: p.id,
        name: p.name,
        ig_username: p.instagram_business_account?.username ?? null,
        has_instagram: !!p.instagram_business_account?.id,
      })),
    },
  })
  if (!credWrite.ok) return credWrite
  const marked = await upsertChannelAccount(svc, {
    platform: channel,
    account_name: null,
    status: "pending",
    credential_ref: credWrite.id,
    connected_by: connectedBy,
    connected_at: null,
    last_verified_at: null,
    updated_at: nowIso,
  })
  if (!marked.ok) return marked
  return { ok: true, accountName: null, pendingSelection: true }
}

/** Finish a parked multi-Page Meta connect: find the channel whose credential
 *  holds pending_pages containing pageId, fetch that Page fresh with the stored
 *  user token, and commit it (finalizeMetaPageSelection — clears the pending
 *  config by overwriting the credential row). */
export async function completePlatformFacebookPageSelection(
  svc: ServiceClient,
  pageId: string,
  connectedBy: string,
): Promise<{ ok: true; accountName: string | null; channel: "facebook" | "instagram" } | { ok: false; error: string }> {
  for (const channel of ["facebook", "instagram"] as const) {
    const { data: account } = await svc
      .from("platform_social_accounts")
      .select("credential_ref, status")
      .eq("platform", channel)
      .maybeSingle()
    if (!account?.credential_ref) continue
    const { data: cred } = await svc
      .from("platform_credentials")
      .select("id, access_token, token_expires_at, config")
      .eq("id", account.credential_ref)
      .maybeSingle()
    const pending: any[] = Array.isArray((cred as any)?.config?.pending_pages) ? (cred as any).config.pending_pages : []
    if (!cred?.access_token || pending.length === 0) continue
    if (!pending.some((p) => String(p?.id) === pageId)) {
      return { ok: false, error: "That Page isn't in the pending list — hit Reconnect to refresh the Page list from Meta" }
    }
    if (cred.token_expires_at && new Date(cred.token_expires_at).getTime() < Date.now()) {
      return { ok: false, error: "The stored Meta token expired before a Page was chosen — hit Reconnect and pick again" }
    }
    const fetched = await fetchMetaPage(pageId, cred.access_token)
    if (!fetched.ok) return fetched
    const done = await finalizeMetaPageSelection(svc, {
      requestedChannel: (cred as any)?.config?.pending_for === "instagram" ? "instagram" : "facebook",
      page: fetched.page,
      userToken: cred.access_token,
      userTokenExpiresAt: cred.token_expires_at ?? null,
      connectedBy,
    })
    if (!done.ok) return done
    return { ok: true, accountName: done.accountName, channel }
  }
  return { ok: false, error: "No Facebook Page selection is pending — start Connect on the Facebook (or Instagram) channel first" }
}

/** The REAL permalink of a just-published Meta post (Page post: permalink_url;
 *  IG media: permalink). Null when Graph won't say — callers must not invent one. */
export async function fetchMetaPostPermalink(
  kind: "facebook" | "instagram",
  postId: string,
  accessToken: string,
): Promise<string | null> {
  const field = kind === "facebook" ? "permalink_url" : "permalink"
  const res = await callConnector<{ permalink_url?: string; permalink?: string }>({
    connector: "meta", baseUrl: "https://graph.facebook.com", path: `/v18.0/${postId}`, method: "GET",
    query: { fields: field },
    auth: { style: "query", name: "access_token", value: accessToken },
  })
  if (!res.ok) return null
  const link = kind === "facebook" ? res.data?.permalink_url : res.data?.permalink
  return typeof link === "string" && link.startsWith("http") ? link : null
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
    .select("id, access_token, account_id, token_expires_at, is_active")
    .eq("id", account.credential_ref)
    .maybeSingle()
  if (!cred?.access_token || cred.is_active === false) return markError("Stored credential is missing or inactive — reconnect")
  if (cred.token_expires_at && new Date(cred.token_expires_at).getTime() < Date.now()) {
    return markError(`Token expired ${new Date(cred.token_expires_at).toLocaleDateString()} — reconnect`)
  }

  // Meta channels ping with the stored PAGE token (facebook: /me resolves to the
  // Page identity under a Page token; instagram: the IG business node by id).
  const profile = await fetchChannelProfile(channel, cred.access_token, cred.account_id ?? null)
  if (!profile.ok) return markError(profile.error)

  const nowIso = new Date().toISOString()
  const patch: Record<string, unknown> = { status: "connected", last_verified_at: nowIso, updated_at: nowIso }
  if (profile.name) patch.account_name = profile.name
  await svc.from("platform_social_accounts").update(patch).eq("id", account.id)
  if (profile.accountId) {
    // test_status/'pass' + the resolved provider account id ARE the verification
    // result. Written silently, a refusal meant Verify reported "connected"
    // while the credential still carried the previous (or no) account id — and
    // the publisher then posts with the stale one.
    const { error: credVerifyError } = await svc.from("platform_credentials")
      .update({ account_id: profile.accountId, account_name: profile.name ?? undefined, last_tested_at: nowIso, test_status: "pass", updated_at: nowIso })
      .eq("id", cred.id)
    if (credVerifyError) {
      return markError(`Verified with ${channel}, but the credential could not be updated: ${credVerifyError.message}`)
    }
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
    // THE REVOCATION. Deactivating the credential is what actually withdraws
    // the stored OAuth token; the account row below is only the label. Written
    // silently, a refusal reported the channel disconnected while a live token
    // stayed active and usable.
    const { error: revokeError } = await svc.from("platform_credentials")
      .update({ is_active: false, updated_at: new Date().toISOString() })
      .eq("id", account.credential_ref)
    if (revokeError) {
      return { ok: false, error: `The stored credential could not be deactivated — the channel is NOT disconnected: ${revokeError.message}` }
    }
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
 *  real account identity. All egress rides the connector gateway. Meta channels
 *  carry the PAGE token: facebook's /me resolves to the Page; instagram needs
 *  the IG business-account id (accountId) since /me would answer as the Page. */
export async function fetchChannelProfile(
  channel: PlatformSocialChannel,
  accessToken: string,
  accountId?: string | null,
): Promise<ProfileResult> {
  const provider = CHANNEL_OAUTH_PROVIDER[channel]
  try {
    if (provider === "meta") {
      if (channel === "instagram") {
        if (!accountId) return { ok: false, error: "No Instagram business-account id on file — reconnect the channel" }
        const res = await callConnector<{ id?: string; username?: string; name?: string }>({
          connector: "meta", baseUrl: "https://graph.facebook.com", path: `/v18.0/${accountId}`, method: "GET",
          query: { fields: "id,username,name" }, auth: { style: "query", name: "access_token", value: accessToken },
        })
        if (!res.ok || !res.data?.id) return { ok: false, error: res.error || "Meta rejected the Instagram token" }
        return { ok: true, accountId: res.data.id, name: res.data.username ? `@${res.data.username}` : res.data.name }
      }
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
