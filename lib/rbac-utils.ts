// Compatibility shim — logic has moved to lib/security/rbac
export {
  requirePermission,
  autoGrantAccess,
  revokeAccess,
  batchGrantAccess,
  getResourceAccessList,
} from '@/lib/security/rbac'
