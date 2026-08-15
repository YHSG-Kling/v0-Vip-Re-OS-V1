// lib/kernel/resolve-user-team.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ANSWER to "which team is this person on?" — the app-side twin of
// public.resolve_team_id() (migration m431), and the same shape as
// lib/kernel/resolve-user-office.ts, which is the one answer for a person's
// OFFICE and exists for exactly the same reason.
//
// There are FOUR places a team can be recorded and all four exist, which is
// precisely why this has to be one function rather than a `??` written out at
// each call site. Measured on the live database:
//
//   teams.team_lead_id  — FK → users(id). The team's LEAD. The only team
//                         relationship the `teams` table declares itself, and
//                         the ONLY populated team fact on the database.
//   users.team_id       — FK → teams(id). The PERSON's team. Read by
//                         dispatch-showing, connection-center, financials
//                         (logScopedExpense), seller-listing/execution-engine,
//                         podcast-generation and buyer-offer/submit-to-compliance,
//                         and surfaced as AgentContext.teamId.
//   team_members        — the junction, with split_percent, source_of_funds,
//                         effective dating and is_active. Read by
//                         getTeamDashboard, lib/finance/team-pl-writer and
//                         app/actions/admin/team-members.ts, its only writer.
//   agents.team_id      — FK → teams(id). The producing AGENT's team. Read by
//                         app/team/[slug] — the PUBLIC team site roster.
//
// So app/team/[slug] and lib/finance/team-pl-writer can DISAGREE about who is on
// a team right now, on live data: the public roster reads agents.team_id and the
// team P&L reads team_members, and today those two sources hold different
// answers. Neither is wrong; there was simply no rule.
//
// PRECEDENCE IS LEAD-LINK FIRST, and each step is a decision rather than an
// ordering accident:
//
//   1. teams.team_lead_id — if you LEAD a team, that is your team, full stop.
//      It also survives a lead who has no `agents` row. requiresAgentRow()
//      (lib/kernel/tenant-provisioning-spec.ts) puts 'team_lead' in AGENT_ROLES
//      so a correctly provisioned lead always has one — but the single live
//      user_type='team_lead' account does not, so that path is real today.
//   2. users.team_id — m423's rule transplanted: the person's own record is what
//      an admin last set deliberately, and it is the only option for someone
//      with no `agents` row. Same direction resolve-user-office.ts takes when it
//      puts users.location_id above agents.location_id.
//   3. team_members, active — the rich model, and a deliberate admin act ("add
//      this agent to this team at this split") through admin/team-members.ts.
//   4. agents.team_id — last, because it is also written by provisioning and
//      import paths. The explicit act wins, again m423's rule.
//
// NULL means NOT ON A TEAM, and here that is FAIL-CLOSED — the opposite of
// resolve-user-office.ts, where NULL means "not pinned, so see everything". The
// direction is inverted on purpose: an unpinned office WIDENS an admin to their
// whole brokerage, which is the right reading of "no narrowing was ever
// applied". An unresolved TEAM must never widen a team lead to their whole
// brokerage, because the owner's ruling — "teams should only see their own
// board" — IS the narrowing. A team lead with no resolvable team gets an empty
// board and is told so, not the brokerage's book.

import type { SupabaseClient } from "@supabase/supabase-js"

export type UserTeamSource = "lead" | "user" | "member" | "agent" | "none"

export interface UserTeam {
  teamId: string | null
  /** Where the answer came from — for surfaces that explain a scope to a human. */
  source: UserTeamSource
}

/**
 * The precedence rule itself, as a pure function.
 *
 * MODULE-PRIVATE ON PURPOSE, unlike its twin pickUserOffice.
 *
 * It was written exported, to mirror pickUserOffice — which five callers use
 * because they already hold the user and agent rows and would otherwise re-query
 * to re-derive what they are holding. No caller holds all FOUR team sources
 * today, so exporting this published a function with nothing on the other end,
 * and test:orphan-exports said so: "a new export with no caller is an unfinished
 * feature."
 *
 * It is not deleted and it is not unfinished — resolveUserTeam() below calls it
 * three times and IS wired (app/dashboard/team/page.tsx). It is simply internal
 * until a caller genuinely holds the rows. Export it that day; a speculative
 * export is the same dead weight as a column with no writer, which is exactly
 * what this codebase keeps clearing out.
 */
function pickUserTeam(
  leadOfTeamId: string | null | undefined,
  userTeamId: string | null | undefined,
  memberTeamId: string | null | undefined,
  agentTeamId: string | null | undefined,
): UserTeam {
  if (leadOfTeamId) return { teamId: leadOfTeamId, source: "lead" }
  if (userTeamId) return { teamId: userTeamId, source: "user" }
  if (memberTeamId) return { teamId: memberTeamId, source: "member" }
  if (agentTeamId) return { teamId: agentTeamId, source: "agent" }
  return { teamId: null, source: "none" }
}

/** An active team_members row: is_active AND not past its effective_to.
 *
 *  removeTeamMember() (app/actions/admin/team-members.ts) sets both together, so
 *  on any row the existing readers see the two agree. Checking both anyway is
 *  strictly narrower than the `is_active` those readers use, and narrowing is
 *  the safe direction here: the only thing it can ever do is drop somebody who
 *  has already left the team out of that team's money. Matches the same pair of
 *  conditions in public.resolve_team_id().
 */
function isCurrentMembership(row: { is_active?: boolean | null; effective_to?: string | null }): boolean {
  if (!row.is_active) return false
  if (!row.effective_to) return true
  return row.effective_to >= new Date().toISOString().slice(0, 10)
}

/**
 * "DO YOU LEAD A TEAM?" — the app-side twin of public.current_user_led_team_id()
 * (migration m444), which returns `teams.id WHERE team_lead_id = auth.uid() AND
 * deleted_at IS NULL`. Same query, same NULL, same fail-closed reading.
 *
 * THIS IS THE ONLY LEGITIMATE TEST FOR "IS A TEAM LEAD", and the reason it has to
 * exist separately from resolveUserTeam() is that the two questions are NOT the
 * same question. resolveUserTeam() answers "which team is this person ON" and
 * falls through four sources, so it returns a team for an ordinary member too.
 * "Do you LEAD one" has exactly one source — the `teams.team_lead_id` FK — and a
 * member must answer NO.
 *
 * The owner's ruling is "a team lead is an agent that runs their own team", and
 * measured on the live database the `user_type` label is INVERTED on both
 * accounts that exist: teamlead@vip.demo is user_type='agent' and runs one team,
 * while buyer@yourbrokerage.com is user_type='team_lead' and runs none. So
 * `user_type === 'team_lead'` gives the real lead a personal-only scope and hands
 * the other account a team scope for a team that does not exist. A ROLE LABEL IS
 * NOT A FACT; the FK is.
 *
 * NULL is fail-closed here for the reason set out in this module's header: an
 * unresolved TEAM must never widen anybody to their brokerage. A refused read is
 * logged loudly because supabase-js RESOLVES it, and NULL cannot distinguish
 * "permission denied" from "leads nobody".
 */
export async function resolveLedTeamId(
  client: SupabaseClient<any, any, any>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("teams")
    .select("id")
    .eq("team_lead_id", userId)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle()

  if (error) {
    console.error(`[resolve-user-team] teams read REFUSED for ${userId}: ${error.message}`)
    return null
  }
  return (data as { id?: string } | null)?.id ?? null
}

/**
 * Resolve one person's team. `client` must be a service client or a session
 * client that can read `teams`, `users`, `team_members` and `agents`.
 *
 * `agentId` (agents.id) is optional and is used only to find a team_members row
 * for someone whose agents row this function would otherwise have to look up
 * twice — pass it when you have it.
 *
 * Errors are DESTRUCTURED and logged rather than swallowed: supabase-js resolves
 * a refused read, so `const { data }` alone would turn "permission denied" into
 * "this person has no team". Because NULL is fail-closed here, a refused read
 * degrades to an EMPTY board rather than to a widened one — but it is still
 * indistinguishable from genuinely having no team, so the log line is the only
 * way to tell them apart. Say so loudly.
 */
export async function resolveUserTeam(
  client: SupabaseClient<any, any, any>,
  userId: string,
  agentId?: string | null,
): Promise<UserTeam> {
  // Step 1 IS the lead-link question, so it is the same call resolveLedTeamId()
  // makes rather than a second copy of that query written out here.
  const ledOf = await resolveLedTeamId(client, userId)
  if (ledOf) return pickUserTeam(ledOf, null, null, null)

  const { data: userRow, error: userErr } = await client
    .from("users")
    .select("team_id")
    .eq("id", userId)
    .maybeSingle()

  if (userErr) {
    console.error(`[resolve-user-team] users read REFUSED for ${userId}: ${userErr.message}`)
  }
  const fromUser = (userRow as { team_id?: string | null } | null)?.team_id ?? null
  if (fromUser) return pickUserTeam(null, fromUser, null, null)

  // The agents row answers step 4 directly and supplies the id step 3 needs, so
  // it is read once and used for both.
  const { data: agentRow, error: agentErr } = await client
    .from("agents")
    .select("id, team_id")
    .eq("user_id", userId)
    .maybeSingle()

  if (agentErr) {
    console.error(`[resolve-user-team] agents read REFUSED for ${userId}: ${agentErr.message}`)
  }
  const resolvedAgentId = agentId ?? (agentRow as { id?: string } | null)?.id ?? null
  const fromAgent = (agentRow as { team_id?: string | null } | null)?.team_id ?? null

  let fromMember: string | null = null
  if (resolvedAgentId) {
    const { data: memberRows, error: memberErr } = await client
      .from("team_members")
      .select("team_id, is_active, effective_from, effective_to")
      .eq("agent_id", resolvedAgentId)
      .eq("is_active", true)
      .order("effective_from", { ascending: false })

    if (memberErr) {
      console.error(`[resolve-user-team] team_members read REFUSED for agent ${resolvedAgentId}: ${memberErr.message}`)
    }
    const current = ((memberRows ?? []) as Array<{ team_id: string; is_active: boolean; effective_to: string | null }>)
      .find(isCurrentMembership)
    fromMember = current?.team_id ?? null
  }

  return pickUserTeam(null, null, fromMember, fromAgent)
}

/**
 * The other direction: given a team, which `agents.id`s are on it RIGHT NOW.
 *
 * Not a plain union of the four sources — that would be WIDER than
 * resolveUserTeam() and the two would disagree, which is the exact defect this
 * module exists to end. Instead the four sources produce CANDIDATES, and each
 * candidate is then put back through the same precedence: an agent belongs to
 * this team only if the rule says this team is the one they are on. So the
 * roster and the individual answer can never contradict each other, and both
 * match what public.resolve_team_id() enforces in RLS.
 */
export async function resolveTeamAgentIds(
  client: SupabaseClient<any, any, any>,
  teamId: string,
): Promise<{ agentIds: string[]; degraded: string[] }> {
  const degraded: string[] = []

  // The team first and on its own: every other read is scoped to ITS brokerage,
  // not to the caller's. A service client is not subject to RLS, so an unscoped
  // `select` here would pull every agent on the platform into the candidate set.
  const teamRes = await client
    .from("teams")
    .select("id, team_lead_id, brokerage_id")
    .eq("id", teamId)
    .is("deleted_at", null)
    .maybeSingle()

  if (teamRes.error) {
    console.error(`[resolve-team-agents] teams read REFUSED for ${teamId}: ${teamRes.error.message}`)
    degraded.push("teams")
  }
  const team = teamRes.data as { id: string; team_lead_id: string | null; brokerage_id: string } | null
  if (!team) return { agentIds: [], degraded }

  const [agentsRes, membersRes] = await Promise.all([
    client.from("agents").select("id, user_id, team_id").eq("brokerage_id", team.brokerage_id),
    client.from("team_members").select("agent_id, team_id, is_active, effective_from, effective_to")
      .eq("brokerage_id", team.brokerage_id),
  ])

  if (agentsRes.error) {
    console.error(`[resolve-team-agents] agents read REFUSED: ${agentsRes.error.message}`)
    degraded.push("agents")
  }
  if (membersRes.error) {
    console.error(`[resolve-team-agents] team_members read REFUSED: ${membersRes.error.message}`)
    degraded.push("team_members")
  }

  const agents = (agentsRes.data ?? []) as Array<{ id: string; user_id: string; team_id: string | null }>
  const memberships = ((membersRes.data ?? []) as Array<{
    agent_id: string; team_id: string; is_active: boolean; effective_from: string | null; effective_to: string | null
  }>)
    .filter(isCurrentMembership)
    .sort((a, b) => (b.effective_from ?? "").localeCompare(a.effective_from ?? ""))

  // users.team_id, for the candidates only — the one source not already in hand.
  const candidateUserIds = agents.map((a) => a.user_id)
  const userTeamById = new Map<string, string | null>()
  if (candidateUserIds.length > 0) {
    const { data: userRows, error: userErr } = await client
      .from("users")
      .select("id, team_id")
      .in("id", candidateUserIds)
    if (userErr) {
      console.error(`[resolve-team-agents] users read REFUSED: ${userErr.message}`)
      degraded.push("users")
    }
    for (const u of (userRows ?? []) as Array<{ id: string; team_id: string | null }>) {
      userTeamById.set(u.id, u.team_id)
    }
  }

  const agentIds = agents
    .filter((a) => {
      const led = team.team_lead_id === a.user_id ? team.id : null
      const member = memberships.find((m) => m.agent_id === a.id)?.team_id ?? null
      return pickUserTeam(led, userTeamById.get(a.user_id) ?? null, member, a.team_id).teamId === teamId
    })
    .map((a) => a.id)

  return { agentIds, degraded }
}
