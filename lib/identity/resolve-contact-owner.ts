import { SupabaseClient } from "@supabase/supabase-js"

// resolveContactOwnerUserId — DELETED (orphan burn-down w44).
//
// It was not unwired-but-correct, it was WRONG: it returned `contact.agent_id`
// under a name and docstring that both claimed the value is a users.id. It is an
// agents.id. m366 re-pointed the last stragglers so the plain spelling `agent_id`
// means agents(id) everywhere, lib/identity/get-agent-context.ts records the same
// ("contacts.agent_id → agents.id, FK corrected in migration 114"), and
// scripts/agent-id-class-guard.ts hard-codes `contact.agent_id` in its
// AGENT_ID_EXPR list of expressions that ARE an agents.id. A one-line function
// whose only job is to relabel one id class as the other is a trap for the next
// caller, not a capability.
//
// The owner of a contact is reached by resolveContactOwnerAgent below (agents row
// + user details) or by lib/identity/get-agent-context.ts:getAgentContext for the
// CALLER's own identity. Neither needs a "contact → users.id" shortcut, because
// there is no such column.

/**
 * Resolve the full contact owner agent record.
 * 
 * Implementation:
 * 1. Query agents table where user_id = ownerUserId
 * 2. Query users table where id = ownerUserId
 * 3. Build full_name from first_name + last_name
 * 4. Return null if agent not found or either query fails
 * 
 * @param supabase - Supabase client
 * @param ownerUserId - The user ID of the owner (from contact.agent_id)
 * @returns Agent record with full user details, or null if not found
 */
export async function resolveContactOwnerAgent(
  supabase: SupabaseClient,
  ownerUserId: string
): Promise<{
  id: string
  user_id: string
  brokerage_id: string
  full_name: string | null
  email: string | null
  phone_mobile: string | null
  profile_image_url: string | null
} | null> {
  try {
    // Query agent by user_id
    const { data: agent, error: agentError } = await supabase
      .from("agents")
      .select("id, user_id, brokerage_id, phone_mobile, profile_image_url")
      .eq("user_id", ownerUserId)
      .single()

    if (agentError || !agent) {
      return null
    }

    // Query user by id
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("first_name, last_name, email")
      .eq("id", ownerUserId)
      .single()

    if (userError || !user) {
      return null
    }

    // Build full_name from first_name + last_name
    const fullName = [user.first_name, user.last_name]
      .filter(Boolean)
      .join(" ") || null

    return {
      id: agent.id,
      user_id: agent.user_id,
      brokerage_id: agent.brokerage_id,
      full_name: fullName,
      email: user.email || null,
      phone_mobile: agent.phone_mobile || null,
      profile_image_url: agent.profile_image_url || null,
    }
  } catch (error) {
    console.error("[resolveContactOwnerAgent] Error:", error)
    return null
  }
}
