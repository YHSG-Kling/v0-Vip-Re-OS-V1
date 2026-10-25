"use server"

/**
 * app/actions/commission-policy/commission-policy.ts — the AGENT CONCESSION requests and the brokerage's PAYOUT / CONCESSION
 * POLICY (wave 144, lane 144D; owner rulings 4 and 8, 2026-10-25).
 *
 * Every export is a public endpoint (CLAUDE.md §4): async, tenant from the SESSION (requireAuth → brokerageId), never from a
 * body. The finance-admin facts are resolved here once from the session's own ids (resolveTenantPrincipalTeamLead — FAILS
 * CLOSED on a refused read). The writes run on the service client AFTER the gate (lib/kernel/manager-registry.ts pattern).
 * The rules and the writer live in lib/commission/agent-concession.ts; the payout gate's rule in
 * lib/transactions/cda-closing-policy.ts. Nothing here computes money — the deterministic waterfall does.
 */

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { isBrokerageFinanceAdmin, resolveTenantPrincipalTeamLead } from "@/lib/auth/resolve-user-role"
import { revalidatePath } from "next/cache"
import type { AgentConcessionBeneficiary } from "@/lib/commission/agent-concession"

type ActionResult<T> = ({ success: true } & T) | { success: false; error: string }

async function sessionActor() {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { ok: false as const, error: "unauthenticated" }
  const principal = await resolveTenantPrincipalTeamLead(supabase as never, auth.userId, auth.brokerageId)
  if (!principal.ok) return { ok: false as const, error: `role_unresolved: ${principal.reason}` }
  return {
    ok: true as const,
    actor: {
      userId: auth.userId,
      agentId: auth.agentId,
      brokerageId: auth.brokerageId,
      userType: auth.userType,
      isTenantPrincipal: principal.isPrincipal,
    },
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// ─── Agent concessions (owner ruling 4) ────────────────────────────────────────────────────────────────────────────

/** An agent asks (or, where the brokerage requires no approval, records) a concession off their own gross commission. */
export async function requestAgentConcessionAction(input: {
  transactionId: string
  beneficiary: AgentConcessionBeneficiary
  beneficiaryName?: string | null
  amount: number
  valueType: "flat" | "percent"
  reason: string
}): Promise<ActionResult<{ concessionId: string; requiresApproval: boolean }>> {
  if (!UUID.test(String(input?.transactionId ?? ""))) return { success: false, error: "invalid_transaction" }
  const s = await sessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { requestAgentConcession } = await import("@/lib/commission/agent-concession")
  const r = await requestAgentConcession(createServiceClient() as never, s.actor, {
    transactionId: input.transactionId,
    beneficiary: input.beneficiary,
    beneficiaryName: input.beneficiaryName ?? null,
    amount: Number(input.amount),
    valueType: input.valueType,
    reason: String(input.reason ?? ""),
  })
  if (!r.ok) return { success: false, error: r.error }
  revalidatePath(`/dashboard/transactions/${input.transactionId}/cda`)
  return { success: true, concessionId: r.record.id, requiresApproval: r.requiresApproval }
}

/** A finance admin approves or denies a requested concession (before it is committed). */
export async function decideAgentConcessionAction(input: {
  concessionId: string
  decision: "approved" | "denied"
  note?: string | null
}): Promise<ActionResult<{ approvalStatus: string }>> {
  if (!UUID.test(String(input?.concessionId ?? ""))) return { success: false, error: "invalid_concession" }
  const s = await sessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { decideAgentConcession } = await import("@/lib/commission/agent-concession")
  const r = await decideAgentConcession(createServiceClient() as never, s.actor, {
    adjustmentId: input.concessionId,
    decision: input.decision,
    note: input.note ?? null,
  })
  if (!r.ok) return { success: false, error: r.error }
  revalidatePath(`/dashboard/transactions/${r.record.transactionId}/cda`)
  return { success: true, approvalStatus: r.record.approvalStatus }
}

/** The requesting agent withdraws their own still-pending request. */
export async function withdrawAgentConcessionAction(input: { concessionId: string }): Promise<ActionResult<{ approvalStatus: string }>> {
  if (!UUID.test(String(input?.concessionId ?? ""))) return { success: false, error: "invalid_concession" }
  const s = await sessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { withdrawAgentConcession } = await import("@/lib/commission/agent-concession")
  const r = await withdrawAgentConcession(createServiceClient() as never, s.actor, { adjustmentId: input.concessionId })
  if (!r.ok) return { success: false, error: r.error }
  revalidatePath(`/dashboard/transactions/${r.record.transactionId}/cda`)
  return { success: true, approvalStatus: r.record.approvalStatus }
}

/**
 * The deal's agent concessions + the brokerage's policy, for the CDA page. An agent sees the concessions of a deal they
 * are on; a finance admin sees any deal's in their brokerage (agents never see another agent's money — §5).
 */
export async function listAgentConcessionsAction(transactionId: string): Promise<ActionResult<{
  concessions: Array<{
    id: string; concessionAgentId: string | null; beneficiary: string | null; beneficiaryName: string | null; valueType: string; value: number
    reason: string | null; approvalStatus: string; approvalLabel: string; approvalNote: string | null; settlementTreatment: string | null; mine: boolean
  }>
  requiresApproval: boolean
  policyDeclared: boolean
  canDecide: boolean
}>> {
  if (!UUID.test(String(transactionId ?? ""))) return { success: false, error: "invalid_transaction" }
  const s = await sessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const canDecide = isBrokerageFinanceAdmin({ user_type: s.actor.userType, is_tenant_principal: s.actor.isTenantPrincipal })
  if (!canDecide) {
    const { data: tx, error } = await svc
      .from("transactions")
      .select("agent_id, buyer_agent_id, seller_agent_id")
      .eq("id", transactionId)
      .eq("brokerage_id", s.actor.brokerageId)
      .maybeSingle()
    if (error) return { success: false, error: `transaction_read_refused: ${error.message}` }
    const t = (tx ?? {}) as { agent_id?: string | null; buyer_agent_id?: string | null; seller_agent_id?: string | null }
    if (!s.actor.agentId || ![t.agent_id, t.buyer_agent_id, t.seller_agent_id].includes(s.actor.agentId)) return { success: false, error: "forbidden" }
  }
  const { listAgentConcessions, AGENT_CONCESSION_APPROVAL_LABEL } = await import("@/lib/commission/agent-concession")
  const r = await listAgentConcessions(svc as never, s.actor, { transactionId })
  if (!r.ok) return { success: false, error: r.error }
  const visible = canDecide ? r.records : r.records.filter((x) => x.concessionAgentId === s.actor.agentId || x.concessionAgentId === null)
  return {
    success: true,
    concessions: visible.map((x) => ({
      id: x.id, concessionAgentId: x.concessionAgentId, beneficiary: x.beneficiary, beneficiaryName: x.beneficiaryName, valueType: x.valueType,
      value: x.value, reason: x.reason, approvalStatus: x.approvalStatus,
      approvalLabel: AGENT_CONCESSION_APPROVAL_LABEL[x.approvalStatus as keyof typeof AGENT_CONCESSION_APPROVAL_LABEL] ?? x.approvalStatus,
      approvalNote: x.approvalNote, settlementTreatment: x.settlementTreatment,
      mine: !!s.actor.agentId && x.concessionAgentId === s.actor.agentId,
    })),
    requiresApproval: r.policy.requiresApproval,
    policyDeclared: r.policy.declared,
    canDecide,
  }
}

// ─── The brokerage's payout gate + concession-approval policy (owner rulings 8 and 4) ──────────────────────────────

export async function getCommissionPayoutPolicyAction(): Promise<ActionResult<{
  offersCda: boolean | null
  payoutTiming: string | null
  effectiveTiming: string
  timingFinding: string | null
  agentConcessionApproval: string | null
  concessionRequiresApproval: boolean
  /** The payout-timing choices with their ONE label set (lib/transactions/cda-closing-policy.ts COMMISSION_PAYOUT_TIMING_LABEL). */
  timingOptions: Array<{ value: string; label: string; available: boolean }>
  canEdit: boolean
}>> {
  const s = await sessionActor()
  if (!s.ok) return { success: false, error: s.error }
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { data, error } = await createServiceClient().from("brokerages").select("*").eq("id", s.actor.brokerageId).maybeSingle()
  if (error) return { success: false, error: `policy_read_refused: ${error.message}` }
  const b = (data ?? {}) as { offers_cda?: boolean | null; commission_payout_timing?: string | null; agent_concession_approval?: string | null }
  const { resolvePayoutTiming, COMMISSION_PAYOUT_TIMINGS, COMMISSION_PAYOUT_TIMING_LABEL } = await import("@/lib/transactions/cda-closing-policy")
  const { resolveAgentConcessionPolicy } = await import("@/lib/commission/agent-concession")
  const timing = resolvePayoutTiming({ offersCda: b.offers_cda ?? null, payoutTiming: b.commission_payout_timing })
  const timingOptions = COMMISSION_PAYOUT_TIMINGS.map((value) => ({
    value,
    label: COMMISSION_PAYOUT_TIMING_LABEL[value],
    // Closing-time payout is authorized by a CDA — offered only to a brokerage that uses one.
    available: value !== "at_closing_per_cda" || b.offers_cda === true,
  }))
  return {
    success: true,
    offersCda: b.offers_cda ?? null,
    payoutTiming: b.commission_payout_timing ?? null,
    effectiveTiming: timing.timing,
    timingFinding: timing.finding,
    agentConcessionApproval: b.agent_concession_approval ?? null,
    concessionRequiresApproval: resolveAgentConcessionPolicy(b.agent_concession_approval).requiresApproval,
    timingOptions,
    canEdit: isBrokerageFinanceAdmin({ user_type: s.actor.userType, is_tenant_principal: s.actor.isTenantPrincipal }),
  }
}

/**
 * A finance admin sets WHEN agents are paid (at closing per the CDA, or after the brokerage receives the commission) and
 * whether an agent must ask before offering a concession. Ledgered (LAW 5) and versioned through the tenant-policy appender
 * under `commission_payout_policy` (reported as not-recorded until that key is registered — never silently).
 */
export async function setCommissionPayoutPolicyAction(input: {
  payoutTiming: "at_closing_per_cda" | "after_brokerage_receipt"
  agentConcessionApproval: "broker_approval_required" | "no_approval_required"
  reason?: string | null
}): Promise<ActionResult<{ policyVersionRecorded: boolean; note: string | null }>> {
  const s = await sessionActor()
  if (!s.ok) return { success: false, error: s.error }
  if (!isBrokerageFinanceAdmin({ user_type: s.actor.userType, is_tenant_principal: s.actor.isTenantPrincipal })) {
    return { success: false, error: "forbidden: only the brokerage's finance admins set the payout policy" }
  }
  const { COMMISSION_PAYOUT_TIMINGS } = await import("@/lib/transactions/cda-closing-policy")
  const { AGENT_CONCESSION_APPROVAL_POLICIES } = await import("@/lib/commission/agent-concession")
  if (!(COMMISSION_PAYOUT_TIMINGS as readonly string[]).includes(input?.payoutTiming)) return { success: false, error: "payout_timing_invalid" }
  if (!(AGENT_CONCESSION_APPROVAL_POLICIES as readonly string[]).includes(input?.agentConcessionApproval)) return { success: false, error: "concession_approval_invalid" }

  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const { data: before, error: readErr } = await svc.from("brokerages").select("*").eq("id", s.actor.brokerageId).maybeSingle()
  if (readErr) return { success: false, error: `policy_read_refused: ${readErr.message}` }
  const b = (before ?? {}) as { offers_cda?: boolean | null; commission_payout_timing?: string | null; agent_concession_approval?: string | null }
  if (input.payoutTiming === "at_closing_per_cda" && b.offers_cda !== true) {
    return { success: false, error: "cda_required: closing-time payout is authorized by the CDA — this brokerage does not use a CDA (turn the CDA on in the brokerage's CDA setup first)" }
  }
  const previous = { payout_timing: b.commission_payout_timing ?? null, agent_concession_approval: b.agent_concession_approval ?? null }
  const value = { payout_timing: input.payoutTiming, agent_concession_approval: input.agentConcessionApproval }
  const reason = String(input.reason ?? "").trim() || "finance admin set the commission payout policy"

  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  let writeError: string | null = null
  await withActionLedger<{ ok: boolean }>(
    {
      brokerageId: s.actor.brokerageId,
      action: "finance.payout_policy.set",
      actor: { type: "user", userId: s.actor.userId, agentId: s.actor.agentId },
      subject: { type: "brokerage", id: s.actor.brokerageId },
      reasonCode: "HUMAN_REQUESTED",
      reasonDetail: reason.slice(0, 500),
      riskClass: "FINANCIAL",
      systemSource: "commission_payout_policy",
      detail: { previous, value },
    },
    async () => {
      const { data: updated, error } = await svc
        .from("brokerages")
        .update({ commission_payout_timing: input.payoutTiming, agent_concession_approval: input.agentConcessionApproval, updated_at: new Date().toISOString() })
        .eq("id", s.actor.brokerageId)
        .select("id")
      if (error) {
        writeError = /commission_payout_timing|agent_concession_approval/.test(error.message)
          ? `m850 (payout policy columns) is not applied: ${error.message}`
          : `policy_write_refused: ${error.message}`
        return { ok: false }
      }
      if (!updated || updated.length !== 1) { writeError = "policy_not_saved (0 rows matched)"; return { ok: false } }
      return { ok: true }
    },
    { settle: (x) => (x.ok ? { status: "executed", outcome: "policy_set" } : { status: "failed", outcome: "refused", error: writeError }), replay: () => ({ ok: false }) },
    { client: svc as never },
  )
  if (writeError) return { success: false, error: writeError }

  const { appendTenantPolicyVersion } = await import("@/lib/kernel/tenant-policy")
  const version = await appendTenantPolicyVersion(svc, {
    brokerageId: s.actor.brokerageId,
    policyKey: "commission_payout_policy",
    value,
    previous,
    actor: { type: "user", userId: s.actor.userId, reason },
  })
  revalidatePath("/dashboard/financials/payouts")
  return {
    success: true,
    policyVersionRecorded: version.ok === true,
    note: version.ok ? null : `saved and ledgered; the policy version was not recorded (${"error" in version ? version.error : "unknown"})`,
  }
}
