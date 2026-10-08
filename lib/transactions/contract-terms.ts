// lib/transactions/contract-terms.ts
// ──────────────────────────────────────────────────────────────────────────────
// ONE definition of "the contract terms", imported by everything that needs it:
// lib/transactions/offer-bridge.ts (which copies them onto the transaction) and
// app/actions/seller-offers.ts (which selects them for the agent's offer list and
// the AI comparison). It lives in its own module rather than on the bridge so
// that adding a term is a single edit and no surface can hand-type a list that
// silently drifts from the one the deal is actually built from — which is how
// these came to be dropped in the first place.

/**
 * THE EXECUTED CONTRACT'S TERMS, as opposed to its DEADLINES.
 *
 * A DEADLINE (`inspection_deadline`) is a DATE derived from the contract date. A
 * TERM (`inspection_period_days`) is the NUMBER WRITTEN ON THE CONTRACT. Both
 * belong on the transaction and neither replaces the other: the deadline tells
 * the deal-health rails when something is due, the term is the contractual fact
 * an amendment or a dispute is argued from. Waves 10 and 11 recorded, honestly,
 * that these were read off the contract onto `offers` and then DROPPED here
 * because no column existed to hold them. m387 added all twelve to
 * `transactions` with the IDENTICAL names they carry on `offers`, precisely so
 * this is a 1:1 copy and no second vocabulary is created.
 *
 * The list is exported because it is the single definition of "the contract
 * terms" — the SELECT, the INSERT and the proof all read it, so a term can
 * never be added to one and forgotten by another.
 */
export const CONTRACT_TERM_COLUMNS = [
  "financing_type",
  "down_payment_amount",
  "down_payment_percent",
  "closing_cost_contribution",
  "possession_terms",
  "escalation_clause",
  "escalation_cap",
  "appraisal_gap",
  "due_diligence_fee",
  "inspection_period_days",
  "appraisal_contingency_days",
  "financing_contingency_days",
] as const

export type ContractTermColumn = (typeof CONTRACT_TERM_COLUMNS)[number]

/**
 * The DATE columns the transaction carries. Named here only so the disjointness
 * from CONTRACT_TERM_COLUMNS is a checkable property rather than a hope — a term
 * must never land in a deadline slot, which is the same class of bug as the
 * earnest DEPOSIT AMOUNT landing in the earnest DUE DATE (owner correction R28).
 */
/** @proofSeam "Named here only so the disjointness from CONTRACT_TERM_COLUMNS is a checkable property" (above) — scripts/contract-terms-storage-orphan-simulator.ts asserts the two sets never overlap; the writer types its columns through CONTRACT_TERM_COLUMNS and never needs the deadline list. */
export const CONTRACT_DEADLINE_COLUMNS = [
  "inspection_deadline",
  "appraisal_deadline",
  "financing_deadline",
  "close_date",
  "estimated_close_date",
  "contract_date",
] as const

/**
 * PURE. Copy the contract terms off an offers row into a transactions payload.
 * Every column is carried, present or not: a term the contract did not state is
 * an explicit NULL, not an absent key, so "we did not read it" and "the contract
 * is silent" look the same on the row — which is the truth in both cases.
 */
export function copyContractTerms(
  offer: Record<string, unknown> | null | undefined,
): Record<ContractTermColumn, unknown> {
  const out = {} as Record<ContractTermColumn, unknown>
  for (const column of CONTRACT_TERM_COLUMNS) {
    const value = (offer as Record<string, unknown> | null | undefined)?.[column]
    out[column] = value === undefined ? null : value
  }
  return out
}


/**
 * THE TERMS A COUNTER CARRIES FORWARD (wave 95). A counter offer is the SAME
 * deal with some terms changed — it is not a blank offer with a new price. The
 * two counter writers — MERGED in wave 96 (lane 96A): sendCounterOffer is now a
 * gate that delegates to issueCounterOffer, the one writer — (lib/kernel/offers.ts issueCounterOffer, the survivor the
 * approvals queue, voice and the signed-counter recorder call; and
 * app/actions/seller-offers.ts sendCounterOffer, the slide-over) used to insert
 * only the fields the counter named, so the counter row had no closing date and
 * no earnest money, and the transaction built from an ACCEPTED counter
 * (lib/transactions/offer-bridge.ts reads the accepted row) had no close date.
 *
 * Carried: the closing date, the earnest deposit and its due-days term, the
 * contingency list, the property address, the paperwork's origin
 * (`form_source` — what lib/buyer-offer/buyer-signature-evidence.ts
 * isOutsideOriginated reads, so an outside agent's deal stays outside-originated
 * through a counter), and every CONTRACT_TERM_COLUMNS term. NOT carried:
 * `earnest_money_due_at` (a calendar date derived from the EXECUTED contract's
 * date — the parent never executed), signatures, documents, statuses.
 */
export const COUNTER_CARRIED_COLUMNS = [
  "closing_date",
  "earnest_money",
  "earnest_money_due_days",
  "contingencies",
  "property_address",
  "form_source",
  ...CONTRACT_TERM_COLUMNS,
] as const

export type CounterCarriedColumn = (typeof COUNTER_CARRIED_COLUMNS)[number]

/**
 * PURE. The counter row's terms: every carried term from the parent offer, with
 * ONLY the terms the counter changes replaced. `undefined` in `changes` means
 * "the counter did not touch this term" and keeps the parent's value; any other
 * value (including an explicit null — "strike this term") replaces it.
 */
export function carryCounterTerms(
  parent: Record<string, unknown> | null | undefined,
  changes: Partial<Record<CounterCarriedColumn, unknown>> = {},
): Record<CounterCarriedColumn, unknown> {
  const out = {} as Record<CounterCarriedColumn, unknown>
  for (const column of COUNTER_CARRIED_COLUMNS) {
    const changed = changes[column]
    const inherited = (parent as Record<string, unknown> | null | undefined)?.[column]
    out[column] = changed !== undefined ? changed : inherited === undefined ? null : inherited
  }
  return out
}
