// lib/providers/provider-pilot.ts
//
// THE 2,400-CANDIDATE MATCHED PILOT — DESIGN AS AN EXECUTABLE SIMULATION (wave 150, lane 150HIAB — contract C39, owner
// ruling R9, directive canary 9). It runs over a supabase-shaped client the caller hands it (an in-memory one in the
// proof), READS ONLY, and never reaches a vendor: there is no transport in this file, every provider answer comes from
// the caller's `simulate` function, and the result says `paidCalls: 0` / `liveCalls: 0` because none can happen.
//
// C39 pilot design, as the owner wrote it: "2,400 matched candidates (600 consented inbound / 600 owners missing
// right-party contact / 600 independently evidenced possible sellers / 600 controls) across solo, team, office,
// multi-office; sandbox / no-cost first; identical input cohort; per-field new coverage, right-party verified contact,
// seller-score lift over the public-property baseline, suppression, freshness, 30/90-day outcomes, true marginal cost,
// cost per newly usable legally eligible person / qualified appointment; holdouts and provenance. 50k/month is a
// SIMULATION target." Directive: "Never rank DataZapp score's 4x labels numerically as Tracerfy 0–100; calibrate both
// against observed results." A proposed PAID pilot cap of $1,000 is NOT approved (spec): this file cannot spend.
//
// What it decides: whether the cohort is a valid matched design (deduplicated, balanced per stratum × tenant shape), and
// — given simulated answers — the per-arm scorecard. What it never decides: activation. activationVerdict stays false for
// every provider whose license is unknown, and the simulation runs anyway (license unknown blocks ACTIVATION, not offline
// testing).

import { planProviderWaterfall, activationVerdict, labelSellerSignal, compareSellerSignals, PROVIDER_FIELD_SCORECARD, PROVIDER_RECOMMENDATION, PROVIDER_SELECTION_STATUS, RECOMMENDATION_TIERS, formatUnitUsd, type ScoreField, type ScorecardProvider, type SellerSignalName } from "@/lib/providers/provider-scorecard"
import { mapDormantProviderResponse, type DormantProduct } from "@/lib/providers/dormant-adapters"

// ═════════════════════════════════════════════════════════════════════════════
// THE ONE BOUNDED MATCHED-COHORT EVALUATION DESIGN (wave 151, lane 151G — directive 151G "Tracerfy / DataZapp / BatchData /
// PeopleData: run one bounded matched-cohort evaluation" + "Matched pilot design — no paid calls without approval").
// This EXTENDS the C39 pilot above (LAW 1): the strata × tenant-shape simulation stays the executable half; this block is
// the DESIGN half the directive asks for — the population cohorts, what is held constant, what is measured, the blinded
// verification sample, the explicit unknowns, the directive's specific questions with their documented answers, and the
// 50,000-record-a-month waterfall projection with CLEARLY LABELLED variables (never a fictional price: every unit price is
// read from PROVIDER_FIELD_SCORECARD; an unpublished price stays UNKNOWN). Nothing here calls a vendor, spends, or
// selects a provider — `spend.approved` is false, the $1,000 cap is NOT approved, and the owner decides.
// ═════════════════════════════════════════════════════════════════════════════

/** The four providers the evaluation compares (R9's pilot pair + the two dormant survivors), and the incumbents whose
 *  already-held answers the "incremental overlap" is measured against. */
export const EVALUATION_ARMS: readonly ScorecardProvider[] = ["tracerfy", "datazapp", "batchdata", "peopledata"]
const INCUMBENTS: readonly ScorecardProvider[] = ["versium", "rentcast"]

export type EvaluationCohort = "owner_occupied" | "absentee_owner" | "seller_candidate" | "buyer_candidate" | "sparse_rural" | "dense_urban" | "hard_identity"

export interface CohortSpec {
  cohort: EvaluationCohort
  definition: string
  /** How members are drawn from PLATFORM-HELD records (never a vendor list) — and the rule that keeps cohorts disjoint. */
  drawnFrom: string
  /** The fields every arm is asked for on this cohort (constant across providers). */
  expectedFields: readonly ScoreField[]
  /** Bounded size per cohort (records); the total is the design's one bound. */
  size: number
}

export const MATCHED_COHORT_DESIGN = Object.freeze({
  id: "wave151-151G-matched-cohort-evaluation-v1",
  status: "DESIGN — simulation only; no vendor called, no record bought, no credential requested" as const,
  arms: EVALUATION_ARMS,
  incumbents: INCUMBENTS,
  /** Non-overlapping cohorts: a record belongs to exactly ONE (the first rule it satisfies, in this order). */
  cohorts: [
    { cohort: "hard_identity", definition: "intentionally difficult-match identities: hyphenated / suffixed / very common names, recent movers (a prior address held), PO-box or multi-unit mailing addresses, trusts and LLC owners", drawnFrom: "platform-held records flagged by the identity keys (lib/identity/subject-identity.ts) as multi-key or ambiguous — assigned FIRST so no other cohort absorbs them", expectedFields: ["owner_phone", "owner_email", "mailing_address"], size: 150 },
    { cohort: "absentee_owner", definition: "property owner whose mailing address differs from the property address (RentCast ownerOccupied false / owner.mailingAddress ≠ formattedAddress)", drawnFrom: "RentCast property records already held (no new purchase) — assigned before owner_occupied", expectedFields: ["owner_phone", "owner_email", "mailing_address", "seller_signal"], size: 150 },
    { cohort: "owner_occupied", definition: "owner lives at the property (RentCast ownerOccupied true or mailing address = property address)", drawnFrom: "RentCast property records already held", expectedFields: ["owner_phone", "owner_email", "length_of_residence"], size: 150 },
    { cohort: "seller_candidate", definition: "a person with EXPRESSED INTEREST or INFERRED POSSIBILITY of selling in the readiness dimensions (never a vendor score alone)", drawnFrom: "Contacts / Raw Leads whose readiness evidence class is expressed_interest or inferred_possibility on the SELL side, not already in a cohort above", expectedFields: ["owner_phone", "owner_email", "seller_signal", "distress_signal"], size: 150 },
    { cohort: "buyer_candidate", definition: "a buyer with STATED criteria on a consent basis (property_preferences criteria_provenance said + consent)", drawnFrom: "consented buyers not in a cohort above — the verification TRUTH set (their contact points are held)", expectedFields: ["owner_phone", "owner_email", "employment"], size: 150 },
    { cohort: "sparse_rural", definition: "property in a ZIP whose RentCast /markets totalListings is in the bottom quartile of the tenant's territories (sparse inventory, rural / exurban)", drawnFrom: "territory ZIP statistics already cached; records not in a cohort above", expectedFields: ["owner_phone", "owner_email", "property_facts"], size: 150 },
    { cohort: "dense_urban", definition: "property in a ZIP whose totalListings is in the top quartile, multi-family / condo share high", drawnFrom: "territory ZIP statistics already cached; records not in a cohort above", expectedFields: ["owner_phone", "owner_email", "property_facts"], size: 150 },
  ] as readonly CohortSpec[],
  /** What is held CONSTANT across every arm. */
  constants: {
    rawIdentity: "the SAME raw identity string per record (name + address + ZIP, plus any held email / phone) is sent to every arm — no arm gets a cleaned or enriched version",
    dataAge: "a record's data age (last_verified_at / signal_at, lib/lead-pipeline/freshness.ts) is frozen at cohort draw; every arm sees the same age",
    expectedFields: "the per-cohort expectedFields list is the ask for every arm; an arm that does not sell a field is scored 'not sold', never penalised as a miss",
    order: "arms are asked in parallel on identical input (no arm sees another arm's answer); the incumbents' already-held answers are the overlap baseline, never re-bought",
  },
  blindedVerification: {
    sampleShare: 0.2,
    method: "a 20% random sample per cohort is verified for right-party accuracy against contact points the platform ALREADY holds with consent (the buyer_candidate truth set, consented inbound records); the verifier sees provider answers with the provider name REMOVED",
    lawful: "phone / email usability is judged only where a lawful basis to contact exists (TCPA / CAN-SPAM; the DNC gate decides) — no verification call is placed to a person",
  },
  measures: [
    "match rate (hits ÷ attempted) per cohort per arm",
    "field accuracy on the blinded sample (right-party verified ÷ checked)",
    "phone / email usability when lawful (non-DNC mobile or deliverable email that is the right person)",
    "owner / property ambiguity (answers naming more than one owner, or an owner not on the record)",
    "data refresh age (the vendor's dated fields where published; otherwise 'unpublished')",
    "cost per usable unique person (true marginal cost: misses free on per-match products; retries billed)",
    "incremental overlap beyond the incumbents (a field the incumbents already hold is not new coverage)",
    "signal usefulness: seller / refinance propensity evidence in the VENDOR'S OWN unit, observed against 90-day outcomes — never a probability, never cross-ranked",
    "read / write / update capabilities (batch read, single read, push / monitor, update of a held record)",
    "SaaS / multi-tenant LICENSE (written platform use, storage on tenant records, end-user delivery, white-label terms)",
    "storage and customer-facing data rights (retention, deletion, what may be shown to a consumer)",
  ] as readonly string[],
  /** The directive's specific questions, answered from what was READ (docs/commercial/CUSTOMER-360-PROVIDER-COMPARISON.md §10–§11, the vendor pages dated there) — 'unresolved' where nothing was read. */
  questions: [
    { id: "tracerfy_vs_versium_overlap", question: "What does Tracerfy supply that overlaps Versium?", answer: "Owner / person phone and email (Normal / Advanced Trace ↔ Versium Contact Append) and basic age / DOB. Tracerfy ADDS what Versium does not sell: a DNC / TCPA-litigator scrub, phone intelligence, address-only owner trace, parcel (APN) trace, Property Monitors and TraceAI propensity scores. Versium ALONE sells online-presence indicators, the free audience estimate, Online Audience Append and the B2B2C crosswalk, and is cheaper on the real-time single lookup (Tracerfy instant = 5 credits).", basis: "documented" },
    { id: "tracerfy_seller_score_definition", question: "Does Tracerfy's seller score have a published definition or predictive validation?", answer: "No. The pages read name five TraceAI propensity scores (sell, refinance, roof, HVAC, solar — 'each score returns the exact factors that fired') but publish no scale, no definition of the sell score and no validation against outcomes; the JSON key is not documented, so lib/providers/dormant-adapters.ts labels nothing until the sandbox schema is read.", basis: "unresolved" },
    { id: "batchdata_unique_functions", question: "Which BatchData property / ownership / acquisition functions are unique beyond RentCast / Tracerfy / Versium?", answer: "Motivated-seller quickLists (pre-foreclosure, absentee, vacant …) as a property SEARCH at scale; the Smart Search push webhook (property-change events); skip trace of LLC / corporate owners (Tracerfy covers individuals only); the comparable / property datasets used as the AVM-chain BACKUP after a named RentCast miss; the DNC / TCPA MCP check overlaps Tracerfy's scrub, not RentCast's or Versium's. BatchRank sale propensity is an add-on not on the account.", basis: "documented" },
    { id: "peopledata_missing_from_versium", question: "Which PeopleData fields actually remain missing from Versium?", answer: "The employment profile (job title, company, education, inferred experience) and social profile URLs (person_profile). Email validation overlaps (both sell it). Contact points overlap at 5× the price.", basis: "documented" },
    { id: "tracerfy_listing_feeds_photos", question: "Does Tracerfy offer active-listing feeds and licensed photos?", answer: "Not in any page read (pricing, features, API documentation, FAQ, Terms of Service, 2026-11-03): no active-listing feed and no listing-photo product is documented. Property Monitors are owner / property-change alerts, not MLS listings. Never presumed.", basis: "documented absence" },
    { id: "rentcast_facts_and_sold_records", question: "What RentCast property facts and sold records can feed real comps and the market-report producer?", answer: "The /v1/properties record carries lastSaleDate / lastSalePrice and history 'Sale' events — RECORDED sales (RENTCAST_DATA_TYPES.property_record); with saleDateRange it is an area sold-records filter (sold_records — reader not built, Outside-lane request). /avm/value comparables are LISTING records (last list price) and /markets is ZIP LISTING statistics — neither is a closed sale. lib/market-reports/research.ts now labels a RentCast comparable last_list_price and upgrades it to recorded_sale only when its own property record confirms a sale on or after the day it left the market.", basis: "documented" },
  ] as readonly { id: string; question: string; answer: string; basis: "documented" | "documented absence" | "unresolved" }[],
  unknowns: [
    "no vendor publishes a numeric match rate — every hit rate is an ASSUMED variable until measured",
    "Tracerfy's seller-score scale, definition, validation and JSON key",
    "DataZapp's Signal_Seller_Score price and modelling method",
    "BatchData's BatchRank add-on (not on the account) and its Terms (not read)",
    "PeopleData per-credit tiers (not rendered 2026-11-03)",
    "every vendor's refresh cadence (unpublished)",
    "RentCast's Terms of Use (consumer display, attribution, retention) — not read",
    "the share of records that must be answered in real time (Tracerfy instant = 5 credits erodes its saving)",
  ] as readonly string[],
  spend: { approved: false as const, paidCalls: 0 as const, capUsd: null as number | null, note: "the proposed $1,000 paid pilot cap is NOT approved; the sandbox (mock.tracerfy.com) proves shape, not data; a bounded paid sample needs the owner's explicit approval" },
  selection: PROVIDER_SELECTION_STATUS,
})

/** The labelled variables of the monthly waterfall projection. Every value is ASSUMED unless the caller measured it. */
export interface WaterfallVariables {
  /** Records reaching the gap fill per month AFTER pre-pull dedup. */
  monthlyRecords: number
  /** h — share of attempted records that come back with a usable answer. ASSUMED until measured. */
  hitRate: number
  /** u — share of hits that are the right person with a lawful, usable contact point. ASSUMED until measured. */
  usableShare: number
  /** Share of records that must be answered in real time (the batch price does not apply). ASSUMED until measured. */
  realTimeShare: number
  /** The field each stage is asked for — the waterfall stops at the first provider that fills it. */
  field: ScoreField
}

export interface WaterfallStageProjection {
  stage: number
  provider: ScorecardProvider
  recommendation: string
  unit: string
  /** Attempted records at this stage (the previous stage's misses). */
  attempted: number
  /** Expected hits = attempted × h (ASSUMED). */
  expectedHits: number
  /** USD at the published unit — null when the unit is UNKNOWN (never a guess). */
  costUsd: number | null
  costPerUsablePerson: number | null
  note: string
}

export interface MonthlyWaterfallProjection {
  basis: "PROJECTION_WITH_LABELED_VARIABLES"
  variables: WaterfallVariables
  variableLabels: Record<keyof WaterfallVariables, string>
  stages: WaterfallStageProjection[]
  totalUsd: number | null
  unknownStages: string[]
  disclaimer: string
}

/**
 * PURE — the 50,000-record-a-month WATERFALL PROJECTION with labelled variables (directive 151G). The order is the
 * capability-first waterfall's: incumbents first (a field already held is never bought again), then the evaluation arms by
 * recommendation tier and published unit price. Every unit price is read from PROVIDER_FIELD_SCORECARD; a provider whose
 * price is unpublished contributes `costUsd: null` and is listed under `unknownStages` — the total is then null, never a
 * number built on a guess. No literal price lives in this function.
 * Product reader: the platform connector-healing console (app/dashboard/superadmin/connector-healing/page.tsx, the
 * matched-cohort card); scripts/provider-gap-matrix-guard.ts renders the doc table from it and asserts no price literal
 * outside the scorecard.
 */
export function projectMonthlyWaterfall(vars: Partial<WaterfallVariables> = {}): MonthlyWaterfallProjection {
  const v: WaterfallVariables = { monthlyRecords: vars.monthlyRecords ?? SIMULATED_MONTHLY_RECORDS, hitRate: vars.hitRate ?? 0.6, usableShare: vars.usableShare ?? 0.5, realTimeShare: vars.realTimeShare ?? 0, field: vars.field ?? "owner_phone" }
  const labels: MonthlyWaterfallProjection["variableLabels"] = {
    monthlyRecords: "records reaching the gap fill per month after pre-pull dedup (the directive's projection size — a SIMULATION target, never a request size)",
    hitRate: "h — ASSUMED hit rate (no vendor publishes one); the table is re-run at 0.4 / 0.6 / 0.8 in the doc",
    usableShare: "u — ASSUMED share of hits that are the right person with a lawful usable contact point",
    realTimeShare: "ASSUMED share answered in real time (Tracerfy's batch price does not apply to it)",
    field: "the field the waterfall is asked for",
  }
  // The stage order after the incumbents is the recommendation vocabulary's own order (RECOMMENDATION_TIERS), then price.
  const tierOrder = (p: ScorecardProvider) => RECOMMENDATION_TIERS.indexOf(PROVIDER_RECOMMENDATION[p].tier)
  const sellers = PROVIDER_FIELD_SCORECARD.filter((r) => r.field === v.field && r.capability === "owner_contact")
  const ordered = [...sellers].sort((a, b) => {
    const ia = INCUMBENTS.includes(a.provider) ? 0 : 1, ib = INCUMBENTS.includes(b.provider) ? 0 : 1
    if (ia !== ib) return ia - ib
    const ta = tierOrder(a.provider), tb = tierOrder(b.provider)
    if (ta !== tb) return ta - tb
    return (a.unitUsd ?? Number.POSITIVE_INFINITY) - (b.unitUsd ?? Number.POSITIVE_INFINITY)
  })
  const stages: WaterfallStageProjection[] = []
  const unknownStages: string[] = []
  let remaining = v.monthlyRecords
  let total: number | null = 0
  ordered.forEach((r, i) => {
    const attempted = Math.round(remaining)
    const hits = Math.round(attempted * v.hitRate)
    let cost: number | null
    if (r.unitUsd === null) { cost = null; unknownStages.push(`${r.provider}: ${formatUnitUsd(r.unitUsd, r.unit)}`) }
    else if (r.unit === "per_match") cost = hits * r.unitUsd
    else cost = attempted * r.unitUsd
    // Tracerfy's bulk price is for batch queues; the real-time share pays the instant multiple (documented 5 credits vs 1).
    const batchNote = r.batchOnly ? `batch price; ${Math.round(v.realTimeShare * 100)}% real-time share would pay the instant multiple (documented 5 credits a lookup)` : ""
    if (r.batchOnly && cost !== null && v.realTimeShare > 0) cost = cost * (1 - v.realTimeShare) + cost * v.realTimeShare * 5
    const usable = hits * v.usableShare
    stages.push({
      stage: i + 1, provider: r.provider, recommendation: PROVIDER_RECOMMENDATION[r.provider].tier, unit: formatUnitUsd(r.unitUsd, r.unit), attempted, expectedHits: hits,
      costUsd: cost === null ? null : Math.round(cost * 100) / 100, costPerUsablePerson: cost === null || usable <= 0 ? null : Math.round((cost / usable) * 100) / 100,
      note: [INCUMBENTS.includes(r.provider) ? "incumbent — a field already held is never re-bought (pre-pull dedup)" : `${PROVIDER_RECOMMENDATION[r.provider].tier} — not selected; offline only until the owner decides`, batchNote].filter(Boolean).join("; "),
    })
    total = total === null || cost === null ? null : total + cost
    remaining = attempted - hits
  })
  return {
    basis: "PROJECTION_WITH_LABELED_VARIABLES", variables: v, variableLabels: labels, stages, totalUsd: total === null ? null : Math.round(total * 100) / 100, unknownStages,
    disclaimer: "a projection over ASSUMED h / u / real-time variables and PUBLISHED unit prices (unpublished = UNKNOWN, total withheld); it ranks cost, never accuracy — only the blinded matched-cohort evaluation can rank usable-person yield",
  }
}

type PilotStratum = "consented_inbound" | "owner_missing_contact" | "evidenced_possible_seller" | "control"
type TenantShape = "solo" | "team" | "office" | "multi_office"
const PILOT_STRATA: readonly PilotStratum[] = ["consented_inbound", "owner_missing_contact", "evidenced_possible_seller", "control"]
const TENANT_SHAPES: readonly TenantShape[] = ["solo", "team", "office", "multi_office"]
const PER_STRATUM = 600
const PER_CELL = PER_STRATUM / TENANT_SHAPES.length // 150 per stratum × tenant shape
/** 50,000 records a month is a SIMULATION target (directive) — arithmetic only, never a request size. */
const SIMULATED_MONTHLY_RECORDS = 50_000

/** The matched pair R9 names; each non-control candidate is the IDENTICAL input to both arms. */
const PILOT_ARMS: readonly ScorecardProvider[] = ["tracerfy", "datazapp"]
const ARM_SELLER_FIELD: Readonly<Partial<Record<ScorecardProvider, SellerSignalName>>> = Object.freeze({
  tracerfy: "tracerfy_lead_builder_seller_score",
  datazapp: "datazapp_signal_seller_score",
})

interface PilotCandidate {
  rawId: string
  brokerageId: string
  tenantShape: TenantShape
  stratum: PilotStratum
  identityKey: string
  missing: ScoreField[]
  /** Already contacted / suppressed records are never counted as newly usable. */
  suppressed: boolean
  /** Consented inbound only: the right-party contact we already hold, to verify a provider's answer against. */
  truth: { phone: string | null; email: string | null } | null
  /** The public-property baseline signal (e.g. absentee / tax-delinquent from public facts) — the lift's reference. */
  publicBaseline: boolean
  /** Simulated outcomes (qualified appointment — an appointment is not a closing). */
  outcome30: boolean
  outcome90: boolean
}

/** What a simulated provider answers for one candidate (the caller's deterministic fake — never a live call). */
export interface SimulatedAnswer { hit: boolean; phone?: string | null; email?: string | null; dnc?: boolean; sellerValue?: number | string | null; retries?: number; ageDays?: number | null }

interface ArmScore {
  provider: ScorecardProvider
  attempted: number
  calls: number
  hits: number
  perFieldNewCoverage: Partial<Record<ScoreField, number>>
  rightPartyVerified: { checked: number; verified: number }
  newlyUsableEligible: number
  suppressedExcluded: number
  medianAgeDays: number | null
  simulatedCostUsd: number
  costPerNewlyUsable: number | null
  sellerSignal: { field: SellerSignalName | null; labelled: number; refused: number; topBucketOutcome90: number | null; baselineOutcome90: number | null; lift: number | null; why: string }
  outcomes: { appt30: number; appt90: number }
  costPerQualifiedAppointment: number | null
}

export interface PilotScorecard {
  valid: boolean
  designProblems: string[]
  cohort: { candidates: number; duplicatesDropped: number; perCell: Record<string, number> }
  holdout: { candidates: number; appt30: number; appt90: number }
  arms: ArmScore[]
  /** Seller signals are compared WITHIN a provider's own unit only. */
  crossProviderRanking: null
  activation: Array<{ provider: ScorecardProvider; mayActivate: boolean; blockers: string[] }>
  projection: { monthlyRecords: number; costUsdByArm: Record<string, number | null>; basis: "SIMULATION" }
  paidCalls: 0
  liveCalls: 0
  blindSpots: string[]
  /** The evaluation design this run executes the simulation half of (MATCHED_COHORT_DESIGN.id). */
  design: string
}

function identityKeyOf(r: { first_name?: string | null; last_name?: string | null; address?: string | null; zip_code?: string | null }): string {
  const n = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "")
  return `${n(r.first_name)}|${n(r.last_name)}|${n(r.address)}|${n(r.zip_code)}`
}

/** The lowest value of each field's TOP bucket, in the vendor's own documented order. Absent = no documented order. */
const TOP_BUCKET_FLOOR: Readonly<Partial<Record<SellerSignalName, string>>> = Object.freeze({ datazapp_signal_seller_score: "3x" })

/**
 * Top bucket in a provider's OWN documented order — ordered by compareSellerSignals against the floor labelled in the SAME
 * field, so the order is the scorecard's one definition; an undocumented scale has none (lift needs calibration first).
 */
function inTopBucket(field: SellerSignalName, value: number | string): boolean | null {
  const floor = TOP_BUCKET_FLOOR[field]
  if (floor === undefined) return null
  const at = "1970-01-01T00:00:00.000Z"
  const a = labelSellerSignal(field, value, at), f = labelSellerSignal(field, floor, at)
  if (!a.ok || !f.ok) return null
  const c = compareSellerSignals(a.signal, f.signal)
  return c === null ? null : c >= 0
}

/** PURE — a recorded documented-shape response → the answer the pilot scores. The dormant mappers map NO contact
 *  fields (Tracerfy documents only hit / credits; DataZapp's per-row email key is undocumented), so a replayed answer can
 *  only carry the hit and a labelled seller signal — a replay never invents a phone or an email. */
function answerFromRecorded(product: DormantProduct, raw: unknown, at: string): SimulatedAnswer {
  const mapped = mapDormantProviderResponse(product, raw, at)
  return { hit: mapped.billing.hit === true, phone: null, email: null, sellerValue: mapped.sellerSignals[0]?.value ?? null }
}

/**
 * THE SIMULATION. Reads the cohort from `raw_scraped_leads` rows whose `evidence.pilot` names the stratum, tenant shape,
 * the fields missing, suppression, the consented truth, the public baseline and the simulated outcomes; validates the
 * matched design; runs both arms over the identical input; scores them. Writes nothing.
 * @proofSeam the C39 pilot is a DESIGN executed on an in-memory client by scripts/provider-scorecard-guard.ts — no
 * product surface runs a pilot until the owner approves a no-cost sandbox or a bounded paid test
 */
export async function simulateProviderPilot(
  svc: { from: (t: string) => any },
  deps: {
    simulate: (provider: ScorecardProvider, c: Readonly<PilotCandidate>) => SimulatedAnswer
    now: Date
    /** A RECORDED documented-shape response (a sandbox / mock reply the owner saved — never a live call) for this
     *  candidate: it is replayed through the dormant mapper (documented fields only), so the pilot scores what the
     *  provider's own response shape would yield. Absent or null → `simulate` answers. */
    replay?: (provider: ScorecardProvider, c: Readonly<PilotCandidate>) => { product: DormantProduct; raw: unknown } | null
  },
): Promise<PilotScorecard> {
  const designProblems: string[] = []
  const blindSpots: string[] = [
    "outcomes are SIMULATED fixtures — real 30/90-day appointment outcomes need the live cohort",
    "the providers' answers are the caller's deterministic fakes — they prove the scoring, not the data",
    "Tracerfy's seller-score scale is undocumented: its lift is not computed until it is calibrated against outcomes",
  ]
  const { data, error } = await svc.from("raw_scraped_leads").select("id, brokerage_id, first_name, last_name, address, zip_code, evidence")
  if (error) {
    return { valid: false, designProblems: [`cohort read refused: ${error.message}`], cohort: { candidates: 0, duplicatesDropped: 0, perCell: {} }, holdout: { candidates: 0, appt30: 0, appt90: 0 }, arms: [], crossProviderRanking: null, activation: [], projection: { monthlyRecords: SIMULATED_MONTHLY_RECORDS, costUsdByArm: {}, basis: "SIMULATION" }, paidCalls: 0, liveCalls: 0, blindSpots, design: MATCHED_COHORT_DESIGN.id }
  }
  // C36 dedup: one candidate per identity (name + address + ZIP); a repeat is dropped, never double-counted.
  const seen = new Set<string>()
  let duplicatesDropped = 0
  const cohort: PilotCandidate[] = []
  for (const r of (data ?? []) as Array<Record<string, any>>) {
    const p = r?.evidence?.pilot
    if (!p || !PILOT_STRATA.includes(p.stratum) || !TENANT_SHAPES.includes(p.tenantShape) || !r.brokerage_id) continue
    const key = identityKeyOf(r)
    if (seen.has(key)) { duplicatesDropped++; continue }
    seen.add(key)
    cohort.push({
      rawId: String(r.id), brokerageId: String(r.brokerage_id), tenantShape: p.tenantShape, stratum: p.stratum, identityKey: key,
      missing: Array.isArray(p.missing) ? p.missing : [], suppressed: p.suppressed === true,
      truth: p.stratum === "consented_inbound" && p.truth ? { phone: p.truth.phone ?? null, email: p.truth.email ?? null } : null,
      publicBaseline: p.publicBaseline === true, outcome30: p.outcome30 === true, outcome90: p.outcome90 === true,
    })
  }
  const perCell: Record<string, number> = {}
  for (const s of PILOT_STRATA) for (const t of TENANT_SHAPES) perCell[`${s}×${t}`] = cohort.filter((c) => c.stratum === s && c.tenantShape === t).length
  for (const [cell, n] of Object.entries(perCell)) if (n !== PER_CELL) designProblems.push(`${cell}: ${n} candidates (the matched design needs ${PER_CELL})`)
  if (cohort.length !== PER_STRATUM * PILOT_STRATA.length) designProblems.push(`cohort is ${cohort.length} deduplicated candidates (the design needs ${PER_STRATUM * PILOT_STRATA.length})`)

  const control = cohort.filter((c) => c.stratum === "control")
  const treated = cohort.filter((c) => c.stratum !== "control")
  const rate = (xs: PilotCandidate[], f: (c: PilotCandidate) => boolean) => (xs.length === 0 ? null : Math.round((xs.filter(f).length / xs.length) * 1000) / 1000)
  const at = deps.now.toISOString()

  const arms: ArmScore[] = PILOT_ARMS.map((provider) => {
    const sellerField = ARM_SELLER_FIELD[provider] ?? null
    const arm: ArmScore = {
      provider, attempted: 0, calls: 0, hits: 0, perFieldNewCoverage: {}, rightPartyVerified: { checked: 0, verified: 0 }, newlyUsableEligible: 0,
      suppressedExcluded: 0, medianAgeDays: null, simulatedCostUsd: 0, costPerNewlyUsable: null,
      sellerSignal: { field: sellerField, labelled: 0, refused: 0, topBucketOutcome90: null, baselineOutcome90: null, lift: null, why: "" },
      outcomes: { appt30: 0, appt90: 0 }, costPerQualifiedAppointment: null,
    }
    const ages: number[] = []
    const top: PilotCandidate[] = []
    for (const c of treated) {
      arm.attempted++
      // Ask only for what is missing, through the ONE waterfall, in OFFLINE mode (the dormant arm is offline-only).
      const plan = planProviderWaterfall({ capability: "owner_contact", missingFields: c.missing, mode: "offline_simulation" })
      const step = plan.steps.find((s) => s.provider === provider)
      const wantsScore = c.stratum === "evidenced_possible_seller" && sellerField !== null
      if (!step && !wantsScore) continue
      if (step && step.mayCallLive) designProblems.push(`${provider} planned as live-callable — a pilot arm must be offline`)
      const recorded = deps.replay?.(provider, c) ?? null
      const a: SimulatedAnswer = recorded ? answerFromRecorded(recorded.product, recorded.raw, at) : deps.simulate(provider, c)
      arm.calls++
      const retries = Math.max(0, a.retries ?? 0)
      // True marginal cost: per-match products bill hits only; retries and per-record products bill every attempt.
      const contactRow = PROVIDER_FIELD_SCORECARD.find((r) => r.provider === provider && r.capability === "owner_contact")
      if (step && contactRow?.unitUsd != null) arm.simulatedCostUsd += contactRow.unit === "per_match" ? (a.hit ? contactRow.unitUsd : 0) : contactRow.unitUsd * (1 + retries)
      const scoreRow = PROVIDER_FIELD_SCORECARD.find((r) => r.provider === provider && r.capability === "seller_signal_score")
      if (wantsScore && scoreRow?.unitUsd != null) arm.simulatedCostUsd += scoreRow.unitUsd
      if (a.hit) arm.hits++
      if (typeof a.ageDays === "number") ages.push(a.ageDays)
      const filled: ScoreField[] = []
      if (c.missing.includes("owner_phone") && a.phone) filled.push("owner_phone")
      if (c.missing.includes("owner_email") && a.email) filled.push("owner_email")
      for (const f of filled) arm.perFieldNewCoverage[f] = (arm.perFieldNewCoverage[f] ?? 0) + 1
      if (c.truth) {
        arm.rightPartyVerified.checked++
        if ((a.phone && a.phone === c.truth.phone) || (a.email && a.email === c.truth.email)) arm.rightPartyVerified.verified++
      }
      const usable = filled.length > 0 && !(filled.length === 1 && filled[0] === "owner_phone" && a.dnc === true)
      if (usable && c.suppressed) arm.suppressedExcluded++
      else if (usable) {
        arm.newlyUsableEligible++
        if (c.outcome30) arm.outcomes.appt30++
        if (c.outcome90) arm.outcomes.appt90++
      }
      if (wantsScore && sellerField && a.sellerValue !== undefined && a.sellerValue !== null) {
        const l = labelSellerSignal(sellerField, a.sellerValue, at)
        if (!l.ok) arm.sellerSignal.refused++
        else {
          arm.sellerSignal.labelled++
          if (inTopBucket(sellerField, l.signal.value) === true) top.push(c)
        }
      }
    }
    arm.simulatedCostUsd = Math.round(arm.simulatedCostUsd * 100) / 100
    ages.sort((x, y) => x - y)
    arm.medianAgeDays = ages.length ? ages[Math.floor(ages.length / 2)] : null
    arm.costPerNewlyUsable = arm.newlyUsableEligible > 0 ? Math.round((arm.simulatedCostUsd / arm.newlyUsableEligible) * 100) / 100 : null
    arm.costPerQualifiedAppointment = arm.outcomes.appt90 > 0 ? Math.round((arm.simulatedCostUsd / arm.outcomes.appt90) * 100) / 100 : null
    const sellers = treated.filter((c) => c.stratum === "evidenced_possible_seller")
    const baseline = rate(sellers.filter((c) => c.publicBaseline), (c) => c.outcome90)
    arm.sellerSignal.baselineOutcome90 = baseline
    if (!sellerField || inTopBucket(sellerField, "4x") === null) {
      arm.sellerSignal.why = `${sellerField}: the vendor scale is undocumented — no top bucket, no lift until calibrated against outcomes`
    } else {
      const topRate = rate(top, (c) => c.outcome90)
      arm.sellerSignal.topBucketOutcome90 = topRate
      arm.sellerSignal.lift = topRate !== null && baseline !== null ? Math.round((topRate - baseline) * 1000) / 1000 : null
      arm.sellerSignal.why = `${sellerField}: 90-day appointment rate in the vendor's own top labels (3x–4x) minus the public-property baseline — an observed difference in this cohort, not a probability`
    }
    return arm
  })

  const costPerAttempt = (a: ArmScore) => (a.attempted > 0 ? a.simulatedCostUsd / a.attempted : null)
  return {
    valid: designProblems.length === 0,
    designProblems,
    cohort: { candidates: cohort.length, duplicatesDropped, perCell },
    holdout: { candidates: control.length, appt30: control.filter((c) => c.outcome30).length, appt90: control.filter((c) => c.outcome90).length },
    arms,
    crossProviderRanking: null,
    activation: PILOT_ARMS.map((p) => { const v = activationVerdict(p); return { provider: p, mayActivate: v.mayActivate, blockers: v.blockers } }),
    projection: {
      monthlyRecords: SIMULATED_MONTHLY_RECORDS,
      costUsdByArm: Object.fromEntries(arms.map((a) => { const c = costPerAttempt(a); return [a.provider, c === null ? null : Math.round(c * SIMULATED_MONTHLY_RECORDS * 100) / 100] })),
      basis: "SIMULATION",
    },
    paidCalls: 0,
    liveCalls: 0,
    blindSpots,
    design: MATCHED_COHORT_DESIGN.id,
  }
}
