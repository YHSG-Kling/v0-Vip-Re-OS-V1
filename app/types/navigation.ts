'use strict'

import { UserRole } from './roles'

export interface NavItem {
  id: string
  /** Required for normal nav items. Optional when divider: true */
  label?: string
  href?: string
  icon?: string
  /**
   * badgeKey is resolved at runtime from BadgeCounts.
   * A badge renders only when badgeCounts[badgeKey] > 0.
   * Never use a hardcoded `badge: { count: N }` — counts must come from the DB.
   */
  badgeKey?: string
  /** @deprecated Use badgeKey instead. Kept for type-compatibility only; never populate count. */
  badge?: { count?: number; color: 'red' | 'blue' | 'green' }
  children?: NavItem[]
  requiredRoles?: UserRole[]
  requiredPermissions?: string[]
  divider?: boolean
}

/**
 * Live badge counts resolved server-side per request.
 * Keys match the badgeKey values used in navigation-config.ts.
 */
export interface BadgeCounts {
  unread_notifications: number
  pending_approvals: number
  isa_queue_count: number
  compliance_violations: number
  active_deals: number
  vendor_pending_jobs: number
  lender_pipeline_count: number
  title_open_orders: number
  [key: string]: number
}

export interface NavigationConfig {
  sidebarItems: NavItem[]
  topNavItems: NavItem[]
  mobileBottomNav: NavItem[]
  commandPaletteItems: NavItem[]
}
