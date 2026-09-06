// Listing-search adapter for the property-alert engine.
//
// ─── WHY THE FILE AND THE EXPORT KEEP THEIR IDX NAMES ───────────────────────
// IDX Broker is still tier 1 here and this is the file the owner named. Both
// names UNDERSTATE what this module now does, and both were deliberately left
// alone rather than fixed blind:
//   · `scripts/orphan-export-guard.ts` treats a renamed export as a DELETED
//     capability unless the new name appears in a file that did not export it at
//     baseline. A pure rename therefore goes RED, and its documented remedy is a
//     deliberate re-baseline — an integrator's decision, not a lane's. The
//     rename was made, measured against that guard, and reverted; it belongs in
//     the same commit that re-baselines.
//   · the PATH is imported by lib/property-alerts/index.ts, alert-engine.ts and
//     app/actions/property-alerts/alert-actions.ts and by nothing else, so
//     moving it is mechanical — but it would need the full guard chain to
//     re-verify, which a parallel lane may not run (CLAUDE.md §7).
// Renaming both is one handoff item. Until then this header, not the filename,
// is the description of the lane.
//
// ─── THE DEFECT THIS FILE CARRIED ───────────────────────────────────────────
// It opened with `IDXBrokerClient.forBrokerage(brokerageId)` and, when that
// client was not configured, returned `error: "not_configured"` with ZERO
// results. IDX Broker is TENANT-SETTABLE (lib/providers/tenancy-matrix.ts:
// `tenant_optional_key`), so for a tenant that never connected one — the
// majority, by construction — every saved search on a CRON sweep produced
// nothing, silently, and the buyer concluded the market was empty. That is the
// worst possible failure on an alert rail: "we could not look" rendered as
// "there is nothing for you".
//
// The showing-route planner had exactly this defect and it was fixed in a prior
// wave (app/actions/ai-predictions.ts optimizeShowingRoute). This is the same
// fix on the alert rail, asked through the SAME two modules so there is no
// second cascade in the tree:
//
//   lib/property/rentcast-eligibility.ts → THE one gate. Has this tenant
//        connected their OWN IDX Broker feed / could we not tell / is the
//        platform RentCast key set / is the vendor budget exhausted — and it
//        NAMES which one said no.
//   lib/property/listing-source.ts       → THE one selector. CONNECTION decides,
//        never a result count.
//
// The tiers are EXCLUSIVE, exactly as lib/property/external-listings-search.ts
// states them: a connected IDX feed that returns nothing for a saved search
// returns nothing. It does not fall through to RentCast, because the owner
// ruling turns on the CONNECTION and not on what the connection returned.
//
// ─── THE PLATFORM IDX FLOOR IS PRESERVED, AND IS NOT A NEW PRECEDENCE ───────
// `IDXBrokerClient.forBrokerage` resolves the ownership cascade and then falls
// back to `process.env.IDXBROKER_API_KEY` — "the platform key is the floor,
// never the ceiling" (tenancy-matrix.ts). So TODAY, a tenant with no IDX
// connection of their own is still served by that floor whenever the env key is
// set, and this fix must not take that away: removing a source that works is the
// same silent zero in a different costume.
//
// It is therefore consulted LAST, only where `resolveListingSource` has already
// answered "none" — i.e. only where the alternative is a refusal. RentCast
// outranks it, which is the owner's ruling verbatim ("we are defaulting the
// platform provider rentcast functionality") and is the same order the showing
// route took. The tier that actually answered rides out on the result as
// `idxCredentialTier` so an operator can tell "their board" from "our floor".
//
// ─── HONESTY CONTRACT ───────────────────────────────────────────────────────
// A refusal is NEVER an empty result set. `refusal` is a machine-readable code
// and `error` is the plain sentence that goes in the delivery log; the engine
// refuses to deliver, and to record a zero, on either. An unreadable IDX check,
// a dark platform key, an exhausted vendor budget and a provider outage are all
// refusals. "No new listings" is reserved for a search that actually ran.
//
// `alertId` NAMES THE SUBJECT OF EVERY DIAGNOSTIC — kept from the prior pass,
// which added it because an operator reading a cron log saw "IDX API error" with
// no way to tell WHICH alert, or which brokerage's credential, produced it.

import { IDXBrokerClient } from "@/lib/idxbroker-client"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveRentcastEligibility } from "@/lib/property/rentcast-eligibility"
import { resolveListingSource, type ListingSource } from "@/lib/property/listing-source"
import { searchRentcastSaleListings, type RentcastListing } from "@/lib/property/rentcast"
import type { AlertProperty, AlertCriteria } from "./alert-matcher"

/**
 * The vendor-ledger lane a RentCast alert sweep spends under.
 *
 * NOT `buyer_search`: a saved-search sweep is a different lane from a buyer
 * typing a search, and RentCast metering used to hard-code `buyer_search` on
 * every reader — the one question the ledger exists to answer had a single
 * possible answer and it was wrong for most calls. The spelling matches the one
 * already in the tree for this lane (lib/property-alerts/alert-notifier.ts:105).
 */
const ALERT_SEARCH_SYSTEM_SOURCE = "property_alert"

/**
 * How many DISTINCT AREAS one alert may ask RentCast about per run.
 *
 * RentCast searches ONE city or ONE ZIP per call and a saved search may name
 * several, so an uncapped sweep multiplies a paid, metered call by the number of
 * areas times the number of alerts. The cap is not a silent truncation: anything
 * over it comes back on `areasNotSearched` and is logged, the same discipline
 * lib/property-alerts/alert-engine.ts already applies to its per-run batch cap.
 */
const RENTCAST_AREAS_PER_ALERT = 3

/** Rows requested per area. The matcher then scores and the engine caps. */
const RENTCAST_LIMIT_PER_AREA = 50

/**
 * The namespace a RentCast row's identity key carries in
 * `property_alert_results.mls_number`.
 *
 * WHY NAMESPACED RATHER THAN THE BARE MLS NUMBER. That column is the identity of
 * an OUTSIDE property for the whole downstream lane: the engine dedups sends on
 * it, and app/actions/property-alerts/alert-actions.ts turns it into the
 * kernel's `ext_<source>_<id>` handle, which decides what
 * `saved_properties.source` records. A bare number there would file every
 * RentCast match as an IDX match — a fresh vocabulary drift (§6) in the one
 * place a buyer's saved property is attributed. RentCast's own `externalId` is
 * stable per listing, so the key is stable across runs, which is what the dedup
 * needs.
 */
export const RENTCAST_ALERT_KEY_PREFIX = "rentcast-"

/** Machine-readable refusal vocabulary. Every value means WE DID NOT LOOK. */
export type AlertSearchRefusal =
  /** The IDX-connection read was refused, so we cannot prove which source may
   *  serve this tenant. Fails closed (never spends RentCast on a maybe). */
  | "source_check_unreadable"
  /** No provider can serve this tenant: no tenant IDX, RentCast ineligible
   *  (dark platform key or exhausted vendor budget), no platform IDX floor. */
  | "no_listing_source"
  /** RentCast is the source but the saved search names no area it can search. */
  | "no_search_area"
  /** The chosen provider was called and every call failed. */
  | "provider_error"

export interface AlertSearchContext {
  /** The tenant. Always from the alert row / session — never from a parameter a
   *  caller supplied (CLAUDE.md §4). */
  brokerageId: string
  /** A USERS.id — the tier an agent's OWN IDX credential is filed under. Never
   *  agents.id, never contacts.id: those spaces are disjoint. */
  agentUserId?: string | null
  /** teams.id, the middle tier of the same ownership cascade. */
  teamId?: string | null
  /** contacts.id, for vendor-ledger attribution ONLY. Not a credential selector
   *  and not a tenant boundary. */
  contactId?: string | null
  /** Two-letter state for a CITY area query — RentCast cannot search a city
   *  without one. Resolved by the caller (see alert-engine.ts) because the
   *  saved-search row carries no state column. */
  state?: string | null
}

export interface AlertListingSearchResult {
  results: AlertProperty[]
  /** Which external source answered. `resolveListingSource`'s own vocabulary —
   *  imported, not re-spelled (§6). */
  source: ListingSource
  /** Present only when `source === "idx"`: whose credential answered. */
  idxCredentialTier?: "tenant" | "platform_floor"
  api_called: boolean
  response_time_ms: number | null
  /** Set = WE DID NOT LOOK. The engine must not record a zero on this. */
  refusal?: AlertSearchRefusal
  /** One plain sentence. On a refusal it says why; on a completed search it is
   *  present only when part of the search degraded. */
  error?: string
  /** Areas a capped RentCast sweep never asked about. Never silently dropped. */
  areasNotSearched?: string[]
}

/** One RentCast-searchable area derived from the saved search. */
interface AlertArea {
  label: string
  city?: string
  state?: string
  zipCode?: string
}

export async function searchIDXForAlert(
  alertId: string,
  criteria: AlertCriteria,
  ctx: AlertSearchContext,
): Promise<AlertListingSearchResult> {
  const startMs = Date.now()
  const brokerageId = ctx.brokerageId

  // ── WHICH SOURCE ANSWERS THIS TENANT ──────────────────────────────────────
  // ONE gate, asked at the FULLEST scope the caller holds (agent → team →
  // brokerage). A gate asked only at brokerage scope cannot see an agent-tier
  // IDX credential and would spend the platform's RentCast against the ruling.
  const eligibility = await resolveRentcastEligibility({
    brokerageId,
    agentUserId: ctx.agentUserId ?? null,
    teamId: ctx.teamId ?? null,
  })

  // FAIL CLOSED. If we could not read whether this tenant owns a feed we may not
  // spend the platform's RentCast on them and we cannot claim their board
  // either. This is a REFUSAL, not an empty market.
  if (eligibility.idx.status === "unreadable") {
    console.warn(
      `[alert-search] alert ${alertId} (brokerage ${brokerageId}) refused — ${eligibility.detail}`,
    )
    return {
      results: [],
      source: "none",
      api_called: false,
      response_time_ms: Date.now() - startMs,
      refusal: "source_check_unreadable",
      error: eligibility.detail,
    }
  }

  let source = resolveListingSource({
    hasIdx: eligibility.idx.status === "connected",
    hasRentcast: eligibility.eligible,
  })
  let idxCredentialTier: "tenant" | "platform_floor" | undefined =
    source === "idx" ? "tenant" : undefined

  // THE PLATFORM IDX FLOOR — consulted only where the answer would otherwise be
  // a refusal (see the header). It is the credential this lane already ran on
  // for every tenant without their own connection, so it stays available; it
  // simply no longer outranks the platform's declared default.
  let idxClient: IDXBrokerClient | null = null
  if (source === "idx" || source === "none") {
    idxClient = await IDXBrokerClient.forBrokerage(brokerageId, {
      agentUserId: ctx.agentUserId ?? null,
      teamId: ctx.teamId ?? null,
    })
    if (source === "none" && idxClient.isConfigured()) {
      source = "idx"
      idxCredentialTier = "platform_floor"
    }
    // A "connected" verdict from the gate means the resolver found an
    // owner-scoped row carrying a non-empty api key, so this cannot normally
    // fire — but a client that cannot authenticate must refuse rather than run
    // an unauthenticated search that returns an empty board.
    if (source === "idx" && !idxClient.isConfigured()) {
      source = "none"
      idxCredentialTier = undefined
    }
  }

  if (source === "none") {
    // The second sentence is derived, not assumed: an IDX credential the gate
    // called CONNECTED but whose client cannot authenticate is a different fact
    // from no credential at all, and an operator reading this line has to be
    // able to act on the right one.
    const idxSentence =
      eligibility.idx.status === "connected"
        ? `An IDX Broker credential is connected at ${eligibility.idx.ownerType} scope but carries no usable API key, so the tenant's own board could not be searched.`
        : "The tenant has not connected an IDX Broker account, and no platform IDX key is configured."
    const detail =
      `No listing source could answer this saved search. ${eligibility.detail} ${idxSentence} Nothing was searched — this is NOT a report that no homes matched.`
    console.warn(`[alert-search] alert ${alertId} (brokerage ${brokerageId}) refused — ${detail}`)
    return {
      results: [],
      source: "none",
      api_called: false,
      response_time_ms: Date.now() - startMs,
      refusal: "no_listing_source",
      error: detail,
    }
  }

  // ── EXTERNAL SOURCE ───────────────────────────────────────────────────────
  let externalResults: AlertProperty[] = []
  let api_called = false
  let areasNotSearched: string[] | undefined
  let degradedNote: string | undefined

  if (source === "idx") {
    const client = idxClient!
    try {
      const raw = await client.searchProperties(buildIDXQuery(criteria))
      api_called = true
      externalResults = normaliseIDXResults(Array.isArray(raw) ? raw : [])
    } catch (err: any) {
      const detail = `The IDX Broker search failed for this saved search: ${err?.message ?? "unknown error"}. Nothing was searched, so no conclusion about the market can be drawn from this run.`
      console.error(
        `[alert-search] IDX API error on alert ${alertId} (brokerage ${brokerageId}):`,
        err?.message,
      )
      return {
        results: [],
        source,
        idxCredentialTier,
        api_called: true,
        response_time_ms: Date.now() - startMs,
        refusal: "provider_error",
        error: detail,
      }
    }
  } else {
    // ── RENTCAST, THE PLATFORM DEFAULT ──────────────────────────────────────
    // The gate, the metering and the budget cap are NOT re-implemented here and
    // are not bypassed: `searchRentcastSaleListings` asks `gateRentcast` itself
    // before any request leaves (lib/property/rentcast.ts) and meters the call
    // through logVendorUsage. What this call site owes the ledger is the truth
    // about WHO spent and WHY — the tenant, the lane, and the contact the sweep
    // ran for — so all three are passed rather than defaulted.
    const areas = buildRentcastAreas(criteria, ctx.state ?? null)
    if (areas.length === 0) {
      const detail =
        "RentCast searches one ZIP, or one city with its state, at a time, and this saved search names neither a ZIP code nor a city we could pair with a state. Nothing was searched — this is not a report that no homes matched. Add a ZIP code or a city to the search."
      console.warn(`[alert-search] alert ${alertId} (brokerage ${brokerageId}) refused — ${detail}`)
      return {
        results: [],
        source,
        api_called: false,
        response_time_ms: Date.now() - startMs,
        refusal: "no_search_area",
        error: detail,
      }
    }

    const searched = areas.slice(0, RENTCAST_AREAS_PER_ALERT)
    const skipped = areas.slice(RENTCAST_AREAS_PER_ALERT)
    if (skipped.length) {
      areasNotSearched = skipped.map((a) => a.label)
      console.warn(
        `[alert-search] alert ${alertId} (brokerage ${brokerageId}): ${areas.length} areas named, searching ${searched.length} (cap ${RENTCAST_AREAS_PER_ALERT}); not searched this run: ${areasNotSearched.join(", ")}`,
      )
    }

    const areaErrors: string[] = []
    const seen = new Set<string>()
    for (const area of searched) {
      const rc = await searchRentcastSaleListings({
        brokerageId,
        agentUserId: ctx.agentUserId ?? null,
        teamId: ctx.teamId ?? null,
        systemSource: ALERT_SEARCH_SYSTEM_SOURCE,
        contactId: ctx.contactId ?? null,
        filters: {
          city: area.city,
          state: area.state,
          zipCode: area.zipCode,
          bedroomsMin: criteria.bedrooms_min ?? undefined,
          bathroomsMin: criteria.bathrooms_min ?? undefined,
          priceMin: criteria.min_price ?? undefined,
          priceMax: criteria.max_price ?? undefined,
          // propertyType is DELIBERATELY NOT PUSHED. RentCast's vocabulary and
          // ours are different spellings of the same idea, and an untranslated
          // canonical value ("single_family") sent as a provider filter returns
          // an empty page that is indistinguishable from "no homes". The matcher
          // scores property type on BOTH sides through canonicalPropertyType
          // (lib/property-alerts/alert-matcher.ts), so the filter is applied
          // here, after the fetch, where the two vocabularies can be reconciled.
          limit: RENTCAST_LIMIT_PER_AREA,
        },
      })
      api_called = true
      // THE ERROR IS READ (§3). A refused gate and a provider outage both
      // resolve here with `success: false` and an empty list; reporting that as
      // "no listing found" is the conflation this whole lane exists to prevent.
      if (!rc.success) {
        areaErrors.push(`${area.label}: ${rc.error ?? "the RentCast lookup did not complete"}`)
        continue
      }
      for (const row of rc.listings) {
        const mapped = rentcastToAlertProperty(row)
        if (!mapped) continue
        if (seen.has(mapped.mls_number)) continue
        seen.add(mapped.mls_number)
        externalResults.push(mapped)
      }
    }

    // EVERY AREA FAILED — we did not look anywhere. A refusal, not an empty
    // market. A PARTIAL failure keeps its results and says what it lost.
    if (areaErrors.length === searched.length) {
      const detail = `RentCast could not be searched for this saved search: ${areaErrors.join("; ")}. Nothing was searched, so no conclusion about the market can be drawn from this run.`
      console.error(`[alert-search] alert ${alertId} (brokerage ${brokerageId}) refused — ${detail}`)
      return {
        results: [],
        source,
        api_called,
        response_time_ms: Date.now() - startMs,
        refusal: "provider_error",
        error: detail,
        areasNotSearched,
      }
    }
    if (areaErrors.length) {
      degradedNote = `partial RentCast search — ${areaErrors.join("; ")}`
    }
  }

  // ── Internal listings query (parallel source, both tiers) ─────────────────
  // Platform-internal inventory is not a vendor and is not gated: it is this
  // brokerage's own board and it is merged under either external source.
  const supabase = createServiceClient()
  const internalQuery = supabase
    .from("listings")
    .select("id, mls_number, address, city, state, zip, list_price, bedrooms, bathrooms, sqft, status, listing_date, brokerage_id")
    .eq("brokerage_id", brokerageId)
    .in("lifecycle_stage", ["MLS_ACTIVE", "COMING_SOON_ACTIVE"])
    .is("deleted_at", null)

  if (criteria.min_price) internalQuery.gte("list_price", criteria.min_price)
  if (criteria.max_price) internalQuery.lte("list_price", criteria.max_price)
  if (criteria.bedrooms_min) internalQuery.gte("bedrooms", criteria.bedrooms_min)
  if (criteria.cities?.length) internalQuery.in("city", criteria.cities)

  // THE ERROR IS READ (§3). This was dropped: a refused read of our OWN board
  // was indistinguishable from a board with nothing on it, on the one rail whose
  // whole job is not to confuse those two.
  const { data: internalListings, error: internalError } = await internalQuery
  if (internalError) {
    console.error(
      `[alert-search] internal listings read refused on alert ${alertId} (brokerage ${brokerageId}):`,
      internalError.message,
    )
    degradedNote = [degradedNote, `the brokerage's own listings could not be read (${internalError.message})`]
      .filter(Boolean)
      .join("; ")
  }

  const internalResults: AlertProperty[] = (internalListings ?? []).map(l => ({
    mls_number: l.mls_number ?? `internal-${l.id}`,
    // A real listings.id — this is what makes an in-house match file as OURS
    // downstream (property_alert_results.listing_id → resultPropertyId).
    listing_id: l.id,
    property_address: l.address,
    city: l.city ?? undefined,
    state: l.state ?? undefined,
    zip: l.zip ?? undefined,
    list_price: l.list_price ? Number(l.list_price) : undefined,
    bedrooms: l.bedrooms ?? undefined,
    bathrooms: l.bathrooms ? Number(l.bathrooms) : undefined,
    sqft: l.sqft ?? undefined,
    property_type: "internal",
    listed_at: l.listing_date ?? undefined,
  }))

  // ── Merge + dedup (internal listing wins) ─────────────────────────────────
  //
  // IDX rows key on the MLS number they share with our own listings, so the map
  // dedups them directly. A RENTCAST row cannot: its key is namespaced (see
  // RENTCAST_ALERT_KEY_PREFIX), and RentCast does not always report an MLS
  // number at all. So the same home appearing on both our board and RentCast is
  // suppressed on NORMALISED ADDRESS instead — otherwise a buyer would be shown
  // one house twice in one email.
  const merged = new Map<string, AlertProperty>()
  const internalAddresses = new Set(
    internalResults.map((r) => normaliseAddress(r.property_address)).filter(Boolean),
  )

  for (const r of externalResults) {
    if (!r.mls_number) continue
    if (r.mls_number.startsWith(RENTCAST_ALERT_KEY_PREFIX)) {
      const addr = normaliseAddress(r.property_address)
      if (addr && internalAddresses.has(addr)) continue
    }
    merged.set(r.mls_number, r)
  }
  // Internal overwrites external on conflict
  for (const r of internalResults) {
    if (r.mls_number) merged.set(r.mls_number, r)
  }

  return {
    results: Array.from(merged.values()),
    source,
    idxCredentialTier,
    api_called,
    response_time_ms: Date.now() - startMs,
    error: degradedNote,
    areasNotSearched,
  }
}

// ─── Area derivation ────────────────────────────────────────────────────────

/**
 * The RentCast-searchable areas a saved search names.
 *
 * ZIP codes are preferred and are self-sufficient. Cities need a state, which
 * `property_alerts` does not carry — the caller resolves one and passes it (see
 * lib/property-alerts/alert-engine.ts). With neither, this returns an empty list
 * and the caller REFUSES rather than issuing an unbounded national sweep whose
 * results would be scored against a saved search that named no location.
 */
function buildRentcastAreas(criteria: AlertCriteria, state: string | null): AlertArea[] {
  const zips = (criteria.zip_codes ?? [])
    .map((z) => String(z ?? "").trim())
    .filter(Boolean)
  if (zips.length) {
    return Array.from(new Set(zips)).map((zipCode) => ({ label: `ZIP ${zipCode}`, zipCode }))
  }

  const cities = (criteria.cities ?? [])
    .map((c) => String(c ?? "").trim())
    .filter(Boolean)
  const st = (state ?? "").trim()
  if (cities.length && st) {
    return Array.from(new Set(cities)).map((city) => ({ label: `${city}, ${st}`, city, state: st }))
  }

  return []
}

/** Suppression key only — never an identity. Case, punctuation and repeated
 *  whitespace are the differences between two spellings of one address. */
function normaliseAddress(address: string | null | undefined): string {
  return String(address ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

// ─── Provider row mappers ───────────────────────────────────────────────────

/**
 * RentCast row → the alert rail's shape.
 *
 * WHAT RENTCAST CANNOT ANSWER, STATED RATHER THAN FAKED:
 *   · `description` — `/listings/sale` carries no public remarks, so the
 *     matcher's 10-point KEYWORD rule cannot score a RentCast row. A saved
 *     search that leans on a keyword scores 10 points lower on this source than
 *     on IDX. Price + city still clears the 40-point bar, so keyword searches
 *     still deliver; they are simply not keyword-FILTERED here.
 *   · `is_price_reduction` / `previous_price` — not on the sale contract, so a
 *     price-reduction alert cannot be RAISED from RentCast. Left undefined
 *     rather than defaulted to false-with-a-price, which would let the matcher
 *     compute a reduction percentage from nothing.
 *   · `listing_url` — RentCast returns no consumer listing page.
 *   · `listed_at` — not exposed by this repo's RentCast mapper.
 * Returns null for a row with no usable identity: an alert result with no stable
 * key cannot be deduped, and a match that re-sends every run is worse than one
 * that is skipped and reported.
 */
function rentcastToAlertProperty(l: RentcastListing): AlertProperty | null {
  const id = String(l.externalId ?? "").trim()
  if (!id) return null
  return {
    mls_number: `${RENTCAST_ALERT_KEY_PREFIX}${id}`,
    property_address: l.address ?? "",
    city: l.city ?? undefined,
    state: l.state ?? undefined,
    zip: l.zip ?? undefined,
    list_price: l.price != null ? Number(l.price) : undefined,
    bedrooms: l.bedrooms != null ? Number(l.bedrooms) : undefined,
    bathrooms: l.bathrooms != null ? Number(l.bathrooms) : undefined,
    sqft: l.squareFeet != null ? Number(l.squareFeet) : undefined,
    property_type: l.propertyType ?? undefined,
    days_on_market: l.daysOnMarket != null ? Number(l.daysOnMarket) : undefined,
    primary_photo_url: l.photoUrl ?? undefined,
  }
}

function buildIDXQuery(criteria: AlertCriteria): string {
  const parts: string[] = []
  if (criteria.cities?.length)      parts.push(criteria.cities.join(" OR "))
  if (criteria.zip_codes?.length)   parts.push(criteria.zip_codes.join(" OR "))
  if (criteria.keywords)            parts.push(criteria.keywords)
  if (criteria.property_types?.length) parts.push(criteria.property_types.join(" OR "))
  return parts.join(" ") || "active listings"
}

function normaliseIDXResults(raw: any[]): AlertProperty[] {
  return raw.map(r => ({
    mls_number:       r.mlsID   ?? r.mls_number   ?? r.id ?? "",
    property_address: r.address ?? r.property_address ?? "",
    city:             r.city    ?? undefined,
    state:            r.state   ?? undefined,
    zip:              r.zip     ?? r.zipCode ?? undefined,
    list_price:       r.listPrice   != null ? Number(r.listPrice)   : undefined,
    bedrooms:         r.bedrooms    != null ? Number(r.bedrooms)    : undefined,
    bathrooms:        r.bathrooms   != null ? Number(r.bathrooms)   : undefined,
    sqft:             r.sqft        != null ? Number(r.sqft)        : undefined,
    property_type:    r.propType    ?? r.property_type ?? undefined,
    days_on_market:   r.daysOnMarket != null ? Number(r.daysOnMarket) : undefined,
    listing_url:      r.listingURL  ?? r.listing_url ?? undefined,
    primary_photo_url: r.image      ?? r.primaryPhoto ?? undefined,
    is_price_reduction: !!r.priceReduction,
    previous_price:   r.previousPrice != null ? Number(r.previousPrice) : undefined,
    description:      r.remarks ?? r.description ?? undefined,
    listed_at:        r.listingDate ?? r.listed_at ?? undefined,
  }))
}
