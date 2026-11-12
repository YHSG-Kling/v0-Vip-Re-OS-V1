/**
 * app/dashboard/settings/territories/territory-rules.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE rules for territory coverage. No I/O, no supabase, no session — so the
 * simulator can execute them directly rather than only grepping for them.
 *
 * This module is deliberately NOT a "use server" file: every export here is a
 * plain function, shared by the server actions (app/actions/settings/territories.ts),
 * the client component, and scripts/territory-settings-simulator.ts. One copy of
 * the rule, three readers — the shape lib/auth/require-brokerage-admin.ts exists
 * to enforce after W47 found the same authorisation rule written three times and
 * corrected once.
 *
 * ── THE THREE GRAINS ────────────────────────────────────────────────────────
 * subscriber_service_areas carries brokerage_id, team_id and agent_user_id, and
 * the combination is not decoration — it is the grain of the claim:
 *
 *   brokerage  team_id NULL,     agent_user_id NULL      "this brokerage covers 90210"
 *   team       team_id set,      agent_user_id NULL      "the Westside team covers 90210"
 *   agent      agent_user_id set                         "Dana covers 90210"
 *
 * All three can be true at once; they are separate rows, not conflicting ones.
 * MEASURED: lib/platform/distribution-engine.ts reads ONLY the brokerage grain
 * (`.is("agent_user_id", null).is("team_id", null)`) when rotating platform leads,
 * so the brokerage row is the one that decides whether the tenant receives leads
 * at all, and the team/agent rows are internal routing detail the platform never
 * sees. Anything in this module that blurs that distinction is a bug.
 *
 * ── agent_user_id IS A users.id ─────────────────────────────────────────────
 * Not an agents.id. The column name says so and the FK map agrees
 * (scripts/schema-fk-map.ts records only brokerage_id → brokerages for this table).
 * The E&O defect in scripts/license-eo-record-simulator.ts was exactly this class:
 * agent_licenses.agent_id (an AGENTS id) compared against user.id (a USERS id),
 * two id spaces that never overlap, so the lookup found nothing and the action
 * reported success. Every writer here uses users.id and the simulator asserts it.
 */

/** ZIPs are five digits. The market sync already filtered on this; so do we. */
export const ZIP_RE = /^\d{5}$/

export type TerritoryGrain = "brokerage" | "team" | "agent"

export const TERRITORY_GRAINS: readonly TerritoryGrain[] = ["brokerage", "team", "agent"] as const

/** The two nullable grain columns, as they are written to the row. */
export interface GrainColumns {
  team_id: string | null
  agent_user_id: string | null
}

/** A row's grain is DERIVED from its columns, never stored — there is no grain column. */
export function grainOf(row: { team_id?: string | null; agent_user_id?: string | null }): TerritoryGrain {
  if (row.agent_user_id) return "agent"
  if (row.team_id) return "team"
  return "brokerage"
}

/**
 * ZIP parsing that REFUSES rather than silently dropping.
 *
 * syncServiceAreasForMarket filters with `.filter(z => /^\d{5}$/.test(z))` — a
 * silent drop. Typing "9021" there claims nothing and says nothing. Here the
 * rejects come back so the caller can put them in front of the person who typed
 * them.
 */
export function parseZipInput(raw: string): { zips: string[]; rejected: string[] } {
  const tokens = String(raw ?? "")
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  const zips: string[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  for (const t of tokens) {
    if (!ZIP_RE.test(t)) {
      if (!rejected.includes(t)) rejected.push(t)
      continue
    }
    if (seen.has(t)) continue
    seen.add(t)
    zips.push(t)
  }
  return { zips, rejected }
}

/**
 * Turn a requested grain + ids into the columns to write, or say why not.
 * A grain that needs an id and did not get one is a REFUSAL, not a fallback to
 * brokerage-wide — silently widening a claim from "Dana's zips" to "the whole
 * brokerage's zips" is how a tenant starts receiving leads nobody claimed.
 */
export function resolveGrainColumns(
  grain: TerritoryGrain,
  ids: { teamId?: string | null; agentUserId?: string | null },
): { ok: true; columns: GrainColumns } | { ok: false; reason: string } {
  const teamId = ids.teamId?.trim() || null
  const agentUserId = ids.agentUserId?.trim() || null

  if (grain === "brokerage") {
    if (teamId || agentUserId) {
      return { ok: false, reason: "A brokerage-wide territory carries no team and no agent." }
    }
    return { ok: true, columns: { team_id: null, agent_user_id: null } }
  }
  if (grain === "team") {
    if (!teamId) return { ok: false, reason: "Pick a team for a team territory." }
    if (agentUserId) return { ok: false, reason: "A team territory carries no agent — use an agent territory instead." }
    return { ok: true, columns: { team_id: teamId, agent_user_id: null } }
  }
  if (grain === "agent") {
    if (!agentUserId) return { ok: false, reason: "Pick an agent for an agent territory." }
    // team_id on an agent claim is context, not key — see uq_service_area_agent_zip
    // in m462, which keys on (brokerage_id, agent_user_id, zip_code) only.
    return { ok: true, columns: { team_id: teamId, agent_user_id: agentUserId } }
  }
  return { ok: false, reason: `Unknown territory grain: ${String(grain)}` }
}

/**
 * WHO the caller is, resolved from the SESSION by the action layer and never
 * from a prop or an argument.
 *
 * `ledTeamIds` is a FACT, not a role label: it is the set of teams whose
 * teams.team_lead_id equals this user's id. A user_type or a role string saying
 * "team_lead" is a claim about a person; team_lead_id is the record of which team
 * they actually lead, and only the record can answer "their own team".
 */
export interface TerritoryViewer {
  userId: string
  brokerageId: string
  isBrokerageAdmin: boolean
  ledTeamIds: string[]
}

export interface TerritoryTarget {
  grain: TerritoryGrain
  teamId: string | null
  agentUserId: string | null
}

export type AuthzVerdict = { ok: true } | { ok: false; reason: string }

/**
 * The grain gate.
 *
 *   brokerage admin  → any grain in their own tenant
 *   team lead        → the team grain, for a team they actually lead
 *   agent            → the agent grain, for themselves
 *
 * Nothing here can cross a tenant: the action layer only ever supplies the
 * session's own brokerageId, and RLS
 * (subscriber_service_areas_tenant_* → brokerage_id = current_user_brokerage_id())
 * refuses cross-tenant writes underneath regardless. This gate sits INSIDE the
 * database boundary and narrows it; it never exceeds it.
 */
export function authorizeTerritoryWrite(viewer: TerritoryViewer, target: TerritoryTarget): AuthzVerdict {
  if (!viewer.userId || !viewer.brokerageId) {
    return { ok: false, reason: "No session tenant — sign in again." }
  }
  if (viewer.isBrokerageAdmin) return { ok: true }

  if (target.grain === "brokerage") {
    return { ok: false, reason: "Only a brokerage admin can set brokerage-wide coverage." }
  }
  if (target.grain === "team") {
    if (target.teamId && viewer.ledTeamIds.includes(target.teamId)) return { ok: true }
    return { ok: false, reason: "You can only set coverage for a team you lead." }
  }
  if (target.grain === "agent") {
    if (target.agentUserId && target.agentUserId === viewer.userId) return { ok: true }
    return { ok: false, reason: "You can only set your own coverage." }
  }
  return { ok: false, reason: `Unknown territory grain: ${String(target.grain)}` }
}

/**
 * Whether a claim is what the platform distribution rotation actually reads.
 * MEASURED against lib/platform/distribution-engine.ts step 6, which selects
 * subscriber_service_areas WHERE zip_code = ? AND active AND agent_user_id IS
 * NULL AND team_id IS NULL. A team or agent claim is real, and it routes NOTHING
 * from the platform — the UI says so rather than implying every claim earns leads.
 */
export function feedsPlatformRotation(row: {
  team_id?: string | null
  agent_user_id?: string | null
  active?: boolean | null
}): boolean {
  return grainOf(row) === "brokerage" && row.active !== false
}
