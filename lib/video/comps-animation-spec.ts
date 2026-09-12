// lib/video/comps-animation-spec.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE COMPS-ANIMATION BRAIN — turns a buyer's target property + its REAL recent comparable
// sales into the bar-chart rows the CMAReel animation renders ("this home vs 3 recent sales")
// AND the plain fair-value read the agent's offer plan states ("priced ~4% below the comp
// median — room to win"). PURE: no I/O, no fabrication — it normalizes whatever real comps the
// comps engine (runAiCma / findCompsViaPerplexity) returns. The live comps FETCH + the Director
// render are wired separately; this is the deterministic, testable core both depend on.
//
// Row shape mirrors remotion/charts/CompsBar.tsx CompRow ({label, value, isSubject?}) WITHOUT
// importing Remotion into lib — structural compatibility, not a coupling.
//
// WHO CONSUMES WHAT (wired 2026-09-03, wave 26 lane L3):
//   · The CMAReel's comps bars are built by lib/charts/cma-reel-data.ts (:100-102), NOT here —
//     that builder gates the SUBJECT bar on audience === "agent", because the seller's own price
//     is off client display (CLAUDE.md §5). Do not route the seller-facing reel through this
//     module; `includeSubject: false` exists so an agent-only caller can still share the read.
//   · The fair-value READ (fairValue / confidence / agentRead) is consumed by
//     lib/agents/offer-strategy-producer.ts, where it grounds the AGENT-facing offer brief.

/** A single comparable sale (real data from the comps engine). */
export interface CompInput {
  label: string // address or short label
  soldPrice: number
}

/** A bar row for the CMAReel CompsBar animation. */
export interface CompBarRow {
  label: string
  value: number
  isSubject?: boolean
}

export type FairValueRead = "below_market" | "at_market" | "above_market" | "unknown"

/** How much weight the read deserves — a thin/scattered comp set is DIRECTIONAL, not gospel.
 *  Guards against a black-and-white CMA "coming up short" and over-claiming. */
export type CompsConfidence = "high" | "moderate" | "low"

export interface CompsAnimationSpec {
  /** Subject highlighted + each comp, ready for the CompsBar animation. */
  rows: CompBarRow[]
  /** Median of the comparable sale prices (null when no comps). */
  compMedian: number | null
  /** Subject price vs the comp median, as a signed % (negative = below market). null w/o comps. */
  deltaPct: number | null
  fairValue: FairValueRead
  /** Confidence in the read from the comp count + spread (≥4 tight → high; <3 or wide → low). */
  confidence: CompsConfidence
  /** The AGENT-facing one-liner for the offer plan — softened when confidence is low (directional,
   *  never a definitive verdict that would scare a client if the agent repeated it verbatim). */
  agentRead: string
}

/** Tolerance band around the comp median that reads as "at market" (±%). */
export const AT_MARKET_BAND_PCT = 3
/** A comp price spread wider than this (max/min − 1) means the comps disagree → lower confidence. */
export const WIDE_SPREAD_RATIO = 0.25

function median(nums: number[]): number | null {
  const xs = nums.filter((n) => typeof n === "number" && n > 0).sort((a, b) => a - b)
  if (xs.length === 0) return null
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid]
}

const money = (n: number) => `$${Math.round(n).toLocaleString()}`

/**
 * buildCompsAnimationSpec — PURE. Normalize the subject + real comps into animation rows + a
 * fair-value read. With no usable comps it returns an honest "unknown" (the caller degrades to
 * the motivational reel + a number-free brief — never a fabricated comp set).
 */
export function buildCompsAnimationSpec(input: {
  subjectLabel: string
  subjectPrice: number
  comps: CompInput[]
  /** false → rows carry the comps ONLY (a customer-facing surface must not print the subject's
   *  price, §5). The read (fairValue/deltaPct/agentRead) is computed either way — it is agent copy. */
  includeSubject?: boolean
}): CompsAnimationSpec {
  const comps = (input.comps ?? []).filter((c) => c && typeof c.soldPrice === "number" && c.soldPrice > 0)
  const rows: CompBarRow[] = [
    ...(input.includeSubject === false ? [] : [{ label: "This home", value: input.subjectPrice, isSubject: true }]),
    ...comps.map((c) => ({ label: c.label, value: c.soldPrice })),
  ]
  const compMedian = median(comps.map((c) => c.soldPrice))

  if (compMedian == null || !(input.subjectPrice > 0)) {
    return { rows, compMedian, deltaPct: null, fairValue: "unknown", confidence: "low", agentRead: "Not enough recent comps to read fair value yet — pull a few more before advising." }
  }

  // Confidence: comp count + price spread. A thin or scattered set is DIRECTIONAL only.
  const prices = comps.map((c) => c.soldPrice)
  const spread = Math.max(...prices) / Math.min(...prices) - 1
  const confidence: CompsConfidence =
    comps.length >= 4 && spread <= WIDE_SPREAD_RATIO ? "high"
    : comps.length >= 3 && spread <= WIDE_SPREAD_RATIO ? "moderate"
    : "low"

  const deltaPct = Math.round(((input.subjectPrice - compMedian) / compMedian) * 1000) / 10 // 1 decimal
  let fairValue: FairValueRead
  if (Math.abs(deltaPct) <= AT_MARKET_BAND_PCT) fairValue = "at_market"
  else if (deltaPct < 0) fairValue = "below_market"
  else fairValue = "above_market"

  // Low confidence → soft, directional language (never a definitive verdict that, if repeated to a
  // client, would scare them). High/moderate → the crisp read the agent can act on.
  const qualifier = confidence === "low" ? "a few comps suggest roughly " : "~"
  const tail = confidence === "low" ? " — directional only; worth a closer look before you advise." : ""
  const agentRead =
    confidence === "low"
      ? `Thin comp set (${comps.length}). ${qualifier}${Math.abs(deltaPct)}% ${deltaPct < 0 ? "below" : deltaPct > 0 ? "above" : "around"} a ${money(compMedian)} median${tail}`
      : fairValue === "below_market"
      ? `Listed ~${Math.abs(deltaPct)}% BELOW the comp median (${money(compMedian)}) — room to win at or near ask.`
      : fairValue === "above_market"
      ? `Listed ~${deltaPct}% ABOVE the comp median (${money(compMedian)}) — justify the premium or negotiate down.`
      : `Listed right around the comp median (${money(compMedian)}) — fairly priced; compete on terms.`

  return { rows, compMedian, deltaPct, fairValue, confidence, agentRead }
}
