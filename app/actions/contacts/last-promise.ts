"use server"

/**
 * app/actions/contacts/last-promise.ts — "LAST PROMISE MADE" (concierge
 * A.3; l50-s01): one field per contact holding the last explicit promise
 * ("I'll get you updated comps tomorrow"). Setting it stamps the clock;
 * clearing it means the promise was KEPT. The aging guard in the morning
 * briefing refuses to let an open promise silently age out. Gated by the
 * same contact-access check every contact surface runs.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { assertCanActOnContact } from "@/lib/auth/contact-access"

export async function setLastPromiseAction(input: {
  contactId: string
  /** the promise text; null/empty = promise KEPT (cleared). */
  promise: string | null
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const gate = await assertCanActOnContact(input.contactId)
  if (!gate.ok) return { ok: false, error: gate.error }
  const text = (input.promise ?? "").trim().slice(0, 240) || null
  const svc = createServiceClient()
  const { error } = await svc.from("contacts").update({
    last_promise: text,
    last_promise_at: text ? new Date().toISOString() : null,
  }).eq("id", input.contactId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
}
