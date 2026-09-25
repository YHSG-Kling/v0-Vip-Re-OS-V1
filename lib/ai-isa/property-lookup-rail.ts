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
 *   lib/property/enrichment-chain.ts (DELETED, wave 80 lane B, owner verbatim
 *   "resolve enrichment duplicate for listing intake") — its OSINT → BatchData
 *   → ai_estimate ladder was a SECOND spelling of rungs 4/5 with its own
 *   source vocabulary ("osint" | "batchdata" | "ai_estimate"), an inline
 *   Nominatim copy, an unbooked model call (a `shim:generateObject` row in
 *   scripts/ai-spend-booked-baseline.json) and a BatchData reach for a
 *   listing-intake purpose. What it did that this rail lacked is merged
 *   BELOW as the `listing_intake` path: (a) the free geocode — through the
 *   canonical lib/external/nominatim-geocode.ts::geocodeOne, never a third
 *   inline copy — filling `lat`/`lon` on the facts; (b) the AI ESTIMATE
 *   fallback when every rung misses — FACTS ONLY (beds/baths/sqft/yearBuilt/
 *   lotSize/propertyType), flagged `isEstimate: true`, source "ai_estimate",
 *   booked to ai_tool_usage by generateObjectRouted with the tenant; never
 *   a value/rent/walk score (the old chain fabricated all three — §5, the
 *   "GPT-fabrication" its own header disowned). Its Zillow-page Zenrows
 *   scrape (a private-field reach into OSINTClient, regex over markup) was
 *   NOT carried: the facts it fished for are rung 4's job (public records),
 *   and scraping is frozen. Its Street View / static-map helpers were not a
 *   ladder and moved verbatim to lib/property/street-view.ts. Callers
 *   repointed: lib/workflow/intelligence/listing-presentation-builder.ts
 *   (purpose "listing_intake", audience "staff").
 *
 * ── ONE GATE FOR EVERY BATCHDATA REACH (wave 80 lane B) ─────────────────────
 * The facts rung above is one BatchData shape (lookup_property). The platform's
 * acquisition lanes reach BatchData in OTHER shapes — a skip trace returns
 * phones, a DNC check returns a flag, an off-market pull returns a list — so
 * they cannot ride `lookupPropertyForConversation`. They ride the SAME purpose
 * gate instead: `resolveBatchDataAccess({ brokerageId, purpose })` reads the
 * same two policy facts (readProductionPolicy) and applies the carve-out per
 * purpose. Every production BatchData caller that is not the facts rung calls
 * it first (lib/lead-pipeline/enrichment-orchestrator.ts, lib/buyer-search/
 * investor-offmarket-runner.ts, lib/compliance/phone-scrub-runner.ts,
 * lib/communication/tcpa-gate.ts) — scripts/enrichment-one-rail-guard.ts holds
 * that list against the stripped source. Per purpose:
 *   acquisition — tier ≠ off AND the platform-staff opt-in (79B's rule for a
 *                 billed per-tenant pull, unchanged). A tenant nobody opted in
 *                 gets NO billed off-market pull and NO property-dataset
 *                 enrichment; scraped inventory still matches.
 *   skip_trace  — tier ≠ off. The tier's monthly cap already sums EVERY
 *                 vendor_usage_tracking row for batchdata (persona-tool-
 *                 policy.ts::readPlatformBatchDataMonthlySpendCents), so it is
 *                 the platform-wide kill switch; the opt-in is by name about
 *                 on-market listing pulls, and the orchestrator keeps its own
 *                 vendor budget gate. A tenant-less skip trace is refused (§4).
 *   dnc         — never refused by a SPEND policy: a compliance scrub blocked
 *                 by a tool tier puts unscrubbed numbers on the dialer. The
 *                 provider-configured / balance check stays in the MCP wrapper
 *                 (checkDncStatus → unconfigured → the runner DEFERS). The gate
 *                 still declares the purpose, so the reach is auditable.
 *   conversation / listing_intake — refused, always.
 *   valuation   — (wave 81 lane B) the STAFF valuation / deal-analytics lane the
 *                 owner admitted in wave 70 ("BatchData supplement when short"
 *                 for CMA comps): lib/cma/comp-provider.ts (comps supplement),
 *                 lib/avm/provider-chain.ts (AVM chain), lib/offers/public-
 *                 record-preload.ts (net-sheet tax line), lib/agentic-os/deal-
 *                 investigator.ts (deal synthesis). Tier ≠ off, tenant required,
 *                 no on-market opt-in (it is not a per-tenant list pull); each
 *                 caller keeps its own cheaper-first order (RentCast / cache /
 *                 free preview) and its own budget gate. Never a customer audience.
 *
 * ── PROVIDER CHOICE — PEOPLESEARCH vs BATCHDATA (wave 81 lane B) ────────────
 * Owner verbatim: "make sure that peoplesearch and batchdata don't overlap and if
 * they do then search which one is cheaper, then use that one. those capabilities
 * and scraping acquisition are platform paid." The audit (lane-81B notes, Exa
 * 2026-09-24) found ONE overlap — owner-contact discovery (phone/email append):
 *   · BatchData V3 skip trace — $0.07 per MATCHED record at the published
 *     pay-per-match floor (batchdata.io/pricing "pay per matched record";
 *     blog 2026-04-02 "$0.07–$0.18"), DNC/TCPA/litigator/deceased flags INLINE,
 *     property-keyed (owner name + property address).
 *   · PeopleData Labs Person Enrichment — $0.25–$0.28 per MATCH (support.
 *     peopledatalabs.com Pricing & credits 2025-10-24), person-keyed (name/
 *     email/phone/profile URL), carries demographics + employment + socials
 *     BatchData does not sell (the non-overlapping "person_profile" capability).
 * CONTACT_PROVIDER_ROUTES is the price table AS DATA, cheapest first per
 * capability, and resolveContactProviderRoute picks the order for ONE record by
 * what it carries: a record with a property address is traced by BatchData FIRST
 * and reaches PeopleData ONLY when BatchData returns nothing; a record keyed by
 * email/phone alone rides BatchData REVERSE skip trace first (wave 82 lane A —
 * lib/enrichment/reverse-skip-trace.ts, capability "reverse_contact"), PeopleData on a
 * miss; a name/handle alone still goes to PeopleData. DNC/TCPA, property
 * facts, motivated-seller lists and email validation do not overlap (one provider
 * each). The BatchData leg still declares purpose "skip_trace" through
 * resolveBatchDataAccess — this resolver chooses the ORDER, the gate stays ONE.
 * lib/osint-client.ts ("peoplesearch" as a scrape of truepeoplesearch/whitepages
 * through ZenRows) is a FROZEN scraper lane, audited only: it returns no
 * structured person record (records: [] by construction) and is not a provider
 * this table routes to. Every booking these providers make lands on
 * vendor_usage_tracking (the PLATFORM ledger, brokerage-attributed for telemetry)
 * and never on meter_readings / usage_counters (tenant metering) —
 * scripts/provider-cost-routing-guard.ts holds that.
 */

import type { BatchDataToolTier } from "@/lib/ai-isa/persona-tool-policy"
import { BATCHDATA_SKIP_TRACE_COST_USD, BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD } from "@/lib/external/batchdata-client"
import { PEOPLEDATA_MATCH_COST_USD, PEOPLEDATA_EMAIL_VALIDATE_COST_USD } from "@/lib/external/peopledata-client"
import { MCP_TOOL_CALL_COST_USD } from "@/lib/external/batchdata-ai-tools"
import { BATCHDATA_BILLED_PULL_OPT_IN } from "@/lib/buyer-search/listing-source-order"

/**
 * public_facts (wave 82 lane A) — owner verbatim: "the calculator was giving the property facts so
 * the calculator was calculating the correct property taxes, etc for the property landing pages".
 * The PUBLIC calculators (app/actions/calculators.ts — home value, the listing-page payment
 * estimate) need the tax bill, the county's assessed tax basis, HOA dues and the structure facts
 * for an ANONYMOUS visitor. Rungs: cache → tenant IDX → RentCast PROPERTY RECORD (/properties —
 * the one rung that carries tax bills + HOA) → public records. NEVER BatchData (not in
 * BATCHDATA_ELIGIBLE_PURPOSES). The ladder does not stop at the first answer for this purpose: a
 * hit without a tax bill continues to the next rung and fills only the missing fields
 * (PURPOSE_REQUIRED_FACTS). Output leaves the rail ONLY through toPublicPropertyFacts — a
 * WHITELIST that carries no owner identity, no contact point and no valuation figure.
 */
export type PropertyLookupPurpose = "conversation" | "listing_intake" | "acquisition" | "skip_trace" | "dnc" | "valuation" | "public_facts"
// Module-private (wave 79 integration, opposite-missing C3: the exported list had no
// reader). Its ONE reader is the entry gate below — a "use server" caller can hand the
// rail any string, and an unknown purpose must fail CLOSED, never fall to a rung.
const PROPERTY_LOOKUP_PURPOSES: readonly PropertyLookupPurpose[] = [
  "conversation", "listing_intake", "acquisition", "skip_trace", "dnc", "valuation", "public_facts",
]

/** Facts a purpose is not answered WITHOUT — the ladder keeps walking (filling gaps only) until
 *  they arrive or the rungs run out. Every other purpose stops at the first answer. */
const PURPOSE_REQUIRED_FACTS: Partial<Record<PropertyLookupPurpose, ReadonlyArray<keyof PropertyLookupFacts>>> = {
  public_facts: ["annualPropertyTax"],
}
function isPropertyLookupPurpose(v: unknown): v is PropertyLookupPurpose {
  return typeof v === "string" && (PROPERTY_LOOKUP_PURPOSES as readonly string[]).includes(v)
}

/** The owner's carve-out (wave 79: acquisition / skip-trace / DNC) plus the wave-70
 *  staff valuation lane (comps supplement): the ONLY purposes that may ever reach
 *  BatchData. A conversation or a listing intake never does. */
export const BATCHDATA_ELIGIBLE_PURPOSES: ReadonlySet<PropertyLookupPurpose> = new Set<PropertyLookupPurpose>([
  "acquisition", "skip_trace", "dnc", "valuation",
])

// ─── PROVIDER CHOICE TABLE (data, cheapest first) ───────────────────────────

export type ContactDataProvider = "batchdata" | "peopledata"

/** The capabilities the two providers sell, named by the QUESTION a caller asks. */
export type ProviderCapability =
  | "owner_contact"          // phone / email / mailing append for a person or a property owner
  | "reverse_contact"        // PERSON-keyed (phone/email [+ name]) → who it is + contact points + linked property (wave 82 lane A)
  | "person_profile"         // demographics, employment, socials, life events for a known person
  | "dnc_tcpa"               // DNC / TCPA-litigator / line-type scrub of a phone number
  | "email_validation"       // is this address deliverable / role / disposable
  | "property_facts"         // beds/baths/sqft/year/lot for an address (the rail's rung 5)
  | "motivated_seller_list"  // quicklist pulls (pre-foreclosure, absentee, vacant, …)

export interface ProviderRouteEntry {
  provider: ContactDataProvider
  /** Documented per-unit USD (the constant the ledger books) — a cost ORDER, never an invoice. */
  unitCostUsd: number
  /** What the provider needs to be asked with. */
  keyedBy: "property_address" | "person_identifier" | "phone" | "email" | "geography"
}

/**
 * THE ONE PRICE TABLE, cheapest first per capability. scripts/provider-cost-
 * routing-guard.ts asserts (a) every list is sorted ascending by unitCostUsd, (b)
 * owner_contact's first provider is the cheaper of the two, (c) every unit cost is
 * the SAME constant the transport books (no second spelling), (d) the capabilities
 * that do not overlap name exactly one provider.
 */
export const CONTACT_PROVIDER_ROUTES: Readonly<Record<ProviderCapability, readonly ProviderRouteEntry[]>> = {
  owner_contact: [
    { provider: "batchdata", unitCostUsd: BATCHDATA_SKIP_TRACE_COST_USD, keyedBy: "property_address" },
    { provider: "peopledata", unitCostUsd: PEOPLEDATA_MATCH_COST_USD, keyedBy: "person_identifier" },
  ],
  // Wave 82 lane A ("build a reverse skip trace wrapper"): BatchData reverse skip trace bills
  // "by matched records, not by API calls" (batchdata.io/reverse-skip-trace-api) at the SAME
  // pay-per-match floor as the V3 skip trace — one constant, no second spelling (§6). PeopleData
  // stays the fallback on a miss. Wrapper: lib/enrichment/reverse-skip-trace.ts.
  reverse_contact: [
    { provider: "batchdata", unitCostUsd: BATCHDATA_SKIP_TRACE_COST_USD, keyedBy: "phone" },
    { provider: "peopledata", unitCostUsd: PEOPLEDATA_MATCH_COST_USD, keyedBy: "person_identifier" },
  ],
  person_profile: [
    { provider: "peopledata", unitCostUsd: PEOPLEDATA_MATCH_COST_USD, keyedBy: "person_identifier" },
  ],
  dnc_tcpa: [
    { provider: "batchdata", unitCostUsd: MCP_TOOL_CALL_COST_USD, keyedBy: "phone" },
  ],
  email_validation: [
    { provider: "peopledata", unitCostUsd: PEOPLEDATA_EMAIL_VALIDATE_COST_USD, keyedBy: "email" },
  ],
  property_facts: [
    { provider: "batchdata", unitCostUsd: MCP_TOOL_CALL_COST_USD, keyedBy: "property_address" },
  ],
  motivated_seller_list: [
    { provider: "batchdata", unitCostUsd: BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD, keyedBy: "geography" },
  ],
}

/** What ONE record carries — the resolver picks the provider order from this, never
 *  from a vendor preference. */
export interface ContactRouteInput {
  hasName: boolean
  hasPropertyAddress: boolean
  hasEmailOrPhone: boolean
  hasProfileUrl: boolean
}

export interface ContactProviderRoute {
  /** owner_contact = property-keyed (V3 skip trace); reverse_contact = person-keyed (phone/email →
   *  BatchData REVERSE skip trace). The BatchData SHAPE follows the capability. */
  capability: "owner_contact" | "reverse_contact"
  /** Providers to try IN ORDER; the next runs only when the previous returned nothing. */
  providers: readonly ContactDataProvider[]
  reason: string
}

/**
 * PURE — the contact route for ONE record. Cheapest adequate provider first; the dearer one only
 * as a fallback when the cheaper one cannot be asked (input shape) or returned nothing (the
 * caller's job to fall through). Empty = refused.
 *   property address          → owner_contact:   BatchData V3 skip trace → PeopleData
 *   no address, phone/email   → reverse_contact: BatchData REVERSE skip trace → PeopleData (wave 82 A)
 *   name / profile URL only   → owner_contact:   PeopleData (BatchData has nothing to be asked with)
 */
export function resolveContactProviderRoute(input: ContactRouteInput): ContactProviderRoute {
  const pdlUsable = input.hasName || input.hasEmailOrPhone || input.hasProfileUrl
  if (!input.hasPropertyAddress && input.hasEmailOrPhone) {
    const providers = CONTACT_PROVIDER_ROUTES.reverse_contact.map((e) => e.provider)
    return {
      capability: "reverse_contact",
      providers,
      reason: `no property address but a phone/email → BatchData REVERSE skip trace first ($${BATCHDATA_SKIP_TRACE_COST_USD}/match); PeopleData ($${PEOPLEDATA_MATCH_COST_USD}/match) only when BatchData returns nothing`,
    }
  }
  const bdUsable = input.hasPropertyAddress // V3 skip trace is property-keyed; owner name optional
  const ordered = CONTACT_PROVIDER_ROUTES.owner_contact
    .filter((e) => (e.provider === "batchdata" ? bdUsable : pdlUsable))
    .map((e) => e.provider)
  if (ordered.length === 0) {
    return { capability: "owner_contact", providers: [], reason: "no identifier — neither a property address (BatchData) nor a name/email/phone/profile (PeopleData) to trace from" }
  }
  const reason = ordered[0] === "batchdata"
    ? `property address present → BatchData first ($${BATCHDATA_SKIP_TRACE_COST_USD}/match)${ordered.length > 1 ? `; PeopleData ($${PEOPLEDATA_MATCH_COST_USD}/match) only when BatchData returns nothing` : "; no PeopleData identifier"}`
    : `no property address and no phone/email → BatchData cannot be asked (V3 is property-keyed, reverse is phone/email-keyed); PeopleData ($${PEOPLEDATA_MATCH_COST_USD}/match) is the only adequate provider`
  return { capability: "owner_contact", providers: ordered, reason }
}

/** "public" (wave 82 lane A) — an anonymous visitor on a public page (calculators, listing
 *  landing pages). Keeps the county's assessed TAX BASIS (the calculators need it and it is a
 *  public record), strips every valuation-shaped figure; the public projection
 *  (toPublicPropertyFacts) then whitelists what may leave. */
export type PropertyLookupAudience = "customer" | "staff" | "public"

export type PropertyLookupRung = "cache" | "tenant_idx" | "rentcast" | "public_records" | "batchdata"

/** THE ONE SOURCE VOCABULARY (§6) for "where did these facts come from": every
 *  rung, plus the listing-intake AI estimate — which is not a rung (it looks
 *  nothing up) and never runs for any other purpose. */
export type PropertyLookupSource = PropertyLookupRung | "ai_estimate"

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
  /** County assessed value. STRIPPED for a customer audience (it reads as a value); kept for a
   *  public audience as the labelled TAX BASIS the calculators need. */
  taxAssessedValue: number | null
  /** Most recent annual property-tax bill in dollars (public record) and its year — wave 82 lane A. */
  annualPropertyTax: number | null
  propertyTaxYear: number | null
  /** Monthly HOA dues in dollars when known (own listing's hoa_dues, RentCast hoa.fee, public records). */
  hoaMonthly: number | null
  mlsNumber: string | null
  listingUrl: string | null
  /** Geocode (free, Nominatim survivor) — filled on the listing_intake path; null elsewhere. */
  lat: number | null
  lon: number | null
  /** true ONLY for the listing-intake AI estimate — the UI shows "verify before publishing". */
  isEstimate: boolean
  source: PropertyLookupSource
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
  if (audience === "public") return { ...facts, estimatedValue: null }
  return { ...facts, estimatedValue: null, taxAssessedValue: null }
}

// ─── PUBLIC FACTS PROJECTION (wave 82 lane A) ───────────────────────────────

/** The ONLY fields that may leave the rail for an anonymous public page. A WHITELIST, so a field
 *  added to PropertyLookupFacts later (or an owner/contact/value field a rung ever carries) cannot
 *  reach a visitor by default — scripts/public-property-facts-guard.ts holds the list. */
export const PUBLIC_PROPERTY_FACT_FIELDS = [
  "address", "city", "state", "zip", "beds", "baths", "sqft", "yearBuilt", "lotSize", "propertyType",
  "listingStatus", "listPrice", "annualPropertyTax", "propertyTaxYear", "hoaMonthly", "source", "sourceNote",
] as const satisfies ReadonlyArray<keyof PropertyLookupFacts>

export type PublicPropertyFacts = Pick<PropertyLookupFacts, (typeof PUBLIC_PROPERTY_FACT_FIELDS)[number]> & {
  /** The county's assessed value — the TAX BASIS, labelled so it can never be read as a market value. */
  assessedValueForTax: number | null
}

/** PURE — the whitelist projection. Nothing outside PUBLIC_PROPERTY_FACT_FIELDS is copied. */
export function toPublicPropertyFacts(facts: PropertyLookupFacts): PublicPropertyFacts {
  const out = {} as Record<string, unknown>
  for (const k of PUBLIC_PROPERTY_FACT_FIELDS) out[k] = facts[k] ?? null
  out.assessedValueForTax = facts.taxAssessedValue ?? null
  return out as PublicPropertyFacts
}

/** PURE — fill ONLY the null fields of `base` from `more` (first rung's source is kept). */
function fillMissingFacts(base: PropertyLookupFacts, more: PropertyLookupFacts): PropertyLookupFacts {
  const merged = { ...base } as Record<string, unknown>
  const extra = more as unknown as Record<string, unknown>
  for (const [k, v] of Object.entries(extra)) {
    if (k === "source" || k === "sourceNote" || k === "isEstimate") continue
    if (merged[k] == null && v != null) merged[k] = v
  }
  merged.sourceNote = `${base.sourceNote} Gaps filled from ${more.source}.`
  return merged as unknown as PropertyLookupFacts
}

/** PURE — one normalised street line for a case-insensitive own-DB match. */
export function normalizeStreetLine(street: string): string {
  return street.trim().toLowerCase().replace(/\s+/g, " ").replace(/[.,]/g, "")
}

/** PURE — the full one-line address RentCast/public-records readers take. */
export function formatFullAddress(a: PropertyLookupAddress): string {
  return [a.street, a.city, a.state, a.zip].map((v) => (v ?? "").trim()).filter(Boolean).join(", ")
}

/** PURE — the inverse for callers that hold ONE line ("123 Main St, Austin, TX 78701"):
 *  street is everything before the first comma; a trailing "ST 12345" splits into
 *  state + zip; the middle is the city. Anything unparsed stays on the street line
 *  so the cache rung's ilike still matches. */
export function splitOneLineAddress(line: string): PropertyLookupAddress {
  const parts = line.split(",").map((p) => p.trim()).filter(Boolean)
  if (parts.length === 0) return { street: line.trim() }
  const street = parts[0]
  let city: string | null = null, state: string | null = null, zip: string | null = null
  const tail = parts.slice(1)
  const last = tail[tail.length - 1] ?? ""
  const m = last.match(/^([A-Za-z]{2})(?:\s+(\d{5}(?:-\d{4})?))?$/)
  if (m) { state = m[1].toUpperCase(); zip = m[2] ?? null; tail.pop() }
  else { const z = last.match(/^(\d{5}(?:-\d{4})?)$/); if (z) { zip = z[1]; tail.pop() } }
  if (tail.length > 0) city = tail.join(", ")
  return { street, city, state, zip }
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v.replace(/[$,]/g, "")) : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)

function emptyFacts(source: PropertyLookupSource, sourceNote: string): PropertyLookupFacts {
  return {
    address: null, city: null, state: null, zip: null, beds: null, baths: null, sqft: null, yearBuilt: null,
    lotSize: null, propertyType: null, listingStatus: null, listPrice: null, estimatedValue: null,
    taxAssessedValue: null, annualPropertyTax: null, propertyTaxYear: null, hoaMonthly: null,
    mlsNumber: null, listingUrl: null, lat: null, lon: null, isEstimate: false, source, sourceNote,
  }
}

// ─── LISTING-INTAKE EXTRAS (merged from lib/property/enrichment-chain.ts) ───

/** The fields the listing-intake AI estimate may fill. FACTS ONLY — no value,
 *  no rent, no walk score: a model-guessed figure is not a home value (§5). */
export const AI_ESTIMATE_FACT_FIELDS = ["beds", "baths", "sqft", "yearBuilt", "lotSize", "propertyType"] as const
export type AiEstimateFacts = Pick<PropertyLookupFacts, (typeof AI_ESTIMATE_FACT_FIELDS)[number]>

export type PropertyGeocodeFn = (address: PropertyLookupAddress) => Promise<{ lat: number; lon: number } | null>
export type PropertyEstimateFn = (req: PropertyLookupRequest) => Promise<AiEstimateFacts | null>

/** PURE — only an agent entering their own listing gets a labelled guess. */
export function isAiEstimateAllowed(purpose: PropertyLookupPurpose, audience: PropertyLookupAudience): boolean {
  return purpose === "listing_intake" && audience === "staff"
}

/** I/O — the canonical free geocoder (lib/external/nominatim-geocode.ts::geocodeOne). */
async function productionGeocode(address: PropertyLookupAddress): Promise<{ lat: number; lon: number } | null> {
  const { geocodeOne } = await import("@/lib/external/nominatim-geocode")
  const p = await geocodeOne({ address: address.street, city: address.city, state: address.state, zip: address.zip })
  return p ? { lat: p.lat, lon: p.lng } : null
}

/** I/O — the last-resort estimate, booked to ai_tool_usage under the tenant
 *  by generateObjectRouted (the old chain's `generateObject` shim booked nothing). */
async function productionEstimate(req: PropertyLookupRequest): Promise<AiEstimateFacts | null> {
  const [{ generateObjectRouted }, { z }] = await Promise.all([import("@/lib/ai/models"), import("zod")])
  const { object } = await generateObjectRouted({
    feature: "listing_intake_property_estimate",
    brokerageId: req.brokerageId,
    userId: req.userId ?? null,
    schema: z.object({
      beds: z.number().nullable(), baths: z.number().nullable(), sqft: z.number().nullable(),
      yearBuilt: z.number().nullable(), lotSize: z.number().nullable(),
      propertyType: z.enum(["single_family", "condo", "townhouse", "multi_family", "land"]).nullable(),
    }),
    prompt: `You are a real estate data analyst. No public record was found for: ${formatFullAddress(req.address)}. Estimate ONLY the physical facts of a typical home at that address (beds, baths, square feet, year built, lot size in acres, property type). Return null for anything you cannot reasonably estimate. Do NOT estimate a value, a rent or a score.`,
  })
  return {
    beds: num(object.beds), baths: num(object.baths), sqft: num(object.sqft), yearBuilt: num(object.yearBuilt),
    lotSize: num(object.lotSize), propertyType: str(object.propertyType),
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
    .select("address, city, state, zip, bedrooms, bathrooms, sqft, year_built, lot_size, property_type, status, list_price, mls_number, hoa_dues")
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
      // listings.hoa_dues is MONTHLY (app/actions/portal-seller.ts reads it as hoaDuesMonthly).
      hoaMonthly: num(l.hoa_dues),
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
  if (req.purpose === "public_facts") {
    // The PROPERTY RECORD endpoint (/properties) — the one RentCast shape that carries the tax
    // bill, the assessed tax basis and the HOA fee. Same gate, same meter, same price per request
    // as the listing search below; its reader is a whitelist that never maps the owner block.
    const { getRentcastPropertyRecord } = await import("@/lib/property/rentcast")
    const p = await getRentcastPropertyRecord({
      brokerageId: req.brokerageId, systemSource: "public_calculator", contactId: req.contactId ?? null,
      address: formatFullAddress(req.address),
    })
    if (!p) return null
    return {
      ...emptyFacts("rentcast", "From RentCast's public property record (county assessor data; platform-metered)."),
      address: p.address, city: p.city, state: p.state, zip: p.zip,
      beds: p.bedrooms, baths: p.bathrooms, sqft: p.squareFeet, yearBuilt: p.yearBuilt,
      // RentCast reports lotSize in SQUARE FEET; the rail's lotSize is acres (address-lookup's unit).
      lotSize: p.lotSizeSqft != null ? Math.round((p.lotSizeSqft / 43560) * 100) / 100 : null,
      propertyType: p.propertyType, taxAssessedValue: p.assessedValue,
      annualPropertyTax: p.annualPropertyTax, propertyTaxYear: p.taxYear, hoaMonthly: p.hoaMonthly,
    }
  }
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
  if (r.beds == null && r.sqft == null && r.yearBuilt == null && r.annualPropertyTax == null) return null
  return {
    ...emptyFacts("public_records", `From public records (${r.sources.join(", ") || "county/public pages"}; confidence ${r.dataConfidence}).`),
    address: req.address.street, city: req.address.city ?? null, state: req.address.state ?? null, zip: req.address.zip ?? null,
    beds: r.beds, baths: r.baths, sqft: r.sqft, yearBuilt: r.yearBuilt, lotSize: r.lotSizeAcres,
    propertyType: r.propertyType, taxAssessedValue: r.taxAssessedValue,
    annualPropertyTax: num(r.annualPropertyTax), hoaMonthly: num(r.hoaMonthlyFee),
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
    // ONE code-side name for the stored "batchdata_on_market" flag (listing-source-order.ts).
    batchDataOptedIn = (await resolveActiveListingSources(brokerageId)).includes(BATCHDATA_BILLED_PULL_OPT_IN)
  } catch { batchDataOptedIn = false }
  return { batchDataTier, batchDataOptedIn }
}

export interface PropertyLookupDeps {
  rungs?: Partial<PropertyLookupRungs>
  policy?: PropertyLookupPolicy
  /** listing_intake only — injectable so the proof runs with zero network. */
  geocode?: PropertyGeocodeFn
  estimate?: PropertyEstimateFn
}

// ─── THE ONE BATCHDATA GATE (non-facts shapes: skip trace, DNC, list pulls) ──

export interface BatchDataAccess {
  allowed: boolean
  purpose: PropertyLookupPurpose
  reason: string
}

/** PURE — the per-purpose carve-out over the two policy facts (header: ONE GATE). */
export function decideBatchDataAccess(
  req: { brokerageId?: string | null; purpose: PropertyLookupPurpose },
  policy: PropertyLookupPolicy,
): BatchDataAccess {
  const { purpose } = req
  if (!isPropertyLookupPurpose(purpose)) {
    return { allowed: false, purpose, reason: `purpose "${String(purpose)}" is not one of ${PROPERTY_LOOKUP_PURPOSES.join("/")} — refused, fail closed` }
  }
  if (!BATCHDATA_ELIGIBLE_PURPOSES.has(purpose)) {
    return { allowed: false, purpose, reason: `purpose "${purpose}" never reaches BatchData (reserved for acquisition / skip-trace / DNC / staff valuation)` }
  }
  if (purpose === "dnc") return { allowed: true, purpose, reason: "DNC/TCPA compliance scrub — never refused by a spend policy; the MCP wrapper reports unconfigured" }
  if (!req.brokerageId) return { allowed: false, purpose, reason: "no tenant on the request — a tenant-less billed BatchData reach is refused (§4)" }
  if (policy.batchDataTier === "off") return { allowed: false, purpose, reason: "BatchData tier is off (configured off, or the platform monthly cap is spent)" }
  if (purpose === "acquisition" && policy.batchDataOptedIn !== true) {
    return { allowed: false, purpose, reason: `tenant not opted into billed BatchData pulls by platform staff (${BATCHDATA_BILLED_PULL_OPT_IN})` }
  }
  const reason = purpose === "acquisition" ? "acquisition under tier + platform-staff opt-in"
    : purpose === "valuation" ? "staff valuation / deal analytics under tier (platform-wide cap; the caller's own cheaper-first order and budget gate still apply)"
    : "skip trace under tier (platform-wide cap)"
  return { allowed: true, purpose, reason }
}

/**
 * I/O — THE gate every non-facts BatchData caller passes first. Reads the same
 * policy the facts rung reads (FAIL CLOSED on an unreadable policy) and applies
 * decideBatchDataAccess. `deps.policy` lets a proof inject the policy.
 */
export async function resolveBatchDataAccess(
  req: { brokerageId?: string | null; purpose: PropertyLookupPurpose },
  deps: { policy?: PropertyLookupPolicy } = {},
): Promise<BatchDataAccess> {
  if (req.purpose === "dnc" || !BATCHDATA_ELIGIBLE_PURPOSES.has(req.purpose)) {
    // No policy read needed: DNC is never spend-gated and an ineligible purpose is refused outright.
    return decideBatchDataAccess(req, deps.policy ?? { batchDataTier: "off", batchDataOptedIn: false })
  }
  const policy = deps.policy ?? (await readProductionPolicy(req.brokerageId ?? ""))
  return decideBatchDataAccess(req, policy)
}

/**
 * THE rail. Walks PROPERTY_LOOKUP_RUNG_ORDER cheapest-first and returns the
 * first rung's facts, redacted for the audience. A rung that throws is
 * recorded as skipped and the ladder continues — a dark vendor never fails
 * the lookup, it just costs the next rung. The batchdata rung is consulted
 * ONLY when isBatchDataRungAllowed(purpose, policy) holds.
 *
 * listing_intake (staff audience) adds two things AFTER the ladder: the free
 * geocode fills lat/lon on whatever was found, and when every rung missed a
 * FACTS-ONLY AI estimate is returned flagged isEstimate (never for any other
 * purpose — a customer conversation gets "not found" and the value-review
 * offer, never a guess).
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
        result.skipped.push({ rung, reason: `purpose "${req.purpose}" never reaches BatchData (reserved for acquisition / skip-trace / DNC / staff valuation)` })
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
        const redacted = redactFactsForAudience(facts, req.audience)
        result.facts = result.facts ? fillMissingFacts(result.facts, redacted) : redacted
        // Stop at the first answer — unless this purpose names facts it is not answered without
        // (public_facts needs the tax bill): then keep walking, filling gaps only.
        const required = PURPOSE_REQUIRED_FACTS[req.purpose] ?? []
        if (required.every((k) => result.facts?.[k] != null)) break
      }
    } catch (e) {
      result.skipped.push({ rung, reason: `rung failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  if (!isAiEstimateAllowed(req.purpose, req.audience)) return result

  // ── listing_intake extras (merged from enrichment-chain.ts) ──
  if (!result.facts) {
    try {
      const est = await (deps.estimate ?? productionEstimate)(req)
      if (est && (est.beds != null || est.sqft != null || est.yearBuilt != null)) {
        result.found = true
        result.facts = {
          ...emptyFacts("ai_estimate", "AI estimate — verify before publishing. No property record was found for this address."),
          address: req.address.street, city: req.address.city ?? null, state: req.address.state ?? null, zip: req.address.zip ?? null,
          beds: est.beds, baths: est.baths, sqft: est.sqft, yearBuilt: est.yearBuilt, lotSize: est.lotSize, propertyType: est.propertyType,
          isEstimate: true,
        }
      }
    } catch (e) {
      result.skipped.push({ rung: "public_records", reason: `ai estimate failed: ${e instanceof Error ? e.message : String(e)}` })
    }
  }
  if (result.facts && (result.facts.lat == null || result.facts.lon == null)) {
    try {
      const g = await (deps.geocode ?? productionGeocode)(req.address)
      if (g) result.facts = { ...result.facts, lat: g.lat, lon: g.lon }
    } catch { /* a failed free geocode costs nothing and changes nothing */ }
  }
  return result
}

// ─── THE PUBLIC ENTRY (wave 82 lane A) ──────────────────────────────────────

export interface PublicPropertyFactsResult {
  found: boolean
  facts: PublicPropertyFacts | null
  rungsTried: PropertyLookupRung[]
  skipped: Array<{ rung: PropertyLookupRung; reason: string }>
}

/**
 * THE one door a public page (anonymous visitor) uses for property facts: purpose
 * "public_facts", audience "public", output through the toPublicPropertyFacts WHITELIST only.
 * The caller supplies the tenant it RESOLVED (session, an agent's public slug, or the listing
 * row a public listing slug names — never a body uuid, §4); a tenant-less call is refused by
 * the rail. BatchData is never reached (public_facts is not an eligible purpose).
 */
export async function lookupPublicPropertyFacts(
  req: { brokerageId: string; address: PropertyLookupAddress; contactId?: string | null },
  deps: PropertyLookupDeps = {},
): Promise<PublicPropertyFactsResult> {
  const r = await lookupPropertyForConversation(
    { brokerageId: req.brokerageId, purpose: "public_facts", audience: "public", address: req.address, contactId: req.contactId ?? null },
    deps,
  )
  return { found: r.found, facts: r.facts ? toPublicPropertyFacts(r.facts) : null, rungsTried: r.rungsTried, skipped: r.skipped }
}
