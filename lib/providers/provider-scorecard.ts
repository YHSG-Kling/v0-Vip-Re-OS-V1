// lib/providers/provider-scorecard.ts
//
// THE ONE COST / RIGHTS SCORECARD (wave 150, lane 150HIAB — directive 150I / 150AB, contract C39). PURE: no client, no
// network, no credential read, no `server-only`.
//
// C39: "One capability router (routeCapability + CONTACT_PROVIDER_ROUTES) and one cost/rights scorecard per provider ×
// capability × field; adapters dormant until contract + measurable incremental coverage + unit economics." This file is
// the SCORECARD half. It is NOT a second router: the live provider ORDER is still CONTACT_PROVIDER_ROUTES, asked through
// routeCapability (lib/ai-isa/property-lookup-rail.ts — OS-CONSTITUTION law 3). What the router never carried, and what
// this file adds, is (a) each provider's ACTIVATION / LICENSING state with its rights and credential recorded BY NAME, (b)
// the FIELD-level price / rights / documentation rows — which is what lets a waterfall ask only for the field that is
// actually missing — and (c) the seller-score fields, each in its OWN vendor-defined unit.
//
// OWNER RULING R9 (2026-11-06): "RentCast + Versium + ONE owner-contact/seller-score provider decided by a matched pilot:
// Tracerfy vs DataZapp … BatchData and PeopleData become DORMANT survivor adapters (never deleted; activation needs proven
// incremental coverage and rights) … Data Axle only for market-level employer events / licensed acquisition lists if a gap
// is proven." A dormant-pending-rights provider is NOT in the route table (there is nothing to route to: no transport is
// built), so live routing cannot reach it by construction; activation is a reviewed change that adds its route row, its
// adapter facts and its transport together — never a flag a manager or the self-healer can flip (money; constitution law 4).
//
// Every vendor fact below is cited to the page it was read from (docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md §10,
// read 2026-11-03; the PropertyRadar playbook installed by the owner, read 2026-11-06). A price nobody published is `null`
// (UNKNOWN), never 0 and never a guess. Citations are written host/path without a scheme on purpose — they are evidence,
// not endpoints, and nothing here calls them.

import { CONTACT_PROVIDER_ROUTES, routeCapability, PROVIDER_ACTIVATION, type ContactDataProvider, type ProviderCapability, type CapabilityProviderHealth, type ScorecardProvider, type ActivationState, type RightsStatus, type ProviderActivation } from "@/lib/ai-isa/property-lookup-rail"
// Wave 151 (lane 151G): the ONE RentCast data-type table (sold records vs listing statistics vs listing records) lives in the
// pure market-report contract so the on-graph readers share it; the scorecard joins it into the gap matrix below.
import { RENTCAST_DATA_TYPES, type RentcastDataKind } from "@/lib/market-reports/contract"

// ─── activation / licensing state lives beside the route table (lib/ai-isa/property-lookup-rail.ts PROVIDER_ACTIVATION); re-exported here ──
export { PROVIDER_ACTIVATION, RENTCAST_DATA_TYPES }
export type { ScorecardProvider, ActivationState, RightsStatus, ProviderActivation, RentcastDataKind }

// ═════════════════════════════════════════════════════════════════════════════
// COMMERCIAL SELECTION STATUS (wave 151, lane 151G). Owner, 2026-11-09, verbatim: "this platform os has not been released
// yet nor providers picked so that needs to be decided by pricing, capabilities and use license". PROVIDER_ACTIVATION's
// `active` is a TECHNICAL state — an existing adapter with a transport and a platform credential NAME — and is NOT a
// commercial selection. Nothing below selects, activates, purchases or requests a credential; every tier is a
// RECOMMENDATION the owner decides on. scripts/provider-gap-matrix-guard.ts E holds `selected` null and every decision
// `waiting_owner`.
// ═════════════════════════════════════════════════════════════════════════════

export const PROVIDER_SELECTION_STATUS = Object.freeze({
  status: "WAITING_OWNER_APPROVAL" as const,
  /** The provider the owner has SELECTED for production. null until the owner decides. */
  selected: null as ScorecardProvider | null,
  activatedForProduction: false as const,
  decidedBy: "the owner — on pricing, capabilities and use LICENSE (owner, 2026-11-09)",
  purchasesMade: 0 as const,
  credentialsRequested: 0 as const,
  /** The proposed $1,000 paid pilot cap is NOT approved (directive 151G); the evaluation design runs as a simulation only. */
  paidPilotApproved: false as const,
  meaningOfActive: "PROVIDER_ACTIVATION.state 'active' = an existing adapter with a transport and a platform credential NAME (technical) — not a commercial selection",
})

/**
 * The commercial recommendation vocabulary (directive 151G: PRIMARY / GAP-FILL / DORMANT BACKUP / UNNECESSARY / WAITING_LICENSE) —
 * one spelling each; LICENSE, never a British spelling. The ORDER is the waterfall's stage order after the incumbents
 * (lib/providers/provider-pilot.ts projectMonthlyWaterfall): a provider nothing needs comes last.
 */
export const RECOMMENDATION_TIERS = ["PRIMARY", "GAP_FILL", "DORMANT_BACKUP", "WAITING_LICENSE", "UNNECESSARY"] as const
export type RecommendationTier = (typeof RECOMMENDATION_TIERS)[number]

export interface ProviderRecommendation {
  tier: RecommendationTier
  /** Always waiting_owner: a recommendation is not a selection. */
  decision: "waiting_owner"
  /** The role the tier proposes, in one line. */
  role: string
  /** What only this provider documents (the directive's "actual unique value"); empty = nothing unique found. */
  uniqueValue: readonly string[]
  /** What must be TRUE (contract, measurement, rights) before the owner could select / activate it. */
  conditions: readonly string[]
  why: string
}

// ─── per-provider commercial facts (who pays, API stability, attribution, retention, consumer display rights) ──────
// Every cell is read from the vendor page named in the comparison (docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md §10,
// §11) or from this repo's own code; "unknown" / "not read" is written where nothing was read — never a guess.

export interface ProviderCommercialFacts {
  /** Who pays for a call under each authorized route. */
  payer: string
  /** Permitted LICENSED use of the data for THIS deployment (SaaS, many tenants, storage on tenant records). */
  permittedUse: string
  apiStability: string
  attribution: string
  retention: string
  consumerDisplayRights: string
}

export const PROVIDER_COMMERCIAL_FACTS: Readonly<Record<ScorecardProvider, ProviderCommercialFacts>> = Object.freeze({
  rentcast: {
    payer: "platform — ONE platform key (RENTCAST_API_KEY by name), metered per tenant (lib/property/rentcast.ts meterCall), budget-gated; a tenant's own IDX connection substitutes for sale LISTINGS only (rentcast-eligibility.ts readKind)",
    permittedUse: "property records + sale history, AVM, ZIP listing statistics, listing records for buyers whose tenant has no connected IDX — 'any use case that is not specifically prohibited under our Terms of Use' (API page); the Terms of Use themselves were NOT read",
    apiStability: "REST v1; the vendor's OpenAPI spec is vendored (lib/external/_generated/rentcast-openapi.ts) so a renamed field fails at compile time; ≤ 500 rows per request (rentcast-query.ts); proofs test:rentcast-platform / test:rentcast-eligibility",
    attribution: "UNVERIFIED — the Terms of Use were not read; the portal names the originating MLS (mlsName) as a listing's source and RentCast as the carrier of facts",
    retention: "repo caches: property record 30 d, AVM 14 d, /markets 7 d (RENTCAST_CACHE_TTL_DAYS); external listing references purged after 3 d (lib/buyer-search/external-match.ts EXTERNAL_REF_TTL_DAYS); vendor retention terms not read",
    consumerDisplayRights: "listing FACTS shown to a buyer with the MLS name as source and 'your agent confirms it's available' (status = provider_reported, never verified active); NO photo on any surface (the schema carries none); owner block and sale history are STAFF audience only (public whitelist never reads them)",
  },
  versium: {
    payer: "platform — VERSIUM_API_KEY (by name); match credits per MATCHED output at the credit-package ceiling (VERSIUM_MATCH_CREDIT_USD); a no-match is free",
    permittedUse: "licensed consumer enrichment (contact, demographic categories, financial band), property facts (year built / dwelling type / purchase date), B2B2C crosswalk, allow-listed online-presence indicators, audience ESTIMATE (a count), Online Audience Append (hashed match ids on a record we hold) — on the EXISTING account; SaaS / partner / LLM rights in the SIGNED terms are unverified",
    apiStability: "REST v2 documented (api-documentation.versium.com); REACH MCP is OAuth authorization-code only — no server credential model, WAITING_EXTERNAL (VERSIUM_REACH_MCP); no SDK; one webhook (job callback_url, unsigned)",
    attribution: "no attribution clause in the standard terms; every appended field carries provenance (enrichment-column-map.ts stampFieldProvenance)",
    retention: "the STANDARD terms forbid caching / building a database and service-bureau use — signed SaaS terms UNVERIFIED (comparison §4); gap-only append + field provenance keep what is stored to the fields a decision needs",
    consumerDisplayRights: "none — enrichment fields are internal CRM facts, never shown to a consumer; an audience estimate is a COUNT, never contacts; Online Audience Append is a match + append, never ad targeting and never an e-mail/SMS address",
  },
  batchdata: {
    payer: "route A: the platform's env-held account (BATCHDATA_API_KEY by name; plans are annual commitments) — a DORMANT survivor whose live doors wait on the owner; route B: the TENANT's own token (tenant_paid, lib/providers/tenant-provider-connections.ts)",
    permittedUse: "skip trace (incl. LLC / corporate owners), property search + quicklists, Smart Search push, DNC/TCPA scrub (MCP), property lookup and comps as the AVM-chain BACKUP after a named RentCast miss — marketing-use terms by NAME (batchdata_api_terms), NOT read",
    apiStability: "REST v1 / v3 + MCP (static server bearer) + signed push webhook (smart-search); developer.batchdata.com read 2026-09-16 / 2026-11-09; the ONE transport lib/external/batchdata-client.ts",
    attribution: "unknown — Terms not read",
    retention: "unknown — Terms not read; repo: 14-day fallback cache; a tenant connection carries its own retention_days attestation",
    consumerDisplayRights: "none asserted — acquisition / staff use; a property fact may back a staff record; never a consumer-facing listing or photo source",
  },
  peopledata: {
    payer: "platform — PEOPLEDATA_API_KEY (by name); one credit per SUCCESSFUL match (a 404 no-match is free)",
    permittedUse: "person profile (employment, education, social profile URLs) and email validation for ONE End User on the Customer's platform (standard terms, comparison §4)",
    apiStability: "REST v5 Person Enrichment + a separate Email Validation endpoint, documented (docs.peopledatalabs.com); per-credit tiers did not render on the pricing page 2026-11-03",
    attribution: "not required (standard terms)",
    retention: "cached data no longer than necessary; delete on termination (standard terms, secondary source)",
    consumerDisplayRights: "none — internal enrichment only",
  },
  tracerfy: {
    payer: "nothing contracted — would be a platform credit balance or the tenant's own account; the $0.02 bulk price is for BATCH queues (an instant lookup is 5 credits)",
    permittedUse: "ToS §13: 'licensed for Customer's internal business use and lawful delivery to Customer's contracted end users'; white-label 'Contact sales … with a contract' — platform use likely, UNCONFIRMED in writing; individual owners only (no LLCs)",
    apiStability: "REST (Bearer) + MCP + a free deterministic mock sandbox (mock.tracerfy.com); batch 10 submissions / 5 min, instant 500 / min; only `hit` / `credits_deducted` named in the pages read — phone / email / score keys NOT read",
    attribution: "no attribution clause found; ToS §3 flow-down of restrictions to end users (no resale, no FCRA use, no harassment)",
    retention: "no retention / deletion clause found; 'Cache results to avoid redundant requests' is a vendor best practice (ToS §4); 'Lead Storage' is a product line",
    consumerDisplayRights: "none — contact data is internal; ToS prohibits a standalone data feed, directory or sublicensed product; no listing or photo product is documented",
  },
  datazapp: {
    payer: "nothing contracted — the API is prepaid only ($1,000 minimum deposit after a $125 test, which is a purchase)",
    permittedUse: "NONE STATED in writing — the Terms grant no license and prohibit none (resale / platform / storage silent); WAITING_LICENSE by construction",
    apiStability: "HTTPS POST JSON, `ApiKey` in the body, batch `Data` array; API enabled by sales staff; phone scrub 1 request / s ≤ 500 phones; the per-row email key inside `Data` is undocumented",
    attribution: "none stated",
    retention: "not addressed ('YOU ARE RESPONSIBLE FOR BACKING-UP YOUR OWN MATERIALS'); terms may change without notice",
    consumerDisplayRights: "none — append data; protected / credit-like demographic fields (ethnicity, religion, party, CREDIT_RANGE, NLTV) are refused at the API by the required written license",
  },
  propertyradar: {
    payer: "nothing contracted — would be credits on a platform or tenant PropertyRadar account; Purchase=0 previews are free",
    permittedUse: "preview counts and the criteria methodology (used without a purchase — lib/investor/rei-playbook.ts); records, scores and contacts only under partner / embedded rights, which are unverified",
    apiStability: "REST documented in the owner-installed propertyradar-api playbook (read 2026-11-06); `Purchase=0` consumes no quota; `Purchase=1` spends credits at an unpublished price",
    attribution: "partner / embedded product rights for tenant exposure UNVERIFIED",
    retention: "not read",
    consumerDisplayRights: "none — an investor / acquisition methodology; DistressScore is a staff rank (0–100), never a probability and never consumer-facing",
  },
  data_axle: {
    payer: "none — no product chosen",
    permittedUse: "unknown — only for a PROVEN market-level employer-event or licensed-acquisition gap (owner ruling R9)",
    apiStability: "unknown — no field-level documentation was read",
    attribution: "unknown",
    retention: "unknown",
    consumerDisplayRights: "unknown",
  },
})

// ─── the commercial recommendation (a RECOMMENDATION — the owner selects) ──────────────────────────────────────────

export const PROVIDER_RECOMMENDATION: Readonly<Record<ScorecardProvider, ProviderRecommendation>> = Object.freeze({
  rentcast: {
    tier: "PRIMARY", decision: "waiting_owner",
    role: "the property-data survivor: property record + sale history (recorded sales), AVM, ZIP LISTING statistics, listing records for buyers without a connected IDX",
    uniqueValue: ["ZIP-level sale + rental listing statistics (/markets)", "property record with sale history and a saleDateRange sold-records filter (/properties)", "AVM with comparable listings (/avm/value)", "listing records with the originating MLS name (/listings/sale)"],
    conditions: ["the Terms of Use read by counsel for consumer display of listing facts, attribution and retention", "the plan tier chosen by measured monthly volume (Foundation / Growth / Scale overage)", "the area sold-records reader built on the ONE client (RENTCAST_DATA_TYPES.sold_records — no reader today)"],
    why: "already the owner-ordered primary for property facts / valuation / market (R9, wave 92); the recorded-sale evidence lives in its property record, not in /markets — the readers now label the three data types apart",
  },
  versium: {
    tier: "PRIMARY", decision: "waiting_owner",
    role: "licensed consumer enrichment on the existing account: real-time contact append, demographic categories, online-presence indicators, the free audience estimate (a count), Online Audience Append (match ids)",
    uniqueValue: ["Online Presence Indicator — Real Estate (full_demographic)", "B2C ListGen Estimates — a free audience COUNT", "Online Audience Append — hashed ad-platform identifiers appended to a record (not targeting)", "B2B2C crosswalk (business identity ↔ consumer contact points)"],
    conditions: ["signed SaaS / partner terms that permit storing appended fields on tenant records (the standard terms forbid caching and service-bureau use)", "the REACH MCP stays WAITING_EXTERNAL until a server-side credential model exists"],
    why: "the existing contracted identity provider; nothing evaluated sells the online-presence indicators, the free estimate or the audience append",
  },
  batchdata: {
    tier: "GAP_FILL", decision: "waiting_owner",
    role: "dormant survivor kept for what no PRIMARY sells: quicklist / distress property search, Smart Search push, DNC/TCPA scrub (the only dnc_tcpa route row), LLC / corporate owner skip trace, the AVM / record / comps BACKUP after a named RentCast miss, and the ONE tenant-connectable acquisition transport (route B)",
    uniqueValue: ["motivated-seller quickLists (pre-foreclosure, absentee, vacant …) at scale", "Smart Search push webhook (property-change events)", "DNC / TCPA litigator check (MCP) — the route's only dnc_tcpa provider today", "skip trace of LLC / corporate owners (Tracerfy covers individuals only)", "comparable / property datasets as the chain's backup"],
    conditions: ["the owner's confirmation whether R9 closes its existing live doors (survivorDoors)", "the marketing-use terms (batchdata_api_terms) read and filed", "a plan commitment only if the measured gap volume justifies an annual plan — otherwise tenant-owned connections (route B) carry it"],
    why: "functions beyond RentCast / Tracerfy / Versium are documented (above); the platform account is an annual commitment, so it stays dormant gap-fill rather than PRIMARY",
  },
  peopledata: {
    tier: "DORMANT_BACKUP", decision: "waiting_owner",
    role: "dormant survivor for the one field no other provider documents — the employment / education / social profile (person_profile) — and the third owner_contact rung",
    uniqueValue: ["employment profile: job title, company, education, social profile URLs (person_profile)"],
    conditions: ["a flow that needs employment facts and the rights to store them (one End User on the Customer's platform)", "re-confirmed per-credit tiers (not rendered 2026-11-03)"],
    why: "unique coverage exists but at 5× the per-match price of the contact rungs and with no current flow that needs it; never deleted (extend before replacing), never activated without the measured gap",
  },
  tracerfy: {
    tier: "WAITING_LICENSE", decision: "waiting_owner",
    role: "candidate for the BATCH owner-contact rung and the DNC/TCPA scrub (cheapest documented per hit; misses free) — decided by the matched-cohort evaluation, never presumed",
    uniqueValue: ["address-only owner trace (Advanced Trace) and parcel (APN) trace", "DNC / TCPA litigator scrub bundled on one credit balance", "a free deterministic mock sandbox for a no-spend adapter proof", "Property Monitors (owner / property-change alerts with a webhook)", "TraceAI propensity scores (sell / refinance / roof / HVAC / solar) — scale and validation UNPUBLISHED"],
    conditions: ["written platform-use confirmation (storage on tenant records, delivery to tenants as contracted end users, one platform account for many tenants, white-label terms)", "the tenant Terms flow-down of ToS §3 restrictions (counsel)", "the matched-cohort evaluation (MATCHED_COHORT_DESIGN) run on the sandbox first, then a bounded paid sample ONLY if the owner approves it"],
    why: "no license covers platform use today; no transport is built; the seller score has no published definition or validation (dormant-adapters refuses to label it until the schema is read)",
  },
  datazapp: {
    tier: "WAITING_LICENSE", decision: "waiting_owner",
    role: "candidate for email append / household attributes only if a written license grants storage, platform use and the exclusion of protected / credit-like fields — otherwise UNNECESSARY",
    uniqueValue: ["household attributes at the lowest published per-attribute price (LOR, Home_Owner, Dwelling_Type, Home_Value)", "Signal_Seller_Score (0x–4x ordinal label; price and method unpublished)"],
    conditions: ["a written license (storage, platform use, field exclusions) — the Terms grant none", "the cohort evaluation shows email fill the PRIMARY rungs miss", "the $1,000 prepaid floor accepted by the owner"],
    why: "everything it would add is either covered (RentCast + the contact rungs) or protected / credit-like; the matched evaluation is the only way it earns a role",
  },
  propertyradar: {
    tier: "WAITING_LICENSE", decision: "waiting_owner",
    role: "methodology and free preview counts for the investor playbook; records, scores and contacts only under partner / embedded rights",
    uniqueValue: ["Purchase=0 preview counts (totalResultCount) at no quota cost", "DistressScore 0–100 rollup and the foreclosure-stage criteria vocabulary"],
    conditions: ["written partner / embedded product rights for tenant exposure", "an uncovered high-value capability proven against BatchData's quicklists (which overlap most of it)"],
    why: "conditional under R9 — kept dormant pending rights; nothing calls it",
  },
  data_axle: {
    tier: "UNNECESSARY", decision: "waiting_owner",
    role: "not needed today — only for a PROVEN market-level employer-event or licensed-acquisition-list gap",
    uniqueValue: [],
    conditions: ["a measured market-level gap no other source covers (employer events are public-record / Exa research today)", "a product, its fields, reseller / embedded license and quota read"],
    why: "no product chosen, no field documented, nothing it would add that is not covered or protected",
  },
})

/**
 * PURE — may this provider be ACTIVATED (live calls)? License unknown blocks ACTIVATION, never offline testing
 * (directive canary 9): `offlineTestAllowed` is true for every provider — a simulation spends nothing and calls nothing.
 */
export function activationVerdict(provider: ScorecardProvider): { mayActivate: boolean; offlineTestAllowed: true; blockers: string[] } {
  const a = PROVIDER_ACTIVATION[provider]
  if (a.state === "active") return { mayActivate: true, offlineTestAllowed: true, blockers: [] }
  const blockers: string[] = []
  if (a.rights.status === "none_stated" || a.rights.status === "not_read" || a.rights.status === "api_page_statement_only") blockers.push(`rights: ${a.rights.status} — ${a.rights.summary}`)
  if (!a.activationEvidence.contract) blockers.push("no contract / written platform-use confirmation on record")
  if (!a.activationEvidence.incrementalCoverage) blockers.push("no measured incremental coverage (the matched pilot has not run on real data)")
  if (!a.activationEvidence.unitEconomics) blockers.push("no unit economics from a measured test")
  if (a.credential.envVars.length === 0) blockers.push("no credential name — no product chosen")
  return { mayActivate: blockers.length === 0, offlineTestAllowed: true, blockers }
}

// ─── the field-level scorecard (provider × capability × field) ────────────────────────────────────────────────────

/** The fields a person / property record can be missing — the waterfall asks only for these. */
export type ScoreField =
  | "owner_phone" | "owner_email" | "dnc_status" | "mailing_address" | "property_facts" | "home_value"
  | "length_of_residence" | "seller_signal" | "distress_signal" | "demographics" | "employment" | "online_audience_ids" | "preview_count"

/** A capability the router routes, or one only dormant providers sell today (no route row until one is activated). */
type ScorecardCapability = ProviderCapability | "seller_signal_score" | "acquisition_preview"

interface ScorecardRow {
  provider: ScorecardProvider
  capability: ScorecardCapability
  field: ScoreField
  /** The vendor's own field / product name exactly as documented; null = the documentation read did not name it. */
  vendorField: string | null
  documented: boolean
  /** USD per unit; null = UNKNOWN (unpublished / unconfirmed). */
  unitUsd: number | null
  unit: "per_match" | "per_request" | "per_record" | "per_phone" | "per_attribute" | "free"
  /** The bulk price is for batched queues only (Tracerfy: an instant single lookup is 5×). */
  batchOnly?: boolean
  /** The route table's unit is a cost ORDER (one credit); the bill is credits × the published weight. */
  creditWeight?: number
  source: string
  // ─── the gap-matrix columns (wave 151, lane 151G) — identity / property grain, matching key, recency, consuming survivor ──
  /** What ONE row of the vendor's answer is about. */
  grain: "person" | "household" | "property" | "phone" | "audience" | "zip"
  /** What the provider must be asked with to match this field. */
  matchingKey: string
  /** How fresh the vendor says the field is ("unpublished" when no cadence is documented) and how long the repo caches it. */
  recency: string
  /** The repo survivor that consumes the field (repo-relative path + symbol), or "none — …" when nothing does (said so). */
  consumer: string
}

const NO_TRANSPORT = "none — no transport (dormant pending rights; lib/providers/dormant-adapters.ts maps documented keys only)"
const UNPUBLISHED = "vendor refresh cadence unpublished"

export const PROVIDER_FIELD_SCORECARD: readonly ScorecardRow[] = Object.freeze([
  // RentCast — the property survivor (R9).
  { provider: "rentcast", capability: "property_facts", field: "property_facts", vendorField: "/properties", documented: true, unitUsd: 0.074, unit: "per_request", source: "rentcast.io/api; lib/property/rentcast.ts RENTCAST_USD_PER_REQUEST", grain: "property", matchingKey: "full address (Street, City, State, Zip)", recency: "as of RentCast's last record refresh (unpublished per record); cached 30 d (RENTCAST_CACHE_TTL_DAYS.record)", consumer: "lib/avm/provider-chain.ts getPropertyRecordWithFallback; lib/ai-isa/property-lookup-rail.ts rung 5" },
  { provider: "rentcast", capability: "property_valuation", field: "home_value", vendorField: "/avm/value", documented: true, unitUsd: 0.074, unit: "per_request", source: "rentcast.io/api", grain: "property", matchingKey: "full address", recency: "estimated at request time; cached 14 d (RENTCAST_CACHE_TTL_DAYS.avm)", consumer: "lib/avm/provider-chain.ts requestPropertyValuation (owner-ordered primary)" },
  { provider: "rentcast", capability: "property_facts", field: "mailing_address", vendorField: "owner.mailingAddress", documented: true, unitUsd: 0.074, unit: "per_request", source: "comparison §10.7 F7", grain: "property", matchingKey: "full address", recency: "assessor roll as RentCast carries it (unpublished); cached 30 d", consumer: "lib/property/rentcast.ts normalizeRentcastPropertyDetail → the rail's STAFF record (never the public whitelist)" },
  { provider: "rentcast", capability: "property_facts", field: "length_of_residence", vendorField: "history (last sale date)", documented: true, unitUsd: 0.074, unit: "per_request", source: "comparison §10.5 leg 3", grain: "property", matchingKey: "full address", recency: "derived from lastSaleDate — the sale-history side of the record", consumer: "lib/property/rentcast.ts normalizeRentcastPropertyDetail; lib/market-reports/research.ts recordedSaleFromRentcastRecord" },
  // Versium — the existing contracted identity provider (R9).
  { provider: "versium", capability: "owner_contact", field: "owner_phone", vendorField: "Contact Append (phone)", documented: true, unitUsd: 0.05, unit: "per_match", source: "versium.com/pricing; VERSIUM_MATCH_CREDIT_USD", grain: "person", matchingKey: "name + city/state or ZIP, or address / email / phone", recency: `${UNPUBLISHED}; retrieved_at stamped per field`, consumer: "lib/ai-isa/property-lookup-rail.ts runVersiumContactLeg (owner_contact rung 1)" },
  { provider: "versium", capability: "owner_contact", field: "owner_email", vendorField: "Contact Append (email)", documented: true, unitUsd: 0.05, unit: "per_match", source: "versium.com/pricing", grain: "person", matchingKey: "name + geography, or address / email / phone", recency: `${UNPUBLISHED}; retrieved_at stamped per field`, consumer: "lib/ai-isa/property-lookup-rail.ts runVersiumContactLeg" },
  { provider: "versium", capability: "online_presence", field: "demographics", vendorField: "full_demographic", documented: true, unitUsd: 0.15, unit: "per_match", creditWeight: 3, source: "VERSIUM_CREDIT_WEIGHTS.full_demographic (3 credits)", grain: "household", matchingKey: "name + postal address", recency: `${UNPUBLISHED}; persisted gap-only with provenance`, consumer: "lib/kernel/lookalike-audience.ts runVersiumOnlinePresenceLeg → enrichment_profile.real_estate_indicators (allow-listed; protected values dropped)" },
  { provider: "versium", capability: "online_audience_match", field: "online_audience_ids", vendorField: "Online Audience Append", documented: true, unitUsd: 0.05, unit: "per_match", source: "api-documentation.versium.com", grain: "person", matchingKey: "name + address / email / phone of a record we already hold", recency: "at match; re-asked on the next enrichment pass only for the required gap", consumer: "lib/enrichment/online-audience-store.ts runVersiumOnlineAudienceLeg (hashed ids on the record — not targeting)" },
  { provider: "versium", capability: "audience_estimate", field: "preview_count", vendorField: "B2C ListGen Estimates", documented: true, unitUsd: 0, unit: "free", source: "api-documentation.versium.com/reference/estimates-api", grain: "audience", matchingKey: "geography + allow-listed housing / property / mortgage filters", recency: "at query (query_id + criteria + retrieved-at)", consumer: "lib/kernel/lookalike-audience.ts runVersiumAudienceEstimateLeg — a COUNT, never contacts" },
  // BatchData — dormant survivor (R9).
  { provider: "batchdata", capability: "owner_contact", field: "owner_phone", vendorField: "skip-trace v3", documented: true, unitUsd: 0.07, unit: "per_match", source: "batchdata.io/pricing; BATCHDATA_SKIP_TRACE_COST_USD", grain: "property", matchingKey: "property address (owner resolved by the vendor; LLC / corporate owners included)", recency: UNPUBLISHED, consumer: "lib/ai-isa/property-lookup-rail.ts owner_contact rung 2 → lib/external/batchdata-client.ts (dormant doors wait on the owner)" },
  { provider: "batchdata", capability: "owner_contact", field: "owner_email", vendorField: "skip-trace v3", documented: true, unitUsd: 0.07, unit: "per_match", source: "batchdata.io/pricing", grain: "property", matchingKey: "property address", recency: UNPUBLISHED, consumer: "lib/ai-isa/property-lookup-rail.ts owner_contact rung 2" },
  { provider: "batchdata", capability: "dnc_tcpa", field: "dnc_status", vendorField: "check_dnc_status (MCP)", documented: true, unitUsd: 0.05, unit: "per_request", source: "MCP_TOOL_CALL_COST_USD", grain: "phone", matchingKey: "phone number", recency: "at check", consumer: "lib/external/batchdata-mcp.ts via the dnc_tcpa route; lib/communication/tcpa-gate.ts decides what may be dialled" },
  { provider: "batchdata", capability: "motivated_seller_list", field: "distress_signal", vendorField: "quickLists", documented: true, unitUsd: 0.05, unit: "per_record", source: "BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD", grain: "property", matchingKey: "geography + quicklist filters (pre-foreclosure, absentee, vacant …)", recency: "list pull date; Smart Search push events carry their own date", consumer: "lib/lead-pipeline/pooled-pull.ts runPooledBatchDataLane → THE RawData producer" },
  { provider: "batchdata", capability: "seller_signal_score", field: "seller_signal", vendorField: "intel.salePropensity", documented: true, unitUsd: null, unit: "per_record", source: "lib/external/batchdata-client.ts (BatchRank add-on, $2,500/mo plan — comparison §10.4)", grain: "property", matchingKey: "property", recency: "add-on not on the platform account", consumer: "none — the BatchRank add-on is not held (labelled through labelSellerSignal if it ever arrives)" },
  // PeopleData — dormant survivor (R9).
  { provider: "peopledata", capability: "person_profile", field: "employment", vendorField: "Person Enrichment", documented: true, unitUsd: 0.25, unit: "per_match", source: "PEOPLEDATA_MATCH_COST_USD", grain: "person", matchingKey: "email / phone, or name + location (city, state / postal code)", recency: "PDL dataset release cadence (per-record age unpublished)", consumer: "lib/ai-isa/property-lookup-rail.ts person_profile route → lib/external/peopledata-client.ts (dormant doors wait on the owner)" },
  { provider: "peopledata", capability: "owner_contact", field: "owner_email", vendorField: "Person Enrichment", documented: true, unitUsd: 0.25, unit: "per_match", source: "PEOPLEDATA_MATCH_COST_USD", grain: "person", matchingKey: "email / phone, or name + location", recency: UNPUBLISHED, consumer: "lib/ai-isa/property-lookup-rail.ts owner_contact rung 3 (fallback)" },
  // Tracerfy — pilot candidate (R9), dormant pending rights.
  { provider: "tracerfy", capability: "owner_contact", field: "owner_phone", vendorField: "Normal Trace", documented: true, unitUsd: 0.02, unit: "per_match", batchOnly: true, source: "tracerfy.com/pricing (1 credit a hit; misses free; instant lookup 5 credits)", grain: "person", matchingKey: "owner name + address (Normal Trace) or address only (Advanced Trace, 2 credits); individual owners only", recency: UNPUBLISHED, consumer: NO_TRANSPORT },
  { provider: "tracerfy", capability: "owner_contact", field: "owner_email", vendorField: "Normal Trace", documented: true, unitUsd: 0.02, unit: "per_match", batchOnly: true, source: "tracerfy.com/pricing", grain: "person", matchingKey: "owner name + address", recency: UNPUBLISHED, consumer: NO_TRANSPORT },
  { provider: "tracerfy", capability: "dnc_tcpa", field: "dnc_status", vendorField: "DNC scrub", documented: true, unitUsd: 0.02, unit: "per_phone", source: "tracerfy.com/pricing (charged per phone checked)", grain: "phone", matchingKey: "phone number", recency: "at check", consumer: NO_TRANSPORT },
  { provider: "tracerfy", capability: "seller_signal_score", field: "seller_signal", vendorField: null, documented: false, unitUsd: 0.1, unit: "per_record", source: "tracerfy.com/pricing (Property Data + TraceAI, 5 credits a delivered record; the score's JSON field name is not documented in the pages read)", grain: "property", matchingKey: "property (list criteria)", recency: `${UNPUBLISHED}; no published scale, definition or validation`, consumer: "none — the JSON key is undocumented; nothing is labelled until the schema is read" },
  // DataZapp — pilot candidate (R9), dormant pending rights.
  { provider: "datazapp", capability: "owner_contact", field: "owner_email", vendorField: "Email Append API", documented: true, unitUsd: 0.03, unit: "per_match", source: "datazapp.com/email-append; knowledgebase.datazapp.com email-append-api", grain: "person", matchingKey: "name + postal address", recency: `${UNPUBLISHED} ('regularly updated'); matched emails are not verified`, consumer: NO_TRANSPORT },
  { provider: "datazapp", capability: "owner_contact", field: "owner_phone", vendorField: "Phone Append", documented: true, unitUsd: 0.03, unit: "per_match", source: "datazapp.com/phone-append (≤ 50,000)", grain: "person", matchingKey: "name + postal address", recency: UNPUBLISHED, consumer: NO_TRANSPORT },
  { provider: "datazapp", capability: "online_presence", field: "length_of_residence", vendorField: "LOR", documented: true, unitUsd: 0.0075, unit: "per_attribute", source: "knowledgebase.datazapp.com/apis/demography-append-api", grain: "household", matchingKey: "name + postal address", recency: UNPUBLISHED, consumer: NO_TRANSPORT },
  { provider: "datazapp", capability: "seller_signal_score", field: "seller_signal", vendorField: "Signal_Seller_Score", documented: true, unitUsd: null, unit: "per_attribute", source: "knowledgebase.datazapp.com/apis/demography-append-api (0x–4x); the seller-score price is unconfirmed", grain: "household", matchingKey: "name + postal address", recency: `${UNPUBLISHED} ('AI-modeled')`, consumer: NO_TRANSPORT },
  // PropertyRadar — methodology used without purchase; dormant pending rights.
  { provider: "propertyradar", capability: "acquisition_preview", field: "preview_count", vendorField: "totalResultCount (Purchase=0)", documented: true, unitUsd: 0, unit: "free", source: "propertyradar-api playbook references/endpoints.md (Purchase=0 consumes no record quota)", grain: "audience", matchingKey: "property criteria (the playbook's confirmed names)", recency: "at query", consumer: "lib/investor/rei-playbook.ts builds the preview-only play (purchase 0); no transport sends it" },
  { provider: "propertyradar", capability: "seller_signal_score", field: "distress_signal", vendorField: "DistressScore", documented: true, unitUsd: null, unit: "per_record", source: "propertyradar-api playbook references/endpoints.md (0–100 rollup; may be preview-gated)", grain: "property", matchingKey: "RadarID / property criteria", recency: "per record, as returned", consumer: NO_TRANSPORT },
  { provider: "propertyradar", capability: "owner_contact", field: "owner_phone", vendorField: "POST /v1/persons/{PersonKey}/Phone?Purchase=1", documented: true, unitUsd: null, unit: "per_match", source: "propertyradar-api playbook references/endpoints.md (spends credits; price unpublished)", grain: "person", matchingKey: "PersonKey", recency: UNPUBLISHED, consumer: NO_TRANSPORT },
  // Data Axle — only for a proven market-level gap; nothing documented at field level yet.
  { provider: "data_axle", capability: "person_profile", field: "demographics", vendorField: null, documented: false, unitUsd: null, unit: "per_record", source: "data-axle.com (advertised from $25 / 1k standard consumer — fields unconfirmed)", grain: "household", matchingKey: "unknown — no field-level documentation read", recency: "unknown", consumer: "none — no product chosen" },
])

// ─── seller-score fields: each in its OWN vendor-defined unit (never cross-ranked, never a probability) ─────────────

interface SellerSignalField {
  provider: ScorecardProvider
  /** The key lib/intent/moving-moments.ts VENDOR_SCORE_UNITS labels it by — ONE vocabulary (CLAUDE.md §6). */
  vendorKey: string
  product: string
  scale: string
  domain: { kind: "range"; min: number; max: number } | { kind: "labels"; labels: readonly string[] } | { kind: "undocumented" }
}

/** The stored names (raw_scraped_leads.evidence.seller_signals.<name>) — one per vendor field, never merged. */
export const SELLER_SIGNAL_FIELDS = Object.freeze({
  tracerfy_lead_builder_seller_score: { provider: "tracerfy", vendorKey: "tracerfy:seller_score", product: "Lead Builder / Property Data + TraceAI (NOT the ordinary skip trace, which returns no score)", scale: "Tracerfy's own scale — the numeric range is not published", domain: { kind: "undocumented" } },
  datazapp_signal_seller_score: { provider: "datazapp", vendorKey: "datazapp:Signal_Seller_Score", product: "Demography Append API", scale: "an ordinal LABEL 0x–4x — never a number on Tracerfy's or PropertyRadar's scale", domain: { kind: "labels", labels: ["0x", "1x", "2x", "3x", "4x"] } },
  propertyradar_distress_score: { provider: "propertyradar", vendorKey: "propertyradar:DistressScore", product: "Property search / detail (Overview fieldset)", scale: "0–100 rollup of distress signals — a rank for investors, not a likely-listing score", domain: { kind: "range", min: 0, max: 100 } },
  propertyradar_likely_listing_score: { provider: "propertyradar", vendorKey: "propertyradar:LikelyListingScore", product: "named in the REI playbook; not in the installed API reference", scale: "undocumented — verify on a live account before use", domain: { kind: "undocumented" } },
  propertyradar_likely_purchase_score: { provider: "propertyradar", vendorKey: "propertyradar:LikelyPurchaseScore", product: "named in the REI playbook; not in the installed API reference", scale: "undocumented — verify on a live account before use", domain: { kind: "undocumented" } },
  batchdata_sale_propensity: { provider: "batchdata", vendorKey: "batchdata:salePropensity", product: "BatchRank add-on (intel.salePropensity / salePropensityCategory)", scale: "BatchData's own propensity scale (the add-on is not on the platform account)", domain: { kind: "undocumented" } },
} satisfies Record<string, SellerSignalField>)

export type SellerSignalName = keyof typeof SELLER_SIGNAL_FIELDS

export interface LabelledSellerSignal {
  name: SellerSignalName
  provider: ScorecardProvider
  vendorKey: string
  value: number | string
  scale: string
  label: string
  /** ALWAYS null — a vendor score is never a chance of a move until calibrated against outcomes (C37). */
  probability: null
  observedAt: string
}

/**
 * PURE — a raw vendor value → the labelled signal stored under ITS OWN name, or a refusal when the value is outside the
 * vendor's documented domain (a "5x" DataZapp label, a DistressScore of 140). An undocumented-scale field is kept
 * verbatim and labelled as such — never coerced onto another vendor's scale.
 */
export function labelSellerSignal(name: SellerSignalName, raw: unknown, observedAt: string): { ok: true; signal: LabelledSellerSignal } | { ok: false; reason: string } {
  const f: SellerSignalField = SELLER_SIGNAL_FIELDS[name]
  if (raw === null || raw === undefined || raw === "") return { ok: false, reason: `${name}: no value` }
  let value: number | string
  if (f.domain.kind === "labels") {
    const s = String(raw).trim().toLowerCase()
    if (!f.domain.labels.includes(s)) return { ok: false, reason: `${name}: "${String(raw)}" is not one of ${f.domain.labels.join(" / ")}` }
    value = s
  } else if (f.domain.kind === "range") {
    const n = typeof raw === "number" ? raw : Number(raw)
    if (!Number.isFinite(n) || n < f.domain.min || n > f.domain.max) return { ok: false, reason: `${name}: ${String(raw)} is outside ${f.domain.min}–${f.domain.max}` }
    value = n
  } else {
    value = typeof raw === "number" ? raw : String(raw)
  }
  return {
    ok: true,
    signal: {
      name, provider: f.provider, vendorKey: f.vendorKey, value, scale: f.scale,
      label: `${f.vendorKey} ${String(value)} — ${f.scale}; a provider signal in its own units, never a probability of a move`,
      probability: null, observedAt,
    },
  }
}

/**
 * PURE — order two seller signals, or REFUSE (null) when they are not the same vendor field. A Tracerfy score is never
 * "higher" than a DataZapp label, and a DataZapp label is ordered only by its own documented label order.
 */
export function compareSellerSignals(a: LabelledSellerSignal, b: LabelledSellerSignal): number | null {
  if (a.name !== b.name) return null
  const f: SellerSignalField = SELLER_SIGNAL_FIELDS[a.name]
  if (f.domain.kind === "labels") return f.domain.labels.indexOf(String(a.value)) - f.domain.labels.indexOf(String(b.value))
  if (f.domain.kind === "range") return Number(a.value) - Number(b.value)
  return null // an undocumented scale has no documented order
}

// ─── the field-level overlap / gap matrix ─────────────────────────────────────────────────────────────────────────

interface FieldMatrixCell { provider: ScorecardProvider; state: ActivationState; unitUsd: number | null; unit: ScorecardRow["unit"]; rights: RightsStatus; documented: boolean }

/**
 * PURE — per FIELD: every provider that sells it (with state, unit price, rights and whether the field is documented),
 * whether ≥ 2 sell it (an OVERLAP — the cheaper licensed one is asked first, never both), and whether NO active provider
 * documents it (a GAP — only a pilot or an activation can close it). Read by the platform connector-healing console
 * (app/dashboard/superadmin/connector-healing/page.tsx) and by the provider-scorecard proof, which asserts the comparison
 * doc's §11 matrix agrees with it.
 */
export function providerFieldMatrix(): Array<{ field: ScoreField; cells: FieldMatrixCell[]; overlap: boolean; gap: boolean }> {
  const byField = new Map<ScoreField, FieldMatrixCell[]>()
  for (const r of PROVIDER_FIELD_SCORECARD) {
    const a = PROVIDER_ACTIVATION[r.provider]
    const cells = byField.get(r.field) ?? []
    if (!cells.some((c) => c.provider === r.provider)) cells.push({ provider: r.provider, state: a.state, unitUsd: r.unitUsd, unit: r.unit, rights: a.rights.status, documented: r.documented })
    byField.set(r.field, cells)
  }
  return [...byField.entries()].map(([field, cells]) => ({
    field, cells,
    overlap: cells.length >= 2,
    gap: !cells.some((c) => c.state === "active" && c.documented),
  }))
}

// ─── THE FIELD-BY-FIELD GAP MATRIX (wave 151, lane 151G — directive 151G "Exact provider gap matrix") ───────────────

/** One row of the directive's matrix: source/field, recency, permitted licensed use, grain, matching key, cost per call /
 *  usable person, who pays, API stability, attribution, retention, consumer display rights, consuming survivor. */
export interface GapMatrixRow {
  source: string
  provider: ScorecardProvider
  field: ScoreField | RentcastDataKind
  capability: string
  state: ActivationState
  rights: RightsStatus
  recommendation: RecommendationTier
  recency: string
  permittedUse: string
  grain: string
  matchingKey: string
  /** "$0.05 per_match" / "$0 free" / "UNKNOWN per_record" — never a guessed number. */
  costPerCall: string
  /** A FORMULA until measured: unit ÷ (hit rate × usable share), both ASSUMED variables of MATCHED_COHORT_DESIGN. */
  costPerUsablePerson: string
  whoPays: string
  apiStability: string
  attribution: string
  retention: string
  consumerDisplayRights: string
  consumer: string
  documented: boolean
}

export function formatUnitUsd(unitUsd: number | null, unit: ScorecardRow["unit"]): string {
  return unitUsd === null ? `UNKNOWN ${unit}` : `$${unitUsd} ${unit}`
}

/**
 * PURE — the whole matrix: every scorecard row joined with its provider's activation state, rights, commercial facts and
 * recommendation tier, PLUS one row per RentCast DATA TYPE (sold records / listing statistics / listing records / AVM /
 * comparables are kept apart — a `/markets` row can never read as closed sales). Read by scripts/provider-gap-matrix-guard.ts,
 * which renders docs/operations/PROVIDER-SELECTION-WAVE151.md from it and fails when the doc and this disagree.
 * Product reader: the platform connector-healing console (app/dashboard/superadmin/connector-healing/page.tsx, the gap-matrix table).
 */
export function providerGapMatrix(): GapMatrixRow[] {
  const usable = (row: Pick<ScorecardRow, "unitUsd" | "unit" | "field">) =>
    row.unitUsd === 0 ? "free — a count / preview, not a person" : row.unitUsd === null ? "UNKNOWN — no published unit price" : row.unit === "per_match" ? `${formatUnitUsd(row.unitUsd, row.unit)} ÷ usable share u (a miss is free; u ASSUMED until measured)` : `${formatUnitUsd(row.unitUsd, row.unit)} ÷ (hit rate h × usable share u), h and u ASSUMED until measured`
  const rows: GapMatrixRow[] = PROVIDER_FIELD_SCORECARD.map((r) => {
    const a = PROVIDER_ACTIVATION[r.provider], c = PROVIDER_COMMERCIAL_FACTS[r.provider]
    return {
      source: `${r.provider}/${r.vendorField ?? r.field}`, provider: r.provider, field: r.field, capability: r.capability, state: a.state, rights: a.rights.status,
      recommendation: PROVIDER_RECOMMENDATION[r.provider].tier, recency: r.recency, permittedUse: c.permittedUse, grain: r.grain, matchingKey: r.matchingKey,
      costPerCall: `${formatUnitUsd(r.unitUsd, r.unit)}${r.batchOnly ? " (batch queue only)" : ""}${r.creditWeight ? ` (${r.creditWeight} credits)` : ""}`,
      costPerUsablePerson: usable(r), whoPays: c.payer, apiStability: c.apiStability, attribution: c.attribution, retention: c.retention, consumerDisplayRights: c.consumerDisplayRights,
      consumer: r.consumer, documented: r.documented,
    }
  })
  const rc = PROVIDER_ACTIVATION.rentcast, rcc = PROVIDER_COMMERCIAL_FACTS.rentcast
  const perRequest = PROVIDER_FIELD_SCORECARD.find((r) => r.provider === "rentcast")!
  for (const t of Object.values(RENTCAST_DATA_TYPES)) {
    rows.push({
      source: `rentcast/${t.endpoint}`, provider: "rentcast", field: t.kind, capability: t.kind === "listing_statistics" ? "market_statistics" : t.kind === "sold_records" || t.kind === "property_record" ? "sold_records" : t.kind === "listing_records" ? "listing_search" : "property_valuation",
      state: rc.state, rights: rc.rights.status, recommendation: PROVIDER_RECOMMENDATION.rentcast.tier,
      recency: t.kind === "listing_records" ? "listedDate / removedDate / lastSeenDate per row; freshness window owed (BUYER_LISTING_RECENCY_DAYS); references purged after 3 d" : t.kind === "listing_statistics" ? "RentCast's lastUpdatedDate per ZIP; platform cache 7 d" : t.kind === "avm_estimate" || t.kind === "listing_comparables" ? "at request; cached 14 d" : "record as of RentCast's last refresh; cached 30 d",
      permittedUse: `${t.label} — ${rcc.permittedUse}`, grain: t.kind === "listing_statistics" ? "zip" : "property",
      matchingKey: t.kind === "listing_statistics" ? "ZIP code" : t.kind === "sold_records" ? "ZIP / city+state / radius + saleDateRange (days since last sale)" : t.kind === "listing_records" ? "city+state or ZIP + beds / baths / price / type / daysOld" : "full address",
      costPerCall: formatUnitUsd(perRequest.unitUsd, perRequest.unit), costPerUsablePerson: "n/a — a property / market read, not a person",
      whoPays: rcc.payer, apiStability: rcc.apiStability, attribution: rcc.attribution, retention: rcc.retention,
      consumerDisplayRights: `${t.closedSaleEvidence ? "RECORDED-SALE evidence" : "NOT closed-sale evidence"}; photo rights: none; ${rcc.consumerDisplayRights}`,
      consumer: t.readers.join("; "), documented: true,
    })
  }
  return rows
}

// ─── the capability-first waterfall ───────────────────────────────────────────────────────────────────────────────

export interface WaterfallStep {
  provider: ScorecardProvider
  fields: ScoreField[]
  unitUsd: number | null
  unit: ScorecardRow["unit"]
  /** route_table = CONTACT_PROVIDER_ROUTES order (live-callable); dormant_candidate = scorecard only (offline simulation). */
  source: "route_table" | "dormant_candidate"
  mayCallLive: boolean
  why: string
}

export interface ProviderWaterfall {
  capability: ScorecardCapability
  steps: WaterfallStep[]
  skipped: Array<{ provider: string; reason: string }>
  /** Set when NO call is planned at all — with the reason (nothing missing / nothing licensed sells it). */
  noCallReason: string | null
}

/**
 * PURE — THE CAPABILITY-FIRST WATERFALL (C39). A caller names a CAPABILITY and the FIELDS the record is actually missing
 * ("for every person ask which field is actually missing and whether action requires it"). The live order is the router's
 * (routeCapability over CONTACT_PROVIDER_ROUTES, failing providers routed around); a provider that sells none of the
 * missing fields is skipped; a dormant survivor stays live only while its doors wait on the owner (survivorDoors), never
 * once closed. Dormant-pending-rights providers appear ONLY in `offline_simulation` mode, with `mayCallLive: false` —
 * license unknown blocks activation, not offline testing. Deterministic: no vendor call decides the plan.
 */
export function planProviderWaterfall(req: {
  capability: ScorecardCapability
  missingFields: readonly ScoreField[]
  health?: Partial<Record<ContactDataProvider, CapabilityProviderHealth | null>>
  mode: "live" | "offline_simulation"
}): ProviderWaterfall {
  const missing = new Set(req.missingFields)
  const out: ProviderWaterfall = { capability: req.capability, steps: [], skipped: [], noCallReason: null }
  if (missing.size === 0) { out.noCallReason = "nothing is missing — no provider is asked"; return out }
  const rowsFor = (p: ScorecardProvider) => PROVIDER_FIELD_SCORECARD.filter((r) => r.provider === p && r.capability === req.capability && missing.has(r.field))
  const routed = new Set<string>()
  if (req.capability in CONTACT_PROVIDER_ROUTES) {
    const route = routeCapability(req.capability as ProviderCapability, req.health ?? {})
    for (const s of route.skipped) out.skipped.push(s)
    for (const p of route.providers) {
      routed.add(p)
      const a = (PROVIDER_ACTIVATION as Partial<Record<string, ProviderActivation>>)[p]
      const sp = p as ScorecardProvider
      const rows = a ? rowsFor(sp) : []
      if (!a) { out.skipped.push({ provider: p, reason: "outside the C39 acquisition stack — routed by its own caller" }); continue }
      if (a.state === "dormant_survivor" && a.survivorDoors === "closed") { out.skipped.push({ provider: p, reason: "dormant survivor (R9) — its doors are closed until activation evidence is recorded" }); continue }
      if (rows.length === 0) { out.skipped.push({ provider: p, reason: "sells none of the missing fields" }); continue }
      out.steps.push({
        provider: sp, fields: rows.map((r) => r.field), unitUsd: rows[0].unitUsd, unit: rows[0].unit, source: "route_table", mayCallLive: true,
        why: a.state === "dormant_survivor" ? "dormant survivor (R9) — live only until the owner confirms its doors close" : "active and in the route table",
      })
    }
  }
  for (const p of Object.keys(PROVIDER_ACTIVATION) as ScorecardProvider[]) {
    if (routed.has(p)) continue
    const rows = rowsFor(p)
    if (rows.length === 0) continue
    const a = PROVIDER_ACTIVATION[p]
    if (a.state !== "dormant_pending_rights") { out.skipped.push({ provider: p, reason: `${a.state} — not in this capability's route row (reached through its own door, e.g. the property-lookup rungs)` }); continue }
    if (req.mode === "live") { out.skipped.push({ provider: p, reason: `${a.state} — not in the route table; license / rights unverified blocks activation` }); continue }
    out.steps.push({ provider: p, fields: rows.map((r) => r.field), unitUsd: rows[0].unitUsd, unit: rows[0].unit, source: "dormant_candidate", mayCallLive: false, why: `${a.state} — offline simulation only (no transport, no spend)` })
  }
  if (out.steps.length === 0) out.noCallReason = req.mode === "live" ? "no active, licensed provider sells the missing fields" : "no provider sells the missing fields"
  return out
}
