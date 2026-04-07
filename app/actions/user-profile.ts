"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"

/**
 * Save the calling user's personal email signature to users.email_signature.
 * This overrides the brokerage-level signature in assemble-email.ts.
 */
export async function saveAgentEmailSignature(
  signature: string
): Promise<{ success: boolean; error?: string }> {
  const { userId } = await getAgentContext()
  const supabase = await createClient()

  const { error } = await supabase
    .from("users")
    .update({ email_signature: signature.trim() || null })
    .eq("id", userId)

  if (error) {
    return { success: false, error: error.message }
  }

  return { success: true }
}

/**
 * Load the calling user's personal email signature.
 */
export async function getAgentEmailSignature(): Promise<string | null> {
  const { userId } = await getAgentContext()
  const supabase = await createClient()

  const { data } = await supabase
    .from("users")
    .select("email_signature")
    .eq("id", userId)
    .maybeSingle()

  return data?.email_signature ?? null
}
