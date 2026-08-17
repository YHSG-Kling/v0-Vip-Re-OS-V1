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
      superadmin: [],
      admin: [],
      broker: [],
      team_lead: ['commission_structure'],
      agent: ['commission_structure', 'all_brokerage_contacts'],
      isa: ['pricing', 'commission_structure'],
      tc: [],
      compliance_officer: [],
      vendor: ['pricing', 'commission_structure', 'team_members'],
      lender: [],
      title_agent: [],
      contact: ['pricing', 'commission_structure', 'agent_metrics'],
      // The bare seat. Hides everything the client persona hides and everything
      // the vendor persona hides — a seat with no business role has no business
      // reading a price, a split, or another person's numbers.
      member: ['pricing', 'commission_structure', 'agent_metrics', 'all_brokerage_contacts', 'team_members'],
    }
    return !hiddenFields[userRole]?.includes(field)
  }

  static shouldShowMenuItem(userRole: UserRole, menuItem: string): boolean {
    const hiddenMenuItems: Record<UserRole, string[]> = {
      superadmin: [],
      admin: [],
      broker: [],
      team_lead: [],
      agent: ['admin', 'broker_settings', 'team_management'],
      isa: ['crm', 'listings', 'seller_portal'],
      tc: ['crm', 'listings'],
      compliance_officer: ['crm', 'listings'],
      vendor: ['crm', 'listings', 'team'],
      lender: ['crm', 'listings'],
      title_agent: ['crm', 'listings'],
      contact: ['crm', 'admin', 'analytics'],
      member: ['crm', 'admin', 'analytics', 'listings', 'team', 'team_management', 'broker_settings', 'seller_portal'],
    }
    return !hiddenMenuItems[userRole]?.includes(menuItem)
  }

  static getDisabledTooltip(userRole: UserRole, action: string): string {
    return `You don't have permission to ${action} as a ${RoleManager.getRoleLabel(userRole)}`
  }
}
