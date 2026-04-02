/**
 * Canonical Contact Identity Resolver
 * 
 * Enforces contacts.id as the primary key across all operations.
 * contacts.contact_id is a legacy alias that should be mapped to contacts.id.
 * 
 * Kernel OS Architecture: contacts.id is the canonical identifier for all ownership-scoped operations.
 */

import { createClient } from "@/lib/supabase/client"

/**
 * Resolve a contact identifier to the canonical contacts.id
 * Handles both contacts.id (already canonical) and contacts.contact_id (legacy)
 */
export async function resolveContactId(contactIdentifier: string | null | undefined): Promise<string | null> {
  if (!contactIdentifier) return null

  const supabase = await createClient()

  // Try direct ID first (most common case)
  const { data: directMatch } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactIdentifier)
    .maybeSingle()

  if (directMatch) {
    return directMatch.id as string
  }

  // Fallback: lookup by legacy contact_id field
  const { data: legacyMatch } = await supabase
    .from("contacts")
    .select("id")
    .eq("contact_id", contactIdentifier)
    .maybeSingle()

  if (legacyMatch) {
    return legacyMatch.id as string
  }

  // Not found
  return null
}

/**
 * Get the canonical contacts.id for a given user in a brokerage context
 * Returns the first contact record associated with the user, if any
 */
export async function getContactIdForUser(
  userId: string,
  brokerageId: string
): Promise<string | null> {
  const supabase = await createClient()

  const { data } = await supabase
    .from("contacts")
    .select("id")
    .eq("user_id", userId)
    .eq("brokerage_id", brokerageId)
    .limit(1)
    .maybeSingle()

  return (data?.id as string) || null
}

/**
 * Validate that a contact exists and belongs to a brokerage
 * Returns the canonical contacts.id if valid, null otherwise
 */
export async function validateContactOwnership(
  contactId: string,
  brokerageId: string
): Promise<string | null> {
  const supabase = await createClient()

  const { data } = await supabase
    .from("contacts")
    .select("id, brokerage_id")
    .eq("id", contactId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (data && (data.brokerage_id === brokerageId)) {
    return data.id as string
  }

  return null
}
