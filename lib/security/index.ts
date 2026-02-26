// ─── TYPES ────────────────────────────────────────────────────────────────────
export type {
  Permission,
  PermissionGroup,
  RoleHierarchy,
  RolePermissions,
  ResourceAccess,
  AccessCheckResult,
  AuthorizedUser,
  SubscriptionContext,
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
