// app/api/webhooks/batchdata-smart-search/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// BATCHDATA SMART SEARCH — inbound webhook receiver (DISTINCT capability from
// batchdata_motivated / expired_listing — owner ruling: never fold two source
// capabilities into one). BatchData's "Smart Search" is EVENT-DRIVEN monitoring:
// once a saved search is configured on their side, they PUSH new matches to a
// webhook instead of us polling — so this door is CRON-FREE by design (there is
// nothing to schedule; BatchData decides when a match exists).
//
// TWO DOORS, ONE ROUTE (wave 151, lane 151F — directive 151F routes A and B):
//
//   PLATFORM door (route A, unchanged): no `?connection=` — AUTH is the shared
//   secret in BATCHDATA_SMART_SEARCH_WEBHOOK_SECRET, compared timing-safe against
//   an inbound header; no secret configured → refuse every request (fail closed —
//   CLAUDE.md §4). Records are PLATFORM-owned (brokerageId: null) and routed by
//   geography against the active-subscriber territories.
//
//   TENANT door (route B, wave 151F): `?connection=<platform_credentials.id>` names
//   a TENANT's own BatchData Smart Search subscription. The presented secret is
//   compared timing-safe against THAT connection's own encrypted signing secret
//   (minted when the tenant connected on Settings → Integrations → Lead sources,
//   lib/providers/tenant-provider-connections.ts) — never the platform env secret;
//   a disconnected connection carries no secret and refuses everything. Hydration
//   runs under the TENANT's own token (no fallback to the platform key), the hydrate
//   spend books coverage tenant_paid, and the records enter THE SAME producer with
//   brokerageId = the tenant (source_origin 'brokerage') gated by the connection's
//   territory, the provider's eventId anchoring the m961 idempotency key so a replay
//   is ONE observation. A delivery the tenant's token cannot hydrate is PARKED
//   (ingress-continuity) and the connection's health is written on its row.
//
// PAYLOAD CONTRACT — WAVE 66 CORRECTION of wave 65's guess, against DOCUMENTED
// FACTS (help.batchdata.io, fetched 2026-09-16, transcribed verbatim in the
// lane prompt): the push event carries IDS ONLY —
//   { eventId, subscriberId, propertyId, parcelHash, addressHash,
//     propertyChangedAt, addedToSubscriptionIds: [], removedFromSubscriptionIds: [] }
// — never the full property record. Hydration is a SEPARATE call,
// lib/external/batchdata-client.ts::lookupBatchDataPropertiesByIds (documented
// as `POST /api/v1/property/lookup`; independently confirmed by this lane's own
// Exa fetch as the live `POST /api/v1/property/lookup/all-attributes`).
//
// wave 65's `results.properties[]` / `matches[]` shapes are KEPT as a fallback
// (never removed) for an account/tier that ships the full row inline despite
// the documented ids-only contract — read defensively, not pinned to one shape.
// Wave 151F: the envelope reading and the ids-only test moved to
// lib/providers/tenant-provider-connections.ts (extractSmartSearchEvents /
// isIdsOnlySmartSearchEvent) so both doors read ONE definition.
//
// TERRITORY (platform door): Smart Search matches carry no market_id, so each
// match is routed by GEOGRAPHY against the SAME active-subscriber territory
// resolver every other scraper uses (resolveActiveScrapeTerritories +
// recordMatchesTerritory) — never ingested for a zip no active subscriber
// configured. Records are PLATFORM-owned (brokerageId: null) — the same
// market-driven posture the cron uses — so raw_scraped_leads.source_origin
// derives to 'platform'.
//
// INGEST: routed through the task-1 survivor, lib/kernel/scraping.ts::
// ingestRawSourceBatch — no second raw-insert implementation.
import { NextResponse } from "next/server"
import { timingSafeEqual } from "crypto"
import { createServiceClient } from "@/lib/supabase/service"
import { ingestRawSourceBatch } from "@/lib/kernel/scraping"
import { normalizeBatchDataRecord } from "@/lib/lead-pipeline/scraper-parsers"
import { resolveActiveScrapeTerritories } from "@/lib/lead-pipeline/scrape-territories"
import { recordMatchesTerritory } from "@/lib/lead-pipeline/source-intent-map"
import { lookupBatchDataPropertiesByIds } from "@/lib/external/batchdata-client"
import { bookSourceSpend } from "@/lib/lead-pipeline/source-cost-ledger"
import type { NormalizedScrapedRecord } from "@/lib/lead-pipeline/raw-record-types"
import {
  TENANT_WEBHOOK_SECRET_HEADER,
  extractSmartSearchEvents,
  ingestTenantWebhookDelivery,
  isIdsOnlySmartSearchEvent,
  redactProviderSecrets,
  tenantAcquisitionProvider,
  tenantWebhookConnectionId,
  verifyTenantWebhookSecret,
  type SmartSearchEvent,
  type TenantProviderConnectionConfig,
} from "@/lib/providers/tenant-provider-connections"

export const dynamic = "force-dynamic"

/** The headers a delivery may carry its secret in — ONE list for both doors. */
function presentedSecret(request: Request): string {
  return (
    request.headers.get("x-batchdata-webhook-secret") ??
    request.headers.get(TENANT_WEBHOOK_SECRET_HEADER) ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    ""
  )
}

/** Timing-safe shared-secret check (PLATFORM door). Accepts either a dedicated header or a
 *  bearer Authorization header, since BatchData's exact header name for this
 *  push was not confirmed by research — both are checked so a real delivery
 *  is never rejected on a header-name guess alone. */
function verifySharedSecret(request: Request): boolean {
  const expected = process.env.BATCHDATA_SMART_SEARCH_WEBHOOK_SECRET
  if (!expected) {
    console.warn("[batchdata-smart-search] BATCHDATA_SMART_SEARCH_WEBHOOK_SECRET not set — refusing request")
    return false
  }
  const received = presentedSecret(request)
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  if (a.length === 0 || a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/**
 * THE TENANT DOOR (wave 151F, route B). The connection row is read on the service client by id; its secret and token are
 * decrypted here and handed to the pure ingester; the ingester's health verdict is written back on the row (counted). No
 * platform secret, no platform key, no platform territory resolver is consulted on this path.
 */
async function handleTenantDelivery(request: Request, connectionId: string): Promise<Response> {
  const svc = createServiceClient()
  const { data: row, error } = await svc
    .from("platform_credentials")
    .select("id, brokerage_id, platform, api_key, config, is_active, test_status, owner_type")
    .eq("id", connectionId)
    .eq("owner_type", "brokerage")
    .maybeSingle()
  // A refused read is NOT "no such connection": nothing is accepted and nothing is said about the connection.
  if (error) return NextResponse.json({ error: "connection store unavailable" }, { status: 503 })
  if (!row || !row.brokerage_id || !tenantAcquisitionProvider(String(row.platform))?.webhook) {
    // 404-silent — the URL is ours; an unknown connection id learns nothing.
    return NextResponse.json({ error: "not found" }, { status: 404 })
  }
  const { decryptSecret } = await import("@/lib/security/secret-crypto")
  const config = (row.config ?? null) as Partial<TenantProviderConnectionConfig> | null
  let signingSecret: string | null = null
  let apiKey: string | null = null
  try {
    signingSecret = decryptSecret(config?.webhook_secret ?? null)
    apiKey = decryptSecret((row.api_key as string | null) ?? null)
  } catch (e) {
    // A tampered envelope is a platform incident, never an accepted delivery. The message is redacted before it is logged.
    console.error("[batchdata-smart-search] tenant connection secret did not decrypt:", redactProviderSecrets((e as Error).message))
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }
  const verdict = verifyTenantWebhookSecret(signingSecret, presentedSecret(request))
  if (verdict !== "ok") return NextResponse.json({ error: "unauthorized" }, { status: 401 })

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const events = extractSmartSearchEvents(payload)
  const { meterVendorSpend } = await import("@/lib/vendor-governance/meter-vendor")
  const { parkIngressEvent } = await import("@/lib/kernel/ingress-continuity")
  const report = await ingestTenantWebhookDelivery(
    svc,
    { id: String(row.id), brokerage_id: String(row.brokerage_id), platform: String(row.platform), is_active: row.is_active === true, test_status: (row.test_status as "pass" | "fail" | "pending" | null) ?? null, apiKey, config },
    events,
    {
      // The TENANT's token, pinned to the tenant for the gateway's api_response_logs attribution; never the platform key.
      // Wave 151 (lane 151C, wired by the integrator): PRE-PULL DEDUP BEFORE THE PAID HYDRATE — ids this tenant already holds
      // (a known source id, a fresh prior answer) are not bought again; an unreadable known-set hydrates as before and says so.
      hydrate: async (ids, key) => {
        const { loadKnownAcquisitionKeys, planPrePullDedup } = await import("@/lib/lead-pipeline/pre-pull-dedup")
        const candidates = ids.map((id) => ({ ref: id, source: "batchdata_smart_search", sourceRecordId: id }))
        const known = await loadKnownAcquisitionKeys(svc as never, { brokerageId: String(row.brokerage_id), marketIds: [] }, { candidates })
        const plan = known ? planPrePullDedup(candidates, known, { lookupKind: "property" }) : null
        const toHydrate = plan ? plan.buy.map((c) => c.ref) : ids
        if (!known) console.warn("[batchdata-smart-search] pre-pull dedup could not read the known keys — hydrating every id as before")
        else if (plan && plan.skipped > 0) console.log(`[batchdata-smart-search] pre-pull dedup saved ${plan.skipped} paid hydrate(s) of ${ids.length} for tenant ${String(row.brokerage_id)}`)
        if (toHydrate.length === 0) return { ok: true, properties: [], cost: 0 } as Awaited<ReturnType<typeof lookupBatchDataPropertiesByIds>>
        return lookupBatchDataPropertiesByIds(toHydrate, { apiKey: key, brokerageId: String(row.brokerage_id) })
      },
      normalize: (raw, geo) => normalizeBatchDataRecord(raw, geo),
      ingest: (p) => ingestRawSourceBatch(p),
      book: (input) => meterVendorSpend(input),
      park: (p) => parkIngressEvent(svc, p),
    },
  )
  if (report.healthPatch) {
    const { data: moved, error: healthErr } = await svc
      .from("platform_credentials")
      .update({ test_status: report.healthPatch.test_status, last_tested_at: report.healthPatch.last_health.at, config: { ...(config ?? {}), last_health: report.healthPatch.last_health }, updated_at: new Date().toISOString() })
      .eq("id", connectionId)
      .eq("brokerage_id", row.brokerage_id)
      .select("id")
    if (healthErr || (moved ?? []).length !== 1) console.error("[batchdata-smart-search] tenant connection health NOT written:", healthErr?.message ?? "update matched no row")
  }
  // Wave 152 (lane 152K — 152A outside-lane 1): a shape-drift / other-4xx hydrate refusal is classified
  // `notify: "platform_staff"` (lib/providers/tenant-provider-connections.ts classifyTenantProviderFailure), but this
  // branch reported only "tenant_admin", so platform staff were never told. Both now report; a platform-staff verdict is
  // platform-visible, so the consumer's escalation opens the ticket in the platform lane as well as the account's.
  if ((report.notify === "tenant_admin" || report.notify === "platform_staff") && report.refused) {
    // The right authorized user hears it now, without a secret (lib/kernel/immediate-operations.ts reportOperationOutcome).
    try {
      const { reportOperationOutcome } = await import("@/lib/kernel/immediate-operations")
      await reportOperationOutcome(svc, {
        operation: "provider_connection", brokerageId: String(row.brokerage_id), ok: false,
        subjectType: "platform_credentials", subjectId: connectionId, actorUserId: null, source: "webhook",
        evidence: { provider: row.platform, connectionState: report.connectionState, held: report.held, parked: report.parked }, error: report.refused,
        tenantFacing: report.refused,
        platformVisible: report.notify === "platform_staff",
      })
    } catch (e) {
      console.error("[batchdata-smart-search] tenant notification not sent:", (e as Error).message)
    }
  }
  // 200 when the delivery was taken (ingested, held or parked — the provider must not retry a held delivery blindly);
  // 503 only when the connection itself refused, so the provider's retry finds a reconnected door.
  const status = report.ok || report.parked > 0 || report.held > 0 ? 200 : 503
  return NextResponse.json({
    door: "tenant", connectionState: report.connectionState, received: report.received, hydrated: report.hydrated, ingested: report.inserted,
    replayed: report.replayed, offTerritory: report.skippedTerritory, held: report.held, parked: report.parked, refused: report.refused,
  }, { status })
}

export async function POST(request: Request) {
  // ── THE TENANT DOOR (route B): `?connection=<id>` — its own secret, its own token, its own territory. ──
  const connectionId = tenantWebhookConnectionId(request.url)
  if (connectionId) return handleTenantDelivery(request, connectionId)

  // ── THE PLATFORM DOOR (route A) — unchanged. ──
  if (!verifySharedSecret(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const events = extractSmartSearchEvents(payload)

  if (events.length === 0) {
    return NextResponse.json({ ingested: 0, reason: "no events in payload" })
  }

  // ── HYDRATE: ids-only events (the documented shape) need a Property Lookup;
  // an inline full record (a fallback for an account/tier that ships one
  // anyway) is used as-is. A pure REMOVAL event (addedToSubscriptionIds empty,
  // only removedFromSubscriptionIds populated) is dropped — the property no
  // longer matches, which is not a lead to create.
  const idsOnly = events.filter(isIdsOnlySmartSearchEvent) as unknown as SmartSearchEvent[]
  const fullRecords = events.filter((e) => !isIdsOnlySmartSearchEvent(e))

  const additionIds = idsOnly
    .filter((e) => (e.addedToSubscriptionIds?.length ?? 0) > 0)
    .map((e) => e.propertyId)
    .filter((id): id is string => typeof id === "string")

  let rawMatches: Array<Record<string, unknown>> = [...fullRecords]
  let hydrateCostUsd = 0
  if (additionIds.length > 0) {
    const hydrate = await lookupBatchDataPropertiesByIds(additionIds)
    rawMatches = [...rawMatches, ...hydrate.properties]
    hydrateCostUsd = hydrate.cost
  }

  if (rawMatches.length === 0) {
    return NextResponse.json({ ingested: 0, reason: "no matches after hydration (all events were removals or the lookup returned nothing)" })
  }

  const supabase = createServiceClient()

  // Same active-subscriber territory resolver every scraper uses — a Smart
  // Search push for a zip no active subscriber configured is never ingested
  // (the platform never scrapes/ingests fixed or unclaimed geography).
  const resolution = await resolveActiveScrapeTerritories(supabase)
  if (resolution.noOp) {
    return NextResponse.json({ ingested: 0, reason: resolution.reason })
  }

  const byMarket = new Map<string, { market: (typeof resolution.territories)[number]; records: NormalizedScrapedRecord[] }>()
  let unmatched = 0
  for (const raw of rawMatches) {
    const record = normalizeBatchDataRecord(raw, { city: null, state: null })
    const market = resolution.territories.find((m) =>
      recordMatchesTerritory({ city: record.city, state: record.state, zip: record.zip }, m),
    )
    if (!market) { unmatched++; continue }
    // Budget gate — same posture as the cron: an exhausted territory is skipped,
    // never over-spent because a push arrived out of band.
    if ((market.spend_this_month ?? 0) >= (market.monthly_budget_usd ?? 100)) continue
    const entry = byMarket.get(market.id) ?? { market, records: [] as NormalizedScrapedRecord[] }
    entry.records.push(record)
    byMarket.set(market.id, entry)
  }

  let inserted = 0
  // Property Lookup hydration cost is spread evenly across the markets this
  // delivery actually matched — the hydrate call is one batch across every
  // event in the payload, so there is no per-market cost to read off it
  // directly; an even split is the honest approximation until a per-property
  // cost breakdown is available, and it is still visible in the ledger rather
  // than silently unmetered (CLAUDE.md §5: a wrong ledger number is a wrong
  // invoice, but an ABSENT one is worse — it reads as free).
  const perMarketHydrateCost = byMarket.size > 0 ? hydrateCostUsd / byMarket.size : 0
  for (const { market, records } of byMarket.values()) {
    const res = await ingestRawSourceBatch({
      brokerageId: null, // platform-owned pool — same posture as the scheduled territory cron
      marketId: market.id,
      source: "batchdata_smart_search",
      sourceFamily: "motivated_seller",
      sourceChannel: "batchdata_smart_search",
      records,
      executionId: null,
      marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
      // Lane 82B — the hydrate spend reaches cost_per_record (was null → a pushed lead read $0).
      batchCostUsd: perMarketHydrateCost,
      // C35 (wave 150, lane 150EFG): the row names the door it came in (raw_scraped_leads.producer_actor_type).
      actor: { type: "webhook", id: "batchdata_smart_search" },
    })
    inserted += res.inserted
    if (perMarketHydrateCost > 0) {
      // Platform ledger, per SOURCE (lane 82B): vendor from SOURCE_VENDOR ('batchdata'), usage_type
      // = 'batchdata_smart_search' so the lead-cost reconcile can see it.
      void bookSourceSpend({
        source: "batchdata_smart_search", cost: perMarketHydrateCost,
        brokerageId: market.brokerage_id, marketId: market.id,
      }).catch(() => null)
    }
  }

  return NextResponse.json({
    received: events.length,
    hydrated: additionIds.length,
    ingested: inserted,
    marketsMatched: byMarket.size,
    unmatchedTerritory: unmatched,
  })
}
