// ─── CLIENT HOOK ──────────────────────────────────────────────────────────────
// NOTE: Only import useAuth in Client Components ("use client").
export { useAuth } from "./useAuth"

// ─── SERVER-SIDE PERMISSIONS ──────────────────────────────────────────────────
export type { Role, UserWithRole, BrokerageContext } from "./permissions"
export {
  getUserBrokerages,
  hasCapability,
  hasRole,
  isAdmin,
  assertCapability,
  assertRole,
  assertAdmin,
  getCurrentBrokerageId,
  canAccessResource,
} from "./permissions"

// ─── CLIENT-SIDE PERMISSIONS ──────────────────────────────────────────────────
export type { UserRole } from "./permissions-client"
export { getClientUserRole, clientHasCapability, clientIsAdmin } from "./permissions-client"

// ─── AUTHORIZATION (re-exports from lib/security for backwards compatibility) ─
// Prefer importing directly from "@/lib/security" for new code.
export type { AuthorizedUser, SubscriptionContext } from "./authorization"
