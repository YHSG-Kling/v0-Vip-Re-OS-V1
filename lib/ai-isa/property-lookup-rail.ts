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
 * were never consulted first. This file is the ladder, cheapest ADEQUATE rung first,
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
 *   3. rentcast       — the ONE RentCast client (lib/property/rentcast.ts).
 *                       WAVE 92 (lane 92B, owner: "also can use it for a
 *                       simple property lookup … this is supposed to run for
 *                       the full platform"): the PROPERTY RECORD
 *                       (getRentcastPropertyRecord, /properties — ~140M
 *                       assessor records, so an unlisted home resolves too) is
 *                       the rung for every purpose; a customer CONVERSATION
 *                       asks the single-address LISTING first (a buyer asking
 *                       about a home for sale is owed its list price and
 *                       status) and falls to the record. RENTCAST_USD_PER_
 *                       REQUEST ≈ $0.074/request, metered by the reader, the
 *                       record cached 30 days. A property-data read is no
 *                       longer suppressed by a tenant IDX connection
 *                       (rentcast-eligibility.ts readKind); budget still is.
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
 *   valuation      — WAVE 92 (lane 92B): NO LONGER a BatchData purpose. Owner
 *                    (2026-10-01): "use rentcast as much as possible regarding
 *                    … comparable, home values" · "batchdata is to be used
 *                    more for scrapping leads." Every former valuation caller
 *                    (CMA comps supplement, AVM chain, net-sheet tax preload,
 *                    deal investigator) now reads RentCast; the purpose stays
 *                    in the vocabulary and is REFUSED by the gate, so a
 *                    regression cannot quietly reopen the reach.
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
 *   valuation   — FALLBACK ONLY since wave 93 (lane 93B, owner: "use batchdata as a backup"):
 *                 admitted only with `afterRentcastMiss` in BATCHDATA_FALLBACK_MISS_REASONS, from the
 *                 server-side provider chain (lib/avm/provider-chain.ts); never a primary, never
 *                 the conversation rail. As a PRIMARY it is REFUSED since wave 92 (lane 92B). It was (wave 81 lane B) the
 *                 STAFF valuation lane the owner admitted in wave 70; its four
 *                 callers — lib/cma/comp-provider.ts (comps supplement → RentCast
 *                 widened search), lib/avm/provider-chain.ts (AVM chain → the
 *                 RentCast leg), lib/offers/public-record-preload.ts (tax line →
 *                 the RentCast record), lib/agentic-os/deal-investigator.ts
 *                 (→ the RentCast record) — no longer import BatchData at all.
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

import type { EnrichmentDecision } from "@/lib/kernel/resource-allocation"
import type { BatchDataToolTier } from "@/lib/ai-isa/persona-tool-policy"
import { BATCHDATA_SKIP_TRACE_COST_USD, BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD } from "@/lib/external/batchdata-client"
import { PEOPLEDATA_MATCH_COST_USD, PEOPLEDATA_EMAIL_VALIDATE_COST_USD } from "@/lib/external/peopledata-client"
import { MCP_TOOL_CALL_COST_USD } from "@/lib/external/batchdata-ai-tools"
import {
  VERSIUM_MATCH_CREDIT_USD, type VersiumIdentity, type VersiumContactCall, type VersiumDemographicCall, type VersiumProvenance,
  // Wave 142 (lane 142D): the B2B2C crosswalk + the full-demographic real-estate indicators (audited in the adapter).
  type VersiumB2B2CIdentity, type VersiumB2B2COutput, type VersiumB2B2CCall, type VersiumFullDemographicCall, type VersiumRealEstateIndicators,
  // Wave 143 (lane 143D): the published credit weights drive the pre-flight worst case (a bill is a number, not a guess), and the
  // free audience-size estimate is the sixth Versium capability on this rail (owner_contact, reverse_contact, property_facts,
  // business_identity, online_presence, audience_estimate).
  VERSIUM_CREDIT_WEIGHTS, versiumCreditsUsd, versiumB2B2CWorstCaseCredits,
  type VersiumAudienceFilters, type VersiumAudienceEstimate, type VersiumEstimateCall,
  // Wave 144 (lane 144E): the Online Audience MATCH + APPEND — the seventh Versium capability on this rail (online_audience_match).
  VERSIUM_ONLINE_AUDIENCE_WORST_CASE_CREDITS,
  type VersiumOnlineAudienceCall, type VersiumOnlineAudienceIdentifiers, type VersiumOnlineAudienceService,
} from "@/lib/external/versium-client"
import { BATCHDATA_BILLED_PULL_OPT_IN } from "@/lib/buyer-search/listing-source-order"
import { MAPBOX_SKU_USD, GOOGLE_MAPS_SKU_USD } from "@/lib/vendor-governance/cost-normalizer"

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

/** The owner's carve-out (wave 79: acquisition / skip-trace / DNC): the ONLY purposes that may
 *  ever reach BatchData — LEAD work. A conversation, a listing intake, public facts or a
 *  valuation never does. Wave 92 (lane 92B) struck "valuation" (the wave-70 staff comps/AVM lane
 *  admitted by 81B): owner 2026-10-01 "batchdata is to be used more for scrapping leads" — its
 *  four callers read RentCast now (header). */
export const BATCHDATA_ELIGIBLE_PURPOSES: ReadonlySet<PropertyLookupPurpose> = new Set<PropertyLookupPurpose>([
  "acquisition", "skip_trace", "dnc",
])

/**
 * WAVE 93 (lane 93B) — BATCHDATA AS THE BACKUP. Owner, verbatim (2026-10-01): "use batchdata as a
 * backup." The "valuation" purpose is RE-OPENED FOR THE FALLBACK PATH ONLY: a property read
 * (lookup, home value, comps) reaches BatchData only when the SERVER-SIDE provider chain
 * (lib/avm/provider-chain.ts::batchDataPropertyFallback) names the RentCast miss that sent it
 * there, and only for a miss in BATCHDATA_FALLBACK_MISS_REASONS. It stays OUT of
 * BATCHDATA_ELIGIBLE_PURPOSES, so the conversation rail (every AI agent's lookup_property_facts)
 * never reaches a BatchData rung — agents keep RentCast; only the server-side chain falls back.
 *
 * Why a miss, and which:
 *   unconfigured — the platform RentCast key is unset (the whole lane is dark).
 *   error        — RentCast answered non-2xx (incl. a 429/402 plan-quota refusal) or threw.
 *   no_record    — RentCast answered and had nothing for this address.
 *   over_budget  — DELIBERATELY NOT A FALLBACK TRIGGER. The vendor budget gate is per TENANT and
 *                  sums EVERY vendor (lib/vendor-governance/budget-gate.ts); a tenant over it would
 *                  be billed a second paid vendor against the same spent cap. The ladder rule
 *                  (vendor-policy.ts: "the cap throttles COST, not CAPABILITY") routes it to the
 *                  FREE tiers instead. Adding "over_budget" to the set below is the one-line switch
 *                  if the owner wants the paid backup anyway.
 */
export type RentcastMissReason = "unconfigured" | "over_budget" | "error" | "no_record"
export const BATCHDATA_FALLBACK_MISS_REASONS: ReadonlySet<RentcastMissReason> = new Set<RentcastMissReason>([
  "unconfigured", "error", "no_record",
])

// ─── PROVIDER CHOICE TABLE (data, cheapest first) ───────────────────────────

// Wave 93 (lane 93B2): "versium" joins — the EXISTING vendor (household financials) now also sells
// the owner/person email + phone append, cheapest per match (owner cost decision, header of
// runVersiumContactLeg below).
// Wave 99 (lane 99C, LAW 3 "agents request capabilities, not vendors"): "rentcast" joins as the
// PRIMARY of the property_valuation capability — the AVM chain now routes through this same table.
// Wave 140 (lane 140I, owner: "MAPBOX IS REQUIRED … one map subsystem"): the MAP providers ride the SAME
// router (map_render below) — the name stays (two importers; a rename is a rewrite), the union widens.
export type ContactDataProvider = "versium" | "batchdata" | "peopledata" | "rentcast" | "mapbox" | "google_maps"

/** The capabilities the two providers sell, named by the QUESTION a caller asks. */
export type ProviderCapability =
  | "owner_contact"          // phone / email / mailing append for a person or a property owner
  | "reverse_contact"        // PERSON-keyed (phone/email [+ name]) → who it is + contact points + linked property (wave 82 lane A)
  | "person_profile"         // demographics, employment, socials, life events for a known person
  | "dnc_tcpa"               // DNC / TCPA-litigator / line-type scrub of a phone number
  | "email_validation"       // is this address deliverable / role / disposable
  | "property_facts"         // beds/baths/sqft/year/lot for an address (the rail's rung 5)
  | "motivated_seller_list"  // quicklist pulls (pre-foreclosure, absentee, vacant, …)
  | "property_valuation"     // "what is this home worth?" — AVM point + range (wave 99, lane 99C)
  | "map_render"             // a map of coordinates — static image or browser tiles (wave 140, lane 140I)
  | "business_identity"      // a BUSINESS identity (LinkedIn URL / name + city + state) ↔ its consumer contact points — the B2B2C crosswalk (wave 142, lane 142D)
  | "online_presence"        // observed online real-estate activity + property/behaviour indicators for a known person (wave 142, lane 142D)
  | "audience_estimate"      // HOW MANY people match a geography + housing-fact lead-gen filter — a FREE COUNT with provenance, never a contact, never a purchase (wave 143, lane 143D; 144E: a count for any lawful lead-gen criteria, not look-alike research only)
  | "online_audience_match"  // WHICH online (ad-platform) identifiers belong to a person we already hold — hashed IDs APPENDED to the record; NOT targeting, never an e-mail/SMS address (wave 144, lane 144E)

export interface ProviderRouteEntry {
  provider: ContactDataProvider
  /** Documented per-unit USD (the constant the ledger books) — a cost ORDER, never an invoice. */
  unitCostUsd: number
  /** What the provider needs to be asked with. */
  keyedBy: "property_address" | "person_identifier" | "phone" | "email" | "geography" | "coordinates"
}

/** RENTCAST_USD_PER_REQUEST (lib/property/rentcast.ts), Foundation plan; $0.018 at Scale — ONE spelling
 *  in this file, read by the property_valuation route AND the rentcast rung cost below (the rail does
 *  not import the RentCast client statically; scripts/provider-cost-routing-guard.ts asserts equality). */
const RENTCAST_REQUEST_USD = 0.074

/**
 * THE ONE PRICE TABLE, cheapest first per capability. scripts/provider-cost-
 * routing-guard.ts asserts (a) every list is sorted ascending by unitCostUsd, (b)
 * owner_contact's first provider is the cheaper of the two, (c) every unit cost is
 * the SAME constant the transport books (no second spelling), (d) the capabilities
 * that do not overlap name exactly one provider.
 */
export const CONTACT_PROVIDER_ROUTES: Readonly<Record<ProviderCapability, readonly ProviderRouteEntry[]>> = {
  owner_contact: [
    // Wave 93 (lane 93B2): VERSIUM FIRST — 1 match credit per matched output (credit-package ceiling
    // $0.05; a no-match is free), asked by name + geography / address / email / phone.
    { provider: "versium", unitCostUsd: VERSIUM_MATCH_CREDIT_USD, keyedBy: "person_identifier" },
    { provider: "batchdata", unitCostUsd: BATCHDATA_SKIP_TRACE_COST_USD, keyedBy: "property_address" },
    { provider: "peopledata", unitCostUsd: PEOPLEDATA_MATCH_COST_USD, keyedBy: "person_identifier" },
  ],
  // Wave 82 lane A ("build a reverse skip trace wrapper"): BatchData reverse skip trace bills
  // "by matched records, not by API calls" (batchdata.io/reverse-skip-trace-api) at the SAME
  // pay-per-match floor as the V3 skip trace — one constant, no second spelling (§6). PeopleData
  // stays the fallback on a miss. Wrapper: lib/enrichment/reverse-skip-trace.ts.
  reverse_contact: [
    { provider: "versium", unitCostUsd: VERSIUM_MATCH_CREDIT_USD, keyedBy: "person_identifier" },
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
  // Wave 138 (lane 138A, owner: "Versium (ALSO a property-data provider)"): Versium's demographic /
  // property append is the THIRD property-data source — BEHIND BatchData here (equal unit price, so
  // cheapest-first holds and table order breaks the tie) and absent from property_valuation, whose
  // owner order (RentCast primary, BatchData backup) is not reordered. Same transport constant the
  // Versium adapter books (VERSIUM_MATCH_CREDIT_USD; a no-match is free).
  // Wave 139 (lane 139D): WALKED by lib/avm/provider-chain.ts fillPropertyFactGaps — GAP-ONLY, after
  // the RentCast → BatchData record (BatchData excluded from that walk: its one door already ran).
  // Versium's documented property facts are year built / dwelling type / purchase date only
  // (versium-client.ts appendVersiumPropertyFacts); its value RANGES never feed property_valuation.
  property_facts: [
    { provider: "batchdata", unitCostUsd: MCP_TOOL_CALL_COST_USD, keyedBy: "property_address" },
    { provider: "versium", unitCostUsd: VERSIUM_MATCH_CREDIT_USD, keyedBy: "property_address" },
  ],
  motivated_seller_list: [
    { provider: "batchdata", unitCostUsd: BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD, keyedBy: "geography" },
  ],
  // Wave 99 (lane 99C): THE AVM CHAIN AS A CAPABILITY. Ordered by OWNER RULING, not by price (see
  // OWNER_ORDERED_CAPABILITIES): RentCast primary (wave 92, "use rentcast as much as possible
  // regarding … home values"), BatchData the backup (wave 93, "use batchdata as a backup") — reached
  // only after a named RentCast miss (BATCHDATA_FALLBACK_MISS_REASONS) through the ONE BatchData gate.
  // RentCast's cost is the rung constant above (= RENTCAST_USD_PER_REQUEST); BatchData's is the
  // per-record Property Search constant fetchBatchDataPropertyFallback books.
  property_valuation: [
    { provider: "rentcast", unitCostUsd: RENTCAST_REQUEST_USD, keyedBy: "property_address" },
    { provider: "batchdata", unitCostUsd: BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD, keyedBy: "property_address" },
  ],
  // Wave 140 (lane 140I; owner: "MAPBOX IS REQUIRED … team heatmap chooses a VALID configured provider,
  // never Google Maps with an empty key … One map subsystem"). THE ONE MAP CAPABILITY: Mapbox first,
  // Google Maps the fallback — cheapest-first AND the owner's order agree (Static Images $1.50 / 1k past
  // 100k free vs Google Static Maps $2 / 1k past 10k free; both VARIABLE — the booked unit is the
  // static-image SKU each transport books: lib/vendor-governance/cost-normalizer.ts MAPBOX_SKU_USD /
  // GOOGLE_MAPS_SKU_USD). The WALK is lib/property/street-view.ts resolveMapProvider: route order minus
  // failing providers minus UNCONFIGURED ones (a provider whose credential is absent is never chosen),
  // for both the browser tiles (team heatmap) and the server-minted static images.
  map_render: [
    { provider: "mapbox", unitCostUsd: MAPBOX_SKU_USD.static_image, keyedBy: "coordinates" },
    { provider: "google_maps", unitCostUsd: GOOGLE_MAPS_SKU_USD.static_map, keyedBy: "coordinates" },
  ],
  // Wave 142 (lane 142D; owner: "expose contact/business append, B2B2C identity matching, online-presence /
  // real-estate indicators … through the EXISTING kernel capability routing"). ONE provider sells each
  // (audited: lib/external/versium-client.ts — the B2B2C Crosswalk Append API and the full_demographic
  // output), at the SAME credit constant every Versium leg books; a no-match is free. No second rail.
  business_identity: [
    { provider: "versium", unitCostUsd: VERSIUM_MATCH_CREDIT_USD, keyedBy: "person_identifier" },
  ],
  // Billing note (wave 143, 143D): the unit here is the cost ORDER (one credit); the real bill is credits × the published
  // weight — online_presence bills VERSIUM_CREDIT_WEIGHTS.full_demographic (3) credits per matched record.
  online_presence: [
    { provider: "versium", unitCostUsd: VERSIUM_MATCH_CREDIT_USD, keyedBy: "person_identifier" },
  ],
  // Wave 143 (lane 143D; owner: "consider Versium for lead-acquisition steps … research what customers have in common"):
  // Versium's B2C ListGen ESTIMATES API sizes an audience for $0 ("can be called as many times as requested without
  // incurring in any charge" — api-documentation.versium.com/reference/estimates-api). ONE provider sells it; the unit is 0.
  audience_estimate: [
    { provider: "versium", unitCostUsd: 0, keyedBy: "geography" },
  ],
  // Wave 144 (lane 144E; owner ruling 10: "online_audience_append is NOT targeting: it matches contacts' online profiles (if
  // any) and appends matched online contact identifiers … to the platform record"). ONE provider sells it — Versium's Online
  // Audience Append, 1 match credit per matched record (VERSIUM_CREDIT_WEIGHTS.online_audience, the published table), a
  // no-match is free; the SAME credit constant every Versium leg books. Walked by runVersiumOnlineAudienceLeg below.
  online_audience_match: [
    { provider: "versium", unitCostUsd: VERSIUM_MATCH_CREDIT_USD, keyedBy: "person_identifier" },
  ],
}

/**
 * Capabilities whose answer is a RESEARCH SIGNAL that degrades gracefully when its only provider is down — the
 * caller's leg refuses with its reason and the run continues (the deal investigator leaves the source null and says
 * why). OS health therefore does not count them when it asks whether a failing provider can be routed around
 * (lib/kernel/os-health.ts): a sole-provider COMPLIANCE capability (dnc_tcpa) still sends the incident to a human,
 * a sole-provider research capability never blocks the failover of the provider's other capabilities.
 */
// Wave 144 (lane 144E): + online_audience_match — an append the record does without when Versium is down (the next enrichment
// pass re-asks the gap); it never blocks the failover of Versium's other capabilities.
export const DEGRADABLE_CAPABILITIES: ReadonlySet<ProviderCapability> = new Set<ProviderCapability>(["online_presence", "business_identity", "audience_estimate", "online_audience_match"])

/**
 * Capabilities whose route row is FREE (unit 0) — each carries the vendor statement that makes it free. Every OTHER
 * route row must be priced above zero (scripts/provider-cost-routing-guard.ts holds both halves of the rule, with a
 * positive control): a zero on a paid capability is a missing price, a zero here is a documented one.
 * @proofSeam kept exported for scripts/provider-cost-routing-guard.ts, which asserts the free-row rule and its positive control
 */
export const FREE_CAPABILITIES: ReadonlyMap<ProviderCapability, string> = new Map<ProviderCapability, string>([
  ["audience_estimate", "Versium B2C ListGen Estimates API — \"can be called as many times as requested without incurring in any charge\" (api-documentation.versium.com/reference/estimates-api, read 2026-10-23)"],
])

/**
 * Capabilities whose provider ORDER is an owner ruling rather than cheapest-first. Every other
 * capability stays sorted by unit cost (scripts/provider-cost-routing-guard.ts asserts both rules).
 * The value is the ruling, verbatim, so the exception carries its own authority.
 */
export const OWNER_ORDERED_CAPABILITIES: ReadonlyMap<ProviderCapability, string> = new Map<ProviderCapability, string>([
  ["property_valuation", "owner 2026-10-01: \"use rentcast as much as possible regarding … home values\" + \"use batchdata as a backup\""],
])

/** The health a capability route reads per provider (connector-gateway.ts::loadProviderHealth shape). */
export type CapabilityProviderHealth = { state: string; routeAround: boolean; reason: string }

export interface CapabilityRoute {
  capability: ProviderCapability
  /** Providers to ask IN ORDER (table order minus the skipped). */
  providers: readonly ContactDataProvider[]
  /** Who was left out and why — a caller-skipped provider or one in a `failing` cool-down. */
  skipped: ReadonlyArray<{ provider: ContactDataProvider; reason: string }>
}

/**
 * PURE — THE CAPABILITY ROUTER (wave 99, lane 99C; LAW 3). A caller names a CAPABILITY; this
 * returns the provider order from CONTACT_PROVIDER_ROUTES with every provider the caller excluded,
 * and every provider in a `failing` cool-down (connector-gateway.ts::deriveProviderHealth,
 * routeAround), left out WITH its reason. A provider with no health entry is asked (no evidence is
 * not a fault). Deterministic: no vendor call is made to decide the route.
 */
export function routeCapability(
  capability: ProviderCapability,
  health: Partial<Record<ContactDataProvider, CapabilityProviderHealth | null>>,
  exclude: ReadonlySet<string> = new Set(),
): CapabilityRoute {
  const providers: ContactDataProvider[] = []
  const skipped: Array<{ provider: ContactDataProvider; reason: string }> = []
  for (const e of CONTACT_PROVIDER_ROUTES[capability] ?? []) {
    const h = health[e.provider]
    if (exclude.has(e.provider)) skipped.push({ provider: e.provider, reason: "excluded by the caller" })
    else if (h?.routeAround) skipped.push({ provider: e.provider, reason: `provider_failing (${h.state}): ${h.reason}` })
    else providers.push(e.provider)
  }
  return { capability, providers, skipped }
}

/** What ONE record carries — the resolver picks the provider order from this, never
 *  from a vendor preference. */
export interface ContactRouteInput {
  /** Wave 93: a city + state or ZIP beside the name (Versium's name + geography input). */
  hasLocation?: boolean
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
      reason: `no property address but a phone/email → Versium first ($${VERSIUM_MATCH_CREDIT_USD}/matched output), then BatchData REVERSE skip trace ($${BATCHDATA_SKIP_TRACE_COST_USD}/match); PeopleData ($${PEOPLEDATA_MATCH_COST_USD}/match) only when both return nothing`,
    }
  }
  const bdUsable = input.hasPropertyAddress // V3 skip trace is property-keyed; owner name optional
  // Versium is asked by an address, a name + geography, or an email/phone (versiumQueryFor); a bare
  // name or a profile URL alone is not a Versium input.
  const versiumUsable = input.hasPropertyAddress || input.hasEmailOrPhone || (input.hasName && input.hasLocation === true)
  const ordered = CONTACT_PROVIDER_ROUTES.owner_contact
    .filter((e) => (e.provider === "batchdata" ? bdUsable : e.provider === "versium" ? versiumUsable : pdlUsable))
    .map((e) => e.provider)
  if (ordered.length === 0) {
    return { capability: "owner_contact", providers: [], reason: "no identifier — neither a property address (BatchData) nor a name/email/phone/profile (PeopleData) to trace from" }
  }
  const viaVersium = ordered[0] === "versium" ? `Versium first ($${VERSIUM_MATCH_CREDIT_USD}/matched output); ` : ""
  const rest = ordered[0] === "versium" ? ordered.slice(1) : ordered
  const reason = viaVersium + (rest[0] === "batchdata"
    ? `property address present → BatchData first ($${BATCHDATA_SKIP_TRACE_COST_USD}/match)${rest.length > 1 ? `; PeopleData ($${PEOPLEDATA_MATCH_COST_USD}/match) only when BatchData returns nothing` : "; no PeopleData identifier"}`
    : `no property address and no phone/email → BatchData cannot be asked (V3 is property-keyed, reverse is phone/email-keyed); PeopleData ($${PEOPLEDATA_MATCH_COST_USD}/match) is the ${viaVersium ? "fallback" : "only adequate provider"}`)
  return { capability: "owner_contact", providers: ordered, reason }
}

/**
 * THE VERSIUM LEG of the owner-contact route (wave 93, lane 93B2) — the FIRST provider whenever the
 * route names it. Owner cost decision (2026-10-01, relayed by the coordinator): "VERSIUM FIRST for
 * owner/person email+phone append, People Data Labs only when Versium misses (and PDL stays for full
 * person profiles)". ONE leg, used by BOTH enrichment paths that buy contact points — the queue drain
 * (lib/lead-pipeline/enrichment-orchestrator.ts Step 5) and the raw-record promotion
 * (lib/lead-pipeline/pipeline-processor.ts enrichWithPeopleData) — so there is no second chain.
 *   · Asks ONLY for what the person is missing: a LEAD asks EMAIL only (leads get email + direct mail,
 *     never SMS/voice — a phone would be paid for and never used); a CONTACT asks email, then phone.
 *     Nothing missing → nothing asked, $0.
 *   · Books the platform ledger as vendor "versium", usage "contact_append", with `answered_by`
 *     ("versium" on a match, null on a miss) — a miss is free (cost 0 books no row).
 *   · Unconfigured (no VERSIUM_API_KEY) → `skipped: "unconfigured"`, the caller's chain runs as before.
 * Never throws.
 */
export async function runVersiumContactLeg(
  req: {
    brokerageId: string | null
    stage: "lead" | "contact"
    identity: VersiumIdentity
    hasEmail: boolean
    hasPhone: boolean
    systemSource: string
    metadata?: Record<string, unknown>
    attribution?: { leadId?: string | null; contactId?: string | null; rawRecordId?: string | null }
    /**
     * Wave 93 (lane 93B3): the person's CURRENT enrichment profile (or the demographic values already
     * known). On a contact hit the leg buys only the Versium demographic categories this profile still
     * lacks (enrichment-column-map.ts::versiumDemographicCategoriesNeeded) — a filled category is never
     * re-bought. Omitted → treated as empty (every category is asked).
     */
    existingProfile?: Record<string, unknown> | null
    /**
     * Wave 106 (lane 106A) — WHICH DECISION the append serves (lib/kernel/resource-allocation.ts
     * DECISION_FIELD_DEPENDENCIES). Owner: "Only purchase enrichment when missing information could
     * change the decision." Defaults by stage — a lead's first touch depends on email alone (leads get
     * email + direct mail), a contact's on email + phone — so every existing caller buys exactly what it
     * bought before; a caller naming a decision none of the missing fields can change buys NOTHING
     * (`skipped: "no_decision_impact"`), and a field the decision does not depend on is never asked.
     */
    /** Wave 106A: the DECLARED decision the purchase must be able to change (lib/kernel/resource-allocation.ts DECISION_FIELD_DEPENDENCIES). */
    decision?: EnrichmentDecision
  },
  deps: {
    call?: VersiumContactCall
    demographicCall?: VersiumDemographicCall
    /** Wave 106A test seam — defaults to the tenant's resource_allocation policy (defaults when unreadable). */
    allocationPolicy?: (brokerageId: string) => Promise<{ enrichment_max_usd_per_decision: number }>
    meter?: (input: { vendorName: string; usageType: string; cost: number; brokerageId?: string | null; systemSource?: string; metadata?: Record<string, unknown>; attribution?: { leadId?: string | null; contactId?: string | null; rawRecordId?: string | null } }) => Promise<unknown>
    /** Test seam — defaults to lib/vendor-governance/budget-gate.ts::checkVendorBudget (the financial rung's gate). */
    checkBudget?: (p: { brokerageId: string; addCost: number }) => Promise<{ allowed: boolean }>
    /** Wave 98 (98C) test seam — defaults to connector-gateway.ts::loadProviderHealth. */
    providerHealth?: ProviderHealthFn
    /** Wave 108F test seam — defaults to highValueEnrichmentEnvelope (lib/kernel/autonomy-budgets.ts). */
    highValueEnvelope?: (a: { brokerageId: string; leadId: string | null; contactId: string | null; costUsd: number; decision: string }) => Promise<{ allowed: boolean; reason: string }>
  } = {},
): Promise<{ answered: boolean; emails: string[]; phones: string[]; cost: number; skipped: string | null; demographicsProfile: Record<string, any> | null; demographicCategories: string[]; fieldProvenance: Record<string, VersiumProvenance> }> {
  const missing: Array<"email" | "phone"> = []
  if (!req.hasEmail) missing.push("email")
  if (req.stage === "contact" && !req.hasPhone) missing.push("phone")
  const none = { demographicsProfile: null, demographicCategories: [] as string[], fieldProvenance: {} as Record<string, VersiumProvenance> }
  if (missing.length === 0) return { answered: false, emails: [], phones: [], cost: 0, skipped: "nothing_to_append", ...none }
  // Wave 106A — THE DATA SPEND GATE: only the missing fields that could change the declared decision
  // are bought (fail closed on an undeclared decision; the per-decision USD cap is tenant policy).
  const { shouldPurchaseEnrichment, loadResourceAllocationPolicy } = await import("@/lib/kernel/resource-allocation")
  const decision: EnrichmentDecision = req.decision ?? (req.stage === "lead" ? "lead_first_touch" : "contact_first_touch")
  const policy = req.brokerageId
    ? await (deps.allocationPolicy
        ? deps.allocationPolicy(req.brokerageId)
        : (async () => { try { return await loadResourceAllocationPolicy((await import("@/lib/supabase/service")).createServiceClient(), req.brokerageId as string) } catch { return null } })())
    : null
  let purchase = shouldPurchaseEnrichment({ decision, missingFields: missing, providerCostUsd: Math.round(VERSIUM_MATCH_CREDIT_USD * missing.length * 100) / 100, policy })
  // Wave 108F — CONTROLLED AUTONOMOUS BUDGETING: OVER the base per-decision cap, a HIGH-VALUE opportunity (value tier
  // from its lead score) may still buy the decisive fields from the provider router's envelope — consumed atomically
  // through the ONE enforcement function. Default all zero: the base cap stands exactly as before.
  if (!purchase.purchase && purchase.decisiveFields.length > 0 && req.brokerageId) {
    const costUsd = Math.round(VERSIUM_MATCH_CREDIT_USD * purchase.decisiveFields.length * 100) / 100
    const uplift = await (deps.highValueEnvelope ?? highValueEnrichmentEnvelope)({ brokerageId: req.brokerageId, leadId: req.attribution?.leadId ?? null, contactId: req.attribution?.contactId ?? null, costUsd, decision }).catch((e) => ({ allowed: false, reason: `envelope threw: ${(e as Error).message}` }))
    if (uplift.allowed) purchase = { purchase: true, decisiveFields: purchase.decisiveFields, reason: `${purchase.reason} — bought under the high-value envelope (${uplift.reason})` }
  }
  if (!purchase.purchase) return { answered: false, emails: [], phones: [], cost: 0, skipped: `no_decision_impact: ${purchase.reason}`, ...none }
  const outputs = missing.filter((f) => purchase.decisiveFields.includes(f))
  // Wave 97 (lane 97C): THE SAME vendor budget gate the Versium financial rung runs
  // (lib/enrichment/household-financials.ts::appendModeledCreditForProfile → checkVendorBudget), asked
  // BEFORE the paid call with the worst-case bill (one match credit per output asked). Tenant-attributed
  // spend only — a null tenant has no budget to check and no ledger row to book (meterVendorSpend
  // resolves false), so it is refused like the financial rung's `no_brokerage` (fail closed, §4); the
  // caller's chain (PeopleData) runs as it does on any skip.
  if (!req.brokerageId) return { answered: false, emails: [], phones: [], cost: 0, skipped: "no_brokerage", ...none }
  // Unconfigured Versium spends nothing — answer that before paying for a budget read.
  if (!deps.call && !(await import("@/lib/external/versium-client")).isVersiumConfigured()) {
    return { answered: false, emails: [], phones: [], cost: 0, skipped: "unconfigured", ...none }
  }
  // Wave 98 (98C) — PROVIDER HEALTH: a Versium in `failing` is routed around for its cool-down; the
  // caller's chain (PeopleData) runs exactly as it does on any other skip. No paid call, no budget read.
  const versiumHealth = await (deps.providerHealth ?? defaultProviderHealth)("versium").catch(() => null)
  if (versiumHealth?.routeAround) {
    return { answered: false, emails: [], phones: [], cost: 0, skipped: `provider_failing: ${versiumHealth.reason}`, ...none }
  }
  try {
    const checkBudget = deps.checkBudget
      ?? (async (p: { brokerageId: string; addCost: number }) => (await import("@/lib/vendor-governance/budget-gate")).checkVendorBudget(p))
    const budget = await checkBudget({ brokerageId: req.brokerageId, addCost: Math.round(VERSIUM_MATCH_CREDIT_USD * outputs.length * 100) / 100 })
    if (!budget.allowed) return { answered: false, emails: [], phones: [], cost: 0, skipped: "budget", ...none }
  } catch (e) {
    // A gate that cannot run refuses (CLAUDE.md §4) — never "nobody checked" read as "checked and fine".
    return { answered: false, emails: [], phones: [], cost: 0, skipped: `budget_unavailable: ${e instanceof Error ? e.message : String(e)}`, ...none }
  }
  try {
    const { appendVersiumContact, appendVersiumDemographics } = await import("@/lib/external/versium-client")
    const r = await appendVersiumContact(req.identity, outputs, { call: deps.call })
    if (r.skipped) return { answered: false, emails: [], phones: [], cost: 0, skipped: r.skipped, ...none }
    const meterFn = deps.meter
      ?? ((m: import("@/lib/vendor-governance/meter-vendor").MeterVendorInput) => import("@/lib/vendor-governance/meter-vendor").then((v) => v.meterVendorSpend(m)))
    // Wave 96 (lane 96B): the booking's answer is READ. meterVendorSpend resolves `false` when the row
    // was not written (no brokerage, a refused insert) — that is spend the ledger never saw, so it is
    // reported, never swallowed (CLAUDE.md §3: supabase-js resolves refusals). Never throws.
    const meter = async (m: Parameters<typeof meterFn>[0]): Promise<void> => {
      let booked: unknown
      try { booked = await Promise.resolve(meterFn(m)) } catch (e) { booked = e instanceof Error ? e.message : String(e) }
      if (booked === false || typeof booked === "string") {
        console.warn(`[versium] $${m.cost} ${m.usageType} NOT booked to the vendor ledger (brokerage ${m.brokerageId ?? "none"})${typeof booked === "string" ? `: ${booked}` : ""}`)
      }
    }
    if (r.cost > 0) {
      await meter({
        vendorName: "versium",
        usageType: "contact_append",
        cost: r.cost,
        brokerageId: req.brokerageId,
        systemSource: req.systemSource,
        metadata: { ...(req.metadata ?? {}), capability: "person.enrich_contact", answered_by: r.matched ? "versium" : null, outputs, credits: r.credits },
        attribution: req.attribution,
      })
    }
    const fieldProvenance: Record<string, VersiumProvenance> = { ...r.provenance }
    // ── Wave 93 (lane 93B3): DEMOGRAPHICS on a contact HIT ─────────────────────────────────────
    // A Versium hit ends the chain without People Data Labs (93B2), which used to supply the
    // demographic profile. The SAME step now buys Versium's demographic categories — only those the
    // person's profile still lacks — and maps them onto the SAME enrichment_profile vocabulary PDL
    // fills (enrichment-column-map.ts::buildVersiumDemographicProfile, provider 'versium'). Each
    // category credit is booked as its own ledger row (usage `demographic_append_<category>`).
    let demographicsProfile: Record<string, any> | null = null
    let demographicCategories: string[] = []
    let demographicCost = 0
    if (r.matched) {
      const { versiumDemographicCategoriesNeeded } = await import("@/lib/lead-pipeline/enrichment-column-map")
      const wanted = versiumDemographicCategoriesNeeded(req.existingProfile ?? null)
      if (wanted.length > 0) {
        // Ask with the email Versium just found — the strongest key for the same person.
        const id = { ...req.identity, email: req.identity.email || r.emails[0] || null }
        const demo = await appendVersiumDemographics(id, wanted, { call: deps.demographicCall })
        for (const [category, credits] of Object.entries(demo.creditsByCategory)) {
          const cost = Math.round((credits ?? 0) * VERSIUM_MATCH_CREDIT_USD * 100) / 100
          if (cost <= 0) continue
          await meter({
            vendorName: "versium",
            usageType: `demographic_append_${category}`,
            cost,
            brokerageId: req.brokerageId,
            systemSource: req.systemSource,
            metadata: { ...(req.metadata ?? {}), capability: "person.enrich_demographics", answered_by: "versium", category, credits },
            attribution: req.attribution,
          })
        }
        demographicCost = demo.cost
        // OUR profile, mapped inside the adapter (wave 96) — no raw Versium row reaches this leg.
        demographicCategories = demo.categories
        demographicsProfile = demo.profile
        if (demo.provenance) fieldProvenance.demographics = demo.provenance
      }
    }
    // Provenance per field rides the profile it describes (enrichment_profile.field_provenance — the
    // existing enrichment metadata JSON; no provenance table exists, gap noted in the OS gap map).
    if (demographicsProfile && Object.keys(fieldProvenance).length > 0) demographicsProfile = { ...demographicsProfile, field_provenance: fieldProvenance }
    return {
      answered: r.matched, emails: r.emails, phones: r.phones,
      cost: Math.round((r.cost + demographicCost) * 100) / 100,
      skipped: r.error && !r.matched ? `error: ${r.error}` : null,
      demographicsProfile, demographicCategories, fieldProvenance,
    }
  } catch (e) {
    return { answered: false, emails: [], phones: [], cost: 0, skipped: `error: ${e instanceof Error ? e.message : String(e)}`, ...none }
  }
}

// ─── WAVE 142 (lane 142D): TWO MORE VERSIUM CAPABILITIES ON THE SAME RAIL ──────────────────────
// Owner: "Expose contact/business append, B2B2C identity matching, online-presence/real-estate indicators
// … through the EXISTING kernel capability routing (routeCapability / provider chain), with the cost gate,
// cost booking and evidence." Both legs are the contact leg's shape: the route is read through
// routeCapability (a Versium in cool-down is routed around), the budget pre-flight runs through THE SAME
// gate (budget-gate.ts::checkVendorBudget) with the worst-case bill BEFORE a credit can be spent, ONE
// booking per paid call names the capability, and nothing here throws. The vendor contract each calls is
// audited in lib/external/versium-client.ts (what is verified vs UNRESOLVED is written beside the code).
// Callers at HEAD: the business-card scanner (business_identity — an agent's / vendor's card is a BUSINESS
// identity; the crosswalk is the identity/dedup evidence, never an outreach channel) and the deal
// investigator (online_presence — a research step within its cap). No LLM decides either.

type VersiumLegDeps = {
  meter?: (m: import("@/lib/vendor-governance/meter-vendor").MeterVendorInput) => Promise<unknown>
  /** Test seam — defaults to budget-gate.ts::checkVendorBudget (the same gate every Versium leg runs). */
  checkBudget?: (p: { brokerageId: string; addCost: number }) => Promise<{ allowed: boolean }>
  /** Test seam — defaults to connector-gateway.ts::loadProviderHealth. */
  providerHealth?: ProviderHealthFn
}

/** The pre-flight every paid Versium leg runs — refuse (by name) before a single credit can be spent. */
async function versiumLegPreflight(args: {
  capability: ProviderCapability
  brokerageId: string | null
  worstCaseUsd: number
  injectedCall: boolean
  deps: VersiumLegDeps
}): Promise<{ ok: true } | { ok: false; skipped: string }> {
  // Tenant-attributed spend only — a null tenant has no budget to check and no ledger row to book (§4).
  if (!args.brokerageId) return { ok: false, skipped: "no_brokerage" }
  // Unconfigured Versium spends nothing — answer that before paying for a budget read.
  if (!args.injectedCall && !(await import("@/lib/external/versium-client")).isVersiumConfigured()) return { ok: false, skipped: "unconfigured" }
  const health = await (args.deps.providerHealth ?? defaultProviderHealth)("versium").catch(() => null)
  const route = routeCapability(args.capability, { versium: health })
  if (!route.providers.includes("versium")) return { ok: false, skipped: route.skipped.map((s) => `provider_failing: ${s.reason}`).join("; ") || "no_provider_on_route" }
  try {
    const checkBudget = args.deps.checkBudget
      ?? (async (p: { brokerageId: string; addCost: number }) => (await import("@/lib/vendor-governance/budget-gate")).checkVendorBudget(p))
    const budget = await checkBudget({ brokerageId: args.brokerageId, addCost: args.worstCaseUsd })
    if (!budget.allowed) return { ok: false, skipped: "budget" }
  } catch (e) {
    // A gate that cannot run refuses (CLAUDE.md §4) — never "nobody checked" read as "checked and fine".
    return { ok: false, skipped: `budget_unavailable: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true }
}

/** Book one Versium leg's spend and READ the ledger's answer (meterVendorSpend resolves false when no row landed). */
async function bookVersiumLeg(meterFn: VersiumLegDeps["meter"], m: import("@/lib/vendor-governance/meter-vendor").MeterVendorInput): Promise<void> {
  const fn = meterFn ?? ((x: import("@/lib/vendor-governance/meter-vendor").MeterVendorInput) => import("@/lib/vendor-governance/meter-vendor").then((v) => v.meterVendorSpend(x)))
  let booked: unknown
  try { booked = await Promise.resolve(fn(m)) } catch (e) { booked = e instanceof Error ? e.message : String(e) }
  if (booked === false || typeof booked === "string") {
    console.warn(`[versium] $${m.cost} ${m.usageType} NOT booked to the vendor ledger (brokerage ${m.brokerageId ?? "none"})${typeof booked === "string" ? `: ${booked}` : ""}`)
  }
}

export interface VersiumBusinessIdentityLegResult {
  answered: boolean
  businessEmails: string[]
  consumerEmails: string[]
  consumerMobiles: string[]
  consumerAddress: { address: string | null; city: string | null; state: string | null; zip: string | null } | null
  cost: number
  skipped: string | null
  provenance: Partial<Record<VersiumB2B2COutput, VersiumProvenance>>
}

/**
 * THE B2B2C IDENTITY LEG — a business identity (a LinkedIn URL, or first + last + city + state) crosswalked
 * to its consumer contact points. Default ask: consumer_email ONLY (one crosswalk, one data point — the key
 * the scanner dedups a business card against the tenant's contacts with). Books vendor "versium", usage
 * "b2b2c_append", capability person.enrich_business_identity. Never throws.
 */
export async function runVersiumBusinessIdentityLeg(
  req: {
    brokerageId: string | null
    identity: VersiumB2B2CIdentity
    outputs?: readonly VersiumB2B2COutput[]
    systemSource: string
    metadata?: Record<string, unknown>
    attribution?: { leadId?: string | null; contactId?: string | null; rawRecordId?: string | null }
  },
  deps: VersiumLegDeps & { call?: VersiumB2B2CCall } = {},
): Promise<VersiumBusinessIdentityLegResult> {
  const outputs: readonly VersiumB2B2COutput[] = req.outputs?.length ? req.outputs : ["consumer_email"]
  const none: VersiumBusinessIdentityLegResult = { answered: false, businessEmails: [], consumerEmails: [], consumerMobiles: [], consumerAddress: null, cost: 0, skipped: null, provenance: {} }
  // Worst case: each output's PUBLISHED weight (business_email 2, the others 1) + the crosswalk once per consumer request
  // (versium-client.ts versiumB2B2CWorstCaseCredits — the Output Sample's Billing table). 143D: it was (1 + outputs) credits,
  // which understated a business_email ask by one credit and any multi-output ask by its extra crosswalks.
  const pre = await versiumLegPreflight({ capability: "business_identity", brokerageId: req.brokerageId, worstCaseUsd: versiumCreditsUsd(versiumB2B2CWorstCaseCredits(outputs)), injectedCall: !!deps.call, deps })
  if (!pre.ok) return { ...none, skipped: pre.skipped }
  try {
    const { appendVersiumB2B2C } = await import("@/lib/external/versium-client")
    const r = await appendVersiumB2B2C(req.identity, outputs, { call: deps.call })
    if (r.skipped) return { ...none, skipped: r.skipped }
    if (r.cost > 0) {
      await bookVersiumLeg(deps.meter, {
        vendorName: "versium",
        usageType: "b2b2c_append",
        cost: r.cost,
        brokerageId: req.brokerageId,
        systemSource: req.systemSource,
        metadata: { ...(req.metadata ?? {}), capability: "person.enrich_business_identity", answered_by: r.matched ? "versium" : null, outputs, credits: r.credits },
        attribution: req.attribution,
      })
    }
    return {
      answered: r.matched, businessEmails: r.businessEmails, consumerEmails: r.consumerEmails, consumerMobiles: r.consumerMobiles, consumerAddress: r.consumerAddress,
      cost: r.cost, skipped: r.error && !r.matched ? `error: ${r.error}` : null, provenance: r.provenance,
    }
  } catch (e) {
    return { ...none, skipped: `error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export interface VersiumOnlinePresenceLegResult {
  answered: boolean
  indicators: VersiumRealEstateIndicators | null
  cost: number
  skipped: string | null
  provenance: VersiumProvenance | null
  /** Wave 145 (lane 145F, owner ruling 12; wired by lane 145Z): the SAME paid row's protected fields, carried through
   *  UNTOUCHED for the segregated research store (persistRealEstateIndicators opts.protectedResearch) — never merged into
   *  `indicators`, never a targeting input. Empty when nothing protected came back. */
  protectedResearch: readonly import("@/lib/external/versium-client").VersiumProtectedResearchField[]
}

/**
 * THE ONLINE-PRESENCE LEG — "Online Presence Indicator - Real Estate" and the other property / behaviour
 * indicators of the full demographic output, for ONE known person; protected characteristics leave the adapter only
 * in the segregated `protectedResearch` field, bound for the research store (owner ruling 12). Books vendor "versium", usage "online_presence_append", capability person.enrich_online_presence.
 * A research / intent signal — never a targeting segment (lib/kernel/lookalike-audience.ts carries the
 * ad-policy verdict). Never throws.
 */
export async function runVersiumOnlinePresenceLeg(
  req: {
    brokerageId: string | null
    identity: VersiumIdentity
    systemSource: string
    metadata?: Record<string, unknown>
    attribution?: { leadId?: string | null; contactId?: string | null; rawRecordId?: string | null }
  },
  deps: VersiumLegDeps & { call?: VersiumFullDemographicCall } = {},
): Promise<VersiumOnlinePresenceLegResult> {
  const none: VersiumOnlinePresenceLegResult = { answered: false, indicators: null, cost: 0, skipped: null, provenance: null, protectedResearch: [] }
  // Worst case: the published full_demographic weight — 3 match credits per matched record (143D; it was asked as ONE credit).
  const pre = await versiumLegPreflight({ capability: "online_presence", brokerageId: req.brokerageId, worstCaseUsd: versiumCreditsUsd(VERSIUM_CREDIT_WEIGHTS.full_demographic), injectedCall: !!deps.call, deps })
  if (!pre.ok) return { ...none, skipped: pre.skipped }
  try {
    const { appendVersiumRealEstateIndicators } = await import("@/lib/external/versium-client")
    const r = await appendVersiumRealEstateIndicators(req.identity, { call: deps.call })
    if (r.skipped) return { ...none, skipped: r.skipped }
    if (r.cost > 0) {
      await bookVersiumLeg(deps.meter, {
        vendorName: "versium",
        usageType: "online_presence_append",
        cost: r.cost,
        brokerageId: req.brokerageId,
        systemSource: req.systemSource,
        metadata: { ...(req.metadata ?? {}), capability: "person.enrich_online_presence", answered_by: r.indicators ? "versium" : null, credits: r.credits },
        attribution: req.attribution,
      })
    }
    return { answered: !!r.indicators, indicators: r.indicators, cost: r.cost, skipped: r.error && !r.indicators ? `error: ${r.error}` : null, provenance: r.provenance, protectedResearch: r.protectedResearch ?? [] }
  } catch (e) {
    return { ...none, skipped: `error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export interface VersiumAudienceEstimateLegResult {
  answered: boolean
  estimate: VersiumAudienceEstimate | null
  /** Always 0 — the estimate is free; carried so every Versium leg result states its cost. */
  cost: 0
  skipped: string | null
}

/**
 * THE AUDIENCE-ESTIMATE LEG (wave 143, lane 143D) — HOW MANY people match a geography + housing-fact filter, for
 * look-alike RESEARCH sizing. FREE (Versium's ListGen Estimates API), so there is no budget pre-flight and nothing to
 * book — but it is still a CAPABILITY on this rail: the route is read through routeCapability (a Versium in cool-down is
 * routed around, an unconfigured one is skipped), the call rides the ONE egress with the tenant on the log row, and the
 * filter object cannot express a protected characteristic (versium-client.ts versiumEstimateQueryFor refuses any other
 * key by name). A research number, never a targeting list. Tenant-attributed only (no tenant, no read). Never throws.
 */
export async function runVersiumAudienceEstimateLeg(
  req: { brokerageId: string | null; filters: VersiumAudienceFilters },
  deps: { call?: VersiumEstimateCall; providerHealth?: ProviderHealthFn } = {},
): Promise<VersiumAudienceEstimateLegResult> {
  const none: VersiumAudienceEstimateLegResult = { answered: false, estimate: null, cost: 0, skipped: null }
  if (!req.brokerageId) return { ...none, skipped: "no_brokerage" }
  try {
    const { isVersiumConfigured, estimateVersiumAudience } = await import("@/lib/external/versium-client")
    if (!deps.call && !isVersiumConfigured()) return { ...none, skipped: "unconfigured" }
    const health = await (deps.providerHealth ?? defaultProviderHealth)("versium").catch(() => null)
    const route = routeCapability("audience_estimate", { versium: health })
    if (!route.providers.includes("versium")) return { ...none, skipped: route.skipped.map((s) => `provider_failing: ${s.reason}`).join("; ") || "no_provider_on_route" }
    const estimate = await estimateVersiumAudience(req.filters, { call: deps.call, brokerageId: req.brokerageId })
    if (estimate.skipped) return { ...none, estimate, skipped: estimate.skipped === "refused_filter" ? `refused_filter: ${estimate.refused.join(", ")}` : estimate.skipped }
    return { answered: estimate.estimatedRecords !== null, estimate, cost: 0, skipped: estimate.error && estimate.estimatedRecords === null ? `error: ${estimate.error}` : null }
  } catch (e) {
    return { ...none, skipped: `error: ${e instanceof Error ? e.message : String(e)}` }
  }
}

export interface VersiumOnlineAudienceLegResult {
  answered: boolean
  /** OUR shape: service → identifier kind → hash values. Never an e-mail address, never a phone number. */
  identifiers: VersiumOnlineAudienceIdentifiers | null
  dropped: { plaintext: number; malformed: number; unknownService: number }
  cost: number
  skipped: string | null
  provenance: VersiumProvenance | null
  queryId: string | null
}

/**
 * THE ONLINE-AUDIENCE LEG (wave 144, lane 144E) — the MATCH + APPEND of a person's hashed online identifiers. The contact
 * leg's shape: routeCapability('online_audience_match') (a Versium in cool-down is routed around, an unconfigured one is
 * skipped), THE SAME budget pre-flight with the published worst case (1 match credit) BEFORE a credit can be spent, ONE
 * booking per paid call (vendor "versium", usage "online_audience_append", capability person.enrich_online_audience), the
 * tenant on the gateway log row. It TARGETS NOBODY: the answer is appended to the record by lib/enrichment/online-audience-
 * store.ts; an ad audience is the separate governed act (lib/kernel/ads.ts syncAudience). Tenant-attributed only. Never throws.
 */
export async function runVersiumOnlineAudienceLeg(
  req: {
    brokerageId: string | null
    identity: VersiumIdentity
    /** The ad-platform sections to ask for — the platforms the tenant's governed audiences use (data minimisation). */
    services?: readonly VersiumOnlineAudienceService[]
    systemSource: string
    metadata?: Record<string, unknown>
    attribution?: { leadId?: string | null; contactId?: string | null; rawRecordId?: string | null }
  },
  deps: VersiumLegDeps & { call?: VersiumOnlineAudienceCall } = {},
): Promise<VersiumOnlineAudienceLegResult> {
  const none: VersiumOnlineAudienceLegResult = { answered: false, identifiers: null, dropped: { plaintext: 0, malformed: 0, unknownService: 0 }, cost: 0, skipped: null, provenance: null, queryId: null }
  const pre = await versiumLegPreflight({ capability: "online_audience_match", brokerageId: req.brokerageId, worstCaseUsd: versiumCreditsUsd(VERSIUM_ONLINE_AUDIENCE_WORST_CASE_CREDITS), injectedCall: !!deps.call, deps })
  if (!pre.ok) return { ...none, skipped: pre.skipped }
  try {
    const { appendVersiumOnlineAudience } = await import("@/lib/external/versium-client")
    const r = await appendVersiumOnlineAudience(req.identity, { services: req.services }, { call: deps.call, brokerageId: req.brokerageId })
    if (r.skipped) return { ...none, skipped: r.skipped }
    if (r.cost > 0) {
      await bookVersiumLeg(deps.meter, {
        vendorName: "versium",
        usageType: "online_audience_append",
        cost: r.cost,
        brokerageId: req.brokerageId,
        systemSource: req.systemSource,
        metadata: { ...(req.metadata ?? {}), capability: "person.enrich_online_audience", answered_by: r.matched ? "versium" : null, credits: r.credits, services: req.services ?? "all", query_id: r.queryId, identifiers: r.identifiers?.identifierCount ?? 0, dropped: r.dropped },
        attribution: req.attribution,
      })
    }
    return { answered: r.matched, identifiers: r.identifiers, dropped: r.dropped, cost: r.cost, skipped: r.error && !r.matched ? `error: ${r.error}` : null, provenance: r.provenance, queryId: r.queryId }
  } catch (e) {
    return { ...none, skipped: `error: ${e instanceof Error ? e.message : String(e)}` }
  }
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

/** Cheapest ADEQUATE first. The rail walks this order and stops at the first answer.
 *  It is NOT a pure cost order. RentCast ($0.074) runs ahead of two cheaper rungs, and each
 *  inversion carries its reason in PROPERTY_LOOKUP_RUNG_COST_USD[rung].aheadOfCheaper. */
export const PROPERTY_LOOKUP_RUNG_ORDER: readonly PropertyLookupRung[] = [
  "cache", "tenant_idx", "rentcast", "public_records", "batchdata",
]

/**
 * Documented per-lookup cost of each rung in USD. This is never a billing number; the
 * ledgers carry those.
 *
 * WAVE 85D CORRECTION. The comment here used to say "a cost ORDER the proof holds
 * monotone". The numbers never were. RentCast ($0.074) sits ahead of public records
 * ($0.015) and BatchData ($0.05), and the proof only checked that the paid rungs were
 * above zero, so the claim went unexamined (lane84E finding). The order is kept, and the
 * reason is now written down where the order is decided. The rule the proof holds
 * (test:persona-tool-realism): every rung that precedes a CHEAPER rung names why, in
 * `aheadOfCheaper`, and every other adjacent pair is non-decreasing.
 * @proofSeam kept exported for scripts/enrichment-one-rail-guard.ts and scripts/persona-tool-realism-guard.ts, which assert the lookup rung costs
 */
export const PROPERTY_LOOKUP_RUNG_COST_USD: Readonly<Record<PropertyLookupRung, { usd: number; aheadOfCheaper?: string }>> = {
  cache: { usd: 0 },
  tenant_idx: { usd: 0 },
  rentcast: {
    usd: RENTCAST_REQUEST_USD, // RENTCAST_USD_PER_REQUEST (lib/property/rentcast.ts), Foundation plan; $0.018 at Scale
    aheadOfCheaper:
      "public_records (the rung) is cheaper per call but is NOT adequate first. It is a live LLM web search "
      + "(Perplexity Sonar) that extracts facts from county pages with a confidence score and a "
      + "multi-second latency, which is too slow to wait on mid-call and can be wrong in front of a "
      + "customer. RentCast returns a structured assessor record in one metered request. batchdata (the rung) is "
      + "cheaper per call but is a policy rung: never reached for a customer conversation or a listing "
      + "intake (owner ruling, wave 79: own DB → RentCast → BatchData only for acquisition / skip-trace "
      + "/ DNC; wave 92 struck staff valuation — RentCast serves it).",
  },
  public_records: { usd: 0.015 }, // Perplexity Sonar upper bound (lib/property/address-lookup.ts), booked to ai_tool_usage, not a vendor
  batchdata: { usd: 0.05 },       // MCP_TOOL_CALL_COST_USD (lib/external/batchdata-ai-tools.ts) per call, per-record priced at scale
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
  const rc = await import("@/lib/property/rentcast")
  const fullAddress = formatFullAddress(req.address)
  // WAVE 92 (lane 92B): a customer CONVERSATION asks the single-address LISTING first — a buyer
  // asking about a home for sale is owed its list price and status, which only a listing row
  // carries. Every purpose then (or otherwise) reads the PROPERTY RECORD, which resolves listed and
  // unlisted homes alike — "a simple property lookup".
  if (req.purpose === "conversation") {
    const r = await rc.searchRentcastSaleListings({
      brokerageId: req.brokerageId,
      systemSource: "ai_agent_tool",
      contactId: req.contactId ?? null,
      filters: { address: fullAddress },
    })
    if (r.success && r.listings.length > 0) {
      const l = r.listings[0]
      return {
        ...emptyFacts("rentcast", "From RentCast's listing record (platform-metered)."),
        address: l.address, city: l.city, state: l.state, zip: l.zip,
        beds: l.bedrooms, baths: l.bathrooms, sqft: l.squareFeet, yearBuilt: l.yearBuilt,
        lotSize: l.lotSizeSqft != null ? Math.round((l.lotSizeSqft / 43560) * 100) / 100 : null,
        propertyType: l.propertyType, listingStatus: l.status ? l.status.toLowerCase() : null,
        listPrice: l.price, mlsNumber: l.mlsNumber, hoaMonthly: l.hoaMonthly ?? null,
        lat: l.latitude ?? null, lon: l.longitude ?? null,
      }
    }
  }
  // The PROPERTY RECORD endpoint (/properties) — the RentCast shape that carries the tax bill,
  // the assessed tax basis and the HOA fee. Same gate, same meter, same price per request as the
  // listing search above, cached 30 days; its reader is a whitelist that never maps the owner
  // block, so it is safe for every audience (redactFactsForAudience still strips value figures).
  const p = await rc.getRentcastPropertyRecord({
    brokerageId: req.brokerageId,
    systemSource: req.purpose === "public_facts" ? "public_calculator" : "ai_agent_tool",
    contactId: req.contactId ?? null,
    address: fullAddress,
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
  /** Wave 98 (98C) test seam — defaults to lib/agentic-os/connector-gateway.ts::loadProviderHealth. */
  providerHealth?: ProviderHealthFn
}

/** The provider-health reader the router consults (connector-gateway.ts::loadProviderHealth). */
export type ProviderHealthFn = (serviceKey: string) => Promise<{ state: string; routeAround: boolean; reason: string }>
const defaultProviderHealth: ProviderHealthFn = async (serviceKey) =>
  (await import("@/lib/agentic-os/connector-gateway")).loadProviderHealth(serviceKey)

// ─── THE ONE BATCHDATA GATE (non-facts shapes: skip trace, DNC, list pulls) ──

export interface BatchDataAccess {
  allowed: boolean
  purpose: PropertyLookupPurpose
  reason: string
}

/** PURE — the per-purpose carve-out over the two policy facts (header: ONE GATE). */
export function decideBatchDataAccess(
  req: { brokerageId?: string | null; purpose: PropertyLookupPurpose; afterRentcastMiss?: RentcastMissReason | null },
  policy: PropertyLookupPolicy,
): BatchDataAccess {
  const { purpose } = req
  if (!isPropertyLookupPurpose(purpose)) {
    return { allowed: false, purpose, reason: `purpose "${String(purpose)}" is not one of ${PROPERTY_LOOKUP_PURPOSES.join("/")} — refused, fail closed` }
  }
  // Wave 93 (lane 93B): the valuation purpose is a FALLBACK, never a primary — admitted only behind
  // a named RentCast miss the fallback set accepts (BATCHDATA_FALLBACK_MISS_REASONS header).
  if (purpose === "valuation") {
    const miss = req.afterRentcastMiss ?? null
    if (!miss) return { allowed: false, purpose, reason: `purpose "valuation" never reaches BatchData as a primary — property reads are RentCast's; BatchData is the backup only after a RentCast miss` }
    if (!BATCHDATA_FALLBACK_MISS_REASONS.has(miss)) {
      return { allowed: false, purpose, reason: `RentCast miss "${miss}" is not a BatchData fallback trigger (${[...BATCHDATA_FALLBACK_MISS_REASONS].join("/")}) — the free tiers answer instead` }
    }
    if (!req.brokerageId) return { allowed: false, purpose, reason: "no tenant on the request — a tenant-less billed BatchData reach is refused (§4)" }
    if (policy.batchDataTier === "off") return { allowed: false, purpose, reason: "BatchData tier is off (configured off, or the platform monthly cap is spent)" }
    return { allowed: true, purpose, reason: `BatchData backup after a RentCast miss (${miss}) under tier (platform-wide cap)` }
  }
  if (!BATCHDATA_ELIGIBLE_PURPOSES.has(purpose)) {
    return { allowed: false, purpose, reason: `purpose "${purpose}" never reaches BatchData (reserved for LEAD work: acquisition / skip-trace / DNC — property reads are RentCast's)` }
  }
  if (purpose === "dnc") return { allowed: true, purpose, reason: "DNC/TCPA compliance scrub — never refused by a spend policy; the MCP wrapper reports unconfigured" }
  if (!req.brokerageId) return { allowed: false, purpose, reason: "no tenant on the request — a tenant-less billed BatchData reach is refused (§4)" }
  if (policy.batchDataTier === "off") return { allowed: false, purpose, reason: "BatchData tier is off (configured off, or the platform monthly cap is spent)" }
  if (purpose === "acquisition" && policy.batchDataOptedIn !== true) {
    return { allowed: false, purpose, reason: `tenant not opted into billed BatchData pulls by platform staff (${BATCHDATA_BILLED_PULL_OPT_IN})` }
  }
  const reason = purpose === "acquisition" ? "acquisition under tier + platform-staff opt-in"
    : "skip trace under tier (platform-wide cap)"
  return { allowed: true, purpose, reason }
}

/**
 * I/O — THE gate every non-facts BatchData caller passes first. Reads the same
 * policy the facts rung reads (FAIL CLOSED on an unreadable policy) and applies
 * decideBatchDataAccess. `deps.policy` lets a proof inject the policy.
 */
export async function resolveBatchDataAccess(
  req: { brokerageId?: string | null; purpose: PropertyLookupPurpose; afterRentcastMiss?: RentcastMissReason | null },
  deps: { policy?: PropertyLookupPolicy } = {},
): Promise<BatchDataAccess> {
  // Wave 93 (lane 93B): a valuation FALLBACK with an accepted miss reads the tier like any billed reach.
  const fallbackRead = req.purpose === "valuation" && !!req.afterRentcastMiss
    && BATCHDATA_FALLBACK_MISS_REASONS.has(req.afterRentcastMiss) && !!req.brokerageId
  if (!fallbackRead && (req.purpose === "dnc" || !BATCHDATA_ELIGIBLE_PURPOSES.has(req.purpose))) {
    // No policy read needed: DNC is never spend-gated and an ineligible purpose is refused outright.
    return decideBatchDataAccess(req, deps.policy ?? { batchDataTier: "off", batchDataOptedIn: false })
  }
  const policy = deps.policy ?? (await readProductionPolicy(req.brokerageId ?? ""))
  return decideBatchDataAccess(req, policy)
}

/**
 * THE rail. Walks PROPERTY_LOOKUP_RUNG_ORDER cheapest-adequate-first and returns the
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
        result.skipped.push({ rung, reason: `purpose "${req.purpose}" never reaches BatchData (reserved for acquisition / skip-trace / DNC — LEAD work)` })
        continue
      }
      policy = policy ?? (await readProductionPolicy(req.brokerageId))
      if (!isBatchDataRungAllowed(req.purpose, policy)) {
        result.skipped.push({ rung, reason: policy.batchDataTier === "off" ? "BatchData tier is off" : "tenant not opted into billed BatchData pulls by platform staff" })
        continue
      }
    }
    // Wave 98 (98C) — PROVIDER HEALTH: a RentCast in `failing` (consecutive provider faults inside the
    // cool-down, derived from the gateway's own ledger) is routed around for the cool-down, so the
    // ladder falls to the next rung (public records, then BatchData where the purpose admits it)
    // instead of paying a timeout per lookup. Deterministic; no vendor call is made to decide it.
    if (rung === "rentcast") {
      const health = await (deps.providerHealth ?? defaultProviderHealth)("rentcast").catch(() => null)
      if (health?.routeAround) {
        result.skipped.push({ rung, reason: `provider ${health.state}: ${health.reason}` })
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


/**
 * Wave 108F — the provider router's HIGH-VALUE envelope for one over-cap enrichment decision: the opportunity's value
 * tier from its lead score (leads / contacts lead_score, tenant-pinned) → consumeAutonomyEnvelope("provider_high_value"),
 * scoped to the decision so one opportunity can never draw past its per-decision max. A standard opportunity is refused
 * (and ledgered as refused) — the base cap stands.
 */
async function highValueEnrichmentEnvelope(a: { brokerageId: string; leadId: string | null; contactId: string | null; costUsd: number; decision: string }): Promise<{ allowed: boolean; reason: string }> {
  const svc = (await import("@/lib/supabase/service")).createServiceClient()
  const subjectId = a.contactId ?? a.leadId
  if (!subjectId) return { allowed: false, reason: "no opportunity to value — base cap stands" }
  const table = a.contactId ? "contacts" : "leads"
  const { data, error } = await svc.from(table).select(a.contactId ? "lead_score" : "lead_score, estimated_value").eq("brokerage_id", a.brokerageId).eq("id", subjectId).maybeSingle()
  if (error) return { allowed: false, reason: `${table} read refused: ${error.message} — base cap stands` }
  const { opportunityValueTier, consumeAutonomyEnvelope } = await import("@/lib/kernel/autonomy-budgets")
  const tier = opportunityValueTier({ leadScore: (data as { lead_score?: number | null } | null)?.lead_score ?? null })
  const v = await consumeAutonomyEnvelope(svc, {
    brokerageId: a.brokerageId, envelope: "provider_high_value", amount: a.costUsd, scopeKey: `${a.decision}:${subjectId}`, valueTier: tier.tier,
    reasonCode: a.contactId ? "NURTURE_TOUCH" : "LEAD_FIRST_RESPONSE", reasonDetail: `enrichment above the per-decision cap for a ${tier.tier} opportunity (${tier.why}) — ${a.decision}`,
    subject: { type: a.contactId ? "contact" : "lead", id: subjectId },
  })
  return { allowed: v.allowed, reason: v.reason }
}
