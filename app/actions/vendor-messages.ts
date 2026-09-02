"use server"

// Vendor messaging — backend for the unified communication spine.
// vendor_messages (migration m086) is a dedicated lane that the unified inbox
// (lib/kernel/communications.ts loadUniversalInbox) aggregates at read time.
//
// Scope (this phase): vendor → contact messaging, sent BY the vendor. The
// vendor must own the vendor_id (user_role_assignments) and there must be an
// active contact_vendors relationship. We validate authorization in the app
// layer (not relying on RLS alone, since RLS only constrains the brokerage_id
// column, not whether the referenced vendor/contact belong together). RLS is
// the backstop. Contact-side replies and the vendor↔agent lane are added with
// their UIs in a follow-up.

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isValidUUID } from "@/lib/validations"
import { revalidatePath } from "next/cache"

async function callerOwnsVendor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  vendorId: string,
): Promise<boolean> {
  // EXISTENCE, over rows. (user_id, vendor_id) is NOT a unique key — the table is
  // UNIQUE on (user_id, role) — so a caller holding two grants against the same
  // vendor produced two rows. `.limit(1)` kept that from erroring, but only by
  // picking one row at random to prove a question that is about the SET; and the
  // discarded `error` meant a REFUSED read was indistinguishable from "does not
  // own this vendor". Counting rows answers the real question, and the refusal is
  // now reported rather than quietly denied.
  const { data, error } = await supabase
    .from("user_role_assignments")
    .select("id")
    .eq("user_id", userId)
    .eq("vendor_id", vendorId)
  if (error) {
    console.error("[vendor-messages] vendor ownership read failed:", error.message)
    return false
  }
  return (data?.length ?? 0) > 0
}

export interface SendVendorMessageInput {
  vendorId: string
  contactId: string
  body: string
}

export async function sendVendorMessage(
  input: SendVendorMessageInput,
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (!isValidUUID(input.vendorId) || !isValidUUID(input.contactId)) {
    return { success: false, error: "Invalid vendor or contact id" }
  }
  if (!input.body?.trim()) {
    return { success: false, error: "Message body is required" }
  }

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Not authenticated" }
  }

  const supabase = await createClient()

  // Only the vendor sends through this path, and only for a vendor they own.
  if (!(await callerOwnsVendor(supabase, ctx.userId, input.vendorId))) {
    return { success: false, error: "Not permitted to send for this vendor" }
  }

  // The vendor must belong to the caller's brokerage — prevents stamping a
  // message with a brokerage_id that doesn't own the vendor.
  const { data: vendor } = await supabase
    .from("vendors")
    .select("id")
    .eq("id", input.vendorId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  if (!vendor) {
    return { success: false, error: "Vendor does not belong to this brokerage" }
  }

  // Relationship gate: an active contact_vendors link must exist so a vendor
  // cannot message arbitrary contacts. status is nullable; treat NULL as active,
  // only 'revoked' blocks (avoids the NULL <> 'revoked' = NULL pitfall).
  const { data: link } = await supabase
    .from("contact_vendors")
    .select("id, status")
    .eq("vendor_id", input.vendorId)
    .eq("contact_id", input.contactId)
    .eq("brokerage_id", ctx.brokerageId)
    .limit(1)
    .maybeSingle()
  if (!link || link.status === "revoked") {
    return { success: false, error: "No active vendor↔contact relationship" }
  }

  const { data: msg, error } = await supabase
    .from("vendor_messages")
    .insert({
      brokerage_id: ctx.brokerageId,
      vendor_id: input.vendorId,
      counterparty_type: "contact",
      counterparty_id: input.contactId,
      sender_type: "vendor",
      contact_vendor_id: link.id,
      channel: "vendor",
      body: input.body.trim(),
      read: false,
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !msg) {
    return { success: false, error: error?.message ?? "Failed to send message" }
  }

  revalidatePath("/dashboard/communications/inbox")
  return { success: true, messageId: msg.id }
}

export interface VendorMessageRow {
  id: string
  vendor_id: string
  counterparty_type: string
  counterparty_id: string
  sender_type: string
  body: string
  read: boolean
  /**
   * WHEN the reader flipped `read` (markVendorMessagesRead below stamps it
   * together with read=true). `read` alone says "seen"; this says when — the
   * receipt a sender actually wants. NULL while unread or for rows read before
   * the column was stamped.
   */
  read_at: string | null
  /** The lane discriminator the universal inbox keys on. sendVendorMessage writes "vendor". */
  channel: string | null
  /** contact_vendors.id — the relationship (role/status) this thread rides on. */
  contact_vendor_id: string | null
  created_at: string
}

// Reads a vendor↔contact thread. RLS scopes rows to the owning vendor or the
// brokerage's staff; we additionally require the caller to be authenticated.
export async function getVendorThread(input: {
  vendorId: string
  contactId: string
  limit?: number
}): Promise<{ success: boolean; messages?: VendorMessageRow[]; error?: string }> {
  if (!isValidUUID(input.vendorId) || !isValidUUID(input.contactId)) {
    return { success: false, error: "Invalid ids" }
  }
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("vendor_messages")
    .select("id, vendor_id, counterparty_type, counterparty_id, sender_type, body, read, read_at, channel, contact_vendor_id, created_at")
    .eq("vendor_id", input.vendorId)
    .eq("counterparty_type", "contact")
    .eq("counterparty_id", input.contactId)
    .order("created_at", { ascending: true })
    .limit(input.limit ?? 100)

  if (error) return { success: false, error: error.message }
  return { success: true, messages: (data ?? []) as VendorMessageRow[] }
}

// Marks the contact's messages read on the vendor's behalf when the vendor
// opens the thread. Only the owning vendor may do this; staff observing a
// thread must not flip the contact's unread state.
export async function markVendorMessagesRead(input: {
  vendorId: string
  contactId: string
}): Promise<{ success: boolean; error?: string }> {
  if (!isValidUUID(input.vendorId) || !isValidUUID(input.contactId)) {
    return { success: false, error: "Invalid ids" }
  }
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }

  const supabase = await createClient()
  if (!(await callerOwnsVendor(supabase, ctx.userId, input.vendorId))) {
    return { success: false, error: "Not permitted" }
  }

  const { error } = await supabase
    .from("vendor_messages")
    .update({ read: true, read_at: new Date().toISOString() })
    .eq("vendor_id", input.vendorId)
    .eq("counterparty_type", "contact")
    .eq("counterparty_id", input.contactId)
    .eq("sender_type", "contact")
    .eq("read", false)

  if (error) return { success: false, error: error.message }
  return { success: true }
}
