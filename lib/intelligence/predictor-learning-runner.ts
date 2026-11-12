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

export const PREDICTOR_NAMES: readonly PredictorName[] = ["buyer_stall", "listing_stall", "dual_transaction", "stuck_stage"]

/** The record (wins / losses) and the tuning it derives. Read-only. */
async function recordAndTuning(svc: Svc, brokerageId: string, predictor: PredictorName, sinceDays: number): Promise<{ wins: number; losses: number; tuning: PredictorTuning }> {
  const outcomes = await loadLearningOutcomes(svc, brokerageId, { system: predictorSystem(predictor), sinceDays })
  let wins = 0, losses = 0
  for (const o of outcomes) {
    if (o.outcome === "win") wins++
    else if (o.outcome === "loss") losses++
  }
  return { wins, losses, tuning: predictorTuning(wins, losses) }
}

/**
 * A PROMOTED threshold (wave 104C): brokerage_settings.settings.predictor_tuning[predictor] — written
 * only by lib/kernel/improvement-proposals.ts promotion / rollback (policy key `predictor_tuning`).
 * null = no override (or the read was refused — then the record-derived tuning stands, as before).
 */
async function promotedPredictorOverride(svc: Svc, brokerageId: string, predictor: PredictorName): Promise<{ thresholdMultiplier: number; requireStrongest: boolean } | null> {
  const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error || !data) return null
  const all = ((data as { settings?: Record<string, unknown> }).settings ?? {}).predictor_tuning as Record<string, unknown> | undefined
  const o = all && typeof all === "object" ? (all[predictor] as { thresholdMultiplier?: unknown; requireStrongest?: unknown } | undefined) : undefined
  if (!o || typeof o.thresholdMultiplier !== "number") return null
  return { thresholdMultiplier: o.thresholdMultiplier, requireStrongest: o.requireStrongest === true }
}

/**
 * Load a predictor's accumulated record for a brokerage and compute its tuning. Read-only.
 * CONTROLLED LEARNING (104C): a PROMOTED override wins over the record-derived tuning — the
 * record-derived raise-the-bar stays as the conservative default (it never widens autonomy), but
 * what the tenant promoted / rolled back on the Manager Trust page is what fires.
 */
export async function getPredictorTuning(
  svc: Svc, brokerageId: string, predictor: PredictorName, opts?: { sinceDays?: number },
): Promise<PredictorTuning> {
  const { tuning } = await recordAndTuning(svc, brokerageId, predictor, opts?.sinceDays ?? 365)
  const override = await promotedPredictorOverride(svc, brokerageId, predictor)
  if (!override) return tuning
  return { ...tuning, thresholdMultiplier: override.thresholdMultiplier, requireStrongest: override.requireStrongest, why: `promoted override (×${override.thresholdMultiplier}, strongest=${override.requireStrongest}); record: ${tuning.why}` }
}

/**
 * CONTROLLED LEARNING PROPOSER (104C). Today the raise-the-bar tuning is applied SILENTLY at fire
 * time (getPredictorTuning → shouldFireWithTuning) with no actor, no version and no way to put it
 * back. This writes the SAME change as a `threshold` proposal (lib/kernel/improvement-proposals.ts)
 * whenever the record is proven (not `unproven`) and no promoted override already equals it; the
 * deterministic evaluator re-derives the tuning from the record, a human promotes it on the
 * Manager Trust page (authority 4 — no manager auto-promotes a threshold today). Never throws.
 */
export async function proposePredictorTuning(
  svc: Svc, brokerageId: string, predictor: PredictorName, opts?: { sinceDays?: number },
): Promise<{ proposed: boolean; status: string | null; reason: string }> {
  try {
    const { wins, losses, tuning } = await recordAndTuning(svc, brokerageId, predictor, opts?.sinceDays ?? 365)
    if (tuning.confidence === "unproven") return { proposed: false, status: null, reason: tuning.why }
    const override = await promotedPredictorOverride(svc, brokerageId, predictor)
    if (override && override.thresholdMultiplier === tuning.thresholdMultiplier && override.requireStrongest === tuning.requireStrongest) {
      return { proposed: false, status: null, reason: "the promoted override already equals the record-derived tuning" }
    }
    const { proposeEvaluatePromote } = await import("@/lib/kernel/improvement-proposals")
    const r = await proposeEvaluatePromote(svc, {
      brokerageId, subjectKind: "threshold", subjectKey: predictorSystem(predictor), proposer: "predictor_learning",
      proposedChange: { predictor, thresholdMultiplier: tuning.thresholdMultiplier, requireStrongest: tuning.requireStrongest, record: { wins, losses }, why: tuning.why },
      evidenceRefs: [{ kind: "ai_feedback_log", system: predictorSystem(predictor), wins, losses, sinceDays: opts?.sinceDays ?? 365 }],
    })
    return { proposed: r.proposal.ok, status: r.status, reason: r.held ?? (r.proposal.ok ? "recorded" : r.proposal.error) }
  } catch (e) {
    return { proposed: false, status: null, reason: (e as Error)?.message ?? String(e) }
  }
}
