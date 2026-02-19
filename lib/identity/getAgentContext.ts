import { SupabaseClient } from "@supabase/supabase-js"

/**
 * Resolves agent business identity from user authentication identity
 * 
 * CRITICAL: Never confuse user_id with agent_id
 * - user_id = authentication identity (users table)
 * - agent_id = business profile identity (agents table)
 * 
 * Always use this helper to maintain proper identity separation
 */
export async function getAgentContext(supabase: SupabaseClient, userId: string) {
  const { data: agent, error } = await supabase
    .from('agents')
    .select('id, brokerage_id, team_id, user_id')
    .eq('user_id', userId)
    .single()

  if (error || !agent) {
    throw new Error(`Agent profile not found for user ${userId}`)
  }

  return {
    agentId: agent.id,
    brokerageId: agent.brokerage_id,
    teamId: agent.team_id,
    userId: agent.user_id,
  }
}

/**
 * Safely resolve agent context, returning null if not found
 * Use when agent profile is optional
 */
export async function tryGetAgentContext(supabase: SupabaseClient, userId: string) {
  try {
    return await getAgentContext(supabase, userId)
  } catch {
    return null
  }
}
