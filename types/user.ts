import type { UserRole } from "@/lib/auth/resolve-user-role"

/**
 * Canonical shape of a row returned from the `users` table.
 *
 * user_type  — canonical, always select this
 * role       — deprecated legacy column; kept for backward compat only
 *
 * Rule: Never check .role — it is not read anywhere any more. `user_type` IS the
 * role. Read it directly for the raw column value; when you need the CANONICAL
 * role (legacy spellings mapped, unknowns rejected rather than cast) use
 * toCanonicalRole / toCanonicalRoleOrDefault from lib/security/types.ts:161.
 * To turn a role into PERMISSION, never compare strings at the call site — use
 * the named predicates in lib/auth/resolve-user-role.ts (isAdminOrBroker,
 * isBrokerageFinanceAdmin, isTenantAdminOrPlatformStaff, resolveTenantAdmin).
 *
 * This comment used to point at `resolveUserRole(profile)` and describe it as
 * applying "the (user_type ?? role) fallback". It did not — it ignored `role`
 * outright — and the function has been deleted; see the tombstone at
 * lib/auth/resolve-user-role.ts:90.
 */
export interface UserRow {
  id: string
  email: string
  first_name?: string | null
  last_name?: string | null
  /** Canonical role field — the source of truth post-migration */
  user_type: UserRole
  /** @deprecated — use user_type. Kept for backward compat during transition. */
  role?: UserRole | null
  brokerage_id?: string | null
  team_id?: string | null
  platform_role?: string | null
  contact_persona?: string | null
  assistant_wake_name?: string | null
  username?: string | null
  created_at?: string | null
  updated_at?: string | null
  deleted_at?: string | null
}
