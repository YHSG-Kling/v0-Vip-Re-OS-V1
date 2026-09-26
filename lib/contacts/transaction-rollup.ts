// lib/contacts/transaction-rollup.ts
//
// THE ONE DEFINITION of "this contact's transactions with us" (§6 — one
// vocabulary per function).
//
// GRAIN DECISION. `transactions` carries THREE foreign keys to contacts —
// contact_id (the client the deal was opened on), buyer_contact_id and
// seller_contact_id (the sides). A lifetime contact may have been on EITHER
// side of past deals, so "total transactions with us" is the THREE-SIDED union,
// the definition app/crm/contacts/[contactId]/seller-lifetime-overview.tsx has
// always used ("both sides because lifetime contacts may have been on either
// side of past deals"). A single-FK count undercounts anyone who bought through
// us and later sold through us.
//
// Both consumers share these two helpers so the definition cannot fork again:
//   · seller-lifetime-overview.tsx  — display list + memory-video tenure gate
//   · lib/services/contact-management.service.ts getContact — the derived
//     `transaction_count` / `last_closed_at` fields on the Contact surface
//
// The three-FK shape is also why a bare `transactions(...)` embed from contacts
// is ambiguous (PGRST201) and why the OR-filter below cannot be expressed as a
// single PostgREST embed: an embed rides exactly one named relationship. The
// union needs its own query against `transactions`.
//
// Everything here is PURE (no supabase import) so the tsx guard simulators can
// load it, and so it stays a derivation — the derived fields it feeds are
// computed at read time, never stored (the writerless-gate guard exists to
// catch stored aggregates nothing updates).

/** Row shape the rollup needs — a subset of any transactions select. */
export interface TransactionRollupRow {
  status?: string | null
  close_date?: string | null
}

export interface ContactTransactionRollup {
  /** Count of transactions naming the contact on ANY of the three contact FKs. */
  transaction_count: number
  /** Max close_date across CLOSED transactions (ISO string), or null. */
  last_closed_at: string | null
}

/**
 * The three-sided PostgREST `.or()` filter for transactions rows that name a
 * contact on any of its three FKs. Use as:
 *   svc.from("transactions").select(...).or(threeSidedContactTransactionFilter(id))
 */
export function threeSidedContactTransactionFilter(contactId: string): string {
  return `buyer_contact_id.eq.${contactId},seller_contact_id.eq.${contactId},contact_id.eq.${contactId}`
}

/**
 * Derive { transaction_count, last_closed_at } from transactions rows.
 * "Closed" means status === 'closed' AND close_date present — the same
 * predicate the seller-lifetime tenure gate has always applied.
 */
export function deriveTransactionRollup(
  rows: ReadonlyArray<TransactionRollupRow>,
): ContactTransactionRollup {
  const closedTimes = rows
    .filter((t) => t.status === "closed" && t.close_date)
    .map((t) => new Date(t.close_date as string).getTime())
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => b - a)
  return {
    transaction_count: rows.length,
    last_closed_at: closedTimes.length ? new Date(closedTimes[0]).toISOString() : null,
  }
}
