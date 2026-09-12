/**
 * lib/kernel/priority-rank.ts — THE rank of a text priority / severity.
 *
 * WHY THIS EXISTS (§6 one vocabulary — lane R3-B, 2026-09-03). Six readers
 * ordered a TEXT priority column in SQL, and text sorts alphabetically:
 * "critical" < "high" < "low" < "medium". So `ORDER BY priority DESC` put
 * `medium` first and `high` LAST — and with a `.limit(10)` on the same query
 * the high rows were the first ones DROPPED. ASC was no better: `low` outranked
 * `medium`. The six sites, each now ordering by its real secondary key in SQL,
 * over-fetching, sorting with `byPriorityDesc`, then slicing to its original
 * limit:
 *   1. app/actions/contact-details.ts               smart_assistant_suggestions      was DESC + limit 10
 *   2. app/dashboard/coaching/page.tsx              smart_assistant_suggestions      was DESC + limit 5
 *   3. app/dashboard/coaching/sessions/page.tsx     smart_assistant_suggestions      was DESC + limit 25
 *   4. app/actions/copilot.ts                       tasks                            was DESC + limit 10
 *   5. app/actions/seller-offers.ts                 transaction_repair_negotiations  was ASC
 *   6. app/dashboard/voice/review/[callId]/page.tsx call_coaching_insights           was ASC
 * No table carries a numeric sibling column (verified live), so the rank lives
 * in code. `assignment_rules.priority` and `lead_scraping_markets.priority` are
 * INTEGER columns — their SQL ORDER BY is correct and untouched.
 *
 * The same rank map had ALSO been hand-copied five times, each with its own
 * numbering and its own fallback for an unknown value:
 *   app/dashboard/admin/support-tickets/support-queue-client.tsx         {urgent:0 … low:3}, unknown → 9
 *   app/dashboard/financials/components/os/financial-action-stack.tsx    {urgent:0 … low:3}
 *   app/mobile/components/os/mobile-followup-panel.tsx                   {high:0 … low:2}, unknown → medium
 *   lib/voice/call-coaching.ts                                           {high:0 … low:2}
 *   app/actions/overdue.ts                                               {critical:4 … low:1}
 * All five fold onto this module; each site's tombstone names this file.
 *
 * VOCABULARY. Live CHECKs (scripts/check-vocabularies.ts):
 * smart_assistant_suggestions.priority (low, medium, high);
 * call_coaching_insights.priority (high, medium, low);
 * transaction_repair_negotiations.priority (critical, high, medium, low);
 * tasks.priority varchar, no CHECK, default 'medium'. Support tickets spell
 * the top rung `urgent`; it is an ALIAS of `critical` here — the same rung,
 * not a rung above it — so a support queue and an overdue list agree on what
 * sorts first.
 *
 * Pure: no client, no I/O, importable on both sides of the client/server
 * boundary (two of the folded copies are "use client" components).
 */

/** Higher = more urgent. `urgent` is an alias of `critical`, not a rung above it. */
export const PRIORITY_RANK = {
  critical: 4,
  urgent: 4,
  high: 3,
  medium: 2,
  low: 1,
} as const satisfies Record<string, number>

export type RankedPriority = keyof typeof PRIORITY_RANK

/**
 * Rank of a value outside the vocabulary (null, undefined, a misspelling):
 * BELOW `low`, so an unranked row sorts last rather than being mistaken for a
 * ranked one. A caller whose column defaults a missing value (tasks.priority
 * DEFAULT 'medium') applies that default before ranking — see the mobile
 * follow-up panel.
 */
export const UNRANKED_PRIORITY = 0

/** Rank of any priority/severity text — case-insensitive, unknown → UNRANKED_PRIORITY. */
export function priorityRank(priority: string | null | undefined): number {
  if (!priority) return UNRANKED_PRIORITY
  const key = priority.toLowerCase() as RankedPriority
  return PRIORITY_RANK[key] ?? UNRANKED_PRIORITY
}

/**
 * Comparator: most urgent first. Ties return 0, so a stable sort (every
 * supported runtime — ES2019 Array.prototype.sort) keeps whatever secondary
 * order the rows arrived in: the SQL ORDER BY on created_at / due_date that
 * each site kept. Sort a COPY (`[...rows].sort(byPriorityDesc)`) when the
 * source array is shared.
 */
export function byPriorityDesc<T extends { priority?: string | null }>(a: T, b: T): number {
  return priorityRank(b.priority) - priorityRank(a.priority)
}
