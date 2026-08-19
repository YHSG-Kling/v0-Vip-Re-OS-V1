import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"

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
// The SOLO shortcut and the brokerage-DEFAULT fallback are no longer imported
// here: they are steps of the tier-aware policy and moved with it into
// ./tier-routing, which this file's evaluateAndAssignLead delegates to.


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

/**
 * ENGINE 2 — the qualified lead → owned contact handoff. Kept as the name every
 * caller already imports (the AI ISA qualification hook, the ISA handoff
 * acceptance action, the voice broker command, the admin Assign action), and it
 * now DELEGATES rather than deciding.
 *
 * WHAT MOVED, AND WHY IT HAD TO. The body used to be the whole policy: a solo
 * shortcut, a rule pass, a brokerage default, coverage, then the write. It knew
 * about exactly ONE tier (solo_agent) and treated the other three identically —
 * so a `team` tenant's lead was routed across the whole agents table, ignoring
 * the team and ignoring teams.team_lead_id, and the owner's rule that "if team
 * lead subscription, team lead has agent assignment settings" had no code.
 *
 * The tier-aware policy now lives in ONE place, lib/lead-assignment/tier-routing.ts,
 * which every automatic path calls — including Lane 1's positive-feedback
 * conversion. Two implementations of "whose lead is this" is exactly the drift a
 * single resolver exists to prevent, so this function is a thin adapter that
 * preserves the historical return shape and names its trigger.
 *
 * The two behaviours the old body had that the new one keeps, unchanged: the
 * qualification+consent gate (it is stricter there, not looser) and the coverage
 * redirect. The one it drops is writing a DECORATED method string into
 * assignment_log.assignment_method — m489 proved those were refused outright by
 * assignment_log_assignment_method_check, and the insert is not destructured, so
 * every such assignment wrote no ledger row at all.
 */
export async function evaluateAndAssignLead(params: {
  leadId: string
  brokerageId: string
}): Promise<{ assigned: boolean; agentId?: string; reason: string }> {
  const { autoAssignLead } = await import("./tier-routing")
  const out = await autoAssignLead({
    leadId: params.leadId,
    brokerageId: params.brokerageId,
    trigger: "ai_isa_qualified",
  })
  // An already-assigned lead reports as assigned to this caller: the historical
  // contract is "does the lead now have an owner", and it does. The distinction
  // is preserved on autoAssignLead's own result for callers that need it.
  return {
    assigned: out.assigned || !!out.alreadyAssigned,
    agentId: out.agentId,
    reason: out.reason,
  }
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
