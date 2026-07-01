"use server"

// app/actions/tax-planning.ts
// Self-employed (1099) agent tax planning — persists the agent's set-aside % + effective rate +
// recorded quarterly payments, and computes the full tax plan from their REAL YTD income (commission
// received) and deductible business expenses. Feeds lib/finance/tax-planning.ts (the pure engine).

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { revalidatePath } from "next/cache"
import {
  buildTaxPlan,
  sumDeductibleExpenses,
  type TaxPlan,
  type FilingStatus,
} from "@/lib/finance/tax-planning"

interface TaxProfileRow {
  agent_id: string
  brokerage_id: string
  tax_year: number
  set_aside_percent: number
  estimated_effective_rate: number
  filing_status: string
  home_state: string | null
  quarterly_payments: Array<{ quarter: number; amount: number; paid_at: string }>
}

function currentTaxYear(): number {
  return new Date().getUTCFullYear()
}
function fractionOfYearElapsed(): number {
  const now = new Date()
  const start = Date.UTC(now.getUTCFullYear(), 0, 1)
  const elapsedDays = (now.getTime() - start) / 86_400_000
  return Math.min(1, Math.max(0.01, elapsedDays / 365))
}

async function ctx() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { agentId, brokerageId } = await getAgentContext()
  if (!agentId || !brokerageId) return null
  return { userId: user.id, agentId, brokerageId }
}

async function loadOrDefaultProfile(svc: ReturnType<typeof createServiceClient>, agentId: string, brokerageId: string, taxYear: number): Promise<TaxProfileRow> {
  const { data } = await svc
    .from("agent_tax_profile")
    .select("agent_id, brokerage_id, tax_year, set_aside_percent, estimated_effective_rate, filing_status, home_state, quarterly_payments")
    .eq("agent_id", agentId)
    .eq("tax_year", taxYear)
    .maybeSingle()
  if (data) return data as TaxProfileRow
  return {
    agent_id: agentId, brokerage_id: brokerageId, tax_year: taxYear,
    set_aside_percent: 25, estimated_effective_rate: 0.12, filing_status: "single",
    home_state: null, quarterly_payments: [],
  }
}

/** Compute the agent's YTD commission income + deductible business expenses for the tax year. */
async function loadYtdNumbers(svc: ReturnType<typeof createServiceClient>, agentId: string, taxYear: number) {
  const yearStart = `${taxYear}-01-01`
  const yearEnd = `${taxYear}-12-31`
  const [{ data: comms }, { data: expenses }] = await Promise.all([
    // The agent's 1099 income = the commission THEY receive (their split), not the whole deal's GCI.
    svc.from("agent_commissions")
      .select("agent_commission, close_date, created_at")
      .eq("agent_id", agentId)
      .gte("created_at", `${yearStart}T00:00:00Z`),
    svc.from("business_expenses")
      .select("amount")
      .eq("agent_id", agentId)
      .gte("expense_date", yearStart)
      .lte("expense_date", yearEnd),
  ])
  const ytdGrossIncome = (comms ?? []).reduce((s: number, c: any) => s + Number(c.agent_commission ?? 0), 0)
  const deductibleExpenses = sumDeductibleExpenses((expenses ?? []) as Array<{ amount?: number | null }>)
  return { ytdGrossIncome, deductibleExpenses }
}

export async function getTaxPlanAction(input?: { taxYear?: number }): Promise<
  { success: true; plan: TaxPlan; profile: { setAsidePercent: number; estimatedEffectiveRate: number; filingStatus: string; homeState: string | null } }
  | { success: false; error: string }
> {
  const c = await ctx()
  if (!c) return { success: false, error: "unauthenticated" }
  const taxYear = input?.taxYear ?? currentTaxYear()
  const svc = createServiceClient()

  const profile = await loadOrDefaultProfile(svc, c.agentId, c.brokerageId, taxYear)
  const { ytdGrossIncome, deductibleExpenses } = await loadYtdNumbers(svc, c.agentId, taxYear)
  const paidQuarters = (profile.quarterly_payments ?? []).map((p) => p.quarter)

  const plan = buildTaxPlan({
    taxYear,
    ytdGrossIncome,
    deductibleExpenses,
    setAsidePercent: Number(profile.set_aside_percent ?? 25),
    effectiveIncomeRate: Number(profile.estimated_effective_rate ?? 0.12),
    fractionOfYearElapsed: fractionOfYearElapsed(),
    paidQuarters,
  })

  return {
    success: true,
    plan,
    profile: {
      setAsidePercent: Number(profile.set_aside_percent ?? 25),
      estimatedEffectiveRate: Number(profile.estimated_effective_rate ?? 0.12),
      filingStatus: profile.filing_status ?? "single",
      homeState: profile.home_state ?? null,
    },
  }
}

export async function saveTaxProfileAction(input: {
  taxYear?: number
  setAsidePercent: number
  estimatedEffectiveRate?: number
  filingStatus?: FilingStatus
  homeState?: string | null
}): Promise<{ success: true } | { success: false; error: string }> {
  const c = await ctx()
  if (!c) return { success: false, error: "unauthenticated" }
  const taxYear = input.taxYear ?? currentTaxYear()
  const svc = createServiceClient()

  const setAside = Math.max(0, Math.min(50, Number(input.setAsidePercent)))
  const rate = input.estimatedEffectiveRate != null ? Math.max(0, Math.min(0.5, Number(input.estimatedEffectiveRate))) : undefined

  const { error } = await svc
    .from("agent_tax_profile")
    .upsert({
      agent_id: c.agentId,
      brokerage_id: c.brokerageId,
      tax_year: taxYear,
      set_aside_percent: setAside,
      ...(rate != null ? { estimated_effective_rate: rate } : {}),
      ...(input.filingStatus ? { filing_status: input.filingStatus } : {}),
      ...(input.homeState !== undefined ? { home_state: input.homeState } : {}),
      updated_at: new Date().toISOString(),
    }, { onConflict: "agent_id,tax_year" })
  if (error) return { success: false, error: error.message }

  revalidatePath("/dashboard/financials/planning")
  return { success: true }
}

export async function recordQuarterlyPaymentAction(input: {
  taxYear?: number
  quarter: 1 | 2 | 3 | 4
  amount: number
}): Promise<{ success: true } | { success: false; error: string }> {
  const c = await ctx()
  if (!c) return { success: false, error: "unauthenticated" }
  const taxYear = input.taxYear ?? currentTaxYear()
  const svc = createServiceClient()

  const profile = await loadOrDefaultProfile(svc, c.agentId, c.brokerageId, taxYear)
  const existing = (profile.quarterly_payments ?? []).filter((p) => p.quarter !== input.quarter)
  const next = [...existing, { quarter: input.quarter, amount: Math.max(0, Number(input.amount) || 0), paid_at: new Date().toISOString() }]

  const { error } = await svc
    .from("agent_tax_profile")
    .upsert({
      agent_id: c.agentId,
      brokerage_id: c.brokerageId,
      tax_year: taxYear,
      set_aside_percent: profile.set_aside_percent ?? 25,
      estimated_effective_rate: profile.estimated_effective_rate ?? 0.12,
      filing_status: profile.filing_status ?? "single",
      home_state: profile.home_state ?? null,
      quarterly_payments: next,
      updated_at: new Date().toISOString(),
    }, { onConflict: "agent_id,tax_year" })
  if (error) return { success: false, error: error.message }

  revalidatePath("/dashboard/financials/planning")
  return { success: true }
}
