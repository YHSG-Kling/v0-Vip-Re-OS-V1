// lib/finance/quarterly-tax-concierge.ts
//
// AUTONOMOUS QUARTERLY-TAX CONCIERGE — the Finance Manager acting, not just showing a screen. As an estimated-tax due
// date approaches it builds EACH agent's plan with THE ONE estimator (lib/finance/tax-planning.ts buildTaxPlan) from
// their own recorded income and expenses and the rates THEY entered, and reminds them once per quarter. Idempotent (one
// reminder per agent per quarter). Agent-owned, so it works for a solo agent too.
//
// WAVE 153 (lane 153A): it no longer invents a rate. The previous runner fell back to a 25% set-aside and a 12% income
// rate and quoted the result as "your Q3 federal estimated tax payment is about $X". Now:
//   · rates entered (or the accountant's quarterly amount)  → "suggested reserve ~$X, due <rolled date>", labelled a
//     cash-planning reserve, not the amount legally due;
//   · rates NOT entered                                      → a reminder that the date is coming and that entering their
//     rates (or their accountant's amount) is what turns on a suggestion — the coaching moment, with no number;
//   · the due date is the agent's OWN (fiscal year / their entered schedule / the IRS rule with weekend-holiday roll);
//   · nothing is ever paid; recorded payments are read, never rewritten.

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  buildTaxPlan,
  parseTaxAssumptions,
  recognizeCommissionIncome,
  sumDeductibleExpenses,
  quarterlyDueDates,
  taxYearWindow,
  type TaxAssumptions,
  type CommissionIncomeRow,
  type RecordedTaxEntry,
} from "./tax-planning"
import { usd } from "@/lib/format/money"

type Svc = SupabaseClient<any, any, any>

export interface UpcomingDue { taxYear: number; quarter: 1 | 2 | 3 | 4; dueDate: string; daysUntil: number }

/**
 * PURE: is a quarterly estimated-tax due date within `windowDays` of `today` (yyyy-mm-dd)? Checks this tax year's four
 * dates plus the prior year's Q4 (due in January), honoring the person's fiscal year and any due dates they entered.
 * Returns the soonest upcoming due inside the window, else null. With no assumptions it is the calendar-year IRS rule.
 */
export function upcomingQuarterlyDue(today: string, windowDays = 12, assumptions?: Pick<TaxAssumptions, "fiscalYearStartMonth" | "dueDateOverrides"> | null): UpcomingDue | null {
  const now = Date.parse(`${today}T00:00:00Z`)
  if (Number.isNaN(now)) return null
  const year = new Date(now).getUTCFullYear()
  const fy = assumptions?.fiscalYearStartMonth?.value ?? 1
  const candidates: Array<{ taxYear: number; quarter: 1 | 2 | 3 | 4; dueDate: string }> = []
  for (const ty of [year - 1, year]) {
    quarterlyDueDates(ty, fy).forEach((d, i) => {
      const q = (i + 1) as 1 | 2 | 3 | 4
      // A person's entered date is for the profile's own year; it replaces the rule's date for that year only.
      const override = ty === year ? assumptions?.dueDateOverrides?.[q]?.value : undefined
      candidates.push({ taxYear: ty, quarter: q, dueDate: override ?? d })
    })
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

// TOMBSTONE (§1.1, 2026-09-08): local `usd` lived here; survivor lib/format/money.ts:usd

/**
 * Run the concierge for one brokerage. For each agent: read their profile, find THEIR due date inside the window, build
 * their plan, and send ONE reminder for that quarter (deduped on notifications). Best-effort per agent; a refused read
 * skips that agent and is reported in `errors` (never treated as "nothing owed").
 */
export async function runQuarterlyTaxConcierge(
  brokerageId: string,
  svc: Svc,
  opts?: { today?: string; windowDays?: number },
): Promise<{ agentsConsidered: number; remindersSent: number; inputRemindersSent: number; dueQuarter: string | null; errors: string[] }> {
  const today = opts?.today ?? new Date().toISOString().slice(0, 10)
  const windowDays = opts?.windowDays ?? 12
  const errors: string[] = []

  const { data: agents, error: agentsErr } = await svc
    .from("agents")
    .select("id, user_id")
    .eq("brokerage_id", brokerageId)
    .not("user_id", "is", null)
    .limit(1000)
  if (agentsErr) return { agentsConsidered: 0, remindersSent: 0, inputRemindersSent: 0, dueQuarter: null, errors: [`agents read refused: ${agentsErr.message}`] }

  let agentsConsidered = 0, remindersSent = 0, inputRemindersSent = 0
  let dueQuarter: string | null = null
  for (const a of (agents ?? []) as Array<{ id: string; user_id: string }>) {
    try {
      agentsConsidered++
      const year = Number(today.slice(0, 4))
      const { data: profiles, error: profErr } = await svc
        .from("agent_tax_profile")
        .select("tax_year, quarterly_payments, assumptions")
        .eq("agent_id", a.id)
        // Strings: PostgREST serializes either form to the same `in.(y-1,y)` filter.
        .in("tax_year", [String(year - 1), String(year)])
      if (profErr) { errors.push(`${a.id}: profile read refused: ${profErr.message}`); continue }
      const byYear = new Map(((profiles ?? []) as Array<{ tax_year: number; quarterly_payments: RecordedTaxEntry[] | null; assumptions: unknown }>).map((p) => [Number(p.tax_year), p]))
      const thisYear = parseTaxAssumptions(byYear.get(year)?.assumptions)
      // THEIR date: the IRS rule (rolled), their fiscal year, or the date they entered — never the calendar date when
      // they entered another one.
      const due = upcomingQuarterlyDue(today, windowDays, thisYear)
      if (!due) continue
      const profile = byYear.get(due.taxYear)
      const assumptions = parseTaxAssumptions(profile?.assumptions)
      const window = taxYearWindow(due.taxYear, assumptions, today)

      // Real income = commission the agent earned / received (their split) on their basis; their own book's expenses.
      const [{ data: comms, error: commErr }, { data: expenses, error: expErr }] = await Promise.all([
        svc.from("agent_commissions").select("agent_commission, close_date, paid_at, status").eq("agent_id", a.id).or(`close_date.gte.${window.from},paid_at.gte.${window.from}`),
        svc.from("business_expenses").select("amount, category").eq("agent_id", a.id).gte("expense_date", window.from).lte("expense_date", window.to),
      ])
      if (commErr || expErr) { errors.push(`${a.id}: income/expense read refused`); continue }
      const plan = buildTaxPlan({
        taxYear: due.taxYear,
        today,
        assumptions,
        income: recognizeCommissionIncome((comms ?? []) as CommissionIncomeRow[], assumptions.incomeBasis?.value ?? "cash", window),
        expenses: sumDeductibleExpenses((expenses ?? []) as Array<{ amount: number | null; category: string | null }>, assumptions.deductibleCategories?.value ?? null),
        recorded: (profile?.quarterly_payments ?? []) as RecordedTaxEntry[],
      })
      if (plan.periodToDate.income <= 0) continue // no recorded income this year → nothing to plan for
      const quarter = plan.quarterly.find((q) => q.quarter === due.quarter)
      if (!quarter) continue
      const needsInput = plan.inputs.status === "needs_input" && quarter.suggested == null
      if (!needsInput && !(Number(quarter.suggested) > 0)) continue // already recorded in full, or a loss → no reminder

      // Dedupe — one reminder per agent per quarter (any created since the window opened).
      const windowOpenedIso = new Date(Date.parse(`${due.dueDate}T00:00:00Z`) - windowDays * 86_400_000).toISOString()
      const { data: existing, error: dedupeErr } = await svc
        .from("notifications")
        .select("id")
        .eq("user_id", a.user_id)
        .eq("type", "quarterly_tax_reminder")
        .gte("created_at", windowOpenedIso)
        .limit(1)
      if (dedupeErr) { errors.push(`${a.id}: reminder dedupe read refused`); continue } // never risk a duplicate on a refused read
      if (existing && existing.length > 0) continue

      dueQuarter = `${due.taxYear}-Q${due.quarter}`
      const dueLabel = new Date(`${quarter.dueDate}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
      const row = needsInput
        ? {
          title: `Q${due.quarter} estimated tax is due ${dueLabel} — add your rates to see a suggested amount`,
          body: `Your Q${due.quarter} estimated tax payment date is ${dueLabel}. We don't guess personal tax rates, so enter your federal and state estimated rates (or your accountant's quarterly amount) in your tax planner and we'll suggest what to set aside from your recorded income. Nothing is paid automatically.`,
        }
        : {
          title: `Q${due.quarter} suggested tax reserve ~${usd(Number(quarter.suggested))} — due ${dueLabel}`,
          body: `From your recorded income and the ${quarter.suggestedSource === "accountant" ? "quarterly amount your accountant gave" : "rates you entered"}, we suggest setting aside about ${usd(Number(quarter.suggested))} for Q${due.quarter}, due ${dueLabel}. This is a planning reserve, not the amount legally due — confirm with your tax professional, pay through your usual method, then record it in your tax planner. Nothing is paid automatically.`,
        }
      const { error: notifyError } = await svc.from("notifications").insert({
        user_id: a.user_id,
        brokerage_id: brokerageId,
        type: "quarterly_tax_reminder",
        title: row.title,
        body: row.body,
        entity_type: "agent",
        entity_id: a.id,
        priority: "high",
        channel: "in_app",
      })
      if (notifyError) { errors.push(`${a.id}: reminder not saved: ${notifyError.message}`); continue }
      if (needsInput) inputRemindersSent++
      else remindersSent++
    } catch (e: any) {
      errors.push(`${a.id}: ${e?.message ?? String(e)}`)
    }
  }

  return { agentsConsidered, remindersSent, inputRemindersSent, dueQuarter, errors: errors.slice(0, 10) }
}
