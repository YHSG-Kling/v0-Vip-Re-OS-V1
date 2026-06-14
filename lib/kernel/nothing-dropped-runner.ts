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
/** Age from the MOST RECENT of several timestamps (0 if none) — "how long since the last touch". */
const hoursSinceLatest = (...isos: (string | null)[]): number => {
  const ts = isos.filter(Boolean).map((s) => new Date(s as string).getTime())
  return ts.length ? (Date.now() - Math.max(...ts)) / 3_600_000 : 0
}

async function gather(
  svc: Svc, table: string, select: string, filter: (q: any) => any,
  entityType: DropEntity, age: (r: any) => number, label: (r: any) => string,
): Promise<DropCandidate[]> {
  try {
    const { data } = await filter(svc.from(table).select(select).limit(500))
    return ((data ?? []) as Record<string, any>[]).map((r) => ({
      entityType, entityId: r.id, ageHours: age(r), hasNextAction: false, label: label(r),
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
    ...(await gather(svc, "showing_requests", "id, created_at", (q) => q.eq("brokerage_id", brokerageId).eq("status", "pending"),
      "showing_request", (r) => hoursSince(r.created_at), () => "pending showing")),
    // A proposed action awaiting approval (office-hours SLA).
    ...(await gather(svc, "agent_client_messages", "id, created_at", (q) => q.eq("brokerage_id", brokerageId).eq("status", "proposed"),
      "approval", (r) => hoursSince(r.created_at), () => "awaiting approval")),
    // An unconsumed inter-manager signal.
    ...(await gather(svc, "manager_signals", "id, created_at", (q) => q.eq("brokerage_id", brokerageId).eq("status", "open"),
      "manager_signal", (r) => hoursSince(r.created_at), () => "open signal")),
    // A lead never first-touched (ghost) — leads stay AI-ISA owned until conversion.
    ...(await gather(svc, "leads", "id, created_at", (q) => q.eq("brokerage_id", brokerageId).is("first_touched_at", null),
      "lead", (r) => hoursSince(r.created_at), () => "lead not first-touched")),
    // A first-touched lead whose NEXT email/direct-mail push is overdue (age from the last touch).
    ...(await gather(svc, "leads", "id, first_touched_at, last_contacted_at",
      (q) => q.eq("brokerage_id", brokerageId).not("first_touched_at", "is", null).eq("ai_isa_owner", true),
      "lead_followup", (r) => hoursSinceLatest(r.last_contacted_at, r.first_touched_at), () => "lead needs next email/mail push")),
  ]

  const dropping = findDroppingBalls(candidates)
  return summarizeSweep(dropping, opts.topN ?? 10)
}
