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
        result = await compareProperties(params.propertyIds, userId)
        break
        
      case "affordability_calculator":
        result = await calculateAffordability(params.income, params.downPayment, params.location)
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
  
  // Log usage
  await supabase.from("ai_tool_usage").insert({
    user_id: userId,
    user_type: userType,
    tool_name: toolName,
    input_data: params,
    output_data: result,
    execution_time_ms: Date.now() - startTime,
    success,
    tokens_used: result?.tokensUsed || 0,
  })
  
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

async function compareProperties(propertyIds: string[], userId: string) {
  const supabase = await createClient()
  
  const { data: properties } = await supabase
    .from("listings")
    .select("*")
    .in("id", propertyIds)
  
  if (!properties || properties.length < 2) {
    throw new Error("Need at least 2 properties to compare")
  }
  
  const prompt = `
You are a real estate AI assistant. Compare these properties for a homebuyer and provide insights:

${properties.map((p, i) => `
Property ${i + 1}:
- Address: ${p.address}
- Price: $${p.price?.toLocaleString()}
- Beds: ${p.beds} | Baths: ${p.baths} | SqFt: ${p.sqft}
- Year Built: ${p.year_built}
- Property Type: ${p.property_type}
`).join("\\n")}

Provide:
1. Price per square foot comparison
2. Key differentiators
3. Pros/cons of each
4. Which property offers better value and why

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

async function calculateAffordability(income: number, downPayment: number, location: string) {
  // Standard lending ratios
  const maxDTI = 0.43 // 43% debt-to-income ratio
  const estimatedTaxRate = 0.012 // 1.2% annual property tax
  const estimatedInsurance = 1200 // annual
  const estimatedHOA = 0 // monthly
  
  const maxMonthlyPayment = (income / 12) * maxDTI
  const estimatedRate = 0.07 // 7% interest rate assumption
  
  // Calculate max loan amount
  const monthlyRate = estimatedRate / 12
  const numPayments = 360 // 30-year mortgage
  
  const maxLoanAmount = maxMonthlyPayment * 
    ((1 - Math.pow(1 + monthlyRate, -numPayments)) / monthlyRate)
  
  const maxHomePrice = maxLoanAmount + downPayment
  
  const prompt = `
Based on these financials:
- Annual Income: $${income.toLocaleString()}
- Down Payment: $${downPayment.toLocaleString()}
- Location: ${location}
- Max Home Price: $${maxHomePrice.toLocaleString()}

Provide friendly, actionable advice for a homebuyer:
1. What price range should they focus on?
2. Monthly payment estimate (including taxes, insurance)
3. Tips for improving buying power
4. What to expect in the ${location} market

Be encouraging and practical. 2-3 paragraphs.
`
  
  const { text } = await generateText({
    model: "openai/gpt-4o-mini",
    prompt,
    temperature: 0.7,
  })
  
  return {
    maxHomePrice: Math.round(maxHomePrice),
    maxMonthlyPayment: Math.round(maxMonthlyPayment),
    downPayment,
    recommendations: text,
  }
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
    tools_by_category: groupByCategory(data || []),
  }
}

function groupByCategory(usage: any[]) {
  const grouped: any = {}
  for (const item of usage) {
    const category = item.tool_category || "other"
    grouped[category] = (grouped[category] || 0) + 1
  }
  return grouped
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
