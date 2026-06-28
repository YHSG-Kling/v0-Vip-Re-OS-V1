// lib/intelligence/loan-milestone-sync-runner.ts
//
// Live side of LOAN-MILESTONE SYNC — when a financing milestone lands for a buyer, plan the sync (pure
// planLoanMilestoneSync) and hand it to the Deal Coordinator on the bus so it keeps the buyer + agent
// in the loop (gated buyer update + agent prompt). Sensitive milestones (denial) never auto-message
// the buyer. Idempotent per (contact, milestone). Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { planLoanMilestoneSync, type LoanMilestone } from "./loan-milestone-sync"

type Svc = ReturnType<typeof createServiceClient>

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
