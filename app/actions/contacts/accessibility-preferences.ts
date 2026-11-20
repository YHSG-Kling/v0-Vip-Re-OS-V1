"use server"

/**
 * app/actions/contacts/accessibility-preferences.ts — the TWO doors that write a contact's accessibility preferences
 * (wave 145, lane 145H; owner ruling 18 — "explicit, user-controllable fields … never inferred"). Both delegate to THE
 * writer, lib/contacts/accessibility-preferences.ts writeAccessibilityPreferences (vocabulary-validated, tenant-pinned,
 * counted, provenance-stamped). Every export here is a public endpoint and async (CLAUDE.md §4).
 *
 *   saveMyAccessibilityPreferences          — THE CONTACT, in their own portal. Gate: requireContactAccess, and only
 *                                             the account holder (isContactSelf) — staff never write through this door.
 *   saveContactAccessibilityPreferences     — an AGENT / STAFF member, at the contact's request. Gate: the canonical
 *                                             CRM contact gate (assertCanActOnContact, write intent — assigned agent or
 *                                             same-brokerage staff; a read-only act-as grant is refused). The caller
 *                                             must attest the contact asked (`contactRequested: true`): the field is the
 *                                             PERSON's statement, so staff record it, never decide it.
 *
 * Tenant: from the gate's resolution of the session and the contact row — never from the body.
 */

import { revalidatePath } from "next/cache"
import { createServiceClient } from "@/lib/supabase/service"
import { writeAccessibilityPreferences, type AccessibilityPreferences } from "@/lib/contacts/accessibility-preferences"

/** WAVE 155 (lane 155R12): ONE action-ledger receipt per user-initiated write, through the one helper (lib/kernel/action-ledger.ts
 *  ledgerSessionAction) with NO key — recording only, so a second save runs again and leaves a second receipt. Tenant and actor are
 *  the SESSION's (each caller resolves them). The helper answers `{ success, error }` WITHOUT running only when it refused the
 *  claim; callers here read their own result shape, so only that refusal maps through `refused` — a run's value is returned as is.
 *  A caller with NO tenant (platform staff) has no valid receipt row: never invented (CLAUDE.md §4) — it runs exactly as before. */
async function withReceipt<T, R>(rc: { brokerageId: string | null; userId: string; agentId?: string | null; action: string; subject: { type: string; id?: string | null; ref?: string | null }; riskClass: string; detail?: Record<string, unknown> }, run: () => Promise<T>, refused: (error: string) => R): Promise<T | R> {
  if (!rc.brokerageId) return run()
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  let ran = false
  const out = await ledgerSessionAction({ brokerageId: rc.brokerageId, action: rc.action, actor: { type: "user", userId: rc.userId, agentId: rc.agentId ?? null }, subject: rc.subject, riskClass: rc.riskClass, reasonCode: "HUMAN_REQUESTED", detail: rc.detail ?? null }, () => { ran = true; return run() })
  return ran ? out as T : refused((out as { error?: string }).error ?? "The action was not recorded, so it did not run.")
}

type SaveResult = { ok: true; preferences: AccessibilityPreferences; changed: string[] } | { ok: false; error: string }

export async function saveMyAccessibilityPreferences(input: { contactId: string; preferences: unknown }): Promise<SaveResult> {
  const { requireContactAccess } = await import("@/lib/portal/require-contact-access")
  const access = await requireContactAccess(String(input?.contactId ?? ""))
  if (!access.ok) return { ok: false, error: access.error }
  if (!access.isContactSelf) return { ok: false, error: "Only the account holder can change these here — your agent can record them for you." }
  const res = await withReceipt({ brokerageId: access.brokerageId, userId: access.userId, action: "contact.accessibility_preferences.save", subject: { type: "contact", id: input.contactId }, riskClass: "LOW_RISK_WRITE", detail: { writer: "contact" } }, () => writeAccessibilityPreferences(createServiceClient(), {
    brokerageId: access.brokerageId, contactId: input.contactId, input: input.preferences,
    writer: { userId: access.userId, kind: "contact" },
  }), (error) => ({ ok: false as const, error }))
  if (!res.ok) return res
  if (res.provenanceWarning) console.warn("[accessibility-preferences] self edit:", res.provenanceWarning)
  revalidatePath(`/portal/${input.contactId}`, "layout")
  return { ok: true, preferences: res.preferences, changed: res.changed }
}

export async function saveContactAccessibilityPreferences(input: {
  contactId: string
  preferences: unknown
  /** The staff member attests the CONTACT asked for this. Without it nothing is written. */
  contactRequested: boolean
}): Promise<SaveResult> {
  if (input?.contactRequested !== true) {
    return { ok: false, error: "Record accessibility preferences only when the contact asked — confirm they did." }
  }
  const { assertCanActOnContact } = await import("@/lib/auth/contact-access")
  const gate = await assertCanActOnContact(String(input.contactId ?? ""), { intent: "write" })
  if (!gate.ok) return { ok: false, error: gate.error }
  if (!gate.contact.brokerage_id) return { ok: false, error: "This contact has no brokerage — nothing was saved." }
  const res = await withReceipt({ brokerageId: gate.contact.brokerage_id, userId: gate.actorUserId, action: "contact.accessibility_preferences.save", subject: { type: "contact", id: input.contactId }, riskClass: "LOW_RISK_WRITE", detail: { writer: "staff_on_request" } }, () => writeAccessibilityPreferences(createServiceClient(), {
    brokerageId: gate.contact.brokerage_id!, contactId: input.contactId, input: input.preferences,
    // The REAL human (the staff member when acting-as) — the audit field records who typed it.
    writer: { userId: gate.actorUserId, kind: "staff_on_request" },
  }), (error) => ({ ok: false as const, error }))
  if (!res.ok) return res
  if (res.provenanceWarning) console.warn("[accessibility-preferences] staff edit:", res.provenanceWarning)
  revalidatePath(`/crm/contacts/${input.contactId}`)
  return { ok: true, preferences: res.preferences, changed: res.changed }
}
