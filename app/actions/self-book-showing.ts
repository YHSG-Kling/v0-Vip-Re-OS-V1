"use server"

// app/actions/self-book-showing.ts — the portal surface for client self-booking
// (lib/kernel/self-book.ts). Caller must BE the contact (portal session email
// match) or brokerage staff acting for them — same trust shape as the portal
// layout gate. Slots are re-verified server-side at booking time.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"
import { loadBookableSlots, bookShowingSlot } from "@/lib/kernel/self-book"
import { guardShowingFinancialGate } from "@/lib/buyer-execution/showing-financial-policy"
import type { FreeSlot } from "@/lib/providers/calendar/free-slots"

/**
 * Authorizes the caller AND hands back the two ids the financial gate needs, so
 * neither is re-derived (or worse, guessed) downstream: the CONTACT's brokerage
 * — the tenant whose policy governs this booking — and the caller's auth id.
 */
async function authorizeForContact(contactId: string): Promise<
  { ok: true; brokerageId: string | null; authUserId: string } | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const svc = createServiceClient()
  const { data: contact, error: contactError } = await svc.from("contacts").select("email, brokerage_id").eq("id", contactId).maybeSingle()
  if (contactError) return { ok: false, error: contactError.message }
  if (!contact) return { ok: false, error: "Not found" }
  const brokerageId = ((contact as any).brokerage_id ?? null) as string | null
  if (user.email && (contact as any).email && user.email.toLowerCase() === (contact as any).email.toLowerCase()) {
    return { ok: true, brokerageId, authUserId: user.id }
  }
  // BOTH IDENTITY COLUMNS. This read used to select `user_type` alone and test
  // `user_type === "superadmin"`, which is the last surviving instance of the
  // single-column gate documented in lib/auth/resolve-user-role.ts: the ONE live
  // superadmin on this database is (user_type='admin', platform_role='superadmin'),
  // so the literal never matched them, and 'marketing' is not a legal user_type at
  // all. The defect here was FAIL-CLOSED — the tenant test beside it still held, so
  // nothing leaked; the platform's own administrator was simply refused. The gate
  // now asks the same question the RLS helper public.is_platform_staff() and the
  // app-side isPlatformStaffIdentity() ask, from the same two columns.
  const { data: u, error: userError } = await svc
    .from("users").select("brokerage_id, user_type, platform_role").eq("id", user.id).maybeSingle()
  if (userError) return { ok: false, error: userError.message }
  const sameTenant =
    (u as any)?.brokerage_id != null && (u as any).brokerage_id === (contact as any).brokerage_id
  if (sameTenant || isPlatformStaffIdentity((u as any)?.user_type, (u as any)?.platform_role)) {
    return { ok: true, brokerageId, authUserId: user.id }
  }
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

  // ── Buyer financial gate — TENANT SETTING (m377) ─────────────────────────
  // Self-booking is the path where a buyer schedules a showing with no human in
  // the loop at all, so it is precisely the one a brokerage that requires
  // financial verification means to cover. Off by default: unless this brokerage
  // opted in, this returns without running the gate and the flow is unchanged.
  const finGate = await guardShowingFinancialGate({
    contactId:   params.contactId,
    brokerageId: auth.brokerageId,
    userId:      auth.authUserId,
  })
  if (finGate.blocked) {
    return { ok: false, error: finGate.reason, errorCode: finGate.errorCode }
  }

  return bookShowingSlot(createServiceClient(), params)
}
