'use strict'

import { RoleHierarchy, RolePermissions, Permission } from '@/app/types/permissions'
import { UserRole } from '@/app/types/roles'

// Role hierarchy (determines management scope and data access)
export const ROLE_HIERARCHY: Record<UserRole, RoleHierarchy> = {
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
  agent: {
    role: 'agent',
    level: 3,
    canManage: [],
    canViewData: 'own',
  },
  transaction_coordinator: {
    role: 'transaction_coordinator',
    level: 4,
    canManage: [],
    canViewData: 'brokerage',
  },
  compliance_manager: {
    role: 'compliance_manager',
    level: 5,
    canManage: [],
    canViewData: 'brokerage',
  },
  lender: {
    role: 'lender',
    level: 6,
    canManage: [],
    canViewData: 'brokerage',
  },
  title_agent: {
    role: 'title_agent',
    level: 7,
    canManage: [],
    canViewData: 'brokerage',
  },
  broker: {
    role: 'broker',
    level: 8,
    canManage: ['agent', 'isa', 'vendor'],
    canViewData: 'brokerage',
  },
  admin: {
    role: 'admin',
    level: 9,
    canManage: ['broker', 'agent', 'isa', 'admin', 'vendor', 'contact', 'compliance_manager', 'transaction_coordinator', 'lender', 'title_agent'],
    canViewData: 'all',
  },
}

// Role-based permissions
export const ROLE_PERMISSIONS: Record<UserRole, RolePermissions> = {
  contact: {
    role: 'contact',
    permissions: [
      'contacts:view', // View own profile
      'transactions:view', // View own transaction
      'listings:view_all', // Can browse listings
    ],
    features: ['transaction_portal', 'document_viewer', 'messaging'],
  },

  vendor: {
    role: 'vendor',
    permissions: [
      'contacts:view', // View job contacts
      'listings:view_all', // Browse listings for jobs
      'financials:view_own', // View own earnings
      'settings:manage_account', // Manage profile
    ],
    features: ['job_portal', 'portfolio', 'earnings_dashboard', 'messaging'],
  },

  isa: {
    role: 'isa',
    permissions: [
      'leads:view', // View assigned leads
      'leads:qualify', // Qualify leads
      'contacts:create', // Create contacts from leads
      'transactions:view', // View conversations
      'analytics:view_own', // View own call stats
      'settings:manage_account',
    ],
    features: ['calling_center', 'lead_dialer', 'conversation_log', 'call_scripts'],
  },

  agent: {
    role: 'agent',
    permissions: [
      'contacts:view', // View own contacts
      'contacts:create',
      'contacts:edit',
      'leads:view', // View claimed leads
      'leads:claim', // Claim unassigned leads
      'listings:create',
      'listings:edit',
      'listings:view_all', // Browse all listings
      'transactions:view', // View own transactions
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

  transaction_coordinator: {
    role: 'transaction_coordinator',
    permissions: [
      'contacts:view_all',
      'leads:view_all',
      'listings:view_all',
      'transactions:view_all', // View all transactions
      'transactions:edit', // Update transaction status
      'transactions:coordinate', // Manage checklist, vendor coordination
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

  compliance_manager: {
    role: 'compliance_manager',
    permissions: [
      'contacts:view_all',
      'transactions:view_all',
      'compliance:view_logs', // Audit logs
      'compliance:flag_violations', // Flag communications
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

  lender: {
    role: 'lender',
    permissions: [
      'contacts:view_all',
      'transactions:view_all', // View transaction details
      'transactions:edit', // Update loan status
      'transactions:coordinate', // Request documents
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
      'transactions:view_all', // View title order status
      'transactions:edit', // Update title status
      'transactions:coordinate', // Manage closing
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

  broker: {
    role: 'broker',
    permissions: [
      'contacts:view_all',
      'contacts:bulk_import',
      'leads:view_all',
      'leads:reassign', // Reassign leads between agents
      'listings:view_all',
      'transactions:view_all',
      'team:manage_agents', // Add/remove agents
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
}

// Permission definitions (for documentation)
export const PERMISSION_DEFINITIONS: Record<string, string> = {
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

// Feature flags by role
export const FEATURE_FLAGS: Record<string, UserRole[]> = {
  'crm': ['agent', 'broker', 'admin'],
  'lead_management': ['agent', 'isa', 'broker', 'admin'],
  'calling_center': ['isa', 'broker', 'admin'],
  'listing_creation': ['agent', 'broker', 'admin'],
  'content_studio': ['agent', 'broker', 'admin'],
  'campaigns': ['agent', 'broker', 'admin'],
  'seller_portal': ['agent', 'broker', 'admin'],
  'buyer_portal': ['contact', 'agent', 'broker', 'admin'],
  'transaction_dashboard': ['transaction_coordinator', 'broker', 'admin'],
  'deal_checklist': ['transaction_coordinator', 'broker', 'admin'],
  'compliance_dashboard': ['compliance_manager', 'broker', 'admin'],
  'loan_pipeline': ['lender', 'broker', 'admin'],
  'title_orders': ['title_agent', 'broker', 'admin'],
  'admin_dashboard': ['admin'],
  'broker_dashboard': ['broker', 'admin'],
  'analytics': ['agent', 'broker', 'admin', 'transaction_coordinator', 'compliance_manager', 'lender', 'title_agent'],
}
