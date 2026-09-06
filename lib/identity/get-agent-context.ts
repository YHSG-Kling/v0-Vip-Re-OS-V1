"use server"

import { createClient } from "@/lib/supabase/server"
import { isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"
import { readRoleGrants, selectAgentId, selectPrimaryRole, selectTenantBrokerageId } from "@/lib/auth/role-grants"
import { resolveActiveImpersonation } from "@/lib/platform/impersonation"

export interface AgentContext {
  userId: string
  /**
   * agents.id — the row PK in the agents table.
   * contacts.agent_id → agents.id (FK corrected in migration 114).
   * Use agentId for all contacts, transactions, listings, showings, offers, tasks, etc.
   */
  agentId: string | null
  brokerageId: string | null
  /**
   * `users.team_id` — the TEAM tier of the connection ownership cascade
   * (agent → team → brokerage → platform), used by every scoped-credential
   * resolver: `lib/connections/resolve-scoped.ts:resolveScopedConnection` and
   * therefore `IDXBrokerClient.forBrokerage(brokerageId, { agentUserId, teamId })`.
   *
   * This row was ALREADY selected here and thrown away, so every caller that
   * needed the team tier either re-read `users` itself or silently skipped that
   * rung — which meant a team that connected its own IDX Broker account was
   * stepped over and the brokerage (or platform) feed answered instead. Exposing
   * it once is why three call sites could stop guessing (wave 17).
   *
   * NOT the same class as `agentId` (agents.id) or `userId` (users.id) — it is
   * teams.id, a third id space. Never substitute one for another.
   */
  teamId: string | null
  /**
   * Source priority: users.user_type > user_role_assignments.role > auth metadata.
   * NO 'agent' FALLBACK (wave 27, §4): a seat whose role cannot be resolved gets
   * the EMPTY STRING, which every roster predicate refuses. An unresolvable role
   * must never be graded as a granted one.
   */
  userType: string
  /** Alias for userType — backward compat for all callers that reference .role */
  role: string
  isAuthenticated: boolean
  /** True when a platform-staff member is acting AS this tenant (GHL "act as"). */
  isImpersonating?: boolean
  /** The REAL staff actor behind an impersonated context — always set when impersonating. */
  impersonatorUserId?: string | null
  /** 'read_only' | 'full' — the impersonation grant, for write-gating. */
  impersonationMode?: string | null
}

/**
 * Safe default returned when the user is not authenticated. Never throws.
 *
 * `userType` IS THE EMPTY STRING HERE FOR THE SAME REASON IT IS BELOW (§4).
 * It read "agent" until wave 27, alongside the resolver's `?? "agent"` final
 * fallback — so the shape returned for NOBODY AT ALL claimed a producing agent's
 * role. `isAuthenticated: false` is the intended guard, but it is an OPT-IN one:
 * a caller that reads `.userType` without checking it got a grant handed to it by
 * a default. Fixing the resolver and leaving this would have left the weaker of
 * the two paths carrying the stronger claim, which is the disagreement, not the
 * fix. Both now say "unknown", and every roster predicate in this repo refuses
 * the empty string.
 */
const UNAUTHENTICATED_CONTEXT: AgentContext = {
  userId: "",
  agentId: null,
  brokerageId: null,
  teamId: null,
  userType: "",
  role: "",
  isAuthenticated: false,
}

/**
 * Resolves authenticated user to a fully typed AgentContext.
 * Works for all user types (agent, broker, admin, tc, compliance_officer, vendor, etc.)
 * NEVER throws — returns safe defaults on any failure including unauthenticated.
 * Source priority: users.user_type > user_role_assignments.role > auth metadata; an
 * unresolvable role is the empty string, never 'agent' (§4 fail closed).
 */
export async function getAgentContext(): Promise<AgentContext> {
  try {
    const supabase = await createClient()

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return UNAUTHENTICATED_CONTEXT
    }

    // Fetch users row + role assignments in parallel. Neither throws on a missing
    // row; the grant read returns a discriminated result so a REFUSED read stays
    // distinguishable from a seat that genuinely holds no grants.
    const [{ data: userData }, rolesResult] = await Promise.all([
      supabase
        .from("users")
        .select("id, brokerage_id, user_type, platform_role, team_id")
        .eq("id", user.id)
        .maybeSingle(),
      // NOT `.limit(1)`. A seat legitimately holds several grants (the table is
      // UNIQUE on (user_id, role), not on user_id), and taking the first of them
      // with no ORDER BY let PostgREST's row order decide this user's TENANT, their
      // role and their agent linkage — three different answers, all from one row
      // chosen for no reason, and free to change between two identical requests.
      // Read them all; each of the three is derived by its own rule below.
      readRoleGrants(supabase, user.id),
    ])

    if (!rolesResult.ok) {
      console.error("[get-agent-context] role grant read failed:", rolesResult.error)
    }
    const grants = rolesResult.ok ? rolesResult.grants : []

    // Source priority: users.user_type > role_assignments.role > auth metadata.
    // The seat's own declared identity still wins; the grant half is chosen by
    // explicit authority order rather than by row order.
    //
    // ── THE FINAL FALLBACK IS NO LONGER 'agent' (§4 fail closed, wave 27) ──────
    //
    // It used to be `?? "agent"`, which GRADED A SEAT WHOSE ROLE COULD NOT BE
    // RESOLVED AS AN AGENT — the exact reading lib/auth/require-caller.ts:187
    // deliberately refuses, and the disagreement lane SEC3 §8.4 recorded between
    // this repo's two identity survivors. "Nobody could tell what this seat is"
    // must never render as "checked, and they are an agent"; that is not a
    // default, it is a grant. The three sources this fallback stands behind are
    // exhaustive for a real seat — measured live by the integrator, ZERO users
    // rows carry a NULL user_type — so failing closed here locks nobody out and
    // only changes what happens when the answer is genuinely unknown.
    //
    // The empty string, not null, so `AgentContext.userType` stays `string` and
    // no caller's type changes. Every roster predicate in this repo normalises
    // with `String(x ?? "").toLowerCase()` and answers NO to it
    // (isAdminOrBroker, isBrokerageFinanceAdmin, isAgentOrTenantAdmin,
    // isCrmContactStaff — the last two refuse an empty string explicitly), so an
    // unresolvable role is refused by every gate rather than admitted by one.
    const userType: string =
      userData?.user_type ??
      selectPrimaryRole(grants) ??
      (user.user_metadata?.user_type as string | undefined) ??
      ""

    // brokerageId: users table > role assignments > auth metadata > null.
    // An untenanted grant (contact/lender, brokerage_id NULL) can no longer win and
    // blank the tenant — selectTenantBrokerageId skips those by construction.
    const brokerageId: string | null =
      userData?.brokerage_id ??
      selectTenantBrokerageId(grants) ??
      (user.user_metadata?.brokerage_id as string | undefined) ??
      null

    // agentId: role assignments > agents table lookup (only for agent-type users).
    // Only a grant that actually CARRIES an agent_id can supply it — picking "the"
    // grant first and reading agent_id off it discards a real agent linkage
    // whenever another grant happens to sort ahead of it.
    //
    // And it must not be `grants.find(g => g.agent_id)` either. `public.agents` is
    // UNIQUE (user_id), so one user's grants can only correctly carry ONE distinct
    // agent_id; two different ones is a provable data fault, and `find` would settle
    // it by row order — handing this request someone else's production and
    // commissions under this user's identity. selectAgentId REPORTS that instead.
    const { agentId: grantAgentId, ambiguous: agentAmbiguous } = selectAgentId(grants)
    if (agentAmbiguous) {
      console.error(
        "[get-agent-context] user", user.id,
        "holds grants naming more than one agent — resolving from public.agents, which is UNIQUE (user_id)",
      )
    }
    let agentId: string | null = grantAgentId
    // On ambiguity the authoritative table decides regardless of userType: agents
    // is unique on user_id, so it can answer what the grants could not.
    if (!agentId && (userType === "agent" || agentAmbiguous)) {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("id")
        .eq("user_id", user.id)
        .maybeSingle()
      agentId = agentRow?.id ?? null
    }

    // ── ACT-AS seam ──────────────────────────────────────────────────────────
    // If this authenticated user is platform staff AND holds an active impersonation
    // session, resolve the TARGET tenant's workspace context instead — while keeping
    // the real staff id as impersonatorUserId so every downstream write stays
    // attributable. Non-staff / expired sessions are ignored (defence in depth).
    const platformRole: string | null = (userData as any)?.platform_role ?? null
    if (isPlatformStaffIdentity(userType, platformRole)) {
      const imp = await resolveActiveImpersonation(user.id, platformRole ?? userType ?? "")
      if (imp) {
        return {
          userId: imp.userId,
          agentId: imp.agentId,
          brokerageId: imp.brokerageId,
          // The impersonation grant carries no team, and the STAFF actor's team
          // is not the impersonated tenant's — borrowing it would resolve a
          // credential from the wrong org. Null until the grant carries one.
          teamId: null,
          userType: imp.userType,
          role: imp.userType,
          isAuthenticated: true,
          isImpersonating: true,
          impersonatorUserId: imp.impersonatorUserId,
          impersonationMode: imp.mode,
        }
      }
    }

    return {
      userId: user.id,
      agentId,
      brokerageId,
      teamId: (userData?.team_id ?? null) as string | null,
      userType,
      role: userType, // alias — same value, different key name
      isAuthenticated: true,
      isImpersonating: false,
      impersonatorUserId: null,
      impersonationMode: null,
    }
  } catch {
    // Never propagate — return safe defaults so callers don't need try/catch
    return UNAUTHENTICATED_CONTEXT
  }
}
