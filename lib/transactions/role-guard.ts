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

/**
 * Check if user can act as an external party (lender / title updating specific milestones).
 */
export async function canActAsExternalParty(
  context: RoleContext,
  milestoneType: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const role = resolveRole(context)
  const { transactionId, userId, brokerageId } = context

  if (!transactionId) {
    return { allowed: false, reason: 'Transaction ID required' }
  }

  if (role === 'lender') {
    const allowedMilestones = ['clear_to_close_received', 'financing_deadline', 'conditional_approval']
    if (!allowedMilestones.includes(milestoneType)) {
      return { allowed: false, reason: 'Lender can only update financing milestones' }
    }

    const supabase = createServiceClient()
    const { data: member } = await supabase
      .from('deal_team_members')
      .select('id')
      .eq('transaction_id', transactionId)
      .eq('brokerage_id', brokerageId)
      .eq('member_id', userId)
      .eq('member_type', 'lender')
      .single()

    if (!member) {
      return { allowed: false, reason: 'Not assigned as lender for this transaction' }
    }

    return { allowed: true }
  }

  if (role === 'title_agent') {
    const allowedMilestones = ['funding_confirmed', 'cda_delivered', 'cd_uploaded']
    if (!allowedMilestones.includes(milestoneType)) {
      return { allowed: false, reason: 'Title agent can only update closing milestones' }
    }

    const supabase = createServiceClient()
    const { data: member } = await supabase
      .from('deal_team_members')
      .select('id')
      .eq('transaction_id', transactionId)
      .eq('brokerage_id', brokerageId)
      .eq('member_id', userId)
      .eq('member_type', 'title')
      .single()

    if (!member) {
      return { allowed: false, reason: 'Not assigned as title agent for this transaction' }
    }

    return { allowed: true }
  }

  return { allowed: false, reason: 'Not an external party' }
}

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
