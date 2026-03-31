"use server"

// app/actions/reporting-kernel.ts
//
// Thin "use server" wrapper for lib/kernel/reporting.ts commands.
// NO DB logic lives here — only actor context resolution and kernel delegation.
// All mutations are handled by the kernel layer.

import { createClient } from "@/lib/supabase/server"
import {
  loadReportingWorkspace,
  generateSourcePerformanceReport,
  generateCampaignROIReport,
  generateTransactionPipelineReport,
  generateTeamPerformanceReport,
  generateAgentPerformanceReport,
  generateFinancialSummaryReport,
  generateReputationReport,
  exportReportCsv,
  exportReportPdf,
  emailReport,
} from "@/lib/kernel/reporting"
import type {
  ReportingActorContext,
  LoadReportingWorkspaceInput,
  GenerateSourcePerformanceInput,
  GenerateCampaignROIInput,
  GenerateTransactionPipelineInput,
  GenerateTeamPerformanceInput,
  GenerateAgentPerformanceInput,
  GenerateFinancialSummaryInput,
  GenerateReputationInput,
  ExportReportCsvInput,
  ExportReportPdfInput,
  EmailReportInput,
} from "@/lib/kernel/reporting"

// ─── ACTOR CONTEXT RESOLVER ──────────────────────────────────────────────────

async function resolveActorContext(): Promise<ReportingActorContext | null> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from("users")
    .select("id, brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) return null

  // Resolve agents.id from user.id
  const { data: agent } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()

  return {
    userId:      user.id,
    agentId:     agent?.id ?? user.id,
    brokerageId: profile.brokerage_id,
    userType:    profile.user_type ?? "agent",
  }
}

// ─── ACTION WRAPPERS ─────────────────────────────────────────────────────────

export async function loadReportingWorkspaceAction(
  opts?: Pick<LoadReportingWorkspaceInput, "dateFrom" | "dateTo">
) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false as const, error: "Not authenticated" }
  return loadReportingWorkspace({ ctx, ...opts })
}

export async function generateSourcePerformanceReportAction(
  opts?: Pick<GenerateSourcePerformanceInput, "dateFrom" | "dateTo" | "agentId">
) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false as const, error: "Not authenticated" }
  return generateSourcePerformanceReport({ ctx, ...opts })
}

export async function generateCampaignROIReportAction(
  opts?: Pick<GenerateCampaignROIInput, "dateFrom" | "dateTo">
) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false as const, error: "Not authenticated" }
  return generateCampaignROIReport({ ctx, ...opts })
}

export async function generateTransactionPipelineReportAction(
  opts?: Pick<GenerateTransactionPipelineInput, "agentId">
) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false as const, error: "Not authenticated" }
  return generateTransactionPipelineReport({ ctx, ...opts })
}

export async function generateTeamPerformanceReportAction() {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false as const, error: "Not authenticated" }
  return generateTeamPerformanceReport({ ctx })
}

export async function generateAgentPerformanceReportAction(
  opts: Pick<GenerateAgentPerformanceInput, "periodStart" | "periodEnd" | "agentId">
) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false as const, error: "Not authenticated" }
  return generateAgentPerformanceReport({ ctx, ...opts })
}

export async function generateFinancialSummaryReportAction(
  opts?: Pick<GenerateFinancialSummaryInput, "dateFrom" | "dateTo">
) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false as const, error: "Not authenticated" }
  return generateFinancialSummaryReport({ ctx, ...opts })
}

export async function generateReputationReportAction(
  opts?: Pick<GenerateReputationInput, "agentId">
) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false as const, error: "Not authenticated" }
  return generateReputationReport({ ctx, ...opts })
}

export async function exportReportCsvAction(
  opts: Pick<ExportReportCsvInput, "reportType" | "rows" | "columns">
) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false as const, error: "Not authenticated" }
  return exportReportCsv({ ctx, ...opts })
}

export async function exportReportPdfAction(
  opts: Pick<ExportReportPdfInput, "reportType" | "title" | "htmlContent">
) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false as const, error: "Not authenticated" }
  return exportReportPdf({ ctx, ...opts })
}

export async function emailReportAction(
  opts: Pick<EmailReportInput, "to" | "reportType" | "subject" | "body">
) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false as const, error: "Not authenticated" }
  return emailReport({ ctx, ...opts })
}
