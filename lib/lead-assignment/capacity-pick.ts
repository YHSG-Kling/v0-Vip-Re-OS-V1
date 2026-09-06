// lib/lead-assignment/capacity-pick.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SINGLE capacity-aware agent picker — the one authority both assignment resolvers
// (resolveAgentForContact for contacts, evaluateAndAssignLead's fallback for leads) share so
// they can never disagree on "who has room". Working load = active contacts + owned leads +
// active deals — the SAME definition the Capacity Guardian's computeAgentWorkloadIndex uses,
// and the ceiling comes from the SAME tierMaxLoadForAgentCount. An overloaded agent is never
// handed fresh work (the guardian becomes preventive); a contact/lead is never stranded when
// everyone is slammed (least-loaded wins, the guardian then surfaces the overload).

import type { createServiceClient } from "@/lib/supabase/service"
import { pickLeastLoadedWithHeadroom, tierMaxLoadForAgentCount } from "@/lib/kernel/capacity-guardian"
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"

type Svc = ReturnType<typeof createServiceClient>

/** An agent's WORKING LOAD = active contacts + owned leads + active deals. */
export async function agentWorkingLoad(supabase: Svc, brokerageId: string, agentId: string): Promise<number> {
  const [c, l, d] = await Promise.all([
    supabase.from("contacts").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("agent_id", agentId).is("deleted_at", null),
    supabase.from("leads").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("agent_id", agentId),
    supabase.from("transactions").select("id", { count: "exact", head: true }).eq("brokerage_id", brokerageId).eq("agent_id", agentId).in("status", [...TRANSACTION_STATUSES_OPEN]),
  ])
  return (c.count ?? 0) + (l.count ?? 0) + (d.count ?? 0)
}

/** Resolve the per-agent tier ceiling from the brokerage's active-agent headcount. */
export async function resolveBrokerageMaxLoad(supabase: Svc, brokerageId: string): Promise<number> {
  const { count } = await supabase.from("agents").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("is_active", true)
  return tierMaxLoadForAgentCount(count ?? 1)
}

/** Capacity-aware pick over a candidate pool: prefer an agent with HEADROOM under the tier
 *  ceiling; never strand work when everyone is slammed (the guardian surfaces it). */
export async function selectAgentByCapacity(
  supabase: Svc, brokerageId: string, agentIds: string[], maxLoad: number,
): Promise<string | null> {
  const candidates: Array<{ agentId: string; load: number }> = []
  for (const id of agentIds) candidates.push({ agentId: id, load: await agentWorkingLoad(supabase, brokerageId, id) })
  return pickLeastLoadedWithHeadroom(candidates, maxLoad)
}
