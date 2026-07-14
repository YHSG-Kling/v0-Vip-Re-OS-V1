/**
 * lib/agents/coverage-mode.ts
 *
 * COVERAGE MODE (forgotten-items #12) — vacation, illness, leave: the
 * REVERSIBLE sibling of agent deactivation. While coverage is active
 * (agents.covering_agent_id set AND coverage_until in the future,
 * l52-s01), NEW work redirects to the covering agent at the ball-drop
 * point — lead assignment — while the away agent's book stays THEIRS
 * (nothing reassigned, nothing to undo; coverage simply expires or is
 * cleared). PURE redirect decision + a thin resolver; enforcement lives
 * in the assignment engine's single terminal. recruiting_manager owns
 * team continuity.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

/** PURE: is coverage active, and to whom does new work go? */
export function coverageRedirect(agent: {
  coveringAgentId: string | null
  coverageUntil: string | null
}, now: Date): string | null {
  if (!agent.coveringAgentId) return null
  if (!agent.coverageUntil) return null
  return new Date(agent.coverageUntil).getTime() > now.getTime() ? agent.coveringAgentId : null
}

/** LIVE: given a chosen assignee, return the covering agent when coverage is
 *  active (one hop only — a cover of a cover does NOT chain; the second
 *  agent's own coverage is their leave, not a routing graph). Best-effort:
 *  any read failure returns the original choice. */
export async function redirectForCoverage(svc: Svc, agentId: string, now = new Date()): Promise<string> {
  try {
    const { data: a } = await svc.from("agents")
      .select("covering_agent_id, coverage_until").eq("id", agentId).maybeSingle()
    const covered = coverageRedirect({
      coveringAgentId: (a as any)?.covering_agent_id ?? null,
      coverageUntil: (a as any)?.coverage_until ?? null,
    }, now)
    return covered ?? agentId
  } catch {
    return agentId
  }
}
