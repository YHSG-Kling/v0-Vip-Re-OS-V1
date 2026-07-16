"use client"

import { createClient } from "@/lib/supabase/client"
import { ROLE_PERMISSIONS } from "@/lib/security/permission-matrix"
import { toCanonicalRole } from "@/lib/security/types"

/**
 * Client-side permission utilities
 * These are lightweight checks that can be used in client components
 * For security-critical operations, always verify on the server
 */

export type Role = "agent" | "broker" | "admin" | "tc" | "isa" | "team_lead" | "compliance_officer" | "vendor" | "lender" | "superadmin" | "contact" | "system"

export interface UserRole {
  roleName: Role
  capabilities: string[]
}

/**
 * Get current user's role from client
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
  const { data: roleRow } = await supabase
    .from("user_role_assignments")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle()

  if (!roleRow?.role) {
    return null
  }

  const canonical = toCanonicalRole(roleRow.role)
  const capabilities: string[] = canonical ? [...(ROLE_PERMISSIONS[canonical]?.permissions ?? [])] : []

  return {
    roleName: roleRow.role as Role,
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
  return ["broker", "admin", "superadmin"].includes(role?.roleName || "") || false
}
