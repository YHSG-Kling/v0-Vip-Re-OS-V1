'use strict'

import { UserRole } from '@/app/types/roles'
import { Permission, RolePermissions } from '@/app/types/permissions'
import { ROLE_HIERARCHY, ROLE_PERMISSIONS } from '@/app/constants/permissions'

export class RoleManager {
  /**
   * Get all permissions for a role
   */
  static getPermissions(role: UserRole): Permission[] {
    return ROLE_PERMISSIONS[role]?.permissions || []
  }

  /**
   * Get all features available to a role
   */
  static getFeatures(role: UserRole): string[] {
    return ROLE_PERMISSIONS[role]?.features || []
  }

  /**
   * Check if a role has a specific permission
   */
  static hasPermission(role: UserRole, permission: Permission): boolean {
    const permissions = this.getPermissions(role)
    return permissions.includes(permission)
  }

  /**
   * Check if a role has feature access
   */
  static hasFeature(role: UserRole, feature: string): boolean {
    const features = this.getFeatures(role)
    return features.includes(feature) || features.includes('all_features')
  }

  /**
   * Check if a role can manage another role
   */
  static canManageRole(managerRole: UserRole, targetRole: UserRole): boolean {
    const hierarchy = ROLE_HIERARCHY[managerRole]
    return hierarchy.canManage.includes(targetRole)
  }

  /**
   * Get role hierarchy level (higher = more privilege)
   */
  static getRoleLevel(role: UserRole): number {
    return ROLE_HIERARCHY[role]?.level || -1
  }

  /**
   * Check if one role outranks another
   */
  static outranks(role1: UserRole, role2: UserRole): boolean {
    return this.getRoleLevel(role1) > this.getRoleLevel(role2)
  }

  /**
   * Get data visibility scope for a role
   */
  static getDataScope(role: UserRole): 'own' | 'team' | 'brokerage' | 'all' {
    return ROLE_HIERARCHY[role]?.canViewData || 'own'
  }

  /**
   * Get all permissions for multiple roles (union)
   */
  static getPermissionsForRoles(roles: UserRole[]): Permission[] {
    const allPermissions = new Set<Permission>()
    
    roles.forEach((role) => {
      const permissions = this.getPermissions(role)
      permissions.forEach((p) => allPermissions.add(p))
    })

    return Array.from(allPermissions)
  }

  /**
   * Check if any role in a list has a permission
   */
  static anyHasPermission(roles: UserRole[], permission: Permission): boolean {
    return roles.some((role) => this.hasPermission(role, permission))
  }

  /**
   * Get role display label
   */
  static getRoleLabel(role: UserRole): string {
    const labels: Record<UserRole, string> = {
      agent: 'Agent',
      broker: 'Broker',
      isa: 'ISA',
      admin: 'Administrator',
      vendor: 'Vendor',
      contact: 'Contact',
      compliance_manager: 'Compliance Manager',
      transaction_coordinator: 'Transaction Coordinator',
      lender: 'Lender',
      title_agent: 'Title Agent',
    }
    return labels[role] || role
  }
}
