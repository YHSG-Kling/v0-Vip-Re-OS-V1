/**
 * lib/ai-isa/property-lookup-rail.ts
 *
 * Lane 79B — owner verbatim (wave 79): "we created these batchdata tools that
 * are not necessarily a good choice for a tool and are basically the only
 * provider tools that are built… tools for the ai agents should not be using
 * batchdata tools if there are less expensive tools to look up properties".
 *
 * THE ONE PROPERTY-LOOKUP RAIL for a CONVERSATION (an AI agent talking to a
 * customer persona, a seat's copilot acting for a contact, or a listing
 * intake). Before this file every AI surface reached a paid provider through
 * its own registry (lib/ai-isa/batchdata-isa-tools.ts's lookup_property /
 * search_properties_* / comparable_property_* / investor_buybox_* — all
 * BatchData, per-record priced) and the cheap rails the OS already owned
 * were never consulted first. This file is the ladder, cheapest rung first,
 * and it STOPS at the first rung that answers:
 *
 *   1. cache          — OUR OWN DATABASE: `listings` (the brokerage's own
 *                       inventory) and `saved_properties` (the cached
 *                       RentCast/IDX/MLS snapshots lib/property/resolve-
 *                       property-facts.ts already treats as a source). $0.
 *   2. tenant_idx     — the tenant's OWN connected IDX Broker feed, when
 *                       lib/buyer-search/listing-source-order.ts derives
 *                       "idx" for the brokerage (their MLS data, no vendor
 *                       spend to the platform). $0 to the platform.
 *   3. rentcast       — lib/property/rentcast.ts::searchRentcastSaleListings
 *                       in its documented single-address mode (RENTCAST_USD_
 *                       PER_REQUEST ≈ $0.074/request on the Scale ladder,
 *                       metered by the reader itself). Gated INSIDE that
 *                       reader by resolveRentcastEligibility (IDX-connected
 *                       tenants never reach it; budget-exhausted tenants
 *                       never reach it).
 *   4. public_records — lib/property/address-lookup.ts::lookupPropertyBy
 *                       Address (Perplexity Sonar over county assessor /
 *                       public pages, ~$0.005–0.015, booked to ai_tool_usage
 *                       by generateTextRouted). Facts only — a
 *                       taxAssessedValue is NOT a home value and is stripped
 *                       for a customer audience below.
 *   5. batchdata      — lib/external/batchdata-mcp.ts::batchDataPreferMcp
 *                       ("lookup_property", the SAME seam lib/offers/public-
 *                       record-preload.ts rides). MCP_TOOL_CALL_COST_USD per
 *                       call, booked to vendor_usage_tracking through
 *                       meterVendorSpend. REACHED ONLY when
 *                       `isBatchDataRungAllowed` says so — see below.
 *
 * ── WHEN BATCHDATA IS ALLOWED (the owner's carve-out, wave 79) ──────────────
 * "BatchData reserved for platform lead ACQUISITION, skip-trace, DNC." The
 * rail encodes that as a PURPOSE vocabulary (`PropertyLookupPurpose`):
 *   conversation   — a customer persona or a seat's copilot asking about a
 *                    property mid-chat/call. NEVER BatchData, whatever the
 *                    tier or opt-in says.
 *   listing_intake — an agent entering their own listing address. NEVER
 *                    BatchData (RentCast/public records cover the facts).
 *   acquisition    — platform lead acquisition (off-market sourcing, seller
 *                    signal enrichment). BatchData allowed when the platform
 *                    policy admits it.
 *   skip_trace     — owner-contact discovery for an acquisition lane. Allowed
 *                    under the same policy.
 *   dnc            — phone compliance (DNC/TCPA) before an outbound send.
 *                    Allowed under the same policy.
 * The PLATFORM POLICY is two existing facts, never a new setting:
 *   - lib/ai-isa/persona-tool-policy.ts::resolveEffectiveBatchDataToolTier —
 *     an explicit "off" (or an over-cap month) is honoured here exactly as
 *     the tool registries honour it.
 *   - lib/buyer-search/listing-source-order.ts::resolveActiveListingSources —
 *     the platform-staff opt-in "batchdata_on_market" (m642/m643, written
 *     ONLY by app/actions/superadmin/active-listing-sources.ts) is the
 *     per-tenant permission for a billed BatchData pull. No opt-in → no
 *     BatchData, even for an acquisition purpose.
 * FAIL CLOSED on both: an unreadable tier or opt-in reads as "not allowed".
 *
 * ── AUDIENCE REDACTION (CLAUDE.md §5: contacts see no financials; the
 *    home-value review callback never speaks a number) ─────────────────────
 * `redactFactsForAudience` strips `estimatedValue` and `taxAssessedValue`
 * for a "customer" audience before the facts ever reach the model: a seller
 * asking "what's my home worth" gets the FACTS of their home (beds, baths,
 * year built, sqft) and the schedule_home_value_review offer, never a
 * figure. `listPrice` of an ACTIVE listing is public marketing information
 * and survives. A "staff" audience (the in-app copilot) keeps everything.
 *
 * ── NOT A SECOND PROVIDER CLIENT ────────────────────────────────────────────
 * Every rung is a thin adapter over an existing survivor (named above);
 * this file adds no HTTP, no credential resolution and no second meter.
 * `deps.rungs` lets a proof inject fake rungs so the LADDER ORDER, the
 * short-circuit and the purpose gate are exercised with zero network
 * (scripts/persona-tool-realism-guard.ts).
 *
 * Tombstone map (CLAUDE.md §1) — what this rail replaced, and where:
 *   lib/ai-isa/batchdata-isa-tools.ts lookup_property / search_properties_
 *   preview|count|page / verify_address / comparable_property_preview|count /
 *   investor_buybox_preview|count → this rail (facts) + lib/ai-isa/property-
 *   lookup-tools.ts (the two persona tools). The DNC/TCPA/phone tools stay
 *   in batchdata-isa-tools.ts under the `dnc` purpose (sphere, outbound-
 *   eligible only).
 */

import type { BatchDataToolTier } from "@/lib/ai-isa/persona-tool-policy"

export type PropertyLookupPurpose = "conversation" | "listing_intake" | "acquisition" | "skip_trace" | "dnc"
// Module-private (wave 79 integration, opposite-missing C3: the exported list had no
// reader). Its ONE reader is the entry gate below — a "use server" caller can hand the
// rail any string, and an unknown purpose must fail CLOSED, never fall to a rung.
const PROPERTY_LOOKUP_PURPOSES: readonly PropertyLookupPurpose[] = [
  "conversation", "listing_intake", "acquisition", "skip_trace", "dnc",
]
function isPropertyLookupPurpose(v: unknown): v is PropertyLookupPurpose {
  return typeof v === "string" && (PROPERTY_LOOKUP_PURPOSES as readonly string[]).includes(v)
}

/** The owner's carve-out: the ONLY purposes that may ever reach BatchData. */
export const BATCHDATA_ELIGIBLE_PURPOSES: ReadonlySet<PropertyLookupPurpose> = new Set<PropertyLookupPurpose>([
  "acquisition", "skip_trace", "dnc",
])

export type PropertyLookupAudience = "customer" | "staff"

export type PropertyLookupRung = "cache" | "tenant_idx" | "rentcast" | "public_records" | "batchdata"

/** Cheapest first. The rail walks this order and stops at the first answer. */
export const PROPERTY_LOOKUP_RUNG_ORDER: readonly PropertyLookupRung[] = [
  "cache", "tenant_idx", "rentcast", "public_records", "batchdata",
]

/** Documented per-lookup cost of each rung in USD — a cost ORDER the proof
 *  holds monotone (never a billing number; the ledgers carry those). */
export const PROPERTY_LOOKUP_RUNG_COST_USD: Readonly<Record<PropertyLookupRung, number>> = {
  cache: 0,
  tenant_idx: 0,
  rentcast: 0.074,      // RENTCAST_USD_PER_REQUEST (lib/property/rentcast.ts)
  public_records: 0.015, // Perplexity Sonar upper bound (lib/property/address-lookup.ts) — booked to ai_tool_usage, not a vendor
  batchdata: 0.05,      // MCP_TOOL_CALL_COST_USD (lib/external/batchdata-ai-tools.ts) per call, per-record priced at scale
}

export interface PropertyLookupAddress {
  street: string
  city?: string | null
  state?: string | null
  zip?: string | null
}

export interface PropertyLookupFacts {
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  beds: number | null
  baths: number | null
  sqft: number | null
  yearBuilt: number | null
  lotSize: number | null
  propertyType: string | null
  /** Our listings vocabulary when known (active/pending/sold/…); null = unknown, never "available". */
  listingStatus: string | null
  /** Public marketing price of an active listing — survives every audience. */
  listPrice: number | null
  /** A valuation-shaped figure. STRIPPED for a customer audience. */
  estimatedValue: number | null
  /** County assessed value. STRIPPED for a customer audience (it reads as a value). */
  taxAssessedValue: number | null
  mlsNumber: string | null
  listingUrl: string | null
  source: PropertyLookupRung
  sourceNote: string
}

export interface PropertyLookupRequest {
  /** Tenant — from the SESSION / the resolved conversation row, never a body (§4). */
  brokerageId: string
  purpose: PropertyLookupPurpose
  audience: PropertyLookupAudience
  address: PropertyLookupAddress
  /** Ledger attribution only. */
  contactId?: string | null
  userId?: string | null
  agentId?: string | null
}

export interface PropertyLookupPolicy {
  batchDataTier: BatchDataToolTier
  /** brokerage_settings.active_listing_sources carries "batchdata_on_market" (platform-staff opt-in). */
  batchDataOptedIn: boolean
}

export interface PropertyLookupResult {
  found: boolean
  facts: PropertyLookupFacts | null
  /** Every rung that ran, in order — the cost story of this lookup. */
  rungsTried: PropertyLookupRung[]
  /** Rungs SKIPPED and why (a purpose gate, an unavailable source) — data the model can relay. */
  skipped: Array<{ rung: PropertyLookupRung; reason: string }>
}

export type PropertyLookupRungFn = (req: PropertyLookupRequest) => Promise<PropertyLookupFacts | null>
export type PropertyLookupRungs = Record<PropertyLookupRung, PropertyLookupRungFn>

// ─── PURE DECISIONS ─────────────────────────────────────────────────────────

/** PURE — may this lookup reach BatchData at all? Purpose carve-out AND
 *  platform policy, both required. "off"/over-cap tier or no opt-in → never. */
export function isBatchDataRungAllowed(purpose: PropertyLookupPurpose, policy: PropertyLookupPolicy): boolean {
  if (!BATCHDATA_ELIGIBLE_PURPOSES.has(purpose)) return false
  if (policy.batchDataTier === "off") return false
  return policy.batchDataOptedIn === true
}

/** PURE — a customer never sees a valuation-shaped figure (CLAUDE.md §5). */
export function redactFactsForAudience(facts: PropertyLookupFacts, audience: PropertyLookupAudience): PropertyLookupFacts {
  if (audience === "staff") return facts
  return { ...facts, estimatedValue: null, taxAssessedValue: null }
}

/** PURE — one normalised street line for a case-insensitive own-DB match. */
export function normalizeStreetLine(street: string): string {
  return street.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,]/g, "")
}

/** PURE — the full one-line address RentCast/public-records readers take. */
export function formatFullAddress(a: PropertyLookupAddress): string {
  return [a.street, a.city, a.state, a.zip].map((v) => (v ?? "").trim()).filter(Boolean).join(", ")
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/[$,]/g, "")) : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

function emptyFacts(source: PropertyLookupRung, sourceNote: string): PropertyLookupFacts {
  return {
    address: null, city: null, state: null, zip: null, beds: null, baths: null, sqft: null, yearBuilt: null,
    lotSize: null, propertyType: null, listingStatus: null, listPrice: null, estimatedValue: null,
    taxAssessedValue: null, mlsNumber: null, listingUrl: null, source, sourceNote,
  }
}

// ─── PRODUCTION RUNGS (thin adapters over existing survivors) ───────────────

async function cacheRung(req: PropertyLookupRequest): Promise<PropertyLookupFacts | null> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const needle = `%${normalizeStreetLine(req.address.street)}%`

  // (1) Our own listings — authoritative and free.
  const { data: own, error: ownErr } = await svc
    .from("listings")
    .select("address, city, state, zip, bedrooms, bathrooms, sqft, year_built, lot_size, property_type, status, list_price, mls_number")
    .eq("brokerage_id", req.brokerageId)
    .is("deleted_at", null)
    .ilike("address", needle)
    .limit(1)
  if (ownErr) console.error("[property-lookup-rail] listings read refused:", ownErr.message)
  const l = (own ?? [])[0] as Record<string, unknown> | undefined
  if (l) {
    return {
      ...emptyFacts("cache", "From the brokerage's own listing record."),
      address: str(l.address), city: str(l.city), state: str(l.state), zip: str(l.zip),
      beds: num(l.bedrooms), baths: num(l.bathrooms), sqft: num(l.sqft), yearBuilt: num(l.year_built),
      lotSize: num(l.lot_size), propertyType: str(l.property_type), listingStatus: str(l.status),
      listPrice: num(l.list_price), mlsNumber: str(l.mls_number),
    }
  }

  // (2) Cached external snapshots (RentCast / IDX / MLS) the OS already holds.
  const { data: saved, error: savedErr } = await svc
    .from("saved_properties")
    .select("property_address, city, state, bedrooms, bathrooms, sqft, property_type, list_price, mls_number, listing_url, source")
    .eq("brokerage_id", req.brokerageId)
    .ilike("property_address", needle)
    .order("saved_at", { ascending: false })
    .limit(1)
  if (savedErr) console.error("[property-lookup-rail] saved_properties read refused:", savedErr.message)
  const s = (saved ?? [])[0] as Record<string, unknown> | undefined
  if (!s) return null
  return {
    ...emptyFacts("cache", `From a cached ${str(s.source) ?? "external"} snapshot the OS already holds — availability unverified.`),
    address: str(s.property_address), city: str(s.city), state: str(s.state),
    beds: num(s.bedrooms), baths: num(s.bathrooms), sqft: num(s.sqft), propertyType: str(s.property_type),
    listPrice: num(s.list_price), mlsNumber: str(s.mls_number), listingUrl: str(s.listing_url),
  }
}

async function tenantIdxRung(req: PropertyLookupRequest): Promise<PropertyLookupFacts | null> {
  const { resolveActiveListingSources } = await import("@/lib/buyer-search/listing-source-order")
  const sources = await resolveActiveListingSources(req.brokerageId)
  if (!sources.includes("idx")) return null
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
  const client = await IDXBrokerClient.forBrokerage(req.brokerageId)
  if (!client.isConfigured()) return null
  const rows = await client.searchActiveListings({
    city: req.address.city ?? undefined, state: req.address.state ?? undefined,
    zipCode: req.address.zip ?? undefined, limit: 50,
  })
  const want = normalizeStreetLine(req.address.street)
  const hit = (rows as unknown as Array<Record<string, unknown>>).find((r) => normalizeStreetLine(String(r.address ?? "")).includes(want))
  if (!hit) return null
  return {
    ...emptyFacts("tenant_idx", "From the brokerage's own connected IDX/MLS feed."),
    address: str(hit.address), city: str(hit.city), state: str(hit.state), zip: str(hit.zip),
    beds: num(hit.bedrooms), baths: num(hit.bathrooms), sqft: num(hit.squareFeet ?? hit.sqft),
    yearBuilt: num(hit.yearBuilt), propertyType: str(hit.propertyType), listingStatus: str(hit.status),
    listPrice: num(hit.price), mlsNumber: str(hit.mlsNumber), listingUrl: str(hit.listingUrl),
  }
}

async function rentcastRung(req: PropertyLookupRequest): Promise<PropertyLookupFacts | null> {
  const { searchRentcastSaleListings } = await import("@/lib/property/rentcast")
  const r = await searchRentcastSaleListings({
    brokerageId: req.brokerageId,
    systemSource: "ai_agent_tool",
    contactId: req.contactId ?? null,
    filters: { address: formatFullAddress(req.address) },
  })
  if (!r.success || r.listings.length === 0) return null
  const l = r.listings[0]
  return {
    ...emptyFacts("rentcast", "From RentCast's listing record (platform-metered)."),
    address: l.address, city: l.city, state: l.state, zip: l.zip,
    beds: l.bedrooms, baths: l.bathrooms, sqft: l.squareFeet, yearBuilt: l.yearBuilt,
    propertyType: l.propertyType, listingStatus: l.status ? l.status.toLowerCase() : null,
    listPrice: l.price, mlsNumber: l.mlsNumber,
  }
}

async function publicRecordsRung(req: PropertyLookupRequest): Promise<PropertyLookupFacts | null> {
  const { lookupPropertyByAddress } = await import("@/lib/property/address-lookup")
  const r = await lookupPropertyByAddress({
    address: req.address.street, city: req.address.city ?? "", state: req.address.state ?? "", zip: req.address.zip ?? undefined,
    brokerageId: req.brokerageId, userId: req.userId ?? null,
  })
  if (r.beds == null && r.sqft == null && r.yearBuilt == null) return null
  return {
    ...emptyFacts("public_records", `From public records (${r.sources.join(", ") || "county/public pages"}; confidence ${r.dataConfidence}).`),
    address: req.address.street, city: req.address.city ?? null, state: req.address.state ?? null, zip: req.address.zip ?? null,
    beds: r.beds, baths: r.baths, sqft: r.sqft, yearBuilt: r.yearBuilt, lotSize: r.lotSizeAcres,
    propertyType: r.propertyType, taxAssessedValue: r.taxAssessedValue,
  }
}

async function batchDataRung(req: PropertyLookupRequest): Promise<PropertyLookupFacts | null> {
  const { batchDataPreferMcp } = await import("@/lib/external/batchdata-mcp")
  const r = await batchDataPreferMcp<Record<string, unknown> | null>(
    "lookup_property",
    {
      property_street: req.address.street, property_city: req.address.city ?? "",
      property_state: req.address.state ?? "", property_zip: req.address.zip ?? "",
    },
    async () => null,
  )
  if (!r.data) return null
  // Book the spend to the SAME vendor ledger every BatchData tool call books to.
  const [{ meterVendorSpend }, { MCP_TOOL_CALL_COST_USD }] = await Promise.all([
    import("@/lib/vendor-governance/meter-vendor"),
    import("@/lib/external/batchdata-ai-tools"),
  ])
  void meterVendorSpend({
    vendorName: "batchdata", usageType: `rail_lookup_property_${req.purpose}`, cost: MCP_TOOL_CALL_COST_USD,
    brokerageId: req.brokerageId, systemSource: "ai_agent_tool",
    metadata: { userId: req.userId ?? null, agentId: req.agentId ?? null, purpose: req.purpose },
  }).catch(() => null)
  const d = r.data
  const building = (d.building ?? {}) as Record<string, unknown>
  const valuation = (d.valuation ?? {}) as Record<string, unknown>
  const addr = (d.address ?? {}) as Record<string, unknown>
  return {
    ...emptyFacts("batchdata", "From BatchData public records (per-record billed)."),
    address: str(addr.street) ?? req.address.street, city: str(addr.city) ?? req.address.city ?? null,
    state: str(addr.state) ?? req.address.state ?? null, zip: str(addr.zip) ?? req.address.zip ?? null,
    beds: num(building.bedroomCount ?? d.beds), baths: num(building.bathroomCount ?? d.baths),
    sqft: num(building.totalBuildingAreaSquareFeet ?? d.sqft), yearBuilt: num(building.yearBuilt ?? d.yearBuilt),
    lotSize: num(d.lotSize), propertyType: str(building.propertyType ?? d.propertyType),
    estimatedValue: num(valuation.estimatedValue ?? d.estimatedValue),
  }
}

const PRODUCTION_RUNGS: PropertyLookupRungs = {
  cache: cacheRung,
  tenant_idx: tenantIdxRung,
  rentcast: rentcastRung,
  public_records: publicRecordsRung,
  batchdata: batchDataRung,
}

/** I/O — the platform policy from the two existing facts. FAIL CLOSED. */
async function readProductionPolicy(brokerageId: string): Promise<PropertyLookupPolicy> {
  let batchDataTier: BatchDataToolTier = "off"
  let batchDataOptedIn = false
  try {
    const { resolveEffectiveBatchDataToolTier } = await import("@/lib/ai-isa/persona-tool-policy")
    batchDataTier = await resolveEffectiveBatchDataToolTier()
  } catch { batchDataTier = "off" }
  try {
    const { resolveActiveListingSources } = await import("@/lib/buyer-search/listing-source-order")
    batchDataOptedIn = (await resolveActiveListingSources(brokerageId)).includes("batchdata_on_market")
  } catch { batchDataOptedIn = false }
  return { batchDataTier, batchDataOptedIn }
}

export interface PropertyLookupDeps {
  rungs?: Partial<PropertyLookupRungs>
  policy?: PropertyLookupPolicy
}

/**
 * THE rail. Walks PROPERTY_LOOKUP_RUNG_ORDER cheapest-first and returns the
 * first rung's facts, redacted for the audience. A rung that throws is
 * recorded as skipped and the ladder continues — a dark vendor never fails
 * the lookup, it just costs the next rung. The batchdata rung is consulted
 * ONLY when isBatchDataRungAllowed(purpose, policy) holds.
 */
export async function lookupPropertyForConversation(
  req: PropertyLookupRequest,
  deps: PropertyLookupDeps = {},
): Promise<PropertyLookupResult> {
  const result: PropertyLookupResult = { found: false, facts: null, rungsTried: [], skipped: [] }
  if (!isPropertyLookupPurpose(req.purpose)) {
    result.skipped.push({ rung: "cache", reason: `purpose "${String(req.purpose)}" is not one of ${PROPERTY_LOOKUP_PURPOSES.join("/")} — refused, fail closed` })
    return result
  }
  if (!req.brokerageId) {
    result.skipped.push({ rung: "cache", reason: "no tenant on the request — a tenant-less lookup is refused (§4)" })
    return result
  }
  if (!req.address?.street?.trim()) {
    result.skipped.push({ rung: "cache", reason: "no street address given — ask for the address first" })
    return result
  }
  const rungs: PropertyLookupRungs = { ...PRODUCTION_RUNGS, ...(deps.rungs ?? {}) }
  let policy: PropertyLookupPolicy | null = deps.policy ?? null

  for (const rung of PROPERTY_LOOKUP_RUNG_ORDER) {
    if (rung === "batchdata") {
      if (!BATCHDATA_ELIGIBLE_PURPOSES.has(req.purpose)) {
        result.skipped.push({ rung, reason: `purpose "${req.purpose}" never reaches BatchData (reserved for acquisition / skip-trace / DNC)` })
        continue
      }
      policy = policy ?? (await readProductionPolicy(req.brokerageId))
      if (!isBatchDataRungAllowed(req.purpose, policy)) {
        result.skipped.push({ rung, reason: policy.batchDataTier === "off" ? "BatchData tier is off" : "tenant not opted into billed BatchData pulls by platform staff" })
        continue
      }
    }
    result.rungsTried.push(rung)
    try {
      const facts = await rungs[rung](req)
      if (facts) {
        result.found = true
        result.facts = redactFactsForAudience(facts, req.audience)
        return result
      }
    } catch (e) {
      result.skipped.push({ rung, reason: `rung failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  return result
}
