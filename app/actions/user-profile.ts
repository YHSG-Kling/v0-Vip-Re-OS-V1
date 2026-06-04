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

/**
 * Wave 33 — personal website actions. Distinct from brokerage.website
 * (broker's site) — this is the agent's own real-estate pro site that
 * lives independently of the brokerage. Used as the canonical embed/CSP
 * origin for /embed/blog when set, and surfaced as the byline link on
 * the hosted /blog/[slug] landing page.
 */
export interface UserProfileRow {
  personal_website_url: string | null
}

export async function getMyProfile(): Promise<{ success: boolean; error?: string; profile?: UserProfileRow }> {
  const { userId, isAuthenticated } = await getAgentContext()
  if (!isAuthenticated || !userId) return { success: false, error: "Unauthorized" }
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("users")
    .select("personal_website_url")
    .eq("id", userId)
    .maybeSingle()
  if (error) return { success: false, error: error.message }
  return { success: true, profile: (data as UserProfileRow | null) ?? { personal_website_url: null } }
}

const URL_RE = /^https?:\/\/\S+$/

export async function updateMyProfile(input: {
  personalWebsiteUrl?: string | null
}): Promise<{ success: boolean; error?: string }> {
  const { userId, isAuthenticated } = await getAgentContext()
  if (!isAuthenticated || !userId) return { success: false, error: "Unauthorized" }

  // Normalize empty-string to null so the DB CHECK accepts "clear".
  const cleaned: string | null =
    input.personalWebsiteUrl == null ? null
    : input.personalWebsiteUrl.trim() === "" ? null
    : input.personalWebsiteUrl.trim()
  if (cleaned !== null) {
    if (cleaned.length > 500) return { success: false, error: "Website URL too long (max 500 chars)" }
    if (!URL_RE.test(cleaned)) return { success: false, error: "Website must start with http:// or https://" }
  }

  const supabase = await createClient()
  const { error } = await supabase.from("users")
    .update({ personal_website_url: cleaned })
    .eq("id", userId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}
