// lib/lead-assignment/tier-routing.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE TIER-AWARE ASSIGNMENT RESOLVER. A LEAD BELONGS TO THE BROKERAGE UNTIL
// THIS FILE DECIDES WHOSE IT IS.
//
// OWNER RULING, verbatim:
//
//   "agents can't claim leads when they can only see contacts. brokerage admins
//    can auto assign to team leads and/or agents manually but agent assignment
//    should be auto assigned when positive feedback is received from the
//    brokerages agent assignment settings. if solo agent, all leads get
//    autoassigned to them. if team lead subscription, team lead has agent
//    assignment settings. in team or solo agent subscription, they can have an
//    admin that sees everything since a brokerage id needs to be created for
//    their subscription."
//
// Four tiers, one function, and the tier decides WHOSE SETTINGS apply:
//
//   solo_agent      the tenant's single agent. No settings are consulted at all —
//                   there is nobody else to route to, and a 'manual' default
//                   would hold the founder's own leads for the founder to place.
//   team            the TEAM LEAD's settings, applied WITHIN the team. Resolved
//                   through teams.team_lead_id (users.id → agents.user_id — the
//                   two id spaces are DISJOINT and this is the only crossing).
//   brokerage       the brokerage admin's settings, across the whole roster.
//   multi_location  ditto. (Office scoping rides assignment_rules.team_id, which
//                   already outranks brokerage-wide rules at equal priority.)
//
// ── WHERE "THE BROKERAGE'S AGENT ASSIGNMENT SETTINGS" LIVE ───────────────────
//
// MEASURED on the live database before writing this: `brokerage_settings` has
// ZERO rows for either brokerage, and its `settings` jsonb carries nothing about
// assignment. The settings that exist and have writers are two COLUMNS with
// VALIDATED CHECKs:
//
//   brokerages.default_assignment_method   (m305) — the policy for every lead no
//                                          rule covers, i.e. most of them
//   assignment_rules (per brokerage, optionally per team) — the exceptions
//
// So no new column and no new jsonb key is introduced here. A tier does not get
// its own settings store; it gets its own POOL and its own decision about who
// may edit the one store. On a team-tier tenant the team lead IS a tenant admin
// (team_lead is in TENANT_ADMIN_USER_TYPES, lib/auth/resolve-user-role.ts), so
// "the team lead has agent assignment settings" is already true of the surfaces —
// what was missing is that the ROUTER ignored the team entirely.
//
// ── WHAT A TIER IS READ FROM, AND WHAT HAPPENS WITH NO SUBSCRIPTION ROW ──────
//
// resolvePlanTier (lib/billing/plan-tier.ts) — `brokerages.plan_tier`, the column
// with writers, CHECK-constrained to exactly the four tier names, defaulting to
// 'solo_agent'. `subscriptions` holds ZERO rows on this database, so a resolver
// that read the subscription would decide nothing for every live tenant. The
// subscription is consulted only to fill a NULL plan_tier, and the floor is
// 'solo_agent' — the TIGHTEST tier, so a mis-tagged tenant is never handed a
// wider pool than it pays for.
//
// ── ONE VOCABULARY IN THE LEDGER ────────────────────────────────────────────
//
// m489 aligned assignment_log.assignment_method to the same five methods
// assignment_rules.rule_type and brokerages.default_assignment_method carry, plus
// two log-only owners (solo_agent, team_lead). It deliberately does NOT admit the
// router's DECORATED strings ('default_load_balance', 'geo_based_no_match',
// 'team_round_robin', '…_coverage'). Before m489 the ledger refused those AND
// 'solo_agent', 'geo_based', 'specialization' outright — and the insert in
// lib/kernel/lead-acquisition-handlers.ts:413 is not destructured, so supabase-js
// resolved the refusal and every such assignment wrote NO ledger row, silently.
// normalizeAssignmentMethod below is the one place the split happens: method into
// `assignment_method`, attribution into `routing_reason`.

import type { createServiceClient } from "@/lib/supabase/service"
import { resolvePlanTier, FALLBACK_TIER, type PlanTier } from "@/lib/billing/plan-tier"
import { resolveSoloAgentOwner } from "./solo-agent"
import { assignByDefaultMethod } from "./default-assignment"
import type { LeadRoutingHints } from "./rule-matcher"
import { handleLeadAssigned } from "@/lib/kernel/lead-acquisition-handlers"

type Svc = ReturnType<typeof createServiceClient>

// ─── LEDGER VOCABULARY ───────────────────────────────────────────────────────

/** EXACTLY the values assignment_log_assignment_method_check admits after m489.
 *  Verified against the live constraint; a value added here without a migration
 *  produces a refused insert that supabase-js resolves, i.e. a silent data loss. */
export const ASSIGNMENT_LOG_METHODS = [
  "round_robin",
  "load_balance",
  "geo_based",
  "specialization",
  "manual",
  "rule_match",
  "ai_recommendation",
  "solo_agent",
  "team_lead",
] as const
export type AssignmentLogMethod = (typeof ASSIGNMENT_LOG_METHODS)[number]

export function isAssignmentLogMethod(v: string | null | undefined): v is AssignmentLogMethod {
  return !!v && (ASSIGNMENT_LOG_METHODS as readonly string[]).includes(v)
}

/**
 * PURE — split the router's decorated method string into the LEDGER METHOD and
 * the human attribution that goes with it.
 *
 * The decorations, all of which exist in the tree today:
 *   `default_<m>`   the brokerage-wide policy ran, not a rule (default-assignment.ts:97)
 *   `team_<m>`      a team-scoped rule ran (assignment-engine.ts:138)
 *   `<m>_no_match`  the expertise/geo narrow found nobody; the whole pool was used
 *   `<m>_coverage`  coverage mode redirected the pick to a covering agent
 *
 * `team_lead` is a METHOD, not a decorated `lead` — it is checked before the
 * `team_` prefix is stripped, or the team cascade's last rung would be recorded
 * as a method called "lead" that no constraint admits.
 */
export function normalizeAssignmentMethod(decorated: string): {
  method: AssignmentLogMethod
  detail: string[]
} {
  const detail: string[] = []
  let s = String(decorated ?? "").trim()

  if (s === "team_lead") return { method: "team_lead", detail: [] }

  if (s.startsWith("default_")) {
    s = s.slice("default_".length)
    detail.push("chosen by the brokerage-wide default policy, not by a rule")
  } else if (s.startsWith("team_")) {
    s = s.slice("team_".length)
    detail.push("chosen by a team-scoped rule")
  }

  // Coverage is appended LAST by the engine, so it is stripped FIRST.
  if (s.endsWith("_coverage")) {
    s = s.slice(0, -"_coverage".length)
    detail.push("redirected to a covering agent (coverage mode)")
  }
  if (s.endsWith("_no_match")) {
    s = s.slice(0, -"_no_match".length)
    detail.push("no candidate matched the narrow; the whole pool was used")
  }

  if (isAssignmentLogMethod(s)) return { method: s, detail }

  // An unrecognised method is recorded as a rule match with the raw string kept —
  // losing it in the ledger is exactly the failure m489 exists to end.
  detail.push(`unrecognised router method: ${decorated}`)
  return { method: "rule_match", detail }
}

// ─── THE DECISION ────────────────────────────────────────────────────────────

export interface TierRoutingDecision {
  tier: PlanTier
  /** agents.id — NEVER users.id. leads.agent_id and assignment_log.agent_id both FK agents(id). */
  agentId: string | null
  /** CHECK-legal assignment_log.assignment_method. */
  method: AssignmentLogMethod
  /** assignment_log.routing_reason — the attribution the method column cannot carry. */
  routingReason: string
  ruleId: string | null
  /** A policy deliberately assigned nobody. NOT a routing failure. */
  held: boolean
  error?: string
}

/** The one non-deleted team a team-tier tenant routes through. */
async function resolveTenantTeam(
  supabase: Svc,
  brokerageId: string,
): Promise<{ id: string; teamLeadUserId: string | null; multiple: boolean } | null> {
  const { data, error } = await supabase
    .from("teams")
    .select("id, team_lead_id, created_at")
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .order("created_at", { ascending: true })

  // supabase-js RESOLVES a refused query — a swallowed error here would be
  // indistinguishable from "this tenant has no team", and those must not be
  // the same answer.
  if (error) return null
  const rows = (data ?? []) as Array<{ id: string; team_lead_id: string | null }>
  if (rows.length === 0) return null
  return { id: rows[0].id, teamLeadUserId: rows[0].team_lead_id, multiple: rows.length > 1 }
}

/** teams.team_lead_id is users.id. agents.id and users.id are DISJOINT spaces —
 *  this is the crossing, through agents.user_id, pinned to the tenant. */
async function resolveTeamLeadAgentId(
  supabase: Svc,
  brokerageId: string,
  teamLeadUserId: string | null,
): Promise<string | null> {
  if (!teamLeadUserId) return null
  const { data, error } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", teamLeadUserId)
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .maybeSingle()
  if (error) return null
  return (data as { id?: string } | null)?.id ?? null
}

async function activeTeamMembers(supabase: Svc, brokerageId: string, teamId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("agents")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("team_id", teamId)
    .eq("is_active", true)
  if (error) return []
  return ((data ?? []) as Array<{ id: string }>).map((a) => a.id)
}

/**
 * THE resolver. Decides WHO gets the lead, from the tenant's TIER and the
 * settings that tier makes authoritative. Pure decision — no writes, no
 * lifecycle, no contact. autoAssignLead below is what commits it.
 *
 * Exported so the assignment-rules settings page and the simulator can ask
 * "who would this go to" without assigning anybody.
 */
export async function resolveTierRouting(
  supabase: Svc,
  brokerageId: string,
  lead: LeadRoutingHints & { id: string },
): Promise<TierRoutingDecision> {
  const tier = await resolvePlanTier(supabase, brokerageId)

  const none = (method: AssignmentLogMethod, routingReason: string): TierRoutingDecision => ({
    tier, agentId: null, method, routingReason, ruleId: null, held: false,
  })

  // ── TIER 1: SOLO AGENT ─────────────────────────────────────────────────────
  // "if solo agent, all leads get autoassigned to them." No settings consulted:
  // there is nobody else, and brokerages.default_assignment_method='manual'
  // would otherwise hold the founder's own leads for the founder to place.
  if (tier === "solo_agent") {
    const owner = await resolveSoloAgentOwner(supabase, brokerageId)
    if (owner) {
      return {
        tier, agentId: owner, method: "solo_agent", ruleId: null, held: false,
        routingReason: "solo_agent tier — the tenant's single agent owns every lead; assignment settings are not consulted",
      }
    }
    return none("solo_agent", "solo_agent tier but the brokerage has no active agents row yet (provisioning gap)")
  }

  // The rule pass is shared with Engine 2 and the governance rail so the broker's
  // configured method applies wherever a lead is routed. Imported lazily: this
  // module is what assignment-engine.ts delegates TO, so a static import would
  // close a module cycle at evaluation time.
  const { resolveAgentByRules } = await import("./assignment-engine")

  // ── TIER 2: TEAM ───────────────────────────────────────────────────────────
  // "if team lead subscription, team lead has agent assignment settings."
  // The team lead's settings are the tenant's settings (they are a tenant admin);
  // what the tier changes is the POOL — the team's own board, never the whole
  // agents table. A team-tier tenant that somehow has extra agents rows outside
  // the team must not receive its leads.
  if (tier === "team") {
    const team = await resolveTenantTeam(supabase, brokerageId)
    if (team) {
      const pool = await activeTeamMembers(supabase, brokerageId, team.id)
      const scopeNote = team.multiple
        ? ` (tenant carries more than one team; the oldest, ${team.id}, is the routing team)`
        : ""

      // Rules first — a team lead's explicit rule outranks their default policy.
      const ruled = await resolveAgentByRules(supabase, brokerageId, lead as never)
      if (ruled.error) {
        return { ...none("load_balance", `team tier — rule pass failed: ${ruled.error}`), error: ruled.error }
      }
      if (ruled.held) {
        return {
          tier, agentId: null, method: "manual", ruleId: ruled.ruleId, held: true,
          routingReason: ruled.reason ?? "a matched rule is set to manual — the lead is held for the team lead to route",
        }
      }
      // TEAMS SEE ONLY THEIR OWN BOARD: a rule that picks someone outside the
      // team is ignored rather than obeyed. Obeying it would hand a team-tier
      // tenant's lead to an agents row that is not on the team.
      if (ruled.agentId && pool.includes(ruled.agentId)) {
        const n = normalizeAssignmentMethod(ruled.method ?? "rule_match")
        return {
          tier, agentId: ruled.agentId, method: n.method, ruleId: ruled.ruleId, held: false,
          routingReason: [`team tier${scopeNote} — matched rule, routed within the team`, ...n.detail].join("; "),
        }
      }
      const rejectedNote = ruled.agentId
        ? "; a matched rule picked an agent outside the team and was ignored"
        : ""

      // The team lead's DEFAULT method, applied WITHIN the team.
      if (pool.length > 0) {
        const pick = await assignByDefaultMethod(supabase, brokerageId, lead, pool)
        if (pick.held) {
          return {
            tier, agentId: null, method: "manual", ruleId: null, held: true,
            routingReason: `team tier${scopeNote} — the team lead's default method is Manual; the lead is held for a person${rejectedNote}`,
          }
        }
        if (pick.agentId) {
          const n = normalizeAssignmentMethod(pick.method)
          return {
            tier, agentId: pick.agentId, method: n.method, ruleId: null, held: false,
            routingReason: [`team tier${scopeNote} — the team lead's default method, applied within the team${rejectedNote}`, ...n.detail].join("; "),
          }
        }
      }

      // Nobody on the team is routable → the TEAM LEAD themselves. Same last
      // rung the contact resolver already uses (contact-assignment.ts:243), so
      // leads and contacts cannot disagree about who catches the overflow.
      const leadAgentId = await resolveTeamLeadAgentId(supabase, brokerageId, team.teamLeadUserId)
      if (leadAgentId) {
        return {
          tier, agentId: leadAgentId, method: "team_lead", ruleId: null, held: false,
          routingReason: `team tier${scopeNote} — no routable team member; the team lead takes it${rejectedNote}`,
        }
      }
      return none(
        "team_lead",
        `team tier${scopeNote} — the team has no routable member and no active agents row for teams.team_lead_id (provisioning gap)`,
      )
    }
    // A team-tier tenant with no teams row is a provisioning gap, not a routing
    // decision. Falling through to the brokerage-wide pool is the safe direction
    // (the lead is still assigned) and it is SAID OUT LOUD in the ledger.
  }

  // ── TIER 3+4: BROKERAGE / MULTI_LOCATION ───────────────────────────────────
  // The brokerage admin's settings across the whole roster. Office scoping rides
  // assignment_rules.team_id, which resolveAgentByRules already sorts above
  // brokerage-wide rules at equal priority.
  const tierNote = tier === "team"
    ? "team tier with NO teams row — fell through to the brokerage-wide pool (provisioning gap)"
    : `${tier} tier — the brokerage admin's assignment settings`

  const ruled = await resolveAgentByRules(supabase, brokerageId, lead as never)
  if (ruled.error) {
    return { ...none("load_balance", `${tierNote}; rule pass failed: ${ruled.error}`), error: ruled.error }
  }
  if (ruled.held) {
    return {
      tier, agentId: null, method: "manual", ruleId: ruled.ruleId, held: true,
      routingReason: ruled.reason ?? `${tierNote}; a matched rule is set to manual — held for a person to route`,
    }
  }
  if (ruled.agentId) {
    const n = normalizeAssignmentMethod(ruled.method ?? "rule_match")
    return {
      tier, agentId: ruled.agentId, method: n.method, ruleId: ruled.ruleId, held: false,
      routingReason: [`${tierNote}; matched rule`, ...n.detail].join("; "),
    }
  }

  const fallback = await assignByDefaultMethod(supabase, brokerageId, lead)
  if (fallback.held) {
    return {
      tier, agentId: null, method: "manual", ruleId: null, held: true,
      routingReason: `${tierNote}; the default method is Manual — the lead is held for a person to route`,
    }
  }
  if (!fallback.agentId) {
    return none("load_balance", `${tierNote}; no eligible agent found`)
  }
  const n = normalizeAssignmentMethod(fallback.method)
  return {
    tier, agentId: fallback.agentId, method: n.method, ruleId: null, held: false,
    routingReason: [`${tierNote}; default policy`, ...n.detail].join("; "),
  }
}

// ─── THE SEAM ────────────────────────────────────────────────────────────────

/**
 * WHY a lead is being assigned. Recorded in routing_reason so a brokerage can
 * tell an ISA qualification apart from a positive-feedback conversion apart from
 * an admin pressing Assign All.
 */
export type AssignmentTrigger =
  /** Lane 1: inbound intent came back POSITIVE and the lead converted. The
   *  owner's rule — "agent assignment should be auto assigned when positive
   *  feedback is received" — is this trigger. */
  | "positive_feedback"
  | "ai_isa_qualified"
  | "admin_auto"
  | "import"
  | "escalation"

export interface AutoAssignResult {
  assigned: boolean
  /** agents.id. */
  agentId?: string
  tier: PlanTier
  method?: AssignmentLogMethod
  reason: string
  /** A policy assigned nobody on purpose (rule or default method = manual). */
  held?: boolean
  /** The lead already had an owner. Idempotent no-op, not a failure. */
  alreadyAssigned?: boolean
}

/**
 * ASSIGN A QUALIFIED LEAD TO AN AGENT, BY THE TENANT'S TIER POLICY.
 *
 * THE call for every automatic path — Lane 1's positive-feedback conversion, the
 * AI ISA's qualification hook, the admin's Assign All, an import. It gates,
 * resolves, commits and logs; callers do not reimplement any of that.
 *
 * ── THE CONTRACT A CALLER MUST MEET ─────────────────────────────────────────
 *
 * The lead must ALREADY be qualified and consented before this is called:
 *   leads.lead_stage      = 'qualified'
 *   leads.lifecycle_state ∈ ('consented','assigned')   (the two live values that
 *                            mean consent has been given; 'qualified' is NOT a
 *                            legal lifecycle_state — leads_lifecycle_state_check
 *                            admits raw | unconsented | isa_qualifying |
 *                            consented | assigned | appointment | representation
 *                            | long_term_nurture)
 *
 * There is deliberately NO bypass parameter. Assignment converts the lead into a
 * contact owned by a named agent and starts their clock; a caller that could
 * skip the gate could start that clock on an unconsented person. A caller that
 * has just decided the lead is qualified must STAMP it, then call.
 *
 * IDEMPOTENT. A second positive signal on the same lead is a no-op, not a second
 * assignment — without this the same lead would be handed out twice and
 * converted into two contacts.
 */
export async function autoAssignLead(params: {
  leadId: string
  brokerageId: string
  trigger: AssignmentTrigger
}): Promise<AutoAssignResult> {
  const { leadId, brokerageId, trigger } = params
  const { createServiceClient: makeService } = await import("@/lib/supabase/service")
  const supabase = makeService()

  const { data: leadData, error: leadError } = await supabase
    .from("leads")
    .select(
      "id, brokerage_id, lifecycle_state, lead_stage, lead_score, property_zip_code, " +
        "source, urgency_level, agent_id, motivation_type, persona",
    )
    .eq("id", leadId)
    .eq("brokerage_id", brokerageId) // explicit tenant predicate — the service client bypasses RLS
    .maybeSingle()

  // supabase-js RESOLVES a refused query: a swallowed error would be
  // indistinguishable from "no such lead", and both must refuse.
  // FALLBACK_TIER on these two branches is not a claim about the tenant — the
  // lead could not be read, so no tier was resolved. It is the tightest tier,
  // the same fail-safe direction resolvePlanTier uses.
  if (leadError) {
    return { assigned: false, tier: FALLBACK_TIER, reason: `Lead read failed: ${leadError.message}` }
  }
  if (!leadData) {
    return { assigned: false, tier: FALLBACK_TIER, reason: "Lead not found in this brokerage" }
  }

  const lead = leadData as unknown as LeadRoutingHints & {
    id: string
    agent_id: string | null
    lead_stage: string | null
    lifecycle_state: string | null
    lead_score: number | null
  }

  // IDEMPOTENCY. Leads belong to the BROKERAGE until assignment happens; once it
  // has happened, a repeat signal must not re-run it.
  if (lead.agent_id) {
    const tier = await resolvePlanTier(supabase, brokerageId)
    return {
      assigned: false, alreadyAssigned: true, agentId: lead.agent_id, tier,
      reason: "Lead already has an assigned agent — no second assignment",
    }
  }

  const isQualified = lead.lead_stage === "qualified"
  const isConsented = lead.lifecycle_state === "consented" || lead.lifecycle_state === "assigned"
  if (!isQualified || !isConsented) {
    const tier = await resolvePlanTier(supabase, brokerageId)
    return {
      assigned: false, tier,
      reason:
        "Assignment requires lead_stage='qualified' AND lifecycle_state in (consented|assigned). " +
        `Got lead_stage='${lead.lead_stage}', lifecycle_state='${lead.lifecycle_state}'. ` +
        "Stamp the lead before calling — there is no bypass.",
    }
  }

  const decision = await resolveTierRouting(supabase, brokerageId, lead)

  if (decision.held) {
    return { assigned: false, held: true, tier: decision.tier, reason: decision.routingReason }
  }
  if (!decision.agentId) {
    return { assigned: false, tier: decision.tier, reason: decision.routingReason }
  }

  // COVERAGE MODE — an agent on leave never silently collects new work. One hop,
  // never chained; the away agent's existing book is untouched.
  let agentId = decision.agentId
  let coverageNote = ""
  {
    const { redirectForCoverage } = await import("@/lib/agents/coverage-mode")
    const redirected = await redirectForCoverage(supabase, agentId)
    if (redirected && redirected !== agentId) {
      agentId = redirected
      coverageNote = "; redirected to a covering agent (coverage mode)"
    }
  }

  const routingReason = `[${trigger}] ${decision.routingReason}${coverageNote}`

  // Commits the whole handoff: leads.agent_id + handed_to_agent_at, lifecycle
  // advance, assignment_log row, SLA close, contact conversion, agent notify.
  await handleLeadAssigned({
    leadId,
    brokerageId,
    agentId,
    ruleId: decision.ruleId ?? undefined,
    method: decision.method,
    scoreAtAssignment: lead.lead_score ?? 0,
  })

  // ATTRIBUTION. handleLeadAssigned does not take a routing reason, and m489
  // deliberately keeps the DECORATIONS out of assignment_method, so the "why"
  // has to land here or it is lost. Scoped to this lead, this tenant, and only
  // the row that has no reason yet.
  const { error: reasonError } = await supabase
    .from("assignment_log")
    .update({ routing_reason: routingReason.slice(0, 2000) })
    .eq("lead_id", leadId)
    .eq("brokerage_id", brokerageId)
    .is("routing_reason", null)
  if (reasonError) {
    // Bookkeeping only — the lead HAS moved. Reported, never thrown: throwing
    // here would tell the caller the assignment failed when it did not.
    console.warn("[tier-routing] routing_reason not recorded:", reasonError.message)
  }

  if (decision.ruleId) {
    await supabase.rpc("increment_rule_triggered", { rule_id: decision.ruleId })
  }

  return {
    assigned: true,
    agentId,
    tier: decision.tier,
    method: decision.method,
    reason: routingReason,
  }
}
