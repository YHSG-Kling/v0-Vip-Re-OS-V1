// lib/intelligence/loan-milestone-sync-runner.ts
//
// Live side of LOAN-MILESTONE SYNC — when a financing milestone lands for a buyer, plan the sync (pure
// planLoanMilestoneSync) and hand it to the Deal Coordinator on the bus so it keeps the buyer + agent
// in the loop (gated buyer update + agent prompt). Sensitive milestones (denial) never auto-message
// the buyer. Idempotent per (contact, milestone). Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { planLoanMilestoneSync, deriveLoanMilestone, type LoanMilestone, type LenderState } from "./loan-milestone-sync"

type Svc = ReturnType<typeof createServiceClient>

// Furthest-along wins when a deal somehow has more than one lender row.
const MILESTONE_RANK: Record<LoanMilestone, number> = {
  application_submitted: 1, pre_approval: 2, conditional_approval: 3, appraisal_ordered: 4,
  appraisal_complete: 5, clear_to_close: 6, funded: 7, delay: 0, denied: 8,
}

export interface LoanMilestoneArgs {
  brokerageId: string
  contactId: string
  milestone: LoanMilestone
  daysToClose?: number | null
  transactionId?: string | null
  propertyAddress?: string | null
}

export async function syncLoanMilestone(args: LoanMilestoneArgs, client?: Svc): Promise<{ published: boolean; audience: string }> {
  const svc = client ?? createServiceClient()
  const plan = planLoanMilestoneSync({ milestone: args.milestone, daysToClose: args.daysToClose ?? null })
  if (!plan.notify) return { published: false, audience: "none" }

  // Idempotent — one sync per (contact, milestone).
  const { data: prior } = await svc.from("manager_signals")
    .select("id").eq("brokerage_id", args.brokerageId).eq("signal_type", "loan_milestone")
    .eq("contact_id", args.contactId).ilike("message", `%${args.milestone}%`).limit(1).maybeSingle()
  if (prior) return { published: false, audience: plan.audience }

  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    const r = await publishManagerSignal({
      // A financing milestone ORIGINATES with the Finance Manager (owns lender/financing data) and is
      // HANDED to the Deal Coordinator (keeps buyer + agent in sync). The previous deal_coordinator →
      // deal_coordinator self-loop was rejected by validSignalRoute (from===to), so the signal never
      // persisted and the deal_coordinator:loan_milestone handler was structurally unreachable.
      brokerageId: args.brokerageId, fromManager: "finance_manager", toManager: "deal_coordinator",
      signalType: "loan_milestone",
      message: `Loan milestone "${args.milestone}" (${plan.tone}): ${plan.reason}.`,
      entityType: "contact", entityId: args.contactId, contactId: args.contactId,
      payload: {
        milestone: args.milestone, audience: plan.audience, tone: plan.tone,
        buyerMessage: plan.buyerMessage, agentNote: plan.agentNote,
        transactionId: args.transactionId ?? null, property_address: args.propertyAddress ?? null,
      },
    }, svc)
    return { published: !!(r as any).ok, audience: plan.audience }
  } catch {
    return { published: false, audience: plan.audience }
  }
}

/**
 * LOAN-MILESTONE SYNC SWEEP — the missing TRIGGER for the loan_milestone circuit. For each ACTIVE deal
 * in the brokerage with a lender row, derive the furthest financing milestone reached (pure
 * deriveLoanMilestone) and hand it to syncLoanMilestone, which publishes the gated finance_manager →
 * deal_coordinator handoff (buyer update + agent prompt; denial is agent-only). Idempotent per
 * (contact, milestone), so a milestone fires exactly once. Best-effort; never throws. Runs from the
 * financing-pit-stop cron — the same financing window as the rate-lock + rate-race work.
 */
export async function runLoanMilestoneSync(
  args: { brokerageId: string }, client?: Svc,
): Promise<{ scanned: number; synced: number; skippedNoMilestone: number; skippedNoBuyer: number; errors: string[] }> {
  const svc = client ?? createServiceClient()
  const errors: string[] = []
  let scanned = 0, synced = 0, skippedNoMilestone = 0, skippedNoBuyer = 0

  const { data: txns, error } = await svc
    .from("transactions")
    .select("id, buyer_contact_id, contact_id, close_date, property_address, status, transaction_lenders(pre_approval_date, appraisal_ordered_date, appraisal_completed_date, clear_to_close_date, underwriting_status)")
    .eq("brokerage_id", args.brokerageId)
    .not("status", "in", "(closed,lost)")
    .limit(500)
  if (error) { errors.push(error.message); return { scanned, synced, skippedNoMilestone, skippedNoBuyer, errors } }

  const now = Date.now()
  for (const t of (txns ?? []) as Array<Record<string, any>>) {
    const lenders = (t.transaction_lenders ?? []) as LenderState[]
    if (lenders.length === 0) continue
    scanned += 1
    // Furthest-along milestone across this deal's lender row(s).
    let milestone: LoanMilestone | null = null
    for (const l of lenders) {
      const m = deriveLoanMilestone(l)
      if (m && (!milestone || MILESTONE_RANK[m] > MILESTONE_RANK[milestone])) milestone = m
    }
    if (!milestone) { skippedNoMilestone += 1; continue }
    const contactId: string | null = t.buyer_contact_id ?? t.contact_id ?? null
    if (!contactId) { skippedNoBuyer += 1; continue }
    const daysToClose = t.close_date
      ? Math.round((new Date(t.close_date).getTime() - now) / 86_400_000)
      : null
    try {
      const r = await syncLoanMilestone({
        brokerageId: args.brokerageId, contactId, milestone,
        daysToClose, transactionId: t.id, propertyAddress: t.property_address ?? null,
      }, svc)
      if (r.published) synced += 1
    } catch (e: any) {
      errors.push(`txn ${t.id}: ${e?.message ?? String(e)}`)
    }
  }
  return { scanned, synced, skippedNoMilestone, skippedNoBuyer, errors }
}
