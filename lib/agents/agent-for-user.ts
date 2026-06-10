/**
 * lib/agents/agent-for-user.ts
 *
 * ID-space bridge: users.id → agents.id. Task assignment, listings, contacts
 * and transactions key on agents.id (FK-enforced), while auth/webhook payloads
 * carry users.id. Every flow that receives a user id and writes an agent-keyed
 * row MUST translate through here — writing a users.id into an agents.id column
 * either FK-fails or (worse, pre-FK) silently orphans the row from the agent's
 * RLS view.
 */
import type { SupabaseClient } from "@supabase/supabase-js"

export async function agentIdForUser(
  supabase: SupabaseClient,
  userId: string | null | undefined
): Promise<string | null> {
  if (!userId) return null
  const { data } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle()
  return (data as { id: string } | null)?.id ?? null
}
