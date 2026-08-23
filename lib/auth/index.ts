/**
 * lib/auth/index.ts — SERVER-ONLY barrel.
 *
 * Safe to import in Server Components, Route Handlers, and Server Actions.
 * Do NOT import from this file in Client Components.
 *
 * For client-side auth utilities (useAuth, getClientUserRole, etc.)
 * import from "@/lib/auth/client" instead.
 */

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

// ─── AUTHORIZATION (re-exports from lib/security for backwards compatibility) ─
// Prefer importing directly from "@/lib/security" for new code.
// SubscriptionContext removed with the four subscription-admin gates —
// see the tombstone in ./authorization.ts.
export type { AuthorizedUser } from "./authorization"
