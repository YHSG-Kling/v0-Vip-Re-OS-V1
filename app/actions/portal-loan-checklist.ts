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

export interface BuyerLoanChecklist {
  lenderName: string | null
  underwritingStatus: string | null
  clearToClose: boolean
  conditions: Array<{ condition: string; cleared: boolean }>
  outstanding: number
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

  return {
    lenderName: (loan as any).lender_name ?? null,
    underwritingStatus: (loan as any).underwriting_status ?? null,
    clearToClose,
    conditions,
    outstanding: conditions.filter((c) => !c.cleared).length,
  }
}
