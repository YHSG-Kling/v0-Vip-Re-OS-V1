/**
 * lib/agent-orchestration/action-plan-generator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE AGENT'S FIRST-TOUCH PLAN — KEYED ON THE **CONTACT**, NEVER ON A LEAD.
 *
 * OWNER RULING (2026-08-24), verbatim:
 *
 *   "leads are not assigned to any agents until the lead has been qualified or a
 *    positive response came back from an ai isa's email or direct mail since
 *    these leads have not yet consented. so the action plan generator is
 *    incorrect. once the leads have been qualified or a positive response then
 *    they go through a gate to convert the lead to a contact which has already
 *    been built and all history, etc. stops on the lead record and continues on
 *    the contact record."
 *
 * ── WHAT THIS FILE USED TO BE, AND WHY EVERY LINE OF IT WAS WRONG ────────────
 *
 * It took `(leadId, agentId, brokerageId)`, its header said "when leads are
 * ASSIGNED", it read `.from("leads")`, and it told the agent to act "Within 2
 * hours of assignment". Four independent, MEASURED reasons that subject cannot
 * stand:
 *
 *  1. CONSENT. A lead that has not passed the assignment gate has not consented.
 *     lib/lead-assignment/rule-matcher.ts:135 `evaluateAssignmentEligibility` is
 *     THE gate (lead_stage='qualified' OR a positive-intent lifecycle_state), and
 *     both enforcers — autoAssignLead (lib/lead-assignment/tier-routing.ts:489)
 *     and manualAssignLead (app/actions/lead-assignment/assign-lead.ts:229) —
 *     refuse without it. This generator had NO gate of any kind: hand it any lead
 *     id and it produced "call them within 2 hours" for someone who never
 *     answered anything.
 *
 *  2. ASSIGNMENT *IS* CONVERSION IN THIS SYSTEM. lib/kernel/lead-acquisition-
 *     handlers.ts:362 `handleLeadAssigned` — the one commit point every
 *     assignment path routes through — stamps `leads.agent_id`, CREATES the
 *     contact, carries the history (lib/contact-promotion/history-carry.ts) and
 *     deactivates the lead, in that order. So the instant a lead has an agent it
 *     also has a `contact_id`, and lib/contact-promotion/conversion-finality.ts
 *     says the CONTACT owns every action from then on. A lead-keyed agent plan
 *     therefore has no legal moment to exist: before assignment it is
 *     unconsented, after assignment it is converted.
 *
 *  3. AN AGENT CANNOT READ A LEAD. Live RLS on `public.leads`, read 2026-08-25:
 *       leads_select USING (is_platform_admin() OR (is_lead_visible_role()
 *                            AND has_brokerage_access(brokerage_id)))
 *     and `is_lead_visible_role()` admits broker / broker_admin / broker_owner /
 *     admin / team_lead / the ISA service role / platform admin — NOT `agent`.
 *     CLAUDE.md §5 ("agents see CONTACTS only") is enforced in the database. A
 *     plan whose subject the reader cannot open is not a plan.
 *
 *  4. THE EVIDENCE READS WERE STRUCTURALLY EMPTY. `activities.contact_id` and
 *     `messages.contact_id` are FOREIGN KEYS TO `contacts(id)` (live
 *     information_schema, 2026-08-25). The old code queried both with a LEAD id
 *     — `.eq("contact_id", leadId)` — so `aiActivities` and `messages` could
 *     never match a row. Every plan this function ever produced took the
 *     "hasAnyAiTouch === false" branch and reported "AI has not engaged this lead
 *     yet" regardless of what the ISA had actually done.
 *
 * ── WHAT IT IS NOW ──────────────────────────────────────────────────────────
 *
 * `generateAgentActionPlan(contactId, agentId, brokerageId)`:
 *   · reads the CONTACT, tenant-pinned, and refuses one that is not this agent's;
 *   · RE-RUNS THE CONSENT GATE against the originating lead when there is one —
 *     `evaluateAssignmentEligibility` on the very same lead row the assignment
 *     path gated. A contact manufactured out of a raw / unconsented /
 *     isa_qualifying lead is REFUSED, loudly, rather than quietly planned for;
 *   · reads the ISA history where the conversion actually put it —
 *     `ai_isa_activities` / `ai_isa_qualifications` on `contact_id`, the columns
 *     history-carry re-points (REPOINTED_HISTORY_TABLES);
 *   · splits AGENT touches from AI touches, which is the merged capability from
 *     the retired lib/agent-orchestration/agent-activity-monitor.ts;
 *   · carries the retired monitor's 48-HOUR FIRST-CONTACT SLA as the plan's own
 *     first deadline, on the subject where that clock can actually run.
 *
 * `persistAgentActionPlan` is THE MISSING WRITER (CLAUDE.md §1 case 2).
 * app/dashboard/agent/page.tsx:256 reads
 *   activities where activity_type='agent_action_plan' AND status='pending'
 * and renders the rows under "New Assignment Plans" (agent-next-best-actions.tsx
 * :136 → ActionPlanCard). NOTHING in the tree wrote that activity_type — live
 * count 0 rows, 2026-08-25 — so the section was permanently empty. The reader was
 * live and the writer did not exist; this is it.
 */

import type { StandardTimeline } from "@/constants/crm-standards"
import { evaluateAssignmentEligibility } from "@/lib/lead-assignment/rule-matcher"

/**
 * The `contacts.timeline` members that warrant a direct phone call rather than
 * seven more days of AI nurture. Typed against the one vocabulary so a renamed
 * or dropped member is a type error, not a silently unreachable branch.
 * `contacts_timeline_check` and `leads_timeline_check` carry the identical list
 * live (m487), so the same buckets survive the conversion.
 */
const URGENT_TIMELINES: readonly StandardTimeline[] = ["immediate", "1-3_months"]

/**
 * THE FIRST-CONTACT SLA, MERGED FROM THE RETIRED MONITOR.
 *
 * lib/agent-orchestration/agent-activity-monitor.ts owned a 48-hour
 * agent-first-contact clock and an `approaching_sla` warning band. Both are kept:
 * the WARNING BAND merged onto the live SLA survivor
 * (lib/lead-governance/sla-monitor.ts — see its APPROACHING_SLA_WINDOW_HOURS),
 * and the 48-hour clock merged HERE, because here is the only place it can run.
 * On the lead it could not: a lead with an agent is a converted lead, and
 * `evaluateSLA` stops the lead clock on conversion by design.
 */
export const FIRST_CONTACT_SLA_HOURS = 48

/** `ai_isa_activities.activity_type` members that are an OUTBOUND EMAIL touch.
 *  Values from the live CHECK `ai_isa_activities_activity_type_check`; the ISA's
 *  own logger normalises onto them (lib/ai-isa/isa-outreach-logger.ts:62). */
const ISA_EMAIL_ACTIVITY_TYPES = ["email"] as const

/** `activities.activity_type` values a HUMAN AGENT does not author. Used only to
 *  split agent work from system work — see `agentTouches` below. */
const NON_AGENT_ACTIVITY_TYPES = [
  "agent_action_plan",
  "agent_assignment",
  "lead_scoring",
  "routing_decision",
  "promotion_signal",
  "sla_escalation",
  "lead_promoted_to_contact",
] as const

export interface ActionPlanItem {
  action: string
  priority: "high" | "medium" | "low"
  reason: string
  suggestedTiming: string
}

export interface ActionPlan {
  /** contacts.id — the PRIMARY key, NOT contacts.contact_id (CLAUDE.md §3). */
  contactId: string
  /** agents.id — the class `contacts.agent_id` and `activities.agent_id` store. */
  agentId: string
  planGeneratedAt: string
  recommendedActions: ActionPlanItem[]
  aiContextSummary: string
  /** The lead this contact was converted from, when there was one. NULL for a
   *  contact captured directly (a consented web form / portal intake). */
  sourceLeadId: string | null
  /** WHICH arm of the consent gate opened for the source lead — 'qualified' or
   *  'positive_intent'; 'direct_capture' when there was no lead at all. */
  consentBasis: "qualified" | "positive_intent" | "direct_capture"
  /** Hours the agent has left against FIRST_CONTACT_SLA_HOURS, or null once the
   *  agent has already made contact. Negative means the SLA is breached. */
  hoursUntilFirstContactSla: number | null
}

/**
 * The refusal shape. Every path that declines returns one of these rather than
 * throwing a bare Error, so a caller can SAY why nothing was planned — the same
 * posture conversion-finality.ts takes. CLAUDE.md §4: fail closed, and be able to
 * report the closure.
 */
export type ActionPlanRefusalCode =
  | "no_tenant"
  | "contact_unreadable"
  | "contact_missing"
  | "not_this_agents_contact"
  | "consent_gate_closed"

export interface ActionPlanRefusal {
  ok: false
  code: ActionPlanRefusalCode
  reason: string
}

export type ActionPlanResult = { ok: true; plan: ActionPlan } | ActionPlanRefusal

/** The `leads` columns the consent gate needs. Anything wider is fine. */
export interface SourceLeadRow {
  id?: string | null
  lead_stage?: string | null
  lifecycle_state?: string | null
  handed_to_agent_at?: string | null
  converted_at?: string | null
}

export type ConsentBasisVerdict =
  | { ok: true; basis: ActionPlan["consentBasis"]; reason: string }
  | { ok: false; basis: null; reason: string }

/**
 * PURE — THE CONSENT GATE, extracted so it can be exercised and MUTATION-TESTED
 * without a database. This is the owner's ruling made checkable in one place:
 *
 *   "leads are not assigned to any agents until the lead has been qualified or a
 *    positive response came back … since these leads have not yet consented."
 *
 * It delegates to lib/lead-assignment/rule-matcher.ts `evaluateAssignmentEligibility`
 * — the SAME predicate autoAssignLead and manualAssignLead enforce — rather than
 * carrying a second copy of the rule, which is exactly how the retired
 * lib/lead-assignment/assignment-eligibility.ts came to admit `isa_qualifying`.
 *
 * A NULL source lead is NOT a refusal: it is a DIRECT CAPTURE (consented web
 * form, portal intake, agent-entered client). There is no lead to gate, and the
 * contact is itself the consented entity.
 */
export function resolveConsentBasis(sourceLead: SourceLeadRow | null | undefined): ConsentBasisVerdict {
  if (!sourceLead) {
    return {
      ok: true,
      basis: "direct_capture",
      reason: "No originating lead — this contact was captured directly and is itself the consented entity.",
    }
  }
  const gate = evaluateAssignmentEligibility(sourceLead.lead_stage, sourceLead.lifecycle_state)
  if (!gate.ok) {
    return {
      ok: false,
      basis: null,
      reason:
        `Lead ${sourceLead.id ?? "unknown"} never passed the assignment gate. ${gate.reason} ` +
        `A lead that has not been qualified and has given no positive signal has not consented, ` +
        `so no agent action plan is produced for it.`,
    }
  }
  return {
    ok: true,
    basis: gate.via === "qualified" ? "qualified" : "positive_intent",
    reason: gate.reason,
  }
}

/**
 * Generates the AI-recommended first-touch plan for the agent who now owns a
 * CONTACT. It does NOT execute anything, and the AI ISA is unaffected by it.
 *
 * FAILS CLOSED at every gate (CLAUDE.md §4). supabase-js RESOLVES refusals
 * (§3), so every read destructures `{ data, error }` and reads the error: a
 * refused tenant predicate must never render as "this contact has no history".
 */
export async function generateAgentActionPlan(
  contactId: string,
  agentId: string,
  brokerageId: string,
  supabaseClient?: any,
): Promise<ActionPlanResult> {
  // FAIL CLOSED (§4): with no tenant this refuses rather than running an
  // un-scoped read on the service client, which bypasses RLS.
  if (!brokerageId) {
    return {
      ok: false,
      code: "no_tenant",
      reason: "generateAgentActionPlan requires a brokerageId — refusing an un-scoped service-client read",
    }
  }
  if (!contactId || !agentId) {
    return {
      ok: false,
      code: "contact_missing",
      reason: "generateAgentActionPlan requires both a contactId and an agentId",
    }
  }

  const supabase = supabaseClient ?? (await import("@/lib/supabase/service")).createServiceClient()

  // ── THE SUBJECT ────────────────────────────────────────────────────────────
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select(
      "id, agent_id, brokerage_id, first_name, last_name, lead_score, motivation_type, " +
        "motivation_confidence, timeline, budget_min, budget_max, property_type, " +
        "created_at, last_contacted_at",
    )
    .eq("id", contactId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (contactError) {
    return {
      ok: false,
      code: "contact_unreadable",
      reason: `Contact ${contactId} lookup was refused (${contactError.message}) — failing closed.`,
    }
  }
  if (!contact) {
    return {
      ok: false,
      code: "contact_missing",
      reason: `Contact ${contactId} not found in brokerage ${brokerageId}.`,
    }
  }

  // AGENTS SEE THEIR OWN BOOK. `contacts.agent_id` stores agents.id (migration
  // 111 / RLS helpers), which is the same class this function is handed. A plan
  // for a contact somebody else owns is a cross-agent leak inside one tenant.
  if (contact.agent_id !== agentId) {
    return {
      ok: false,
      code: "not_this_agents_contact",
      reason:
        `Contact ${contactId} is owned by agent ${contact.agent_id ?? "nobody"}, not ${agentId} — ` +
        `refusing to build another agent's action plan.`,
    }
  }

  // ── THE CONSENT GATE, RE-RUN ON THE ORIGINATING LEAD ───────────────────────
  //
  // This is the ruling made checkable. The assignment path already gated this
  // person (tier-routing.ts:489 / assign-lead.ts:229) — re-running the SAME pure
  // predicate here means a contact that reached an agent WITHOUT passing it
  // cannot be planned for. `handleLeadAssigned` stamps lifecycle_state='assigned'
  // before it creates the contact, so a properly-converted lead always passes;
  // anything that does not pass got here some other way, and that is exactly the
  // case the owner called out.
  //
  // A contact with NO source lead is a DIRECT CAPTURE (a consented web form,
  // portal intake, agent-entered client). There is no lead to gate — the contact
  // is itself the consented entity — so the gate is satisfied by construction and
  // says so rather than pretending a lead existed.
  const { data: sourceLead, error: sourceLeadError } = await supabase
    .from("leads")
    .select("id, lead_stage, lifecycle_state, handed_to_agent_at, converted_at")
    .eq("contact_id", contactId)
    .eq("brokerage_id", brokerageId)
    .order("converted_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (sourceLeadError) {
    // FAIL CLOSED. "Could not check consent" must never render as "consented".
    return {
      ok: false,
      code: "consent_gate_closed",
      reason:
        `Consent check for contact ${contactId} was refused (${sourceLeadError.message}) — ` +
        `refusing to build an agent action plan on an unverified consent basis.`,
    }
  }

  const consent = resolveConsentBasis(sourceLead as SourceLeadRow | null)
  if (!consent.ok) {
    return {
      ok: false,
      code: "consent_gate_closed",
      reason: `Contact ${contactId}: ${consent.reason}`,
    }
  }
  const consentBasis: ActionPlan["consentBasis"] = consent.basis

  // ── THE EVIDENCE ───────────────────────────────────────────────────────────
  // All three reads are CONTACT-keyed, which is where the conversion put the
  // history: history-carry re-points ai_isa_activities / ai_isa_qualifications
  // onto contact_id, and activities.contact_id / messages.contact_id are FKs to
  // contacts(id).
  const [isaRes, qualRes, activityRes, messageRes] = await Promise.all([
    supabase
      .from("ai_isa_activities")
      .select("activity_type, channel, outcome, created_at")
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(25),
    supabase
      .from("ai_isa_qualifications")
      .select("qualification_score, qualification_result, qualified_at")
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .order("qualified_at", { ascending: false })
      .limit(1),
    supabase
      .from("activities")
      .select("activity_type, agent_id, created_at")
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId)
      .order("created_at", { ascending: false })
      .limit(50),
    supabase
      .from("messages")
      .select("id, direction")
      .eq("contact_id", contactId)
      .eq("brokerage_id", brokerageId),
  ])

  // Every refusal is NAMED. A swallowed error here degrades the plan silently —
  // the exact failure the old lead-keyed reads produced for their whole life.
  const evidenceWarnings: string[] = []
  for (const [label, res] of [
    ["ai_isa_activities", isaRes],
    ["ai_isa_qualifications", qualRes],
    ["activities", activityRes],
    ["messages", messageRes],
  ] as const) {
    if (res?.error) evidenceWarnings.push(`${label}: ${res.error.message}`)
  }
  if (evidenceWarnings.length > 0) {
    console.error(
      `[action-plan] contact ${contactId}: evidence read(s) refused — the plan below is built on less ` +
        `than the full history: ${evidenceWarnings.join("; ")}`,
    )
  }

  const isaActivities: any[] = isaRes?.data ?? []
  const qualification = qualRes?.data ?? null
  const allActivities: any[] = activityRes?.data ?? []
  const messages: any[] = messageRes?.data ?? []

  // ── THE AGENT-vs-AI SPLIT (merged from the retired agent-activity-monitor) ──
  // An `activities` row authored by a human agent: it names THIS agent and is not
  // one of the system-authored types the OS writes on the agent's behalf.
  const agentTouches = allActivities.filter(
    (a) =>
      a.agent_id === agentId &&
      !(NON_AGENT_ACTIVITY_TYPES as readonly string[]).includes(a.activity_type),
  )
  const hasAgentContacted = agentTouches.length > 0 || !!contact.last_contacted_at

  const inboundCount = messages.filter((m) => m.direction === "inbound").length
  const hasReplied = inboundCount > 0

  // ── THE 48-HOUR FIRST-CONTACT CLOCK (merged from the retired monitor) ───────
  // Anchored on `leads.handed_to_agent_at` — the column handleLeadAssigned stamps
  // at the moment of handoff — and falling back to the contact's creation for a
  // direct capture, which is when that person became this agent's to call.
  const handoffAt = sourceLead?.handed_to_agent_at ?? sourceLead?.converted_at ?? contact.created_at
  const hoursUntilFirstContactSla = hasAgentContacted
    ? null
    : hoursUntil(handoffAt, FIRST_CONTACT_SLA_HOURS)

  const aiContextSummary = buildContextSummary(contact, isaActivities, qualification, hasReplied)
  const recommendedActions = determineRecommendedActions({
    contact,
    hasReplied,
    hasAgentContacted,
    isaActivities,
    qualification,
    hoursUntilFirstContactSla,
  })

  return {
    ok: true,
    plan: {
      contactId,
      agentId,
      planGeneratedAt: new Date().toISOString(),
      recommendedActions,
      aiContextSummary,
      sourceLeadId: sourceLead?.id ?? null,
      consentBasis,
      hoursUntilFirstContactSla,
    },
  }
}

/** PURE — hours remaining until `anchor + windowHours`. Negative once past. */
export function hoursUntil(anchor: string | null | undefined, windowHours: number, now = new Date()): number | null {
  if (!anchor) return null
  const start = new Date(anchor)
  if (Number.isNaN(start.getTime())) return null
  const deadline = start.getTime() + windowHours * 60 * 60 * 1000
  return Math.round(((deadline - now.getTime()) / (1000 * 60 * 60)) * 10) / 10
}

function buildContextSummary(
  contact: any,
  isaActivities: any[],
  qualification: any,
  hasReplied: boolean,
): string {
  const parts: string[] = []

  if (contact.lead_score) parts.push(`Score: ${contact.lead_score}/100`)

  if (contact.motivation_type) {
    parts.push(
      `Motivation: ${contact.motivation_type}` +
        (contact.motivation_confidence
          ? ` (${Math.round(Number(contact.motivation_confidence) * 100)}% confidence)`
          : ""),
    )
  }

  if (contact.timeline) parts.push(`Timeline: ${contact.timeline}`)

  if (qualification?.qualification_result) {
    parts.push(
      `AI ISA qualification: ${qualification.qualification_result}` +
        (qualification.qualification_score != null ? ` (${qualification.qualification_score})` : ""),
    )
  }

  const emailsSent = isaActivities.filter((a) =>
    (ISA_EMAIL_ACTIVITY_TYPES as readonly string[]).includes(a.activity_type),
  ).length
  if (emailsSent > 0) parts.push(`AI sent ${emailsSent} email${emailsSent > 1 ? "s" : ""}`)

  if (isaActivities.some((a) => a.activity_type === "appointment_set")) {
    parts.push("AI already set an appointment")
  }

  if (hasReplied) parts.push("They have replied")

  return parts.join(" | ")
}

/**
 * `isaActivities` IS THE PLAN'S EVIDENCE. Under the old lead-keyed reads it was
 * ALWAYS an empty array — `.eq("contact_id", leadId)` against a FK to contacts —
 * so the "no AI touch" branch was the only branch that ever ran. Contact-keyed,
 * it finally carries what the ISA actually did.
 */
function determineRecommendedActions(input: {
  contact: any
  hasReplied: boolean
  hasAgentContacted: boolean
  isaActivities: any[]
  qualification: any
  hoursUntilFirstContactSla: number | null
}): ActionPlanItem[] {
  const { contact, hasReplied, hasAgentContacted, isaActivities, qualification, hoursUntilFirstContactSla } = input
  const actions: ActionPlanItem[] = []

  const aiEmailCount = isaActivities.filter((a) =>
    (ISA_EMAIL_ACTIVITY_TYPES as readonly string[]).includes(a.activity_type),
  ).length
  const hasQualification = !!qualification
  const hasAnyAiTouch = isaActivities.length > 0

  // THE FIRST-CONTACT TIMING, in the retired monitor's own words. `breached` is
  // stated rather than softened: an SLA that only ever says "soon" is not one.
  const firstTouchTiming =
    hoursUntilFirstContactSla === null
      ? "Within 2 hours"
      : hoursUntilFirstContactSla < 0
        ? `OVERDUE by ${Math.abs(hoursUntilFirstContactSla)}h — the ${FIRST_CONTACT_SLA_HOURS}h first-contact SLA is breached`
        : `Within ${Math.min(2, Math.max(1, Math.floor(hoursUntilFirstContactSla)))}h (${hoursUntilFirstContactSla}h left on the ${FIRST_CONTACT_SLA_HOURS}h first-contact SLA)`

  // Action 1: read what the AI produced — but only when it produced something.
  // An empty history means there is nothing to review, and sending the agent to
  // an empty summary is how a plan loses its credibility.
  if (hasAnyAiTouch || hasQualification) {
    actions.push({
      action: hasQualification
        ? "Review AI qualification summary and conversation history"
        : "Review AI conversation history",
      priority: "high",
      reason: hasQualification
        ? `The AI ISA qualified this person across ${isaActivities.length} logged touch${isaActivities.length === 1 ? "" : "es"} — read it before making contact`
        : `The AI ISA has ${isaActivities.length} logged touch${isaActivities.length === 1 ? "" : "es"} but no qualification record — read what it has before making contact`,
      suggestedTiming: firstTouchTiming,
    })
  } else {
    actions.push({
      action: "Make first contact yourself — the AI ISA has no logged touches for this contact",
      priority: "high",
      reason:
        "No AI ISA activity is carried on this contact, so there is no summary to review. " +
        "They reached you through the consent gate, so they are expecting a person.",
      suggestedTiming: firstTouchTiming,
    })
  }

  // Action 2: the reply, the channel change, or the introduction.
  if (hasReplied) {
    actions.push({
      action: "Respond personally to their reply",
      priority: "high",
      reason: "They are engaged and expecting human follow-up",
      suggestedTiming: "Within 4 hours",
    })
  } else if (aiEmailCount >= 3) {
    // Three unanswered AI emails is not an argument for a fourth. Change channel.
    actions.push({
      action: "Change channel — call or text instead of another email",
      priority: "high",
      reason: `The AI has already sent ${aiEmailCount} emails with no reply; another email is the least likely thing to work`,
      suggestedTiming: "Within 24 hours",
    })
  } else {
    actions.push({
      action: "Send personal introduction email",
      priority: "medium",
      reason:
        aiEmailCount > 0
          ? `Introduce yourself — the AI has sent ${aiEmailCount} email${aiEmailCount > 1 ? "s" : ""} with no reply, so a human name in the inbox is the change`
          : "Introduce yourself while the AI continues automated follow-ups",
      suggestedTiming: "Within 24 hours",
    })
  }

  // Action 3: urgency, on the ONE timeline vocabulary
  // (constants/crm-standards.ts STANDARD_TIMELINES). "1-3 months" was the SPACED
  // spelling and matched nothing, so someone one-to-three months out was routed
  // down the "monitor for 7 days" branch — the opposite of what this rule says.
  if (URGENT_TIMELINES.includes(contact.timeline as StandardTimeline)) {
    actions.push({
      action: "Attempt phone call to schedule consultation",
      priority: "high",
      reason: `Timeline is ${contact.timeline} — warrants direct contact`,
      suggestedTiming: `Within ${FIRST_CONTACT_SLA_HOURS} hours`,
    })
  } else {
    actions.push({
      action: "Monitor AI engagement for 7 days before calling",
      priority: "low",
      reason: "Let the AI build rapport first, then follow up personally",
      suggestedTiming: "After 7 days of AI engagement",
    })
  }

  // Action 4: property interest. `contacts` carries `property_type` +
  // `budget_min`/`budget_max`; the lead-side `property_interest` column the old
  // version read does not exist on `contacts` (live information_schema).
  if (contact.property_type || contact.budget_min || contact.budget_max) {
    actions.push({
      action: "Prepare relevant property listings",
      priority: "medium",
      reason: "Show you understand their needs from day one",
      suggestedTiming: "Before first call",
    })
  }

  // Action 5: the SLA, said out loud, when the agent has not made contact and the
  // clock is already spent. The retired monitor escalated this to the broker; the
  // survivor for BROKER-side escalation is lib/lead-governance/sla-monitor.ts.
  // Here it is the agent's own warning, on their own card.
  if (!hasAgentContacted && hoursUntilFirstContactSla !== null && hoursUntilFirstContactSla < 0) {
    actions.push({
      action: "Make contact now — first-contact SLA is breached",
      priority: "high",
      reason: `No agent activity is logged and the ${FIRST_CONTACT_SLA_HOURS}-hour first-contact window closed ${Math.abs(hoursUntilFirstContactSla)}h ago`,
      suggestedTiming: "Immediately",
    })
  }

  return actions
}

export interface PersistedActionPlan {
  /** Rows written to `activities`. */
  written: number
  /** Named refusals — never thrown. The plan itself is already computed. */
  warnings: string[]
}

/**
 * THE WRITER HALF (CLAUDE.md §1 case 2).
 *
 * app/dashboard/agent/page.tsx:252-259 selects
 *   activities(id, title, description, priority, contact_id)
 *   where agent_id = <agents.id> and activity_type='agent_action_plan'
 *     and status='pending'
 * and renders each row through ActionPlanCard, which deep-links
 * `/crm/contacts/${plan.contact_id}`. That reader shipped with NO writer anywhere
 * in the tree (live `agent_action_plan` row count: 0). These inserts are it.
 *
 * IDEMPOTENT BY DESIGN: a re-plan first closes the contact's outstanding pending
 * plan rows, so an agent who is re-planned does not accumulate two copies of the
 * same advice. The old rows are marked `superseded`, never deleted — the record
 * of what the OS told the agent last week is evidence, not clutter.
 *
 * TENANT: `brokerage_id` is stated explicitly. The BEFORE INSERT trigger
 * `activities_set_brokerage` would resolve it from `contact_id`, but the column
 * is NOT NULL and a trigger that misses every branch leaves the insert refused
 * with 23502 — the failure mode lib/lead-governance/sla-monitor.ts:105 documents.
 */
export async function persistAgentActionPlan(
  supabase: any,
  plan: ActionPlan,
  brokerageId: string,
): Promise<PersistedActionPlan> {
  const warnings: string[] = []

  if (!brokerageId) {
    return { written: 0, warnings: ["persistAgentActionPlan requires a brokerageId — activities.brokerage_id is NOT NULL"] }
  }

  // Supersede the previous plan for this contact+agent. `.select()` the update so
  // the count is READ: a PostgREST update that matched nothing resolves exactly
  // like one that worked (CLAUDE.md §3).
  const { error: supersedeError } = await supabase
    .from("activities")
    .update({ status: "superseded" })
    .eq("contact_id", plan.contactId)
    .eq("agent_id", plan.agentId)
    .eq("brokerage_id", brokerageId)
    .eq("activity_type", "agent_action_plan")
    .eq("status", "pending")
    .select("id")

  if (supersedeError) {
    warnings.push(`previous action plan NOT superseded: ${supersedeError.message}`)
  }

  const now = new Date().toISOString()
  const rows = plan.recommendedActions.map((item) => ({
    brokerage_id: brokerageId,
    entity_type: "contact",
    entity_id: plan.contactId,
    contact_id: plan.contactId,
    agent_id: plan.agentId,
    activity_type: "agent_action_plan",
    title: item.action,
    description: `${item.reason} — ${item.suggestedTiming}`,
    status: "pending",
    priority: item.priority,
    notes: JSON.stringify({
      suggestedTiming: item.suggestedTiming,
      aiContextSummary: plan.aiContextSummary,
      consentBasis: plan.consentBasis,
      sourceLeadId: plan.sourceLeadId,
      hoursUntilFirstContactSla: plan.hoursUntilFirstContactSla,
      planGeneratedAt: plan.planGeneratedAt,
    }),
    created_at: now,
  }))

  if (rows.length === 0) return { written: 0, warnings }

  // supabase-js RESOLVES refusals — the error is READ, and the count comes from
  // the returned rows rather than from the absence of an error.
  const { data, error } = await supabase.from("activities").insert(rows).select("id")

  if (error) {
    warnings.push(
      `agent action plan NOT written for contact ${plan.contactId}: ${error.message}. ` +
        `The agent dashboard's "New Assignment Plans" section will stay empty for this contact.`,
    )
    return { written: 0, warnings }
  }

  return { written: (data ?? []).length, warnings }
}
