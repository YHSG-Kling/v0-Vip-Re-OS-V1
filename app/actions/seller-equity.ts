"use server"

// app/actions/seller-equity.ts
// ─────────────────────────────────────────────────────────────────────────────
// SELLER EQUITY tool — persists the seller's own mortgage balance so their net-proceeds estimate is
// accurate (we never fabricate it). Stored on the real contacts.metadata jsonb (the canonical home
// for buyer/seller self-entered facts), mirroring the commute-destination + notification-preference
// pattern. The math lives in the PURE engine (lib/seller-equity/equity-estimate) so the card can
// recompute live; this action only saves the input.

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

function readMetadata(raw: any): Record<string, any> {
  if (!raw) return {}
  if (typeof raw === "string") { try { return JSON.parse(raw) } catch { return {} } }
  return raw
}

/** Save (or clear) the seller's remaining mortgage balance for an accurate net-proceeds estimate. */
export async function setSellerMortgageBalance(
  contactId: string,
  balance: number | null,
): Promise<{ success: boolean; error?: string }> {
  if (!contactId) return { success: false, error: "Missing contact" }
  if (balance !== null && (!Number.isFinite(balance) || balance < 0)) {
    return { success: false, error: "Enter a valid balance" }
  }
  // WAVE 155 (lane 155S3): THE CONTACT GATE FIRST (lib/portal/require-contact-access.ts requireContactAccess — the seller
  // themselves, or staff of the contact's own brokerage). This "use server" export had NO gate: it read and rewrote any
  // contact's metadata by id, with RLS its only fence and every read's error dropped. The tenant is the gate's (the contact's
  // brokerage); the read and the write carry it, both errors are READ, and the update is COUNTED (CLAUDE.md §3) — a zero-row
  // write is a failure for this caller (the seller's card would otherwise show a balance that was never saved).
  const { requireContactAccess } = await import("@/lib/portal/require-contact-access")
  const access = await requireContactAccess(contactId)
  if (!access.ok) return { success: false, error: access.error }
  const supabase = await createClient()
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  return ledgerSessionAction({ brokerageId: access.brokerageId, action: "portal.seller_mortgage_balance.set", actor: { type: "user", userId: access.userId }, subject: { type: "contact", id: contactId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED", detail: { cleared: balance === null, by_contact_self: access.isContactSelf } }, async (): Promise<{ success: boolean; error?: string }> => {
  const { data, error: readError } = await supabase.from("contacts").select("metadata").eq("id", contactId).eq("brokerage_id", access.brokerageId).maybeSingle()
  if (readError) return { success: false, error: readError.message }
  if (!data) return { success: false, error: "Contact not found" }
  const md = readMetadata(data?.metadata)
  const next = { ...md, mortgage_balance: balance === null ? null : Math.round(balance) }
  const { data: saved, error } = await supabase
    .from("contacts")
    .update({ metadata: next, updated_at: new Date().toISOString() })
    .eq("id", contactId)
    .eq("brokerage_id", access.brokerageId)
    .select("id")
  if (error) return { success: false, error: error.message }
  if ((saved ?? []).length === 0) return { success: false, error: "Your balance was not saved — please try again" }
  revalidatePath(`/portal/${contactId}/listing`)
  return { success: true }
  })
}
