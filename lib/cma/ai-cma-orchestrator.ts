/**
 * AI-CMA ORCHESTRATOR
 *
 * Single entry point for the CMA the seller-facing lanes and the listing
 * presentation are built on. Composes:
 *   1. Comp sourcing        — lib/cma/comp-provider.ts (RentCast by default,
 *                             the brokerage's connected IDX feed for the active
 *                             side). Providers are tried FIRST for every slot;
 *                             an AI web search may fill only a PENDING or ACTIVE
 *                             slot no provider could serve, is labelled per row
 *                             and per slot, and is never admitted to the SOLD
 *                             side that the value range is computed from.
 *   2. State appraiser guidelines — lib/cma/state-adjustment-rates.ts, applied
 *                             per comp DETERMINISTICALLY (no model in the math)
 *   3. Seller-reported upgrades since purchase — narrative context, with the
 *                             reason it is not a dollar adjustment stated on the
 *                             result rather than left to be inferred
 *   4. AI valuation narrative + range (low/mid/high)
 *   5. Investor ARV mode (best-condition comps + repair budget formula)
 *
 * THE REQUIRED COMP MIX (owner's ruling): at least 3 SOLD within 6 months —
 * widening to 12 months ONLY when 6 months returns fewer than 3 — plus 2 ACTIVE
 * and 1 PENDING. Whichever window was actually used, whichever provider actually
 * served each side, and whether any side had to be completed by an AI web search
 * is reported on `compProvenance` and repeated in the seller-facing disclaimers.
 * A CMA can never claim a provenance or a comp freshness it did not have.
 *
 * `mode` no longer selects a comp SOURCE — there is one sourcing path now, and
 * it is provider-backed for every mode. What mode still changes:
 *   - 'investor_arv' suppresses the condition adjustment (the comp's condition
 *     IS the target post-renovation condition) and adds the ARV/max-offer block
 *   - 'standard' and 'premium' behave identically; 'premium' is retained because
 *     callers pass it (lib/workflow/adapters/avm-cma.ts) and it still reads as
 *     "the agent asked for this deliberately".
 *
 * PURE OF DB WRITES. It reads (adjustment rates, credentials) and calls
 * providers; it persists nothing. Callers own persistence.
 */

import { generateTextRouted } from "@/lib/ai/models"
import { sourceCompsForCma, REQUIRED_SOLD_COMPS, type CompProvenance } from "./comp-provider"
import type { ScoredComp, SellerUpgrade } from "./comp-types"
import {
  getStateAdjustmentRates,
  formatRatesForPrompt,
  computeCompAdjustments,
  type SubjectFeatures,
  type CompAdjustment,
} from "./state-adjustment-rates"

export type { SellerUpgrade } from "./comp-types"

export type CmaMode = "standard" | "premium" | "investor_arv"

export interface AiCmaInput {
  mode: CmaMode
  brokerageId: string
  /** auth users.id of the acting agent. Used to resolve THEIR IDX connection
   *  through the agent → team → brokerage → platform cascade. Never substituted
   *  for agents.id. */
  agentUserId?: string | null
  teamId?: string | null
  contactId?: string | null
  subject: SubjectFeatures & {
    address: string
    city?: string | null
    state: string  // 2-letter
    zip?: string | null
    propertyType?: "single_family" | "condo" | "townhouse" | null
    /**
     * Improvements the SELLER says they have made since buying the home.
     * Load them with lib/cma/seller-upgrades.loadSellerUpgradesForListing when
     * the caller has a listing id. See SELLER_UPGRADE_TREATMENT below for how
     * they are used — and for why they do not become a dollar figure.
     */
    sellerUpgrades?: SellerUpgrade[] | null
  }
  /** For investor_arv mode — agent-supplied estimated repair budget */
  estimatedRepairBudget?: number | null
}

export interface AdjustedComp {
  comp: ScoredComp
  adjustments: CompAdjustment[]
  adjustedPrice: number
  totalAdjustment: number
  totalAdjustmentPct: number
}

/**
 * WHY SELLER UPGRADES ARE NOT A NUMERIC ADJUSTMENT.
 *
 * The state adjustment engine prices STRUCTURED features — sqft, beds, baths,
 * garage spaces, pool, waterfront, view, lot, age, condition grade, finished
 * basement, new construction, gated. Every one has a published state rate behind
 * it. A seller's upgrade list is free text ("redid the kitchen in 2022",
 * "new roof") and the rate table has no line for it.
 *
 * Two things it would be easy — and wrong — to do here:
 *   1. Guess a rate for the text. That is inventing a dollar figure and putting
 *      it in a column a later reader will treat as measured.
 *   2. Use the seller's stated COST as the adjustment. Cost is not value: the
 *      cost-to-value ratio of a renovation is well under 1 and varies by market,
 *      scope and age of the work. Adding $60k of kitchen spend to a valuation is
 *      a number no comparable supports.
 *
 * So upgrades reach the valuation two ways, both honest:
 *   · THE ADJUSTMENT STAGE — when an upgrade is something the rate table
 *     actually prices, it belongs in the SUBJECT'S FEATURES (a seller who added
 *     a pool sets subject.hasPool; who finished a basement sets
 *     basementFinished; whose renovation lifted the home's condition sets
 *     conditionGrade). Those already flow through computeCompAdjustments as real,
 *     state-rate-backed dollars. That is the numeric path, and it is the only one.
 *   · THE NARRATIVE — the free-text list is given to the narrative writer as
 *     context so the report can say what the seller has done and why the home
 *     sits where it does in the range, without attaching a fabricated number.
 */
export const SELLER_UPGRADE_TREATMENT = "narrative_context_only" as const
export type SellerUpgradeTreatment = typeof SELLER_UPGRADE_TREATMENT

export interface AiCmaResult {
  mode: CmaMode
  estimatedValueLow: number
  estimatedValueMid: number
  estimatedValueHigh: number
  confidenceScore: number      // 0..1
  adjustedComps: AdjustedComp[]
  /** Up to REQUIRED_PENDING_COMPS (1). Empty when no provider reported one. */
  pendingComps: AdjustedComp[]
  /** Up to REQUIRED_ACTIVE_COMPS (2). */
  activeComps: AdjustedComp[]
  /** WHICH provider served each side, which sold window was used, and every
   *  reason a side came back short. Never omitted, never silently empty. */
  compProvenance: CompProvenance
  /** The seller-reported upgrades that were fed to the valuation, verbatim. */
  sellerUpgrades: SellerUpgrade[]
  /** How those upgrades were used. See SELLER_UPGRADE_TREATMENT. */
  sellerUpgradeTreatment: SellerUpgradeTreatment
  /** Investor ARV mode only */
  arv?: {
    estimatedArv: number
    estimatedRepairBudget: number
    maxOfferAt70: number   // 70% rule: ARV × 0.70 - repairs
    maxOfferAt75: number
  }
  aiNarrative: string
  citations: string[]
  stateGuidelinesUsed: string
  costEstimateCents: number
  disclaimers: string[]
  generatedAt: string
}

/** Cost of the narrative generation itself (a routed fast model), in cents. */
const NARRATIVE_COST_CENTS = 2

/**
 * A widened (12-month) sold window is a materially weaker basis than a 6-month
 * one — the comps are older and the time-trend adjustment is doing more of the
 * work. Confidence takes a deliberate, documented haircut for it. This is a
 * stated judgement, not a measurement, which is why it is a named constant
 * rather than a magic number buried in the formula.
 */
const WIDENED_WINDOW_CONFIDENCE_FACTOR = 0.85

/**
 * A set whose required 3/2/1 mix was completed by an AI web search rather than
 * by a data provider is less well-sourced than a fully provider-backed one, and
 * the confidence number must not read identically for both.
 *
 * The haircut is deliberately SMALL — 5% — and here is the honest reason it is
 * not larger: the gap-fill can only touch the ACTIVE and PENDING sides (see
 * AI_GAP_FILL_SLOTS in lib/cma/comp-provider.ts), and neither of those enters
 * the value range, which is computed from the adjusted CLOSED comps alone. So
 * the estimate itself is untouched by the gap-fill; what is weakened is the
 * market-direction context around it. A large haircut here would misrepresent
 * where the uncertainty actually lives. If AI-sourced SOLD comps were ever
 * admitted, this factor would be the wrong instrument and a separate, much
 * heavier one would be required.
 */
const AI_GAP_FILLED_MIX_CONFIDENCE_FACTOR = 0.95

export async function runAiCma(input: AiCmaInput): Promise<AiCmaResult> {
  const isArv = input.mode === "investor_arv"
  const sellerUpgrades = (input.subject.sellerUpgrades ?? []).filter((u) => u?.description?.trim())

  // ── 1. Source comps from a PROVIDER (never from a model) ────────────────
  const sourced = await sourceCompsForCma({
    brokerageId: input.brokerageId,
    agentUserId: input.agentUserId ?? null,
    teamId: input.teamId ?? null,
    address: input.subject.address,
    city: input.subject.city ?? null,
    state: input.subject.state,
    zip: input.subject.zip ?? null,
    subject: input.subject,
    propertyType: input.subject.propertyType ?? null,
    systemSource: "ai_cma",
  })

  // ── 2. Load state adjustment rates ──────────────────────────────────────
  const rates = await getStateAdjustmentRates(input.subject.state)
  const stateGuidelinesText = formatRatesForPrompt(input.subject.state, rates)

  // ── 3. Compute adjustments per comp deterministically ──────────────────
  //
  // Seller upgrades reach this stage through input.subject's FEATURE flags
  // (hasPool / basementFinished / conditionGrade / …), which the rate table
  // prices in real state-published dollars. The free-text list itself gets no
  // dollar line — see SELLER_UPGRADE_TREATMENT above for why.
  const adjustClosed = sourced.closedComps.map((c) => adjustComp(input.subject, c, rates, isArv))
  const adjustPending = sourced.pendingComps.map((c) => adjustComp(input.subject, c, rates, isArv))
  const adjustActive = sourced.activeComps.map((c) => adjustComp(input.subject, c, rates, isArv))

  // ── 4. Compute value range from adjusted CLOSED comps ──────────────────
  // Only closed sales set the value. An active or pending comp is an asking
  // price — it tells us about market direction, never about what a home sold for.
  const adjustedPrices = adjustClosed.map((a) => a.adjustedPrice).filter((p) => p > 0)
  const sorted = [...adjustedPrices].sort((a, b) => a - b)
  const mid =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)]
  const low = sorted.length > 0 ? sorted[0] * 0.97 : 0  // -3% from lowest adjusted comp
  const high = sorted.length > 0 ? sorted[sorted.length - 1] * 1.03 : 0  // +3% from highest

  // Confidence — comp count, similarity scores, price spread, and a haircut when
  // the sold window had to be widened to 12 months.
  const avgSimilarity =
    adjustClosed.reduce((s, a) => s + a.comp.similarityScore, 0) /
    Math.max(1, adjustClosed.length)
  const spread = sorted.length >= 2 && mid > 0 ? (sorted[sorted.length - 1] - sorted[0]) / mid : 0
  const spreadPenalty = Math.min(0.3, spread)
  const rawConfidence =
    (adjustClosed.length / REQUIRED_SOLD_COMPS) * 0.5 + avgSimilarity * 0.5 - spreadPenalty
  const confidenceScore = Math.max(
    0,
    Math.min(
      1,
      rawConfidence *
        (sourced.provenance.soldWindowWidened ? WIDENED_WINDOW_CONFIDENCE_FACTOR : 1) *
        (sourced.provenance.aiGapFilledSlots.length > 0 ? AI_GAP_FILLED_MIX_CONFIDENCE_FACTOR : 1)
    )
  )

  // ── 5. Investor ARV calculation ─────────────────────────────────────────
  let arv: AiCmaResult["arv"] | undefined
  if (isArv) {
    const repairBudget = input.estimatedRepairBudget ?? 0
    arv = {
      estimatedArv: Math.round(mid),
      estimatedRepairBudget: repairBudget,
      maxOfferAt70: Math.round(mid * 0.70 - repairBudget),
      maxOfferAt75: Math.round(mid * 0.75 - repairBudget),
    }
  }

  // ── 6. AI narrative — the ASSIST. Explains the number; never sources it ──
  const aiNarrative = await generateValuationNarrative({
    input,
    rates: stateGuidelinesText,
    adjustedComps: adjustClosed,
    pendingComps: adjustPending,
    activeComps: adjustActive,
    provenance: sourced.provenance,
    sellerUpgrades,
    range: { low, mid, high },
    arv,
  })

  // ── 7. Disclaimers ──────────────────────────────────────────────────────
  const disclaimers = buildDisclaimers(
    input.subject.state,
    input.mode,
    sourced.provenance,
    sellerUpgrades.length > 0
  )

  return {
    mode: input.mode,
    estimatedValueLow: Math.round(low),
    estimatedValueMid: Math.round(mid),
    estimatedValueHigh: Math.round(high),
    confidenceScore,
    adjustedComps: adjustClosed,
    pendingComps: adjustPending,
    activeComps: adjustActive,
    compProvenance: sourced.provenance,
    sellerUpgrades,
    sellerUpgradeTreatment: SELLER_UPGRADE_TREATMENT,
    arv,
    aiNarrative,
    citations: sourced.provenance.citations,
    stateGuidelinesUsed: input.subject.state.toUpperCase(),
    costEstimateCents: sourced.provenance.estimatedCostCents + NARRATIVE_COST_CENTS,
    disclaimers,
    generatedAt: new Date().toISOString(),
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function adjustComp(
  subject: SubjectFeatures,
  comp: ScoredComp,
  rates: Awaited<ReturnType<typeof getStateAdjustmentRates>>,
  isArv: boolean
): AdjustedComp {
  // For ARV mode, suppress condition adjustment (we're estimating the comp's
  // POST-renovation value already)
  const useSubject = isArv ? { ...subject, conditionGrade: comp.conditionGrade } : subject
  const { adjustments, adjustedPrice } = computeCompAdjustments({
    subject: useSubject,
    comp,
    rates,
  })
  const total = adjustments.reduce((s, a) => s + a.amount, 0)
  return {
    comp,
    adjustments,
    adjustedPrice,
    totalAdjustment: total,
    totalAdjustmentPct: comp.salePrice > 0 ? total / comp.salePrice : 0,
  }
}

/** One-line, human-readable statement of where this CMA's comps came from. */
export function describeCompProvenance(p: CompProvenance): string {
  const soldWhere =
    p.soldProvider === "rentcast"
      ? `RentCast (platform comps provider), sold within ${p.soldWindowMonths ?? "?"} months`
      : "no provider (none available)"
  const activeWhere = describeSideProvider(p.activeProvider, p.aiGapFilledSlots.includes("active"))
  const pendingWhere = describeSideProvider(p.pendingProvider, p.aiGapFilledSlots.includes("pending"))
  return (
    `${p.soldCompCount} sold from ${soldWhere}; ` +
    `${p.activeCompCount} active from ${activeWhere}; ` +
    `${p.pendingCompCount} pending from ${pendingWhere}.`
  )
}

/** Names a side's source, and says out loud when part of it is an AI web search. */
function describeSideProvider(provider: CompProvenance["activeProvider"], aiGapFilled: boolean): string {
  const base =
    provider === "idxbroker"
      ? "the brokerage's connected IDX Broker feed"
      : provider === "rentcast"
      ? "RentCast"
      : provider === "perplexity"
      ? "an AI web search (Perplexity) — UNVERIFIED, no data provider could serve this side"
      : "no provider (none available)"
  // A side can be part provider, part gap-fill; say so rather than picking one.
  return aiGapFilled && provider !== "perplexity"
    ? `${base}, completed by an AI web search (Perplexity) — the AI-sourced row(s) are UNVERIFIED`
    : base
}

function formatUpgradesForPrompt(upgrades: SellerUpgrade[]): string {
  if (upgrades.length === 0) return ""
  const lines = upgrades.map((u) => {
    const bits = [
      u.completedOn ? `recorded ${u.completedOn}` : null,
      u.estimatedCost != null ? `seller-stated cost $${Math.round(u.estimatedCost).toLocaleString()}` : null,
    ].filter(Boolean)
    return `  • ${u.description}${bits.length ? ` (${bits.join("; ")})` : ""}`
  })
  return `\n\nSELLER-REPORTED IMPROVEMENTS SINCE PURCHASE (provided by the seller, not independently verified):\n${lines.join("\n")}`
}

async function generateValuationNarrative(params: {
  input: AiCmaInput
  rates: string
  adjustedComps: AdjustedComp[]
  pendingComps: AdjustedComp[]
  activeComps: AdjustedComp[]
  provenance: CompProvenance
  sellerUpgrades: SellerUpgrade[]
  range: { low: number; mid: number; high: number }
  arv: AiCmaResult["arv"] | undefined
}): Promise<string> {
  const { input, rates, adjustedComps, pendingComps, activeComps, provenance, sellerUpgrades, range, arv } =
    params

  const compSummary =
    adjustedComps.length > 0
      ? adjustedComps
          .map(
            (a, i) =>
              `Comp ${i + 1}: ${a.comp.address} — $${a.comp.salePrice.toLocaleString()}, off-market ${a.comp.saleDate}` +
              `${a.comp.distanceMiles != null ? `, ${a.comp.distanceMiles} mi away` : ""}` +
              `; adjusted to $${a.adjustedPrice.toLocaleString()} (${a.totalAdjustment >= 0 ? "+" : ""}${(a.totalAdjustmentPct * 100).toFixed(1)}%)`
          )
          .join("\n")
      : "  (none — no closed comparable sales could be sourced)"

  // Every listing row carries its own source, so the narrative writer cannot
  // describe an AI-found listing as if a data provider had reported it.
  const sourceTag = (c: ScoredComp) =>
    c.sourceProvider === "perplexity"
      ? " [SOURCE: AI web search — UNVERIFIED]"
      : c.sourceProvider === "idxbroker"
      ? " [source: IDX Broker feed]"
      : c.sourceProvider === "rentcast"
      ? " [source: RentCast]"
      : ""
  const pendingSummary = pendingComps
    .map((p) => `  • ${p.comp.address} — asking $${p.comp.salePrice.toLocaleString()}${sourceTag(p.comp)}`)
    .join("\n")
  const activeSummary = activeComps
    .map((a) => `  • ${a.comp.address} — asking $${a.comp.salePrice.toLocaleString()}${sourceTag(a.comp)}`)
    .join("\n")
  const hasAiSourcedListing = [...pendingComps, ...activeComps].some(
    (c) => c.comp.sourceProvider === "perplexity"
  )

  const arvBlock = arv
    ? `\n\nINVESTOR ARV ANALYSIS:
  ARV: $${arv.estimatedArv.toLocaleString()}
  Estimated repair budget: $${arv.estimatedRepairBudget.toLocaleString()}
  Max offer at 70% rule: $${arv.maxOfferAt70.toLocaleString()}
  Max offer at 75% rule: $${arv.maxOfferAt75.toLocaleString()}`
    : ""

  const upgradeBlock = formatUpgradesForPrompt(sellerUpgrades)
  const upgradeInstruction = sellerUpgrades.length
    ? "\n  5. The seller's reported improvements: name them and say how they position the home " +
      "within the range. Do NOT attach a dollar value to any individual improvement — the " +
      "comparable adjustments above are the only priced figures in this report, and a renovation's " +
      "cost is not its value."
    : ""

  const prompt = `You are summarizing a comparative market analysis for a real estate professional.

Subject: ${input.subject.address}, ${input.subject.city ?? ""}, ${input.subject.state} ${input.subject.zip ?? ""}
${input.subject.bedrooms ? `Beds: ${input.subject.bedrooms}` : ""}
${input.subject.fullBaths ? `Baths: ${input.subject.fullBaths}F${input.subject.halfBaths ? `+${input.subject.halfBaths}H` : ""}` : ""}
${input.subject.sqftLiving ? `Sqft: ${input.subject.sqftLiving}` : ""}

COMP SOURCING (state this accurately if you mention it; do not upgrade it):
${describeCompProvenance(provenance)}
${provenance.notes.length ? provenance.notes.map((n) => `  - ${n}`).join("\n") : ""}

STATE APPRAISER ADJUSTMENT GUIDELINES already applied to the comps below.
(These were applied DETERMINISTICALLY — the dollar figures are computed, not
yours to revise. They are here so you can explain WHY an adjustment was made.)
${rates}

Adjusted closed comps:
${compSummary}

Pending (under contract, asking price — not a sale):
${pendingSummary || "  (none reported by any connected provider)"}

Active (currently for sale, asking price — not a sale):
${activeSummary || "  (none available)"}
${upgradeBlock}

Estimated value range (derived from the ADJUSTED closed comps only):
  Low:  $${Math.round(range.low).toLocaleString()}
  Mid:  $${Math.round(range.mid).toLocaleString()}
  High: $${Math.round(range.high).toLocaleString()}${arvBlock}

HARD RULES:
  - Use ONLY the comparables listed above. Do not add, recall, or infer any other
    property, address, sale price or sale date. If the comp set is thin, say it is thin.
  - Never describe an active or pending listing as a sale.${
    hasAiSourcedListing
      ? `
  - One or more of the pending/active listings above is tagged
    [SOURCE: AI web search — UNVERIFIED]. Whenever you refer to one, say plainly
    in the same sentence that it was found by an AI web search of public listing
    sites rather than supplied by a data provider, and that it is unverified.
    Do not smooth this over, do not relegate it to a footnote, and do not give
    it the same weight as a provider-sourced comparable.`
      : ""
  }

Write a 3-4 paragraph CMA narrative (NOT an appraisal):
  1. Value conclusion + range justification
  2. Strongest 1-2 comps and why
  3. Market context — what the pending + active listings say about direction
  4. ${arv ? "ARV strategy: comp condition, repair scope, max-offer reasoning" : "Pricing strategy: list at high to leave room for negotiation, or list at mid for faster movement"}${upgradeInstruction}

Tone: professional, fact-grounded, never guarantee a sale price. End with the
mandatory disclaimer that this is informational and not a state-licensed
appraisal.`

  try {
    const { text } = await generateTextRouted({
      feature: "pricing_research",  // routes to a fast/cheap model
      prompt,
      temperature: 0.3,
      maxTokens: 800,
    })
    return text.trim()
  } catch {
    if (adjustedComps.length === 0) {
      return (
        "No comparable sales could be sourced for this property, so no value range has been " +
        `produced. ${provenance.notes.join(" ")} This is not an appraisal.`
      )
    }
    return `Estimated value: $${Math.round(range.mid).toLocaleString()} (range $${Math.round(range.low).toLocaleString()} - $${Math.round(range.high).toLocaleString()}). Based on ${adjustedComps.length} closed comparable sale(s). This is a market estimate, not a state-licensed appraisal.`
  }
}

function buildDisclaimers(
  state: string,
  mode: CmaMode,
  provenance: CompProvenance,
  hasSellerUpgrades: boolean
): string[] {
  const base = [
    "This is a Comparative Market Analysis (CMA), not a state-licensed appraisal. Only a licensed appraiser can produce an official appraisal.",
    "Estimated values are based on comparable sales supplied by a third-party data provider and are subject to market fluctuation.",
  ]

  // ── THE AI GAP-FILL, SAID FIRST ───────────────────────────────────────────
  // Placed at the TOP of the list, immediately after the "this is not an
  // appraisal" line, and never appended to the tail where a reader stops
  // reading. If a row in this report came off a web page instead of a data
  // provider, that is the second thing the reader learns.
  if (provenance.aiGapFilledSlots.length > 0) {
    const sides = provenance.aiGapFilledSlots
      .map((s) => (s === "pending" ? "pending (under-contract)" : s))
      .join(" and ")
    base.splice(
      1,
      0,
      `NOT ALL COMPARABLES CAME FROM A DATA PROVIDER. ${provenance.aiGapFilledCompCount} of the comparables shown — the ${sides} listing(s) — were found by an AI web search of public listing sites, because no connected data provider (RentCast or the brokerage's IDX feed) could supply them. Those rows are UNVERIFIED: they have not been confirmed against the MLS or public records, and they should be independently checked before being relied on. Every AI-sourced row is labelled as such in the comparable table.`,
    )
    base.splice(
      2,
      0,
      "The estimated value range was computed from CLOSED SALES ONLY, and no closed sale in this report came from an AI web search — closed comparables are taken exclusively from a data provider. The AI-sourced listings above inform market direction only; they do not move the estimate.",
    )
  }

  // ── Provenance, said out loud ──────────────────────────────────────────────
  if (provenance.soldProvider === "rentcast") {
    base.push(
      `Comparable sales were sourced from RentCast, the platform's property-data provider, using sales within the last ${provenance.soldWindowMonths} months.`
    )
  }
  if (provenance.activeProvider === "idxbroker") {
    base.push(
      "Active comparable listings came from this brokerage's connected IDX Broker feed — the inventory the brokerage has the rights to display, narrowed to the subject's city/ZIP. It is not a full MLS active search."
    )
  } else if (provenance.activeProvider === "rentcast") {
    base.push("Active comparable listings came from RentCast's current for-sale comparables.")
  }

  // ── The material weaknesses, said before anyone has to ask ────────────────
  if (provenance.soldWindowWidened) {
    base.push(
      `Fewer than ${REQUIRED_SOLD_COMPS} qualifying sales closed within 6 months of this analysis, so the search was widened to 12 months. Older comparables are a materially weaker basis for a value conclusion and a larger share of the estimate rests on the time-of-sale market adjustment.`
    )
  }
  if (provenance.soldCompCount === 0) {
    base.push(
      "No closed comparable sales were available for this property, so no comparable-based value range could be produced."
    )
  } else if (provenance.soldCompCount < REQUIRED_SOLD_COMPS) {
    base.push(
      `This analysis rests on ${provenance.soldCompCount} closed comparable sale(s) — fewer than the ${REQUIRED_SOLD_COMPS} this method calls for. Treat the range as directional. The shortfall was NOT made up with AI-sourced sales: a closed sale that anchors a valuation is only carried here when a data provider supplied it.`
    )
  }
  if (provenance.pendingCompCount === 0) {
    base.push(
      provenance.aiGapFillAttempted
        ? "No pending (under-contract) comparable is included: no connected data provider reports under-contract status for this area, and the AI web-search fallback returned nothing usable either. None was substituted."
        : "No pending (under-contract) comparable is included: no connected data provider reports under-contract status for this area. None was substituted."
    )
  }
  if (provenance.activeCompCount === 0) {
    base.push("No active comparable listings were available from any connected provider.")
  }

  // ── Seller upgrades ───────────────────────────────────────────────────────
  if (hasSellerUpgrades) {
    base.push(
      "Improvements reported by the seller since purchase were provided by the seller, are not independently verified, and are reflected in the written analysis as context. They are NOT applied as a separate dollar adjustment: the state appraiser adjustment rates price structured property features, and the cost of a renovation is not the value it adds."
    )
  }

  if (mode === "investor_arv") {
    base.push(
      "ARV (After Repair Value) is an estimate based on best-condition recent comps and assumes the property is renovated to a comparable standard. Actual post-renovation value depends on scope of work, market timing, and execution quality."
    )
    base.push(
      "Max-offer formulas (70%/75% rules) are common investor frameworks; actual purchase decisions should account for all carrying costs, financing, and market risk."
    )
  }
  if (state.toUpperCase() === "CA") {
    base.push("California: Includes consideration of seismic disclosure obligations under state law.")
  }
  if (state.toUpperCase() === "FL") {
    base.push("Florida: Hurricane wind mitigation, flood zone, and HOA disclosure obligations may impact final pricing.")
  }
  return base
}
