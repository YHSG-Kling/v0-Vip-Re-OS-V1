// lib/intelligence/predictor-learning-runner.ts
//
// Live side of PREDICTOR LEARNING — records each predictor play's outcome onto the existing
// ai_feedback_log (system "predictor:<name>", keyed by the contact) and reads the accumulated record
// back as PER-BROKERAGE tuning the predictor runners consult before firing. Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { recordLearningOutcome, loadLearningOutcomes } from "./learning-outcomes-runner"
import { predictorTuning, type PredictorTuning } from "./predictor-learning"

type Svc = ReturnType<typeof createServiceClient>

export type PredictorName = "buyer_stall" | "listing_stall" | "dual_transaction" | "stuck_stage"

export function predictorSystem(name: PredictorName): string {
  return `predictor:${name}`
}

/**
 * Record whether a predictor play worked: the contact re-engaged after the gated play (win) or didn't
 * (loss). Keyed by the contact so a play and its outcome line up. The `play`/`severity` ride
 * context_snapshot for later analysis.
 */
export async function recordPredictorOutcome(
  input: { brokerageId: string; predictor: PredictorName; contactId: string; won: boolean; play?: string | null; severity?: string | null },
  client?: Svc,
): Promise<{ ok: boolean }> {
  const r = await recordLearningOutcome({
    brokerageId: input.brokerageId,
    system: predictorSystem(input.predictor),
    outcome: input.won ? "win" : "loss",
    entityType: "contact",
    entityId: input.contactId,
    label: `${input.predictor} ${input.play ?? "play"} ${input.won ? "re-engaged" : "did not re-engage"}`,
    detail: { predictor: input.predictor, play: input.play ?? null, severity: input.severity ?? null, won: input.won },
  }, client)
  return { ok: r.ok }
}

/** Load a predictor's accumulated record for a brokerage and compute its tuning. Read-only. */
export async function getPredictorTuning(
  svc: Svc, brokerageId: string, predictor: PredictorName, opts?: { sinceDays?: number },
): Promise<PredictorTuning> {
  const outcomes = await loadLearningOutcomes(svc, brokerageId, { system: predictorSystem(predictor), sinceDays: opts?.sinceDays ?? 365 })
  let wins = 0, losses = 0
  for (const o of outcomes) {
    if (o.outcome === "win") wins++
    else if (o.outcome === "loss") losses++
  }
  return predictorTuning(wins, losses)
}
