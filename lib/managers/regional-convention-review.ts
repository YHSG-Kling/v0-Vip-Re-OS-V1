/**
 * lib/managers/regional-convention-review.ts
 *
 * REGIONAL-CONVENTION YEARLY REVIEW (round 34, owner-approved recommendation) — the
 * Finance Manager's standing yearly task: re-verify lib/offers/regional-closing-costs.ts
 * (the 50-state + DC closing-convention model — transfer taxes, title conventions,
 * settlement models, recording bands, effective property-tax bands) against the
 * PUBLISHED sources those conventions are drawn from.
 *
 * THE HONEST SHAPE: this is a human verification task on code-resident conventions, so
 * it is a SCHEDULED SURFACE ENTRY, not a cron — the QBR idiom (pure window/assessment
 * functions, completion recorded on an existing ledger, dedupe against the ledger
 * itself, no new table, no parallel state):
 *   · Completion is an audit_log row (action REGIONAL_CONVENTION_REVIEW.auditAction,
 *     entity_id = brokerage) written by the governance surface's "mark verified" verb —
 *     the same audit_log idiom the settings actions use, so the tenant audit surface
 *     shows every completion automatically.
 *   · Due state is DERIVED purely from the most recent completion row: never completed
 *     → due now (we don't fake a baseline); completed → due again 365 days later.
 *   · The entry renders on the managers governance surface (manager-trust page) under
 *     the Finance Manager with its due state and the named source classes to check.
 * No cron was added: the per-minute dispatcher registry + CRON_MANAGER are frozen to
 * their owners this round, and a once-a-year automated sweep of third-party statute
 * pages would be a fake verification anyway — a human reads the sources; the OS keeps
 * the schedule honest and the trail auditable.
 *
 * Pure assessment (no I/O) — reads/writes live in the governance surface actions.
 */

import type { ManagerKey } from "@/lib/kernel/manager-registry"

export interface StandingReviewSpec {
  key: string
  owner: ManagerKey
  label: string
  /** What is being re-verified. */
  target: string
  cadenceDays: number
  /** audit_log.action for a completion (the dedupe + due-date ledger). */
  auditAction: string
  /** audit_log.entity_type for a completion. */
  auditEntityType: string
  /** The published source classes a completing reviewer must check — the same
   *  classes the module's provenance notes cite. */
  sources: string[]
  what: string
}

export const REGIONAL_CONVENTION_REVIEW: StandingReviewSpec = {
  key: "regional_convention_yearly_review",
  owner: "finance_manager",
  label: "Regional closing-cost conventions — yearly re-verification",
  target: "lib/offers/regional-closing-costs.ts",
  cadenceDays: 365,
  auditAction: "regional_convention_review_completed",
  auditEntityType: "regional_closing_costs",
  sources: [
    "State DOI title-insurance rate filings / promulgated schedules (e.g. TDI Basic Premium Rates; FL/NM/PA/LA promulgated rates; Iowa Title Guaranty fee)",
    "State + county transfer/deed/recordation tax statutes (incl. graduated structures: WA REET tiers, NYC RPTT, MD county transfer)",
    "State land title association / ALTA settlement-practice and attorney-closing guidance",
    "Published effective property-tax reports (drives the prepaids/escrow bands)",
  ],
  what: "Transfer-tax rates + customary payers, title pricing conventions, settlement/attorney models, recording-fee bands and effective property-tax bands are statutes and regulator filings — they move on legislative/regulatory cycles, so the model is re-verified against the published sources once a year and every completion lands on the audit ledger.",
}

export type StandingReviewStatus = "due" | "overdue" | "scheduled"

export interface StandingReviewAssessment {
  status: StandingReviewStatus
  /** When the review is (or was) due. Null only when never completed (due immediately). */
  dueAt: string | null
  lastCompletedAt: string | null
  /** Days until due (scheduled) or days past due (overdue); 0 when due today / never completed. */
  days: number
  summary: string
}

/**
 * PURE: derive the review's due state from the latest completion on the audit ledger.
 * Never completed → DUE now, said plainly (no invented baseline). Completed → due
 * again cadenceDays later; past that line → OVERDUE with the honest day count.
 */
export function assessStandingReview(
  spec: Pick<StandingReviewSpec, "cadenceDays">,
  lastCompletedIso: string | null,
  now: Date = new Date(),
): StandingReviewAssessment {
  if (!lastCompletedIso || !Number.isFinite(new Date(lastCompletedIso).getTime())) {
    return {
      status: "due",
      dueAt: null,
      lastCompletedAt: null,
      days: 0,
      summary: "No completed review on the audit ledger yet — the first yearly verification is due now.",
    }
  }
  const last = new Date(lastCompletedIso).getTime()
  const dueMs = last + spec.cadenceDays * 86_400_000
  const dueAt = new Date(dueMs).toISOString()
  const deltaDays = Math.floor((now.getTime() - dueMs) / 86_400_000)
  if (deltaDays >= 0) {
    return {
      status: deltaDays === 0 ? "due" : "overdue",
      dueAt,
      lastCompletedAt: lastCompletedIso,
      days: deltaDays,
      summary: deltaDays === 0
        ? "The yearly verification window opened today."
        : `${deltaDays} day${deltaDays === 1 ? "" : "s"} past the yearly verification date.`,
    }
  }
  return {
    status: "scheduled",
    dueAt,
    lastCompletedAt: lastCompletedIso,
    days: -deltaDays,
    summary: `Verified ${lastCompletedIso.slice(0, 10)}; next review due ${dueAt.slice(0, 10)} (${-deltaDays} day${deltaDays === -1 ? "" : "s"} out).`,
  }
}
