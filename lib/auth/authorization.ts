"use server"
// Compatibility shim — logic has moved to lib/security/authorization
export {
  requireSuperAdmin,
  isSuperAdmin,
  requireSubscriptionAdmin,
  isSubscriptionAdmin,
  getSubscriptionAdmin,
  getCurrentUserSubscriptionContext,
} from '@/lib/security/authorization'
export type { AuthorizedUser, SubscriptionContext } from '@/lib/security/types'
