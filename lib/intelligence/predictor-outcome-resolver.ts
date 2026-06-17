// lib/intelligence/predictor-outcome-resolver.ts
//
// Live side of PREDICTOR OUTCOME — the fuel line for the self-tuning predictors. Scans the brokerage's
// unresolved predictor plays (manager_signals: buyer_stall_predicted / listing_stall_predicted /
// stage_stalled / dual_transaction_timing), checks whether the contact RE-ENGAGED after each play (a
// reply, a new tour, or a new offer), and records the win/loss onto ai_feedback_log via
// recordPredictorOutcome — then marks the signal resolved so it's recorded exactly once. Plays still
// inside the window with no re-engagement are left for next run. Read-mostly; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { decidePredictorOutcome, predictorNameForSignal, PREDICTOR_EVAL_WINDOW_DAYS } from "./predictor-outcome"
import { recordPredictorOutcome } from "./predictor-learning-runner"

type Svc = ReturnType<typeof createServiceClient>
const DAY = 86_400_000
const PREDICTOR_SIGNALS = ["buyer_stall_predicted", "listing_stall_predicted", "stage_stalled", "dual_transaction_timing"]

export interface ResolvePredictorOutcomesResult { scanned: number; wins: number; losses: number; pending: number }

/** Find the contact's first genuine re-engagement (reply / tour / offer) strictly AFTER `afterMs`. */
async function firstReengagementAfter(svc: Svc, contactId: string, afterMs: number): Promise<number | null> {
  const afterIso = new Date(afterMs).toISOString()
  const candidates: number[] = []

  const { data: replies } = await svc.from("sequence_step_executions")
    .select("replied_at").eq("contact_id", contactId).not("replied_at", "is", null).gt("replied_at", afterIso).limit(1)
  for (const r of (replies ?? []) as any[]) { const t = new Date(r.replied_at).getTime(); if (Number.isFinite(t)) candidates.push(t) }

  const { data: tours } = await svc.from("showings")
    .select("scheduled_at").eq("contact_id", contactId).gt("scheduled_at", afterIso).limit(1)
  for (const s of (tours ?? []) as any[]) { const t = new Date(s.scheduled_at).getTime(); if (Number.isFinite(t)) candidates.push(t) }

  const { data: offers } = await svc.from("offers")
    .select("created_at").eq("contact_id", contactId).gt("created_at", afterIso).limit(1)
  for (const o of (offers ?? []) as any[]) { const t = new Date(o.created_at).getTime(); if (Number.isFinite(t)) candidates.push(t) }

  return candidates.length ? Math.min(...candidates) : null
}

export async function resolvePredictorOutcomes(
  brokerageId: string, opts: { now?: string; limit?: number } = {}, client?: Svc,
): Promise<ResolvePredictorOutcomesResult> {
  const svc = client ?? createServiceClient()
  const nowMs = new Date(opts.now ?? new Date().toISOString()).getTime()
  const out: ResolvePredictorOutcomesResult = { scanned: 0, wins: 0, losses: 0, pending: 0 }

  const { data: signals } = await svc.from("manager_signals")
    .select("id, signal_type, contact_id, created_at, payload, status")
    .eq("brokerage_id", brokerageId).in("signal_type", PREDICTOR_SIGNALS)
    .neq("status", "resolved").not("contact_id", "is", null)
    .order("created_at", { ascending: true }).limit(opts.limit ?? 500)

  for (const sig of (signals ?? []) as any[]) {
    const predictor = predictorNameForSignal(sig.signal_type)
    if (!predictor || !sig.contact_id) continue
    out.scanned++
    const playAtMs = new Date(sig.created_at).getTime()
    const reengagedAtMs = await firstReengagementAfter(svc, sig.contact_id, playAtMs)
    const decision = decidePredictorOutcome(playAtMs, reengagedAtMs, nowMs, PREDICTOR_EVAL_WINDOW_DAYS)
    if (!decision.settled) { out.pending++; continue }

    const rec = await recordPredictorOutcome({
      brokerageId, predictor, contactId: sig.contact_id, won: decision.won,
      play: (sig.payload?.play as string | undefined) ?? null,
      severity: (sig.payload?.severity as string | undefined) ?? (sig.payload?.risk as string | undefined) ?? null,
    }, svc).catch(() => ({ ok: false }))
    if (!rec.ok) continue

    await svc.from("manager_signals").update({
      status: "resolved",
      consumed_action: `predictor outcome: ${predictor} ${decision.won ? "won (re-engaged)" : "lost (no re-engagement)"}`,
      consumed_at: new Date().toISOString(),
      payload: { ...(sig.payload ?? {}), outcome_recorded: true, outcome_won: decision.won },
    }).eq("id", sig.id).then(() => {}, () => {})

    if (decision.won) out.wins++; else out.losses++
  }

  return out
}
