import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

/**
 * TEAM SCOPE — the app half of m473's rule, ONE vocabulary with the database.
 *
 * OWNER RULING: "a team is a mini version of a brokerage … the team lead needs
 * to see finaincials pertaining to their contacts and their team and be able to
 * set the caps and percentages of their agents."
 *
 * ── THE ANCHOR ───────────────────────────────────────────────────────────────
 * Leading a team is the FACT `teams.team_lead_id = <users.id>`, never a
 * user_type. MEASURED live: the one real team's lead carries user_type 'agent',
 * so any seat-anchored rule refuses the actual lead; and a user_type
 * 'team_lead' who leads no team row leads nothing. m473 moved every RLS lane
 * onto the FACT; these helpers are the same rule for the SERVICE-CLIENT
 * actions, where RLS is bypassed and the app predicate is the only gate.
 *
 * ── WHY THE MEMBERSHIP QUESTION IS AN RPC, NOT A SECOND QUERY ────────────────
 * "Which team is this agent on" is answered live by public.agent_team_id(),
 * whose resolution order (lead's own team → users.team_id → active
 * team_members row → agents.team_id) is exactly what RLS applies. Re-implementing
 * that order here would be a second vocabulary that drifts the first time one
 * side changes — the class of defect this whole wave removes. The function is
 * SECURITY DEFINER and takes the agent id as a parameter, so it answers
 * identically under the service role (no auth.uid() dependency).
 */

type Svc = ReturnType<typeof createServiceClient>

/** The team this user LEADS (`teams.team_lead_id`), or null — same one query as SQL. */
export async function resolveLedTeamId(
  svc: Svc,
  userId: string,
): Promise<{ ok: true; teamId: string | null } | { ok: false; error: string }> {
  // DESTRUCTURE THE ERROR: supabase-js resolves a refused query, and "the read
  // was refused" must not be reported as "you lead nothing".
  const { data, error } = await svc
    .from("teams")
    .select("id")
    .eq("team_lead_id", userId)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle()
  if (error) return { ok: false, error: `Could not resolve your team: ${error.message}` }
  return { ok: true, teamId: data?.id ?? null }
}

/**
 * Does this user LEAD the team the target agent is on?
 *
 * The authority behind "set the caps and percentages of THEIR agents": true
 * only when the caller's led team and the agent's resolved team are both
 * non-null and equal. Returns a RESULT, not a boolean — a refused read must be
 * reported as a refusal, never as "not your agent".
 */
export async function leadsAgentsTeam(
  svc: Svc,
  userId: string,
  agentId: string,
): Promise<{ ok: true; leads: boolean; ledTeamId: string | null } | { ok: false; error: string }> {
  const led = await resolveLedTeamId(svc, userId)
  if (!led.ok) return led
  if (!led.teamId) return { ok: true, leads: false, ledTeamId: null }

  const { data: agentTeam, error } = await svc.rpc("agent_team_id", { p_agent_id: agentId })
  if (error) return { ok: false, error: `Could not resolve the agent's team: ${error.message}` }
  return { ok: true, leads: !!agentTeam && agentTeam === led.teamId, ledTeamId: led.teamId }
}
