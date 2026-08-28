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
 * Key endpoints used:
 *   GET /v1/listings/sale?city=X&state=Y&bedrooms=&bathrooms=&maxPrice=&minPrice=
 *   GET /v1/listings/rental/long-term?city=X&state=Y&...
 *   GET /v1/avm/value?address=...
 *   GET /v1/properties?address=...&city=...&state=...
 */

import { createServiceClient } from "@/lib/supabase/service"
import { logVendorUsage } from "@/lib/vendor-governance/usage-logger"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
import {
  resolveRentcastEligibility,
  type RentcastEligibility,
  type RentcastEligibilityContext,
} from "./rentcast-eligibility"
import {
  normalizeRentcastMarketStats,
  normalizeRentcastComps,
  type RentcastMarketStats,
  type RentcastComp,
} from "./rentcast-normalize"

export { normalizeRentcastMarketStats, normalizeRentcastComps, type RentcastMarketStats, type RentcastComp }

const RENTCAST_BASE = "https://api.rentcast.io/v1"

/** RentCast GET through the connector-gateway (X-Api-Key header). */
async function rentcastGet(apiKey: string, path: string, qs: URLSearchParams): Promise<{ ok: boolean; status: number; data: any }> {
  const res = await callConnector<any>({
    connector: "rentcast", baseUrl: RENTCAST_BASE, path, method: "GET",
    query: Object.fromEntries(qs), auth: { style: "header", name: "X-Api-Key", value: apiKey },
  })
  return { ok: res.ok, status: res.status ?? 0, data: res.data }
}

// Approximate per-call costs at Rentcast's standard tier ($49/mo / 250 calls = $0.196).
// Used for usage telemetry — actual billing happens via Rentcast directly.
const COST_PER_LISTING_SEARCH = 0.20
const COST_PER_AVM_LOOKUP = 0.15

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
}) {
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
  /** Listing status filter (RentCast): 'Active' (default) | 'Inactive' (off-market/expired). */
  status?: string
}

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
): Promise<{ apiKey: string | null; eligibility: RentcastEligibility }> {
  const eligibility = await resolveRentcastEligibility(caller)
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
  params: RentcastCaller & { filters: RentcastSearchFilters },
): Promise<{ success: boolean; listings: RentcastListing[]; error?: string }> {
  const { apiKey, eligibility } = await gateRentcast(params)
  if (!apiKey) {
    return {
      success: false,
      listings: [],
      error: refusalMessage(eligibility),
    }
  }

  const qs = new URLSearchParams()
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
  if (f.address) {
    qs.set("address", f.address)
  } else {
    if (f.city) qs.set("city", f.city)
    if (f.state) qs.set("state", f.state)
    if (f.zipCode) qs.set("zipCode", f.zipCode)
    // MCP-verified contract: bedrooms/bathrooms/price are RANGE params — a plain
    // "3" means EXACTLY 3 (a 3+ buyer would silently lose 4-bed homes); the min-
    // only form is "3:*". Price has no minPrice/maxPrice — one `price=min:max`.
    if (f.bedroomsMin != null && f.bedroomsMax != null) qs.set("bedrooms", `${f.bedroomsMin}:${f.bedroomsMax}`)
    else if (f.bedroomsMin != null) qs.set("bedrooms", `${f.bedroomsMin}:*`)
    if (f.bathroomsMin != null) qs.set("bathrooms", `${f.bathroomsMin}:*`)
    if (f.priceMin != null && f.priceMax != null) qs.set("price", `${f.priceMin}:${f.priceMax}`)
    else if (f.priceMin != null) qs.set("price", `${f.priceMin}:*`)
    else if (f.priceMax != null) qs.set("price", `*:${f.priceMax}`)
    if (f.propertyType) qs.set("propertyType", f.propertyType)
    qs.set("status", f.status ?? "Active")
    qs.set("limit", String(f.limit ?? 30))
  }
  try {
    const res = await rentcastGet(apiKey, "/listings/sale", qs)
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "api_call",
      cost: COST_PER_LISTING_SEARCH,
      endpoint: "/listings/sale",
      systemSource: params.systemSource,
      contactId: params.contactId,
      metadata: { ok: res.ok, status: res.status },
    })
    if (!res.ok) {
      return { success: false, listings: [], error: `Rentcast returned ${res.status}` }
    }
    const data = res.data
    const arr: any[] = Array.isArray(data) ? data : []

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
    }))

    return { success: true, listings }
  } catch (err: any) {
    return { success: false, listings: [], error: err?.message ?? "Rentcast fetch failed" }
  }
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
  const { apiKey } = await gateRentcast(params)
  if (!apiKey || !params.externalId) return null
  try {
    const res = await rentcastGet(apiKey, `/listings/sale/${encodeURIComponent(params.externalId)}`, new URLSearchParams())
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "api_call",
      cost: COST_PER_LISTING_SEARCH,
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
    const row: any = Array.isArray(res.data) ? res.data[0] : res.data
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
  const { apiKey, eligibility } = await gateRentcast(params)
  if (!apiKey) {
    return {
      success: false,
      listings: [],
      error: refusalMessage(eligibility),
    }
  }

  const qs = new URLSearchParams()
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
  if (f.address) {
    qs.set("address", f.address)
  } else {
    if (f.city) qs.set("city", f.city)
    if (f.state) qs.set("state", f.state)
    if (f.zipCode) qs.set("zipCode", f.zipCode)
    // Same MCP-verified range contract as the for-sale search: a bare "3" means
    // EXACTLY 3, so a min-only filter must be written "3:*". `price` here is the
    // monthly rent range, which is the same query parameter on this endpoint.
    if (f.bedroomsMin != null && f.bedroomsMax != null) qs.set("bedrooms", `${f.bedroomsMin}:${f.bedroomsMax}`)
    else if (f.bedroomsMin != null) qs.set("bedrooms", `${f.bedroomsMin}:*`)
    else if (f.bedroomsMax != null) qs.set("bedrooms", `*:${f.bedroomsMax}`)
    if (f.bathroomsMin != null) qs.set("bathrooms", `${f.bathroomsMin}:*`)
    if (f.priceMin != null && f.priceMax != null) qs.set("price", `${f.priceMin}:${f.priceMax}`)
    else if (f.priceMin != null) qs.set("price", `${f.priceMin}:*`)
    else if (f.priceMax != null) qs.set("price", `*:${f.priceMax}`)
    if (f.propertyType) qs.set("propertyType", f.propertyType)
    qs.set("status", f.status ?? "Active")
    qs.set("limit", String(f.limit ?? 20))
  }
  try {
    const res = await rentcastGet(apiKey, "/listings/rental/long-term", qs)
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "api_call",
      cost: COST_PER_LISTING_SEARCH,
      endpoint: "/listings/rental/long-term",
      systemSource: params.systemSource,
      contactId: params.contactId,
      metadata: { ok: res.ok, status: res.status },
    })
    if (!res.ok) {
      return { success: false, listings: [], error: `Rentcast returned ${res.status}` }
    }
    const data = res.data
    const arr: any[] = Array.isArray(data) ? data : []
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
function parseAvmValue(data: any): { value: number | null; rangeLow: number | null; rangeHigh: number | null } {
  const num = (v: any): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null)
  return {
    value: num(data?.price),
    rangeLow: num(data?.priceRangeLow),
    rangeHigh: num(data?.priceRangeHigh),
  }
}

export async function getRentcastAVM(
  params: RentcastCaller & { address: string },
): Promise<{ value: number | null; rangeLow: number | null; rangeHigh: number | null }> {
  const { apiKey } = await gateRentcast(params)
  if (!apiKey) return { value: null, rangeLow: null, rangeHigh: null }

  try {
    const qs = new URLSearchParams({ address: params.address })
    const res = await rentcastGet(apiKey, "/avm/value", qs)
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "avm_lookup",
      cost: COST_PER_AVM_LOOKUP,
      endpoint: "/avm/value",
      systemSource: params.systemSource,
      contactId: params.contactId,
      metadata: { ok: res.ok, status: res.status },
    })
    if (!res.ok) return { value: null, rangeLow: null, rangeHigh: null }
    return parseAvmValue(res.data)
  } catch {
    return { value: null, rangeLow: null, rangeHigh: null }
  }
}

// ---------------------------------------------------------------------------
// Market statistics endpoint — zip-level aggregate (median price, DOM, inventory).
// This is the TIER-1 data feed for the AI market-insight report, replacing the
// retired HouseCanary integration. RentCast is the brokerage's chosen property-data
// provider for AVM/comps/market stats.
// ---------------------------------------------------------------------------

const COST_PER_MARKET_LOOKUP = 0.20

/** Fetch zip-level sale market statistics from RentCast. Never throws. */
export async function getRentcastMarketStats(
  params: RentcastCaller & { zipCode: string },
): Promise<RentcastMarketStats | null> {
  const { apiKey } = await gateRentcast(params)
  if (!apiKey || !params.zipCode) return null

  try {
    const qs = new URLSearchParams({ zipCode: params.zipCode, dataType: "Sale", historyRange: "12" })
    const res = await rentcastGet(apiKey, "/markets", qs)
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "market_stats",
      cost: COST_PER_MARKET_LOOKUP,
      endpoint: "/markets",
      systemSource: params.systemSource,
      contactId: params.contactId,
      metadata: { ok: res.ok, status: res.status, zip: params.zipCode },
    })
    if (!res.ok) return null
    const data = res.data
    return normalizeRentcastMarketStats(data?.saleData)
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
  params: RentcastCaller & { address: string; limit?: number },
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

  const { apiKey, eligibility } = await gateRentcast(params)
  if (!apiKey) return empty("not_eligible", eligibility)
  if (!params.address) return empty("no_address", eligibility)

  try {
    const qs = new URLSearchParams({ address: params.address, compCount: String(params.limit ?? 10) })
    const res = await rentcastGet(apiKey, "/avm/value", qs)
    meterCall({
      brokerageId: params.brokerageId,
      usageType: "comps_lookup",
      cost: COST_PER_AVM_LOOKUP,
      endpoint: "/avm/value(comps)",
      systemSource: params.systemSource,
      contactId: params.contactId,
      metadata: { ok: res.ok, status: res.status },
    })
    if (!res.ok) return empty("provider_error", eligibility)
    const data = res.data
    const comps = normalizeRentcastComps(data?.comparables)
    // PULL-DRIFT SENTINEL: RentCast returned comparables but the normalizer
    // kept none → the response shape drifted (a renamed `price` would silently
    // empty every CMA). Quarantines one sample + ledgers, never throws.
    const received = Array.isArray(data?.comparables) ? data.comparables.length : 0
    if (received > 0 && comps.length === 0) {
      const { reportPullDrift } = await import("@/lib/kernel/ingress-continuity")
      await reportPullDrift(createServiceClient() as any, {
        connector: "rentcast", source: "rentcast_avm_comps",
        received, kept: 0, sample: data.comparables[0],
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
