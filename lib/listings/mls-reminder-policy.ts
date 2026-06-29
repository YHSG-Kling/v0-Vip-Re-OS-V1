// lib/listings/mls-reminder-policy.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE eligibility for the MLS-number entry reminder — split out of the server-only runner so it's
// unit-testable. A live listing (MLS_ACTIVE / active) with no MLS number and an agent to prompt is the
// only thing reminded. No I/O.

export interface MlsReminderInput {
  /** lifecycle_stage = MLS_ACTIVE, or status = active — the listing should be on the MLS. */
  isLiveListing: boolean
  /** A real MLS number is already on file. */
  hasMlsNumber: boolean
  /** There's a listing agent to notify. */
  hasAgent: boolean
}

/** PURE. A live listing with no MLS number and an agent to prompt → remind to enter it. */
export function needsMlsNumberReminder(input: MlsReminderInput): boolean {
  return input.isLiveListing && !input.hasMlsNumber && input.hasAgent
}
