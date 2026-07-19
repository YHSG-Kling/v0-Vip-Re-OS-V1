"use server"

/**
 * app/actions/portal-loan-checklist.ts — BUYER LOAN-CONDITION VISIBILITY.
 * The lender-condition loop asks the buyer for documents; this is the other
 * half — the buyer SEES which conditions are still open on their own portal
 * deal view, killing the "did they get my statement?" call. Read-only, party-
 * anchored (the contact must be ON the transaction — no arbitrary reads),
 * grounded in the same transaction_lenders row the lender writes. Honest:
 * no loan row / no conditions → null, the card simply doesn't render.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { assessFinancingLetterStrength } from "@/lib/financing/letter-strength"

export interface BuyerLoanChecklist {
  lenderName: string | null
  underwritingStatus: string | null
  clearToClose: boolean
  conditions: Array<{ condition: string; cleared: boolean }>
  outstanding: number
  /** Honest pre-qual→pre-approval upgrade line (letter unverified/absent/expired on the
   *  buyer's financial profile); null once financing is verified-strong or cleared to close.
   *  The card links it to the buyer's education (the pre-qual vs pre-approval lesson). */
  preApprovalNudge: string | null
}

export async function loadBuyerLoanChecklist(input: {
  contactId: string
  transactionId: string
}): Promise<BuyerLoanChecklist | null> {
  const svc = createServiceClient()

  // Party check — the requesting contact must be on THIS deal.
  const { data: tx } = await svc.from("transactions")
    .select("id, contact_id, buyer_contact_id")
    .eq("id", input.transactionId).maybeSingle()
  if (!tx) return null
  const party = (tx as any).contact_id === input.contactId || (tx as any).buyer_contact_id === input.contactId
  if (!party) return null

  const { data: loan } = await svc.from("transaction_lenders")
    .select("lender_name, underwriting_status, clear_to_close_date, notes")
    .eq("transaction_id", input.transactionId)
    .order("created_at", { ascending: false })
    .limit(1).maybeSingle()
  if (!loan) return null

  let conditions: Array<{ condition: string; cleared: boolean }> = []
  try {
    const parsed = JSON.parse(String((loan as any).notes ?? "[]"))
    if (Array.isArray(parsed)) {
      conditions = parsed
        .filter((c: any) => c && typeof c.condition === "string" && c.condition.trim())
        .map((c: any) => ({ condition: String(c.condition), cleared: String(c.status ?? "") === "cleared" }))
    }
  } catch { /* notes not a condition list — nothing to show, stay honest */ }

  const clearToClose = Boolean((loan as any).clear_to_close_date)
  if (conditions.length === 0 && !clearToClose && !(loan as any).underwriting_status) return null

  // MOMENT-OF-TRUTH NUDGE — when the buyer's letter is unverified (pre-qual strength), absent,
  // or expired on their financial profile, show the honest upgrade line. Keys off the SAME
  // buyer_financial_profiles row the pre-approval record sourcing reads (the OS records no
  // explicit pre-qual vs pre-approval letter TYPE — see lib/financing/letter-strength.ts).
  // Once the loan is cleared to close the letter conversation is moot — no nudge.
  let preApprovalNudge: string | null = null
  if (!clearToClose) {
    const { data: fin } = await svc.from("buyer_financial_profiles")
      .select("is_cash_buyer, verified, pre_approval_amount, pre_approval_letter_doc_id, pre_approval_expires_at")
      .eq("contact_id", input.contactId)
      .maybeSingle()
    preApprovalNudge = assessFinancingLetterStrength({
      isCashBuyer: (fin as any)?.is_cash_buyer ?? null,
      verified: (fin as any)?.verified ?? null,
      preApprovalAmount: (fin as any)?.pre_approval_amount ?? null,
      preApprovalLetterDocId: (fin as any)?.pre_approval_letter_doc_id ?? null,
      preApprovalExpiresAt: (fin as any)?.pre_approval_expires_at ?? null,
    }).buyerNudge
  }

  return {
    lenderName: (loan as any).lender_name ?? null,
    underwritingStatus: (loan as any).underwriting_status ?? null,
    clearToClose,
    conditions,
    outstanding: conditions.filter((c) => !c.cleared).length,
    preApprovalNudge,
  }
}
