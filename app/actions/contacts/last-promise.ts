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
  const run = async (): Promise<{ ok: true } | { ok: false; error: string }> => {
  const { error } = await svc.from("contacts").update({
    last_promise: text,
    last_promise_at: text ? new Date().toISOString() : null,
  }).eq("id", input.contactId)
  if (error) return { ok: false, error: error.message }
  return { ok: true }
  }
  // WAVE 155 (155R14): the receipt, against the tenant the gate proved (a contact with no tenant runs exactly as before).
  const brokerageId = gate.contact.brokerage_id
  if (!brokerageId) return run()
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  const r = await ledgerSessionAction({ brokerageId, action: "contact.last_promise.set", actor: { type: "user", userId: gate.actorUserId }, subject: { type: "contact", id: input.contactId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { kept: !text } }, run)
  return "ok" in r ? r : { ok: false, error: r.error ?? "The promise was not saved" }
}
