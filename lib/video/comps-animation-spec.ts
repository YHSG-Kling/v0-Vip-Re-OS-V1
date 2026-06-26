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

export interface CompsAnimationSpec {
  /** Subject highlighted + each comp, ready for the CompsBar animation. */
  rows: CompBarRow[]
  /** Median of the comparable sale prices (null when no comps). */
  compMedian: number | null
  /** Subject price vs the comp median, as a signed % (negative = below market). null w/o comps. */
  deltaPct: number | null
  fairValue: FairValueRead
  /** The agent-facing one-liner for the offer plan (factual, no fabrication). */
  agentRead: string
}

/** Tolerance band around the comp median that reads as "at market" (±%). */
export const AT_MARKET_BAND_PCT = 3

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
}): CompsAnimationSpec {
  const comps = (input.comps ?? []).filter((c) => c && typeof c.soldPrice === "number" && c.soldPrice > 0)
  const rows: CompBarRow[] = [
    { label: "This home", value: input.subjectPrice, isSubject: true },
    ...comps.map((c) => ({ label: c.label, value: c.soldPrice })),
  ]
  const compMedian = median(comps.map((c) => c.soldPrice))

  if (compMedian == null || !(input.subjectPrice > 0)) {
    return { rows, compMedian, deltaPct: null, fairValue: "unknown", agentRead: "Not enough recent comps to read fair value yet." }
  }

  const deltaPct = Math.round(((input.subjectPrice - compMedian) / compMedian) * 1000) / 10 // 1 decimal
  let fairValue: FairValueRead
  if (Math.abs(deltaPct) <= AT_MARKET_BAND_PCT) fairValue = "at_market"
  else if (deltaPct < 0) fairValue = "below_market"
  else fairValue = "above_market"

  const agentRead =
    fairValue === "below_market"
      ? `Listed ~${Math.abs(deltaPct)}% BELOW the comp median (${money(compMedian)}) — room to win at or near ask.`
      : fairValue === "above_market"
      ? `Listed ~${deltaPct}% ABOVE the comp median (${money(compMedian)}) — justify the premium or negotiate down.`
      : `Listed right around the comp median (${money(compMedian)}) — fairly priced; compete on terms.`

  return { rows, compMedian, deltaPct, fairValue, agentRead }
}
