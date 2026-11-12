import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { resolveLedTeamId } from "@/lib/kernel/resolve-user-team"

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

// TOMBSTONE (§1 orphan doctrine, DUPLICATES ROUND 3, 2026-09-11): resolveLedTeamId
// used to live here, doing the SAME job as lib/kernel/resolve-user-team.ts's
// function of the same name — same `teams.team_lead_id` fact, same purpose,
// two spellings. That survivor fixed a DIFFERENT bug this copy did not
// (multiple led teams answered non-deterministically); this copy's own fix — a
// REFUSED read must report `{ ok: false, error }`, never collapse to "leads
// nobody" — is now merged ONTO the survivor at lib/kernel/resolve-user-team.ts:139,
// which returns exactly the `{ ok, teamId } | { ok: false, error }` shape this
// file used to. All three callers (commission-agreement.ts, team-members.ts,
// qr-management.ts) now import the survivor directly; nothing in the tree
// imports resolveLedTeamId from this file anymore.

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
