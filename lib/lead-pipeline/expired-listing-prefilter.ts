/**
 * lib/lead-pipeline/expired-listing-prefilter.ts
 *
 * THE RENTCAST INACTIVE-LISTING PREFILTER for the expired / withdrawn seller lane (wave 92, lane
 * 92B — the wiring lane 91B recommended in §4.3 of its notes and left for an owner decision).
 *
 * Owner, verbatim (2026-10-01): "use rentcast as much as possible regarding property listings" ·
 * "batchdata is to be used more for scrapping leads." · "pulling recent data should be only on
 * where it is appropriate."
 *
 * THE PROBLEM IT CLOSES. BatchData publishes NO request-side filter on a listing's STATUS date
 * (lib/external/batchdata-client.ts withinListingStatusWindow's header), so the `expired` area
 * pull bills every row it returns (~$0.05/record) and the freshness window can only DROP stale
 * rows after they were paid for (lane 90B's `staleDropped`). RentCast's `/listings/sale?status=
 * Inactive` answers "what came off the market here, and WHEN" — every row carries `removedDate`
 * — at up to 500 listings per request (one request ≈ $0.074, or $0 from the free tier).
 *
 * THE PIPELINE:
 *   1. ONE RentCast request per territory (status Inactive, ≤500 rows — RENTCAST_MAX_LISTINGS_
 *      PER_REQUEST) — a property-data read, so a tenant's IDX feed does not suppress it.
 *   2. PURE selection (selectFreshRemovals): removed within the market's lookback window (a
 *      listing STATUS CHANGE — exactly where a recency window belongs), one row per address,
 *      capped at the market's per-run record budget.
 *   3. BatchData property lookup ONLY for those fresh addresses (owner + mailing + quickLists —
 *      the LEAD data RentCast does not sell), each normalized as an `expired` record.
 *   4. Sold-after-removal rows are dropped (BatchData's own soldDate / last sale on or after the
 *      removal): RentCast's Inactive status cannot tell expired from sold.
 * When RentCast cannot answer (unconfigured, budget paused, provider error) the caller keeps the
 * BatchData area pull it ran before (mode "unavailable") — a dark RentCast lane never darkens the
 * expired lane. When RentCast answers with ZERO fresh removals, the BatchData pull is SKIPPED:
 * nothing came off the market, so there is nothing to buy.
 *
 * Called ONLY by app/api/cron/lead-scraping/route.ts, inside the active-territory gate.
 */
import type { BatchDataRecord } from "@/lib/external/batchdata-client"
import type { RentcastListing } from "@/lib/property/rentcast"

/** The window when the market sets none (lead_scraping_motivated_params.lookback_days unset). */
const DEFAULT_EXPIRED_LOOKBACK_DAYS = 30
/** Per-run BatchData lookup ceiling when the market sets none (max_records_per_run unset). */
const DEFAULT_MAX_LOOKUPS = 50

interface FreshRemoval {
  address: string
  city: string | null
  state: string | null
  zip: string | null
  removedDate: string
  listPrice: number | null
  daysOnMarket: number | null
}

/**
 * PURE — the inactive listings worth a BatchData lookup: removed inside the window, one per
 * normalized address (newest removal wins), newest first, capped. An undated, unparseable or
 * FUTURE removal is not fresh (nothing proves it left recently).
 */
function selectFreshRemovals(
  listings: ReadonlyArray<Pick<RentcastListing, "address" | "city" | "state" | "zip" | "removedDate" | "price" | "daysOnMarket">>,
  lookbackDays: number | null | undefined,
  nowMs: number,
  cap: number,
): FreshRemoval[] {
  const days = typeof lookbackDays === "number" && lookbackDays > 0 ? lookbackDays : DEFAULT_EXPIRED_LOOKBACK_DAYS
  const floor = nowMs - days * 86_400_000
  const byKey = new Map<string, FreshRemoval>()
  for (const l of listings) {
    const at = Date.parse(String(l.removedDate ?? ""))
    if (!Number.isFinite(at) || at < floor || at > nowMs + 86_400_000) continue
    const address = (l.address ?? "").trim()
    if (!address) continue
    const key = address.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
    const prev = byKey.get(key)
    if (prev && Date.parse(prev.removedDate) >= at) continue
    byKey.set(key, {
      address, city: l.city ?? null, state: l.state ?? null, zip: l.zip ?? null,
      removedDate: String(l.removedDate), listPrice: l.price ?? null, daysOnMarket: l.daysOnMarket ?? null,
    })
  }
  return [...byKey.values()]
    .sort((a, b) => Date.parse(b.removedDate) - Date.parse(a.removedDate))
    .slice(0, Math.max(0, Math.floor(cap)))
}

/** PURE — did this home SELL on/after it came off the market? (BatchData's listing.soldDate or
 *  its last sale, a week of slack for recording lag.) A sold home is not an expired-listing lead. */
function soldAfterRemoval(record: Pick<BatchDataRecord, "listing" | "lastSale">, removedDate: string): boolean {
  const removedAt = Date.parse(removedDate)
  if (!Number.isFinite(removedAt)) return false
  const soldAt = Date.parse(String(record.listing?.soldDate ?? record.lastSale?.date ?? ""))
  return Number.isFinite(soldAt) && soldAt >= removedAt - 7 * 86_400_000
}

interface ExpiredPrefilterResult {
  /** "prefiltered" = RentCast answered (records are the fresh, unsold owner rows; possibly none).
   *  "unavailable" = RentCast could not answer — the caller runs its BatchData area pull. */
  mode: "prefiltered" | "unavailable"
  records: BatchDataRecord[]
  /** Inactive listings RentCast returned for the territory. */
  removalsSeen: number
  /** Of those, removed inside the window (one per address, capped) — the BatchData lookups asked. */
  freshRemovals: number
  /** BatchData lookups that returned a property row (each billed). */
  lookupsMatched: number
  /** Fresh removals whose BatchData row shows a sale on/after the removal — dropped. */
  soldDropped: number
  /** BatchData spend (matched rows × the per-record search price). RentCast meters itself. */
  batchDataCostUsd: number
  reason: string
}

interface ExpiredPrefilterDeps {
  inactiveListings: (q: { brokerageId: string; city: string; state: string }) => Promise<{ success: boolean; listings: RentcastListing[]; error?: string }>
  lookupOwner: (address: string) => Promise<BatchDataRecord | null>
  recordCostUsd: number
  nowMs?: number
}

/** I/O defaults — the ONE RentCast client and the BatchData property search (lead data). */
async function productionDeps(): Promise<ExpiredPrefilterDeps> {
  const [{ searchRentcastSaleListings }, bd, { RENTCAST_MAX_LISTINGS_PER_REQUEST }] = await Promise.all([
    import("@/lib/property/rentcast"),
    import("@/lib/external/batchdata-client"),
    import("@/lib/property/rentcast-query"),
  ])
  return {
    inactiveListings: (q) => searchRentcastSaleListings({
      brokerageId: q.brokerageId,
      systemSource: "expired_listing_prefilter",
      filters: { city: q.city, state: q.state, status: "Inactive", limit: RENTCAST_MAX_LISTINGS_PER_REQUEST },
    }),
    lookupOwner: async (address) => {
      const r = await bd.searchProperties(address, { take: 1 })
      const row = (r.matches ?? [])[0]
      return row ? bd.normalizeBatchDataProperty(row, "expired") : null
    },
    recordCostUsd: bd.BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD,
  }
}

/**
 * Run the prefilter for ONE territory. Never throws: any failure on the RentCast side returns
 * mode "unavailable" (the caller keeps its BatchData area pull); a failed BatchData lookup skips
 * that address only.
 */
export async function runExpiredListingPrefilter(
  params: { brokerageId: string; city: string; state: string; lookbackDays?: number | null; maxLookups?: number | null },
  deps?: ExpiredPrefilterDeps,
): Promise<ExpiredPrefilterResult> {
  const base = { records: [] as BatchDataRecord[], removalsSeen: 0, freshRemovals: 0, lookupsMatched: 0, soldDropped: 0, batchDataCostUsd: 0 }
  let d: ExpiredPrefilterDeps
  try { d = deps ?? (await productionDeps()) } catch (e) {
    return { ...base, mode: "unavailable", reason: `prefilter could not load its providers: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!params.city || !params.state) return { ...base, mode: "unavailable", reason: "territory has no city + state for an area sweep" }
  let inactive: { success: boolean; listings: RentcastListing[]; error?: string }
  try { inactive = await d.inactiveListings({ brokerageId: params.brokerageId, city: params.city, state: params.state }) } catch (e) {
    return { ...base, mode: "unavailable", reason: `RentCast inactive sweep threw: ${e instanceof Error ? e.message : String(e)}` }
  }
  if (!inactive.success) return { ...base, mode: "unavailable", reason: `RentCast inactive sweep unavailable: ${inactive.error ?? "no reason reported"}` }

  const cap = typeof params.maxLookups === "number" && params.maxLookups > 0 ? params.maxLookups : DEFAULT_MAX_LOOKUPS
  const fresh = selectFreshRemovals(inactive.listings, params.lookbackDays, d.nowMs ?? Date.now(), cap)
  const out: ExpiredPrefilterResult = { ...base, mode: "prefiltered", removalsSeen: inactive.listings.length, freshRemovals: fresh.length, reason: "" }
  for (const f of fresh) {
    let rec: BatchDataRecord | null = null
    try { rec = await d.lookupOwner([f.address, f.city, f.state].filter(Boolean).join(", ")) } catch { rec = null }
    if (!rec) continue
    out.lookupsMatched++
    out.batchDataCostUsd += d.recordCostUsd
    if (soldAfterRemoval(rec, f.removedDate)) { out.soldDropped++; continue }
    // The RentCast removal date IS the status date the expired lane's freshness gate reads.
    out.records.push({ ...rec, listing: { ...(rec.listing ?? {}), statusUpdatedAt: rec.listing?.statusUpdatedAt ?? f.removedDate } })
  }
  out.batchDataCostUsd = Math.round(out.batchDataCostUsd * 100) / 100
  out.reason = fresh.length === 0
    ? `RentCast saw ${out.removalsSeen} inactive listing(s); none left the market inside the window — the BatchData expired pull was skipped`
    : `RentCast saw ${out.removalsSeen} inactive listing(s); ${fresh.length} fresh removal(s) looked up on BatchData (${out.lookupsMatched} matched, ${out.soldDropped} sold dropped)`
  return out
}
