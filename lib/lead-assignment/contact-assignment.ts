// SYSTEM: Contact Assignment Resolver (Track B + Lane A consent handoff)
// FILE: lib/lead-assignment/contact-assignment.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURPOSE
//   Pick which agent owns a brand-new contact. Used by both:
//     • Lane B imports (forms / FB ads / Zillow / Realtor.com) — at insert time.
//     • Lane A lead→contact conversion (after qualification + consent).
//
// PRECEDENCE (highest → lowest) — the canonical chain across ALL four
// subscription setups (solo_agent | team | brokerage | multi_location; a
// multi-location brokerage models each office as a TEAM):
//   1. Caller-provided ownerAgentId — used when a form is attached to a
//      specific agent (e.g., agent's personal landing page, agent-tagged FB
//      ad). The agent stays with the contact regardless of rules.
//   2. Solo-agent brokerage — every contact goes to the one active agent
//      (plan_tier='solo_agent').
//   3. assignment_rules — evaluated in priority order against the available
//      hints (source, property_zip_code). TEAM-scoped rules (team_id set)
//      outrank brokerage-wide rules at equal priority, never fire for a
//      contact with a DIFFERENT team affinity, and route within the team's
//      members when no explicit agent_ids are listed.
//   4. Team fallback — when the contact has a team affinity (owner's team /
//      team-tagged capture / single-team 'team' tier): load-balance within
//      the team, then the TEAM LEAD.
//   5. Load-balance fallback — pick the active agent with the fewest active
//      contacts in the brokerage. No contact is ever left unrouted.
//
// All callers MUST persist the returned id into contacts.agent_id (which
// stores agents.id, NOT users.id — per migration 111 / RLS helpers).
// ─────────────────────────────────────────────────────────────────────────────

import { createServiceClient } from "@/lib/supabase/service"
import {
  teamScopeAllows,
  pickAgentForRule,
  toRoutingProfiles,
  ROUTING_PROFILE_COLUMNS,
  type AgentProfileForRouting,
} from "./rule-matcher"
import { selectAgentByCapacity, resolveBrokerageMaxLoad } from "./capacity-pick"
import { loadRoutingProfiles } from "./routing-profiles"

export interface ResolveAgentForContactInput {
  brokerageId: string
  /** If the row already has an owner (e.g., agent-tagged form), use it. */
  ownerAgentId?: string | null
  /** Team affinity hint (team-tagged form / multi-location office capture). */
  teamId?: string | null
  /** Hints used by rule evaluation. Optional. */
  source?: string | null
  propertyZipCode?: string | null
}

export interface ResolveAgentForContactResult {
  agentId: string | null
  method:
    | "owner"
    | "solo_agent"
    | "rule"
    | "team_load_balance"
    | "team_lead"
    | "load_balance"
    | "manual_hold"
    | "none"
  ruleId?: string | null
  teamId?: string | null
}


const RULE_FIELDS =
  "id, brokerage_id, rule_type, conditions, agent_ids, team_id, priority, is_active, times_triggered"

export async function resolveAgentForContact(
  input: ResolveAgentForContactInput
): Promise<ResolveAgentForContactResult> {
  const supabase = createServiceClient()
  const { brokerageId, ownerAgentId, source, propertyZipCode } = input
  let teamHint: string | null = input.teamId ?? null

  // 1. Caller-specified owner — verify it belongs to the brokerage before honoring.
  if (ownerAgentId) {
    const { data: ownerAgent } = await supabase
      .from("agents")
      .select("id, team_id, is_active")
      .eq("id", ownerAgentId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (ownerAgent?.id && ownerAgent.is_active) {
      return { agentId: ownerAgent.id, method: "owner", teamId: ownerAgent.team_id ?? null }
    }
    // Owner unavailable (left / deactivated) — the contact stays with the
    // owner's TEAM: keep their team as the affinity for the steps below.
    if (ownerAgent?.team_id && !teamHint) teamHint = ownerAgent.team_id
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

  // 2b. Team tier — a single-team brokerage gives every contact that team's
  //     affinity (rules + fallback then stay within the team).
  if (!teamHint && brokerage?.plan_tier === "team") {
    const { data: onlyTeam } = await supabase
      .from("teams")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .is("deleted_at", null)
      .limit(2)
    if (onlyTeam?.length === 1) teamHint = onlyTeam[0].id
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

  // Team-scoped rules outrank brokerage-wide rules at equal priority and never
  // fire for a contact with a different team affinity (teamScopeAllows). A team
  // rule without explicit agent_ids routes within the team's active members.
  const ruleRows = ((rules ?? []) as Array<{
    id: string
    rule_type: string
    conditions: Record<string, unknown> | null
    agent_ids: string[] | null
    team_id: string | null
    priority: number
    times_triggered: number | null
  }>).sort((a, b) =>
    b.priority - a.priority !== 0
      ? b.priority - a.priority
      : Number(!!b.team_id) - Number(!!a.team_id),
  )

  for (const rule of ruleRows) {
    if (!teamScopeAllows(rule as never, teamHint)) continue
    if (!matchesContactConditions(rule.conditions ?? {}, { source, propertyZipCode })) continue

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

    // Same fix as Engine 2: every method other than round_robin used to be
    // pool[0]. At contact-creation time the only hints available are source and
    // ZIP (no score or persona yet), so an expertise rule will usually find no
    // match and fall back to capacity — which is the honest outcome, and still
    // far better than always handing the contact to the first agent listed.
    const pick = pickAgentForRule(
      rule as never,
      pool,
      { source, property_zip_code: propertyZipCode },
      await loadRoutingProfiles(supabase, brokerageId, pool),
    )

    if (pick.kind === "manual") {
      return { agentId: null, method: "manual_hold", ruleId: rule.id, teamId: rule.team_id ?? teamHint }
    }

    const candidate = pick.kind === "agent"
      ? pick.agentId
      : await selectAgentByCapacity(
          supabase, brokerageId, pick.candidates,
          await resolveBrokerageMaxLoad(supabase, brokerageId),
        )
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
      return { agentId: confirmed.id, method: "rule", ruleId: rule.id, teamId: rule.team_id ?? teamHint }
    }
  }

  // CAPACITY CEILING — derived from the brokerage's active-agent headcount, the SAME tier
  // ceiling the Capacity Guardian enforces. The load-balance steps below prefer an agent with
  // HEADROOM so a fresh contact never piles onto someone already at/over capacity (the
  // guardian becomes PREVENTIVE, not just reactive). Never strands a contact.
  const maxLoad = await resolveBrokerageMaxLoad(supabase, brokerageId)

  // 3b. Team fallback — the contact has a team affinity: stay within the team.
  //     Capacity-aware load-balance among team members; if the team has no routable
  //     members, hand to the TEAM LEAD (teams.team_lead_id is users.id → agents row).
  if (teamHint) {
    const { data: teamAgents } = await supabase
      .from("agents")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("team_id", teamHint)
      .eq("is_active", true)

    if (teamAgents?.length) {
      const bestTeamAgent = await selectAgentByCapacity(supabase, brokerageId, teamAgents.map((a) => a.id), maxLoad)
      if (bestTeamAgent) {
        return { agentId: bestTeamAgent, method: "team_load_balance", teamId: teamHint }
      }
    }

    const { data: teamRow } = await supabase
      .from("teams")
      .select("team_lead_id")
      .eq("id", teamHint)
      .is("deleted_at", null)
      .maybeSingle()
    if (teamRow?.team_lead_id) {
      const { data: leadAgent } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", teamRow.team_lead_id)
        .eq("brokerage_id", brokerageId)
        .eq("is_active", true)
        .maybeSingle()
      if (leadAgent?.id) {
        return { agentId: leadAgent.id, method: "team_lead", teamId: teamHint }
      }
    }
    // Team has nobody routable — fall through to brokerage-wide load balance.
  }

  // 4. Load-balance fallback — capacity-aware: prefer the agent with the most HEADROOM
  //    under the tier ceiling (least working load), never just the fewest contacts.
  const { data: agents } = await supabase
    .from("agents")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("is_active", true)

  if (!agents?.length) return { agentId: null, method: "none" }

  const bestAgent = await selectAgentByCapacity(supabase, brokerageId, agents.map((a) => a.id), maxLoad)

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
