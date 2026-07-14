/**
 * lib/transactions/walkthrough-outcome.ts
 *
 * WALKTHROUGH OUTCOME BRANCHING (forgotten-items #38 / shared-process
 * C.11) — the final walkthrough is the last moment a deal can wobble, and
 * "all good," "minor issues," and "major issues" deserve three DIFFERENT
 * processes, not one generic note. PURE composer: outcome in → the client
 * line (acknowledge-first on bad news), the agent's next tasks, and
 * whether the deal auto-flags SHAKY (major issues suspend earned autonomy
 * for the file via the existing deal_shaky rail — two trust systems, one
 * flag). The writer records the outcome on the lifecycle ledger and
 * creates the branch's tasks (NOT-NULL assignee contract honored).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export type WalkthroughOutcome = "all_good" | "minor_issues" | "major_issues"

export interface WalkthroughFollowUp {
  /** the client-facing line the agent sends (persona rails may rephrase). */
  clientLine: string
  /** the agent's next tasks, in order. */
  agentTasks: Array<{ title: string; dueDays: number }>
  /** major issues auto-flag the deal SHAKY (autonomy suspended for the file). */
  flagShaky: boolean
}

/** PURE: three outcomes, three genuinely different processes. */
export function composeWalkthroughFollowUp(outcome: WalkthroughOutcome, addressAs: string): WalkthroughFollowUp {
  if (outcome === "all_good") {
    return {
      clientLine: `${addressAs}, the walkthrough looked great — we're clear for closing. I'll confirm the final logistics with every party today and you'll have the play-by-play before you sign.`,
      agentTasks: [{ title: "Walkthrough clear — confirm closing logistics with all parties", dueDays: 0 }],
      flagShaky: false,
    }
  }
  if (outcome === "minor_issues") {
    return {
      clientLine: `${addressAs}, we found a few small items at the walkthrough — that's normal at this stage, and none of it threatens the closing. I'm documenting each one and agreeing the fix or credit before we sign, so nothing is left to memory.`,
      agentTasks: [
        { title: "Walkthrough punch list — document each item with photos + agree fix or credit before closing", dueDays: 0 },
        { title: "Confirm punch-list resolution in writing with the other side", dueDays: 1 },
      ],
      flagShaky: false,
    }
  }
  return {
    clientLine: `${addressAs}, the walkthrough surfaced real issues and I want to own that with you directly — we are NOT signing until they're resolved or priced. I'm getting every party on this today and you'll hear from me by end of day with the options.`,
    agentTasks: [
      { title: "MAJOR walkthrough issues — huddle with all parties TODAY (resolve, credit, or delay)", dueDays: 0 },
      { title: "Walk the client through the options live — do not let this ride in text", dueDays: 0 },
    ],
    flagShaky: true,
  }
}

/** LIVE: record the outcome (ledger) + create the branch's tasks; major
 *  issues flip deal_shaky so the file's earned autonomy suspends at once. */
export async function recordWalkthroughOutcome(svc: Svc, input: {
  transactionId: string
  brokerageId: string
  outcome: WalkthroughOutcome
  actorUserId: string
  addressAs: string
  /** tasks need a NOT-NULL assignee — the deal's agent, resolved by the caller. */
  assigneeAgentId: string
}): Promise<{ tasksCreated: number; flaggedShaky: boolean }> {
  const plan = composeWalkthroughFollowUp(input.outcome, input.addressAs)

  await svc.from("lifecycle_events").insert({
    brokerage_id: input.brokerageId,
    entity_type: "transaction",
    entity_id: input.transactionId,
    event_type: "walkthrough_outcome",
    actor_user_id: input.actorUserId,
    metadata: { outcome: input.outcome },
  })

  if (plan.flagShaky) {
    await svc.from("transactions").update({ deal_shaky: true }).eq("id", input.transactionId)
  }

  let tasksCreated = 0
  for (const t of plan.agentTasks) {
    const { error } = await svc.from("tasks").insert({
      brokerage_id: input.brokerageId,
      transaction_id: input.transactionId,
      assigned_to_agent_id: input.assigneeAgentId,
      title: t.title,
      description: `Walkthrough outcome: ${input.outcome.replace(/_/g, " ")}. Client line (send it): "${plan.clientLine}"`,
      due_date: new Date(Date.now() + t.dueDays * 86_400_000).toISOString(),
      assignee_type: "agent",
      source: "walkthrough_outcome",
      status: "pending",
      created_at: new Date().toISOString(),
    })
    if (!error) tasksCreated++
  }
  return { tasksCreated, flaggedShaky: plan.flagShaky }
}
