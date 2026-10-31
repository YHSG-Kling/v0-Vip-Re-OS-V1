// lib/kernel/capacity-guardian-runner.ts
//
// Server runner for the Capacity Guardian. Gathers live workload signals per agent (leads counted
// as real load), computes the pure index, and when an agent is OVERLOADED publishes a GATED,
// persona-generated rebalance recommendation on the inter-manager bus so the ball is never dropped.
// Attributed to recruiting_manager (which already owns agent management) — no new ManagerKey.
// Nothing moves a client autonomously; the broker/team-lead approves the rebalance.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import {
  detectOverload, tierMaxLoadForAgentCount, overloadDaysIn, shouldSuggestReassignment,
  OVER_CAPACITY_ESCALATION_DAYS, REASSIGNMENT_SUGGESTION_DAYS,
  AGENT_OVERLOADED_SIGNAL, AGENT_REASSIGNMENT_SUGGESTED_SIGNAL,
} from "./capacity-guardian"
import { capacityFor, selectAgentByCapacity } from "@/lib/lead-assignment/capacity-pick"
import { validateBookTransferRequest } from "@/lib/agents/agent-books"
import { generatePersonaCopy, type CopyGenerator } from "./ai-copy"
import { publishManagerSignal } from "./manager-signals"

type Svc = ReturnType<typeof createServiceClient>

/** Derive the tier ceiling from the agent headcount — the shared, single-source helper. */
const tierMaxLoad = tierMaxLoadForAgentCount

// TOMBSTONE (wave 103, lane 103B): the private `gatherSignals` (four swallowed head counts, and
// `overdueTasks: 0` HARDCODED — the follow-up-debt term the index was written for never read a
// task) is MERGED onto the one gatherer, survivor lib/lead-assignment/capacity-pick.ts
// gatherWorkloadSignals / capacityFor, which reads overdue tasks, pending showings and the
// agent's fatigue tier too, with every refusal surfaced instead of swallowed.

// The manager-bus words this runner publishes live on the pure module (readers such as the
// team-lead brief import them without this runner's AI-copy graph).
export { AGENT_OVERLOADED_SIGNAL, AGENT_REASSIGNMENT_SUGGESTED_SIGNAL }

export interface CapacityGuardianResult {
  scanned: number
  overloaded: number
  proposals: { agentId: string; rebalanceCount: number; signalId?: string }[]
  /** WAVE 103: agents over for ≥ OVER_CAPACITY_ESCALATION_DAYS with a temporary-cover suggestion
   *  (agent-books shape, validated) published for the broker / team lead to approve. */
  reassignments: { fromAgentId: string; toAgentId: string; daysOver: number; signalId?: string }[]
}

/** Scan a brokerage's agents, flag overload, and propose a gated rebalance per overloaded agent. */
export async function runCapacityGuardian(
  brokerageId: string,
  opts: { copyGenerator?: CopyGenerator; staleDays?: number; agentIds?: string[]; dryRun?: boolean } = {},
  client?: Svc,
): Promise<CapacityGuardianResult> {
  const svc = client ?? createServiceClient()
  let aq = svc.from("agents").select("id, user_id").eq("brokerage_id", brokerageId).eq("is_active", true)
  if (opts.agentIds?.length) aq = aq.in("id", opts.agentIds)
  const { data: agents } = await aq
  const agentRows = (agents ?? []) as { id: string; user_id: string | null }[]
  // Ceiling reflects the whole brokerage's tier, not just the scanned subset.
  const { count: totalAgents } = await svc.from("agents").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("is_active", true)
  const maxLoad = tierMaxLoad(totalAgents ?? agentRows.length)

  const result: CapacityGuardianResult = { scanned: agentRows.length, overloaded: 0, proposals: [], reassignments: [] }
  const now = new Date()

  for (const a of agentRows) {
    const cap = await capacityFor(svc, brokerageId, a.id, { now, staleDays: opts.staleDays ?? 14, maxLoad })
    const idx = cap.index
    const decision = detectOverload(idx, { maxLoad })
    if (!decision.overloaded) continue
    result.overloaded++

    // Persona-generated recommendation — NEVER hardcoded; deterministic fallback guarantees copy.
    const draft = await generatePersonaCopy(
      {
        goal: "a short recommendation to the broker/team-lead that this agent is overloaded and N of their contacts should be rebalanced to a teammate so nothing is dropped",
        facts: [
          `Working load: ${idx.load} (capacity ${Math.round(idx.capacityScore * 100)}%)`,
          `Follow-up debt: ${idx.followUpDebt}`,
          `Recommend rebalancing ${decision.rebalanceCount} contacts`,
          ...idx.drivers,
        ],
        channel: "portal",
        persona: { audience: "agent", situation: "overloaded" },
        words: 50,
      },
      { body: `This agent is carrying ${idx.load} active items with ${idx.followUpDebt} follow-ups overdue. Rebalance ${decision.rebalanceCount} contacts to a teammate so nothing is dropped.` },
      { generator: opts.copyGenerator },
    )

    // dryRun computes + recommends without writing a signal (used by the proof so it can't pollute).
    let signalId: string | undefined
    if (!opts.dryRun) {
      const sig = await publishManagerSignal({
        brokerageId,
        fromManager: "recruiting_manager",
        toManager:   "ai_isa",
        signalType:  AGENT_OVERLOADED_SIGNAL,
        message:     draft.body,
        entityType:  "agent",
        entityId:    a.id,
        payload:     { workloadIndex: idx, rebalanceCount: decision.rebalanceCount, reason: decision.reason },
      }, svc)
      signalId = sig.signalId
    }

    result.proposals.push({ agentId: a.id, rebalanceCount: decision.rebalanceCount, signalId })

    // WAVE 103 (lane 103B) — ESCALATION. Over for N days (the cron signals once per agent per day,
    // so prior agent_overloaded rows ARE the day count) → suggest a TEMPORARY books cover to the
    // teammate with the most headroom, in agent-books' own validated shape. GATED: a suggestion on
    // the bus; reassignAgentBooks runs only when the broker / team lead approves it.
    const { data: priorSignals, error: priorErr } = await svc.from("manager_signals").select("created_at")
      .eq("brokerage_id", brokerageId).eq("signal_type", AGENT_OVERLOADED_SIGNAL).eq("entity_id", a.id)
      .gte("created_at", new Date(now.getTime() - OVER_CAPACITY_ESCALATION_DAYS * 86_400_000).toISOString())
    if (priorErr) { console.error(`[capacity-guardian] overload history read refused for ${a.id}: ${priorErr.message}`); continue }
    const daysOver = overloadDaysIn([...((priorSignals ?? []) as { created_at: string }[]).map((r) => r.created_at), now.toISOString()], now)
    const receivers = agentRows.map((r) => r.id).filter((id) => id !== a.id)
    const receiverId = receivers.length > 0 ? await selectAgentByCapacity(svc, brokerageId, receivers, maxLoad) : null
    if (!shouldSuggestReassignment(daysOver, receiverId)) continue
    const until = new Date(now.getTime() + REASSIGNMENT_SUGGESTION_DAYS * 86_400_000).toISOString()
    const shape = validateBookTransferRequest({ fromAgentId: a.id, toAgentId: receiverId as string, scope: "temporary", until }, now)
    if (!shape.ok) { console.error(`[capacity-guardian] reassignment shape refused for ${a.id}: ${shape.error}`); continue }
    let reassignmentSignalId: string | undefined
    if (!opts.dryRun) {
      const sig = await publishManagerSignal({
        brokerageId,
        fromManager: "recruiting_manager",
        toManager:   "ai_isa",
        signalType:  AGENT_REASSIGNMENT_SUGGESTED_SIGNAL,
        message:     `Over capacity ${daysOver} days running — suggest a temporary books cover (${REASSIGNMENT_SUGGESTION_DAYS} days) to the teammate with the most headroom. Approve to run the agent-books transfer.`,
        entityType:  "agent",
        entityId:    a.id,
        payload:     { fromAgentId: a.id, toAgentId: receiverId, scope: "temporary", until: shape.untilIso, daysOver, rebalanceCount: decision.rebalanceCount, band: cap.band, reasons: cap.reasons },
      }, svc)
      reassignmentSignalId = sig.signalId
    }
    result.reassignments.push({ fromAgentId: a.id, toAgentId: receiverId as string, daysOver, signalId: reassignmentSignalId })
  }

  return result
}
