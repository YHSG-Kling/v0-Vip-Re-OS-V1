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
import { graphGet, graphPost } from "@/lib/providers/meta/client"

/** Pure: map a Meta Insights data row → our normalized performance row. */
/** @proofSeam pure mapper, already wired internally by metaConnector.fetchPerformance below; exported for scripts/ad-connector-simulator.ts */
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

/**
 * PURE — Marketing API v25 refuses Advantage+ Shopping/App campaign creation.
 * Recognizes both platform-native discriminators: `smart_promotion_type`
 * (Meta's own field, set to AUTOMATED_SHOPPING_ADS for Advantage+ Shopping or
 * SMART_APP_PROMOTION for Advantage+ App) on either the campaign or the ad
 * set, and the OUTCOME_APP_PROMOTION objective (App campaigns are always
 * Advantage+ under v25 — there is no non-Advantage+ App objective any more).
 * @proofSeam already wired internally by metaConnector.publishCampaign below; exported for scripts/ad-connector-simulator.ts
 */
export function detectAdvantagePlusShoppingOrApp(
  campaign: Record<string, unknown> | undefined,
  adSet: Record<string, unknown> | undefined,
): "Shopping" | "App" | null {
  const spt = String(campaign?.smart_promotion_type ?? adSet?.smart_promotion_type ?? "").toUpperCase()
  if (spt === "AUTOMATED_SHOPPING_ADS") return "Shopping"
  if (spt === "SMART_APP_PROMOTION") return "App"
  const objective = String(campaign?.objective ?? "").toUpperCase()
  if (objective === "OUTCOME_APP_PROMOTION") return "App"
  return null
}

// Wave 71A: routes through the official `facebook-nodejs-business-sdk` adapter
// (lib/providers/meta/client.ts) instead of a hand-rolled `fetch`. Keeps this
// file's calling convention (`graph(path, {method, token, body?})` →
// `{ok, json, status}`) so publishCampaign/pushCustomAudience/createLookalike/
// fetchPerformance below needed no further changes — `path` may carry a query
// string (e.g. `${id}/insights?fields=...&date_preset=...`), split here into
// SDK path segments + params.
async function graph(path: string, init: RequestInit & { token: string }): Promise<{ ok: boolean; json: any; status: number }> {
  const method = ((init.method as string) ?? "GET").toUpperCase() as "GET" | "POST"
  const [rawPath, queryString] = path.split("?")
  const segments = rawPath.split("/").filter(Boolean)
  const query = queryString ? Object.fromEntries(new URLSearchParams(queryString)) : {}
  const body = typeof init.body === "string" ? JSON.parse(init.body) : {}
  const res = method === "GET"
    ? await graphGet<any>(init.token, segments, query)
    : await graphPost<any>(init.token, segments, body)
  return { ok: res.ok, json: res.data, status: res.status ?? (res.ok ? 200 : 400) }
}

export const metaConnector: AdConnector = {
  platform: "facebook",

  // (integrator research, 2026-09-17, blind-spot burn-down 2026-09-18): as of
  // Marketing API v25, Advantage+ Shopping / Advantage+ App campaigns CANNOT be
  // created via the Marketing API at all (Meta requires Ads Manager for those
  // objectives) — a platform-side API restriction, not something the SDK swap
  // changes. This OS's own objective vocabulary (lib/ads/connectors/ad-payload.ts
  // AdObjective) never sets `smart_promotion_type` or an OUTCOME_APP_PROMOTION
  // objective through the normal ad-creator/launch-assembler path, so the shape
  // is unreachable there today — but `PublishArgs.structure` is
  // `Record<string, unknown>` (lib/ads/connectors/types.ts), so nothing at the
  // TYPE level stops a future caller from assembling one directly. Originally
  // this just let the call through and relied on "Meta will return a real
  // error" — which is a SILENT API FAILURE from this OS's point of view (an
  // opaque provider 4xx, not a clear refusal a caller can act on). Refuse
  // LOCALLY instead, before any Graph call, with a clear, actionable message.
  async publishCampaign(args): Promise<{ ok: boolean; externalCampaignId?: string; error?: string }> {
    const { cred } = args
    if (!cred.accessToken || !cred.accountId) return { ok: false, error: "meta credential not connected" }
    const s = args.structure as { campaign?: Record<string, unknown>; adSet?: Record<string, unknown>; adCreative?: Record<string, unknown>; ad?: Record<string, unknown> }
    if (!s.campaign || !s.adSet || !s.adCreative || !s.ad) return { ok: false, error: "incomplete ad structure" }
    const advantagePlus = detectAdvantagePlusShoppingOrApp(s.campaign, s.adSet)
    if (advantagePlus) {
      return {
        ok: false,
        error: `Meta Marketing API v25 refuses Advantage+ ${advantagePlus} campaign creation via the API — this must be built in Meta Ads Manager directly. This is a Meta platform restriction, not a VIP RE OS limitation.`,
      }
    }
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

// ── LEAD FORMS ONLY: the form's own legal content (wave 150, lane 150U) ──────────────────────────────────────────────────
//
// THE DISCLOSURE A PERSON SAW ON A META LEAD FORM is the only wording a TCPA / CAN-SPAM consent from that form can rest on
// (lib/ads/ad-lead-intake.ts records NO consent without it — owner ruling 3, "consent never fabricated"). Meta keeps it on the
// LeadgenForm node's `legal_content` (a privacy-policy link and an optional custom disclaimer with optional checkboxes).
//
// PROVIDER LEGAL CONTENT IS UNKNOWN UNTIL VERIFIED. The field path below (`legal_content{privacy_policy,custom_disclaimer}`,
// `custom_disclaimer.body.text`, `custom_disclaimer.checkboxes[].key|is_required`) is written from Meta's published LeadgenForm
// reference and has NOT been read back from a live form by this OS (no page token in any sandbox). So the mapper is total (any
// shape → a value, never a throw), the caller stores what came back with status 'unknown', and nothing here arms a consent.
// WAITING_EXTERNAL: one live form check (a Page access token with leads_retrieval + Meta's Lead Ads Testing Tool) confirming the
// path; then a person marks that form's row verified (owner SQL — lane 150PU notes, m978).

export interface MetaLeadFormLegalContent {
  /** The custom disclaimer's body text, verbatim (trimmed) — null when the form shows none. */
  disclosureText: string | null
  /** Checkbox keys the form asked about (a consent box Meta may record a per-lead response for). */
  checkboxKeys: string[]
  /** True when any checkbox was marked required on the form. */
  requiredCheckbox: boolean
  privacyPolicyUrl: string | null
}

/** PURE, TOTAL: a Graph LeadgenForm payload → its legal content, or null when the payload carries none. Never throws.
 *  Module-private (driven by scripts/suppression-everywhere-guard.ts through fetchMetaLeadFormLegalContent's stubbed Graph). */
function mapMetaLeadFormLegalContent(form: unknown): MetaLeadFormLegalContent | null {
  const legal = (form as { legal_content?: unknown } | null | undefined)?.legal_content as
    | { privacy_policy?: { url?: unknown } | null; custom_disclaimer?: { body?: { text?: unknown } | null; checkboxes?: unknown } | null }
    | null | undefined
  if (!legal || typeof legal !== "object") return null
  const bodyText = legal.custom_disclaimer?.body?.text
  const text = typeof bodyText === "string" ? bodyText.trim() : ""
  const boxes = Array.isArray(legal.custom_disclaimer?.checkboxes) ? (legal.custom_disclaimer?.checkboxes as Array<Record<string, unknown>>) : []
  const url = typeof legal.privacy_policy?.url === "string" ? legal.privacy_policy.url : null
  const out: MetaLeadFormLegalContent = {
    disclosureText: text || null,
    checkboxKeys: boxes.map((b) => (typeof b?.key === "string" ? b.key : null)).filter((k): k is string => !!k),
    requiredCheckbox: boxes.some((b) => b?.is_required === true),
    privacyPolicyUrl: url,
  }
  return out.disclosureText || out.checkboxKeys.length || out.privacyPolicyUrl ? out : null
}

/** One Graph read of a lead form's legal content. Never throws; a failure is a reason, never a guessed disclosure. */
export async function fetchMetaLeadFormLegalContent(
  accessToken: string,
  formId: string,
): Promise<{ ok: true; legal: MetaLeadFormLegalContent | null } | { ok: false; error: string }> {
  if (!accessToken || !formId) return { ok: false, error: "no access token or form id" }
  const res = await graphGet<Record<string, unknown>>(accessToken, [formId], { fields: "legal_content{privacy_policy,custom_disclaimer}" })
  if (!res.ok) return { ok: false, error: res.error ?? "graph error" }
  return { ok: true, legal: mapMetaLeadFormLegalContent(res.data) }
}
