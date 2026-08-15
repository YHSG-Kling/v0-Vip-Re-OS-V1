

import { createServerClient } from "@supabase/ssr"
import { cookies } from "next/headers"

// Canonical user_type values — must match users.user_type in the DB
export type Role =
  | "agent"
  | "broker"
  | "admin"
  | "tc"
  | "isa"
  | "team_lead"
  | "compliance_officer"
  | "vendor"
  | "lender"
  | "superadmin"
  | "contact"
  | "system"

// Static capability sets per role (replaces role_capabilities DB table)
const ROLE_CAPABILITIES: Record<string, string[]> = {
  superadmin: ["*"],
  broker: ["contacts:read", "contacts:write", "listings:read", "listings:write", "transactions:read", "transactions:write", "agents:read", "agents:write", "reports:read", "billing:read", "billing:write", "admin:read", "admin:write"],
  admin: ["contacts:read", "contacts:write", "listings:read", "listings:write", "transactions:read", "transactions:write", "agents:read", "reports:read", "admin:read"],
  team_lead: ["contacts:read", "contacts:write", "listings:read", "listings:write", "transactions:read", "agents:read", "reports:read"],
  agent: ["contacts:read", "contacts:write", "listings:read", "listings:write", "transactions:read"],
  tc: ["transactions:read", "transactions:write", "listings:read", "contacts:read"],
  compliance_officer: ["transactions:read", "listings:read", "contacts:read", "compliance:read", "compliance:write"],
  isa: ["contacts:read", "contacts:write"],
  vendor: ["listings:read"],
  lender: ["contacts:read"],
}

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
 * Get user's primary brokerage context with role and capabilities
 * @returns UserWithRole object or null if not found
 */
export async function getCurrentUserContext(): Promise<UserWithRole | null> {
  const supabase = await getSupabaseServerClient()

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser()

  if (authError || !user) {
    console.error("[Auth] Error fetching current user:", authError)
    return null
  }

  // Canonical resolution: users table is the primary source of truth for
  // brokerage_id and user_type; user_role_assignments is the RBAC join table.
  const [usersResult, roleResult] = await Promise.all([
    supabase
      .from("users")
      .select("brokerage_id, user_type")
      .eq("id", user.id)
      .maybeSingle(),
    supabase
      .from("user_role_assignments")
      .select("id, role, brokerage_id, brokerages(id, name, slug)")
      .eq("user_id", user.id)
      .maybeSingle(),
  ])

  // Derive brokerage_id and user_type from canonical sources
  const brokerageId: string =
    (usersResult.data?.brokerage_id ?? roleResult.data?.brokerage_id) ?? ""

  const rawUserType: string =
    usersResult.data?.user_type ??
    (user.user_metadata?.user_type as string | undefined) ??
    "agent"

  const roleName: Role = rawUserType as Role
  const capabilities: string[] = ROLE_CAPABILITIES[rawUserType] ?? ROLE_CAPABILITIES.agent

  // Brokerage name from user_role_assignments join (optional enrichment)
  const brokRecord = roleResult.data
    ? (Array.isArray(roleResult.data.brokerages)
        ? roleResult.data.brokerages[0]
        : roleResult.data.brokerages)
    : null

  if (!brokerageId) {
    console.warn("[Auth] No brokerage_id found for user:", user.id)
  }

  return {
    id: user.id,
    email: user.email!,
    brokerageId,
    brokerageName: (brokRecord as any)?.name ?? "",
    roleId: roleResult.data?.id ?? rawUserType,
    roleName,
    capabilities,
    isPrimary: true,
  }
}

/**
 * Alias for getCurrentUserContext — provides UserWithRole shape for permission checks.
 * Used by hasCapability, hasRole, isAdmin, requireRole, etc.
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
    .from("user_role_assignments")
    .select("brokerages(id, name, slug)")
    .eq("user_id", user.id)

  if (error || !userBrokerages) {
    // Fallback to users table for single brokerage
    const { data: userData } = await supabase
      .from("users")
      // users↔brokerages is joined by TWO foreign keys (users.brokerage_id and
      // brokerages.ai_isa_system_user_id), so the bare embed was PGRST201 — this
      // FALLBACK, the one that runs when the role-assignment read fails, could
      // never itself succeed. The two embeds above are off user_role_assignments,
      // which has a single FK to brokerages and needs no hint.
      .select("brokerage_id, brokerages!users_brokerage_id_fkey(id, name, slug)")
      .eq("id", user.id)
      .maybeSingle()
    if (!userData?.brokerage_id) return []
    const b = Array.isArray((userData as any).brokerages)
      ? (userData as any).brokerages[0]
      : (userData as any).brokerages
    return b ? [{ id: b.id, name: b.name ?? "", code: b.slug ?? "" }] : []
  }

  return userBrokerages
    .map((ub: any) => {
      const brokerage = Array.isArray(ub.brokerages) ? ub.brokerages[0] : ub.brokerages
      return brokerage ? { id: brokerage.id, name: brokerage.name ?? "", code: brokerage.slug ?? "" } : null
    })
    .filter((b): b is BrokerageContext => !!b)
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
 * Check if the current user is an admin (broker, admin, or superadmin)
 * @returns true if user is an admin, false otherwise
 */
export async function isAdmin(): Promise<boolean> {
  const user = await getCurrentUserWithRole()

  if (!user) {
    return false
  }

  return ["broker", "admin", "superadmin"].includes(user.roleName)
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
    throw new Error(`Access denied. User ${user?.email || "unknown"} must have role: broker, admin, or superadmin`)
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
