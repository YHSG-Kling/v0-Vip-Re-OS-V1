// lib/kernel/consensus-memory-runner.ts
//
// Live side of CONSENSUS MEMORY — the readers that make the huddle learn from accumulated HISTORY,
// not just whatever's live right now. As a consulted manager's second opinions are proven right or
// wrong by the eventual outcome, each verdict is recorded onto the existing ai_feedback_log (system
// "second_opinion:<play>", with the consulted manager in context_snapshot). getConsultTrackRecord
// reads that history back and runs it through the pure consensus math (accuracy → confidence →
// weight), so requestSecondOpinion can tell the huddle whose read has earned trust on this play.
// Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { consultAccuracy, consultConfidence, consultWeight, consultSystem, type ConsultOutcome, type ConsultTrackRecord } from "./consensus-memory"
import { recordLearningOutcome, loadLearningOutcomes } from "@/lib/intelligence/learning-outcomes-runner"
import type { LearningEntity } from "@/lib/intelligence/learning-outcomes"

type Svc = ReturnType<typeof createServiceClient>

/**
 * Read a consulted manager's accumulated track record on a play from ai_feedback_log and run it
 * through the pure consensus math. Neutral outcomes (no clear right/wrong yet) don't count as calls.
 */
export async function getConsultTrackRecord(
  svc: Svc, brokerageId: string, opts: { consult: string; playType: string; sinceDays?: number },
): Promise<ConsultTrackRecord> {
  const history = await loadLearningOutcomes(svc, brokerageId, { system: consultSystem(opts.playType), sinceDays: opts.sinceDays ?? 365 })
  const records: ConsultOutcome[] = history
    .filter((h) => ((h.detail as any)?.consult ?? null) === opts.consult && h.outcome !== "neutral")
    .map((h) => ({ correct: h.outcome === "win" }))
  const accuracy = consultAccuracy(records)
  const confidence = consultConfidence(accuracy)
  return {
    consult: opts.consult,
    playType: opts.playType,
    calls: accuracy.calls,
    accuracy: accuracy.accuracy,
    confidence,
    weight: consultWeight(confidence),
  }
}

/**
 * Record the eventual verdict on a manager's second opinion (was it proven correct?) so the huddle's
 * track record on this play grows over time. Keyed by the consulted manager in context_snapshot.
 */
export async function recordConsultOutcome(
  input: { brokerageId: string; consult: string; playType: string; correct: boolean; entityType?: LearningEntity; entityId?: string | null; agentId?: string | null },
  client?: Svc,
): Promise<{ ok: boolean }> {
  const r = await recordLearningOutcome({
    brokerageId: input.brokerageId,
    system: consultSystem(input.playType),
    outcome: input.correct ? "win" : "loss",
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    agentId: input.agentId ?? null,
    label: `${input.consult} second opinion ${input.correct ? "proven right" : "proven wrong"}`,
    detail: { consult: input.consult, playType: input.playType, correct: input.correct },
  }, client)
  return { ok: r.ok }
}

// Re-export the pure helpers so callers can pull namespace/phrasing from the runner too.
export { consultSystem, describeTrackRecord, type ConsultTrackRecord } from "./consensus-memory"
