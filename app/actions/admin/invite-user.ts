"use server"

import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { createServiceClient } from "@/lib/supabase/service"
import { inviteTenantMember } from "@/lib/kernel/users"
import { emitUserProvisionedEvent } from "@/lib/kernel/users"
import { KernelEvent } from "@/lib/kernel/events"
import type { UserDomainRole } from "@/lib/kernel/users"
import { tierAllowsRole, roleRefusalReason, seatableUserTypes } from "@/lib/kernel/tier-role-matrix"
import { CHECK_VOCABULARIES } from "@/scripts/check-vocabularies"
import { seatGate } from "@/lib/kernel/seat-usage"
import { isAdminOrBroker } from "@/lib/auth/resolve-user-role"

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
  /**
   * Present only when the invite was held because it would cross the seat limit.
   * Carries the upgrade-vs-paid-seat choice so the UI can offer both instead of
   * rendering a dead end (see seatDecision in lib/kernel/tier-role-matrix).
   */
  seatDecision?: import("@/lib/kernel/tier-role-matrix").SeatDecision
}

// Roles a team lead is allowed to assign (never admin/broker).
// 'lender' removed (owner ruling: lender is a vendor CATEGORY, not a user type).
// tierAllowsRole below already refused it — see roleRefusalReason in
// lib/kernel/tier-role-matrix.ts — so this entry was a second spelling of a value
// that could not be invited, and the kind of leftover that gets copied forward.
const BROKERAGE_ASSIGNABLE_ROLES = new Set([
  "agent", "tc", "isa", "team_lead", "compliance_officer", "vendor",
])

// Roles only platform staff can assign. Tenant admins/brokers CAN invite
// admin/broker peers — always pinned to their OWN brokerage (see scope
// resolution below), so this is intra-tenant delegation, not escalation.
const SUPERADMIN_ONLY_ROLES = new Set(["superadmin"])

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
  if (!isAdminOrBroker({ user_type: callerType })) {
    return { success: false, error: "Forbidden: insufficient privileges to invite users" }
  }

  // ── 3. Role boundary checks ───────────────────────────────────────────────
  const requestedRole = params.userType as UserDomainRole

  // Prevent non-superadmins from granting the platform-staff role
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

  // ── 4b. Tier-aware role matrix (composes WITH the caller-role checks above) ─
  // The tenant's plan tier bounds which roles may be seated at all: solo = one
  // seat (partners only), team adds team structure, brokerage/multi_location add
  // governance roles. This applies to EVERY caller on this tenant-tier surface —
  // including superadmin acting on behalf of a tenant; the only sanctioned
  // bypass lives in the platform-side createTenantUserAction (god console).
  const { data: tenant, error: tierErr } = await service
    .from("brokerages")
    .select("plan_tier, billing_metadata")
    .eq("id", resolvedBrokerageId)
    .maybeSingle()
  if (tierErr) return { success: false, error: tierErr.message }

  const tenantTier = tenant?.plan_tier ?? null
  if (!tierAllowsRole(tenantTier, requestedRole)) {
    // The refusal is no longer ABOUT THE PLAN. Under the owner's ruling every
    // tier seats every staff user type and the tier decides only HOW MANY, so
    // the only values still refused here are the ones that are not workspace
    // seats on any plan. `roleRefusalReason` says which, and never offers an
    // upgrade that would buy nothing.
    return { success: false, error: roleRefusalReason(requestedRole) ?? `'${requestedRole}' cannot be invited.` }
  }

  // The database is the last word on which user types exist: users_user_type_check
  // is VALIDATED, and an INSERT naming a value outside it is refused ENTIRELY
  // (CLAUDE.md §3). Catching it HERE turns a raw constraint violation into a
  // sentence, and keeps this server action in agreement with the menu the client
  // rendered from `seatableUserTypes`.
  if (!seatableUserTypes(tenantTier, CHECK_VOCABULARIES.users?.user_type).includes(requestedRole)) {
    return {
      success: false,
      error: `'${requestedRole}' is not a user type this database can store yet. No invite was sent.`,
    }
  }

  // ── Gate 4c: SEATS (owner-corrected model — roles are open, seats are the
  // constraint: Solo 2 · Team 5 · Brokerage/Multi unlimited). A seat is a
  // working staff user; partners (vendor) never consume one. Suspended users
  // don't hold a seat — deactivate one to free it.
  //
  // ONE GATE — lib/kernel/seat-usage.ts `seatGate`, shared with the god console,
  // the role-change path, the reactivation path and the recruiting provisioner,
  // because a cap enforced on one path is not a cap. It reads the count from the
  // one seat resolver (BOTH role sources), the limit from the PLAN CATALOGUE
  // (subscription_tiers.max_agents, with the staff override on top), and it FAILS
  // CLOSED: an unreadable tenant, count or catalogue REFUSES and says which.
  //
  // PAST THE LIMIT IS AN UPGRADE. The owner's ruling — "agent tier subscription
  // only has 2 seats and if they need more than they need to upgrade to a team
  // subscription", team → brokerage — makes this a refusal that names the next
  // tier, not a dead end and not a per-seat upsell. The full decision rides back
  // so the UI can render that tier as a button.
  {
    const verdict = await seatGate(service, resolvedBrokerageId, requestedRole)
    if (!verdict.allowed) {
      return {
        success: false,
        seatDecision: verdict.decision ?? undefined,
        error: verdict.message ?? undefined,
      }
    }
  }

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
    // The catch below can never see a REJECTED row — supabase-js resolves those
    // as { error } — so the audit entry could stop landing without a sound.
    // Read it: the invite itself is already committed, so this only reports.
    const { error: auditError } = await service
      .from("activities")
      .insert({
        activity_type: "admin.user.invited",
        agent_id:      await resolveAgentId(supabase as any, user.id),
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
    if (auditError) console.error("[inviteUser] audit activity REJECTED:", auditError.message)
  } catch (err: unknown) {
    console.error("[v0] Audit log error:", err)
  }

  return { success: true }
}
