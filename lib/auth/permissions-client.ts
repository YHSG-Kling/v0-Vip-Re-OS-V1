"use client"

import { createClient } from "@/lib/supabase/client"

/**
 * Client-side permission utilities
 * These are lightweight checks that can be used in client components
 * For security-critical operations, always verify on the server
 */

export type Role = "BrokerOwner" | "ManagingBroker" | "Agent" | "tc" | "compliance_officer"

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

  const { data: userBrokerageRole } = await supabase
    .from("user_brokerage_roles")
    .select(`
      roles (
        name,
        role_capabilities (
          capability
        )
      )
    `)
    .eq("user_id", user.id)
    .eq("is_primary", true)
    .single()

  if (!userBrokerageRole) {
    return null
  }

  const role = Array.isArray(userBrokerageRole.roles) ? userBrokerageRole.roles[0] : userBrokerageRole.roles

  const capabilities = role?.role_capabilities?.map((rc: any) => rc.capability) || []

  return {
    roleName: role?.name as Role,
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
  return ["BrokerOwner", "ManagingBroker"].includes(role?.roleName || "") || false
}
