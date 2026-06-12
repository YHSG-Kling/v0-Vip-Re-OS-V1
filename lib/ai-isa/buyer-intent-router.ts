/**
 * lib/ai-isa/buyer-intent-router.ts
 *
 * PURE intent → milestone router for the buyer side. No I/O, no server-only — the
 * unit-testable core of the buyer INTENT ROUTER. There is NO one-size-fits-all
 * buyer milestone: each positive-intent reason converts the lead (canonical) and
 * routes to its OWN right milestone. This module is the single source of truth for
 * WHICH milestone each reason maps to; convert-buyer-lead-on-intent.ts executes it.
 *
 * The targetStage values are the canonical BuyerState machine values
 * (lib/buyer-lifecycle/lifecycle-definitions.ts), written to contacts.buyer_stage.
 * The kernelEvent values are KernelEvent enum string values
 * (lib/kernel/events.ts) — verified to exist, not fabricated.
 */

export type BuyerIntentReason =
  | "positive_reply"
  | "criteria_request"
  | "preapproval_request"
  | "showing_request"

export interface BuyerMilestonePlan {
  /** Does this intent advance contacts.buyer_stage past BUYER_CONTACT_CREATED? */
  advancesStage: boolean
  /** Does this intent schedule a showing (BBA-gated)? */
  schedulesShowing: boolean
  /** Does this intent capture buyer criteria into property_preferences? */
  capturesCriteria: boolean
  /** Does this intent START the pre-approval step (unverified financial profile)? */
  startsPreapproval: boolean
  /** Canonical BuyerState the contact lands at after routing (null = no advance). */
  targetStage:
    | "BUYER_SEARCH_CONFIGURED"
    | "BUYER_TOURING"
    | null
  /** KernelEvent enum value fired on the advance (empty when no advance). */
  kernelEvent:
    | "buyer_search_configured"
    | "tour_planned"
    | ""
}

/**
 * Map a buyer positive-intent reason to its milestone plan. Pure + total.
 *
 *   positive_reply      → convert only (dormant ISA, no milestone).
 *   criteria_request    → capture criteria → BUYER_SEARCH_CONFIGURED.
 *   preapproval_request → start pre-approval (unverified profile). No stage jump —
 *                         the buyer REQUESTED pre-approval, hasn't COMPLETED it, and
 *                         the 13-state machine has no pending sub-state, so we honestly
 *                         leave the stage at contact-created until verification lands.
 *   showing_request     → schedule showing (BBA-gated) → BUYER_TOURING.
 */
export function buyerIntentToMilestone(reason: BuyerIntentReason): BuyerMilestonePlan {
  switch (reason) {
    case "criteria_request":
      return {
        advancesStage: true,
        schedulesShowing: false,
        capturesCriteria: true,
        startsPreapproval: false,
        targetStage: "BUYER_SEARCH_CONFIGURED",
        kernelEvent: "buyer_search_configured",
      }
    case "preapproval_request":
      return {
        advancesStage: false,
        schedulesShowing: false,
        capturesCriteria: false,
        startsPreapproval: true,
        targetStage: null,
        kernelEvent: "",
      }
    case "showing_request":
      return {
        advancesStage: true,
        schedulesShowing: true,
        capturesCriteria: false,
        startsPreapproval: false,
        targetStage: "BUYER_TOURING",
        kernelEvent: "tour_planned",
      }
    case "positive_reply":
    default:
      return {
        advancesStage: false,
        schedulesShowing: false,
        capturesCriteria: false,
        startsPreapproval: false,
        targetStage: null,
        kernelEvent: "",
      }
  }
}
