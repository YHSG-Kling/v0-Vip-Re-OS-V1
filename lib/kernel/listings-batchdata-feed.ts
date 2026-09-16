/**
 * lib/kernel/listings-batchdata-feed.ts
 *
 * Wave 66. Owner ruling (verbatim): "Batchdata also allows you to find properties
 * that are active and other new features… enhance our lead acquisition,
 * enrichment and listing providing."
 *
 * THREE DISTINCT CAPABILITIES, never merged (owner's standing rule):
 *
 *  1. ACTIVE-LISTING DISCOVERY — `runActiveListingDiscoveryForMarket`. Polls
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

import type { SupabaseClient } from "@supabase/supabase-js"
import { ingestRawSourceBatch } from "@/lib/kernel/scraping"
import { isViableRecord } from "@/lib/lead-pipeline/raw-record-types"
import { normalizeStreetAddress } from "@/lib/external/permit-signals"
import {
  fetchIncrementalPropertySearch,
  normalizeBuyBoxInvestorRecord,
  type BatchDataInvestorMatch,
  type BatchDataRecord,
} from "@/lib/external/batchdata-client"
import { investorBuyboxPage } from "@/lib/external/batchdata-mcp"
import {
  ACTIVE_LISTING_SIGNAL_TYPE,
  EXPIRED_LISTING_SIGNAL_TYPE,
  WITHDRAWN_LISTING_SIGNAL_TYPE,
  SOLD_LISTING_SIGNAL_TYPE,
  buildBatchDataSignalRow,
  type SignalEntityKind,
  type DerivedSellerSignal,
} from "@/lib/external/batchdata-seller-signals"
import { meterVendorSpend } from "@/lib/vendor-governance/meter-vendor"
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

// ─── quickList → our own status bucket ────────────────────────────────────────
/** PURE. Reads the property's on-market bucket off the quickLists BatchData
 *  returned, most-specific first (a property can carry more than one). */
function statusFromQuickLists(quickLists: readonly string[] | undefined): "active" | "expired" | "withdrawn" | "sold" | "unknown" {
  const ql = new Set((quickLists ?? []).map((q) => q.toLowerCase()))
  if (ql.has("expired-listing")) return "expired"
  if (ql.has("canceled-listing") || ql.has("failed-listing")) return "withdrawn"
  if (ql.has("recently-sold")) return "sold"
  if (ql.has("on-market") || ql.has("active-listing") || ql.has("pending-listing")) return "active"
  return "unknown"
}

const STATUS_SIGNAL_TYPE: Record<"active" | "expired" | "withdrawn" | "sold", string> = {
  active: ACTIVE_LISTING_SIGNAL_TYPE,
  expired: EXPIRED_LISTING_SIGNAL_TYPE,
  withdrawn: WITHDRAWN_LISTING_SIGNAL_TYPE,
  sold: SOLD_LISTING_SIGNAL_TYPE,
}

/**
 * ACTIVE-LISTING DISCOVERY — one territory per call. Best-effort throughout:
 * a read/write failure on one property never aborts the rest of the pull, and
 * the caller (the BatchData branch of the lead-scraping cron) treats this as a
 * side-channel exactly like the Smart Search reconcile beside it.
 */
export async function runActiveListingDiscoveryForMarket(
  supabase: SupabaseClient,
  market: FeedMarket,
): Promise<{ observed: number; transitions: number; signalsWritten: number; errors: string[] }> {
  const errors: string[] = []
  let signalsWritten = 0
  let transitions = 0

  // COST GATE (wave 68, owner: "that is a lot of money to spend for leads…" — RESEARCHED: this
  // pull bills per RECORD and must re-walk the whole active set every cycle to detect status
  // transitions, 20x-100x RentCast's per-request cost for the same coverage). Skip the billed
  // pull entirely when this brokerage's order excludes "batchdata_on_market" (the m642 default).
  const sources = await resolveActiveListingSources(market.brokerage_id)
  if (!sources.includes("batchdata_on_market")) {
    return { observed: 0, transitions: 0, signalsWritten: 0, errors: [] }
  }

  const pull = await fetchIncrementalPropertySearch({
    quicklist: "on-market",
    city: market.city,
    state: market.state,
    searchSession: `feed-${market.id}-onmarket`,
    take: 100,
  })
  if (!pull.ok) {
    errors.push(`active-listing pull failed for ${market.name}: ${pull.error}`)
    return { observed: 0, transitions: 0, signalsWritten: 0, errors }
  }
  await meterVendorSpend({
    vendorName: "batchdata", usageType: "active_listing_discovery", cost: pull.cost,
    brokerageId: market.brokerage_id, metadata: { market_id: market.id },
  })

  for (const record of pull.records) {
    const addressRaw = record.propertyAddress || record.address
    if (!addressRaw) continue
    const addressKey = normalizeStreetAddress(addressRaw)
    if (!addressKey) continue
    const status = statusFromQuickLists(record.quickLists)
    if (status === "unknown") continue

    // ── upsert the feed row and detect a transition ─────────────────────────
    const { data: existing, error: readErr } = await supabase
      .from("market_active_listings")
      .select("id, current_status")
      .eq("market_id", market.id)
      .eq("address_key", addressKey)
      .maybeSingle()
    if (readErr) {
      errors.push(`feed read failed for ${addressRaw}: ${readErr.message}`)
      continue
    }
    const previousStatus = existing?.current_status ?? null
    const isTransition = previousStatus !== null && previousStatus !== status
    const isFirstSeen = previousStatus === null

    const { error: upsertErr } = await supabase
      .from("market_active_listings")
      .upsert(
        {
          market_id: market.id,
          brokerage_id: market.brokerage_id,
          address_key: addressKey,
          property_address: addressRaw,
          city: record.propertyCity ?? record.city ?? market.city,
          state: record.propertyState ?? record.state ?? market.state,
          zip: record.propertyZip ?? record.zip ?? null,
          current_status: status,
          list_price: record.estimatedValue ?? null,
          // m639 — criteria-fit specs (beds/baths/sqft/property_type), nullable: honest when a
          // pull's building sub-object is absent, never a fabricated 0/null-string default.
          beds: record.beds ?? null,
          baths: record.baths ?? null,
          sqft: record.sqft ?? null,
          property_type: record.propertyType ?? null,
          batchdata_quicklists: record.quickLists ?? [],
          last_seen_at: new Date().toISOString(),
          ...(isTransition || isFirstSeen ? { last_status_change_at: new Date().toISOString() } : {}),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "market_id,address_key" },
      )
    if (upsertErr) {
      errors.push(`feed write failed for ${addressRaw}: ${upsertErr.message}`)
      continue
    }

    // Only a genuine TRANSITION (not "first time we've ever seen this address")
    // is signal-worthy — a feed's first pass over a territory would otherwise
    // file a signal for every already-active listing it happens to discover.
    if (!isTransition) continue
    transitions++

    const matched = await findLeadOrContactByAddress(supabase, market.brokerage_id, addressKey)
    if (!matched) continue

    const signal: DerivedSellerSignal = {
      signalType: STATUS_SIGNAL_TYPE[status],
      strength: status === "expired" || status === "withdrawn" ? "moderate" : "weak",
      variant: `t:${previousStatus}->${status}`,
      reason: `Active-listing monitor observed this address's MLS status change from ${previousStatus} to ${status}`,
      observed: { previous_status: previousStatus, new_status: status, quicklists: record.quickLists ?? [] },
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

  return { observed: pull.records.length, transitions, signalsWritten, errors }
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
      await supabase.from("batchdata_incremental_search_state").upsert(
        { market_id: market.id, lane: params.lane, session_supported: false, last_error: pull.error, updated_at: new Date().toISOString() },
        { onConflict: "market_id,lane" },
      )
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
  await supabase.from("batchdata_incremental_search_state").upsert(
    {
      market_id: market.id, lane,
      page_cursor: nextPageCursor, results_found: pull.resultsFound,
      last_error: null, last_run_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    },
    { onConflict: "market_id,lane" },
  )

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
    })
    investorLeadsCreated += res.inserted
    // Buy Box has no independently-confirmed per-call price; metered at the same
    // conservative rate as the comps dataset pull (both are one address lookup
    // against a named MCP tool) so the spend is at least VISIBLE in the ledger
    // rather than silently unmetered.
    await meterVendorSpend({
      vendorName: "batchdata", usageType: "investor_buybox_match", cost: 0.05,
      brokerageId: market.brokerage_id, metadata: { listing_id: listing.id },
    })
  }

  return { listingsChecked: (activeListings ?? []).length, investorLeadsCreated, errors }
}
