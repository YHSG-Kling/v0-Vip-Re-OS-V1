// lib/intelligence/learning-outcomes.ts
//
// LEARNING OUTCOMES (pure) — the recorder that turns the session's live learners (variant winner,
// channel order, source health, win/loss autopsy, second-opinion consensus) from "aggregate on
// whatever's live right now" into "learn from accumulated HISTORY". It writes onto the EXISTING
// generic ai_feedback_log substrate (source_system + source_record_type + source_record_id + rating
// + context_snapshot) — NOT a new table — and is entity-aware: source_record_type is "contact" OR
// "lead", so outcomes are tracked for BOTH (a lead that converts to a thriving client and a lead
// that ghosts both teach the system). Pure mappings here; the live recorder/loader is the runner.

export type OutcomeKind = "win" | "loss" | "neutral"
export type LearningEntity = "contact" | "lead"

/** Map an outcome to the ai_feedback_log smallint rating (NOT NULL). Pure. */
export function outcomeToRating(outcome: OutcomeKind): number {
  switch (outcome) {
    case "win": return 1
    case "loss": return -1
    case "neutral": return 0
  }
}

/** Inverse — interpret a stored rating. Pure. */
export function ratingToOutcome(rating: number | null | undefined): OutcomeKind {
  if (typeof rating !== "number") return "neutral"
  if (rating > 0) return "win"
  if (rating < 0) return "loss"
  return "neutral"
}
