'use strict'

import type { UserRole } from '@/app/types/roles'
import type { Permission } from './types'
import { AccessControl } from './access-control'

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
