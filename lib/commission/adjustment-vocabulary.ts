/**
 * lib/commission/adjustment-vocabulary.ts
 *
 * TWO TABLES SPELL "ADJUSTMENT TYPE" DIFFERENTLY, AND ONE VARIABLE WAS WRITTEN
 * INTO BOTH.
 *
 * `uploadListingAgreement` takes ONE `commissionTerms.adjustmentType` string and
 * writes it into two places:
 *
 *   listing_agreements.adjustment_type   — WHY the commission was adjusted. This
 *     is the seller-facing reason an agent picks in the UI:
 *       first_responder | military | repeat_client | relocation |
 *       charity_donation | custom
 *
 *   commission_adjustments.adjustment_type — HOW the money engine should treat it.
 *     A different set, and only partly overlapping:
 *       rate_override | credit | discount | charity_donation |
 *       first_responder | custom
 *
 * The overlap is only {first_responder, charity_donation, custom}. `military`,
 * `repeat_client` and `relocation` are perfectly valid reasons and are REJECTED
 * outright by the ledger's CHECK. The parameter is typed `adjustmentType?: string`
 * — no union — so TypeScript had nothing to compare and the mismatch surfaced
 * only as a constraint violation at the database, which supabase-js reports by
 * RESOLVING rather than throwing.
 *
 * The reason is never lost: it stays on listing_agreements.adjustment_type, and
 * this module carries it into the ledger row's notes as well, so the money engine
 * row explains itself without having to join back.
 *
 * MIRRORS the two live CHECK constraints. Adding a member on either side without
 * the matching migration produces a value the database refuses.
 */

/** WHY the commission was adjusted — the reason an agent picks. */
export type CommissionAdjustmentReason =
  | "first_responder"
  | "military"
  | "repeat_client"
  | "relocation"
  | "charity_donation"
  | "custom"

/** HOW the money engine treats it — the ledger's mechanism vocabulary. */
export type CommissionAdjustmentMechanism =
  | "rate_override"
  | "credit"
  | "discount"
  | "charity_donation"
  | "first_responder"
  | "custom"

/** Every reason, in the order a picker should offer them. */
export const COMMISSION_ADJUSTMENT_REASONS: CommissionAdjustmentReason[] = [
  "first_responder",
  "military",
  "repeat_client",
  "relocation",
  "charity_donation",
  "custom",
]

/** Human labels — the raw column value is not reader-friendly. */
export const COMMISSION_ADJUSTMENT_REASON_LABEL: Record<CommissionAdjustmentReason, string> = {
  first_responder:  "First Responder",
  military:         "Military",
  repeat_client:    "Repeat Client",
  relocation:       "Relocation",
  charity_donation: "Charity Donation",
  custom:           "Custom",
}

/**
 * Reason → ledger mechanism.
 *
 * Where the ledger has the reason as its own member (first_responder,
 * charity_donation) it is kept, because that carries more meaning than a generic
 * mechanism. Everything else IS a discount on the gross commission, which is what
 * `discount` means — the specific reason travels alongside in the notes.
 */
const REASON_TO_MECHANISM: Record<CommissionAdjustmentReason, CommissionAdjustmentMechanism> = {
  first_responder:  "first_responder",
  charity_donation: "charity_donation",
  custom:           "custom",
  military:         "discount",
  repeat_client:    "discount",
  relocation:       "discount",
}

/**
 * Translate a reason into a value commission_adjustments.adjustment_type accepts.
 * An unrecognised reason becomes `custom` rather than being passed through — an
 * unknown string is guaranteed to violate the CHECK, and losing the granularity
 * is better than losing the whole adjustment.
 */
export function ledgerMechanismForReason(reason: string | null | undefined): CommissionAdjustmentMechanism {
  if (!reason) return "custom"
  return REASON_TO_MECHANISM[reason as CommissionAdjustmentReason] ?? "custom"
}

/**
 * Who receives the benefit — commission_adjustments.recipient_type is NOT NULL
 * and admits buyer | seller | agent | brokerage | charity.
 *
 * A concession negotiated INTO a listing agreement comes off the gross commission
 * for the seller's benefit; a charity donation goes to the charity.
 */
export function recipientTypeForReason(reason: string | null | undefined): "seller" | "charity" {
  return reason === "charity_donation" ? "charity" : "seller"
}

/** Is this reason storable on listing_agreements.adjustment_type? */
export function isCommissionAdjustmentReason(value: string): value is CommissionAdjustmentReason {
  return (COMMISSION_ADJUSTMENT_REASONS as string[]).includes(value)
}

/** Label a raw reason without trusting it to be in the union. */
export function commissionAdjustmentReasonLabel(value: string | null | undefined): string {
  if (!value) return "Adjustment"
  return COMMISSION_ADJUSTMENT_REASON_LABEL[value as CommissionAdjustmentReason] ?? value
}
