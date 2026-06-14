// lib/kernel/nothing-dropped-runner.ts
//
// Gathers the live "awaiting / no-next-action" rows across entities and ranks them into ONE
// dropping-balls card. READ-ONLY by default (a sweep never writes) — opt into publish to escalate
// a gated digest. Composes the awaiting states; the per-entity monitors still work each lane.
// Contacts + transactions are intentionally excluded — the stale-contact monitor + deadline
// watcher own those; this unifies the lanes nothing else unifies.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { findDroppingBalls, summarizeSweep, type DropCandidate, type DropEntity, type SweepSummary } from "./nothing-dropped"

type Svc = ReturnType<typeof createServiceClient>

const hoursSince = (iso: string | null): number => (iso ? (Date.now() - new Date(iso).getTime()) / 3_600_000 : 0)

async function gather(svc: Svc, table: string, filter: (q: any) => any, entityType: DropEntity, label: (r: any) => string): Promise<DropCandidate[]> {
  try {
    const { data } = await filter(svc.from(table).select("id, created_at").limit(500))
    return ((data ?? []) as { id: string; created_at: string | null }[]).map((r) => ({
      entityType, entityId: r.id, ageHours: hoursSince(r.created_at), hasNextAction: false, label: label(r),
    }))
  } catch { return [] }
}

/** Sweep a brokerage's actionable entities for anything past SLA with no next action. Read-only. */
export async function runNothingDroppedSweep(
  brokerageId: string,
  opts: { topN?: number } = {},
  client?: Svc,
): Promise<SweepSummary> {
  const svc = client ?? createServiceClient()

  const candidates: DropCandidate[] = [
    // A pending showing nobody confirmed.
    ...(await gather(svc, "showing_requests", (q) => q.eq("brokerage_id", brokerageId).eq("status", "pending"), "showing_request", () => "pending showing")),
    // A proposed action awaiting approval (office-hours SLA).
    ...(await gather(svc, "agent_client_messages", (q) => q.eq("brokerage_id", brokerageId).eq("status", "proposed"), "approval", () => "awaiting approval")),
    // An unconsumed inter-manager signal.
    ...(await gather(svc, "manager_signals", (q) => q.eq("brokerage_id", brokerageId).eq("status", "open"), "manager_signal", () => "open signal")),
    // A lead never first-touched (ghost) — leads stay AI-ISA owned until conversion.
    ...(await gather(svc, "leads", (q) => q.eq("brokerage_id", brokerageId).is("first_touched_at", null), "lead", () => "lead not first-touched")),
  ]

  const dropping = findDroppingBalls(candidates)
  return summarizeSweep(dropping, opts.topN ?? 10)
}
