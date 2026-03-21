import type { UserRole } from "@/lib/auth/resolve-user-role"

/**
 * Canonical shape of a row returned from the `users` table.
 *
 * user_type  — canonical, always select this
 * role       — deprecated legacy column; kept for backward compat only
 *
 * Rule: Never check .role alone. Use resolveUserRole(profile) from
 * lib/auth/resolve-user-role.ts which applies the (user_type ?? role) fallback.
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
