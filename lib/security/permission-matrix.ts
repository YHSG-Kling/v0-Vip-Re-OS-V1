'use strict'

/**
 * SINGLE SOURCE OF TRUTH — PERMISSION MATRIX
 *
 * All role permissions, hierarchy, and feature flags are defined here using
 * canonical role keys only.  Legacy strings (transaction_coordinator,
 * compliance_manager, etc.) are resolved via toCanonicalRole() in types.ts
 * before any lookup reaches this module.
 *
 * Import via @/lib/security or @/lib/security/permission-matrix.
 */

import type { UserRole } from './types'
import type { RoleHierarchy, RolePermissions, Permission } from './types'

// ─── ROLE HIERARCHY ───────────────────────────────────────────────────────────

export const ROLE_HIERARCHY: Record<UserRole, RoleHierarchy> = {
  // The FLOOR of the hierarchy, below the client portal: a workspace member who
  // has been given no business role. Level 0 is shared with `contact` on
  // purpose — neither can manage anyone and neither sees past their own row —
  // but they are different relationships (a contact is a client of the
  // brokerage, a member is inside it with nothing assigned yet), so they are
  // separate entries rather than an alias.
  member: {
    role: 'member',
    level: 0,
    canManage: [],
    canViewData: 'own',
  },
  contact: {
    role: 'contact',
    level: 0,
    canManage: [],
    canViewData: 'own',
  },
  vendor: {
    role: 'vendor',
    level: 1,
    canManage: [],
    canViewData: 'own',
  },
  isa: {
    role: 'isa',
    level: 2,
    canManage: [],
    canViewData: 'own',
  },
  lender: {
    role: 'lender',
    level: 3,
    canManage: [],
    canViewData: 'brokerage',
  },
  title_agent: {
    role: 'title_agent',
    level: 4,
    canManage: [],
    canViewData: 'brokerage',
  },
  tc: {
    role: 'tc',
    level: 5,
    canManage: [],
    canViewData: 'brokerage',
  },
  compliance_officer: {
    role: 'compliance_officer',
    level: 6,
    canManage: [],
    canViewData: 'brokerage',
  },
  agent: {
    role: 'agent',
    level: 7,
    canManage: [],
    canViewData: 'own',
  },
  team_lead: {
    role: 'team_lead',
    level: 8,
    canManage: ['agent', 'isa'],
    canViewData: 'team',
  },
  broker: {
    role: 'broker',
    level: 9,
    canManage: ['team_lead', 'agent', 'isa', 'vendor', 'tc', 'compliance_officer', 'lender', 'title_agent'],
    canViewData: 'brokerage',
  },
  admin: {
    role: 'admin',
    level: 10,
    canManage: [
      'broker', 'team_lead', 'agent', 'isa', 'vendor', 'contact',
      'tc', 'compliance_officer', 'lender', 'title_agent',
    ],
    canViewData: 'all',
  },
  superadmin: {
    role: 'superadmin',
    level: 11,
    canManage: [
      'admin', 'broker', 'team_lead', 'agent', 'isa', 'vendor', 'contact',
      'tc', 'compliance_officer', 'lender', 'title_agent',
    ],
    canViewData: 'all',
  },
}

// ─── ROLE PERMISSIONS ─────────────────────────────────────────────────────────

export const ROLE_PERMISSIONS: Record<UserRole, RolePermissions> = {
  // No permissions and no features. `settings:manage_account` is deliberately
  // absent as well: that permission governs the account-settings surfaces the
  // agent seat carries, and a member's own preferences reach them through their
  // navigation, not through a permission test.
  member: {
    role: 'member',
    permissions: [],
    features: [],
  },

  contact: {
    role: 'contact',
    permissions: ['contacts:view', 'transactions:view', 'listings:view_all'],
    features: ['transaction_portal', 'document_viewer', 'messaging'],
  },

  vendor: {
    role: 'vendor',
    permissions: [
      'contacts:view',
      'listings:view_all',
      'financials:view_own',
      'settings:manage_account',
    ],
    features: ['job_portal', 'portfolio', 'earnings_dashboard', 'messaging'],
  },

  isa: {
    role: 'isa',
    permissions: [
      'leads:view',
      'leads:qualify',
      'contacts:create',
      'transactions:view',
      'analytics:view_own',
      'settings:manage_account',
    ],
    features: ['calling_center', 'lead_dialer', 'conversation_log', 'call_scripts'],
  },

  lender: {
    role: 'lender',
    permissions: [
      'contacts:view_all',
      'transactions:view_all',
      'transactions:edit',
      'transactions:coordinate',
      'team:view_all',
      'analytics:view_all',
      'settings:manage_account',
    ],
    features: [
      'loan_pipeline',
      'application_review',
      'document_request',
      'approval_tracking',
      'underwriting',
    ],
  },

  title_agent: {
    role: 'title_agent',
    permissions: [
      'contacts:view_all',
      'transactions:view_all',
      'transactions:edit',
      'transactions:coordinate',
      'team:view_all',
      'analytics:view_all',
      'settings:manage_account',
    ],
    features: [
      'title_orders',
      'document_management',
      'closing_coordination',
      'title_search',
      'closing_schedule',
    ],
  },

  tc: {
    role: 'tc',
    permissions: [
      'contacts:view_all',
      'leads:view_all',
      'listings:view_all',
      'transactions:view_all',
      'transactions:edit',
      'transactions:coordinate',
      'team:view_all',
      'analytics:view_all',
      'compliance:view_logs',
      'settings:manage_team',
    ],
    features: [
      'transaction_dashboard',
      'deal_checklist',
      'vendor_coordination',
      'document_management',
      'closing_coordination',
    ],
  },

  compliance_officer: {
    role: 'compliance_officer',
    permissions: [
      'contacts:view_all',
      'transactions:view_all',
      'compliance:view_logs',
      'compliance:flag_violations',
      'compliance:manage_policies',
      'compliance:generate_reports',
      'team:view_all',
      'analytics:view_all',
    ],
    features: [
      'compliance_dashboard',
      'audit_logs',
      'violation_flagging',
      'conversation_analysis',
      'compliance_reports',
    ],
  },

  agent: {
    role: 'agent',
    permissions: [
      'contacts:view',
      'contacts:create',
      'contacts:edit',
      'leads:view',
      'leads:claim',
      'listings:create',
      'listings:edit',
      'listings:view_all',
      'transactions:view',
      'analytics:view_own',
      'financials:view_own',
      'settings:manage_account',
    ],
    features: [
      'crm',
      'lead_management',
      'listing_creation',
      'content_studio',
      'campaigns',
      'seller_portal',
      'buyer_portal',
    ],
  },

  team_lead: {
    role: 'team_lead',
    permissions: [
      'contacts:view_all',
      'contacts:create',
      'contacts:edit',
      'leads:view',
      'leads:view_all',
      'leads:claim',
      'leads:reassign',
      'listings:create',
      'listings:edit',
      'listings:view_all',
      'transactions:view',
      'transactions:view_all',
      'team:manage_agents',
      'team:manage_isas',
      'team:view_performance',
      'team:view_all',
      'analytics:view_own',
      'analytics:view_team',
      'financials:view_own',
      'financials:view_team',
      'settings:manage_account',
      'settings:manage_team',
      'compliance:view_logs',
    ],
    features: [
      'crm',
      'lead_management',
      'team_management',
      'listing_creation',
      'content_studio',
      'campaigns',
      'seller_portal',
      'buyer_portal',
      'agent_analytics',
    ],
  },

  broker: {
    role: 'broker',
    permissions: [
      'contacts:view_all',
      'contacts:bulk_import',
      'leads:view_all',
      'leads:reassign',
      'listings:view_all',
      'transactions:view_all',
      'team:manage_agents',
      'team:manage_isas',
      'team:view_performance',
      'team:view_all',
      'analytics:view_all',
      'analytics:export',
      'financials:view_all',
      'financials:manage_commissions',
      'settings:manage_brokerage',
      'compliance:view_logs',
    ],
    features: [
      'broker_dashboard',
      'team_management',
      'agent_analytics',
      'commission_management',
      'brokerage_settings',
      'all_crm_features',
    ],
  },

  admin: {
    role: 'admin',
    permissions: [
      'admin:manage_users',
      'admin:manage_brokerages',
      'admin:view_all_data',
      'admin:manage_integrations',
      'admin:system_health',
      'compliance:manage_policies',
      'compliance:generate_reports',
    ],
    features: [
      'admin_dashboard',
      'user_management',
      'brokerage_management',
      'system_monitoring',
      'integration_management',
      'all_features',
    ],
  },

  superadmin: {
    role: 'superadmin',
    permissions: [
      'admin:manage_users',
      'admin:manage_brokerages',
      'admin:view_all_data',
      'admin:manage_integrations',
      'admin:system_health',
      'compliance:manage_policies',
      'compliance:generate_reports',
    ],
    features: ['all_features'],
  },
}

// ─── PERMISSION DEFINITIONS ────────────────────────────────────────────────────

export const PERMISSION_DEFINITIONS: Record<Permission, string> = {
  'contacts:view': 'View own contacts',
  'contacts:view_all': 'View all contacts in brokerage',
  'contacts:create': 'Create new contacts',
  'contacts:edit': 'Edit contacts',
  'contacts:delete': 'Delete contacts',
  'contacts:bulk_import': 'Import contacts in bulk',

  'leads:view': 'View assigned leads',
  'leads:view_all': 'View all leads in brokerage',
  'leads:claim': 'Claim unassigned leads',
  'leads:reassign': 'Reassign leads between agents',
  'leads:qualify': 'Qualify leads',
  'leads:score': 'Score leads',

  'listings:create': 'Create new listings',
  'listings:edit': 'Edit listings',
  'listings:publish': 'Publish listings to MLS',
  'listings:view_all': 'View all listings',
  'listings:delete': 'Delete listings',
  'listings:archive': 'Archive listings',

  'transactions:view': 'View own transactions',
  'transactions:view_all': 'View all transactions in brokerage',
  'transactions:create': 'Create new transactions',
  'transactions:edit': 'Edit transaction status',
  'transactions:coordinate': 'Coordinate transaction (checklists, vendors)',
  'transactions:close': 'Close transactions',

  'team:manage_agents': 'Add/remove agents',
  'team:manage_isas': 'Manage ISAs',
  'team:view_performance': 'View team performance',
  'team:view_all': 'View all team members',

  'analytics:view_own': 'View own analytics',
  'analytics:view_team': 'View team analytics',
  'analytics:view_all': 'View all analytics',
  'analytics:export': 'Export analytics reports',

  'financials:view_own': 'View own earnings',
  'financials:view_team': 'View team commissions',
  'financials:view_all': 'View all financials',
  'financials:manage_commissions': 'Manage commission structure',

  'settings:manage_account': 'Manage own account settings',
  'settings:manage_team': 'Manage team settings',
  'settings:manage_brokerage': 'Manage brokerage settings',

  'compliance:view_logs': 'View compliance logs',
  'compliance:flag_violations': 'Flag compliance violations',
  'compliance:manage_policies': 'Manage compliance policies',
  'compliance:generate_reports': 'Generate compliance reports',

  'admin:manage_users': 'Manage users',
  'admin:manage_brokerages': 'Manage brokerages',
  'admin:view_all_data': 'View all system data',
  'admin:manage_integrations': 'Manage integrations',
  'admin:system_health': 'View system health',
}

// ─── FEATURE FLAGS ────────────────────────────────────────────────────────────

export const FEATURE_FLAGS: Record<string, UserRole[]> = {
  crm: ['agent', 'team_lead', 'broker', 'admin', 'superadmin'],
  lead_management: ['agent', 'team_lead', 'isa', 'broker', 'admin', 'superadmin'],
  calling_center: ['isa', 'broker', 'admin', 'superadmin'],
  listing_creation: ['agent', 'team_lead', 'broker', 'admin', 'superadmin'],
  content_studio: ['agent', 'team_lead', 'broker', 'admin', 'superadmin'],
  campaigns: ['agent', 'team_lead', 'broker', 'admin', 'superadmin'],
  seller_portal: ['agent', 'team_lead', 'broker', 'admin', 'superadmin'],
  buyer_portal: ['contact', 'agent', 'team_lead', 'broker', 'admin', 'superadmin'],
  transaction_dashboard: ['tc', 'team_lead', 'broker', 'admin', 'superadmin'],
  deal_checklist: ['tc', 'team_lead', 'broker', 'admin', 'superadmin'],
  compliance_dashboard: ['compliance_officer', 'broker', 'admin', 'superadmin'],
  loan_pipeline: ['lender', 'broker', 'admin', 'superadmin'],
  title_orders: ['title_agent', 'broker', 'admin', 'superadmin'],
  admin_dashboard: ['admin', 'superadmin'],
  broker_dashboard: ['broker', 'admin', 'superadmin'],
  analytics: [
    'agent', 'team_lead', 'broker', 'admin', 'superadmin',
    'tc', 'compliance_officer', 'lender', 'title_agent',
  ],
}
