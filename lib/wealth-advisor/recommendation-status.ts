// lib/wealth-advisor/recommendation-status.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE wealth-recommendation lifecycle.
//
// wealth_advisor_recommendations.status carries a live CHECK constraint
// admitting exactly six values:
//
//   open · presented · reviewed · converted · dismissed · stale
//
// and the column defaults to 'open'. The daily scan (lib/wealth-advisor/
// scan-opportunities.ts) inserts without a status, so every row a real agent
// could ever see is 'open'.
//
// Three separate readers had each invented their own vocabulary for that
// column, and not one of them overlapped with the constraint on the value the
// writer actually produces:
//
//   app/actions/predictive-surfaces.ts   .in(status, [pending_review, ready_to_push, pushed])
//   app/dashboard/wealth/actions.ts      status === 'new' || status === 'active'
//   lib/lifetime-customer-npv/scorer.ts  .in(status, [new, pushed, reviewed, acknowledged])
//
// The first matched nothing, ever — the Wealth Advisor surface on the
// predictive dashboard was permanently empty. The second sorted every live
// opportunity into the "already acted on" history list, so the by-type grid
// the page is built around never rendered a card. The third contributed a
// wealth signal of exactly zero to every lifetime-NPV score ('reviewed' is
// real but nothing writes it).
//
// So the vocabulary lives here once, and the readers import it.

/** Every value the CHECK constraint admits, in lifecycle order. */
export const WEALTH_STATUSES = [
  "open",
  "presented",
  "reviewed",
  "converted",
  "dismissed",
  "stale",
] as const

export type WealthStatus = (typeof WEALTH_STATUSES)[number]

/** What the column defaults to — the scan inserts no status of its own. */
export const WEALTH_STATUS_DEFAULT: WealthStatus = "open"

/**
 * Still actionable: the agent has not converted, dismissed, or let it go stale.
 * `presented` (pushed to the client portal) and `reviewed` stay actionable —
 * showing a client an opportunity is not the same as closing it out.
 */
export const WEALTH_ACTIVE_STATUSES: readonly WealthStatus[] = ["open", "presented", "reviewed"]

/** Terminal: the opportunity is history, not work. */
export const WEALTH_CLOSED_STATUSES: readonly WealthStatus[] = ["converted", "dismissed", "stale"]

/** Written when the agent pushes the opportunity to the client's portal. */
export const WEALTH_STATUS_PRESENTED: WealthStatus = "presented"
/** Written when the agent marks the opportunity acted on. */
export const WEALTH_STATUS_CONVERTED: WealthStatus = "converted"
/** Written when the agent dismisses it, with a reason. */
export const WEALTH_STATUS_DISMISSED: WealthStatus = "dismissed"

/** PURE — is this row still work the agent should see? */
export function isWealthActive(status: string): boolean {
  return (WEALTH_ACTIVE_STATUSES as readonly string[]).includes(status)
}
