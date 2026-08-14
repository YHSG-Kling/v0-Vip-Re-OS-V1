"use server"

// app/actions/reporting-kernel.ts
//
// Thin "use server" wrapper for lib/kernel/reporting.ts commands.
// NO DB logic lives here — only actor context resolution and kernel delegation.
// All mutations are handled by the kernel layer.

import { createClient } from "@/lib/supabase/server"
import { pickUserOffice } from "@/lib/kernel/resolve-user-office"
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
    .select("id, brokerage_id, user_type, team_id, location_id")
    .eq("id", user.id)
    .maybeSingle()

  if (!profile?.brokerage_id) return null

  // Resolve agents.id + the actor's office/team from user.id. location_id lives on agents
  // (multi-location brokerages); team_id can be on either agents or users.
  const { data: agent } = await supabase
    .from("agents")
    .select("id, location_id, team_id")
    .eq("user_id", user.id)
    .maybeSingle()

  return {
    userId:      user.id,
    // NOT `?? user.id` (m349). This is the ctx EVERY reporting action reads
    // through — the "middle". The pages know who the user is and the schema
    // knows what each report is keyed on; this object was the only place that
    // guessed. Every report keys agents-class columns, so the users id produced
    // a complete, internally consistent set of zeros: a quiet month, rendered
    // with full confidence. An empty id produces the same zeros without an
    // ambiguous value leaking into a dozen downstream readers.
    agentId:     agent?.id ?? "",
    brokerageId: profile.brokerage_id,
    userType:    profile.user_type ?? "agent",
    // pickUserOffice, not `agent?.location_id` — the office set on the PERSON
    // wins over the one on their agent record, and a pure-admin on a
    // brokerage/multi_location tenant HAS no agent record (requiresAgentRow),
    // so reading only the agents row silently un-narrowed every office admin
    // on the one tier that has offices.
    locationId:  pickUserOffice(
                   (profile as { location_id?: string | null }).location_id ?? null,
                   agent?.location_id ?? null,
                 ).locationId,
    teamId:      agent?.team_id ?? (profile as { team_id?: string | null }).team_id ?? null,
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

// NO generateFinancialSummaryReportAction.
//
// It existed as a client-callable wrapper with nowhere to be called from:
// /dashboard/reports deliberately excludes commission/financials (they live in
// Financials → Commission Tracker — see the note on that page), and the three
// export/email actions below reach generateFinancialSummaryReport (the kernel
// function) directly. A wrapper whose only possible caller is this file is a
// second name for one capability, so the kernel function is the single path.

export async function generateReputationReportAction(
  opts?: Pick<GenerateReputationInput, "agentId">
) {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false as const, error: "Not authenticated" }
  return generateReputationReport({ ctx, ...opts })
}

// Self-contained CSV export: fetches report data internally, formats rows, calls kernel CSV.
export async function exportReportCsvAction(opts: {
  reportType: string
  agentId: string
  brokerageId: string
  dateFrom?: string
}): Promise<{ success: boolean; data?: string; error?: string }> {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false, error: "Not authenticated" }

  const { reportType, dateFrom } = opts

  // Fetch the relevant data for this report type
  let rows: Record<string, unknown>[] = []
  let columns: string[] = []

  if (reportType === "source") {
    const result = await generateSourcePerformanceReport({ ctx, dateFrom })
    if (!result.success || !result.data) return { success: false, error: result.error ?? "Failed to generate source report" }
    rows    = result.data.sources as Record<string, unknown>[]
    columns = ["source", "source_family", "contact_count", "transaction_count", "revenue", "roi_multiple", "close_rate"]
  } else if (reportType === "campaign") {
    const result = await generateCampaignROIReport({ ctx, dateFrom })
    if (!result.success || !result.data) return { success: false, error: result.error ?? "Failed to generate campaign report" }
    rows    = result.data.campaigns as Record<string, unknown>[]
    columns = ["campaign_name", "status", "total_spend", "total_leads", "total_conversions", "total_revenue", "roi_percentage"]
  } else if (reportType === "reputation") {
    const result = await generateReputationReport({ ctx })
    if (!result.success || !result.data) return { success: false, error: result.error ?? "Failed to generate reputation report" }
    rows    = result.data.recentReviews as Record<string, unknown>[]
    columns = ["platform", "rating", "review_text", "response_text", "created_at"]
  } else {
    // Default: financial summary
    const result = await generateFinancialSummaryReport({ ctx, dateFrom })
    if (!result.success || !result.data) return { success: false, error: result.error ?? "Failed to generate financial report" }
    rows    = result.data.recentCommissions as Record<string, unknown>[]
    columns = ["id", "close_date", "gross_commission", "agent_commission", "brokerage_commission"]
  }

  const csvResult = await exportReportCsv({ ctx, reportType, rows, columns })
  if (!csvResult.success || !csvResult.data) return { success: false, error: csvResult.error ?? "CSV export failed" }
  return { success: true, data: csvResult.data.csv }
}

// Self-contained PDF export: builds HTML from report data and uploads to Blob.
export async function exportReportPdfAction(opts: {
  reportType: string
  agentId: string
  brokerageId: string
  dateFrom?: string
}): Promise<{ success: boolean; pdfUrl?: string; error?: string }> {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false, error: "Not authenticated" }

  const { reportType, dateFrom } = opts

  // Build a simple HTML table from the report data
  let title = "Report"
  let rows: Record<string, unknown>[] = []
  let columns: string[] = []

  if (reportType === "source") {
    const result = await generateSourcePerformanceReport({ ctx, dateFrom })
    if (!result.success || !result.data) return { success: false, error: result.error ?? "Failed to generate source report" }
    title   = "Source Performance Report"
    rows    = result.data.sources as Record<string, unknown>[]
    columns = ["source", "contact_count", "transaction_count", "revenue", "roi_multiple", "close_rate"]
  } else if (reportType === "campaign") {
    const result = await generateCampaignROIReport({ ctx, dateFrom })
    if (!result.success || !result.data) return { success: false, error: result.error ?? "Failed to generate campaign report" }
    title   = "Campaign ROI Report"
    rows    = result.data.campaigns as Record<string, unknown>[]
    columns = ["campaign_name", "status", "total_spend", "total_revenue", "roi_percentage", "total_leads"]
  } else if (reportType === "reputation") {
    const result = await generateReputationReport({ ctx })
    if (!result.success || !result.data) return { success: false, error: result.error ?? "Failed to generate reputation report" }
    title   = "Reputation Report"
    rows    = result.data.recentReviews as Record<string, unknown>[]
    columns = ["platform", "rating", "review_text", "created_at"]
  } else {
    const result = await generateFinancialSummaryReport({ ctx, dateFrom })
    if (!result.success || !result.data) return { success: false, error: result.error ?? "Failed to generate financial report" }
    title   = "Financial Summary Report"
    rows    = result.data.recentCommissions as Record<string, unknown>[]
    columns = ["id", "close_date", "gross_commission", "agent_commission", "brokerage_commission"]
  }

  const headerCells = columns.map(c => `<th style="padding:8px;border:1px solid #ddd;text-align:left">${c}</th>`).join("")
  const bodyRows    = rows.map(row =>
    `<tr>${columns.map(c => `<td style="padding:8px;border:1px solid #ddd">${row[c] ?? ""}</td>`).join("")}</tr>`
  ).join("")

  const htmlContent = `<!DOCTYPE html><html><head><title>${title}</title>
<style>body{font-family:sans-serif;padding:32px}h1{margin-bottom:16px}table{border-collapse:collapse;width:100%}</style>
</head><body><h1>${title}</h1><p>Generated: ${new Date().toLocaleDateString()}</p>
<table><thead><tr>${headerCells}</tr></thead><tbody>${bodyRows}</tbody></table></body></html>`

  const pdfResult = await exportReportPdf({ ctx, reportType, title, htmlContent })
  if (!pdfResult.success || !pdfResult.data) return { success: false, error: pdfResult.error ?? "PDF export failed" }
  return { success: true, pdfUrl: pdfResult.data.pdfUrl }
}

// Self-contained email action: accepts array of recipients, builds body from report data.
export async function emailReportAction(opts: {
  reportType: string
  recipients: string[]
  subject: string
  message?: string
  agentId: string
  brokerageId: string
  dateFrom?: string
}): Promise<{ success: boolean; error?: string }> {
  const ctx = await resolveActorContext()
  if (!ctx) return { success: false, error: "Not authenticated" }

  const { reportType, recipients, subject, message, dateFrom } = opts

  // Build a plain-text summary to embed in the email body
  let summary = message ? `${message}\n\n` : ""

  if (reportType === "summary" || reportType === "financial") {
    const result = await generateFinancialSummaryReport({ ctx, dateFrom })
    if (result.success && result.data) {
      const d = result.data
      summary += `Financial Summary\nYTD GCI: $${d.ytdGrossCommission.toLocaleString()}\nAgent Net: $${d.ytdAgentCommission.toLocaleString()}\nExpenses: $${d.ytdExpenses.toLocaleString()}\nNet Income: $${d.ytdNetIncome.toLocaleString()}`
    }
  } else if (reportType === "reputation") {
    const result = await generateReputationReport({ ctx })
    if (result.success && result.data) {
      const d = result.data
      summary += `Reputation Summary\nAvg Rating: ${d.avgRating}\nTotal Reviews: ${d.totalReviews}\nResponse Rate: ${d.responseRate}%`
    }
  } else if (reportType === "source") {
    const result = await generateSourcePerformanceReport({ ctx, dateFrom })
    if (result.success && result.data) {
      const d = result.data
      summary += `Source Performance\nTotal Sources: ${d.summary.total_sources}\nTotal Revenue: $${d.summary.total_revenue.toLocaleString()}`
    }
  } else if (reportType === "campaign") {
    const result = await generateCampaignROIReport({ ctx, dateFrom })
    if (result.success && result.data) {
      const d = result.data
      summary += `Campaign ROI\nTotal Spend: $${d.totals.total_spend.toLocaleString()}\nTotal Revenue: $${d.totals.total_revenue.toLocaleString()}\nOverall ROI: ${d.totals.overall_roi}%`
    }
  }

  // Send to all recipients
  const results = await Promise.all(
    recipients.map(to =>
      emailReport({ ctx, to, reportType, subject, body: summary })
    )
  )
  const failed = results.find(r => !r.success)
  if (failed) return { success: false, error: failed.error ?? "Failed to send email" }
  return { success: true }
}
