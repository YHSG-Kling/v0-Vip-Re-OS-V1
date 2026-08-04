// app/actions/financial-kernel.ts
// Thin "use server" wrapper for kernel financial commands.
// Resolves actor context (userId → agentId → brokerageId) and delegates to kernel.
// No DB logic here — pure delegation.
// app/actions/financial-kernel.ts
// Thin "use server" wrapper for kernel financial commands.
// Resolves actor context (userId → agentId → brokerageId) and delegates to kernel.
// No DB logic here — pure delegation.

"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import {
  loadFinancialWorkspace,
  loadAgentFinancialSummary,
  loadAgentFinancialDashboardSummary,
  loadAgentProfitLossSummary,
  loadBrokerageFinancialSummary,
  loadCommissionQueue,
  loadCommissionDistributions,
  recalculateCommissionState,
  markCommissionApproved,
  markCommissionPaid,
  markCommissionDisputed,
  resolveCommissionDispute,
  createExpenseRecord,
  exportFinancialReport,
  emailFinancialReport,
  createCommissionRecord,
  type CreateCommissionRecordInput,
  type FinancialActorContext,
  type LoadAgentFinancialSummaryInput,
  type LoadBrokerageFinancialSummaryInput,
  type LoadCommissionQueueInput,
  type LoadCommissionDistributionsInput,
  type RecalculateCommissionStateInput,
  type MarkCommissionApprovedInput,
  type MarkCommissionPaidInput,
  type CreateExpenseRecordInput,
  type ExportFinancialReportInput,
  type EmailFinancialReportInput,
  type KernelFinancialResult,
  type AgentFinancialSummary,
  type AgentProfitLossSummary,
  type AgentFinancialDashboardSummary,
} from "@/lib/kernel/financial"

// Get actor context for all commands
async function getFinancialActorContext(): Promise<FinancialActorContext> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) throw new Error("Not authenticated")

  const { agentId, brokerageId, role } = await getAgentContext()

  if (!brokerageId) throw new Error("Missing brokerage context")

  return {
    userId: user.id,
    agentId,
    brokerageId,
    userType: (role ?? "agent") as "agent" | "team_lead" | "broker" | "admin" | "superadmin",
  }
}

type FinancialContextResolution =
  | { success: true; ctx: FinancialActorContext }
  | { success: false; error: string; ctx?: undefined }

async function resolveFinancialContext(
  brokerageId?: string
): Promise<FinancialContextResolution> {
  try {
    const ctx = await getFinancialActorContext()

    return {
      success: true,
      ctx: {
        ...ctx,
        brokerageId: brokerageId ?? ctx.brokerageId,
      },
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

// ─── EXPORTED SERVER ACTIONS ──────────────────────────────────────────────────────

export async function loadFinancialWorkspaceAction() {
  try {
    const ctx = await getFinancialActorContext()
    return await loadFinancialWorkspace({ ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function loadAgentFinancialSummaryAction(
  input: Omit<LoadAgentFinancialSummaryInput, "ctx">
): Promise<KernelFinancialResult<AgentFinancialSummary>> {
  try {
    const ctx = await getFinancialActorContext()
    return await loadAgentFinancialSummary({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function loadAgentFinancialDashboardSummaryAction(params: {
  agentId: string
  brokerageId?: string
}): Promise<KernelFinancialResult<AgentFinancialDashboardSummary>> {
  const ctx = await resolveFinancialContext(params.brokerageId)

  if (!ctx.success || !ctx.ctx) {
    return {
      success: false,
      error: ctx.error || "Failed to resolve financial context",
    }
  }

  return await loadAgentFinancialDashboardSummary({
    ctx: ctx.ctx,
    agentId: params.agentId,
    periodType: "ytd",
  })
}

export async function loadAgentProfitLossSummaryAction(params: {
  agentId: string
  brokerageId?: string
}): Promise<KernelFinancialResult<AgentProfitLossSummary>> {
  const ctx = await resolveFinancialContext(params.brokerageId)

  if (!ctx.success || !ctx.ctx) {
    return {
      success: false,
      error: ctx.error || "Failed to resolve financial context",
    }
  }

  return await loadAgentProfitLossSummary({
    ctx: ctx.ctx,
    agentId: params.agentId,
    periodType: "ytd",
  })
}

export async function loadBrokerageFinancialSummaryAction(
  input: Omit<LoadBrokerageFinancialSummaryInput, "ctx">
) {
  try {
    const ctx = await getFinancialActorContext()
    return await loadBrokerageFinancialSummary({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function loadCommissionQueueAction(
  input: Omit<LoadCommissionQueueInput, "ctx">
) {
  try {
    const ctx = await getFinancialActorContext()
    return await loadCommissionQueue({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function loadCommissionDistributionsAction(
  input: Omit<LoadCommissionDistributionsInput, "ctx">
) {
  try {
    const ctx = await getFinancialActorContext()
    return await loadCommissionDistributions({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function recalculateCommissionStateAction(
  input: Omit<RecalculateCommissionStateInput, "ctx">
) {
  try {
    const ctx = await getFinancialActorContext()
    return await recalculateCommissionState({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * Broker approval of a commission: pending → approved, the step the kernel REQUIRES
 * before markCommissionPaid will disburse (COMMISSION_STATUS_TRANSITIONS rejects
 * pending → paid outright). approvedBy defaults to the authenticated caller — the
 * approver on a money record is who the session says it is, never a value the client
 * chose. It stays overridable so server-side callers can attribute an approval they
 * are performing on someone else's behalf.
 */
export async function markCommissionApprovedAction(
  input: Omit<MarkCommissionApprovedInput, "ctx" | "approvedBy"> & { approvedBy?: string }
) {
  try {
    const ctx = await getFinancialActorContext()
    return await markCommissionApproved({ ...input, approvedBy: input.approvedBy ?? ctx.userId, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function markCommissionPaidAction(
  input: Omit<MarkCommissionPaidInput, "ctx">
) {
  try {
    const ctx = await getFinancialActorContext()
    return await markCommissionPaid({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/** The agent (or a broker on their behalf) disputes a commission they believe is wrong. */
export async function fileCommissionDisputeAction(input: { commissionId: string; brokerageId: string; reason: string }) {
  try {
    const ctx = await getFinancialActorContext()
    return await markCommissionDisputed({ ctx, commissionId: input.commissionId, brokerageId: input.brokerageId, reason: input.reason })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/** A broker resolves a disputed commission: uphold/correct → approved, or reopen → pending. */
export async function resolveCommissionDisputeAction(input: { commissionId: string; brokerageId: string; resolution: "upheld" | "corrected" | "reopened"; notes?: string }) {
  try {
    const ctx = await getFinancialActorContext()
    return await resolveCommissionDispute({ ctx, commissionId: input.commissionId, brokerageId: input.brokerageId, resolution: input.resolution, notes: input.notes })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/** The agent's own commissions they can dispute (pending/approved) or that are already disputed. */
export async function loadMyDisputableCommissionsAction() {
  try {
    const ctx = await getFinancialActorContext()
    if (!ctx.agentId) return { success: false as const, error: "no_agent_context" }
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const { data, error } = await svc
      .from("agent_commissions")
      .select("id, transaction_id, gross_commission, agent_commission, agent_split_percent, status, close_date, dispute_reason, dispute_resolution, dispute_resolved_at")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("agent_id", ctx.agentId)
      .in("status", ["pending", "approved", "disputed"])
      .order("close_date", { ascending: false, nullsFirst: false })
      .limit(50)
    if (error) return { success: false as const, error: error.message }
    return { success: true as const, brokerageId: ctx.brokerageId, commissions: data ?? [] }
  } catch (error) {
    return { success: false as const, error: String(error) }
  }
}

/** Broker dispute queue — the disputed agent_commissions awaiting resolution. */
export async function loadCommissionDisputesAction() {
  try {
    const ctx = await getFinancialActorContext()
    if (!["broker", "admin", "superadmin"].includes(ctx.userType)) {
      return { success: false as const, error: "forbidden" }
    }
    const { createServiceClient } = await import("@/lib/supabase/service")
    const svc = createServiceClient()
    const { data, error } = await svc
      .from("agent_commissions")
      .select("id, agent_id, transaction_id, gross_commission, agent_commission, agent_split_percent, status, dispute_reason, disputed_at, disputed_by")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("status", "disputed")
      .order("disputed_at", { ascending: true })
      .limit(100)
    if (error) return { success: false as const, error: error.message }
    return { success: true as const, disputes: data ?? [] }
  } catch (error) {
    return { success: false as const, error: String(error) }
  }
}

/**
 * Record that the brokerage RECEIVED the commission deposit at closing — the ledger's money-tracking
 * step between close and disbursement (close freezes the amount; the deposit is the money arriving;
 * disbursement pays the agent). Broker-gated; stamps deposit_received_at on the transaction's ledger.
 */
export async function recordCommissionDepositReceivedAction(
  input: { transactionId: string }
) {
  try {
    const ctx = await getFinancialActorContext()
    if (!["broker", "admin", "superadmin"].includes(ctx.userType)) {
      return { success: false as const, error: "Insufficient permissions to record a deposit" }
    }
    const { createServiceClient } = await import("@/lib/supabase/service")
    const { recordCommissionDepositReceived } = await import("@/lib/commission/reconcile-tracking")
    const svc = createServiceClient()
    const res = await recordCommissionDepositReceived(svc, {
      transactionId: input.transactionId,
      brokerageId: ctx.brokerageId,
      actorUserId: ctx.userId,
    })
    return { success: true as const, stamped: res.stamped }
  } catch (error) {
    return { success: false as const, error: String(error) }
  }
}

export async function createExpenseRecordAction(
  input: Omit<CreateExpenseRecordInput, "ctx">
) {
  try {
    const ctx = await getFinancialActorContext()
    return await createExpenseRecord({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function createCommissionRecordAction(
  input: Omit<CreateCommissionRecordInput, "ctx">
) {
  try {
    const ctx = await getFinancialActorContext()
    return await createCommissionRecord({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function exportFinancialReportAction(
  input: Omit<ExportFinancialReportInput, "ctx">
) {
  try {
    const ctx = await getFinancialActorContext()
    return await exportFinancialReport({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function emailFinancialReportAction(
  input: Omit<EmailFinancialReportInput, "ctx">
) {
  try {
    const ctx = await getFinancialActorContext()
    return await emailFinancialReport({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
