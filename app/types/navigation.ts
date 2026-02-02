'use strict'

import { UserRole } from './roles'

export interface NavItem {
  id: string
  label: string
  href?: string
  icon?: string
  badge?: { count: number; color: 'red' | 'blue' | 'green' }
  children?: NavItem[]
  requiredRoles?: UserRole[]
  requiredPermissions?: string[]
  divider?: boolean
}

export interface NavigationConfig {
  sidebarItems: NavItem[]
  topNavItems: NavItem[]
  mobileBottomNav: NavItem[]
  commandPaletteItems: NavItem[]
}
