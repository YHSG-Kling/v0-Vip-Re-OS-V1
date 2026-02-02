'use strict'

import { UserRole } from '@/app/types/roles'
import { Permission } from '@/app/types/permissions'
import { AccessControl } from './access-control'

/**
 * Wrapper for server actions to check permissions
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
      return {
        allowed: false,
        message: `Insufficient permissions. Required: ${requiredPermission}`,
      }
    }

    return { allowed: true }
  } catch (error) {
    console.error('[v0] Permission check error:', error)
    return {
      allowed: false,
      message: 'Failed to verify permissions',
    }
  }
}

/**
 * Decorator for server actions (usage example)
 */
export function requirePermission(permission: Permission) {
  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value

    descriptor.value = async function (...args: any[]) {
      const { userId, userRole, userBrokerageId } = args[0]

      const permissionCheck = await checkServerActionPermission(
        userId,
        userRole,
        userBrokerageId,
        permission
      )

      if (!permissionCheck.allowed) {
        throw new Error(permissionCheck.message)
      }

      return originalMethod.apply(this, args)
    }

    return descriptor
  }
}
