// lib/providers/stackadapt-ads.ts
// StackAdapt (multi-channel programmatic DSP) — the connector for the second TV connection the owner ruled on
// 2026-10-29 (ruling 8: "groundtruth … and stackadapt are 2 tv connections"). Same fabric as Vibe and GroundTruth:
// the AdConnector registry (lib/ads/connectors/registry.ts), the ONE streaming-TV gateway
// (lib/ads/ctv-campaign.ts — broadcast gate, READY TV master, approved topic) and the Ads Manager loop.
//
// CONTRACT, as read on 2026-10-29:
//   · https://docs.stackadapt.com/ (public): the GraphQL API "to create and manage your programmatic spend"
//     authenticates with `Authorization: Bearer <token>`; the REST API is READ-ONLY reporting (writes deprecated);
//     a Pixel API takes server-to-server conversion events; "If you don't have an API key, please reach out to
//     StackAdapt" (credential WAITING_EXTERNAL); all APIs are rate-limited (429).
//   · The GraphQL REFERENCE (docs.stackadapt.com/graphql/reference) sits behind a StackAdapt login. The schema was
//     read instead from StackAdapt's OWN published SDK, npm @stackadapt/pa-typescript-sdk 0.73.0 (published
//     2025-11-26; homepage docs.stackadapt.com; "uses the latest StackAdapt Public API Schema"):
//     dist/graphql-client.js names https://api.stackadapt.com/graphql (sandbox https://sandbox.stackadapt.com/public/graphql);
//     dist/gql/graphql.d.ts carries the schema — Mutation.createCampaignGroup / upsertCampaign(input:{ctv}) /
//     upsertAd / createUploadTargets / createCreatives / createCrmSegmentWithPii / pause|resumeCampaigns /
//     createWebhook (events CAMPAIGN_CREATION, CAMPAIGN_UPDATES, CREATIVE_CREATION); Query.campaign /
//     campaignDelivery (CampaignDeliveryOutcome | Progress) / tokenInfo / advertiser.
//   · CampaignType: AUDIO, CTV, DISPLAY, DOOH, NATIVE, PROGRAMMATIC_LINEAR_TV, VIDEO — only CTV and
//     PROGRAMMATIC_LINEAR_TV are TV. CampaignState: DRAFT, PENDING (creatives pending review), APPROVED, LIVE,
//     PAUSED, REJECTED, ENDED, ERROR.
//   · NOT published (declared, never faked): lead / response objects; the webhook payload and its signature
//     scheme (so no inbound route is built — the events are POLLED); the currency unit of budgets beyond Float.
//
// HONESTY: dispatched:true ONLY when StackAdapt returned the campaign with no userErrors and isDraft false — its
// state is then usually PENDING (StackAdapt reviews the creative) and is reported as such, never as "live".
// FAIR HOUSING: geography (ZIP / DMA / city) + the CTV channel only — the documented demographicSegmentIds /
// interest / custom-segment targeting is never sent on a launch.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveConnectionResult, type ResolvedConnection } from "@/lib/integrations/connection-manager"
import { callConnector, type GatewayRequest, type GatewayResponse } from "@/lib/agentic-os/connector-gateway"
import type { AdProviderDeclaration } from "@/lib/ads/connectors/types"
import type { HashedMatchKey } from "@/lib/ads/connectors/pii"

export const STACKADAPT_PROVIDER = "stackadapt"
export const STACKADAPT_HOME_URL = "https://www.stackadapt.com"
const STACKADAPT_API_BASE = "https://api.stackadapt.com"
const STACKADAPT_GRAPHQL_PATH = "/graphql"
const SA_FLIGHT_DAYS = 30
/** CampaignSubtype is documented as MANDATORY for a CTV campaign ("the type of devices on which the CTV campaign ads
 *  are to run") with members DEFAULT | INGAME | OTT | STATIC | VIDEO. DEFAULT unless the tenant's connection names
 *  another documented member (config.ctv_subtype). */
const SA_CTV_SUBTYPES = ["DEFAULT", "INGAME", "OTT", "STATIC", "VIDEO"] as const

/** THE capability declaration, from the documentation only (see the header for what was read). */
export const STACKADAPT_DECLARATION: AdProviderDeclaration = Object.freeze<AdProviderDeclaration>({
  provider: STACKADAPT_PROVIDER,
  campaignPlatforms: ["stackadapt"],
  sources: [
    "https://docs.stackadapt.com/ (GraphQL Bearer auth; REST read-only reporting; Pixel API; 429 rate limits; keys on request)",
    "https://www.stackadapt.com/enterprise-api-solution (native, display, video, connected TV, audio, in-game, DOOH; 1st-party data onboarding)",
    "https://registry.npmjs.org/@stackadapt/pa-typescript-sdk 0.73.0 (2025-11-26) dist/graphql-client.js + dist/gql/graphql.d.ts — the published GraphQL schema",
    "https://docs.stackadapt.com/graphql/reference — gated behind a StackAdapt login (not readable without an account)",
  ],
  readOn: "2026-10-29",
  credentialFields: ["GraphQL API token (api_key)", "StackAdapt advertiser id (account_id)"],
  tvFormats: ["CTV", "PROGRAMMATIC_LINEAR_TV"],
  nonTvFormats: ["NATIVE", "DISPLAY", "VIDEO", "AUDIO", "DOOH"],
  capabilities: {
    account_access:        { documented: "supported",   via: "graphql", built: "lib/providers/stackadapt-ads.ts launchStackadaptCampaign (tokenInfo + advertiser)", evidence: "Query.tokenInfo {name, expiresAt, scopesByAdvertiser}; Query.advertiser(id)" },
    campaign_creation:     { documented: "supported",   via: "graphql", built: "lib/providers/stackadapt-ads.ts launchStackadaptCampaign", evidence: "Mutation.createCampaignGroup(CampaignGroupInput) → Mutation.upsertCampaign(input: { ctv: CtvCampaignInput })" },
    creative_association:  { documented: "supported",   via: "graphql", built: "lib/providers/stackadapt-ads.ts launchStackadaptCampaign", evidence: "createUploadTargets (VIDEO_ASSET) → presigned upload → createCreatives(assetType VIDEO) → CtvAdInput.creative {creativeId} on the campaign" },
    budget:                { documented: "supported",   via: "graphql", built: "lib/providers/stackadapt-ads.ts launchStackadaptCampaign", evidence: "CampaignGroupFlightInput.dailyBudget; CampaignFlightInput {grossDailyBudget, bidType CPM, bidAmount}. Currency unit: UNKNOWN beyond Float" },
    provider_review:       { documented: "supported",   via: "poll",    built: "lib/providers/stackadapt-ads.ts readStackadaptCampaignStatus", evidence: "CampaignState PENDING ('Campaign is live, but all creatives pending') / REJECTED ('All your submitted creatives are rejected')" },
    status_readback:       { documented: "supported",   via: "poll",    built: "lib/providers/stackadapt-ads.ts readStackadaptCampaignStatus", evidence: "Query.campaign(id) { campaignStatus { state status } } — CampaignState + CampaignStatuses (13 values)" },
    performance_readback:  { documented: "supported",   via: "poll",    built: "lib/providers/stackadapt-ads.ts fetchStackadaptCampaignDelivery", evidence: "Query.campaignDelivery(dataType TABLE, granularity TOTAL, date, filterBy {ids}) → CampaignDeliveryOutcome.totalStats | Progress (async)" },
    conversion_readback:   { documented: "supported",   via: "poll",    built: "lib/providers/stackadapt-ads.ts fetchStackadaptCampaignDelivery", evidence: "DeliveryStatsRecord.conversionsBigint / conversionRevenue; Pixel API server-to-server events (not sent from here)" },
    attribution:           { documented: "supported",   via: "poll",    built: null, evidence: "Query.conversionPath, footfallTrackingStats, brandLiftStudy — not read here" },
    ctv_inventory:         { documented: "supported",   via: "graphql", built: "lib/providers/stackadapt-ads.ts launchStackadaptCampaign (upsertCampaign ctv)", evidence: "CampaignType CTV + PROGRAMMATIC_LINEAR_TV; CampaignInventoryInput; inventoryPackages. The tenant's CTV entitlement is StackAdapt's to grant — WAITING_EXTERNAL" },
    lead_readback:         { documented: "unsupported", via: "none",    built: null, evidence: "no lead / form object in the published schema" },
    response_readback:     { documented: "unsupported", via: "none",    built: null, evidence: "no comment / reply / message object — nothing reaches the C1 inbound record from StackAdapt" },
    audience_sync:         { documented: "supported",   via: "graphql", built: "lib/providers/stackadapt-ads.ts pushStackadaptCrmSegment", evidence: "Mutation.createCrmSegmentWithPii(CrmSegmentWithPiiInput {name, hashAlgo SHA_256, hashedCrmData, region US}) / updateCrmSegmentWithPii" },
    webhooks:              { documented: "supported",   via: "webhook", built: null, evidence: "Mutation.createWebhook {event: CAMPAIGN_CREATION | CAMPAIGN_UPDATES | CREATIVE_CREATION, url https://…}; the delivered payload and any signature are NOT in the schema — no inbound route is built until they are published; status is POLLED" },
  },
})

export type StackadaptCredential = Pick<ResolvedConnection, "apiKey" | "accountId" | "config"> & { brokerageId?: string | null }

export type StackadaptCredentialResolution =
  | { status: "connected"; conn: StackadaptCredential }
  | { status: "not_connected"; reason: string }
  | { status: "unreadable"; detail: string; reason: string }

export type StackadaptTransport = (req: GatewayRequest) => Promise<GatewayResponse>

/** THE ONE place a StackAdapt credential is resolved for a brokerage (§6). */
export async function resolveStackadaptCredential(brokerageId: string): Promise<StackadaptCredentialResolution> {
  const resolved = await resolveConnectionResult({ brokerageId, provider: STACKADAPT_PROVIDER })
  if (resolved.status === "unreadable") {
    return { status: "unreadable", detail: resolved.detail, reason: `stackadapt_connection_unreadable — the StackAdapt credential could not be READ (${resolved.detail}); this is not "not connected"` }
  }
  const conn = resolved.status === "connected" ? resolved.connection : null
  if (!conn || !conn.apiKey) return { status: "not_connected", reason: "stackadapt_not_connected" }
  return { status: "connected", conn: { ...conn, brokerageId } }
}

class StackadaptError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

type GqlUserError = { message?: string; path?: string[] | null }

/** THE ONE StackAdapt GraphQL egress — through the connector gateway. A GraphQL error comes back two ways: transport
 *  `errors[]` (HTTP 200 or 4xx) and a mutation payload's `userErrors[]`; both are read, neither is swallowed. */
async function saGraphql<T = any>(conn: StackadaptCredential, query: string, variables: Record<string, unknown>, transport?: StackadaptTransport): Promise<T> {
  if (!conn.apiKey) throw new StackadaptError(401, "StackAdapt GraphQL token not configured")
  const res = await (transport ?? callConnector)({
    connector: "stackadapt", // == STACKADAPT_PROVIDER, spelled literally so the provider census sees the site
    brokerageId: conn.brokerageId ?? null,
    baseUrl: STACKADAPT_API_BASE,
    path: STACKADAPT_GRAPHQL_PATH,
    method: "POST",
    auth: { style: "bearer", token: conn.apiKey },
    body: { query, variables },
  })
  const envelope = (res.ok ? res.data : res.errorBody) as { data?: T; errors?: Array<{ message?: string }> } | null | undefined
  if (envelope?.errors?.length) throw new StackadaptError(res.status ?? 0, `StackAdapt ${res.status ?? ""}: ${envelope.errors.map((e) => e.message ?? "error").join("; ")}`.trim())
  if (!res.ok) throw new StackadaptError(res.status ?? 0, `StackAdapt ${res.status ?? "unreachable"}: ${res.error ?? ""}`.trim())
  if (!envelope?.data) throw new StackadaptError(res.status ?? 0, "StackAdapt answered without data")
  return envelope.data
}

function userErrorText(errs: GqlUserError[] | null | undefined): string | null {
  return errs && errs.length ? errs.map((e) => `${e.message ?? "invalid"}${e.path?.length ? ` (${e.path.join(".")})` : ""}`).join("; ") : null
}

export interface StackadaptLaunchResult {
  /** true ONLY when StackAdapt returned the non-draft campaign with no userErrors. */
  dispatched: boolean
  reason: string
  stackadaptCampaignId?: string
  stackadaptCampaignGroupId?: string
  stackadaptCreativeId?: string
  /** CampaignState as returned (typically PENDING while StackAdapt reviews the creative). */
  providerState?: string | null
}

/**
 * Launch a STAGED StackAdapt TV campaign. The caller (lib/ads/connectors/stackadapt.ts) has already run the ONE TV
 * broadcast gate. Chain: account check → campaign group (daily budget flight) → upload the TV master (upload target
 * → presigned POST) → creative → CTV campaign with the ad, geography only, not a draft.
 */
export async function launchStackadaptCampaign(campaignId: string, opts: { transport?: StackadaptTransport; client?: ReturnType<typeof createServiceClient>; now?: Date; resolve?: typeof resolveStackadaptCredential } = {}): Promise<StackadaptLaunchResult> {
  const supabase = opts.client ?? createServiceClient()
  const { data: campaign, error } = await supabase
    .from("ad_campaigns")
    .select("id, brokerage_id, platform, status, campaign_name, daily_budget, targeting_config")
    .eq("id", campaignId)
    .maybeSingle()
  if (error) return { dispatched: false, reason: `campaign lookup failed: ${error.message}` }
  if (!campaign) return { dispatched: false, reason: "campaign not found" }
  const row = campaign as { id: string; brokerage_id: string; platform: string; campaign_name: string | null; daily_budget: number | null; targeting_config: Record<string, unknown> | null }
  if (row.platform !== "stackadapt") return { dispatched: false, reason: `campaign platform is '${row.platform}', not 'stackadapt'` }

  const resolved = await (opts.resolve ?? resolveStackadaptCredential)(row.brokerage_id)
  if (resolved.status === "unreadable") return { dispatched: false, reason: `${resolved.reason}, and the campaign was left staged` }
  if (resolved.status === "not_connected") return { dispatched: false, reason: "stackadapt_not_connected — the campaign stays staged; StackAdapt issues GraphQL API tokens on request (docs.stackadapt.com)" }
  const conn = resolved.conn
  if (!conn.accountId) return { dispatched: false, reason: "no StackAdapt advertiser id on the connection — enter it in Settings → Connections" }

  const cfg = (row.targeting_config ?? {}) as { dmas?: string[]; cities?: string[]; zips?: string[]; creative_video_url?: string | null; creative_source?: string | null; bid_cpm_usd?: number | null }
  if (!cfg.creative_video_url || cfg.creative_source !== "tv_master") return { dispatched: false, reason: "the staged spot carries no READY TV master URL — StackAdapt receives the TV master, never the social reel" }
  const zips = (cfg.zips ?? []).map((z) => z.trim()).filter((z) => /^\d{5}$/.test(z))
  const places = [...(cfg.dmas ?? []), ...(cfg.cities ?? [])].map((p) => p.trim()).filter(Boolean)
  if (zips.length + places.length === 0) return { dispatched: false, reason: "no DMA / city / 5-digit ZIP on the staged spot — refusing rather than launching nationwide" }
  const daily = Number(row.daily_budget ?? 0)
  if (!Number.isFinite(daily) || daily <= 0) return { dispatched: false, reason: "staged campaign has no daily budget" }
  const bid = Number(cfg.bid_cpm_usd ?? 0)
  if (!Number.isFinite(bid) || bid <= 0) return { dispatched: false, reason: "no CPM bid on the staged spot (targeting_config.bid_cpm_usd) — set it when staging" }
  const subtypeCfg = typeof conn.config?.ctv_subtype === "string" ? conn.config.ctv_subtype.toUpperCase() : "DEFAULT"
  const subtype = (SA_CTV_SUBTYPES as readonly string[]).includes(subtypeCfg) ? subtypeCfg : "DEFAULT"

  const now = opts.now ?? new Date()
  const startTime = now.toISOString()
  const endTime = new Date(now.getTime() + SA_FLIGHT_DAYS * 86_400_000).toISOString()
  const name = ((row.campaign_name ?? "").trim() || "Streaming TV spot").slice(0, 200)
  const t = opts.transport

  try {
    // 1 · account access — the token works and sees this advertiser.
    const who = await saGraphql<{ tokenInfo?: { name?: string } | null; advertiser?: { id?: string; isArchived?: boolean } | null }>(conn,
      "query VipAccount($id: ID!) { tokenInfo { name expiresAt } advertiser(id: $id) { id name isArchived } }", { id: conn.accountId }, t)
    if (!who.advertiser?.id) return { dispatched: false, reason: `StackAdapt advertiser ${conn.accountId} is not visible to this token` }
    if (who.advertiser.isArchived) return { dispatched: false, reason: `StackAdapt advertiser ${conn.accountId} is archived` }

    // 2 · geography → location ids (DMA / city names), ZIPs as global ZIP targeting. Unresolved names are named.
    const locationIds: string[] = []
    const unresolved: string[] = []
    for (const place of places) {
      const g = await saGraphql<{ geos?: { nodes?: Array<{ id: string; administrativeLevel?: string }> } }>(conn,
        "query VipGeo($q: String!) { geos(first: 3, filterBy: { nameContains: $q, country: \"US\", administrativeLevel: [DMA_REGION, CITY] }) { nodes { id administrativeLevel displayName } } }", { q: place.split(",")[0] }, t)
      const hit = g.geos?.nodes?.[0]
      if (hit?.id) locationIds.push(hit.id); else unresolved.push(place)
    }
    if (locationIds.length === 0 && zips.length === 0) return { dispatched: false, reason: `no StackAdapt location resolved for ${places.join(" / ")} — add a 5-digit ZIP or a DMA/city StackAdapt recognises` }

    // 3 · campaign group carrying the daily budget flight.
    const group = await saGraphql<{ createCampaignGroup?: { campaignGroup?: { id?: string } | null; userErrors?: GqlUserError[] } }>(conn,
      "mutation VipGroup($input: CampaignGroupInput!) { createCampaignGroup(input: $input) { campaignGroup { id } userErrors { message path } } }",
      { input: { advertiserId: conn.accountId, name: `${name} — group`, budgetType: "cost", revenueType: "CPM", flights: [{ startTime, endTime, dailyBudget: Math.round(daily * 100) / 100, isPaceEvenly: true }] } }, t)
    const groupErr = userErrorText(group.createCampaignGroup?.userErrors)
    if (groupErr) return { dispatched: false, reason: `StackAdapt refused the campaign group: ${groupErr}` }
    const groupId = group.createCampaignGroup?.campaignGroup?.id
    if (!groupId) return { dispatched: false, reason: "StackAdapt created no campaign group id" }

    // 4 · the TV master → upload target → presigned POST → creative.
    const filename = "tv-master.mp4"
    const targets = await saGraphql<{ createUploadTargets?: { targets?: Array<{ url: string; resourceUrl: string; parameters?: Array<{ name: string; value: string }> }>; userErrors?: GqlUserError[] } }>(conn,
      "mutation VipUpload($input: CreateUploadTargetsInput!) { createUploadTargets(input: $input) { targets { url resourceUrl parameters { name value } } userErrors { message path } } }",
      { input: { regionIndependent: [{ filename, mimeType: "video/mp4", resourceType: "VIDEO_ASSET" }] } }, t)
    const targetErr = userErrorText(targets.createUploadTargets?.userErrors)
    const target = targets.createUploadTargets?.targets?.[0]
    if (targetErr || !target?.url) return { dispatched: false, reason: `StackAdapt refused the upload target: ${targetErr ?? "no target returned"}`, stackadaptCampaignGroupId: groupId }
    const egress = t ?? callConnector
    const master = await egress({ connector: "stackadapt", brokerageId: conn.brokerageId ?? null, url: cfg.creative_video_url, method: "GET", responseType: "arraybuffer", timeoutMs: 60_000 })
    if (!master.ok || !master.data) return { dispatched: false, reason: `could not fetch the TV master (${master.status ?? master.error})`, stackadaptCampaignGroupId: groupId }
    const form = new FormData()
    for (const p of target.parameters ?? []) form.append(p.name, p.value)
    form.append("file", new Blob([new Uint8Array(master.data as ArrayBuffer)], { type: "video/mp4" }), filename)
    const put = await egress({ connector: "stackadapt", brokerageId: conn.brokerageId ?? null, url: target.url, method: "POST", bodyType: "multipart", body: form, responseType: "text", timeoutMs: 120_000 })
    if (!put.ok) return { dispatched: false, reason: `TV master upload to StackAdapt storage failed (${put.status ?? put.error})`, stackadaptCampaignGroupId: groupId }
    const creatives = await saGraphql<{ createCreatives?: { creatives?: Array<{ id: string }>; userErrors?: GqlUserError[] } }>(conn,
      "mutation VipCreative($input: CreateCreativesInput!) { createCreatives(input: $input) { creatives { id } userErrors { message path } } }",
      { input: { creativeInputs: [{ assetType: "VIDEO", filename, uploadTargetUrl: target.resourceUrl }] } }, t)
    const creativeErr = userErrorText(creatives.createCreatives?.userErrors)
    const creativeId = creatives.createCreatives?.creatives?.[0]?.id
    if (creativeErr || !creativeId) return { dispatched: false, reason: `StackAdapt refused the creative: ${creativeErr ?? "no creative id"}`, stackadaptCampaignGroupId: groupId }

    // 5 · the CTV campaign with its ad — geography only, not a draft.
    const geo: Record<string, unknown> = {
      ...(locationIds.length ? { locationIds: Array.from(new Set(locationIds)), includeDma: true } : {}),
      ...(zips.length ? { globalZipTargeting: [{ country: "US", zipCodes: Array.from(new Set(zips)), inclusion: true }] } : {}),
    }
    const upsert = await saGraphql<{ upsertCampaign?: { campaign?: { id?: string; isDraft?: boolean; campaignStatus?: { state?: string; status?: string } | null } | null; userErrors?: GqlUserError[] } }>(conn,
      "mutation VipCtv($input: CtvCampaignInput!) { upsertCampaign(input: { ctv: $input }) { campaign { id isDraft campaignStatus { state status } } userErrors { message path } } }",
      { input: {
        advertiserId: conn.accountId, campaignGroupId: groupId, name, subtype, isDraft: false, geo,
        flights: [{ startTime, endTime, grossDailyBudget: Math.round(daily * 100) / 100, bidType: "CPM", bidAmount: bid, budgetType: "COST", isPaceEvenly: true }],
        ads: [{ name: `${name} — TV master`.slice(0, 200), creative: { creativeId } }],
      } }, t)
    const upsertErr = userErrorText(upsert.upsertCampaign?.userErrors)
    const sa = upsert.upsertCampaign?.campaign
    if (upsertErr || !sa?.id) return { dispatched: false, reason: `StackAdapt refused the CTV campaign: ${upsertErr ?? "no campaign id"}`, stackadaptCampaignGroupId: groupId, stackadaptCreativeId: creativeId }
    if (sa.isDraft) return { dispatched: false, reason: "StackAdapt kept the campaign as a DRAFT — nothing will deliver; finish it in StackAdapt", stackadaptCampaignId: sa.id, stackadaptCampaignGroupId: groupId, stackadaptCreativeId: creativeId, providerState: sa.campaignStatus?.state ?? null }
    const state = sa.campaignStatus?.state ?? null
    return {
      dispatched: true,
      reason: `Submitted to StackAdapt (state ${state ?? "unknown"}${state === "PENDING" ? " — StackAdapt is reviewing the creative" : ""})${unresolved.length ? `; unresolved places skipped: ${unresolved.join(", ")}` : ""}`,
      stackadaptCampaignId: sa.id, stackadaptCampaignGroupId: groupId, stackadaptCreativeId: creativeId, providerState: state,
    }
  } catch (e) {
    return { dispatched: false, reason: e instanceof StackadaptError ? e.message : `StackAdapt dispatch error: ${(e as Error)?.message ?? String(e)}` }
  }
}

/** Status + review readback (poll — the webhook payload is not published, so no inbound route is built). */
export async function readStackadaptCampaignStatus(conn: StackadaptCredential, saCampaignId: string, opts: { transport?: StackadaptTransport } = {}): Promise<{ ok: true; state: string | null; status: string | null } | { ok: false; reason: string }> {
  try {
    const r = await saGraphql<{ campaign?: { campaignStatus?: { state?: string; status?: string } | null } | null }>(conn,
      "query VipStatus($id: ID!) { campaign(id: $id) { campaignStatus { state status } } }", { id: saCampaignId }, opts.transport)
    if (!r.campaign) return { ok: false, reason: `StackAdapt campaign ${saCampaignId} is not visible to this token` }
    return { ok: true, state: r.campaign.campaignStatus?.state ?? null, status: r.campaign.campaignStatus?.status ?? null }
  } catch (e) {
    return { ok: false, reason: e instanceof StackadaptError ? e.message : String((e as Error)?.message ?? e) }
  }
}

export interface StackadaptDeliveryTotals { impressions: number; clicks: number; spend: number; conversions: number; videoCompletions: number; conversionRevenue: number }

/** Performance readback: campaignDelivery is ASYNC — a `Progress` answer means "still computing" (the connector turns
 *  it into a pending marker and asks again next pass); CampaignDeliveryOutcome.totalStats carries the numbers. */
export async function fetchStackadaptCampaignDelivery(conn: StackadaptCredential, saCampaignId: string, sinceIso: string, opts: { transport?: StackadaptTransport; now?: Date } = {}): Promise<{ pending: true } | { pending: false; totals: StackadaptDeliveryTotals }> {
  const now = opts.now ?? new Date()
  const since = new Date(sinceIso)
  const from = (Number.isFinite(since.getTime()) ? since : new Date(now.getTime() - 30 * 86_400_000)).toISOString().slice(0, 10)
  const to = new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10) // `to` is exclusive
  const r = await saGraphql<{ campaignDelivery?: { __typename?: string; totalStats?: Record<string, unknown> | null } | null }>(conn,
    "query VipDelivery($ids: [ID!], $from: ISO8601Date, $to: ISO8601Date) { campaignDelivery(dataType: TABLE, granularity: TOTAL, date: { from: $from, to: $to }, filterBy: { ids: $ids }) { __typename ... on CampaignDeliveryOutcome { totalStats { impressionsBigint clicksBigint cost conversionsBigint conversionRevenue videoCompletionsBigint } } } }",
    { ids: [saCampaignId], from, to }, opts.transport)
  const d = r.campaignDelivery
  if (!d || d.__typename === "Progress") return { pending: true }
  const s = d.totalStats ?? {}
  const n = (k: string) => { const v = Number(s[k] ?? 0); return Number.isFinite(v) ? v : 0 }
  return { pending: false, totals: { impressions: n("impressionsBigint"), clicks: n("clicksBigint"), spend: Math.round(n("cost") * 100) / 100, conversions: n("conversionsBigint"), videoCompletions: n("videoCompletionsBigint"), conversionRevenue: Math.round(n("conversionRevenue") * 100) / 100 } }
}

/** Audience sync (ruling 2 / C2's provider half): a CRM segment of SHA-256 hashed EMAILS (createCrmSegmentWithPii,
 *  hashAlgo SHA_256, region US). Phones are not sent — the schema does not say which identifier a hashed string is,
 *  so only the one universal key goes. Raw PII never leaves (lib/ads/connectors/pii.ts hashed upstream). */
export async function pushStackadaptCrmSegment(conn: StackadaptCredential, args: { name: string; externalSegmentId: string | null; members: HashedMatchKey[] }, opts: { transport?: StackadaptTransport } = {}): Promise<{ ok: boolean; externalAudienceId?: string; recordsSynced: number; recordsRejected: number; error?: string }> {
  const hashed = Array.from(new Set(args.members.map((m) => m.email_sha256).filter((h): h is string => !!h)))
  const rejected = args.members.length - hashed.length
  if (hashed.length === 0) return { ok: false, recordsSynced: 0, recordsRejected: args.members.length, error: "stackadapt: no hashed email among the members — nothing to upload" }
  try {
    const mutation = args.externalSegmentId ? "updateCrmSegmentWithPii" : "createCrmSegmentWithPii"
    const r = await saGraphql<Record<string, { customSegment?: { id?: string } | null; userErrors?: GqlUserError[] } | undefined>>(conn,
      `mutation VipCrm($input: CrmSegmentWithPiiInput!) { ${mutation}(input: $input) { customSegment { id } userErrors { message path } } }`,
      { input: { ...(args.externalSegmentId ? { id: args.externalSegmentId } : {}), name: args.name.slice(0, 200), hashAlgo: "SHA_256", hashedCrmData: hashed, region: "US" } }, opts.transport)
    const payload = r[mutation]
    const err = userErrorText(payload?.userErrors)
    const id = payload?.customSegment?.id ?? args.externalSegmentId ?? undefined
    if (err || !id) return { ok: false, recordsSynced: 0, recordsRejected: args.members.length, error: `stackadapt: ${err ?? "no segment id returned"}` }
    return { ok: true, externalAudienceId: id, recordsSynced: hashed.length, recordsRejected: rejected }
  } catch (e) {
    return { ok: false, recordsSynced: 0, recordsRejected: args.members.length, error: e instanceof StackadaptError ? e.message : String((e as Error)?.message ?? e) }
  }
}
