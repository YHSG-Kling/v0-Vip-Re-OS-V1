// lib/intent/moving-moments.ts
//
// THE MOVING-MOMENTS EVIDENCE MODEL (contract C37), THE DECISION-WINDOW FORECASTER (150N) and THE NEEDS × EXPECTATION ×
// FEASIBILITY READING the arbiter reasons over (contract C38) — wave 150, lane 150JNAD (directive 150J + 150N + 150AD; owner
// rulings R2, 2026-11-06: readiness is NOT derived from `contact_type`).
//
// NOT A SECOND PREDICTION STORE (LAW 1 / LAW 2). This module is PURE and composes the survivors:
//   the evidence      lib/intent/movement-signals.ts (C9 records, m892) read per decision by lib/intent/opportunity-discovery.ts
//                     readOpportunities (lane 149H) — the moment is computed OVER that reading, never beside it;
//   the frozen claim  public.ai_predictions (prediction_type 'decision_window') via lib/analytics/ai-prediction-outcomes.ts — the
//                     ONE prediction ledger; calibration reads its graded rows (lib/intelligence/strategy-learning.ts
//                     calibrateDecisionWindows);
//   the snapshot      movement_signals.moment / decision_window (m970), stamped by the movement manager's decision;
//   the holdout arm   lib/kernel/experiments.ts assignExperimentArm (THE deterministic arm picker) with the definition below;
//   the engagement    lib/enrichment/life-event-vocabulary.ts LIFE_EVENT_ENGAGEMENT_MODES — a C38 play RIDES one of those modes
//                     (one vocabulary for the posture; the play names the kind of help).
//
// WHY DESIRE AND EXPECTATION ARE SEPARATE (Coulter, van Ham & Feijten): wanting to move and expecting to move are different
// states, and many who want to never do; ability (financing, equity, inventory, a lease, a sell-before-buy chain) is what turns
// one into the other. That paper MOTIVATES the separation; nothing here is a calibrated probability. A probability is published
// ONLY from this tenant's own graded forecasts once enough VALIDATED outcomes exist (confirmed moves — an appointment is never a
// closing), and a vendor score stays a labelled signal in its own units (a PropertyRadar DistressScore of 85 is a 0–100 vendor
// rollup, never "an 85% chance").
//
// THE FORECASTER'S RULES (deterministic — AI explains, deterministic services calculate and gate):
//   1. Only a PERSON we hold gets a person-level moment. A territory / property / anonymous subject (an anonymous neighbourhood
//      topic) never yields a prediction about anyone.
//   2. STATED DATES BEAT INFERRED RANGES: a known deadline (a documented lease end, a planned MLS go-live date, a closing date) →
//      the window it falls in; else the person's own timeline bucket; else — only when the reading is `emerging` or stronger and
//      nothing blocks — a labelled PRIOR range per kind of evidence; else UNKNOWN.
//   3. MIXED EVIDENCE IS UNKNOWN: negative evidence as new as the newest positive (a declined offer of help, a false positive, an
//      opt-out, a withdrawn listing, a purchase just closed) makes the window UNKNOWN — a legitimate answer, never a guess.
//   4. DESIRE WITHOUT FEASIBILITY IS NOT "READY NOW": a blocked ability caps readiness at `considering`, and with no known date
//      the window is UNKNOWN (nobody knows when a barrier clears).
//   5. The windows are REPORTING INTERVALS (0–30 / 31–90 / 91–180 / 181–365 / >365 / UNKNOWN), never a follow-up cadence. The
//      person-facing vocabulary stays the timeline buckets (CLAUDE.md §5); a bucket maps onto exactly one window.
//   6. R2: `contact_type` is never an input here. The side (buyer / seller / renter / investor) comes from the evidence, the
//      person's own words, or a recorded fact (home_owner_status), each labelled.

import type { OpportunityKind, OpportunityMenu, OpportunityObservation, OpportunityReading, OpportunityStage } from "@/lib/intent/opportunity-discovery"
import { EPISTEMIC_RANK, type EpistemicClass, type MovementRelevance } from "@/lib/intent/movement-source-registry"
import { screenLifeEventOutreach, type LifeEventEngagementMode } from "@/lib/enrichment/life-event-vocabulary"
import { assignExperimentArm, type ExperimentAssignment, type ExperimentDefinition, type ExperimentPolicy } from "@/lib/kernel/experiments"

const DAY_MS = 86_400_000

// ── vocabularies (one spelling each — CLAUDE.md §6) ──────────────────────────────────────────────────────────────────────────

/** The reporting intervals (owner directive 2026-11-06). ORDERED; `unknown` last. */
export const DECISION_WINDOWS = Object.freeze(["0_30", "31_90", "91_180", "181_365", "over_365", "unknown"] as const)
export type DecisionWindow = (typeof DECISION_WINDOWS)[number]
/** Inclusive day ranges of each window (upper null = open). A definition of the interval, not a schedule. */
const WINDOW_SPAN: Readonly<Record<Exclude<DecisionWindow, "unknown">, readonly [number, number | null]>> = Object.freeze({
  "0_30": [0, 30], "31_90": [31, 90], "91_180": [91, 180], "181_365": [181, 365], over_365: [366, null],
})

/** PURE. Days from now → its reporting window (a negative or non-finite value is unknown). */
export function decisionWindowForDays(days: number | null | undefined): DecisionWindow {
  if (typeof days !== "number" || !Number.isFinite(days) || days < 0) return "unknown"
  const d = Math.floor(days)
  for (const w of DECISION_WINDOWS) {
    if (w === "unknown") continue
    const [lo, hi] = WINDOW_SPAN[w]
    if (d >= lo && (hi === null || d <= hi)) return w
  }
  return "unknown"
}

/**
 * The person's own timeline bucket (contacts.timeline — m-vocabulary immediate / 1-3_months / 3-6_months / 6-12_months / 12+_months
 * / researching — and the public-text classifier's short spellings) → ONE window. `researching` is desire, not expectation.
 */
const TIMELINE_WINDOW: Readonly<Record<string, DecisionWindow>> = Object.freeze({
  immediate: "0_30", "1-3_months": "31_90", "1-3": "31_90", "3-6_months": "91_180", "3-6": "91_180",
  "6-12_months": "181_365", "6-12": "181_365", "12+_months": "over_365", researching: "unknown", unknown: "unknown",
})

/** PURE. A stated timeline spelling → its window (null = not a timeline spelling at all; `researching` → unknown). */
export function statedTimelineWindow(value: string | null | undefined): DecisionWindow | null {
  return value != null && Object.prototype.hasOwnProperty.call(TIMELINE_WINDOW, value) ? TIMELINE_WINDOW[value] : null
}

/** What a known date is. `lease_end` and `other_stated` come only from the person / a document; a go-live date from the listing row. */
export const KNOWN_DEADLINE_KINDS = Object.freeze(["lease_end", "planned_list_date", "closing_date", "relocation_start", "other_stated"] as const)
export type KnownDeadlineKind = (typeof KNOWN_DEADLINE_KINDS)[number]
export type KnownDeadlineSource = "person_stated" | "staff_entered" | "document" | "first_party_row" | "mls_record"

/** Readiness CONDITIONS the person or a verified fact names — never a psychographic category, never inferred distress. */
const BARRIER_KEYS = Object.freeze(["financing_not_ready", "no_equity", "no_fitting_inventory", "lease_term", "must_sell_first", "rate_lock_in", "timing_uncertain", "other_stated"] as const)
export type BarrierKey = (typeof BARRIER_KEYS)[number]

/** Per side, ORDERED. `unknown` = mixed evidence; `not_indicated` = nothing bears on this side. */
const READINESS_LEVELS = Object.freeze(["not_indicated", "unknown", "exploring", "considering", "preparing", "ready"] as const)
export type ReadinessLevel = (typeof READINESS_LEVELS)[number]

/** The investor's exit, in the owner's PropertyRadar REI Playbook v5.5 vocabulary (wholesale / fix-and-flip; buy-and-hold is the
 *  landlord exit the playbook's absentee play names). Read ONLY from the person's own words — never inferred. */
const INVESTOR_EXITS = Object.freeze(["wholesale", "fix_and_flip", "buy_and_hold"] as const)
export type InvestorExit = (typeof INVESTOR_EXITS)[number]

/** C38: the kinds of help, each riding ONE engagement mode of THE vocabulary (LIFE_EVENT_ENGAGEMENT_MODES). */
const READINESS_PLAYS = Object.freeze(["invite", "explain", "match", "clarify", "watch", "stay_quiet"] as const)
export type ReadinessPlay = (typeof READINESS_PLAYS)[number]
const PLAY_MODE: Readonly<Record<ReadinessPlay, LifeEventEngagementMode>> = Object.freeze({
  invite: "appropriate_outreach", clarify: "appropriate_outreach", explain: "helpful_education", match: "helpful_education",
  watch: "quiet_monitoring", stay_quiet: "quiet_monitoring",
})

// ── vendor scores: labelled signals in their own units (never a probability) ────────────────────────────────────────────────────

/** What each known vendor field IS. A field not listed is "a vendor-defined score in unverified units". */
const VENDOR_SCORE_UNITS: Readonly<Record<string, string>> = Object.freeze({
  "propertyradar:DistressScore": "PropertyRadar's 0–100 rollup of distress signals (a rank, not a filter, per the REI Playbook)",
  "propertyradar:LikelyListingScore": "PropertyRadar's vendor-defined listing-likelihood score (units not documented in the installed playbook — verify before use)",
  "propertyradar:LikelyPurchaseScore": "PropertyRadar's vendor-defined purchase-likelihood score (units not documented in the installed playbook — verify before use)",
  "datazapp:Signal_Seller_Score": "DataZapp's 0x–4x seller-signal label",
  "tracerfy:seller_score": "Tracerfy's Lead Builder seller score (vendor scale)",
  // wave 150, lane 150Z (150HIAB Outside-lane 1): BatchData's BatchRank add-on, labelled in its own unit.
  "batchdata:salePropensity": "BatchData's BatchRank sale-propensity score (vendor scale; the add-on is not on the platform account)",
})

export interface LabelledVendorScore { provider: string; field: string; value: number | string; unit: string; label: string; probability: null }

/** PURE. A vendor score → a labelled signal. `probability` is ALWAYS null: a score is never a chance. */
function labelVendorScore(s: { provider: string; field: string; value: number | string }): LabelledVendorScore {
  const unit = VENDOR_SCORE_UNITS[`${s.provider.toLowerCase()}:${s.field}`] ?? `${s.provider} ${s.field}: a vendor-defined score in unverified units`
  return { provider: s.provider, field: s.field, value: s.value, unit, label: `${s.provider} ${s.field} ${String(s.value)} — ${unit}; a provider signal in its own units, never a probability of a move`, probability: null }
}

// ── the model ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type MomentBasis = "person_stated" | "staff_entered" | "verified_record" | "observed" | "inferred" | "prior" | "none"

export interface MomentDimension<L extends string> { level: L; basis: MomentBasis; why: string; evidenceIds: string[] }

export interface MomentNegative { key: string; why: string; at: string; source: string }

/** The calibration shape lib/intelligence/strategy-learning.ts calibrateDecisionWindows returns (structural here). */
export interface DecisionWindowCalibrationView {
  byWindow: Partial<Record<DecisionWindow, { validated: number; hits: number; rate: number | null; interval: [number, number] | null; published: boolean; why: string }>>
  minValidated: number
}

/** The facts the loader reads beside the C9 records (each null / absent = not read or not known — never "no"). */
export interface MovingMomentFacts {
  /** A person we hold (contact / lead). False for a territory, a property, a raw lead or an anonymous topic. */
  subjectIsPerson: boolean
  /** contacts.timeline with WHO recorded it (the field-provenance stamp). */
  statedTimeline?: { value: string; basis: "person_stated" | "staff_entered" | "unstamped"; at: string | null } | null
  knownDeadlines?: ReadonlyArray<{ kind: KnownDeadlineKind; at: string; source: KnownDeadlineSource; ref?: string | null }>
  /** buyer_financial_profiles (status only — never an amount, CLAUDE.md §5). */
  financing?: "pre_approved" | "cash" | "expired" | "none" | "unknown"
  /** Sign of contacts.equity_estimate (never the number). */
  equity?: "positive" | "none" | "unknown"
  /** A buyer's fit against licensed active inventory (the Shopping Agent's match), when known. */
  inventory?: "available" | "shortage" | "unknown"
  /** The person said they must sell before they buy. */
  mustSellFirst?: boolean | null
  barriers?: ReadonlyArray<{ key: BarrierKey; basis: "person_stated" | "staff_entered" | "verified_record"; at?: string | null }>
  negative?: ReadonlyArray<MomentNegative>
  /** The side in the person's OWN words (an inbound statement / a form answer) — NEVER contacts.contact_type (R2). */
  statedSide?: "buyer" | "seller" | "both" | null
  /** contacts.home_owner_status as recorded (a fact with its own provenance) — the renter segment. */
  tenure?: "owner" | "renter" | null
  investorExit?: InvestorExit | null
  vendorScores?: ReadonlyArray<{ provider: string; field: string; value: number | string }>
  /** Consent as the existing resolvers answered it (null = not asked here). */
  consent?: { checked: boolean; allowed: boolean } | null
  calibration?: DecisionWindowCalibrationView | null
  /** The facts the loader could not read — published beside the moment. */
  unread?: readonly string[]
}

export interface MovingMoment {
  personLevel: boolean
  segments: Array<"seller" | "buyer" | "renter" | "investor">
  buyer_readiness: MomentDimension<ReadinessLevel>
  seller_readiness: MomentDimension<ReadinessLevel>
  investor_strategy: { stage: "none" | "exploring" | "considering" | "active" | "unknown"; exit: InvestorExit | "unknown"; basis: MomentBasis; why: string }
  desire_to_move: MomentDimension<"none" | "low" | "some" | "strong" | "unknown">
  expects_to_move: MomentDimension<"expects" | "not_yet" | "unknown">
  ability_to_act: MomentDimension<"able" | "partly" | "blocked" | "unknown"> & { factors: Array<{ factor: string; state: "ok" | "partly" | "blocked" | "unknown"; basis: MomentBasis }> }
  barrier: Array<{ key: BarrierKey; basis: MomentBasis }>
  known_deadline: { kind: KnownDeadlineKind; at: string; source: KnownDeadlineSource; inDays: number } | null
  identity_confidence: "confirmed" | "probable" | "name_only" | "none"
  source_confidence: EpistemicClass
  rights: { collections: string[]; restricted: boolean }
  last_observed: string | null
  negative_evidence: MomentNegative[]
  outreach_permission: "permitted" | "consent_required" | "consent_refused" | "email_mail_only" | "address_correction_only" | "none"
  decision_window: { window: DecisionWindow; basis: "stated_date" | "stated_bucket" | "evidence_prior" | "unknown"; uncertainty: "low" | "medium" | "high" | "unknown"; why: string }
  vendor_scores: LabelledVendorScore[]
  /** Only from this tenant's graded forecasts with enough validated outcomes — else null with the reason. */
  probability: { window: DecisionWindow; rate: number; interval: [number, number] | null; validated: number } | null
  probabilityWhy: string
  explanation: string
  unread: string[]
}

/** PRIOR lead ranges per kind of evidence — labelled PRIOR, uncalibrated; replaced the moment calibration publishes. */
const PRIOR_WINDOW: Readonly<Partial<Record<MovementRelevance, DecisionWindow>>> = Object.freeze({
  seeking_agent: "31_90", relocation: "91_180", property_event: "181_365", life_stage: "181_365", divorce: "181_365", probate_estate: "181_365",
})
// A MOVE names no side (a renter moves, an owner moves) — the side comes from the other evidence or the person's words.
const KIND_SIDE: Readonly<Record<OpportunityKind, Array<"seller" | "buyer" | "investor">>> = Object.freeze({ sell: ["seller"], buy: ["buyer"], move: [], invest: ["investor"], refinance: [] })
const SOURCE_RANK: Readonly<Record<KnownDeadlineSource, number>> = Object.freeze({ document: 5, mls_record: 4, first_party_row: 4, person_stated: 3, staff_entered: 2 })
const STAGE_DESIRE: Readonly<Record<OpportunityStage, { level: "none" | "low" | "some" | "strong" | "unknown"; basis: MomentBasis }>> = Object.freeze({
  none: { level: "unknown", basis: "none" }, single_observation: { level: "low", basis: "inferred" }, watch: { level: "low", basis: "inferred" },
  emerging: { level: "some", basis: "observed" }, likely: { level: "some", basis: "verified_record" }, stated: { level: "strong", basis: "person_stated" },
})

const confRank = (c: EpistemicClass) => EPISTEMIC_RANK[c] ?? 0

/**
 * PURE. The C37 moment for ONE subject: the reading (readOpportunities over its C9 records) + the observations + the facts the
 * loader read. Deterministic; `now` injectable. Never throws.
 */
export function buildMovingMoment(reading: OpportunityReading, observations: readonly OpportunityObservation[], facts: MovingMomentFacts, opts: { now?: Date } = {}): MovingMoment {
  const now = opts.now ?? new Date()
  const unread = [...(facts.unread ?? [])]
  const primary = reading.primary
  const ids = new Set(reading.assessments.flatMap((a) => a.evidenceIds))
  const positives = observations.filter((o) => ids.has(o.id))
  const lastObserved = positives.reduce<string | null>((m, o) => (!m || o.observedAt > m ? o.observedAt : m), null)
  const negatives = [...(facts.negative ?? [])].sort((a, b) => (a.at < b.at ? 1 : -1))
  const personLevel = facts.subjectIsPerson === true
  const unknownDim = <L extends string>(level: L, why: string): MomentDimension<L> => ({ level, basis: "none", why, evidenceIds: [] })

  // Rule 1: no person, no person-level prediction (an anonymous topic / a territory / a property predicts nobody).
  if (!personLevel) {
    const why = "not a person we hold — an anonymous topic, a property or a territory never yields a person-level prediction"
    return {
      personLevel: false, segments: [], buyer_readiness: unknownDim("not_indicated", why), seller_readiness: unknownDim("not_indicated", why),
      investor_strategy: { stage: "unknown", exit: "unknown", basis: "none", why }, desire_to_move: unknownDim("unknown", why), expects_to_move: unknownDim("unknown", why),
      ability_to_act: { ...unknownDim("unknown", why), factors: [] }, barrier: [], known_deadline: null, identity_confidence: "none", source_confidence: "unknown",
      rights: { collections: [], restricted: false }, last_observed: lastObserved, negative_evidence: [], outreach_permission: "none",
      decision_window: { window: "unknown", basis: "unknown", uncertainty: "unknown", why }, vendor_scores: (facts.vendorScores ?? []).map(labelVendorScore),
      probability: null, probabilityWhy: why, explanation: why, unread,
    }
  }

  // ── sides / segments (R2: evidence, the person's words, a recorded tenure — never contact_type) ──
  const sideEvidence = new Set<"seller" | "buyer" | "investor">()
  for (const a of reading.assessments) for (const s of KIND_SIDE[a.kind]) sideEvidence.add(s)
  for (const o of positives) { if (o.side === "seller" || o.side === "both") sideEvidence.add("seller"); if (o.side === "buyer" || o.side === "both") sideEvidence.add("buyer") }
  if (facts.statedSide === "buyer" || facts.statedSide === "both") sideEvidence.add("buyer")
  if (facts.statedSide === "seller" || facts.statedSide === "both") sideEvidence.add("seller")
  const deadlinesAll = [...(facts.knownDeadlines ?? []), ...positives.filter((o) => o.knownDeadline).map((o) => ({ kind: o.knownDeadline!.kind, at: o.knownDeadline!.at, source: (o.confidence === "verified" ? "first_party_row" : "person_stated") as KnownDeadlineSource, ref: o.id }))]
  const renter = facts.tenure === "renter" || deadlinesAll.some((d) => d.kind === "lease_end")
  if (renter) sideEvidence.add("buyer")
  const segments = [...(sideEvidence.has("seller") ? ["seller" as const] : []), ...(sideEvidence.has("buyer") ? ["buyer" as const] : []), ...(renter ? ["renter" as const] : []), ...(sideEvidence.has("investor") || facts.investorExit ? ["investor" as const] : [])]

  // ── desire (what they want — their words first) ──
  const stage: OpportunityStage = primary?.stage ?? "none"
  const statedTimelineHuman = !!facts.statedTimeline && facts.statedTimeline.basis !== "unstamped"
  let desire: MovingMoment["desire_to_move"] = { level: STAGE_DESIRE[stage].level, basis: STAGE_DESIRE[stage].basis, why: primary ? primary.reason : "no home-decision evidence in the window", evidenceIds: primary?.evidenceIds ?? [] }
  if ((facts.statedSide || statedTimelineHuman) && desire.level !== "strong") desire = { level: "strong", basis: facts.statedTimeline?.basis === "staff_entered" && !facts.statedSide ? "staff_entered" : "person_stated", why: "the person told us what they want to do", evidenceIds: desire.evidenceIds }

  // ── known deadline (stated dates beat inferred ranges) ──
  const future = deadlinesAll.map((d) => ({ ...d, inDays: (Date.parse(d.at) - now.getTime()) / DAY_MS })).filter((d) => Number.isFinite(d.inDays))
  const pastCount = future.filter((d) => d.inDays < 0).length
  const upcoming = future.filter((d) => d.inDays >= 0).sort((a, b) => SOURCE_RANK[b.source] - SOURCE_RANK[a.source] || a.inDays - b.inDays)
  const deadline = upcoming[0] ? { kind: upcoming[0].kind, at: new Date(Date.parse(upcoming[0].at)).toISOString(), source: upcoming[0].source, inDays: Math.floor(upcoming[0].inDays) } : null

  // ── expectation (expecting to move ≠ wanting to) ──
  const tlWindow = statedTimelineWindow(facts.statedTimeline?.value) ?? "unknown"
  const expects: MovingMoment["expects_to_move"] = deadline
    ? { level: "expects", basis: deadline.source === "staff_entered" ? "staff_entered" : deadline.source === "person_stated" ? "person_stated" : "verified_record", why: `a known ${deadline.kind.replace(/_/g, " ")} (${deadline.source.replace(/_/g, " ")})`, evidenceIds: [] }
    : facts.statedTimeline && tlWindow !== "unknown"
      ? { level: "expects", basis: facts.statedTimeline.basis === "unstamped" ? "observed" : facts.statedTimeline.basis, why: `their own timeline: ${facts.statedTimeline.value.replace(/_/g, " ")}${facts.statedTimeline.basis === "unstamped" ? " (no stamp says who recorded it)" : ""}`, evidenceIds: [] }
      : facts.statedTimeline?.value === "researching"
        ? { level: "not_yet", basis: facts.statedTimeline.basis === "unstamped" ? "observed" : facts.statedTimeline.basis, why: "they said they are researching — desire, not yet an expectation", evidenceIds: [] }
        : { level: "unknown", basis: "none", why: "no stated date or timeline — an expectation is never inferred from activity", evidenceIds: [] }

  // ── ability (what makes it possible) ──
  const factors: MovingMoment["ability_to_act"]["factors"] = []
  const buyerSide = sideEvidence.has("buyer"), sellerSide = sideEvidence.has("seller")
  if (buyerSide) {
    const f = facts.financing ?? "unknown"
    factors.push({ factor: "financing", state: f === "pre_approved" || f === "cash" ? "ok" : f === "expired" ? "partly" : f === "none" ? "blocked" : "unknown", basis: f === "unknown" ? "none" : "verified_record" })
    const inv = facts.inventory ?? "unknown"
    factors.push({ factor: "inventory", state: inv === "available" ? "ok" : inv === "shortage" ? "partly" : "unknown", basis: inv === "unknown" ? "none" : "verified_record" })
  }
  if (sellerSide) {
    const e = facts.equity ?? "unknown"
    factors.push({ factor: "equity", state: e === "positive" ? "ok" : e === "none" ? "blocked" : "unknown", basis: e === "unknown" ? "none" : "observed" })
  }
  if (facts.mustSellFirst === true) factors.push({ factor: "sell_buy_chain", state: "partly", basis: "person_stated" })
  const leaseEnd = deadlinesAll.find((d) => d.kind === "lease_end" && Date.parse(d.at) > now.getTime())
  if (leaseEnd) factors.push({ factor: "lease", state: "partly", basis: leaseEnd.source === "document" ? "verified_record" : "person_stated" })
  const barriers: MovingMoment["barrier"] = (facts.barriers ?? []).map((b) => ({ key: b.key, basis: b.basis }))
  for (const b of barriers) factors.push({ factor: `barrier:${b.key}`, state: b.key === "financing_not_ready" || b.key === "no_equity" ? "blocked" : "partly", basis: b.basis })
  const known = factors.filter((f) => f.state !== "unknown")
  const abilityLevel: MovingMoment["ability_to_act"]["level"] = factors.some((f) => f.state === "blocked") ? "blocked" : known.length === 0 ? "unknown" : known.some((f) => f.state === "partly") || factors.some((f) => f.state === "unknown") ? "partly" : "able"
  const ability: MovingMoment["ability_to_act"] = { level: abilityLevel, basis: known.length === 0 ? "none" : known.some((f) => f.basis === "person_stated") ? "person_stated" : "verified_record", why: factors.length === 0 ? "no feasibility fact read for this side" : factors.map((f) => `${f.factor} ${f.state}`).join(", "), evidenceIds: [], factors }

  // ── mixed evidence (rule 3) ──
  // A negative OLDER than the newest positive (a sign of a move, or the person's own timeline) is history, not a contradiction.
  const newestNegative = negatives[0]?.at ?? null
  const newestPositive = [lastObserved, facts.statedTimeline?.at ?? null].filter((x): x is string => !!x).sort().pop() ?? null
  const mixed = !!newestNegative && (!newestPositive || newestNegative >= newestPositive)

  // ── the window (rule 2 → 4) ──
  let window: MovingMoment["decision_window"]
  if (mixed) window = { window: "unknown", basis: "unknown", uncertainty: "unknown", why: `mixed evidence: ${negatives[0].why} — as new as the newest sign of a move; UNKNOWN is the honest answer` }
  else if (deadline) window = { window: decisionWindowForDays(deadline.inDays), basis: "stated_date", uncertainty: "low", why: `a known ${deadline.kind.replace(/_/g, " ")} in ${deadline.inDays} day(s) (${deadline.source.replace(/_/g, " ")}) — a stated date beats any inferred range` }
  else if (facts.statedTimeline && tlWindow !== "unknown") window = { window: tlWindow, basis: "stated_bucket", uncertainty: "medium", why: `their own timeline (${facts.statedTimeline.value.replace(/_/g, " ")})` }
  else if (abilityLevel === "blocked") window = { window: "unknown", basis: "unknown", uncertainty: "unknown", why: "something blocks the move and no date says when it clears — the window is unknown" }
  else if (primary && (stage === "emerging" || stage === "likely" || stage === "stated")) {
    const rel = primary.relevances.map((r) => PRIOR_WINDOW[r]).filter((w): w is DecisionWindow => !!w)
    const w = rel.sort((a, b) => DECISION_WINDOWS.indexOf(a) - DECISION_WINDOWS.indexOf(b))[0] ?? "unknown"
    window = w === "unknown" ? { window: "unknown", basis: "unknown", uncertainty: "unknown", why: "the evidence carries no range" } : { window: w, basis: "evidence_prior", uncertainty: "high", why: `a PRIOR range for this kind of evidence (${primary.relevances.join(", ")}) — uncalibrated, labelled as such` }
  } else window = { window: "unknown", basis: "unknown", uncertainty: "unknown", why: primary ? `the reading is only "${stage.replace(/_/g, " ")}" — too little to place a window` : "no home-decision evidence" }

  // ── readiness per side (rule 4: desire without feasibility is never ready now) ──
  const readinessFor = (side: "buyer" | "seller"): MovingMoment["buyer_readiness"] => {
    if (!sideEvidence.has(side)) return { level: "not_indicated", basis: "none", why: `nothing bears on the ${side} side`, evidenceIds: [] }
    if (mixed) return { level: "unknown", basis: "none", why: "mixed evidence", evidenceIds: desire.evidenceIds }
    const near = window.window === "0_30" || window.window === "31_90"
    const level: ReadinessLevel =
      expects.level === "expects" && near && abilityLevel === "able" && (desire.level === "some" || desire.level === "strong") ? "ready"
        : expects.level === "expects" && abilityLevel !== "blocked" && window.window !== "over_365" && window.window !== "unknown" ? "preparing"
          : desire.level === "some" || desire.level === "strong" ? "considering"
            : desire.level === "low" ? "exploring" : "unknown"
    const why = level === "considering" && abilityLevel === "blocked" ? "they may want to, but something blocks it — not ready now" : level === "considering" && expects.level !== "expects" ? "desire without a stated expectation" : `${expects.why}; ability ${abilityLevel}`
    return { level, basis: desire.basis, why, evidenceIds: desire.evidenceIds }
  }
  const invest = reading.assessments.find((a) => a.kind === "invest")
  const investor_strategy: MovingMoment["investor_strategy"] = {
    stage: !invest && !facts.investorExit ? "none" : mixed ? "unknown" : invest?.stage === "stated" || invest?.stage === "likely" || facts.investorExit ? "active" : invest?.stage === "emerging" ? "considering" : "exploring",
    exit: facts.investorExit ?? "unknown", basis: facts.investorExit ? "person_stated" : invest ? STAGE_DESIRE[invest.stage].basis : "none",
    why: facts.investorExit ? `their own exit: ${facts.investorExit.replace(/_/g, " ")} (REI Playbook vocabulary)` : invest ? invest.reason : "no investing evidence",
  }

  // ── identity, source, rights, outreach ──
  const grounded = positives.filter((o) => confRank(o.confidence) >= EPISTEMIC_RANK.reported)
  const identity_confidence: MovingMoment["identity_confidence"] = grounded.some((o) => o.identity === "record_key" || o.identity === "verified_match") ? "confirmed"
    : positives.some((o) => o.identity === "verified_match" || o.identity === "record_key") ? "probable" : positives.some((o) => o.identity === "name_only") ? "name_only" : "none"
  const source_confidence = positives.reduce<EpistemicClass>((m, o) => (confRank(o.confidence) > confRank(m) ? o.confidence : m), "unknown")
  const collections = [...new Set(positives.map((o) => o.rights).filter((r): r is string => !!r))].sort()
  const outreaches = positives.map((o) => o.outreach).filter((x): x is NonNullable<OpportunityObservation["outreach"]> => !!x)
  const best = outreaches.includes("consent_gated") ? "consent_gated" : outreaches.includes("email_mail_only") ? "email_mail_only" : outreaches.includes("address_correction_only") ? "address_correction_only" : "none"
  const outreach_permission: MovingMoment["outreach_permission"] = best === "consent_gated" ? (!facts.consent?.checked ? "consent_required" : facts.consent.allowed ? "permitted" : "consent_refused") : best

  // ── probability (only once calibrated) ──
  const cal = window.window !== "unknown" ? facts.calibration?.byWindow?.[window.window] : undefined
  const probability = cal && cal.published && typeof cal.rate === "number" ? { window: window.window, rate: cal.rate, interval: cal.interval, validated: cal.validated } : null
  const probabilityWhy = window.window === "unknown" ? "no window — nothing to calibrate" : !facts.calibration ? "calibration not read — no probability published" : probability ? `${cal!.validated} validated outcomes for this window (≥ ${facts.calibration.minValidated})` : (cal?.why ?? `no graded forecasts for ${window.window} yet — fewer than ${facts.calibration.minValidated} validated outcomes, so no probability is published`)

  const moment: MovingMoment = {
    personLevel: true, segments, buyer_readiness: readinessFor("buyer"), seller_readiness: readinessFor("seller"), investor_strategy, desire_to_move: desire, expects_to_move: expects,
    ability_to_act: ability, barrier: barriers, known_deadline: deadline, identity_confidence, source_confidence, rights: { collections, restricted: collections.some((c) => c === "manual_only" || c === "platform_scrape_contested" || c === "contract_required") },
    last_observed: lastObserved, negative_evidence: negatives, outreach_permission, decision_window: window, vendor_scores: (facts.vendorScores ?? []).map(labelVendorScore), probability, probabilityWhy,
    explanation: "", unread: [...unread, ...(pastCount > 0 ? [`${pastCount} known date(s) already passed — not a window`] : [])],
  }
  moment.explanation = `window ${window.window} (${window.basis}; ${window.why}) | desire ${desire.level} (${desire.basis}) | expects ${expects.level} | ability ${abilityLevel} | buyer ${moment.buyer_readiness.level}, seller ${moment.seller_readiness.level} | identity ${identity_confidence}, source ${source_confidence}${negatives.length ? ` | ${negatives.length} negative` : ""}`
  return moment
}

// ── C38: needs × expectation × feasibility → the plays the arbiter may choose ─────────────────────────────────────────────────

export interface ReadinessPlayOption {
  play: ReadinessPlay
  /** The engagement mode it rides (THE vocabulary) — its status is that mode's in the opportunity menu, then narrowed here. */
  mode: LifeEventEngagementMode
  status: "eligible" | "needs_authority" | "needs_budget" | "not_eligible"
  why: string
  /** For the WRITER: what help fits — event-agnostic, screened. Null for internal plays. */
  brief: string | null
}

export interface ReadinessPlays { options: ReadinessPlayOption[]; floor: "watch" | "stay_quiet"; holdout: boolean }

const NEVER = "Never mention what was observed, where it came from, any life event, a score or a probability; offer, never push."

/**
 * PURE. The C38 plays over the C37 moment and the existing opportunity menu (one gate: a play is never MORE eligible than the mode
 * it rides). An independent HOLDOUT subject is offered watch / stay quiet only — unless the person told us themselves (the person
 * asked; a measurement never withholds an answer).
 */
export function readinessPlays(moment: MovingMoment, menu: OpportunityMenu | null, reading: OpportunityReading, opts: { holdout?: boolean } = {}): ReadinessPlays {
  const modeStatus = (m: LifeEventEngagementMode) => menu?.options.find((o) => o.mode === m) ?? null
  const stated = reading.primary?.stage === "stated"
  const holdout = opts.holdout === true && !stated
  const quiet = !moment.personLevel || moment.outreach_permission === "consent_refused" || moment.negative_evidence.some((n) => n.key === "opted_out" || n.key === "declined")
  const options: ReadinessPlayOption[] = []
  const screen = (b: string): string => { const t = `${b} ${NEVER}`; return screenLifeEventOutreach(t, { events: reading.screenEvents.map((type) => ({ type })) }).ok ? t : `Something genuinely useful to anyone in their situation. ${NEVER}` }
  const near = (["buyer_readiness", "seller_readiness"] as const).some((k) => moment[k].level === "ready" || moment[k].level === "preparing")
  const desire = moment.desire_to_move.level === "some" || moment.desire_to_move.level === "strong"
  const outward = (play: ReadinessPlay, need: string[], brief: string): ReadinessPlayOption => {
    const mode = PLAY_MODE[play]
    const gate = modeStatus(mode)
    const blocks = [...need, ...(quiet ? ["the person asked for space, opted out, or is not a person we hold"] : []), ...(holdout ? ["an independent holdout for outcome learning — watched, never contacted on this evidence"] : [])]
    if (!gate || gate.status === "not_eligible") blocks.push(`the ${mode.replace(/_/g, " ")} mode is not eligible (${gate?.why ?? "no menu"})`)
    if (blocks.length > 0) return { play, mode, status: "not_eligible", why: blocks.join("; "), brief: null }
    return { play, mode, status: gate!.status, why: gate!.why, brief: screen(brief) }
  }
  const buyer = moment.segments.includes("buyer"), barrierish = moment.ability_to_act.level === "blocked" || moment.ability_to_act.level === "partly"
  options.push(outward("invite", near ? [] : ["no side is preparing or ready — an invitation would be premature"], "A warm, personal invitation to talk through their plans when it suits them — no urgency, no deal."))
  options.push(outward("explain", desire && (barrierish || moment.expects_to_move.level !== "expects") ? [] : ["nothing to explain yet — no stated want, or nothing in the way"], moment.segments.includes("seller") && moment.segments.includes("buyer")
    ? "A plain-language explanation of how a sell-and-buy timeline usually works and what their home's position could make possible, with a licensed professional on request."
    : buyer ? "Plain-language help with what makes a purchase possible — financing steps, what to ask a lender they choose, how a timeline fits." : "Plain-language help with their home's position and the steps owners usually look at first; no price without a CMA."))
  options.push(outward("match", buyer && desire ? [] : ["no buyer-side want to match against"], "Only licensed active homes that meet the criteria they gave, in their own units — or a kind, honest note that few fit right now and what would widen the choice."))
  options.push(outward("clarify", desire && (moment.decision_window.window === "unknown" || moment.expects_to_move.level !== "expects") ? [] : ["the window is already known — nothing to ask"], "One kind, easy question about what they are hoping for and what would help — never about why we asked."))
  options.push({ play: "watch", mode: "quiet_monitoring", status: moment.personLevel && !quiet ? "eligible" : "not_eligible", why: moment.personLevel && !quiet ? "keep reading the approved signals; new evidence re-opens the decision (no timer)" : "nothing to watch for this subject", brief: null })
  options.push({ play: "stay_quiet", mode: "quiet_monitoring", status: "eligible", why: "always permitted — doing nothing is a kind answer when evidence is thin, mixed or unwelcome", brief: null })
  return { options, floor: quiet || moment.decision_window.window === "unknown" && !desire ? "stay_quiet" : "watch", holdout }
}

// ── independent holdouts (the ONE arm picker) ─────────────────────────────────────────────────────────────────────────────────

/**
 * The movement-outreach HOLDOUT: a small, stable, independent share of movement subjects is watched but not contacted on movement
 * evidence, so outcome learning can measure what outreach ADDS (lib/intelligence/strategy-learning.ts movementOutcomeLearning).
 * Control = `treated` (business as usual): a killed / disabled / unreadable experiments policy holds nobody out. A person who told us
 * themselves is never held out (readinessPlays). The tenant disables it with settings.experiments.disabled ⊇ ["movement_outreach_holdout"].
 */
const MOVEMENT_OUTREACH_HOLDOUT: ExperimentDefinition = Object.freeze({
  key: "movement_outreach_holdout",
  description: "Independent holdout for movement-signal outreach (wave 150, lane 150JNAD) — holdout subjects are watched, never contacted on movement evidence; outcomes compare treated vs holdout.",
  control: "treated",
  arms: Object.freeze([{ key: "treated", weight: 95 }, { key: "holdout", weight: 5 }]),
  instanceSwitch: "settings.experiments.disabled (the tenant's existing kill switch / disabled list)",
})

/** PURE. The subject's holdout arm (deterministic over tenant × subject; no clock, no random). */
export function movementHoldoutArm(brokerageId: string, subjectId: string | null, policy: ExperimentPolicy): ExperimentAssignment | null {
  return assignExperimentArm({ definition: MOVEMENT_OUTREACH_HOLDOUT, brokerageId, subjectId, instanceOn: true, policy })
}
