'use strict'

import type { UserRole } from './types'
import type { Permission } from './types'
import { AccessControl } from './access-control'
import { createClient } from '@/lib/supabase/server'
import { resolveUserBrokerageId } from '@/lib/activities/activity-tenant'

/**
 * ROLE + IDENTITY GATE for a server action.
 *
 * ── `userId` AND `userBrokerageId` WERE ACCEPTED AND NEVER READ ─────────────
 *
 * The whole body used to be `AccessControl.checkPermission(userRole,
 * requiredPermission)`. Two of the four arguments were decoration, and the one
 * that WAS read — `userRole` — is also caller-supplied. That is the §4 shape
 * this repo has paid for repeatedly: identity handed in as a PARAMETER and
 * trusted, on a gate whose whole job is to decide whether the caller may
 * proceed. `requirePermission` below makes it concrete — it reads
 * `const { userId, userRole, userBrokerageId } = args[0]`, i.e. straight off
 * the decorated method's own argument object. Anything that can call the
 * method can name its own role.
 *
 * So the two unread arguments are now the CLAIM, and this function's job is to
 * check the claim against the SESSION. A caller may still say who it thinks it
 * is; it can no longer be believed.
 *
 * FAIL CLOSED, per §4: every branch where the session cannot be read, the user
 * cannot be resolved, or the tenant lookup is REFUSED returns `allowed: false`.
 * "Nobody could check" must not render as "checked and fine". Note in
 * particular that `resolveUserBrokerageId` destructures its own error, so a
 * refused `users` read arrives as `ok: false` rather than as a null tenant that
 * would otherwise have been compared and mismatched for the wrong reason.
 *
 * ORDER MATTERS: the permission matrix is evaluated FIRST and short-circuits.
 * A caller with a role that cannot perform the action is refused without a
 * round trip, so the added database cost is paid only on requests that were
 * otherwise about to be granted.
 *
 * NOT a duplicate of `lib/security/rbac.ts:51 requirePermission`, and
 * deliberately not merged into it: that one answers "may this user touch THIS
 * RESOURCE", resolves the caller from the session itself, and defers a
 * non-broker to RLS without throwing. This one answers "does this ROLE hold
 * this PERMISSION", from the ROLE_PERMISSIONS matrix. Different questions, both
 * live; what they must not disagree about is who the caller is, and now they
 * do not.
 */
export async function checkServerActionPermission(
  userId: string,
  userRole: UserRole,
  userBrokerageId: string,
  requiredPermission: Permission
): Promise<{ allowed: boolean; message?: string }> {
  try {
    const result = AccessControl.checkPermission(userRole, requiredPermission)
    if (!result.allowed) {
      return { allowed: false, message: `Insufficient permissions. Required: ${requiredPermission}` }
    }

    const supabase = await createClient()

    const { data: { user }, error: sessionError } = await supabase.auth.getUser()
    if (sessionError || !user) {
      return {
        allowed: false,
        message: 'Could not verify the caller against a session — refusing rather than assuming',
      }
    }

    if (user.id !== userId) {
      return {
        allowed: false,
        message: 'The identity supplied with this call does not match the signed-in session',
      }
    }

    const tenant = await resolveUserBrokerageId(supabase, user.id)
    if (!tenant.ok) {
      return { allowed: false, message: `Could not resolve the caller's brokerage — ${tenant.reason}` }
    }
    if (!tenant.brokerageId || tenant.brokerageId !== userBrokerageId) {
      return {
        allowed: false,
        message: 'The brokerage supplied with this call does not match the signed-in session',
      }
    }

    return { allowed: true }
  } catch (error) {
    console.error('[Security] Permission check error:', error)
    return { allowed: false, message: 'Failed to verify permissions' }
  }
}

export function requirePermission(permission: Permission) {
  return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value
    descriptor.value = async function (...args: any[]) {
      const { userId, userRole, userBrokerageId } = args[0]
      const check = await checkServerActionPermission(userId, userRole, userBrokerageId, permission)
      if (!check.allowed) throw new Error(check.message)
      return originalMethod.apply(this, args)
    }
    return descriptor
  }
}
