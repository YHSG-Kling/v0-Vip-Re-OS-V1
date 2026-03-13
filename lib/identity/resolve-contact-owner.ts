import { SupabaseClient } from "@supabase/supabase-js"

/**
 * Pure helper function to extract the owner user ID from a contact object.
 * The contact.agent_id points directly to users.id in the current schema.
 */
export function resolveContactOwnerUserId(contact: {
  agent_id: string | null
}): string | null {
  return contact.agent_id
}

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
