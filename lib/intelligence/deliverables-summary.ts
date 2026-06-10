// lib/intelligence/deliverables-summary.ts
//
// UNIFIED GOVERNED-DELIVERABLES RAIL — the aggregate story of the egress in one glance.
// Every loop (strategy, referral, recruiting, seller-video, vendor intro/review,
// education, plus any deal-critical manager's client message) proposes into the SAME
// gate (agent_client_messages). This rolls all of them up for a window: how many
// governed deliverables the AI workforce produced, how many a human approved/sent, and
// the breakdown by manager and by loop. This is the proof-of-system screenshot —
// "N AI deliverables this week, every one human-approved before it shipped."
//
// Pure aggregation over agent_client_messages; entity_type maps to its originating loop.

import { createServiceClient } from "@/lib/supabase/service"
import { MANAGERS, type ManagerKey } from "@/lib/kernel/manager-registry"

/** entity_type on the gate row → the loop that produced it (broker-readable). */
export const LOOP_LABELS: Record<string, string> = {
  learning_module: "Education",
  vendor_booking:  "Vendor marketplace",
  referral:        "Referrals",
  recruit:         "Recruiting",
  listing:         "Listings & seller updates",
  transaction:     "Deal coordination",
  offer:           "Offers",
  contact:         "Client updates",
}
export function loopLabelFor(entityType: string | null): string {
  return (entityType && LOOP_LABELS[entityType]) || "Other"
}

export interface DeliverableTotals {
  total: number
  proposed: number   // still awaiting a human
  approved: number   // approved, not yet confirmed sent
  sent: number       // reached the client
  rejected: number
  failed: number
  /** Of everything that REACHED a client (sent), how many had a human approver. Must
   *  equal `sent` — the governance invariant surfaced for the operator. */
  sentWithApprover: number
}

export interface ManagerDeliverables {
  manager: ManagerKey | "unknown"
  label: string
  total: number
  sent: number
  pending: number
}

export interface LoopDeliverables {
  loop: string
  count: number
}

export interface DeliverablesSummary {
  brokerageId: string
  since: string
  until: string
  totals: DeliverableTotals
  byManager: ManagerDeliverables[]
  byLoop: LoopDeliverables[]
}

interface Row { agent_kind: string | null; entity_type: string | null; status: string; approved_by: string | null }

/** Pure: fold gate rows into the unified summary. */
export function computeDeliverablesSummary(rows: Row[], brokerageId: string, since: string, until: string): DeliverablesSummary {
  const totals: DeliverableTotals = { total: rows.length, proposed: 0, approved: 0, sent: 0, rejected: 0, failed: 0, sentWithApprover: 0 }
  const byManagerMap = new Map<ManagerKey | "unknown", ManagerDeliverables>()
  const byLoopMap = new Map<string, number>()

  for (const r of rows) {
    if (r.status in totals && r.status !== "total") (totals as unknown as Record<string, number>)[r.status] += 1
    if (r.status === "sent" && r.approved_by) totals.sentWithApprover += 1

    const key = (r.agent_kind && r.agent_kind in MANAGERS ? r.agent_kind : "unknown") as ManagerKey | "unknown"
    const m = byManagerMap.get(key) ?? { manager: key, label: key === "unknown" ? "Unassigned" : MANAGERS[key].label, total: 0, sent: 0, pending: 0 }
    m.total += 1
    if (r.status === "sent") m.sent += 1
    if (r.status === "proposed" || r.status === "approved") m.pending += 1
    byManagerMap.set(key, m)

    const loop = loopLabelFor(r.entity_type)
    byLoopMap.set(loop, (byLoopMap.get(loop) ?? 0) + 1)
  }

  return {
    brokerageId, since, until,
    totals,
    byManager: Array.from(byManagerMap.values()).sort((a, b) => b.total - a.total),
    byLoop: Array.from(byLoopMap.entries()).map(([loop, count]) => ({ loop, count })).sort((a, b) => b.count - a.count),
  }
}

export interface DeliverablesSummaryParams {
  brokerageId: string
  /** Window on proposed_at. Defaults to trailing 7 days. */
  sinceIso?: string
  untilIso?: string
}

export async function generateDeliverablesSummary(
  params: DeliverablesSummaryParams,
  client?: ReturnType<typeof createServiceClient>,
): Promise<DeliverablesSummary> {
  const supabase = client ?? createServiceClient()
  const since = params.sinceIso ?? new Date(Date.now() - 7 * 86_400_000).toISOString()
  const until = params.untilIso ?? new Date().toISOString()

  const { data } = await supabase
    .from("agent_client_messages")
    .select("agent_kind, entity_type, status, approved_by")
    .eq("brokerage_id", params.brokerageId)
    .gte("proposed_at", since).lt("proposed_at", until)
    .limit(5000)

  return computeDeliverablesSummary((data ?? []) as Row[], params.brokerageId, since, until)
}
