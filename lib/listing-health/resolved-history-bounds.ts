/**
 * lib/listing-health/resolved-history-bounds.ts — the ONE spelling of "recent"
 * for the resolved-intervention audit trail.
 *
 * Read by both surfaces that show who cleared a listing_health_interventions
 * row and when:
 *   · app/dashboard/listings/[id]/lifecycle/page.tsx — the per-listing panel
 *   · app/dashboard/listings/health/actions.ts       — the board across every
 *     listing the agent owns
 * Until 2026-09-03 each declared its own copy (the page as function-local
 * consts inside the component body, the board module-level), with the board's
 * comment naming this exact hoist as the follow-up and warning that any change
 * to one number had to be made in both places. That drift risk is closed here:
 * the number is stated once and both import it (§6).
 *
 * BOUNDS, chosen and stated.
 *   RESOLVED_HISTORY_WINDOW_DAYS = 180 — covers a full listing term plus a
 *   renewal. The per-listing panel sits on an ACTIVE listing, and the
 *   longest-lived thing it can be auditing is that listing's own run.
 *   RESOLVED_HISTORY_LIMIT = 10 — matches the open-intervention list limit
 *   directly beside it on the lifecycle page, so neither half of the panel can
 *   dominate the other. Both surfaces print both numbers beside the list.
 *
 * Pure constants — no client, no I/O.
 */

export const RESOLVED_HISTORY_LIMIT = 10
export const RESOLVED_HISTORY_WINDOW_DAYS = 180
