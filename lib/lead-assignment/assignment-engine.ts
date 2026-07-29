import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"
import { handleLeadAssigned } from "@/lib/kernel/lead-acquisition-handlers"

// ─── TYPES ────────────────────────────────────────────────────────────────────

type RuleType = "round_robin" | "load_balance" | "geo_based" | "specialization"

interface AssignmentRule {
  id: string
  brokerage_id: string
  name: string
  rule_type: RuleType
  conditions: Record<string, unknown>
  agent_ids: string[]
  priority: number
  is_active: boolean
  times_triggered: number
}

interface LeadRow {
  id: string
  brokerage_id: string
  lifecycle_state: string
  lead_stage: string | null
  lead_score: number | null
  property_zip_code: string | null
  source: string | null
  urgency_level: string | null
  agent_id: string | null
  motivation_type: string | null
  persona: string | null
}

// ─── CONDITION EVALUATOR ──────────────────────────────────────────────────────
// Consolidated into lib/lead-assignment/rule-matcher.ts (pure) — the SAME matcher
// powers this engine, the settings UI's routing preview, and the simulator, so
// what the broker previews is exactly what the engine does.
import {
  evaluateRuleConditions,
  pickAgentForRule,
  toRoutingProfiles,
  ROUTING_PROFILE_COLUMNS,
  type AgentProfileForRouting,
} from "./rule-matcher"
import { selectAgentByCapacity, resolveBrokerageMaxLoad } from "./capacity-pick"
import { loadRoutingProfiles } from "./routing-profiles"
import { assignByDefaultMethod } from "./default-assignment"


/** What the rule pass decided for a lead. */
export interface RuleResolution {
  agentId: string | null
  ruleId: string | null
  method: string | null
  /** A matched rule chose MANUAL: assign nobody, and do not fall through. */
  held?: boolean
  reason?: string
  error?: string
}

/**
 * THE canonical assignment-rule pass. Engine 2 and the lead-governance rail both
 * call it, so the broker's configured method applies wherever a lead is routed.
 *
 * Governance used to bypass rules entirely: lib/lead-governance/agent-selector.ts
 * sorted active agents by id and took the first, then logged it as
 * "load_balanced". Any brokerage that had configured a round-robin or a ZIP farm
 * saw none of it on that path.
 */
export async function resolveAgentByRules(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  lead: LeadRow,
): Promise<RuleResolution> {
  const { data: rules, error: rulesError } = await supabase
    .from("assignment_rules")
    .select("id, brokerage_id, name, rule_type, conditions, agent_ids, team_id, priority, is_active, times_triggered")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .order("priority", { ascending: false })

  if (rulesError) {
    return { agentId: null, ruleId: null, method: null, error: `Failed to load rules: ${rulesError.message}` }
  }

  // Team-scoped rules outrank brokerage-wide rules at equal priority — the
  // canonical precedence: agent → team → brokerage → platform.
  const orderedRules = ((rules ?? []) as Array<AssignmentRule & { team_id: string | null }>)
    .sort((a, b) =>
      b.priority - a.priority !== 0
        ? b.priority - a.priority
        : Number(!!b.team_id) - Number(!!a.team_id),
    )

  for (const rule of orderedRules) {
    if (!evaluateRuleConditions(lead, rule.conditions ?? {})) continue

    let pool = rule.agent_ids ?? []
    if (pool.length === 0 && rule.team_id) {
      const { data: members } = await supabase
        .from("agents")
        .select("id")
        .eq("brokerage_id", brokerageId)
        .eq("team_id", rule.team_id)
        .eq("is_active", true)
      pool = (members ?? []).map((m) => m.id)
    }
    if (pool.length === 0) continue

    // Apply the rule's METHOD. Every branch except round_robin used to be
    // pool[0], so a broker who chose "Load Balance" or "Specialization" sent
    // every matching lead to the same agent, forever.
    const pick = pickAgentForRule(rule as never, pool, lead, await loadRoutingProfiles(supabase, brokerageId, pool))

    if (pick.kind === "manual") {
      // A deliberate hold, not a routing failure. Falling through to
      // load-balance would defeat the whole point of choosing it.
      return {
        agentId: null, ruleId: rule.id, method: "manual", held: true,
        reason: `Rule "${rule.name}" is set to manual assignment — the lead is held for a person to route.`,
      }
    }

    const agentId = pick.kind === "agent"
      ? pick.agentId
      : await selectAgentByCapacity(
          supabase, brokerageId, pick.candidates,
          await resolveBrokerageMaxLoad(supabase, brokerageId),
        )
    if (!agentId) continue   // nobody in this rule's pool is routable

    return {
      agentId,
      ruleId: rule.id,
      method: rule.team_id ? `team_${pick.method}` : pick.method,
    }
  }

  return { agentId: null, ruleId: null, method: null }
}

// ─── evaluateAndAssignLead ────────────────────────────────────────────────────

export async function evaluateAndAssignLead(params: {
  leadId: string
  brokerageId: string
}): Promise<{ assigned: boolean; agentId?: string; reason: string }> {
  const { leadId, brokerageId } = params
  const supabase = createServiceClient()

  // Step 1: Fetch lead
  const { data: leadData, error: leadError } = await supabase
    .from("leads")
    .select(
      "id, brokerage_id, lifecycle_state, lead_stage, lead_score, property_zip_code, " +
        "source, urgency_level, agent_id, motivation_type, persona"
    )
    .eq("id", leadId)
    .single()

  if (leadError || !leadData) {
    return { assigned: false, reason: `Lead not found: ${leadError?.message ?? "no data"}` }
  }

  // Step 2: Engine 2 fires only on QUALIFIED leads.
  // The ISA must have completed qualification (lead_stage = 'qualified') AND
  // the contact must have given explicit consent (lifecycle_state = 'consented'
  // or beyond). This replaces the prior consent-only gate which fired too early.
  const typedLead0 = leadData as unknown as LeadRow
  const isQualified = typedLead0.lead_stage === "qualified"
  const isConsented =
    typedLead0.lifecycle_state === "consented" ||
    typedLead0.lifecycle_state === "qualified" ||
    typedLead0.lifecycle_state === "assigned"

  if (!isQualified || !isConsented) {
    return {
      assigned: false,
      reason: `Engine 2 requires lead_stage='qualified' AND lifecycle_state in (consented|qualified|assigned). ` +
        `Got lead_stage='${typedLead0.lead_stage}', lifecycle_state='${typedLead0.lifecycle_state}'.`,
    }
  }

  // Step 3+4: the canonical rule pick — shared with the lead-governance rail so
  // both honour the broker's configured method rather than each rolling its own.
  const ruled = await resolveAgentByRules(supabase, brokerageId, typedLead0)
  if (ruled.held) {
    return { assigned: false, reason: ruled.reason ?? "Held for manual assignment." }
  }
  if (ruled.error) {
    return { assigned: false, reason: ruled.error }
  }

  const typedLead = typedLead0
  let matchedAgentId: string | null = ruled.agentId
  const matchedRuleId: string | null = ruled.ruleId
  let matchedMethod = ruled.method ?? "load_balance"

  // Step 5: Load-balance fallback if no rule matched
  if (!matchedAgentId) {
    // THE DEFAULT — brokerages.default_assignment_method (m305), the admin's
    // decision in Settings. This was a hardcoded capacity load-balance, so the
    // method deciding most assignments was the one nobody could configure.
    const fallback = await assignByDefaultMethod(supabase, brokerageId, typedLead)
    if (fallback.held) {
      return {
        assigned: false,
        reason: "The brokerage's default assignment method is Manual — this lead is held for a person to route.",
      }
    }
    matchedAgentId = fallback.agentId
    matchedMethod = fallback.method
    if (!matchedAgentId) {
      return { assigned: false, reason: "No eligible agent found" }
    }
  }

  // Step 5b: COVERAGE MODE (l52-s01) — an agent on leave never silently
  // collects new leads: active coverage redirects the pick to the covering
  // agent (one hop, never chained). The away agent's existing book is
  // untouched — coverage is reversible by construction.
  {
    const { redirectForCoverage } = await import("@/lib/agents/coverage-mode")
    const redirected = await redirectForCoverage(supabase, matchedAgentId)
    if (redirected !== matchedAgentId) {
      matchedAgentId = redirected
      matchedMethod = `${matchedMethod}_coverage`
    }
  }

  // Step 6: Call handleLeadAssigned — advances lifecycle_state + auto-creates contact
  await handleLeadAssigned({
    leadId,
    brokerageId,
    agentId: matchedAgentId,
    ruleId: matchedRuleId ?? undefined,
    method: matchedMethod,
    scoreAtAssignment: typedLead.lead_score ?? 0,
  })

  // Step 7: Increment times_triggered on the matched rule
  if (matchedRuleId) {
    await supabase.rpc("increment_rule_triggered", { rule_id: matchedRuleId })
  }

  // Step 8: Return result
  return { assigned: true, agentId: matchedAgentId, reason: `Assigned via ${matchedMethod}` }
}

// ─── claimLead (race-condition safe) ─────────────────────────────────────────

export async function claimLead(params: {
  leadId: string
  agentUserId: string
  brokerageId: string
}): Promise<{ success: boolean; reason?: string }> {
  const { leadId, agentUserId, brokerageId } = params
  const supabase = createServiceClient()

  // Step 1: Check current claimed state
  const { data: logRow, error: logError } = await supabase
    .from("assignment_log")
    .select("id, claimed, agent_id")
    .eq("lead_id", leadId)
    .eq("claimed", false)
    .maybeSingle()

  if (logError) {
    return { success: false, reason: `Failed to check claim status: ${logError.message}` }
  }

  // Step 2: Already claimed
  if (!logRow) {
    return { success: false, reason: "already_claimed" }
  }

  // Step 3: Atomically mark as claimed
  const { error: updateError } = await supabase
    .from("assignment_log")
    .update({ claimed: true, claimed_at: new Date().toISOString() })
    .eq("id", logRow.id)
    .eq("claimed", false) // optimistic lock — only update if still unclaimed

  if (updateError) {
    return { success: false, reason: `Claim update failed: ${updateError.message}` }
  }

  // Step 4: Emit LEAD_CLAIMED through the canonical emitter (insert + reactor fan-out).
  // Bare lifecycle_events inserts silently skipped staff notifications / sequence enrollment /
  // portal updates downstream of a claim — emit() restores all three channels.
  await emitKernelEvent({
    event:       KernelEvent.LEAD_CLAIMED,
    brokerageId,
    entityType:  "lead",
    entityId:    leadId,
    agentUserId,
    metadata:    { claimed_by: agentUserId },
  })

  // Step 5: Return success
  return { success: true }
}
