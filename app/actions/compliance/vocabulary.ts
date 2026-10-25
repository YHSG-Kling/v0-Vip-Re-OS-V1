"use server"

/**
 * app/actions/compliance/vocabulary.ts — the doors of VOCABULARY SELF-HEALING (wave 144, lane 144A; owner
 * ruling 1). Every export is a public HTTP endpoint (CLAUDE.md §4): async, tenant from the SESSION
 * (requireCallerTenant — no argument names a brokerage), gate first, then the service client. The
 * decisions live in lib/compliance/vocabulary-healing.ts over the controlled-learning kernel.
 *
 *   reportVocabularyGapAction(report)     any member of the brokerage: "this label is missing / obsolete /
 *                                          different in my state" → the evaluation, and (when it implies a
 *                                          change) ONE validated proposal. Nothing is applied.
 *   approveVocabularyProposalAction(id)   a tenant admin (a compliance approver for a state-scoped change):
 *                                          approve → promote → attest → verify.
 *   rejectVocabularyProposalAction(id)    a tenant admin: EVALUATED → REJECTED through the same kernel.
 *   attestVocabularyTermAction(dim, key)  a compliance approver: attest a state-scoped term promoted elsewhere.
 *   reportComingSoonPolicyAction(report)  any member: record the MLS's coming-soon rule WITH its published source →
 *                                          ONE proposal a compliance approver approves (approveVocabularyProposalAction).
 */

import { revalidatePath } from "next/cache"
import { requireCallerTenant } from "@/lib/auth/require-caller"
import { isTenantAdminGrantRole } from "@/lib/auth/resolve-user-role"
import { createServiceClient } from "@/lib/supabase/service"
import { decideProposal, loadProposal } from "@/lib/kernel/improvement-proposals"
import { ADAPTIVE_VOCABULARY_POLICY_KEY, type VocabularyDimension, type VocabularyReport } from "@/lib/compliance/adaptive-vocabulary"
import { COMING_SOON_POLICY_KEY, type ComingSoonPolicyReport } from "@/lib/compliance/coming-soon-policy"
import {
  approveVocabularyProposal, attestVocabularyEntry, reportComingSoonPolicy, reportVocabularyGap,
  type ApproveVocabularyResult, type ReportComingSoonPolicyResult, type ReportVocabularyGapResult,
} from "@/lib/compliance/vocabulary-healing"

const SETTINGS_PATH = "/dashboard/settings/required-documents"
const REPORT_KINDS = new Set(["missing", "obsolete", "different_in_state", "rename"])
const clip = (v: unknown, n: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : null)

export async function reportVocabularyGapAction(input: VocabularyReport): Promise<ReportVocabularyGapResult> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  const kind = String(input?.kind ?? "")
  if (!REPORT_KINDS.has(kind)) return { ok: false, error: "Say whether the label is missing, obsolete, different in your state, or needs a new name." }
  const report: VocabularyReport = {
    dimension: String(input?.dimension ?? ""),
    label: clip(input?.label, 80) ?? "",
    kind: kind as VocabularyReport["kind"],
    stateCode: clip(input?.stateCode, 2)?.toUpperCase() ?? null,
    sameAs: clip(input?.sameAs, 80),
    rollsUpTo: clip(input?.rollsUpTo, 60),
    newLabel: clip(input?.newLabel, 80),
    sourceUrl: clip(input?.sourceUrl, 500),
    sourceTitle: clip(input?.sourceTitle, 200),
    note: clip(input?.note, 280),
  }
  const r = await reportVocabularyGap(createServiceClient(), { brokerageId: caller.brokerageId, reporterUserId: caller.userId, report })
  if (r.ok && r.outcome === "proposed") revalidatePath(SETTINGS_PATH)
  return r
}

export async function approveVocabularyProposalAction(proposalId: string): Promise<ApproveVocabularyResult> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  if (!isTenantAdminGrantRole(caller.userType)) return { ok: false, error: "Only a broker, owner, admin, team lead or compliance officer approves a vocabulary change." }
  const r = await approveVocabularyProposal(createServiceClient(), {
    brokerageId: caller.brokerageId, proposalId: String(proposalId ?? ""),
    approver: { userId: caller.userId, userType: caller.userType, isTenantAdmin: true },
  })
  revalidatePath(SETTINGS_PATH)
  revalidatePath("/dashboard/admin/manager-trust")
  return r
}

export async function rejectVocabularyProposalAction(proposalId: string, reason?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  if (!isTenantAdminGrantRole(caller.userType)) return { ok: false, error: "Only a broker, owner, admin, team lead or compliance officer rejects a vocabulary change." }
  const svc = createServiceClient()
  // This door decides VOCABULARY proposals only — every other proposal is decided on Manager Trust.
  const got = await loadProposal(svc, caller.brokerageId, String(proposalId ?? ""))
  if (!got.ok) return { ok: false, error: got.error }
  if (got.row.subject_kind !== "policy" || (got.row.subject_key !== ADAPTIVE_VOCABULARY_POLICY_KEY && got.row.subject_key !== COMING_SOON_POLICY_KEY)) return { ok: false, error: "That proposal is not a vocabulary or coming-soon change." }
  const r = await decideProposal(svc, {
    brokerageId: caller.brokerageId, id: String(proposalId ?? ""), decision: "reject",
    actor: { type: "user", userId: caller.userId, isTenantAdmin: true, reason: clip(reason, 280) ?? "vocabulary change rejected from the required-documents settings" },
    reason: clip(reason, 280) ?? "vocabulary change rejected from the required-documents settings",
  })
  revalidatePath(SETTINGS_PATH)
  return r.ok ? { ok: true } : { ok: false, error: r.error }
}

export async function attestVocabularyTermAction(dimension: VocabularyDimension, key: string): Promise<{ ok: true; why: string } | { ok: false; error: string }> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  const r = await attestVocabularyEntry(createServiceClient(), {
    brokerageId: caller.brokerageId, dimension, key: String(key ?? ""),
    approver: { userId: caller.userId, userType: caller.userType, isTenantAdmin: isTenantAdminGrantRole(caller.userType) },
  })
  revalidatePath(SETTINGS_PATH)
  return r
}

export async function reportComingSoonPolicyAction(input: ComingSoonPolicyReport): Promise<ReportComingSoonPolicyResult> {
  const caller = await requireCallerTenant()
  if (!caller.ok) return { ok: false, error: caller.error }
  const bool = (v: unknown) => (v === true || v === false ? v : null)
  const r = await reportComingSoonPolicy(createServiceClient(), {
    brokerageId: caller.brokerageId, reporterUserId: caller.userId,
    report: {
      mlsName: clip(input?.mlsName, 80) ?? "",
      stateCodes: Array.isArray(input?.stateCodes) ? input.stateCodes.slice(0, 10).map((s) => String(s ?? "").slice(0, 2)) : [],
      permitted: bool(input?.permitted), showingsPermitted: bool(input?.showingsPermitted),
      maxDays: input?.maxDays ?? null, mlsSubmissionWithinBusinessDays: input?.mlsSubmissionWithinBusinessDays ?? null,
      sourceUrl: clip(input?.sourceUrl, 500), ruleRef: clip(input?.ruleRef, 120), sourceTitle: clip(input?.sourceTitle, 200),
    },
  })
  if (r.ok) revalidatePath(SETTINGS_PATH)
  return r
}
