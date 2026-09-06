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

/**
 * PIPELINE BOARD COLUMNS — the ONE definition of which statuses land in which
 * column of the agent kanban / dashboard pipeline.
 *
 * WHAT WAS THERE. Both boards (lib/application/transactions.ts —
 * getAgentTransactionKanban and calculatePipeline) hand-rolled their columns
 * against `offer`, `negotiation`, `inspection`, `appraisal`, `financing` and
 * `prospecting`. `transactions_status_check` admits NONE of those six: they are
 * the lowercased `stage` vocabulary (transactions_stage_check), which lives in a
 * different column. Every filter matched zero rows, so "Active Offers" and
 * "Under Contract" were permanently empty on every brokerage — including the one
 * live deal sitting at status=under_contract/stage=INSPECTION.
 *
 * Keyed on `status` alone, because STAGE_TO_STATUS_MAP
 * (lib/transactions/transaction-stages.ts:22) keeps status in lockstep with
 * stage on every advance, and pre-contract deals (lead/qualifying/active) have
 * no stage at all.
 */
export const PIPELINE_COLUMN_STATUSES = {
  /** Not yet a working deal. */
  lead: ["lead", "qualifying"],
  /** Working the deal, no accepted contract yet — where an outstanding offer sits. */
  offer: ["active"],
  /** Contract signed; inspection/appraisal (under_contract) then contingencies cleared (pending). */
  contract: ["under_contract", "pending"],
  /** Lender has issued clear-to-close. */
  closing: ["clear_to_close"],
  /** The sale happened; `funded` is closed-and-disbursed. */
  closed: ["closed", "funded"],
} as const satisfies Record<string, readonly TransactionStatus[]>

export type PipelineColumn = keyof typeof PIPELINE_COLUMN_STATUSES

/** PURE — does this deal belong in the given pipeline column? */
export function inPipelineColumn(status: string | null | undefined, column: PipelineColumn): boolean {
  return !!status && (PIPELINE_COLUMN_STATUSES[column] as readonly string[]).includes(status)
}

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
