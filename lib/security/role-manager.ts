'use strict'

import type { UserRole } from '@/app/types/roles'
import type { Permission } from './types'
import { ROLE_HIERARCHY, ROLE_PERMISSIONS } from './permission-matrix'

export class RoleManager {
  static getPermissions(role: UserRole): Permission[] {
    return ROLE_PERMISSIONS[role]?.permissions || []
  }

  static getFeatures(role: UserRole): string[] {
    return ROLE_PERMISSIONS[role]?.features || []
  }

  static hasPermission(role: UserRole, permission: Permission): boolean {
    return this.getPermissions(role).includes(permission)
  }

  static hasFeature(role: UserRole, feature: string): boolean {
    const features = this.getFeatures(role)
    return features.includes(feature) || features.includes('all_features')
  }

  static canManageRole(managerRole: UserRole, targetRole: UserRole): boolean {
    return ROLE_HIERARCHY[managerRole]?.canManage.includes(targetRole) ?? false
  }

  static getRoleLevel(role: UserRole): number {
    return ROLE_HIERARCHY[role]?.level ?? -1
  }

  static outranks(role1: UserRole, role2: UserRole): boolean {
    return this.getRoleLevel(role1) > this.getRoleLevel(role2)
  }

  static getDataScope(role: UserRole): 'own' | 'team' | 'brokerage' | 'all' {
    return ROLE_HIERARCHY[role]?.canViewData ?? 'own'
  }

  static getPermissionsForRoles(roles: UserRole[]): Permission[] {
    const all = new Set<Permission>()
    roles.forEach((role) => this.getPermissions(role).forEach((p) => all.add(p)))
    return Array.from(all)
  }

  static anyHasPermission(roles: UserRole[], permission: Permission): boolean {
    return roles.some((role) => this.hasPermission(role, permission))
  }

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
    return labels[role] ?? role
  }
}
