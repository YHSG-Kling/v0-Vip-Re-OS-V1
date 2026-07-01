// lib/finance/quarterly-tax-concierge.ts
//
// AUTONOMOUS QUARTERLY-TAX CONCIERGE — the Finance Manager acting, not just showing a screen. As an
// IRS estimated-tax due date approaches, it computes EACH agent's exact estimated payment from their
// REAL YTD income (commission received − deductible business expenses), honoring their saved tax
// profile, and proactively reminds them with the amount + due date. Agent-owned, so it works for a
// solo agent regardless of whether their brokerage is on the platform. Idempotent (one reminder per
// agent per quarter). No competitor does agent tax proactively.

import type { SupabaseClient } from "@supabase/supabase-js"
import { buildTaxPlan, sumDeductibleExpenses, quarterlyDueDates } from "./tax-planning"

type Svc = SupabaseClient<any, any, any>

export interface UpcomingDue { taxYear: number; quarter: 1 | 2 | 3 | 4; dueDate: string; daysUntil: number }

/**
 * PURE: is an IRS quarterly estimated-tax due date within `windowDays` of `today` (yyyy-mm-dd)? Checks
 * this tax year's four dates plus the prior year's Q4 (due Jan 15). Returns the soonest upcoming due
 * inside the window, else null.
 */
export function upcomingQuarterlyDue(today: string, windowDays = 12): UpcomingDue | null {
  const now = Date.parse(`${today}T00:00:00Z`)
  if (Number.isNaN(now)) return null
  const year = new Date(now).getUTCFullYear()
  const candidates: Array<{ taxYear: number; quarter: 1 | 2 | 3 | 4; dueDate: string }> = []
  for (const ty of [year - 1, year]) {
    quarterlyDueDates(ty).forEach((d, i) => candidates.push({ taxYear: ty, quarter: (i + 1) as 1 | 2 | 3 | 4, dueDate: d }))
  }
  let best: UpcomingDue | null = null
  for (const c of candidates) {
    const due = Date.parse(`${c.dueDate}T00:00:00Z`)
    const daysUntil = Math.round((due - now) / 86_400_000)
    if (daysUntil >= 0 && daysUntil <= windowDays) {
      if (!best || daysUntil < best.daysUntil) best = { ...c, daysUntil }
    }
  }
  return best
}

const usd = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)

/**
 * Run the concierge for one brokerage. No-op unless a quarterly due date is within the window. For each
 * agent with real YTD commission income, computes their estimated payment and sends ONE reminder per
 * quarter (deduped on notifications). Best-effort per agent.
 */
export async function runQuarterlyTaxConcierge(
  brokerageId: string,
  svc: Svc,
  opts?: { today?: string; windowDays?: number },
): Promise<{ agentsConsidered: number; remindersSent: number; dueQuarter: string | null; errors: string[] }> {
  const today = opts?.today ?? new Date().toISOString().slice(0, 10)
  const windowDays = opts?.windowDays ?? 12
  const errors: string[] = []

  const due = upcomingQuarterlyDue(today, windowDays)
  if (!due) return { agentsConsidered: 0, remindersSent: 0, dueQuarter: null, errors }

  const dueQuarter = `${due.taxYear}-Q${due.quarter}`
  const yearStart = `${due.taxYear}-01-01`
  const yearEnd = `${due.taxYear}-12-31`

  // The window opened this many days ago — dedupe reminders created since then (one per quarter).
  const windowOpenedIso = new Date(Date.parse(`${due.dueDate}T00:00:00Z`) - windowDays * 86_400_000).toISOString()
  const fracElapsed = Math.min(1, Math.max(0.01, (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${yearStart}T00:00:00Z`)) / 86_400_000 / 365))

  const { data: agents } = await svc
    .from("agents")
    .select("id, user_id")
    .eq("brokerage_id", brokerageId)
    .not("user_id", "is", null)
    .limit(1000)

  let agentsConsidered = 0, remindersSent = 0
  for (const a of (agents ?? []) as Array<{ id: string; user_id: string }>) {
    try {
      agentsConsidered++
      // Real YTD income = commission the agent received; deductible = their business expenses.
      const [{ data: comms }, { data: expenses }, { data: profile }] = await Promise.all([
        svc.from("agent_commissions").select("agent_commission").eq("agent_id", a.id).gte("created_at", `${yearStart}T00:00:00Z`),
        svc.from("business_expenses").select("amount").eq("agent_id", a.id).gte("expense_date", yearStart).lte("expense_date", yearEnd),
        svc.from("agent_tax_profile").select("set_aside_percent, estimated_effective_rate, quarterly_payments").eq("agent_id", a.id).eq("tax_year", due.taxYear).maybeSingle(),
      ])
      const ytdGrossIncome = (comms ?? []).reduce((s: number, c: any) => s + Number(c.agent_commission ?? 0), 0)
      if (ytdGrossIncome <= 0) continue // no income → no estimated tax owed

      // Already paid this quarter? then skip.
      const paidQuarters: number[] = ((profile as any)?.quarterly_payments ?? []).map((p: any) => p.quarter)
      if (paidQuarters.includes(due.quarter)) continue

      const plan = buildTaxPlan({
        taxYear: due.taxYear,
        ytdGrossIncome,
        deductibleExpenses: sumDeductibleExpenses((expenses ?? []) as Array<{ amount?: number | null }>),
        setAsidePercent: Number((profile as any)?.set_aside_percent ?? 25),
        effectiveIncomeRate: Number((profile as any)?.estimated_effective_rate ?? 0.12),
        fractionOfYearElapsed: fracElapsed,
        paidQuarters,
      })
      const amount = plan.quarterly.find((q) => q.quarter === due.quarter)?.amount ?? 0
      if (amount <= 0) continue

      // Dedupe — one reminder per agent per quarter (any created since the window opened).
      const { data: existing } = await svc
        .from("notifications")
        .select("id")
        .eq("user_id", a.user_id)
        .eq("type", "quarterly_tax_reminder")
        .gte("created_at", windowOpenedIso)
        .limit(1)
      if (existing && existing.length > 0) continue

      const dueLabel = new Date(`${due.dueDate}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
      await svc.from("notifications").insert({
        user_id: a.user_id,
        brokerage_id: brokerageId,
        type: "quarterly_tax_reminder",
        title: `Q${due.quarter} estimated tax ~${usd(amount)} due ${dueLabel}`,
        body: `Based on your ${usd(ytdGrossIncome)} commission income this year, your Q${due.quarter} federal estimated tax payment is about ${usd(amount)}, due ${dueLabel}. Pay via IRS Direct Pay, then mark it paid in your tax planner. (Estimate — confirm with your CPA.)`,
        entity_type: "agent",
        entity_id: a.id,
        priority: "high",
        channel: "in_app",
      })
      remindersSent++
    } catch (e: any) {
      errors.push(`${a.id}: ${e?.message ?? String(e)}`)
    }
  }

  return { agentsConsidered, remindersSent, dueQuarter, errors: errors.slice(0, 10) }
}
