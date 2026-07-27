"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { resolveCommissionStructure, type CalculateCommissionInput } from "@/lib/kernel/adapters/financial"
import {
  createExpenseRecordAction,
  createCommissionRecordAction,
  loadAgentProfitLossSummaryAction,
  loadCommissionQueueAction,
} from "@/app/actions/financial-kernel"

// ============================================================================
// AI FINANCIAL MANAGEMENT SYSTEM
// QuickBooks integration, expense tracking, commission management, P&L
// ============================================================================

interface ExpenseEntry {
  agentId: string
  amount: number
  category: string
  description: string
  vendor?: string
  transactionId?: string
  receiptUrl?: string
  date: string
  isDeductible?: boolean
}

type CommissionEntry = CalculateCommissionInput

/**
 * AI Expense Categorization and Entry
 * Automatically categorizes expenses and suggests deductions
 */
export async function aiCategorizeExpense(params: {
  agentId: string
  description: string
  amount: number
  vendor?: string
  receiptText?: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get agent's expense history for pattern matching
    const { data: recentExpenses } = await supabase
      .from("business_expenses")
      .select("category, description")
      .eq("agent_id", params.agentId)
      .order("created_at", { ascending: false })
      .limit(50)

    // AI categorization
    const { text: categoryAnalysis } = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: `You are a real estate expense categorization expert. Categorize this expense.

EXPENSE DETAILS:
- Description: ${params.description}
- Amount: $${params.amount}
- Vendor: ${params.vendor || "Unknown"}
${params.receiptText ? `- Receipt Text: ${params.receiptText}` : ""}

AGENT'S RECENT EXPENSE PATTERNS:
${recentExpenses?.slice(0, 10).map((e: any) => `- ${e.category}: ${e.description}`).join("\n") || "No history"}

REAL ESTATE EXPENSE CATEGORIES:
- Marketing (ads, signs, flyers, open house supplies)
- Technology (software, subscriptions, equipment)
- Transportation (mileage, gas, vehicle maintenance)
- Professional Development (courses, certifications, coaching)
- Office Supplies (printing, stationery)
- Client Entertainment (meals, gifts)
- Licensing & Dues (MLS, association fees, E&O insurance)
- Photography/Staging (professional photos, virtual tours, staging)
- Lead Generation (leads, referral fees)
- Administrative (virtual assistant, office rent)
- Other

Provide JSON:
{
  "category": "category name",
  "subcategory": "more specific if applicable",
  "isDeductible": true/false,
  "deductionPercentage": 100 or partial,
  "deductionNotes": "explanation of tax treatment",
  "suggestedTags": ["tag1", "tag2"],
  "confidence": 0-100,
  "alternativeCategories": ["alt1", "alt2"]
}`,
    })

    let categorization
    try {
      const jsonMatch = categoryAnalysis.match(/\{[\s\S]*\}/)
      categorization = jsonMatch ? JSON.parse(jsonMatch[0]) : { category: "Other" }
    } catch {
      categorization = { category: "Other", isDeductible: true }
    }

    return {
      success: true,
      categorization,
    }
  } catch (error) {
    return handleError(error, "aiCategorizeExpense")
  }
}

/**
 * Create Expense with AI Enhancement
 */
export async function createExpense(params: ExpenseEntry) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  try {
    const categoryResult = await aiCategorizeExpense({
      agentId: params.agentId,
      description: params.description,
      amount: params.amount,
      vendor: params.vendor,
    })

    const categorization = categoryResult.success ? categoryResult.categorization : {}

    const expenseResult = await createExpenseRecordAction({
      agentId: params.agentId,
      category: params.category || categorization.category || "other",
      amount: params.amount,
      description: params.description,
      receiptUrl: params.receiptUrl,
      expenseDate: params.date,
    })

    if (!expenseResult.success || !expenseResult.data) {
      throw new Error(expenseResult.error || "Failed to create expense record")
    }

    const expense = expenseResult.data

    // Agent-scoped expenses are the AGENT'S book (Schedule C via CSV export) —
    // they never post to the brokerage's QuickBooks (same principle as team
    // financials not rolling up). Brokerage-scoped expenses ride the real
    // accounting egress in lib/finance/accounting-egress.ts.

    revalidatePath("/financials")

    return {
      success: true,
      expense,
      categorization,
    }
  } catch (error) {
    return handleError(error, "createExpense")
  }
}

/**
 * Get Expenses
 * Retrieves expense records with optional filters
 */
export async function getExpenses(params?: {
  agentId?: string
  category?: string
  status?: string
  startDate?: string
  endDate?: string
}) {
  const supabase = await createClient()

  try {
    let query = supabase
      .from("business_expenses")
      .select("*")
      .order("expense_date", { ascending: false })

    if (params?.agentId && isValidUUID(params.agentId)) {
      query = query.eq("agent_id", params.agentId)
    }

    if (params?.category) {
      query = query.eq("category", params.category)
    }

    // business_expenses has no status column — filter removed (phantom).

    if (params?.startDate) {
      query = query.gte("expense_date", params.startDate)
    }

    if (params?.endDate) {
      query = query.lte("expense_date", params.endDate)
    }

    const { data: expenses, error } = await query

    if (error) throw error

    return {
      success: true,
      expenses: expenses || [],
    }
  } catch (error) {
    return handleError(error, "getExpenses")
  }
}

/**
 * AI Calculate Commission
 * Uses AI to calculate commission splits with cap tracking
 */
export async function aiCalculateCommission(params: CommissionEntry) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid agent or transaction ID" }
  }

  const supabase = await createClient()

  try {
    // Get transaction details
    const { data: transaction } = await supabase
      .from("transactions")
      .select(`
        *,
        listings(address, city, sold_price)
      `)
      .eq("id", params.transactionId)
      .maybeSingle()

    // Get agent's commission structure.
    // pass 12: params.agentId is agents.id (every caller resolves via
    // getAgentContext), so match the agents PK — the old user_id lookup
    // silently returned null and the cap logic never engaged.
    // pass 13 CONSOLIDATION: cap state is owned by agent_cap_tracking (the
    // CapProgressBar, CDA portal, commission waterfall and kernel all key on
    // it) — the agents cap-progress column was a second drifting ledger; read the
    // canonical row here and let the kernel's createCommissionRecord own the
    // ratchet (it already updates cap_paid_to_date).
    const [{ data: agentProfile }, { data: capRow }] = await Promise.all([
      supabase
        .from("agents")
        .select("commission_split, brokerage_id")
        .eq("id", params.agentId)
        .maybeSingle(),
      supabase
        .from("agent_cap_tracking")
        .select("cap_amount, cap_paid_to_date")
        .eq("agent_id", params.agentId)
        .maybeSingle(),
    ])

    // Calculate commission breakdown
    const grossCommission = params.grossCommission

    const resolvedStructure = await resolveCommissionStructure(params)
    const agentSplit = resolvedStructure.splitPercentage

    if (!agentSplit) {
      throw new Error("[ai-financial-management] Cannot resolve agent split — no profile configured")
    }
    const brokerageFee = params.brokerageFee || 0
    const franchiseFee = params.franchiseFee || 0

    let additionalFeesTotal = 0
    const feeBreakdown: any[] = []

    // Standard fees
    if (brokerageFee > 0) {
      feeBreakdown.push({ name: "Brokerage Fee", amount: brokerageFee, type: "flat" })
      additionalFeesTotal += brokerageFee
    }

    if (franchiseFee > 0) {
      const franchiseAmount = grossCommission * (franchiseFee / 100)
      feeBreakdown.push({ name: "Franchise Fee", amount: franchiseAmount, type: "percentage" })
      additionalFeesTotal += franchiseAmount
    }

    // Custom additional fees
    if (params.additionalFees) {
      for (const fee of params.additionalFees) {
        feeBreakdown.push({ name: fee.name, amount: fee.amount, type: "flat" })
        additionalFeesTotal += fee.amount
      }
    }

    // Calculate split
    const brokerageShare = grossCommission * ((100 - agentSplit) / 100)
    const agentGross = grossCommission * (agentSplit / 100)
    const agentNet = agentGross - additionalFeesTotal

    // Check cap status (canonical agent_cap_tracking ledger)
    let cappedAmount = 0
    if (capRow?.cap_amount && capRow?.cap_paid_to_date != null) {
      const remainingToCap = capRow.cap_amount - capRow.cap_paid_to_date
      if (remainingToCap <= 0) {
        // Agent is capped, gets 100%
        cappedAmount = brokerageShare
      }
    }

    const finalAgentNet = agentNet + cappedAmount

    // AI Tax Estimation
    const { text: taxAnalysis } = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: `Estimate tax liability for this real estate commission.

COMMISSION DETAILS:
- Gross Commission: $${grossCommission.toLocaleString()}
- Agent Net: $${finalAgentNet.toLocaleString()}
- State: ${transaction?.listings?.city ? "Check state" : "Unknown"}

Provide JSON with tax estimates:
{
  "estimatedSelfEmploymentTax": number,
  "estimatedFederalTax": number,
  "estimatedStateTax": number,
  "totalEstimatedTax": number,
  "recommendedQuarterlyPayment": number,
  "taxSavingTips": ["tip1", "tip2"]
}`,
    })

    let taxEstimate
    try {
      const jsonMatch = taxAnalysis.match(/\{[\s\S]*\}/)
      taxEstimate = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      taxEstimate = { totalEstimatedTax: finalAgentNet * 0.3 }
    }

    // Save commission record
      const commissionResult = await createCommissionRecordAction({
      agentId: params.agentId,
      transactionId: params.transactionId,
      grossCommission,
      splitPercentage: agentSplit,
      brokerageFee: params.brokerageFee,
      franchiseFee: params.franchiseFee,
      additionalFees: params.additionalFees,
    })

    if (!commissionResult.success || !commissionResult.data) {
      throw new Error(commissionResult.error || "Failed to create commission record")
    }

    const commission = commissionResult.data

    // pass 13 CONSOLIDATION: the cap ratchet is OWNED by the kernel's
    // createCommissionRecord (agent_cap_tracking.cap_paid_to_date, updated in
    // the call above) — the old agents cap-progress update here was a second
    // ledger advancing in parallel and has been removed (keep-one verdict).

    // Sync to QuickBooks. pass 12: `commission` is the kernel's camelCase result
    // (id/grossCommission/agentNet…), NOT a DB row — the old call passed it raw so
    // agent_id/gross_commission/agent_net were all undefined and the sync was dead.
    await syncCommissionToQuickBooks({
      id: commission.id,
      agent_id: params.agentId,
      gross_commission: grossCommission,
      agent_net: finalAgentNet,
    })

    revalidatePath("/financials")

    return {
      success: true,
      commission: {
        grossCommission,
        agentSplit,
        brokerageShare,
        agentGross,
        feesTotal: additionalFeesTotal,
        feeBreakdown,
        cappedAmount,
        agentNet: finalAgentNet,
        taxEstimate,
      },
      commissionId: commission.id,
    }
  } catch (error) {
    return handleError(error, "aiCalculateCommission")
  }
}

/**
 * AI Profit & Loss Report Generator
 */
export async function aiGenerateProfitLossReport(params: {
  agentId: string
  startDate: string
  endDate: string
  includeProjections?: boolean
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get all income for period
  const summaryResult = await loadAgentProfitLossSummaryAction({
  agentId: params.agentId,
})

if (!summaryResult.success || !summaryResult.data) {
  throw new Error(summaryResult.error || "Failed to load agent financial summary")
}

const summary = summaryResult.data

const { data: expenses } = await supabase
  .from("business_expenses")
  .select("category, amount")
  .eq("agent_id", params.agentId)
  .gte("expense_date", params.startDate)
  .lte("expense_date", params.endDate)

const totalIncome = summary.totalIncome

const totalExpenses =
  typeof summary.totalExpenses === "number"
    ? summary.totalExpenses
    : expenses?.reduce((sum: number, e: any) => sum + (e.amount || 0), 0) || 0

const netProfit =
  typeof summary.netProfit === "number"
    ? summary.netProfit
    : totalIncome - totalExpenses

const transactionCount = summary.closedTransactions

    const expensesByCategory: Record<string, number> = {}
    expenses?.forEach((e: any) => {
      expensesByCategory[e.category] = (expensesByCategory[e.category] || 0) + e.amount
    })

    // business_expenses has no is_deductible/deduction_percentage columns — treat all
    // recorded business expenses as fully deductible.
    const deductibleExpenses =
      expenses?.reduce((sum: number, e: any) => sum + (e.amount || 0), 0) || 0
    
    // AI Analysis and Projections
    const { text: financialAnalysis } = await generateText({
      model: resolveModel("openai/gpt-4o"),
      prompt: `Analyze this real estate agent's financial performance and provide insights.

PERIOD: ${params.startDate} to ${params.endDate}

INCOME:
- Total Commissions: $${totalIncome.toLocaleString()}
- Number of Transactions: ${transactionCount}
- Average Commission: $${transactionCount ? (totalIncome / transactionCount).toLocaleString() : 0}

EXPENSES BY CATEGORY:
${Object.entries(expensesByCategory)
  .map(([cat, amt]) => `- ${cat}: $${(amt as number).toLocaleString()}`)
  .join("\n")}

TOTALS:
- Total Expenses: $${totalExpenses.toLocaleString()}
- Deductible Expenses: $${deductibleExpenses.toLocaleString()}
- Net Profit: $${netProfit.toLocaleString()}
- Profit Margin: ${totalIncome > 0 ? ((netProfit / totalIncome) * 100).toFixed(1) : 0}%

Provide comprehensive analysis:
{
  "performanceSummary": "2-3 sentence summary",
  "healthScore": 0-100,
  "keyMetrics": {
    "profitMargin": number,
    "expenseRatio": number,
    "avgTransactionValue": number
  },
  "topExpenseCategories": [{"category": "name", "amount": number, "percentOfTotal": number}],
  "taxProjection": {
    "estimatedTaxableIncome": number,
    "estimatedTaxLiability": number,
    "effectiveTaxRate": number,
    "quarterlyPaymentSuggestion": number
  },
  "recommendations": [
    {"area": "area", "suggestion": "suggestion", "potentialSavings": number}
  ],
  "yearEndProjection": {
    "projectedIncome": number,
    "projectedExpenses": number,
    "projectedProfit": number
  },
  "benchmarkComparison": {
    "vsAverageAgent": "above|at|below",
    "notes": "comparison notes"
  }
}`,
    })

    let analysis
    try {
      const jsonMatch = financialAnalysis.match(/\{[\s\S]*\}/)
      analysis = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      analysis = { performanceSummary: "Analysis unavailable" }
    }

    // Save report
    const { data: report, error } = await supabase
      .from("financial_reports")
      .insert({
        agent_id: params.agentId,
        report_type: "profit_loss",
        period_start: params.startDate,
        period_end: params.endDate,
        total_income: totalIncome,
        total_expenses: totalExpenses,
        net_profit: netProfit,
        expenses_by_category: expensesByCategory,
        deductible_expenses: deductibleExpenses,
        ai_analysis: analysis,
        generated_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/financials")

    return {
      success: true,
      report: {
        period: { start: params.startDate, end: params.endDate },
                income: {
          total: totalIncome,
          transactionCount,
          averageCommission: transactionCount ? totalIncome / transactionCount : 0,
        },
        expenses: {
          total: totalExpenses,
          byCategory: expensesByCategory,
          deductible: deductibleExpenses,
        },
        netProfit,
        profitMargin: totalIncome > 0 ? (netProfit / totalIncome) * 100 : 0,
        analysis,
      },
      reportId: report.id,
    }
  } catch (error) {
    return handleError(error, "aiGenerateProfitLossReport")
  }
}

/**
 * QuickBooks Sync Functions
 */
async function syncCommissionToQuickBooks(commission: any) {
  // REAL egress (keep-one): the old body built a QBO payload, logged
  // quickbooks_sync_log 'in_progress' and returned synced:true WITHOUT calling
  // Intuit — a stub that fed permanent silent-gap alarms. Commissions ARE
  // brokerage revenue, so they post through the ONE accounting egress with an
  // honest accounting_sync_log lifecycle (completed/failed, or no row when
  // QuickBooks isn't connected). quickbooks_sync_log is retired.
  const supabase = await createClient()
  const { data: agent } = await supabase
    .from("agents")
    .select("brokerage_id")
    .eq("id", commission.agent_id)
    .maybeSingle()
  if (!agent?.brokerage_id) return { synced: false }

  const { data: integration } = await supabase
    .from("integration_credentials")
    .select("id, webhook_url")
    .eq("brokerage_id", agent.brokerage_id)
    .eq("provider_name", "quickbooks")
    .eq("is_active", true)
    .maybeSingle()
  if (!integration) return { synced: false }

  const { pushCommissionToAccounting } = await import("@/lib/finance/accounting-egress")
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = createServiceClient()
  const outcome = await pushCommissionToAccounting(svc, {
    brokerageId: agent.brokerage_id,
    grossCommission: Number(commission.gross_commission) || 0,
    description: `Commission ${commission.id ?? ""}`.trim(),
    qbCustomerRef: null, // mapped per-tenant on the connection; unmapped fails honestly into the sync-errors UI
  })
  return { synced: outcome.success, error: outcome.error }
}



/**
 * AI Budget Planner
 * Creates smart budgets based on historical data and goals
 */
export async function aiCreateBudget(params: {
  agentId: string
  year: number
  incomeGoal?: number
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get historical data
    const lastYear = params.year - 1
    const { data: lastYearExpenses } = await supabase
      .from("business_expenses")
      .select("category, amount")
      .eq("agent_id", params.agentId)
      .gte("expense_date", `${lastYear}-01-01`)
      .lte("expense_date", `${lastYear}-12-31`)

    const { data: lastYearCommissions } = await supabase
      .from("agent_commissions")
      .select("agent_commission")
      .eq("agent_id", params.agentId)
      .gte("created_at", `${lastYear}-01-01`)
      .lte("created_at", `${lastYear}-12-31`)

    const lastYearIncome = lastYearCommissions?.reduce((sum: number, c: any) => sum + (c.agent_commission || 0), 0) || 0
    const lastYearTotalExpenses = lastYearExpenses?.reduce((sum: number, e: any) => sum + (e.amount || 0), 0) || 0

    // Categorize last year's expenses
    const expensesByCategory: Record<string, number> = {}
    lastYearExpenses?.forEach((e: any) => {
      expensesByCategory[e.category] = (expensesByCategory[e.category] || 0) + e.amount
    })

    // AI Budget Generation
    const { text: budgetPlan } = await generateText({
      model: resolveModel("openai/gpt-4o"),
      prompt: `Create a smart budget plan for a real estate agent.

HISTORICAL DATA (${lastYear}):
- Total Income: $${lastYearIncome.toLocaleString()}
- Total Expenses: $${lastYearTotalExpenses.toLocaleString()}
- Profit: $${(lastYearIncome - lastYearTotalExpenses).toLocaleString()}

EXPENSES BY CATEGORY:
${Object.entries(expensesByCategory)
  .map(([cat, amt]) => `- ${cat}: $${(amt as number).toLocaleString()}`)
  .join("\n")}

INCOME GOAL FOR ${params.year}: $${(params.incomeGoal || lastYearIncome * 1.2).toLocaleString()}

Create a detailed budget with monthly allocations:
{
  "annualBudget": {
    "projectedIncome": number,
    "targetProfit": number,
    "targetProfitMargin": number
  },
  "categoryBudgets": [
    {
      "category": "category name",
      "annualBudget": number,
      "monthlyBudget": number,
      "lastYearSpent": number,
      "changeFromLastYear": "percentage",
      "rationale": "why this amount"
    }
  ],
  "monthlyBreakdown": [
    {"month": "January", "expectedIncome": number, "budgetedExpenses": number}
  ],
  "savingsRecommendations": [
    {"category": "name", "currentSpend": number, "suggestedBudget": number, "savingsTip": "tip"}
  ],
  "investmentRecommendations": [
    {"area": "name", "suggestedInvestment": number, "expectedROI": "description"}
  ],
  "emergencyFund": {
    "recommended": number,
    "monthsOfExpenses": number
  },
  "taxSetAside": {
    "percentage": number,
    "monthlyAmount": number,
    "quarterlyPayment": number
  }
}`,
    })

    let budget
    try {
      const jsonMatch = budgetPlan.match(/\{[\s\S]*\}/)
      budget = jsonMatch ? JSON.parse(jsonMatch[0]) : {}
    } catch {
      budget = { annualBudget: { projectedIncome: params.incomeGoal || lastYearIncome * 1.2 } }
    }

    // Save budget
    const { data: savedBudget, error } = await supabase
      .from("budgets")
      .insert({
        agent_id: params.agentId,
        year: params.year,
        income_goal: params.incomeGoal || lastYearIncome * 1.2,
        budget_data: budget,
        created_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle()

    if (error) throw error

    revalidatePath("/financials")

    return {
      success: true,
      budget,
      budgetId: savedBudget.id,
    }
  } catch (error) {
    return handleError(error, "aiCreateBudget")
  }
}

/**
 * Get Commission Records
 * Retrieves commission records with optional filters
 */
export async function getCommissionRecords(params?: {
  brokerageId?: string
  agentId?: string
  transactionId?: string
  status?: string
  startDate?: string
  endDate?: string
}) {
  try {
    if (!params?.brokerageId || !isValidUUID(params.brokerageId)) {
      return { success: false, error: "Valid brokerageId is required" }
    }

    const queueResult = await loadCommissionQueueAction({
      brokerageId: params.brokerageId,
    })

    if (!queueResult.success || !queueResult.data) {
      throw new Error(queueResult.error || "Failed to load commission queue")
    }

    let commissions = queueResult.data

    if (params.agentId && isValidUUID(params.agentId)) {
      commissions = commissions.filter((c: any) => c.agentId === params.agentId)
    }

    if (params.transactionId && isValidUUID(params.transactionId)) {
      commissions = commissions.filter((c: any) => c.transactionId === params.transactionId)
    }

    if (params.status) {
      commissions = commissions.filter((c: any) => c.status === params.status)
    }

if (params.startDate) {
  const startDate = params.startDate
  commissions = commissions.filter((c: any) => {
    const createdAt = c.createdAt || c.created_at
    return createdAt ? createdAt >= startDate : true
  })
}

if (params.endDate) {
  const endDate = params.endDate
  commissions = commissions.filter((c: any) => {
    const createdAt = c.createdAt || c.created_at
    return createdAt ? createdAt <= endDate : true
  })
}

    return {
      success: true,
      commissions,
    }
  } catch (error) {
    return handleError(error, "getCommissionRecords")
  }
}

/**
 * Track Deposit
 * Records earnest money deposits with compliance tracking
 */
export async function trackDeposit(params: {
  agentId: string
  transactionId: string
  amount: number
  depositType: "earnest_money" | "option_fee" | "additional_deposit"
  receivedDate: string
  dueDate?: string
  escrowCompany?: string
  checkNumber?: string
  notes?: string
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.transactionId)) {
    return { success: false, error: "Invalid agent or transaction ID" }
  }

  const supabase = await createClient()

  try {
    // Create deposit record
    const { data: deposit, error } = await supabase
      .from("deposits")
      .insert({
        agent_id: params.agentId,
        transaction_id: params.transactionId,
        amount: params.amount,
        deposit_type: params.depositType,
        received_date: params.receivedDate,
        due_date: params.dueDate,
        escrow_company: params.escrowCompany,
        check_number: params.checkNumber,
        notes: params.notes,
        status: "received",
        created_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle()

    if (error) throw error

    // Create compliance task for deposit delivery
    await supabase.from("compliance_tasks").insert({
      agent_id: params.agentId,
      transaction_id: params.transactionId,
      task_type: "deposit_delivery",
      description: `Deliver ${params.depositType} of $${params.amount.toLocaleString()} to escrow`,
      due_date: params.dueDate || new Date(new Date(params.receivedDate).getTime() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      status: "pending",
      created_at: new Date().toISOString(),
    })

    revalidatePath("/financials")
    revalidatePath("/dashboard/transactions")

    return {
      success: true,
      deposit,
    }
  } catch (error) {
    return handleError(error, "trackDeposit")
  }
}

// ============================================================================
// WORKFLOW OS — generate invoice draft document
// ============================================================================
/**
 * Generates an AI-drafted invoice for a contact (vendor → agent, or agent → client
 * for service work). Called by the draft_document workflow adapter when
 * document_type = "invoice".
 *
 * Writes the invoice line items + total + AI-drafted memo onto the documents
 * record passed in (created upstream by the adapter).
 */
export async function generateInvoice(params: {
  brokerageId: string
  contactId?: string | null
  agentUserId?: string | null
  transactionId?: string | null
  documentId?: string | null
  /** Optional pre-filled line items; AI suggests if omitted */
  lineItems?: Array<{ description: string; quantity: number; unitPrice: number }>
  /** Free-form description of what the invoice is for (used for AI generation) */
  invoicePurpose?: string
}): Promise<{
  success: boolean
  documentId?: string
  invoiceTotal?: number
  error?: string
}> {
  try {
    const supabase = await createClient()

    // Fetch context for the AI to draft against
    let contactName = "Client"
    let agentName = "Agent"
    if (params.contactId) {
      const { data: c } = await supabase
        .from("contacts").select("first_name, last_name").eq("id", params.contactId).maybeSingle()
      if (c) contactName = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || "Client"
    }
    if (params.agentUserId) {
      const { data: u } = await supabase
        .from("users").select("first_name, last_name").eq("id", params.agentUserId).maybeSingle()
      if (u) agentName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || "Agent"
    }

    // AI drafts line items if none provided
    let lineItems = params.lineItems ?? []
    if (lineItems.length === 0) {
      const prompt = `Draft a professional real estate invoice from ${agentName} to ${contactName}.
Purpose: ${params.invoicePurpose ?? "real estate services rendered"}.
Output ONLY a JSON array of line items: [{"description":"string","quantity":number,"unitPrice":number}].
Typical items: consultation fee, listing prep, marketing services, transaction coordination, photography reimbursement, etc.
Suggest 2-4 realistic line items totalling $500-$2500. JSON only, no prose.`

      try {
        const { text } = await generateText({
          feature: "invoice_draft",
          messages: [{ role: "user", content: prompt }],
        })
        const cleaned = text.replace(/```json|```/g, "").trim()
        const parsed = JSON.parse(cleaned)
        if (Array.isArray(parsed)) {
          lineItems = parsed.filter(
            (i: any) => typeof i?.description === "string" && typeof i?.quantity === "number" && typeof i?.unitPrice === "number"
          )
        }
      } catch { /* keep empty */ }
    }

    const subtotal = lineItems.reduce((sum, item) => sum + (item.quantity * item.unitPrice), 0)
    const invoiceTotal = subtotal // tax handling deferred to per-state config

    // AI drafts a payment memo
    let memo = `Invoice from ${agentName} for services rendered.`
    try {
      const memoPrompt = `Write a professional 1-2 sentence invoice memo for an invoice from ${agentName} to ${contactName} for ${params.invoicePurpose ?? "real estate services"}. Total: $${invoiceTotal.toLocaleString()}. Polite, brief, professional.`
      const { text } = await generateText({
        feature: "invoice_memo",
        messages: [{ role: "user", content: memoPrompt }],
      })
      if (text) memo = text.trim()
    } catch { /* keep default */ }

    const invoiceContent = JSON.stringify({
      from: agentName,
      to: contactName,
      issuedAt: new Date().toISOString(),
      lineItems,
      subtotal,
      total: invoiceTotal,
      memo,
    }, null, 2)

    // Update the documents record (created upstream by draft_document adapter)
    if (params.documentId) {
      await supabase.from("documents").update({
        content: invoiceContent,
        status: "draft_ready",
        metadata: {
          line_items: lineItems,
          total_cents: Math.round(invoiceTotal * 100),
          memo,
          contact_name: contactName,
          agent_name: agentName,
        },
        updated_at: new Date().toISOString(),
      }).eq("id", params.documentId)
    }

    return { success: true, documentId: params.documentId ?? undefined, invoiceTotal }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
