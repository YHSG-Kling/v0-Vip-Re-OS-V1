/**
 * lib/ads/connectors/meta.ts
 *
 * Wave 42 — the META (Facebook/Instagram) ad connector. Real Graph API calls for
 * Custom Audiences (hashed CRM upload), Lookalike creation, and Insights → our
 * normalized performance row. Never throws — a missing credential or API error
 * returns a structured failure so the kernel records it on the sync run.
 *
 * The response MAPPERS (mapInsights) are pure + exported for unit tests; the HTTP
 * is credential-gated (skips cleanly when no token / in the sandbox).
 */
import type { AdConnector, AudiencePushArgs, AudienceSyncResult, LookalikeArgs, PerformanceQuery, ProviderPerformanceRow } from "./types"
import { deriveMetrics } from "./types"

const GRAPH = "https://graph.facebook.com/v19.0"

/** Pure: map a Meta Insights data row → our normalized performance row. */
export function mapInsights(row: Record<string, unknown> | null | undefined): ProviderPerformanceRow {
  const num = (v: unknown) => (v == null ? 0 : Number(v) || 0)
  const spend = num(row?.spend)
  const impressions = num(row?.impressions)
  const clicks = num(row?.clicks)
  // Meta returns lead/conversion counts inside an `actions` array.
  const actions = Array.isArray(row?.actions) ? (row!.actions as Array<{ action_type?: string; value?: unknown }>) : []
  const actionVal = (type: string) => num(actions.find((a) => a.action_type === type)?.value)
  const leads = actionVal("lead") + actionVal("leadgen.other") + actionVal("onsite_conversion.lead_grouped")
  const conversions = actionVal("offsite_conversion.fb_pixel_purchase") + actionVal("purchase")
  // Revenue from the purchase action_value when a value-tracking pixel is configured.
  const actionValues = Array.isArray(row?.action_values) ? (row!.action_values as Array<{ action_type?: string; value?: unknown }>) : []
  const revenue = num(actionValues.find((a) => a.action_type === "offsite_conversion.fb_pixel_purchase" || a.action_type === "purchase")?.value)
  const { ctr, costPerLead } = deriveMetrics({ spend, impressions, clicks, leads })
  return { spend, impressions, clicks, leads, conversions, ctr, costPerLead, revenue }
}

async function graph(path: string, init: RequestInit & { token: string }): Promise<{ ok: boolean; json: any; status: number }> {
  const url = `${GRAPH}/${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(init.token)}`
  const res = await fetch(url, init)
  let json: any = null
  try { json = await res.json() } catch { /* non-json */ }
  return { ok: res.ok, json, status: res.status }
}

export const metaConnector: AdConnector = {
  platform: "facebook",

  async publishCampaign(args): Promise<{ ok: boolean; externalCampaignId?: string; error?: string }> {
    const { cred } = args
    if (!cred.accessToken || !cred.accountId) return { ok: false, error: "meta credential not connected" }
    const s = args.structure as { campaign?: Record<string, unknown>; adSet?: Record<string, unknown>; adCreative?: Record<string, unknown>; ad?: Record<string, unknown> }
    if (!s.campaign || !s.adSet || !s.adCreative || !s.ad) return { ok: false, error: "incomplete ad structure" }
    const acct = `act_${cred.accountId}`
    const post = (path: string, body: Record<string, unknown>) =>
      graph(path, { method: "POST", token: cred.accessToken, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    try {
      const camp = await post(`${acct}/campaigns`, s.campaign)
      if (!camp.ok || !camp.json?.id) return { ok: false, error: camp.json?.error?.message ?? `campaign create failed (${camp.status})` }
      const campaignId = String(camp.json.id)
      const set = await post(`${acct}/adsets`, { ...s.adSet, campaign_id: campaignId })
      if (!set.ok || !set.json?.id) return { ok: false, externalCampaignId: campaignId, error: set.json?.error?.message ?? "ad set create failed" }
      const creative = await post(`${acct}/adcreatives`, s.adCreative)
      if (!creative.ok || !creative.json?.id) return { ok: false, externalCampaignId: campaignId, error: creative.json?.error?.message ?? "creative create failed" }
      const ad = await post(`${acct}/ads`, { ...s.ad, adset_id: set.json.id, creative: { creative_id: creative.json.id } })
      if (!ad.ok || !ad.json?.id) return { ok: false, externalCampaignId: campaignId, error: ad.json?.error?.message ?? "ad create failed" }
      return { ok: true, externalCampaignId: campaignId }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },

  async pushCustomAudience(args: AudiencePushArgs): Promise<AudienceSyncResult> {
    if (!args.cred.accessToken || !args.cred.accountId) return { ok: false, recordsSynced: 0, recordsRejected: args.members.length, error: "meta credential not connected" }
    try {
      // Create the audience if we don't have one yet.
      let audienceId = args.externalAudienceId
      if (!audienceId) {
        const create = await graph(`act_${args.cred.accountId}/customaudiences`, {
          method: "POST", token: args.cred.accessToken,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: args.audienceName, subtype: "CUSTOM", customer_file_source: "USER_PROVIDED_ONLY", description: "VIP RE OS consented CRM audience" }),
        })
        if (!create.ok || !create.json?.id) return { ok: false, recordsSynced: 0, recordsRejected: args.members.length, error: create.json?.error?.message ?? `create failed (${create.status})` }
        audienceId = String(create.json.id)
      }
      // Upload hashed users. Schema declares which keys each tuple carries.
      const schema = ["EMAIL", "PHONE"]
      const data = args.members.map((m) => [m.email_sha256 ?? "", m.phone_sha256 ?? ""])
      const add = await graph(`${audienceId}/users`, {
        method: "POST", token: args.cred.accessToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payload: { schema, data } }),
      })
      if (!add.ok) return { ok: false, externalAudienceId: audienceId, recordsSynced: 0, recordsRejected: args.members.length, error: add.json?.error?.message ?? `upload failed (${add.status})` }
      const received = Number(add.json?.num_received ?? args.members.length)
      const invalid = Number(add.json?.num_invalid_entries ?? 0)
      return { ok: true, externalAudienceId: audienceId, recordsSynced: received - invalid, recordsRejected: invalid }
    } catch (e) {
      return { ok: false, recordsSynced: 0, recordsRejected: args.members.length, error: (e as Error).message }
    }
  },

  async createLookalike(args: LookalikeArgs): Promise<AudienceSyncResult> {
    if (!args.cred.accessToken || !args.cred.accountId) return { ok: false, recordsSynced: 0, recordsRejected: 0, error: "meta credential not connected" }
    try {
      const ratio = Math.max(0.01, Math.min(0.1, (args.sizePct ?? 1) / 100))
      const create = await graph(`act_${args.cred.accountId}/customaudiences`, {
        method: "POST", token: args.cred.accessToken,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: args.audienceName, subtype: "LOOKALIKE", origin_audience_id: args.seedExternalId,
          lookalike_spec: JSON.stringify({ ratio, country: args.country ?? "US", type: "similarity" }),
        }),
      })
      if (!create.ok || !create.json?.id) return { ok: false, recordsSynced: 0, recordsRejected: 0, error: create.json?.error?.message ?? `lookalike failed (${create.status})` }
      return { ok: true, externalAudienceId: String(create.json.id), recordsSynced: 0, recordsRejected: 0 }
    } catch (e) {
      return { ok: false, recordsSynced: 0, recordsRejected: 0, error: (e as Error).message }
    }
  },

  async fetchPerformance(args: PerformanceQuery): Promise<ProviderPerformanceRow | null> {
    if (!args.cred.accessToken) return null
    try {
      const fields = "spend,impressions,clicks,actions,action_values"
      const res = await graph(`${args.campaignExternalId}/insights?fields=${fields}&date_preset=last_30d`, { method: "GET", token: args.cred.accessToken })
      if (!res.ok) return null
      const row = Array.isArray(res.json?.data) ? res.json.data[0] : null
      return mapInsights(row)
    } catch { return null }
  },
}
