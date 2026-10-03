/**
 * Rentcast API client — Tier-2 fallback for buyer property search when
 * the brokerage hasn't connected an IDX feed yet.
 *
 * EVERY EXPORTED READER BELOW IS GATED. Owner ruling: "rentcast is platform
 * owned and should not be used if the tenant adds their idx broker
 * credentials." `gateRentcast` (below) asks the ONE eligibility resolver in
 * ./rentcast-eligibility.ts — platform key present? tenant's own IDX Broker
 * connected? vendor budget exhausted? — BEFORE any request is issued and before
 * any caller accrues cost. The gate sits inside these exports rather than at
 * their call sites so that every lane in the tree inherits it, including the
 * ones no wave has touched.
 *
 * Rentcast is a paid data license (~$49/mo, 250 calls). We do NOT persist
 * listing data — only `external_listing_id`, address, and last-seen price
 * are kept (24h TTL). All MLS-licensed display data is re-fetched at view time.
 *
 * WAVE 92 (lane 92B) — RENTCAST IS THE PLATFORM PROPERTY SOURCE. Owner, verbatim
 * (2026-10-01): "use rentcast as much as possible regarding property listings, market,
 * comparable, home values and use any other attributes that are available, also can use it
 * for a simple property lookup. this is supposed to run for the full platform." Three things
 * changed here, and nothing else about the readers' contracts did:
 *   1. The gate is asked PER READ KIND (rentcast-eligibility.ts `readKind`): the tenant-IDX
 *      substitute rule applies only to the ACTIVE for-sale listing SEARCH; every property-data
 *      read (record, AVM + comps, markets, rentals, listing status, inactive sweeps) runs for
 *      every tenant on the ONE platform key. There is no brokerage RentCast key to keep as an
 *      override — lib/connections/scope.ts keeps RentCast out of the user-connectable
 *      providers, so none exists.
 *   2. Property FACTS are cached (record 30 d, AVM/comps 14 d, market stats 7 d — never
 *      listings, whose display data is MLS-licensed and time-sensitive) through
 *      lib/cma/comp-supplement-cache.ts's provider-payload store, so a repeat read of the
 *      same address inside the window costs no request.
 *   3. Every attribute RentCast returns is carried: the full property record
 *      (getRentcastPropertyDetail — features, sale history, owner, assessor ids, zoning),
 *      the listing dates / agent / office / coordinates on every listing row, and the rental
 *      half of /markets. Limits respected: <=500 listings per request (rentcast-query.ts),
 *      20 req/s per key (sweeps are sequential), plan quota via the vendor budget gate.
 *
 * Key endpoints used:
 *   GET /v1/listings/sale?city=X&state=Y&bedrooms=&bathrooms=&maxPrice=&minPrice=
 *   GET /v1/listings/rental/long-term?city=X&state=Y&...
 *   GET /v1/avm/value?address=...
 *   GET /v1/properties?address=...&city=...&state=...
 */

import { createServiceClient } from "@/lib/supabase/service"
import { logVendorUsage } from "@/lib/vendor-governance/usage-logger"
import { buildRentcastListingQuery } from "./rentcast-query"
import {
  callRentcastGet,
  callRentcastGetById,
  type RentcastSaleListingsQuery,
  type RentcastSaleListing as RentcastSaleListingRow,
  type RentcastSaleListingResponse,
  type RentcastRentalListingsQuery,
  type RentcastRentalListing as RentcastRentalListingRow,
  type RentcastAvmValueQuery,
  type RentcastAvmValueResponse,
  type RentcastMarketsQuery,
  type RentcastMarketsResponse,
  type RentcastPropertyRecord,
} from "@/lib/external/rentcast-typed"
import {
  resolveRentcastEligibility,
  type RentcastEligibility,
  type RentcastEligibilityContext,
  type RentcastReadKind,
} from "./rentcast-eligibility"
import {
  normalizeRentcastMarketStats,
  normalizeRentcastRentalMarketStats,
  normalizeRentcastComps,
  type RentcastMarketStats,
  type RentcastComp,
} from "./rentcast-normalize"

export { normalizeRentcastMarketStats, normalizeRentcastComps, type RentcastMarketStats, type RentcastComp }

// TOMBSTONE (2026-08-31): the private untyped `rentcastGet(apiKey, path, URLSearchParams)`
// transport that lived here was a duplicate of the typed façade this module now consumes —
// survivor: `callRentcastGet` at lib/external/rentcast-typed.ts:84 (static paths) and
// `callRentcastGetById` at lib/external/rentcast-typed.ts:123 (`{id}` paths). The façade was
// written FOR these readers ("drop them into the existing lib/property/rentcast.ts callsite
// signatures") and never adopted; the untyped copy is what let a renamed query param or a
// drifted response shape reach production as a 4xx or an empty map instead of a compile error.

/**
 * Fields observed on live RentCast /listings responses that the published OpenAPI spec does not
 * declare (the spec is the source of lib/external/_generated/rentcast-openapi.ts). The row
 * mappers below have always read them defensively (`?? null` / optional chains); typing them
 * here keeps that read legal without casting the whole row back to `any`. If regeneration ever
 * adds these to the spec, delete this and let the generated type carry them.
 */
type RentcastListingRowExtras = {
  /** Some feeds spell the asking price `listPrice`; the spec only declares `price`. */
  listPrice?: number
  /** Listing photo URLs — absent from the spec; kept because photoUrl is display-only and
   *  already null-tolerant everywhere it is shown. */
  photos?: string[]
}

// TOMBSTONE (lane 91C, §1): the canonical → RentCast property-type translator
// (RENTCAST_PROPERTY_TYPE / toRentcastPropertyType) moved to
// lib/property/rentcast-query.ts beside THE ONE listing-query builder, its only
// caller.

/**
 * RentCast bills PER REQUEST — every successful API request counts for billing purposes
 * regardless of endpoint or page size (developers.rentcast.io, verified 2026-09-17; the same
 * page states MCP calls count as API requests too, at this SAME rate — see
 * lib/external/rentcast-ai-tools.ts). Derived from the Foundation plan ($74/mo ÷ 1,000 included
 * requests = $0.074/request) — Foundation is the assumed default tier; the exact tier is the
 * owner's commercial decision (docs/lead-acquisition-coverage-2026-09.md carries the full plan
 * table: Developer $0/50 req free, Foundation $74/1,000, Growth $199/5,000 = $0.0398, Scale
 * $449/25,000 = $0.01796 — all cheaper per-request at a higher tier). ONE constant for every
 * RentCast endpoint below: the old per-endpoint estimates (COST_PER_LISTING_SEARCH $0.20,
 * COST_PER_AVM_LOOKUP $0.15, COST_PER_MARKET_LOOKUP $0.20) were leftovers from RentCast's old
 * "$49/mo / 250 calls" pricing and invented a DIFFERENT number per endpoint for a vendor that
 * bills the same way regardless of which endpoint was called — replaced here.
 */
export const RENTCAST_USD_PER_REQUEST = 0.074

/**
 * The vendor-ledger lane a RentCast call is attributed to when the caller did
 * not name one. It is `buyer_search` because that is what this client was built
 * for and what the historical ledger rows say.
 */
const DEFAULT_SYSTEM_SOURCE = "buyer_search"

/**
 * Fire-and-forget usage logger; never blocks the caller's request.
 *
 * `systemSource` USED TO BE HARD-CODED to "buyer_search" here, on every reader.
 * That made the vendor ledger say something false: a CMA's comparable pull, an
 * equity-trigger AVM and a market-stats read were all filed as buyer search, so
 * "what is RentCast spend actually going to?" had exactly one possible answer
 * and it was wrong for most of the calls. `sourceCompsForCma` had been accepting
 * a `systemSource` from its callers the whole time and there was no route for it
 * to reach this line. Now the caller's lane is carried on `RentcastCaller` and
 * lands on the ledger row; the old constant remains as the default so nothing
 * that does not name a lane changes meaning.
 */
function meterCall(params: {
  brokerageId: string
  usageType: string
  cost: number
  endpoint: string
  systemSource?: string
  contactId?: string | null
  metadata?: Record<string, any>
  /** Wave 93 (lane 93B) — a POOLED sweep served every brokerage named here with the SAME rows. */
  pooledBrokerageIds?: readonly string[] | null
}) {
  // ONE PULL, SPLIT LEDGER (wave 93, lane 93B — owner: "pull all of the active territories … to
  // make it one pull to keep the cost down"). A pooled area sweep is one billed request whose
  // identical rows every pool member receives, so the split by records received is EQUAL: one
  // ledger row per member at cost ÷ n (the last row absorbs the rounding so the rows sum to the
  // vendor charge exactly — lib/lead-pipeline/pooled-pull.ts::splitPullCost is the one rule).
  const pool = [...new Set((params.pooledBrokerageIds ?? []).filter(Boolean))]
  if (pool.length > 1) {
    void import("@/lib/lead-pipeline/pooled-pull").then(({ splitPullCost }) => {
      const shares = splitPullCost(params.cost, new Map(pool.map((b) => [b, 1])))
      for (const [brokerageId, share] of shares) {
        void logVendorUsage({
          vendorName: "rentcast",
          usageType: params.usageType,
          unitCount: 1 / pool.length,
          estimatedCost: share,
          systemSource: params.systemSource ?? DEFAULT_SYSTEM_SOURCE,
          brokerageId,
          metadata: { endpoint: params.endpoint, pooled: true, pool_size: pool.length, ...(params.metadata ?? {}) },
        }).catch(() => null)
      }
    }).catch(() => null)
    return
  }
  void logVendorUsage({
    vendorName: "rentcast",
    usageType: params.usageType,
    unitCount: 1,
    estimatedCost: params.cost,
    systemSource: params.systemSource ?? DEFAULT_SYSTEM_SOURCE,
    brokerageId: params.brokerageId,
    metadata: { endpoint: params.endpoint, contact_id: params.contactId ?? null, ...(params.metadata ?? {}) },
  }).catch(() => null)
}

/**
 * Who a RentCast call is being made FOR — the tenant it is metered against, and
 * the ownership tiers the IDX-connection gate is answered at.
 *
 * Every exported reader below takes these fields. `brokerageId` was always
 * required (platform-GATED means no call without a tenant to bill it to);
 * `agentUserId` (a USERS.id) and `teamId` are new, OPTIONAL, and exist so a
 * caller that knows the acting agent can have the gate see an AGENT-tier IDX
 * connection. A caller that passes only a brokerage id gets the gate answered at
 * brokerage scope — see lib/property/rentcast-eligibility.ts for what that
 * misses and why it is stated rather than guessed around.
 */
type RentcastCaller = RentcastEligibilityContext & {
  /**
   * Which lane of the product is making this call, for the vendor ledger.
   * OPTIONAL and defaulted to `buyer_search` so no existing caller changes
   * meaning — but a caller that knows its lane (the CMA comp sourcing does)
   * must pass it, or the ledger records a lane that did not spend.
   */
  systemSource?: string
  /**
   * The contact this call is being made ON BEHALF OF, when the caller has one.
   * Ledger metadata only — it is NOT a credential selector and it is NOT a
   * tenant boundary (`brokerageId` is both). It exists so "which client's CMA
   * did this $0.15 go to?" is answerable, which it was not while every RentCast
   * row carried only a brokerage.
   */
  contactId?: string | null
  /**
   * Wave 93 (lane 93B) — the brokerages a POOLED area sweep serves (identical geography, identical
   * rows). The request is gated + attributed to `brokerageId` (one of them) and the ledger row is
   * SPLIT equally across every id here (meterCall). Only the area sweeps pass it.
   */
  pooledBrokerageIds?: readonly string[] | null
}

export interface RentcastSearchFilters {
  /**
   * ONE home, by its postal address — "123 Main St, Austin, TX 78701".
   *
   * RentCast's `/listings/sale` and `/listings/rental/long-term` both accept an
   * `address` and return the listing(s) AT that address rather than an area
   * sweep; it is the same parameter `/avm/value` takes above, which is why the
   * spelling is not guessed here.
   *
   * WHY A SEARCH READER GREW A SINGLE-PROPERTY FILTER. The showing-route planner
   * has to resolve a SPECIFIC saved home, not "homes in Austin". Under the owner
   * ruling RentCast is the PLATFORM DEFAULT source for tenants who have not
   * connected their own IDX Broker feed, so without this the default source could
   * not answer the one question that lane asks. A second reader for it would be a
   * second gate, a second meter and a second refusal contract over the same
   * endpoint — §6 — so the endpoint's own parameter is exposed instead.
   *
   * Combines with the area filters (RentCast treats `address` + `radius` as a
   * circular search); every caller in this tree passes it ALONE, meaning "this
   * home".
   */
  address?: string
  city?: string
  state?: string
  zipCode?: string
  bedroomsMin?: number
  bedroomsMax?: number
  bathroomsMin?: number
  priceMin?: number
  priceMax?: number
  propertyType?: string
  limit?: number
  /** Listing status filter — RentCast's spec vocabulary: 'Active' (default) | 'Inactive'
   *  (off-market/expired). Was `string`; no caller in the tree ever passed one, so tightening
   *  to the generated query type's own union broke nobody and stops a junk status from riding
   *  to the vendor as a silently-ignored parameter. */
  status?: "Active" | "Inactive"
  /**
   * RECENCY WINDOW (wave 91, owner: "we should only pull more recent data").
   * Only listings put on the market within the last N days. Sent as RentCast's
   * own `daysOld` numeric-range parameter (`*:N` — "at most N days since it was
   * listed"; spec: lib/external/_generated/rentcast-openapi.ts, /listings/sale
   * and /listings/rental/long-term query). Area searches only — a single-home
   * `address` lookup omits every other parameter by RentCast's contract, so a
   * window there is dropped rather than sent beside it. Omitted = no window
   * (the reader's pre-wave-91 behaviour, kept for callers that pull comps or a
   * rent estimate where an older active listing is still evidence).
   * The window a BUYER-facing caller passes is BUYER_LISTING_RECENCY_DAYS
   * (lib/property-alerts/alert-cadence.ts) or the alert's own derived window.
   */
  listedWithinDays?: number
  /** Wave 92 (lane 92B) — RentCast's pagination index (the first row to return). A sweep that
   *  needs more than RENTCAST_MAX_LISTINGS_PER_REQUEST rows pages with this; area mode only. */
  offset?: number
}

// TOMBSTONE (lane 91C, §1/§6): THE ONE area-query builder for both listing
// readers (buildRentcastListingQuery — merged from the two per-reader copies
// that had drifted) and the recency window (daysOld) live in the pure sibling
// lib/property/rentcast-query.ts, the rentcast-normalize.ts pattern: no key, no
// gate, no egress, so the request SHAPE is provable without a network call.

export interface RentcastListing {
  externalId: string
  address: string
  city: string | null
  state: string | null
  zip: string | null
  price: number | null
  bedrooms: number | null
  bathrooms: number | null
  squareFeet: number | null
  yearBuilt: number | null
  propertyType: string | null
  daysOnMarket: number | null
  status: string | null
  /** Display-only photo URL — do NOT store; re-fetch */
  photoUrl: string | null
  /**
   * MLS listing number as reported by the originating MLS, and the MLS's own
   * name. Both are on the /listings/sale response contract (mlsNumber, mlsName)
   * and were being dropped by this mapper — which meant a for-sale search could
   * see the MLS number for a home and the OS still had no way to show it.
   * NEVER auto-written onto listings.mls_number: the join back to one of our own
   * listings is an ADDRESS match, which is fuzzy, and a wrong MLS number
   * syndicates the wrong home. Surfaced as a confirmable suggestion only.
   */
  mlsNumber: string | null
  mlsName: string | null
  source: "rentcast"
  /**
   * WAVE 92 (lane 92B, owner: "use any other attributes that are available") — the rest of the
   * /listings row, carried instead of dropped. All optional, all null-when-absent (never 0):
   * the listing's own DATES are what an inactive-listing sweep and a recency rule read
   * (`removedDate` is when it left the market — the expired/withdrawn freshness signal).
   */
  listedDate?: string | null
  removedDate?: string | null
  lastSeenDate?: string | null
  createdDate?: string | null
  listingType?: string | null
  latitude?: number | null
  longitude?: number | null
  county?: string | null
  lotSizeSqft?: number | null
  hoaMonthly?: number | null
  /** Public listing-marketing contacts (the MLS's own published listing agent / office). */
  listingAgent?: RentcastListingContact | null
  listingOffice?: RentcastListingContact | null
}

/** A listing's published agent / office contact block. */
interface RentcastListingContact { name: string | null; phone: string | null; email: string | null; website: string | null }

/** PURE — the wave-92 extras off one /listings row (sale or rental), shared by both mappers so
 *  the two readers cannot drift on which attributes they carry (§6). */
function listingRowExtras(r: Record<string, any>): Pick<RentcastListing,
  "listedDate" | "removedDate" | "lastSeenDate" | "createdDate" | "listingType" | "latitude" | "longitude"
  | "county" | "lotSizeSqft" | "hoaMonthly" | "listingAgent" | "listingOffice"> {
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v !== 0 ? v : null)
  const contact = (c: unknown): RentcastListingContact | null => (c && typeof c === "object"
    ? { name: s((c as any).name), phone: s((c as any).phone), email: s((c as any).email), website: s((c as any).website) }
    : null)
  return {
    listedDate: s(r?.listedDate),
    removedDate: s(r?.removedDate),
    lastSeenDate: s(r?.lastSeenDate),
    createdDate: s(r?.createdDate),
    listingType: s(r?.listingType),
    latitude: n(r?.latitude),
    longitude: n(r?.longitude),
    county: s(r?.county),
    lotSizeSqft: n(r?.lotSize),
    hoaMonthly: n(r?.hoa?.fee),
    listingAgent: contact(r?.listingAgent),
    listingOffice: contact(r?.listingOffice),
  }
}

// ---------------------------------------------------------------------------
// PROPERTY-FACT CACHE (wave 92, lane 92B) — "be careful of the limitations"
// ---------------------------------------------------------------------------

/**
 * How long a RentCast answer is reused, per endpoint family, in days. Facts only: a property
 * RECORD (assessor facts change yearly), an AVM / comparable set (RentCast recomputes on its own
 * cadence; two weeks is the AVM chain's own staleness bar, lib/avm/provider-chain.ts
 * DEFAULT_CACHE_STALE_DAYS) and zip market aggregates. LISTINGS ARE NEVER CACHED: their display
 * data is MLS-licensed (this file's header) and a buyer is owed today's status.
 */
const RENTCAST_CACHE_TTL_DAYS = { record: 30, avm: 14, markets: 7 } as const

/** PURE — one stable cache key for an address (case, punctuation and spacing folded). */
function addressCacheKey(address: string): string {
  return address.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
}

/** Instance-local layer in front of the shared store (a burst on one instance — a CMA and its
 *  narrative on the same address — never reaches the database twice). */
const memoryCache = new Map<string, { at: number; data: unknown }>()
const MEMORY_CACHE_MAX_ENTRIES = 500

/** Remember one answer in the instance layer. Bounded: a long-lived instance must not grow without
 *  limit — the oldest entry goes first (Map iteration is insertion order); the shared store keeps
 *  the long tail. */
function rememberInMemory(key: string, data: unknown): void {
  if (memoryCache.has(key)) memoryCache.delete(key)
  else if (memoryCache.size >= MEMORY_CACHE_MAX_ENTRIES) {
    const oldest = memoryCache.keys().next().value
    if (oldest !== undefined) memoryCache.delete(oldest)
  }
  memoryCache.set(key, { at: Date.now(), data })
}

/**
 * Read-through cache for ONE RentCast fact request. A hit costs nothing and is not metered (no
 * request was made). A miss runs `fetcher` (which meters its own request) and stores ONLY a
 * successful answer — a failed request is never cached, so a transient outage cannot become a
 * week of "no data". The shared store is best-effort by construction (lib/cma/comp-supplement-
 * cache.ts): an unreadable or unwritable store degrades to "make the request", never to a refusal.
 */
async function cachedRentcastRead<T>(
  key: string,
  maxAgeDays: number,
  fetcher: () => Promise<{ ok: boolean; data: T | null }>,
): Promise<{ ok: boolean; data: T | null; cacheHit: boolean }> {
  const ttlMs = maxAgeDays * 86_400_000
  const mem = memoryCache.get(key)
  if (mem && Date.now() - mem.at < ttlMs) return { ok: true, data: mem.data as T, cacheHit: true }
  let store: typeof import("@/lib/cma/comp-supplement-cache") | null = null
  try { store = await import("@/lib/cma/comp-supplement-cache") } catch { store = null }
  if (store) {
    const hit = await store.getCachedProviderPayload<T>(`rentcast:${key}`, maxAgeDays).catch(() => null)
    if (hit) {
      rememberInMemory(key, hit)
      return { ok: true, data: hit, cacheHit: true }
    }
  }
  const fresh = await fetcher()
  if (fresh.ok && fresh.data != null) {
    rememberInMemory(key, fresh.data)
    if (store) void store.setCachedProviderPayload(`rentcast:${key}`, fresh.data, Math.round(RENTCAST_USD_PER_REQUEST * 100)).catch(() => null)
  }
  return { ...fresh, cacheHit: false }
}

// ---------------------------------------------------------------------------
// Resolve the ONE platform RentCast key
// ---------------------------------------------------------------------------

/** Tenants already told their RentCast lane is dark — one line per tenant per
 *  instance, so a missing platform key is reported without flooding the log on
 *  every call. */
const darkLaneReported = new Set<string>()

/**
 * RentCast is a PLATFORM-GATED credential (owner ruling): ONE platform account
 * serving every tenant, governed by per-tenant metering (meterCall above →
 * logVendorUsage) plus the vendor budget gate. A tenant does NOT bring their own
 * RentCast key and is never offered the option — lib/connections/scope.ts is the
 * arbiter and deliberately keeps RentCast out of the user-connectable providers,
 * offering idxbroker as the only tenant-settable listing provider. There is
 * therefore NO per-tenant credential branch here: a tenant-resolved key would be
 * spend the platform cannot see, meter, or cap on a provider the product owns.
 *
 * `brokerageId` is NOT a credential selector. It is the tenant ATTRIBUTION every
 * caller already holds and hands to meterCall — kept on this signature so no
 * RentCast lane can resolve a key without a tenant to bill the call against,
 * which is exactly what "platform GATED" (rather than merely platform-owned)
 * means. It is used here to name whose lane went dark.
 *
 * Returns null — never throws — when the platform key is unset, so the AVM
 * cascade in lib/avm/provider-chain.ts falls through to the next provider and
 * every reader below can return its honest empty result.
 */
async function getApiKey(brokerageId: string): Promise<string | null> {
  const key = process.env.RENTCAST_API_KEY ?? null
  if (!key && !darkLaneReported.has(brokerageId)) {
    darkLaneReported.add(brokerageId)
    console.warn(`[rentcast] platform key not configured — RentCast lane is dark for brokerage ${brokerageId}`)
  }
  return key
}

/**
 * Does the platform RentCast key resolve for this tenant's lane?
 *
 * Every RentCast reader below returns an EMPTY result both when the vendor is
 * unconfigured and when the vendor simply has no coverage for the address — two
 * very different facts that a caller must be able to tell apart. Credential read
 * only; no egress, nothing to meter. The brokerage is carried for attribution,
 * not selection — the answer is the same platform key for every tenant.
 *
 * THIS IS THE PLATFORM-KEY QUESTION ONLY, and it is now one of three. A caller
 * that needs to know whether RentCast will actually RUN for a tenant must ask
 * `resolveRentcastEligibility` in ./rentcast-eligibility.ts, which also answers
 * "has this tenant connected their own IDX Broker feed?" and "is the vendor
 * budget exhausted?" and names WHICH one said no. lib/cma/comp-provider.ts asks
 * that resolver, not this predicate, precisely so its "no comparables" outcome
 * can distinguish a deliberate suppression from a dark vendor lane.
 */
export async function isRentcastConfigured(brokerageId: string): Promise<boolean> {
  return !!(await getApiKey(brokerageId))
}

/**
 * THE GATE, APPLIED INSIDE THE EXPORTS — so no caller can forget it.
 *
 * Owner ruling: "rentcast is platform owned and should not be used if the tenant
 * adds their idx broker credentials." That is a rule about the TENANT, not about
 * one feature, so it belongs on the vendor's own front door rather than
 * replicated at each of the eleven call sites that reach one of these readers.
 * Put another way: the ruling is enforced by construction here, and a new caller
 * added next month inherits it without knowing it exists.
 *
 * This is safe to do INSIDE the exports because every reader below already has
 * an honest empty return for "the vendor cannot serve this" — an explicit
 * refusal object, a null, or an empty array — established when RentCast became
 * platform-gated. A closed gate reuses that existing path, so NO caller's return
 * contract changes shape: `searchRentcastSaleListings` still resolves
 * `{ success: false, listings: [], error }`, `getRentcastAVM` still resolves
 * all-null so lib/avm/provider-chain.ts falls through to the next provider,
 * `getRentcastComps` still resolves `[]`, and the status/market readers still
 * resolve null. What changes is only that the `error`/note now NAMES the reason,
 * so "we deliberately did not call" is legible instead of looking like an
 * outage.
 *
 * The eligibility resolver never throws, so the gate cannot turn a dark lane
 * into a thrown request.
 */
async function gateRentcast(
  caller: RentcastCaller,
  readKind: RentcastReadKind,
): Promise<{ apiKey: string | null; eligibility: RentcastEligibility }> {
  // Wave 92 (lane 92B): the READER names its kind — never the caller — so a property-data read
  // cannot be suppressed by the IDX substitute rule and an active for-sale search cannot skip it.
  const eligibility = await resolveRentcastEligibility({ ...caller, readKind })
  if (!eligibility.eligible) return { apiKey: null, eligibility }
  return { apiKey: await getApiKey(caller.brokerageId), eligibility }
}

/**
 * The `error` string a refusing search returns.
 *
 * THE PLATFORM-KEY FACT LEADS WHENEVER THE KEY IS THE OPERATOR'S BLOCKER,
 * whichever question the gate happened to answer first. "RentCast is
 * unconfigured" is the actionable, invariant fact for an operator and it has
 * been this lane's refusal contract since RentCast became platform-gated;
 * dropping it because a different check fired earlier would regress that
 * contract to satisfy an ordering choice. The gate's own sentence is appended,
 * never replaced, so the deliberate-suppression reason is not lost either.
 */
function refusalMessage(eligibility: RentcastEligibility): string {
  if (eligibility.eligible) return "Rentcast not configured"
  if (eligibility.platformKeyPresent || eligibility.reason === "no_platform_key") return eligibility.detail
  return `Rentcast is not configured (the platform key is unset). ${eligibility.detail}`
}

// ---------------------------------------------------------------------------
// Search for-sale listings
// ---------------------------------------------------------------------------

export async function searchRentcastSaleListings(
  params: RentcastCaller & {
    filters: RentcastSearchFilters
    /** Wave 92 (lane 92B): a MARKET SWEEP — platform market intelligence over a territory (the
     *  active-listing discovery feed, lib/kernel/listings-batchdata-feed.ts), never a list a buyer
     *  is shown. Read as property_data: no tenant IDX feed substitutes for a market-wide sweep. */
    marketSweep?: boolean
  },
): Promise<{ success: boolean; listings: RentcastListing[]; error?: string }> {
  // Wave 92: an ACTIVE for-sale search a buyer is shown is the one read a tenant's IDX feed
  // substitutes for. An INACTIVE (off-market) sweep or a market sweep is market data IDX cannot
  // serve — property_data.
  const { apiKey, eligibility } = await gateRentcast(
    params,
    params.filters.status === "Inactive" || params.marketSweep === true ? "property_data" : "sale_listings",
  )
  if (!apiKey) {
    return {
      success: false,
      listings: [],
      error: refusalMessage(eligibility),
    }
  }

  const f = params.filters
  // A SINGLE-HOME LOOKUP IS ITS OWN QUERY MODE, not one more filter.
  // RentCast's search-queries reference (checked against the live docs
  // 2026-08-28): "If you need to retrieve property data or listing information
  // for a specific property, you can do so by providing its full address in the
  // `address` query parameter, and OMITTING ALL OTHER QUERY PARAMETERS." An
  // address sent beside the status/limit this builder always sets is not the
  // documented shape, and the provider is then free to ignore it and answer an
  // AREA search instead — the dangerous failure, because it returns 200 with
  // listings, so a showing route would silently plan a tour around the wrong
  // homes rather than reporting the one it could not resolve. Sent on BOTH
  // readers: an accepted-and-dropped filter is the exact defect this file's
  // rental reader was corrected for.
  //
  // The query object is TYPED (RentcastSaleListingsQuery, from the OpenAPI spec): the range
  // params below (`bedrooms`, `bathrooms`, `price`) are `string` on the spec precisely because
  // they carry range syntax, so a numeric exact-match regression now fails to compile.
  //
  // Built by THE ONE area-query builder (lib/property/rentcast-query.ts) —
  // wave 91 merged this reader's copy of the block onto it; the copy had lost
  // the max-only bedroom range the rental copy carried.
  const q: NonNullable<RentcastSaleListingsQuery> = buildRentcastListingQuery(f, { defaultLimit: 30, endpoint: "sale" })
  try {
    const res = await callRentcastGet("/listings/sale", q, apiKey)
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "api_call",
      cost: RENTCAST_USD_PER_REQUEST,
      endpoint: "/listings/sale",
      systemSource: params.systemSource,
      contactId: params.contactId,
      metadata: { ok: res.ok, status: res.status },
      pooledBrokerageIds: params.pooledBrokerageIds ?? null,
    })
    if (!res.ok) {
      return { success: false, listings: [], error: `Rentcast returned ${res.status ?? 0}` }
    }
    const data = res.data
    const arr: Array<RentcastSaleListingRow & RentcastListingRowExtras> = Array.isArray(data) ? data : []

    // Belt-and-braces re-filter (the server-side price/bedrooms ranges above are
    // the MCP-verified contract; this keeps bedroomsMax exact + guards nulls)
    const filtered = arr.filter((r) => {
      const price = r?.price ?? r?.listPrice ?? null
      if (f.priceMin != null && (price == null || price < f.priceMin)) return false
      if (f.priceMax != null && (price == null || price > f.priceMax)) return false
      if (f.bedroomsMax != null && r?.bedrooms != null && r.bedrooms > f.bedroomsMax) return false
      return true
    })

    const listings: RentcastListing[] = filtered.map((r) => ({
      externalId: r?.id ?? r?.formattedAddress ?? "",
      address: r?.formattedAddress ?? r?.addressLine1 ?? "",
      city: r?.city ?? null,
      state: r?.state ?? null,
      zip: r?.zipCode ?? null,
      price: r?.price ?? r?.listPrice ?? null,
      bedrooms: r?.bedrooms ?? null,
      bathrooms: r?.bathrooms ?? null,
      squareFeet: r?.squareFootage ?? null,
      yearBuilt: r?.yearBuilt ?? null,
      propertyType: r?.propertyType ?? null,
      daysOnMarket: r?.daysOnMarket ?? null,
      status: r?.status ?? "Active",
      photoUrl: r?.photos?.[0] ?? null,
      mlsNumber: r?.mlsNumber != null && r.mlsNumber !== "" ? String(r.mlsNumber) : null,
      mlsName: r?.mlsName != null && r.mlsName !== "" ? String(r.mlsName) : null,
      source: "rentcast",
      ...listingRowExtras(r as Record<string, any>),
    }))

    return { success: true, listings }
  } catch (err: any) {
    return { success: false, listings: [], error: err?.message ?? "Rentcast fetch failed" }
  }
}

// ---------------------------------------------------------------------------
// Property RECORD facts (lane 82A) — the tax/HOA facts the public calculators need
// ---------------------------------------------------------------------------

/**
 * FACTS ONLY from one RentCast property record. A WHITELIST projection: the
 * response also carries `owner` (names, mailing address), `ownerOccupied`,
 * `history` and `lastSalePrice`, and none of them is copied here — this reader
 * serves the anonymous calculators on public pages (owner verbatim, wave 82: "the
 * calculator was giving the property facts so the calculator was calculating the
 * correct property taxes, etc for the property landing pages"), and a visitor is
 * never handed an owner's identity or a sale figure. scripts/public-property-facts-
 * guard.ts feeds this a record WITH an owner block and asserts none of it survives.
 */
export interface RentcastPropertyFacts {
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  bedrooms: number | null
  bathrooms: number | null
  squareFeet: number | null
  lotSizeSqft: number | null
  yearBuilt: number | null
  propertyType: string | null
  /** Most recent tax-assessment year's total assessed value (the county's TAX BASIS). */
  assessedValue: number | null
  /** Most recent annual property-tax bill (dollars) and its year. */
  annualPropertyTax: number | null
  taxYear: number | null
  /** Monthly HOA fee (dollars) when the record carries one. */
  hoaMonthly: number | null
}

/** PURE — latest year's entry of a `{ "2023": {year, ...}, "2024": {...} }` map. */
function latestByYear<T extends { year?: number }>(m: Record<string, T | undefined> | null | undefined): T | null {
  if (!m || typeof m !== "object") return null
  const rows = Object.values(m).filter((v): v is T => !!v && typeof v === "object")
  if (rows.length === 0) return null
  return rows.reduce((a, b) => ((b.year ?? 0) > (a.year ?? 0) ? b : a))
}

const posNum = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null)

/** PURE — one raw /properties row → RentcastPropertyFacts (whitelist; the owner block is never read). */
export function normalizeRentcastPropertyRecord(r: RentcastPropertyRecord | Record<string, unknown>): RentcastPropertyFacts {
  const row = r as Record<string, any>
  const assess = latestByYear<{ year?: number; value?: number }>(row.taxAssessments)
  const tax = latestByYear<{ year?: number; total?: number }>(row.propertyTaxes)
  return {
    address: typeof row.formattedAddress === "string" ? row.formattedAddress : typeof row.addressLine1 === "string" ? row.addressLine1 : null,
    city: typeof row.city === "string" ? row.city : null,
    state: typeof row.state === "string" ? row.state : null,
    zip: typeof row.zipCode === "string" ? row.zipCode : null,
    bedrooms: posNum(row.bedrooms),
    bathrooms: posNum(row.bathrooms),
    squareFeet: posNum(row.squareFootage),
    lotSizeSqft: posNum(row.lotSize),
    yearBuilt: posNum(row.yearBuilt),
    propertyType: typeof row.propertyType === "string" ? row.propertyType : null,
    assessedValue: posNum(assess?.value),
    annualPropertyTax: posNum(tax?.total),
    taxYear: posNum(tax?.year),
    hoaMonthly: posNum(row.hoa?.fee),
  }
}

/**
 * ONE property record by full address (`GET /properties?address=…`, the documented
 * single-property mode: address alone, no other params). Gated + metered exactly
 * like every reader in this file (gateRentcast → meterCall at RENTCAST_USD_PER_REQUEST).
 * Returns null — never throws — when refused, not found or failed.
 */
export async function getRentcastPropertyRecord(
  params: RentcastCaller & { address: string },
): Promise<RentcastPropertyFacts | null> {
  const { row } = await fetchRentcastPropertyRow(params)
  return row ? normalizeRentcastPropertyRecord(row) : null
}

/**
 * THE ONE /properties request (wave 92, lane 92B) behind BOTH projections — the public
 * whitelist above (getRentcastPropertyRecord) and the full staff record below
 * (getRentcastPropertyDetail). One gate (property_data — an IDX feed carries no assessor
 * record), one meter, one cache entry (RENTCAST_CACHE_TTL_DAYS.record): the two projections of
 * the same address never pay twice. Null — never throws — when refused, not found or failed.
 */
/**
 * WHY a RentCast read came back empty (wave 93, lane 93B). The provider chain's BatchData BACKUP
 * (lib/avm/provider-chain.ts) runs only after a NAMED miss, so the readers it asks report one:
 * `not_eligible` (the gate refused — `eligibility.reason` says which question), `error` (non-2xx,
 * including a plan-quota 429/402, or a throw), `no_record` (RentCast answered with nothing).
 * "answered" = a usable row/price came back. Never collapsed to a boolean.
 */
export type RentcastReadOutcome = "answered" | "not_eligible" | "error" | "no_record"

/** THE /properties request WITH its outcome (wave 93) — the one body both projections and the
 *  provider chain's lookup (getRentcastPropertyDetailWithOutcome) share. */
async function fetchRentcastPropertyRow(
  params: RentcastCaller & { address: string },
): Promise<{ row: RentcastPropertyRecord | null; outcome: RentcastReadOutcome; eligibility: RentcastEligibility }> {
  const { apiKey, eligibility } = await gateRentcast(params, "property_data")
  if (!apiKey) return { row: null, outcome: "not_eligible", eligibility }
  if (!params.address?.trim()) return { row: null, outcome: "no_record", eligibility }
  let httpOk = true
  try {
    const address = params.address.trim()
    const read = await cachedRentcastRead<RentcastPropertyRecord>(
      `/properties|${addressCacheKey(address)}`, RENTCAST_CACHE_TTL_DAYS.record, async () => {
        const res = await callRentcastGet("/properties", { address }, apiKey)
        httpOk = res.ok
        meterCall({
          brokerageId: params.brokerageId,
          usageType: "api_call",
          cost: RENTCAST_USD_PER_REQUEST,
          endpoint: "/properties",
          systemSource: params.systemSource,
          contactId: params.contactId,
          metadata: { ok: res.ok, status: res.status },
        })
        const first = res.ok && Array.isArray(res.data) && res.data.length > 0 ? res.data[0] : null
        return { ok: first != null, data: first }
      })
    if (read.ok && read.data) return { row: read.data, outcome: "answered", eligibility }
    return { row: null, outcome: httpOk ? "no_record" : "error", eligibility }
  } catch {
    return { row: null, outcome: "error", eligibility }
  }
}

/** The full staff record WITH why it is absent — the provider chain's RentCast leg for a property
 *  lookup (getPropertyRecordWithFallback). Same request, gate, meter and cache as the two readers. */
export async function getRentcastPropertyDetailWithOutcome(
  params: RentcastCaller & { address: string },
): Promise<{ detail: RentcastPropertyDetail | null; outcome: RentcastReadOutcome; eligibility: RentcastEligibility }> {
  const r = await fetchRentcastPropertyRow(params)
  return { detail: r.row ? normalizeRentcastPropertyDetail(r.row) : null, outcome: r.outcome, eligibility: r.eligibility }
}

/**
 * EVERY ATTRIBUTE of one RentCast property record (wave 92, lane 92B — owner: "use any other
 * attributes that are available"). STAFF-ONLY by construction: it carries the owner block, the
 * sale history and the last sale price, which the public whitelist (RentcastPropertyFacts) never
 * maps. Callers: the property-lookup rail's staff audience, the deal investigator. A customer or
 * public surface must use getRentcastPropertyRecord.
 */
export interface RentcastPropertyDetail extends RentcastPropertyFacts {
  rentcastId: string | null
  county: string | null
  latitude: number | null
  longitude: number | null
  assessorId: string | null
  legalDescription: string | null
  subdivision: string | null
  zoning: string | null
  lastSaleDate: string | null
  lastSalePrice: number | null
  ownerOccupied: boolean | null
  ownerNames: string[]
  ownerType: string | null
  ownerMailingAddress: string | null
  /** RentCast's `features` block verbatim (garage, pool, heating, cooling, roof, floors…). */
  features: Record<string, unknown> | null
  /** Sale / listing history events, newest first: { date, event, price }. */
  history: Array<{ date: string; event: string | null; price: number | null }>
  /** Every tax-assessment and tax-bill year RentCast published (not just the latest). */
  taxAssessments: Array<{ year: number; value: number | null; land: number | null; improvements: number | null }>
  propertyTaxes: Array<{ year: number; total: number | null }>
}

/** PURE — one raw /properties row → the full staff record. */
function normalizeRentcastPropertyDetail(r: RentcastPropertyRecord | Record<string, unknown>): RentcastPropertyDetail {
  const row = r as Record<string, any>
  const s = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
  const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v !== 0 ? v : null)
  const owner = (row.owner ?? {}) as Record<string, any>
  const mail = (owner.mailingAddress ?? {}) as Record<string, any>
  const byYear = (m: unknown) => (m && typeof m === "object" ? Object.values(m as Record<string, any>).filter((v) => v && typeof v === "object") : [])
  return {
    ...normalizeRentcastPropertyRecord(r),
    rentcastId: s(row.id),
    county: s(row.county),
    latitude: n(row.latitude),
    longitude: n(row.longitude),
    assessorId: s(row.assessorID),
    legalDescription: s(row.legalDescription),
    subdivision: s(row.subdivision),
    zoning: s(row.zoning),
    lastSaleDate: s(row.lastSaleDate),
    lastSalePrice: posNum(row.lastSalePrice),
    ownerOccupied: typeof row.ownerOccupied === "boolean" ? row.ownerOccupied : null,
    ownerNames: Array.isArray(owner.names) ? owner.names.filter((x: unknown): x is string => typeof x === "string" && !!x.trim()) : [],
    ownerType: s(owner.type),
    ownerMailingAddress: s(mail.formattedAddress) ?? s(mail.addressLine1),
    features: row.features && typeof row.features === "object" ? (row.features as Record<string, unknown>) : null,
    history: Object.entries((row.history ?? {}) as Record<string, any>)
      .map(([date, h]) => ({ date: s(h?.date) ?? date, event: s(h?.event), price: posNum(h?.price) }))
      .sort((a, b) => (a.date < b.date ? 1 : -1)),
    taxAssessments: byYear(row.taxAssessments)
      .map((a: any) => ({ year: Number(a.year), value: posNum(a.value), land: posNum(a.land), improvements: posNum(a.improvements) }))
      .filter((a) => Number.isFinite(a.year))
      .sort((a, b) => b.year - a.year),
    propertyTaxes: byYear(row.propertyTaxes)
      .map((t: any) => ({ year: Number(t.year), total: posNum(t.total) }))
      .filter((t) => Number.isFinite(t.year))
      .sort((a, b) => b.year - a.year),
  }
}

/** The full RentCast property record (every attribute) — STAFF audiences only. Same request,
 *  gate, meter and cache entry as getRentcastPropertyRecord. Null when refused / not found. */
export async function getRentcastPropertyDetail(
  params: RentcastCaller & { address: string },
): Promise<RentcastPropertyDetail | null> {
  const { row } = await fetchRentcastPropertyRow(params)
  return row ? normalizeRentcastPropertyDetail(row) : null
}

// ---------------------------------------------------------------------------
// Single-listing availability (m315) — is this outside home still for sale?
// ---------------------------------------------------------------------------

/**
 * Look up ONE external listing's current status.
 *
 * Exists so a video that showed a buyer a third-party home can be checked
 * rather than assumed. Resolves the PLATFORM key (getApiKey — RentCast is
 * platform-gated, there is no tenant key to prefer), which is why an agent with
 * no vendor account of their own is covered by construction.
 *
 * Returns a status on OUR vocabulary, or null when we could not find out.
 * Null is never upgraded to "active" by any caller — an unverifiable home stays
 * unverifiable, because telling a buyer a sold house is available is the one
 * mistake this whole lane exists to prevent.
 */
export async function getRentcastListingStatus(
  params: RentcastCaller & { externalId: string },
): Promise<string | null> {
  const { apiKey } = await gateRentcast(params, "property_data")
  if (!apiKey || !params.externalId) return null
  try {
    const res = await callRentcastGetById("/listings/sale/{id}", params.externalId, apiKey)
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "api_call",
      cost: RENTCAST_USD_PER_REQUEST,
      endpoint: "/listings/sale/{id}",
      systemSource: params.systemSource,
      contactId: params.contactId,
      metadata: { ok: res.ok, status: res.status },
    })
    // A 404 means the vendor no longer carries the listing. That is genuinely
    // informative — it is off the market — but it is not proof of WHICH
    // terminal state, so it maps to off_market rather than to "sold".
    if (res.status === 404) return "off_market"
    if (!res.ok) return null
    // The by-id endpoint's 200 body is `unknown` on the spec (RentcastSaleListingResponse) —
    // the alias states that honestly; the shape is then narrowed defensively as it always was.
    const payload: RentcastSaleListingResponse | null = res.data
    const row: any = Array.isArray(payload) ? payload[0] : payload
    const { normalizeVendorStatus } = await import("./resolve-property-facts")
    return normalizeVendorStatus(row?.status ?? null)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Search rental listings (used by investor mode + lifetime customer portal)
// ---------------------------------------------------------------------------

/**
 * Long-term rental listings for an area.
 *
 * `price` on every row this returns is a MONTHLY RENT, not a sale price. That is
 * the only reason this is a separate function from `searchRentcastSaleListings`
 * rather than a `status`/endpoint flag on it: the two share a request shape and
 * a row shape but not the meaning of their central number, and merging them
 * would produce one function whose result a caller cannot interpret without
 * knowing which branch ran. Everything they genuinely share — the gate, the
 * refusal message, the range-parameter contract, the row mapper — is shared.
 *
 * WHAT CHANGED AND WHY: this used to accept the full `RentcastSearchFilters`
 * and read exactly FOUR of its fields. `bedroomsMax`, `bathroomsMin`,
 * `priceMin`, `priceMax`, `propertyType` and `status` were accepted from the
 * caller and silently dropped, so a caller asking for "2-3 bed rentals under
 * $2,500" got every rental in the city and no indication its filters had been
 * discarded. Worse, `bedrooms` was sent as a bare `String(bedroomsMin)`, which
 * is RentCast's EXACT-match form — a "3+ bedroom" search lost every 4-bedroom
 * rental. `searchRentcastSaleListings` had already been corrected to the
 * MCP-verified range syntax (`3:*`, `min:max`, `price=min:max`); this had not,
 * because nothing consumed it and so nothing surfaced the difference. Both now
 * build the query the same way.
 */
export async function searchRentcastRentalListings(
  params: RentcastCaller & { filters: RentcastSearchFilters },
): Promise<{ success: boolean; listings: RentcastListing[]; error?: string }> {
  // Wave 92: property_data — the tenant IDX feed this product reads carries no rentals, so it is
  // no substitute (rent-estimate.ts's own note said so while the gate still suppressed it).
  const { apiKey, eligibility } = await gateRentcast(params, "property_data")
  if (!apiKey) {
    return {
      success: false,
      listings: [],
      error: refusalMessage(eligibility),
    }
  }

  const f = params.filters
  // Same single-home lookup the for-sale reader sends. Honoured here rather than
  // silently dropped: this reader has already been through one round of
  // accepted-and-discarded filters and must not grow another.
  // A SINGLE-HOME LOOKUP IS ITS OWN QUERY MODE, not one more filter.
  // RentCast's search-queries reference (checked against the live docs
  // 2026-08-28): "If you need to retrieve property data or listing information
  // for a specific property, you can do so by providing its full address in the
  // `address` query parameter, and OMITTING ALL OTHER QUERY PARAMETERS." An
  // address sent beside the status/limit this builder always sets is not the
  // documented shape, and the provider is then free to ignore it and answer an
  // AREA search instead — the dangerous failure, because it returns 200 with
  // listings, so a showing route would silently plan a tour around the wrong
  // homes rather than reporting the one it could not resolve. Sent on BOTH
  // readers: an accepted-and-dropped filter is the exact defect this file's
  // rental reader was corrected for.
  //
  // Typed as the RENTAL endpoint's own query (RentcastRentalListingsQuery), which is the sale
  // query minus "Land" on propertyType — the compiler now holds the two builders to their own
  // endpoints instead of one URLSearchParams shape pretending to fit both.
  //
  // Built by THE ONE area-query builder (buildRentcastListingQuery) — wave 91
  // merged this reader's copy onto it. `price` here is the monthly rent range,
  // the same query parameter on this endpoint; the builder omits "Land" for the
  // rental endpoint, which is the only property-type difference between the
  // two query types, so the narrowing below is exact.
  const q = buildRentcastListingQuery(f, { defaultLimit: 20, endpoint: "rental" }) as NonNullable<RentcastRentalListingsQuery>
  try {
    const res = await callRentcastGet("/listings/rental/long-term", q, apiKey)
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "api_call",
      cost: RENTCAST_USD_PER_REQUEST,
      endpoint: "/listings/rental/long-term",
      systemSource: params.systemSource,
      contactId: params.contactId,
      metadata: { ok: res.ok, status: res.status },
    })
    if (!res.ok) {
      return { success: false, listings: [], error: `Rentcast returned ${res.status ?? 0}` }
    }
    const data = res.data
    const arr: Array<RentcastRentalListingRow & RentcastListingRowExtras> = Array.isArray(data) ? data : []
    // Belt-and-braces re-filter, matching the for-sale search: the server-side
    // ranges above are the contract, this keeps bedroomsMax exact and stops a
    // row with NO rent at all from satisfying a rent filter.
    const filtered = arr.filter((r) => {
      const rent = r?.price ?? null
      if (f.priceMin != null && (rent == null || rent < f.priceMin)) return false
      if (f.priceMax != null && (rent == null || rent > f.priceMax)) return false
      if (f.bedroomsMax != null && r?.bedrooms != null && r.bedrooms > f.bedroomsMax) return false
      return true
    })
    const listings: RentcastListing[] = filtered.map((r) => ({
      externalId: r?.id ?? r?.formattedAddress ?? "",
      address: r?.formattedAddress ?? r?.addressLine1 ?? "",
      city: r?.city ?? null,
      state: r?.state ?? null,
      zip: r?.zipCode ?? null,
      price: r?.price ?? null,    // monthly rent
      bedrooms: r?.bedrooms ?? null,
      bathrooms: r?.bathrooms ?? null,
      squareFeet: r?.squareFootage ?? null,
      yearBuilt: r?.yearBuilt ?? null,
      propertyType: r?.propertyType ?? null,
      daysOnMarket: r?.daysOnMarket ?? null,
      status: r?.status ?? "Active",
      photoUrl: r?.photos?.[0] ?? null,
      mlsNumber: r?.mlsNumber != null && r.mlsNumber !== "" ? String(r.mlsNumber) : null,
      mlsName: r?.mlsName != null && r.mlsName !== "" ? String(r.mlsName) : null,
      source: "rentcast",
      ...listingRowExtras(r as Record<string, any>),
    }))
    return { success: true, listings }
  } catch (err: any) {
    return { success: false, listings: [], error: err?.message ?? "Rentcast fetch failed" }
  }
}

// ---------------------------------------------------------------------------
// AVM endpoint (used for cross-checking Perplexity estimate)
// ---------------------------------------------------------------------------

/**
 * The AVM figures carried on a `/avm/value` response, parsed in ONE place.
 *
 * `/avm/value` answers two questions in a single billed call: what does
 * RentCast's model think this home is worth (`price`, `priceRangeLow`,
 * `priceRangeHigh`), and which comparables did it look at (`comparables[]`).
 * `getRentcastAVM` reads the first half, `getRentcastComps` reads the second,
 * and `getRentcastAvmAndComps` reads both from the SAME response — which is why
 * this parser exists rather than three copies of `data?.price ?? null`.
 *
 * Every field is `number | null`. NEVER 0: a provider that did not answer and a
 * provider that answered "zero" are different facts, and this lane's whole
 * purpose is that a missing estimate reads as missing.
 */
function parseAvmValue(data: RentcastAvmValueResponse | null): { value: number | null; rangeLow: number | null; rangeHigh: number | null } {
  // The spec declares price/priceRangeLow/priceRangeHigh as REQUIRED numbers with @default 0 —
  // i.e. "no estimate" arrives as 0, which is exactly why the >0 guard maps it to null here.
  const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null)
  return {
    value: num(data?.price),
    rangeLow: num(data?.priceRangeLow),
    rangeHigh: num(data?.priceRangeHigh),
  }
}

/**
 * Wave 93 (lane 93B): the read also says WHY it is empty (`outcome`, RentcastReadOutcome) — the AVM
 * chain's BatchData backup runs only after a NAMED miss. Extra fields only: every caller that reads
 * value / rangeLow / rangeHigh keeps its contract.
 */
export async function getRentcastAVM(
  params: RentcastCaller & { address: string },
): Promise<{ value: number | null; rangeLow: number | null; rangeHigh: number | null; outcome: RentcastReadOutcome; eligibility: RentcastEligibility; cacheHit: boolean }> {
  // Wave 99 (lane 99C): `cacheHit` rides back so the property_valuation capability
  // (lib/avm/provider-chain.ts::requestPropertyValuation) reports the cost it actually metered.
  const none = { value: null, rangeLow: null, rangeHigh: null, cacheHit: false }
  const { apiKey, eligibility } = await gateRentcast(params, "property_data")
  if (!apiKey) return { ...none, outcome: "not_eligible", eligibility }

  try {
    const q: RentcastAvmValueQuery = { address: params.address }
    // Wave 92: a home value is a property FACT for its window — cached (RENTCAST_CACHE_TTL_DAYS.avm).
    const read = await cachedRentcastRead<RentcastAvmValueResponse>(
      `/avm/value|${addressCacheKey(params.address)}`, RENTCAST_CACHE_TTL_DAYS.avm, async () => {
        const res = await callRentcastGet("/avm/value", q, apiKey)
        meterCall({
          brokerageId: params.brokerageId,
          usageType: "avm_lookup",
          cost: RENTCAST_USD_PER_REQUEST,
          endpoint: "/avm/value",
          systemSource: params.systemSource,
          contactId: params.contactId,
          metadata: { ok: res.ok, status: res.status },
        })
        return { ok: res.ok, data: res.ok ? res.data : null }
      })
    if (!read.ok) return { ...none, outcome: "error", eligibility }
    const avm = parseAvmValue(read.data)
    return { ...avm, outcome: avm.value != null ? "answered" : "no_record", eligibility, cacheHit: read.cacheHit }
  } catch {
    return { ...none, outcome: "error", eligibility }
  }
}

// ---------------------------------------------------------------------------
// Market statistics endpoint — zip-level aggregate (median price, DOM, inventory).
// This is the TIER-1 data feed for the AI market-insight report, replacing the
// retired HouseCanary integration. RentCast is the brokerage's chosen property-data
// provider for AVM/comps/market stats.
// ---------------------------------------------------------------------------

/** Fetch zip-level sale market statistics from RentCast. Never throws. */
export async function getRentcastMarketStats(
  params: RentcastCaller & { zipCode: string },
): Promise<RentcastMarketStats | null> {
  const { apiKey } = await gateRentcast(params, "property_data")
  if (!apiKey || !params.zipCode) return null

  try {
    // Wave 92 (lane 92B): dataType "All" — the SAME one billed request returns the sale AND the
    // rental half ("use any other attributes that are available"); was "Sale", which paid for a
    // request and left the rental market on the table. Cached RENTCAST_CACHE_TTL_DAYS.markets
    // (RentCast refreshes zip aggregates on its own cadence; a same-week re-read is the same row).
    const zip = params.zipCode.trim()
    const q: RentcastMarketsQuery = { zipCode: zip, dataType: "All", historyRange: 12 }
    const read = await cachedRentcastRead<RentcastMarketsResponse>(
      `/markets|${zip}`, RENTCAST_CACHE_TTL_DAYS.markets, async () => {
        const res = await callRentcastGet("/markets", q, apiKey)
        meterCall({
          brokerageId: params.brokerageId,
          usageType: "market_stats",
          cost: RENTCAST_USD_PER_REQUEST,
          endpoint: "/markets",
          systemSource: params.systemSource,
          contactId: params.contactId,
          metadata: { ok: res.ok, status: res.status, zip },
        })
        return { ok: res.ok, data: res.ok ? res.data : null }
      })
    if (!read.ok) return null
    // The alias makes the read explicit: `saleData` is a spec-promised member, so a renamed
    // field in a regenerated spec fails HERE at compile time instead of as a silent null stats.
    const data: RentcastMarketsResponse | null = read.data
    const sale = normalizeRentcastMarketStats(data?.saleData)
    if (!sale) return null
    return { ...sale, rental: normalizeRentcastRentalMarketStats(data?.rentalData) }
  } catch {
    return null
  }
}

/**
 * WHY A RENTCAST AVM BASELINE IS ABSENT. Never collapsed to a boolean, and never
 * collapsed to a zero: "we deliberately did not call", "the call failed" and
 * "RentCast has no estimate for this address" are three different facts about
 * the product and a reader is owed the difference.
 */
export type RentcastAvmUnavailableReason =
  | "not_eligible"      // the gate refused — `eligibility.reason` names which question said no
  | "no_address"        // nothing to look up
  | "provider_error"    // non-2xx, or the request threw
  | "no_estimate"       // RentCast answered and published no price for this address

export interface RentcastAvmAndComps {
  comps: RentcastComp[]
  /** RentCast's own automated estimate. NOT a comp-derived value conclusion.
   *  Every field is null-when-unknown; a refused or failed lookup is never 0. */
  avm: { value: number | null; rangeLow: number | null; rangeHigh: number | null }
  /** True only when RentCast actually published a price. */
  avmAvailable: boolean
  /** Why not, when not. Null when it is available. */
  avmUnavailableReason: RentcastAvmUnavailableReason | null
  /** The gate's verdict, so a caller can say WHICH question suppressed the call. */
  eligibility: RentcastEligibility
}

/**
 * ONE `/avm/value` call, BOTH of the things it answers.
 *
 * RentCast's `/avm/value` response carries the model's price estimate AND the
 * comparables it reasoned from. The CMA lane needs both — the comparables to
 * build the value range from, and the estimate as the owner's "possible
 * baseline" to show alongside it ("rentcast does offer an avm which can be
 * argued but a possible baseline"). Reading both off the one response is not an
 * optimisation, it is the correctness requirement: a separate `getRentcastAVM`
 * call would bill the tenant a SECOND $0.15 lookup and could return an estimate
 * computed from a different comparable set than the one the report shows.
 *
 * Metered ONCE, as `comps_lookup`, because it is one billable call. The AVM
 * rides along at no marginal cost, which is exactly why it is read here.
 *
 * Never throws.
 */
export async function getRentcastAvmAndComps(
  params: RentcastCaller & {
    address: string
    limit?: number
    /** Wave 92 (lane 92B) — RentCast's own /avm/value comparable-search bounds, used by the CMA's
     *  WIDENED sold-side supplement (lib/cma/comp-provider.ts §3b), which replaced the retired
     *  BatchData comps pull: a wider radius (miles) and an older last-seen window (days). */
    maxRadiusMiles?: number
    daysOld?: number
  },
): Promise<RentcastAvmAndComps> {
  const empty = (
    reason: RentcastAvmUnavailableReason,
    eligibility: RentcastEligibility,
    comps: RentcastComp[] = [],
  ): RentcastAvmAndComps => ({
    comps,
    avm: { value: null, rangeLow: null, rangeHigh: null },
    avmAvailable: false,
    avmUnavailableReason: reason,
    eligibility,
  })

  const { apiKey, eligibility } = await gateRentcast(params, "property_data")
  if (!apiKey) return empty("not_eligible", eligibility)
  if (!params.address) return empty("no_address", eligibility)

  try {
    // RentCast's compCount is 5..25 (spec); the request is clamped rather than refused.
    const compCount = Math.min(25, Math.max(5, Math.floor(params.limit ?? 10)))
    const q: RentcastAvmValueQuery = { address: params.address, compCount }
    if (params.maxRadiusMiles != null && params.maxRadiusMiles > 0) q.maxRadius = params.maxRadiusMiles
    if (params.daysOld != null && params.daysOld >= 1) q.daysOld = Math.floor(params.daysOld)
    // Wave 92: cached per (address, comp bounds) for RENTCAST_CACHE_TTL_DAYS.avm — a re-generated
    // CMA, a second agent on the same listing or a retry reads the same row instead of re-paying.
    const read = await cachedRentcastRead<RentcastAvmValueResponse>(
      `/avm/value(comps)|${addressCacheKey(params.address)}|${compCount}|${q.maxRadius ?? ""}|${q.daysOld ?? ""}`,
      RENTCAST_CACHE_TTL_DAYS.avm, async () => {
        const res = await callRentcastGet("/avm/value", q, apiKey)
        meterCall({
          brokerageId: params.brokerageId,
          usageType: "comps_lookup",
          cost: RENTCAST_USD_PER_REQUEST,
          endpoint: "/avm/value(comps)",
          systemSource: params.systemSource,
          contactId: params.contactId,
          metadata: { ok: res.ok, status: res.status },
        })
        return { ok: res.ok, data: res.ok ? res.data : null }
      })
    if (!read.ok) return empty("provider_error", eligibility)
    const data = read.data
    const comparables = data?.comparables
    const comps = normalizeRentcastComps(comparables)
    // PULL-DRIFT SENTINEL: RentCast returned comparables but the normalizer
    // kept none → the response shape drifted (a renamed `price` would silently
    // empty every CMA). Quarantines one sample + ledgers, never throws.
    const received = Array.isArray(comparables) ? comparables.length : 0
    if (received > 0 && comps.length === 0 && comparables) {
      const { reportPullDrift } = await import("@/lib/kernel/ingress-continuity")
      await reportPullDrift(createServiceClient() as any, {
        connector: "rentcast", source: "rentcast_avm_comps",
        received, kept: 0, sample: comparables[0],
      })
    }

    const avm = parseAvmValue(data)
    if (avm.value == null) return empty("no_estimate", eligibility, comps)
    return { comps, avm, avmAvailable: true, avmUnavailableReason: null, eligibility }
  } catch {
    return empty("provider_error", eligibility)
  }
}

/**
 * Fetch comparable sales for an address via RentCast's AVM endpoint (returns a
 * `comparables[]` array). This is the chosen comps source for CMA generation,
 * replacing the retired HouseCanary integration. Never throws.
 *
 * A THIN READER OVER `getRentcastAvmAndComps` — one HTTP call, one meter entry,
 * one parser. Callers that only want the comparables keep this signature; the
 * CMA lane calls the combined reader because it also shows the AVM baseline.
 * Do not re-implement the pull here: two pulls is two prices for one question.
 */
export async function getRentcastComps(
  params: RentcastCaller & { address: string; limit?: number },
): Promise<RentcastComp[]> {
  return (await getRentcastAvmAndComps(params)).comps
}
