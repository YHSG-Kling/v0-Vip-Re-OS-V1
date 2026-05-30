/**
 * lib/auth/contact-access.ts
 *
 * Canonical "is the caller allowed to read/act on this contact?" gate. Single source of truth used
 * by:
 *   - `app/actions/contact-quick-actions.ts` server actions (write-side enforcement)
 *   - `app/crm/contacts/[contactId]/page.tsx` (read-side defense-in-depth on the consolidated
 *      contact detail page)
 *
 * The contact table's RLS policies already gate cross-brokerage reads — but the consolidated CRM
 * page does the contact fetch with the user-session client, so a future refactor that swaps to the
 * service client (RLS bypass) would silently expose every contact in the DB. This module is the
 * defense-in-depth layer that enforces the same invariant at the app layer regardless of which
 * Supabase client the page uses.
 *
 * Authorization tree (matches the canonical tenant-scoping rule for contacts):
 *   - platform admin / staff      → always allowed
 *   - assigned agent              → contacts.agent_id resolves to caller's agents.id
 *   - same-brokerage staff        → broker / team_lead / TC / compliance officer in the contact's brokerage
 *   - anyone else                 → denied
 */
import "server-only"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { isPlatformStaff } from "@/lib/auth/resolve-user-role"

export interface ContactAccessRow {
  id:               string
  brokerage_id:     string | null
  agent_id:         string | null
  email:            string | null
  mailing_address:  string | null
  mailing_city:     string | null
  mailing_state:    string | null
  mailing_zip:      string | null
}

export type ContactAccessResult =
  | { ok: true;  userId: string; contact: ContactAccessRow }
  | { ok: false; error: string }

const BROKERAGE_ROLES = new Set([
  "broker", "broker_owner", "team_lead", "team_leader",
  "tc", "transaction_coordinator", "compliance_officer", "compliance_manager",
])

/**
 * Server-side gate: confirm the current authenticated user is allowed to act on the given contact.
 * Returns the contact row on success so callers don't have to refetch.
 */
export async function assertCanActOnContact(contactId: string): Promise<ContactAccessResult> {
  const authClient = await createClient()
  const { data: { user } } = await authClient.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const svc = createServiceClient()
  const { data: contact } = await svc.from("contacts")
    .select("id, brokerage_id, agent_id, email, mailing_address, mailing_city, mailing_state, mailing_zip")
    .eq("id", contactId).maybeSingle()
  if (!contact) return { ok: false, error: "Contact not found" }
  const c = contact as ContactAccessRow

  const { data: profile } = await svc.from("users")
    .select("user_type, platform_role, brokerage_id").eq("id", user.id).maybeSingle()

  // Platform admin / staff always allowed
  if (profile?.user_type === "superadmin" || isPlatformStaff(profile?.platform_role)) {
    return { ok: true, userId: user.id, contact: c }
  }

  // Agent — must own the contact (contacts.agent_id is an agents.id; resolve caller's agents.id)
  if (profile?.user_type === "agent") {
    const { data: a } = await svc.from("agents").select("id").eq("user_id", user.id).maybeSingle()
    if (a?.id && c.agent_id === a.id) return { ok: true, userId: user.id, contact: c }
    return { ok: false, error: "Forbidden — not your contact" }
  }

  // Broker / team-lead / TC / compliance in the contact's brokerage
  if (profile?.user_type && BROKERAGE_ROLES.has(profile.user_type) && profile.brokerage_id && profile.brokerage_id === c.brokerage_id) {
    return { ok: true, userId: user.id, contact: c }
  }

  return { ok: false, error: "Forbidden" }
}
