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
import { evaluateRuleConditions, pickRoundRobinAgent } from "./rule-matcher"
import { selectAgentByCapacity, resolveBrokerageMaxLoad } from "./capacity-pick"

// ─── LOAD-BALANCE FALLBACK ────────────────────────────────────────────────────
// CAPACITY-AWARE — shares the SAME picker as resolveAgentForContact + the Capacity
// Guardian (working load = contacts + leads + deals against the tier ceiling), so a lead
// is never handed to an agent who is already at/over capacity. (Consolidated: the old
// "fewest assigned leads" heuristic was a third, divergent load metric — removed.)

async function loadBalanceFallback(brokerageId: string): Promise<string | null> {
  const supabase = createServiceClient()

  const { data: agents } = await supabase
    .from("agents")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)

  if (!agents || agents.length === 0) return null

  const maxLoad = await resolveBrokerageMaxLoad(supabase, brokerageId)
  return selectAgentByCapacity(supabase, brokerageId, agents.map((a) => a.id), maxLoad)
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

  // Step 3: Fetch active rules — team-scoped rules (team tier / multi-location
  // office) outrank brokerage-wide rules at equal priority. A team rule without
  // explicit agent_ids routes within the team's active members.
  const { data: rules, error: rulesError } = await supabase
    .from("assignment_rules")
    .select("id, brokerage_id, name, rule_type, conditions, agent_ids, team_id, priority, is_active, times_triggered")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .order("priority", { ascending: false })

  if (rulesError) {
    return { assigned: false, reason: `Failed to load rules: ${rulesError.message}` }
  }

  const typedLead = typedLead0
  let matchedAgentId: string | null = null
  let matchedRuleId: string | null = null
  let matchedMethod = "load_balance"

  // Step 4: Evaluate rules in priority order (team rules first at equal priority —
  // canonical precedence: agent → team → brokerage → platform)
  const orderedRules = ((rules ?? []) as Array<AssignmentRule & { team_id: string | null }>)
    .sort((a, b) =>
      b.priority - a.priority !== 0
        ? b.priority - a.priority
        : Number(!!b.team_id) - Number(!!a.team_id),
    )
  for (const rule of orderedRules) {
    const matched = evaluateRuleConditions(typedLead, rule.conditions ?? {})
    if (!matched) continue

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

    // Pick agent based on rule type
    if (rule.rule_type === "round_robin") {
      matchedAgentId = pickRoundRobinAgent(pool, rule.times_triggered)
    } else {
      // geo_based / specialization / load_balance — use first agent in pool as default
      matchedAgentId = pool[0]
    }

    matchedRuleId = rule.id
    matchedMethod = rule.team_id ? `team_${rule.rule_type}` : rule.rule_type
    break
  }

  // Step 5: Load-balance fallback if no rule matched
  if (!matchedAgentId) {
    matchedAgentId = await loadBalanceFallback(brokerageId)
    matchedMethod = "load_balance"
    if (!matchedAgentId) {
      return { assigned: false, reason: "No eligible agent found" }
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
