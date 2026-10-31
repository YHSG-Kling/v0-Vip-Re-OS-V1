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
  /** Wave 139 (139B): the brokerage the credential was loaded FOR (loadConnectorCredential sets it
   *  from its tenant argument) — every connector egress carries it onto the gateway's
   *  api_response_logs row. Never taken from a request body. */
  brokerageId?: string | null
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
  /** Per-campaign provider state carried between ingest passes (a pending
   *  async report id, for one). Stored on ad_campaigns.targeting_config by the
   *  ingest under `provider_state`; Meta/Google ignore it. */
  providerState?:     Record<string, unknown>
}

/** An ASYNC provider has accepted the question and will answer on a later pass.
 *  The ingest persists `providerState` so the next pass can read the answer.
 *  (Vibe reporting is a create-then-poll report; a cron tick never blocks on it.) */
export interface PerformancePending { pending: true; providerState: Record<string, unknown> }

export type PerformanceFetchResult = ProviderPerformanceRow | PerformancePending | null

export function isPerformancePending(r: PerformanceFetchResult): r is PerformancePending {
  return !!r && (r as PerformancePending).pending === true
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

export interface PublishResult { ok: boolean; externalCampaignId?: string; error?: string }
export interface PublishArgs { structure: Record<string, unknown>; cred: ConnectorCredential }

/** Wave 146 (lane 146E — ruling 8 "submission/status, approval" readback): the provider's OWN view of a launched
 *  campaign, read back (poll). `state` is the provider's word, lower-cased; `review` is its creative-review word when
 *  it publishes one (StackAdapt PENDING / REJECTED), else null. Never mapped onto our status ladder silently. */
export interface ProviderStatusQuery { campaignExternalId: string; cred: ConnectorCredential }
export type ProviderStatusResult = { ok: true; state: string; review: string | null } | { ok: false; reason: string }

export interface AdConnector {
  platform: string
  /** Create the campaign on the platform (PAUSED) from an assembled structure. */
  publishCampaign(args: PublishArgs): Promise<PublishResult>
  /** Upload/replace a Customer-Match / Custom Audience from hashed CRM members. */
  pushCustomAudience(args: AudiencePushArgs): Promise<AudienceSyncResult>
  /** Create a lookalike/similar audience seeded from an existing custom audience. */
  createLookalike(args: LookalikeArgs): Promise<AudienceSyncResult>
  /** Pull campaign performance for ad_performance ingestion. A synchronous
   *  provider returns the row (or null); an async one may return a pending
   *  marker with the state to carry to the next pass. */
  fetchPerformance(args: PerformanceQuery): Promise<PerformanceFetchResult>
  /** Optional (wave 146): the provider's own campaign status / review state, polled by the performance ingest and
   *  recorded on the campaign (targeting_config.provider_status). A connector that publishes none omits it. */
  fetchStatus?(args: ProviderStatusQuery): Promise<ProviderStatusResult>
}

// ─── CAPABILITY DECLARATIONS (wave 146, lane 146E — owner ruling 8) ─────────────────────────────
// What an ad provider's PUBLISHED documentation shows it can do, one row per capability the ruling
// names (account access, campaign creation, creative association, budget/approval, status, performance
// readback, attribution, CTV inventory) plus the two-way facts (leads, responses, audience updates,
// webhooks). `documented` is the vendor's own answer — "unknown" when the docs we could read do not
// say (UNKNOWN is an answer; it is never upgraded to "supported" by a guess). `built` is OURS: whether
// this repo has a code path for it. A capability can be documented and not built (said, never faked).

/** The capability keys ruling 8 names, in its order. */
export type AdCapabilityKey =
  | "account_access" | "campaign_creation" | "creative_association" | "budget" | "provider_review"
  | "status_readback" | "performance_readback" | "conversion_readback" | "attribution" | "ctv_inventory"
  | "lead_readback" | "response_readback" | "audience_sync" | "webhooks"

export interface AdCapabilityDeclaration {
  documented: "supported" | "unsupported" | "unknown"
  /** How the vendor exposes it, when documented. */
  via: "rest" | "graphql" | "webhook" | "poll" | "none"
  /** Our code path (file + function), or null when not built here. */
  built: string | null
  /** The documentation evidence: the endpoint / type / page the answer was read from. */
  evidence: string
}

export interface AdProviderDeclaration {
  provider: string
  /** ad_campaigns.platform value(s) this provider runs. */
  campaignPlatforms: readonly string[]
  /** The primary sources read, with the date they were read. Never a value, never a key. */
  sources: readonly string[]
  readOn: string
  /** The credential NAMES the tenant enters (Settings → Connections), never values. */
  credentialFields: readonly string[]
  capabilities: Readonly<Record<AdCapabilityKey, AdCapabilityDeclaration>>
  /** Which of the vendor's formats are TV (ruling 8: "not every GroundTruth format is TV"). */
  tvFormats: readonly string[]
  /** Formats the vendor offers that are NOT TV (stated so a non-TV format is never sold as TV). */
  nonTvFormats: readonly string[]
}

/** Pure: derive cost-per-lead + ctr consistently from raw counters (reused by every connector). */
export function deriveMetrics(p: { spend: number; impressions: number; clicks: number; leads: number }): { ctr: number; costPerLead: number | null } {
  const ctr = p.impressions > 0 ? p.clicks / p.impressions : 0
  const costPerLead = p.leads > 0 ? Math.round((p.spend / p.leads) * 100) / 100 : null
  return { ctr: Math.round(ctr * 10000) / 10000, costPerLead }
}
