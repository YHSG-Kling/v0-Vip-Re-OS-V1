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
  SubscriptionContext,
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

// ─── AUTHORIZATION (super admin / subscription admin) ─────────────────────────
export {
  requireSuperAdmin,
  isSuperAdmin,
  requireSubscriptionAdmin,
  isSubscriptionAdmin,
  getSubscriptionAdmin,
  getCurrentUserSubscriptionContext,
} from './authorization'

// ─── PERMISSIONS SERVICE (UI / client-side runtime checks) ────────────────────
export { permissionsService, ROLE_NAVIGATION } from './permissions-service'
export type { UserAccessContext, UserSubType } from './permissions-service'
