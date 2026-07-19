"use server"

/**
 * app/actions/buyer-closing-costs.ts — the buyer's closing-cost breakdown,
 * grounded in THIS deal's real numbers (purchase price, loan amount, the
 * seller credit actually negotiated). Party-anchored like every portal read.
 *
 * LOAN SOURCING HIERARCHY (owner correction — loan terms are never assumed):
 *   1. transaction_lenders — the lender's own record (loan_amount, rate, name)
 *   2. transactions.loan_amount — the loan recorded on the deal
 *   3. the accepted offer's OWN terms (down_payment_amount / percent)
 *   4. buyer_financial_profiles — the buyer's pre-approval (cash flag, down
 *      payment, lender) → labeled "per your pre-approval from {lender}"
 *   5. genuinely unknown → the estimator marks lender-dependent lines PENDING.
 * Every resolved figure carries its provenance into the estimate.
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
    .select("id, brokerage_id, purchase_price, loan_amount, contact_id, buyer_contact_id, seller_contact_id")
    .eq("id", input.transactionId).maybeSingle()
  if (!tx) return { success: false, error: "Transaction not found" }
  const isParty = [(tx as any).contact_id, (tx as any).buyer_contact_id, (tx as any).seller_contact_id]
    .filter(Boolean).includes(input.contactId)
  if (!isParty) return { success: false, error: "Not a party to this transaction" }

  const [{ data: offer }, { data: lender }, { data: fin }] = await Promise.all([
    svc.from("offers")
      .select("offer_price, closing_cost_contribution, financing_type, down_payment_amount, down_payment_percent")
      .eq("transaction_id", input.transactionId)
      .order("created_at", { ascending: false }).limit(1).maybeSingle(),
    svc.from("transaction_lenders")
      .select("loan_amount, interest_rate, lender_name")
      .eq("transaction_id", input.transactionId).limit(1).maybeSingle(),
    svc.from("buyer_financial_profiles")
      .select("is_cash_buyer, down_payment_amount, down_payment_percent, pre_approval_lender")
      .eq("contact_id", input.contactId).maybeSingle(),
  ])

  const purchasePrice = Number((tx as any).purchase_price ?? (offer as any)?.offer_price ?? 0)
  if (!purchasePrice || purchasePrice <= 0) {
    return { success: false, error: "No purchase price on this deal yet" } // honest absence — never estimate against nothing
  }

  // ── Resolve the REAL loan amount + its provenance. NO assumption tier: when no
  //    record carries the terms, loanAmount stays null and the estimator presents
  //    the lender-dependent lines as pending — an invented 80% LTV is still an
  //    invention. ──
  const sane = (n: unknown): number | null => {
    const v = Number(n)
    return Number.isFinite(v) && v > 0 && v < purchasePrice ? Math.round(v) : null
  }
  const financing = String((offer as any)?.financing_type ?? "").toLowerCase()
  let loanAmount: number | null = null
  let loanSourceNote: string | null = null
  let interestRatePct: number | null = null

  const lenderLoan = sane((lender as any)?.loan_amount)
  const lenderRate = Number((lender as any)?.interest_rate)
  if (Number.isFinite(lenderRate) && lenderRate > 0) interestRatePct = lenderRate

  if (financing === "cash" || (fin as any)?.is_cash_buyer === true) {
    loanAmount = 0
    loanSourceNote = financing === "cash" ? "cash purchase per your offer" : "cash purchase per your financial profile"
  } else if (lenderLoan != null) {
    loanAmount = lenderLoan
    const name = (lender as any)?.lender_name
    loanSourceNote = `per your lender's loan terms on file${name ? ` (${name})` : ""}`
  } else if (sane((tx as any).loan_amount) != null) {
    loanAmount = sane((tx as any).loan_amount)
    loanSourceNote = "per the loan amount on your transaction record"
  } else {
    // The offer's own terms, then the buyer's pre-approval record.
    const offerDownAmt = sane((offer as any)?.down_payment_amount)
    const offerDownPct = Number((offer as any)?.down_payment_percent)
    const finDownAmt = sane((fin as any)?.down_payment_amount)
    const finDownPct = Number((fin as any)?.down_payment_percent)
    const preLender = (fin as any)?.pre_approval_lender
    if (offerDownAmt != null) {
      loanAmount = purchasePrice - offerDownAmt
      loanSourceNote = "per the down payment on your offer"
    } else if (Number.isFinite(offerDownPct) && offerDownPct > 0 && offerDownPct < 100) {
      loanAmount = Math.round(purchasePrice * (1 - offerDownPct / 100))
      loanSourceNote = `per the ${offerDownPct}% down payment on your offer`
    } else if (finDownAmt != null) {
      loanAmount = purchasePrice - finDownAmt
      loanSourceNote = `per your pre-approval${preLender ? ` from ${preLender}` : ""}`
    } else if (Number.isFinite(finDownPct) && finDownPct > 0 && finDownPct < 100) {
      loanAmount = Math.round(purchasePrice * (1 - finDownPct / 100))
      loanSourceNote = `per your pre-approval${preLender ? ` from ${preLender}` : ""}`
    }
    // else: genuinely unknown — loanAmount stays null, lines go pending.
  }

  const estimate = estimateBuyerClosingCosts({
    purchasePrice,
    loanAmount,
    sellerCredit: Number((offer as any)?.closing_cost_contribution ?? 0),
    interestRatePct,
    loanSourceNote,
  })
  return { success: true, estimate, purchasePrice }
}
