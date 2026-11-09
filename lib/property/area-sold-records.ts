// lib/property/area-sold-records.ts
// ─────────────────────────────────────────────────────────────────────────────
// AREA SOLD RECORDS — THE CAPABILITY (wave 151; RENTCAST_DATA_TYPES.sold_records, lib/market-reports/contract.ts).
//
// Owner: "RentCast has sold properties because market data is a capability of RentCast if the tenant doesn't have a
// connected IDX provider." A tenant WITH a connected IDX/MLS feed takes its closed sales from that feed (the MLS-synced
// listings the market report already reads) — RentCast is not asked and nothing is spent; a tenant WITHOUT one reads
// RentCast's `/properties?saleDateRange=` sold records (RECORDED sales — never `/markets`, which is LISTING statistics),
// gated, metered and cached inside the vendor leg (lib/property/rentcast.ts getRentcastSoldRecords). No BatchData
// backup: a report never buys a backup sold list. The IDX question is THE ONE gate's (rentcast-eligibility.ts, readKind
// sale_listings — the kind that asks it); an unreadable IDX answer fails CLOSED here exactly as it does there.
//
// Callers reach this door, never the vendor leg (LAW 3 — lib/market-reports/research.ts defaultSoldRecords; the
// market-report guards forbid a RentCast client call from lib/market-reports). NOT server-only: simulator-driven
// (scripts/provider-gap-matrix-guard.ts B drives it with injected seams) like lib/property/rentcast.ts beside it.

export type AreaSoldRecordsOutcome = "answered" | "tenant_has_idx" | "not_eligible" | "no_records" | "error"

export interface AreaSoldRecord {
  address: string | null; city: string | null; state: string | null; zip: string | null
  /** YYYY-MM-DD the recorded sale closed. */
  lastSaleDate: string
  lastSalePrice: number
  bedrooms: number | null; bathrooms: number | null; squareFeet: number | null; propertyType: string | null
}

/** Injectable seams so the proof walks the capability with zero network. */
export interface AreaSoldRecordsDeps {
  eligibility?: (ctx: { brokerageId: string; agentUserId?: string | null; readKind: "sale_listings" }) => Promise<{ reason: string; detail: string }>
  rentcast?: (p: { brokerageId: string; agentUserId?: string | null; zipCode: string | null; city: string | null; state: string | null; saleDateRangeDays: number; limit: number; systemSource?: string }) => Promise<{ success: boolean; records: Array<{ address: string | null; city: string | null; state: string | null; zip: string | null; lastSaleDate: string | null; lastSalePrice: number | null; bedrooms: number | null; bathrooms: number | null; squareFeet: number | null; propertyType: string | null }>; cacheHit: boolean; error?: string }>
  now?: Date
}

/**
 * THE area sold-records read. `windowDays` bounds the recorded sale date (RentCast filters server-side; the window is
 * re-applied here so a row the vendor returns outside it, or without a dated positive price, never counts). Never throws.
 */
export async function getAreaSoldRecords(
  params: { brokerageId: string; agentUserId?: string | null; zip?: string | null; city?: string | null; state?: string | null; windowDays: number; limit?: number; systemSource?: string },
  deps: AreaSoldRecordsDeps = {},
): Promise<{ outcome: AreaSoldRecordsOutcome; dataType: "sold_records"; records: AreaSoldRecord[]; note: string; cacheHit: boolean }> {
  const dataType = "sold_records" as const
  const none = (outcome: AreaSoldRecordsOutcome, note: string) => ({ outcome, dataType, records: [] as AreaSoldRecord[], note, cacheHit: false })
  if (!params.zip && !(params.city && params.state)) return none("error", "an area sold-records read needs a zip code, or a city and state")
  try {
    const gate = deps.eligibility
      ? await deps.eligibility({ brokerageId: params.brokerageId, agentUserId: params.agentUserId ?? null, readKind: "sale_listings" })
      : await (await import("./rentcast-eligibility")).resolveRentcastEligibility({ brokerageId: params.brokerageId, agentUserId: params.agentUserId ?? undefined, readKind: "sale_listings" })
    if (gate.reason === "tenant_has_idx") return none("tenant_has_idx", `this tenant's connected IDX/MLS feed is its closed-sales source — RentCast sold records were not read (${gate.detail})`)
    if (gate.reason !== "eligible") return none("not_eligible", `RentCast sold records were not read: ${gate.reason} — ${gate.detail}`)
    const windowDays = Math.max(1, Math.floor(params.windowDays))
    const read = deps.rentcast
      ? await deps.rentcast({ brokerageId: params.brokerageId, agentUserId: params.agentUserId ?? null, zipCode: params.zip ?? null, city: params.city ?? null, state: params.state ?? null, saleDateRangeDays: windowDays, limit: params.limit ?? 200, systemSource: params.systemSource })
      : await (await import("./rentcast")).getRentcastSoldRecords({ brokerageId: params.brokerageId, agentUserId: params.agentUserId ?? undefined, zipCode: params.zip ?? null, city: params.city ?? null, state: params.state ?? null, saleDateRangeDays: windowDays, limit: params.limit ?? 200, systemSource: params.systemSource })
    if (!read.success) return none("error", read.error ?? "RentCast sold records request failed")
    const now = deps.now ?? new Date()
    const since = now.getTime() - windowDays * 86_400_000
    const records: AreaSoldRecord[] = []
    for (const r of read.records) {
      if (!r.lastSaleDate || !/^\d{4}-\d{2}-\d{2}/.test(r.lastSaleDate) || typeof r.lastSalePrice !== "number" || !(r.lastSalePrice > 0)) continue
      const t = Date.parse(`${r.lastSaleDate.slice(0, 10)}T00:00:00Z`)
      if (!Number.isFinite(t) || t < since || t > now.getTime() + 86_400_000) continue
      records.push({ address: r.address, city: r.city, state: r.state, zip: r.zip, lastSaleDate: r.lastSaleDate.slice(0, 10), lastSalePrice: r.lastSalePrice, bedrooms: r.bedrooms, bathrooms: r.bathrooms, squareFeet: r.squareFeet, propertyType: r.propertyType })
    }
    records.sort((a, b) => (a.lastSaleDate < b.lastSaleDate ? 1 : a.lastSaleDate > b.lastSaleDate ? -1 : 0))
    if (records.length === 0) return { ...none("no_records", `RentCast returned ${read.records.length} property record(s) for the area, none with a recorded sale inside the last ${windowDays} days`), cacheHit: read.cacheHit }
    return { outcome: "answered", dataType, records, note: `${records.length} RentCast sold record(s) in the last ${windowDays} days (${read.records.length} returned; ${read.cacheHit ? "cached read" : "one metered request"})`, cacheHit: read.cacheHit }
  } catch (e) {
    return none("error", `area sold records threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}
