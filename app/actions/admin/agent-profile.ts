"use server"

/**
 * app/actions/admin/agent-profile.ts
 *
 * PEOPLE-OPS CONSOLIDATION — brings an agent's real-estate profile fields onto
 * the brokerage-admin user-edit surface, instead of scattering them across
 * separate license-tracking / locations pages. Reads/writes the LIVE columns only
 * (verified against the DB): agents.license_number / license_state /
 * license_expiry / commission_split / location_id. (mls_id / commission_tier are
 * migration-only drift and do NOT exist live, so they are intentionally omitted.)
 *
 * Admin-gated (broker / broker_admin / admin / superadmin / team_lead) with
 * identity resolved server-side; the target agent must belong to the caller's own
 * brokerage. Mirrors the locations.ts / assignment-rules.ts admin pattern.
 */

import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { leadsAgentsTeam } from "@/lib/teams/team-scope"
import { resolveUserTeam, type UserTeamSource } from "@/lib/kernel/resolve-user-team"

/**
 * Finance admin, OR the LEAD of the target agent's team (m473, owner ruling:
 * "the team lead needs to … be able to set the caps and percentages of their
 * agents"). Every write below goes through the SERVICE client, so this gate is
 * the only gate — and it now mirrors the RLS lanes exactly: brokerage-wide for
 * the finance roster, row-scoped by teams.team_lead_id for the lead. Leading is
 * the FK FACT, never a user_type: the live team's lead carries user_type
 * 'agent', and a 'team_lead' seat that leads no team row leads nothing.
 */
async function requireAdmin(targetUserId?: string): Promise<
  | { ok: true; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId || !ctx.userId) return { ok: false, error: "Unauthorized" }
  if (isBrokerageFinanceAdmin({ user_type: ctx.userType })) {
    return { ok: true, brokerageId: ctx.brokerageId, userType: ctx.userType }
  }
  if (targetUserId) {
    const svc = createServiceClient()
    const { data: agent, error } = await svc
      .from("agents").select("id, brokerage_id").eq("user_id", targetUserId).maybeSingle()
    // A refused read is an outage, not a denial — do not tell a lead they are
    // not one because a lookup failed.
    if (error) return { ok: false, error: `Could not resolve the target agent: ${error.message}` }
    if (agent && agent.brokerage_id === ctx.brokerageId) {
      const lead = await leadsAgentsTeam(svc, ctx.userId, agent.id)
      if (!lead.ok) return { ok: false, error: lead.error }
      if (lead.leads) return { ok: true, brokerageId: ctx.brokerageId, userType: ctx.userType }
    }
  }
  return { ok: false, error: "Forbidden" }
}

export interface AgentProfile {
  agentId: string
  licenseNumber: string | null
  licenseState: string | null
  licenseExpiry: string | null
  commissionSplit: number | null
  /**
   * The TEAM cut this agent negotiated, from
   * `agent_commission_profiles.team_override_percent` — a WHOLE PERCENTAGE
   * (15 = 15%), the same units as the `teams.team_split_percent` it overrides.
   * `null` means nothing was negotiated and the team's standing terms apply.
   */
  teamOverridePercent: number | null
  /**
   * True when the negotiated term could NOT be read. Deliberately separate from
   * a `null` term: "we could not check" and "there is no negotiated term" are
   * different statements, and a form that renders them identically tells a broker
   * that an agreement does not exist when it may simply be unreadable.
   */
  teamOverrideUnavailable: boolean
  locationId: string | null
  /**
   * The RESOLVED team, through lib/kernel/resolve-user-team.ts — the ONE
   * precedence rule (lead-link > users.team_id > active team_members row >
   * agents.team_id). Restored to this surface with the deleted
   * app/actions/agents.ts:updateAgent's team field (owner ruling, lane F2
   * 2026-08-28); resolved rather than read off one column because a team
   * membership can be recorded in FOUR places and this form must show the
   * answer the platform actually enforces.
   */
  teamId: string | null
  /** Where the resolved team came from — "member" means an active roster row
   *  (with split terms) at Team → Members, which this form cannot tear up. */
  teamSource: UserTeamSource
  /**
   * `agents.specializations` split into tags. The live column is
   * `character varying`, NOT `text[]` (verified against information_schema —
   * see app/portal/[contactId]/team/page.tsx, the reader this parse mirrors):
   * comma-separated in the database, an array at this boundary.
   */
  specializations: string[]
}

export interface OfficeOption {
  id: string
  name: string
}

export interface TeamOption {
  id: string
  name: string
}

/**
 * Load an agent's profile fields + the brokerage's office list for the user-edit
 * surface. Returns `agent: null` when the target user has no agents row (e.g. a
 * TC/vendor) — the caller renders the agent card only when present.
 */
export async function getAgentProfileForUserAction(
  targetUserId: string,
): Promise<
  | { ok: true; agent: AgentProfile | null; offices: OfficeOption[]; teams: TeamOption[] }
  | { ok: false; error: string }
> {
  const auth = await requireAdmin(targetUserId)
  if (!auth.ok) return auth
  const svc = createServiceClient()

  // Target must belong to the caller's brokerage.
  const { data: target } = await svc
    .from("users")
    .select("id, brokerage_id")
    .eq("id", targetUserId)
    .maybeSingle()
  if (!target) return { ok: false, error: "User not found" }
  if ((target as { brokerage_id: string | null }).brokerage_id !== auth.brokerageId) {
    return { ok: false, error: "User belongs to a different brokerage" }
  }

  const [{ data: agent }, { data: offices }, { data: teams }] = await Promise.all([
    svc
      .from("agents")
      .select("id, license_number, license_state, license_expiry, commission_split, location_id, specializations")
      .eq("user_id", targetUserId)
      .eq("brokerage_id", auth.brokerageId)
      .maybeSingle(),
    svc.from("locations").select("id, name").eq("brokerage_id", auth.brokerageId).order("name"),
    svc.from("teams").select("id, name").eq("brokerage_id", auth.brokerageId).is("deleted_at", null).order("name"),
  ])

  // The negotiated team term lives on agent_commission_profiles, NOT on the
  // agents row — a second query rather than a wider select, because they are
  // different tables. Reading it off `agents` would have made this function an
  // instance of the phantom-column class it exists to expose.
  //
  // Sequenced after the agents read because it needs the resolved agents.id;
  // `error` is checked so a refused read is not rendered as "nothing negotiated",
  // which is a materially different statement to a broker looking at the form.
  let teamOverridePercent: number | null = null
  let teamOverrideUnavailable = false
  if (agent) {
    const { data: profile, error: profileErr } = await svc
      .from("agent_commission_profiles")
      .select("team_override_percent")
      .eq("agent_id", (agent as { id: string }).id)
      .eq("brokerage_id", auth.brokerageId)
      .eq("is_active", true)
      .maybeSingle()
    if (profileErr) {
      teamOverrideUnavailable = true
    } else {
      const raw = (profile as { team_override_percent?: unknown } | null)?.team_override_percent
      teamOverridePercent = raw === null || raw === undefined || raw === "" ? null : Number(raw)
    }
  }

  // The RESOLVED team — the ONE precedence rule, not a raw column read (a team
  // membership lives in four places; showing one column would lie whenever the
  // sources disagree, which they do on live data).
  let teamId: string | null = null
  let teamSource: UserTeamSource = "none"
  if (agent) {
    const resolved = await resolveUserTeam(svc, targetUserId, (agent as { id: string }).id)
    teamId = resolved.teamId
    teamSource = resolved.source
  }

  return {
    ok: true,
    offices: (offices ?? []).map((o: Record<string, unknown>) => ({ id: o.id as string, name: o.name as string })),
    teams: (teams ?? []).map((t: Record<string, unknown>) => ({ id: t.id as string, name: t.name as string })),
    agent: agent
      ? {
          agentId: (agent as any).id,
          licenseNumber: (agent as any).license_number ?? null,
          licenseState: (agent as any).license_state ?? null,
          licenseExpiry: (agent as any).license_expiry ?? null,
          commissionSplit: (agent as any).commission_split ?? null,
          teamOverridePercent,
          /** True when the negotiated term could NOT be read — not the same as "none". */
          teamOverrideUnavailable,
          locationId: (agent as any).location_id ?? null,
          teamId,
          teamSource,
          // varchar in the DB, tags at the boundary — same comma parse as the
          // portal reader (null and "" both become []).
          specializations: String((agent as any).specializations ?? "")
            .split(",")
            .map((s: string) => s.trim())
            .filter(Boolean),
        }
      : null,
  }
}

export interface UpdateAgentProfileInput {
  targetUserId: string
  licenseNumber?: string | null
  licenseState?: string | null
  licenseExpiry?: string | null // YYYY-MM-DD or null
  commissionSplit?: number | null
  /**
   * `agent_commission_profiles.team_override_percent` — the TEAM cut this agent
   * negotiated before signing (owner ruling: "all commission agreements can be
   * negotiated per agent before signing").
   *
   * `undefined` LEAVES IT ALONE. `null` CLEARS it, which reverts this agent to
   * their team's standing terms. Those are different acts and the action must not
   * conflate them — a form that omits the field would otherwise silently tear up
   * a negotiated agreement.
   */
  teamOverridePercent?: number | null
  locationId?: string | null
  /**
   * TEAM ASSIGNMENT (restored with the deleted app/actions/agents.ts:updateAgent's
   * team field — owner ruling, lane F2 2026-08-28). `undefined` leaves it alone;
   * a team id assigns; `null` clears the assignment.
   *
   * WHAT WAS FOUND before wiring this (the owner's compare-the-process rule):
   * team membership is recorded in FOUR places, unified by ONE precedence rule
   * (public.resolve_team_id / lib/kernel/resolve-user-team.ts): lead-link >
   * users.team_id > active team_members row > agents.team_id. `team_members` is
   * the MONEY roster — split_percent + source_of_funds, written only by the
   * sanctioned door app/actions/admin/team-members.ts and read by the commission
   * waterfall — so an org-chart assignment from this form must NOT invent a
   * roster row (it has no split terms to put on it) and must NOT tear one up
   * (that is a commission agreement). This action therefore writes the two
   * plain assignment columns — users.team_id (the precedence rule's "what an
   * admin last set deliberately" slot, which OUTRANKS the roster) and
   * agents.team_id (kept in agreement for its raw readers: the public team
   * site, career-tier) — and on a CLEAR reports honestly when an active roster
   * row still binds the agent to a team, pointing at Team → Members.
   */
  teamId?: string | null
  /**
   * Specializations — the expertise tags lead routing (lib/lead-assignment),
   * mentor matching and the client portal read. `undefined` leaves them alone;
   * `null` or `[]` clears. Stored COMMA-SEPARATED: `agents.specializations` is
   * `character varying`, NOT `text[]` (verified live — the old deleted
   * updateAgent typed this string[] and wrote it raw at a varchar column).
   */
  specializations?: string[] | null
}

export async function updateAgentProfileAction(
  input: UpdateAgentProfileInput,
): Promise<{ ok: true; note?: string } | { ok: false; error: string }> {
  const auth = await requireAdmin(input.targetUserId)
  if (!auth.ok) return auth
  const svc = createServiceClient()

  // TEAM ASSIGNMENT is a brokerage-level org act — finance-admin roster only.
  // requireAdmin also admits the agent's TEAM LEAD (for caps and percentages,
  // m473), but a lead moving their agent onto a different team is not a power
  // the owner ruled they have.
  if (input.teamId !== undefined && !isBrokerageFinanceAdmin({ user_type: auth.userType })) {
    return { ok: false, error: "Only a broker or admin can change an agent's team assignment." }
  }
  // Validate the target team belongs to the session brokerage (§4) BEFORE any
  // write, so a failed validation leaves nothing half-assigned.
  if (input.teamId) {
    const { data: team, error: teamErr } = await svc
      .from("teams")
      .select("id")
      .eq("id", input.teamId)
      .eq("brokerage_id", auth.brokerageId)
      .is("deleted_at", null)
      .maybeSingle()
    if (teamErr) return { ok: false, error: `Could not verify the team: ${teamErr.message}` }
    if (!team) return { ok: false, error: "Team not found for this brokerage" }
  }

  // Resolve the agent row, pinned to the caller's brokerage.
  const { data: agent } = await svc
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", input.targetUserId)
    .maybeSingle()
  if (!agent) return { ok: false, error: "This user is not an agent (no agent profile to edit)" }
  if ((agent as { brokerage_id: string | null }).brokerage_id !== auth.brokerageId) {
    return { ok: false, error: "Agent belongs to a different brokerage" }
  }

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (input.licenseNumber !== undefined) patch.license_number = input.licenseNumber?.trim() || null
  if (input.licenseState !== undefined) patch.license_state = input.licenseState?.trim()?.toUpperCase() || null
  if (input.licenseExpiry !== undefined) patch.license_expiry = input.licenseExpiry || null
  if (input.teamId !== undefined) patch.team_id = input.teamId || null

  // Specializations — sanitized to what the varchar column and its readers can
  // hold: comma is the SEPARATOR (the portal reader splits on it), so it is
  // stripped from items rather than smuggled through; blanks are dropped;
  // bounds are refused, not truncated (a silently shortened tag is not the tag
  // the admin typed).
  if (input.specializations !== undefined) {
    if (input.specializations === null) {
      patch.specializations = null
    } else {
      const items = input.specializations
        .map((s) => String(s).replace(/,/g, " ").replace(/\s+/g, " ").trim())
        .filter(Boolean)
      if (items.length > 20) {
        return { ok: false, error: "At most 20 specializations can be stored." }
      }
      const tooLong = items.find((s) => s.length > 60)
      if (tooLong) {
        return { ok: false, error: `Specialization "${tooLong.slice(0, 60)}…" is too long (max 60 characters).` }
      }
      patch.specializations = items.length > 0 ? items.join(", ") : null
    }
  }

  if (input.commissionSplit !== undefined) {
    if (input.commissionSplit === null) {
      patch.commission_split = null
    } else {
      const n = Number(input.commissionSplit)
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return { ok: false, error: "Commission split must be between 0 and 100" }
      }
      patch.commission_split = n
    }
  }

  // Office assignment — validate the office belongs to this brokerage first.
  if (input.locationId !== undefined) {
    if (input.locationId) {
      const { data: loc } = await svc
        .from("locations")
        .select("id")
        .eq("id", input.locationId)
        .eq("brokerage_id", auth.brokerageId)
        .maybeSingle()
      if (!loc) return { ok: false, error: "Office not found for this brokerage" }
      patch.location_id = input.locationId
    } else {
      patch.location_id = null
    }
  }

  const { error } = await svc.from("agents").update(patch).eq("id", (agent as { id: string }).id)
  if (error) return { ok: false, error: error.message }

  // ── TEAM ASSIGNMENT, second half ───────────────────────────────────────────
  // users.team_id is the precedence rule's "what an admin last set deliberately"
  // slot (public.resolve_team_id: lead-link > users.team_id > active
  // team_members row > agents.team_id) — writing agents.team_id alone would be
  // OUTRANKED by a stale roster row, so both plain assignment columns are set
  // and the resolver then answers with this admin's act. The roster
  // (team_members) is deliberately untouched: it carries commission split
  // terms and has its own sanctioned door (app/actions/admin/team-members.ts).
  let note: string | undefined
  if (input.teamId !== undefined) {
    const { data: userRows, error: userTeamErr } = await svc
      .from("users")
      .update({ team_id: input.teamId || null })
      .eq("id", input.targetUserId)
      .eq("brokerage_id", auth.brokerageId)
      .select("id")
    if (userTeamErr) {
      return { ok: false, error: `The agent record was updated but the team assignment was refused: ${userTeamErr.message}` }
    }
    // A zero-row update resolves with error null — "nothing was assigned" must
    // not render as "assigned".
    if (!userRows || userRows.length === 0) {
      return { ok: false, error: "The database accepted the request but assigned no team — the user record did not match." }
    }

    if (!input.teamId) {
      // CLEARING the explicit assignment cannot end a roster membership — the
      // precedence rule will fall through to any active team_members row, and
      // tearing that up here would silently void a commission agreement. Say
      // so instead of pretending the agent is off the team.
      const today = new Date().toISOString().slice(0, 10)
      const { data: memberRows, error: memberErr } = await svc
        .from("team_members")
        .select("team_id, effective_to")
        .eq("agent_id", (agent as { id: string }).id)
        .eq("is_active", true)
      if (memberErr) {
        note = `Team assignment cleared, but the team roster could not be checked (${memberErr.message}) — if this agent has an active roster membership at Team → Members, it still binds them to that team.`
      } else {
        const current = ((memberRows ?? []) as Array<{ team_id: string; effective_to: string | null }>).filter(
          (m) => !m.effective_to || m.effective_to >= today,
        )
        if (current.length > 0) {
          note =
            "Team assignment cleared, but this agent still has an active team-roster membership (with commission split terms). Remove it under Team → Members to fully detach them — it cannot be torn up from this form."
        }
      }
    }
  }

  // RULE-1 SYNC (single source of truth for commission structure). The commission
  // ENGINES resolve an agent's split from agent_commission_profiles.split_percent
  // (lib/brokerage/get-default-commission-structure), NOT from agents.commission_split
  // — so historically a broker "setting the split" here never reached the math. Mirror
  // the split onto the engine-authoritative profile so what the broker sets is what the
  // engine uses. agents.commission_split is kept (it has non-engine readers: onboarding
  // readiness, brokerage P&L rollup, the CDA display), so the two stay in lockstep.
  // Upsert on the unique agent_id; is_active=true so the engine's active-profile read
  // finds it; existing cap/fees on the profile are preserved (only split_percent is set).
  // THE NEGOTIATED TEAM TERM, validated before it can reach a money column.
  // Refused rather than rounded: a percentage silently moved by a fraction is not
  // the percentage that was agreed, and numeric(5,2) is what the column stores.
  let teamOverride: number | null | undefined
  if (input.teamOverridePercent !== undefined) {
    if (input.teamOverridePercent === null) {
      teamOverride = null
    } else {
      const n = Number(input.teamOverridePercent)
      // MEASURED, not assumed: `agent_commission_profiles.team_override_percent`
      // is numeric(6,4) — 2 digits before the point, 4 after — so its real
      // ceiling is 99.9999 and NOT 100. Validating to 100 would have handed
      // Postgres a value it refuses with a numeric-overflow error the broker
      // could not act on. Every SIBLING percent column here is numeric(5,2)
      // (split_percent, referral_percent, residual_percent, teams.team_split_percent,
      // agents.commission_split), so this one is the odd shape on the table; the
      // inconsistency is reported below rather than migrated mid-flight.
      if (!Number.isFinite(n) || n < 0 || n > 99.9999) {
        return {
          ok: false,
          // 100 is refused for a reason worth stating rather than hiding: a 100%
          // team override means the agent nets nothing from their own deal, which
          // is not an agreement anyone signs, and the column cannot store it.
          error: "The team's negotiated percentage must be between 0 and 99.9999.",
        }
      }
      if (Math.round(n * 10000) !== n * 10000) {
        return { ok: false, error: "The team's negotiated percentage can have at most 4 decimal places." }
      }
      teamOverride = n
    }
  }

  const writesSplit = input.commissionSplit !== undefined && input.commissionSplit !== null
  if (writesSplit || teamOverride !== undefined) {
    // ONE upsert for both, on the unique agent_id. Only the keys actually being
    // set are included, so saving a split never blanks a negotiated team term and
    // saving a team term never blanks the split.
    const profilePatch: Record<string, unknown> = {
      agent_id: (agent as { id: string }).id,
      brokerage_id: auth.brokerageId,
      is_active: true,
    }
    if (writesSplit) profilePatch.split_percent = patch.commission_split as number
    // `teamOverride === null` is a DELIBERATE clear (back to the team default) and
    // must be written; `undefined` means the caller did not touch the field.
    if (teamOverride !== undefined) profilePatch.team_override_percent = teamOverride

    const { data: profileRows, error: profileErr } = await svc
      .from("agent_commission_profiles")
      .upsert(profilePatch, { onConflict: "agent_id" })
      .select("id")
    if (profileErr) {
      return { ok: false, error: `Saved, but the commission engine did not pick it up: ${profileErr.message}` }
    }
    // A zero-row write arrives as `error: null`, so a resolved promise is not
    // proof. Without this the broker is told a negotiated term was stored when
    // the engine will still charge the team default — the exact silence this
    // whole change exists to end.
    if (!profileRows || profileRows.length === 0) {
      return {
        ok: false,
        error: "The database accepted the request but stored no commission profile, so the engine will keep using the previous terms.",
      }
    }
  }

  revalidatePath(`/dashboard/admin/users/${input.targetUserId}`)
  return { ok: true, note }
}
