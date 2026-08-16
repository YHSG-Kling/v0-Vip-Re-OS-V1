/**
 * Assignment-aware access gate for vendor / lender USERS.
 *
 * A lender is a vendor-user role (user_type 'lender' | 'vendor'), NOT a contact.
 * The brokerage owns the contact; a lender only gets to see / act on a contact
 * when the brokerage has ASSIGNED them to it — the owner's rule: "if the lender
 * is assigned to the contact they can see the transaction, etc."
 *
 * The canonical assignment model (mirrors app/actions/vendor-contact-access.ts):
 *   1. user_role_assignments.vendor_id      resolves a logged-in user → vendors row
 *   2. vendor_contact_assignments           the (vendor_id, contact_id) grant with
 *                                           scope + status + per-assignment expiry
 *   3. vendors.access_expires_at            the whole-vendor time box (engagement
 *                                           ended = every assignment goes dark)
 *
 * This helper is PURE of routing — it takes an already-constructed service client
 * so it works from server actions, voice dispatchers, and the buyer-execution
 * engine alike. It intentionally reads through the service client (RLS-independent)
 * and enforces the business gate itself: defense in depth, one code path.
 */
import type { SupabaseClient } from "@supabase/supabase-js"
import { readRoleGrants, selectVendorId } from "@/lib/auth/role-grants"

export type VendorAccessScope = "pii_basic" | "pii_full" | "transaction_docs" | "financial"

export interface VendorAssignmentCheck {
  ok: boolean
  /** The resolved vendors.id for the calling user (present on success). */
  vendorId?: string
  /** The granting assignment's scope (present on success). */
  scope?: string
  /** Human-readable reason on failure — safe to speak/return to the caller. */
  error?: string
}

/**
 * Assert that a vendor/lender USER is actively assigned to a specific contact.
 *
 * Fails closed with a spoken-safe reason when:
 *   - the user resolves to no vendor row (not a vendor account)
 *   - the whole vendor is time-boxed out (vendors.access_expires_at in the past)
 *   - there is no ACTIVE, unexpired vendor_contact_assignment for (vendor, contact)
 *   - requiredScopes is set and no active assignment grants one of them
 *
 * @param svc     a service-role Supabase client (RLS-independent)
 * @param params  vendorUserId = the caller's users.id; contactId = target contact;
 *                requiredScopes = if set, at least one active assignment must carry
 *                one of these scopes (e.g. ['financial'] for financial confirmation).
 */
export async function assertVendorAssignedToContact(
  svc: SupabaseClient,
  params: { vendorUserId: string; contactId: string; requiredScopes?: VendorAccessScope[] },
): Promise<VendorAssignmentCheck> {
  const { vendorUserId, contactId, requiredScopes } = params

  // 1. Resolve caller → vendor row (same lookup the scoped vendor portal uses).
  //
  // "Which vendor is this user?" — asked of a table that is UNIQUE on
  // (user_id, role), NOT on user_id. `.not("vendor_id","is",null).maybeSingle()`
  // narrowed to the vendor-bearing grants but not to ONE of them, so a user
  // holding two vendor-bearing grants under different roles made this an ERROR
  // that supabase-js resolves — and this gate, reading `data` alone, would refuse
  // a genuinely assigned vendor with "Not a vendor account". This is an access
  // gate: a refused read must never be spoken as a settled "no".
  const grantsResult = await readRoleGrants(svc, vendorUserId)
  if (!grantsResult.ok) {
    console.error("[vendor/assignment-access] role grant read failed:", grantsResult.error)
    return { ok: false, error: "Could not verify your vendor account just now — please try again." }
  }
  const { vendorId, ambiguous } = selectVendorId(grantsResult.grants)
  if (ambiguous) {
    return { ok: false, error: "Your account is linked to more than one vendor — ask the brokerage to correct it." }
  }
  if (!vendorId) return { ok: false, error: "Not a vendor account — no vendor assignment on file." }

  // 2. Whole-vendor time box (l49-s01): engagement ended = all access dark at once.
  const { data: vendor } = await svc
    .from("vendors")
    .select("access_expires_at")
    .eq("id", vendorId)
    .maybeSingle()
  if (!vendor) return { ok: false, error: "Vendor record not found." }
  if (vendor.access_expires_at && new Date(vendor.access_expires_at as string).getTime() < Date.now()) {
    return { ok: false, error: "Vendor access has expired — ask the brokerage to renew it." }
  }

  // 3. Active, unexpired contact assignment.
  const { data: rows } = await svc
    .from("vendor_contact_assignments")
    .select("scope, expires_at")
    .eq("vendor_id", vendorId)
    .eq("contact_id", contactId)
    .eq("status", "active")
  const now = Date.now()
  const active = (rows ?? []).filter(
    (r) => !r.expires_at || new Date(r.expires_at as string).getTime() > now,
  )
  if (active.length === 0) {
    return { ok: false, error: "You are not assigned to this contact." }
  }

  // 4. Scope gate (least privilege — e.g. financial confirmation needs 'financial').
  if (requiredScopes && requiredScopes.length) {
    const granted = active.find((r) => requiredScopes.includes(r.scope as VendorAccessScope))
    if (!granted) {
      return {
        ok: false,
        error: `Your assignment does not grant the required scope (${requiredScopes.join(" / ")}).`,
      }
    }
    return { ok: true, vendorId, scope: granted.scope as string }
  }

  return { ok: true, vendorId, scope: active[0].scope as string }
}
