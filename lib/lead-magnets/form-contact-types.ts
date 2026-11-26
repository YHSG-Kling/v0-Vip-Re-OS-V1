// lib/lead-magnets/form-contact-types.ts
//
// WHO FILLS THIS FORM — the contact types a lead-capture form may DECLARE for its submitters
// (lead_capture_forms.settings.default_contact_type). Wave 142, lane 142E: the ONE unique piece of the
// retired admin Forms Manager (app/dashboard/admin/forms/FormsManagerClient.tsx + /api/forms/submit Step 4b),
// merged onto the lead-magnet survivor. PURE and dependency-free so the kernel (lib/kernel/lead-magnets.ts,
// the honouring reader), the builder / review surfaces (client components) and the proof read ONE roster.
// The three values are live contacts_contact_type_check members (scripts/check-vocabularies.ts) — a form
// declares a side of the business, never a lifecycle stage.

export const FORM_DECLARABLE_CONTACT_TYPES = ["buyer", "seller", "both"] as const

export type FormDeclarableContactType = (typeof FORM_DECLARABLE_CONTACT_TYPES)[number]

/** The declared type when it is one the kernel honours, else null (an unrecognised string is dropped, never stored). */
export function declarableContactType(raw: unknown): FormDeclarableContactType | null {
  const v = String(raw ?? "").trim().toLowerCase()
  return (FORM_DECLARABLE_CONTACT_TYPES as readonly string[]).includes(v) ? (v as FormDeclarableContactType) : null
}
