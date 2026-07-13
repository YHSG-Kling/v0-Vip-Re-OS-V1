"use server"

/**
 * app/actions/contacts/update-addressing.ts — persist the ADDRESSING MEMORY
 * ("call me Bill"): preferred name, pronunciation, salutation register.
 * Captured once on the contact card; every copy surface (AI drafts, the
 * context spine, briefing nudges) reads it through resolveAddressing.
 * Gated by the same contact-access check the detail page runs.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { assertCanActOnContact } from "@/lib/auth/contact-access"

const clean = (s: string | null | undefined): string | null => {
  const t = (s ?? "").trim()
  return t.length > 0 ? t.slice(0, 120) : null
}

export async function updateContactAddressingAction(input: {
  contactId: string
  preferredName: string | null
  namePronunciation: string | null
  salutationStyle: string | null
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await assertCanActOnContact(input.contactId)
  if (!gate.ok) return { ok: false, error: gate.error }

  const style = clean(input.salutationStyle)?.toLowerCase() ?? null
  const svc = createServiceClient()
  const { error } = await svc.from("contacts").update({
    preferred_name: clean(input.preferredName),
    name_pronunciation: clean(input.namePronunciation),
    salutation_style: style === "formal" || style === "casual" ? style : null,
  }).eq("id", input.contactId)

  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
