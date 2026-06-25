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
  computeAgentWorkloadIndex, detectOverload, tierMaxLoadForAgentCount, type WorkloadSignals,
} from "./capacity-guardian"
import { generatePersonaCopy, type CopyGenerator } from "./ai-copy"
import { publishManagerSignal } from "./manager-signals"

type Svc = ReturnType<typeof createServiceClient>

async function safeCount(p: PromiseLike<{ count: number | null }>): Promise<number> {
  try { const { count } = await p; return count ?? 0 } catch { return 0 }
}

/** Derive the tier ceiling from the agent headcount — the shared, single-source helper. */
const tierMaxLoad = tierMaxLoadForAgentCount

async function gatherSignals(svc: Svc, brokerageId: string, agentId: string, staleCutoffISO: string): Promise<WorkloadSignals> {
  const activeContacts = await safeCount(svc.from("contacts").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("agent_id", agentId).is("deleted_at", null))
  const activeLeads = await safeCount(svc.from("leads").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("agent_id", agentId))
  const staleContacts = await safeCount(svc.from("contacts").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("agent_id", agentId).is("deleted_at", null).lt("last_contacted_at", staleCutoffISO))
  const activeDeals = await safeCount(svc.from("transactions").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("agent_id", agentId).in("status", ["active", "under_contract", "closing"]))
  return { activeContacts, activeLeads, staleContacts, overdueTasks: 0, activeDeals }
}

export interface CapacityGuardianResult {
  scanned: number
  overloaded: number
  proposals: { agentId: string; rebalanceCount: number; signalId?: string }[]
}

/** Scan a brokerage's agents, flag overload, and propose a gated rebalance per overloaded agent. */
export async function runCapacityGuardian(
  brokerageId: string,
  opts: { copyGenerator?: CopyGenerator; staleDays?: number; agentIds?: string[]; dryRun?: boolean } = {},
  client?: Svc,
): Promise<CapacityGuardianResult> {
  const svc = client ?? createServiceClient()
  const staleCutoffISO = new Date(Date.now() - (opts.staleDays ?? 14) * 86_400_000).toISOString()

  let aq = svc.from("agents").select("id, user_id").eq("brokerage_id", brokerageId).eq("is_active", true)
  if (opts.agentIds?.length) aq = aq.in("id", opts.agentIds)
  const { data: agents } = await aq
  const agentRows = (agents ?? []) as { id: string; user_id: string | null }[]
  // Ceiling reflects the whole brokerage's tier, not just the scanned subset.
  const { count: totalAgents } = await svc.from("agents").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("is_active", true)
  const maxLoad = tierMaxLoad(totalAgents ?? agentRows.length)

  const result: CapacityGuardianResult = { scanned: agentRows.length, overloaded: 0, proposals: [] }

  for (const a of agentRows) {
    const signals = await gatherSignals(svc, brokerageId, a.id, staleCutoffISO)
    const idx = computeAgentWorkloadIndex(signals, { maxLoad })
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
        signalType:  "agent_overloaded",
        message:     draft.body,
        entityType:  "agent",
        entityId:    a.id,
        payload:     { workloadIndex: idx, rebalanceCount: decision.rebalanceCount, reason: decision.reason },
      }, svc)
      signalId = sig.signalId
    }

    result.proposals.push({ agentId: a.id, rebalanceCount: decision.rebalanceCount, signalId })
  }

  return result
}
