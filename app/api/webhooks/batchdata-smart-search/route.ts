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
// PAYLOAD CONTRACT — UNRESOLVED: this lane's research confirmed Smart Search is
// "event-driven monitoring [that] pushes new matches (no polling)" but did not
// surface a confirmed push-payload schema (unlike property/search, which this
// repo already parses via normalizeBatchDataProperty). Rather than guess a
// schema and silently drop a real payload shape, every plausible envelope
// (`matches[]`, `properties[]`, `results[]`, a bare array, or a single object)
// is accepted, and each item is run through the SAME normalizeBatchDataRecord
// used by the property-search + motivated-seller sourcers — the wire contract
// should be reconfirmed against BatchData's dashboard/docs before this fires in
// production (see the wave report's unresolved list).
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
import type { NormalizedScrapedRecord } from "@/lib/lead-pipeline/raw-record-types"

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
  const rawMatches: Array<Record<string, unknown>> = Array.isArray((p as any)?.matches)
    ? (p as any).matches
    : Array.isArray((p as any)?.properties)
      ? (p as any).properties
      : Array.isArray((p as any)?.results)
        ? (p as any).results
        : Array.isArray(p)
          ? (p as unknown[])
          : p && typeof p === "object"
            ? [p as Record<string, unknown>]
            : []

  if (rawMatches.length === 0) {
    return NextResponse.json({ ingested: 0, reason: "no matches in payload" })
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
    })
    inserted += res.inserted
  }

  return NextResponse.json({
    received: rawMatches.length,
    ingested: inserted,
    marketsMatched: byMarket.size,
    unmatchedTerritory: unmatched,
  })
}
