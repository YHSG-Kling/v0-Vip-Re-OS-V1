"use server"

import { createClient } from "@/lib/supabase/server"

/**
 * Resolves authenticated user to context with userId, agentId (if applicable), and brokerageId.
 * Works for all user types (agent, broker, admin, tc, compliance_officer, vendor, etc.)
 * agentId will be null for non-agent users.
 * brokerageId may be null if user profile is incomplete - callers should handle this case.
 */
export async function getAgentContext() {
  const supabase = await createClient()
  
  const {
    data: { user },
  } = await supabase.auth.getUser()
  
  if (!user) {
    throw new Error("Not authenticated")
  }

  // Get the user record for brokerage_id and user_type
  const { data: userData } = await supabase
    .from("users")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  // Also check user_role_assignments for brokerage_id as fallback
  const { data: roleData } = await supabase
    .from("user_role_assignments")
    .select("brokerage_id, role, agent_id")
    .eq("user_id", user.id)
    .limit(1)
    .single()

  // Determine userType from multiple sources
  const userType = userData?.user_type ?? roleData?.role ?? user.user_metadata?.user_type ?? "agent"
  
  // brokerageId - check users table, then role assignments, then auth metadata
  const brokerageId = userData?.brokerage_id ?? roleData?.brokerage_id ?? user.user_metadata?.brokerage_id ?? null

  // Try to get agent record if user is an agent type
  let agentId: string | null = roleData?.agent_id ?? null
  if (!agentId && userType === "agent") {
    const { data: agent } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", user.id)
      .single()
    
    agentId = agent?.id ?? null
  }

  return {
    userId: user.id,
    agentId,
    brokerageId,
    userType,
  }
}
