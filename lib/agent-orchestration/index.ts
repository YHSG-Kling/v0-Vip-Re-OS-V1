// ─── ACTION PLAN GENERATOR ────────────────────────────────────────────────────
//
// SUBJECT CORRECTED 2026-08-25: the plan is keyed on the CONTACT, never on a
// lead. See the header of ./action-plan-generator.ts for the four measured
// reasons (consent gate, assignment-IS-conversion, agents cannot SELECT `leads`
// under live RLS, and both evidence reads were querying a contacts FK with a
// lead id and could never match).
export type {
  ActionPlanItem,
  ActionPlan,
  ActionPlanResult,
  ActionPlanRefusal,
  ActionPlanRefusalCode,
  PersistedActionPlan,
  SourceLeadRow,
  ConsentBasisVerdict,
} from "./action-plan-generator"
export {
  FIRST_CONTACT_SLA_HOURS,
  generateAgentActionPlan,
  persistAgentActionPlan,
  resolveConsentBasis,
  hoursUntil,
} from "./action-plan-generator"

// ─── AGENT ACTIVITY MONITOR — RETIRED ─────────────────────────────────────────
//
// TOMBSTONE. `monitorAgentActivity` / `AgentActivityStatus` lived at
// lib/agent-orchestration/agent-activity-monitor.ts and were DELETED 2026-08-25.
// SURVIVOR: lib/lead-governance/sla-monitor.ts:74 `evaluateSLA` — the live one,
// called by app/actions/lead-governance/govern-lead.ts:239.
//
// It was a duplicate SLA evaluator with no caller anywhere in the tree. Per
// CLAUDE.md §1 everything the survivor was missing was MERGED ONTO THE SURVIVOR
// FIRST, and nothing was lost — the three capabilities went to the two places
// where each can actually run:
//
//   1. THE `approaching_sla` WARNING BAND  →  lib/lead-governance/sla-monitor.ts.
//      `SLAStatus` gained `posture: 'within_sla' | 'approaching_sla' |
//      'breached_sla'` and `hoursUntilDeadline`, with the monitor's own
//      12-hour constant as APPROACHING_SLA_WINDOW_HOURS. It applies to the
//      survivor's RULE 1 (unassigned >7d) and RULE 3 (isa_qualifying >14d),
//      both of which run on UNCONVERTED leads, so the band is live.
//
//   2. THE 48-HOUR FIRST-CONTACT SLA  →  ./action-plan-generator.ts
//      FIRST_CONTACT_SLA_HOURS. It did NOT go onto the lead, and that is a
//      finding rather than a shortcut: the retired monitor opened with
//      `if (!lead.agent_id) throw new Error("Lead not assigned to agent")`, and
//      in this system a lead WITH an agent is a CONVERTED lead —
//      lib/kernel/lead-acquisition-handlers.ts:362 handleLeadAssigned stamps
//      `agent_id` and creates the contact in one call. `evaluateSLA` stops the
//      lead clock on conversion (its conversion-finality guard), so a 48-hour
//      post-assignment rule placed on the lead could never fire once. Putting it
//      there would have been a dead rule reading as an enforced one — the
//      blind-guard failure CLAUDE.md §2 is about. On the contact it runs.
//
//   3. THE AGENT-vs-AI ACTIVITY SPLIT  →  ./action-plan-generator.ts, the
//      `agentTouches` / `isaActivities` split. Same reason: under live RLS an
//      `agent` role cannot SELECT `public.leads` at all
//      (leads_select requires is_lead_visible_role(), which admits
//      broker/broker_admin/broker_owner/admin/team_lead/ISA/platform only), so
//      "has the AGENT touched this LEAD" was a question about rows that could
//      not exist. On the contact both halves are real.
//
// Also retired with it: the monitor's own reads were `.eq("contact_id", leadId)`
// against `activities`, whose `contact_id` is a FOREIGN KEY to `contacts(id)`
// (live information_schema, 2026-08-25) — so its agent-activity and AI-activity
// queries matched nothing and every verdict it produced was computed from two
// empty arrays.
