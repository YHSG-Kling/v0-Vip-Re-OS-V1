// lib/connections/zoom.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE scope-aware ZOOM-connection layer (round 39) — the round-36
// accounting-scopes idiom applied to meetings. Every level of the hierarchy
// (platform | brokerage | team | agent) gets its Zoom story from THIS module:
// the settings cards, the OAuth storage keys, the appointment meeting-creation
// lane, and the recording-webhook attach targets all read it.
//
// It rides the EXISTING rails end to end:
//   • Tokens live in platform_credentials keyed by (owner_type, owner_id,
//     platform) — the m102/m104 owner model. The EXISTING
//     /api/integrations/oauth/zoom route resolves the connecting user's scope
//     (connectionScopeForUserType) and stores owner-scoped.
//   • The PLATFORM's own Zoom uses the DISTINCT storage key 'platform_zoom'
//     (the m273 idiom): the tenant credential cascade falls back to
//     owner_type='platform', so storing the company's Zoom under 'zoom' would
//     let a tenant with no connection host meetings on the COMPANY's account.
//     A distinct key makes that leak impossible by construction.
//   • Meeting creation resolves the HOST by an explicit, documented cascade of
//     EXACT owner matches (agent → team → brokerage for tenant actors; the
//     platform's own key for platform actors) — never resolveScopedConnection,
//     so one tenant's Zoom can never host another owner's meeting.
//
// HONESTY CONTRACT: a meeting is "created" ONLY on real Zoom API acceptance
// (an id + join_url in the response). Not connected → an honest refusal with
// the settings hint — never a fabricated join link. Vendor scope is a
// documented not-offered VERDICT (no meeting-creation consumer exists for
// vendors), never a dead button. Provider gating: no ZOOM_CLIENT_ID/SECRET at
// the platform level → the connect card states exactly what is missing.
//
// Pure sections (matrix, owner resolution, cascade, webhook crypto, VTT
// parsing, attach-target resolution) are unit-tested by
// scripts/zoom-lane-simulator.ts; live sections take a service client as a
// parameter (same idiom as lib/connections/accounting-scopes.ts).

import { createHmac } from "crypto"
import type { createServiceClient } from "@/lib/supabase/service"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

type ServiceClient = ReturnType<typeof createServiceClient>

// ─── Scope model (pure) ──────────────────────────────────────────────────────

/** Zoom-capable owner scopes. `contact` is deliberately absent — contacts join
 *  meetings, they never host them. Vendor is present in the matrix so the
 *  verdict is documented, not silently missing. */
export type ZoomScope = "platform" | "brokerage" | "team" | "agent" | "vendor"

export const ZOOM_SCOPES: readonly ZoomScope[] = [
  "platform", "brokerage", "team", "agent", "vendor",
]

/** The one OAuth start path every Zoom connect button uses. The route derives
 *  the owner scope from the LOGGED-IN user's role server-side. */
export const ZOOM_OAUTH_START = "/api/integrations/oauth/zoom"

/** Sentinel owner id for the platform's own row (m273 idiom). */
export const PLATFORM_ZOOM_OWNER_ID = "platform"

/** DISTINCT platform_credentials.platform key for the COMPANY's own Zoom —
 *  never the tenant 'zoom' key (cascade leak-proofing, see header). */
export const PLATFORM_ZOOM_STORAGE_KEY = "platform_zoom"

/** Pure: the platform_credentials.platform key a scope's Zoom tokens are
 *  stored under. Tenant-side scopes share 'zoom' (rows differ by owner); the
 *  platform's own account uses the distinct company key. */
export function zoomStorageKey(scope: ZoomScope): string {
  return scope === "platform" ? PLATFORM_ZOOM_STORAGE_KEY : "zoom"
}

export type ZoomOfferingStatus = "connectable" | "not-offered"

export interface ZoomOffering {
  status: ZoomOfferingStatus
  /** Real connect surface for "connectable"; null for "not-offered". */
  connectPath: string | null
  /** The documented, honest reason — rendered verbatim on the settings card. */
  verdict: string
}

/**
 * THE per-level offering matrix (single source of truth).
 *
 * Zoom audit (2026-07, round 39): the meeting-creation consumers are the
 * appointment lanes (ISA appointments, listing appointments) — all hosted by
 * platform/brokerage/team/agent actors. Vendors take bookings through the
 * vendor-booking rail and never host OS-scheduled appointments, so vendor Zoom
 * is an honest not-offered verdict, not a dead Connect button.
 */
export const ZOOM_OFFERINGS: Record<ZoomScope, ZoomOffering> = {
  platform: {
    status: "connectable",
    connectPath: ZOOM_OAUTH_START,
    verdict:
      "The platform's own Zoom account (tenant success calls, demos, platform-hosted meetings). Stored under the distinct 'platform_zoom' key so the tenant credential cascade can never host on the company's account.",
  },
  brokerage: {
    status: "connectable",
    connectPath: ZOOM_OAUTH_START,
    verdict:
      "The brokerage's Zoom account: appointments booked with a Zoom location create real meetings here when the booking agent has no personal or team Zoom connected.",
  },
  team: {
    status: "connectable",
    connectPath: ZOOM_OAUTH_START,
    verdict:
      "The team's Zoom account: team members' Zoom appointments host here when the member has no personal Zoom connected.",
  },
  agent: {
    status: "connectable",
    connectPath: ZOOM_OAUTH_START,
    verdict:
      "Your personal Zoom account: appointments you book with a Zoom location create real meetings on your account, with the join link stamped on the calendar event.",
  },
  vendor: {
    status: "not-offered",
    connectPath: null,
    verdict:
      "Not offered — no vendor meeting-creation flow: vendors take bookings through the vendor-booking rail and never host OS-scheduled appointments, so a Connect button would mint a dead credential.",
  },
}

/** Pure: is Zoom actually connectable at this scope? */
export function isZoomOffered(scope: ZoomScope): boolean {
  return ZOOM_OFFERINGS[scope].status === "connectable"
}

// ─── Provider gating (pure core + live env wrapper) ──────────────────────────

/** Pure: the honest statement of what is missing when the platform has not
 *  configured a Zoom OAuth app. Null when fully configured. */
export function zoomProviderGap(env: { clientId?: string | null; clientSecret?: string | null }): string | null {
  const missing: string[] = []
  if (!env.clientId) missing.push("ZOOM_CLIENT_ID")
  if (!env.clientSecret) missing.push("ZOOM_CLIENT_SECRET")
  if (missing.length === 0) return null
  return `Zoom OAuth app not configured at the platform level — missing ${missing.join(" and ")}. Set them in the environment to enable Zoom connections.`
}

/** Live: is the Zoom OAuth app configured? (Drives every connect button.) */
export function isZoomProviderConfigured(): boolean {
  return zoomProviderGap({
    clientId: process.env.ZOOM_CLIENT_ID ?? null,
    clientSecret: process.env.ZOOM_CLIENT_SECRET ?? null,
  }) === null
}

/** Live: the gap statement for the current environment (null when configured). */
export function currentZoomProviderGap(): string | null {
  return zoomProviderGap({
    clientId: process.env.ZOOM_CLIENT_ID ?? null,
    clientSecret: process.env.ZOOM_CLIENT_SECRET ?? null,
  })
}

// ─── Owner resolution (pure — the accounting-scopes idiom) ───────────────────

export interface ZoomOwnerIds {
  brokerageId?: string | null
  teamId?: string | null
  /** auth user id — agent-scope rows are keyed by the USER id (what the OAuth
   *  route writes: owner_type='agent', owner_id=<auth user id>). */
  agentUserId?: string | null
}

/** Pure: resolve the owning entity id for a scope. Null when the actor lacks
 *  the required anchor. NO cross-scope fallback — an unresolvable owner is an
 *  honest null, never someone else's id. */
export function resolveZoomOwner(
  scope: ZoomScope,
  ids: ZoomOwnerIds,
): { ownerType: ZoomScope; ownerId: string } | null {
  if (scope === "vendor") return null // not offered — no owner to resolve
  const pick =
    scope === "platform" ? PLATFORM_ZOOM_OWNER_ID
    : scope === "brokerage" ? ids.brokerageId
    : scope === "team" ? ids.teamId
    : ids.agentUserId
  return pick ? { ownerType: scope, ownerId: pick } : null
}

/** Pure: the EXACT-match filter a Zoom read uses. Exported so the simulator
 *  can prove no two scopes ever share a filter (no token leakage). */
export function zoomOwnerFilter(
  scope: ZoomScope,
  ownerId: string,
): { owner_type: string; owner_id: string; platform: string } {
  return { owner_type: scope, owner_id: ownerId, platform: zoomStorageKey(scope) }
}

export interface ZoomHostContext {
  /** The connecting actor's connection scope (connectionScopeForUserType). */
  scope: ZoomScope | "contact"
  agentUserId?: string | null
  teamId?: string | null
  brokerageId?: string | null
}

/**
 * Pure: the ordered EXACT-owner candidates a meeting-creation attempt tries as
 * host, most-specific first. This is a deliberate, documented MEETING-HOST
 * cascade (an agent without their own Zoom may host on the team's, then the
 * brokerage's account) — each step is still an exact (owner_type, owner_id)
 * match, and tenant actors can NEVER reach the platform's account (distinct
 * 'platform_zoom' key + the platform owner is simply not in their list).
 * Platform actors host ONLY on the platform's own account. Vendor/contact
 * actors get an empty list (not offered).
 */
export function zoomHostCascade(ctx: ZoomHostContext): Array<{ ownerType: ZoomScope; ownerId: string }> {
  if (ctx.scope === "platform") {
    return [{ ownerType: "platform", ownerId: PLATFORM_ZOOM_OWNER_ID }]
  }
  if (ctx.scope === "vendor" || ctx.scope === "contact") return []
  const out: Array<{ ownerType: ZoomScope; ownerId: string }> = []
  if (ctx.agentUserId) out.push({ ownerType: "agent", ownerId: ctx.agentUserId })
  if (ctx.teamId) out.push({ ownerType: "team", ownerId: ctx.teamId })
  if (ctx.brokerageId) out.push({ ownerType: "brokerage", ownerId: ctx.brokerageId })
  return out
}

/** The settings hint surfaced when an appointment asks for Zoom but no scope
 *  in the actor's cascade has it connected. */
export const ZOOM_SETTINGS_HINT =
  "No Zoom account is connected for you, your team, or your brokerage — connect one under Settings to make appointments Zoom meetings. Booked as in-person/phone for now."

// ─── Live: scoped Zoom credential (exact owner match) ────────────────────────

const ZOOM_TOKEN_URL = "https://zoom.us/oauth/token"
const ZOOM_API_BASE = "https://api.zoom.us"

export interface ScopedZoomCredential {
  id: string
  scope: ZoomScope
  ownerId: string
  accessToken: string
  refreshToken: string
  tokenExpiresAt: string | null
  /** Zoom account email captured at connect time (config.email). */
  accountEmail: string | null
}

/**
 * Load ONE scope's Zoom credential by EXACT owner match — deliberately NOT
 * resolveScopedConnection: the host cascade above decides WHICH owners to try;
 * each try is an exact match so a token can never serve a different owner.
 * Returns null when not connected / inactive / unusable.
 */
export async function loadScopedZoomCredential(
  svc: ServiceClient,
  scope: ZoomScope,
  ownerId: string,
): Promise<ScopedZoomCredential | null> {
  const filter = zoomOwnerFilter(scope, ownerId)
  const { data } = await svc
    .from("platform_credentials")
    .select("id, access_token, refresh_token, token_expires_at, config, is_active")
    .eq("owner_type", filter.owner_type)
    .eq("owner_id", filter.owner_id)
    .eq("platform", filter.platform)
    .maybeSingle()

  if (!data || data.is_active === false) return null
  const config = (data.config ?? {}) as Record<string, unknown>
  const accessToken = (data.access_token as string | null) ?? (config.access_token as string | undefined) ?? null
  const refreshToken = (data.refresh_token as string | null) ?? (config.refresh_token as string | undefined) ?? ""
  if (!accessToken) return null
  return {
    id: data.id as string,
    scope,
    ownerId,
    accessToken,
    refreshToken,
    tokenExpiresAt: (data.token_expires_at as string | null) ?? null,
    accountEmail: (config.email as string | undefined) ?? null,
  }
}

/** Refresh the access token when near expiry and persist the new set on the
 *  SAME owner-scoped row (Zoom rotates refresh tokens — always persist both).
 *  Returns the live access token. Throws on failure. */
export async function ensureFreshZoomToken(
  svc: ServiceClient,
  cred: ScopedZoomCredential,
): Promise<string> {
  const exp = cred.tokenExpiresAt ? Date.parse(cred.tokenExpiresAt) : NaN
  const nearExpiry = !Number.isNaN(exp) && exp <= Date.now() + 5 * 60_000
  if (!nearExpiry || !cred.refreshToken) return cred.accessToken

  const clientId = process.env.ZOOM_CLIENT_ID
  const clientSecret = process.env.ZOOM_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error(currentZoomProviderGap() ?? "Zoom app credentials not configured")
  }

  const tokenUrl = new URL(ZOOM_TOKEN_URL)
  const res = await callConnector<{ access_token: string; refresh_token: string; expires_in: number }>({
    connector: "zoom-oauth",
    baseUrl: tokenUrl.origin,
    path: tokenUrl.pathname,
    method: "POST",
    // Zoom's token endpoint requires HTTP Basic auth (client_id:client_secret).
    auth: { style: "basic", username: clientId, password: clientSecret },
    bodyType: "form",
    body: { grant_type: "refresh_token", refresh_token: cred.refreshToken },
  })
  if (!res.ok || !res.data?.access_token) {
    throw new Error(`Zoom token refresh failed (${res.status ?? "—"}): ${res.error ?? ""}`)
  }
  const tokenExpiresAt = new Date(Date.now() + (res.data.expires_in ?? 3600) * 1000).toISOString()
  // ZOOM ROTATES THE REFRESH TOKEN: the one we just spent is now dead. If this
  // persist is refused and nobody is told, the row keeps the spent token and the
  // integration is permanently broken at the next refresh — while this call
  // still returns a working access token, so the failure surfaces an hour later
  // with nothing pointing back here. The function already throws on a failed
  // refresh; a failed persist is the same class of failure.
  const { error: persistError } = await svc
    .from("platform_credentials")
    .update({
      access_token: res.data.access_token,
      refresh_token: res.data.refresh_token,
      token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", cred.id)
  if (persistError) {
    throw new Error(`Zoom token refreshed but could not be stored — the stored refresh token is now spent: ${persistError.message}`)
  }
  return res.data.access_token
}

/** Single egress choke point for Zoom API calls (Bearer, via the connector-gateway). */
export async function zoomRequest<T>(args: {
  accessToken: string
  method: "GET" | "POST" | "PATCH" | "DELETE"
  path: string // e.g. "/v2/users/me/meetings"
  body?: unknown
}): Promise<{ ok: boolean; status: number | null; data: T | null; error: string | null }> {
  const res = await callConnector<T>({
    connector: "zoom",
    baseUrl: ZOOM_API_BASE,
    path: args.path,
    method: args.method,
    body: args.body,
    auth: { style: "bearer", token: args.accessToken },
  })
  return { ok: res.ok, status: res.status, data: res.data, error: res.error }
}

// ─── Live: real meeting creation (honest — created only on API acceptance) ───

export type ZoomMeetingOutcome =
  | {
      created: true
      meetingId: string
      joinUrl: string
      startUrl: string | null
      hostOwnerType: ZoomScope
      hostOwnerId: string
      hostEmail: string | null
    }
  | {
      created: false
      reason: "provider_unconfigured" | "not_connected" | "api_error"
      /** Rendered to the booking surface — the settings hint or the API error. */
      detail: string
    }

/**
 * Create a REAL Zoom meeting for an appointment, hosted by the first owner in
 * the actor's host cascade with Zoom connected. Returns an honest refusal
 * (never a fabricated link) when the provider is unconfigured, no owner is
 * connected, or the Zoom API rejects the request. auto_recording=cloud is
 * requested so the recording/transcript webhook lane can enrich the contact
 * afterward (Zoom only honors it on accounts licensed for cloud recording).
 */
export async function ensureZoomMeetingForAppointment(
  svc: ServiceClient,
  args: {
    host: ZoomHostContext
    topic: string
    startAt: Date
    endAt?: Date | null
    timezoneName?: string | null
  },
): Promise<ZoomMeetingOutcome> {
  if (!isZoomProviderConfigured()) {
    return { created: false, reason: "provider_unconfigured", detail: currentZoomProviderGap()! }
  }

  const candidates = zoomHostCascade(args.host)
  let cred: ScopedZoomCredential | null = null
  for (const c of candidates) {
    cred = await loadScopedZoomCredential(svc, c.ownerType, c.ownerId)
    if (cred) break
  }
  if (!cred) {
    return { created: false, reason: "not_connected", detail: ZOOM_SETTINGS_HINT }
  }

  try {
    const accessToken = await ensureFreshZoomToken(svc, cred)
    const durationMinutes = args.endAt
      ? Math.max(15, Math.round((args.endAt.getTime() - args.startAt.getTime()) / 60_000))
      : 30
    const res = await zoomRequest<{ id?: number | string; uuid?: string; join_url?: string; start_url?: string }>({
      accessToken,
      method: "POST",
      path: "/v2/users/me/meetings",
      body: {
        topic: args.topic.slice(0, 200),
        type: 2, // scheduled meeting
        start_time: args.startAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
        duration: durationMinutes,
        ...(args.timezoneName ? { timezone: args.timezoneName } : {}),
        settings: {
          join_before_host: true,
          waiting_room: false,
          auto_recording: "cloud",
        },
      },
    })
    // "created" ONLY on real API acceptance: an id AND a join_url in the body.
    if (!res.ok || !res.data?.id || !res.data.join_url) {
      return {
        created: false,
        reason: "api_error",
        detail: `Zoom meeting creation failed (${res.status ?? "—"}): ${res.error ?? "no meeting id/join_url returned"}`,
      }
    }
    return {
      created: true,
      meetingId: String(res.data.id),
      joinUrl: res.data.join_url,
      startUrl: res.data.start_url ?? null,
      hostOwnerType: cred.scope,
      hostOwnerId: cred.ownerId,
      hostEmail: cred.accountEmail,
    }
  } catch (e: any) {
    return { created: false, reason: "api_error", detail: e?.message ?? "Zoom meeting creation failed" }
  }
}

// ─── Live: per-scope connection status (drives the settings cards) ───────────

export interface ScopedZoomStatus {
  scope: ZoomScope
  ownerId: string
  offering: ZoomOffering
  connected: boolean
  accountEmail: string | null
  /** Provider gating: null when the Zoom OAuth app is configured; otherwise the
   *  honest statement of what is missing (rendered instead of a dead button). */
  providerGap: string | null
}

/** Read one owner's Zoom connection by EXACT owner match (no cascade — the
 *  status a card shows is that owner's own state, never an inherited one). */
export async function readScopedZoom(
  svc: ServiceClient,
  scope: ZoomScope,
  ownerId: string,
): Promise<ScopedZoomStatus> {
  const offering = ZOOM_OFFERINGS[scope]
  const cred = offering.status === "connectable"
    ? await loadScopedZoomCredential(svc, scope, ownerId)
    : null
  return {
    scope,
    ownerId,
    offering,
    connected: !!cred,
    accountEmail: cred?.accountEmail ?? null,
    providerGap: currentZoomProviderGap(),
  }
}

// ─── Meeting SDK signature (pure — round 40 in-page embed upgrade) ───────────
//
// The Component (embedded) view of the Zoom Meeting SDK joins a meeting with
// an SDK JWT — NOT an OAuth token: HS256 over { appKey, sdkKey, mn, role,
// iat, exp, tokenExp } signed with the SDK secret. Credentials come from a
// Zoom "Meeting SDK" app (ZOOM_SDK_KEY / ZOOM_SDK_SECRET) — OR, on newer Zoom
// "General" apps (Zoom unified app types in 2023+), the SAME client id/secret
// as the OAuth app, so we fall back to ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET
// when no dedicated SDK vars are set.
//
// OPS REQUIREMENTS for the in-page embed (documented here, the one place):
//   • The Zoom app must have the Meeting SDK feature/embed enabled
//     (Marketplace → your app → Features → Embed → Meeting SDK).
//   • The app's Domain Allow List must include the OS host (the origin the
//     dashboard is served from), or the SDK refuses to join in-browser.

export interface ZoomSdkEnv {
  sdkKey?: string | null
  sdkSecret?: string | null
  clientId?: string | null
  clientSecret?: string | null
}

/** Pure: resolve the Meeting SDK credential pair. Dedicated SDK vars win; a
 *  complete OAuth pair is the documented General-app fallback; otherwise null
 *  (never a half pair — a key without its secret cannot sign). */
export function resolveZoomSdkCredentials(
  env: ZoomSdkEnv,
): { sdkKey: string; sdkSecret: string; source: "sdk_app" | "general_app" } | null {
  if (env.sdkKey && env.sdkSecret) return { sdkKey: env.sdkKey, sdkSecret: env.sdkSecret, source: "sdk_app" }
  if (env.clientId && env.clientSecret) return { sdkKey: env.clientId, sdkSecret: env.clientSecret, source: "general_app" }
  return null
}

/** Pure: the honest statement of exactly which env is missing for the Meeting
 *  SDK embed. Null when a usable pair exists. */
export function zoomSdkGap(env: ZoomSdkEnv): string | null {
  if (resolveZoomSdkCredentials(env)) return null
  const sdkTouched = !!(env.sdkKey || env.sdkSecret)
  if (sdkTouched) {
    const missing: string[] = []
    if (!env.sdkKey) missing.push("ZOOM_SDK_KEY")
    if (!env.sdkSecret) missing.push("ZOOM_SDK_SECRET")
    return `Zoom Meeting SDK partially configured — missing ${missing.join(" and ")}. Both are required to sign the SDK JWT.`
  }
  const oauthTouched = !!(env.clientId || env.clientSecret)
  if (oauthTouched) {
    const missing: string[] = []
    if (!env.clientId) missing.push("ZOOM_CLIENT_ID")
    if (!env.clientSecret) missing.push("ZOOM_CLIENT_SECRET")
    return `Zoom Meeting SDK not configured — no ZOOM_SDK_KEY/ZOOM_SDK_SECRET, and the General-app fallback is missing ${missing.join(" and ")}.`
  }
  return "Zoom Meeting SDK not configured — missing ZOOM_SDK_KEY and ZOOM_SDK_SECRET (or, for a Zoom 'General' app where the Meeting SDK shares the OAuth credentials, ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET)."
}

/** Live: the current env for the Meeting SDK credential resolution. */
export function currentZoomSdkEnv(): ZoomSdkEnv {
  return {
    sdkKey: process.env.ZOOM_SDK_KEY ?? null,
    sdkSecret: process.env.ZOOM_SDK_SECRET ?? null,
    clientId: process.env.ZOOM_CLIENT_ID ?? null,
    clientSecret: process.env.ZOOM_CLIENT_SECRET ?? null,
  }
}

/** Pure: the viewer's Meeting SDK role for a calendar event — 1 (host) only
 *  when the viewer IS the event's owning agent; everyone else joins as 0. */
export function zoomSdkRoleForViewer(args: {
  viewerUserId: string
  eventAgentUserId: string | null | undefined
}): 0 | 1 {
  return args.eventAgentUserId != null && args.eventAgentUserId === args.viewerUserId ? 1 : 0
}

const b64url = (input: Buffer | string): string =>
  (typeof input === "string" ? Buffer.from(input) : input).toString("base64url")

/**
 * Pure: mint the Meeting SDK JWT. Zoom requires HS256, appKey (=== sdkKey),
 * mn (meeting number), role (0|1), iat/exp with 1800s ≤ exp−iat ≤ 172800s,
 * and tokenExp ≥ exp. iat is backdated 30s for clock skew.
 */
export function mintZoomSdkSignature(args: {
  sdkKey: string
  sdkSecret: string
  meetingNumber: string
  role: 0 | 1
  nowMs?: number
  expiresInSec?: number
}): string {
  const iat = Math.floor((args.nowMs ?? Date.now()) / 1000) - 30
  const lifetime = Math.min(Math.max(args.expiresInSec ?? 2 * 60 * 60, 1800), 172_800)
  const exp = iat + lifetime
  const header = { alg: "HS256", typ: "JWT" }
  const payload = {
    appKey: args.sdkKey,
    sdkKey: args.sdkKey,
    mn: args.meetingNumber,
    role: args.role,
    iat,
    exp,
    tokenExp: exp,
  }
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`
  const sig = createHmac("sha256", args.sdkSecret).update(signingInput).digest("base64url")
  return `${signingInput}.${sig}`
}

/** Pure: the pwd Zoom stamps into a join_url query string (the embedded client
 *  needs it as a separate `password` field). Null when absent/unparsable. */
export function zoomPasswordFromJoinUrl(joinUrl: string | null | undefined): string | null {
  if (!joinUrl) return null
  try {
    return new URL(joinUrl).searchParams.get("pwd")
  } catch {
    return null
  }
}

// ─── Webhook verification (pure — Zoom's documented scheme) ──────────────────

/** Pure: the x-zm-signature value Zoom computes for a request:
 *  v0=HMAC_SHA256_hex(`v0:{timestamp}:{rawBody}`, secretToken). */
export function zoomWebhookSignature(rawBody: string, timestamp: string, secretToken: string): string {
  const digest = createHmac("sha256", secretToken).update(`v0:${timestamp}:${rawBody}`).digest("hex")
  return `v0=${digest}`
}

/** Pure: verify an incoming Zoom webhook. Missing secret/header/timestamp →
 *  reject (the Vapi-webhook gate idiom: no secret, no processing). Timestamps
 *  older than 5 minutes are rejected (Zoom's replay guidance). */
export function verifyZoomWebhook(args: {
  rawBody: string
  timestamp: string | null
  signatureHeader: string | null
  secretToken: string | null | undefined
  nowMs?: number
}): boolean {
  if (!args.secretToken || !args.signatureHeader || !args.timestamp) return false
  const ts = Number(args.timestamp)
  if (!Number.isFinite(ts)) return false
  const now = args.nowMs ?? Date.now()
  if (Math.abs(now - ts * 1000) > 5 * 60_000) return false
  return zoomWebhookSignature(args.rawBody, args.timestamp, args.secretToken) === args.signatureHeader
}

/** Pure: the response body for Zoom's endpoint.url_validation challenge:
 *  { plainToken, encryptedToken: HMAC_SHA256_hex(plainToken, secretToken) }. */
export function zoomUrlValidationResponse(plainToken: string, secretToken: string): { plainToken: string; encryptedToken: string } {
  return {
    plainToken,
    encryptedToken: createHmac("sha256", secretToken).update(plainToken).digest("hex"),
  }
}

// ─── Transcript parsing (pure) ───────────────────────────────────────────────

/**
 * Pure: Zoom cloud transcripts are WebVTT with per-cue speaker prefixes
 * ("Dana Kling: we'd list in September"). Collapse to plain "Speaker: line"
 * text, merging consecutive cues from the same speaker, dropping cue ids,
 * timestamps, and the WEBVTT header. Returns "" for non-VTT/empty input.
 */
export function parseZoomVtt(vtt: string): string {
  const lines = (vtt ?? "").split(/\r?\n/)
  const out: string[] = []
  let lastSpeaker: string | null = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line === "WEBVTT" || /^\d+$/.test(line)) continue
    if (line.includes("-->")) continue // timestamp cue line
    if (/^NOTE\b/.test(line)) continue
    const m = line.match(/^([^:]{1,80}):\s*(.*)$/)
    if (m && m[2]) {
      const speaker = m[1].trim()
      const text = m[2].trim()
      if (speaker === lastSpeaker && out.length > 0) {
        out[out.length - 1] += ` ${text}`
      } else {
        out.push(`${speaker}: ${text}`)
        lastSpeaker = speaker
      }
    } else {
      // Cue without a speaker prefix — continuation of the previous line.
      if (out.length > 0) out[out.length - 1] += ` ${line}`
      else { out.push(line); lastSpeaker = null }
    }
  }
  return out.join("\n")
}

// ─── Attach-target resolution (pure — contact vs tenant by host scope) ───────

export type ZoomAttachTarget =
  | { kind: "contact"; contactId: string }
  /** PLATFORM-scope meetings attach to the TENANT (brokerage) entity — the
   *  platform's "customer" is the tenant, so its transcript+insights land on
   *  the tenant's record, never inside a tenant contact's CRM history. */
  | { kind: "tenant"; brokerageId: string }
  | { kind: "none"; reason: string }

export interface ZoomEventForAttach {
  hostOwnerType: string | null
  brokerageId: string | null
  entityType: string | null
  entityId: string | null
  /** metadata.contact_id (listing appointments carry the contact here). */
  metadataContactId?: string | null
  /** leads.contact_id when entity_type='lead' (resolved by the caller). */
  leadContactId?: string | null
}

/** Pure: where a meeting's transcript attaches. Platform-hosted → the tenant;
 *  tenant-hosted → the contact tied to the calendar event (entity contact, a
 *  lead's linked contact, or the listing appointment's metadata contact). */
export function resolveZoomAttachTarget(ev: ZoomEventForAttach): ZoomAttachTarget {
  if (ev.hostOwnerType === "platform") {
    return ev.brokerageId
      ? { kind: "tenant", brokerageId: ev.brokerageId }
      : { kind: "none", reason: "platform-hosted meeting has no tenant anchor on the calendar event" }
  }
  if (ev.entityType === "contact" && ev.entityId) return { kind: "contact", contactId: ev.entityId }
  if (ev.entityType === "lead" && ev.leadContactId) return { kind: "contact", contactId: ev.leadContactId }
  if (ev.metadataContactId) return { kind: "contact", contactId: ev.metadataContactId }
  return { kind: "none", reason: "no contact is tied to this calendar event (lead without a linked contact record)" }
}
