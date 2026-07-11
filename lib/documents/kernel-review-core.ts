/**
 * lib/documents/kernel-review-core.ts
 *
 * ONE RESOLUTION CORE, EVERY FRONT-END — the document kernel's amber
 * proposals (deadline conflicts, stage candidates, autonomy ratchets)
 * resolve through THIS module whether the human clicks the Command
 * Center feed buttons (app/actions/document-kernel-review.ts) or SPEAKS
 * to the voice admin ("approve the stage move on Birch" —
 * lib/voice/team-commands.ts kernel_resolve). Two front-ends, zero
 * drift: the same writes, the same policy_decisions trail, the same
 * consumed_action record.
 *
 * Cores take an EXPLICIT actor (userId) — auth/role enforcement lives in
 * each front-end (cookie auth + REVIEW_ROLES in the server actions; the
 * voice tool registry's authority for the spoken admin).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { recordPolicyDecision } from "./policy-decisions"

type Svc = SupabaseClient<any, any, any>

export interface KernelActor {
  userId: string
  brokerageId: string
}

export const KERNEL_PROPOSAL_TYPES = [
  "deadline_conflict_finding",
  "stage_advance_candidate",
  "autonomy_ratchet_proposal",
] as const
export type KernelProposalType = (typeof KERNEL_PROPOSAL_TYPES)[number]

export interface KernelProposal {
  signalId: string
  signalType: KernelProposalType
  message: string
  payload: Record<string, unknown>
  createdAt: string
  /** deal address when the proposal is transaction-scoped (spoken listing). */
  address: string | null
}

/** The open kernel proposals for a brokerage, newest first — the voice
 *  admin numbers these ("number one, number two") and resolves by rank. */
export async function listOpenKernelProposals(
  svc: Svc,
  brokerageId: string,
  limit = 10,
): Promise<KernelProposal[]> {
  const { data } = await svc
    .from("manager_signals")
    .select("id, signal_type, message, payload, created_at")
    .eq("brokerage_id", brokerageId)
    .eq("status", "open")
    .in("signal_type", [...KERNEL_PROPOSAL_TYPES])
    .order("created_at", { ascending: false })
    .limit(limit)
  const rows = (data ?? []) as any[]
  if (rows.length === 0) return []

  // Resolve addresses for transaction-scoped proposals (one query).
  const txIds = Array.from(new Set(rows
    .map((r) => (r.payload?.transaction_id ? String(r.payload.transaction_id) : null))
    .filter(Boolean))) as string[]
  const addrById = new Map<string, string>()
  if (txIds.length > 0) {
    const { data: txs } = await svc
      .from("transactions")
      .select("id, brokerage_id, property_address")
      .eq("brokerage_id", brokerageId)
      .in("id", txIds)
    for (const t of ((txs ?? []) as any[])) {
      if (t.property_address) addrById.set(t.id, t.property_address)
    }
  }

  return rows.map((r) => ({
    signalId: r.id,
    signalType: r.signal_type,
    message: r.message,
    payload: (r.payload ?? {}) as Record<string, unknown>,
    createdAt: r.created_at,
    address: r.payload?.transaction_id ? (addrById.get(String(r.payload.transaction_id)) ?? null) : null,
  }))
}

export async function loadOpenSignal(
  svc: Svc,
  signalId: string,
  brokerageId: string,
  signalType: string,
): Promise<{ id: string; payload: Record<string, unknown> } | null> {
  const { data: sig } = await svc
    .from("manager_signals")
    .select("id, status, payload")
    .eq("id", signalId)
    .eq("brokerage_id", brokerageId)
    .eq("signal_type", signalType)
    .maybeSingle()
  if (!sig || (sig as any).status !== "open") return null
  return { id: (sig as any).id, payload: ((sig as any).payload ?? {}) as Record<string, unknown> }
}

export async function consumeSignal(svc: Svc, signalId: string, action: string): Promise<void> {
  await svc.from("manager_signals")
    .update({ status: "consumed", consumed_at: new Date().toISOString(), consumed_action: action })
    .eq("id", signalId)
}

export async function resolveDeadlineConflictCore(
  svc: Svc,
  actor: KernelActor,
  input: { signalId: string; adopt: boolean },
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const sig = await loadOpenSignal(svc, input.signalId, actor.brokerageId, "deadline_conflict_finding")
  if (!sig) return { ok: false, error: "Proposal not found or already resolved" }

  const p = sig.payload as {
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

export async function approveStageAdvanceCore(
  svc: Svc,
  actor: KernelActor,
  input: { signalId: string },
): Promise<{ ok: boolean; message?: string; blockers?: string[]; error?: string }> {
  const sig = await loadOpenSignal(svc, input.signalId, actor.brokerageId, "stage_advance_candidate")
  if (!sig) return { ok: false, error: "Proposal not found or already resolved" }

  const p = sig.payload as { transaction_id?: string; to_stage?: string; document_id?: string }
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

export async function dismissStageCandidateCore(
  svc: Svc,
  actor: KernelActor,
  input: { signalId: string },
): Promise<{ ok: boolean; message?: string; error?: string }> {
  const sig = await loadOpenSignal(svc, input.signalId, actor.brokerageId, "stage_advance_candidate")
  if (!sig) return { ok: false, error: "Proposal not found or already resolved" }
  const p = sig.payload as { transaction_id?: string; to_stage?: string; document_id?: string }

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
