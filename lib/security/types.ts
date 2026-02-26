'use strict'

// Re-export UserRole from the canonical source
export type { UserRole, RoleConfig, UserContext } from '@/app/types/roles'

// Permission groups (functional areas)
export type PermissionGroup =
  | 'contacts'
  | 'leads'
  | 'listings'
  | 'transactions'
  | 'team'
  | 'analytics'
  | 'financials'
  | 'settings'
  | 'compliance'
  | 'admin'

// Individual permissions — lib/permissions typed set
export type Permission =
  // Contact permissions
  | 'contacts:view'
  | 'contacts:create'
  | 'contacts:edit'
  | 'contacts:delete'
  | 'contacts:view_all'
  | 'contacts:bulk_import'

  // Lead permissions
  | 'leads:view'
  | 'leads:claim'
  | 'leads:reassign'
  | 'leads:qualify'
  | 'leads:score'
  | 'leads:view_all'

  // Listing permissions
  | 'listings:create'
  | 'listings:edit'
  | 'listings:publish'
  | 'listings:view_all'
  | 'listings:delete'
  | 'listings:archive'

  // Transaction permissions
  | 'transactions:view'
  | 'transactions:create'
  | 'transactions:edit'
  | 'transactions:view_all'
  | 'transactions:coordinate'
  | 'transactions:close'

  // Team permissions
  | 'team:manage_agents'
  | 'team:manage_isas'
  | 'team:view_performance'
  | 'team:view_all'

  // Analytics permissions
  | 'analytics:view_own'
  | 'analytics:view_team'
  | 'analytics:view_all'
  | 'analytics:export'

  // Financial permissions
  | 'financials:view_own'
  | 'financials:view_team'
  | 'financials:view_all'
  | 'financials:manage_commissions'

  // Settings permissions
  | 'settings:manage_account'
  | 'settings:manage_team'
  | 'settings:manage_brokerage'

  // Compliance permissions
  | 'compliance:view_logs'
  | 'compliance:flag_violations'
  | 'compliance:manage_policies'
  | 'compliance:generate_reports'

  // Admin permissions
  | 'admin:manage_users'
  | 'admin:manage_brokerages'
  | 'admin:view_all_data'
  | 'admin:manage_integrations'
  | 'admin:system_health'

export interface RoleHierarchy {
  role: import('@/app/types/roles').UserRole
  level: number
  canManage: import('@/app/types/roles').UserRole[]
  canViewData: 'own' | 'team' | 'brokerage' | 'all'
}

export interface RolePermissions {
  role: import('@/app/types/roles').UserRole
  permissions: Permission[]
  features: string[]
}

export interface ResourceAccess {
  userId: string
  resourceType: 'contact' | 'lead' | 'listing' | 'transaction' | 'team' | 'agent'
  resourceId: string
  action: 'view' | 'edit' | 'delete' | 'create'
  brokerageId?: string
  teamId?: string
  ownerId?: string
}

export interface AccessCheckResult {
  allowed: boolean
  reason?: string
  requiredPermissions?: Permission[]
}

export interface AuthorizedUser {
  id: string
  email: string
  platformRole: string
}

export interface SubscriptionContext {
  brokerageId?: string
  teamId?: string
  agentId?: string
}
