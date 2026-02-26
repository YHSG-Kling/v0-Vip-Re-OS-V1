'use strict'

import type { UserRole } from './types'
import type { Permission } from './types'
import { RoleManager } from './role-manager'

export class UIHelpers {
  static shouldShowAction(
    userRole: UserRole,
    action: 'create' | 'edit' | 'delete' | 'view',
    resourceType: string
  ): boolean {
    return RoleManager.hasPermission(userRole, `${resourceType}:${action}` as Permission)
  }

  static shouldShowField(userRole: UserRole, field: string): boolean {
    const hiddenFields: Record<UserRole, string[]> = {
      agent: ['commission_structure', 'all_brokerage_contacts'],
      broker: [],
      isa: ['pricing', 'commission_structure'],
      admin: [],
      vendor: ['pricing', 'commission_structure', 'team_members'],
      contact: ['pricing', 'commission_structure', 'agent_metrics'],
      compliance_manager: [],
      transaction_coordinator: [],
      lender: [],
      title_agent: [],
    }
    return !hiddenFields[userRole]?.includes(field)
  }

  static shouldShowMenuItem(userRole: UserRole, menuItem: string): boolean {
    const hiddenMenuItems: Record<UserRole, string[]> = {
      agent: ['admin', 'broker_settings', 'team_management'],
      broker: [],
      isa: ['crm', 'listings', 'seller_portal'],
      admin: [],
      vendor: ['crm', 'listings', 'team'],
      contact: ['crm', 'admin', 'analytics'],
      compliance_manager: ['crm', 'listings'],
      transaction_coordinator: ['crm', 'listings'],
      lender: ['crm', 'listings'],
      title_agent: ['crm', 'listings'],
    }
    return !hiddenMenuItems[userRole]?.includes(menuItem)
  }

  static getDisabledTooltip(userRole: UserRole, action: string): string {
    return `You don't have permission to ${action} as a ${RoleManager.getRoleLabel(userRole)}`
  }
}
