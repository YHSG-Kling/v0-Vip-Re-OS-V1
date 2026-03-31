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
  loadBrokerageFinancialSummary,
  loadCommissionQueue,
  loadCommissionDistributions,
  recalculateCommissionState,
  markCommissionApproved,
  markCommissionPaid,
  createExpenseRecord,
  exportFinancialReport,
  emailFinancialReport,
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
} from "@/lib/kernel"

// Get actor context for all commands
async function getFinancialActorContext(): Promise<FinancialActorContext> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) throw new Error("Not authenticated")

  const { agentId, brokerageId, role } = await getAgentContext()

  return {
    userId:      user.id,
    agentId,
    brokerageId,
    userType:    (role ?? "agent") as "agent" | "team_lead" | "broker" | "admin" | "superadmin",
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

export async function loadAgentFinancialSummaryAction(input: Omit<LoadAgentFinancialSummaryInput, "ctx">) {
  try {
    const ctx = await getFinancialActorContext()
    return await loadAgentFinancialSummary({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
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

export async function loadCommissionQueueAction(input: Omit<LoadCommissionQueueInput, "ctx">) {
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

export async function recalculateCommissionStateAction(input: Omit<RecalculateCommissionStateInput, "ctx">) {
  try {
    const ctx = await getFinancialActorContext()
    return await recalculateCommissionState({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function markCommissionApprovedAction(input: Omit<MarkCommissionApprovedInput, "ctx">) {
  try {
    const ctx = await getFinancialActorContext()
    return await markCommissionApproved({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function markCommissionPaidAction(input: Omit<MarkCommissionPaidInput, "ctx">) {
  try {
    const ctx = await getFinancialActorContext()
    return await markCommissionPaid({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function createExpenseRecordAction(input: Omit<CreateExpenseRecordInput, "ctx">) {
  try {
    const ctx = await getFinancialActorContext()
    return await createExpenseRecord({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function exportFinancialReportAction(input: Omit<ExportFinancialReportInput, "ctx">) {
  try {
    const ctx = await getFinancialActorContext()
    return await exportFinancialReport({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

export async function emailFinancialReportAction(input: Omit<EmailFinancialReportInput, "ctx">) {
  try {
    const ctx = await getFinancialActorContext()
    return await emailFinancialReport({ ...input, ctx })
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
