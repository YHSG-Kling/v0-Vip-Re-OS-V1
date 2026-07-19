// ─── CANONICAL ROLE DEFINITIONS (single source of truth) ─────────────────────
//
// System catalog: superadmin | admin | broker | team_lead | agent | isa |
//                 tc | compliance_officer | vendor | lender | title_agent | contact
//
// All other files in this codebase MUST import UserRole from here (or from
// @/lib/security which re-exports it).  No file may declare its own UserRole.

// ─── CANONICAL ROLE TYPE ──────────────────────────────────────────────────────

export type CanonicalRole =
  | 'superadmin'
  | 'admin'
  | 'broker'
  | 'team_lead'
  | 'agent'
  | 'isa'
  | 'tc'
  | 'compliance_officer'
  | 'vendor'
  | 'lender'
  | 'title_agent'
  | 'contact'

/** Public alias — use `UserRole` everywhere in application code. */
export type UserRole = CanonicalRole

// ─── LEGACY ROLE STRINGS (database values from older schema) ─────────────────
//
// These values may appear in existing database rows, JWTs, or serialised state.
// They are NEVER stored as UserRole in application memory; they are always
// mapped to a CanonicalRole immediately on ingress via `toCanonicalRole()`.

export type LegacyRole =
  | 'transaction_coordinator'  // → tc
  | 'compliance_manager'       // → compliance_officer
  | 'title'                    // → title_agent
  | 'client'                   // → contact
  | 'team_leader'              // → team_lead
  | 'TC'                       // → tc  (old enum value)
  | 'COMPLIANCE_OFFICER'       // → compliance_officer (old enum key)
  | 'TEAM_LEADER'              // → team_lead (old enum key)
  | 'super_admin'              // → superadmin
  | 'broker_admin'             // → broker (brokerage-admin user_type in older rows)
  | 'solo_agent'               // → agent (plan-tier string leaked into role fields)

/** Any raw string that could arrive from the database or a JWT claim. */
export type RawRole = CanonicalRole | LegacyRole | string

// ─── MAPPING TABLE ─────────────────────────────────────────────────────────────

const LEGACY_ROLE_MAP: Record<string, CanonicalRole> = {
  // Legacy snake_case variants
  transaction_coordinator: 'tc',
  compliance_manager: 'compliance_officer',
  title: 'title_agent',
  client: 'contact',
  team_leader: 'team_lead',
  super_admin: 'superadmin',
  // broker_admin is a live user_type in older rows — everywhere it appears it is
  // grouped with 'broker' at brokerage-wide scope (see lib/kernel/egress-scope.ts),
  // so it maps to 'broker', NOT the default fallback ('agent' in most callers).
  broker_admin: 'broker',
  // solo_agent is a PLAN TIER string that leaked into role fields in early rows;
  // a solo-tier user is an agent.
  solo_agent: 'agent',

  // Old enum key strings (stored verbatim in some early rows)
  TC: 'tc',
  COMPLIANCE_OFFICER: 'compliance_officer',
  TEAM_LEADER: 'team_lead',
  ADMIN: 'admin',
  BROKER: 'broker',
  AGENT: 'agent',
  ISA: 'isa',
  VENDOR: 'vendor',
  LENDER: 'lender',
  CONTACT: 'contact',
}

/** Canonical set for fast O(1) membership checks. */
const CANONICAL_ROLES = new Set<string>([
  'superadmin', 'admin', 'broker', 'team_lead', 'agent', 'isa',
  'tc', 'compliance_officer', 'vendor', 'lender', 'title_agent', 'contact',
])

// ─── MAPPING FUNCTIONS ────────────────────────────────────────────────────────

/**
 * Convert any raw role string (canonical, legacy, or unknown) to a
 * CanonicalRole.  Returns `null` when the value cannot be resolved.
 *
 * @example
 * toCanonicalRole('transaction_coordinator') // → 'tc'
 * toCanonicalRole('tc')                      // → 'tc'
 * toCanonicalRole('TC')                      // → 'tc'
 * toCanonicalRole('unknown_role')            // → null
 */
export function toCanonicalRole(raw: RawRole | null | undefined): CanonicalRole | null {
  if (!raw) return null
  if (CANONICAL_ROLES.has(raw)) return raw as CanonicalRole
  return LEGACY_ROLE_MAP[raw] ?? null
}

/**
 * Same as `toCanonicalRole` but falls back to `defaultRole` instead of `null`.
 *
 * @example
 * toCanonicalRoleOrDefault('compliance_manager', 'contact') // → 'compliance_officer'
 * toCanonicalRoleOrDefault(null, 'contact')                 // → 'contact'
 */
export function toCanonicalRoleOrDefault(
  raw: RawRole | null | undefined,
  defaultRole: CanonicalRole,
): CanonicalRole {
  return toCanonicalRole(raw) ?? defaultRole
}

/**
 * Convert an array of raw role strings to canonical roles, dropping any that
 * cannot be resolved.
 */
export function toCanonicalRoles(raws: (RawRole | null | undefined)[]): CanonicalRole[] {
  const result: CanonicalRole[] = []
  for (const r of raws) {
    const canonical = toCanonicalRole(r)
    if (canonical !== null) result.push(canonical)
  }
  return result
}

/**
 * Type guard — narrow an unknown string to CanonicalRole.
 *
 * @example
 * if (isCanonicalRole(someString)) { /* UserRole-typed here *\/ }
 */
export function isCanonicalRole(value: unknown): value is CanonicalRole {
  return typeof value === 'string' && CANONICAL_ROLES.has(value)
}

// ─── ROLE CONFIG ──────────────────────────────────────────────────────────────

export interface RoleConfig {
  role: CanonicalRole
  label: string
  description: string
  icon: string
  permissions: string[]
}

export const CANONICAL_ROLE_CONFIG: Record<CanonicalRole, Omit<RoleConfig, 'role'>> = {
  superadmin: {
    label: 'Super Admin',
    description: 'Platform-level administrator with full access',
    icon: 'ShieldAlert',
    permissions: ['*'],
  },
  admin: {
    label: 'Admin',
    description: 'Brokerage system administrator',
    icon: 'Shield',
    permissions: ['manage_users', 'manage_brokerages', 'view_all_data', 'manage_integrations', 'view_system_health'],
  },
  broker: {
    label: 'Broker',
    description: 'Brokerage owner/manager',
    icon: 'Building2',
    permissions: ['view_all_contacts', 'manage_agents', 'view_analytics', 'manage_settings', 'view_financials'],
  },
  team_lead: {
    label: 'Team Lead',
    description: 'Team leader managing a group of agents',
    icon: 'Users',
    permissions: ['view_team_contacts', 'manage_team', 'view_team_analytics', 'view_team_financials'],
  },
  agent: {
    label: 'Agent',
    description: 'Real estate agent',
    icon: 'User2',
    permissions: ['view_contacts', 'create_contact', 'claim_lead', 'create_listing', 'view_transactions'],
  },
  isa: {
    label: 'ISA',
    description: 'Inside Sales Agent',
    icon: 'Headphones',
    permissions: ['view_leads', 'call_leads', 'qualify_lead', 'transfer_to_agent', 'create_notes'],
  },
  tc: {
    label: 'Transaction Coordinator',
    description: 'Transaction coordination and management',
    icon: 'FileText',
    permissions: ['view_all_transactions', 'update_transaction_status', 'manage_checklists', 'coordinate_vendors'],
  },
  compliance_officer: {
    label: 'Compliance Officer',
    description: 'Compliance oversight and audit',
    icon: 'CheckCircle2',
    permissions: ['view_all_communications', 'flag_violations', 'generate_reports', 'view_audit_logs'],
  },
  vendor: {
    label: 'Vendor',
    description: 'Service vendor',
    icon: 'Briefcase',
    permissions: ['view_referrals', 'manage_availability', 'submit_invoices', 'view_portfolio', 'manage_services'],
  },
  lender: {
    label: 'Lender',
    description: 'Mortgage lender / loan officer',
    icon: 'DollarSign',
    permissions: ['view_loan_pipeline', 'approve_loans', 'view_buyer_info', 'submit_to_underwriting'],
  },
  title_agent: {
    label: 'Title Agent',
    description: 'Title company representative',
    icon: 'FileCheck',
    permissions: ['view_title_orders', 'manage_documents', 'schedule_closing', 'track_title_status'],
  },
  contact: {
    label: 'Contact',
    description: 'Buyer / seller contact',
    icon: 'Home',
    permissions: ['view_transaction', 'view_documents', 'request_showing', 'view_portal'],
  },
}

// ─── SHARED INTERFACES ────────────────────────────────────────────────────────

export interface UserContext {
  id: string
  email: string
  firstName: string
  lastName: string
  roles: UserRole[]
  brokerageId?: string
  teamId?: string
  agentId?: string
  vendorId?: string
}

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

// Individual permissions
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
  role: UserRole
  level: number
  canManage: UserRole[]
  canViewData: 'own' | 'team' | 'brokerage' | 'all'
}

export interface RolePermissions {
  role: UserRole
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
