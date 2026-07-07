"use server"

// app/actions/self-book-showing.ts — the portal surface for client self-booking
// (lib/kernel/self-book.ts). Caller must BE the contact (portal session email
// match) or brokerage staff acting for them — same trust shape as the portal
// layout gate. Slots are re-verified server-side at booking time.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { loadBookableSlots, bookShowingSlot } from "@/lib/kernel/self-book"
import type { FreeSlot } from "@/lib/providers/calendar/free-slots"

async function authorizeForContact(contactId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const { data: contact } = await svc.from("contacts").select("email, brokerage_id").eq("id", contactId).maybeSingle()
  if (!contact) return { ok: false, error: "Not found" }
  if (user.email && (contact as any).email && user.email.toLowerCase() === (contact as any).email.toLowerCase()) return { ok: true }
  const { data: u } = await svc.from("users").select("brokerage_id, user_type").eq("id", user.id).maybeSingle()
  if ((u as any)?.brokerage_id === (contact as any).brokerage_id || (u as any)?.user_type === "superadmin") return { ok: true }
  return { ok: false, error: "Forbidden" }
}

export async function getBookableSlotsAction(params: { listingId: string; contactId: string }): Promise<
  { ok: true; enabled: boolean; slots: FreeSlot[]; reason?: string } | { ok: false; error: string }
> {
  const auth = await authorizeForContact(params.contactId)
  if (!auth.ok) return auth
  const r = await loadBookableSlots(createServiceClient(), params.listingId)
  return { ok: true, enabled: r.enabled, slots: r.slots, reason: r.reason }
}

export async function bookShowingSlotAction(params: { listingId: string; contactId: string; slotStartIso: string }): Promise<
  { ok: boolean; showingId?: string; error?: string; errorCode?: string }
> {
  const auth = await authorizeForContact(params.contactId)
  if (!auth.ok) return auth
  return bookShowingSlot(createServiceClient(), params)
}
