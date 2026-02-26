// app/types/roles.ts
// Canonical definitions live in lib/security/types.ts — re-exported here for
// backward compatibility with any app-layer code that imports from this path.
export type { UserRole, RoleConfig, UserContext } from '@/lib/security'

// ROLE_CONFIG is a runtime value — kept here since app/types is allowed to
// reference lib/security (app → domain is the correct direction).
import type { UserRole, RoleConfig } from '@/lib/security'

export const ROLE_CONFIG: Record<UserRole, RoleConfig> = {
  agent: {
    role: 'agent',
    label: 'Agent',
    description: 'Real estate agent',
    icon: 'User2',
    permissions: ['view_contacts', 'create_contact', 'claim_lead', 'create_listing', 'view_transactions'],
  },
  broker: {
    role: 'broker',
    label: 'Broker',
    description: 'Brokerage owner/manager',
    icon: 'Building2',
    permissions: ['view_all_contacts', 'manage_agents', 'view_analytics', 'manage_settings', 'view_financials'],
  },
  isa: {
    role: 'isa',
    label: 'ISA',
    description: 'Inside Sales Agent (Vapi.ai voice)',
    icon: 'Headphones',
    permissions: ['view_leads', 'call_leads', 'qualify_lead', 'transfer_to_agent', 'create_notes'],
  },
  admin: {
    role: 'admin',
    label: 'Admin',
    description: 'System administrator',
    icon: 'Shield',
    permissions: ['manage_users', 'manage_brokerages', 'view_all_data', 'manage_integrations', 'view_system_health'],
  },
  vendor: {
    role: 'vendor',
    label: 'Vendor',
    description: 'Service vendor',
    icon: 'Briefcase',
    permissions: ['view_referrals', 'manage_availability', 'submit_invoices', 'view_portfolio', 'manage_services'],
  },
  contact: {
    role: 'contact',
    label: 'Contact',
    description: 'Buyer/Seller contact',
    icon: 'Home',
    permissions: ['view_transaction', 'view_documents', 'request_showing', 'view_portal'],
  },
  compliance_manager: {
    role: 'compliance_manager',
    label: 'Compliance Manager',
    description: 'Compliance oversight',
    icon: 'CheckCircle2',
    permissions: ['view_all_communications', 'flag_violations', 'generate_reports', 'view_audit_logs'],
  },
  transaction_coordinator: {
    role: 'transaction_coordinator',
    label: 'Transaction Coordinator',
    description: 'Transaction management',
    icon: 'FileText',
    permissions: ['view_all_transactions', 'update_transaction_status', 'manage_checklists', 'coordinate_vendors'],
  },
  lender: {
    role: 'lender',
    label: 'Lender',
    description: 'Mortgage lender/loan officer',
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
}
