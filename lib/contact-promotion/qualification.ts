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
 *
 * UPDATE 2026-08-31: the owner ruled — fix by building and normalizing. The
 * spellings ARE now collapsed (survivors below), supabase/migrations/m587 puts a
 * CHECK behind the column (WRITTEN, not applied — lanes write, the integrator
 * applies, §3), and this file is the single code-side source of the vocabulary.
 * After m587 is applied the integrator regenerates scripts/check-vocabularies.ts
 * so `contacts.status` appears in the generated cache alongside this list.
 */

/** The one earned status. Never spell it inline. */
export const QUALIFIED_CONTACT_STATUS = "qualified"

/**
 * THE `contacts.status` VOCABULARY — one spelling per lifecycle idea (§6).
 * Mirrors the CHECK written in supabase/migrations/m587 (pending apply). Every
 * member has a live writer AND a live reader, measured on stripped source
 * (scripts/strip-comments.ts, §2) 2026-08-31:
 *
 *   'new'       DEFAULT; app/actions/seller-open-house.ts:770,
 *               app/api/open-house/attend/route.ts:94, lib/kernel/crm.ts:326,
 *               lib/application/lead-application-service.ts:437 (import fallback),
 *               lib/kernel/lead-magnets.ts:439 (was 'lead' — merged, see below)
 *   'contacted' CRM manual-add dialog (app/crm/page.tsx) via the crm.ts create
 *               path; read at app/dashboard/isa/calling/page.tsx:79,
 *               app/actions/ai-lead-nurturing.ts:442
 *   'active'    lib/contact-promotion/contact-creator.ts:319 (lead conversion),
 *               app/api/widget/intake/route.ts:202, lib/kernel/listings.ts:332,
 *               lib/kernel/open-house.ts:203,
 *               lib/services/contact-management.service.ts:143
 *   'nurture'   CRM manual-add dialog; read at app/actions/briefing-actions.ts,
 *               app/actions/property-buyer-matching.ts:95
 *   'qualified' EARNED — stamped in one place, lib/portal/portal-invite-core.ts
 *               (header above); an agent may also set it later through the edit
 *               path (app/actions/contacts.ts updateContact), never at create
 *   'inactive'  dormancy: automation stops, contact stays visible. Writer: the
 *               edit path (caller-chosen); readers lib/ai-isa/reengagement-policy.ts
 *               NON_ENGAGEABLE_CONTACT_STATUSES, lib/lead-pipeline/
 *               reactivation-enroller.ts:61, stale-preapproval-reengage-runner.ts:66,
 *               lib/kernel/communication-compliance.ts (soft warn)
 *   'archived'  the agent-departure book archive — automation stops AND the row
 *               leaves working lists, history preserved. Writer:
 *               lib/agents/agent-deactivation.ts:263; readers
 *               app/dashboard/team/page.tsx, lib/intelligence/health-prioritizer-runner.ts,
 *               lib/lead-pipeline/persona-drift-runner.ts, reengagement-policy
 *   'deleted'   soft delete, paired with `deleted_at`. Writer:
 *               lib/services/contact-management.service.ts:310; readers
 *               app/actions/crm.ts:369, lib/agents/seller-conversion-nurture.ts:49
 *
 * 'inactive', 'archived' and 'deleted' are three DIFFERENT capabilities
 * (dormancy / departure-archive / soft delete) — do not fold them (owner
 * methodology ruling: same-sounding is not same-capability).
 *
 * MERGED SPELLINGS (each a §6 defect, each with its survivor):
 *   'lead'          → 'new'      a lead-magnet capture is a NEW contact; leads
 *                                belong to the brokerage (§5) and are a different
 *                                entity. Writer fixed at lib/kernel/lead-magnets.ts:439.
 *   'nurturing'     → 'nurture'  spelling drift; reader fixed at
 *                                app/actions/ai-lead-nurturing.ts:442
 *   'active_client' → 'active'   phantom (no writer ever); reader repointed at
 *                                app/actions/copilot.ts:874
 *   'hot'/'hot_lead'→ lead_temperature='hot' — a TEMPERATURE, not a status;
 *                                contacts.lead_temperature carries a live CHECK
 *                                (cold/hot/warm). Readers repointed at
 *                                app/actions/ai-auto-response.ts,
 *                                lib/intelligence/daily-briefing-generator.ts,
 *                                lib/intelligence/user-type-briefs/team-lead.ts,
 *                                app/actions/copilot.ts
 *   'closed'        → the terminal set; reader fixed at
 *                                app/api/cron/pattern-scan/route.ts:52
 *   'do_not_contact'→ dnc_status boolean (the real DNC rail; compliance already
 *                                hard-blocks on it). Phantom status member removed
 *                                from lib/ai-isa/reengagement-policy.ts and
 *                                lib/kernel/communication-compliance*.ts
 *   'appointment_booked' + the journey ladder (signed_agreement, pre_listing,
 *   active_listing, contingent, pending, sold, lifetime_customer)
 *                   → these are DEAL/JOURNEY facts living on buyer_stage,
 *                     listings.status, transactions and contact_type
 *                     ('lifetime_customer'), not contact lifecycle. They existed
 *                     only in the caller-less aiMappingService/supabaseService
 *                     import path and two type copies; all retargeted here.
 */
export const CONTACT_STATUSES = [
  "new",
  "contacted",
  "active",
  "nurture",
  "qualified",
  "inactive",
  "archived",
  "deleted",
] as const

export type ContactStatus = (typeof CONTACT_STATUSES)[number]

/** UI labels for the vocabulary — dropdowns render from this, never inline. */
export const CONTACT_STATUS_LABELS: Record<ContactStatus, string> = {
  new: "New",
  contacted: "Contacted",
  active: "Active",
  nurture: "Nurture",
  qualified: "Qualified",
  inactive: "Inactive",
  archived: "Archived",
  deleted: "Deleted",
}

/**
 * Statuses after which a contact is out of every working surface: dormant
 * ('inactive'), archived with a departing agent ('archived'), or soft-deleted
 * ('deleted'). Pipeline scans exclude these; see app/api/cron/pattern-scan and
 * lib/ai-isa/reengagement-policy.ts (which excludes the first two but not
 * 'deleted', because its callers already gate on `deleted_at`).
 */
export const TERMINAL_CONTACT_STATUSES: readonly ContactStatus[] = [
  "inactive",
  "archived",
  "deleted",
]

/**
 * Tolerant READER for the retired spellings — the exact mapping m587's backfill
 * applies (keep the two in lockstep). Returns the canonical member for a known
 * value or a retired alias, and null for anything else — the caller decides
 * whether null is a refusal (a writer must refuse; see the asymmetry documented
 * in scripts/contact-vocabulary-guard.ts: readers stay tolerant, writers do not).
 * Case- and whitespace-insensitive, since these arrive from CSV cells, request
 * bodies and voice-tool arguments.
 */
export function canonicalContactStatus(raw: string | null | undefined): ContactStatus | null {
  const key = (raw ?? "").toString().trim().toLowerCase()
  if (!key) return null
  if ((CONTACT_STATUSES as readonly string[]).includes(key)) return key as ContactStatus
  const alias: Record<string, ContactStatus> = {
    lead: "new",
    nurturing: "nurture",
    active_client: "active",
    hot_lead: "active",
    hot: "active",
    closed: "inactive",
    do_not_contact: "inactive", // the DNC fact itself lives on dnc_status
    appointment_booked: "active",
    signed_agreement: "active",
    pre_listing: "active",
    active_listing: "active",
    contingent: "active",
    pending: "active",
    sold: "inactive", // the working pipeline ended; the relationship lives on contact_type='lifetime_customer'
    lifetime_customer: "active",
  }
  return alias[key] ?? null
}

/**
 * `contacts.status` values that mean "nothing has qualified this contact yet" —
 * the set a conversion-invite may upgrade FROM. Every member is a value some live
 * path in this tree actually writes or offers today, measured on stripped source
 * (§2), with its writer named so a future lane can audit the membership rather
 * than trust it:
 *
 *   'new'       the column DEFAULT, plus app/actions/seller-open-house.ts:770,
 *               app/api/open-house/attend/route.ts:94, lib/kernel/crm.ts:326,
 *               lib/application/lead-application-service.ts:437 (import fallback),
 *               and lib/kernel/lead-magnets.ts:439 (wrote 'lead' until 2026-08-31;
 *               merged onto 'new' — a lead-magnet capture is a NEW contact, and
 *               'lead' the status made those contacts invisible to every reader
 *               that lists workable contacts, e.g. app/dashboard/isa/calling)
 *   'active'    lib/contact-promotion/contact-creator.ts:319 (the conversion path
 *               itself), app/api/widget/intake/route.ts:202,
 *               lib/kernel/listings.ts:332, lib/kernel/open-house.ts:203,
 *               lib/services/contact-management.service.ts:143
 *   'contacted' offered by the CRM manual-add dialog (app/crm/page.tsx)
 *   'nurture'   offered by the same dialog; read back at
 *               app/actions/briefing-actions.ts:484
 *
 * ('lead', the fifth spelling this list once carried, was merged onto 'new' when
 * the owner ruled the vocabulary be collapsed — see CONTACT_STATUSES above.)
 *
 * What this list is NOT is a waypoint (§2): it asserts the RULE "still
 * pre-qualification", and anything outside it means something later already
 * claimed the row, so an invite must not walk it backwards.
 */
export const PRE_QUALIFICATION_CONTACT_STATUSES: readonly string[] = [
  "new",
  "active",
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
