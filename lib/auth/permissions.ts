

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

// Type definitions
export type Role = "BrokerOwner" | "ManagingBroker" | "Agent" | "TC" | "Compliance"

export interface UserWithRole {
  id: string
  email: string
  brokerageId: string
  brokerageName: string
  roleId: string
  roleName: Role
  capabilities: string[]
  isPrimary: boolean
}

export interface BrokerageContext {
  id: string
  name: string
  code: string
}

/**
 * Creates a Supabase server client for server-side operations
 */
function getSupabaseServerClient() {
  const cookieStore = cookies()
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value
      },
    },
  })
}

/**
 * Get the current authenticated user with their role and brokerage information
 * @returns UserWithRole object or null if not authenticated
 */
export async function getCurrentUserWithRole(): Promise<UserWithRole | null> {
  const supabase = getSupabaseServerClient()

  // Get current user from Supabase Auth
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return null
  }

  // Get user's brokerage and role information
  const { data: userBrokerageRole, error: roleError } = await supabase
    .from("user_brokerage_roles")
    .select(`
      brokerage_id,
      role_id,
      is_primary,
      brokerages (
        id,
        name,
        code
      ),
      roles (
        id,
        name,
        role_capabilities (
          capability
        )
      )
    `)
    .eq("user_id", user.id)
    .eq("is_primary", true)
    .single()

  if (roleError || !userBrokerageRole) {
    console.error("[Auth] Error fetching user role:", roleError)
    return null
  }

  const brokerage = Array.isArray(userBrokerageRole.brokerages)
    ? userBrokerageRole.brokerages[0]
    : userBrokerageRole.brokerages

  const role = Array.isArray(userBrokerageRole.roles) ? userBrokerageRole.roles[0] : userBrokerageRole.roles

  const capabilities = role?.role_capabilities?.map((rc: any) => rc.capability) || []

  return {
    id: user.id,
    email: user.email!,
    brokerageId: userBrokerageRole.brokerage_id,
    brokerageName: brokerage?.name || "",
    roleId: userBrokerageRole.role_id,
    roleName: role?.name as Role,
    capabilities,
    isPrimary: userBrokerageRole.is_primary,
  }
}

/**
 * Get all brokerages the current user belongs to
 * @returns Array of BrokerageContext objects
 */
export async function getUserBrokerages(): Promise<BrokerageContext[]> {
  const supabase = getSupabaseServerClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    return []
  }

  const { data: userBrokerages, error } = await supabase
    .from("user_brokerage_roles")
    .select(`
      brokerages (
        id,
        name,
        code
      )
    `)
    .eq("user_id", user.id)

  if (error || !userBrokerages) {
    return []
  }

  return userBrokerages.map((ub: any) => {
    const brokerage = Array.isArray(ub.brokerages) ? ub.brokerages[0] : ub.brokerages
    return {
      id: brokerage.id,
      name: brokerage.name,
      code: brokerage.code,
    }
  })
}

/**
 * Check if the current user has a specific capability
 * @param capability - The capability to check (e.g., 'contacts:write')
 * @returns true if user has the capability, false otherwise
 */
export async function hasCapability(capability: string): Promise<boolean> {
  const user = await getCurrentUserWithRole()

  if (!user) {
    return false
  }

  return user.capabilities.includes(capability)
}

/**
 * Check if the current user has a specific role
 * @param roleName - The role to check
 * @returns true if user has the role, false otherwise
 */
export async function hasRole(roleName: Role): Promise<boolean> {
  const user = await getCurrentUserWithRole()

  if (!user) {
    return false
  }

  return user.roleName === roleName
}

/**
 * Check if the current user is an admin (BrokerOwner or ManagingBroker)
 * @returns true if user is an admin, false otherwise
 */
export async function isAdmin(): Promise<boolean> {
  const user = await getCurrentUserWithRole()

  if (!user) {
    return false
  }

  return ["BrokerOwner", "ManagingBroker"].includes(user.roleName)
}

/**
 * Assert that the current user has a specific capability
 * Throws an error if the user lacks the capability
 * @param capability - The required capability
 * @throws Error if user lacks the capability
 */
export async function assertCapability(capability: string): Promise<void> {
  const hasIt = await hasCapability(capability)

  if (!hasIt) {
    const user = await getCurrentUserWithRole()
    throw new Error(`Access denied. User ${user?.email || "unknown"} lacks required capability: ${capability}`)
  }
}

/**
 * Assert that the current user has a specific role
 * Throws an error if the user lacks the role
 * @param roleName - The required role
 * @throws Error if user lacks the role
 */
export async function assertRole(roleName: Role): Promise<void> {
  const hasIt = await hasRole(roleName)

  if (!hasIt) {
    const user = await getCurrentUserWithRole()
    throw new Error(`Access denied. User ${user?.email || "unknown"} must have role: ${roleName}`)
  }
}

/**
 * Assert that the current user is an admin
 * Throws an error if the user is not an admin
 * @throws Error if user is not an admin
 */
export async function assertAdmin(): Promise<void> {
  const admin = await isAdmin()

  if (!admin) {
    const user = await getCurrentUserWithRole()
    throw new Error(`Access denied. User ${user?.email || "unknown"} must be a BrokerOwner or ManagingBroker`)
  }
}

/**
 * Get the current user's primary brokerage ID
 * Useful for filtering queries by brokerage
 * @returns Brokerage UUID or null
 */
export async function getCurrentBrokerageId(): Promise<string | null> {
  const user = await getCurrentUserWithRole()
  return user?.brokerageId || null
}

/**
 * Check if current user can access a specific resource
 * @param resourceOwnerId - The user_id who owns the resource
 * @param assignedAgentId - The agent_id assigned to the resource
 * @param sharedWithUserIds - Array of user IDs the resource is shared with
 * @returns true if user can access, false otherwise
 */
export async function canAccessResource(
  resourceOwnerId?: string | null,
  assignedAgentId?: string | null,
  sharedWithUserIds?: string[] | null,
): Promise<boolean> {
  const user = await getCurrentUserWithRole()

  if (!user) {
    return false
  }

  // Admins can access everything in their brokerage
  if (await isAdmin()) {
    return true
  }

  // TC and Compliance can access all transactions
  if (["TC", "Compliance"].includes(user.roleName)) {
    return true
  }

  // Check if user is the owner or assigned agent
  if (resourceOwnerId === user.id || assignedAgentId === user.id) {
    return true
  }

  // Check if explicitly shared
  if (sharedWithUserIds && sharedWithUserIds.includes(user.id)) {
    return true
  }

  return false
}
