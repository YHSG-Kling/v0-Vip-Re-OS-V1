"use server"

import { createClient } from "@/lib/supabase/server"
import { resolveAgentId } from "@/lib/kernel/agent-identity"
import { createServiceClient } from "@/lib/supabase/service"
import { inviteTenantMember } from "@/lib/kernel/users"
import { emitUserProvisionedEvent } from "@/lib/kernel/users"
import { KernelEvent } from "@/lib/kernel/events"
import type { UserDomainRole } from "@/lib/kernel/users"
import { tierAllowsRole, tierLabel, minimumTierForRole, TIER_LABELS, roleConsumesSeat, seatDecision, seatDecisionMessage, parseSeatOverride } from "@/lib/kernel/tier-role-matrix"
import { resolveSeatUsage } from "@/lib/kernel/seat-usage"

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

// Roles a team lead is allowed to assign (never admin/broker)
const BROKERAGE_ASSIGNABLE_ROLES = new Set([
  "agent", "tc", "isa", "team_lead", "compliance_officer", "lender", "vendor",
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
  if (!["admin", "broker", "superadmin", "team_lead"].includes(callerType)) {
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
    const minTier = minimumTierForRole(requestedRole)
    return {
      success: false,
      error:
        `The ${tierLabel(tenantTier)} plan does not include the '${requestedRole}' role.` +
        (minTier ? ` Upgrade to ${TIER_LABELS[minTier]} to invite this role.` : ""),
    }
  }

  // ── Gate 4c: SEATS (owner-corrected model — roles are open, seats are the
  // constraint: Solo 2 · Team 5 · Brokerage/Multi unlimited). A seat is a
  // working staff user; partners (vendor) never consume one. Suspended users
  // don't hold a seat — deactivate one to free it.
  if (roleConsumesSeat(requestedRole)) {
    // ONE seat resolver with every display surface. This hand-rolled the count off
    // users.user_type alone, which under-counts: a user may hold a seat role
    // through user_role_assignments without their primary type being one. On the
    // ENFORCEMENT path that is worse than a wrong label — it admits an invite that
    // pushes the tenant past the limit they pay for.
    const { seatCount } = await resolveSeatUsage(service, resolvedBrokerageId)
    // ONE resolution (effectiveSeatLimit inside seatDecision): staff-set per-tenant
    // override (brokerages.billing_metadata.seat_override) wins when set, else the
    // tier default.
    //
    // PAST THE LIMIT IS A BILLING CHOICE, NOT A DEAD END. This used to refuse the
    // invite and tell the tenant to deactivate someone — at the exact moment they
    // were trying to grow. The owner's ruling is to offer the upgrade first and the
    // per-seat price second, so the answer now names both paths and the decision is
    // theirs. The invite still does not go through on its own: adding a seat they
    // have not paid for is a billing event, and the caller confirms which way.
    const decision = seatDecision(
      tenantTier, seatCount, parseSeatOverride((tenant as any)?.billing_metadata),
    )
    if (!decision.withinLimit) {
      return {
        success: false,
        seatDecision: decision,
        error: seatDecisionMessage(decision) ?? undefined,
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
    await service
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
  } catch (err: unknown) {
    console.error("[v0] Audit log error:", err)
  }

  return { success: true }
}
