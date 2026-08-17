// app/types/roles.ts
// Canonical definitions live in lib/security/types.ts — re-exported here for
// backward compatibility with any app-layer code that imports from this path.
export type { UserRole, CanonicalRole, LegacyRole, RawRole, RoleConfig, UserContext } from '@/lib/security'
export {
  toCanonicalRole,
  toCanonicalRoleOrDefault,
  toCanonicalRoles,
  isCanonicalRole,
  CANONICAL_ROLE_CONFIG,
} from '@/lib/security'

// ROLE_CONFIG is a runtime value — kept here since app/types is allowed to
// reference lib/security (app → domain is the correct direction).
import type { UserRole, RoleConfig } from '@/lib/security'

export const ROLE_CONFIG: Record<UserRole, RoleConfig> = {
  superadmin: {
    role: 'superadmin',
    label: 'Super Admin',
    description: 'Platform-level administrator with full access',
    icon: 'ShieldAlert',
    permissions: ['*'],
  },
  admin: {
    role: 'admin',
    label: 'Admin',
    description: 'System administrator',
    icon: 'Shield',
    permissions: ['manage_users', 'manage_brokerages', 'view_all_data', 'manage_integrations', 'view_system_health'],
  },
  broker: {
    role: 'broker',
    label: 'Broker',
    description: 'Brokerage owner/manager',
    icon: 'Building2',
    permissions: ['view_all_contacts', 'manage_agents', 'view_analytics', 'manage_settings', 'view_financials'],
  },
  team_lead: {
    role: 'team_lead',
    label: 'Team Lead',
    description: 'Team leader managing a group of agents',
    icon: 'Users',
    permissions: ['view_team_contacts', 'manage_team', 'view_team_analytics', 'view_team_financials'],
  },
  agent: {
    role: 'agent',
    label: 'Agent',
    description: 'Real estate agent',
    icon: 'User2',
    permissions: ['view_contacts', 'create_contact', 'claim_lead', 'create_listing', 'view_transactions'],
  },
  isa: {
    role: 'isa',
    label: 'ISA',
    description: 'Inside Sales Agent (AI voice)',
    icon: 'Headphones',
    permissions: ['view_leads', 'call_leads', 'qualify_lead', 'transfer_to_agent', 'create_notes'],
  },
  tc: {
    role: 'tc',
    label: 'Transaction Coordinator',
    description: 'Transaction management and coordination',
    icon: 'FileText',
    permissions: ['view_all_transactions', 'update_transaction_status', 'manage_checklists', 'coordinate_vendors'],
  },
  compliance_officer: {
    role: 'compliance_officer',
    label: 'Compliance Officer',
    description: 'Compliance oversight and audit',
    icon: 'CheckCircle2',
    permissions: ['view_all_communications', 'flag_violations', 'generate_reports', 'view_audit_logs'],
  },
  vendor: {
    role: 'vendor',
    label: 'Vendor',
    description: 'Service vendor',
    icon: 'Briefcase',
    permissions: ['view_referrals', 'manage_availability', 'submit_invoices', 'view_portfolio', 'manage_services'],
  },
  lender: {
    role: 'lender',
    label: 'Lender',
    description: 'Mortgage lender / loan officer',
    icon: 'DollarSign',
    permissions: ['view_loan_pipeline', 'approve_loans', 'view_buyer_info', 'submit_to_underwriting'],
  },
  title_agent: {
    role: 'title_agent',
    label: 'Title Agent',
    description: 'Title company representative',
    icon: 'FileCheck',
    permissions: ['view_title_orders', 'manage_documents', 'schedule_closing', 'track_title_status'],
  },
  contact: {
    role: 'contact',
    label: 'Contact',
    description: 'Buyer / seller contact',
    icon: 'Home',
    permissions: ['view_transaction', 'view_documents', 'request_showing', 'view_portal'],
  },
  member: {
    role: 'member',
    label: 'Member',
    description: 'Workspace member with no business role — sees only their own work',
    icon: 'UserCircle',
    permissions: [],
  },
}
