"use client"

import { createClient } from "@/lib/supabase/client"
import { ROLE_PERMISSIONS } from "@/lib/security/permission-matrix"
import { toCanonicalRole } from "@/lib/security/types"
import { readRoleGrants, allRoles } from "@/lib/auth/role-grants"
import { isTenantAdminGrantRole } from "@/lib/auth/resolve-user-role"

/**
 * Client-side permission utilities
 * These are lightweight checks that can be used in client components
 * For security-critical operations, always verify on the server
 */

export type Role = "agent" | "broker" | "admin" | "tc" | "isa" | "team_lead" | "compliance_officer" | "vendor" | "lender" | "superadmin" | "contact" | "system"

export interface UserRole {
  /**
   * ONE role name, for callers that can only display or branch on one. Chosen by
   * the shared authority precedence — never by row order. See `roleNames` when the
   * question is "does this user hold X?", which is what it usually is.
   */
  roleName: Role
  /** EVERY role this user holds, in authority order. A seat may carry several. */
  roleNames: Role[]
  /** The UNION of the capabilities of every held role. */
  capabilities: string[]
}

/**
 * Get current user's roles from client
 * This is a convenience method - server-side checks should be used for security
 */
export async function getClientUserRole(): Promise<UserRole | null> {
  const supabase = createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return null
  }

  // user_role_assignments replaced user_brokerage_roles — user_brokerage_roles was a writer-less
  // legacy twin (burn-down round 4 repoint). The canonical table carries a flat `role` column
  // (no roles/role_capabilities join); capabilities derive from the permission matrix instead.
  //
  // WAS `.eq("user_id", user.id).maybeSingle()`. The table is UNIQUE on
  // (user_id, role), NOT on user_id — a seat holding several roles is the DESIGNED
  // case, not an anomaly, so this read errored for precisely the users with the
  // most capabilities and (the error being discarded) returned null: "no role at
  // all". A single-row read cannot answer "what may this user do?"; only the set
  // can, and the capabilities are the UNION over that set.
  const grantsResult = await readRoleGrants(supabase, user.id)
  if (!grantsResult.ok) {
    // A refused read is not "this user has no role" — say so, and return null
    // rather than a confidently empty capability list.
    console.error("[Auth] client role grant read failed:", grantsResult.error)
    return null
  }

  const roleNames = allRoles(grantsResult.grants) as Role[]
  if (roleNames.length === 0) {
    return null
  }

  const capabilities = [
    ...new Set(
      roleNames.flatMap((r) => {
        const canonical = toCanonicalRole(r)
        return canonical ? [...(ROLE_PERMISSIONS[canonical]?.permissions ?? [])] : []
      }),
    ),
  ]

  return {
    roleName: roleNames[0],
    roleNames,
    capabilities,
  }
}

/**
 * Check if user has capability (client-side)
 * WARNING: This is not secure - always verify on server for protected operations
 */
export async function clientHasCapability(capability: string): Promise<boolean> {
  const role = await getClientUserRole()
  return role?.capabilities.includes(capability) || false
}

/**
 * Check if user is admin (client-side)
 * WARNING: This is not secure - always verify on server for protected operations
 */
export async function clientIsAdmin(): Promise<boolean> {
  const role = await getClientUserRole()
  // Against roleNames, not roleName: an admin grant held ALONGSIDE an agent grant
  // still makes the user an admin. Testing the one chosen name would have denied
  // it whenever the other grant sorted first.
  return (role?.roleNames ?? []).some((r) => isTenantAdminGrantRole(r))
}
