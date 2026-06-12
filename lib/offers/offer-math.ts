// lib/offers/offer-math.ts
//
// PURE seller net-proceeds commission math — the SINGLE SOURCE OF TRUTH.
//
// Numbers in, numbers out. NO "server-only", NO AI gateway, NO Supabase, NO imports
// except types. This is intentionally dependency-light so it is importable EVERYWHERE:
//   · lib/offers/offer-analyzer.ts        (server-only AI surface — re-exports this)
//   · lib/kernel/offer-net-sheet.ts       (non-server-only kernel + cron + simulator)
//   · app/components/.../interactive-net-sheet.tsx  (client component, transitively)
//
// CONVENTIONS (do not drift):
//   · commission_rate is a DECIMAL fraction, e.g. 0.06 for 6% (NOT a percent like 6).
//     Callers holding a percent (e.g. listings.commission_rate = 6, or the UI's
//     commissionPct) must divide by 100 BEFORE calling. This module never divides by 100.
//   · closing_cost_contribution is the buyer's requested seller-paid closing-cost credit,
//     in whole dollars; null is treated as 0.
//   · All values are plain dollars; no rounding is applied here — the inputs are passed
//     through arithmetically so results are bit-identical to the pre-consolidation copies.

/** Inputs for the canonical commission + buyer-credit net-to-seller math. */
export interface NetToSellerInput {
  offer_price: number
  /** the buyer's requested seller-paid closing-cost credit, in dollars; null → 0 */
  closing_cost_contribution: number | null
  /** commission as a DECIMAL fraction, e.g. 0.06 */
  commission_rate: number
}

/**
 * Canonical net-to-seller after commission and the buyer's closing-cost credit.
 *
 *   net = offer_price − (offer_price × commission_rate) − (closing_cost_contribution ?? 0)
 *
 * This is the commission/credit CORE shared by the offer-analyzer AI surface and the
 * kernel net-sheet engine. The net-sheet engine extends it with the seller-responsible
 * deductions (payoff, taxes, HOA, other) that the offer/listing rows don't carry.
 */
export function calcNetToSeller(params: NetToSellerInput): number {
  const { offer_price, closing_cost_contribution, commission_rate } = params
  const commission = offer_price * commission_rate
  const sellerConc = closing_cost_contribution ?? 0
  return offer_price - commission - sellerConc
}
