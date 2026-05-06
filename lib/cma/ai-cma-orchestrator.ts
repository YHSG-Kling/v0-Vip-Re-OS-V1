/**
 * AI-CMA ORCHESTRATOR
 *
 * Single entry point for the new AI-driven CMA. Composes:
 *   1. Comp source — Perplexity (free, default) OR paid premium (BatchData /
 *      HouseCanary, agent-triggered before listing appointments)
 *   2. State-specific adjustment rates → applied per comp
 *   3. AI valuation narrative + range (low/mid/high)
 *   4. Investor ARV mode (best-condition comps + repair budget formula)
 *
 * Three call modes:
 *   - mode: 'standard'         Perplexity comps + state adjustments
 *   - mode: 'premium'          BatchData/HouseCanary comps (agent pays/clicks)
 *   - mode: 'investor_arv'     Best-condition comps + ARV + max-offer formula
 *
 * Cost summary (per CMA):
 *   standard:     ~$0.01–0.05  (Perplexity Sonar + GPT narrative)
 *   premium:      ~$0.30–1.00  (BatchData + HouseCanary comp pulls)
 *   investor_arv: ~$0.05       (Perplexity with ARV-mode prompt)
 */

import { generateTextRouted } from "@/lib/ai/models"
import { findCompsViaPerplexity, type ScoredComp } from "./perplexity-comp-finder"
import {
  getStateAdjustmentRates,
  formatRatesForPrompt,
  computeCompAdjustments,
  type SubjectFeatures,
  type CompAdjustment,
} from "./state-adjustment-rates"

export type CmaMode = "standard" | "premium" | "investor_arv"

export interface AiCmaInput {
  mode: CmaMode
  brokerageId: string
  agentUserId?: string | null
  contactId?: string | null
  subject: SubjectFeatures & {
    address: string
    city?: string | null
    state: string  // 2-letter
    zip?: string | null
    propertyType?: "single_family" | "condo" | "townhouse" | null
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

export interface AiCmaResult {
  mode: CmaMode
  estimatedValueLow: number
  estimatedValueMid: number
  estimatedValueHigh: number
  confidenceScore: number      // 0..1
  adjustedComps: AdjustedComp[]
  pendingComp: AdjustedComp | null
  activeComp: AdjustedComp | null
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

export async function runAiCma(input: AiCmaInput): Promise<AiCmaResult> {
  const isArv = input.mode === "investor_arv"
  const isPremium = input.mode === "premium"

  // ── 1. Source comps ─────────────────────────────────────────────────────
  const comps = isPremium
    ? await runPremiumCompPull(input)
    : await findCompsViaPerplexity({
        subjectAddress: input.subject.address,
        subjectCity: input.subject.city,
        subjectState: input.subject.state,
        subjectZip: input.subject.zip,
        subjectBeds: input.subject.bedrooms,
        subjectBaths:
          (input.subject.fullBaths ?? 0) + (input.subject.halfBaths ?? 0) * 0.5,
        subjectSqft: input.subject.sqftLiving,
        subjectYearBuilt: input.subject.yearBuilt,
        subjectPropertyType: input.subject.propertyType ?? "single_family",
        searchRadiusMiles: 1.0,
        monthsBack: 6,
        arvMode: isArv,
      })

  // ── 2. Load state adjustment rates ──────────────────────────────────────
  const rates = await getStateAdjustmentRates(input.subject.state)
  const stateGuidelinesText = formatRatesForPrompt(input.subject.state, rates)

  // ── 3. Compute adjustments per comp deterministically ──────────────────
  const adjustClosed = comps.closedComps.map((c) => adjustComp(input.subject, c, rates, isArv))
  const adjustPending = comps.pendingComp
    ? adjustComp(input.subject, comps.pendingComp, rates, isArv)
    : null
  const adjustActive = comps.activeComp
    ? adjustComp(input.subject, comps.activeComp, rates, isArv)
    : null

  // ── 4. Compute value range from adjusted comps ─────────────────────────
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

  // Confidence — based on comp count, similarity scores, and price spread
  const avgSimilarity =
    adjustClosed.reduce((s, a) => s + a.comp.similarityScore, 0) /
    Math.max(1, adjustClosed.length)
  const spread = sorted.length >= 2 ? (sorted[sorted.length - 1] - sorted[0]) / mid : 0
  const spreadPenalty = Math.min(0.3, spread)
  const confidenceScore = Math.max(
    0,
    Math.min(1, (adjustClosed.length / 3) * 0.5 + avgSimilarity * 0.5 - spreadPenalty)
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

  // ── 6. AI narrative — explain the value, condition, market context ─────
  const aiNarrative = await generateValuationNarrative({
    input,
    rates: stateGuidelinesText,
    adjustedComps: adjustClosed,
    pendingComp: adjustPending,
    activeComp: adjustActive,
    range: { low, mid, high },
    arv,
  })

  // ── 7. Disclaimers ──────────────────────────────────────────────────────
  const disclaimers = buildDisclaimers(input.subject.state, input.mode)

  return {
    mode: input.mode,
    estimatedValueLow: Math.round(low),
    estimatedValueMid: Math.round(mid),
    estimatedValueHigh: Math.round(high),
    confidenceScore,
    adjustedComps: adjustClosed,
    pendingComp: adjustPending,
    activeComp: adjustActive,
    arv,
    aiNarrative,
    citations: comps.citations,
    stateGuidelinesUsed: input.subject.state.toUpperCase(),
    costEstimateCents: isPremium ? 50 : 2,
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

async function generateValuationNarrative(params: {
  input: AiCmaInput
  rates: string
  adjustedComps: AdjustedComp[]
  pendingComp: AdjustedComp | null
  activeComp: AdjustedComp | null
  range: { low: number; mid: number; high: number }
  arv: AiCmaResult["arv"] | undefined
}): Promise<string> {
  const { input, adjustedComps, pendingComp, activeComp, range, arv } = params

  const compSummary = adjustedComps
    .map(
      (a, i) =>
        `Comp ${i + 1}: ${a.comp.address} sold $${a.comp.salePrice.toLocaleString()} on ${a.comp.saleDate}; adjusted to $${a.adjustedPrice.toLocaleString()} (${a.totalAdjustment >= 0 ? "+" : ""}${(a.totalAdjustmentPct * 100).toFixed(1)}%)`
    )
    .join("\n")

  const arvBlock = arv
    ? `\n\nINVESTOR ARV ANALYSIS:
  ARV: $${arv.estimatedArv.toLocaleString()}
  Estimated repair budget: $${arv.estimatedRepairBudget.toLocaleString()}
  Max offer at 70% rule: $${arv.maxOfferAt70.toLocaleString()}
  Max offer at 75% rule: $${arv.maxOfferAt75.toLocaleString()}`
    : ""

  const prompt = `You are summarizing a comparative market analysis for a real estate professional.

Subject: ${input.subject.address}, ${input.subject.city ?? ""}, ${input.subject.state} ${input.subject.zip ?? ""}
${input.subject.bedrooms ? `Beds: ${input.subject.bedrooms}` : ""}
${input.subject.fullBaths ? `Baths: ${input.subject.fullBaths}F${input.subject.halfBaths ? `+${input.subject.halfBaths}H` : ""}` : ""}
${input.subject.sqftLiving ? `Sqft: ${input.subject.sqftLiving}` : ""}

Adjusted closed comps:
${compSummary}

${pendingComp ? `Pending: ${pendingComp.comp.address} at $${pendingComp.comp.salePrice.toLocaleString()}` : ""}
${activeComp ? `Active: ${activeComp.comp.address} at $${activeComp.comp.salePrice.toLocaleString()}` : ""}

Estimated value range:
  Low:  $${Math.round(range.low).toLocaleString()}
  Mid:  $${Math.round(range.mid).toLocaleString()}
  High: $${Math.round(range.high).toLocaleString()}${arvBlock}

Write a 3-4 paragraph CMA narrative (NOT an appraisal):
  1. Value conclusion + range justification
  2. Strongest 1-2 comps and why
  3. Market context — pending + active tell us about current direction
  4. ${arv ? "ARV strategy: comp condition, repair scope, max-offer reasoning" : "Pricing strategy: list at high to leave room for negotiation, or list at mid for faster movement"}

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
    return `Estimated value: $${Math.round(range.mid).toLocaleString()} (range $${Math.round(range.low).toLocaleString()} - $${Math.round(range.high).toLocaleString()}). Based on ${adjustedComps.length} closed comparable sales. This is a market estimate, not a state-licensed appraisal.`
  }
}

/**
 * Premium comp pull — uses paid BatchData + HouseCanary clients. Called when
 * an agent clicks "Pull Premium CMA" before a listing appointment.
 */
async function runPremiumCompPull(input: AiCmaInput): Promise<{
  closedComps: ScoredComp[]
  pendingComp: ScoredComp | null
  activeComp: ScoredComp | null
  citations: string[]
}> {
  const closedComps: ScoredComp[] = []
  const citations: string[] = []

  // BatchData comparable sales (closed only)
  if (process.env.BATCHDATA_API_KEY) {
    try {
      const { fetchComparableSales } = await import("@/lib/external/batchdata-client")
      const bd = await fetchComparableSales({
        address: input.subject.address,
        city: input.subject.city ?? "",
        state: input.subject.state,
        zip: input.subject.zip ?? undefined,
        bedrooms: input.subject.bedrooms ?? 3,
        bathrooms: (input.subject.fullBaths ?? 2) + (input.subject.halfBaths ?? 0) * 0.5,
        squareFeet: input.subject.sqftLiving ?? 1500,
        radiusMiles: 1,
        maxAgeDays: 180,
        limit: 5,
      })

      for (const c of bd ?? []) {
        const cAny = c as unknown as { address?: string; sold_price?: number; sale_price?: number; sold_date?: string; sale_date?: string; square_feet?: number; bedrooms?: number; bathrooms?: number; days_on_market?: number }
        closedComps.push({
          address: cAny.address ?? "Unknown",
          status: "closed",
          salePrice: cAny.sold_price ?? cAny.sale_price ?? 0,
          saleDate: cAny.sold_date ?? cAny.sale_date ?? new Date().toISOString().slice(0, 10),
          sqftLiving: cAny.square_feet ?? null,
          bedrooms: cAny.bedrooms ?? null,
          fullBaths: Math.floor(cAny.bathrooms ?? 0),
          halfBaths: 0,
          garageSpaces: null,
          hasPool: null,
          isWaterfront: null,
          hasView: null,
          lotSizeAcres: null,
          yearBuilt: null,
          conditionGrade: null,
          basementFinished: null,
          isNewConstruction: null,
          isGated: null,
          daysOnMarket: cAny.days_on_market ?? null,
          pricePerSqft: null,
          similarityScore: 0.85,
          citation: "BatchData premium pull",
        })
      }
      citations.push("BatchData premium comp pull")
    } catch {
      // fall through to HouseCanary
    }
  }

  // HouseCanary comps fallback / supplement
  if (closedComps.length < 3 && process.env.HOUSECANARY_API_KEY) {
    try {
      const { fetchHouseCanaryComps } = await import("@/lib/external/housecanary-client")
      const hc = await fetchHouseCanaryComps({
        address: input.subject.address,
        zipCode: input.subject.zip ?? "",
        bedrooms: input.subject.bedrooms ?? 3,
        squareFeet: input.subject.sqftLiving ?? 1500,
        maxAgeDays: 180,
        limit: 5,
      })

      for (const c of hc ?? []) {
        if (closedComps.length >= 3) break
        const cAny = c as unknown as { address?: string; sale_price?: number; sale_date?: string; sqft?: number; beds?: number; baths?: number }
        closedComps.push({
          address: cAny.address ?? "Unknown",
          status: "closed",
          salePrice: cAny.sale_price ?? 0,
          saleDate: cAny.sale_date ?? new Date().toISOString().slice(0, 10),
          sqftLiving: cAny.sqft ?? null,
          bedrooms: cAny.beds ?? null,
          fullBaths: Math.floor(cAny.baths ?? 0),
          halfBaths: 0,
          garageSpaces: null,
          hasPool: null,
          isWaterfront: null,
          hasView: null,
          lotSizeAcres: null,
          yearBuilt: null,
          conditionGrade: null,
          basementFinished: null,
          isNewConstruction: null,
          isGated: null,
          daysOnMarket: null,
          pricePerSqft: null,
          similarityScore: 0.80,
          citation: "HouseCanary premium pull",
        })
      }
      citations.push("HouseCanary premium comp pull")
    } catch {
      // fall through
    }
  }

  return {
    closedComps: closedComps.slice(0, 3),
    pendingComp: null,
    activeComp: null,
    citations,
  }
}

function buildDisclaimers(state: string, mode: CmaMode): string[] {
  const base = [
    "This is a Comparative Market Analysis (CMA), not a state-licensed appraisal. Only a licensed appraiser can produce an official appraisal.",
    "Estimated values are based on publicly available comparable sales and are subject to market fluctuation.",
  ]
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
