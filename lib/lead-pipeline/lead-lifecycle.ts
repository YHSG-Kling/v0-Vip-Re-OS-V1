// lib/lead-pipeline/lead-lifecycle.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE leads.lifecycle_state vocabulary, and the two predicates built on it.
//
// The live CHECK, read off the database:
//
//   CHECK (lifecycle_state = ANY (ARRAY[
//     'raw','unconsented','consented','isa_qualifying',
//     'assigned','appointment','representation','long_term_nurture']))
//   DEFAULT 'raw'   (nullable)
//
// It does NOT admit 'converted', 'qualified' or 'do_not_contact', and all three
// were in the code:
//
//   lib/ai-isa/conversation-handler.ts       WROTE lifecycle_state: 'do_not_contact'
//   lib/intelligence/lead-warmth-runner.ts   neq(lifecycle_state, 'converted')
//   lib/lead-pipeline/persona-drift-runner.ts        same
//   lib/lead-pipeline/reactivation-enroller.ts       same
//
// SUPPRESSION IS A FLAG, NOT A STATE. A lead who asks to be left alone has not
// moved along the funnel — they have been suppressed at whatever stage they were
// in. leads.dnc_status and leads.call_stop_flag carry that, and the reactivation
// enroller already honours dnc_status. The lifecycle write was not just invalid,
// it was the wrong shape.
//
// CONVERSION IS 'representation'. That is the terminal state in the vocabulary —
// the lead is now a represented client. `neq('lifecycle_state','converted')` also
// hid a second defect: in SQL, `col <> 'x'` is NULL for a NULL column, so the row
// is filtered OUT. The column is nullable, so a lead with no state was silently
// dropped from every one of those three sweeps. NOT_CONVERTED_FILTER spells the
// null case out.

/** Every value the CHECK admits, in funnel order. */
export const LEAD_LIFECYCLE_STATES = [
  "raw",
  "unconsented",
  "consented",
  "isa_qualifying",
  "assigned",
  "appointment",
  "representation",
  "long_term_nurture",
] as const

export type LeadLifecycleState = (typeof LEAD_LIFECYCLE_STATES)[number]

/** The column default — a lead that has only just landed. */
export const LEAD_LIFECYCLE_DEFAULT: LeadLifecycleState = "raw"

/** Converted: the lead became a represented client. The terminal state. */
export const LEAD_CONVERTED_STATE: LeadLifecycleState = "representation"

/**
 * PostgREST `.or()` argument for "not yet converted", including rows whose state
 * is NULL. `.neq()` alone excludes NULLs, because `NULL <> 'x'` is NULL, not true.
 */
export const NOT_CONVERTED_FILTER = `lifecycle_state.is.null,lifecycle_state.neq.${LEAD_CONVERTED_STATE}`

/**
 * States at which the AI ISA must stop auto-responding: the lead has consented
 * and moved into human hands. Everything before this is still ISA territory.
 */
export const LEAD_HANDED_OFF_STATES: readonly LeadLifecycleState[] = [
  "consented",
  "assigned",
  "appointment",
  "representation",
]

/** PURE — has this lead moved past the ISA? */
export function isLeadHandedOff(lifecycleState: string | null | undefined): boolean {
  if (!lifecycleState) return false
  return (LEAD_HANDED_OFF_STATES as readonly string[]).includes(lifecycleState)
}

/**
 * PURE — is outreach to this lead suppressed? Suppression lives on the boolean
 * flags, never on lifecycle_state, which has no value for it.
 */
export function isLeadSuppressed(lead: {
  dnc_status?: boolean | null
  call_stop_flag?: boolean | null
}): boolean {
  return lead.dnc_status === true || lead.call_stop_flag === true
}
