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
//   - business_expenses HAS a brokerage_id column (and team_id). CORRECTED
//     2026-08-22: this line claimed the opposite, and createExpenseRecord below
//     already contradicts it. brokerage_id is NOT NULL since m516 and is stamped
//     from ctx.brokerageId; trigger business_expenses_derive_tenant is the DB
//     backstop for writers that omit it. Scope reads by tenant AND agent_id.
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
// BROKERAGE-WIDE MONEY GATES: every role check in this file guards commission /
// expense / report surfaces backed by the SERVICE client (RLS bypassed), so the
// app predicate is the only gate. Repointed from inline
// ["broker","admin","superadmin"] literals to THE finance roster
// (admin/broker/broker_owner — mirrors public.is_brokerage_finance_admin, m472):
// 'superadmin' was dead (0 live rows store that user_type; the platform's
// superadmin is user_type='admin' + platform_role='superadmin'), and
// broker_owner — a storable seat that OWNS the brokerage — was wrongly refused.
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { KernelEvent } from "./events"
import { processKernelEvent } from "./notification-engine"
import { syncAgentLedgerToStamp } from "@/lib/commission/ledger-sync"
import { resolveUserOffice, pickUserOffice } from "./resolve-user-office"
import { resolveLedTeamId } from "./resolve-user-team"
import { TRANSACTION_STATUSES_OPEN } from "@/lib/transactions/transaction-status"
import { readCapProgress } from "@/lib/finance/cap-progress"
import type { SupabaseClient } from "@supabase/supabase-js"
import { isPlatformSuperadminIdentity } from "@/lib/platform/platform-staff-roster"


// ─── CONSTANTS & ENUMS ────────────────────────────────────────────────────────

// Mirrors the agent_commissions_status_check DB constraint:
// status ∈ (pending, approved, paid, disputed).
const COMMISSION_STATUS_TRANSITIONS: Record<string, string[]> = {
  pending:    ["approved", "disputed"],
  approved:   ["paid", "disputed"],
  paid:       [],                              // terminal (disburse via payment tracking)
  disputed:   ["approved", "pending"],         // resolve: uphold/correct → approved, or reopen → pending
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
  /**
   * `users.platform_role` — the OTHER half of staff identity, and the half this
   * shape was missing. Same reason it exists on AuthResult in
   * lib/kernel/api-auth.ts: staff identity is DUAL-COLUMN, and the platform's
   * only superadmin on this database is (user_type='admin',
   * platform_role='superadmin'). A context carrying `userType` alone cannot
   * represent that person, so `ctx.userType === "superadmin"` was a test no live
   * account could ever pass.
   *
   * OPTIONAL AND NULL-BY-DEFAULT ON PURPOSE. Callers that legitimately do not
   * know the column simply omit it; `undefined` means "unknown", and
   * loadFinancialWorkspace then resolves the FACT from `users` rather than
   * assuming one. `null` means "known, and this person is not staff" — every
   * tenant user. Neither value ever grants anything on its own.
   */
  platformRole?: string | null
  /**
   * m526 — IS THIS ACTOR THE PRINCIPAL OF A TEAM-SCALE TENANT?
   *
   * OWNER RULING: on TEAM and SOLO tier the tenant's money IS the team's money,
   * so its lead reads and administers its books; on BROKERAGE tier the same
   * person is one of several leads in a larger office and m472/m473 stand — own
   * team only, never the office's P&L.
   *
   * RESOLVED ONCE, at context build, by
   * `lib/auth/resolve-user-role.ts#resolveTenantPrincipalTeamLead` — the app-side
   * twin of `public.is_tenant_principal_team_lead()`. It is carried here for the
   * same reason `platformRole` is: the eight gates below run on the SERVICE
   * client (RLS bypassed), so the app predicate is the ONLY gate, and they are
   * sync and cannot await a two-query lookup eight times.
   *
   * OPTIONAL AND FAIL-CLOSED. `undefined` means "nobody resolved this" and
   * `null` means "resolved, and no"; only an explicit `true` widens anybody.
   * A caller that cannot run the resolution therefore gets today's behaviour
   * exactly, never a free grant.
   */
  isTenantPrincipal?: boolean | null
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
  /**
   * The team this actor LEADS (`teams.team_lead_id = userId`), or null. It is
   * returned because `accessLevel: "team"` is otherwise an unusable answer — it
   * says "scope this to your team" without naming the team, which is what forced
   * every team surface to re-derive it from `users.team_id` and get a different
   * answer. Null for everyone who leads no team, including brokerage/system
   * actors whose wider scope does not come from a team link.
   */
  teamId:       string | null
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
 * `users.platform_role` for one actor — the half of staff identity a caller may
 * not have been able to supply.
 *
 * MODULE-PRIVATE. It exists so a context built by a caller that never read the
 * column (`ctx.platformRole === undefined`) degrades to READING THE FACT rather
 * than to assuming the person is not staff — which is precisely how the live
 * superadmin was being refused. A caller that HAS read the column passes it
 * (including as an explicit `null`) and no second query happens.
 *
 * The error is DESTRUCTURED: supabase-js resolves a refused read, so `const
 * { data }` alone would report "permission denied" as "not staff". A refusal
 * here returns null, which is fail-CLOSED — it can only ever narrow somebody to
 * the scope their user_type already earns them, never widen them — but it is
 * logged, because null is otherwise indistinguishable from a genuine tenant user.
 */
async function resolveActorPlatformRole(
  client: SupabaseClient<any, any, any>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await client
    .from("users")
    .select("platform_role")
    .eq("id", userId)
    .maybeSingle()

  if (error) {
    console.error(`[financial] users.platform_role read REFUSED for ${userId}: ${error.message}`)
    return null
  }
  return (data as { platform_role?: string | null } | null)?.platform_role ?? null
}

/**
 * loadFinancialWorkspace — Verify actor identity + determine access level
 */
export async function loadFinancialWorkspace(
  input: LoadFinancialWorkspaceInput
): Promise<KernelFinancialResult<FinancialWorkspace>> {
  const { ctx } = input
  const supabase = createServiceClient()

  try {
    // ── ACCESS LEVEL — resolved from FACTS, not from the `user_type` label ────
    //
    // This block used to read:
    //
    //     if (ctx.userType === "team_lead")  accessLevel = "team"
    //     if (ctx.userType === "superadmin") accessLevel = "system"
    //
    // and both tests were inverted against the live database.
    //
    // TEAM. The owner's ruling is "a team lead is an agent that runs their own
    // team". Measured live, teamlead@vip.demo is user_type='agent' and LEADS one
    // team — so the label test gave the real lead accessLevel="personal" and they
    // never saw their team's numbers — while buyer@yourbrokerage.com is
    // user_type='team_lead' and leads NOTHING, so the label test handed them a
    // team scope for a team that does not exist. The fact is the
    // `teams.team_lead_id` FK, which is what RLS was moved onto in m444 via
    // public.current_user_led_team_id(). resolveLedTeamId() is that function's
    // app-side twin, so the app and the database now give the same answer.
    //
    // SYSTEM. Staff identity is DUAL-COLUMN and the platform's only superadmin is
    // (user_type='admin', platform_role='superadmin') — `ctx.userType ===
    // "superadmin"` alone described nobody. Both columns are read, which is the
    // same shape public.is_platform_admin() uses in RLS and requireSuperadmin()
    // uses in app/actions/superadmin/platform-staff.ts. platform_role='superadmin'
    // is written solely by the superadmin-gated staff CRUD, so this widens to the
    // genuine superadmin and to nobody else.
    //
    // BROKER/ADMIN IS DELIBERATELY UNTOUCHED — 'broker' and 'admin' are real
    // user_type values held by real brokerage users, and brokerage scope is still
    // exactly what they get.
    //
    // ORDER IS PRECEDENCE, WIDEST LAST: a broker who also leads a team keeps
    // brokerage scope (wider), and the superadmin keeps system scope, rather than
    // being narrowed to one team by the lead link.
    const platformRole =
      ctx.platformRole !== undefined
        ? ctx.platformRole
        : await resolveActorPlatformRole(supabase, ctx.userId)
    // ONE DEFINITION (ruling 1) — lib/platform/platform-staff-roster.ts:isPlatformSuperadminIdentity
    const isSuperadmin = isPlatformSuperadminIdentity(ctx.userType, platformRole)

    const ledTeamId = await resolveLedTeamId(supabase, ctx.userId)

    let accessLevel: "personal" | "team" | "brokerage" | "system" = "personal"
    if (ledTeamId) accessLevel = "team"
    // m526 — ON A TEAM-SCALE TENANT THE LEAD'S TEAM SCOPE *IS* THE TENANT SCOPE.
    // Placed above broker/admin and below superadmin, keeping the "ORDER IS
    // PRECEDENCE, WIDEST LAST" rule this block already documents: it can only
    // ever WIDEN a lead from "team" to "brokerage", never narrow a broker who
    // also happens to lead a team. On BROKERAGE tier `isTenantPrincipal` is
    // false and the lead stays on "team" — m472/m473 untouched. `undefined`
    // (unresolved) is not `true`, so a caller that never resolved the fact gets
    // exactly today's answer (§4, fail closed).
    if (ctx.isTenantPrincipal === true) accessLevel = "brokerage"
    if (ctx.userType === "broker" || ctx.userType === "admin") accessLevel = "brokerage"
    if (isSuperadmin) accessLevel = "system"

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
        teamId:      ledTeamId,
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
        // ONE READING of the cap, shared with the earnings rollup that now
        // stamps agent_earnings.cap_progress_pct — see lib/finance/cap-progress.ts.
        // The inline `(paid / amount) * 100` this replaces divided by zero for an
        // uncapped agent and handed the progress bar NaN, which renders as "NaN%".
        capProgressPct:   readCapProgress(capData).pct ?? 0,
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

    const { count: teamCount } = await supabase
      .from("teams")
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
        teamCount:           teamCount ?? 0,
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

    const { data: distributions, error: distError } = await query
    if (distError) {
      return { success: false, error: distError.message }
    }

    // ── RESOLVE RECIPIENT NAMES (2026-08-27, lane CB — §1.2 the missing half) ──
    // recipientName was hardcoded null after the recipient_id/recipient_name
    // tombstone below, and the one UI consumer
    // (app/dashboard/financials/agent/agent-financials-client.tsx:639 renders
    // `recipientName ?? recipientId`) therefore showed a RAW UUID in the
    // recipient cell. The recipient the engine stamps is agent_id / team_id, so
    // the name is resolvable: agents.id → agents.user_id → users.first/last name
    // (agents.id and users.id are DISJOINT classes — never fed to each other,
    // CLAUDE.md §3), and teams.id → teams.name. Batched, error-READ, and
    // display-only: a refused name read logs and falls back to null (the UI then
    // shows the id) rather than failing the money list — the amounts are the
    // load-bearing data, the label is not.
    const agentIds = [...new Set((distributions ?? []).map((d) => d.agent_id).filter(Boolean))] as string[]
    const teamIds = [...new Set((distributions ?? []).map((d) => d.team_id).filter(Boolean))] as string[]
    const agentNameById = new Map<string, string>()
    const teamNameById = new Map<string, string>()

    if (agentIds.length > 0) {
      const { data: agentRows, error: agentErr } = await supabase
        .from("agents")
        .select("id, user_id")
        .in("id", agentIds)
        .eq("brokerage_id", brokerageId)
      if (agentErr) {
        console.error("[financial-kernel] distribution agent lookup refused:", agentErr.message)
      } else if (agentRows && agentRows.length > 0) {
        const userIds = [...new Set(agentRows.map((a) => a.user_id).filter(Boolean))] as string[]
        const { data: userRows, error: userErr } = await supabase
          .from("users")
          .select("id, first_name, last_name")
          .in("id", userIds)
        if (userErr) {
          console.error("[financial-kernel] distribution user-name lookup refused:", userErr.message)
        } else {
          const userNameById = new Map(
            (userRows ?? []).map((u) => [u.id, [u.first_name, u.last_name].filter(Boolean).join(" ").trim()]),
          )
          for (const a of agentRows) {
            const name = a.user_id ? userNameById.get(a.user_id) : undefined
            if (name) agentNameById.set(a.id, name)
          }
        }
      }
    }

    if (teamIds.length > 0) {
      const { data: teamRows, error: teamErr } = await supabase
        .from("teams")
        .select("id, name")
        .in("id", teamIds)
        .eq("brokerage_id", brokerageId)
      if (teamErr) {
        console.error("[financial-kernel] distribution team lookup refused:", teamErr.message)
      } else {
        for (const t of teamRows ?? []) {
          if (t.name) teamNameById.set(t.id, t.name)
        }
      }
    }

    return {
      success: true,
      data: (distributions ?? []).map((d) => ({
        id:               d.id,
        agentId:          d.agent_id,
        // TOMBSTONE (2026-08-27, §1.1): this used to read `d.recipient_id` and
        // `d.recipient_name`. recipient_id is writer-less — the engine's ONLY
        // insert (lib/commission/waterfall/11-validate-persist.ts:164
        // distributionRows) writes distribution_type + agent_id / team_id and
        // has never named it; live-verified 2026-08-27 on hrvaqgvukzxfskkcrwbt:
        // 0 rows, no trigger, no pg_proc, no FK, no view touches it (m571
        // retires the column). recipient_name was worse: NOT A COLUMN on
        // commission_distributions at all, so `?? ""` rendered every recipient
        // cell as an empty string and masked the null id behind it. SURVIVORS:
        // agent_id / team_id + distribution_type — the columns the engine
        // actually stamps the recipient with, now resolved to display names above.
        recipientId:      d.agent_id ?? d.team_id ?? null,
        recipientName:    (d.agent_id ? agentNameById.get(d.agent_id) : undefined)
                            ?? (d.team_id ? teamNameById.get(d.team_id) : undefined)
                            ?? null,
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
// ── Cap anniversary state (pure, testable) ──────────────────────────────────────
export interface CapRecordLite {
  cap_amount: number | null
  cap_paid_to_date: number | null
  is_capped: boolean | null
  anniversary_start: string
  anniversary_end: string
}
export interface CapState {
  isCapped: boolean
  capPaidToDate: number
  anniversaryStart: string
  anniversaryEnd: string
  /** The cap YEAR elapsed → the window advanced and the cap reset (the anniversary logic). */
  rolledOver: boolean
  /** Anything to persist (rollover or an is_capped flip). */
  changed: boolean
}

/**
 * PURE: the agent-cap state for `now`. A cap applies only while we're inside the anniversary year
 * AND the agent has paid their full cap. When the year has elapsed, the window ROLLS FORWARD by
 * whole years (handling multiple missed years) and the cap RESETS to 0 — the brokerage cap is an
 * annual reset, not a lifetime total. No cap configured (cap_amount ≤ 0) is never "capped".
 */
export function computeCapState(r: CapRecordLite, now: Date = new Date()): CapState {
  let start = new Date(r.anniversary_start)
  let end = new Date(r.anniversary_end)
  let capPaid = Number(r.cap_paid_to_date) || 0
  let rolledOver = false
  while (!isNaN(end.getTime()) && now.getTime() > end.getTime()) {
    start = new Date(start); start.setFullYear(start.getFullYear() + 1)
    end = new Date(end); end.setFullYear(end.getFullYear() + 1)
    capPaid = 0
    rolledOver = true
  }
  const capAmount = Number(r.cap_amount) || 0
  const withinYear = isNaN(end.getTime()) || now.getTime() <= end.getTime()
  const isCapped = capAmount > 0 && capPaid >= capAmount && withinYear
  const changed = rolledOver || isCapped !== !!r.is_capped
  return {
    isCapped, capPaidToDate: capPaid,
    anniversaryStart: isNaN(start.getTime()) ? r.anniversary_start : start.toISOString(),
    anniversaryEnd: isNaN(end.getTime()) ? r.anniversary_end : end.toISOString(),
    rolledOver, changed,
  }
}

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

    // Anniversary cap logic: capped within the cap year once fully paid; the window rolls forward
    // and the cap RESETS when the anniversary year elapses (computeCapState — pure, tested).
    const now = new Date()
    let capped = 0

    for (const record of capTracking ?? []) {
      const st = computeCapState(record as CapRecordLite, now)
      if (st.changed) {
        await supabase
          .from("agent_cap_tracking")
          .update({
            is_capped: st.isCapped,
            ...(st.rolledOver
              ? { cap_paid_to_date: st.capPaidToDate, anniversary_start: st.anniversaryStart, anniversary_end: st.anniversaryEnd }
              : {}),
          })
          .eq("id", record.id)
      }
      if (st.isCapped) capped++
    }

    // Emit lifecycle event
    await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: brokerageId, // NOT NULL (pass 5)
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
    if (!isBrokerageFinanceAdmin({ user_type: ctx.userType, is_tenant_principal: ctx.isTenantPrincipal })) {
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
    // A refused status transition used to return { success: true } — the caller,
    // the splits mirror and the deal stamp all then proceeded as if the
    // commission had been approved while the row stayed 'pending'.
    const { error: approveError } = await supabase
      .from("agent_commissions")
      .update({ status: newStatus, approved_at: approvedAt, approved_by: approvedBy })
      .eq("id", commissionId)
    if (approveError) {
      return { success: false, error: `Could not approve the commission: ${approveError.message}` }
    }

    // Mirror onto the splits ledger (same lifecycle, keyed by commission_id).
    await supabase.from("commission_splits").update({ status: "approved", updated_at: approvedAt }).eq("commission_id", commissionId)

    // …and onto the deal stamp, so approval is visible on the retained record too.
    await syncAgentLedgerToStamp(supabase, {
      transaction_id: (commission as { transaction_id?: string | null }).transaction_id ?? null,
      agent_id:       (commission as { agent_id: string }).agent_id,
      status:         newStatus,
    })

    // Emit lifecycle event
    await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: brokerageId, // NOT NULL (pass 5)
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
    if (!isBrokerageFinanceAdmin({ user_type: ctx.userType, is_tenant_principal: ctx.isTenantPrincipal })) {
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

    // Update status. THIS IS THE PAYOUT RECORD. A refused write here previously
    // returned success, and the splits ledger and the seven-year deal stamp were
    // then mirrored to 'paid' against a row still reading 'pending'.
    const { error: payError } = await supabase
      .from("agent_commissions")
      .update({ status: newStatus, paid_at: paidAt, payment_method: method ?? null })
      .eq("id", commissionId)
    if (payError) {
      return { success: false, error: `Could not mark the commission paid: ${payError.message}` }
    }

    // Mirror onto the splits ledger (same lifecycle, keyed by commission_id).
    await supabase.from("commission_splits").update({ status: "paid", paid_at: paidAt, updated_at: paidAt }).eq("commission_id", commissionId)

    // Mirror onto the DEAL STAMP (transaction_commissions) — the record real-estate
    // retention keeps for seven years. Paying the agent here without stamping the
    // deal leaves that record saying "pending" forever, which is a false record.
    await syncAgentLedgerToStamp(supabase, {
      transaction_id: (commission as { transaction_id?: string | null }).transaction_id ?? null,
      agent_id:       (commission as { agent_id: string }).agent_id,
      status:         newStatus,
      paid_at:        paidAt,
    })

    // Emit lifecycle event
    await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: brokerageId, // NOT NULL (pass 5)
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

    // THE ONE LOCK AT DISBURSEMENT — the earnings record is now paid; lock the LEDGER (commissions +
    // commission_distributions) for the same transaction in the same step, so the two trackings
    // converge on 'paid' at the real disbursement event, never at close. Best-effort — never fails the
    // payout; the tracking-drift reaper heals any single-sided miss.
    try {
      const transactionId = (commission as { transaction_id?: string | null }).transaction_id ?? null
      if (transactionId) {
        const { reconcileCommissionDisbursement } = await import("@/lib/commission/reconcile-tracking")
        await reconcileCommissionDisbursement(supabase, {
          transactionId,
          brokerageId,
          actorUserId: ctx.userId,
          paidAt,
        })
      }
    } catch { /* ledger lock is best-effort; the reaper reconciles any miss */ }

    return {
      success: true,
      data: { commissionId, paidAt, status: newStatus },
    }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * markCommissionDisputed — the AGENT (or a broker on their behalf) disputes a commission they believe
 * is wrong (bad split, wrong amount, missing adjustment). Transition pending|approved → disputed with
 * a required reason. Gated: the OWNING agent, or a broker/admin. A paid commission can't be disputed
 * here (money already moved — that's a clawback, out of scope). Emits COMMISSION_DISPUTED.
 */
export async function markCommissionDisputed(input: {
  ctx: FinancialActorContext
  commissionId: string
  brokerageId: string
  reason: string
}): Promise<KernelFinancialResult<{ commissionId: string; status: string }>> {
  const { ctx, commissionId, brokerageId, reason } = input
  const supabase = createServiceClient()
  try {
    const trimmed = (reason ?? "").trim()
    if (trimmed.length < 5) return { success: false, error: "A dispute reason is required" }

    const { data: commission } = await supabase
      .from("agent_commissions")
      .select("id, agent_id, status")
      .eq("id", commissionId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (!commission) return { success: false, error: "Commission not found" }

    // Gate: the owning agent, or a broker/admin.
    const isOwner = ctx.agentId != null && ctx.agentId === commission.agent_id
    const isBroker = isBrokerageFinanceAdmin({ user_type: ctx.userType, is_tenant_principal: ctx.isTenantPrincipal })
    if (!isOwner && !isBroker) return { success: false, error: "Only the owning agent or a broker can dispute this commission" }

    if (!COMMISSION_STATUS_TRANSITIONS[commission.status]?.includes("disputed")) {
      return { success: false, error: `Cannot dispute a ${commission.status} commission` }
    }

    const now = new Date().toISOString()
    // A dispute that reports success without landing leaves the agent believing
    // their objection is on the record when the row is untouched.
    const { error: disputeError } = await supabase
      .from("agent_commissions")
      .update({ status: "disputed", dispute_reason: trimmed, disputed_at: now, disputed_by: ctx.userId, dispute_resolution: null, dispute_resolved_at: null, updated_at: now })
      .eq("id", commissionId)
    if (disputeError) {
      return { success: false, error: `Could not file the dispute: ${disputeError.message}` }
    }

    // Mirror onto the splits ledger (same lifecycle, keyed by commission_id).
    await supabase.from("commission_splits").update({ status: "disputed", updated_at: now }).eq("commission_id", commissionId)

    await supabase.from("lifecycle_events").insert({
      brokerage_id: brokerageId, // NOT NULL (pass 5)
      entity_type: "agent_commission", entity_id: commissionId,
      event_type: KernelEvent.COMMISSION_DISPUTED, metadata: { reason: trimmed, disputedBy: ctx.userId }, created_at: now,
    }).then(() => {}, () => {})

    return { success: true, data: { commissionId, status: "disputed" } }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * resolveCommissionDispute — a broker resolves a disputed commission: UPHELD/CORRECTED → approved
 * (the amount stands or was fixed and is now authorized), or REOPENED → pending (send it back through
 * calc/approval). Broker/admin only. Transition disputed → approved|pending.
 */
export async function resolveCommissionDispute(input: {
  ctx: FinancialActorContext
  commissionId: string
  brokerageId: string
  resolution: "upheld" | "corrected" | "reopened"
  notes?: string
}): Promise<KernelFinancialResult<{ commissionId: string; status: string }>> {
  const { ctx, commissionId, brokerageId, resolution, notes } = input
  const supabase = createServiceClient()
  try {
    if (!isBrokerageFinanceAdmin({ user_type: ctx.userType, is_tenant_principal: ctx.isTenantPrincipal })) {
      return { success: false, error: "Only a broker can resolve a dispute" }
    }
    const { data: commission } = await supabase
      .from("agent_commissions")
      .select("id, status")
      .eq("id", commissionId)
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (!commission) return { success: false, error: "Commission not found" }
    if (commission.status !== "disputed") return { success: false, error: "Only a disputed commission can be resolved" }

    const nextStatus = resolution === "reopened" ? "pending" : "approved"
    if (!COMMISSION_STATUS_TRANSITIONS["disputed"].includes(nextStatus)) {
      return { success: false, error: `Invalid resolution transition disputed → ${nextStatus}` }
    }

    const now = new Date().toISOString()
    // Resolving a dispute moves money back into the payable lifecycle; a refused
    // write reported as resolved leaves the commission stuck on 'disputed'.
    const { error: resolveError } = await supabase
      .from("agent_commissions")
      .update({
        status: nextStatus,
        dispute_resolution: resolution,
        dispute_resolved_at: now,
        dispute_resolved_by: ctx.userId,
        ...(nextStatus === "approved" ? { approved_at: now, approved_by: ctx.userId } : {}),
        updated_at: now,
      })
      .eq("id", commissionId)
    if (resolveError) {
      return { success: false, error: `Could not resolve the dispute: ${resolveError.message}` }
    }

    // Mirror onto the splits ledger (same lifecycle, keyed by commission_id).
    await supabase.from("commission_splits").update({ status: nextStatus, updated_at: now }).eq("commission_id", commissionId)

    await supabase.from("lifecycle_events").insert({
      brokerage_id: brokerageId, // NOT NULL (pass 5)
      entity_type: "agent_commission", entity_id: commissionId,
      event_type: nextStatus === "approved" ? KernelEvent.COMMISSION_APPROVED : KernelEvent.COMMISSION_CALCULATED,
      metadata: { dispute_resolution: resolution, notes: notes ?? null, resolvedBy: ctx.userId }, created_at: now,
    }).then(() => {}, () => {})

    return { success: true, data: { commissionId, status: nextStatus } }
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
    // Guard: owner can only create own expenses (unless broker/admin).
    //
    // THIS IS NOT THE WHOLE GATE, and saying so here is the point. `agentId`
    // arrives as a PARAMETER and this function writes on the SERVICE-ROLE client,
    // so the roster check below answers "may this rank book someone else's cost"
    // but NOT "is that someone in the caller's brokerage" — without which a
    // finance admin could name an agent in ANOTHER tenant while brokerage_id
    // downstream is stamped with the CALLER's, filing one brokerage's cost onto
    // another's books.
    //
    // The tenant half lives ONE layer up, at
    // app/actions/financial-kernel.ts#authorizeAgentScope, which every other
    // agentId-taking action already calls and which createExpenseRecordAction now
    // calls too (added 2026-08-22). It is not re-implemented here: docs/wave4-slice3.md
    // rules that authorization belongs in the action layer and that these kernel
    // functions trust the ctx they are handed, and a second dialect of the same
    // clause is the drift CLAUDE.md §6 forbids. Any NEW caller of
    // createExpenseRecord that does not come through that action must apply the
    // same helper before calling.
    if (ctx.agentId !== agentId && !isBrokerageFinanceAdmin({ user_type: ctx.userType, is_tenant_principal: ctx.isTenantPrincipal })) {
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

    // business_expenses.description is NOT NULL in the live schema, so
    // `description ?? null` did not write an anonymous expense — it made the
    // whole insert fail, and the caller learned that only from a raw Postgres
    // message. Ask for the description instead.
    const expenseDescription = description?.trim()
    if (!expenseDescription) {
      return { success: false, error: "A description is required for an expense" }
    }

    // Insert expense record.
    //
    // The comment here used to read "business_expenses has NO brokerage_id
    // column — only agent_id". That is false against the live schema: the table
    // carries brokerage_id AND team_id. Believing it meant every expense written
    // through the kernel was tenant-orphaned, while logScopedExpense in
    // app/actions/financials.ts set them — two writers, two shapes, and reports
    // that scope by brokerage silently missed the kernel's rows.
    const { data: expense, error: insertError } = await supabase
      .from("business_expenses")
      .insert({
        agent_id:     agentId,
        brokerage_id: ctx.brokerageId,
        // team_id is left to the DB: FinancialActorContext does not carry a
        // team, and guessing one from the actor would mis-file an expense a
        // broker recorded for an agent on a different team.
        category,
        amount,
        description:  expenseDescription,
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
        brokerage_id: ctx.brokerageId, // NOT NULL (pass 5)
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

    // OFFICE OF RECORD for the PRODUCING agent — `agentId`, not `ctx.userId`,
    // because a broker may be creating this record on an agent's behalf and the
    // deal was closed out of the AGENT's office. Resolved through the ONE
    // precedence rule (./resolve-user-office: users.location_id wins over
    // agents.location_id); an agent with no linked user takes the pure form of
    // that same rule rather than a second one written out here. Stamped on the
    // split below so a later office transfer cannot drag closed history with it
    // (owner ruling; see the OfficeProduction comment in
    // lib/intelligence/brokerage-pnl.ts, which reads this stamp).
    const { data: agentRow, error: agentOfficeErr } = await supabase
      .from("agents").select("user_id, location_id").eq("id", agentId).maybeSingle()
    if (agentOfficeErr) {
      // Never silently becomes "no office": that would file real money under
      // "No office assigned" on the owner's report and read as a real finding.
      console.error(`[createCommissionRecord] agent office read REFUSED for ${agentId}: ${agentOfficeErr.message}`)
    }
    const agentOffice = (agentRow as { user_id?: string | null; location_id?: string | null } | null) ?? null
    const office = agentOffice?.user_id
      ? await resolveUserOffice(supabase, agentOffice.user_id)
      : pickUserOffice(null, agentOffice?.location_id ?? null)

    // COMMISSION SPLITS LEDGER (burn-down round 4): the agent financials page
    // and brokerage-P&L intelligence read commission_splits — writer-less until
    // now, so both rendered empty forever. One split row per commission with
    // the SAME numbers the waterfall computed (fees + cap credit in metadata);
    // status mirrors the commission lifecycle (live CHECK: pending/approved/
    // paid/disputed/cancelled). Best-effort: the commission is already the
    // source of truth — a split-ledger failure never blocks the close. But it is
    // never SILENT either: supabase-js resolves a refused write, so an
    // undestructured insert would swallow a real failure — including the one
    // ordering hazard this row now has, a deploy that lands ahead of m427 and so
    // writes `location_id` to a column that does not exist yet.
    const { error: splitErr } = await supabase.from("commission_splits").insert({
      agent_id: agentId,
      brokerage_id: ctx.brokerageId,
      location_id: office.locationId,
      transaction_id: transactionId,
      commission_id: commission.id,
      agent_amount: agentNet,
      brokerage_amount: grossCommission - agentNet,
      status: "pending",
      metadata: { fee_breakdown: feeBreakdown, capped_amount: cappedAmount, agent_split_percent: agentSplit },
    })
    if (splitErr) {
      console.error(`[createCommissionRecord] commission_splits ledger write FAILED for commission ${commission.id}: ${splitErr.message}`)
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
// ── Report serialization (pure, testable) ──────────────────────────────────────
const fmtMoney = (n: number) => `$${Math.round(Number(n) || 0).toLocaleString("en-US")}`

/** PURE: flatten a brokerage financial summary into labelled rows for CSV/PDF. */
export function financialReportRows(
  s: BrokerageFinancialSummary,
  meta: { reportType: string; dateFrom?: string | null; dateTo?: string | null; generatedAt: string },
): Array<[string, string]> {
  return [
    ["Report Type", meta.reportType],
    ["Period From", meta.dateFrom ?? "—"],
    ["Period To", meta.dateTo ?? "—"],
    ["Generated", meta.generatedAt],
    ["MTD Gross Income", fmtMoney(s.mtdGrossIncome)],
    ["MTD Agent Splits", fmtMoney(s.mtdAgentSplits)],
    ["MTD Brokerage Net", fmtMoney(s.mtdBrokerageNet)],
    ["YTD Gross Income", fmtMoney(s.ytdGrossIncome)],
    ["YTD Agent Splits", fmtMoney(s.ytdAgentSplits)],
    ["YTD Brokerage Net", fmtMoney(s.ytdBrokerageNet)],
    ["Agents", String(s.agentCount)],
    ["Teams", String(s.teamCount)],
    ["Pending Commissions", String(s.pendingCommissions)],
    ["Approved Commissions", String(s.approvedCommissions)],
  ]
}

/** PURE: RFC-4180 CSV (quote-escaped). */
export function rowsToCsv(header: [string, string], rows: Array<[string, string]>): string {
  const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`
  return [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n")
}

/**
 * exportFinancialReport — REAL CSV/PDF export with audit trail. Serializes live brokerage financials
 * into a downloadable data-URI (no fake URL, no storage dependency): CSV via rowsToCsv, PDF via pdf-lib.
 */
export async function exportFinancialReport(
  input: ExportFinancialReportInput
): Promise<KernelFinancialResult<FinancialExportResult>> {
  const { ctx, brokerageId, format, reportType, dateFrom, dateTo } = input
  const supabase = createServiceClient()

  try {
    // Guard: only authorized users can export
    if (!isBrokerageFinanceAdmin({ user_type: ctx.userType, is_tenant_principal: ctx.isTenantPrincipal })) {
      return { success: false, error: "Insufficient permissions to export reports" }
    }

    const generatedAt = new Date().toISOString()
    const filename = `financial-report-${reportType}-${generatedAt.split("T")[0]}.${format}`

    // Pull the LIVE brokerage financials and serialize them — real data, real downloadable file.
    const summaryRes = await loadBrokerageFinancialSummary({ ctx, brokerageId })
    if (!summaryRes.success || !summaryRes.data) {
      return { success: false, error: summaryRes.error ?? "Could not load financials to export" }
    }
    const rows = financialReportRows(summaryRes.data, { reportType, dateFrom, dateTo, generatedAt })

    let fileUrl: string
    if (format === "csv") {
      const csv = rowsToCsv(["Metric", "Value"], rows)
      fileUrl = `data:text/csv;base64,${Buffer.from(csv, "utf8").toString("base64")}`
    } else {
      const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib")
      const pdf = await PDFDocument.create()
      const page = pdf.addPage([612, 792])
      const font = await pdf.embedFont(StandardFonts.Helvetica)
      const bold = await pdf.embedFont(StandardFonts.HelveticaBold)
      let y = 740
      page.drawText("Financial Report", { x: 50, y, size: 18, font: bold, color: rgb(0.1, 0.1, 0.1) })
      y -= 34
      for (const [k, v] of rows) {
        page.drawText(`${k}`, { x: 50, y, size: 11, font: bold })
        page.drawText(v, { x: 300, y, size: 11, font })
        y -= 22
      }
      const bytes = await pdf.save()
      fileUrl = `data:application/pdf;base64,${Buffer.from(bytes).toString("base64")}`
    }

    // Emit lifecycle event
    await supabase
      .from("lifecycle_events")
      .insert({
        brokerage_id: brokerageId, // NOT NULL (pass 5)
        entity_type: "financial_report",
        entity_id:   brokerageId,
        event_type:  format === "csv" ? KernelEvent.REPORT_EXPORTED_CSV : KernelEvent.REPORT_EXPORTED_PDF,
        metadata:    { reportType, dateFrom, dateTo, filename },
        created_at:  generatedAt,
      })

    return {
      success: true,
      data: {
        fileUrl,
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
    if (!isBrokerageFinanceAdmin({ user_type: ctx.userType, is_tenant_principal: ctx.isTenantPrincipal })) {
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
        brokerage_id: brokerageId, // NOT NULL (pass 5)
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
        .in("status", [...TRANSACTION_STATUSES_OPEN]),

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
