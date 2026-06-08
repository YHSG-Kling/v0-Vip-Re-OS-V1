/**
 * lib/ads/connectors/types.ts
 *
 * Wave 42 — the AD CONNECTOR contract. Every ad vendor (Meta, Google, and any
 * future LinkedIn/TikTok) implements this so the kernel can push audiences and
 * pull performance uniformly. The one egress command center talks to outside ad
 * platforms only through these connectors.
 */
import type { HashedMatchKey } from "./pii"

export interface ConnectorCredential {
  accessToken: string
  accountId:   string | null            // Meta ad-account id / Google customer id
  config:      Record<string, unknown>  // platform-specific extras (e.g. login_customer_id, developer_token)
}

export interface AudiencePushArgs {
  audienceName:       string
  externalAudienceId: string | null     // existing provider audience to update, else create
  members:            HashedMatchKey[]   // already SHA-256 hashed — raw PII never reaches a connector
  cred:               ConnectorCredential
}

export interface LookalikeArgs {
  audienceName:   string
  seedExternalId: string                // the provider audience id to seed from
  country?:       string                // default 'US'
  sizePct?:       number                // 1-10 (Meta lookalike size scale)
  cred:           ConnectorCredential
}

export interface PerformanceQuery {
  campaignExternalId: string
  sinceIso:           string
  cred:               ConnectorCredential
}

export interface AudienceSyncResult {
  ok:               boolean
  externalAudienceId?: string
  recordsSynced:    number
  recordsRejected:  number
  error?:           string
}

/** Normalized performance — maps onto ad_performance columns. */
export interface ProviderPerformanceRow {
  spend:       number
  impressions: number
  clicks:      number
  leads:       number
  conversions: number
  ctr:         number          // 0..1
  costPerLead: number | null   // null when leads === 0
  revenue:     number
}

export interface AdConnector {
  platform: string
  /** Upload/replace a Customer-Match / Custom Audience from hashed CRM members. */
  pushCustomAudience(args: AudiencePushArgs): Promise<AudienceSyncResult>
  /** Create a lookalike/similar audience seeded from an existing custom audience. */
  createLookalike(args: LookalikeArgs): Promise<AudienceSyncResult>
  /** Pull campaign performance for ad_performance ingestion. */
  fetchPerformance(args: PerformanceQuery): Promise<ProviderPerformanceRow | null>
}

/** Pure: derive cost-per-lead + ctr consistently from raw counters (reused by every connector). */
export function deriveMetrics(p: { spend: number; impressions: number; clicks: number; leads: number }): { ctr: number; costPerLead: number | null } {
  const ctr = p.impressions > 0 ? p.clicks / p.impressions : 0
  const costPerLead = p.leads > 0 ? Math.round((p.spend / p.leads) * 100) / 100 : null
  return { ctr: Math.round(ctr * 10000) / 10000, costPerLead }
}
