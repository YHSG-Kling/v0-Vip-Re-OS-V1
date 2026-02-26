'use strict'

import type { UserRole } from '@/app/types/roles'
import type { Permission, ResourceAccess, AccessCheckResult } from './types'
import { RoleManager } from './role-manager'

export class AccessControl {
  static checkPermission(userRole: UserRole, permission: Permission): AccessCheckResult {
    const hasPermission = RoleManager.hasPermission(userRole, permission)
    if (!hasPermission) {
      return {
        allowed: false,
        reason: `Role ${userRole} does not have permission: ${permission}`,
        requiredPermissions: [permission],
      }
    }
    return { allowed: true }
  }

  static async checkResourceAccess(
    userId: string,
    userRole: UserRole,
    userBrokerageId: string,
    access: ResourceAccess
  ): Promise<AccessCheckResult> {
    if (userRole === 'admin') return { allowed: true }

    const permissionCheck = this.checkPermission(
      userRole,
      `${access.resourceType}:${access.action}` as Permission
    )
    if (!permissionCheck.allowed) return permissionCheck

    const scope = RoleManager.getDataScope(userRole)

    if (scope === 'own' && access.ownerId && access.ownerId !== userId) {
      return { allowed: false, reason: `User can only access their own ${access.resourceType}` }
    }

    if (scope === 'brokerage' && access.brokerageId && access.brokerageId !== userBrokerageId) {
      return { allowed: false, reason: 'User can only access data from their brokerage' }
    }

    return { allowed: true }
  }

  static canManageUser(
    managerRole: UserRole,
    targetRole: UserRole,
    managerBrokerageId: string,
    targetBrokerageId: string
  ): AccessCheckResult {
    if (managerBrokerageId !== targetBrokerageId && managerRole !== 'admin') {
      return { allowed: false, reason: 'Can only manage users in your brokerage' }
    }
    if (!RoleManager.canManageRole(managerRole, targetRole)) {
      return { allowed: false, reason: `Role ${managerRole} cannot manage role ${targetRole}` }
    }
    return { allowed: true }
  }

  static getReadFilter(
    userId: string,
    userRole: UserRole,
    userBrokerageId: string,
    userTeamId?: string
  ): {
    filterType: 'own' | 'team' | 'brokerage' | 'none'
    filterValue?: string
    filterField?: string
  } {
    const scope = RoleManager.getDataScope(userRole)
    switch (scope) {
      case 'own':
        return { filterType: 'own', filterField: 'user_id', filterValue: userId }
      case 'team':
        return { filterType: 'team', filterField: 'team_id', filterValue: userTeamId ?? '' }
      case 'brokerage':
        return { filterType: 'brokerage', filterField: 'brokerage_id', filterValue: userBrokerageId }
      case 'all':
        return { filterType: 'none' }
    }
  }
}
