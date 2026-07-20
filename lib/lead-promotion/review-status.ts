// lib/lead-promotion/review-status.ts
// PURE display-status derivation for the platform Raw Leads bench (read-only).
// No I/O — maps a raw_scraped_leads row's processing/dedupe/promotion state to
// a label + whether the AUTOMATIC pipeline still has work to do on it.
//
// CANONICAL PROCESS (owner, round 37): raw leads can't be manually moved to
// leads — promotion is fully automatic (processRawRecord via the lead-scraping
// cron + its stranded-record re-enrich sweep). `pipelineRetryEligible` therefore
// describes the PIPELINE's retry posture, never a manual affordance.

export interface RawLeadRow {
  lead_id?: string | null
  processing_status?: string | null
  dedupe_status?: string | null
  promotion_attempts?: number | null
  error_message?: string | null
}

export type RawLeadReviewTone = "promoted" | "duplicate" | "error" | "pending" | "attempted"

export interface RawLeadReview {
  tone: RawLeadReviewTone
  label: string
  /** Will the automatic pipeline (cron pass / re-enrich sweep) try this row again? */
  pipelineRetryEligible: boolean
}

export function rawLeadReviewStatus(row: RawLeadRow): RawLeadReview {
  // Already promoted → terminal for the pipeline.
  if (row.lead_id) return { tone: "promoted", label: "Promoted", pipelineRetryEligible: false }

  const dedupe = (row.dedupe_status ?? "").toLowerCase()
  if (dedupe === "duplicate" || dedupe === "merged") {
    return { tone: "duplicate", label: "Duplicate", pipelineRetryEligible: false }
  }

  const status = (row.processing_status ?? "").toLowerCase()
  if (status === "error" || row.error_message) {
    return { tone: "error", label: "Error — pipeline retries", pipelineRetryEligible: true }
  }
  if ((row.promotion_attempts ?? 0) > 0) {
    return { tone: "attempted", label: `In re-enrich sweep (${row.promotion_attempts} attempt${(row.promotion_attempts ?? 0) === 1 ? "" : "s"})`, pipelineRetryEligible: true }
  }
  return { tone: "pending", label: "Pending — auto-promotion", pipelineRetryEligible: true }
}
