// lib/transactions/transaction-status.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE transactions.status vocabulary.
//
// OWNER-STATED DEAL PROCESS. The deal ladder lives on the TRANSACTION, not on the
// listing — a listing is a piece of inventory (signed, coming soon, active,
// withdrawn/cancelled/off market, sold); the deal that happens against it is its
// own object with its own states:
//
//   under contract → pending → clear to close → closed / sold → funded
//
// Each of those is a real, actionable boundary in a US residential deal:
//
//   under_contract   offer accepted; inspection + financing contingencies LIVE
//   pending          contingencies cleared; the deal is no longer at risk from them
//   clear_to_close   the lender has issued CTC — docs to title, figures final
//   closed           signed and recorded; the sale happened
//   funded           the loan actually disbursed and the money moved
//
// `closed` and `funded` are not the same day and not the same risk. An agent is
// not paid at `closed`, they are paid at `funded`, which is exactly why the
// commission ledger cares about the difference.
//
// WHAT WAS THERE. The column admitted `closing` and neither `pending`,
// `clear_to_close` nor `funded`. `closing` is a scheduling word, not a milestone —
// it cannot tell you whether the lender has signed off. So the three states an
// agent actually chases were unrepresentable, and five separate surfaces
// hand-rolled `["under_contract", "closing"]` to mean "a live deal".
//
// The coordinator's own status colour map (app/components/coordinator/
// transaction-list.tsx) already had `case "pending"` and `case "clear_to_close"`
// branches — the UI was written against this process before the column could
// store it. m291 makes the column agree.

/** Every value the CHECK admits, in ladder order (terminals last). */
export const TRANSACTION_STATUSES = [
  "lead",
  "qualifying",
  "active",
  "under_contract",
  "pending",
  "clear_to_close",
  "closed",
  "funded",
  "lost",
  "archived",
] as const

export type TransactionStatus = (typeof TRANSACTION_STATUSES)[number]

export function isTransactionStatus(v: string | null | undefined): v is TransactionStatus {
  return !!v && (TRANSACTION_STATUSES as readonly string[]).includes(v)
}

/**
 * IN ESCROW — under contract through clear-to-close. A deal that exists, is not
 * yet closed, and has a contract behind it. This is what the five hand-rolled
 * `["under_contract", "closing"]` filters were reaching for; they missed
 * `pending` and `clear_to_close` because those values did not exist.
 */
export const TRANSACTION_STATUSES_IN_ESCROW: readonly TransactionStatus[] = [
  "under_contract",
  "pending",
  "clear_to_close",
] as const

/** OPEN — everything an agent is still working, contract or not. */
export const TRANSACTION_STATUSES_OPEN: readonly TransactionStatus[] = [
  "active",
  "under_contract",
  "pending",
  "clear_to_close",
] as const

/** DONE — the deal is over, one way or another. Nothing further is chased. */
export const TRANSACTION_STATUSES_TERMINAL: readonly TransactionStatus[] = [
  "closed",
  "funded",
  "lost",
  "archived",
] as const

/** PURE — is there a contract on this deal that has not yet closed? */
export function isInEscrow(status: string | null | undefined): boolean {
  return !!status && (TRANSACTION_STATUSES_IN_ESCROW as readonly string[]).includes(status)
}

/** PURE — is the agent still working this deal? */
export function isOpenDeal(status: string | null | undefined): boolean {
  return !!status && (TRANSACTION_STATUSES_OPEN as readonly string[]).includes(status)
}

/**
 * PURE — how confident are we this deal closes, from its status alone?
 * Monotonic along the ladder: every cleared hurdle raises it. Used for pipeline
 * forecasting, where `under_contract` (inspection could still kill it) must not
 * be weighted the same as `clear_to_close` (the lender has signed off).
 */
export function closeConfidence(status: string | null | undefined): number {
  switch (status) {
    case "clear_to_close": return 0.95
    case "pending":        return 0.85
    case "under_contract": return 0.6
    case "active":         return 0.3
    case "closed":
    case "funded":         return 1
    default:               return 0
  }
}
