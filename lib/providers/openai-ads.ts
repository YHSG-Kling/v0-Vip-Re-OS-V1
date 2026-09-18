// lib/providers/openai-ads.ts
// OpenAI Ads (ChatGPT Ads) — the LIVE Advertiser API connector for the ChatGPT
// ad lane. Owner, 2026-09-07: "https://developers.openai.com/ads/api-quickstart
// … finish missing ads capability needs built out fully. owners decision is
// build and fix."
//
// Contract (developers.openai.com/ads/api-reference/*): base
// https://api.ads.openai.com/v1, `Authorization: Bearer <Ads API key>` — the key
// is issued in the Ads Manager's Settings tab and is scoped to ONE ad account.
// A launch is a chain of real calls:
//   GET /ad_account (the key works, the account is reviewed) → GET
//   /geo_lookup/search per location (country / region / DMA ids; no ZIP) →
//   POST /upload {image_url} → POST /campaigns (status paused, budget
//   lifetime_spend_limit_micros, bidding_type, targeting.locations.include) →
//   POST /ad_groups (context_hints, bidding_config {billing_event_type,
//   max_bid_micros}) → POST /ads (creative chat_card {title, body, target_url,
//   file_id}) → POST /campaigns/{id} {status: active}.
// Insights: GET /campaigns/{id}/insights (impressions, clicks, spend).
//
// HONESTY: dispatched:true is returned ONLY after the campaign is activated;
// every failure returns dispatched:false with the API's own error message and
// the ad_campaigns row is untouched — the staged package + ads.openai.com by
// hand + Mark-as-launched + CSV import remain the fallback (lib/ads/chatgpt-campaign.ts).
// FAIR HOUSING: targeting is GEOGRAPHY (region/DMA) + intent context hints only
// — never an audience list, never a demographic.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveConnectionResult, type ResolvedConnection } from "@/lib/integrations/connection-manager"

export const OPENAI_ADS_PROVIDER = "openai_ads"
const OPENAI_ADS_API_BASE = "https://api.ads.openai.com/v1"
/** The API's budget is a LIFETIME cap in micros; the staged row carries a DAILY
 *  budget. One documented mapping: daily × this many days, with end_time set to
 *  match, so the cap and the flight agree. */
const OPENAI_ADS_FLIGHT_DAYS = 30
const MICROS = 1_000_000

export type OpenaiAdsCredential = Pick<ResolvedConnection, "apiKey" | "accountId" | "config">

export type OpenaiAdsCredentialResolution =
  | { status: "connected"; conn: OpenaiAdsCredential }
  | { status: "not_connected"; reason: string }
  | { status: "unreadable"; detail: string; reason: string }

/** THE ONE place an OpenAI Ads credential is resolved for a brokerage (§6). The
 *  dispatcher, the connector registry and the launch precheck all ask here, so
 *  "not connected" and "could not read the store" are told apart once. */
export async function resolveOpenaiAdsCredential(brokerageId: string): Promise<OpenaiAdsCredentialResolution> {
  const resolved = await resolveConnectionResult({ brokerageId, provider: OPENAI_ADS_PROVIDER })
  const unreadable = resolved.status === "unreadable"
  if (unreadable) {
    return {
      status: "unreadable",
      detail: resolved.detail,
      reason: `openai_ads_connection_unreadable — the OpenAI Ads credential could not be READ (${resolved.detail}); this is not "not connected"`,
    }
  }
  const conn = resolved.status === "connected" ? resolved.connection : null
  if (!conn || !conn.apiKey) return { status: "not_connected", reason: "openai_ads_not_connected" }
  return { status: "connected", conn }
}

/** Boolean posture for the lane UI (offer the in-app Launch button or not);
 *  not_connected and unreadable share the fail-closed answer here, and the
 *  distinction is carried where a CLAIM is made — dispatchChatgptCampaign. */
export async function isOpenaiAdsConfigured(brokerageId: string): Promise<boolean> {
  return (await resolveOpenaiAdsCredential(brokerageId)).status === "connected"
}

// ─── low-level client ────────────────────────────────────────────────────────

class OpenaiAdsError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function errorMessage(status: number, body: any): string {
  const e = body?.error
  if (e?.message) return `OpenAI Ads ${status}: ${e.message}${e.code ? ` (${e.code})` : ""}`
  if (typeof body?.message === "string") return `OpenAI Ads ${status}: ${body.message}`
  return `OpenAI Ads ${status}`
}

async function adsFetch<T = any>(conn: OpenaiAdsCredential, method: string, path: string, jsonBody?: unknown, idempotencyKey?: string): Promise<T> {
  if (!conn.apiKey) throw new OpenaiAdsError(401, "OpenAI Ads API key not configured")
  const res = await fetch(`${OPENAI_ADS_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${conn.apiKey}`,
      Accept: "application/json",
      ...(jsonBody !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: jsonBody !== undefined ? JSON.stringify(jsonBody) : undefined,
  })
  const body = res.status === 204 ? {} : await res.json().catch(() => ({}))
  if (!res.ok) throw new OpenaiAdsError(res.status, errorMessage(res.status, body))
  return body as T
}

interface OpenaiAdAccount { id: string; name: string | null; status: string | null; currency_code: string | null; review?: { status?: string | null } | null }

/** GET /ad_account — the key works and names the account. */
async function getOpenaiAdAccount(conn: OpenaiAdsCredential): Promise<OpenaiAdAccount> {
  return adsFetch<OpenaiAdAccount>(conn, "GET", "/ad_account")
}

interface OpenaiGeoLocation { id: string; type: string; name: string; canonical_name?: string; country_code?: string; region_code?: string }

/** GET /geo_lookup/search — the first targetable location for a query
 *  (country / region / DMA; the API does not target ZIPs). */
async function lookupOpenaiLocation(conn: OpenaiAdsCredential, query: string): Promise<OpenaiGeoLocation | null> {
  const q = query.trim()
  if (q.length < 2) return null
  const r = await adsFetch<{ results?: OpenaiGeoLocation[] }>(conn, "GET", `/geo_lookup/search?q=${encodeURIComponent(q)}&limit=3`)
  const rows = r?.results ?? []
  // Prefer a DMA (the metro a listing sits in), then a region, then anything.
  return rows.find((x) => x.type === "dma") ?? rows.find((x) => x.type === "region") ?? rows[0] ?? null
}

/** POST /upload {image_url} → file_id (the square listing photo for the chat card). */
async function uploadImageByUrl(conn: OpenaiAdsCredential, imageUrl: string): Promise<string> {
  const r = await adsFetch<{ file_id?: string }>(conn, "POST", "/upload", { image_url: imageUrl })
  if (!r?.file_id) throw new OpenaiAdsError(500, "OpenAI Ads upload response missing file_id")
  return r.file_id
}

// ─── orchestrated dispatch ───────────────────────────────────────────────────

export interface ChatgptDispatchResult {
  /** true ONLY after the campaign is ACTIVE on OpenAI Ads. */
  dispatched: boolean
  reason: string
  openaiCampaignId?: string
  openaiAdGroupId?: string
  openaiAdId?: string
  /** The ad's review_status as returned at creation (typically "in_review"). */
  reviewStatus?: string | null
  locationIds?: string[]
}

type Objective = "reach" | "clicks" | "conversions"

/** Objective → the API's bidding_type + the ad group's billing event + max bid
 *  in micros. Conversions bidding needs an active standard conversion event
 *  setting on the account (config.conversion_event_setting_id); without one the
 *  lane bids CLICKS and says so in the reason, rather than failing the launch. */
function biddingFor(objective: Objective, maxCpcUsd: number, cfg: Record<string, unknown>): {
  bidding_type: "impressions" | "clicks" | "conversions"; billing_event_type: "impression" | "click"; max_bid_micros: number
  conversion_event_setting_ids?: string[]; note?: string
} {
  if (objective === "reach") {
    const cpmUsd = Number(cfg.max_cpm_usd ?? 60) // the Ads Manager's default CPM cap
    return { bidding_type: "impressions", billing_event_type: "impression", max_bid_micros: Math.max(1, Math.round((cpmUsd / 1000) * MICROS)) }
  }
  const ces = typeof cfg.conversion_event_setting_id === "string" ? cfg.conversion_event_setting_id : null
  if (objective === "conversions" && ces) {
    const cpaUsd = Number(cfg.target_cpa_usd ?? 100)
    return { bidding_type: "conversions", billing_event_type: "click", max_bid_micros: Math.max(1, Math.round(cpaUsd * MICROS)), conversion_event_setting_ids: [ces] }
  }
  return {
    bidding_type: "clicks", billing_event_type: "click", max_bid_micros: Math.max(1, Math.round(maxCpcUsd * MICROS)),
    note: objective === "conversions" ? "no conversion_event_setting_id on the connection — bid CLICKS instead of oCPC" : undefined,
  }
}

/**
 * Dispatch a staged ChatGPT campaign to OpenAI Ads end-to-end. Reads the staged
 * ad_campaigns row (targeting_config: locations, context_hints, bid,
 * destination_url, chatgpt_objective) and its APPROVED creative (the one
 * ad-creative approval queue is the copy gate). Returns dispatched:true only
 * after the campaign is activated.
 */
export async function dispatchChatgptCampaign(campaignId: string): Promise<ChatgptDispatchResult> {
  const supabase = createServiceClient()
  const { data: campaign, error } = await supabase
    .from("ad_campaigns")
    .select("id, brokerage_id, platform, status, campaign_name, daily_budget, targeting_config")
    .eq("id", campaignId)
    .maybeSingle()
  if (error) return { dispatched: false, reason: `campaign lookup failed: ${error.message}` }
  if (!campaign) return { dispatched: false, reason: "campaign not found" }
  if (campaign.platform !== "chatgpt") return { dispatched: false, reason: `campaign platform is '${campaign.platform}', not 'chatgpt'` }

  const resolved = await resolveOpenaiAdsCredential(campaign.brokerage_id as string)
  if (resolved.status === "unreadable") {
    return { dispatched: false, reason: `${resolved.reason}, and the campaign was left staged` }
  }
  if (resolved.status === "not_connected") {
    return { dispatched: false, reason: "openai_ads_not_connected — campaign staged as launch package (upload it at ads.openai.com)" }
  }
  const conn = resolved.conn

  // The copy must have passed the one approval queue. supabase-js RESOLVES a
  // refusal — the error is read, not assumed to be "no creative".
  const { data: creatives, error: crErr } = await supabase
    .from("ad_creative_variations")
    .select("id, headline, primary_text, destination_url, media_asset_url")
    .eq("ad_campaign_id", campaignId).eq("approval_status", "approved")
    .order("updated_at", { ascending: false }).limit(1)
  if (crErr) return { dispatched: false, reason: `creative read refused: ${crErr.message}` }
  const creative = creatives?.[0] as { id: string; headline: string | null; primary_text: string | null; destination_url: string | null; media_asset_url: string | null } | undefined
  if (!creative) return { dispatched: false, reason: "no APPROVED creative — approve the ChatGPT ad copy in the approval queue first" }
  if (!creative.headline || !creative.primary_text) return { dispatched: false, reason: "approved creative has no headline/body" }
  if (!creative.media_asset_url) return { dispatched: false, reason: "approved creative has no image — a chat card needs a square PNG/JPG ≥256×256" }

  const cfg = (campaign.targeting_config ?? {}) as {
    locations?: string[]; context_hints?: string[]; bid?: { max_bid_usd?: number }; destination_url?: string; chatgpt_objective?: Objective
  }
  const destination = creative.destination_url ?? cfg.destination_url
  if (!destination) return { dispatched: false, reason: "staged campaign has no destination_url" }
  const rawDaily = Number(campaign.daily_budget ?? 0)
  if (!Number.isFinite(rawDaily) || rawDaily <= 0) return { dispatched: false, reason: "staged campaign has no daily budget" }
  const objective: Objective = cfg.chatgpt_objective ?? "clicks"
  const bidding = biddingFor(objective, Number(cfg.bid?.max_bid_usd ?? 4), conn.config ?? {})
  const name = (campaign.campaign_name as string | null)?.trim() || "ChatGPT listing campaign"
  const campaignName = name.length < 3 ? `${name} — ChatGPT` : name.slice(0, 1000)

  try {
    const account = await getOpenaiAdAccount(conn)
    if (account.status && account.status !== "active") return { dispatched: false, reason: `OpenAI ad account ${account.id} is ${account.status}, not active` }

    // Geography: region/DMA ids for the staged locations. A location the lookup
    // cannot resolve is skipped and named; none resolved → refuse rather than
    // run nationwide by accident (an empty include targets ALL locations).
    const wanted = (cfg.locations ?? []).map((l) => l.replace(/\s*\(postal\)\s*$/i, "")).filter((l) => !/^\d{5}(-\d{4})?$/.test(l))
    const locations: string[] = []
    const unresolved: string[] = []
    for (const q of wanted) {
      const hit = await lookupOpenaiLocation(conn, q)
      if (hit) locations.push(hit.id); else unresolved.push(q)
    }
    if (locations.length === 0) {
      return { dispatched: false, reason: `no targetable location resolved for ${wanted.length ? wanted.join(" / ") : "the staged campaign"} — OpenAI Ads targets country/region/DMA, not ZIPs; add a city or region` }
    }

    const fileId = await uploadImageByUrl(conn, creative.media_asset_url)

    const now = Math.floor(Date.now() / 1000)
    const created = await adsFetch<{ id: string }>(conn, "POST", "/campaigns", {
      name: campaignName,
      status: "paused",
      start_time: now,
      end_time: now + OPENAI_ADS_FLIGHT_DAYS * 86_400,
      budget: { lifetime_spend_limit_micros: Math.max(MICROS, Math.round(rawDaily * OPENAI_ADS_FLIGHT_DAYS * MICROS)) },
      bidding_type: bidding.bidding_type,
      ...(bidding.conversion_event_setting_ids ? { conversion_event_setting_ids: bidding.conversion_event_setting_ids } : {}),
      targeting: { locations: { include: Array.from(new Set(locations)).map((id) => ({ id })) } },
    }, `vip-ads-${campaignId}`)
    const openaiCampaignId = created.id

    const group = await adsFetch<{ id: string }>(conn, "POST", "/ad_groups", {
      campaign_id: openaiCampaignId,
      name: `${campaignName} — ${objective}`.slice(0, 1000),
      status: "active",
      context_hints: (cfg.context_hints ?? []).slice(0, 20),
      bidding_config: { billing_event_type: bidding.billing_event_type, max_bid_micros: bidding.max_bid_micros },
    }, `vip-ads-${campaignId}-group`)

    const ad = await adsFetch<{ id: string; review_status?: string | null }>(conn, "POST", "/ads", {
      ad_group_id: group.id,
      name: campaignName.slice(0, 1000),
      status: "active",
      creative: {
        type: "chat_card",
        title: creative.headline.slice(0, 50),
        body: creative.primary_text.slice(0, 100),
        target_url: destination,
        file_id: fileId,
      },
    }, `vip-ads-${campaignId}-ad`)

    await adsFetch(conn, "POST", `/campaigns/${encodeURIComponent(openaiCampaignId)}`, { status: "active" })

    const notes = [bidding.note, unresolved.length ? `unresolved locations skipped: ${unresolved.join(", ")}` : null].filter(Boolean)
    return {
      dispatched: true,
      reason: `Active on OpenAI Ads (ad ${ad.review_status ?? "in_review"})${notes.length ? ` — ${notes.join("; ")}` : ""}`,
      openaiCampaignId,
      openaiAdGroupId: group.id,
      openaiAdId: ad.id,
      reviewStatus: ad.review_status ?? null,
      locationIds: Array.from(new Set(locations)),
    }
  } catch (e: any) {
    const reason = e instanceof OpenaiAdsError ? e.message : `OpenAI Ads dispatch error: ${e?.message ?? String(e)}`
    return { dispatched: false, reason }
  }
}

// ─── insights (the read-back half of the loop) ───────────────────────────────

export interface OpenaiCampaignTotals { impressions: number; clicks: number; spend: number }

/** GET /campaigns/{id}/insights over [since, now], summed. Rows come back either
 *  flat (impressions/clicks/spend, as the quickstart's ad-level example) or
 *  prefixed by aggregation level (campaign.impressions …); both are read. */
export async function fetchOpenaiCampaignInsights(conn: OpenaiAdsCredential, openaiCampaignId: string, sinceIso: string): Promise<OpenaiCampaignTotals> {
  const since = new Date(sinceIso)
  const hour = 3600
  const end = Math.floor(Date.now() / 1000 / hour) * hour
  const start = Math.min(Number.isFinite(since.getTime()) ? Math.floor(since.getTime() / 1000 / hour) * hour : end - 30 * 86_400, end - hour)
  const params = new URLSearchParams()
  params.set("time_granularity", "daily")
  params.set("limit", "500")
  params.append("time_ranges[]", JSON.stringify({ type: "unix_range", start, end }))
  const r = await adsFetch<{ data?: Array<Record<string, unknown>> }>(conn, "GET", `/campaigns/${encodeURIComponent(openaiCampaignId)}/insights?${params.toString()}`)
  const num = (row: Record<string, unknown>, k: string) => {
    const v = row[k] ?? row[`campaign.${k}`] ?? (row.campaign as Record<string, unknown> | undefined)?.[k]
    const n = Number(v ?? 0); return Number.isFinite(n) ? n : 0
  }
  const t: OpenaiCampaignTotals = { impressions: 0, clicks: 0, spend: 0 }
  for (const row of r?.data ?? []) { t.impressions += num(row, "impressions"); t.clicks += num(row, "clicks"); t.spend += num(row, "spend") }
  t.spend = Math.round(t.spend * 100) / 100
  return t
}
