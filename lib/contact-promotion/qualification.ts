/**
 * lib/contact-promotion/qualification.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * WHO MAY BE QUALIFIED — one vocabulary, one rule, one place (CLAUDE.md §6).
 *
 * OWNER RULING, verbatim:
 *
 *   "invitation from a lead converting to a contact makes sense for status
 *    qualified but any other new contacts coming in from forms, lead magnets,
 *    other real estate sites, etc. haven't been qualified yet."
 *
 * So `contacts.status = 'qualified'` is EARNED, and exactly one thing earns it: a
 * LEAD CONVERSION standing behind the contact. It is stamped in exactly one place,
 * lib/portal/portal-invite-core.ts:77 `stampQualifiedIfLeadConverted`, which
 * derives the answer from the RECORD — `leads.contact_id`, THE conversion marker
 * (./conversion-finality.ts:50) — and never from a caller-supplied flag (§4).
 *
 * ── WHY A SHARED MODULE AND NOT THREE COPIES OF A STRING ────────────────────
 *
 * Three separate CREATE paths accept a caller-supplied status and write it
 * straight to `contacts.status`:
 *
 *   lib/kernel/crm.ts:326                           direct intake + CRM manual add
 *   lib/kernel/crm.ts:285                           the same path's dedup-MERGE branch
 *   lib/services/contact-management.service.ts:143  the CRM manual-add service
 *   lib/application/lead-application-service.ts:448 the CSV/bulk import row
 *
 * Every one of them is reachable from a `"use server"` export, and in this repo a
 * `"use server"` export is a PUBLIC HTTP ENDPOINT (§4) — so removing "Qualified"
 * from a dropdown does not close the door, it only hides the handle. The rule has
 * to live on the server side of all three, and three inlined copies of the literal
 * `"qualified"` is precisely the §6 defect that has already bitten timeline (six
 * spellings), video status (twenty-two) and vendor category.
 *
 * ── WHAT THE DATABASE DOES AND DOES NOT ENFORCE ─────────────────────────────
 *
 * `contacts.status` carries NO CHECK constraint on hrvaqgvukzxfskkcrwbt (verified
 * live 2026-08-29: the ten CHECKs on `contacts` cover ai_autopilot_level,
 * buyer_stage, contact_persona, contact_type, lead_temperature, lender_status,
 * lifetime_segment, phone_status, referral_potential and timeline — `status` is
 * not among them, and it is correspondingly absent from the generated
 * scripts/check-vocabularies.ts `contacts` block). The column DEFAULT is `'new'`.
 *
 * That is the whole reason this file has to exist. Postgres will accept ANY string
 * here, so nothing downstream refuses a forged 'qualified' — it simply becomes
 * true. No lane may collapse the spellings below into one without an owner ruling
 * naming the survivor, so they are enumerated and REPORTED rather than merged.
 */

/** The one earned status. Never spell it inline. */
export const QUALIFIED_CONTACT_STATUS = "qualified"

/**
 * `contacts.status` values that mean "nothing has qualified this contact yet" —
 * the set a conversion-invite may upgrade FROM. Every member is a value some live
 * path in this tree actually writes or offers today, measured on stripped source
 * (§2), with its writer named so a future lane can audit the membership rather
 * than trust it:
 *
 *   'new'       the column DEFAULT, plus app/actions/seller-open-house.ts:779,
 *               app/api/open-house/attend/route.ts:102, lib/kernel/crm.ts:326,
 *               lib/application/lead-application-service.ts:448 (import fallback)
 *   'active'    lib/contact-promotion/contact-creator.ts:320 (the conversion path
 *               itself), app/api/widget/intake/route.ts:202,
 *               lib/kernel/listings.ts:332, lib/kernel/open-house.ts:203,
 *               lib/services/contact-management.service.ts:143
 *   'lead'      lib/kernel/lead-magnets.ts:439
 *   'contacted' offered by the CRM manual-add dialog (app/crm/page.tsx)
 *   'nurture'   offered by the same dialog; read back at
 *               app/actions/briefing-actions.ts:470
 *
 * FIVE SPELLINGS OF ONE IDEA IS A §6 DEFECT and it is reported, not silently
 * collapsed — see the header. What this list is NOT is a waypoint (§2): it asserts
 * the RULE "still pre-qualification", and anything outside it means something later
 * already claimed the row, so an invite must not walk it backwards.
 */
export const PRE_QUALIFICATION_CONTACT_STATUSES: readonly string[] = [
  "new",
  "active",
  "lead",
  "contacted",
  "nurture",
]

/**
 * The status a NEWLY CREATED contact may be stored with.
 *
 * Returns the requested status unchanged in every case but one: a create that asks
 * for 'qualified' gets `fallback` instead, because a contact cannot be born
 * qualified — no lead has converted into a row that did not exist a moment ago.
 * Case- and whitespace-insensitive, since these values arrive from CSV cells and
 * request bodies, not from a picker.
 *
 * NARROW ON PURPOSE. This refuses ONE spelling; it is not a vocabulary gate and it
 * does not normalize, rename or reject anything else. `contacts.status` has no
 * CHECK behind it (header), so a gate that silently rewrote unfamiliar values would
 * be inventing a vocabulary the database never agreed to.
 *
 * ALSO CORRECT ON A DEDUP-MERGE. An intake that turns out to match an existing
 * contact is still "a new contact coming in"; there the caller passes `undefined`
 * as the fallback, which is what that path already meant by "no status supplied"
 * — so a forged 'qualified' becomes "leave the existing status alone" rather than
 * overwriting it.
 *
 * @param requested caller-supplied status, from a form field, a CSV cell or a body
 * @param fallback  what this path would have used with no status at all — each
 *                  caller passes its OWN default (or `undefined`) so this never
 *                  changes a path's entry status, only refuses the earned one
 */
export function statusForNewContact<F extends string | undefined>(
  requested: string | null | undefined,
  fallback: F,
): string | F {
  const asked = (requested ?? "").toString().trim().toLowerCase()
  if (!asked) return fallback
  return asked === QUALIFIED_CONTACT_STATUS ? fallback : (requested as string)
}
