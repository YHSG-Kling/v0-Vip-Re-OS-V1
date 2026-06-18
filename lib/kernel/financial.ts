// lib/kernel/financial.ts
//
// FINANCIAL CANONICAL MANAGER — Layer 0 ownership
//
// All financial operations: commission approval, payment, cap tracking,
// expense creation, and reporting flow through these commands only.
//
// Kernel Ownership Rules:
//   - NO direct DB writes for financial data outside this file
//   - Every mutation emits a KernelEvent via lifecycle_events
//   - business_expenses has NO brokerage_id column — filter by agent_id only
//   - agent_commissions.status transitions: pending → approved → paid
//   - agent_cap_tracking is source of truth for cap state (not agents.cap_progress)
//   - All functions are pure async — no global state, no module-level DB calls
//
// Explicit Commands:
//   1. loadFinancialWorkspace — read-only workspace baseline
//   2. loadAgentFinancialSummary — agent personal earnings
//   3. loadBrokerageFinancialSummary — brokerage-wide earnings + splits
//   4. loadCommissionQueue — pending + approved commissions for workflow
//   5. loadCommissionDistributions — commission splits by recipient
//   6. recalculateCommissionState — trigger cap recalc + audit trail
//   7. markCommissionApproved — status: pending → approved
//   8. markCommissionPaid — status: approved → paid
//   9. createExpenseRecord — new business expense
//   10. exportFinancialReport — CSV/PDF export with audit trail
//   11. emailFinancialReport — send report via email_queue

import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "./events"
import { processKernelEvent } from "./notification-engine"


// ─── CONSTANTS & ENUMS ────────────────────────────────────────────────────────

// Mirrors the agent_commissions_status_check DB constraint:
// status ∈ (pending, approved, paid, disputed).
const COMMISSION_STATUS_TRANSITIONS: Record<string, string[]> = {
  pending:    ["approved", "disputed"],
  approved:   ["paid", "disputed"],
  paid:       [],                      // terminal
  disputed:   [],                      // terminal
}

const VALID_EXPENSE_CATEGORIES = [
  "marketing",
  "training",
  "technology",
  "office_supplies",
  "travel",
  "professional_services",
  "other",
] as const
type ExpenseCategory = typeof VALID_EXPENSE_CATEGORIES[number]

// ─── INPUT / OUTPUT TYPES ─────────────────────────────────────────────────────

export interface FinancialActorContext {
  userId:      string
  agentId:     string | null
  brokerageId: string
  userType:    "agent" | "team_lead" | "broker" | "admin" | "superadmin"
}

export interface KernelFinancialResult<T = void> {
  success: boolean
  data?:   T
  error?:  string
}

// ─── READ-ONLY TYPES ──────────────────────────────────────────────────────────
export interface AgentProfitLossSummary {
  agentId: string
  totalIncome: number
  totalExpenses: number
  netProfit: number
  closedTransactions: number
}

export interface AgentFinancialDashboardSummary {
  agentId: string
  mtdEarnings: {
    gross_commission: number
    agent_net: number
  }
  ytdEarnings: {
    gross_commission: number
    agent_net: number
  }
  expenses: Array<{
    id: string
    category: string
    amount: number
    description: string | null
    receipt_url: string | null
    expense_date: string
  }>
  pendingCommissions: any[]
  teamSplits: any[]
  bonusCredits: any[]
  monthlyTrendData: any[]
  ytdTransactionCount: number
  commissionProfile: any | null
  capTracking: {
    capAmount: number
    capPaidToDate: number
    capIsCapped: boolean
    capProgressPct: number
    anniversaryStart: string
    anniversaryEnd: string
  }
  agentData: any | null
  pipelineTransactions: any[]
  earningsHistory: any[]
}
export interface FinancialWorkspace {
  agentId:      string | null
  brokerageId:  string
  userType:     string
  accessLevel:  "personal" | "team" | "brokerage" | "system"
  validatedAt:  string
}

export interface AgentFinancialSummary {
  agentId:          string
  mtdGCI:           number
  mtdAgentNet:      number
  ytdGCI:           number
  ytdAgentNet:      number
  ytdTransactionCount: number
  capAmount:        number
  capPaidToDate:    number
  capIsCapped:      boolean
  capProgressPct:   number
  anniversaryStart: string
  anniversaryEnd:   string
}

export interface BrokerageFinancialSummary {
  brokerageId:         string
  mtdGrossIncome:      number
  mtdAgentSplits:      number
  mtdBrokerageNet:     number
  ytdGrossIncome:      number
  ytdAgentSplits:      number
  ytdBrokerageNet:     number
  teamCount:           number
  agentCount:          number
  pendingCommissions:  number
  approvedCommissions: number
}

export interface CommissionRecord {
  id:               string
  agentId:          string
  transactionId:    string | null
  grossCommission:  number
  agentCommission:  number
  brokerageCommission: number
  status:           string
  side:             string | null
  closeDate:        string
  createdAt:        string
}

export interface CommissionDistribution {
  id:                 string
  agentId:            string
  recipientId:        string | null
  recipientName:      string | null
  type:               string
  calculatedAmount:   number
  status:             string
  paidAt:             string | null
}

export interface ExpenseRecord {
  id:          string
  agentId:     string
  category:    string
  amount:      number
  description: string | null
  receiptUrl:  string | null
  expenseDate: string
  createdAt:   string
}

export interface FinancialExportResult {
  fileUrl:     string
  format:      "csv" | "pdf"
  generatedAt: string
}

// ─── INPUT CONTRACTS ──────────────────────────────────────────────────────────
export interface CreateCommissionRecordInput {
  ctx: FinancialActorContext
  agentId: string
  transactionId: string
  grossCommission: number
  splitPercentage: number
  brokerageFee?: number
  franchiseFee?: number
  additionalFees?: Array<{ name: string; amount: number }>
}

export interface CreatedCommissionRecord {
  id: string
  grossCommission: number
  agentSplit: number
  brokerageShare: number
  agentGross: number
  feesTotal: number
  cappedAmount: number
  agentNet: number
}

export interface LoadFinancialWorkspaceInput {
  ctx: FinancialActorContext
}

export interface LoadAgentFinancialSummaryInput {
  ctx:        FinancialActorContext
  agentId:    string
  periodType?: "mtd" | "ytd" | "custom"
}

export interface LoadBrokerageFinancialSummaryInput {
  ctx:        FinancialActorContext
  brokerageId: string
  periodType?: "mtd" | "ytd"
}

export interface LoadCommissionQueueInput {
  ctx:         FinancialActorContext
  brokerageId: string
  statusFilter?: ("pending" | "approved" | "paid")[]
}

export interface LoadCommissionDistributionsInput {
  ctx:         FinancialActorContext
  brokerageId: string
  agentId?:    string
}

export interface RecalculateCommissionStateInput {
  ctx:         FinancialActorContext
  brokerageId: string
}

export interface MarkCommissionApprovedInput {
  ctx:          FinancialActorContext
  commissionId: string
  brokerageId:  string
  approvedBy:   string
}

export interface MarkCommissionPaidInput {
  ctx:          FinancialActorContext
  commissionId: string
  brokerageId:  string
  paidAt?:      string
  method?:      string
}

export interface CreateExpenseRecordInput {
  ctx:         FinancialActorContext
  agentId:     string
  category:    string
  amount:      number
  description?: string
  receiptUrl?: string
  expenseDate?: string
}

export interface ExportFinancialReportInput {
  ctx:         FinancialActorContext
  brokerageId: string
  format:      "csv" | "pdf"
  reportType:  string
  dateFrom?:   string
  dateTo?:     string
}

export interface EmailFinancialReportInput {
  ctx:         FinancialActorContext
  brokerageId: string
  recipients:  string[]
  reportType:  string
  subject?:    string
  message?:    string
}

// ─── COMMAND IMPLEMENTATIONS ──────────────────────────────────────────────────

/**
 * loadFinancialWorkspace — Verify actor identity + determine access level
 */
export async function loadFinancialWorkspace(
  input: LoadFinancialWorkspaceInput
): Promise<KernelFinancialResult<FinancialWorkspace>> {
  const { ctx } = input
  const supabase = createServiceClient()

  try {
    // Determine access level first — broker/admin users may not have an agents row
    let accessLevel: "personal" | "team" | "brokerage" | "system" = "personal"
    if (ctx.userType === "team_lead") accessLevel = "team"
    if (ctx.userType === "broker" || ctx.userType === "admin") accessLevel = "brokerage"
    if (ctx.userType === "superadmin") accessLevel = "system"

    if (ctx.agentId) {
      // Agent path: verify identity via agents table
      const { data: agent } = await supabase
        .from("agents")
        .select("id, user_id, brokerage_id")
        .eq("id", ctx.agentId)
        .eq("user_id", ctx.userId)
        .maybeSingle()

      if (!agent) {
        return { success: false, error: "Agent identity verification failed" }
      }
    } else {
      // Broker/admin path: no agents row — verify they belong to the brokerage.
      // brokerages has no owner_id column; canonical membership is users.brokerage_id.
      const { data: ownerUser } = await supabase
        .from("users")
        .select("id")
        .eq("id", ctx.userId)
        .eq("brokerage_id", ctx.brokerageId)
        .maybeSingle()

      if (!ownerUser) {
        // Also accept admin users with a matching agents row linked to the brokerage
        const { data: adminAgent } = await supabase
          .from("agents")
          .select("id")
          .eq("user_id", ctx.userId)
          .eq("brokerage_id", ctx.brokerageId)
          .maybeSingle()

        if (!adminAgent) {
          return { success: false, error: "Brokerage identity verification failed" }
        }
      }
    }

    return {
      success: true,
      data: {
        agentId:     ctx.agentId,
        brokerageId: ctx.brokerageId,
        userType:    ctx.userType,
        accessLevel,
        validatedAt: new Date().toISOString(),
      },
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * loadAgentFinancialSummary — Agent personal earnings snapshot
 */
export async function loadAgentFinancialSummary(
  input: LoadAgentFinancialSummaryInput
): Promise<KernelFinancialResult<AgentFinancialSummary>> {
  const { ctx, agentId } = input
  const supabase = createServiceClient()

  try {
    // Fetch agent_earnings for MTD and YTD
    const { data: earnings } = await supabase
      .from("agent_earnings")
      .select("*")
      .eq("agent_id", agentId)
      .eq("brokerage_id", ctx.brokerageId)
      .in("period_type", ["mtd", "ytd"])

    // Fetch agent_cap_tracking for cap state
    const { data: capData } = await supabase
      .from("agent_cap_tracking")
      .select("*")
      .eq("agent_id", agentId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    const mtdEarning = earnings?.find((e) => e.period_type === "mtd")
    const ytdEarning = earnings?.find((e) => e.period_type === "ytd")

    return {
      success: true,
      data: {
        agentId,
        mtdGCI:           mtdEarning?.gross_commission ?? 0,
        mtdAgentNet:      mtdEarning?.agent_net ?? 0,
        ytdGCI:           ytdEarning?.gross_commission ?? 0,
        ytdAgentNet:      ytdEarning?.agent_net ?? 0,
        ytdTransactionCount: ytdEarning?.transaction_count ?? 0,
        capAmount:        capData?.cap_amount ?? 0,
        capPaidToDate:    capData?.cap_paid_to_date ?? 0,
        capIsCapped:      capData?.is_capped ?? false,
        capProgressPct:   capData ? (capData.cap_paid_to_date / capData.cap_amount) * 100 : 0,
        anniversaryStart: capData?.anniversary_start ?? "",
        anniversaryEnd:   capData?.anniversary_end ?? "",
      },
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * loadBrokerageFinancialSummary — Brokerage-wide earnings + splits
 */
export async function loadBrokerageFinancialSummary(
  input: LoadBrokerageFinancialSummaryInput
): Promise<KernelFinancialResult<BrokerageFinancialSummary>> {
  const { ctx, brokerageId } = input
  const supabase = createServiceClient()

  try {
    // Aggregate agent_earnings by brokerage
    const { data: earnings } = await supabase
      .from("agent_earnings")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .in("period_type", ["mtd", "ytd"])

    const mtdEarnings = earnings?.filter((e) => e.period_type === "mtd") ?? []
    const ytdEarnings = earnings?.filter((e) => e.period_type === "ytd") ?? []

    const mtdGross = mtdEarnings.reduce((sum, e) => sum + (e.gross_commission ?? 0), 0)
    const mtdAgentSplits = mtdEarnings.reduce((sum, e) => sum + (e.agent_net ?? 0), 0)
    const ytdGross = ytdEarnings.reduce((sum, e) => sum + (e.gross_commission ?? 0), 0)
    const ytdAgentSplits = ytdEarnings.reduce((sum, e) => sum + (e.agent_net ?? 0), 0)

    // Count agents and teams
    const { count: agentCount } = await supabase
      .from("agents")
      .select("*", { count: "exact", head: true })
      .eq("brokerage_id", brokerageId)

    const { data: commissions } = await supabase
      .from("agent_commissions")
      .select("status")
      .eq("brokerage_id", brokerageId)
      .in("status", ["pending", "approved"])

    const pendingCommissions = commissions?.filter((c) => c.status === "pending").length ?? 0
    const approvedCommissions = commissions?.filter((c) => c.status === "approved").length ?? 0

    return {
      success: true,
      data: {
        brokerageId,
        mtdGrossIncome:      mtdGross,
        mtdAgentSplits:      mtdAgentSplits,
        mtdBrokerageNet:     mtdGross - mtdAgentSplits,
        ytdGrossIncome:      ytdGross,
        ytdAgentSplits:      ytdAgentSplits,
        ytdBrokerageNet:     ytdGross - ytdAgentSplits,
        teamCount:           0,  // TODO: fetch from teams table
        agentCount:          agentCount ?? 0,
        pendingCommissions,
        approvedCommissions,
      },
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * loadCommissionQueue — Pending + approved commissions for approval/payout workflow
 */
export async function loadCommissionQueue(
  input: LoadCommissionQueueInput
): Promise<KernelFinancialResult<CommissionRecord[]>> {
  const { ctx, brokerageId, statusFilter } = input
  const supabase = createServiceClient()

  try {
    let query = supabase
      .from("agent_commissions")
      .select("*")
      .eq("brokerage_id", brokerageId)

    if (statusFilter && statusFilter.length > 0) {
      query = query.in("status", statusFilter)
    } else {
      query = query.in("status", ["pending", "approved"])
    }

    const { data: commissions } = await query.order("close_date", { ascending: false })

    return {
      success: true,
      data: (commissions ?? []).map((c) => ({
        id:                  c.id,
        agentId:             c.agent_id,
        transactionId:       c.transaction_id,
        grossCommission:     c.gross_commission,
        agentCommission:     c.agent_commission,
        brokerageCommission: c.brokerage_commission,
        status:              c.status,
        side:                c.side,
        closeDate:           c.close_date,
        createdAt:           c.created_at,
      })),
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * loadCommissionDistributions — Commission splits by recipient
 */
export async function loadCommissionDistributions(
  input: LoadCommissionDistributionsInput
): Promise<KernelFinancialResult<CommissionDistribution[]>> {
  const { ctx, brokerageId, agentId } = input
  const supabase = createServiceClient()

  try {
    let query = supabase
      .from("commission_distributions")
      .select("*")
      .eq("brokerage_id", brokerageId)

    if (agentId) {
      query = query.eq("agent_id", agentId)
    }

    const { data: distributions } = await query

    return {
      success: true,
      data: (distributions ?? []).map((d) => ({
        id:               d.id,
        agentId:          d.agent_id,
        recipientId:      d.recipient_id,
        recipientName:    d.recipient_name ?? "",
        type:             d.distribution_type,
        calculatedAmount: d.calculated_amount,
        status:           d.status,
        paidAt:           d.paid_at,
      })),
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * recalculateCommissionState — Trigger cap recalculation + audit trail
 */
export async function recalculateCommissionState(
  input: RecalculateCommissionStateInput
): Promise<KernelFinancialResult<{ recalculated: number; capped: number; updated_at: string }>> {
  const { ctx, brokerageId } = input
  const supabase = createServiceClient()

  try {
    // Fetch all agent_cap_tracking records for this brokerage
    const { data: capTracking } = await supabase
      .from("agent_cap_tracking")
      .select("*")
      .eq("brokerage_id", brokerageId)

    // TODO: Implement anniversary logic to determine if each agent is capped
    const now = new Date()
    let capped = 0

    for (const record of capTracking ?? []) {
      const anniversaryEnd = new Date(record.anniversary_end)
      const isCapped = record.cap_paid_to_date >= record.cap_amount && now <= anniversaryEnd

      if (isCapped !== record.is_capped) {
        await supabase
          .from("agent_cap_tracking")
          .update({ is_capped: isCapped })
          .eq("id", record.id)
        if (isCapped) capped++
      }
    }

    // Emit lifecycle event
    await supabase
      .from("lifecycle_events")
      .insert({
        entity_type: "commission_state",
        entity_id:   brokerageId,
        event_type:  KernelEvent.COMMISSION_STATE_RECALCULATED,
        metadata:    { recalculated: capTracking?.length ?? 0, capped },
        created_at:  new Date().toISOString(),
      })

    return {
      success: true,
      data: {
        recalculated: capTracking?.length ?? 0,
        capped,
        updated_at: new Date().toISOString(),
      },
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * markCommissionApproved — Transition status: pending → approved
 */
export async function markCommissionApproved(
  input: MarkCommissionApprovedInput
): Promise<KernelFinancialResult<{ commissionId: string; oldStatus: string; newStatus: string; approvedAt: string }>> {
  const { ctx, commissionId, brokerageId, approvedBy } = input
  const supabase = createServiceClient()

  try {
    // Guard: only brokerage users can approve
    if (!["broker", "admin", "superadmin"].includes(ctx.userType)) {
      return { success: false, error: "Insufficient permissions to approve commissions" }
    }

    // Fetch commission
    const { data: commission } = await supabase
      .from("agent_commissions")
      .select("*")
      .eq("id", commissionId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (!commission) {
      return { success: false, error: "Commission not found" }
    }

    const oldStatus = commission.status
    const newStatus = "approved"

    // Validate transition
    if (!COMMISSION_STATUS_TRANSITIONS[oldStatus]?.includes(newStatus)) {
      return { success: false, error: `Invalid status transition: ${oldStatus} → ${newStatus}` }
    }

    // Update status
    const approvedAt = new Date().toISOString()
    await supabase
      .from("agent_commissions")
      .update({ status: newStatus, approved_at: approvedAt, approved_by: approvedBy })
      .eq("id", commissionId)

    // Emit lifecycle event
    await supabase
      .from("lifecycle_events")
      .insert({
        entity_type: "agent_commission",
        entity_id:   commissionId,
        event_type:  KernelEvent.COMMISSION_APPROVED,
        metadata:    { oldStatus, newStatus, approvedBy },
        created_at:  approvedAt,
      })

    return {
      success: true,
      data: { commissionId, oldStatus, newStatus, approvedAt },
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * markCommissionPaid — Transition status: approved → paid
 */
export async function markCommissionPaid(
  input: MarkCommissionPaidInput
): Promise<KernelFinancialResult<{ commissionId: string; paidAt: string; status: string }>> {
  const { ctx, commissionId, brokerageId, paidAt: paidAtInput, method } = input
  const supabase = createServiceClient()

  try {
    // Guard: only brokerage users can mark paid
    if (!["broker", "admin", "superadmin"].includes(ctx.userType)) {
      return { success: false, error: "Insufficient permissions to mark commissions as paid" }
    }

    // Fetch commission
    const { data: commission } = await supabase
      .from("agent_commissions")
      .select("*")
      .eq("id", commissionId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()

    if (!commission) {
      return { success: false, error: "Commission not found" }
    }

    const oldStatus = commission.status
    const newStatus = "paid"

    // Validate transition
    if (!COMMISSION_STATUS_TRANSITIONS[oldStatus]?.includes(newStatus)) {
      return { success: false, error: `Invalid status transition: ${oldStatus} → ${newStatus}` }
    }

    const paidAt = paidAtInput ?? new Date().toISOString()

    // Update status
    await supabase
      .from("agent_commissions")
      .update({ status: newStatus, paid_at: paidAt, payment_method: method ?? null })
      .eq("id", commissionId)

    // Emit lifecycle event
    await supabase
      .from("lifecycle_events")
      .insert({
        entity_type: "agent_commission",
        entity_id:   commissionId,
        event_type:  KernelEvent.COMMISSION_PAID,
        metadata:    { oldStatus, newStatus, paidAt, method },
        created_at:  paidAt,
      })

    // Update agent cap tracking (cap_paid_to_date)
    const { data: agentEarnings } = await supabase
      .from("agent_commissions")
      .select("agent_id, agent_commission")
      .eq("id", commissionId)
      .maybeSingle()

    if (agentEarnings) {
      const { data: capRecord } = await supabase
        .from("agent_cap_tracking")
        .select("cap_paid_to_date")
        .eq("agent_id", agentEarnings.agent_id)
        .eq("brokerage_id", brokerageId)
        .maybeSingle()

      if (capRecord) {
        await supabase
          .from("agent_cap_tracking")
          .update({
            cap_paid_to_date: (capRecord.cap_paid_to_date ?? 0) + (agentEarnings.agent_commission ?? 0),
          })
          .eq("agent_id", agentEarnings.agent_id)
          .eq("brokerage_id", brokerageId)
      }
    }

    return {
      success: true,
      data: { commissionId, paidAt, status: newStatus },
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * createExpenseRecord — New business expense
 */
export async function createExpenseRecord(
  input: CreateExpenseRecordInput
): Promise<KernelFinancialResult<ExpenseRecord>> {
  const { ctx, agentId, category, amount, description, receiptUrl, expenseDate } = input
  const supabase = createServiceClient()

  try {
    // Guard: owner can only create own expenses (unless broker/admin)
    if (ctx.agentId !== agentId && !["broker", "admin", "superadmin"].includes(ctx.userType)) {
      return { success: false, error: "Can only create expenses for yourself" }
    }

    // Validate category
    if (!VALID_EXPENSE_CATEGORIES.includes(category as ExpenseCategory)) {
      return { success: false, error: `Invalid expense category: ${category}` }
    }

    // Validate amount
    if (amount <= 0) {
      return { success: false, error: "Amount must be positive" }
    }

    const now = new Date().toISOString()
    const recordDate = expenseDate ?? new Date().toISOString().split("T")[0]

    // Insert expense record
    // NOTE: business_expenses has NO brokerage_id column — only agent_id
    const { data: expense, error: insertError } = await supabase
      .from("business_expenses")
      .insert({
        agent_id:     agentId,
        category,
        amount,
        description:  description ?? null,
        receipt_url:  receiptUrl ?? null,
        expense_date: recordDate,
        created_at:   now,
      })
      .select()
      .single()

    if (insertError) {
      return { success: false, error: `Insert failed: ${insertError.message}` }
    }

    // Emit lifecycle event
    await supabase
      .from("lifecycle_events")
      .insert({
        entity_type: "business_expense",
        entity_id:   expense.id,
        event_type:  KernelEvent.EXPENSE_CREATED,
        metadata:    { agentId, category, amount, description },
        created_at:  now,
      })

    return {
      success: true,
      data: {
        id:          expense.id,
        agentId,
        category,
        amount,
        description: description ?? null,
        receiptUrl:  receiptUrl ?? null,
        expenseDate: recordDate,
        createdAt:   now,
      },
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
export async function createCommissionRecord(
  input: CreateCommissionRecordInput
): Promise<KernelFinancialResult<CreatedCommissionRecord>> {
  const { ctx, agentId, transactionId, grossCommission, splitPercentage, brokerageFee, franchiseFee, additionalFees } = input
  const supabase = createServiceClient()

  try {
    // Cap state is owned by agent_cap_tracking (cap_amount, cap_paid_to_date) —
    // the agents table has no cap_current. agentId is agents.id (getAgentContext).
    const { data: capRow } = await supabase
      .from("agent_cap_tracking")
      .select("id, cap_amount, cap_paid_to_date")
      .eq("agent_id", agentId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    const agentSplit = splitPercentage
    const flatBrokerageFee = brokerageFee || 0
    const franchisePct = franchiseFee || 0

    let additionalFeesTotal = 0
    const feeBreakdown: Array<{ name: string; amount: number; type: string }> = []

    if (flatBrokerageFee > 0) {
      feeBreakdown.push({ name: "Brokerage Fee", amount: flatBrokerageFee, type: "flat" })
      additionalFeesTotal += flatBrokerageFee
    }

    if (franchisePct > 0) {
      const franchiseAmount = grossCommission * (franchisePct / 100)
      feeBreakdown.push({ name: "Franchise Fee", amount: franchiseAmount, type: "percentage" })
      additionalFeesTotal += franchiseAmount
    }

    if (additionalFees?.length) {
      for (const fee of additionalFees) {
        feeBreakdown.push({ name: fee.name, amount: fee.amount, type: "flat" })
        additionalFeesTotal += fee.amount
      }
    }

    const brokerageShare = grossCommission * ((100 - agentSplit) / 100)
    const agentGross = grossCommission * (agentSplit / 100)
    const agentNetBase = agentGross - additionalFeesTotal

    let cappedAmount = 0
    if (capRow?.cap_amount && capRow?.cap_paid_to_date != null) {
      const remainingToCap = capRow.cap_amount - capRow.cap_paid_to_date
      if (remainingToCap <= 0) {
        cappedAmount = brokerageShare
      }
    }

    const agentNet = agentNetBase + cappedAmount

    // Canonical commission table for this module is agent_commissions (the
    // queue/approve/pay/summary commands all read it). Columns: agent_split_percent,
    // agent_commission (agent net), brokerage_commission, status ∈ pending→approved→paid.
    const { data: commission, error } = await supabase
      // agent_commission and brokerage_commission are GENERATED columns
      // (computed from gross_commission + agent_split_percent) — never inserted.
      .from("agent_commissions")
      .insert({
        brokerage_id: ctx.brokerageId,
        agent_id: agentId,
        transaction_id: transactionId,
        gross_commission: grossCommission,
        agent_split_percent: agentSplit,
        close_date: new Date().toISOString(),
        status: "pending",
      })
      .select("id")
      .maybeSingle()

    if (error || !commission) {
      return { success: false, error: error?.message || "Failed to create commission record" }
    }

    if (capRow && !cappedAmount) {
      await supabase
        .from("agent_cap_tracking")
        .update({ cap_paid_to_date: (capRow.cap_paid_to_date || 0) + brokerageShare })
        .eq("id", capRow.id)
    }

    await processKernelEvent({
      event: KernelEvent.COMMISSION_PAID,
      brokerageId: ctx.brokerageId,
      entityType: "commission",
      entityId: commission.id,
    })

    return {
      success: true,
      data: {
        id: commission.id,
        grossCommission,
        agentSplit,
        brokerageShare,
        agentGross,
        feesTotal: additionalFeesTotal,
        cappedAmount,
        agentNet,
      },
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
/**
 * exportFinancialReport — CSV/PDF export with audit trail
 */
export async function exportFinancialReport(
  input: ExportFinancialReportInput
): Promise<KernelFinancialResult<FinancialExportResult>> {
  const { ctx, brokerageId, format, reportType, dateFrom, dateTo } = input
  const supabase = createServiceClient()

  try {
    // Guard: only authorized users can export
    if (!["broker", "admin", "superadmin"].includes(ctx.userType)) {
      return { success: false, error: "Insufficient permissions to export reports" }
    }

    // TODO: Implement CSV/PDF generation logic
    // For now, return a placeholder blob URL
    const generatedAt = new Date().toISOString()
    const filename = `financial-report-${reportType}-${generatedAt.split("T")[0]}.${format}`

    // Emit lifecycle event
    await supabase
      .from("lifecycle_events")
      .insert({
        entity_type: "financial_report",
        entity_id:   brokerageId,
        event_type:  format === "csv" ? KernelEvent.REPORT_EXPORTED_CSV : KernelEvent.REPORT_EXPORTED_PDF,
        metadata:    { reportType, dateFrom, dateTo, filename },
        created_at:  generatedAt,
      })

    return {
      success: true,
      data: {
        fileUrl:     `https://storage.example.com/${filename}`,  // Placeholder
        format,
        generatedAt,
      },
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * emailFinancialReport — Send report via email_queue
 */
export async function emailFinancialReport(
  input: EmailFinancialReportInput
): Promise<KernelFinancialResult<{ queuedAt: string; recipients: string[] }>> {
  const { ctx, brokerageId, recipients, reportType, subject, message } = input
  const supabase = createServiceClient()

  try {
    // Guard: only authorized users can email reports
    if (!["broker", "admin", "superadmin"].includes(ctx.userType)) {
      return { success: false, error: "Insufficient permissions to email reports" }
    }

    const queuedAt = new Date().toISOString()

    // Insert to email_queue (canonical columns: to_email NOT NULL, template, metadata jsonb,
    // status; no recipient_email/template_type/variables/priority/scheduled_for). One row per recipient.
    const { error: queueError } = await supabase
      .from("email_queue")
      .insert(
        recipients.map((to_email: string) => ({
          brokerage_id: brokerageId,
          to_email,
          subject:    subject ?? `Financial Report - ${reportType}`,
          body:       message ?? null,
          template:   "financial_report",
          metadata:   { reportType, message, brokerageId, priority: "normal" },
          status:     "pending",
          created_at: queuedAt,
        })),
      )

    if (queueError) {
      return { success: false, error: `Queue failed: ${queueError.message}` }
    }

    // Emit lifecycle event
    await supabase
      .from("lifecycle_events")
      .insert({
        entity_type: "email_report",
        entity_id:   brokerageId,
        event_type:  KernelEvent.REPORT_EMAILED,
        metadata:    { reportType, recipients, subject },
        created_at:  queuedAt,
      })

    return {
      success: true,
      data: { queuedAt, recipients },
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
export async function loadAgentProfitLossSummary(
  input: LoadAgentFinancialSummaryInput
): Promise<KernelFinancialResult<AgentProfitLossSummary>> {
  try {
    const base = await loadAgentFinancialSummary(input)
    if (!base.success || !base.data) {
      return { success: false, error: base.error || "Failed to load agent financial summary" }
    }

    const service = createServiceClient()

    const { data: expenses, error: expensesError } = await service
      .from("business_expenses")
      .select("amount")
      .eq("agent_id", input.agentId)

    if (expensesError) {
      return { success: false, error: expensesError.message }
    }

    const totalIncome = base.data.ytdAgentNet ?? 0
    const totalExpenses = (expenses ?? []).reduce((sum: number, row: any) => sum + (row.amount || 0), 0)

    return {
      success: true,
      data: {
        agentId: input.agentId,
        totalIncome,
        totalExpenses,
        netProfit: totalIncome - totalExpenses,
        closedTransactions: base.data.ytdTransactionCount ?? 0,
      },
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function loadAgentFinancialDashboardSummary(
  input: LoadAgentFinancialSummaryInput
): Promise<KernelFinancialResult<AgentFinancialDashboardSummary>> {
  try {
    const base = await loadAgentFinancialSummary(input)
    if (!base.success || !base.data) {
      return { success: false, error: base.error || "Failed to load agent financial summary" }
    }

    const service = createServiceClient()

    const [
      expensesResult,
      pendingResult,
      splitsResult,
      trendResult,
      profileResult,
      agentResult,
      pipelineResult,
      historyResult,
    ] = await Promise.all([
      service
        .from("business_expenses")
        .select("id, category, amount, description, receipt_url, expense_date")
        .eq("agent_id", input.agentId),

      service
        .from("agent_commissions")
        .select("*")
        .eq("agent_id", input.agentId)
        .in("status", ["pending", "approved"]),

      service
        .from("commission_distributions")
        .select("*")
        .eq("agent_id", input.agentId),

      service
        .from("agent_commissions")
        .select("gross_commission, agent_commission, close_date, paid_at")
        .eq("agent_id", input.agentId),

      service
        .from("agent_commission_profiles")
        .select("*")
        .eq("agent_id", input.agentId)
        .order("effective_date", { ascending: false })
        .limit(1)
        .maybeSingle(),

      service
        .from("agents")
        .select("*")
        .eq("id", input.agentId)
        .maybeSingle(),

      service
        .from("transactions")
        .select("*")
        .eq("agent_id", input.agentId)
        .in("status", ["active", "pending"]),

      service
        .from("agent_commissions")
        .select("*")
        .eq("agent_id", input.agentId)
        .order("created_at", { ascending: false })
        .limit(50),
    ])

    if (expensesResult.error) return { success: false, error: expensesResult.error.message }
    if (pendingResult.error) return { success: false, error: pendingResult.error.message }
    if (splitsResult.error) return { success: false, error: splitsResult.error.message }
    if (trendResult.error) return { success: false, error: trendResult.error.message }
    if (profileResult.error) return { success: false, error: profileResult.error.message }
    if (agentResult.error) return { success: false, error: agentResult.error.message }
    if (pipelineResult.error) return { success: false, error: pipelineResult.error.message }
    if (historyResult.error) return { success: false, error: historyResult.error.message }

    return {
      success: true,
      data: {
        agentId: input.agentId,
        mtdEarnings: {
          gross_commission: base.data.mtdGCI,
          agent_net: base.data.mtdAgentNet,
        },
        ytdEarnings: {
          gross_commission: base.data.ytdGCI,
          agent_net: base.data.ytdAgentNet,
        },
        expenses: expensesResult.data ?? [],
        pendingCommissions: pendingResult.data ?? [],
        teamSplits: splitsResult.data ?? [],
        bonusCredits: [],
        monthlyTrendData: trendResult.data ?? [],
        ytdTransactionCount: base.data.ytdTransactionCount,
        commissionProfile: profileResult.data ?? null,
        capTracking: {
          capAmount: base.data.capAmount,
          capPaidToDate: base.data.capPaidToDate,
          capIsCapped: base.data.capIsCapped,
          capProgressPct: base.data.capProgressPct,
          anniversaryStart: base.data.anniversaryStart,
          anniversaryEnd: base.data.anniversaryEnd,
        },
        agentData: agentResult.data ?? null,
        pipelineTransactions: pipelineResult.data ?? [],
        earningsHistory: historyResult.data ?? [],
      },
    }
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }
}
