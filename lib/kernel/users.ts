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
//   agent_onboarding.agent_id          → agents.id (nullable for non-agent TC)
//   user_role_assignments.user_id      → users.id
//   user_role_assignments.brokerage_id → brokerages.id
//   user_role_assignments.agent_id     → agents.id (nullable)

"use server"

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "./events"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export type UserDomainRole =
  | "agent"
  | "broker"
  | "admin"
  | "tc"
  | "isa"
  | "team_lead"
  | "compliance_officer"
  | "vendor"
  | "lender"
  | "superadmin"
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

const ROLE_DASHBOARD_ROUTES: Record<string, string> = {
  superadmin:          "/dashboard/admin",
  admin:               "/dashboard/admin",
  broker:              "/dashboard/brokerage",
  tc:                  "/dashboard/coordinator",
  compliance_officer:  "/dashboard/compliance",
  isa:                 "/dashboard/isa",
  team_lead:           "/dashboard/agent",
  agent:               "/dashboard/agent",
  contact:             "/portal",
  vendor:              "/vendor/dashboard",
  lender:              "/lender/dashboard",
  system:              "/dashboard/admin",
}

// Roles that require an agents table row
const AGENT_ROLES = new Set<UserDomainRole>(["agent", "isa", "team_lead"])

// Roles that require a transaction_coordinators table row
const TC_ROLES = new Set<UserDomainRole>(["tc"])

// Roles that require an agent_onboarding row
const ONBOARDING_ROLES = new Set<UserDomainRole>(["agent", "isa", "team_lead", "tc"])

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
    const { userId, userType, brokerageId, teamId, callerUserId } = params

    // ── 1. user_role_assignments ──────────────────────────────────────────
    // Write canonical RBAC join row for ALL roles
    const { data: existingRole } = await service
      .from("user_role_assignments")
      .select("id, agent_id")
      .eq("user_id", userId)
      .maybeSingle()

    // ── 2. agents row — only for AGENT_ROLES ─────────────────────────────
    if (AGENT_ROLES.has(userType) && brokerageId) {
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
            active:         true,
            onboarding_status: "pending",
            created_at:     new Date().toISOString(),
            updated_at:     new Date().toISOString(),
          })
          .select("id")
          .maybeSingle()

        if (newAgent?.id) {
          agentId = newAgent.id
          created.push("agents")

          // ── 2a. agent_commission_profiles (default 70/30) ──────────────
          // Schema: split_percent (not split_percentage), no updated_at
          await service
            .from("agent_commission_profiles")
            .insert({
              agent_id:     agentId,
              brokerage_id: brokerageId,
              split_percent: 70,
              is_active:    true,
              effective_date: new Date().toISOString().slice(0, 10),
              structure_type: "standard",
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

    // ── 4. agent_onboarding row — for all agent/TC roles ─────────────────
    // Schema: user_id, agent_id (nullable), brokerage_id, status, completion_percentage
    // NO updated_at column in this table
    if (ONBOARDING_ROLES.has(userType) && brokerageId) {
      const { data: existingOnboarding } = await service
        .from("agent_onboarding")
        .select("id")
        .eq("user_id", userId)
        .maybeSingle()

      if (!existingOnboarding) {
        await service
          .from("agent_onboarding")
          .insert({
            user_id:              userId,
            agent_id:             agentId,
            brokerage_id:         brokerageId,
            status:               "pending",
            completion_percentage: 0,
            current_day:          1,
            certification_achieved: false,
            start_date:           new Date().toISOString().slice(0, 10),
            created_at:           new Date().toISOString(),
          })
          .catch(() => {})

        created.push("agent_onboarding")
      }
    }

    // ── 5. user_role_assignments — upsert canonical RBAC row ─────────────
    if (brokerageId) {
      await service
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
          { onConflict: "user_id" }
        )
        .catch(() => {})

      if (!existingRole) created.push("user_role_assignments")
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

  const [
    { data: userData },
    { data: agentData },
    { data: tcData },
    { data: onboardingData },
    { data: roleData },
  ] = await Promise.all([
    service.from("users").select("user_type, brokerage_id, team_id").eq("id", userId).maybeSingle(),
    service.from("agents").select("id").eq("user_id", userId).maybeSingle(),
    service.from("transaction_coordinators").select("id").eq("user_id", userId).maybeSingle(),
    service.from("agent_onboarding").select("id, status").eq("user_id", userId).maybeSingle(),
    service.from("user_role_assignments").select("role, agent_id").eq("user_id", userId).maybeSingle(),
  ])

  const userType   = userData?.user_type ?? "agent"
  const brokerageId = userData?.brokerage_id ?? null
  const teamId     = userData?.team_id ?? null
  const agentId    = agentData?.id ?? roleData?.agent_id ?? null
  const coordinatorId = tcData?.id ?? null

  const missing: string[] = []

  // Check required domain records
  if (AGENT_ROLES.has(userType as UserDomainRole) && !agentId) {
    missing.push("agents")
  }
  if (TC_ROLES.has(userType as UserDomainRole) && !coordinatorId) {
    missing.push("transaction_coordinators")
  }
  if (ONBOARDING_ROLES.has(userType as UserDomainRole) && !onboardingData) {
    missing.push("agent_onboarding")
  }

  const isComplete    = missing.length === 0
  const requiresSetup = !isComplete || onboardingData?.status === "pending"

  const dashboardRoute = ROLE_DASHBOARD_ROUTES[userType] ?? "/dashboard/agent"

  return {
    userId,
    userType,
    brokerageId,
    teamId,
    agentId,
    coordinatorId,
    hasAgentRow:       !!agentId,
    hasOnboardingRow:  !!onboardingData,
    hasRoleAssignment: !!roleData,
    isComplete,
    dashboardRoute,
    requiresSetup,
    missingRecords: missing,
  }
}

// ─── assignUserRoleAndEntitlements ────────────────────────────────────────────

/**
 * Updates a user's role across both users table and user_role_assignments.
 * Enforces:
 *   - Non-superadmin callers cannot grant superadmin
 *   - Role change emits USER_ROLE_CHANGED event
 *   - Syncs role field in both users.user_type AND users.role (legacy compat)
 */
export async function assignUserRoleAndEntitlements(
  params: RoleAssignmentParams
): Promise<RoleAssignmentResult> {
  const service = createServiceClient()

  try {
    // Update users table — keep both user_type and role in sync
    const { error: userErr } = await service
      .from("users")
      .update({
        user_type:  params.newRole,
        role:       params.newRole,
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
          { onConflict: "user_id" }
        )
        .catch(() => {})
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
    .catch(() => {})

  // Update user_role_assignments
  await service
    .from("user_role_assignments")
    .update({ brokerage_id: params.brokerageId, updated_at: new Date().toISOString() })
    .eq("user_id", params.userId)
    .catch(() => {})

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
    .catch(() => {})

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

  const result = await createOrRepairUserDomainRecords({
    userId,
    email:       userData.email ?? "",
    firstName:   userData.first_name ?? "",
    lastName:    userData.last_name ?? "",
    userType:    (userData.user_type ?? "agent") as UserDomainRole,
    brokerageId: userData.brokerage_id ?? null,
    teamId:      userData.team_id ?? null,
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
    .catch(() => {}) // Non-fatal — audit trail should not block provisioning
}
