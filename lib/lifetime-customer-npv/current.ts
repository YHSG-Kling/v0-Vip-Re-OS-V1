// lib/lifetime-customer-npv/current.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CURRENT ROW OF AN APPEND-ONLY LEDGER.
//
// lifetime_customer_npv_scores is a LEDGER, not a snapshot table: scoreContactNpv
// INSERTs a new row on every run and carries previous_score / score_delta, so the
// history of a relationship's value is deliberately kept. That design is right —
// "what did this client's NPV do over the year" is the whole point of a lifetime
// ledger — but it makes one rule mandatory for every reader:
//
//   THE CURRENT VALUE IS THE NEWEST ROW PER CONTACT. Everything older is history.
//
// Four call sites needed that rule and three of them wrote it out by hand
// (identical `latestByContact` maps in app/actions/lifetime-npv.ts,
// lib/agent-action-queue/composer.ts and the sphere rollup in scorer.ts). The
// fourth — the income engine's Rule 4, which puts sphere-nurture actions on an
// agent's queue with a dollar figure attached — did not:
//
//     .order("npv_dollars", { ascending: false }).limit(10)
//
// Ordering by VALUE across an append-only ledger reads history as if it were
// state, and it fails three ways at once. The same contact appears once per
// historical row, so the agent gets the same "PLATINUM sphere: check-in" several
// times over. Each contact is selected at their HISTORIC PEAK rather than their
// current standing, so someone whose NPV has collapsed still ranks top and still
// carries the old dollar figure into estimated_gci_impact_cents. And because the
// limit is 10 ROWS, a single well-scored contact's history can consume the entire
// rule, hiding every other client who is genuinely due.
//
// One implementation, so the rule cannot be honoured in three places and missed
// in the fourth. The dedupe is pure and exported on its own so a guard can prove
// it without a database.

import type { NpvTier } from "./scorer"

/** The shape every reader needs; individual callers select supersets of this. */
export interface LedgerRow {
  contact_id: string
  computed_at?: string
  [key: string]: unknown
}

/**
 * Collapse an append-only ledger to one row per contact.
 *
 * REQUIRES the input to be ordered newest-first — which is what the shared
 * loader guarantees and what every hand-written copy of this relied on. Kept as
 * a precondition rather than re-sorting here because the ordering belongs in the
 * query (it is indexed) and silently re-sorting would hide a caller that forgot
 * it. `assertOrdered` makes that precondition checkable in tests.
 */
export function latestByContact<T extends LedgerRow>(rows: readonly T[]): T[] {
  const seen = new Map<string, T>()
  for (const r of rows) {
    if (!r?.contact_id) continue
    if (!seen.has(r.contact_id)) seen.set(r.contact_id, r)
  }
  return Array.from(seen.values())
}

/** Is this result set actually newest-first? Used by the guard, not at runtime. */
export function isNewestFirst(rows: readonly LedgerRow[]): boolean {
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].computed_at, b = rows[i].computed_at
    if (!a || !b) continue
    if (Date.parse(a) < Date.parse(b)) return false
  }
  return true
}

/**
 * Rank CURRENT ledger rows by value.
 *
 * Deliberately dedupe-then-rank, never rank-then-limit: ranking the raw ledger
 * by npv_dollars is the exact defect this module exists to remove.
 */
export function topByValue<T extends LedgerRow & { npv_dollars?: unknown }>(
  rows: readonly T[], limit: number,
): T[] {
  return latestByContact(rows)
    .slice()
    .sort((a, b) => Number(b.npv_dollars ?? 0) - Number(a.npv_dollars ?? 0))
    .slice(0, Math.max(0, limit))
}

type AnyClient = { from: (t: string) => any }

export interface CurrentLedgerQuery {
  agentId: string
  brokerageId?: string | null
  /** Only rows whose next touchpoint falls on or before this date (YYYY-MM-DD). */
  dueOnOrBefore?: string | null
  /** Restrict to these tiers. */
  tiers?: readonly NpvTier[] | null
  /** Ignore ledger rows computed before this instant (ISO). */
  computedSince?: string | null
  /**
   * How many LEDGER ROWS to pull before deduping — not how many contacts come
   * back. It must be generous, because history consumes it: a contact scored
   * weekly for a year is 52 rows. Callers cap CONTACTS after the dedupe.
   */
  scanLimit?: number
  columns?: string
}

const DEFAULT_COLUMNS =
  "id, contact_id, agent_id, npv_score, npv_dollars, tier, recommended_action, " +
  "recommended_cadence, next_touchpoint_due, score_delta, computed_at"

/**
 * The current ledger for an agent: newest row per contact, already deduped.
 *
 * Never throws — a failed read returns [], because every consumer of this is an
 * additive surface (an action queue, a forecast, a panel) and none of them
 * should take down the page over a ledger read.
 */
export async function loadCurrentLedger<T extends LedgerRow = LedgerRow>(
  svc: AnyClient, q: CurrentLedgerQuery,
): Promise<T[]> {
  try {
    let query = svc.from("lifetime_customer_npv_scores")
      .select(q.columns ?? DEFAULT_COLUMNS)
      .eq("agent_id", q.agentId)
    // Tenant scope when the caller has it — the ledger is per-brokerage and an
    // agent id alone is not a tenant boundary.
    if (q.brokerageId) query = query.eq("brokerage_id", q.brokerageId)
    if (q.dueOnOrBefore) {
      query = query.not("next_touchpoint_due", "is", null).lte("next_touchpoint_due", q.dueOnOrBefore)
    }
    if (q.tiers && q.tiers.length > 0) query = query.in("tier", q.tiers as string[])
    if (q.computedSince) query = query.gte("computed_at", q.computedSince)

    const { data } = await query
      .order("computed_at", { ascending: false })
      .limit(q.scanLimit ?? 2000)

    return latestByContact((data ?? []) as T[])
  } catch {
    return []
  }
}
