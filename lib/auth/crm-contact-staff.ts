// lib/auth/crm-contact-staff.ts
// ─────────────────────────────────────────────────────────────────────────────
// "MAY THIS SEAT WORK A CONTACT FROM THE BACK OFFICE?" — ASKED ONCE.
//
// WHAT THIS CLOSES. A gate that reads the caller's `users.brokerage_id`, reads
// the target contact's `brokerage_id`, and admits on equality alone has NO role
// test. `users.user_type` can hold `contact`, `vendor` and `lender`, and those
// rows carry a brokerage_id — so every one of them passed such a gate for EVERY
// contact in that brokerage. CLAUDE.md §5: contacts, lenders and vendors see no
// financials and see only their own. Tenancy was being asked to answer a
// question about ROLE, which it cannot.
//
// WHY THE ROSTER IS NOT RETYPED HERE (§6, one vocabulary per function).
// The staff ladder is DEFINED ONCE, in lib/portal/require-contact-access.ts as
// `CONTACT_SCOPE_STAFF_USER_TYPES`. This module CONSUMES it and adds exactly
// three named seats that the back office needs and the portal branch does not.
// Adding a role to the shared roster therefore adds it here automatically; the
// widening is the three lines below and nowhere else.
//
//   THE THREE EXTRAS, argued individually — each is a seat the OLD gate already
//   admitted, so leaving one out would make this "fix" revoke a working surface:
//     · broker_admin        a storable tenant-admin seat (the live users.user_type
//                           CHECK lists it — see scripts/check-vocabularies.ts) and
//                           one of the five names CLAUDE.md §4 calls the tenant
//                           roster. Omitting it revokes a broker admin's own CRM.
//     · isa                 lib/auth/permissions.ts grants it contacts:read AND
//                           contacts:write. Working a contact's channels and inbox
//                           is the entire ISA seat.
//     · compliance_officer  lib/auth/permissions.ts grants it contacts:read, and it
//                           is named by public.is_lead_visible_role() (033/m518/m530).
//
//   REFUSED, and this is the defect being closed: contact, vendor, lender.
//   REFUSED, deliberately: system (not a person), support and superadmin
//   (platform staff reach a tenant through the impersonation seam, §5 — which
//   walks the account and never exceeds it, rather than through a role literal).
//
// WHY THIS IS A SEPARATE MODULE AND NOT AN EXPORT OF THE ACTION FILE.
// Every one of the consumers below is a `"use server"` file, where EVERY export
// is a public HTTP endpoint and must be async (§4). A shared Set or a synchronous
// predicate cannot live in one. This module is pure — no client, no session, no
// I/O — so it is safe to import from server actions, route handlers and guards.
//
// THIS IS NOT AN AUTHORIZATION DECISION ON ITS OWN. It answers "is this seat
// back-office staff?" and nothing else. The caller still has to establish the
// SESSION identity (lib/auth/require-caller.ts) and still has to compare the
// target contact's tenant to the caller's. Role without tenant is as broken as
// tenant without role; this is one half of a two-part gate, never the whole one.
//
// ── INTEGRATOR NOTE (wave 26, lanes SEC2 + SEC3) ─────────────────────────────
// Lane SEC2 landed the same superset as a FILE-LOCAL `isCrmContactStaff` inside
// app/actions/contact-details.ts, because that file is `"use server"` and could
// not export it. When both lanes land, that local copy and this module are two
// spellings of one idea — the §6 defect. Repoint contact-details.ts at this
// module (import `isCrmContactStaff` from here, delete the local definition and
// its local extras array) and leave a tombstone naming
// `lib/auth/crm-contact-staff.ts:isCrmContactStaff`. Membership is identical, so
// the repoint is a deletion, not a behaviour change.

import { CONTACT_SCOPE_STAFF_USER_TYPES } from "@/lib/portal/require-contact-access"

/**
 * The three seats the BACK OFFICE admits beyond the shared portal staff ladder.
 * Every value here must be storable in `users.user_type` — a role literal the
 * live CHECK cannot store reads as "admitted" while matching nobody, forever.
 * Checked by scripts/contact-detail-role-gate-simulator.ts against the generated
 * vocabulary cache rather than against a retyped list.
 */
export const CRM_CONTACT_STAFF_EXTRA_USER_TYPES: ReadonlySet<string> = new Set([
  "broker_admin",
  "isa",
  "compliance_officer",
])

/**
 * The full back-office roster: the shared ladder PLUS the three extras. Derived,
 * never retyped — `[...]` accepts either a Set or a readonly array, so this does
 * not pin the shared roster's container type.
 */
export const CRM_CONTACT_STAFF_USER_TYPES: ReadonlySet<string> = new Set([
  ...[...CONTACT_SCOPE_STAFF_USER_TYPES].map((v) => String(v).toLowerCase()),
  ...CRM_CONTACT_STAFF_EXTRA_USER_TYPES,
])

/**
 * May this `users.user_type` work another person's contact record from a
 * back-office surface (CRM, communications inbox, alerts)?
 *
 * FAILS CLOSED on null/undefined/empty. `lib/auth/require-caller.ts` returns
 * `user_type` EXACTLY AS STORED and does not default it to "agent"; an absent
 * role must never read as a granted one (§4). Zero live rows have a NULL
 * user_type, so refusing an unresolvable role locks nobody out.
 *
 * Case-folded for the same reason lib/auth/role-grants.ts is: users.user_type is
 * CHECK-constrained to lower_snake_case so this is a no-op for it, but callers
 * that pass a legacy `role` value can hold 'Admin' / 'Lender'.
 */
export function isCrmContactStaff(userType: string | null | undefined): boolean {
  const t = String(userType ?? "").trim().toLowerCase()
  if (t.length === 0) return false
  return CRM_CONTACT_STAFF_USER_TYPES.has(t)
}
