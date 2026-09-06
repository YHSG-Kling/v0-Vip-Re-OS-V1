// lib/lead-assignment/default-assignment.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE FALLBACK — which is to say, how MOST leads actually get assigned.
//
// assignment_rules let an admin choose a method per rule, but a rule only fires
// when its conditions match. The ordinary case is a new contact, or a newly
// CONVERTED lead, that no rule covers — and for that lead both routers did the
// same hardcoded thing: capacity-aware load balancing, with no way to change it.
// A brokerage running a strict round-robin floor rotation, the most common
// convention in the business, could not have one. The method deciding the
// majority of assignments was the one nobody could configure.
//
// brokerages.default_assignment_method (m305) is that decision, made by the
// broker or admin in Settings. This resolver applies it through the SAME
// pickByMethod the per-rule path uses, so "round robin" cannot come to mean two
// different things depending on which code path a lead happens to take.

import type { createServiceClient } from "@/lib/supabase/service"
import { pickByMethod, isRuleType, type LeadRoutingHints } from "./rule-matcher"
import { loadRoutingProfiles } from "./routing-profiles"
import { selectAgentByCapacity, resolveBrokerageMaxLoad } from "./capacity-pick"

export interface DefaultAssignmentResult {
  agentId: string | null
  /** The method that ran, prefixed 'default_' so a ledger entry says WHERE the
   *  decision came from — a matched rule or the brokerage-wide policy. */
  method: string
  /** The admin chose 'manual': assign nobody. Not a failure — a policy. */
  held: boolean
}

/** The configured default, or 'load_balance' — which is what the code did before
 *  m305, so an unset or unrecognised value preserves the old behaviour rather
 *  than inventing a new one. */
export async function resolveDefaultMethod(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
): Promise<string> {
  const { data } = await supabase
    .from("brokerages")
    .select("default_assignment_method")
    .eq("id", brokerageId)
    .maybeSingle()
  const m = (data as { default_assignment_method?: string } | null)?.default_assignment_method
  return isRuleType(m) ? m : "load_balance"
}

/**
 * Assign by the brokerage's configured default. `pool` lets a caller narrow the
 * candidates first — the team fallback passes a team's members so the default
 * method applies WITHIN the team rather than across the whole brokerage.
 */
export async function assignByDefaultMethod(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  hints: LeadRoutingHints,
  pool?: string[],
): Promise<DefaultAssignmentResult> {
  let candidates = pool
  if (!candidates) {
    const { data: agents } = await supabase
      .from("agents")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
    candidates = ((agents ?? []) as Array<{ id: string }>).map((a) => a.id)
  }
  if (candidates.length === 0) return { agentId: null, method: "none", held: false }

  const method = await resolveDefaultMethod(supabase, brokerageId)

  // A default round-robin has no rule row to count against, so the rotation
  // advances on the brokerage's own assignment history: one already-assigned
  // contact = one step. Deterministic, and it genuinely rotates rather than
  // handing every lead to the same agent (which is what "load balance" did when
  // capacity data was flat).
  let rotation = 0
  if (method === "round_robin") {
    const { count } = await supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .not("agent_id", "is", null)
    rotation = count ?? 0
  }

  const profiles = method === "specialization" || method === "geo_based"
    ? await loadRoutingProfiles(supabase, brokerageId, candidates)
    : undefined

  const pick = pickByMethod(method, candidates, hints, profiles, rotation)

  if (pick.kind === "manual") {
    return { agentId: null, method: "default_manual", held: true }
  }
  if (pick.kind === "agent") {
    return { agentId: pick.agentId, method: `default_${pick.method}`, held: false }
  }

  const maxLoad = await resolveBrokerageMaxLoad(supabase, brokerageId)
  const agentId = await selectAgentByCapacity(supabase, brokerageId, pick.candidates, maxLoad)
  return { agentId, method: `default_${pick.method}`, held: false }
}
