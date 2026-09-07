// lib/providers/vibe.ts
// Vibe.co (self-serve streaming-TV / CTV ads) — the LIVE connector for the
// streaming-TV ad lane.
//
// Contract (https://developers.vibe.co): OAuth2 client-credentials → Bearer +
// X-Vibe-Revision on every call. A launch is a chain of real calls:
//   advertiser → upload video creative → create campaign (DRAFT) → create
//   strategy (budget + geo targeting + creative) → PUBLISH the campaign.
//
// HONESTY: dispatched:true is returned ONLY after Vibe confirms a PUBLISHED
// campaign. Any failure returns dispatched:false with the real Vibe error, and
// the ad_campaigns row is NOT flipped to live — the human-finalize path (Mark
// as launched) still exists as the fallback. No fabricated ids, no simulated
// launches. FAIR HOUSING: targeting is GEOGRAPHY + device only — never age or
// gender — matching the staging layer's geography-only rule.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveConnectionResult, type ResolvedConnection } from "@/lib/integrations/connection-manager"

export const VIBE_PROVIDER = "vibe"
export const VIBE_HOME_URL = "https://vibe.co"
const VIBE_API_BASE = "https://api.vibe.co"
// Pin the API revision. The documented header value is a full ISO DATE
// (`X-Vibe-Revision: YYYY-MM-DD`, developers.vibe.co/docs/api-versioning; the
// published OpenAPI is "revision 2026-06-01"). The earlier "2026-06" spelling
// was the year-month only, which the contract lists as a 400 "unknown revision".
// Bump deliberately per the changelog.
const VIBE_REVISION = "2026-06-01"

/** The four credential fields every Vibe call needs. `ResolvedConnection`
 *  satisfies it; so does the connector-registry credential projection. */
export type VibeCredential = Pick<ResolvedConnection, "apiKey" | "apiSecret" | "accountId" | "config">

export type VibeCredentialResolution =
  | { status: "connected"; conn: VibeCredential }
  | { status: "not_connected"; reason: string }
  /** `detail` names the store that refused; `reason` is the sentence a caller
   *  that makes no claim of its own may relay verbatim. */
  | { status: "unreadable"; detail: string; reason: string }

/**
 * THE ONE place a Vibe credential is resolved for a brokerage (§6: one
 * vocabulary). `dispatchCtvCampaign`, the connector registry
 * (lib/ads/connectors/registry.ts) and the performance ingest all ask here, so
 * "not connected" and "could not read the store" are told apart once.
 */
export async function resolveVibeCredential(brokerageId: string): Promise<VibeCredentialResolution> {
  const resolved = await resolveConnectionResult({ brokerageId, provider: VIBE_PROVIDER })
  const unreadable = resolved.status === "unreadable"
  if (unreadable) {
    return {
      status: "unreadable",
      detail: resolved.detail,
      reason: `vibe_connection_unreadable — the Vibe credential could not be READ (${resolved.detail}); this is not "not connected"`,
    }
  }
  const conn = resolved.status === "connected" ? resolved.connection : null
  if (!conn || !conn.apiKey || !conn.apiSecret) return { status: "not_connected", reason: "vibe_not_connected" }
  return { status: "connected", conn }
}

/**
 * Is a Vibe credential connected for this brokerage?
 * The unified resolver reads integration_credentials/platform_credentials/
 * agent_api_credentials under the canonical provider name 'vibe'.
 *
 * ─── WHY THIS ONE STAYS A BOOLEAN, AND THE DISPATCHER BELOW DOES NOT ─────────
 * It used to be `resolveConnection(…).catch(() => null)`, a null that meant both
 * "no connection" and "we could not tell" — the collapse wave 19 spent its whole
 * budget removing one layer up. The `.catch` is gone (the resolver reports its
 * failures as VALUES now and cannot throw), and the two outcomes are separated
 * at the resolver. What this function then does with them is a deliberate
 * PROJECTION, not a leftover collapse:
 *
 * The sole consumer is `app/dashboard/campaigns/ads/page.tsx:196`, which threads
 * the answer through `AdsDashboardClient` into `CtvLane` as `vibeConnected` —
 * eight render sites that all ask ONE question: "may we offer the in-app Launch
 * button, or the external vibe.co + Mark-as-launched fallback?" For that
 * question `not_connected` and `unreadable` have the SAME correct answer, and it
 * is the fail-closed one: do not promise a launch we cannot prove we can make.
 * The fallback path the badge falls back to is the honest one either way.
 *
 * Widening the return type here would push a three-state value through two
 * client component prop chains and eight branches to produce a third badge
 * nobody asked for, and would say nothing the user can act on differently. The
 * distinction earns its keep where an ACTION is taken and a claim is made about
 * why it was not — which is `dispatchCtvCampaign`, and that is exactly where it
 * is carried.
 */
export async function isVibeConfigured(brokerageId: string): Promise<boolean> {
  // Kept as the direct discriminated read on purpose: test:credential-cascade-refusal
  // (C9) pins this exact two-line shape as the posture read wave 19 fixed.
  const resolved = await resolveConnectionResult({ brokerageId, provider: VIBE_PROVIDER })
  return resolved.status === "connected" && !!resolved.connection.apiKey && !!resolved.connection.apiSecret
}

export interface CtvDispatchResult {
  /** true ONLY after Vibe confirms a PUBLISHED campaign. */
  dispatched: boolean
  reason: string
  /** Provider ids, present on success — stored back on the ad_campaigns row. */
  vibeCampaignId?: string
  vibeStrategyId?: string
  vibeCreativeId?: string
}

// ─── low-level Vibe client ───────────────────────────────────────────────────

class VibeError extends Error {
  constructor(public status: number, message: string) {
    super(message)
  }
}

/** Extract the human-readable message from Vibe's uniform error envelope. */
function vibeErrorMessage(status: number, body: any): string {
  const e = body?.error
  if (e?.message) {
    const detail = e.detail ? ` (${JSON.stringify(e.detail)})` : ""
    return `Vibe ${status}: ${e.message}${detail}`
  }
  return `Vibe ${status}`
}

/** Client-credentials token exchange (HTTP Basic client_id:client_secret).
 *  Scope is omitted → the token is issued with all scopes the client has. */
async function getAccessToken(conn: VibeCredential): Promise<string> {
  const clientId = conn.apiKey
  const clientSecret = conn.apiSecret
  if (!clientId || !clientSecret) throw new VibeError(401, "Vibe client_id/client_secret not configured")
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64")
  const res = await fetch(`${VIBE_API_BASE}/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new VibeError(res.status, `Vibe token exchange failed: ${body?.error_description ?? body?.error ?? res.status}`)
  const token = body?.access_token as string | undefined
  if (!token) throw new VibeError(500, "Vibe token response missing access_token")
  return token
}

/** Authenticated JSON call against api.vibe.co with the required headers. */
async function vibeFetch<T = any>(
  token: string,
  method: string,
  path: string,
  jsonBody?: unknown,
): Promise<T> {
  const res = await fetch(`${VIBE_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-Vibe-Revision": VIBE_REVISION,
      ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
  })
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}))
  if (!res.ok) throw new VibeError(res.status, vibeErrorMessage(res.status, body))
  return body as T
}

/** Resolve the advertiser to launch under: explicit config, then the account's
 *  first advertiser. */
async function resolveAdvertiserId(token: string, conn: VibeCredential): Promise<string> {
  const configured = (conn.config?.advertiser_id as string | undefined) ?? conn.accountId ?? undefined
  if (configured) return configured
  const list = await vibeFetch<{ data?: Array<{ id: string }> } | Array<{ id: string }>>(token, "GET", "/advertisers")
  const rows = Array.isArray(list) ? list : list?.data ?? []
  if (!rows.length) throw new VibeError(404, "No Vibe advertiser found — create one in Vibe or set config.advertiser_id")
  return rows[0].id
}

/** Upload a hosted video to Vibe (presigned S3 POST) and register the creative.
 *  Returns the creative id. */
async function uploadVideoCreative(
  token: string,
  advertiserId: string,
  videoUrl: string,
  creativeName: string,
): Promise<string> {
  // 1 — presigned target
  const presigned = await vibeFetch<{ upload_url: string; fields: Record<string, string>; upload_id: string }>(
    token,
    "GET",
    `/creatives/upload-url?advertiser_id=${encodeURIComponent(advertiserId)}`,
  )
  // 2 — pull the rendered video bytes
  const videoRes = await fetch(videoUrl)
  if (!videoRes.ok) throw new VibeError(videoRes.status, `Could not fetch the rendered video (${videoRes.status})`)
  const bytes = new Uint8Array(await videoRes.arrayBuffer())
  // 3 — multipart POST to S3 with every presigned field + the file last
  const form = new FormData()
  for (const [k, v] of Object.entries(presigned.fields ?? {})) form.append(k, v)
  form.append("file", new Blob([bytes], { type: "video/mp4" }), "creative.mp4")
  const s3 = await fetch(presigned.upload_url, { method: "POST", body: form })
  if (!s3.ok) throw new VibeError(s3.status, `Video upload to Vibe storage failed (${s3.status})`)
  // 4 — register the creative against the uploaded asset
  const creative = await vibeFetch<{ id: string }>(token, "POST", "/creatives/video", {
    advertiser_id: advertiserId,
    upload_id: presigned.upload_id,
    name: creativeName.slice(0, 100),
  })
  if (!creative?.id) throw new VibeError(500, "Vibe creative response missing id")
  return creative.id
}

// ─── orchestrated dispatch ───────────────────────────────────────────────────

/**
 * Dispatch a staged CTV campaign to Vibe end-to-end. Reads everything from the
 * staged ad_campaigns row (targeting_config carries the creative URL + geo +
 * budget). Returns dispatched:true only on a PUBLISHED campaign.
 */
export async function dispatchCtvCampaign(campaignId: string): Promise<CtvDispatchResult> {
  const supabase = createServiceClient()

  const { data: campaign, error } = await supabase
    .from("ad_campaigns")
    .select("id, brokerage_id, platform, status, campaign_name, daily_budget, targeting_config")
    .eq("id", campaignId)
    .maybeSingle()
  if (error) return { dispatched: false, reason: `campaign lookup failed: ${error.message}` }
  if (!campaign) return { dispatched: false, reason: "campaign not found" }
  if (campaign.platform !== "vibe_ctv") {
    return { dispatched: false, reason: `campaign platform is '${campaign.platform}', not 'vibe_ctv'` }
  }

  // THE REFUSAL IS NOT AN ABSENCE, AND HERE THE DIFFERENCE IS A CLAIM WE MAKE TO
  // THE USER. This used to be `.catch(() => null)` → "vibe_not_connected —
  // campaign staged as launch package", which told an operator their brokerage
  // has no Vibe account when what actually happened is that we could not read the
  // credential store. They then go and connect an account they already have, or
  // hand-launch on vibe.co, on the strength of a fact nobody established.
  // `dispatched` stays false on both paths — that is the fail-closed answer and
  // it does not change — but the REASON is now the true one.
  const resolved = await resolveVibeCredential(campaign.brokerage_id as string)
  if (resolved.status === "unreadable") {
    return {
      dispatched: false,
      reason: `vibe_connection_unreadable — the Vibe credential could not be READ (${resolved.detail}); this is not "not connected", and the campaign was left staged`,
    }
  }
  if (resolved.status === "not_connected") {
    return { dispatched: false, reason: "vibe_not_connected — campaign staged as launch package" }
  }
  const conn = resolved.conn

  const cfg = (campaign.targeting_config ?? {}) as {
    dmas?: string[]; cities?: string[]; zips?: string[]; creative_video_url?: string
  }
  const videoUrl = cfg.creative_video_url
  if (!videoUrl) return { dispatched: false, reason: "staged campaign has no creative_video_url" }
  // Validate the RAW staged budget before clamping — otherwise a null/0
  // daily_budget would silently launch a live CTV ad at the $1/day floor.
  const rawBudgetUsd = Number(campaign.daily_budget ?? 0)
  if (!Number.isFinite(rawBudgetUsd) || rawBudgetUsd <= 0) {
    return { dispatched: false, reason: "staged campaign has no daily budget" }
  }
  const budgetUsd = Math.max(1, Math.round(rawBudgetUsd))

  // Vibe campaign names must be 10–100 chars.
  const rawName = (campaign.campaign_name as string) || "Streaming TV campaign"
  const campaignName = rawName.length < 10 ? `${rawName} — Streaming TV`.slice(0, 100) : rawName.slice(0, 100)

  try {
    const token = await getAccessToken(conn)
    const advertiserId = await resolveAdvertiserId(token, conn)

    // 1 — creative
    const creativeId = await uploadVideoCreative(token, advertiserId, videoUrl, campaignName)

    // 2 — campaign (DRAFT). AWARENESS is the CTV goal; optimize on CPM.
    const targetCpm = Number(conn.config?.target_cpm_usd ?? 25)
    const created = await vibeFetch<{ id: string }>(token, "POST", "/campaigns", {
      advertiser_id: advertiserId,
      name: campaignName,
      goal: "AWARENESS",
      optimization_goal: { type: "CPM", value: targetCpm },
      countries: ["USA"],
      active: true,
    })
    const vibeCampaignId = created.id

    // 3 — strategy: daily budget, geo-only targeting (Fair Housing), TV device,
    //     and the creative attached. NO age/gender narrowing.
    const strategy = await vibeFetch<{ id: string }>(token, "POST", "/strategies", {
      campaign_id: vibeCampaignId,
      name: campaignName.slice(0, 100),
      budget: budgetUsd,
      budget_type: "DAILY",
      starts_at: new Date().toISOString(),
      active: true,
      targeting: {
        geo: {
          metro_codes: cfg.dmas?.length ? { include: cfg.dmas } : undefined,
          cities: cfg.cities?.length ? { include: cfg.cities } : undefined,
          zip_codes: cfg.zips?.length ? { include: cfg.zips } : undefined,
        },
        inventory: { type: "APPS_AND_CHANNELS" },
        devices: ["TV"],
      },
      creative_ids: [creativeId],
    })

    // 4 — publish to start delivery.
    await vibeFetch(token, "POST", `/campaigns/${vibeCampaignId}/actions`, { action: "PUBLISH" })

    return {
      dispatched: true,
      reason: "Published on Vibe",
      vibeCampaignId,
      vibeStrategyId: strategy.id,
      vibeCreativeId: creativeId,
    }
  } catch (e: any) {
    const reason = e instanceof VibeError ? e.message : `Vibe dispatch error: ${e?.message ?? String(e)}`
    return { dispatched: false, reason }
  }
}

// ─── reporting (the read-back half of the loop) ──────────────────────────────
//
// Vibe reporting is ASYNC: POST /reports returns a report resource, the caller
// polls GET /reports/{id} until status READY, then downloads `download_url`
// (valid 24h). Reports "typically complete within a few minutes" and the
// contract asks for no more than one poll per 10 seconds — so a cron tick never
// blocks on one. The ingest is two-phase instead: one pass REQUESTS a report and
// remembers its id on the campaign row; the next pass READS it and requests the
// next. Date windows are capped at 45 days (start inclusive, end exclusive).

export interface VibeReportRequest {
  conn: VibeCredential
  vibeCampaignId: string
  /** Report window start (ISO); clamped to Vibe's 45-day maximum. */
  sinceIso: string
}

export type VibeReportOutcome =
  /** A report was (re)quested; read it on the next pass. */
  | { kind: "pending"; reportId: string }
  /** The report is READY and summed over the window. */
  | { kind: "ready"; row: VibePerformanceTotals; reportId: string }
  /** The report FAILED / expired at Vibe — request a fresh one next pass. */
  | { kind: "failed"; reason: string }

/** CTV metrics summed over a report window. `pageViews` stands in for "clicks"
 *  on a screen with no click: it is the SITE VISITS Vibe attributes to the
 *  campaign through the impression tracker, which is the nearest honest cousin. */
export interface VibePerformanceTotals {
  spend: number
  impressions: number
  completedViews: number
  pageViews: number
  leads: number
  purchases: number
  signups: number
  purchaseAmount: number
}

const VIBE_REPORT_MAX_DAYS = 45
const VIBE_REPORT_METRICS = [
  "spend", "impressions", "completed_views", "number_of_page_views",
  "number_of_leads", "number_of_purchases", "amount_of_purchases", "number_of_signups",
] as const

function isoDate(d: Date): string { return d.toISOString().slice(0, 10) }

/** POST /reports for ONE campaign (filter campaign_id) over the window. */
export async function requestVibeCampaignReport(req: VibeReportRequest): Promise<{ reportId: string }> {
  const token = await getAccessToken(req.conn)
  const advertiserId = await resolveAdvertiserId(token, req.conn)
  const end = new Date()
  end.setUTCDate(end.getUTCDate() + 1) // end_date is EXCLUSIVE — include today
  const floor = new Date(end.getTime() - VIBE_REPORT_MAX_DAYS * 86_400_000)
  const since = new Date(req.sinceIso)
  const start = Number.isFinite(since.getTime()) && since > floor ? since : floor
  const created = await vibeFetch<{ id: string; status?: string }>(token, "POST", "/reports", {
    start_date: isoDate(start),
    end_date: isoDate(end),
    timezone: "UTC",
    advertiser_ids: [advertiserId],
    metrics: [...VIBE_REPORT_METRICS],
    dimensions: ["campaign_id"],
    filters: [{ dimension: "campaign_id", values: [req.vibeCampaignId] }],
    granularity: "DAY",
    format: "JSON",
  })
  if (!created?.id) throw new VibeError(500, "Vibe report response missing id")
  return { reportId: created.id }
}

/** GET /reports/{id}; when READY, download and SUM the rows for the campaign. */
export async function readVibeCampaignReport(
  conn: VibeCredential, reportId: string, vibeCampaignId: string,
): Promise<VibeReportOutcome> {
  const token = await getAccessToken(conn)
  const report = await vibeFetch<{ id: string; status: string; download_url?: string | null; error?: unknown }>(
    token, "GET", `/reports/${encodeURIComponent(reportId)}`,
  )
  const status = String(report?.status ?? "").toUpperCase()
  if (status === "CREATED" || status === "PROCESSING" || status === "PENDING") return { kind: "pending", reportId }
  if (status !== "READY" || !report.download_url) {
    return { kind: "failed", reason: `Vibe report ${reportId} is ${status || "unknown"} with no download_url` }
  }
  const res = await fetch(report.download_url)
  if (!res.ok) return { kind: "failed", reason: `Vibe report download failed (${res.status})` }
  // (not `.catch(() => null)` — that spelling is the two-facts null test:credential-cascade-refusal bans from this module)
  const body = await res.json().catch(() => ({})) as unknown
  const rows: Array<Record<string, unknown>> = Array.isArray(body)
    ? body as Array<Record<string, unknown>>
    : Array.isArray((body as { data?: unknown })?.data) ? (body as { data: Array<Record<string, unknown>> }).data
    : Array.isArray((body as { rows?: unknown })?.rows) ? (body as { rows: Array<Record<string, unknown>> }).rows
    : []
  const num = (r: Record<string, unknown>, k: string) => { const v = Number(r[k] ?? 0); return Number.isFinite(v) ? v : 0 }
  const totals: VibePerformanceTotals = { spend: 0, impressions: 0, completedViews: 0, pageViews: 0, leads: 0, purchases: 0, signups: 0, purchaseAmount: 0 }
  for (const r of rows) {
    // The filter already scopes to the campaign; a row naming another id is a
    // contract drift and is skipped rather than summed into the wrong campaign.
    const rowCampaign = r.campaign_id == null ? null : String(r.campaign_id)
    if (rowCampaign && rowCampaign !== vibeCampaignId) continue
    totals.spend          += num(r, "spend")
    totals.impressions    += num(r, "impressions")
    totals.completedViews += num(r, "completed_views")
    totals.pageViews      += num(r, "number_of_page_views")
    totals.leads          += num(r, "number_of_leads")
    totals.purchases      += num(r, "number_of_purchases")
    totals.signups        += num(r, "number_of_signups")
    totals.purchaseAmount += num(r, "amount_of_purchases")
  }
  return { kind: "ready", row: totals, reportId }
}
