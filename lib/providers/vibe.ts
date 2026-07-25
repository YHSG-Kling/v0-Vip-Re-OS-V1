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
import { resolveConnection, type ResolvedConnection } from "@/lib/integrations/connection-manager"

export const VIBE_PROVIDER = "vibe"
export const VIBE_HOME_URL = "https://vibe.co"
const VIBE_API_BASE = "https://api.vibe.co"
// Pin the API revision (ISO year-month). Bump deliberately per the changelog.
const VIBE_REVISION = "2026-06"

/**
 * Is a Vibe credential connected for this brokerage?
 * The unified resolver reads integration_credentials/platform_credentials/
 * agent_api_credentials under the canonical provider name 'vibe'.
 */
export async function isVibeConfigured(brokerageId: string): Promise<boolean> {
  const conn = await resolveConnection({ brokerageId, provider: VIBE_PROVIDER }).catch(() => null)
  return !!conn && !!conn.apiKey && !!conn.apiSecret
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
async function getAccessToken(conn: ResolvedConnection): Promise<string> {
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
async function resolveAdvertiserId(token: string, conn: ResolvedConnection): Promise<string> {
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

  const conn = await resolveConnection({ brokerageId: campaign.brokerage_id as string, provider: VIBE_PROVIDER }).catch(() => null)
  if (!conn || !conn.apiKey || !conn.apiSecret) {
    return { dispatched: false, reason: "vibe_not_connected — campaign staged as launch package" }
  }

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
