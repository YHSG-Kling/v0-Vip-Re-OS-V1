// lib/listings/listing-status-sync.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE canonical map: listings.lifecycle_stage (the 34-state stage machine) → listings.status (the
// coarse 7-value market state buyer search / public pages / dashboards read). The two columns drifted:
// the stage machine advanced lifecycle_stage while `status` was only written ad-hoc by webhooks, so a
// just-MLS-active listing could still read status='coming_soon' and never surface in buyer search.
// transitionLifecycle now calls statusForStage() on every listing_stage_machine transition and writes
// the synced status in the SAME atomic update — no extra round-trip, no separate code path.
//
// DESIGN: only the MEANINGFUL market-state boundaries are mapped. Intermediate stages return undefined
// so they NEVER clobber status — coming_soon holds through OPEN_HOUSE_MARKETING; active holds through
// OFFERS_RECEIVED/NEGOTIATION; pending holds through INSPECTION/APPRAISAL/FINANCING/CLOSING_PREP. The
// coarse status only moves when the listing actually crosses a public market-state line.
// No I/O — unit-testable.

/** The 7 allowed listings.status values (live CHECK constraint). */
export type ListingStatus = "draft" | "coming_soon" | "active" | "pending" | "sold" | "expired" | "withdrawn"

export const LISTING_STATUS_VALUES: readonly ListingStatus[] = [
  "draft", "coming_soon", "active", "pending", "sold", "expired", "withdrawn",
] as const

// lifecycle_stage → coarse status, at market-state boundaries only. Unlisted stages → undefined (status
// untouched). Keys must be valid lifecycle_stage values (live CHECK).
const STATUS_FOR_STAGE: Record<string, ListingStatus> = {
  COMING_SOON_ACTIVE: "coming_soon", // publicly teased, pre-MLS
  MLS_ACTIVE:         "active",      // live on MLS — must surface in buyer search
  UNDER_CONTRACT:     "pending",     // accepted offer, off the active market
  CLOSED:             "sold",
  LIFETIME_CUSTOMER:  "sold",        // post-close; idempotent (already sold from CLOSED)
  LISTING_EXPIRED:    "expired",
  LISTING_CANCELLED:  "withdrawn",
  SELLER_DECLINED:    "withdrawn",   // seller chose not to list — terminal, never went to market
}

/** PURE. The coarse listings.status a given lifecycle_stage implies, or undefined when the stage does
 *  not change the public market state (leave status as-is). */
export function statusForStage(stage: string): ListingStatus | undefined {
  return STATUS_FOR_STAGE[stage]
}
