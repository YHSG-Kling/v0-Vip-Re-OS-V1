// lib/lead-pipeline/processing-status.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE VOCABULARY FOR raw_scraped_leads.processing_status.
//
// This column is the gate the entire lead pipeline turns on: a scraped record's
// whole fate — enriched, promoted, rejected with a reason, or errored — is this
// one string. It was the only column on the table with NO CHECK constraint,
// which made it invisible to test:check-vocabulary. That guard works by
// comparing code literals against the database's admitted set, so a column
// without a set cannot be covered by it at all.
//
// Why that matters, in the guard's own words: supabase-js resolves with
// `{ error }` instead of throwing and most writes here are best-effort, so a
// value outside the admitted set does not crash — it loses the row in silence.
// On the read side it is worse: a filter on a value the column can never hold
// returns zero rows and looks like "no data yet" forever.
//
// AND THE LIST WAS ALREADY DRIFTING. pipeline-processor.ts declared the union;
// lead-intake-cockpit.ts declared REJECTION_STATUSES with the comment "Kept
// verbatim from ProcessingStatus" — a hand-copied subset. Two hand-maintained
// lists of the same vocabulary is how the next value gets added to one and not
// the other, and the cockpit then silently stops counting a rejection reason.
// Both now import from here.
//
// PURE — no I/O. The CHECK constraint in the migration is generated from this
// same list, so the database and the code cannot disagree.

/**
 * Every value the pipeline may write, in lifecycle order.
 *
 * pending → processing → queued_for_enrichment → enriching → promoted,
 * with the gate-stop reasons and `error` as terminal branches off that spine.
 */
export const RAW_PROCESSING_STATUSES = [
  // ── in-flight ──
  "pending",
  "processing",
  "queued_for_enrichment",
  "enriching",
  // ── the gate stopped it, each one a REASON a human can act on ──
  "duplicate_pre_enrich",
  "duplicate_post_enrich",
  "territory_mismatch",
  "insufficient_contact_data",
  "insufficient_identity",
  "insufficient_identity_for_promotion",
  "unassigned_no_market",
  // ── terminal ──
  "promoted",
  "error",
] as const

export type RawProcessingStatus = (typeof RAW_PROCESSING_STATUSES)[number]

/**
 * The gate-stop reasons — every status that is neither in-flight nor a terminal
 * success/error. DERIVED, not hand-copied: the cockpit's rejection breakdown is
 * now guaranteed to cover exactly the reasons the pipeline can actually produce.
 */
export const REJECTION_STATUSES = [
  "duplicate_pre_enrich",
  "duplicate_post_enrich",
  "territory_mismatch",
  "insufficient_contact_data",
  "insufficient_identity",
  "insufficient_identity_for_promotion",
  "unassigned_no_market",
] as const satisfies readonly RawProcessingStatus[]

export type RejectionStatus = (typeof REJECTION_STATUSES)[number]

/** Statuses that mean the record is still moving. */
export const IN_FLIGHT_STATUSES = [
  "pending", "processing", "queued_for_enrichment", "enriching",
] as const satisfies readonly RawProcessingStatus[]

export function isRawProcessingStatus(v: unknown): v is RawProcessingStatus {
  return typeof v === "string" && (RAW_PROCESSING_STATUSES as readonly string[]).includes(v)
}

export function isRejectionStatus(v: unknown): v is RejectionStatus {
  return typeof v === "string" && (REJECTION_STATUSES as readonly string[]).includes(v)
}
