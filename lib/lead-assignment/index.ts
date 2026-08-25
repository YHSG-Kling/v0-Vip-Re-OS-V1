// ─── ASSIGNMENT ELIGIBILITY — RETIRED ─────────────────────────────────────────
//
// TOMBSTONE. `evaluateAssignmentEligibility` / `EligibilityResult` lived at
// lib/lead-assignment/assignment-eligibility.ts and were DELETED 2026-08-25.
// SURVIVOR: lib/lead-assignment/rule-matcher.ts:135 `evaluateAssignmentEligibility`
// — the PURE gate both enforcers already call
// (lib/lead-assignment/tier-routing.ts:489 autoAssignLead and
// app/actions/lead-assignment/assign-lead.ts:229 manualAssignLead).
//
// Two functions with the SAME NAME expressing the SAME rule is the §6 defect, and
// the retired one was the LOOSER of the pair, in direct conflict with the owner
// ruling that a lead reaches an agent only "once the lead has been qualified or a
// positive response came back". Its gate was:
//
//     const isQualified =
//       (lead.lead_stage && lead.lead_stage !== "new") ||
//       (lead.lead_score && lead.lead_score > 0)
//
// which admits `lifecycle_state='isa_qualifying'` — the state the survivor
// documents as "precisely the state that must not reach an agent", because the
// ISA is still ASKING and the attempt is not the answer. Any lead the scorer had
// ever touched (`lead_score > 0`) also passed. It had ZERO importers outside this
// barrel and this barrel had zero importers, so nothing regressed — but a second,
// looser door standing next to the real one is a defect waiting for its first
// caller.
//
// Where its other parts went — none of them are lost:
//   · tenant predicate + "already has an agent" idempotency → autoAssignLead
//     (tier-routing.ts, `alreadyAssigned`) and manualAssignLead, which both
//     already do it before calling the survivor gate.
//   · `qualifiedAt` from the ISA qualification record → `ai_isa_qualifications`
//     (`qualified_at`, a real column, carried onto the contact by
//     lib/contact-promotion/history-carry.ts REPOINTED_HISTORY_TABLES). The
//     retired version read it from `activities` with `.eq("contact_id", leadId)`
//     — `activities.contact_id` is a FOREIGN KEY to `contacts(id)` (live
//     information_schema, 2026-08-25), so passing a LEAD id could never match and
//     that field was always the `new Date()` fallback.

// ─── STALE LEAD DETECTION ─────────────────────────────────────────────────────
export { detectStaleLeads } from './stale-lead-detector'
export type { StaleLead } from './stale-lead-detector'
