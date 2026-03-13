"use server"

import { createClient } from "@/lib/supabase/server"

/**
 * Resolves authenticated user to context with userId, agentId (if applicable), and brokerageId.
 * Works for all user types (agent, broker, admin, tc, compliance_officer, vendor, etc.)
 * agentId will be null for non-agent users.
 * brokerageId is required - throws if user is not associated with a brokerage.
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

  // Determine userType from users table or auth metadata
  const userType = userData?.user_type ?? user.user_metadata?.user_type ?? "agent"
  
  // brokerageId is required - check users table first, then auth metadata
  const brokerageId = userData?.brokerage_id ?? user.user_metadata?.brokerage_id
  
  if (!brokerageId) {
    throw new Error("User is not associated with a brokerage")
  }

  // Try to get agent record if user is an agent type
  let agentId: string | null = null
  if (userType === "agent") {
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
