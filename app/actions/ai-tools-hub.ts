"use server"

import { createClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"

// =====================================================
// UNIVERSAL AI TOOL EXECUTOR
// =====================================================

export async function executeAITool(
  toolName: string,
  userId: string,
  userType: string,
  params: any
) {
  const supabase = await createClient()
  const startTime = Date.now()
  
  let result: any
  let success = true
  
  try {
    switch (toolName) {
      // CLIENT EDUCATION TOOLS
      case "explain_this":
        result = await explainTerm(params.term, params.context, userType)
        break
        
      case "property_comparison":
        result = await compareProperties(params, userId)
        break
        
      case "affordability_calculator":
        // The form's own four fields — income, debt, downPayment, rate. The old
        // call passed params.location, which this form does not collect, and
        // dropped debt and rate entirely.
        result = await runAffordabilityTool(params)
        break
        
      case "neighborhood_research":
        result = await researchNeighborhood(params.address, userId)
        break
        
      case "document_explainer":
        result = await explainDocument(params.documentText, params.documentType)
        break
        
      // AGENT TOOLS
      case "property_description":
        result = await generatePropertyDescription(params.propertyData, userId)
        break
        
      case "email_composer":
        result = await composeEmail(params.context, params.tone, userId)
        break
        
      case "social_post":
        result = await generateSocialPost(params.platform, params.topic, params.propertyId, userId)
        break
        
      case "objection_handler":
        result = await handleObjection(params.objection, params.context)
        break
        
      case "smart_reply":
        result = await generateSmartReply(params.messageHistory, params.context, userId)
        break
        
      // BROKER TOOLS
      case "deal_health_monitor":
        result = await analyzeDealHealth(params.transactionIds, userId)
        break
        
      case "team_performance_analyzer":
        result = await analyzeTeamPerformance(params.dateRange, params.metrics, userId)
        break
        
      case "market_trend_predictor":
        result = await predictMarketTrends(params.marketArea, params.timeframe)
        break
        
      // TC TOOLS
      case "document_checklist":
        result = await generateDocumentChecklist(params.transactionType, params.state)
        break
        
      case "deadline_calculator":
        result = await calculateDeadlines(params.contractDate, params.state)
        break
        
      default:
        throw new Error(`Unknown tool: ${toolName}`)
    }
    
  } catch (error: any) {
    success = false
    result = { error: error.message }
  }
  
  // Log usage. ai_tool_usage real columns: context_json (was input_data),
  // output_text (was output_data); no user_type column.
  //
  // TENANT — read from the USERS ROW this usage record is filed against
  // (ai_tool_usage.user_id FKs users(id), and users carries brokerage_id), not
  // from `userType`, which is a role string, and not from any agents id: agents.id
  // and brokerages.id are disjoint spaces.
  //
  // Omitting it was not cosmetic. lib/finance/usage-metering.ts rolls the AI
  // meter up per brokerage with `.eq("brokerage_id", b.id)`, as does the
  // brokerage P&L cron — and `NULL = <uuid>` is NULL, never true — so every run
  // logged through this hub was billed to nobody and counted toward no
  // brokerage's usage. Meanwhile lib/kernel/ai-tools.ts reads the same rows by
  // user_id, which is why the feature looked fine from the agent's own screen.
  const { data: toolUserRow, error: toolUserError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", userId)
    .maybeSingle()
  // supabase-js RESOLVES a refused query, so an unread error here would silently
  // downgrade "this read was denied" into "this user has no brokerage".
  if (toolUserError) {
    console.error("[ai-tools-hub] users lookup for tenant stamp refused:", toolUserError.message)
  }
  const toolBrokerageId = (toolUserRow?.brokerage_id as string | null) ?? null
  if (!toolBrokerageId) {
    console.error(
      `[ai-tools-hub] user ${userId} carries no brokerage_id — ai_tool_usage row written untenanted and will not appear in the brokerage usage meter`,
    )
  }

  const { error: usageError } = await supabase.from("ai_tool_usage").insert({
    brokerage_id: toolBrokerageId,
    user_id: userId,
    tool_name: toolName,
    context_json: JSON.stringify(params ?? {}),
    output_text: typeof result === "string" ? result : JSON.stringify(result ?? {}),
    execution_time_ms: Date.now() - startTime,
    success,
    tokens_used: result?.tokensUsed || 0,
  })
  if (usageError) {
    console.error("[ai-tools-hub] ai_tool_usage insert failed:", usageError.message)
  }

  return { success, result }
}

// =====================================================
// RAG-BASED "EXPLAIN THIS" FOR CLIENTS
// =====================================================

async function explainTerm(term: string, context: string, userType: string) {
  const supabase = await createClient()
  
  // Search knowledge base using text search (simplified without embeddings)
  const { data: relevantDocs, error } = await supabase
    .from("knowledge_articles")
    .select("content, title")
    .textSearch("content", term)
    .limit(3)
  
  if (error) {
    console.error("[AI Tools] RAG search error:", error)
    throw new Error("Failed to search knowledge base")
  }
  
  // AI generates explanation using retrieved context
  const prompt = `
Explain "${term}" in simple, plain English for a ${userType === "buyer" ? "homebuyer" : userType === "seller" ? "home seller" : "real estate professional"}.

Context from knowledge base:
${relevantDocs?.map((d: any) => d.content).join("\\n\\n")}

Additional context: ${context}

Requirements:
- No jargon
- Use analogies and examples
- 2-3 sentences max
- Reassuring tone
- "Them First" approach

Explain:
`
  
  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt,
    temperature: 0.7,
  })
  
  return {
    term,
    explanation: text,
    learn_more_docs: relevantDocs?.map((d: any) => d.title) || [],
  }
}

// =====================================================
// PROPERTY COMPARISON (CLIENT TOOL)
// =====================================================

interface ComparePropertiesParams {
  property1?: string
  property2?: string
  property3?: string
  buyerCriteria?: string
}

async function compareProperties(params: ComparePropertiesParams, userId: string) {
  const supabase = await createClient()

  // Buyer-side properties live in `saved_properties` (IDX/external/manual,
  // keyed by `property_address`) — NOT the seller-owned `listings` table and
  // not a non-existent `properties` table. The UI collects address strings,
  // so we match on address and enrich with whatever saved-property data exists.
  const addresses = [params.property1, params.property2, params.property3]
    .map((a) => a?.trim())
    .filter((a): a is string => Boolean(a))

  if (addresses.length < 2) {
    throw new Error("Need at least 2 property addresses to compare")
  }

  const { data: saved } = await supabase
    .from("saved_properties")
    .select(
      "property_address, list_price, bedrooms, bathrooms, sqft, city, state, property_type, source"
    )
    .eq("user_id", userId)
    .in("property_address", addresses)

  const byAddress = new Map(
    (saved ?? []).map((p) => [p.property_address?.trim().toLowerCase(), p])
  )

  const properties = addresses.map((address) => {
    const match = byAddress.get(address.toLowerCase())
    return {
      property_address: address,
      list_price: match?.list_price ?? null,
      bedrooms: match?.bedrooms ?? null,
      bathrooms: match?.bathrooms ?? null,
      sqft: match?.sqft ?? null,
      city: match?.city ?? null,
      state: match?.state ?? null,
      property_type: match?.property_type ?? null,
      source: match?.source ?? null,
    }
  })

  const prompt = `
You are a real estate AI assistant. Compare these properties for a homebuyer and provide insights.
${params.buyerCriteria ? `\nBuyer criteria: ${params.buyerCriteria}\n` : ""}
${properties
  .map(
    (p, i) => `
Property ${i + 1}:
- Address: ${p.property_address}
- Price: ${p.list_price != null ? `$${Number(p.list_price).toLocaleString()}` : "unknown"}
- Beds: ${p.bedrooms ?? "?"} | Baths: ${p.bathrooms ?? "?"} | SqFt: ${p.sqft ?? "?"}
- Location: ${[p.city, p.state].filter(Boolean).join(", ") || "unknown"}
- Property Type: ${p.property_type ?? "unknown"}`
  )
  .join("\n")}

Where a field is unknown, reason from the address and buyer criteria rather than inventing numbers.
Provide:
1. Price per square foot comparison (only where data is available)
2. Key differentiators
3. Pros/cons of each
4. Which property offers better value for this buyer and why

Be concise, objective, and helpful.
`

  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt,
    temperature: 0.7,
  })

  return {
    properties,
    comparison: text,
  }
}

// =====================================================
// AFFORDABILITY CALCULATOR
// =====================================================
//
// This case used to run a SECOND, weaker affordability model defined right here.
// app/actions/calculators.ts calculateAffordability is the survivor — it is
// strictly more capable and it matches the fields this tool's own form already
// collects. The local copy is deleted. What it got wrong:
//
//   · It took (income, downPayment, location) while the form collects income,
//     debt, downPayment and RATE. The buyer's monthly debt and the real interest
//     rate were typed in and thrown away; it assumed zero debt and hardcoded 7%.
//   · `location` is not a field on this form at all, so it was always undefined —
//     the prompt asked the model what to expect "in the undefined market".
//   · The form's inputs are text ("$120,000", "$500", "6.5%" — its own
//     placeholders). `"$120,000" / 12` is NaN, so every figure it produced was
//     NaN and the narrative quoted $NaN.
//   · It returned an OBJECT while this screen renders results as text, so the
//     panel showed "[object Object]".
//   · Its single 43% DTI ignored property tax, insurance, PMI and HOA when
//     solving for max price, so the number it did aim at was too high anyway.
//
// The survivor applies front-end 28% AND back-end 36% DTI against real debts,
// and solves for max price carrying tax + insurance + PMI + HOA. The AI narrative
// stays — it is this tool's value-add — but it now explains REAL figures instead
// of generating them.

/** "6.5%" / "6.5" → 6.5. Returns null rather than guessing. */
function parseRatePercent(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) && v >= 0 ? v : null
  if (typeof v !== "string") return null
  const cleaned = v.replace(/[%\s]/g, "")
  if (cleaned === "" || !/^\d+(\.\d+)?$/.test(cleaned)) return null
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : null
}

async function runAffordabilityTool(params: {
  income?: unknown
  debt?: unknown
  downPayment?: unknown
  rate?: unknown
}): Promise<string> {
  const { parseMoney } = await import("@/lib/offers/closing-cost-accuracy")

  const annualIncome = parseMoney(params.income)
  const downPayment = parseMoney(params.downPayment)
  const interestRate = parseRatePercent(params.rate)
  // Debt is the one genuinely optional field — blank means no monthly debts,
  // which is a real answer. An UNREADABLE value is not the same thing and is
  // refused below rather than silently treated as zero.
  const debtRaw = typeof params.debt === "string" ? params.debt.trim() : params.debt
  const monthlyDebts = debtRaw === "" || debtRaw == null ? 0 : parseMoney(debtRaw)

  const missing: string[] = []
  if (annualIncome == null) missing.push("annual income")
  if (downPayment == null) missing.push("down payment")
  if (interestRate == null) missing.push("interest rate")
  if (monthlyDebts == null) missing.push("monthly debt")

  if (missing.length > 0) {
    // No figure at all beats a figure built on NaN.
    return `I could not read ${missing.join(", ")}. Enter ${missing.length === 1 ? "it" : "them"} as a plain amount — for example 120000 or $120,000 for income, and 6.5 or 6.5% for the rate — and run it again.`
  }

  const { calculateAffordability } = await import("@/app/actions/calculators")
  const affordability = await calculateAffordability({
    annualIncome: annualIncome!,
    monthlyDebts: monthlyDebts!,
    downPayment: downPayment!,
    interestRate: interestRate!,
  })

  const b = affordability.monthlyBreakdown
  const h = affordability.hiddenCosts
  const money = (n: number) => `$${Math.round(n).toLocaleString()}`

  const figures = `Maximum home price: ${money(affordability.maxHomePrice)}
Down payment: ${money(affordability.downPayment)}
Loan amount: ${money(affordability.loanAmount)}

Estimated monthly payment: ${money(b.total)}
  Principal & interest: ${money(b.principal_interest)}
  Property tax: ${money(b.property_tax)}
  Insurance: ${money(b.insurance)}
  PMI: ${money(b.pmi)}
  HOA: ${money(b.hoa)}

Costs beyond the payment:
  Estimated closing costs: ${money(h.closing_costs)}
  Monthly maintenance budget: ${money(h.maintenance_budget)}
  Estimated utilities: ${money(h.utilities_estimate)}`

  // The narrative EXPLAINS the numbers above; it does not produce them.
  const prompt = `You are advising a homebuyer. These figures were already
calculated from their real inputs — annual income ${money(annualIncome!)}, monthly
debts ${money(monthlyDebts!)}, down payment ${money(downPayment!)}, interest rate
${interestRate}%:

${figures}

Write 2-3 short paragraphs that:
1. Explain what price range they should realistically shop in and why.
2. Point out which part of the monthly payment will surprise them most.
3. Give concrete ways to increase their buying power.

Use ONLY the figures above. Do not recalculate them, do not introduce different
numbers, and do not comment on any specific city or market — no location was
provided.`

  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt,
    temperature: 0.7,
  })

  const notes = affordability.recommendations?.length
    ? `\n\nWhat to watch:\n${affordability.recommendations.map((r) => `• ${r}`).join("\n")}`
    : ""

  return `${figures}\n\n${text}${notes}`
}

// =====================================================
// NEIGHBORHOOD RESEARCH
// =====================================================

async function researchNeighborhood(address: string, userId: string) {
  const prompt = `
Provide a comprehensive neighborhood analysis for: ${address}

Cover:
1. Schools (quality, ratings)
2. Safety & Crime Statistics
3. Walkability & Transportation
4. Local Amenities (restaurants, shopping, parks)
5. Market Trends (appreciation, inventory)
6. Demographics & Community Vibe

Be factual, balanced, and helpful for a homebuyer making a decision.
`
  
  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt,
    temperature: 0.7,
  })
  
  return {
    address,
    analysis: text,
  }
}

// =====================================================
// BROKER: DEAL HEALTH MONITOR
// =====================================================

async function analyzeDealHealth(transactionIds: string[], userId: string) {
  const supabase = await createClient()
  
  const { data: transactions } = await supabase
    .from("transactions")
    .select("*, document_requests(*)")
    .in("id", transactionIds)
  
  const healthReports = []
  
  for (const txn of transactions || []) {
    let healthScore = 100
    const issues = []
    
    // Check time in stage
    const daysInStage = Math.floor(
      (Date.now() - new Date(txn.stage_entered_at || txn.created_at).getTime()) / (1000 * 60 * 60 * 24)
    )
    
    if (daysInStage > 30) {
      healthScore -= 20
      issues.push(`Stalled: ${daysInStage} days in ${txn.status}`)
    }
    
    // Check missing documents
    const overdueDocs = txn.document_requests?.filter(
      (d: any) => d.status === "pending" && new Date(d.due_date) < new Date()
    )
    
    if (overdueDocs && overdueDocs.length > 0) {
      healthScore -= overdueDocs.length * 15
      issues.push(`${overdueDocs.length} documents overdue`)
    }
    
    // Check communication frequency
    if (txn.days_since_last_comm > 7) {
      healthScore -= 10
      issues.push(`No communication in ${txn.days_since_last_comm} days`)
    }
    
    healthReports.push({
      transaction_id: txn.id,
      property_address: txn.property_address,
      health_score: Math.max(healthScore, 0),
      status: healthScore >= 70 ? "healthy" : healthScore >= 50 ? "warning" : "critical",
      issues,
      recommendation: generateHealthRecommendation(healthScore, issues),
    })
  }
  
  return { health_reports: healthReports }
}

function generateHealthRecommendation(score: number, issues: string[]): string {
  if (score >= 70) return "Deal is on track. Continue normal monitoring."
  if (score >= 50) return `Action needed: ${issues[0]}. Schedule check-in call.`
  return `URGENT: Multiple issues detected. ${issues.join(". ")}. Escalate immediately.`
}

// =====================================================
// FAVORITES MANAGEMENT
// =====================================================

export async function toggleToolFavorite(userId: string, toolName: string) {
  const supabase = await createClient()
  
  const { data: existing } = await supabase
    .from("ai_tool_favorites")
    .select()
    .eq("user_id", userId)
    .eq("tool_name", toolName)
    .maybeSingle()
  
  if (existing) {
    await supabase.from("ai_tool_favorites").delete().eq("id", existing.id)
    return { favorited: false }
  } else {
    await supabase.from("ai_tool_favorites").insert({ user_id: userId, tool_name: toolName })
    return { favorited: true }
  }
}

export async function getUserFavorites(userId: string) {
  const supabase = await createClient()
  
  const { data } = await supabase
    .from("ai_tool_favorites")
    .select("tool_name")
    .eq("user_id", userId)
  
  return data?.map((f) => f.tool_name) || []
}

// =====================================================
// USAGE ANALYTICS
// =====================================================

export async function getAIToolUsageStats(userId: string, dateRange?: { start: string; end: string }) {
  const supabase = await createClient()
  
  let query = supabase
    .from("ai_tool_usage")
    .select("*")
    .eq("user_id", userId)
  
  if (dateRange) {
    query = query.gte("created_at", dateRange.start).lte("created_at", dateRange.end)
  }
  
  const { data } = await query
  
  const totalTasks = data?.length || 0
  const totalTokens = data?.reduce((sum, d) => sum + (d.tokens_used || 0), 0) || 0
  const avgExecutionTime = data?.reduce((sum, d) => sum + (d.execution_time_ms || 0), 0) / totalTasks || 0
  
  // Calculate time saved (assume 5 minutes per AI task)
  const timeSavedHours = (totalTasks * 5) / 60
  
  return {
    total_tasks: totalTasks,
    total_tokens: totalTokens,
    time_saved_hours: Math.round(timeSavedHours * 10) / 10,
    avg_execution_time_ms: Math.round(avgExecutionTime),
    // Per-tool counts, most-used first. The AI Toolkit's "Recently Used" row needs an
    // ARRAY of {toolName, count} and previously tried to .sort() this whole object,
    // which crashed the page. Keyed on tool_name — the real column on ai_tool_usage.
    by_tool: groupByTool(data || []),
  }
}

/**
 * Count usage per tool from the REAL column (ai_tool_usage.tool_name).
 *
 * This replaces a groupByCategory helper that read `item.tool_category` — a column that
 * does not exist on ai_tool_usage — so every row fell to "other" and the returned
 * tools_by_category was always a single meaningless bucket. Nothing consumed it. Tool
 * categories live in the client's TOOLS constant, not in the table, so grouping by
 * category cannot be done here honestly; per-tool counts are what the caller wants.
 */
function groupByTool(usage: any[]): Array<{ toolName: string; count: number }> {
  const counts = new Map<string, number>()
  for (const item of usage) {
    const name = item?.tool_name
    if (!name) continue
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([toolName, count]) => ({ toolName, count }))
    .sort((a, b) => b.count - a.count)
}

// Placeholder implementations for remaining tools
async function generatePropertyDescription(propertyData: any, userId: string) {
  return { description: "AI-generated property description", tokensUsed: 500 }
}

async function composeEmail(context: string, tone: string, userId: string) {
  return { email: "AI-generated email", tokensUsed: 400 }
}

async function generateSocialPost(platform: string, topic: string, propertyId: string, userId: string) {
  return { post: "AI-generated social post", tokensUsed: 300 }
}

async function handleObjection(objection: string, context: string) {
  return { response: "AI-generated objection handler", tokensUsed: 350 }
}

async function generateSmartReply(messageHistory: string, context: string, userId: string) {
  return { reply: "AI-generated smart reply", tokensUsed: 250 }
}

async function analyzeTeamPerformance(dateRange: any, metrics: any, userId: string) {
  return { analysis: "Team performance analysis", tokensUsed: 600 }
}

async function predictMarketTrends(marketArea: string, timeframe: string) {
  return { trends: "Market trend predictions", tokensUsed: 700 }
}

async function generateDocumentChecklist(transactionType: string, state: string) {
  return { checklist: "Document checklist", tokensUsed: 200 }
}

async function calculateDeadlines(contractDate: string, state: string) {
  return { deadlines: "Calculated deadlines", tokensUsed: 150 }
}

async function explainDocument(documentText: string, documentType: string) {
  return { explanation: "Document explanation", tokensUsed: 500 }
}
