// lib/portal/require-contact-access.ts
// Shared portal authorization gate: verifies the authenticated user may access a
// given contact's portal data — either the contact themselves (by linked user id
// or matching email) or staff in the same brokerage. Used by portal server
// actions AND the portal API routes so neither can be called for an arbitrary
// contactId. Not a "use server" module so it can be imported by route handlers.
//
// TENANT SCOPE IS RESOLVED FROM THE CONTACT ROW, never from the caller: we read
// `contacts.brokerage_id` and compare it to the caller's own `users.brokerage_id`.
// That is the mechanical form of "can only get their contacts".
//
// It also returns the caller's `user_type`, because several callers need to make a
// SECOND, stronger decision than "may you touch this contact" — e.g. overriding a
// buyer's financial gate needs admin/broker, and a session alone is not authority for
// that. Handing back the already-fetched user_type keeps those callers from doing
// their own second `users` lookup (and from reaching for the retired `role` column).

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export type ContactAccess =
  | {
      ok: true
      userId: string
      brokerageId: string
      isContactSelf: boolean
      /** users.user_type of the caller. null when the caller has no `users` row. */
      userType: string | null
    }
  | { ok: false; error: "Unauthorized" | "Contact not found" | "Forbidden" | "Access check failed" }

export async function requireContactAccess(contactId: string): Promise<ContactAccess> {
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()

  // Both reads DESTRUCTURE `error`. supabase-js RESOLVES a refused/failed query
  // rather than throwing, so `const { data }` alone reports a refusal as an empty
  // result — indistinguishable from "no such row". Distinguishing them matters:
  // a refused read must fail closed as an ERROR, not be reported as "Contact not
  // found", which reads as a clean negative and invites a caller to treat it as one.
  const [{ data: contact, error: contactErr }, { data: callerRow, error: callerErr }] =
    await Promise.all([
      svc.from("contacts").select("brokerage_id, contact_user_id, email").eq("id", contactId).maybeSingle(),
      svc.from("users").select("brokerage_id, user_type").eq("id", authUser.id).maybeSingle(),
    ])

  if (contactErr || callerErr) return { ok: false, error: "Access check failed" }
  if (!contact || !contact.brokerage_id) return { ok: false, error: "Contact not found" }

  const callerType = ((callerRow as { user_type?: string | null } | null)?.user_type) ?? null

  const isContactSelf =
    contact.contact_user_id === authUser.id ||
    !!(contact.email && authUser.email && contact.email.toLowerCase() === authUser.email.toLowerCase())

  if (isContactSelf) {
    return {
      ok: true,
      userId: authUser.id,
      brokerageId: contact.brokerage_id,
      isContactSelf: true,
      userType: callerType,
    }
  }

  if (
    (callerRow as { brokerage_id?: string | null } | null)?.brokerage_id === contact.brokerage_id &&
    ["agent", "team_lead", "tc", "admin", "broker", "superadmin"].includes(callerType ?? "")
  ) {
    return {
      ok: true,
      userId: authUser.id,
      brokerageId: contact.brokerage_id,
      isContactSelf: false,
      userType: callerType,
    }
  }

  return { ok: false, error: "Forbidden" }
}
