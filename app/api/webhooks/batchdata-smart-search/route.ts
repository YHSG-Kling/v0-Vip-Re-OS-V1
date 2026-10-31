// app/api/webhooks/batchdata-smart-search/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// BATCHDATA SMART SEARCH — inbound webhook receiver (DISTINCT capability from
// batchdata_motivated / expired_listing — owner ruling: never fold two source
// capabilities into one). BatchData's "Smart Search" is EVENT-DRIVEN monitoring:
// once a saved search is configured on their side, they PUSH new matches to a
// webhook instead of us polling — so this door is CRON-FREE by design (there is
// nothing to schedule; BatchData decides when a match exists).
//
// AUTH: a shared secret in BATCHDATA_SMART_SEARCH_WEBHOOK_SECRET, compared
// timing-safe against an inbound header. No secret configured → refuse every
// request (fail closed — CLAUDE.md §4).
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
//
// TERRITORY: Smart Search matches carry no market_id, so each match is routed
// by GEOGRAPHY against the SAME active-subscriber territory resolver every
// other scraper uses (resolveActiveScrapeTerritories + recordMatchesTerritory)
// — never ingested for a zip no active subscriber configured. Records are
// PLATFORM-owned (brokerageId: null) — the same market-driven posture the
// cron uses — so raw_scraped_leads.source_origin derives to 'platform'.
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

/** One documented Property Monitoring push event. `addedToSubscriptionIds`
 *  distinguishes a NEW match from `removedFromSubscriptionIds` (the property
 *  no longer matches — e.g. it sold or was withdrawn); this receiver hydrates
 *  and ingests ONLY additions, since a removal is not a lead to create. */
interface SmartSearchEvent {
  eventId?: string
  subscriberId?: string
  propertyId?: string
  parcelHash?: string
  addressHash?: string
  propertyChangedAt?: string
  addedToSubscriptionIds?: string[]
  removedFromSubscriptionIds?: string[]
}

function isIdsOnlyEvent(row: unknown): row is SmartSearchEvent {
  return !!row && typeof row === "object" && typeof (row as any).propertyId === "string" &&
    !(row as any).address && !(row as any).owner // an ids-only event carries neither of the full-record's top-level shapes
}

export const dynamic = "force-dynamic"

/** Timing-safe shared-secret check. Accepts either a dedicated header or a
 *  bearer Authorization header, since BatchData's exact header name for this
 *  push was not confirmed by research — both are checked so a real delivery
 *  is never rejected on a header-name guess alone. */
function verifySharedSecret(request: Request): boolean {
  const expected = process.env.BATCHDATA_SMART_SEARCH_WEBHOOK_SECRET
  if (!expected) {
    console.warn("[batchdata-smart-search] BATCHDATA_SMART_SEARCH_WEBHOOK_SECRET not set — refusing request")
    return false
  }
  const received =
    request.headers.get("x-batchdata-webhook-secret") ??
    request.headers.get("x-webhook-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    ""
  const a = Buffer.from(expected)
  const b = Buffer.from(received)
  if (a.length === 0 || a.length !== b.length) return false
  try {
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(request: Request) {
  if (!verifySharedSecret(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }

  const p = payload as Record<string, unknown> | unknown[] | null
  const events: Array<Record<string, unknown>> = Array.isArray((p as any)?.results?.properties)
    ? (p as any).results.properties
    : Array.isArray((p as any)?.matches)
      ? (p as any).matches
      : Array.isArray((p as any)?.events)
        ? (p as any).events
        : Array.isArray((p as any)?.properties)
          ? (p as any).properties
          : Array.isArray((p as any)?.results)
            ? (p as any).results
            : Array.isArray(p)
              ? (p as unknown[])
              : p && typeof p === "object"
                ? [p as Record<string, unknown>]
                : []

  if (events.length === 0) {
    return NextResponse.json({ ingested: 0, reason: "no events in payload" })
  }

  // ── HYDRATE: ids-only events (the documented shape) need a Property Lookup;
  // an inline full record (a fallback for an account/tier that ships one
  // anyway) is used as-is. A pure REMOVAL event (addedToSubscriptionIds empty,
  // only removedFromSubscriptionIds populated) is dropped — the property no
  // longer matches, which is not a lead to create.
  const idsOnly = events.filter(isIdsOnlyEvent) as unknown as SmartSearchEvent[]
  const fullRecords = events.filter((e) => !isIdsOnlyEvent(e))

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
