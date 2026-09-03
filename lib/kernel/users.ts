// lib/kernel/users.ts
// KERNEL OS — User Provisioning & Domain Record Management
//
// This module is the single source of truth for all user account creation,
// domain record provisioning, role assignment, repair, and workspace resolution.
//
// Canonical kernel ownership:
//   - createOrRepairUserDomainRecords()   — provisions/repairs role-specific DB rows
//   - resolveUserWorkspaceContext()       — loads full workspace state for routing
//   - assignUserRoleAndEntitlements()     — updates role + syncs RBAC tables
//   - assignUserToBrokerage()             — sets brokerage on users + domain rows
//   - assignUserToTeam()                  — sets team on users + agents rows
//   - repairIncompleteAccountSetup()      — detects and fixes incomplete accounts
//   - emitUserProvisionedEvent()          — writes lifecycle_events row
//
// Contract rules:
//   - All inputs typed with explicit interfaces — no bare `any`
//   - All DB calls use maybeSingle(), not single()
//   - All FK IDs match exact schema columns (agents.user_id, not agents.id)
//   - Every provisioning path emits a KernelEvent
//   - Errors returned as structured { success, error } — never thrown silently
//
// Schema FK map (from live schema):
//   agents.user_id         → users.id
//   agents.brokerage_id    → brokerages.id
//   agents.team_id         → teams.id
//   transaction_coordinators.user_id   → users.id
//   agent_onboarding.user_id           → users.id
//   agent_onboarding.agent_id          → agents.id (NOT NULL — onboarding is agent-scoped)
//   user_role_assignments.user_id      → users.id
//   user_role_assignments.brokerage_id → brokerages.id
//   user_role_assignments.agent_id     → agents.id (nullable)

// NOT A "use server" MODULE (lane S1, 2026-09-02). The directive that stood here
// — under this header, below raw line 3, where scripts/use-server-export-guard.ts
// could not see it — published all nine exports as Server Actions, POST-able by
// action id from any session while this module sat in the server graph, with
// ZERO session tokens in the file. `assignUserToBrokerage` and `assignUserToTeam`
// take the target TENANT and the CALLER'S IDENTITY from their parameters and
// write on the service client: §4's IDOR shape, on the tenancy ledger. Every
// real caller is server-side and gates before calling (app/actions/admin/
// update-user.ts, invite-user.ts, create-subscriber.ts, superadmin/tenant-users.ts,
// auth/signup-brokerage.ts, onboarding/ensure-agent-brokerage.ts,
// app/dashboard/page.tsx, app/api/billing/webhook), so the directive was only
// ever a door. These are gate-first internals; `server-only` makes a future
// client import fail at build instead of bundling the service client.
import "server-only"

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "./events"
import { requiresAgentRow, requiresOnboardingRow, ownerNeedsTeamRow } from "./tenant-provisioning-spec"
import { roleDashboardRoute } from "./role-routes"
import { readRoleGrants, selectAgentId } from "@/lib/auth/role-grants"
// Runtime-safe both ways: seat-usage imports only TYPES from this module
// (erased at compile time), so this is not a runtime cycle.
import { seatGate } from "./seat-usage"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type UserDomainRole =
  | "agent"
  | "broker"
  // OWNER RULING (2026-08-22): "a broker admin is a user type with differnt
  // permission roles" — and CLAUDE.md §4's tenant roster has always named it
  // (broker, broker_admin, broker_owner, team_lead, admin).
  //
  // NOT YET STORABLE. users_user_type_check admits fourteen values and this is
  // not one of them, which is why m308/m518 stripped it out of the RLS
  // predicates. supabase/migrations/m530-…sql adds it (WRITTEN, NOT APPLIED).
  // Until then the invite menu cannot offer it — tier-role-matrix.ts
  // `seatableUserTypes` intersects the menu with the live CHECK vocabulary — so
  // this union member is reachable by TYPE but never written to the column.
  | "broker_admin"
  // Admitted by the users.user_type CHECK and mapped to brokerage_admin by
  // normalizeCriticalRole, but it was in no seat list — so a brokerage OWNER
  // consumed no seat on any surface.
  | "broker_owner"
  | "admin"
  | "tc"
  | "isa"
  | "team_lead"
  | "compliance_officer"
  | "vendor"
  | "lender"
  | "superadmin"
  // Platform/OS staff — admitted by the users.user_type CHECK, absent from this
  // union. Like superadmin it is NOT a tenant seat.
  | "support"
  | "contact"
  | "system"

export interface UserProvisioningParams {
  /** users.id — auth.users.id */
  userId: string
  email: string
  firstName?: string
  lastName?: string
  userType: UserDomainRole
  brokerageId: string | null
  teamId?: string | null
  /** Canonical plan tier of the brokerage — decides whether an admin/broker OWNER
   *  also needs an agents row (solo_agent IS the agent; a team's owner is its lead). */
  tier?: string | null
  /** ID of the admin/broker who triggered this provisioning */
  callerUserId: string
}

export interface ProvisioningResult {
  success: boolean
  /** agents.id — null for non-agent roles */
  agentId: string | null
  /** transaction_coordinators.id — null for non-TC roles */
  coordinatorId: string | null
  domainRecordsCreated: string[]
  error?: string
}

export interface WorkspaceContext {
  userId: string
  userType: string
  brokerageId: string | null
  teamId: string | null
  agentId: string | null
  coordinatorId: string | null
  hasAgentRow: boolean
  hasOnboardingRow: boolean
  hasRoleAssignment: boolean
  isComplete: boolean
  /** Destination route for this user's dashboard */
  dashboardRoute: string
  /** Whether the user needs to complete setup before accessing the dashboard */
  requiresSetup: boolean
  missingRecords: string[]
}

export interface RoleAssignmentParams {
  userId: string
  newRole: UserDomainRole
  brokerageId: string | null
  teamId?: string | null
  agentId?: string | null
  callerUserId: string
}

export interface RoleAssignmentResult {
  success: boolean
  error?: string
}

export interface RepairResult {
  success: boolean
  repaired: string[]
  error?: string
}

// ─── ROLE → DASHBOARD ROUTE MAP ──────────────────────────────────────────────
// Canonical map (consolidated, no drift) — imported from lib/kernel/role-routes.ts at top.

// Roles that require a transaction_coordinators table row
const TC_ROLES = new Set<UserDomainRole>(["tc"])

// The tier→required-rows predicates (requiresAgentRow / requiresOnboardingRow)
// live in a plain, server-safe module so the SAME logic drives this provisioner,
// the login-time repair, and the simulator's pure layer — no drift.

// ─── createOrRepairUserDomainRecords ─────────────────────────────────────────

/**
 * Provisions or repairs all domain records required for the user's role.
 *
 * Input contract:
 *   userId        — users.id (auth.users.id)
 *   email         — used for user_role_assignments only (no longer in agents row)
 *   userType      — canonical role from users.user_type
 *   brokerageId   — required for scoped roles (nullable for superadmin)
 *
 * Output contract:
 *   agentId            — agents.id if created/found, else null
 *   coordinatorId      — transaction_coordinators.id if created/found, else null
 *   domainRecordsCreated — list of table names written
 *
 * Schema FK rules enforced:
 *   agents.user_id → users.id  (NOT agents.id = users.id)
 *   agents has no first_name/last_name/email/status columns
 *   agent_commission_profiles.split_percent (not split_percentage)
 *   agent_onboarding has no updated_at column
 */
export async function createOrRepairUserDomainRecords(
  params: UserProvisioningParams
): Promise<ProvisioningResult> {
  const service = createServiceClient()
  const created: string[] = []
  let agentId: string | null = null
  let coordinatorId: string | null = null

  try {
    const { userId, userType, brokerageId, teamId, tier, callerUserId } = params

    // ── 1. user_role_assignments ──────────────────────────────────────────
    // Does the grant this run is about to write ALREADY exist?
    //
    // This read does NOT choose insert-vs-update — step 5 below is an upsert and
    // decides that itself, in the database, on the real unique key. The only thing
    // this answers is whether "user_role_assignments" belongs in `created`, which
    // in turn picks USER_DOMAIN_RECORDS_CREATED vs …_REPAIRED on the lifecycle
    // event. So the question is narrow and exact: is there already a grant for
    // (this user, THIS role)?
    //
    // WAS: `.eq("user_id", userId).maybeSingle()` with no role filter — which asks
    // "does this user hold any grant at all?", a different question, and one that
    // cannot be answered by a single-row read: the table is UNIQUE on
    // (user_id, role), NOT on user_id. MEASURED live, one user holds three grants
    // (admin+agent+isa) and another holds two (contact+team_lead); over several
    // rows `.maybeSingle()` is an ERROR, supabase-js RESOLVES it, and the
    // `{ data: … }` destructuring threw the error away. Every provisioning run for
    // those users therefore reported a brand-new grant it had not created, and
    // emitted CREATED where the truth was REPAIRED.
    //
    // Adding `.eq("role", …)` makes the read single-row BY THE CONSTRAINT, not by
    // a `.limit(1)` that would merely hide the ambiguity. `agent_id` came out of
    // the select because nothing read it.
    const { data: existingRole, error: existingRoleErr } = await service
      .from("user_role_assignments")
      .select("id")
      .eq("user_id", userId)
      .eq("role", userType)
      .maybeSingle()

    // A refused read must not masquerade as "no grant yet" — that is how a repair
    // run comes to announce itself as a first-time provision.
    if (existingRoleErr) {
      console.error("[kernel/users] existing role-grant probe failed:", existingRoleErr.message)
    }

    // ── 2. agents row — AGENT_ROLES + solo/team tenant OWNER ─────────────
    if (requiresAgentRow(userType, tier) && brokerageId) {
      const { data: existingAgent } = await service
        .from("agents")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle()

      if (existingAgent) {
        agentId = existingAgent.id
        // Ensure brokerage matches (repair case)
        void service
          .from("agents")
          .update({ brokerage_id: brokerageId, ...(teamId ? { team_id: teamId } : {}) })
          .eq("id", agentId)
      } else {
        // Create agents row — only real schema columns
        const { data: newAgent } = await service
          .from("agents")
          .insert({
            user_id:        userId,
            brokerage_id:   brokerageId,
            team_id:        teamId ?? null,
            is_active:      true,
            // agents.onboarding_status CHECK: not_started|in_progress|completed|pending_review
            onboarding_status: "not_started",
            created_at:     new Date().toISOString(),
            updated_at:     new Date().toISOString(),
          })
          .select("id")
          .maybeSingle()

        if (newAgent?.id) {
          agentId = newAgent.id
          created.push("agents")

          // ── 2a. agent_commission_profiles ──────────────────────────────
          // Schema: split_percent (not split_percentage), no updated_at.
          // A solo_agent owner keeps 100% (no brokerage split to take a cut);
          // everyone else defaults to the standard 70/30 until configured.
          await service
            .from("agent_commission_profiles")
            .insert({
              agent_id:     agentId,
              brokerage_id: brokerageId,
              split_percent: tier === "solo_agent" ? 100 : 70,
              is_active:    true,
              effective_date: new Date().toISOString().slice(0, 10),
              // structure_type CHECK: flat_cap|tiered|team|multi_layer|split
              structure_type: "split",
              created_at:   new Date().toISOString(),
            })

          created.push("agent_commission_profiles")
        }
      }
    }

    // ── 3. transaction_coordinators row — only for TC_ROLES ───────────────
    if (TC_ROLES.has(userType) && brokerageId) {
      const { data: existingTC } = await service
        .from("transaction_coordinators")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle()

      if (existingTC) {
        coordinatorId = existingTC.id
      } else {
        const fullName = [params.firstName, params.lastName].filter(Boolean).join(" ") || params.email
        const { data: newTC } = await service
          .from("transaction_coordinators")
          .insert({
            user_id:          userId,
            brokerage_id:     brokerageId,
            display_name:     fullName,
            is_active:        true,
            max_active_deals: 20,
            created_at:       new Date().toISOString(),
          })
          .select("id")
          .maybeSingle()

        if (newTC?.id) {
          coordinatorId = newTC.id
          created.push("transaction_coordinators")
        }
      }
    }

    // ── 4. agent_onboarding row — AGENT-SCOPED ───────────────────────────
    // agent_onboarding.agent_id is NOT NULL and FKs → agents.id, so this row can
    // only exist alongside an agents row. It is therefore created for a solo/team
    // OWNER and every invited agent role, but NOT for a pure-admin owner
    // (brokerage / multi_location), whose onboarding is tracked at
    // brokerages.onboarding_status. Idempotency key = the UNIQUE(agent_id).
    if (agentId && brokerageId) {
      const { data: existingOnboarding } = await service
        .from("agent_onboarding")
        .select("id")
        .eq("agent_id", agentId)
        .maybeSingle()

      if (!existingOnboarding) {
        await service
          .from("agent_onboarding")
          .insert({
            user_id:              userId,
            agent_id:             agentId,
            brokerage_id:         brokerageId,
            // agent_onboarding.status CHECK: in_progress|completed|paused
            status:               "in_progress",
            completion_percentage: 0,
            current_day:          1,
            certification_achieved: false,
            start_date:           new Date().toISOString().slice(0, 10),
            created_at:           new Date().toISOString(),
          })

        created.push("agent_onboarding")
      }
    }

    // ── 5. user_role_assignments — upsert canonical RBAC row ─────────────
    if (brokerageId) {
      const { data: upserted, error: upsertErr } = await service
        .from("user_role_assignments")
        .upsert(
          {
            user_id:      userId,
            role:         userType,
            brokerage_id: brokerageId,
            team_id:      teamId ?? null,
            agent_id:     agentId,
            created_at:   new Date().toISOString(),
            updated_at:   new Date().toISOString(),
          },
          // The real unique constraint is (user_id, role) — onConflict:"user_id"
          // alone matches no unique index and throws 42P10 at runtime.
          { onConflict: "user_id,role" }
        )
        // supabase-js RESOLVES a failed write, and a row refused by RLS comes back
        // as error:null with nothing written. Selecting the id turns both into
        // something this function can actually see.
        .select("id")

      if (upsertErr || (upserted?.length ?? 0) === 0) {
        return {
          success: false,
          agentId,
          coordinatorId,
          domainRecordsCreated: created,
          error: upsertErr?.message ?? "role grant upsert wrote no row",
        }
      }

      // Only claim a creation when the probe SUCCEEDED and found nothing. A failed
      // probe leaves `existingRole` null too, and reporting that as a creation is
      // the same conflation this pass exists to remove.
      if (!existingRoleErr && !existingRole) created.push("user_role_assignments")
    }

    // ── 6. Emit lifecycle event ───────────────────────────────────────────
    await emitUserProvisionedEvent({
      userId,
      userType,
      brokerageId,
      callerUserId,
      eventType: created.length > 0
        ? KernelEvent.USER_DOMAIN_RECORDS_CREATED
        : KernelEvent.USER_DOMAIN_RECORDS_REPAIRED,
      metadata: { domainRecordsCreated: created, agentId, coordinatorId },
    })

    return { success: true, agentId, coordinatorId, domainRecordsCreated: created }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown provisioning error"
    return { success: false, agentId, coordinatorId, domainRecordsCreated: created, error: message }
  }
}

// ─── resolveUserWorkspaceContext ──────────────────────────────────────────────

/**
 * Loads the full workspace state for a user.
 * Used by dashboard/page.tsx to determine routing AND detect incomplete accounts.
 *
 * Returns:
 *   isComplete      — false if required domain records are missing
 *   requiresSetup   — true if the user should be redirected to setup flow
 *   missingRecords  — list of table names with missing required rows
 *   dashboardRoute  — the target route once complete
 */
export async function resolveUserWorkspaceContext(userId: string): Promise<WorkspaceContext> {
  const service = createServiceClient()

  // The role-grant read is NOT `.maybeSingle()` — see below. It is the one read
  // in this batch whose subject can legitimately be several rows.
  const [
    { data: userData },
    { data: agentData },
    { data: tcData },
    { data: onboardingData },
    roleGrantsResult,
  ] = await Promise.all([
    service.from("users").select("user_type, brokerage_id, team_id").eq("id", userId).maybeSingle(),
    service.from("agents").select("id").eq("user_id", userId).maybeSingle(),
    service.from("transaction_coordinators").select("id").eq("user_id", userId).maybeSingle(),
    service.from("agent_onboarding").select("id, status").eq("user_id", userId).maybeSingle(),
    readRoleGrants(service, userId),
  ])

  // WAS: `.from("user_role_assignments").select("role, agent_id").eq("user_id", userId).maybeSingle()`
  // — no vendor filter, no limit, and the error discarded by the `{ data: … }`
  // destructuring. This was the most exposed instance of defect #221 in the tree:
  // every other site at least narrowed by `.not("vendor_id","is",null)` first, so
  // they needed an unlucky data shape to break. This one narrowed by nothing, and
  // user_role_assignments is UNIQUE on (user_id, role), NOT on user_id.
  //
  // MEASURED on the live database: one user holds THREE grants (agent + admin +
  // isa). `.maybeSingle()` over three rows is an ERROR, supabase-js RESOLVES it,
  // and the discarded error became `roleData = null`. So for that user this
  // function reported hasRoleAssignment:false and lost the `agent_id` fallback on
  // the line below — meaning a user WITH an agent grant could be told they were
  // missing their agents row and pushed back into setup. It is broken today, not
  // hypothetically.
  if (!roleGrantsResult.ok) {
    console.error("[kernel/users] role grant read failed:", roleGrantsResult.error)
  }
  const roleGrants = roleGrantsResult.ok ? roleGrantsResult.grants : []

  const userType   = userData?.user_type ?? "agent"
  const brokerageId = userData?.brokerage_id ?? null
  const teamId     = userData?.team_id ?? null
  // Only a grant that actually carries an agent_id can stand in for the agents row;
  // picking "the" grant first and then reading agent_id off it would discard a real
  // agent linkage whenever another grant happened to sort ahead of it.
  //
  // And `find` is not enough either: public.agents is UNIQUE (user_id), so one
  // user's grants can only correctly name ONE agent, and two different ones is a
  // provable data fault that `find` would settle by row order. selectAgentId
  // reports it instead — and here the authoritative `agentData` (read straight off
  // agents by user_id) is already preferred, so a reported fault simply leaves the
  // fallback unused rather than substituting another agent's identity.
  const { agentId: agentGrantId, ambiguous: agentGrantAmbiguous } = selectAgentId(roleGrants)
  if (agentGrantAmbiguous) {
    console.error("[kernel/users] user", userId, "holds grants naming more than one agent")
  }
  const agentId    = agentData?.id ?? agentGrantId
  const coordinatorId = tcData?.id ?? null

  // Load the tenant tier so a solo/team OWNER (admin/broker) is correctly held
  // to the agent-row requirement (they carry the book of business).
  let tier: string | null = null
  if (brokerageId) {
    const { data: brk } = await service.from("brokerages").select("plan_tier").eq("id", brokerageId).maybeSingle()
    tier = brk?.plan_tier ?? null
  }

  const missing: string[] = []

  // Check required domain records
  if (requiresAgentRow(userType as UserDomainRole, tier) && !agentId) {
    missing.push("agents")
  }
  if (TC_ROLES.has(userType as UserDomainRole) && !coordinatorId) {
    missing.push("transaction_coordinators")
  }
  // Onboarding is agent-scoped (agent_id NOT NULL) — expected exactly when an
  // agents row is expected. ONE VOCABULARY (§6, wave 26): asked through
  // `requiresOnboardingRow` (tenant-provisioning-spec.ts:31), the predicate
  // declared for THIS question, rather than through the agents-row predicate
  // plus a comment explaining that the two coincide. They coincide today because
  // agent_onboarding.agent_id is NOT NULL; if that ever stops being true, the
  // spec module is the one place that has to change.
  if (requiresOnboardingRow(userType as UserDomainRole, tier) && !onboardingData) {
    missing.push("agent_onboarding")
  }

  const isComplete    = missing.length === 0
  const requiresSetup = !isComplete || onboardingData?.status === "pending"

  const dashboardRoute = roleDashboardRoute(userType)

  return {
    userId,
    userType,
    brokerageId,
    teamId,
    agentId,
    coordinatorId,
    hasAgentRow:       !!agentId,
    hasOnboardingRow:  !!onboardingData,
    hasRoleAssignment: roleGrants.length > 0,
    isComplete,
    dashboardRoute,
    requiresSetup,
    missingRecords: missing,
  }
}

// ─── assignUserRoleAndEntitlements ────────────────────────────────────────────

/**
 * Updates a user's role across the users table and user_role_assignments.
 * users.user_type is the single source of truth; users.role is legacy and
 * no longer written (migration 036+).
 */
export async function assignUserRoleAndEntitlements(
  params: RoleAssignmentParams
): Promise<RoleAssignmentResult> {
  const service = createServiceClient()

  try {
    const { error: userErr } = await service
      .from("users")
      .update({
        user_type:  params.newRole,
        updated_at: new Date().toISOString(),
      })
      .eq("id", params.userId)

    if (userErr) return { success: false, error: userErr.message }

    // Upsert user_role_assignments for RBAC
    if (params.brokerageId) {
      await service
        .from("user_role_assignments")
        .upsert(
          {
            user_id:      params.userId,
            role:         params.newRole,
            brokerage_id: params.brokerageId,
            team_id:      params.teamId ?? null,
            agent_id:     params.agentId ?? null,
            updated_at:   new Date().toISOString(),
          },
          { onConflict: "user_id,role" }
        )
    }

    await emitUserProvisionedEvent({
      userId:       params.userId,
      userType:     params.newRole,
      brokerageId:  params.brokerageId,
      callerUserId: params.callerUserId,
      eventType:    KernelEvent.USER_ROLE_CHANGED,
      metadata:     { newRole: params.newRole },
    })

    return { success: true }
  } catch (err: unknown) {
    return { success: false, error: err instanceof Error ? err.message : "Role assignment failed" }
  }
}

// ─── assignUserToBrokerage ────────────────────────────────────────────────────

export async function assignUserToBrokerage(params: {
  userId: string
  brokerageId: string
  callerUserId: string
}): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()

  const { error } = await service
    .from("users")
    .update({ brokerage_id: params.brokerageId, updated_at: new Date().toISOString() })
    .eq("id", params.userId)

  if (error) return { success: false, error: error.message }

  // Also update agents row if exists
  await service
    .from("agents")
    .update({ brokerage_id: params.brokerageId })
    .eq("user_id", params.userId)

  // Update user_role_assignments
  await service
    .from("user_role_assignments")
    .update({ brokerage_id: params.brokerageId, updated_at: new Date().toISOString() })
    .eq("user_id", params.userId)

  await emitUserProvisionedEvent({
    userId:       params.userId,
    userType:     "agent",
    brokerageId:  params.brokerageId,
    callerUserId: params.callerUserId,
    eventType:    KernelEvent.USER_BROKERAGE_ASSIGNED,
    metadata:     { brokerageId: params.brokerageId },
  })

  return { success: true }
}

// ─── assignUserToTeam ─────────────────────────────────────────────────────────

export async function assignUserToTeam(params: {
  userId: string
  teamId: string
  brokerageId: string
  callerUserId: string
}): Promise<{ success: boolean; error?: string }> {
  const service = createServiceClient()

  const { error } = await service
    .from("users")
    .update({ team_id: params.teamId, updated_at: new Date().toISOString() })
    .eq("id", params.userId)

  if (error) return { success: false, error: error.message }

  await service
    .from("agents")
    .update({ team_id: params.teamId })
    .eq("user_id", params.userId)

  await emitUserProvisionedEvent({
    userId:       params.userId,
    userType:     "agent",
    brokerageId:  params.brokerageId,
    callerUserId: params.callerUserId,
    eventType:    KernelEvent.USER_TEAM_ASSIGNED,
    metadata:     { teamId: params.teamId },
  })

  return { success: true }
}

// ─── repairIncompleteAccountSetup ─────────────────────────────────────────────

/**
 * Detects and repairs incomplete account states.
 * Safe to call on every login — it is idempotent.
 * Uses createOrRepairUserDomainRecords internally.
 */
export async function repairIncompleteAccountSetup(
  userId: string
): Promise<RepairResult> {
  const service = createServiceClient()

  const { data: userData } = await service
    .from("users")
    .select("user_type, brokerage_id, team_id, first_name, last_name, email")
    .eq("id", userId)
    .maybeSingle()

  if (!userData) {
    return { success: false, repaired: [], error: "User record not found" }
  }

  // Resolve the tenant tier so an under-provisioned solo/team OWNER (admin who
  // never got an agents row) is healed on their next login.
  let tier: string | null = null
  if (userData.brokerage_id) {
    const { data: brk } = await service.from("brokerages").select("plan_tier").eq("id", userData.brokerage_id).maybeSingle()
    tier = brk?.plan_tier ?? null
  }

  const result = await createOrRepairUserDomainRecords({
    userId,
    email:       userData.email ?? "",
    firstName:   userData.first_name ?? "",
    lastName:    userData.last_name ?? "",
    userType:    (userData.user_type ?? "agent") as UserDomainRole,
    brokerageId: userData.brokerage_id ?? null,
    teamId:      userData.team_id ?? null,
    tier,
    callerUserId: userId, // self-repair
  })

  if (!result.success) {
    return { success: false, repaired: [], error: result.error }
  }

  if (result.domainRecordsCreated.length > 0) {
    await emitUserProvisionedEvent({
      userId,
      userType:     userData.user_type ?? "agent",
      brokerageId:  userData.brokerage_id ?? null,
      callerUserId: userId,
      eventType:    KernelEvent.USER_ACCOUNT_REPAIRED,
      metadata:     { repaired: result.domainRecordsCreated },
    })
  }

  return { success: true, repaired: result.domainRecordsCreated }
}

// ─── identity guards (shared) ────────────────────────────────────────────────

/** Does this public.users id correspond to a real auth.users row (vs. a stale orphan
 *  that merely holds the email)? */
async function isAuthUser(service: ReturnType<typeof createServiceClient>, id: string): Promise<boolean> {
  try {
    const { data, error } = await service.auth.admin.getUserById(id)
    return !!data?.user && !error
  } catch {
    return false
  }
}

/** Before an invite, resolve whether the email is already held: by a REAL auth-linked
 *  user (reuse it — idempotent) or by a stale ORPHAN (a users row with no auth identity,
 *  e.g. a failed pre-invite / seed row). An orphan's unique email is sentineled so the
 *  invite's on_auth_user_created trigger can create the canonical row; its id is returned
 *  so children can be merged onto the new auth id afterwards. Keeps a stale email from
 *  silently breaking a fresh, correct signup/invite. */
async function resolveEmailHolder(
  service: ReturnType<typeof createServiceClient>,
  email: string,
): Promise<{ authUserId: string | null; orphanToMerge: string | null }> {
  const { data: existing } = await service.from("users").select("id").eq("email", email).maybeSingle()
  if (!existing?.id) return { authUserId: null, orphanToMerge: null }
  if (await isAuthUser(service, existing.id)) return { authUserId: existing.id, orphanToMerge: null }
  // Orphan — free the unique email so the trigger can insert the canonical row.
  await service.from("users").update({ email: `__orphan__:${existing.id}` }).eq("id", existing.id)
  return { authUserId: null, orphanToMerge: existing.id }
}

/** Merge a freed orphan's children onto the canonical auth-id row, then drop the orphan. */
async function mergeOrphan(service: ReturnType<typeof createServiceClient>, orphanId: string | null, authUserId: string): Promise<void> {
  if (!orphanId || orphanId === authUserId) return
  try { await service.rpc("repoint_user_identity", { p_from: orphanId, p_to: authUserId }) } catch (err) {
    console.warn("[users] orphan merge failed:", (err as any)?.message)
  }
}

// ─── inviteTenantMember ───────────────────────────────────────────────────────

export interface TenantMemberParams {
  brokerageId: string
  teamId?: string | null
  email: string
  firstName?: string
  lastName?: string
  userType: UserDomainRole
  /** The admin/broker/team_lead/superadmin who triggered this. */
  callerUserId: string
  redirectTo?: string
}

export interface TenantMemberResult {
  success: boolean
  userId: string | null
  agentId: string | null
  error?: string
}

/**
 * Canonical path to provision a NON-owner member into a tenant — the single core both
 * the tenant-scoped invite (app/actions/admin/invite-user.ts) and superadmin-down
 * cross-tenant creation (app/actions/superadmin/tenant-users.ts) converge on. Callers
 * own authorization + brokerage/team resolution; this owns the identity-correct writes:
 * invite (auth user first, trigger seeds users with the auth id) → pin/enrich the users
 * row → track the invitation → merge any stale orphan email → role-aware domain records
 * (agents/onboarding/role). Same invariant as provisionTenantOwner: users.id === auth.id.
 */
export async function inviteTenantMember(params: TenantMemberParams): Promise<TenantMemberResult> {
  const service = createServiceClient()
  const email = params.email.trim().toLowerCase()
  const { brokerageId, callerUserId, userType } = params
  const teamId = params.teamId ?? null
  const firstName = params.firstName ?? ""
  const lastName = params.lastName ?? ""
  const redirectTo = params.redirectTo ?? `${process.env.NEXT_PUBLIC_APP_URL}/dashboard/onboarding`

  const { authUserId: linked, orphanToMerge } = await resolveEmailHolder(service, email)
  let authUserId = linked

  // CROSS-TENANT CAPTURE GUARD.
  //
  // resolveEmailHolder searches users.email GLOBALLY — it has to, because that column is
  // unique across the platform and a stale holder would otherwise break the invite. But
  // when it returns an existing auth-linked user, the upsert below rewrites that row's
  // brokerage_id to the INVITER's. So a broker who typed the email of an agent at another
  // brokerage did not "invite" them — they moved them, silently, out of their tenant and
  // into their own, taking the agents/onboarding/RBAC provisioning with them. Every
  // broker, admin and team_lead with invite rights could do it knowing only an email.
  //
  // An invite may legitimately RE-invite someone already in this brokerage (idempotent),
  // and a superadmin may legitimately move a user between tenants — that is what the
  // superadmin tenant-users path is for. Anything else is refused.
  if (authUserId) {
    const { data: holder } = await service
      .from("users")
      .select("brokerage_id")
      .eq("id", authUserId)
      .maybeSingle()
    const holderBrokerageId = (holder as { brokerage_id?: string | null } | null)?.brokerage_id ?? null

    if (holderBrokerageId && holderBrokerageId !== brokerageId) {
      const { data: caller } = await service
        .from("users")
        .select("user_type, platform_role")
        .eq("id", callerUserId)
        .maybeSingle()
      const callerType = (caller as { user_type?: string | null } | null)?.user_type ?? ""
      const callerPlatformRole = (caller as { platform_role?: string | null } | null)?.platform_role ?? ""
      const isSuperadmin = callerType === "superadmin" || callerPlatformRole === "superadmin"

      if (!isSuperadmin) {
        return {
          success: false,
          userId: null,
          agentId: null,
          error:
            "That email already belongs to a user at another brokerage. They must leave it before they can be invited here.",
        }
      }
    }
  }

  if (!authUserId) {
    try {
      const { data, error } = await service.auth.admin.inviteUserByEmail(email, {
        data: { first_name: firstName, last_name: lastName, user_type: userType, brokerage_id: brokerageId, team_id: teamId },
        redirectTo,
      })
      authUserId = data?.user?.id ?? null
      if (!authUserId && error && !error.message?.toLowerCase().includes("already registered")) {
        return { success: false, userId: null, agentId: null, error: error.message }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "invite failed"
      if (!msg.toLowerCase().includes("already registered")) return { success: false, userId: null, agentId: null, error: msg }
    }
    if (!authUserId) {
      try { const { data } = await service.auth.admin.listUsers(); authUserId = data?.users?.find((u) => u.email?.toLowerCase() === email)?.id ?? null } catch { /* best-effort */ }
    }
  }
  if (!authUserId) return { success: false, userId: null, agentId: null, error: "Could not resolve auth user id after invite" }

  await service.from("users").upsert(
    {
      id:           authUserId,
      email,
      first_name:   firstName || null,
      last_name:    lastName || null,
      user_type:    userType,
      role:         userType,
      brokerage_id: brokerageId,
      team_id:      teamId,
      is_contact:   false,
      created_by:   callerUserId,
      updated_at:   new Date().toISOString(),
    },
    { onConflict: "id" }
  )

  try {
    // pass 10: the only unique on user_invitations is a PARTIAL EXPRESSION
    // index — (brokerage_id, lower(email)) WHERE status='pending' — which a
    // plain onConflict string cannot target, so the old upsert errored every
    // time. The rule it encodes (one PENDING invite per brokerage+email) is
    // enforced with an explicit find-pending → update-or-insert.
    const invitePayload = { brokerage_id: brokerageId, team_id: teamId, invited_by: callerUserId, email, user_type: userType, first_name: firstName, last_name: lastName, status: "pending" }
    const { data: pending } = await service.from("user_invitations")
      .select("id").eq("brokerage_id", brokerageId).ilike("email", email).eq("status", "pending").maybeSingle()
    if (pending) {
      await service.from("user_invitations").update({ ...invitePayload, updated_at: new Date().toISOString() }).eq("id", pending.id)
    } else {
      await service.from("user_invitations").insert(invitePayload)
    }
  } catch (err) { console.warn("[inviteTenantMember] invitation write failed:", (err as any)?.message) }

  await mergeOrphan(service, orphanToMerge, authUserId)

  const domain = await createOrRepairUserDomainRecords({
    userId: authUserId, email, firstName, lastName, userType, brokerageId, teamId, callerUserId,
  })

  return { success: true, userId: authUserId, agentId: domain.agentId }
}

// ─── provisionTenantOwner ─────────────────────────────────────────────────────

export type CanonicalTier = "solo_agent" | "team" | "brokerage" | "multi_location"

export interface TenantOwnerParams {
  email: string
  firstName: string
  lastName: string
  brokerageId: string
  brokerageName: string
  tier: CanonicalTier
  /** Post-invite landing (e.g. /auth/callback?next=/dashboard/onboarding). */
  redirectTo: string
  /** The staff/superadmin who triggered provisioning; null for self-serve signup. */
  callerUserId?: string | null
}

export interface TenantOwnerResult {
  success: boolean
  userId: string | null
  agentId: string | null
  teamId: string | null
  inviteSent: boolean
  inviteError?: string
  error?: string
}

/**
 * Canonical tenant-OWNER provisioning — the single path both self-serve signup
 * (app/actions/auth/signup-brokerage.ts) and superadmin provisioning
 * (app/actions/admin/create-subscriber.ts) converge on, so they can never drift.
 *
 * THE INVARIANT the whole app depends on: public.users.id === auth.users.id
 * (get-agent-context, every RLS auth.uid() policy, the agents.user_id → users.id FK).
 * The only way to satisfy it is to let the AUTH user exist FIRST — the
 * on_auth_user_created trigger then seeds public.users with the auth id — and pin
 * that id on every subsequent write. Pre-inserting a public.users row (random id)
 * BEFORE the invite both orphans the profile AND collides with the trigger on the
 * email-unique constraint, silently rolling back auth-user creation so the owner
 * can never log in. This helper does it in the proven order and is tier-aware:
 *   • invite → auth user + trigger-seeded users row (correct id)
 *   • pin/enrich the users row (id, name, admin role, brokerage)
 *   • team tier → create the teams row + link the owner as its lead
 *   • tier-aware domain records — a solo/team owner gets an agents row (+ commission
 *     + onboarding + role assignment); a brokerage/multi owner is a pure admin.
 */
export async function provisionTenantOwner(params: TenantOwnerParams): Promise<TenantOwnerResult> {
  const service = createServiceClient()
  const { firstName, lastName, brokerageId, brokerageName, tier, redirectTo } = params
  const callerUserId = params.callerUserId ?? null
  const email = params.email.trim().toLowerCase()

  // 1. Resolve the email holder: reuse a REAL auth-linked user (idempotent re-run) or
  //    free a stale ORPHAN email (failed pre-invite / seed) so the trigger can create
  //    the canonical row; the orphan's children are merged onto the auth id afterwards.
  const { authUserId: linkedId, orphanToMerge } = await resolveEmailHolder(service, email)

  // SEATS — the owner is the tenant's FIRST seat, and on a brand-new tenant this
  // is a no-op (0 in use, 2 available on the smallest plan). It is here for the
  // two cases where it is not: this helper takes an EXISTING brokerageId (both
  // callers create the row first), so re-running it against a live tenant, or
  // superadmin create-subscriber pointed at one, would otherwise seat another
  // admin with nothing counting. An idempotent re-run for the SAME owner passes
  // through `already_seated` on their linked id rather than being charged twice.
  // Same gate as every other add path; FAILS CLOSED (lib/kernel/seat-usage.ts).
  {
    const verdict = await seatGate(service, brokerageId, "admin", { subjectUserId: linkedId })
    if (!verdict.allowed) {
      return {
        success: false, userId: null, agentId: null, teamId: null, inviteSent: false,
        error: verdict.message ?? "Seat limit reached for this workspace.",
      }
    }
  }

  let authUserId: string | null = linkedId
  let inviteSent = false
  let inviteError: string | undefined

  // 2. Create the auth user FIRST. The trigger seeds public.users with the auth
  //    id from this metadata; we never pre-insert (that is the collision bug).
  if (!authUserId) {
    try {
      const { data: inviteData, error: inviteErr } = await service.auth.admin.inviteUserByEmail(email, {
        data: { first_name: firstName, last_name: lastName, brokerage_id: brokerageId, user_type: "admin" },
        redirectTo,
      })
      authUserId = inviteData?.user?.id ?? null
      if (authUserId) {
        inviteSent = true
      } else if (inviteErr && !inviteErr.message?.toLowerCase().includes("already registered")) {
        return { success: false, userId: null, agentId: null, teamId: null, inviteSent: false, inviteError: inviteErr.message, error: `Invite failed: ${inviteErr.message}` }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "invite failed"
      if (!msg.toLowerCase().includes("already registered")) {
        return { success: false, userId: null, agentId: null, teamId: null, inviteSent: false, inviteError: msg, error: `Invite failed: ${msg}` }
      }
      inviteError = msg
    }
  }

  // 2b. "Already registered" in auth but no users row yet → recover the auth id.
  if (!authUserId) {
    try {
      const { data: list } = await service.auth.admin.listUsers()
      authUserId = list?.users?.find((u) => u.email?.toLowerCase() === email)?.id ?? null
    } catch { /* best-effort */ }
  }
  if (!authUserId) {
    return { success: false, userId: null, agentId: null, teamId: null, inviteSent, inviteError, error: "Could not resolve auth user id after invite" }
  }

  // 3. Pin/enrich the public.users row (trigger created it; guarantee id + fields).
  await service.from("users").upsert(
    {
      id:           authUserId,
      email,
      first_name:   firstName,
      last_name:    lastName,
      user_type:    "admin",
      role:         "admin",
      brokerage_id: brokerageId,
      is_contact:   false,
      updated_at:   new Date().toISOString(),
    },
    { onConflict: "id" }
  )

  // 3b. Merge any freed orphan email's children onto the canonical auth-id row.
  await mergeOrphan(service, orphanToMerge, authUserId)

  // 4. Team tier → the team must exist (team = team_lead + teams row) so invited
  //    agents can be attached. Idempotent: reuse the brokerage's first live team.
  let teamId: string | null = null
  // ONE VOCABULARY (§6, wave 26): `ownerNeedsTeamRow(tier)`
  // (tenant-provisioning-spec.ts:36) is the declared answer to "does this tier
  // require a teams row"; the inline `tier === "team"` was a second copy of it
  // sitting in the provisioning path the spec module exists to describe.
  if (ownerNeedsTeamRow(tier)) {
    const { data: existingTeam } = await service
      .from("teams").select("id").eq("brokerage_id", brokerageId).is("deleted_at", null)
      .order("created_at", { ascending: true }).limit(1).maybeSingle()
    if (existingTeam) {
      teamId = existingTeam.id
    } else {
      const { data: newTeam } = await service.from("teams")
        .insert({ name: brokerageName, brokerage_id: brokerageId, team_lead_id: authUserId })
        .select("id").maybeSingle()
      teamId = newTeam?.id ?? null
    }
    if (teamId) await service.from("users").update({ team_id: teamId }).eq("id", authUserId)
  }

  // 5. Tier-aware domain records — agents row for a solo/team owner, onboarding,
  //    role assignment. Reuses the ONE provisioning brain (also used by invite).
  const domain = await createOrRepairUserDomainRecords({
    userId:       authUserId,
    email,
    firstName,
    lastName,
    userType:     "admin",
    brokerageId,
    teamId,
    tier,
    callerUserId: callerUserId ?? authUserId,
  })

  return { success: true, userId: authUserId, agentId: domain.agentId, teamId, inviteSent, inviteError }
}

// ─── emitUserProvisionedEvent (internal) ─────────────────────────────────────

/**
 * Writes a lifecycle_events row for any user provisioning event.
 * Matches the lifecycle_events schema: entity_type, entity_id, event_type, actor_user_id, brokerage_id, metadata.
 */
export async function emitUserProvisionedEvent(params: {
  userId: string
  userType: string
  brokerageId: string | null
  callerUserId: string
  eventType: KernelEvent
  metadata?: Record<string, unknown>
}): Promise<void> {
  const service = createServiceClient()

  await service
    .from("lifecycle_events")
    .insert({
      entity_type:   "user",
      entity_id:     params.userId,
      event_type:    params.eventType,
      actor_user_id: params.callerUserId,
      brokerage_id:  params.brokerageId,
      metadata:      params.metadata ?? {},
      created_at:    new Date().toISOString(),
    })
}
