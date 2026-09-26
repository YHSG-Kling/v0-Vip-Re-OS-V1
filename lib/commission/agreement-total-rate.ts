// lib/commission/agreement-total-rate.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE TOTAL COMMISSION RATE ON A LISTING AGREEMENT — one rule, stated once.
//
// Owner ruling, verbatim (2026-08-27): "listing agreement total commission rate
// is part of the agreement which is a state form and/or seller agreement."
//
// So `listing_agreements.total_commission_rate` is AGREEMENT DATA, not a derived
// display convenience: the state form / seller agreement carries a total, and the
// intake must capture it. Until this module, the ONE insert of listing_agreements
// (app/actions/seller-listing/execution-engine.ts :: markAgreementSigned) wrote
// only the split pair, while its readers already speak the richer vocabulary:
//
//   · lib/offers/net-sheet-calc.ts :: resolveAgreedCommission — precedence
//     flat fee → TOTAL rate → listing+buyer sum → estimate fallbacks; a
//     TOTAL-ONLY agreement (total present, both splits null) is a first-class
//     shape there and in app/dashboard/listings/[id]/cma/tabs/net-sheet-tab.tsx
//     (its `totalOnly` branch).
//   · lib/workflow/intelligence/multi-offer-matrix.ts, lib/kernel/offer-net-sheet.ts,
//     app/actions/seller-cma.ts, app/actions/cma-presentation/net-sheet-calculator.ts,
//     app/actions/portal-seller.ts, app/dashboard/listings/[id]/offers/page.tsx —
//     all select total_commission_rate and route it through that same resolver.
//   · lib/revenue-protection/scorer.ts reads it and deliberately does NOT use it
//     as listing-side GCI (the total includes the buyer side).
//
// ONE VOCABULARY (§6), matching every reader:
//   · rates are PERCENT values — 3 means 3%, never 0.03;
//   · a TOTAL-ONLY agreement is legal: total set, splits null;
//   · when BOTH splits are recorded, the total IS their sum — the state form's
//     total line and its side lines cannot disagree, so a mismatched entry is
//     REFUSED at intake rather than written and silently resolved later by
//     reader precedence (total would win and the splits would be dead text);
//   · when the splits are recorded and the total was left blank, the total is
//     DERIVED as their sum at write time — numerically identical to what
//     resolveAgreedCommission's split branch would compute, so deriving changes
//     no seller-facing number, it only makes the agreement row state its own
//     total the way the form does;
//   · blank everywhere stays NULL — "no rate recorded" is not 0%.
//
// PURE — no I/O — so the intake simulator can prove the rule without a database,
// and so the "use server" writer (whose every export must be an async public
// endpoint) can import it instead of hosting an un-exportable private copy.

export interface AgreementTotalRateInput {
  /** Listing-side percent as entered, undefined/null when blank. */
  listingRate?: number | null
  /** Buyer-side percent as entered, undefined/null when blank. */
  buyerRate?: number | null
  /** Total percent as entered on the state form / seller agreement, undefined/null when blank. */
  totalRate?: number | null
}

export type AgreementTotalRateResolution =
  | {
      ok: true
      /** What to write to listing_agreements.total_commission_rate. */
      total: number | null
      /** True when the total was derived as listing + buyer rather than entered. */
      derived: boolean
    }
  | { ok: false; error: string }

/** Sum comparisons tolerate float noise (2.5 + 3 entered as 5.5), nothing more. */
const RATE_EPSILON = 0.005

function invalidRate(label: string, v: number | null | undefined): string | null {
  if (v === undefined || v === null) return null
  if (!Number.isFinite(Number(v))) return `${label} must be a number.`
  if (Number(v) < 0) return `${label} cannot be negative.`
  // Percent-scale sanity: no listing agreement conveys more than the sale itself.
  if (Number(v) > 100) return `${label} is a percent value — 3 means 3% — and cannot exceed 100.`
  return null
}

/**
 * Resolve what markAgreementSigned should write to total_commission_rate.
 * Refusals carry the sentence shown to the agent; nothing is silently coerced.
 */
export function resolveTotalCommissionRate(input: AgreementTotalRateInput): AgreementTotalRateResolution {
  for (const [label, v] of [
    ["Listing side commission", input.listingRate],
    ["Buyer side commission", input.buyerRate],
    ["Total commission rate", input.totalRate],
  ] as const) {
    const bad = invalidRate(label, v)
    if (bad) return { ok: false, error: bad }
  }

  const listing = input.listingRate ?? null
  const buyer = input.buyerRate ?? null
  const total = input.totalRate ?? null
  const anySplit = listing !== null || buyer !== null
  const splitSum = (listing ?? 0) + (buyer ?? 0)

  if (total !== null && listing !== null && buyer !== null) {
    // The form recorded all three lines: they must agree, exactly as they must
    // on the paper form. Writing a disagreeing total would not "average out" —
    // resolveAgreedCommission gives the total precedence, so the splits the
    // agent typed would silently stop mattering.
    if (Math.abs(Number(total) - splitSum) > RATE_EPSILON) {
      return {
        ok: false,
        error:
          `Total commission ${total}% does not equal listing ${listing}% + buyer ${buyer}% = ${splitSum}%. ` +
          `Fix the entry to match the executed agreement — the form's total and its side lines cannot disagree.`,
      }
    }
    return { ok: true, total: Number(total), derived: false }
  }

  if (total !== null && anySplit) {
    // One side plus a total: the other side is the difference, but this intake
    // does not invent agreement lines the form may not have — a total smaller
    // than the recorded side is definitely wrong, so only that is refused.
    if (Number(total) + RATE_EPSILON < splitSum) {
      return {
        ok: false,
        error:
          `Total commission ${total}% is less than the recorded side (${splitSum}%). ` +
          `Fix the entry to match the executed agreement.`,
      }
    }
    return { ok: true, total: Number(total), derived: false }
  }

  if (total !== null) return { ok: true, total: Number(total), derived: false } // total-only agreement

  if (anySplit) return { ok: true, total: splitSum, derived: true } // derived: total = sum of recorded sides

  return { ok: true, total: null, derived: false } // nothing recorded — NULL, never 0
}
