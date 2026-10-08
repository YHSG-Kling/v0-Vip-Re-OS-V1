/**
 * lib/ads/connectors/google.ts
 *
 * Wave 42 — the GOOGLE ADS connector. Customer Match (hashed CRM upload via an
 * offline user-data job), Similar/Lookalike segments, and search/PMax reporting →
 * our normalized performance row. Never throws; credential-gated.
 *
 * The report MAPPER (mapReport) is pure + exported for unit tests.
 */
import type { AdConnector, AudiencePushArgs, AudienceSyncResult, ConnectorCredential, LookalikeArgs, PerformanceQuery, ProviderPerformanceRow } from "./types"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import { deriveMetrics } from "./types"

const ADS_API = "https://googleads.googleapis.com/v17"

/** Pure: map a Google Ads searchStream report row → our normalized performance row.
 *  Google reports micros for cost/value; metrics are nested under `metrics`. */
/** @proofSeam pure mapper, already wired internally by googleConnector.fetchPerformance below; exported for scripts/ad-connector-simulator.ts */
export function mapReport(row: Record<string, any> | null | undefined): ProviderPerformanceRow {
  const m = (row?.metrics ?? {}) as Record<string, unknown>
  const num = (v: unknown) => (v == null ? 0 : Number(v) || 0)
  const spend = num(m.costMicros) / 1_000_000
  const impressions = num(m.impressions)
  const clicks = num(m.clicks)
  const leads = Math.round(num(m.conversions))           // conversions configured as "lead" actions
  const conversions = Math.round(num(m.conversions))
  const revenue = num(m.conversionsValue)
  const { ctr, costPerLead } = deriveMetrics({ spend, impressions, clicks, leads })
  return { spend, impressions, clicks, leads, conversions, ctr, costPerLead, revenue }
}

function headers(cred: { accessToken: string; config: Record<string, unknown> }): Record<string, string> {
  const h: Record<string, string> = {}
  const devToken = cred.config?.developer_token as string | undefined
  const loginCustomerId = cred.config?.login_customer_id as string | undefined
  if (devToken) h["developer-token"] = devToken
  if (loginCustomerId) h["login-customer-id"] = String(loginCustomerId).replace(/-/g, "")
  return h
}

/** The ONE Google Ads egress — every call leaves through the connector gateway (wave 139, lane 139B:
 *  was six raw fetches, published as "no ads call path exists yet", which the raw-fetch census proved
 *  false). The gateway adds the timeout, the tenant-scoped api_response_logs outcome row (health
 *  state) and the applied declared alternate; POSTs stay single-shot (a replayed mutate would
 *  duplicate a campaign). Returns the Response-shaped answer the call sites already read, so the
 *  connector's own error mapping is unchanged (the vendor's error envelope comes back as errorBody). */
async function adsPost(cred: ConnectorCredential, path: string, body: unknown): Promise<{ ok: boolean; status: number; json: () => Promise<any> }> {
  const res = await callConnector({
    connector: "google_ads", brokerageId: cred.brokerageId ?? null,
    baseUrl: ADS_API, path, method: "POST",
    auth: { style: "bearer", token: cred.accessToken }, headers: headers(cred), body,
  })
  return { ok: res.ok, status: res.status ?? 0, json: async () => (res.ok ? res.data : res.errorBody ?? null) }
}

export const googleConnector: AdConnector = {
  platform: "google",

  async publishCampaign(args): Promise<{ ok: boolean; externalCampaignId?: string; error?: string }> {
    const cred = args.cred
    if (!cred.accessToken || !cred.accountId || !cred.config?.developer_token) return { ok: false, error: "google credential not connected" }
    const customerId = String(cred.accountId).replace(/-/g, "")
    const s = args.structure as { budget?: Record<string, unknown>; campaign?: Record<string, unknown>; adGroup?: Record<string, unknown>; ad?: Record<string, unknown> }
    if (!s.budget || !s.campaign) return { ok: false, error: "incomplete ad structure" }
    try {
      // Atomic mutate: budget + campaign in one request (temp resource ids).
      const res = await adsPost(cred, `/customers/${customerId}/googleAds:mutate`, { mutateOperations: [
          { campaignBudgetOperation: { create: { ...s.budget, resourceName: `customers/${customerId}/campaignBudgets/-1` } } },
          { campaignOperation: { create: { ...s.campaign, campaignBudget: `customers/${customerId}/campaignBudgets/-1` } } },
        ] })
      const json: any = await res.json().catch(() => null)
      if (!res.ok) return { ok: false, error: json?.error?.message ?? `campaign create failed (${res.status})` }
      const campRn = json?.mutateOperationResponses?.find((r: any) => r.campaignResult)?.campaignResult?.resourceName
      return { ok: true, externalCampaignId: campRn ? String(campRn).split("/").pop() : undefined }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },

  async pushCustomAudience(args: AudiencePushArgs): Promise<AudienceSyncResult> {
    const cred = args.cred
    if (!cred.accessToken || !cred.accountId || !cred.config?.developer_token) {
      return { ok: false, recordsSynced: 0, recordsRejected: args.members.length, error: "google credential not connected (need token + customer id + developer_token)" }
    }
    const customerId = String(cred.accountId).replace(/-/g, "")
    try {
      // 1. Ensure a Customer Match user list (or reuse the external id).
      let userListResource = args.externalAudienceId
      if (!userListResource) {
        const create = await adsPost(cred, `/customers/${customerId}/userLists:mutate`, { operations: [{ create: { name: args.audienceName, crmBasedUserList: { uploadKeyType: "CONTACT_INFO", dataSourceType: "FIRST_PARTY" }, membershipLifeSpan: 540 } }] })
        const cj: any = await create.json().catch(() => null)
        if (!create.ok || !cj?.results?.[0]?.resourceName) return { ok: false, recordsSynced: 0, recordsRejected: args.members.length, error: cj?.error?.message ?? `userList create failed (${create.status})` }
        userListResource = cj.results[0].resourceName
      }
      // 2. Offline user-data job: create → add hashed members → run.
      const jobCreate = await adsPost(cred, `/customers/${customerId}/offlineUserDataJobs:create`, { job: { type: "CUSTOMER_MATCH_USER_LIST", customerMatchUserListMetadata: { userList: userListResource } } })
      const jj: any = await jobCreate.json().catch(() => null)
      const jobResource = jj?.resourceName
      if (!jobCreate.ok || !jobResource) return { ok: false, externalAudienceId: userListResource ?? undefined, recordsSynced: 0, recordsRejected: args.members.length, error: jj?.error?.message ?? `job create failed (${jobCreate.status})` }

      const operations = args.members.map((mb) => ({ create: { userIdentifiers: [
        ...(mb.email_sha256 ? [{ hashedEmail: mb.email_sha256 }] : []),
        ...(mb.phone_sha256 ? [{ hashedPhoneNumber: mb.phone_sha256 }] : []),
      ] } }))
      const add = await adsPost(cred, `/${jobResource}:addOperations`, { operations, enablePartialFailure: true })
      if (!add.ok) { const aj: any = await add.json().catch(() => null); return { ok: false, externalAudienceId: userListResource ?? undefined, recordsSynced: 0, recordsRejected: args.members.length, error: aj?.error?.message ?? `addOperations failed (${add.status})` } }
      await adsPost(cred, `/${jobResource}:run`, {})
      return { ok: true, externalAudienceId: userListResource ?? undefined, recordsSynced: args.members.length, recordsRejected: 0 }
    } catch (e) {
      return { ok: false, recordsSynced: 0, recordsRejected: args.members.length, error: (e as Error).message }
    }
  },

  async createLookalike(args: LookalikeArgs): Promise<AudienceSyncResult> {
    // Google auto-generates "Similar segments" from a Customer Match seed (no
    // explicit create call); the seed list is targeted with optimized targeting.
    if (!args.cred.accessToken) return { ok: false, recordsSynced: 0, recordsRejected: 0, error: "google credential not connected" }
    return { ok: true, externalAudienceId: `similar:${args.seedExternalId}`, recordsSynced: 0, recordsRejected: 0 }
  },

  async fetchPerformance(args: PerformanceQuery): Promise<ProviderPerformanceRow | null> {
    const cred = args.cred
    if (!cred.accessToken || !cred.accountId || !cred.config?.developer_token) return null
    const customerId = String(cred.accountId).replace(/-/g, "")
    try {
      const query = `SELECT metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE campaign.id = ${args.campaignExternalId} AND segments.date DURING LAST_30_DAYS`
      const res = await adsPost(cred, `/customers/${customerId}/googleAds:searchStream`, { query })
      if (!res.ok) return null
      const json: any = await res.json().catch(() => null)
      const batches = Array.isArray(json) ? json : [json]
      // Sum all returned rows (searchStream can paginate by row).
      let agg: Record<string, number> = {}
      for (const b of batches) for (const r of (b?.results ?? [])) {
        const mapped = mapReport(r)
        agg.spend = (agg.spend ?? 0) + mapped.spend
        agg.impressions = (agg.impressions ?? 0) + mapped.impressions
        agg.clicks = (agg.clicks ?? 0) + mapped.clicks
        agg.leads = (agg.leads ?? 0) + mapped.leads
        agg.conversions = (agg.conversions ?? 0) + mapped.conversions
        agg.revenue = (agg.revenue ?? 0) + mapped.revenue
      }
      if (Object.keys(agg).length === 0) return null
      const { ctr, costPerLead } = deriveMetrics({ spend: agg.spend ?? 0, impressions: agg.impressions ?? 0, clicks: agg.clicks ?? 0, leads: agg.leads ?? 0 })
      return { spend: agg.spend ?? 0, impressions: agg.impressions ?? 0, clicks: agg.clicks ?? 0, leads: agg.leads ?? 0, conversions: agg.conversions ?? 0, ctr, costPerLead, revenue: agg.revenue ?? 0 }
    } catch { return null }
  },
}
