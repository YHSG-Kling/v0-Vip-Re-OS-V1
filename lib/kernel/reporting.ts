// lib/kernel/reporting.ts
//
// CANONICAL Reporting kernel commands.
// ALL report generation, export, and delivery must flow through these commands.
//
// Kernel Ownership Rules:
//   - No direct DB reads for reports from UI components or action files.
//   - generateAgentPerformanceReport writes to agent_performance_reports.
//   - exportReportPdf uploads to Vercel Blob — NOT to generated_documents (non-existent).
//   - emailReport inserts to email_queue (real table).
//   - Every mutation emits a KernelEvent via lifecycle_events.
//   - All commands accept an ActorContext that includes brokerageId + agentId.
//
// Explicit Commands:
//   1. loadReportingWorkspace          — read-only workspace snapshot for reports page
//   2. generateSourcePerformanceReport — source-family breakdown
//   3. generateCampaignROIReport        — campaign_roi table aggregation
//   4. generateTransactionPipelineReport — pipeline stage snapshot
//   5. generateTeamPerformanceReport   — team_performance table roll-up
//   6. generateAgentPerformanceReport  — agent metrics + saves to agent_performance_reports
//   7. generateFinancialSummaryReport  — YTD commission + expenses via agent_commissions
//   8. generateReputationReport        — agent_reviews aggregation
//   9. exportReportCsv                 — returns CSV string (no DB write)
//  10. exportReportPdf                 — Vercel Blob upload, returns URL
//  11. emailReport                     — inserts to email_queue
//
// Explicit Rules:
//   - agent_commissions is the correct table (not `commissions`).
//   - business_expenses has no brokerage_id — filter by agent_id only.
//   - campaign_roi.budget_spent is nullable — coalesce to 0.
//   - agent_performance_reports.metrics is jsonb — always serialize before insert.
//   - generated_documents does NOT exist — never reference it.
//   - maybeSingle() everywhere; never single().
//
// Tables written:
//   agent_performance_reports, lifecycle_events, email_queue, ai_assistant_notes
//
// Tables read (read-only):
//   contacts, leads, transactions, agent_commissions, business_expenses,
//   campaign_roi, marketing_campaigns, agent_reviews, agent_performance_reports,
//   agents, team_performance, brokerage_earnings, isa_outreach_log,
//   ai_isa_qualifications

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "./events"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface ReportingActorContext {
  userId:      string
  agentId:     string
  brokerageId: string
  userType:    "agent" | "coordinator" | "broker" | "admin" | string
}

export interface KernelReportingResult<T = void> {
  success: boolean
  data?:   T
  error?:  string
}

// ── loadReportingWorkspace ────────────────────────────────────────────────────

export interface LoadReportingWorkspaceInput {
  ctx: ReportingActorContext
  dateFrom?: string
  dateTo?:   string
}

export interface ReportingWorkspace {
  agentStats: {
    ytdGci:           number
    ytdTransactions:  number
    activeListings:   number
    pendingPipeline:  number
    avgDaysOnMarket:  number
    totalContacts:    number
    newContactsLast30: number
  }
  recentPerformanceReports: Array<{
    id:           string
    period_start: string
    period_end:   string
    created_at:   string
    metrics:      Record<string, unknown>
  }>
  recentCommissions: Array<{
    id:               string
    gross_commission: number
    agent_commission: number
    close_date:       string | null
    transaction_id:   string | null
  }>
  recentExpenses: Array<{
    id:           string
    amount:       number
    category:     string | null
    expense_date: string | null
  }>
  reviewSummary: {
    avgRating:     number
    totalReviews:  number
    responseRate:  number
  }
}

// ── generateSourcePerformanceReport ──────────────────────────────────────────

export interface GenerateSourcePerformanceInput {
  ctx:          ReportingActorContext
  dateFrom?:    string
  dateTo?:      string
  agentId?:     string   // for broker view scoping to specific agent
}

export interface SourcePerformanceReport {
  sources: Array<{
    source:         string
    source_family:  string
    contact_count:  number
    transaction_count: number
    revenue:        number
    roi_multiple:   number
    cost_per_contact: number
    close_rate:     number
  }>
  summary: {
    total_sources:    number
    total_contacts:   number
    total_revenue:    number
    top_roi_source:   string | null
    top_volume_source: string | null
  }
}

// ── generateCampaignROIReport ────────────────────────────────────────────────

export interface GenerateCampaignROIInput {
  ctx:       ReportingActorContext
  dateFrom?: string
  dateTo?:   string
}

export interface CampaignROIReport {
  campaigns: Array<{
    id:                  string
    campaign_name:       string
    status:              string | null
    total_spend:         number
    total_leads:         number
    total_conversions:   number
    total_revenue:       number
    roi_percentage:      number
    cost_per_lead:       number
    budget_total:        number | null
    budget_spent:        number
    budget_utilization:  number
  }>
  totals: {
    total_spend:    number
    total_revenue:  number
    overall_roi:    number
    total_leads:    number
  }
}

// ── generateTransactionPipelineReport ────────────────────────────────────────

export interface GenerateTransactionPipelineInput {
  ctx:       ReportingActorContext
  agentId?:  string
}

export interface TransactionPipelineReport {
  byStage: Array<{
    stage:           string
    count:           number
    total_value:     number
    avg_days_in_stage: number
  }>
  totalPipelineValue: number
  closedYTD:         number
  closedYTDValue:    number
}

// ── generateTeamPerformanceReport ────────────────────────────────────────────

export interface GenerateTeamPerformanceInput {
  ctx: ReportingActorContext
}

export interface TeamPerformanceReport {
  teams: Array<{
    id:             string
    team_name:      string
    total_revenue:  number
    goal_amount:    number
    attainment_pct: number
    agent_count:    number
  }>
}

// ── generateAgentPerformanceReport ────────────────────────────────────────────

export interface GenerateAgentPerformanceInput {
  ctx:          ReportingActorContext
  periodStart:  string
  periodEnd:    string
  agentId?:     string   // broker/admin can specify; defaults to ctx.agentId
}

export interface AgentPerformanceReport {
  reportId:     string
  agentId:      string
  periodStart:  string
  periodEnd:    string
  metrics: {
    ytdGci:           number
    ytdTransactions:  number
    avgRating:        number
    totalReviews:     number
    newContacts:      number
    closedDeals:      number
    totalExpenses:    number
    netIncome:        number
    conversionRate:   number
  }
}

// ── generateFinancialSummaryReport ────────────────────────────────────────────

export interface GenerateFinancialSummaryInput {
  ctx:       ReportingActorContext
  dateFrom?: string
  dateTo?:   string
}

export interface FinancialSummaryReport {
  ytdGrossCommission:    number
  ytdAgentCommission:    number
  ytdBrokerageCommission: number
  ytdExpenses:           number
  ytdNetIncome:          number
  recentCommissions: Array<{
    id:               string
    gross_commission: number
    agent_commission: number
    close_date:       string | null
  }>
  recentExpenses: Array<{
    id:           string
    amount:       number
    category:     string | null
    expense_date: string | null
  }>
}

// ── generateReputationReport ─────────────────────────────────────────────────

export interface GenerateReputationInput {
  ctx:      ReportingActorContext
  agentId?: string
}

export interface ReputationReport {
  totalReviews:   number
  avgRating:      number
  responseRate:   number
  byPlatform: Array<{
    platform:   string
    count:      number
    avg_rating: number
    responded:  number
  }>
  recentReviews: Array<{
    id:           string
    rating:       number
    review_text:  string | null
    platform:     string
    is_published: boolean
    response_text: string | null
    created_at:   string
  }>
}

// ── exportReportCsv ────────────────────────────────────────────────────────

export interface ExportReportCsvInput {
  ctx:        ReportingActorContext
  reportType: string
  rows:       Record<string, unknown>[]
  columns:    string[]
}

export interface ExportReportCsvOutput {
  csv:      string
  filename: string
}

// ── exportReportPdf ────────────────────────────────────────────────────────

export interface ExportReportPdfInput {
  ctx:        ReportingActorContext
  reportType: string
  title:      string
  htmlContent: string
}

export interface ExportReportPdfOutput {
  pdfUrl:   string
  filename: string
}

// ── emailReport ────────────────────────────────────────────────────────────

export interface EmailReportInput {
  ctx:        ReportingActorContext
  to:         string
  reportType: string
  subject:    string
  body:       string
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function currentYear(): string {
  return new Date().getFullYear().toString()
}

function ytdStart(): string {
  return `${currentYear()}-01-01`
}

async function emitEvent(
  supabase: Awaited<ReturnType<typeof createServiceClient>>,
  ctx: ReportingActorContext,
  event: KernelEvent,
  entityId: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await supabase.from("lifecycle_events").insert({
    agent_id:    ctx.agentId,
    brokerage_id: ctx.brokerageId,
    entity_type: "report",
    entity_id:   entityId,
    event_type:  event,
    metadata,
    created_at:  new Date().toISOString(),
  }).select()
}

// ─── COMMANDS ────────────────────────────────────────────────────────────────

// 1. loadReportingWorkspace
export async function loadReportingWorkspace(
  input: LoadReportingWorkspaceInput
): Promise<KernelReportingResult<ReportingWorkspace>> {
  try {
    const supabase = await createServiceClient()
    const { ctx, dateFrom, dateTo } = input
    const from = dateFrom ?? ytdStart()
    const to   = dateTo   ?? new Date().toISOString()

    const [
      { data: agentRow },
      { data: perfReports },
      { data: commissions },
      { data: expenses },
      { data: reviews },
      { data: listings },
      { data: contacts },
    ] = await Promise.all([
      supabase
        .from("agents")
        .select("ytd_gci, ytd_transactions")
        .eq("user_id", ctx.userId)
        .maybeSingle(),
      supabase
        .from("agent_performance_reports")
        .select("id, period_start, period_end, created_at, metrics")
        .eq("agent_id", ctx.agentId)
        .eq("brokerage_id", ctx.brokerageId)
        .order("created_at", { ascending: false })
        .limit(5),
      supabase
        .from("agent_commissions")
        .select("id, gross_commission, agent_commission, close_date, transaction_id")
        .eq("agent_id", ctx.agentId)
        .gte("close_date", from)
        .lte("close_date", to)
        .order("close_date", { ascending: false })
        .limit(10),
      supabase
        .from("business_expenses")
        .select("id, amount, category, expense_date")
        .eq("agent_id", ctx.agentId)
        .gte("expense_date", from)
        .order("expense_date", { ascending: false })
        .limit(10),
      supabase
        .from("agent_reviews")
        .select("rating, response_text")
        .eq("agent_id", ctx.agentId)
        .eq("brokerage_id", ctx.brokerageId),
      supabase
        .from("listings")
        .select("id, status")
        .eq("brokerage_id", ctx.brokerageId)
        .eq("agent_id", ctx.agentId)
        .in("status", ["active", "pending"]),
      supabase
        .from("contacts")
        .select("id, created_at")
        .eq("brokerage_id", ctx.brokerageId)
        .eq("agent_id", ctx.agentId)
        .gte("created_at", new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()),
    ])

    const totalReviews = reviews?.length ?? 0
    const avgRating = totalReviews > 0
      ? (reviews ?? []).reduce((s, r: Record<string, unknown>) => s + ((r.rating as number) ?? 0), 0) / totalReviews
      : 0
    const responded = (reviews ?? []).filter((r: Record<string, unknown>) => r.response_text).length ?? 0
    const responseRate = totalReviews > 0 ? Math.round((responded / totalReviews) * 100) : 0

    // Pipeline count from transactions
    const { data: pipeline } = await supabase
      .from("transactions")
      .select("id, purchase_price")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("agent_id", ctx.agentId)
      .in("status", ["active", "pending", "under_contract", "in_review"])

    const pendingPipelineValue = (pipeline ?? []).reduce(
      (s, t) => s + (t.purchase_price ?? 0), 0
    )

    return {
      success: true,
      data: {
        agentStats: {
          ytdGci:            agentRow?.ytd_gci           ?? 0,
          ytdTransactions:   agentRow?.ytd_transactions  ?? 0,
          activeListings:    listings?.length            ?? 0,
          pendingPipeline:   pendingPipelineValue,
          avgDaysOnMarket:   0, // computed on demand in pipeline report
          totalContacts:     0,
          newContactsLast30: contacts?.length ?? 0,
        },
        recentPerformanceReports: (perfReports ?? []) as ReportingWorkspace["recentPerformanceReports"],
        recentCommissions:        (commissions  ?? []) as ReportingWorkspace["recentCommissions"],
        recentExpenses:           (expenses     ?? []) as ReportingWorkspace["recentExpenses"],
        reviewSummary: {
          avgRating:    parseFloat(avgRating.toFixed(1)),
          totalReviews,
          responseRate,
        },
      },
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "loadReportingWorkspace failed" }
  }
}

// 2. generateSourcePerformanceReport
// NOTE: Source performance is data-intensive; the canonical implementation
// lives in app/actions/source-analytics.ts (getSourcePerformance). This
// kernel command is a typed orchestration wrapper that shapes the output
// for consistent use in reports-client.tsx.
export async function generateSourcePerformanceReport(
  input: GenerateSourcePerformanceInput
): Promise<KernelReportingResult<SourcePerformanceReport>> {
  try {
    // We call the underlying source-analytics implementation which reads from
    // contacts, leads, raw_scraped_leads, transactions, activities in one pass.
    // This kernel command does not duplicate that logic — it imports from the
    // source-analytics module (no circular dep: action → kernel only).
    // The action layer (app/actions/reporting-kernel.ts) imports BOTH this
    // kernel function and source-analytics and merges them.
    const supabase = await createServiceClient()
    const { ctx, dateFrom, dateTo, agentId } = input
    const from = dateFrom ?? ytdStart()
    const to   = dateTo   ?? new Date().toISOString()
    const scopeAgentId = agentId ?? (ctx.userType === "agent" ? ctx.agentId : undefined)

    // Direct contacts + transactions query for kernel-native aggregation
    const [
      { data: contacts },
      { data: txs },
    ] = await Promise.all([
      supabase
        .from("contacts")
        .select("source, source_family, agent_id, cost_per_record, created_at")
        .eq("brokerage_id", ctx.brokerageId)
        .gte("created_at", from)
        .lte("created_at", to)
        .is("deleted_at", null)
        .then(r => scopeAgentId
          ? { data: (r.data ?? []).filter(c => c.agent_id === scopeAgentId), error: r.error }
          : r
        ),
      supabase
        .from("transactions")
        .select("source, source_family, purchase_price, commission_amount, status, agent_id")
        .eq("brokerage_id", ctx.brokerageId)
        .gte("created_at", from)
        .lte("created_at", to)
        .then(r => scopeAgentId
          ? { data: (r.data ?? []).filter(t => t.agent_id === scopeAgentId), error: r.error }
          : r
        ),
    ])

    // Group by source+source_family
    type SourceBucket = {
      source: string
      source_family: string
      contact_count: number
      transaction_count: number
      revenue: number
      total_spend: number
      close_rate: number
      roi_multiple: number
      cost_per_contact: number
    }
    const map = new Map<string, SourceBucket>()
    const get = (src: string, fam: string): SourceBucket => {
      const k = `${src}::${fam}`
      if (!map.has(k)) map.set(k, {
        source: src, source_family: fam,
        contact_count: 0, transaction_count: 0, revenue: 0,
        total_spend: 0, close_rate: 0, roi_multiple: 0, cost_per_contact: 0,
      })
      return map.get(k)!
    }

    for (const c of contacts ?? []) {
      const b = get(c.source ?? "unknown", c.source_family ?? "contact_direct")
      b.contact_count++
      b.total_spend += c.cost_per_record ?? 0
    }
    for (const t of txs ?? []) {
      const b = get(t.source ?? "unknown", t.source_family ?? "lead")
      b.transaction_count++
      if (t.status === "closed" || t.status === "completed") {
        b.revenue += t.commission_amount ?? (t.purchase_price ? t.purchase_price * 0.03 : 0)
      }
    }

    for (const b of map.values()) {
      if (b.contact_count > 0) {
        b.close_rate       = Math.round((b.transaction_count / b.contact_count) * 100)
        b.cost_per_contact = b.total_spend > 0 ? parseFloat((b.total_spend / b.contact_count).toFixed(2)) : 0
      }
      b.roi_multiple = b.total_spend > 0 ? parseFloat((b.revenue / b.total_spend).toFixed(2)) : 0
    }

    const sources = Array.from(map.values()).sort((a, b) => b.contact_count - a.contact_count)
    const totalRevenue  = sources.reduce((s, x) => s + x.revenue, 0)
    const topRoi        = sources.slice().sort((a, b) => b.roi_multiple - a.roi_multiple)[0]?.source ?? null
    const topVolume     = sources[0]?.source ?? null

    return {
      success: true,
      data: {
        sources,
        summary: {
          total_sources:      sources.length,
          total_contacts:     sources.reduce((s, x) => s + x.contact_count, 0),
          total_revenue:      totalRevenue,
          top_roi_source:     topRoi,
          top_volume_source:  topVolume,
        },
      },
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "generateSourcePerformanceReport failed" }
  }
}

// 3. generateCampaignROIReport
export async function generateCampaignROIReport(
  input: GenerateCampaignROIInput
): Promise<KernelReportingResult<CampaignROIReport>> {
  try {
    const supabase = await createServiceClient()
    const { ctx } = input

    // Join campaign_roi with marketing_campaigns for name + budget
    const { data: roiRows, error: roiErr } = await supabase
      .from("campaign_roi")
      .select(`
        id, marketing_campaign_id, total_spend, total_leads, total_conversions,
        total_revenue, roi_percentage,
        marketing_campaigns(campaign_name, status, budget_total, budget_spent)
      `)
      .eq("brokerage_id", ctx.brokerageId)
      .order("roi_percentage", { ascending: false })
      .limit(50)

    if (roiErr) throw roiErr

    const campaigns = (roiRows ?? []).map(row => {
      const mc = (row.marketing_campaigns as unknown as Record<string, unknown> | null) ?? {}
      const spend    = row.total_spend     ?? 0
      const leads    = row.total_leads     ?? 0
      const budSpent = (mc.budget_spent as number | null) ?? 0
      const budTotal = (mc.budget_total as number | null) ?? null
      return {
        id:                  row.id,
        campaign_name:       (mc.campaign_name as string) ?? "Unnamed Campaign",
        status:              (mc.status as string | null) ?? null,
        total_spend:         spend,
        total_leads:         leads,
        total_conversions:   row.total_conversions  ?? 0,
        total_revenue:       row.total_revenue      ?? 0,
        roi_percentage:      row.roi_percentage     ?? 0,
        cost_per_lead:       leads > 0 ? parseFloat((spend / leads).toFixed(2)) : 0,
        budget_total:        budTotal,
        budget_spent:        budSpent,
        budget_utilization:  budTotal && budTotal > 0 ? Math.round((budSpent / budTotal) * 100) : 0,
      }
    })

    const totals = {
      total_spend:   campaigns.reduce((s, c) => s + c.total_spend,   0),
      total_revenue: campaigns.reduce((s, c) => s + c.total_revenue, 0),
      total_leads:   campaigns.reduce((s, c) => s + c.total_leads,   0),
      overall_roi:   0,
    }
    totals.overall_roi = totals.total_spend > 0
      ? parseFloat(((totals.total_revenue / totals.total_spend) * 100).toFixed(1))
      : 0

    return { success: true, data: { campaigns, totals } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "generateCampaignROIReport failed" }
  }
}

// 4. generateTransactionPipelineReport
export async function generateTransactionPipelineReport(
  input: GenerateTransactionPipelineInput
): Promise<KernelReportingResult<TransactionPipelineReport>> {
  try {
    const supabase = await createServiceClient()
    const { ctx, agentId } = input

    let q = supabase
      .from("transactions")
      .select("id, status, stage, purchase_price, commission_amount, close_date, created_at")
      .eq("brokerage_id", ctx.brokerageId)

    if (agentId) q = q.eq("agent_id", agentId)
    else if (ctx.userType === "agent") q = q.eq("agent_id", ctx.agentId)

    const { data: txs, error } = await q
    if (error) throw error

    // Group by stage
    const stageMap = new Map<string, { count: number; total_value: number; days: number[] }>()
    const ytdStart_ = new Date(`${currentYear()}-01-01`)
    let closedYTD = 0, closedYTDValue = 0

    for (const t of txs ?? []) {
      const stage = t.stage ?? t.status ?? "unknown"
      if (!stageMap.has(stage)) stageMap.set(stage, { count: 0, total_value: 0, days: [] })
      const bucket = stageMap.get(stage)!
      bucket.count++
      bucket.total_value += t.purchase_price ?? 0
      if (t.created_at) {
        const days = Math.round((Date.now() - new Date(t.created_at).getTime()) / (1000 * 60 * 60 * 24))
        bucket.days.push(days)
      }
      if ((t.status === "closed" || t.status === "completed") && t.close_date) {
        if (new Date(t.close_date) >= ytdStart_) {
          closedYTD++
          closedYTDValue += t.commission_amount ?? (t.purchase_price ? t.purchase_price * 0.03 : 0)
        }
      }
    }

    const byStage = Array.from(stageMap.entries()).map(([stage, b]) => ({
      stage,
      count:             b.count,
      total_value:       b.total_value,
      avg_days_in_stage: b.days.length > 0
        ? Math.round(b.days.reduce((s, d) => s + d, 0) / b.days.length)
        : 0,
    }))

    const totalPipelineValue = byStage
      .filter(b => !["closed", "completed", "cancelled", "lost"].includes(b.stage))
      .reduce((s, b) => s + b.total_value, 0)

    return { success: true, data: { byStage, totalPipelineValue, closedYTD, closedYTDValue } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "generateTransactionPipelineReport failed" }
  }
}

// 5. generateTeamPerformanceReport
export async function generateTeamPerformanceReport(
  input: GenerateTeamPerformanceInput
): Promise<KernelReportingResult<TeamPerformanceReport>> {
  try {
    const supabase = await createServiceClient()
    const { ctx } = input

    // team_performance has no team_name/agent_count; name comes via teams FK embed.
    const { data: teamPerf, error } = await supabase
      .from("team_performance")
      .select("id, team_id, total_revenue, goal_amount, teams(name)")
      .eq("brokerage_id", ctx.brokerageId)
      .order("total_revenue", { ascending: false })
      .limit(20)

    if (error) throw error

    const teams = (teamPerf ?? []).map(t => ({
      id:             t.id,
      team_name:      ((t.teams as { name?: string } | null)?.name) ?? "Unnamed Team",
      total_revenue:  t.total_revenue  ?? 0,
      goal_amount:    t.goal_amount    ?? 0,
      attainment_pct: t.goal_amount && t.goal_amount > 0
        ? Math.round(((t.total_revenue ?? 0) / t.goal_amount) * 100)
        : 0,
      agent_count:    0, // no agent_count column on team_performance
    }))

    return { success: true, data: { teams } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "generateTeamPerformanceReport failed" }
  }
}

// 6. generateAgentPerformanceReport — WRITES to agent_performance_reports
export async function generateAgentPerformanceReport(
  input: GenerateAgentPerformanceInput
): Promise<KernelReportingResult<AgentPerformanceReport>> {
  try {
    const supabase = await createServiceClient()
    const { ctx, periodStart, periodEnd, agentId: targetAgentId } = input
    const agentId = targetAgentId ?? ctx.agentId

    const [
      { data: commissions },
      { data: expenses },
      { data: reviews },
      { data: contacts },
      { data: closedTxs },
    ] = await Promise.all([
      supabase
        .from("agent_commissions")
        .select("gross_commission, agent_commission")
        .eq("agent_id", agentId)
        .gte("close_date", periodStart)
        .lte("close_date", periodEnd),
      supabase
        .from("business_expenses")
        .select("amount")
        .eq("agent_id", agentId)
        .gte("expense_date", periodStart)
        .lte("expense_date", periodEnd),
      supabase
        .from("agent_reviews")
        .select("rating, response_text")
        .eq("agent_id", agentId)
        .eq("brokerage_id", ctx.brokerageId),
      supabase
        .from("contacts")
        .select("id")
        .eq("brokerage_id", ctx.brokerageId)
        .eq("agent_id", agentId)
        .gte("created_at", periodStart)
        .lte("created_at", periodEnd),
      supabase
        .from("transactions")
        .select("id, purchase_price")
        .eq("brokerage_id", ctx.brokerageId)
        .eq("agent_id", agentId)
        .eq("status", "closed")
        .gte("close_date", periodStart)
        .lte("close_date", periodEnd),
    ])

    const ytdGci          = (commissions ?? []).reduce((s, c) => s + (c.gross_commission ?? 0), 0)
    const ytdAgentComm    = (commissions ?? []).reduce((s, c) => s + (c.agent_commission ?? 0), 0)
    const totalExpenses   = (expenses    ?? []).reduce((s, e) => s + (e.amount          ?? 0), 0)
    const totalReviews    = reviews?.length ?? 0
    const avgRating       = totalReviews > 0
      ? parseFloat(((reviews ?? []).reduce((s, r) => s + (r.rating ?? 0), 0) / totalReviews).toFixed(1))
      : 0
    const newContacts     = contacts?.length ?? 0
    const closedDeals     = closedTxs?.length ?? 0
    const netIncome       = ytdAgentComm - totalExpenses
    const conversionRate  = newContacts > 0 ? Math.round((closedDeals / newContacts) * 100) : 0

    const metrics = {
      ytdGci, ytdTransactions: closedDeals, avgRating, totalReviews,
      newContacts, closedDeals, totalExpenses, netIncome, conversionRate,
    }

    // Save to agent_performance_reports
    const { data: saved, error: saveErr } = await supabase
      .from("agent_performance_reports")
      .insert({
        agent_id:     agentId,
        brokerage_id: ctx.brokerageId,
        period_start: periodStart,
        period_end:   periodEnd,
        metrics:      metrics,
        created_at:   new Date().toISOString(),
      })
      .select("id")
      .maybeSingle()

    if (saveErr) throw saveErr

    const reportId = saved?.id ?? crypto.randomUUID()
    await emitEvent(supabase, ctx, KernelEvent.REPORT_GENERATED, reportId, {
      reportType: "agent_performance",
      agentId,
      periodStart,
      periodEnd,
    })

    return {
      success: true,
      data: { reportId, agentId, periodStart, periodEnd, metrics },
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "generateAgentPerformanceReport failed" }
  }
}

// 7. generateFinancialSummaryReport
export async function generateFinancialSummaryReport(
  input: GenerateFinancialSummaryInput
): Promise<KernelReportingResult<FinancialSummaryReport>> {
  try {
    const supabase = await createServiceClient()
    const { ctx, dateFrom, dateTo } = input
    const from = dateFrom ?? ytdStart()
    const to   = dateTo   ?? new Date().toISOString().slice(0, 10)

    const [
      { data: commissions, error: commErr },
      { data: expenses,    error: expErr  },
    ] = await Promise.all([
      supabase
        .from("agent_commissions")
        .select("id, gross_commission, agent_commission, brokerage_commission, close_date, transaction_id")
        .eq("agent_id", ctx.agentId)
        .gte("close_date", from)
        .lte("close_date", to)
        .order("close_date", { ascending: false }),
      supabase
        .from("business_expenses")
        .select("id, amount, category, expense_date")
        .eq("agent_id", ctx.agentId)       // no brokerage_id column on business_expenses
        .gte("expense_date", from)
        .lte("expense_date", to)
        .order("expense_date", { ascending: false }),
    ])

    if (commErr) throw commErr
    if (expErr)  throw expErr

    const ytdGrossCommission     = (commissions ?? []).reduce((s, c) => s + (c.gross_commission     ?? 0), 0)
    const ytdAgentCommission     = (commissions ?? []).reduce((s, c) => s + (c.agent_commission     ?? 0), 0)
    const ytdBrokerageCommission = (commissions ?? []).reduce((s, c) => s + (c.brokerage_commission ?? 0), 0)
    const ytdExpenses            = (expenses    ?? []).reduce((s, e) => s + (e.amount               ?? 0), 0)
    const ytdNetIncome           = ytdAgentCommission - ytdExpenses

    return {
      success: true,
      data: {
        ytdGrossCommission,
        ytdAgentCommission,
        ytdBrokerageCommission,
        ytdExpenses,
        ytdNetIncome,
        recentCommissions: (commissions ?? []).slice(0, 10) as FinancialSummaryReport["recentCommissions"],
        recentExpenses:    (expenses    ?? []).slice(0, 10) as FinancialSummaryReport["recentExpenses"],
      },
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "generateFinancialSummaryReport failed" }
  }
}

// 8. generateReputationReport
export async function generateReputationReport(
  input: GenerateReputationInput
): Promise<KernelReportingResult<ReputationReport>> {
  try {
    const supabase = await createServiceClient()
    const { ctx, agentId: targetAgentId } = input
    const agentId = targetAgentId ?? ctx.agentId

    const { data: reviews, error } = await supabase
      .from("agent_reviews")
      .select("id, rating, review_text, platform, is_published, response_text, created_at")
      .eq("agent_id",     agentId)
      .eq("brokerage_id", ctx.brokerageId)
      .order("created_at", { ascending: false })

    if (error) throw error

    const totalReviews = reviews?.length ?? 0
    const avgRating    = totalReviews > 0
      ? parseFloat((((reviews ?? []).reduce((s: number, r: Record<string, unknown>) => s + ((r.rating as number) ?? 0), 0)) / totalReviews).toFixed(1))
      : 0
    const responded    = (reviews ?? []).filter((r: Record<string, unknown>) => r.response_text).length
    const responseRate = totalReviews > 0 ? Math.round((responded / totalReviews) * 100) : 0

    // By platform
    const platformMap = new Map<string, { count: number; ratingSum: number; responded: number }>()
    for (const r of reviews ?? []) {
      const review = r as Record<string, unknown>
      const plat = (review.platform as string) ?? "other"
      if (!platformMap.has(plat)) platformMap.set(plat, { count: 0, ratingSum: 0, responded: 0 })
      const p = platformMap.get(plat)!
      p.count++
      p.ratingSum += (review.rating as number) ?? 0
      if (review.response_text) p.responded++
    }

    const byPlatform = Array.from(platformMap.entries()).map(([platform, p]) => ({
      platform,
      count:      p.count,
      avg_rating: p.count > 0 ? parseFloat((p.ratingSum / p.count).toFixed(1)) : 0,
      responded:  p.responded,
    })).sort((a, b) => b.count - a.count)

    return {
      success: true,
      data: {
        totalReviews,
        avgRating,
        responseRate,
        byPlatform,
        recentReviews: (reviews ?? []).slice(0, 10) as ReputationReport["recentReviews"],
      },
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "generateReputationReport failed" }
  }
}

// 9. exportReportCsv — no DB write; returns CSV string to caller for browser download
export async function exportReportCsv(
  input: ExportReportCsvInput
): Promise<KernelReportingResult<ExportReportCsvOutput>> {
  try {
    const { ctx, reportType, rows, columns } = input

    const header = columns.join(",")
    const body   = rows.map(row =>
      columns.map(col => {
        const val = row[col]
        if (val === null || val === undefined) return ""
        const str = String(val)
        return str.includes(",") || str.includes('"') || str.includes("\n")
          ? `"${str.replace(/"/g, '""')}"`
          : str
      }).join(",")
    ).join("\n")

    const csv      = `${header}\n${body}`
    const filename = `${reportType}-${new Date().toISOString().slice(0, 10)}.csv`

    // Emit event (fire and forget — no await needed for export CSV)
    const supabase = await createServiceClient()
    await emitEvent(supabase, ctx, KernelEvent.REPORT_EXPORTED_CSV, crypto.randomUUID(), {
      reportType, rowCount: rows.length,
    })

    return { success: true, data: { csv, filename } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "exportReportCsv failed" }
  }
}

// 10. exportReportPdf — uploads HTML to Vercel Blob, returns URL
// Does NOT write to generated_documents (non-existent table).
// Stores Blob URL in ai_assistant_notes for audit trail.
export async function exportReportPdf(
  input: ExportReportPdfInput
): Promise<KernelReportingResult<ExportReportPdfOutput>> {
  try {
    const { ctx, reportType, title, htmlContent } = input
    const { put } = await import("@vercel/blob")

    const filename = `${reportType}-${ctx.agentId}-${new Date().toISOString().slice(0, 10)}.html`
    const blob = await put(`reports/${filename}`, htmlContent, {
      access:      "public",
      contentType: "text/html; charset=utf-8",
    })

    const supabase = await createServiceClient()

    // Store Blob URL in ai_assistant_notes for audit trail
    await supabase.from("ai_assistant_notes").insert({
      brokerage_id: ctx.brokerageId, // NOT NULL
      created_by:   ctx.userId,      // NOT NULL (no agent_id column)
      entity_type:  "report",
      entity_id:    crypto.randomUUID(),
      note_text:    JSON.stringify({ type: "pdf_export", url: blob.url, title, reportType }), // was phantom note
      source:       "ai_assistant",
      created_at:   new Date().toISOString(),
    }).select()

    await emitEvent(supabase, ctx, KernelEvent.REPORT_EXPORTED_PDF, crypto.randomUUID(), {
      reportType, blobUrl: blob.url,
    })

    return { success: true, data: { pdfUrl: blob.url, filename } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "exportReportPdf failed" }
  }
}

// 11. emailReport — inserts to email_queue
export async function emailReport(
  input: EmailReportInput
): Promise<KernelReportingResult<{ queued: boolean }>> {
  try {
    const { ctx, to, reportType, subject, body } = input

    if (!to || !to.includes("@")) {
      return { success: false, error: "Invalid email address." }
    }

    const supabase = await createServiceClient()

    const { error } = await supabase.from("email_queue").insert({
      to_email:     to, // real column (was phantom `to`)
      subject,
      body,
      metadata:     { agent_id: ctx.agentId }, // no agent_id column on email_queue
      brokerage_id: ctx.brokerageId,
      status:      "pending",
      created_at:  new Date().toISOString(),
    }).select()

    if (error) throw error

    await emitEvent(supabase, ctx, KernelEvent.REPORT_EMAILED, crypto.randomUUID(), {
      reportType, to,
    })

    return { success: true, data: { queued: true } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "emailReport failed" }
  }
}
