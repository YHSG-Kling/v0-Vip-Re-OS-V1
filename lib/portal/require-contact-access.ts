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

/**
 * THE ONE ROSTER FOR "MAY THIS SEAT TOUCH A CONTACT RECORD AT ALL?"
 *
 * It was an array inlined in the staff branch below, consulted once. EXPORTED as
 * of wave 26 (lane SEC2) because a SECOND gate needed the same question answered
 * — `app/actions/contact-details.ts:authorizeContactAccess`, which gates seven
 * contact-PII server actions and until now checked only that the caller's
 * `users.brokerage_id` matched the contact's, with NO role test at all. Live on
 * the production project that admitted 4 `contact`, 2 `vendor` and 2 `lender`
 * seats to ANY contact in their brokerage, including `select("*")` on the
 * contact row, their credit accounts, transactions and documents.
 *
 * It is EXPORTED rather than retyped there because CLAUDE.md §6 forbids a second
 * spelling of one idea: two rosters for "who is contact-facing staff" would
 * disagree the first time a seat is added to one of them, and the disagreement
 * would be a silent permission change, not a compile error. That consumer SPREADS
 * this set and adds three documented extras of its own (broker_admin, isa,
 * compliance_officer) — the lib/vendors/vendor-scope.ts pattern that
 * lib/auth/resolve-user-role.ts:213 blesses by name. There is still ONE roster;
 * the widening is visible in one line at the site that needs it.
 *
 * MEMBERSHIP HERE IS UNCHANGED by that export — same six values, same order, so
 * the portal branch below behaves byte-identically and no portal surface is
 * widened by a change made for the CRM. The only difference is that the
 * comparison is now case-folded, which is a no-op for real rows
 * (users_user_type_check admits only lower_snake_case) and strictly safer for
 * the legacy free-form values that reach these predicates elsewhere.
 *
 * NOTE, NOT FIXED HERE (lane SEC2, reported not acted on): `broker_admin` is now
 * a STORABLE seat — the live CHECK cache (scripts/check-vocabularies.ts,
 * users.user_type, generated 2026-09-01) lists it, so m530 is applied — and this
 * six-value ladder omits it. A broker admin is therefore refused the PORTAL
 * staff branch today. Adding it is a widening of a portal gate and belongs to
 * whoever owns this file, not to a lane sent here for the CRM.
 *
 * NOT DERIVED from TENANT_ADMIN_USER_TYPES: that roster is the ADMIN class
 * (broker, broker_admin, broker_owner, team_lead, admin) and does not contain
 * `agent` or `tc` — the two seats that do almost all of the contact work. A gate
 * built on it would lock every agent out of /crm, which is the "gate narrower
 * than the surface it protects" failure this file's own header names.
 *
 * SCOPE LADDER, kept as it was: 'superadmin' is absent because it is dead as a
 * users.user_type (0 live rows — the platform's one superadmin is
 * user_type='admin', platform_role='superadmin', and is admitted by 'admin');
 * 'broker_owner' is present as a storable seat that owns the brokerage.
 */
export const CONTACT_SCOPE_STAFF_USER_TYPES: ReadonlySet<string> = new Set([
  "agent",
  "team_lead",
  "tc",
  "admin",
  "broker",
  "broker_owner",
])

/**
 * Fail-closed membership test for {@link CONTACT_SCOPE_STAFF_USER_TYPES}.
 *
 * A null / undefined / unknown `user_type` answers NO. That is the point: a seat
 * whose role could not be resolved must never be graded as a granted one
 * (CLAUDE.md §4 — "nobody checked" must not render as "checked and fine"), and
 * an unrecognised value is exactly the shape a refused `users` read leaves
 * behind.
 */
export function isContactScopeStaff(userType: string | null | undefined): boolean {
  return CONTACT_SCOPE_STAFF_USER_TYPES.has(String(userType ?? "").toLowerCase())
}

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

  // ── WHO COUNTS AS "THE CONTACT THEMSELVES" ──────────────────────────────────
  //
  // This gate recognised a buyer by TWO facts. The portal LAYOUT
  // (app/portal/[contactId]/layout.tsx) recognises them by more, and its extra
  // rule is the ordinary case rather than an edge: an ACCEPTED, UNEXPIRED
  // `portal_contact_invites` row matching the caller's address. An agent invites
  // someone at their work address, or the contact row predates the invite, and
  // the two addresses differ.
  //
  // Until now that buyer PASSED the layout, saw their portal, and was then
  // refused by every action gated on this helper — they could read the page and
  // not use it. That regression arrived the moment wave 14 correctly gated
  // requestOfferHelp: gating against a narrower rule than the surface already
  // admits does not tighten security, it breaks the feature for real users while
  // leaving the ungated siblings wide open.
  //
  // A gate must never be WIDER than the surface it protects, and never NARROWER
  // than the surface that already admits the caller. This is the narrower case.
  // The invite check below is deliberately a strict NARROWING of the layout's
  // rule — same table, same contact, same address, and it additionally requires
  // the row to be BOTH accepted and unexpired.
  let isContactSelf =
    contact.contact_user_id === authUser.id ||
    !!(contact.email && authUser.email && contact.email.toLowerCase() === authUser.email.toLowerCase())

  if (!isContactSelf && authUser.email) {
    // `error` is destructured, unlike the layout's copy of this read: supabase-js
    // RESOLVES a refused query, so `const { data }` there reports a denied read
    // as "no invite" and quietly denies a legitimate buyer. Here a refused read
    // fails CLOSED and says so, rather than being laundered into "Forbidden" —
    // which reads as a decision when it was actually an outage.
    const { data: invite, error: inviteErr } = await svc
      .from("portal_contact_invites")
      .select("status, expires_at")
      .eq("contact_id", contactId)
      .eq("email", authUser.email)
      .maybeSingle()

    if (inviteErr) return { ok: false, error: "Access check failed" }

    const expiresAt = (invite as { expires_at?: string | null } | null)?.expires_at
    const unexpired = !!expiresAt && new Date(expiresAt).getTime() > Date.now()
    if ((invite as { status?: string | null } | null)?.status === "accepted" && unexpired) {
      isContactSelf = true
    }
  }

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
    // SCOPE LADDER — the roster moved twelve lines up and is now EXPORTED, because
    // app/actions/contact-details.ts:authorizeContactAccess needs the same answer
    // and §6 allows exactly one spelling of it. Same six values; see the const's
    // header for why 'superadmin' is absent and 'broker_owner' present.
    isContactScopeStaff(callerType)
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
