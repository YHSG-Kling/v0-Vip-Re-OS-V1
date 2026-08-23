// ─── TYPES ────────────────────────────────────────────────────────────────────
export type {
  // Role types
  UserRole,
  CanonicalRole,
  LegacyRole,
  RawRole,
  // Permission / structure types
  Permission,
  PermissionGroup,
  RoleHierarchy,
  RolePermissions,
  ResourceAccess,
  AccessCheckResult,
  AuthorizedUser,
  // Config
  RoleConfig,
  UserContext,
} from './types'

// ─── MAPPING FUNCTIONS (canonical role resolution) ────────────────────────────
export {
  toCanonicalRole,
  toCanonicalRoleOrDefault,
  toCanonicalRoles,
  isCanonicalRole,
  // Expansion for DB filters — a Postgres .in() cannot canonicalize, so it has
  // to be handed every raw spelling that means the role.
  rawRoleVariants,
  rawRoleVariantsFor,
  CANONICAL_ROLE_CONFIG,
} from './types'

// ─── PERMISSION MATRIX (single source of truth) ───────────────────────────────
export { ROLE_HIERARCHY, ROLE_PERMISSIONS, PERMISSION_DEFINITIONS, FEATURE_FLAGS } from './permission-matrix'

// ─── CLASSES ──────────────────────────────────────────────────────────────────
export { RoleManager } from './role-manager'
export { AccessControl } from './access-control'
export { FeatureFlags } from './feature-flags'
export { UIHelpers } from './ui-helpers'

// ─── SERVER GUARDS ────────────────────────────────────────────────────────────
export { checkServerActionPermission, requirePermission as requireServerPermission } from './server-action-guard'

// ─── RBAC (resource-level ACL) ────────────────────────────────────────────────
export {
  requirePermission,
  autoGrantAccess,
  revokeAccess,
  batchGrantAccess,
  getResourceAccessList,
} from './rbac'

// ─── AUTHORIZATION (super admin) ──────────────────────────────────────────────
// TOMBSTONE: the four subscription-admin exports that stood here are deleted —
// zero callers, and re-exported through a `"use server"` file, so each was a
// public HTTP endpoint nothing needed. Survivor for "may this user administer
// the tenant's subscription": app/actions/billing.ts:46 requireTenantBillingAdmin
// over BROKERAGE_FINANCE_ADMIN_USER_TYPES. Full reasoning, and the live RLS
// policy that still reads ai_subscription_tier, at ./authorization.ts:39.
export {
  requireSuperAdmin,
  isSuperAdmin,
} from './authorization'

// ─── PERMISSIONS SERVICE (UI / client-side runtime checks) ────────────────────
export { permissionsService, ROLE_NAVIGATION } from './permissions-service'
export type { UserAccessContext, UserSubType } from './permissions-service'
