// SYSTEM: Contact Assignment Resolver (Track B + Lane A consent handoff)
// FILE: lib/lead-assignment/contact-assignment.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE
//   Pick which agent owns a brand-new contact. Used by both:
//     • Lane B imports (forms / FB ads / Zillow / Realtor.com) — at insert time.
//     • Lane A lead→contact conversion (after qualification + consent).
//
// PRECEDENCE (highest → lowest)
//   1. Caller-provided ownerAgentId — used when a form is attached to a
//      specific agent (e.g., agent's personal landing page, agent-tagged FB
//      ad). The agent stays with the contact regardless of rules.
//   2. Solo-agent brokerage — every contact goes to the one active agent
//      (plan_tier='solo_agent').
//   3. assignment_rules — evaluated in priority order against the available
//      hints (source, property_zip_code). Rules with all-conditions-match
//      pick the agent via the rule's rule_type (round_robin or first agent).
//   4. Load-balance fallback — pick the active agent with the fewest active
//      contacts in the brokerage.
//
// All callers MUST persist the returned id into contacts.agent_id (which
// stores agents.id, NOT users.id — per migration 111 / RLS helpers).
// ─────────────────────────────────────────────────────────────────────────────

import { createServiceClient } from "@/lib/supabase/service"

export interface ResolveAgentForContactInput {
  brokerageId: string
  /** If the row already has an owner (e.g., agent-tagged form), use it. */
  ownerAgentId?: string | null
  /** Hints used by rule evaluation. Optional. */
  source?: string | null
  propertyZipCode?: string | null
}

export interface ResolveAgentForContactResult {
  agentId: string | null
  method: "owner" | "solo_agent" | "rule" | "load_balance" | "none"
  ruleId?: string | null
}

const RULE_FIELDS =
  "id, brokerage_id, rule_type, conditions, agent_ids, priority, is_active, times_triggered"

export async function resolveAgentForContact(
  input: ResolveAgentForContactInput
): Promise<ResolveAgentForContactResult> {
  const supabase = createServiceClient()
  const { brokerageId, ownerAgentId, source, propertyZipCode } = input

  // 1. Caller-specified owner — verify it belongs to the brokerage before honoring.
  if (ownerAgentId) {
    const { data: ownerAgent } = await supabase
      .from("agents")
      .select("id")
      .eq("id", ownerAgentId)
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .maybeSingle()
    if (ownerAgent?.id) {
      return { agentId: ownerAgent.id, method: "owner" }
    }
    // Owner not found in this brokerage — fall through to brokerage-level routing.
  }

  // 2. Solo-agent brokerage — single-agent shortcut.
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("plan_tier")
    .eq("id", brokerageId)
    .maybeSingle()

  if (brokerage?.plan_tier === "solo_agent") {
    const { data: soloAgent } = await supabase
      .from("agents")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle()
    if (soloAgent?.id) {
      return { agentId: soloAgent.id, method: "solo_agent" }
    }
  }

  // 3. Assignment rules — evaluate in priority order. We have limited hints
  //    at contact-creation time (no score / urgency yet), so only condition
  //    types that match against source / zip will fire.
  const { data: rules } = await supabase
    .from("assignment_rules")
    .select(RULE_FIELDS)
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)
    .order("priority", { ascending: false })

  for (const rule of (rules ?? []) as Array<{
    id: string
    rule_type: string
    conditions: Record<string, unknown> | null
    agent_ids: string[] | null
    times_triggered: number | null
  }>) {
    if (!rule.agent_ids?.length) continue
    if (!matchesContactConditions(rule.conditions ?? {}, { source, propertyZipCode })) continue

    const idx =
      rule.rule_type === "round_robin"
        ? (rule.times_triggered ?? 0) % rule.agent_ids.length
        : 0
    const candidate = rule.agent_ids[idx]
    if (!candidate) continue

    // Verify the candidate is an active agent in the brokerage.
    const { data: confirmed } = await supabase
      .from("agents")
      .select("id")
      .eq("id", candidate)
      .eq("brokerage_id", brokerageId)
      .eq("is_active", true)
      .maybeSingle()
    if (confirmed?.id) {
      return { agentId: confirmed.id, method: "rule", ruleId: rule.id }
    }
  }

  // 4. Load-balance fallback — pick the agent with the fewest active
  //    contacts in this brokerage.
  const { data: agents } = await supabase
    .from("agents")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)

  if (!agents?.length) return { agentId: null, method: "none" }

  let bestAgent: string | null = null
  let bestCount = Number.POSITIVE_INFINITY
  for (const a of agents) {
    const { count } = await supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)
      .eq("agent_id", a.id)
      .is("deleted_at", null)
    const c = count ?? 0
    if (c < bestCount) {
      bestCount = c
      bestAgent = a.id
    }
  }

  return bestAgent
    ? { agentId: bestAgent, method: "load_balance" }
    : { agentId: null, method: "none" }
}

// Only condition types that have useful values at contact-creation time.
// `min_score`, `urgency_levels`, etc. require enrichment that runs later.
function matchesContactConditions(
  conditions: Record<string, unknown>,
  hints: { source?: string | null; propertyZipCode?: string | null }
): boolean {
  for (const [key, value] of Object.entries(conditions)) {
    switch (key) {
      case "sources": {
        const sources = (value as string[]) ?? []
        if (!hints.source || !sources.includes(hints.source)) return false
        break
      }
      case "zip_codes": {
        const zips = (value as string[]) ?? []
        if (!hints.propertyZipCode || !zips.includes(hints.propertyZipCode)) return false
        break
      }
      // Score / urgency / motivation / persona conditions are skipped here —
      // contact-creation time doesn't have those signals yet. Rules that
      // require them simply won't match, which is correct behavior.
      default:
        break
    }
  }
  return true
}
