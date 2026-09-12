import { createServiceClient } from "@/lib/supabase/service"
import type { UserRole } from "@/lib/security"
import { toCanonicalRoleOrDefault } from "@/lib/security"

export type { UserRole }

export interface RoleContext {
  userId: string
  /**
   * The user's role.  Pass either a canonical role string ('tc', 'admin', …)
   * or a legacy string ('TC', 'transaction_coordinator', …) — both are
   * normalised internally via toCanonicalRoleOrDefault().
   */
  role: UserRole | string
  brokerageId: string
  transactionId?: string
}

// Resolve a raw role string from RoleContext to a canonical UserRole.
function resolveRole(ctx: RoleContext): UserRole {
  return toCanonicalRoleOrDefault(ctx.role, 'contact')
}

/**
 * Check if user can transition transaction stage.
 */
export async function canTransitionStage(
  context: RoleContext,
): Promise<{ allowed: boolean; reason?: string }> {
  const role = resolveRole(context)

  if (role === 'superadmin' || role === 'admin' || role === 'broker') {
    return { allowed: true }
  }

  if (role === 'tc') {
    return { allowed: true }
  }

  if (role === 'agent') {
    if (!context.transactionId) {
      return { allowed: false, reason: 'Transaction ID required' }
    }

    const supabase = createServiceClient()
    const { data: transaction } = await supabase
      .from('transactions')
      .select('agent_id')
      .eq('id', context.transactionId)
      .eq('brokerage_id', context.brokerageId)
      .maybeSingle()

    if (transaction?.agent_id === context.userId) {
      return { allowed: true }
    }

    return { allowed: false, reason: 'Not assigned to this transaction' }
  }

  return { allowed: false, reason: 'Insufficient permissions' }
}

/**
 * Check if user can override a milestone with a reason.
 */
export async function canOverrideMilestone(
  context: RoleContext,
): Promise<{ allowed: boolean; reason?: string }> {
  const role = resolveRole(context)

  if (role === 'superadmin' || role === 'admin' || role === 'broker' || role === 'tc') {
    return { allowed: true }
  }

  return { allowed: false, reason: 'Only broker / admin / TC can override milestones' }
}

/**
 * Check if user can edit milestone dates.
 */
export async function canEditMilestoneDate(
  context: RoleContext,
): Promise<{ allowed: boolean; reason?: string }> {
  const role = resolveRole(context)

  if (['superadmin', 'admin', 'broker', 'tc', 'agent', 'team_lead'].includes(role)) {
    return { allowed: true }
  }

  return { allowed: false, reason: 'Cannot edit milestone dates' }
}

/**
 * Check if user can view financial details (CDA, commissions, etc.).
 */
export function canViewFinancials(
  context: RoleContext,
): { allowed: boolean; reason?: string } {
  const role = resolveRole(context)

  if (role === 'contact') {
    return { allowed: false, reason: 'Contacts cannot view internal financial details' }
  }

  if (role === 'lender' || role === 'title_agent') {
    return { allowed: false, reason: 'External parties cannot view commission details' }
  }

  return { allowed: true }
}

// ─── TOMBSTONE: canActAsExternalParty — DELETED, FUNCTIONALITY LIVES ELSEWHERE ─
//
// It gated a lender / title agent updating a milestone, on a
// `deal_team_members` row matched by `member_id` + member_type 'lender'/'title'.
// It was a DOUBLE orphan and the two halves proved each other dead:
//
//  · NO CALLER. The only reference in the tree was the barrel re-export at
//    lib/transactions/index.ts:39. Nothing ever invoked it.
//  · NO DATA, AND NO WRITER FOR THE DATA. `deal_team_members.member_id` is
//    written by nothing in the repository — the table's sole writer
//    (lib/transactions/vendor-quote-workflow.ts:approveQuote) only ever creates
//    'inspector' / 'insurance_provider' rows and never sets member_id. Measured
//    2026-08-22 on hrvaqgvukzxfskkcrwbt: deal_team_members holds 0 rows, and
//    the column carries no DEFAULT and no trigger. Every arm of this function
//    therefore evaluated to `{ allowed: false }` for its whole life.
//
// THE SURVIVOR is the external-party rail that runs on identities that actually
// exist and is called by the live portals:
//
//   lib/kernel/portal-auth.ts:61   requireLenderVendorActor(transactionId)
//        lender identity via user_role_assignments → vendors (lender category),
//        assignment proven through vendor_assignments for THIS transaction.
//   lib/kernel/portal-auth.ts:111  requireTitleActor(claimedTitleUserId)
//        title identity via title_company_users owned by the session user.
//
// THE MILESTONE ALLOW-LIST IS NOT LOST — it was made unnecessary rather than
// dropped. This function existed to keep an external party away from milestones
// that are not theirs, by filtering a caller-supplied `milestoneType`. The
// surviving actions accept NO milestone parameter at all, which is the stronger
// form of the same rule: app/actions/lender-portal-actions.ts:161
// issueClearToClose writes only `clear_to_close_received`, and
// app/actions/title-portal.ts:332 updateTitleStatus writes only
// `closing_scheduled` / `closed`. The read-side visibility vocabularies are
// app/actions/lender-portal.ts:4 LENDER_VISIBLE_MILESTONES and
// lib/title-portal/constants.ts:8 TITLE_VISIBLE_MILESTONES.

/**
 * Assert that the user holds one of the required roles; throws if not.
 */
export async function assertUserHasRole(
  context: RoleContext,
  requiredRoles: UserRole[],
): Promise<void> {
  const role = resolveRole(context)
  if (!requiredRoles.includes(role)) {
    throw new Error(
      `[role-guard] User role '${role}' not authorised. Required: ${requiredRoles.join(', ')}`,
    )
  }
}
