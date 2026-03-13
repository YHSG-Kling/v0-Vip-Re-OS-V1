"use server"

import { createClient } from "@/lib/supabase/server"

/**
 * Resolves authenticated user to context with userId, agentId (if applicable), and brokerageId.
 * Works for all user types (agent, broker, admin, tc, compliance_officer, vendor, etc.)
 * agentId will be null for non-agent users.
 */
export async function getAgentContext() {
  const supabase = await createClient()
  
  const {
    data: { user },
  } = await supabase.auth.getUser()
  
  if (!user) {
    throw new Error("Not authenticated")
  }

  // First get the user record for brokerage_id and user_type
  const { data: userData, error: userError } = await supabase
    .from("users")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .single()

  if (userError || !userData) {
    throw new Error("User profile not found")
  }

  // Try to get agent record if user is an agent type
  let agentId: string | null = null
  if (userData.user_type === "agent") {
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
    brokerageId: userData.brokerage_id,
    userType: userData.user_type,
  }
}
