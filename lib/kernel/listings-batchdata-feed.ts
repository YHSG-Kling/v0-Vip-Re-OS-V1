/**
 * lib/kernel/listings-batchdata-feed.ts
 *
 * Wave 66. Owner ruling (verbatim): "Batchdata also allows you to find properties
 * that are active and other new features… enhance our lead acquisition,
 * enrichment and listing providing."
 *
 * THREE DISTINCT CAPABILITIES, never merged (owner's standing rule):
 *
 *  1. ACTIVE-LISTING DISCOVERY — `runActiveListingDiscoveryForMarket`. WAVE 92
 *     (lane 92B): now a RENTCAST sweep (owner 2026-10-01: "use rentcast as much as
 *     possible regarding property listings" · "batchdata is to be used more for
 *     scrapping leads") — see the function's header. Was: polls
 *     BatchData's `on-market` quickList per territory into a NEW listings feed
 *     table (`market_active_listings`, m636 — no existing table fit: `listings`
 *     is the TENANT's own inventory, `market_data`/`market_trends` are
 *     aggregate stats, not per-property rows). Detects STATUS TRANSITIONS
 *     against the feed's own memory and, only when a transitioned address
 *     matches a lead/contact this brokerage already has on file, files a
 *     `motivated_seller_signals` row through the SAME builder
 *     (buildBatchDataSignalRow) lib/external/batchdata-seller-signals.ts
 *     already owns — never a second signal-row writer.
 *
 *  2. INCREMENTAL PROPERTY SEARCH — `runIncrementalPropertySearchForMarket`.
 *     Cursor-paginated, Search-Session-scoped pulls so a daily tick asks for
 *     ONLY NEW matches instead of re-walking a whole result set. OPT-IN per
 *     market (`enabled_sources` must name `batchdata_incremental`) so it never
 *     silently doubles the EXISTING polled motivated-seller pull the cron
 *     already runs — a tenant switches a market onto this lane deliberately.
 *
 *  3. BUY BOX MATCHING — `runBuyBoxMatchingForMarket`. For each of the
 *     brokerage's own ACTIVE listings, asks BatchData's investor Buy Box tool
 *     who is likely to buy it, and files each match as a raw BUYER lead
 *     through the ONE ingest door, `lib/kernel/scraping.ts::ingestRawSourceBatch`.
 *
 * Every person-shaped record this file produces goes through
 * `ingestRawSourceBatch` — no second raw-insert implementation, per this lane's
 * charter.
 */

import { bestEffort } from "@/lib/db/best-effort"
import type { SupabaseClient } from "@supabase/supabase-js"
import { ingestRawSourceBatch } from "@/lib/kernel/scraping"
import { isViableRecord } from "@/lib/lead-pipeline/raw-record-types"
import { normalizeStreetAddress } from "@/lib/external/permit-signals"
import { RENTCAST_MAX_LISTINGS_PER_REQUEST } from "@/lib/property/rentcast-query"
import {
  fetchIncrementalPropertySearch,
  normalizeBuyBoxInvestorRecord,
  type BatchDataInvestorMatch,
  type BatchDataRecord,
} from "@/lib/external/batchdata-client"
import { investorBuyboxPage, investorBuyboxCount } from "@/lib/external/batchdata-mcp"
import {
  ACTIVE_LISTING_SIGNAL_TYPE,
  EXPIRED_LISTING_SIGNAL_TYPE,
  SOLD_LISTING_SIGNAL_TYPE,
  PRICE_REDUCED_SIGNAL_TYPE,
  buildBatchDataSignalRow,
  type SignalEntityKind,
  type DerivedSellerSignal,
} from "@/lib/external/batchdata-seller-signals"
import { meterVendorSpend } from "@/lib/vendor-governance/meter-vendor"
import { bookSourceSpend } from "@/lib/lead-pipeline/source-cost-ledger"

/** Buy Box has no independently-confirmed per-call price; metered at the comps-pull rate (one
 *  address lookup against a named MCP tool) so the spend is VISIBLE rather than unmetered. */
const BUYBOX_MATCH_COST_USD = 0.05
// Wave 68 — cost gate: this pull bills per RECORD (docs/lead-acquisition-coverage-2026-09.md),
// so it only runs for a brokerage whose resolved order names "batchdata_on_market" (default
// excludes it — see lib/buyer-search/listing-source-order.ts, the SAME resolver market-watch.ts
// consults before reading the feed this function writes).
import { resolveActiveListingSources } from "@/lib/buyer-search/listing-source-order"

// Minimal market shape every caller here already has from
// lib/lead-pipeline/scrape-territories.ts's resolver — no separate DB read.
export interface FeedMarket {
  id: string
  brokerage_id: string
  name: string
  city: string
  state: string
  zip_codes: string[] | null
}

// TOMBSTONE (wave 92, lane 92B, §1.3): statusFromQuickLists (BatchData on-market quickList →
// status bucket) left with the BatchData discovery pull — survivor: the RentCast listing STATUS
// ("Active" / "Inactive" + removedDate) read inside runActiveListingDiscoveryForMarket below.

/** Lane 88G — a list-price drop smaller than this is rounding / a relist artefact, not a price cut. */
const PRICE_CUT_MIN_FRACTION = 0.01

/**
 * Lane 88G — PURE. Did an address that stayed ACTIVE drop its LIST price since the last pass?
 * Both prices must be real positive numbers; an unknown previous price is never a cut.
 */
export function detectPriceCut(params: {
  previousStatus: string | null
  status: string
  previousPrice: number | null | undefined
  price: number | null | undefined
  /** The provider's own listing.maxListPrice — when present it must CORROBORATE the cut (a stored
   *  previous price that was the AVM fallback must never read as a reduction). */
  maxListPrice?: number | null
}): { cut: boolean; fraction: number } {
  const prev = Number(params.previousPrice), next = Number(params.price)
  if (params.previousStatus !== "active" || params.status !== "active") return { cut: false, fraction: 0 }
  if (params.previousPrice == null || params.price == null) return { cut: false, fraction: 0 }
  if (!Number.isFinite(prev) || !Number.isFinite(next) || prev <= 0 || next <= 0) return { cut: false, fraction: 0 }
  if (typeof params.maxListPrice === "number" && params.maxListPrice <= next) return { cut: false, fraction: 0 }
  const fraction = (prev - next) / prev
  return { cut: fraction >= PRICE_CUT_MIN_FRACTION, fraction: Math.round(fraction * 1000) / 1000 }
}

// TOMBSTONE (wave 92, lane 92B): STATUS_SIGNAL_TYPE (quickList bucket → signal type) left with
// the BatchData quickList statuses; the RentCast sweep picks its signal type inline (active /
// sold / left-unsold) in runActiveListingDiscoveryForMarket.

/** Wave 92 (lane 92B) — a market feed refreshed within this many hours is not re-swept ("checking
 *  … before scrapping and pulling data will cutdown on runs"): the lead-scraping tick runs several
 *  times a day; a territory's inventory picture is a DAILY fact. */
const ACTIVE_FEED_MIN_INTERVAL_HOURS = 20

/** Wave 92 — an INACTIVE RentCast listing is a transition only when it left the market inside this
 *  window (its own removedDate). Older removals are history, not news. Listing STATUS CHANGES are
 *  where a recency window belongs (owner: "pulling recent data should be only on where it is
 *  appropriate"). */
const OFF_MARKET_TRANSITION_WINDOW_DAYS = 30

/**
 * ACTIVE-LISTING DISCOVERY — one territory per call. Best-effort throughout:
 * a read/write failure on one property never aborts the rest of the pull, and
 * the caller (the lead-scraping cron, after the active-territory gate) treats this
 * as a side-channel exactly like the Smart Search reconcile beside it.
 *
 * WAVE 92 (lane 92B) — RENTCAST, NOT BATCHDATA. TOMBSTONE (§1.3): the BatchData
 * `on-market` quickList pull (fetchIncrementalPropertySearch, billed PER RECORD on every
 * re-walk — "20x-100x RentCast's per-request cost for the same coverage", this file's own
 * wave-68 note) is deleted. Survivor: TWO RentCast /listings/sale requests per territory per
 * day — status "Active" (up to RENTCAST_MAX_LISTINGS_PER_REQUEST rows) and status "Inactive"
 * (its removedDate is the off-market date). Same feed table, same upsert key, same price-cut
 * rule, same signal builder. Status vocabulary: RentCast says only Active / Inactive and cannot
 * tell expired from withdrawn from sold, so an off-market row is stored as `off_market`
 * (supabase/migrations/m680 widens the CHECK — until it is applied those rows are refused and
 * reported ONCE per run) and a SIGNAL is filed only for an address this brokerage already holds,
 * after ONE cached RentCast property-record read decides sold (lastSaleDate on/after the
 * removal) vs left-unsold. The stored opt-in spelling `batchdata_on_market` still gates this
 * feed (platform-staff written; renaming it is a migration needing a ruling — the same
 * historical-spelling note as BATCHDATA_BILLED_PULL_OPT_IN).
 */
export async function runActiveListingDiscoveryForMarket(
  supabase: SupabaseClient,
  market: FeedMarket,
): Promise<{ observed: number; transitions: number; signalsWritten: number; errors: string[]; skippedRecent?: boolean }> {
  const errors: string[] = []
  let signalsWritten = 0
  let transitions = 0
  // OPT-IN GATE (platform-staff, m642/m643) — unchanged: no opt-in → no feed and no spend.
  const sources = await resolveActiveListingSources(market.brokerage_id)
  if (!sources.includes("batchdata_on_market")) {
    return { observed: 0, transitions: 0, signalsWritten: 0, errors: [] }
  }

  // CADENCE GATE — one sweep per territory per day.
  const { data: lastRow, error: lastErr } = await supabase
    .from("market_active_listings")
    .select("last_seen_at")
    .eq("market_id", market.id)
    .order("last_seen_at", { ascending: false })
    .limit(1)
  if (lastErr) errors.push(`feed cadence read refused for ${market.name} (sweeping anyway): ${lastErr.message}`)
  const lastSeen = Date.parse(String((lastRow ?? [])[0]?.last_seen_at ?? ""))
  if (Number.isFinite(lastSeen) && Date.now() - lastSeen < ACTIVE_FEED_MIN_INTERVAL_HOURS * 3_600_000) {
    return { observed: 0, transitions: 0, signalsWritten: 0, errors, skippedRecent: true }
  }

  const { searchRentcastSaleListings, getRentcastPropertyRecordFacts } = await loadRentcast()
  const area = { city: market.city, state: market.state, limit: RENTCAST_MAX_LISTINGS_PER_REQUEST }
  const caller = { brokerageId: market.brokerage_id, systemSource: "active_listing_discovery", marketSweep: true as const }
  const active = await searchRentcastSaleListings({ ...caller, filters: { ...area, status: "Active" } })
  if (!active.success) {
    errors.push(`active-listing sweep failed for ${market.name}: ${active.error ?? "no reason reported"}`)
    return { observed: 0, transitions: 0, signalsWritten: 0, errors }
  }
  const inactive = await searchRentcastSaleListings({ ...caller, filters: { ...area, status: "Inactive" } })
  if (!inactive.success) errors.push(`off-market sweep failed for ${market.name} (active rows still recorded): ${inactive.error ?? "no reason reported"}`)
  const removedFloor = Date.now() - OFF_MARKET_TRANSITION_WINDOW_DAYS * 86_400_000
  const rows: Array<{ l: (typeof active.listings)[number]; status: "active" | "off_market" }> = [
    ...active.listings.map((l) => ({ l, status: "active" as const })),
    ...(inactive.success ? inactive.listings : [])
      .filter((l) => { const t = Date.parse(String(l.removedDate ?? "")); return Number.isFinite(t) && t >= removedFloor })
      .map((l) => ({ l, status: "off_market" as const })),
  ]
  let offMarketRefusedByCheck = false

  for (const { l, status } of rows) {
    const addressRaw = l.address
    if (!addressRaw) continue
    const addressKey = normalizeStreetAddress(addressRaw)
    if (!addressKey) continue

    // ── read the feed row and detect a transition ─────────────────────────
    const { data: existing, error: readErr } = await supabase
      .from("market_active_listings")
      .select("id, current_status, list_price")
      .eq("market_id", market.id)
      .eq("address_key", addressKey)
      .maybeSingle()
    if (readErr) {
      errors.push(`feed read failed for ${addressRaw}: ${readErr.message}`)
      continue
    }
    const previousStatus = existing?.current_status ?? null
    // An off-market row is NEWS only for an address this feed last saw ACTIVE; a first-seen
    // inactive row is history and is not stored (no write, no signal).
    if (status === "off_market" && previousStatus !== "active") continue
    if (status === "off_market" && offMarketRefusedByCheck) continue
    const isTransition = previousStatus !== null && previousStatus !== status
    const isFirstSeen = previousStatus === null
    const priceCut = detectPriceCut({
      previousStatus, status,
      previousPrice: (existing as { list_price?: number | null } | null)?.list_price ?? null,
      price: l.price ?? null,
    })

    const { error: upsertErr } = await supabase
      .from("market_active_listings")
      .upsert(
        {
          market_id: market.id,
          brokerage_id: market.brokerage_id,
          address_key: addressKey,
          property_address: addressRaw,
          city: l.city ?? market.city,
          state: l.state ?? market.state,
          zip: l.zip ?? null,
          current_status: status,
          list_price: l.price ?? null,
          // m639 — criteria-fit specs (beds/baths/sqft/property_type), nullable: honest when the
          // listing row omits them, never a fabricated 0/null-string default.
          beds: l.bedrooms ?? null,
          baths: l.bathrooms ?? null,
          sqft: l.squareFeet ?? null,
          property_type: l.propertyType ?? null,
          // Historical column (BatchData quickLists) — a RentCast row carries none.
          batchdata_quicklists: [],
          last_seen_at: new Date().toISOString(),
          ...(isTransition || isFirstSeen ? { last_status_change_at: new Date().toISOString() } : {}),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "market_id,address_key" },
      )
    if (upsertErr) {
      if (status === "off_market" && (upsertErr as { code?: string }).code === "23514") {
        // The live current_status CHECK refused 'off_market' (m680 admits it) — a drifted
        // schema, not a row defect. Said ONCE, then skipped; active rows are unaffected.
        offMarketRefusedByCheck = true
        errors.push(`off_market feed rows refused by the current_status CHECK for ${market.name} — the live CHECK must admit it (m680) — active rows unaffected`)
        continue
      }
      errors.push(`feed write failed for ${addressRaw}: ${upsertErr.message}`)
      continue
    }

    // Only a genuine TRANSITION (not "first time we've ever seen this address")
    // is signal-worthy — a feed's first pass over a territory would otherwise
    // file a signal for every already-active listing it happens to discover.
    // Lane 88G — a PRICE CUT on a still-active listing is the second signal-worthy change (a watch
    // fact: attach-only, weak — the home is still represented, NAR Code of Ethics Article 16).
    if (!isTransition && !priceCut.cut) continue
    if (isTransition) transitions++

    const matched = await findLeadOrContactByAddress(supabase, market.brokerage_id, addressKey)
    if (!matched) continue

    let signal: DerivedSellerSignal
    if (isTransition && status === "off_market") {
      // SOLD vs LEFT UNSOLD — RentCast's listing row cannot say, its property RECORD can: a last
      // sale on/after the removal date is a sale. ONE request, only for an address this brokerage
      // already holds, cached 30 days by the RentCast client.
      const record = await getRentcastPropertyRecordFacts({ brokerageId: market.brokerage_id, systemSource: "active_listing_discovery", address: addressRaw })
      const removedAt = Date.parse(String(l.removedDate ?? ""))
      const soldAt = Date.parse(String(record?.lastSaleDate ?? ""))
      const sold = Number.isFinite(removedAt) && Number.isFinite(soldAt) && soldAt >= removedAt - 7 * 86_400_000
      signal = {
        signalType: sold ? SOLD_LISTING_SIGNAL_TYPE : EXPIRED_LISTING_SIGNAL_TYPE,
        strength: sold ? "weak" : "moderate",
        variant: `t:${previousStatus}->${sold ? "sold" : "off_market"}`,
        reason: sold
          ? "Active-listing monitor observed this address leave the market and the property record shows a sale on/after the removal"
          : "Active-listing monitor observed this address leave the market UNSOLD (RentCast cannot tell an expired listing from a withdrawn one)",
        observed: { previous_status: previousStatus, new_status: "off_market", removed_date: l.removedDate ?? null, last_sale_date: record?.lastSaleDate ?? null },
      }
    } else if (isTransition) {
      signal = {
        signalType: ACTIVE_LISTING_SIGNAL_TYPE,
        strength: "weak",
        variant: `t:${previousStatus}->${status}`,
        reason: `Active-listing monitor observed this address's MLS status change from ${previousStatus} to ${status}`,
        observed: { previous_status: previousStatus, new_status: status, listed_date: l.listedDate ?? null },
      }
    } else {
      signal = {
        signalType: PRICE_REDUCED_SIGNAL_TYPE,
        strength: "weak",
        variant: `p:${(existing as { list_price?: number | null } | null)?.list_price ?? "?"}->${l.price ?? "?"}`,
        reason: "Active-listing monitor observed this still-listed address's list price drop since the last pass",
        observed: {
          previous_list_price: (existing as { list_price?: number | null } | null)?.list_price ?? null,
          list_price: l.price ?? null,
          days_on_market: l.daysOnMarket ?? null,
          cut_fraction: priceCut.fraction,
        },
      }
    }
    const row = buildBatchDataSignalRow({
      signal,
      entity: matched.entity,
      entityId: matched.id,
      brokerageId: matched.brokerageId,
      leadAddressKey: addressKey,
      providerAddress: addressRaw,
    })
    const { error: signalErr } = await supabase.from("motivated_seller_signals").insert(row as any)
    if (signalErr) {
      // A duplicate dedupe_key hit is expected and not an error — see m636's
      // widened partial unique index; anything else is worth surfacing.
      if (!/duplicate key value/i.test(signalErr.message)) {
        errors.push(`signal write failed for ${addressRaw}: ${signalErr.message}`)
      }
    } else {
      signalsWritten++
    }
  }

  return { observed: rows.length, transitions, signalsWritten, errors }
}

/** The RentCast readers this feed uses, loaded lazily (the client is gated + metered itself). The
 *  property RECORD's last-sale date is read through the full staff record (an internal signal
 *  decision, never shown to a customer). */
async function loadRentcast() {
  const rc = await import("@/lib/property/rentcast")
  return {
    searchRentcastSaleListings: rc.searchRentcastSaleListings,
    getRentcastPropertyRecordFacts: rc.getRentcastPropertyDetail,
  }
}

/** PURE-ish (one read). Address-keyed lookup against the brokerage's OWN leads
 *  and contacts — never a market-wide fuzzy match, for the same reason
 *  lib/external/batchdata-seller-signals.ts's own header gives: the query IS
 *  the address, and an inexact match would attach one property's transition to
 *  a different person's record. Contacts are checked first — a converted lead
 *  is the survivor per lib/contact-promotion/conversion-finality.ts's ruling,
 *  and a contact is more likely to still be an active relationship. */
async function findLeadOrContactByAddress(
  supabase: SupabaseClient,
  brokerageId: string,
  addressKey: string,
): Promise<{ entity: SignalEntityKind; id: string; brokerageId: string } | null> {
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, brokerage_id, mailing_address, address")
    .eq("brokerage_id", brokerageId)
    .limit(200)
  for (const c of (contact ?? []) as any[]) {
    if (normalizeStreetAddress(c.mailing_address) === addressKey || normalizeStreetAddress(c.address) === addressKey) {
      return { entity: "contact", id: c.id, brokerageId: c.brokerage_id }
    }
  }
  const { data: lead } = await supabase
    .from("leads")
    .select("id, brokerage_id, mailing_address, address")
    .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
    .limit(200)
  for (const l of (lead ?? []) as any[]) {
    if (normalizeStreetAddress(l.mailing_address) === addressKey || normalizeStreetAddress(l.address) === addressKey) {
      return { entity: "lead", id: l.id, brokerageId: l.brokerage_id ?? brokerageId }
    }
  }
  return null
}

// ─── INCREMENTAL PROPERTY SEARCH — cursor + Search Session, OPT-IN per market ─────────
export async function runIncrementalPropertySearchForMarket(
  supabase: SupabaseClient,
  market: FeedMarket,
  params: { quicklist: string; lane: string },
): Promise<{ inserted: number; sessionUnsupported: boolean; errors: string[] }> {
  const errors: string[] = []
  const { data: state } = await supabase
    .from("batchdata_incremental_search_state")
    .select("page_cursor, session_supported")
    .eq("market_id", market.id)
    .eq("lane", params.lane)
    .maybeSingle()

  const sessionSupported = state?.session_supported !== false
  const searchSession = sessionSupported ? `${market.id}-${params.lane}` : null

  const pull = await fetchIncrementalPropertySearch({
    quicklist: params.quicklist,
    city: market.city,
    state: market.state,
    pageCursor: state?.page_cursor ?? null,
    searchSession,
    take: 100,
  })

  if (!pull.ok) {
    if (pull.sessionUnsupported) {
      // Token lacks `property-search-sessions` — record the downgrade and retry
      // once WITHOUT a session, so this run still produces the plain skip/take
      // page rather than coming back empty.
      await bestEffort(supabase.from("batchdata_incremental_search_state").upsert(
        { market_id: market.id, lane: params.lane, session_supported: false, last_error: pull.error, updated_at: new Date().toISOString() },
        { onConflict: "market_id,lane" },
      ), "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent")
      const fallback = await fetchIncrementalPropertySearch({
        quicklist: params.quicklist, city: market.city, state: market.state, take: 100,
      })
      if (!fallback.ok) {
        errors.push(`incremental search fallback failed for ${market.name}/${params.lane}: ${fallback.error}`)
        return { inserted: 0, sessionUnsupported: true, errors }
      }
      return ingestIncrementalRecords(supabase, market, params.lane, fallback, null, errors)
    }
    errors.push(`incremental search failed for ${market.name}/${params.lane}: ${pull.error}`)
    return { inserted: 0, sessionUnsupported: false, errors }
  }

  return ingestIncrementalRecords(supabase, market, params.lane, pull, pull.nextPageCursor, errors)
}

async function ingestIncrementalRecords(
  supabase: SupabaseClient,
  market: FeedMarket,
  lane: string,
  pull: { records: BatchDataRecord[]; resultsFound: number | null; cost: number },
  nextPageCursor: string | null,
  errors: string[],
): Promise<{ inserted: number; sessionUnsupported: boolean; errors: string[] }> {
  await meterVendorSpend({
    vendorName: "batchdata", usageType: "incremental_property_search", cost: pull.cost,
    brokerageId: market.brokerage_id, metadata: { market_id: market.id, lane },
  })
  await bestEffort(supabase.from("batchdata_incremental_search_state").upsert(
    {
      market_id: market.id, lane,
      page_cursor: nextPageCursor, results_found: pull.resultsFound,
      last_error: null, last_run_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
    { onConflict: "market_id,lane" },
  ), "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent")

  const records = pull.records
    .map((r) => ({
      sourceRecordId: `batchdata-incr-${lane}-${(r.propertyAddress ?? r.address ?? "").toString().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      source: "batchdata_incremental", behaviorType: "motivated_seller", intentType: "seller" as const,
      intentSignals: [lane],
      firstName: r.firstName || null, lastName: r.lastName || null,
      email: r.email ?? null, phone: r.phone ?? null,
      city: r.city ?? market.city, state: r.state ?? market.state, zip: r.zip ?? null,
      mailingAddress: r.address ?? null, propertyAddress: r.propertyAddress ?? null,
      motivationScore: r.motivationConfidence ?? null, sourceUrl: null,
      rawPayload: r as unknown as Record<string, unknown>,
    }))
    .filter(isViableRecord)

  if (records.length === 0) return { inserted: 0, sessionUnsupported: false, errors }
  const res = await ingestRawSourceBatch({
    brokerageId: null,
    marketId: market.id,
    source: "batchdata_incremental",
    sourceFamily: "motivated_seller",
    sourceChannel: "batchdata_incremental",
    sourceSubtype: lane,
    records,
    executionId: null,
    marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
    // Lane 82B — the metered pull cost reaches cost_per_record (was null → $0 per lead).
    batchCostUsd: pull.cost,
  })
  return { inserted: res.inserted, sessionUnsupported: false, errors }
}

// ─── BUY BOX MATCHING — per active tenant listing ─────────────────────────────────────
export async function runBuyBoxMatchingForMarket(
  supabase: SupabaseClient,
  market: FeedMarket,
): Promise<{ listingsChecked: number; investorLeadsCreated: number; errors: string[] }> {
  const errors: string[] = []
  const { data: activeListings, error: listErr } = await supabase
    .from("listings")
    .select("id, address, city, state, zip")
    .eq("brokerage_id", market.brokerage_id)
    .eq("status", "active")
    .limit(25) // bounded per tick — a large book is walked across several days rather than one call spike
  if (listErr) {
    errors.push(`buy-box listing read failed for ${market.name}: ${listErr.message}`)
    return { listingsChecked: 0, investorLeadsCreated: 0, errors }
  }

  let investorLeadsCreated = 0
  for (const listing of (activeListings ?? []) as Array<{ id: string; address: string; city: string; state: string; zip: string }> ) {
    // ── COUNT PRE-FLIGHT (wave 69 owner ruling: "scraping is not frozen so those six
    // scraping frozen orphan exports should not be blocked" + cost-down posture) ──────────
    // investor_buybox_count is the same MCP call as the page pull below, minus the actual
    // match rows — ask it FIRST whether this listing has ANY investor matches before paying
    // for the billed take:10 page pull. A confirmed zero skips the pull for THIS listing
    // (cost savings across a book of listings that mostly have none); anything else (a real
    // count, "unconfigured", or a provider error) falls through to the page pull unchanged —
    // the pre-flight only ever SKIPS a pull, it never blocks one it can't be sure about.
    const preflight = await investorBuyboxCount({ address: listing.address, city: listing.city, state: listing.state, zip: listing.zip })
    if (preflight.ok && preflight.count === 0) continue // nothing to page — no cost, no error

    const match = await investorBuyboxPage({ address: listing.address, city: listing.city, state: listing.state, zip: listing.zip, take: 10 })
    if (match.unconfigured) {
      errors.push("BatchData MCP not configured (BATCHDATA_MCP_URL) — Buy Box has no REST fallback, skipping")
      break
    }
    if (!match.ok) {
      errors.push(`Buy Box match failed for listing ${listing.id}: ${match.error}`)
      continue
    }
    const matchedAddress = `${listing.address}, ${listing.city}, ${listing.state}`
    const records = match.rows
      .map((r) => normalizeBuyBoxInvestorRecord(r as BatchDataInvestorMatch & Record<string, any>, matchedAddress))
      .filter(isViableRecord)
    if (records.length === 0) continue

    const res = await ingestRawSourceBatch({
      brokerageId: market.brokerage_id, // derived from the BROKERAGE'S OWN active listing — an explicit, brokerage-owned scrape, not the platform pool
      marketId: market.id,
      source: "batchdata_buybox",
      sourceFamily: "investor_demand",
      sourceChannel: "batchdata_buybox",
      records,
      executionId: null,
      marketGeo: { city: market.city, state: market.state, zip_codes: market.zip_codes },
      batchCostUsd: BUYBOX_MATCH_COST_USD, // lane 82B — the metered match cost reaches cost_per_record
    })
    investorLeadsCreated += res.inserted
    // Buy Box has no independently-confirmed per-call price; metered at the same
    // conservative rate as the comps dataset pull (both are one address lookup
    // against a named MCP tool) so the spend is at least VISIBLE in the ledger
    // rather than silently unmetered.
    // Lane 82B — booked PER SOURCE (usage_type 'batchdata_buybox', vendor from SOURCE_VENDOR) so the
    // lead-cost reconcile (source-cost-ledger.ts::leadCostBySource) can see it.
    await bookSourceSpend({
      source: "batchdata_buybox", cost: BUYBOX_MATCH_COST_USD,
      brokerageId: market.brokerage_id, marketId: market.id,
    })
  }

  return { listingsChecked: (activeListings ?? []).length, investorLeadsCreated, errors }
}
