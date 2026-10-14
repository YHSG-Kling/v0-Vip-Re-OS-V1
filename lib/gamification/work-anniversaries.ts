// lib/gamification/work-anniversaries.ts
// ─────────────────────────────────────────────────────────────────────────────
// AGENT WORK ANNIVERSARIES (wave 103, lane 103C) — the one lifecycle moment on
// the agent side that no writer and no event carried. Rides the weekly
// recruit-outreach cron (the cron every other recruiting-manager sweep rides),
// emits AGENT_WORK_ANNIVERSARY through the canonical emitter, and the event
// reactor awards WORK_ANNIVERSARY once per agent per calendar year
// (lib/gamification/award-points.ts LIFECYCLE_AWARD_RULES, scope "per_year").
//
// THE DATE IS agents.anniversary_date (date) — stamped at seat creation by every provisioning
// door since wave 104 (lane 104E: lib/kernel/users.ts, app/actions/agents.ts createAgent,
// app/api/recruiting/provision-agent) — with agents.created_at as the fallback for seats
// provisioned before the stamp (the column was writerless until then; CLAUDE.md §3).

import type { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** The cron is weekly; a 7-day lookback catches every anniversary exactly once per run cadence.
 *  @proofSeam the proof asserts the window edge against this number */
export const ANNIVERSARY_WINDOW_DAYS = 7

/**
 * PURE: how many whole years ago `startedAt` fell, when its month/day anniversary
 * landed inside the last `windowDays` ending at `now`; null when it did not, or
 * when the agent has not yet completed a full year.
 * @proofSeam PURE — the proof asserts the window edges and the first-year exclusion.
 */
export function anniversaryYearsOn(startedAt: string | null | undefined, now: Date, windowDays = ANNIVERSARY_WINDOW_DAYS): number | null {
  if (!startedAt) return null
  const start = new Date(startedAt)
  if (Number.isNaN(start.getTime())) return null
  const windowStart = now.getTime() - windowDays * 86_400_000
  // The anniversary this year, and last year's (a window spanning New Year).
  for (const year of [now.getUTCFullYear(), now.getUTCFullYear() - 1]) {
    const anniv = Date.UTC(year, start.getUTCMonth(), start.getUTCDate())
    const years = year - start.getUTCFullYear()
    if (years >= 1 && anniv > windowStart && anniv <= now.getTime()) return years
  }
  return null
}

/** PURE: the date an anniversary counts from — anniversary_date when stamped, else created_at.
 *  @proofSeam the proof asserts the preference and the fallback. */
export function anniversaryStartDate(a: { created_at: string | null; anniversary_date?: string | null }): string | null {
  return a.anniversary_date ?? a.created_at
}

export interface WorkAnniversaryResult { brokerages: number; agents: number; emitted: number }

/** One brokerage: emit for every active agent whose anniversary fell in the window. */
async function runWorkAnniversaries(svc: Svc, params: { brokerageId: string; now?: Date }): Promise<Omit<WorkAnniversaryResult, "brokerages">> {
  const now = params.now ?? new Date()
  const out = { agents: 0, emitted: 0 }
  const { data: agents, error } = await svc.from("agents").select("id, created_at, anniversary_date")
    .eq("brokerage_id", params.brokerageId).eq("is_active", true).limit(5000)
  if (error) {
    console.error(`[work-anniversaries] agent roster read refused for ${params.brokerageId}: ${error.message}`)
    return out
  }
  const { emitKernelEvent } = await import("@/lib/kernel/emit")
  const { KernelEvent } = await import("@/lib/kernel/events")
  for (const a of (agents ?? []) as Array<{ id: string; created_at: string | null; anniversary_date: string | null }>) {
    out.agents++
    const startedAt = anniversaryStartDate(a)
    const years = anniversaryYearsOn(startedAt, now)
    if (years === null) continue
    const res = await emitKernelEvent({
      event:       KernelEvent.AGENT_WORK_ANNIVERSARY,
      brokerageId: params.brokerageId,
      entityType:  "agent",
      entityId:    a.id,
      source:      "cron",
      metadata:    { agent_id: a.id, years, started_at: startedAt },
      // A re-run inside the cadence is the same anniversary; the reactor's per-year
      // once-award is the stop beyond this window.
      dedupeKey:       `${a.id}:${now.getUTCFullYear()}`,
      dedupeWindowSec: ANNIVERSARY_WINDOW_DAYS * 86_400,
    })
    if (!res.error) out.emitted++
    else console.error(`[work-anniversaries] AGENT_WORK_ANNIVERSARY did not emit for ${a.id}: ${res.error}`)
  }
  return out
}

/** Autonomous: every brokerage (rides the weekly recruit-outreach cron). */
export async function runWorkAnniversariesAll(svc: Svc, now?: Date): Promise<WorkAnniversaryResult> {
  const out: WorkAnniversaryResult = { brokerages: 0, agents: 0, emitted: 0 }
  const { data: rows, error } = await svc.from("brokerages").select("id").limit(1000)
  if (error) {
    console.error(`[work-anniversaries] brokerage list read refused: ${error.message}`)
    return out
  }
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try {
      const r = await runWorkAnniversaries(svc, { brokerageId: b.id, now })
      out.agents += r.agents; out.emitted += r.emitted
    } catch (e) { console.error(`[work-anniversaries] ${b.id} failed:`, e) }
  }
  return out
}
