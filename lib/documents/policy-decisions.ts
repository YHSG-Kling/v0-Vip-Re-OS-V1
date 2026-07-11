/**
 * lib/documents/policy-decisions.ts
 *
 * THE POLICY LEDGER — document kernel Phase A. Every gated action the
 * document kernel takes (or declines to take) records a green/amber/red
 * decision FIRST, with the reasons and evidence, so "why did the OS do
 * that" is always answerable from a ledger — the same provenance
 * discipline as decidedBy/built_by/generated_from everywhere else.
 *
 *   green — the evidence is strong and non-conflicting: act autonomously
 *           (additive writes only in Phase A — insert a missing deadline,
 *           stamp source provenance on a matching one).
 *   amber — the evidence is real but conflicts with what a human (or an
 *           earlier rail) recorded, or is only medium-confidence: raise a
 *           GATED proposal on the inter-manager bus; a human confirms.
 *   red   — the evidence isn't usable (no parseable date / low-confidence
 *           scan): record why and do nothing until a re-scan or a human
 *           classifies by hand.
 *
 * The verdict is PURE (unit-tested directly); recordPolicyDecision does
 * the write. Distinct from document_field_audit, which audits the FILL
 * direction (AI writing values INTO a generated form packet) — this
 * ledger governs the SCAN direction (facts extracted FROM an uploaded
 * document driving downstream action).
 */

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export type PolicyColor = "green" | "amber" | "red"

export interface PolicyVerdict {
  decision: PolicyColor
  reasons: string[]
  recommendedAction: string
  requiredApproverRole: string | null
}

/**
 * PURE: decide what the kernel may do with one document-derived deadline
 * date. Conflict with an existing tracked deadline ALWAYS ambers — the
 * kernel never silently moves a date a human (or the milestone seeder)
 * already owns, no matter how confident the scan was.
 */
export function decideDeadlinePolicy(input: {
  confidence: "high" | "medium" | "low"
  /** ISO date (YYYY-MM-DD) parsed from the document field, or null when unparseable. */
  derivedDate: string | null
  /** the date already tracked for this (transaction, deadline_type), if any. */
  existingDate: string | null
}): PolicyVerdict {
  if (!input.derivedDate) {
    return {
      decision: "red",
      reasons: ["the document field did not contain a usable date"],
      recommendedAction: "rescan_or_hand_classify",
      requiredApproverRole: null,
    }
  }
  if (input.existingDate && input.existingDate !== input.derivedDate) {
    return {
      decision: "amber",
      reasons: [
        `the document says ${input.derivedDate} but the tracked deadline is ${input.existingDate}`,
        `scan confidence: ${input.confidence}`,
      ],
      recommendedAction: "confirm_deadline_correction",
      requiredApproverRole: "tc",
    }
  }
  if (input.existingDate) {
    return {
      decision: "green",
      reasons: ["the document confirms the tracked deadline date"],
      recommendedAction: "stamp_source_provenance",
      requiredApproverRole: null,
    }
  }
  if (input.confidence === "high") {
    return {
      decision: "green",
      reasons: ["high-confidence scan and no deadline is tracked yet — inserting is additive"],
      recommendedAction: "insert_deadline",
      requiredApproverRole: null,
    }
  }
  if (input.confidence === "medium") {
    return {
      decision: "amber",
      reasons: ["medium-confidence scan — propose the deadline, a human confirms before it's tracked"],
      recommendedAction: "propose_deadline",
      requiredApproverRole: "tc",
    }
  }
  return {
    decision: "red",
    reasons: ["low-confidence scan — not usable evidence for a deadline"],
    recommendedAction: "rescan_or_hand_classify",
    requiredApproverRole: null,
  }
}

/** Write one decision to the policy ledger. Best-effort (never blocks the scan). */
export async function recordPolicyDecision(
  svc: Svc,
  input: {
    brokerageId: string
    transactionId?: string | null
    documentId?: string | null
    targetType: string
    targetId?: string | null
    verdict: PolicyVerdict
    evidence: Record<string, unknown>
  },
): Promise<{ recorded: boolean }> {
  const { error } = await svc.from("policy_decisions").insert({
    brokerage_id: input.brokerageId,
    transaction_id: input.transactionId ?? null,
    document_id: input.documentId ?? null,
    target_type: input.targetType,
    target_id: input.targetId ?? null,
    decision: input.verdict.decision,
    reasons_json: input.verdict.reasons,
    evidence_json: input.evidence,
    recommended_action: input.verdict.recommendedAction,
    required_approver_role: input.verdict.requiredApproverRole,
  })
  return { recorded: !error }
}
