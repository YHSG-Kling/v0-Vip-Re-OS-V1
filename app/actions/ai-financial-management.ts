"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "ai"
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
  loadAgentFinancialSummaryAction,
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
      .select("category, vendor, description")
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

    await syncExpenseToQuickBooks(expense)

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

    if (params?.status) {
      query = query.eq("status", params.status)
    }

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
        listings(address, city, sale_price)
      `)
      .eq("id", params.transactionId)
      .maybeSingle()

    // Get agent's commission structure
    const { data: agentProfile } = await supabase
      .from("agents")
      .select("commission_split, brokerage_id, cap_amount, cap_current")
      .eq("user_id", params.agentId)
      .maybeSingle()

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

    // Check cap status
    let cappedAmount = 0
    if (agentProfile?.cap_amount && agentProfile?.cap_current) {
      const remainingToCap = agentProfile.cap_amount - agentProfile.cap_current
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

    // Update agent's cap tracking
    if (agentProfile && !cappedAmount) {
      await supabase
        .from("agents")
        .update({
          cap_current: (agentProfile.cap_current || 0) + brokerageShare,
        })
        .eq("user_id", params.agentId)
    }

    // Sync to QuickBooks
    await syncCommissionToQuickBooks(commission)

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
        const summaryResult = await loadAgentFinancialSummaryAction({
      agentId: params.agentId,
      periodType: "ytd",
    })

    if (!summaryResult.success || !summaryResult.data) {
      throw new Error(summaryResult.error || "Failed to load agent financial summary")
    }

   type FinancialSummaryCompat = {
  totalIncome?: number
  totalCommissionRevenue?: number
  totalExpenses?: number
  netProfit?: number
  netIncome?: number
  closedTransactions?: number
  total_income?: number
  total_commission_revenue?: number
  total_expenses?: number
  net_profit?: number
  net_income?: number
  closed_transactions?: number
}

const summary = summaryResult.data as unknown as FinancialSummaryCompat

// Keep expense detail query only for category breakdown + deductible math
const { data: expenses } = await supabase
  .from("business_expenses")
  .select("category, amount, is_deductible, deduction_percentage")
  .eq("agent_id", params.agentId)
  .gte("expense_date", params.startDate)
  .lte("expense_date", params.endDate)

const totalIncome =
  typeof summary.totalIncome === "number"
    ? summary.totalIncome
    : typeof summary.total_income === "number"
      ? summary.total_income
      : typeof summary.totalCommissionRevenue === "number"
        ? summary.totalCommissionRevenue
        : typeof summary.total_commission_revenue === "number"
          ? summary.total_commission_revenue
          : 0

const totalExpenses =
  typeof summary.totalExpenses === "number"
    ? summary.totalExpenses
    : typeof summary.total_expenses === "number"
      ? summary.total_expenses
      : expenses?.reduce((sum: number, e: any) => sum + (e.amount || 0), 0) || 0

const netProfit =
  typeof summary.netProfit === "number"
    ? summary.netProfit
    : typeof summary.net_profit === "number"
      ? summary.net_profit
      : typeof summary.netIncome === "number"
        ? summary.netIncome
        : typeof summary.net_income === "number"
          ? summary.net_income
          : totalIncome - totalExpenses

const transactionCount =
  typeof summary.closedTransactions === "number"
    ? summary.closedTransactions
    : typeof summary.closed_transactions === "number"
      ? summary.closed_transactions
      : 0

    const expensesByCategory: Record<string, number> = {}
    expenses?.forEach((e: any) => {
      expensesByCategory[e.category] = (expensesByCategory[e.category] || 0) + e.amount
    })

    const deductibleExpenses =
      expenses?.filter((e: any) => e.is_deductible).reduce((sum: number, e: any) => {
        const pct = typeof e.deduction_percentage === "number" ? e.deduction_percentage : 100
        return sum + (e.amount * pct) / 100
      }, 0) || 0
    
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
      .single()

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
async function syncExpenseToQuickBooks(expense: any) {
  const supabase = await createClient()

  // Resolve agent_id to brokerage_id
  const { data: agent } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", expense.agent_id)
    .single()

  if (!agent?.brokerage_id) {
    console.log("[v0] Agent brokerage not found, skipping sync")
    return { synced: false }
  }

  // Check if QuickBooks is connected
  const { data: integration } = await supabase
    .from("integration_credentials")
    .select("*")
    .eq("brokerage_id", agent.brokerage_id)
    .eq("provider_name", "quickbooks")
    .eq("is_active", true)
    .single()

  if (!integration) {
    console.log("[v0] QuickBooks not connected, skipping sync")
    return { synced: false }
  }

  try {
    // Map to QuickBooks expense format
    const qbExpense = {
      PaymentType: "Cash",
      AccountRef: { value: getCategoryAccountId(expense.category) },
      TotalAmt: expense.amount,
      TxnDate: expense.expense_date,
      PrivateNote: expense.description,
      Line: [
        {
          DetailType: "AccountBasedExpenseLineDetail",
          Amount: expense.amount,
          AccountBasedExpenseLineDetail: {
            AccountRef: { value: getCategoryAccountId(expense.category) },
          },
        },
      ],
    }

    // Log sync attempt (actual API call would go here)
    await supabase.from("quickbooks_sync_log").insert({
      agent_id: expense.agent_id,
      entity_type: "expense",
      entity_id: expense.id,
      qb_data: qbExpense,
      status: "pending",
      created_at: new Date().toISOString(),
    })

    return { synced: true, qbData: qbExpense }
  } catch (error) {
    console.error("[v0] QuickBooks sync error:", error)
    return { synced: false, error }
  }
}

async function syncCommissionToQuickBooks(commission: any) {
  const supabase = await createClient()

  // Resolve agent_id to brokerage_id
  const { data: agent } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", commission.agent_id)
    .maybeSingle()

  if (!agent?.brokerage_id) {
    console.log("[v0] Agent brokerage not found, skipping sync")
    return { synced: false }
  }

  // Check if QuickBooks is connected
  const { data: integration } = await supabase
    .from("integration_credentials")
    .select("*")
    .eq("brokerage_id", agent.brokerage_id)
    .eq("provider_name", "quickbooks")
    .eq("is_active", true)
    .maybeSingle()

  if (!integration) {
    console.log("[v0] QuickBooks not connected, skipping sync")
    return { synced: false }
  }

  try {
    // Map to QuickBooks invoice/payment format
    const qbInvoice = {
      CustomerRef: { value: "1" }, // Would be actual customer/brokerage ID
      TotalAmt: commission.gross_commission,
      Line: [
        {
          DetailType: "SalesItemLineDetail",
          Amount: commission.agent_net,
          SalesItemLineDetail: {
            ItemRef: { value: "1" }, // Commission income item
          },
        },
      ],
    }

    // Log sync attempt
    await supabase.from("quickbooks_sync_log").insert({
      agent_id: commission.agent_id,
      entity_type: "commission",
      entity_id: commission.id,
      qb_data: qbInvoice,
      status: "pending",
      created_at: new Date().toISOString(),
    })

    return { synced: true, qbData: qbInvoice }
  } catch (error) {
    console.error("[v0] QuickBooks sync error:", error)
    return { synced: false, error }
  }
}

function getCategoryAccountId(category: string): string {
  const categoryMap: Record<string, string> = {
    Marketing: "60",
    Technology: "61",
    Transportation: "62",
    "Professional Development": "63",
    "Office Supplies": "64",
    "Client Entertainment": "65",
    "Licensing & Dues": "66",
    "Photography/Staging": "67",
    "Lead Generation": "68",
    Administrative: "69",
    Other: "70",
  }
  return categoryMap[category] || "70"
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
      .from("commissions")
      .select("agent_net")
      .eq("agent_id", params.agentId)
      .gte("created_at", `${lastYear}-01-01`)
      .lte("created_at", `${lastYear}-12-31`)

    const lastYearIncome = lastYearCommissions?.reduce((sum: number, c: any) => sum + (c.agent_net || 0), 0) || 0
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
      .smaybeSingle()

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
      .single()

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
