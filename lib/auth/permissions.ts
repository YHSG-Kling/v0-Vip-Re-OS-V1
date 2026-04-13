

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

// Type definitions
export type Role = "BrokerOwner" | "ManagingBroker" | "Agent" | "tc" | "compliance_officer"

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
 * ✅ FIXED: Wrapped cookies() call to handle static generation context
 */
async function getSupabaseServerClient() {
  let cookieStore
  try {
    cookieStore = await cookies()
  } catch (error) {
    // If cookies() fails (e.g., during static generation), return a minimal client
    // This allows pages to generate statically without auth context
    return createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          get(_name: string) {
            return undefined
          },
        },
      }
    )
  }

  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      get(name: string) {
        return cookieStore.get(name)?.value
      },
    },
  })
}

/**
 * Get user's primary brokerage context with role and capabilities.
 *
 * Uses the CANONICAL tables (same as getAgentContext / useAuth):
 *   users.user_type  →  user_role_assignments.role  →  auth metadata  →  'agent'
 *
 * The previous implementation queried user_brokerage_roles which does NOT
 * exist in the schema, causing all permission checks to silently return null.
 */
export async function getCurrentUserContext(): Promise<UserWithRole | null> {
  const supabase = await getSupabaseServerClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) return null

  // Canonical lookup — same tables used by getAgentContext() and useAuth()
  const [{ data: userData }, { data: rolesData }] = await Promise.all([
    supabase
      .from("users")
      .select("id, email, brokerage_id, user_type, team_id")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("user_role_assignments")
      .select("brokerage_id, role, agent_id, capabilities")
      .eq("user_id", user.id)
      .limit(1),
  ])

  if (!userData) return null

  const firstRole = rolesData?.[0]
  const brokerageId = userData.brokerage_id ?? firstRole?.brokerage_id ?? ""
  if (!brokerageId) return null

  // Resolve brokerage name
  const { data: brokerage } = await supabase
    .from("brokerages")
    .select("name")
    .eq("id", brokerageId)
    .maybeSingle()

  // Canonical role resolution: users.user_type > role_assignment.role > 'agent'
  const canonicalRole = userData.user_type ?? firstRole?.role ?? "agent"
  const roleName = mapCanonicalToLegacyRole(canonicalRole)
  const capabilities: string[] =
    firstRole?.capabilities ?? getDefaultCapabilities(canonicalRole)

  return {
    id: userData.id,
    email: userData.email ?? user.email ?? "",
    brokerageId,
    brokerageName: brokerage?.name ?? "",
    roleId: firstRole?.agent_id ?? userData.id,
    roleName,
    capabilities,
    isPrimary: true,
  }
}

/** Map canonical role strings to the legacy Role type for backward compatibility. */
function mapCanonicalToLegacyRole(canonical: string): Role {
  const map: Record<string, Role> = {
    superadmin: "BrokerOwner",
    admin: "BrokerOwner",
    broker: "BrokerOwner",
    team_lead: "ManagingBroker",
    agent: "Agent",
    isa: "Agent",
    tc: "tc",
    compliance_officer: "compliance_officer",
  }
  return map[canonical] ?? "Agent"
}

/** Default capability sets by canonical role. */
function getDefaultCapabilities(role: string): string[] {
  const caps: Record<string, string[]> = {
    superadmin: ["*"],
    admin: ["contacts:write", "transactions:write", "listings:write", "compliance:write", "admin:write"],
    broker: ["contacts:write", "transactions:write", "listings:write", "compliance:read", "team:write"],
    team_lead: ["contacts:write", "transactions:write", "listings:write", "team:read"],
    agent: ["contacts:write", "transactions:write", "listings:write"],
    isa: ["contacts:read", "leads:write"],
    tc: ["transactions:write", "documents:write", "contacts:read"],
    compliance_officer: ["compliance:write", "contacts:read", "transactions:read"],
  }
  return caps[role] ?? ["contacts:read"]
}

/**
 * Alias for getCurrentUserContext.
 * Kept for backward compatibility — many files call getCurrentUserWithRole.
 */
export async function getCurrentUserWithRole(): Promise<UserWithRole | null> {
  return getCurrentUserContext()
}

/**
 * Get all brokerages the current user belongs to
 * @returns Array of BrokerageContext objects
 */
export async function getUserBrokerages(): Promise<BrokerageContext[]> {
  const supabase = await getSupabaseServerClient()

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
  if (["tc", "compliance_officer"].includes(user.roleName)) {
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
