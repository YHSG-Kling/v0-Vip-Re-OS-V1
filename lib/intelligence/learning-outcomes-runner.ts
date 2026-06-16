// lib/intelligence/learning-outcomes-runner.ts
//
// Live recorder/loader for LEARNING OUTCOMES — persists each learner's win/loss onto the existing
// ai_feedback_log (no new table), keyed by system + entity (contact OR lead). The conductors +
// consensus memory read accumulated history from here so they learn over time, not just per run.
// Best-effort; never throws.

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { outcomeToRating, ratingToOutcome, type OutcomeKind, type LearningEntity } from "./learning-outcomes"

type Svc = ReturnType<typeof createServiceClient>

export interface RecordOutcomeInput {
  brokerageId: string
  /** which learner produced this (e.g. "second_opinion:price_drop", "relationship_outcome"). */
  system: string
  outcome: OutcomeKind
  /** the record this is about — entity-aware so leads AND contacts are tracked. */
  entityType?: LearningEntity
  entityId?: string | null
  agentId?: string | null
  label?: string | null
  detail?: Record<string, unknown> | null
}

export async function recordLearningOutcome(input: RecordOutcomeInput, client?: Svc): Promise<{ ok: boolean; id?: string }> {
  const svc = client ?? createServiceClient()
  const { data, error } = await svc.from("ai_feedback_log").insert({
    brokerage_id: input.brokerageId,
    agent_id: input.agentId ?? null,
    source_system: input.system,
    source_record_id: input.entityId ?? null,
    source_record_type: input.entityType ?? null,
    rating: outcomeToRating(input.outcome),
    feedback_text: input.label ?? input.outcome,
    context_snapshot: input.detail ?? null,
    created_at: new Date().toISOString(),
  }).select("id").maybeSingle()
  if (error || !data) return { ok: false }
  return { ok: true, id: (data as any).id }
}

export interface LoadedOutcome {
  outcome: OutcomeKind
  entityType: LearningEntity | null
  entityId: string | null
  detail: Record<string, unknown> | null
  at: string
}

export async function loadLearningOutcomes(
  svc: Svc, brokerageId: string, opts: { system: string; sinceDays?: number; entityType?: LearningEntity },
): Promise<LoadedOutcome[]> {
  const since = new Date(Date.now() - (opts.sinceDays ?? 180) * 86_400_000).toISOString()
  let q = svc.from("ai_feedback_log")
    .select("rating, source_record_type, source_record_id, context_snapshot, created_at")
    .eq("brokerage_id", brokerageId)
    .eq("source_system", opts.system)
    .gte("created_at", since)
    .limit(5000)
  if (opts.entityType) q = q.eq("source_record_type", opts.entityType)
  const { data } = await q
  return ((data ?? []) as any[]).map((r) => ({
    outcome: ratingToOutcome(r.rating),
    entityType: (r.source_record_type ?? null) as LearningEntity | null,
    entityId: r.source_record_id ?? null,
    detail: r.context_snapshot ?? null,
    at: r.created_at,
  }))
}
