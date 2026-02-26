// ─── OFFER PERMISSIONS ────────────────────────────────────────────────────────
export {
  canCreateOffer,
  canSendOfferForSignature,
  canCounterOffer,
  canEditOffer,
  canWithdrawOffer,
} from './offer-permissions'
export type {
  PermissionCheckResult,
  CanCreateOfferParams,
  CanSendOfferForSignatureParams,
  CanCounterOfferParams,
} from './offer-permissions'

// ─── SECURITY RE-EXPORTS (backward-compat shims) ──────────────────────────────
// These files delegate to lib/security — import from @/lib/security directly.
export { AccessControl } from '@/lib/security'
export type { Permission, ResourceAccess, AccessCheckResult } from '@/lib/security'
export { RoleManager } from '@/lib/security'
export { FeatureFlags } from '@/lib/security'
export { UIHelpers } from '@/lib/security'
export {
  checkServerActionPermission,
  requireServerPermission,
} from '@/lib/security'
