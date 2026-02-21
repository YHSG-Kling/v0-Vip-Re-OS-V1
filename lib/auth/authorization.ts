"use server"

import { createClient } from "@/lib/supabase/server"

// Type definitions
export interface AuthorizedUser {
  id: string
  email: string
  platformRole: string
}

export interface SubscriptionContext {
  brokerageId?: string
  teamId?: string
  agentId?: string
}

/**
 * Require super admin access
 * @throws {Error} If user is not authenticated or not a super admin
 * @returns {Promise<AuthorizedUser>} Authorized super admin user
 */
export async function requireSuperAdmin(): Promise<AuthorizedUser> {
  const supabase = await createClient()
  
  // Get authenticated user
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  
  if (authError || !user) {
    console.warn("[Authorization] Unauthorized access attempt to super admin resource")
    throw new Error("Unauthorized: Not authenticated")
  }
  
  try {
    // Query users table for platform_role
    const { data, error } = await supabase
      .from("users")
      .select("platform_role, email")
      .eq("id", user.id)
      .single()
    
    if (error) {
      console.error("[Authorization] Database error checking super admin status:", error)
      throw new Error("Authorization check failed")
    }
    
    if (!data || data.platform_role !== "super_admin") {
      console.warn(`[Authorization] User ${user.id} attempted super admin access without permission`)
      throw new Error("Forbidden: Super admin access required")
    }
    
    return {
      id: user.id,
      email: data.email,
      platformRole: data.platform_role
    }
  } catch (error) {
    if (error instanceof Error && (error.message.includes("Forbidden") || error.message.includes("Authorization"))) {
      throw error
    }
    console.error("[Authorization] Unexpected error in requireSuperAdmin:", error)
    throw new Error("Authorization check failed")
  }
}

/**
 * Check if current user is a super admin
 * @returns {Promise<boolean>} True if user is super admin, false otherwise
 */
export async function isSuperAdmin(): Promise<boolean> {
  try {
    await requireSuperAdmin()
    return true
  } catch {
    return false
  }
}

/**
 * Require subscription admin access for a specific subscription context
 * @param {SubscriptionContext} context - The subscription context (brokerageId, teamId, or agentId)
 * @throws {Error} If user is not authenticated or not the subscription admin
 * @returns {Promise<AuthorizedUser>} Authorized subscription admin user
 */
export async function requireSubscriptionAdmin(context: SubscriptionContext): Promise<AuthorizedUser> {
  const supabase = await createClient()
  
  // Get authenticated user
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  
  if (authError || !user) {
    console.warn("[Authorization] Unauthorized access attempt to subscription admin resource")
    throw new Error("Unauthorized: Not authenticated")
  }
  
  // Validate context
  if (!context.brokerageId && !context.teamId && !context.agentId) {
    throw new Error("Authorization context required: must provide brokerageId, teamId, or agentId")
  }
  
  try {
    // Build OR filter for subscription query
    const filters: string[] = []
    if (context.brokerageId) filters.push(`brokerage_id.eq.${context.brokerageId}`)
    if (context.teamId) filters.push(`team_id.eq.${context.teamId}`)
    if (context.agentId) filters.push(`agent_id.eq.${context.agentId}`)
    
    const orFilter = filters.join(',')
    
    // Query ai_subscription_tier
    const { data: subscription, error: subError } = await supabase
      .from("ai_subscription_tier")
      .select("admin_user_id, tier_name")
      .or(orFilter)
      .eq("is_active", true)
      .single()
    
    if (subError || !subscription) {
      console.warn(`[Authorization] No active subscription found for context:`, context)
      throw new Error("No active subscription found for this context")
    }
    
    // Check if current user is the subscription admin
    if (subscription.admin_user_id !== user.id) {
      console.warn(`[Authorization] User ${user.id} attempted subscription admin access without permission`)
      throw new Error("Forbidden: Subscription admin access required")
    }
    
    // Get user details
    const { data: userData, error: userError } = await supabase
      .from("users")
      .select("email, platform_role")
      .eq("id", user.id)
      .single()
    
    if (userError || !userData) {
      console.error("[Authorization] Database error fetching user details:", userError)
      throw new Error("Authorization check failed")
    }
    
    return {
      id: user.id,
      email: userData.email,
      platformRole: userData.platform_role || "user"
    }
  } catch (error) {
    if (error instanceof Error && (error.message.includes("Forbidden") || error.message.includes("Authorization") || error.message.includes("No active subscription"))) {
      throw error
    }
    console.error("[Authorization] Unexpected error in requireSubscriptionAdmin:", error)
    throw new Error("Authorization check failed")
  }
}

/**
 * Check if current user is a subscription admin for the given context
 * @param {SubscriptionContext} context - The subscription context
 * @returns {Promise<boolean>} True if user is subscription admin, false otherwise
 */
export async function isSubscriptionAdmin(context: SubscriptionContext): Promise<boolean> {
  try {
    await requireSubscriptionAdmin(context)
    return true
  } catch {
    return false
  }
}

/**
 * Get subscription admin information for a given context
 * @param {SubscriptionContext} context - The subscription context
 * @returns {Promise<{userId: string; email: string; tierName: string} | null>} Subscription admin info or null
 */
export async function getSubscriptionAdmin(
  context: SubscriptionContext
): Promise<{ userId: string; email: string; tierName: string } | null> {
  // Return null if no context provided
  if (!context.brokerageId && !context.teamId && !context.agentId) {
    return null
  }
  
  try {
    const supabase = await createClient()
    
    // Build OR filter
    const filters: string[] = []
    if (context.brokerageId) filters.push(`brokerage_id.eq.${context.brokerageId}`)
    if (context.teamId) filters.push(`team_id.eq.${context.teamId}`)
    if (context.agentId) filters.push(`agent_id.eq.${context.agentId}`)
    
    const orFilter = filters.join(',')
    
    // Query ai_subscription_tier with JOIN to users
    const { data, error } = await supabase
      .from("ai_subscription_tier")
      .select("admin_user_id, tier_name, users:admin_user_id(email)")
      .or(orFilter)
      .eq("is_active", true)
      .single()
    
    if (error || !data || !data.admin_user_id) {
      return null
    }
    
    // Extract email from joined users table
    const userEmail = (data.users as any)?.email
    
    if (!userEmail) {
      return null
    }
    
    return {
      userId: data.admin_user_id,
      email: userEmail,
      tierName: data.tier_name
    }
  } catch (error) {
    console.error("[Authorization] Error fetching subscription admin:", error)
    return null
  }
}

/**
 * Get current user's subscription context (if they are a subscription admin)
 * @returns {Promise<SubscriptionContext | null>} User's subscription context or null
 */
export async function getCurrentUserSubscriptionContext(): Promise<SubscriptionContext | null> {
  try {
    const supabase = await createClient()
    
    // Get authenticated user
    const { data: { user }, error: authError } = await supabase.auth.getUser()
    
    if (authError || !user) {
      return null
    }
    
    // Query ai_subscription_tier where user is admin
    const { data, error } = await supabase
      .from("ai_subscription_tier")
      .select("brokerage_id, team_id, agent_id")
      .eq("admin_user_id", user.id)
      .eq("is_active", true)
      .single()
    
    if (error || !data) {
      return null
    }
    
    return {
      brokerageId: data.brokerage_id || undefined,
      teamId: data.team_id || undefined,
      agentId: data.agent_id || undefined
    }
  } catch (error) {
    console.error("[Authorization] Error fetching user subscription context:", error)
    return null
  }
}
