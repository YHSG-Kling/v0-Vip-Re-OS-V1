// lib/lead-pipeline/pre-pull-value.ts
//
// THE PRE-PULL VALUE EVALUATION — ONE configurable module (wave 151, lane 151C). PURE: no client, no clock, no
// `server-only`; every weight is configuration and every ratio is an observed count the caller passes in.
//
// Owner, verbatim (wave 151): "if at all possible check the formula before deciding to pull in a lead, not just that they
// are coming from a list." Directive 151C: "territory_match × freshness × source_reliability × expected_new_usable_fields ×
// identity_match_likelihood × useful_opportunity_factor, adjusted for existing-data completeness, overlap, uncertainty,
// provider price, enrichment/AI cost and current authorized budget — weights from configuration + measured prior outcomes,
// never advertised as validated, never a probability that a person will sell."
//
// CONSUMERS: lib/lead-pipeline/source-discovery-planner.ts planSourceDiscovery (every paid plan line carries its verdict,
// and a `hold` keeps the line out of the approvable set — live before any budget module reads it) and lane 151F's budget /
// connection code, which imports evaluatePrePullValue beside paidPullApproval (its cross-file consumer).
//
// WHAT THIS IS NOT. Not a seller-propensity score (a vendor score keeps its own unit — lib/providers/provider-scorecard.ts
// labelSellerSignal), not a probability of closing (C37), not a calibrated model: `calibration` reads "unvalidated" until a
// measured outcome loop (lib/lead-pipeline/source-conversion-learning.ts) replaces a weight, and the disclaimer rides every
// verdict.

import { MIN_SOURCE_SAMPLE } from "./source-conversion-learning"

const PRE_PULL_VALUE_VERSION = "pre-pull-value@1"

/** Rides every verdict — the formula is an operating estimate, never a claim about a person. */
export const PRE_PULL_VALUE_DISCLAIMER =
  "an operating estimate from configured weights and this territory's observed ratios — unvalidated; never a probability that any person will sell or buy"

/** The six multiplicative factors, each 0..1 (null = unknown — read as 0.5 and counted into uncertainty). */
export interface PrePullFactors {
  territoryMatch: number | null
  freshness: number | null
  sourceReliability: number | null
  expectedNewUsableFields: number | null
  identityMatchLikelihood: number | null
  usefulOpportunityFactor: number | null
}
export type PrePullFactorName = keyof PrePullFactors

const PRE_PULL_FACTOR_NAMES: readonly PrePullFactorName[] = [
  "territoryMatch", "freshness", "sourceReliability", "expectedNewUsableFields", "identityMatchLikelihood", "usefulOpportunityFactor",
]

export interface PrePullAdjustments {
  /** 0 = we hold nothing on these people yet; 1 = complete already (another pull adds nothing). */
  existingDataCompleteness?: number | null
  /** The share of the pull we already hold (known source ids / persons / properties) — paid twice if bought. */
  knownOverlapRatio?: number | null
  /** Caller-stated uncertainty 0..1 (an unproven provider, an unpreviewed count); unknown factors add to it. */
  uncertainty?: number | null
  /** The territory's MEASURED usable ratio (promoted ÷ rows pulled, shrunk) — when known it IS the yield; the model's
   *  identity × reliability is only the fallback (both derive from the same outcome, so they are never multiplied with it). */
  observedUsableRatio?: number | null
}

export interface PrePullCost {
  recordCount: number
  /** USD per record / match from a quote or the catalogue — null = UNKNOWN (a paid pull at an unknown price is refused). */
  providerUnitUsd: number | null
  minimumUsd?: number | null
  /** What each USABLE record then costs to enrich (provider) and to reason about (AI) — spent only on the usable share. */
  enrichmentUsdPerRecord?: number | null
  aiUsdPerRecord?: number | null
  /** False for a first-party / keyless source (no vendor bill). */
  paid: boolean
}

export interface PrePullBudget {
  /** The spend this tenant has authorized for this source right now (an approved plan line's ceiling, or the territory's remaining monthly budget). null = none known. */
  authorizedUsd: number | null
  /** The platform's own internal acquisition cap for the cycle when the budget owner (lane 151F) supplies it. */
  platformCapUsd?: number | null
}

export interface PrePullValueConfig {
  version: string
  /** Exponent per factor (1 = the plain product). Configuration, not learning. */
  weights: Record<PrePullFactorName, number>
  /** Below this score the pull is HELD. */
  holdBelow: number
  /** A paid pull costing more than this under high uncertainty is previewed / estimated first (count APIs). */
  previewAboveUsd: number
  /** Uncertainty at or above which "preview first" applies. */
  previewAtUncertainty: number
  /** Ceiling on cost per expected usable record (null = none configured). */
  maxCostPerUsableUsd: number | null
  /** What an unknown factor reads as, and how much uncertainty each unknown adds. */
  unknownFactor: number
  uncertaintyPerUnknown: number
  /** "unvalidated" until a measured outcome loop sets a weight. */
  calibration: "unvalidated" | "measured"
}

export const PRE_PULL_VALUE_CONFIG: Readonly<PrePullValueConfig> = Object.freeze({
  version: PRE_PULL_VALUE_VERSION,
  weights: { territoryMatch: 1, freshness: 1, sourceReliability: 1, expectedNewUsableFields: 1, identityMatchLikelihood: 1, usefulOpportunityFactor: 1 },
  holdBelow: 0.12,
  previewAboveUsd: 25,
  previewAtUncertainty: 0.5,
  maxCostPerUsableUsd: null,
  unknownFactor: 0.5,
  uncertaintyPerUnknown: 0.15,
  calibration: "unvalidated",
})

export type PrePullDecision = "proceed" | "preview_first" | "hold" | "refuse"

// ─── THE NINE PRE-PULL INPUTS, EACH NAMED WITH ITS BASIS (wave 154, lane 154J — directive J3) ──────────────────────────
// Directive J3: the decision considers opportunity relevance, event age, duplicate likelihood, fields already verified,
// territory, the specific missing data, source rights, expected unique useful yield and the real provider price — "using
// values the system really has; where an input is not available it is named as unknown rather than replaced by an invented
// probability, and the decision still runs". The formula above already resolves an unknown FACTOR to `unknownFactor` and
// counts it into uncertainty; what it did not say is WHICH of the nine inputs a caller actually measured, which it merely
// CONFIGURED (a planner constant such as "a vendor that sells contact points adds 0.8" — an operating weight, never a
// measurement) and which it did not have at all. `inputs` says that per input; it never changes the decision.
type PrePullInputBasis = "measured" | "configured" | "stated" | "unknown"
const PRE_PULL_INPUTS = [
  "opportunity_relevance", "event_age", "duplicate_likelihood", "fields_already_verified", "territory",
  "specific_missing_data", "source_rights", "expected_unique_useful_yield", "provider_price",
] as const
type PrePullInput = (typeof PRE_PULL_INPUTS)[number]

interface PrePullContext {
  /** How the caller got each factor it passed (absent = "measured" for a known value — the caller's own claim). */
  basis?: Partial<Record<PrePullFactorName, Exclude<PrePullInputBasis, "unknown">>> | null
  /** The source's rights basis as the source catalogue names it (null = not supplied → unknown). */
  rights?: string | null
  /** The specific fields this pull is meant to fill (null = the caller does not know which → unknown). */
  missingFields?: readonly string[] | null
  /** Where the unit price came from (provider_quote / catalogue / history); null = not supplied. */
  priceBasis?: string | null
}

export interface PrePullValueVerdict {
  version: string
  /** 0..1 — the adjusted product; compare only against this module's own thresholds. */
  score: number
  decision: PrePullDecision
  factors: Record<PrePullFactorName, { value: number; known: boolean }>
  /** recordCount × the yield share (overlap removed) — an expected COUNT of usable records, not a promise. */
  expectedUsableRecords: number
  totalCostUsd: number | null
  costPerUsableUsd: number | null
  /** How many records the authorized budget funds at this price and yield (null = no budget known / free). */
  affordableRecords: number | null
  uncertainty: number
  reasons: string[]
  disclaimer: string
  calibration: PrePullValueConfig["calibration"]
  /** Wave 154 (lane 154J): the nine J3 inputs, each with its basis — a configured weight never reads as measured. */
  inputs: Array<{ input: PrePullInput; basis: PrePullInputBasis; value: string }>
  /** The J3 inputs this decision ran WITHOUT (named, never replaced by an invented probability). */
  unknownInputs: PrePullInput[]
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n))
const round2 = (n: number) => Math.round(n * 100) / 100
const known = (v: number | null | undefined): v is number => typeof v === "number" && Number.isFinite(v)

/**
 * PURE — is this pull / enrichment worth paying for, before the paid call? Transparent by construction: every factor is
 * returned as resolved (with whether it was known), the cost is itemized, and the decision names its reasons.
 */
export function evaluatePrePullValue(
  input: { factors: PrePullFactors; adjustments?: PrePullAdjustments | null; cost: PrePullCost; budget?: PrePullBudget | null; context?: PrePullContext | null },
  config: Readonly<PrePullValueConfig> = PRE_PULL_VALUE_CONFIG,
): PrePullValueVerdict {
  const reasons: string[] = []
  const factors = {} as PrePullValueVerdict["factors"]
  let unknowns = 0
  for (const name of PRE_PULL_FACTOR_NAMES) {
    const raw = input.factors[name]
    if (known(raw)) factors[name] = { value: clamp01(raw), known: true }
    else { factors[name] = { value: config.unknownFactor, known: false }; unknowns++ }
  }
  const adj = input.adjustments ?? {}
  const overlap = known(adj.knownOverlapRatio) ? clamp01(adj.knownOverlapRatio) : 0
  const completeness = known(adj.existingDataCompleteness) ? clamp01(adj.existingDataCompleteness) : 0
  const uncertainty = clamp01((known(adj.uncertainty) ? adj.uncertainty : 0) + unknowns * config.uncertaintyPerUnknown)
  if (unknowns > 0) reasons.push(`${unknowns} factor(s) unknown — read as ${config.unknownFactor} and counted into uncertainty (${round2(uncertainty)})`)

  // The six factors MULTIPLY (a zero in any one kills the pull); the product is normalized to a weighted GEOMETRIC MEAN so
  // the score stays comparable whatever the weights — a plain product of six fractions is tiny by construction.
  let logSum = 0, weightSum = 0
  for (const name of PRE_PULL_FACTOR_NAMES) { const w = Math.max(0, config.weights[name]); logSum += w * Math.log(Math.max(factors[name].value, 1e-9)); weightSum += w }
  const anyZero = PRE_PULL_FACTOR_NAMES.some((n) => factors[n].value <= 0 && config.weights[n] > 0)
  const base = anyZero || weightSum === 0 ? 0 : Math.exp(logSum / weightSum)
  const score = round2(clamp01(base * (1 - overlap) * (1 - 0.5 * completeness) * (1 - 0.5 * uncertainty)))
  if (overlap > 0) reasons.push(`${Math.round(overlap * 100)}% of the pull is already held (known source ids / persons / properties) — removed from the yield`)
  if (completeness > 0) reasons.push(`existing data is ${Math.round(completeness * 100)}% complete on these people — another pull adds less`)

  const records = Math.max(0, Math.floor(input.cost.recordCount))
  // The usable YIELD: the measured usable ratio when the territory has one, else the model's identity × reliability — never
  // both. Freshness and territory scale it; the fields factor does not (it is depth per record, not count).
  const measuredYield = known(adj.observedUsableRatio) ? clamp01(adj.observedUsableRatio) : null
  const yieldShare = (1 - overlap) * factors.territoryMatch.value * factors.freshness.value
    * (measuredYield ?? factors.sourceReliability.value * factors.identityMatchLikelihood.value)
  const expectedUsable = Math.round(records * yieldShare * 10) / 10

  const downstreamPerUsable = (known(input.cost.enrichmentUsdPerRecord) ? input.cost.enrichmentUsdPerRecord : 0) + (known(input.cost.aiUsdPerRecord) ? input.cost.aiUsdPerRecord : 0)
  let totalCost: number | null = null
  let costPerUsable: number | null = null
  let affordable: number | null = null
  const unit = input.cost.providerUnitUsd
  const budget = input.budget?.authorizedUsd ?? null
  const cap = input.budget?.platformCapUsd ?? null
  const ceiling = budget === null && cap === null ? null : Math.min(budget ?? Number.POSITIVE_INFINITY, cap ?? Number.POSITIVE_INFINITY)

  if (input.cost.paid && !known(unit)) {
    reasons.push("no documented per-record price — a paid pull is never made at an unknown price")
    return verdict("refuse")
  }
  const unitUsd = known(unit) ? Math.max(0, unit) : 0
  const providerCost = Math.max(records * unitUsd, known(input.cost.minimumUsd) ? input.cost.minimumUsd : 0)
  totalCost = round2(providerCost + expectedUsable * downstreamPerUsable)
  costPerUsable = expectedUsable > 0 ? round2(totalCost / expectedUsable) : null
  if (ceiling !== null) {
    const perRecord = unitUsd + yieldShare * downstreamPerUsable
    affordable = perRecord > 0 ? Math.max(0, Math.floor(ceiling / perRecord)) : records
  }

  if (records === 0) { reasons.push("nothing to pull (0 records)"); return verdict("refuse") }
  if (score < config.holdBelow) { reasons.push(`value ${score} is below the hold floor ${config.holdBelow}`); return verdict("hold") }
  if (input.cost.paid && expectedUsable < 1) { reasons.push(`fewer than one usable record is expected (${expectedUsable}) — not worth a paid call`); return verdict("hold") }
  if (config.maxCostPerUsableUsd !== null && costPerUsable !== null && costPerUsable > config.maxCostPerUsableUsd) {
    reasons.push(`$${costPerUsable} per expected usable record exceeds the configured ceiling $${config.maxCostPerUsableUsd}`); return verdict("hold")
  }
  if (ceiling !== null && totalCost > ceiling) {
    if ((affordable ?? 0) < 1) { reasons.push(`$${totalCost} exceeds the authorized budget $${round2(ceiling)} and not one record fits`); return verdict("hold") }
    reasons.push(`$${totalCost} exceeds the authorized budget $${round2(ceiling)} — ${affordable} record(s) fit (the budget module sizes the pull)`)
  }
  if (input.cost.paid && uncertainty >= config.previewAtUncertainty && totalCost > config.previewAboveUsd) {
    reasons.push(`uncertainty ${round2(uncertainty)} with a $${totalCost} pull — preview / estimate first (a count API returns a count, never contacts)`)
    return verdict("preview_first")
  }
  reasons.push(`${expectedUsable} usable of ${records} expected${costPerUsable !== null ? ` at $${costPerUsable} each` : ""} — proceed within the authorized budget`)
  return verdict("proceed")

  function verdict(decision: PrePullDecision): PrePullValueVerdict {
    const inputs = namedInputs()
    return {
      version: config.version, score, decision, factors, expectedUsableRecords: expectedUsable, totalCostUsd: totalCost, costPerUsableUsd: costPerUsable,
      affordableRecords: affordable, uncertainty: round2(uncertainty), reasons, disclaimer: PRE_PULL_VALUE_DISCLAIMER, calibration: config.calibration,
      inputs, unknownInputs: inputs.filter((i) => i.basis === "unknown").map((i) => i.input),
    }
  }

  function namedInputs(): PrePullValueVerdict["inputs"] {
    const ctx = input.context ?? {}
    const f = (name: PrePullFactorName): { basis: PrePullInputBasis; value: string } =>
      factors[name].known ? { basis: ctx.basis?.[name] ?? "measured", value: String(factors[name].value) } : { basis: "unknown", value: `not supplied — read as ${config.unknownFactor} and counted into uncertainty` }
    const measuredYield = known(adj.observedUsableRatio)
    const yieldBasis: PrePullInputBasis = measuredYield ? "measured" : factors.sourceReliability.known && factors.identityMatchLikelihood.known ? "measured" : "unknown"
    return [
      { input: "opportunity_relevance", ...f("usefulOpportunityFactor") },
      { input: "event_age", ...f("freshness") },
      known(adj.knownOverlapRatio) ? { input: "duplicate_likelihood", basis: "measured", value: String(clamp01(adj.knownOverlapRatio)) } : { input: "duplicate_likelihood", basis: "unknown", value: "no overlap measured — read as 0 (nothing removed from the yield)" },
      known(adj.existingDataCompleteness) ? { input: "fields_already_verified", basis: "measured", value: String(clamp01(adj.existingDataCompleteness)) } : { input: "fields_already_verified", basis: "unknown", value: "completeness of held fields not supplied — read as 0" },
      { input: "territory", ...f("territoryMatch") },
      ctx.missingFields && ctx.missingFields.length > 0 ? { input: "specific_missing_data", basis: "stated", value: ctx.missingFields.join(", ") } : { input: "specific_missing_data", basis: "unknown", value: factors.expectedNewUsableFields.known ? `which fields are missing was not stated — only a ${ctx.basis?.expectedNewUsableFields ?? "measured"} depth factor ${factors.expectedNewUsableFields.value}` : "not supplied" },
      ctx.rights ? { input: "source_rights", basis: "stated", value: ctx.rights } : { input: "source_rights", basis: "unknown", value: "not supplied to the formula (the door decides rights before spend)" },
      { input: "expected_unique_useful_yield", basis: yieldBasis, value: `${expectedUsable} of ${Math.max(0, Math.floor(input.cost.recordCount))}${yieldBasis === "unknown" ? " (from unknown factors — an operating estimate)" : ""}` },
      !input.cost.paid ? { input: "provider_price", basis: "stated", value: "no vendor bill (first-party / keyless)" } : known(input.cost.providerUnitUsd) ? { input: "provider_price", basis: "stated", value: `${input.cost.providerUnitUsd} USD per unit (${ctx.priceBasis ?? "basis not supplied"})` } : { input: "provider_price", basis: "unknown", value: "no documented price — a paid pull at an unknown price is refused" },
    ]
  }
}

/**
 * PURE — the factors a territory's OWN observed history supports (measured prior outcomes, shrunk toward the unknown value
 * when the sample is small — MIN_SOURCE_SAMPLE is the one sample floor, lib/lead-pipeline/source-conversion-learning.ts).
 *   identityMatchLikelihood — of the rows pulled, the share that resolved to a person (promoted OR a known duplicate);
 *   sourceReliability       — of the NEW people, the share that qualified (promoted ÷ non-duplicates);
 *   knownOverlapRatio       — the share already held (duplicates ÷ rows);
 *   freshnessPenalty        — the share held as stale / history (when the caller counted them; m967 freshness_verdict).
 * Never a probability about a person; `basis` says whether any history existed at all.
 */
export function factorsFromObservedOutcomes(
  h: { rawRows: number; promoted: number; duplicates: number; heldStale?: number | null } | null | undefined,
  opts: { minSample?: number; unknownFactor?: number } = {},
): { identityMatchLikelihood: number | null; sourceReliability: number | null; observedUsableRatio: number | null; knownOverlapRatio: number | null; freshnessPenalty: number | null; sample: number; basis: "territory_history" | "no_history" } {
  const k = Math.max(1, opts.minSample ?? MIN_SOURCE_SAMPLE)
  const u = opts.unknownFactor ?? PRE_PULL_VALUE_CONFIG.unknownFactor
  const rows = Math.max(0, Math.floor(h?.rawRows ?? 0))
  if (!h || rows === 0) return { identityMatchLikelihood: null, sourceReliability: null, observedUsableRatio: null, knownOverlapRatio: null, freshnessPenalty: null, sample: 0, basis: "no_history" }
  const promoted = Math.max(0, Math.min(rows, h.promoted))
  const duplicates = Math.max(0, Math.min(rows, h.duplicates))
  const shrink = (num: number, den: number, prior: number) => round2((num + prior * k) / (den + k))
  const identity = shrink(Math.min(rows, promoted + duplicates), rows, u)
  const fresh = Math.max(1, rows - duplicates)
  const reliability = shrink(Math.min(fresh, promoted), fresh, u)
  // The measured usable ratio — the one number the yield rides when history exists (the planner's own "expected new
  // leads" is the same promoted ÷ rows, unshrunk; this one is shrunk toward unknown on a thin sample).
  const usable = shrink(promoted, rows, u)
  const overlap = shrink(duplicates, rows, 0)
  const held = typeof h.heldStale === "number" && h.heldStale >= 0 ? shrink(Math.min(rows, h.heldStale), rows, 0) : null
  return { identityMatchLikelihood: identity, sourceReliability: reliability, observedUsableRatio: usable, knownOverlapRatio: overlap, freshnessPenalty: held, sample: rows, basis: "territory_history" }
}
