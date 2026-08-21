"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { isBrokerageFinanceAdmin } from "@/lib/auth/resolve-user-role"
import { uploadBufferToBucket } from "@/lib/storage/buckets"
import { generateTextRouted } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"

// BROKERAGE-WIDE MONEY. Owner ruling (m472): admin surfaces admit team_lead,
// the brokerage's books do not. This file reads and writes agent_commissions,
// commission_splits, brokerage_p_l and business_expenses — all FINANCE tables
// under public.is_brokerage_finance_admin(), which excludes team_lead. The gate
// is the ONE shared roster, not a local literal, so the app and RLS cannot
// answer differently. Several paths below use the SERVICE client, which bypasses
// RLS, so this predicate is the only gate they have.
//
// The two roles the old local literal carried and this set does not are PROVEN
// dead, not dropped: MEASURED live, ZERO users rows hold user_type 'superadmin'
// (the platform's one superadmin is user_type='admin' WITH
// platform_role='superadmin', already admitted through 'admin'), and
// 'super_admin' is not a storable user_type at all — users_user_type_check
// admits fourteen values and that is not one of them, and it is VALIDATED, so
// no row was grandfathered either. Removing them changes no behaviour.
const isFinanceAdmin = (userType: string) => isBrokerageFinanceAdmin({ user_type: userType })

// ─── AI FORECAST ─────────────────────────────────────────────────────────────

export async function generateAIForecast(params: {
  agentId?: string // ignored — derived from session
  brokerageId?: string // ignored — derived from session
  ytdGCI: number
  ytdTransactionCount: number
  pipelineValue: number
  monthsElapsed: number
}) {
  // AUTH GATE — was burning paid AI tokens on whatever agentId the caller
  // supplied, exposing per-agent financial signals.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()
  const svc = createServiceClient()

  // Force agentId to caller's own agent unless they're an admin of the
  // same brokerage as the target agent.
  let targetAgentId: string | null = params.agentId ?? ctx.agentId ?? null
  if (!targetAgentId) return { success: false, error: "No agent context" }

  if (targetAgentId !== ctx.agentId) {
    const { data: targetAgent } = await svc
      .from("agents").select("brokerage_id").eq("id", targetAgentId).maybeSingle()
    if (!targetAgent || targetAgent.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
    if (!isFinanceAdmin(ctx.userType)) {
      return { success: false, error: "Forbidden: admin only" }
    }
  }

  try {
    // Fetch last 3 years of earnings for trend analysis — agent_monthly_earnings
    // is the canonical rollup (written by the earnings-rollup cron from
    // agent_commissions); earnings_history was a writer-less twin (repointed).
    const { data: monthly } = await supabase
      .from("agent_monthly_earnings")
      .select("month_year, gross_total, net_total")
      .eq("agent_id", targetAgentId)
      .order("month_year", { ascending: false })
      .limit(36)
    const history = (monthly ?? []).map((m: any) => ({
      paid_date: m.month_year, gross_commission: m.gross_total, agent_net: m.net_total,
    }))

    const avgMonthlyGCI =
      params.monthsElapsed > 0 ? params.ytdGCI / params.monthsElapsed : 0
    const projectedYTD = avgMonthlyGCI * 12

    const historySummary =
      history && history.length > 0
        ? history
            .slice(0, 12)
            .map((h: any) => `${h.paid_date}: $${(h.gross_commission || 0).toLocaleString()}`)
            .join(", ")
        : "No historical data available"

    const { text } = await generateTextRouted({
      feature: "unspecified",
      messages: [
        {
          role: "user",
          content: `You are a real estate financial advisor. Based on this agent's current YTD performance, provide a concise earnings forecast for the rest of the year.

YTD GCI: $${params.ytdGCI.toLocaleString()}
Closed transactions: ${params.ytdTransactionCount}
Active pipeline value: $${params.pipelineValue.toLocaleString()}
Months elapsed: ${params.monthsElapsed}/12
Average monthly GCI: $${Math.round(avgMonthlyGCI).toLocaleString()}
Simple linear projection to year end: $${Math.round(projectedYTD).toLocaleString()}

Historical monthly commissions (last 12): ${historySummary}

Provide a 3-4 sentence forecast covering:
1. Projected year-end GCI range (low/high)
2. Key factors that will influence actual outcome
3. One actionable recommendation to maximize year-end earnings

Keep it professional, specific, and data-driven. Use dollar amounts.`,
        },
      ],
    })

    return {
      success: true,
      forecast: text,
      projectedYearEnd: projectedYTD,
      avgMonthlyGCI,
    }
  } catch (err: any) {
    return { success: false, error: err.message ?? "Forecast generation failed" }
  }
}

// ─── GENERATE P&L REPORT (AI-WRITTEN SUMMARY) ────────────────────────────────

export async function generatePLReport(params: {
  agentId?: string
  brokerageId?: string // ignored — derived from session
  isBrokerage?: boolean
}) {
  // AUTH GATE — exposed P&L data for any agent/brokerage to any caller.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()
  const svc = createServiceClient()
  const effectiveBrokerageId = ctx.brokerageId

  // Brokerage-level P&L → admin only
  if (params.isBrokerage) {
    if (!isFinanceAdmin(ctx.userType)) {
      return { success: false, error: "Forbidden: admin only" }
    }
  } else if (params.agentId) {
    // Per-agent P&L → must be the same agent OR an admin in the same brokerage
    if (params.agentId !== ctx.agentId) {
      if (!isFinanceAdmin(ctx.userType)) {
        return { success: false, error: "Forbidden" }
      }
      const { data: targetAgent } = await svc
        .from("agents").select("brokerage_id").eq("id", params.agentId).maybeSingle()
      if (!targetAgent || targetAgent.brokerage_id !== effectiveBrokerageId) {
        return { success: false, error: "Forbidden" }
      }
    }
  } else {
    return { success: false, error: "agentId or isBrokerage required" }
  }

  const currentYear = new Date().getFullYear()

  try {
    let grossCommission = 0
    let agentNet = 0
    let totalExpenses = 0
    let transactionCount = 0

    if (params.isBrokerage) {
      // Brokerage P&L
      const { data: ytd } = await supabase
        .from("brokerage_earnings")
        .select("gross_commission_income, brokerage_net, agent_splits_paid")
        .eq("brokerage_id", effectiveBrokerageId)
        .eq("period_type", "annual")
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      const { data: pl } = await supabase
        .from("brokerage_p_l")
        .select("net_profit, profit_margin_pct, operating_expenses, tech_expenses, marketing_expenses")
        .eq("brokerage_id", effectiveBrokerageId)
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      grossCommission = ytd?.gross_commission_income ?? 0
      agentNet = ytd?.brokerage_net ?? 0
      totalExpenses =
        (pl?.operating_expenses ?? 0) +
        (pl?.tech_expenses ?? 0) +
        (pl?.marketing_expenses ?? 0)
    } else if (params.agentId) {
      // Agent P&L
      const { data: ytd } = await supabase
        .from("agent_earnings")
        .select("gross_commission, agent_net, total_fees, transaction_count")
        .eq("agent_id", params.agentId)
        .eq("period_type", "ytd")
        .order("computed_at", { ascending: false })
        .limit(1)
        .maybeSingle()

      const { data: expenses } = await supabase
        .from("business_expenses")
        .select("amount")
        .eq("agent_id", params.agentId)
        .gte("expense_date", `${currentYear}-01-01`)

      grossCommission = ytd?.gross_commission ?? 0
      agentNet = ytd?.agent_net ?? 0
      transactionCount = ytd?.transaction_count ?? 0
      totalExpenses = expenses?.reduce((s, e: any) => s + (e.amount ?? 0), 0) ?? 0
    }

    const netProfit = agentNet - totalExpenses
    const margin =
      grossCommission > 0 ? ((netProfit / grossCommission) * 100).toFixed(1) : "0"

    const { text } = await generateTextRouted({
      feature: "unspecified",
      messages: [
        {
          role: "user",
          content: `You are a real estate financial analyst. Write a concise P&L report summary (4-6 sentences) for ${params.isBrokerage ? "a real estate brokerage" : "a real estate agent"}.

Financial Data (${currentYear} YTD):
- Gross Commission Income: $${grossCommission.toLocaleString()}
- Net Income (after splits/fees): $${agentNet.toLocaleString()}
- Business Expenses: $${totalExpenses.toLocaleString()}
- Net Profit: $${netProfit.toLocaleString()}
- Profit Margin: ${margin}%
${!params.isBrokerage ? `- Transactions Closed: ${transactionCount}` : ""}

Include:
1. Overall financial health assessment
2. Key performance indicators relative to industry benchmarks
3. Specific recommendations for improvement
Use professional language. Be direct and actionable.`,
        },
      ],
    })

    return {
      success: true,
      summary: text,
      metrics: {
        grossCommission,
        agentNet,
        totalExpenses,
        netProfit,
        margin: parseFloat(margin),
        transactionCount,
      },
    }
  } catch (err: any) {
    return { success: false, error: err.message ?? "Report generation failed" }
  }
}

// ─── EXPORT COMMISSION HISTORY AS CSV ────────────────────────────────────────

export async function exportCommissionsCSV(agentId: string) {
  // AUTH GATE — was exporting any agent's commission history to any caller.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()
  const svc = createServiceClient()

  // Caller may export their own commissions, or an admin/broker can export
  // for any agent within their brokerage.
  //
  // ONE refusal string for every failure — not-an-admin, no-such-agent,
  // agent-in-another-tenant. Distinct messages would make this an ID ORACLE: a
  // caller could enumerate which agent uuids exist without ever reading a row.
  if (agentId !== ctx.agentId) {
    if (!isFinanceAdmin(ctx.userType)) {
      return { success: false, error: "Forbidden" }
    }
    // MERGED ONTO THE SURVIVOR (CLAUDE.md §1, 2026-08-21). This gate is the shape
    // exportExpensesCSV was rebuilt onto, but it was missing the one thing that
    // shape needs most: supabase-js RESOLVES refusals, so `const { data }` alone
    // left `targetAgent` null on a REFUSED read and the gate reported it as "no
    // such agent" — the right answer for the wrong reason, and the wrong answer
    // entirely the day this lookup is refused for an agent who does exist. The
    // error is now read and the gate FAILS CLOSED on it (§4). A malformed uuid
    // lands here too (22P02) rather than reaching the ledger read.
    const { data: targetAgent, error: targetError } = await svc
      .from("agents").select("brokerage_id").eq("id", agentId).maybeSingle()
    if (targetError) {
      console.error("[exportCommissionsCSV] agent tenant check refused:", targetError.message)
      return { success: false, error: "Forbidden" }
    }
    if (!targetAgent || targetAgent.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
  }

  const currentYear = new Date().getFullYear()

  try {
    // Use agent_commissions which has all needed columns
    const { data: commissions, error } = await supabase
      .from("agent_commissions")
      .select(
        "id, close_date, gross_commission, agent_split_percent, agent_commission, brokerage_commission, side, status, transaction_id"
      )
      .eq("agent_id", agentId)
      .eq("brokerage_id", ctx.brokerageId)
      .gte("close_date", `${currentYear}-01-01`)
      .order("close_date", { ascending: false })

    if (error) throw error

    // Build CSV
    const headers = [
      "Transaction ID",
      "Close Date",
      "Side",
      "Gross Commission",
      "Agent Split %",
      "Agent Commission",
      "Brokerage Commission",
      "Status",
    ]

    const rows = (commissions ?? []).map((c: any) => [
      c.transaction_id ?? "",
      c.close_date ?? "",
      c.side ?? "",
      (c.gross_commission ?? 0).toFixed(2),
      (c.agent_split_percent ?? 0).toFixed(2),
      (c.agent_commission ?? 0).toFixed(2),
      (c.brokerage_commission ?? 0).toFixed(2),
      c.status ?? "",
    ])

    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n")

    return {
      success: true,
      csv,
      filename: `commissions-${currentYear}.csv`,
      rowCount: rows.length,
    }
  } catch (err: any) {
    return { success: false, error: err.message ?? "Export failed" }
  }
}

// ─── EXPORT EXPENSES AS CSV ───────────────────────────────────────────────────

// OWNER RULING (wave 15), verbatim: "user should only be able to export their own
// expenses. brokerages' admins and owner can export their brokerages' expenses."
//
// WHAT THIS USED TO BE. The only check was `auth.getUser()` — "somebody is signed
// in" — and the row scope came ENTIRELY from the `agentId` PARAMETER. This is a
// "use server" export called from CLIENT components
// (app/components/features/financial/ExportCSVButton.tsx:24,
// app/dashboard/financials/reports/reports-client.tsx:148), so that parameter
// crosses the network and is caller-controlled whatever the page passes. Any
// signed-in user could name any agent id and receive that agent's expense ledger
// — dates, categories, descriptions, amounts and receipt links — for the year.
//
// The gate below is NOT a second invention: it is the same shape as the sibling
// exportCommissionsCSV above (:268-289), on the same ONE roster. Merging onto the
// survivor rather than writing a parallel gate is the orphan doctrine (CLAUDE.md
// §1) and the one-vocabulary rule (§6): two money exports over the same brokerage
// must not be able to answer "may you?" differently.
//
// isFinanceAdmin is admin / broker / broker_owner (BROKERAGE_FINANCE_ADMIN_USER_TYPES
// = the tenant roster MINUS team_lead) — precisely "brokerages' admins and owner"
// as the owner ruled it, and precisely what public.is_brokerage_finance_admin()
// enforces in RLS. `broker_admin` rides along as an INPUT spelling only; it is not
// a storable user_type (it canonicalizes to `broker`), which is why nothing here
// compares a bare "broker_admin" string against a live row.
export async function exportExpensesCSV(agentId: string) {
  // AUTH GATE — this action had none beyond "signed in". See the header above.
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    return { success: false, error: "Unauthorized" }
  }

  const supabase = await createClient()
  const svc = createServiceClient()

  // Caller may export their OWN expenses, or a brokerage admin/owner may export
  // for any agent within their OWN brokerage.
  //
  // ONE refusal string for three different failures — not-an-admin, no-such-agent,
  // agent-in-another-tenant — deliberately. A gate that says "no such agent" for an
  // unknown id and "not in your brokerage" for a real one is an ID ORACLE: it lets
  // a caller enumerate which agent uuids exist on the platform without ever being
  // allowed to read a row.
  if (agentId !== ctx.agentId) {
    if (!isFinanceAdmin(ctx.userType)) {
      return { success: false, error: "Forbidden" }
    }
    // supabase-js RESOLVES refusals — a swallowed error here would leave
    // `targetAgent` null and read as "no such agent", so the error is read and
    // the gate FAILS CLOSED on it (CLAUDE.md §4). A malformed uuid also lands
    // here (22P02) rather than reaching the ledger read.
    const { data: targetAgent, error: targetError } = await svc
      .from("agents").select("brokerage_id").eq("id", agentId).maybeSingle()
    if (targetError) {
      console.error("[exportExpensesCSV] agent tenant check refused:", targetError.message)
      return { success: false, error: "Forbidden" }
    }
    if (!targetAgent || targetAgent.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }
  }

  const currentYear = new Date().getFullYear()

  try {
    // TENANT PINNED ON THE QUERY, exactly as the commissions sibling pins it at
    // :301 and as getAgentExpenses pins it at app/actions/agents.ts:829. The gate
    // above already proved the agent is in this tenant, so this is the second lock
    // rather than the first — it is what keeps the read correct if this query is
    // ever moved onto the service client, which bypasses RLS.
    //
    // ── THE ORDER TRAP, AND WHY THE PIN IS NOT WHAT DROPS ROWS ────────────────
    //
    // A tenant pin added BEFORE the backfill in supabase/migrations/m516-*.sql is
    // applied looks like it would silently cut a user's own NULL-tenant expenses
    // out of their own export. MEASURED, live 2026-08-21, it does not — for two
    // separate reasons, and both were checked rather than assumed:
    //
    //   1. business_expenses is EMPTY: null_tenant = 0, total = 0. Both numbers
    //      published together, because a bare "0 NULLs" would read as "already
    //      fixed" when it actually says "nothing has been written here yet".
    //   2. Even on a non-empty table the pin removes nothing this client could
    //      otherwise see. Policy `business_expenses_tenant`, read live, is
    //        USING (can_read_tenant_financials()
    //               OR (has_brokerage_access(brokerage_id)
    //                   AND can_read_agent_books(agent_id)))
    //      and public.has_brokerage_access(target) is
    //        is_platform_admin() OR (target IS NOT NULL AND target = current_user_brokerage_id())
    //      so for any non-platform caller has_brokerage_access(NULL) is FALSE and a
    //      NULL-tenant row is ALREADY invisible on this RLS client. The pin is
    //      redundant with RLS here, not narrower than it.
    //
    // So the rows are dropped by the NULL itself, not by this pin — the failure
    // mode is INVISIBILITY, not exposure. That still under-reports someone's own
    // books, and there IS a live writer creating such rows today:
    // app/api/financial/expenses/route.ts:53 inserts on the service client with
    // brokerage_id taken from the request body (normally absent). Until m516 is
    // applied, an expense logged through that route is missing from its own
    // agent's export.
    //
    // BETWEEN NOW AND THE MIGRATION, this export therefore does NOT drop such rows
    // quietly. It counts them and says so — see the probe below. After m516 the
    // column is NOT NULL and the probe is a permanent zero.
    const { data: expenses, error } = await supabase
      .from("business_expenses")
      .select("id, expense_date, category, description, amount, receipt_url")
      .eq("agent_id", agentId)
      .eq("brokerage_id", ctx.brokerageId)
      .gte("expense_date", `${currentYear}-01-01`)
      .order("expense_date", { ascending: false })

    if (error) throw error

    // DENOMINATOR FOR THE EXPORT (CLAUDE.md §2 — publish the blind spot beside the
    // number). Counts this agent's rows for the same year that carry NO tenant and
    // are therefore absent from the CSV above. Runs on the service client because
    // that is the only client that can SEE them — RLS hides them from everyone but
    // platform staff, which is precisely the bug being reported.
    //
    // supabase-js RESOLVES refusals, so `{ count, error }` is destructured and the
    // error read. A failed probe must NOT fail the export — the CSV is already
    // correct — but it must not silently report zero either, so the count comes
    // back null and the caller is told the blind spot could not be measured.
    let untenantedRowCount: number | null = 0
    const { count: nullTenantCount, error: probeError } = await svc
      .from("business_expenses")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .is("brokerage_id", null)
      .gte("expense_date", `${currentYear}-01-01`)

    if (probeError) {
      console.error("[exportExpensesCSV] untenanted-row probe failed:", probeError.message)
      untenantedRowCount = null
    } else {
      untenantedRowCount = nullTenantCount ?? 0
      if (untenantedRowCount > 0) {
        console.warn(
          `[exportExpensesCSV] ${untenantedRowCount} expense row(s) for agent ${agentId} have a NULL brokerage_id and are OMITTED from this export. Source: app/api/financial/expenses/route.ts:53. Fixed by supabase/migrations/m516-*.sql.`,
        )
      }
    }

    const headers = ["Date", "Category", "Description", "Amount", "Receipt URL"]
    // FLAGGED, NOT CHANGED — a bearer credential leaves the tenancy boundary here.
    // `receipt_url` is a SIGNED URL into the PRIVATE `receipts` bucket, minted by
    // attachExpenseReceipt in this file with `bucket: "receipts"` and
    // `signedTtlSeconds: 60 * 60 * 24 * 365` — VERIFIED at the uploadBufferToBucket
    // call, this file, the `bucket:`/`signedTtlSeconds:` pair inside
    // attachExpenseReceipt. Anyone holding the string can fetch the receipt for a YEAR
    // without signing in, so once it is written into a CSV the file itself is the
    // credential: mailed to an accountant, dropped in a shared drive, or attached to
    // a ticket, it outlives the export and no longer answers to the gate above.
    // Not fixed here because every candidate fix changes what the export IS and
    // needs the owner: (a) emit the storage PATH plus a "Receipt on file" marker and
    // let the app re-sign on demand; (b) mint a SHORT-lived URL at export time
    // instead of reusing the year-long one; (c) keep the URL but only for the
    // exporting agent's own rows. Recommendation: (a) — the CSV then carries no
    // credential at all, and the 365-day TTL stays confined to the in-app P&L view
    // it was minted for. Reported to the wave rather than decided in this lane.
    const rows = (expenses ?? []).map((e: any) => [
      e.expense_date ?? "",
      e.category ?? "",
      e.description ?? "",
      (e.amount ?? 0).toFixed(2),
      e.receipt_url ?? "",
    ])

    const csv = [headers, ...rows]
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
      .join("\n")

    return {
      success: true,
      csv,
      filename: `expenses-${currentYear}.csv`,
      rowCount: rows.length,
      // The blind spot, carried back beside the number. 0 = nothing omitted;
      // >0 = that many of this agent's rows are untenanted and missing from the
      // CSV; null = the probe itself could not run, so the omission is UNKNOWN
      // rather than zero. Both current callers
      // (app/components/features/financial/ExportCSVButton.tsx,
      // app/dashboard/financials/reports/reports-client.tsx) read only
      // success/csv/filename/error, so this is additive and breaks neither.
      untenantedRowCount,
    }
  } catch (err: any) {
    return { success: false, error: err.message ?? "Export failed" }
  }
}

// ─── DELETE EXPENSE ───────────────────────────────────────────────────────────

export async function deleteExpense(expenseId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  // business_expenses.agent_id references agents.id (not auth.users.id).
  // Resolve the caller's agent.id before scoping the delete, otherwise the
  // .eq filter silently matches nothing and the delete is a no-op.
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle()
  if (!agentRow?.id) return { success: false, error: "No agent profile" }

  const { data: deleted, error } = await supabase
    .from("business_expenses")
    .delete()
    .eq("id", expenseId)
    .eq("agent_id", agentRow.id)
    .select("id")

  if (error) return { success: false, error: error.message }
  if (!deleted || deleted.length === 0) {
    return { success: false, error: "Expense not found or not yours to delete" }
  }

  revalidatePath("/dashboard/financials/expenses")
  revalidatePath("/dashboard/financials/agent")
  return { success: true }
}

// ─── ATTACH A RECEIPT TO AN EXISTING EXPENSE ─────────────────────────────────
// Deduction readiness counts "missing receipts" and the panel offers an upload
// per row; there was no capability behind it, so the count could never come
// down for an expense that was logged without a receipt. This is that capability.
//
// The file lands in the PRIVATE `receipts` bucket (a receipt is tax material —
// it must not be world-readable), so receipt_url holds a signed URL. Storage
// uses the service client, which is why authorization happens FIRST: the row is
// re-read and ownership proved through the RLS-scoped client before any
// privileged write.

export async function attachExpenseReceipt(input: {
  expenseId: string
  /** base64 (no data: prefix) — the browser reads the File and encodes it. */
  base64: string
  mimeType: string
  fileName?: string
}): Promise<{ success: boolean; receiptUrl?: string; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  if (!input.expenseId) return { success: false, error: "expense_required" }
  if (!input.base64) return { success: false, error: "file_required" }

  const ALLOWED = new Set(["image/jpeg", "image/png", "image/webp", "image/heic", "application/pdf"])
  const mimeType = (input.mimeType || "").toLowerCase()
  if (!ALLOWED.has(mimeType)) {
    return { success: false, error: "A receipt must be a JPEG, PNG, WebP, HEIC or PDF" }
  }

  let buffer: Buffer
  try {
    buffer = Buffer.from(input.base64, "base64")
  } catch {
    return { success: false, error: "The file could not be decoded" }
  }
  if (buffer.length === 0) return { success: false, error: "The file was empty" }
  if (buffer.length > 15 * 1024 * 1024) return { success: false, error: "A receipt must be under 15 MB" }

  // AUTHORIZE FIRST, through the caller's own RLS-scoped client.
  const supabase = await createClient()
  const { data: expense, error: readError } = await supabase
    .from("business_expenses")
    .select("id, agent_id, team_id, brokerage_id")
    .eq("id", input.expenseId)
    .maybeSingle()

  if (readError) return { success: false, error: readError.message }
  if (!expense) return { success: false, error: "That expense is not visible in your workspace" }

  // business_expenses.agent_id → agents.id. ctx.agentId is already an agents.id;
  // it is never substituted with ctx.userId.
  const ownsAsAgent = expense.agent_id != null && expense.agent_id === ctx.agentId
  const sameBrokerage = expense.brokerage_id != null && expense.brokerage_id === ctx.brokerageId
  const isAdmin = isFinanceAdmin(ctx.userType)
  if (!ownsAsAgent && !(isAdmin && sameBrokerage)) {
    return { success: false, error: "That expense is not yours to attach a receipt to" }
  }

  const ext =
    mimeType === "application/pdf" ? "pdf"
      : mimeType === "image/png" ? "png"
        : mimeType === "image/webp" ? "webp"
          : mimeType === "image/heic" ? "heic"
            : "jpg"
  const path = `${ctx.brokerageId}/${expense.id}/${Date.now()}.${ext}`

  const upload = await uploadBufferToBucket({
    bucket: "receipts",
    path,
    buffer,
    contentType: mimeType,
    public: false,
    // A receipt is referenced from the P&L export for a whole tax year.
    signedTtlSeconds: 60 * 60 * 24 * 365,
  })
  if (!upload.ok) return { success: false, error: upload.error }

  const svc = createServiceClient()
  const { data: updated, error: updateError } = await svc
    .from("business_expenses")
    .update({ receipt_url: upload.url })
    .eq("id", expense.id)
    .select("id")

  if (updateError) return { success: false, error: updateError.message }
  if (!updated || updated.length === 0) {
    return { success: false, error: "The receipt uploaded but the expense row was not updated" }
  }

  revalidatePath("/dashboard/financials/expenses")
  revalidatePath("/dashboard/financials/agent")
  revalidatePath("/dashboard/financials")
  return { success: true, receiptUrl: upload.url }
}

// ─── UPDATE COMMISSION STATUS (broker only) ───────────────────────────────────

export async function updateCommissionStatus(
  commissionId: string,
  status: "pending" | "paid" | "deferred"
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { success: false, error: "Unauthorized" }

  const context = await getAgentContext()
  // Marking a commission PAID is the brokerage's money moving. Found by the shape
  // scan in scripts/finance-authority-simulator.ts, which fails a module that asks
  // the shared finance predicate while ALSO keeping a role array of its own — this
  // one had been left behind, and it refused broker_owner from their own ledger.
  if (!isFinanceAdmin(context.userType)) {
    return { success: false, error: "Insufficient permissions" }
  }

  const { error } = await supabase
    // KEEP-ONE (m283): agent_commissions is the canonical ledger.
    // Column translation: commissions.paid_date (date) -> paid_at (timestamptz).
    .from("agent_commissions")
    .update({ status, paid_at: status === "paid" ? new Date().toISOString() : null })
    .eq("id", commissionId)
    .eq("brokerage_id", context.brokerageId!)

  if (error) return { success: false, error: error.message }

  revalidatePath("/dashboard/financials/commissions")
  revalidatePath("/dashboard/financials/payouts")
  return { success: true }
}

// ─── SCOPED EXPENSE ENTRY (agent / team / brokerage) ──────────────────────────
// Owner spec: every principal level logs expenses in financials. Scope semantics
// on business_expenses (l72_s10 added team_id): agent_id set = agent expense;
// team_id set = team expense; neither = brokerage-level operating expense.
// The monthly P&L rollup folds team+brokerage rows into brokerage_p_l buckets.

export type ExpenseScope = "agent" | "team" | "brokerage"

export async function logScopedExpense(input: {
  scope: ExpenseScope
  category: string
  description: string
  amount: number
  expenseDate: string // YYYY-MM-DD
  teamId?: string | null
  receiptUrl?: string | null
}): Promise<{ success: boolean; expenseId?: string; error?: string }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }
  if (!input.description?.trim()) return { success: false, error: "description_required" }
  const amount = Number(input.amount)
  if (!Number.isFinite(amount) || amount <= 0) return { success: false, error: "amount_invalid" }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expenseDate ?? "")) return { success: false, error: "date_invalid" }

  const svc = createServiceClient()
  const row: Record<string, unknown> = {
    brokerage_id: ctx.brokerageId,
    category: input.category?.trim() || "other",
    description: input.description.trim(),
    amount,
    expense_date: input.expenseDate,
    receipt_url: input.receiptUrl?.trim() || null,
  }

  if (input.scope === "agent") {
    // business_expenses.agent_id FKs agents(id) — pass-11 identity rule.
    if (!ctx.agentId) return { success: false, error: "no_agent_context" }
    row.agent_id = ctx.agentId
  } else if (input.scope === "team") {
    // Team leads log against their own team; brokers/admins may pick any team
    // in the tenant. Always verify the team belongs to this brokerage.
    let teamId = input.teamId ?? null
    if (!teamId) {
      const { data: u } = await svc.from("users").select("team_id").eq("id", ctx.userId).maybeSingle()
      teamId = (u?.team_id as string | null) ?? null
    }
    if (!teamId) return { success: false, error: "no_team_context" }
    const { data: team } = await svc.from("teams").select("id, brokerage_id").eq("id", teamId).maybeSingle()
    if (!team || (team.brokerage_id as string) !== ctx.brokerageId) return { success: false, error: "team_not_in_brokerage" }
    if (!isFinanceAdmin(ctx.userType) && ctx.userType !== "team_lead") {
      // Non-lead agents may still log against THEIR OWN team (split dues etc.).
      const { data: self } = await svc.from("users").select("team_id").eq("id", ctx.userId).maybeSingle()
      if ((self?.team_id as string | null) !== teamId) return { success: false, error: "forbidden_team_scope" }
    }
    row.team_id = teamId
  } else if (input.scope === "brokerage") {
    if (!isFinanceAdmin(ctx.userType)) return { success: false, error: "forbidden_brokerage_scope" }
    // agent_id and team_id stay NULL — that IS the brokerage-scope marker.
  } else {
    return { success: false, error: "unknown_scope" }
  }

  const { data, error } = await svc.from("business_expenses").insert(row).select("id").single()
  if (error) return { success: false, error: error.message }

  // Brokerage-scoped expenses post to the brokerage's QuickBooks (when connected)
  // through the ONE accounting egress — best-effort: a sync failure lands in the
  // sync-errors UI, never blocks the local ledger entry. Agent/team expenses
  // stay off the brokerage books (owner rule: no cross-book rollup).
  if (input.scope === "brokerage") {
    try {
      const { pushExpenseToAccounting } = await import("@/lib/finance/accounting-egress")
      await pushExpenseToAccounting(svc, {
        brokerageId: ctx.brokerageId,
        amount,
        category: String(row.category),
        description: String(row.description),
        expenseDate: input.expenseDate,
      })
    } catch { /* egress is best-effort; the expense row is already committed */ }
  }

  revalidatePath("/dashboard/financials/brokerage")
  revalidatePath("/dashboard/financials/expenses")
  return { success: true, expenseId: data.id as string }
}
