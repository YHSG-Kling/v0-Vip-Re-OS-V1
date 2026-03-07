"use server"

import { createClient } from "@/lib/supabase/server"

/**
 * Resolves authenticated user to agent context
 * Returns userId, agentId, and brokerageId for proper FK relationships
 */
export async function getAgentContext() {
  const supabase = await createClient()
  
  const {
    data: { user },
  } = await supabase.auth.getUser()
  
  if (!user) {
    throw new Error("Not authenticated")
  }

  // Query agents table to get agent_id and brokerage_id
  const { data: agent, error } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("user_id", user.id)
    .single()

  if (error || !agent) {
    throw new Error("Agent profile not found")
  }

  return {
    userId: user.id,
    agentId: agent.id,
    brokerageId: agent.brokerage_id,
  }
}
