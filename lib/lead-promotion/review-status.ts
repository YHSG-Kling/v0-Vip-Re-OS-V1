// lib/lead-promotion/review-status.ts
// PURE display-status derivation for the admin Raw Leads review panel. No I/O —
// maps a raw_scraped_leads row's processing/dedupe/promotion state to a label +
// whether the admin may still manually promote it. Unit-tested; the panel and the
// action agree on what "promotable" means.

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
  /** May an admin manually promote this raw record now? */
  canPromote: boolean
}

export function rawLeadReviewStatus(row: RawLeadRow): RawLeadReview {
  // Already promoted → terminal, not promotable again.
  if (row.lead_id) return { tone: "promoted", label: "Promoted", canPromote: false }

  const dedupe = (row.dedupe_status ?? "").toLowerCase()
  if (dedupe === "duplicate" || dedupe === "merged") {
    return { tone: "duplicate", label: "Duplicate", canPromote: false }
  }

  const status = (row.processing_status ?? "").toLowerCase()
  if (status === "error" || row.error_message) {
    return { tone: "error", label: "Error — retry", canPromote: true }
  }
  if ((row.promotion_attempts ?? 0) > 0) {
    return { tone: "attempted", label: `Retry (${row.promotion_attempts} prior)`, canPromote: true }
  }
  return { tone: "pending", label: "Pending review", canPromote: true }
}
