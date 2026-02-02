'use strict'

import { UserRole } from '@/app/types/roles'
import { Permission, ResourceAccess, AccessCheckResult } from '@/app/types/permissions'
import { RoleManager } from './role-manager'

export class AccessControl {
  /**
   * Check if user has permission (synchronous)
   */
  static checkPermission(
    userRole: UserRole,
    permission: Permission
  ): AccessCheckResult {
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

  /**
   * Check if user can access resource (async - checks ownership/brokerage)
   */
  static async checkResourceAccess(
    userId: string,
    userRole: UserRole,
    userBrokerageId: string,
    access: ResourceAccess
  ): Promise<AccessCheckResult> {
    // Admin can access everything
    if (userRole === 'admin') {
      return { allowed: true }
    }

    // Check permission first
    const permissionCheck = this.checkPermission(
      userRole,
      `${access.resourceType}:${access.action}` as Permission
    )

    if (!permissionCheck.allowed) {
      return permissionCheck
    }

    // Check data scope
    const scope = RoleManager.getDataScope(userRole)

    // Own data only
    if (scope === 'own') {
      if (access.ownerId && access.ownerId !== userId) {
        return {
          allowed: false,
          reason: `User can only access their own ${access.resourceType}`,
        }
      }
    }

    // Team data only (if teamId provided)
    if (scope === 'team' && access.teamId) {
      // TODO: Check if user is on same team
      // This requires querying team membership
    }

    // Brokerage data only
    if (scope === 'brokerage') {
      if (access.brokerageId && access.brokerageId !== userBrokerageId) {
        return {
          allowed: false,
          reason: `User can only access data from their brokerage`,
        }
      }
    }

    // All data is allowed (admin only really)
    return { allowed: true }
  }

  /**
   * Check if user can manage another user
   */
  static canManageUser(
    managerRole: UserRole,
    targetRole: UserRole,
    managerBrokerageId: string,
    targetBrokerageId: string
  ): AccessCheckResult {
    // Can only manage users in same brokerage
    if (managerBrokerageId !== targetBrokerageId && managerRole !== 'admin') {
      return {
        allowed: false,
        reason: 'Can only manage users in your brokerage',
      }
    }

    // Check role hierarchy
    const canManage = RoleManager.canManageRole(managerRole, targetRole)

    if (!canManage) {
      return {
        allowed: false,
        reason: `Role ${managerRole} cannot manage role ${targetRole}`,
      }
    }

    return { allowed: true }
  }

  /**
   * Get read query filter for user's data scope
   */
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
        return {
          filterType: 'own',
          filterField: 'user_id',
          filterValue: userId,
        }
      case 'team':
        return {
          filterType: 'team',
          filterField: 'team_id',
          filterValue: userTeamId || '',
        }
      case 'brokerage':
        return {
          filterType: 'brokerage',
          filterField: 'brokerage_id',
          filterValue: userBrokerageId,
        }
      case 'all':
        return {
          filterType: 'none',
        }
    }
  }
}
