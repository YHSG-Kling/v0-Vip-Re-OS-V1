// Role and permission type definitions
// Permissions are enforced by Supabase RLS policies
// This defines what UI actions are available per role

export type UserType = 'broker' | 'admin' | 'agent' | 'vendor' | 'lender' | 'TC' | 'compliance_officer' | 'contact' | 'isa' | 'title_agent';

export interface UserPermission {
  resource: string;
  action: string; // read, create, update, delete
  conditions?: Record<string, any>; // for conditional permissions
}

export interface RoleConfig {
  id: string;
  name: UserType;
  description: string;
  permissions: UserPermission[]; // Full CRUD where applicable
  navigationItems: string[];
  commandPaletteActions: string[];
  color: string;
  icon: string;
}

export interface UserContext {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  user_type: UserType;
  brokerage_id?: string;
  team_id?: string;
  brokerages?: {
    id: string;
    name: string;
  };
  teams?: {
    id: string;
    name: string;
  };
}

export interface AuthSession {
  user: UserContext;
  isAuthenticated: boolean;
  isLoading: boolean;
  error?: string;
}

export const ROLE_CONFIGS: Record<UserType, RoleConfig> = {
  agent: {
    id: 'agent',
    name: 'agent',
    description: 'Real estate agent - claims leads (converts to contacts), manages own listings/transactions',
    permissions: [
      { resource: 'leads', action: 'read' },
      { resource: 'leads', action: 'update', conditions: { action_type: 'claim_or_qualify' } },
      { resource: 'contacts', action: 'read' },
      { resource: 'contacts', action: 'create' },
      { resource: 'contacts', action: 'update' },
      { resource: 'listings', action: 'read' },
      { resource: 'listings', action: 'create' },
      { resource: 'listings', action: 'update' },
      { resource: 'transactions', action: 'read' },
      { resource: 'transactions', action: 'create' },
      { resource: 'transactions', action: 'update' },
      { resource: 'profile', action: 'read' },
      { resource: 'profile', action: 'update' },
    ],
    navigationItems: ['dashboard', 'leads', 'contacts', 'listings', 'transactions', 'settings'],
    commandPaletteActions: ['claim_lead', 'new_contact', 'edit_contact', 'new_listing', 'edit_listing', 'new_transaction', 'edit_transaction'],
    color: '#4169E1',
    icon: 'home',
  },

  broker: {
    id: 'broker',
    name: 'broker',
    description: 'Brokerage owner/manager - full CRUD access to all brokerage data and team management',
    permissions: [
      { resource: 'leads', action: 'read' },
      { resource: 'leads', action: 'create' },
      { resource: 'leads', action: 'update' },
      { resource: 'leads', action: 'delete' },
      { resource: 'contacts', action: 'read' },
      { resource: 'contacts', action: 'create' },
      { resource: 'contacts', action: 'update' },
      { resource: 'contacts', action: 'delete' },
      { resource: 'listings', action: 'read' },
      { resource: 'listings', action: 'create' },
      { resource: 'listings', action: 'update' },
      { resource: 'listings', action: 'delete' },
      { resource: 'transactions', action: 'read' },
      { resource: 'transactions', action: 'create' },
      { resource: 'transactions', action: 'update' },
      { resource: 'transactions', action: 'delete' },
      { resource: 'team', action: 'read' },
      { resource: 'team', action: 'create' },
      { resource: 'team', action: 'update' },
      { resource: 'team', action: 'delete' },
      { resource: 'brokerages', action: 'read' },
      { resource: 'brokerages', action: 'update' },
      { resource: 'analytics', action: 'read' },
      { resource: 'profile', action: 'read' },
      { resource: 'profile', action: 'update' },
    ],
    navigationItems: ['dashboard', 'leads', 'contacts', 'listings', 'transactions', 'team', 'analytics', 'settings'],
    commandPaletteActions: ['manage_leads', 'manage_contacts', 'manage_listings', 'manage_transactions', 'manage_team', 'view_analytics', 'team_settings'],
    color: '#4169E1',
    icon: 'briefcase',
  },

  isa: {
    id: 'isa',
    name: 'isa',
    description: 'Inside Sales Agent - calls leads, logs activities, can create contacts from leads',
    permissions: [
      { resource: 'leads', action: 'read' },
      { resource: 'leads', action: 'update', conditions: { field: 'ai_isa_activities' } },
      { resource: 'contacts', action: 'read' },
      { resource: 'contacts', action: 'create' },
      { resource: 'contacts', action: 'update', conditions: { field: 'ai_isa_activities' } },
      { resource: 'ai_isa_activities', action: 'read' },
      { resource: 'ai_isa_activities', action: 'create' },
      { resource: 'ai_isa_activities', action: 'update' },
      { resource: 'profile', action: 'read' },
      { resource: 'profile', action: 'update' },
    ],
    navigationItems: ['dashboard', 'leads', 'contacts', 'call_logs', 'settings'],
    commandPaletteActions: ['start_call', 'log_activity', 'view_lead', 'create_contact_from_lead', 'view_call_history'],
    color: '#4169E1',
    icon: 'phone',
  },

  admin: {
    id: 'admin',
    name: 'admin',
    description: 'System administrator - full access to all data and system settings',
    permissions: [
      { resource: '*', action: 'read' },
      { resource: '*', action: 'create' },
      { resource: '*', action: 'update' },
      { resource: '*', action: 'delete' },
      { resource: 'users', action: 'read' },
      { resource: 'users', action: 'create' },
      { resource: 'users', action: 'update' },
      { resource: 'users', action: 'delete' },
      { resource: 'roles', action: 'read' },
      { resource: 'roles', action: 'update' },
      { resource: 'compliance_rules', action: 'read' },
      { resource: 'compliance_rules', action: 'create' },
      { resource: 'compliance_rules', action: 'update' },
      { resource: 'compliance_rules', action: 'delete' },
      { resource: 'system', action: 'read' },
      { resource: 'system', action: 'update' },
    ],
    navigationItems: ['dashboard', 'users', 'brokerages', 'analytics', 'system', 'settings'],
    commandPaletteActions: ['manage_users', 'manage_brokerages', 'manage_roles', 'view_system_logs', 'system_settings', 'view_all_analytics'],
    color: '#FF0000',
    icon: 'shield',
  },

  vendor: {
    id: 'vendor',
    name: 'vendor',
    description: 'Service vendor - limited read access, can manage own service offerings',
    permissions: [
      { resource: 'leads', action: 'read' },
      { resource: 'contacts', action: 'read' },
      { resource: 'services', action: 'read' },
      { resource: 'services', action: 'create' },
      { resource: 'services', action: 'update' },
      { resource: 'transactions', action: 'read' },
      { resource: 'profile', action: 'read' },
      { resource: 'profile', action: 'update' },
    ],
    navigationItems: ['dashboard', 'leads', 'contacts', 'services', 'profile'],
    commandPaletteActions: ['view_leads', 'view_contacts', 'submit_service', 'edit_service', 'edit_profile'],
    color: '#4169E1',
    icon: 'users',
  },

  contact: {
    id: 'contact',
    name: 'contact',
    description: 'Buyer/Seller contact - self-service limited access to own profile and listings',
    permissions: [
      { resource: 'profile', action: 'read' },
      { resource: 'profile', action: 'update' },
      { resource: 'listings', action: 'read' },
      { resource: 'saved_properties', action: 'read' },
      { resource: 'saved_properties', action: 'create' },
      { resource: 'saved_properties', action: 'update' },
      { resource: 'saved_properties', action: 'delete' },
      { resource: 'transactions', action: 'read' },
      { resource: 'communications', action: 'read' },
    ],
    navigationItems: ['dashboard', 'my_profile', 'saved_listings', 'my_transactions'],
    commandPaletteActions: ['edit_profile', 'view_listings', 'contact_agent', 'save_property', 'unsave_property'],
    color: '#4169E1',
    icon: 'user',
  },

  compliance_officer: {
    id: 'compliance_officer',
    name: 'compliance_officer',
    description: 'Compliance officer - monitoring and flagging violations, managing compliance rules',
    permissions: [
      { resource: 'compliance_flags', action: 'read' },
      { resource: 'compliance_flags', action: 'create' },
      { resource: 'compliance_flags', action: 'update' },
      { resource: 'compliance_rules', action: 'read' },
      { resource: 'compliance_rules', action: 'update' },
      { resource: 'communications', action: 'read' },
      { resource: 'transactions', action: 'read' },
      { resource: 'users', action: 'read' },
    ],
    navigationItems: ['dashboard', 'compliance', 'communications', 'reports', 'settings'],
    commandPaletteActions: ['flag_issue', 'view_reports', 'manage_rules', 'escalate_violation', 'review_content'],
    color: '#4169E1',
    icon: 'alert-circle',
  },

  TC: {
    id: 'TC',
    name: 'TC',
    description: 'Transaction Coordinator - full transaction management including milestones and documents',
    permissions: [
      { resource: 'transactions', action: 'read' },
      { resource: 'transactions', action: 'create' },
      { resource: 'transactions', action: 'update' },
      { resource: 'transaction_milestones', action: 'read' },
      { resource: 'transaction_milestones', action: 'create' },
      { resource: 'transaction_milestones', action: 'update' },
      { resource: 'client_documents', action: 'read' },
      { resource: 'client_documents', action: 'create' },
      { resource: 'client_documents', action: 'update' },
      { resource: 'contacts', action: 'read' },
      { resource: 'communications', action: 'read' },
      { resource: 'communications', action: 'create' },
      { resource: 'profile', action: 'read' },
      { resource: 'profile', action: 'update' },
    ],
    navigationItems: ['dashboard', 'transactions', 'documents', 'timeline', 'settings'],
    commandPaletteActions: ['update_transaction', 'update_milestone', 'upload_document', 'request_document', 'send_message', 'view_deal_team'],
    color: '#4169E1',
    icon: 'clipboard',
  },

  lender: {
    id: 'lender',
    name: 'lender',
    description: 'Mortgage lender - manages loan applications and credit reviews',
    permissions: [
      { resource: 'transactions', action: 'read' },
      { resource: 'contacts', action: 'read' },
      { resource: 'loans', action: 'read' },
      { resource: 'loans', action: 'create' },
      { resource: 'loans', action: 'update' },
      { resource: 'client_documents', action: 'read' },
      { resource: 'client_documents', action: 'create' },
      { resource: 'communications', action: 'read' },
      { resource: 'communications', action: 'create' },
      { resource: 'credit_status', action: 'read' },
      { resource: 'credit_status', action: 'create' },
      { resource: 'credit_status', action: 'update' },
      { resource: 'profile', action: 'read' },
      { resource: 'profile', action: 'update' },
    ],
    navigationItems: ['dashboard', 'transactions', 'loans', 'contacts', 'documents', 'credit'],
    commandPaletteActions: ['create_loan', 'request_docs', 'update_loan_status', 'review_credit', 'send_message'],
    color: '#4169E1',
    icon: 'credit-card',
  },

  title_agent: {
    id: 'title_agent',
    name: 'title_agent',
    description: 'Title agent - manages title search and closing process',
    permissions: [
      { resource: 'transactions', action: 'read' },
      { resource: 'client_documents', action: 'read' },
      { resource: 'client_documents', action: 'create' },
      { resource: 'client_documents', action: 'update' },
      { resource: 'closing_details', action: 'read' },
      { resource: 'closing_details', action: 'create' },
      { resource: 'closing_details', action: 'update' },
      { resource: 'contacts', action: 'read' },
      { resource: 'communications', action: 'read' },
      { resource: 'communications', action: 'create' },
      { resource: 'profile', action: 'read' },
      { resource: 'profile', action: 'update' },
    ],
    navigationItems: ['dashboard', 'transactions', 'documents', 'closings', 'contacts'],
    commandPaletteActions: ['schedule_closing', 'request_docs', 'upload_closing_doc', 'update_closing_status', 'send_message'],
    color: '#4169E1',
    icon: 'file-text',
  },
};
