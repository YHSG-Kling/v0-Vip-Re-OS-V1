"use server"

import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { createServiceClient } from "@/lib/supabase/service"
import { assignUserRoleAndEntitlements, assignUserToBrokerage } from "@/lib/kernel/users"
import type { UserDomainRole } from "@/lib/kernel/users"
import { tierAllowsRole, tierLabel, minimumTierForRole, TIER_LABELS } from "@/lib/kernel/tier-role-matrix"

export interface UpdateUserParams {
  userId: string
  updates: {
    first_name?: string
    last_name?: string
    /** Contact phone (users.phone) — was previously not editable from the admin UI */
    phone?: string
    /** Canonical role field — will sync to both user_type and user_role_assignments */
    user_type?: string
    /** Legacy alias — treated as user_type if user_type is not provided */
    role?: string
    status?: string
    brokerage_id?: string | null
    team_id?: string | null
  }
}

export interface UpdateUserResult {
  success: boolean
  error?: string
}

// Only platform staff can assign this role. Tenant admins/brokers may promote
// users to admin/broker WITHIN their own brokerage (the scope guard below
// rejects any cross-brokerage target), matching the invite path.
const SUPERADMIN_ONLY_ROLES = new Set(["superadmin"])

export async function updateUser({ userId, updates }: UpdateUserParams): Promise<UpdateUserResult> {
  // ── 1. Auth gate ──────────────────────────────────────────────────────────
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthenticated" }

  // ── 2. Caller role — use user_type, not legacy role ───────────────────────
  const { data: caller } = await supabase
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", user.id)
    .maybeSingle()

  const callerRole = caller?.user_type ?? "agent"
  if (!["admin", "broker", "superadmin"].includes(callerRole)) {
    return { success: false, error: "Forbidden: admin, broker, or superadmin only" }
  }

  // ── 3. Scope guard for non-superadmin callers ─────────────────────────────
  // Tenant admins/brokers MUST be anchored to a brokerage — an unanchored
  // caller gets no cross-tenant reach.
  if (callerRole !== "superadmin" && !caller?.brokerage_id) {
    return { success: false, error: "Forbidden: no brokerage scope" }
  }
  if (callerRole !== "superadmin" && caller?.brokerage_id) {
    const { data: target } = await supabase
      .from("users")
      .select("brokerage_id")
      .eq("id", userId)
      .maybeSingle()

    if (target?.brokerage_id !== caller.brokerage_id) {
      return { success: false, error: "Forbidden: user belongs to a different brokerage" }
    }
    if (updates.brokerage_id && updates.brokerage_id !== caller.brokerage_id) {
      return { success: false, error: "Forbidden: cannot reassign user to another brokerage" }
    }
  }

  // ── 4. Role escalation guard ──────────────────────────────────────────────
  const newRole = updates.user_type ?? updates.role
  if (callerRole !== "superadmin" && newRole && SUPERADMIN_ONLY_ROLES.has(newRole)) {
    return { success: false, error: `Forbidden: cannot assign role '${newRole}'` }
  }

  const service = createServiceClient()

  // ── 5. Snapshot current state for audit ──────────────────────────────────
  const { data: before } = await service
    .from("users")
    .select("first_name, last_name, phone, user_type, role, status, brokerage_id")
    .eq("id", userId)
    .maybeSingle()

  // ── 5b. Tier-aware role matrix for role changes (composes with guard 4) ──
  // A role CHANGE is a seat change: the target tenant's plan tier bounds which
  // roles may exist there (solo = partners only, team adds team seats,
  // brokerage/multi_location add governance roles). Applies to every caller on
  // this tenant surface — superadmin included; the only sanctioned bypass is
  // the platform-side createTenantUserAction. Unanchored (no-brokerage) targets
  // are platform-level users and carry no tenant tier to enforce.
  if (newRole) {
    const roleTargetBrokerageId =
      updates.brokerage_id ?? before?.brokerage_id ?? caller?.brokerage_id ?? null
    if (roleTargetBrokerageId) {
      const { data: tenant, error: tierErr } = await service
        .from("brokerages")
        .select("plan_tier")
        .eq("id", roleTargetBrokerageId)
        .maybeSingle()
      if (tierErr) return { success: false, error: tierErr.message }

      const tenantTier = tenant?.plan_tier ?? null
      if (!tierAllowsRole(tenantTier, newRole as UserDomainRole)) {
        const minTier = minimumTierForRole(newRole as UserDomainRole)
        return {
          success: false,
          error:
            `The ${tierLabel(tenantTier)} plan does not include the '${newRole}' role.` +
            (minTier ? ` Upgrade to ${TIER_LABELS[minTier]} to assign this role.` : ""),
        }
      }
    }
  }

  // ── 6. Build users table patch ────────────────────────────────────────────
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (updates.first_name !== undefined) patch.first_name = updates.first_name
  if (updates.last_name  !== undefined) patch.last_name  = updates.last_name
  if (updates.phone      !== undefined) patch.phone      = updates.phone?.trim() || null
  if (updates.status     !== undefined) patch.status     = updates.status

  // Sync both user_type and legacy role column when role changes
  if (newRole) {
    patch.user_type = newRole
    patch.role      = newRole
  }

  // Handle brokerage change directly on users table here
  // (RBAC sync is handled by kernel below)
  if (updates.brokerage_id !== undefined) {
    patch.brokerage_id = updates.brokerage_id
  }
  if (updates.team_id !== undefined) {
    patch.team_id = updates.team_id
  }

  const { error: updateError } = await service
    .from("users")
    .update(patch)
    .eq("id", userId)

  if (updateError) return { success: false, error: updateError.message }

  // ── 7. Sync user_role_assignments when role or brokerage changes ──────────
  // Delegate to kernel commands that handle full RBAC sync
  const targetBrokerageId = updates.brokerage_id ?? before?.brokerage_id ?? caller?.brokerage_id ?? null

  if (newRole && targetBrokerageId) {
    await assignUserRoleAndEntitlements({
      userId,
      newRole:      newRole as UserDomainRole,
      brokerageId:  targetBrokerageId,
      teamId:       updates.team_id ?? null,
      callerUserId: user.id,
    })
  } else if (updates.brokerage_id && updates.brokerage_id !== before?.brokerage_id) {
    // Brokerage reassignment without role change
    await assignUserToBrokerage({
      userId,
      brokerageId:  updates.brokerage_id,
      callerUserId: user.id,
    })
  }

  // ── 8. Audit log ──────────────────────────────────────────────────────────
  try {
    await service
      .from("activities")
      .insert({
        activity_type: "admin.user.updated",
        agent_id:      await resolveAgentId(supabase as any, user.id),
        brokerage_id:  caller?.brokerage_id ?? null,
        title:         `User updated: ${userId}`,
        description:   JSON.stringify({ before, after: patch, updated_by: user.id }),
        created_at:    new Date().toISOString(),
        updated_at:    new Date().toISOString(),
      })
  } catch (err: unknown) {
    console.error("[v0] Audit log error:", err)
  }

  return { success: true }
}
