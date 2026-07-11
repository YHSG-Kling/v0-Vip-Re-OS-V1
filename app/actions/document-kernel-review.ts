"use server"

/**
 * app/actions/document-kernel-review.ts
 *
 * THE HUMAN'S SIDE OF THE DOCUMENT KERNEL — the amber proposals the
 * kernel raises on the manager bus become one-click decisions on the
 * Command Center feed, and every decision lands back in the SAME ledgers
 * the kernel writes (policy_decisions + signal consumed_action), so the
 * green/amber/red trail stays complete through the human hop:
 *
 *   resolveDeadlineConflictAction — adopt the document's date (updates /
 *     inserts on the existing transaction_deadlines rail with source
 *     provenance) or keep the tracked date; either way the conflict is
 *     resolved by a NAMED human and the signal is consumed.
 *   approveStageAdvanceAction — drives the REAL advanceStage engine (the
 *     same state machine + milestone + compliance gates as the manual
 *     click; blockers surface honestly instead of half-moving).
 *   dismissStageCandidateAction — "not yet", recorded, signal consumed.
 *
 * Auth-first: the actor must belong to the signal's brokerage and hold a
 * stage-transition role (agent/tc/broker/admin).
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { recordPolicyDecision } from "@/lib/documents/policy-decisions"

const REVIEW_ROLES = new Set(["agent", "tc", "broker", "admin", "super_admin"])

async function loadActor(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Not authenticated" }
  const { data: row } = await supabase
    .from("users")
    .select("brokerage_id, user_type, role")
    .eq("id", user.id)
    .maybeSingle()
  const role = String((row as any)?.role ?? (row as any)?.user_type ?? "")
  if (!row?.brokerage_id) return { ok: false, error: "No brokerage" }
  if (!REVIEW_ROLES.has(role)) return { ok: false, error: "Not permitted to review kernel proposals" }
  return { ok: true, userId: user.id, brokerageId: (row as any).brokerage_id }
}

async function loadOpenSignal(
  svc: ReturnType<typeof createServiceClient>,
  signalId: string,
  brokerageId: string,
  signalType: string,
) {
  const { data: sig } = await svc
    .from("manager_signals")
    .select("id, brokerage_id, signal_type, status, payload")
    .eq("id", signalId)
    .eq("brokerage_id", brokerageId)
    .eq("signal_type", signalType)
    .maybeSingle()
  if (!sig) return null
  if ((sig as any).status !== "open") return null
  return sig as any
}

async function consumeSignal(
  svc: ReturnType<typeof createServiceClient>,
  signalId: string,
  action: string,
) {
  await svc.from("manager_signals")
    .update({ status: "consumed", consumed_at: new Date().toISOString(), consumed_action: action })
    .eq("id", signalId)
}

export async function resolveDeadlineConflictAction(input: {
  signalId: string
  adopt: boolean
}): Promise<{ ok: boolean; message?: string; error?: string }> {
  const actor = await loadActor()
  if (!actor.ok) return { ok: false, error: actor.error }
  const svc = createServiceClient()

  const sig = await loadOpenSignal(svc, input.signalId, actor.brokerageId, "deadline_conflict_finding")
  if (!sig) return { ok: false, error: "Proposal not found or already resolved" }

  const p = (sig.payload ?? {}) as {
    transaction_id?: string; deadline_type?: string; proposed_date?: string
    current_date?: string | null; document_id?: string; field_key?: string
  }
  if (!p.transaction_id || !p.deadline_type || !p.proposed_date) {
    return { ok: false, error: "Proposal payload is incomplete" }
  }

  let message: string
  if (input.adopt) {
    const { data: existing } = await svc
      .from("transaction_deadlines")
      .select("id, notes")
      .eq("transaction_id", p.transaction_id)
      .eq("deadline_type", p.deadline_type)
      .maybeSingle()
    if (existing) {
      const { error } = await svc.from("transaction_deadlines").update({
        deadline_date: p.proposed_date,
        source_document_id: p.document_id ?? null,
        source_field_key: p.field_key ?? null,
        notes: [((existing as any).notes as string | null) ?? null, `Corrected to ${p.proposed_date} from the scanned document (human-approved).`]
          .filter(Boolean).join(" "),
      }).eq("id", (existing as any).id)
      if (error) return { ok: false, error: error.message }
    } else {
      const { error } = await svc.from("transaction_deadlines").insert({
        transaction_id: p.transaction_id,
        brokerage_id: actor.brokerageId,
        deadline_type: p.deadline_type,
        deadline_date: p.proposed_date,
        status: "pending",
        source_document_id: p.document_id ?? null,
        source_field_key: p.field_key ?? null,
        notes: "Added from the scanned document (human-approved kernel proposal).",
      })
      if (error) return { ok: false, error: error.message }
    }
    message = `Adopted the document's date — ${p.deadline_type.replace(/_/g, " ")} is now ${p.proposed_date}.`
  } else {
    message = `Kept the tracked date${p.current_date ? ` (${p.current_date})` : ""} — the document's ${p.proposed_date} was declined.`
  }

  await recordPolicyDecision(svc, {
    brokerageId: actor.brokerageId,
    transactionId: p.transaction_id,
    documentId: p.document_id ?? null,
    targetType: "transaction_deadline",
    targetId: p.deadline_type,
    verdict: {
      decision: "green",
      reasons: [input.adopt ? "human adopted the document's date" : "human kept the tracked date"],
      recommendedAction: input.adopt ? "human_adopted_document_date" : "human_kept_tracked_date",
      requiredApproverRole: null,
    },
    evidence: { resolved_by_user_id: actor.userId, proposed_date: p.proposed_date, current_date: p.current_date ?? null },
  })
  await consumeSignal(svc, input.signalId, message)
  return { ok: true, message }
}

export async function approveStageAdvanceAction(input: {
  signalId: string
}): Promise<{ ok: boolean; message?: string; blockers?: string[]; error?: string }> {
  const actor = await loadActor()
  if (!actor.ok) return { ok: false, error: actor.error }
  const svc = createServiceClient()

  const sig = await loadOpenSignal(svc, input.signalId, actor.brokerageId, "stage_advance_candidate")
  if (!sig) return { ok: false, error: "Proposal not found or already resolved" }

  const p = (sig.payload ?? {}) as { transaction_id?: string; to_stage?: string; document_id?: string }
  if (!p.transaction_id || !p.to_stage) return { ok: false, error: "Proposal payload is incomplete" }

  // The SAME engine every manual stage click uses — state machine, critical
  // milestones, compliance gates all hold. No kernel bypass.
  const { advanceStage } = await import("@/lib/transactions/stage-progression")
  const result = await advanceStage({
    transactionId: p.transaction_id,
    targetStage: p.to_stage as any,
    brokerageId: actor.brokerageId,
    userId: actor.userId,
    reason: "Approved document-kernel stage candidate",
  })

  if (!result.success) {
    // Honest failure: the deal changed since the proposal — surface the real
    // blockers, leave the signal open so the human can act after fixing them.
    return { ok: false, blockers: result.blockers, error: result.error ?? "Stage advance blocked" }
  }

  await recordPolicyDecision(svc, {
    brokerageId: actor.brokerageId,
    transactionId: p.transaction_id,
    documentId: p.document_id ?? null,
    targetType: "transaction_stage",
    targetId: p.to_stage,
    verdict: {
      decision: "green",
      reasons: ["human approved the stage candidate; the stage engine advanced the deal"],
      recommendedAction: "stage_advanced",
      requiredApproverRole: null,
    },
    evidence: { approved_by_user_id: actor.userId, new_stage: result.newStage },
  })
  const message = `Advanced to ${String(p.to_stage).replace(/_/g, " ")}.`
  await consumeSignal(svc, input.signalId, message)
  return { ok: true, message }
}

export async function dismissStageCandidateAction(input: {
  signalId: string
}): Promise<{ ok: boolean; message?: string; error?: string }> {
  const actor = await loadActor()
  if (!actor.ok) return { ok: false, error: actor.error }
  const svc = createServiceClient()

  const sig = await loadOpenSignal(svc, input.signalId, actor.brokerageId, "stage_advance_candidate")
  if (!sig) return { ok: false, error: "Proposal not found or already resolved" }
  const p = (sig.payload ?? {}) as { transaction_id?: string; to_stage?: string; document_id?: string }

  await recordPolicyDecision(svc, {
    brokerageId: actor.brokerageId,
    transactionId: p.transaction_id ?? null,
    documentId: p.document_id ?? null,
    targetType: "transaction_stage",
    targetId: p.to_stage ?? null,
    verdict: {
      decision: "green",
      reasons: ["human declined the stage candidate — not yet"],
      recommendedAction: "stage_candidate_dismissed",
      requiredApproverRole: null,
    },
    evidence: { dismissed_by_user_id: actor.userId },
  })
  const message = "Not yet — the human is keeping the deal at its current stage."
  await consumeSignal(svc, input.signalId, message)
  return { ok: true, message }
}
