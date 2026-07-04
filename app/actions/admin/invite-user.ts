"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { inviteTenantMember } from "@/lib/kernel/users"
import { emitUserProvisionedEvent } from "@/lib/kernel/users"
import { KernelEvent } from "@/lib/kernel/events"
import type { UserDomainRole } from "@/lib/kernel/users"

export interface InviteUserParams {
  email: string
  firstName: string
  lastName: string
  /** Must be a valid UserDomainRole */
  userType: string
  brokerageId?: string | null
  teamId?: string | null
}

export interface InviteUserResult {
  success: boolean
  error?: string
}

// Roles that non-superadmin callers are allowed to assign
const BROKERAGE_ASSIGNABLE_ROLES = new Set([
  "agent", "tc", "isa", "team_lead", "compliance_officer", "lender", "vendor",
])

// Roles only a superadmin can assign
const SUPERADMIN_ONLY_ROLES = new Set(["superadmin", "admin", "broker"])

export async function inviteUser(params: InviteUserParams): Promise<InviteUserResult> {
  // ── 1. Authenticate caller ────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthenticated" }

  // ── 2. Load caller profile — use user_type (canonical), not legacy role ──
  const { data: caller } = await supabase
    .from("users")
    .select("user_type, brokerage_id, team_id")
    .eq("id", user.id)
    .maybeSingle()

  const callerType = caller?.user_type ?? "agent"

  // Only admin, broker, superadmin, and team_lead can invite
  if (!["admin", "broker", "superadmin", "team_lead"].includes(callerType)) {
    return { success: false, error: "Forbidden: insufficient privileges to invite users" }
  }

  // ── 3. Role boundary checks ───────────────────────────────────────────────
  const requestedRole = params.userType as UserDomainRole

  // Prevent non-superadmins from granting superadmin/admin/broker roles
  if (callerType !== "superadmin" && SUPERADMIN_ONLY_ROLES.has(requestedRole)) {
    return { success: false, error: `Forbidden: cannot assign role '${requestedRole}'` }
  }

  // Team leads can only invite within brokerage-assignable roles
  if (callerType === "team_lead" && !BROKERAGE_ASSIGNABLE_ROLES.has(requestedRole)) {
    return { success: false, error: `Forbidden: team leads cannot assign role '${requestedRole}'` }
  }

  // ── 4. Resolve brokerage scope ────────────────────────────────────────────
  // Non-superadmin: always scoped to caller's brokerage
  // Superadmin: may specify a different brokerage via params
  const resolvedBrokerageId: string | null =
    callerType === "superadmin"
      ? params.brokerageId ?? caller?.brokerage_id ?? null
      : caller?.brokerage_id ?? null

  const resolvedTeamId: string | null =
    callerType === "team_lead"
      ? (caller?.team_id ?? params.teamId ?? null)
      : (params.teamId ?? null)

  // ── 5. Provision through the canonical, identity-correct tenant-member path ─
  // inviteTenantMember creates the auth user FIRST (so public.users.id ===
  // auth.users.id — the invariant every read path + RLS policy depends on), pins the
  // users row, tracks the invitation, frees any stale orphan email, and provisions the
  // role-specific domain records (agents / TC / onboarding / user_role_assignments).
  if (!resolvedBrokerageId) {
    return { success: false, error: "A brokerage is required to invite a user." }
  }
  const service = createServiceClient()
  const provisioned = await inviteTenantMember({
    brokerageId:  resolvedBrokerageId,
    teamId:       resolvedTeamId,
    email:        params.email,
    firstName:    params.firstName,
    lastName:     params.lastName,
    userType:     requestedRole,
    callerUserId: user.id,
  })
  if (!provisioned.success || !provisioned.userId) {
    return { success: false, error: provisioned.error ?? "Failed to provision the invited user." }
  }
  const resolvedUserId = provisioned.userId

  // ── 8. Emit USER_INVITED event ────────────────────────────────────────────
  if (resolvedUserId) {
    await emitUserProvisionedEvent({
      userId:       resolvedUserId,
      userType:     requestedRole,
      brokerageId:  resolvedBrokerageId,
      callerUserId: user.id,
      eventType:    KernelEvent.USER_INVITED,
      metadata: {
        email:        params.email,
        invitedRole:  requestedRole,
        brokerageId:  resolvedBrokerageId,
        teamId:       resolvedTeamId,
        invitedBy:    user.id,
      },
    })
  }

  // ── 9. Audit log to activities ────────────────────────────────────────────
  try {
    await service
      .from("activities")
      .insert({
        activity_type: "admin.user.invited",
        agent_id:      user.id,
        brokerage_id:  resolvedBrokerageId,
        title:         `User invited: ${params.email}`,
        notes:         JSON.stringify({
          user_type:    requestedRole,
          brokerage_id: resolvedBrokerageId,
          invited_by:   user.id,
        }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
  } catch (err: unknown) {
    console.error("[v0] Audit log error:", err)
  }

  return { success: true }
}
