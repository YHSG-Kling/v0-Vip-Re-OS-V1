// lib/providers/groundtruth-ads.ts
// GroundTruth (location-based programmatic DSP) — the connector for one of the two TV connections the
// owner ruled on 2026-10-29 (ruling 8: "groundtruth (https://api-docs.groundtruth.com/) and stackadapt are
// 2 tv connections"). It plugs into the EXISTING ad fabric — the AdConnector registry
// (lib/ads/connectors/registry.ts), the ONE streaming-TV gateway (lib/ads/ctv-campaign.ts: broadcast gate,
// READY TV master, approved topic) and the Ads Manager's launch → ingest → judge loop. It is not a second
// TV subsystem: staging, the gate and the human approval are the same ones Vibe rides.
//
// CONTRACT, as read on 2026-10-29 from the vendor's own published OpenAPI pages (https://api-docs.groundtruth.com,
// the per-page `.md` specs and https://api-docs.groundtruth.com/llms.txt; pages dated 2025-07-23 / 2025-08-12):
//   · base https://api-public.groundtruth.com ("Prod Env"); every call carries the two headers X-GT-USER-ID +
//     X-GT-API-KEY — "API credentials are provided on a request basis" (the welcome page), so the credential is
//     WAITING_EXTERNAL until GroundTruth issues it to the tenant.
//   · most calls take `tenant_id` (GroundTruth's own tenant, returned by GET /users/current) and `account_id`.
//   · campaign POST /campaigns (status enum 1 ACTIVE / 2 PAUSED; budget_level campaign|adgroup; budget_type
//     0 LIFETIME / 3 DAILY) → ad group POST /adgroups (media_types ⊂ app, web, desktop, ott, ctv,
//     audio-podcast, audio-streaming, dooh — at most 2; location_filters City/State/Zip/DMA/County/LatLng/Address)
//     → creative POST /creatives (type IMAGE | HTML5 | SCRIPT | VIDEO | TEXT_BANNER | AUDIO; video_url) →
//     PATCH /campaigns/{id} {status}.
//   · readback: GET /campaigns/{id} (status), GET /reporting/totals/campaign/{id} (impressions, clicks, spend,
//     total_conversions, visits, video quartiles, tv_imps, …), GET /reporting/spend/campaign/{id}
//     (total_spend), GET /reporting/ctv_ott/performance/campaign/{id} (CTV/OTT report).
//   · NOT documented (declared, never faked): a first-party CRM / hashed-identifier audience UPLOAD (audiences
//     reference ids of type custom_audience, but no create/upload endpoint is published), lead or response
//     objects, campaign webhooks (the only subscription in the docs is location-group notifications), and the
//     budget's currency unit beyond `number` (the launch refuses an account whose currency is not USD rather
//     than guess).
//
// HONESTY (the openai-ads.ts / vibe.ts rule): dispatched:true ONLY after GroundTruth accepted the activation;
// every failure returns the API's own message and the ad_campaigns row is untouched. FAIR HOUSING: an ad group
// is GEOGRAPHY + the CTV media type only — the documented genders / age_ranges / income_ranges / audiences
// fields are never sent (a housing ad is never narrowed by a protected class).

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveConnectionResult, type ResolvedConnection } from "@/lib/integrations/connection-manager"
import { callConnector, type GatewayRequest, type GatewayResponse } from "@/lib/agentic-os/connector-gateway"
import type { AdProviderDeclaration } from "@/lib/ads/connectors/types"

export const GROUNDTRUTH_PROVIDER = "groundtruth"
export const GROUNDTRUTH_HOME_URL = "https://www.groundtruth.com"
const GROUNDTRUTH_API_BASE = "https://api-public.groundtruth.com"
/** GroundTruth's documented enums (CampaignStatus / AdgroupStatus: 1 ACTIVE, 2 PAUSED; CampaignBudgetType 3 DAILY). */
const GT_STATUS_ACTIVE = 1
const GT_STATUS_PAUSED = 2
const GT_BUDGET_TYPE_DAILY = 3
/** Objective enum: 1 BRAND_AWARENESS … 5 VIDEO_VIEWS. A TV spot is an awareness buy. */
const GT_OBJECTIVE_BRAND_AWARENESS = 1
/** The flight the staged daily budget runs for (the ad group's budget period needs an end date). */
const GT_FLIGHT_DAYS = 30

/** THE capability declaration, from the documentation only (see the header for the pages read). */
export const GROUNDTRUTH_DECLARATION: AdProviderDeclaration = Object.freeze<AdProviderDeclaration>({
  provider: GROUNDTRUTH_PROVIDER,
  campaignPlatforms: ["groundtruth"],
  sources: [
    "https://api-docs.groundtruth.com/ (welcome: X-GT-USER-ID + X-GT-API-KEY; credentials on request)",
    "https://api-docs.groundtruth.com/llms.txt (332 endpoint pages; servers: https://api-public.groundtruth.com)",
    "https://api-docs.groundtruth.com/create-campaign-13499341e0.md · create-adgroup-13499345e0.md · create-creative-13499381e0.md",
    "https://api-docs.groundtruth.com/get-totals-campaign-13499362e0.md · get-campaign-spend-23208044e0.md · get-ctv-ott-performance-campaign-13499355e0.md",
    "https://api-docs.groundtruth.com/mediatype-4985377d0.md (app, web, desktop, ott, ctv, audio-podcast, audio-streaming, dooh)",
  ],
  readOn: "2026-10-29",
  credentialFields: ["X-GT-API-KEY (api_key)", "X-GT-USER-ID (api_secret slot)", "GroundTruth account id (account_id)"],
  tvFormats: ["ctv", "ott"],
  nonTvFormats: ["app", "web", "desktop", "audio-podcast", "audio-streaming", "dooh"],
  capabilities: {
    account_access:        { documented: "supported",   via: "rest", built: "lib/providers/groundtruth-ads.ts verifyGroundtruthAccount", evidence: "GET /users/current (user_id, tenant_id, status) + GET /accounts/{account_id}?tenant_id (currency, timezone)" },
    campaign_creation:     { documented: "supported",   via: "rest", built: "lib/providers/groundtruth-ads.ts launchGroundtruthCampaign", evidence: "POST /campaigns?tenant_id&account_id (CreateCampaignModel: name, budget_level, budget_type required) → POST /adgroups?tenant_id&campaign_id (budgets required)" },
    creative_association:  { documented: "supported",   via: "rest", built: "lib/providers/groundtruth-ads.ts launchGroundtruthCampaign", evidence: "POST /creatives?tenant_id&adgroup_id (type VIDEO, video_url) — the TV master URL is attached to the ad group" },
    budget:                { documented: "supported",   via: "rest", built: "lib/providers/groundtruth-ads.ts launchGroundtruthCampaign", evidence: "budget_type 3 DAILY at budget_level campaign; ad group budgets[{start_date,end_date,budget}] (minItems 1). Currency unit: UNKNOWN beyond `number` — launch refuses a non-USD account" },
    provider_review:       { documented: "unknown",     via: "none", built: null, evidence: "only DOOH creatives document an approval status (ConsolidatedDOOHApprovalStatus); no CTV creative review state is published" },
    status_readback:       { documented: "supported",   via: "poll", built: "lib/providers/groundtruth-ads.ts readGroundtruthCampaignStatus", evidence: "GET /campaigns/{campaign_id}?tenant_id → status 1 ACTIVE / 2 PAUSED" },
    performance_readback:  { documented: "supported",   via: "poll", built: "lib/providers/groundtruth-ads.ts fetchGroundtruthCampaignTotals", evidence: "GET /reporting/totals/campaign/{id}?start_date&end_date&tenant_id → impressions, clicks, spend, ctr, video quartiles, tv_imps" },
    conversion_readback:   { documented: "supported",   via: "poll", built: "lib/providers/groundtruth-ads.ts fetchGroundtruthCampaignTotals", evidence: "totals total_conversions / click_conversions / view_conversions; GET /reporting/pixel/campaign/{id} (multipixel conversions)" },
    attribution:           { documented: "supported",   via: "poll", built: null, evidence: "POST /reporting/foot_traffic_attribution, GET /reporting/incremental_visits/campaign/{id}, GET /reporting/web_engagement/campaign/{id} — store-visit / web attribution; not read here (a real-estate office visit is not a conversion this OS counts)" },
    ctv_inventory:         { documented: "supported",   via: "rest", built: "lib/providers/groundtruth-ads.ts launchGroundtruthCampaign (media_types ['ctv'])", evidence: "MediaType ctv / ott; GET /static/streaming_video/premium_ctv_categories; GET /reporting/ctv_ott/network|publisher/campaign/{id}. Whether the TENANT's account holds CTV inventory is an entitlement GroundTruth grants — WAITING_EXTERNAL" },
    lead_readback:         { documented: "unsupported", via: "none", built: null, evidence: "no lead / form object in the 332 published endpoints" },
    response_readback:     { documented: "unsupported", via: "none", built: null, evidence: "no comment / reply / message object — a TV ad has no reply channel; nothing reaches the C1 inbound record from GroundTruth" },
    audience_sync:         { documented: "unknown",     via: "none", built: null, evidence: "AudienceType lists custom_audience, but no create / upload endpoint for first-party identifiers is published — the connector refuses rather than guess" },
    webhooks:              { documented: "unsupported", via: "none", built: null, evidence: "the only subscription published is Subscribe Location Group Notifications — no campaign / delivery webhook; status and spend are POLLED" },
  },
})

export type GroundtruthCredential = Pick<ResolvedConnection, "apiKey" | "apiSecret" | "accountId" | "config"> & {
  /** The brokerage the credential was resolved FOR — carried onto every gateway row (tenant-scoped usage + health). */
  brokerageId?: string | null
}

export type GroundtruthCredentialResolution =
  | { status: "connected"; conn: GroundtruthCredential }
  | { status: "not_connected"; reason: string }
  | { status: "unreadable"; detail: string; reason: string }

/** The gateway seam: production is callConnector; a proof hands in a recorder (no network). */
export type GroundtruthTransport = (req: GatewayRequest) => Promise<GatewayResponse>

/**
 * THE ONE place a GroundTruth credential is resolved for a brokerage (§6). The connector registry, the launch
 * precheck and the launch itself ask here, so "not connected" and "could not read the store" are told apart once.
 * Both halves are required: X-GT-API-KEY (apiKey) and X-GT-USER-ID (stored in the slot's secret half).
 */
export async function resolveGroundtruthCredential(brokerageId: string): Promise<GroundtruthCredentialResolution> {
  const resolved = await resolveConnectionResult({ brokerageId, provider: GROUNDTRUTH_PROVIDER })
  if (resolved.status === "unreadable") {
    return { status: "unreadable", detail: resolved.detail, reason: `groundtruth_connection_unreadable — the GroundTruth credential could not be READ (${resolved.detail}); this is not "not connected"` }
  }
  const conn = resolved.status === "connected" ? resolved.connection : null
  if (!conn || !conn.apiKey || !conn.apiSecret) return { status: "not_connected", reason: "groundtruth_not_connected" }
  return { status: "connected", conn: { ...conn, brokerageId } }
}

class GroundtruthError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function gtErrorMessage(status: number, body: unknown): string {
  // The documented error envelope: { errors: [{ code, message, fields }] }.
  const errs = (body as { errors?: Array<{ code?: string; message?: string; fields?: unknown }> } | null)?.errors
  if (Array.isArray(errs) && errs.length) return `GroundTruth ${status}: ${errs.map((e) => `${e.message ?? e.code ?? "error"}${e.fields ? ` (${JSON.stringify(e.fields)})` : ""}`).join("; ")}`
  return `GroundTruth ${status}`
}

/** THE ONE GroundTruth egress — through the connector gateway (timeout, GET retry, tenant-scoped api_response_logs
 *  row, health). POSTs stay single-shot: a replayed campaign create would duplicate spend. */
async function gtFetch<T = any>(
  conn: GroundtruthCredential, method: "GET" | "POST" | "PATCH", path: string,
  query: Record<string, string>, jsonBody?: unknown, transport?: GroundtruthTransport,
): Promise<T> {
  if (!conn.apiKey || !conn.apiSecret) throw new GroundtruthError(401, "GroundTruth credential incomplete — both X-GT-API-KEY and X-GT-USER-ID are required")
  const req: GatewayRequest = {
    connector: "groundtruth", // == GROUNDTRUTH_PROVIDER, spelled literally so the provider census sees the site
    brokerageId: conn.brokerageId ?? null,
    baseUrl: GROUNDTRUTH_API_BASE,
    path,
    method,
    query,
    auth: { style: "header", name: "X-GT-API-KEY", value: conn.apiKey },
    headers: { "X-GT-USER-ID": conn.apiSecret },
    ...(jsonBody !== undefined ? { body: jsonBody } : {}),
  }
  const res = await (transport ?? callConnector)(req)
  if (!res.ok) throw new GroundtruthError(res.status ?? 0, res.errorBody !== undefined ? gtErrorMessage(res.status ?? 0, res.errorBody) : `GroundTruth ${res.status ?? "unreachable"}: ${res.error ?? ""}`.trim())
  return (res.data ?? {}) as T
}

interface GroundtruthAccountCheck {
  ok: boolean
  reason: string
  tenantId?: string
  accountId?: string
  accountName?: string | null
  currency?: string | null
}

/** Account access (ruling 8): the key works (GET /users/current names the GroundTruth tenant) and the configured
 *  account is readable under it (GET /accounts/{account_id}). Never a claim without both answers. Module-private:
 *  the launch asks it first; the proof reaches it through the launch. */
async function verifyGroundtruthAccount(conn: GroundtruthCredential, opts: { transport?: GroundtruthTransport } = {}): Promise<GroundtruthAccountCheck> {
  try {
    const me = await gtFetch<{ tenant_id?: number | string; status?: unknown }>(conn, "GET", "/users/current", {}, undefined, opts.transport)
    const tenantId = me?.tenant_id != null ? String(me.tenant_id) : ""
    if (!tenantId) return { ok: false, reason: "GroundTruth answered /users/current without a tenant_id — the account cannot be addressed" }
    if (!conn.accountId) return { ok: false, reason: "no GroundTruth account id on the connection — enter it in Settings → Connections", tenantId }
    const acct = await gtFetch<{ id?: number | string; name?: string; currency?: string }>(conn, "GET", `/accounts/${encodeURIComponent(conn.accountId)}`, { tenant_id: tenantId }, undefined, opts.transport)
    return { ok: true, reason: "GroundTruth account readable", tenantId, accountId: String(acct?.id ?? conn.accountId), accountName: acct?.name ?? null, currency: acct?.currency ?? null }
  } catch (e) {
    return { ok: false, reason: e instanceof GroundtruthError ? e.message : `GroundTruth account check error: ${(e as Error)?.message ?? String(e)}` }
  }
}

export interface GroundtruthLaunchResult {
  /** true ONLY after GroundTruth accepted the activation (status 1). */
  dispatched: boolean
  reason: string
  groundtruthCampaignId?: string
  groundtruthAdgroupId?: string
  groundtruthCreativeId?: string
}

/** PURE — the documented location filters for the staged geography (DMA / City / Zip). Nothing demographic. */
function gtLocationFilters(cfg: { dmas?: string[]; cities?: string[]; zips?: string[] }): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const dma of cfg.dmas ?? []) if (dma.trim()) out.push({ type: "DMA", dma: dma.trim(), exclude: false })
  for (const city of cfg.cities ?? []) {
    const [name, state] = city.split(",").map((s) => s.trim())
    if (name) out.push({ type: "City", city: name, ...(state ? { state } : {}), exclude: false })
  }
  for (const zip of cfg.zips ?? []) if (/^\d{5}$/.test(zip.trim())) out.push({ type: "Zip", zip_code: zip.trim(), exclude: false })
  return out
}

function isoDay(d: Date): string { return d.toISOString().slice(0, 10) }

/**
 * Launch a STAGED GroundTruth TV campaign end-to-end. The caller (lib/ads/connectors/groundtruth.ts) has already run
 * the ONE TV broadcast gate (ensureCtvBroadcastReady: approved public video, READY TV master, approved topic) — this
 * function reads the staged row's targeting (geography, the master URL, the CPM bid) and speaks the documented chain:
 * campaign (PAUSED) → CTV ad group → VIDEO creative → activate. dispatched:true only after the activation answered.
 */
export async function launchGroundtruthCampaign(campaignId: string, opts: { transport?: GroundtruthTransport; client?: ReturnType<typeof createServiceClient>; now?: Date; resolve?: typeof resolveGroundtruthCredential } = {}): Promise<GroundtruthLaunchResult> {
  const supabase = opts.client ?? createServiceClient()
  const { data: campaign, error } = await supabase
    .from("ad_campaigns")
    .select("id, brokerage_id, platform, status, campaign_name, daily_budget, targeting_config")
    .eq("id", campaignId)
    .maybeSingle()
  if (error) return { dispatched: false, reason: `campaign lookup failed: ${error.message}` }
  if (!campaign) return { dispatched: false, reason: "campaign not found" }
  const row = campaign as { id: string; brokerage_id: string; platform: string; status: string; campaign_name: string | null; daily_budget: number | null; targeting_config: Record<string, unknown> | null }
  if (row.platform !== "groundtruth") return { dispatched: false, reason: `campaign platform is '${row.platform}', not 'groundtruth'` }

  const resolved = await (opts.resolve ?? resolveGroundtruthCredential)(row.brokerage_id)
  if (resolved.status === "unreadable") return { dispatched: false, reason: `${resolved.reason}, and the campaign was left staged` }
  if (resolved.status === "not_connected") return { dispatched: false, reason: "groundtruth_not_connected — the campaign stays staged; GroundTruth issues API credentials on request (api-docs.groundtruth.com)" }
  const conn = resolved.conn

  const cfg = (row.targeting_config ?? {}) as { dmas?: string[]; cities?: string[]; zips?: string[]; creative_video_url?: string | null; creative_source?: string | null; bid_cpm_usd?: number | null }
  if (!cfg.creative_video_url || cfg.creative_source !== "tv_master") return { dispatched: false, reason: "the staged spot carries no READY TV master URL — GroundTruth receives the TV master, never the social reel" }
  const filters = gtLocationFilters(cfg)
  if (filters.length === 0) return { dispatched: false, reason: "no DMA / city / 5-digit ZIP on the staged spot — refusing rather than launching nationwide" }
  const daily = Number(row.daily_budget ?? 0)
  if (!Number.isFinite(daily) || daily <= 0) return { dispatched: false, reason: "staged campaign has no daily budget" }
  const bid = Number(cfg.bid_cpm_usd ?? 0)
  if (!Number.isFinite(bid) || bid <= 0) return { dispatched: false, reason: "no CPM bid on the staged spot (targeting_config.bid_cpm_usd) — GroundTruth bids per thousand impressions and a 0 bid never delivers; set it when staging" }

  const now = opts.now ?? new Date()
  const start = isoDay(now)
  const end = isoDay(new Date(now.getTime() + GT_FLIGHT_DAYS * 86_400_000))
  const name = ((row.campaign_name ?? "").trim() || "Streaming TV spot").slice(0, 256)

  try {
    const account = await verifyGroundtruthAccount(conn, { transport: opts.transport })
    if (!account.ok || !account.tenantId || !account.accountId) return { dispatched: false, reason: account.reason }
    if (account.currency && account.currency.toUpperCase() !== "USD") {
      return { dispatched: false, reason: `GroundTruth account currency is ${account.currency}; the published schema states the budget only as a number, so a non-USD account is refused rather than guessed` }
    }
    const tenantQ = { tenant_id: account.tenantId }

    const created = await gtFetch<{ id?: number | string }>(conn, "POST", "/campaigns", { ...tenantQ, account_id: account.accountId }, {
      name, budget: Math.round(daily * 100) / 100, budget_level: "campaign", budget_type: GT_BUDGET_TYPE_DAILY, bid_type: "CPM", status: GT_STATUS_PAUSED,
    }, opts.transport)
    if (created?.id == null) return { dispatched: false, reason: "GroundTruth created no campaign id" }
    const gtCampaignId = String(created.id)

    const group = await gtFetch<{ id?: number | string }>(conn, "POST", "/adgroups", { ...tenantQ, campaign_id: gtCampaignId }, {
      name: `${name} — CTV`.slice(0, 256),
      objective: GT_OBJECTIVE_BRAND_AWARENESS,
      media_types: ["ctv"],
      bid_type: "cpm",
      bid_price: bid,
      budgets: [{ start_date: start, end_date: end, budget: 0 }], // the budget is at the campaign level ("this will be 0")
      location_filters: filters,
    }, opts.transport)
    if (group?.id == null) return { dispatched: false, reason: "GroundTruth created no ad group id", groundtruthCampaignId: gtCampaignId }
    const gtAdgroupId = String(group.id)

    const creative = await gtFetch<{ id?: number | string }>(conn, "POST", "/creatives", { ...tenantQ, adgroup_id: gtAdgroupId }, {
      name: `${name} — TV master`.slice(0, 256), type: "VIDEO", video_url: cfg.creative_video_url,
    }, opts.transport)
    if (creative?.id == null) return { dispatched: false, reason: "GroundTruth created no creative id", groundtruthCampaignId: gtCampaignId, groundtruthAdgroupId: gtAdgroupId }

    await gtFetch(conn, "PATCH", `/campaigns/${encodeURIComponent(gtCampaignId)}`, tenantQ, { status: GT_STATUS_ACTIVE }, opts.transport)
    return { dispatched: true, reason: "Active on GroundTruth (CTV ad group, geography only)", groundtruthCampaignId: gtCampaignId, groundtruthAdgroupId: gtAdgroupId, groundtruthCreativeId: String(creative.id) }
  } catch (e) {
    return { dispatched: false, reason: e instanceof GroundtruthError ? e.message : `GroundTruth dispatch error: ${(e as Error)?.message ?? String(e)}` }
  }
}

/** GroundTruth's own tenant id for this credential: the connection's config (`gt_tenant_id`) when the tenant stored
 *  it, else GET /users/current. Never invented. */
async function gtTenantId(conn: GroundtruthCredential, transport?: GroundtruthTransport): Promise<string> {
  const stored = conn.config?.gt_tenant_id
  if (typeof stored === "string" && stored.trim()) return stored.trim()
  const me = await gtFetch<{ tenant_id?: number | string }>(conn, "GET", "/users/current", {}, undefined, transport)
  const id = me?.tenant_id != null ? String(me.tenant_id) : ""
  if (!id) throw new GroundtruthError(0, "GroundTruth answered /users/current without a tenant_id")
  return id
}

/** Status readback (poll — GroundTruth publishes no campaign webhook). */
export async function readGroundtruthCampaignStatus(conn: GroundtruthCredential, gtCampaignId: string, opts: { transport?: GroundtruthTransport } = {}): Promise<{ ok: true; status: "active" | "paused" | "unknown"; raw: unknown } | { ok: false; reason: string }> {
  try {
    const tenantId = await gtTenantId(conn, opts.transport)
    const c = await gtFetch<{ status?: number }>(conn, "GET", `/campaigns/${encodeURIComponent(gtCampaignId)}`, { tenant_id: tenantId }, undefined, opts.transport)
    const status = c?.status === GT_STATUS_ACTIVE ? "active" : c?.status === GT_STATUS_PAUSED ? "paused" : "unknown"
    return { ok: true, status, raw: c?.status ?? null }
  } catch (e) {
    return { ok: false, reason: e instanceof GroundtruthError ? e.message : String((e as Error)?.message ?? e) }
  }
}

export interface GroundtruthCampaignTotals {
  impressions: number
  clicks: number
  spend: number
  conversions: number
  videoCompletions: number
  tvImpressions: number
}

/** Performance readback: GET /reporting/totals/campaign/{id} over [since, today], rows summed (the endpoint answers
 *  an array of TotalsCampaignModel rows). */
export async function fetchGroundtruthCampaignTotals(conn: GroundtruthCredential, gtCampaignId: string, sinceIso: string, opts: { transport?: GroundtruthTransport; now?: Date } = {}): Promise<GroundtruthCampaignTotals> {
  const tenantId = await gtTenantId(conn, opts.transport)
  const since = new Date(sinceIso)
  const now = opts.now ?? new Date()
  const rows = await gtFetch<Array<Record<string, unknown>>>(conn, "GET", `/reporting/totals/campaign/${encodeURIComponent(gtCampaignId)}`, {
    start_date: isoDay(Number.isFinite(since.getTime()) ? since : new Date(now.getTime() - 30 * 86_400_000)), end_date: isoDay(now), tenant_id: tenantId,
  }, undefined, opts.transport)
  const num = (r: Record<string, unknown>, k: string) => { const n = Number(r[k] ?? 0); return Number.isFinite(n) ? n : 0 }
  const t: GroundtruthCampaignTotals = { impressions: 0, clicks: 0, spend: 0, conversions: 0, videoCompletions: 0, tvImpressions: 0 }
  for (const r of Array.isArray(rows) ? rows : []) {
    t.impressions += num(r, "impressions"); t.clicks += num(r, "clicks"); t.spend += num(r, "spend")
    t.conversions += num(r, "total_conversions"); t.videoCompletions += num(r, "video_end"); t.tvImpressions += num(r, "tv_imps")
  }
  t.spend = Math.round(t.spend * 100) / 100
  return t
}
