"use server"

/**
 * app/actions/continuity-receipt.ts — the client's trust receipt. Party-
 * anchored: the caller must supply a contact that IS a party to the
 * transaction (the same anchoring the portal offer-decision rail uses).
 * The receipt runs the REAL per-deal contract checks at read time, so
 * "verified just now" is literally true.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { loadDealContinuity, type ContinuityReceipt } from "@/lib/kernel/continuity-receipt"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getContinuityReceipt(input: {
  contactId: string
  transactionId: string
}): Promise<{ success: true; receipt: ContinuityReceipt } | { success: false; error: string }> {
  if (!UUID_RE.test(input.contactId) || !UUID_RE.test(input.transactionId)) {
    return { success: false, error: "Invalid ids" }
  }
  const svc = createServiceClient()
  const { data: tx } = await svc.from("transactions")
    .select("id, brokerage_id, contact_id, buyer_contact_id, seller_contact_id")
    .eq("id", input.transactionId).maybeSingle()
  if (!tx || !(tx as any).brokerage_id) return { success: false, error: "Transaction not found" }
  const isParty = [(tx as any).contact_id, (tx as any).buyer_contact_id, (tx as any).seller_contact_id]
    .filter(Boolean).includes(input.contactId)
  if (!isParty) return { success: false, error: "Not a party to this transaction" }

  const receipt = await loadDealContinuity(svc, {
    brokerageId: (tx as any).brokerage_id,
    transactionId: input.transactionId,
  })
  return { success: true, receipt }
}
