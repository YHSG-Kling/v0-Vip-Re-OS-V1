/**
 * Agent Identity Resolution Utility
 * 
 * NEVER do: agentId = agentRow?.id ?? user.id
 * ALWAYS do: agentId = await resolveAgentId(supabase, user.id)
 * If null → user has no agent profile yet → handle gracefully
 */

import { SupabaseClient } from '@supabase/supabase-js'

/**
 * Resolves the agent ID from a user ID.
 * Returns null if the user has no agent profile.
 */
export async function resolveAgentId(
  supabase: SupabaseClient,
  userId: string
): Promise<string | null> {
  const { data } = await supabase
    .from('agents')
    .select('id')
    .eq('user_id', userId)
    .maybeSingle()
  return data?.id ?? null
}

/**
 * Resolves agent ID or throws if not found.
 * Use when agent profile is required for the operation.
 */
export async function requireAgentId(
  supabase: SupabaseClient,
  userId: string
): Promise<string> {
  const agentId = await resolveAgentId(supabase, userId)
  if (!agentId) {
    throw new Error('Agent profile not found. Please complete onboarding.')
  }
  return agentId
}
