// lib/portal/require-contact-access.ts
// Shared portal authorization gate: verifies the authenticated user may access a
// given contact's portal data — either the contact themselves (by linked user id
// or matching email) or staff in the same brokerage. Used by portal server
// actions AND the portal API routes so neither can be called for an arbitrary
// contactId. Not a "use server" module so it can be imported by route handlers.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export type ContactAccess =
  | { ok: true; userId: string; brokerageId: string; isContactSelf: boolean }
  | { ok: false; error: "Unauthorized" | "Contact not found" | "Forbidden" }

export async function requireContactAccess(contactId: string): Promise<ContactAccess> {
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: contact } = await svc
    .from("contacts")
    .select("brokerage_id, contact_user_id, email")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact || !contact.brokerage_id) return { ok: false, error: "Contact not found" }

  const isContactSelf =
    contact.contact_user_id === authUser.id ||
    !!(contact.email && authUser.email && contact.email.toLowerCase() === authUser.email.toLowerCase())

  if (isContactSelf) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: true }
  }

  const { data: callerRow } = await svc
    .from("users").select("brokerage_id, user_type").eq("id", authUser.id).maybeSingle()
  if (
    callerRow?.brokerage_id === contact.brokerage_id &&
    ["agent", "team_lead", "tc", "admin", "broker", "superadmin"].includes(((callerRow as any)?.user_type) ?? "")
  ) {
    return { ok: true, userId: authUser.id, brokerageId: contact.brokerage_id, isContactSelf: false }
  }

  return { ok: false, error: "Forbidden" }
}
