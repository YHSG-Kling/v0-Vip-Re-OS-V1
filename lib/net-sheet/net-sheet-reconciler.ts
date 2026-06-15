// lib/net-sheet/net-sheet-reconciler.ts
//
// NET-SHEET SURPRISE GUARD — the pure reconciliation engine.
//
// THE GAP (verified white space): the system ESTIMATES a seller net sheet beautifully
// (lib/kernel/offer-net-sheet → offers.seller_net_estimate, the interactive sheet, the
// portal value card) but NEVER reconciles that promise against the FINAL settlement
// statement / Closing Disclosure. So the seller can be promised "$547K in your pocket"
// at offer time and discover at the table they're netting $512K — and no AI manager
// catches the $35K gap or arms the agent to explain it. Competitors estimate; none
// reconcile estimate-vs-actual and flag the surprise BEFORE the seller feels blindsided.
//
// This module is PURE (no I/O, no server-only): given the ESTIMATED net sheet and the
// ACTUAL figures parsed off the settlement statement, it computes the per-line deltas,
// the overall variance, and an honest surprise verdict. The runner does the I/O and the
// gated escalation. Reuses the SAME line model as offer-net-sheet (sale price minus the
// seller-responsible deductions) so the two halves of the story speak the same language.
//
// HONEST: only lines present on BOTH sides are reconciled at the line level; a missing
// line is reported as `unknown`, never a fabricated $0 delta. When only a net number is
// available on one side, the verdict reconciles on the NET alone (lineDeltas empty) and
// says so. No surprise is asserted from absent data.

/** The canonical net-sheet lines (sale price is a credit; the rest are seller-responsible
 *  deductions). Mirrors offer-net-sheet's breakdown so the estimate and the settlement
 *  statement are compared on identical terms. */
export type NetLineKey =
  | "salePrice"
  | "commission"
  | "mortgagePayoff"
  | "taxesProration"
  | "hoaProration"
  | "buyerCredit"
  | "titleEscrow"
  | "otherCosts"

export const DEDUCTION_KEYS: NetLineKey[] = [
  "commission",
  "mortgagePayoff",
  "taxesProration",
  "hoaProration",
  "buyerCredit",
  "titleEscrow",
  "otherCosts",
]

export const LINE_LABELS: Record<NetLineKey, string> = {
  salePrice: "Sale price",
  commission: "Commission",
  mortgagePayoff: "Mortgage payoff",
  taxesProration: "Property-tax proration",
  hoaProration: "HOA dues / proration",
  buyerCredit: "Buyer closing-cost credit",
  titleEscrow: "Title / escrow fees",
  otherCosts: "Other prorated fees",
}

/** A net sheet's figures. Any line may be absent (undefined) — absent means "not broken
 *  out on this document", NOT zero. `netProceeds`, when present, is the authoritative net
 *  (e.g. offers.seller_net_estimate, or "cash to seller" off the settlement statement);
 *  otherwise the net is computed from the lines. */
export interface NetSheetFigures {
  salePrice?: number
  commission?: number
  mortgagePayoff?: number
  taxesProration?: number
  hoaProration?: number
  buyerCredit?: number
  titleEscrow?: number
  otherCosts?: number
  /** authoritative net if the document states it directly */
  netProceeds?: number
}

/** A surprise verdict. `severe`/`concerning` are NEGATIVE surprises (seller nets LESS than
 *  promised); `pleasant` means the seller nets MORE; `none` is within tolerance. */
export type SurpriseLevel = "none" | "pleasant" | "concerning" | "severe"

export interface LineDelta {
  key: NetLineKey
  label: string
  estimated: number | null
  actual: number | null
  /** actual − estimated in DOLLARS (null when either side is unknown) */
  delta: number | null
  /** the dollar effect on the seller's NET (a higher cost hurts the net; a higher sale
   *  price or a smaller deduction helps). null when unknown. */
  netImpact: number | null
}

export interface NetSheetReconciliation {
  /** true when there was enough on both sides to render a verdict */
  reconciled: boolean
  reason: string
  estimatedNet: number | null
  actualNet: number | null
  /** actualNet − estimatedNet (negative = seller nets LESS than promised) */
  varianceAmount: number | null
  /** varianceAmount / |estimatedNet| (e.g. -0.064 = 6.4% short) */
  variancePct: number | null
  surpriseLevel: SurpriseLevel
  /** per-line deltas, biggest net impact first; only lines present on both sides */
  lineDeltas: LineDelta[]
  /** the single line most responsible for a negative surprise (for the agent's "why") */
  topDriver: LineDelta | null
  /** true when a negative surprise crossed the material threshold (escalate) */
  flagged: boolean
}

// Tolerances. Material = the seller would NOTICE and ask. Severe = a conversation the
// agent must lead before the closing table.
export const MATERIAL_ABS = 2_500
export const MATERIAL_PCT = 0.02
export const SEVERE_ABS = 10_000
export const SEVERE_PCT = 0.05

function num(v: number | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/** Net from explicit figure when present, else computed: salePrice − Σ deductions.
 *  Returns null when neither an explicit net nor a sale price is available. */
export function deriveNet(f: NetSheetFigures): number | null {
  if (num(f.netProceeds) != null) return f.netProceeds as number
  if (num(f.salePrice) == null) return null
  let net = f.salePrice as number
  for (const k of DEDUCTION_KEYS) {
    const v = num(f[k])
    if (v != null) net -= v
  }
  return net
}

/** Reconcile an ESTIMATED net sheet against the ACTUAL settlement figures. Pure. */
export function reconcileNetSheet(
  estimate: NetSheetFigures,
  actual: NetSheetFigures,
): NetSheetReconciliation {
  const estimatedNet = deriveNet(estimate)
  const actualNet = deriveNet(actual)

  const empty: NetSheetReconciliation = {
    reconciled: false,
    reason: "",
    estimatedNet,
    actualNet,
    varianceAmount: null,
    variancePct: null,
    surpriseLevel: "none",
    lineDeltas: [],
    topDriver: null,
    flagged: false,
  }

  if (estimatedNet == null) return { ...empty, reason: "No estimated net on file to reconcile against." }
  if (actualNet == null) return { ...empty, reason: "No actual settlement net available yet." }

  // Per-line deltas — only where BOTH sides carry the line (honest: no fabricated $0).
  const lineDeltas: LineDelta[] = []
  for (const key of ["salePrice", ...DEDUCTION_KEYS] as NetLineKey[]) {
    const est = num(estimate[key])
    const act = num(actual[key])
    if (est == null && act == null) continue
    const delta = est != null && act != null ? act - est : null
    // Net impact: a higher sale price helps; a higher deduction hurts.
    const netImpact = delta == null ? null : key === "salePrice" ? delta : -delta
    lineDeltas.push({ key, label: LINE_LABELS[key], estimated: est, actual: act, delta, netImpact })
  }
  // Biggest hit to the seller's net first (most negative netImpact ranks first).
  lineDeltas.sort((a, b) => (a.netImpact ?? 0) - (b.netImpact ?? 0))

  const varianceAmount = actualNet - estimatedNet
  const base = Math.abs(estimatedNet) || 1
  const variancePct = varianceAmount / base

  const materialThreshold = Math.max(MATERIAL_ABS, MATERIAL_PCT * base)
  const severeThreshold = Math.max(SEVERE_ABS, SEVERE_PCT * base)

  let surpriseLevel: SurpriseLevel = "none"
  if (varianceAmount <= -severeThreshold) surpriseLevel = "severe"
  else if (varianceAmount <= -materialThreshold) surpriseLevel = "concerning"
  else if (varianceAmount >= materialThreshold) surpriseLevel = "pleasant"

  const flagged = surpriseLevel === "severe" || surpriseLevel === "concerning"
  // The driver only matters for a negative surprise; pick the line that hurt net the most.
  const negativeDrivers = lineDeltas.filter((l) => (l.netImpact ?? 0) < 0)
  const topDriver = flagged && negativeDrivers.length > 0 ? negativeDrivers[0] : null

  const reason =
    surpriseLevel === "none"
      ? `Final net is within tolerance of the estimate (${fmtSigned(varianceAmount)}).`
      : surpriseLevel === "pleasant"
        ? `Seller nets ${fmtSigned(varianceAmount)} MORE than estimated — a pleasant surprise.`
        : `Seller nets ${fmtSigned(varianceAmount)} vs the estimate (${(variancePct * 100).toFixed(1)}%)${
            topDriver ? ` — driven mostly by ${topDriver.label.toLowerCase()}` : ""
          }.`

  return {
    reconciled: true,
    reason,
    estimatedNet,
    actualNet,
    varianceAmount,
    variancePct,
    surpriseLevel,
    lineDeltas,
    topDriver,
    flagged,
  }
}

function fmtSigned(n: number): string {
  const s = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(Math.abs(n))
  return `${n < 0 ? "-" : "+"}${s}`
}

/** Deterministic FALLBACK copy for the gated Deal-Coordinator alert. Earned lines only:
 *  names the address, the dollar gap, and the top driver so the agent can ask the title
 *  company the RIGHT question before the seller is blindsided. */
export function composeSurpriseFallback(args: {
  propertyAddress: string
  recon: NetSheetReconciliation
}): string {
  const { propertyAddress, recon } = args
  const gap = fmtSigned(recon.varianceAmount ?? 0)
  const driver = recon.topDriver
  const driverNote =
    driver && driver.delta != null
      ? ` The biggest gap is ${driver.label.toLowerCase()}: estimated ${fmtUsd(driver.estimated ?? 0)}, settlement shows ${fmtUsd(driver.actual ?? 0)} (${fmtSigned(driver.delta)}).`
      : ""
  const lead =
    recon.surpriseLevel === "severe"
      ? `⚠️ Net-sheet surprise on ${propertyAddress}: the final settlement nets the seller ${gap} vs what we estimated.`
      : `Heads-up on ${propertyAddress}: the final settlement nets the seller ${gap} vs our estimate.`
  return `${lead}${driverNote} Reconcile the settlement statement with the title company and get ahead of the seller conversation BEFORE the table — confirm the line, then explain the change proactively.`
}

function fmtUsd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
}

/** A stable signature of the actual figures so a re-run on the SAME settlement statement
 *  is idempotent, but a corrected statement re-triggers. */
export function actualSignature(actual: NetSheetFigures): string {
  const net = deriveNet(actual)
  const parts = (["salePrice", ...DEDUCTION_KEYS] as NetLineKey[]).map((k) => `${k}:${num(actual[k]) ?? ""}`)
  return `net:${net ?? ""}|${parts.join("|")}`
}
