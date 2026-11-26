"use server"

// app/actions/tax-planning.ts
// Self-employed (1099) agent ESTIMATED-TAX planning — the doors of THE ONE estimator (lib/finance/tax-planning.ts).
//
// WAVE 153 (lane 153A): owner ruling "make sure estimate quarterly taxes work (if we cant determine their tax
// percentages, then the user can enter that in)". These doors:
//   · read the SESSION agent's own recorded facts only — their commission (agent_commissions.agent_commission, their
//     split) on their chosen basis, and their own book's expenses — never team or brokerage revenue, so a team lead's or
//     broker's personal plan is never inflated by consolidated income;
//   · save each rate / target with its source (self_entered | accountant_supplied), period, time and version, appending
//     the replaced value to assumption_history (m901) — no default rate exists anywhere;
//   · APPEND a recorded payment or set-aside (the old door replaced a quarter's earlier payment, rewriting history);
//   · never pay anything.
// The legacy columns estimated_effective_rate / set_aside_percent are neither read nor written (m901 makes them nullable;
// before it is applied an insert still lands, the old defaults filling columns nobody reads).
//
// TENANT OPTION (m574): every action is gated on brokerages.tax_assistance_enabled via lib/finance/tax-assistance.ts —
// fail-closed, opt-in. The quarterly concierge gates on the same column.

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { revalidatePath } from "next/cache"
import {
  buildTaxPlan,
  parseTaxAssumptions,
  applyAssumptionChange,
  recognizeCommissionIncome,
  sumDeductibleExpenses,
  taxYearWindow,
  type TaxPlan,
  type FilingStatus,
  type AssumptionChange,
  type CommissionIncomeRow,
  type RecordedTaxEntry,
} from "@/lib/finance/tax-planning"
import { resolveTaxAssistanceEnabled, TAX_ASSISTANCE_DISABLED_ERROR } from "@/lib/finance/tax-assistance"

type Svc = ReturnType<typeof createServiceClient>

interface TaxProfileRow {
  filing_status: string | null
  home_state: string | null
  quarterly_payments: RecordedTaxEntry[] | null
  assumptions: unknown
  assumption_history: unknown[] | null
}

const LOAD_FAILED = "Your tax planner could not be loaded right now. Nothing was changed; try again in a moment."
const SAVE_FAILED = "Your change could not be saved right now. Nothing was changed; try again in a moment."

function todayIso(): string { return new Date().toISOString().slice(0, 10) }
function currentTaxYear(): number { return new Date().getUTCFullYear() }

async function ctx() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return null
  const { agentId, brokerageId } = await getAgentContext()
  if (!agentId || !brokerageId) return null
  return { userId: user.id, agentId, brokerageId }
}

/** The session agent's profile row for one tax year (null = none yet). A refused read is an error, never "no profile". */
async function loadProfile(svc: Svc, agentId: string, taxYear: number): Promise<{ ok: true; row: TaxProfileRow | null } | { ok: false; error: string }> {
  const { data, error } = await svc
    .from("agent_tax_profile")
    .select("filing_status, home_state, quarterly_payments, assumptions, assumption_history")
    .eq("agent_id", agentId)
    .eq("tax_year", taxYear)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  return { ok: true, row: (data as TaxProfileRow | null) ?? null }
}

export async function getTaxPlanAction(input?: { taxYear?: number }): Promise<
  { success: true; plan: TaxPlan; profile: { filingStatus: string | null; homeState: string | null } }
  | { success: false; error: string }
> {
  const c = await ctx()
  if (!c) return { success: false, error: "unauthenticated" }
  const taxYear = input?.taxYear ?? currentTaxYear()
  const svc = createServiceClient()

  // TENANT OPTION GATE (m574) — fail-closed: a brokerage that hasn't enabled tax assistance (or a
  // read that fails) refuses before any tax data is computed.
  const gate = await resolveTaxAssistanceEnabled(svc, c.brokerageId)
  if (!gate.enabled) return { success: false, error: TAX_ASSISTANCE_DISABLED_ERROR }

  const prof = await loadProfile(svc, c.agentId, taxYear)
  if (!prof.ok) { console.error("[tax-planning] profile read refused:", prof.error); return { success: false, error: LOAD_FAILED } }
  const assumptions = parseTaxAssumptions(prof.row?.assumptions)
  const today = todayIso()
  const window = taxYearWindow(taxYear, assumptions, today)
  const [{ data: comms, error: commErr }, { data: expenses, error: expErr }] = await Promise.all([
    // The agent's 1099 income = the commission THEY receive (their split), on their basis.
    svc.from("agent_commissions")
      .select("agent_commission, close_date, paid_at, status")
      .eq("agent_id", c.agentId)
      .or(`close_date.gte.${window.from},paid_at.gte.${window.from}`),
    // Their OWN book only (agent scope) — a team's or the brokerage's costs are not their personal deductions.
    svc.from("business_expenses")
      .select("amount, category")
      .eq("agent_id", c.agentId)
      .gte("expense_date", window.from)
      .lte("expense_date", window.to),
  ])
  if (commErr || expErr) { console.error("[tax-planning] income/expense read refused:", commErr?.message ?? expErr?.message); return { success: false, error: LOAD_FAILED } }

  const plan = buildTaxPlan({
    taxYear,
    today,
    assumptions,
    income: recognizeCommissionIncome((comms ?? []) as CommissionIncomeRow[], assumptions.incomeBasis?.value ?? "cash", window),
    expenses: sumDeductibleExpenses((expenses ?? []) as Array<{ amount: number | null; category: string | null }>, assumptions.deductibleCategories?.value ?? null),
    recorded: (prof.row?.quarterly_payments ?? []) as RecordedTaxEntry[],
  })
  return { success: true, plan, profile: { filingStatus: prof.row?.filing_status ?? null, homeState: prof.row?.home_state ?? null } }
}

/**
 * Save ONE assumption (a rate, a target, the basis, the confirmed deductible categories, a due date) with where it came
 * from. The replaced value is appended to assumption_history; recorded payments are untouched, so the plan reforecasts
 * only the quarters still ahead.
 */
export async function saveTaxAssumptionsAction(input: {
  taxYear?: number
  change: AssumptionChange
  source: "self_entered" | "accountant_supplied"
  note?: string | null
}): Promise<{ success: true } | { success: false; error: string }> {
  const c = await ctx()
  if (!c) return { success: false, error: "unauthenticated" }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger"); const act = async (): ReturnType<typeof saveTaxAssumptionsAction> => {
  const taxYear = input.taxYear ?? currentTaxYear()
  const svc = createServiceClient()

  const gate = await resolveTaxAssistanceEnabled(svc, c.brokerageId)
  if (!gate.enabled) return { success: false, error: TAX_ASSISTANCE_DISABLED_ERROR }

  const prof = await loadProfile(svc, c.agentId, taxYear)
  if (!prof.ok) { console.error("[tax-planning] profile read refused:", prof.error); return { success: false, error: SAVE_FAILED } }
  const applied = applyAssumptionChange(prof.row?.assumptions ?? {}, input.change, {
    source: input.source, taxYear, userId: c.userId, now: new Date().toISOString(), note: input.note?.toString().slice(0, 300) ?? null,
  })
  if (!applied.ok) return { success: false, error: applied.error }
  const history = Array.isArray(prof.row?.assumption_history) ? prof.row!.assumption_history! : []
  const { data: saved, error } = await svc
    .from("agent_tax_profile")
    .upsert({
      agent_id: c.agentId,
      brokerage_id: c.brokerageId,
      tax_year: taxYear,
      assumptions: applied.next,
      assumption_history: applied.replaced ? [...history, applied.replaced] : history,
      updated_at: new Date().toISOString(),
    }, { onConflict: "agent_id,tax_year" })
    .select("agent_id")
  if (error) { console.error("[tax-planning] assumption save refused:", error.message); return { success: false, error: SAVE_FAILED } }
  if (!Array.isArray(saved) || saved.length === 0) return { success: false, error: SAVE_FAILED }

  // agent_tax_profile is read by TaxSetasidePanel, mounted on app/dashboard/financials/agent/agent-financials-client.tsx.
  revalidatePath("/dashboard/financials/agent")
  return { success: true }
  }; return (await ledgerSessionAction({ brokerageId: c.brokerageId, action: "finance.tax_assumptions.save", actor: { type: "user", userId: c.userId }, subject: { type: "agent", id: c.agentId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, act)) as Awaited<ReturnType<typeof act>>
}

/** Filing status and home state — profile facts shown beside the plan (never used to derive a rate). */
export async function saveTaxProfileAction(input: {
  taxYear?: number
  filingStatus?: FilingStatus
  homeState?: string | null
}): Promise<{ success: true } | { success: false; error: string }> {
  const c = await ctx()
  if (!c) return { success: false, error: "unauthenticated" }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger"); const act = async (): ReturnType<typeof saveTaxProfileAction> => {
  const taxYear = input.taxYear ?? currentTaxYear()
  const svc = createServiceClient()

  // TENANT OPTION GATE (m574) — the write path refuses too, so a disabled tenant can't persist
  // tax profiles through a stale UI.
  const saveGate = await resolveTaxAssistanceEnabled(svc, c.brokerageId)
  if (!saveGate.enabled) return { success: false, error: TAX_ASSISTANCE_DISABLED_ERROR }

  const FILING: readonly FilingStatus[] = ["single", "married_joint", "married_separate", "head_of_household"]
  if (input.filingStatus && !FILING.includes(input.filingStatus)) return { success: false, error: "Choose a filing status from the list." }
  const state = input.homeState === undefined ? undefined : (input.homeState ?? "").trim().toUpperCase() || null
  if (state && !/^[A-Z]{2}$/.test(state)) return { success: false, error: "Home state must be a two-letter state code." }

  const { error } = await svc
    .from("agent_tax_profile")
    .upsert({
      agent_id: c.agentId,
      brokerage_id: c.brokerageId,
      tax_year: taxYear,
      ...(input.filingStatus ? { filing_status: input.filingStatus } : {}),
      ...(state !== undefined ? { home_state: state } : {}),
      updated_at: new Date().toISOString(),
    }, { onConflict: "agent_id,tax_year" })
  if (error) { console.error("[tax-planning] profile save refused:", error.message); return { success: false, error: SAVE_FAILED } }

  revalidatePath("/dashboard/financials/agent")
  return { success: true }
  }; return (await ledgerSessionAction({ brokerageId: c.brokerageId, action: "finance.tax_profile.save", actor: { type: "user", userId: c.userId }, subject: { type: "agent", id: c.agentId }, riskClass: "LOW_RISK_WRITE", reasonCode: "HUMAN_REQUESTED" }, act)) as Awaited<ReturnType<typeof act>>
}

/**
 * Record money the person PAID (or set aside) toward a quarter. APPEND-ONLY: earlier entries are never replaced or
 * removed, so a changed assumption can never rewrite what was recorded. No payment is made by this platform.
 */
export async function recordQuarterlyPaymentAction(input: {
  taxYear?: number
  quarter: 1 | 2 | 3 | 4
  amount: number
  kind?: "payment" | "set_aside"
  paidOn?: string | null
}): Promise<{ success: true } | { success: false; error: string }> {
  const c = await ctx()
  if (!c) return { success: false, error: "unauthenticated" }
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger"); const act = async (): ReturnType<typeof recordQuarterlyPaymentAction> => {
  const taxYear = input.taxYear ?? currentTaxYear()
  const svc = createServiceClient()

  // TENANT OPTION GATE (m574) — same fail-closed refusal as the read + save paths.
  const payGate = await resolveTaxAssistanceEnabled(svc, c.brokerageId)
  if (!payGate.enabled) return { success: false, error: TAX_ASSISTANCE_DISABLED_ERROR }

  if (![1, 2, 3, 4].includes(Number(input.quarter))) return { success: false, error: "Choose the quarter this payment is for." }
  const amount = Math.round((Number(input.amount) || 0) * 100) / 100
  if (!(amount > 0)) return { success: false, error: "Enter the amount you paid or set aside." }
  const paidOn = input.paidOn && /^\d{4}-\d{2}-\d{2}$/.test(input.paidOn) ? input.paidOn : todayIso()

  const prof = await loadProfile(svc, c.agentId, taxYear)
  if (!prof.ok) { console.error("[tax-planning] profile read refused:", prof.error); return { success: false, error: SAVE_FAILED } }
  const existing = Array.isArray(prof.row?.quarterly_payments) ? prof.row!.quarterly_payments! : []
  const next = [...existing, { quarter: input.quarter, amount, kind: input.kind === "set_aside" ? "set_aside" : "payment", paid_at: paidOn, recorded_at: new Date().toISOString(), recorded_by: c.userId }]

  const { data: saved, error } = await svc
    .from("agent_tax_profile")
    .upsert({
      agent_id: c.agentId,
      brokerage_id: c.brokerageId,
      tax_year: taxYear,
      quarterly_payments: next,
      updated_at: new Date().toISOString(),
    }, { onConflict: "agent_id,tax_year" })
    .select("agent_id")
  if (error) { console.error("[tax-planning] payment save refused:", error.message); return { success: false, error: SAVE_FAILED } }
  if (!Array.isArray(saved) || saved.length === 0) return { success: false, error: SAVE_FAILED }

  revalidatePath("/dashboard/financials/agent")
  return { success: true }
  }; return (await ledgerSessionAction({ brokerageId: c.brokerageId, action: "finance.tax_payment.record", actor: { type: "user", userId: c.userId }, subject: { type: "agent", id: c.agentId }, riskClass: "FINANCIAL", reasonCode: "HUMAN_REQUESTED" }, act)) as Awaited<ReturnType<typeof act>>
}
