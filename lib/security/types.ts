// ─── CANONICAL ROLE DEFINITIONS (single source of truth) ─────────────────────
//
// System catalog: superadmin | admin | broker | team_lead | agent | isa |
//                 tc | compliance_officer | vendor | lender | title_agent |
//                 contact
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
  //
  // ─── THERE IS NO SEAT BELOW THE SEAT ───────────────────────────────────────
  // A `member` value was added here and then REMOVED, on the owner's ruling:
  // "you introduced member awhile back and we don't need it. user is introduced
  // with the usertype and then role just adds more capability."
  //
  // The model needs no bare seat. A user is CREATED WITH a user_type — that IS
  // their seat and it already carries what they can see — and a grant in
  // user_role_assignments ADDS capability on top of it. `member` was an extra
  // rung invented under that model, not part of it. Nothing was lost by
  // removing it: 0 live rows ever held it (measured at the time it was added
  // and again at the time it was dropped), no policy or boolean helper in the
  // schema ever named it, and it was in neither STAFF_NAV_PRECEDENCE nor
  // EXTERNAL_NAV_ROLES, so it contributed nothing to any workspace.
  //
  // Do NOT re-add it. `team_member` below is UNRELATED — it is a legacy string
  // that means a producing agent on a team, and it maps to `agent`.

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
  | 'team_member'              // → agent (the TEAM-tier twin of solo_agent)

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
  // broker_owner is NOT legacy — it is one of the fourteen STORABLE user_type
  // values (users_user_type_check) and it is in the owner's admin-class roster
  // verbatim: "broker, broker admin, broker owner, team lead, admin". It sat in
  // NEITHER CanonicalRole NOR this map, so toCanonicalRole('broker_owner')
  // returned null and toCanonicalRoleOrDefault(…, 'agent') — the form used at 52
  // call sites, and 'agent' is the default at nearly all of them — DEMOTED THE
  // PERSON WHO OWNS THE BROKERAGE TO AN AGENT. Every scope, navigation and
  // permission decision downstream then treated them as a producing agent.
  //
  // Mapped to 'broker' rather than added to CanonicalRole, and the choice is
  // deliberate: broker_owner and broker are the SAME brokerage-wide scope
  // everywhere this codebase already decides scope — public.is_brokerage_admin()
  // admits {admin, broker, broker_owner} as one tier, and lib/kernel/egress-scope.ts
  // groups them. A thirteenth CanonicalRole would have to be given its own row in
  // every Record<UserRole, …> permission and navigation table, and inventing those
  // rows is minting a new vocabulary — the exact thing the ruling forbids — where
  // an alias states the truth: an owner IS a broker, with a title.
  broker_owner: 'broker',
  // solo_agent is a PLAN TIER string that leaked into role fields in early rows;
  // a solo-tier user is an agent.
  solo_agent: 'agent',
  // team_member is solo_agent's TEAM-TIER TWIN, and it maps the same way.
  //
  // AUDITED, because it was named in three places and existed in no vocabulary —
  // not in CanonicalRole, not in this map, not in users_user_type_check (14
  // values, none of them this). No account could hold it, so all three
  // references were dead. What they SAY it is, though, is unanimous:
  //
  //   lib/kernel/0.1-feature-access.ts  USER_TYPE_TO_TIER — `team_member: "team"`,
  //     sitting beside `team_lead: "team"` and `agent: "solo_agent"`. It is a
  //     BILLING-TIER classification of a producing seat.
  //   lib/kernel/helpers.ts:309         grouped with agent + team_lead as the
  //     `isAgent` test, which is what grants canEdit and canCreate.
  //   lib/kernel/helpers.ts:63          in STAFF_ROLES.
  //   app/components/layout/app-shell.tsx  in STAFF_AI_ROLES.
  //
  // All four give it PRODUCING, STAFF capability. That is the exact opposite of
  // the rights-less seat, so it is NOT an alias for `member`. It is "an agent
  // who is on a team" — and this schema already holds team membership as a FACT
  // in four places (teams.team_lead_id, users.team_id, team_members,
  // agents.team_id; see m431/m444, "leading a team is a fact, not a role"), so
  // the role half of it is a duplicate of `agent` and the team half is a
  // team_id. Mapped, not deleted: the four references above now agree with the
  // canonicaliser instead of being unreachable, and a legacy JWT or an imported
  // row carrying 'team_member' resolves to the producing seat it always meant.
  team_member: 'agent',

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
 * Every RAW string that resolves to `canonical` — the canonical value itself
 * plus every legacy alias that maps to it.
 *
 * This exists because a Postgres filter cannot call toCanonicalRole(). A query
 * like `.in("user_type", ["TC"])` is an exact, CASE-SENSITIVE comparison, and
 * live rows store 'tc'. That filter matched nothing and — since a query with no
 * matches is a perfectly successful query — it failed silently: notifyComplianceFlag
 * had never once reached a transaction coordinator, on any flag, while its own
 * comment said the TC would see it.
 *
 * So: canonicalize on the way IN (toCanonicalRole), and expand on the way OUT
 * (this). Both derive from the same table, so a new alias is picked up by both
 * without anyone remembering to update a hand-typed list.
 *
 * @example rawRoleVariants('tc') // → ['tc', 'transaction_coordinator', 'TC']
 */
export function rawRoleVariants(canonical: CanonicalRole): string[] {
  const out = [canonical as string]
  for (const [raw, mapped] of Object.entries(LEGACY_ROLE_MAP)) {
    if (mapped === canonical) out.push(raw)
  }
  return out
}

/** rawRoleVariants for several canonical roles at once, de-duplicated. */
export function rawRoleVariantsFor(canonicals: CanonicalRole[]): string[] {
  return Array.from(new Set(canonicals.flatMap(rawRoleVariants)))
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

// TOMBSTONE: `SubscriptionContext` is deleted. Its only consumers were the four
// subscription-admin gates in ./authorization.ts, which had zero callers and are
// deleted with it; the evidence it carried about the unmatchable team_id /
// agent_id arms is preserved in that file's tombstone at :39.
// Survivor for "may this user administer the tenant's subscription":
// app/actions/billing.ts:46 requireTenantBillingAdmin.
