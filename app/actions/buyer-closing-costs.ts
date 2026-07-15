"use server"

/**
 * app/actions/buyer-closing-costs.ts — the buyer's closing-cost breakdown,
 * grounded in THIS deal's real numbers (purchase price, loan amount, the
 * seller credit actually negotiated). Party-anchored like every portal read.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { estimateBuyerClosingCosts, type BuyerClosingEstimate } from "@/lib/offers/buyer-closing-costs"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function getBuyerClosingCosts(input: {
  contactId: string
  transactionId: string
}): Promise<{ success: true; estimate: BuyerClosingEstimate; purchasePrice: number } | { success: false; error: string }> {
  if (!UUID_RE.test(input.contactId) || !UUID_RE.test(input.transactionId)) {
    return { success: false, error: "Invalid ids" }
  }
  const svc = createServiceClient()
  const { data: tx } = await svc.from("transactions")
    .select("id, brokerage_id, purchase_price, contact_id, buyer_contact_id, seller_contact_id")
    .eq("id", input.transactionId).maybeSingle()
  if (!tx) return { success: false, error: "Transaction not found" }
  const isParty = [(tx as any).contact_id, (tx as any).buyer_contact_id, (tx as any).seller_contact_id]
    .filter(Boolean).includes(input.contactId)
  if (!isParty) return { success: false, error: "Not a party to this transaction" }

  const [{ data: offer }, { data: lender }] = await Promise.all([
    svc.from("offers")
      .select("offer_price, closing_cost_contribution, financing_type")
      .eq("transaction_id", input.transactionId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("transaction_lenders")
      .select("loan_amount")
      .eq("transaction_id", input.transactionId).limit(1).maybeSingle(),
  ])

  const purchasePrice = Number((tx as any).purchase_price ?? (offer as any)?.offer_price ?? 0)
  if (!purchasePrice || purchasePrice <= 0) {
    return { success: false, error: "No purchase price on this deal yet" } // honest absence — never estimate against nothing
  }
  const financing = String((offer as any)?.financing_type ?? "").toLowerCase()
  const loanAmount = financing === "cash" ? 0 : Number((lender as any)?.loan_amount ?? 0) || Math.round(purchasePrice * 0.8) // no loan recorded yet → conventional 80% assumption, stated in the UI

  const estimate = estimateBuyerClosingCosts({
    purchasePrice,
    loanAmount,
    sellerCredit: Number((offer as any)?.closing_cost_contribution ?? 0),
  })
  return { success: true, estimate, purchasePrice }
}
