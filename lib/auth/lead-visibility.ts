/**
 * lib/auth/lead-visibility.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ONE ANSWER TO "MAY THIS ACTOR REACH LEADS, AND OVER WHICH ROWS".
 *
 * OWNER RULING (this lane, verbatim):
 *
 *   "if team tier subscriptions, they don't have a broker in the subscription so
 *    the team lead can see leads."
 *
 * ── WHY A ROSTER ALONE COULD NOT CARRY THIS RULING ──────────────────────────
 *
 * Sixteen places used to answer "who sees leads", fifteen in the app and one in
 * SQL, and they disagreed: six admitted `team_lead`, nine refused it, the
 * database refused it. Every one of them was a ROSTER — a list of role strings —
 * and a roster can only say YES or NO. It cannot say "yes, but only over their
 * own team's rows", which is precisely what the ruling requires:
 *
 *   · On a TEAM-tier tenant the team IS the whole tenant, so team scope and
 *     brokerage scope are the same set of rows. That is exactly the owner's
 *     sentence: no broker in the subscription, and the team lead sees the leads.
 *   · On a BROKERAGE-tier tenant with several teams, the standing ruling
 *     "teams see only their own board" (CLAUDE.md §4) still holds, so the same
 *     admission must NOT hand a team lead the brokerage's whole lead desk.
 *
 * Admitting team_lead to a roster and stopping there would have produced the
 * second outcome silently — brokerage-wide lead visibility for every team lead
 * in every multi-team tenant. So the answer this module returns is a PAIR:
 * admission AND row scope, resolved together, and the row scope is not optional.
 *
 * ── WHY A SIBLING MODULE AND NOT MORE OF resolve-user-role.ts ───────────────
 *
 * The roster is NOT restated here — LEAD_DESK_USER_TYPES below is DERIVED from
 * TENANT_ADMIN_USER_TYPES with the one documented addition, the same idiom
 * BROKERAGE_FINANCE_ADMIN_USER_TYPES uses for its one documented subtraction.
 * There is still ONE roster.
 *
 * What lives here rather than there is the SCOPE half, and it is a different
 * kind of thing: resolve-user-role.ts answers "what IS this actor" from the two
 * role columns, and every one of its exports is a fact about the person.
 * `LeadRowScope` is a fact about a TABLE — it names `leads.brokerage_id` and
 * `leads.agent_id`, reads `teams` and `agents`, and ships a query applicator.
 * Folding a per-surface row policy into the identity module would make the next
 * surface (contacts, financials) do the same, and the file that everything
 * imports would grow a dependency on every table in the product. The derivation
 * keeps one vocabulary; the split keeps identity separable from row policy.
 *
 * ── FAIL CLOSED, BY CONSTRUCTION ────────────────────────────────────────────
 *
 * There is no boolean return anywhere in this module. A caller reaches lead rows
 * only through `{ allowed: true }`, and every failure — unauthenticated, refused
 * query, a team lead whose team cannot be resolved — is `{ allowed: false }`
 * with a `status` saying which. supabase-js RESOLVES a refused read, so a
 * boolean would have had to report "the teams read was denied" as "no team",
 * which for a widening gate means "no scope restriction" if anyone forgot a
 * branch. Nobody can forget a branch here: there is no scope to apply until the
 * result says allowed.
 *
 * PURE OF server-only. `app/leads/page.tsx` is a CLIENT component that queries
 * `leads` directly, so it needs this same answer in the browser. The client is
 * INJECTED for the same reason lib/auth/role-grants.ts injects it.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  TENANT_ADMIN_USER_TYPES,
  isPlatformStaffIdentity,
} from "@/lib/auth/resolve-user-role"
import { readRoleGrants } from "@/lib/auth/role-grants"

type AnySupabase = SupabaseClient<any, any, any>

/**
 * THE lead-desk roster. DERIVED from the tenant-admin roster, plus the one seat
 * that is not a tenant admin and still works leads.
 *
 * ── WHAT WAS MERGED ONTO IT, AND FROM WHERE ─────────────────────────────────
 *
 *   · `isa` — the AI-ISA seat. It came from app/actions/leads.ts's
 *     ISA_ALLOWED_ROLES, which was the only one of the fifteen rosters to carry
 *     it. The ISA works leads and nothing else: it is what qualifies them before
 *     they ever reach an agent (CLAUDE.md §5), and the database has always known
 *     that — `is_lead_visible_role()` carries `is_ai_isa_system()` as its own
 *     arm. Dropping it in the merge would have retired a live seat.
 *   · `team_lead` — rides along from TENANT_ADMIN_USER_TYPES, which has always
 *     contained it. That is the whole of this lane's widening, and it is the
 *     reason the SCOPE half below exists.
 *   · `broker_admin` — rides along as an INPUT spelling only, exactly as the
 *     parent roster documents. It is NOT a storable user_type (it canonicalizes
 *     to `broker`; users_user_type_check admits fourteen values and that is not
 *     one of them, VALIDATED), so it matches no live row. It is never carried
 *     into an `.in("user_type", […])` query.
 *
 * ── WHAT IS DELIBERATELY NOT IN IT ──────────────────────────────────────────
 *
 *   · `superadmin` as a USER_TYPE. Measured: zero live rows hold it, and the
 *     platform's one superadmin is (user_type='admin', platform_role='superadmin').
 *     Five of the retired rosters listed it and it matched nothing in all five.
 *     Platform staff are admitted below through isPlatformStaffIdentity, which
 *     reads the column that actually holds the answer.
 *   · `support` as a USER_TYPE. It is a legal tenant user_type unconnected to
 *     platform employment, so a roster entry for it admitted the wrong people
 *     and missed the right ones — the same defect requirePlatformStaffAuth was
 *     corrected for (lib/kernel/api-auth.ts:138). Platform support reaches leads
 *     through platform_role, like the rest of staff.
 *   · `tc`, `compliance_officer`, `agent`, `vendor`, `lender`, `contact`. Agents
 *     see CONTACTS, never leads (CLAUDE.md §5); the rest never worked the lead
 *     desk in any of the fifteen rosters.
 *
 * ── AND WHY compliance_officer STAYS OUT AFTER JOINING THE PARENT ROSTER ────
 *
 * The owner's 2026-09-04 ruling ("there is a compliance officer for tenant staff
 * which was not included") put `compliance_officer` INTO
 * TENANT_ADMIN_USER_TYPES. Spreading the parent unchanged would therefore have
 * widened the lead desk by a side effect of a ruling about admin surfaces — and
 * this file's own exclusion list, four lines up, names that seat by name as
 * deliberately absent. Two reasons it stays absent, neither of them withdrawn:
 *
 *   · CLAUDE.md §5 — "Leads belong to the BROKERAGE… A lead reaches an agent
 *     only once qualified or showing positive intent." The lead desk is the
 *     sales pipeline before qualification. Regulatory governance is not a stage
 *     of it, and the compliance officer's own surfaces (compliance_flags, the
 *     ledger, fair-housing review) reach CONTACTS, which they already have
 *     through lib/auth/crm-contact-staff.ts.
 *   · THE DATABASE AGREES AND WAS NOT ASKED TO CHANGE. m530's
 *     public.is_lead_visible_role() admits
 *     ('broker','broker_admin','broker_owner','admin','team_lead','superadmin')
 *     in both branches, and no compliance_officer. Riding the parent widening in
 *     here would make the app admit a `leads` read that RLS refuses — and a
 *     refused SELECT resolves as ZERO ROWS with `error` null (§3), so the desk
 *     would render empty rather than refusing, which is the failure mode this
 *     whole module exists to prevent.
 *
 * The subtraction is EXPLICIT and NAMED rather than a re-typed list, so the
 * derivation still has ONE parent and a seventh role added upstream tomorrow
 * lands on the lead desk by default — the loud direction — instead of vanishing.
 */
/** Held out of the lead desk by CLAUDE.md §5 + m530's is_lead_visible_role(),
 *  NOT by an oversight in the parent roster. See the section above. */
const NOT_LEAD_DESK_USER_TYPES: ReadonlySet<string> = new Set(["compliance_officer"])

export const LEAD_DESK_USER_TYPES: ReadonlySet<string> = new Set([
  ...[...TENANT_ADMIN_USER_TYPES].filter((t) => !NOT_LEAD_DESK_USER_TYPES.has(t)),
  // The AI-ISA seat — merged in from app/actions/leads.ts#ISA_ALLOWED_ROLES.
  "isa",
])

/**
 * The lead-desk roles whose reach is ONE TEAM rather than the whole tenant.
 *
 * Derived by SUBTRACTION for the same reason BROKERAGE_FINANCE_ADMIN_USER_TYPES
 * is: a new admin-class role added to the parent roster must land on the SAFE
 * side by default. Anything that is not explicitly brokerage-wide here is
 * team-scoped, so forgetting to classify a new role narrows it rather than
 * handing it the brokerage's board.
 */
export const BROKERAGE_WIDE_LEAD_USER_TYPES: ReadonlySet<string> = new Set(
  [...LEAD_DESK_USER_TYPES].filter((t) => t !== "team_lead"),
)

/** All-zero uuid — a syntactically valid uuid that no row can carry. */
const NIL_UUID = "00000000-0000-0000-0000-000000000000"

/**
 * WHICH ROWS of `leads` this actor may see.
 *
 *   platform  — every tenant. Platform staff only (CLAUDE.md §4: "platform sees
 *               all tenants"). `brokerageId` is still carried when the surface
 *               is tenant-scoped, so a staff member on a tenant route stays on
 *               that tenant's rows rather than accidentally reading across.
 *   brokerage — one tenant, every row in it.
 *   team      — one tenant, and only the rows whose `agent_id` belongs to this
 *               actor's team(s). The UNASSIGNED POOL (agent_id IS NULL) is NOT
 *               in it: an unworked lead belongs to the BROKERAGE, and in a
 *               multi-team tenant it is not yet any team's. See the collapse
 *               rule in resolveLeadVisibility for the tenant where it is.
 */
export type LeadRowScope =
  | { kind: "platform"; brokerageId: string | null }
  | { kind: "brokerage"; brokerageId: string }
  | { kind: "team"; brokerageId: string; teamIds: string[]; agentIds: string[] }

export type LeadVisibility =
  | {
      allowed: true
      /** Which source admitted them — the seat's own type, a tenant-pinned grant, or staff identity. */
      via: "user_type" | "grant" | "platform_staff"
      scope: LeadRowScope
      /**
       * TRUE when a team lead resolved to BROKERAGE scope because their team(s)
       * are the only team(s) in the tenant. This is the owner's team-tier case,
       * and it is derived from the tenant's own SHAPE rather than from
       * `brokerages.plan_tier` — see the note on the collapse rule below.
       */
      soleTeamTenant?: true
    }
  | {
      allowed: false
      /**
       * forbidden  — the actor is genuinely not on the lead desk. A 403.
       * unresolved — the gate could not run (refused read, missing tenant, a
       *              team lead with no resolvable team). Refuses, and says so,
       *              because "nobody checked" must never render as "checked and
       *              fine" (CLAUDE.md §4).
       */
      status: "forbidden" | "unresolved"
      reason: string
    }

/** The SESSION facts this resolver decides from. Never a request body — CLAUDE.md §4. */
export interface LeadVisibilitySession {
  /** users.id, from the session. */
  userId: string
  /** users.user_type. */
  userType: string | null | undefined
  /**
   * users.platform_role — the OTHER half of staff identity. Pass `undefined`
   * when the caller has not read it and this module will read it (one extra
   * query, only for callers that lack it). Pass `null` to assert it is genuinely
   * absent. The two are NOT interchangeable: `undefined` means "unknown", and a
   * gate that treated unknown as absent would refuse the platform's only
   * superadmin, whose row is (user_type='admin', platform_role='superadmin').
   */
  platformRole?: string | null
  /** users.brokerage_id — the tenant pin. */
  brokerageId: string | null | undefined
}

/**
 * THE resolver. Admission AND row scope, together, from the session.
 *
 * @param supabase the caller's own client. A SESSION client keeps RLS underneath
 *                 the scope; a SERVICE client is for surfaces that have already
 *                 gated and must read past RLS. Injected rather than chosen here
 *                 so this never changes a caller's security posture.
 */
export async function resolveLeadVisibility(
  supabase: AnySupabase,
  session: LeadVisibilitySession,
): Promise<LeadVisibility> {
  const userId = String(session.userId ?? "")
  if (!userId) return { allowed: false, status: "unresolved", reason: "Unauthenticated" }

  const userType = String(session.userType ?? "").toLowerCase()
  const brokerageId = session.brokerageId ?? null

  // ── PLATFORM STAFF ────────────────────────────────────────────────────────
  // Read the column that can actually answer, rather than matching a roster of
  // platform_role values against user_type. When the caller did not read it,
  // read it here — "unknown" is not "absent".
  let platformRole: string | null
  if (session.platformRole === undefined) {
    const { data, error } = await supabase
      .from("users")
      .select("platform_role")
      .eq("id", userId)
      .maybeSingle()
    // supabase-js RESOLVES a refusal. A denied read here is not "not staff":
    // it is "we do not know", and this gate refuses rather than guessing.
    if (error) return { allowed: false, status: "unresolved", reason: "Could not verify your account" }
    platformRole = (data as { platform_role?: string | null } | null)?.platform_role ?? null
  } else {
    platformRole = session.platformRole
  }

  if (isPlatformStaffIdentity(userType, platformRole)) {
    return { allowed: true, via: "platform_staff", scope: { kind: "platform", brokerageId } }
  }

  // ── THE TENANT HALF — BOTH ROLE SOURCES, exactly as the DB reads them ─────
  // `is_lead_visible_role()` admits by users.user_type OR by a row in
  // user_role_assignments. An app gate reading only user_type is NARROWER than
  // RLS and refuses the second seat — the live agent+admin+isa account whose
  // user_type is 'agent'. Same two-branch shape, same answer.
  const admittedRoles = new Set<string>()
  let via: "user_type" | "grant" = "user_type"
  if (LEAD_DESK_USER_TYPES.has(userType)) admittedRoles.add(userType)

  if (admittedRoles.size === 0) {
    // No tenant of their own → no grant can be pinned to it. Same as SQL, where
    // `ura.brokerage_id = current_user_brokerage_id()` can never match NULL.
    if (!brokerageId) {
      return { allowed: false, status: "forbidden", reason: "Leads are managed at the brokerage level" }
    }
    const res = await readRoleGrants(supabase, userId)
    if (!res.ok) return { allowed: false, status: "unresolved", reason: "Could not verify your permissions" }
    for (const g of res.grants) {
      if (!g.brokerage_id || g.brokerage_id !== brokerageId) continue
      const role = String(g.role ?? "").toLowerCase()
      if (LEAD_DESK_USER_TYPES.has(role)) admittedRoles.add(role)
    }
    if (admittedRoles.size === 0) {
      return { allowed: false, status: "forbidden", reason: "Leads are managed at the brokerage level" }
    }
    via = "grant"
  }

  if (!brokerageId) {
    return { allowed: false, status: "unresolved", reason: "No brokerage context" }
  }

  // A seat that ALSO holds a brokerage-wide lead role keeps the wider scope —
  // a team lead who additionally holds an `admin` grant is an admin. Only an
  // actor whose ENTIRE admission is team_lead is team-scoped.
  const brokerageWide = [...admittedRoles].some((r) => BROKERAGE_WIDE_LEAD_USER_TYPES.has(r))
  if (brokerageWide) {
    return { allowed: true, via, scope: { kind: "brokerage", brokerageId } }
  }

  return resolveTeamLeadScope(supabase, userId, brokerageId, via)
}

/**
 * Convenience entry point for the many surfaces that hold only a client.
 * Resolves the session itself — user, user_type, platform_role, brokerage_id —
 * and never accepts an identity from its caller.
 */
export async function resolveLeadVisibilityForSession(supabase: AnySupabase): Promise<LeadVisibility> {
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) return { allowed: false, status: "unresolved", reason: "Unauthenticated" }

  const { data: profile, error } = await supabase
    .from("users")
    .select("user_type, platform_role, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (error) return { allowed: false, status: "unresolved", reason: "Could not verify your account" }

  const p = (profile ?? {}) as { user_type?: string | null; platform_role?: string | null; brokerage_id?: string | null }
  return resolveLeadVisibility(supabase, {
    userId: user.id,
    userType: p.user_type ?? null,
    platformRole: p.platform_role ?? null,
    brokerageId: p.brokerage_id ?? null,
  })
}

/**
 * THE TEAM ANCHOR. `teams.team_lead_id` against the SESSION identity — never a
 * parameter, never a body (CLAUDE.md §4).
 *
 * ── THE COLLAPSE RULE, AND WHY IT IS NOT A TIER READ ────────────────────────
 *
 * The owner's sentence is about a TEAM-TIER SUBSCRIPTION, and the obvious
 * implementation is to read `brokerages.plan_tier`. This does not, for two
 * reasons, and both are measurable rather than stylistic:
 *
 *   1. No lead gate anywhere in this tree reads subscription tier, and
 *      `plan_tier` is not guaranteed backfilled on legacy tenants — a NULL there
 *      would decide lead visibility by an absent column. The structural fact the
 *      ruling actually depends on is "is this team the whole tenant", and
 *      `teams` answers that directly.
 *   2. The CanonicalTier vocabulary is currently declared TWICE
 *      (app/actions/auth/signup-brokerage.ts:28 and re-typed at
 *      app/actions/superadmin/brokerage-management.ts:38) — a §6 defect this
 *      lane did not create and does not own. Taking a dependency on it from an
 *      access gate would spread it into the security path.
 *
 * So: when the actor leads EVERY team in the tenant, the team IS the tenant and
 * the scope collapses to brokerage — which is precisely, and only, the owner's
 * case. On a tenant with a second team it does not collapse, and "teams see only
 * their own board" survives untouched.
 *
 * ── WHY THE UNASSIGNED POOL IS EXCLUDED FROM A TRUE TEAM SCOPE ──────────────
 *
 * `leads` has NO team column (verified against the live column list); a lead's
 * only link to a team is through `leads.agent_id → agents.team_id`. An UNWORKED
 * lead has `agent_id IS NULL`, so it belongs to no team — it belongs to the
 * brokerage, which is the standing ruling. Including it in a multi-team tenant
 * would hand every team lead the brokerage's entire raw desk, which is the exact
 * failure this module exists to prevent. In the collapsed case above the pool is
 * visible because the scope is brokerage scope, not because a team owns it.
 */
async function resolveTeamLeadScope(
  supabase: AnySupabase,
  userId: string,
  brokerageId: string,
  via: "user_type" | "grant",
): Promise<LeadVisibility> {
  // The teams this SESSION user leads, inside their OWN tenant.
  const { data: ledRows, error: ledError } = await supabase
    .from("teams")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .eq("team_lead_id", userId)
    .is("deleted_at", null)
  if (ledError) {
    return { allowed: false, status: "unresolved", reason: "Could not resolve your team" }
  }
  const teamIds = ((ledRows ?? []) as Array<{ id: string }>).map((r) => r.id).filter(Boolean)
  // FAIL CLOSED. A team_lead with no team has no board, and a board that cannot
  // be resolved is not an empty board — both refuse rather than falling through
  // to the tenant's rows.
  if (teamIds.length === 0) {
    return { allowed: false, status: "unresolved", reason: "No team is anchored to your account" }
  }

  // Does this actor lead EVERY team in the tenant? (the collapse rule)
  const { data: allRows, error: allError } = await supabase
    .from("teams")
    .select("id")
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
  if (allError) {
    return { allowed: false, status: "unresolved", reason: "Could not resolve your brokerage's teams" }
  }
  const allTeamIds = ((allRows ?? []) as Array<{ id: string }>).map((r) => r.id).filter(Boolean)
  const led = new Set(teamIds)
  if (allTeamIds.length > 0 && allTeamIds.every((id) => led.has(id))) {
    return { allowed: true, via, scope: { kind: "brokerage", brokerageId }, soleTeamTenant: true }
  }

  // TRUE team scope: the agents.id values that belong to this actor's team(s).
  // BOTH membership sources are read, because both are live: `agents.team_id`
  // is the denormalised one every agent row carries, and `team_members` is the
  // roster table with effective dating. A row present in one and not the other
  // is a member either way; taking only one of them would silently drop leads
  // the team is actually working.
  const [byAgents, byMembers, ownAgent] = await Promise.all([
    supabase.from("agents").select("id").eq("brokerage_id", brokerageId).in("team_id", teamIds),
    supabase.from("team_members").select("agent_id").eq("brokerage_id", brokerageId).in("team_id", teamIds).eq("is_active", true),
    // The team lead's OWN agents row. A lead assigned to the team lead in person
    // is their team's; their agents row may carry a NULL team_id and would then
    // be missed by both reads above.
    supabase.from("agents").select("id").eq("brokerage_id", brokerageId).eq("user_id", userId),
  ])
  if (byAgents.error || byMembers.error || ownAgent.error) {
    return { allowed: false, status: "unresolved", reason: "Could not resolve your team roster" }
  }

  const agentIds = [
    ...new Set([
      ...((byAgents.data ?? []) as Array<{ id: string }>).map((r) => r.id),
      ...((byMembers.data ?? []) as Array<{ agent_id: string | null }>).map((r) => r.agent_id ?? ""),
      ...((ownAgent.data ?? []) as Array<{ id: string }>).map((r) => r.id),
    ]),
  ].filter(Boolean)

  return { allowed: true, via, scope: { kind: "team", brokerageId, teamIds, agentIds } }
}

/**
 * Apply a resolved scope to a PostgREST query builder over a lead-bearing table.
 *
 * This is the only sanctioned way to turn a scope into a filter — a site that
 * reads `scope.kind` and writes its own `.eq()` is the sixteenth roster starting
 * over. It is deliberately shaped so that FORGETTING to call it is visible: the
 * resolver hands back no ids, only a scope, so an unfiltered query has nothing
 * to have been built from.
 *
 * A team scope whose roster is EMPTY becomes an impossible filter rather than no
 * filter — an empty `.in()` list is a PostgREST syntax question, and "no rows"
 * is the correct answer for a team with no agents.
 */
export function applyLeadRowScope<Q>(
  query: Q,
  scope: LeadRowScope,
  columns?: { brokerage?: string; agent?: string },
): Q {
  const brokerageCol = columns?.brokerage ?? "brokerage_id"
  const agentCol = columns?.agent ?? "agent_id"
  const q = query as any

  if (scope.kind === "platform") {
    return (scope.brokerageId ? q.eq(brokerageCol, scope.brokerageId) : q) as Q
  }
  if (scope.kind === "brokerage") {
    return q.eq(brokerageCol, scope.brokerageId) as Q
  }
  const scoped = q.eq(brokerageCol, scope.brokerageId)
  if (scope.agentIds.length === 0) return scoped.eq(agentCol, NIL_UUID) as Q
  return scoped.in(agentCol, scope.agentIds) as Q
}

/**
 * The PURE half of the same rule, for the sites that hold a row rather than a
 * query — a single-lead gate, a `.filter()` over rows already fetched.
 *
 * Same three cases, same exclusion of the unassigned pool under team scope, so a
 * single-row check and a list query can never disagree about one lead.
 */
export function leadRowInScope(
  scope: LeadRowScope,
  lead: { brokerage_id?: string | null; agent_id?: string | null },
): boolean {
  if (scope.kind === "platform") {
    return scope.brokerageId ? lead.brokerage_id === scope.brokerageId : true
  }
  if (lead.brokerage_id !== scope.brokerageId) return false
  if (scope.kind === "brokerage") return true
  return !!lead.agent_id && scope.agentIds.includes(lead.agent_id)
}

/**
 * For tables that carry `lead_id` but NOT `agent_id` — the deduplication log is
 * the live one. A team scope cannot be expressed on such a table directly, so
 * the in-scope lead ids are resolved first and the caller filters on those.
 *
 * Returns `null` when no lead-id restriction is needed (platform / brokerage
 * scope), an ARRAY when one is, and a refusal when the read fails. The three are
 * distinguishable on purpose: collapsing "no restriction needed" into an empty
 * array would silently empty the surface, and collapsing "the read failed" into
 * it would empty it for the wrong reason.
 *
 * `cap` bounds the id list. A team's worked-lead count is small; if a team ever
 * exceeds the cap the surface UNDER-reports rather than over-reports, which is
 * the safe direction for an access filter.
 */
export async function resolveScopedLeadIds(
  supabase: AnySupabase,
  scope: LeadRowScope,
  cap = 1000,
): Promise<{ ok: true; leadIds: string[] | null } | { ok: false; error: string }> {
  if (scope.kind !== "team") return { ok: true, leadIds: null }
  if (scope.agentIds.length === 0) return { ok: true, leadIds: [] }

  const { data, error } = await supabase
    .from("leads")
    .select("id")
    .eq("brokerage_id", scope.brokerageId)
    .in("agent_id", scope.agentIds)
    .limit(cap)
  if (error) return { ok: false, error: error.message }
  return { ok: true, leadIds: ((data ?? []) as Array<{ id: string }>).map((r) => r.id) }
}

// NOT WRITTEN, deliberately: a `describeLeadRowScope()` formatter. It had no
// caller the moment it was typed, and an exported helper with no reader is the
// orphan CLAUDE.md §1 is about. The one surface that needed to SAY the scope
// out loud — the lead desk's stats bar — renders it inline from the scope's own
// fields (app/leads/page.tsx), which is one expression, not a helper.
