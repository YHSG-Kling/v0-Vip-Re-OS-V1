/**
 * lib/documents/stage-candidates.ts
 *
 * POLICY-GATED STAGE CANDIDATES — document kernel Phase B. When a scanned
 * document lands on a deal, the evidence may mean the deal has MOVED:
 * the inspection report arriving during INSPECTION says "inspection is
 * done — appraisal is next"; the closing disclosure during
 * FINANCING_PENDING says "we're in closing prep". Today a human notices
 * (or doesn't) and clicks the stage forward. The kernel now NOTICES for
 * them — and PROPOSES, never moves:
 *
 *   · the candidate must be a legal move in the EXISTING strict state
 *     machine (STAGE_TRANSITIONS — no new lifecycle),
 *   · the REAL engine gate (canAdvanceStage: contract date, compliance,
 *     critical milestones) is consulted BEFORE proposing — a blocked
 *     candidate records a red policy decision with the actual blockers
 *     instead of spamming the bus,
 *   · a clean candidate records an amber policy decision and raises the
 *     gated stage_advance_candidate signal; the human approves on the
 *     Command Center feed, which drives the SAME advanceStage engine
 *     every manual click uses (jurisdiction checklists / required-docs
 *     audit already gate inside that rail — keep-one, no bypass).
 *
 * The evidence→candidate map is PURE and unit-tested.
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { STAGE_TRANSITIONS, type TransactionStage } from "@/lib/transactions/transaction-stages"
import { recordPolicyDecision } from "./policy-decisions"

type Svc = SupabaseClient<any, any, any>

/**
 * PURE: which stage does this document evidence support, from this stage?
 * Only forward moves the state machine allows; null when the evidence
 * doesn't assert progress (an addendum proves nothing about stage).
 */
export function decideStageCandidate(
  currentStage: string | null | undefined,
  documentClassifications: Set<string>,
): { toStage: TransactionStage; evidence: string } | null {
  const stage = (currentStage ?? "") as TransactionStage
  const legal = (to: TransactionStage) => (STAGE_TRANSITIONS[stage] ?? []).includes(to)

  if (stage === "UNDER_CONTRACT" && documentClassifications.has("earnest_money_receipt") && legal("INSPECTION")) {
    return { toStage: "INSPECTION", evidence: "earnest money is receipted — the deal is performing; inspection period is the active clock" }
  }
  if (stage === "INSPECTION" && documentClassifications.has("inspection_report") && legal("APPRAISAL")) {
    return { toStage: "APPRAISAL", evidence: "the inspection report is on file — inspection is done; appraisal is next" }
  }
  if (stage === "APPRAISAL" && documentClassifications.has("appraisal_report") && legal("FINANCING_PENDING")) {
    return { toStage: "FINANCING_PENDING", evidence: "the appraisal report is on file — financing approval is the remaining gate" }
  }
  if (stage === "FINANCING_PENDING" && documentClassifications.has("closing_disclosure") && legal("CLOSING_PREP")) {
    return { toStage: "CLOSING_PREP", evidence: "the closing disclosure arrived — the lender is preparing to close" }
  }
  return null
}

export interface StageCandidateResult {
  candidate: TransactionStage | null
  proposed: boolean
  blockedBy: string[]
  reason?: string
}

/**
 * Post-scan hook: does this document's arrival support a stage advance?
 * PROPOSES only — the human approves on the feed, driving the real
 * advanceStage engine. Idempotent (open-signal + 14d payload dedupe).
 */
export async function proposeStageCandidateFromDocument(
  svc: Svc,
  input: { documentId: string; brokerageId: string; transactionId: string | null },
): Promise<StageCandidateResult> {
  const none: StageCandidateResult = { candidate: null, proposed: false, blockedBy: [] }
  if (!input.transactionId) return { ...none, reason: "no transaction" }

  const { data: txn } = await svc
    .from("transactions")
    .select("id, stage, property_address")
    .eq("id", input.transactionId)
    .eq("brokerage_id", input.brokerageId)
    .maybeSingle()
  if (!txn?.stage) return { ...none, reason: "transaction has no stage (pre-contract)" }

  const { data: docs } = await svc
    .from("documents")
    .select("classification")
    .eq("transaction_id", input.transactionId)
    .not("classification", "is", null)
  const classifications = new Set(((docs ?? []) as Array<{ classification: string }>).map((d) => d.classification))

  const candidate = decideStageCandidate((txn as any).stage, classifications)
  if (!candidate) return { ...none, reason: "document evidence asserts no stage progress" }

  // Consult the REAL engine gate before proposing — same authority the
  // manual click hits, so a proposal is never a false promise.
  const { canAdvanceStage } = await import("@/lib/transactions/stage-progression")
  const gate = await canAdvanceStage(input.transactionId, (txn as any).stage, candidate.toStage, input.brokerageId)

  if (!gate.allowed) {
    await recordPolicyDecision(svc, {
      brokerageId: input.brokerageId,
      transactionId: input.transactionId,
      documentId: input.documentId,
      targetType: "transaction_stage",
      targetId: candidate.toStage,
      verdict: {
        decision: "red",
        reasons: gate.blockers,
        recommendedAction: "resolve_blockers_first",
        requiredApproverRole: null,
      },
      evidence: { from_stage: (txn as any).stage, evidence: candidate.evidence },
    })
    return { candidate: candidate.toStage, proposed: false, blockedBy: gate.blockers }
  }

  // Dedupe: an unactioned candidate for the same move inside 14 days stands.
  const dedupSince = new Date(Date.now() - 14 * 86_400_000).toISOString()
  const { data: dup } = await svc.from("manager_signals")
    .select("id")
    .eq("brokerage_id", input.brokerageId)
    .eq("signal_type", "stage_advance_candidate")
    .contains("payload", { transaction_id: input.transactionId, to_stage: candidate.toStage })
    .gte("created_at", dedupSince)
    .limit(1)
    .maybeSingle()
  if (dup) return { candidate: candidate.toStage, proposed: false, blockedBy: [], reason: "already proposed" }

  await recordPolicyDecision(svc, {
    brokerageId: input.brokerageId,
    transactionId: input.transactionId,
    documentId: input.documentId,
    targetType: "transaction_stage",
    targetId: candidate.toStage,
    verdict: {
      decision: "amber",
      reasons: [candidate.evidence, "all engine gates clear — awaiting human approval"],
      recommendedAction: "propose_stage_advance",
      requiredApproverRole: "tc",
    },
    evidence: { from_stage: (txn as any).stage, evidence: candidate.evidence },
  })

  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  const address = (txn as any).property_address ? ` on ${(txn as any).property_address}` : ""
  await publishManagerSignal({
    brokerageId: input.brokerageId,
    fromManager: "deal_coordinator",
    toManager: "compliance_officer",
    signalType: "stage_advance_candidate",
    message: `The deal${address} looks ready to move ${String((txn as any).stage).replace(/_/g, " ")} → ${candidate.toStage.replace(/_/g, " ")}: ${candidate.evidence}. Every engine gate is clear — approve to advance.`,
    entityType: "transaction",
    entityId: input.transactionId,
    payload: {
      transaction_id: input.transactionId,
      from_stage: (txn as any).stage,
      to_stage: candidate.toStage,
      document_id: input.documentId,
    },
  }, svc)

  return { candidate: candidate.toStage, proposed: true, blockedBy: [] }
}
