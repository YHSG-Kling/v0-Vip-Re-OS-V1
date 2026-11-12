// lib/lead-assignment/capacity-pick.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE SINGLE capacity-aware agent picker — the one authority both assignment resolvers
// (resolveAgentForContact for contacts, evaluateAndAssignLead's fallback for leads) share so
// they can never disagree on "who has room". Working load = active contacts + owned leads +
// active deals — the SAME definition the Capacity Guardian's computeAgentWorkloadIndex uses,
// and the ceiling comes from the SAME tierMaxLoadForAgentCount. An overloaded agent is never
// handed fresh work (the guardian becomes preventive); a contact/lead is never stranded when
// everyone is slammed (least-loaded wins, the guardian then surfaces the overload).
//
// WAVE 103 (lane 103B) — ONE KERNEL ANSWER: `capacityFor(agent)` → { load, headroom, band,
// reasons }. This file is the one GATHERER (it already owned the load reads the assignment
// cascade runs on every pick, and carries no server-only / AI-copy graph); the pure math is
// lib/kernel/capacity-guardian.ts computeCapacity. Consumers: the assignment pick below, the
// guardian runner (lib/kernel/capacity-guardian-runner.ts — its private gatherSignals is
// tombstoned onto this), the stale-contact touch throttle (app/api/cron/stale-contact-monitor),
// the morning stand-up (lib/kernel/morning-standup.ts) and the team-lead brief
// (lib/intelligence/user-type-briefs/team-lead.ts).

import type { createServiceClient } from "@/lib/supabase/service"
import {
  computeCapacity, pickLeastLoadedWithHeadroom, tierMaxLoadForAgentCount,
  type AgentCapacity, type WorkloadSignals,
} from "@/lib/kernel/capacity-guardian"
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"

type Svc = ReturnType<typeof createServiceClient>

// TOMBSTONE (wave 103, lane 103B): the module-private `agentWorkingLoad` (contacts + leads +
// deals, three head counts) is MERGED into gatherWorkloadSignals below — the same three reads,
// now beside the follow-up-debt, task, showing and fatigue reads the one capacity answer needs.
// selectAgentByCapacity reads `capacityFor(...).load`, the identical number.

/** Follow-up SLA — a contact untouched this long is follow-up DEBT (the guardian's default). */
const CAPACITY_STALE_DAYS = 14

async function headCount(p: PromiseLike<{ count: number | null; error: { message: string } | null }>, what: string): Promise<number> {
  const { count, error } = await p
  // A refused count reads as 0 — which reads as "room". Surface it; the caller decides (the
  // pick still runs on the counts that did read, never on a silent zero).
  if (error) console.error(`[capacity] ${what} count refused: ${error.message}`)
  return count ?? 0
}

/**
 * Gather an agent's live workload signals — the ONE gatherer. `agentId` is agents.id (the FK
 * every work table carries); the fatigue tier crosses to the retention radar's row by the same
 * agents.id. Every read is tenant-pinned and error-read.
 */
async function gatherWorkloadSignals(
  supabase: Svc, brokerageId: string, agentId: string, opts: { now?: Date; staleDays?: number } = {},
): Promise<WorkloadSignals> {
  const now = opts.now ?? new Date()
  const nowISO = now.toISOString()
  const today = nowISO.slice(0, 10)
  const staleCutoffISO = new Date(now.getTime() - (opts.staleDays ?? CAPACITY_STALE_DAYS) * 86_400_000).toISOString()
  const [activeContacts, activeLeads, activeDeals, staleContacts, overdueTasks, pendingShowings, fatigueRow] = await Promise.all([
    headCount(supabase.from("contacts").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("agent_id", agentId).is("deleted_at", null), "contacts"),
    headCount(supabase.from("leads").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("agent_id", agentId), "leads"),
    headCount(supabase.from("transactions").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("agent_id", agentId).in("status", [...TRANSACTION_STATUSES_OPEN]), "transactions"),
    headCount(supabase.from("contacts").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("agent_id", agentId).is("deleted_at", null).lt("last_contacted_at", staleCutoffISO), "stale contacts"),
    // The SAME overdue-task predicate the retention radar scores (lib/recruiting/retention-radar.ts).
    headCount(supabase.from("tasks").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("assigned_to_agent_id", agentId).neq("status", "completed").lt("due_date", today), "overdue tasks"),
    // Showings still ahead on the calendar (the NBA's upcoming-showing read, per agent).
    headCount(supabase.from("showings").select("id", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId).eq("agent_id", agentId).gte("scheduled_at", nowISO)
      .not("status", "in", '("cancelled","completed","no_show")'), "pending showings"),
    supabase.from("agent_retention_scores").select("tier")
      .eq("brokerage_id", brokerageId).eq("agent_id", agentId)
      .order("score_date", { ascending: false }).limit(1).maybeSingle(),
  ])
  if (fatigueRow.error) console.error(`[capacity] fatigue tier read refused for agent ${agentId}: ${fatigueRow.error.message}`)
  const fatigueTier = (fatigueRow.error ? null : ((fatigueRow.data as { tier?: string | null } | null)?.tier ?? null)) as WorkloadSignals["fatigueTier"]
  return { activeContacts, activeLeads, activeDeals, staleContacts, overdueTasks, pendingShowings, fatigueTier }
}

/** THE ONE KERNEL ANSWER for an agent's capacity. `maxLoad` may be passed by a caller that
 *  already resolved the brokerage ceiling (a loop over many agents); otherwise it is resolved. */
export async function capacityFor(
  supabase: Svc, brokerageId: string, agentId: string,
  opts: { now?: Date; staleDays?: number; maxLoad?: number } = {},
): Promise<AgentCapacity> {
  const maxLoad = opts.maxLoad ?? await resolveBrokerageMaxLoad(supabase, brokerageId)
  const signals = await gatherWorkloadSignals(supabase, brokerageId, agentId, opts)
  return computeCapacity(signals, { maxLoad })
}

/** Resolve the per-agent tier ceiling from the brokerage's active-agent headcount. */
export async function resolveBrokerageMaxLoad(supabase: Svc, brokerageId: string): Promise<number> {
  const { count } = await supabase.from("agents").select("id", { count: "exact", head: true })
    .eq("brokerage_id", brokerageId).eq("is_active", true)
  return tierMaxLoadForAgentCount(count ?? 1)
}

/** Capacity-aware pick over a candidate pool: prefer an agent with HEADROOM (band available /
 *  busy — fatigue and follow-up debt included, wave 103); never strand work when everyone is
 *  slammed (least-loaded wins, the guardian surfaces it). */
export async function selectAgentByCapacity(
  supabase: Svc, brokerageId: string, agentIds: string[], maxLoad: number,
): Promise<string | null> {
  const candidates: Array<{ agentId: string; load: number; band: AgentCapacity["band"] }> = []
  for (const id of agentIds) {
    const cap = await capacityFor(supabase, brokerageId, id, { maxLoad })
    candidates.push({ agentId: id, load: cap.load, band: cap.band })
  }
  return pickLeastLoadedWithHeadroom(candidates, maxLoad)
}

// TOMBSTONE (wave 87, lane 87A): `agentHasHeadroom` DELETED. Its only caller was the mailbox-owner
// rung's CAPACITY fall-through, which the owner's ruling removed ("since the email was from the
// agents' mailbox, it should lead back to the agent." — a busy agent is still the sender's agent).
// The capacity test itself lives on in the pool pick: survivor
// lib/kernel/capacity-guardian.ts pickLeastLoadedWithHeadroom, via selectAgentByCapacity above.
