"use server"

import { createClient } from "@/lib/supabase/server"
import { generateAIJSON } from "@/lib/ai"
import { getDefaultCommissionStructure } from "@/lib/brokerage"

// ============================================
// PREDICTIVE LEAD CONVERSION ENGINE
// ============================================

interface LeadPrediction {
  conversionProbability: number
  confidence: number
  predictedDealSize: number
  predictedTimelineDays: number
  predictedConversionDate: string
  scoreTier: "platinum" | "gold" | "silver" | "bronze"
  conversionBlockers: Array<{
    blocker: string
    severity: "high" | "medium" | "low"
    solution: string
  }>
  optimalStrategy: {
    nextAction: string
    when: string
    approach: string
    channelPreference: string
    talking_points: string[]
  }
  personaInsights: {
    persona: string
    specialConsiderations: string[]
    compassionateApproach: string
    resources: string[]
  }
  predictedBehavior: {
    likelyToRequestShowing: boolean
    optimalShowingDay: string
    propertiesToShow: number
    decisionMakingStyle: string
    negotiationStyle: string
  }
  riskFactors: Array<{
    risk: string
    mitigation: string
  }>
}

// Predict which leads will convert (ML-based)
export async function predictLeadConversion(leadId: string): Promise<LeadPrediction | { error: string }> {
  const supabase = await createClient()

  // Try to gather lead data - handle tables that may not exist
  let lead: unknown = null
  let leadIntelligence: unknown = null
  let behavioralData: unknown[] = []
  let engagementScores: unknown = null
  let propertyOwnership: unknown[] = []
  let peopleData: unknown = null
  let motivatedSellerSignals: unknown[] = []
  let propertyInteractions: unknown[] = []
  let chatSessions: unknown[] = []

  // Get base lead data - try leads table first, then contacts
  const { data: leadData, error: leadError } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle()

  if (leadData) {
    lead = leadData
  } else {
    // Fallback to contacts table
    const { data: contactData } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", leadId)
      .maybeSingle()
    
    if (contactData) {
      lead = {
        ...contactData,
        lead_source: (contactData as Record<string, unknown>).source || "unknown",
        last_contact_date: (contactData as Record<string, unknown>).last_contact_date || (contactData as Record<string, unknown>).updated_at
      }
    }
  }

  if (!lead) {
    return { error: "Lead not found" }
  }

  const leadRecord = lead as Record<string, unknown>

  // Try to get intelligence data
  try {
    const { data } = await supabase
      .from("lead_intelligence")
      .select("*")
      .eq("lead_id", leadId)
      .maybeSingle()
    leadIntelligence = data
  } catch (e) { /* Table may not exist */ }

  // Try to get behavioral data
  try {
    const { data } = await supabase
      .from("lead_behavioral_data")
      .select("*")
      .eq("lead_id", leadId)
    behavioralData = data || []
  } catch (e) { /* Table may not exist */ }

  // Try to get engagement scores
  try {
    const { data } = await supabase
      .from("lead_engagement_scores")
      .select("*")
      .eq("lead_id", leadId)
      .order("calculated_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    engagementScores = data
  } catch (e) { /* Table may not exist */ }

  // Try to get property ownership
  try {
    const { data } = await supabase
      .from("lead_property_ownership")
      .select("*")
      .eq("lead_id", leadId)
    propertyOwnership = data || []
  } catch (e) { /* Table may not exist */ }

  // Try to get people data
  try {
    const { data } = await supabase
      .from("lead_people_data")
      .select("*")
      .eq("lead_id", leadId)
      .maybeSingle()
    peopleData = data
  } catch (e) { /* Table may not exist */ }

  // Try to get motivated seller signals
  try {
    const { data } = await supabase
      .from("lead_motivated_seller_signals")
      .select("*")
      .eq("lead_id", leadId)
    motivatedSellerSignals = data || []
  } catch (e) { /* Table may not exist */ }

  // Try to get property interactions
  try {
    const { data } = await supabase
      .from("lead_idx_property_interactions")
      .select("*")
      .eq("lead_id", leadId)
    propertyInteractions = data || []
  } catch (e) { /* Table may not exist */ }

  // Calculate days since first contact
  const daysSinceFirstContact = (lead as any).created_at
    ? Math.floor((Date.now() - new Date((lead as any).created_at).getTime()) / (1000 * 60 * 60 * 24))
    : 0

  // Count email opens from behavioral data
  const emailOpens = behavioralData.filter((b: any) => b.event_type === "email_open").length

  // Build the AI prompt
  const prompt = `You are an advanced real estate AI that predicts lead conversion probability.

Lead Profile:
- Name: ${(leadRecord.first_name as string | null) || "Unknown"} ${(leadRecord.last_name as string | null) || ""}
- Source: ${(leadRecord.lead_source as string | null) || (leadRecord.source as string | null) || "Unknown"}
- Days Since First Contact: ${daysSinceFirstContact}
- Last Contact: ${(leadRecord.last_contact_date as string | null) || "Never"}
- Email: ${(leadRecord.email as string | null) || "Not provided"}
- Phone: ${(leadRecord.phone as string | null) || "Not provided"}

Behavioral Signals:
- Email Opens: ${emailOpens}
- Property Views: ${(propertyInteractions as Record<string, unknown>[]).length}
- Engagement Score: ${(engagementScores as Record<string, unknown> | null)?.overall_score as number || 0}/100

Intelligence:
- Buyer/Seller Type: ${(leadIntelligence as Record<string, unknown> | null)?.buyer_seller_type as string || "Unknown"}
- Price Range: ${(leadIntelligence as Record<string, unknown> | null)?.price_range as string || "Unknown"}
- Timeline: ${(leadIntelligence as Record<string, unknown> | null)?.timeline as string || "Unknown"}
- Motivation Score: ${(leadIntelligence as Record<string, unknown> | null)?.motivation_score as number || 0}/100
- Qualification Score: ${(leadIntelligence as Record<string, unknown> | null)?.qualification_score as number || 0}/100

Financial Indicators:
- Property Ownership: ${(propertyOwnership as Record<string, unknown>[]).length} properties
- Estimated Income: $${((peopleData as Record<string, unknown> | null)?.financial_indicators as Record<string, unknown> | null)?.estimated_income as number || 0}
- Motivated Seller Signals: ${(motivatedSellerSignals as Record<string, unknown>[]).length}

Based on ALL this data, predict:

1. **Conversion Probability** (0-100%): How likely are they to close a deal?
2. **Predicted Deal Size** ($): Expected transaction value
3. **Predicted Timeline**: Days until conversion
4. **Conversion Blockers**: What's preventing them from moving forward?
5. **Optimal Strategy**: Exactly what to do next to maximize conversion

Respond with JSON only:
{
  "conversionProbability": 75,
  "confidence": 0.92,
  "predictedDealSize": 450000,
  "predictedTimelineDays": 45,
  "predictedConversionDate": "2026-03-15",
  "scoreTier": "platinum",
  "conversionBlockers": [
    {"blocker": "Not pre-approved", "severity": "high", "solution": "Connect with preferred lender immediately"}
  ],
  "optimalStrategy": {
    "nextAction": "Schedule pre-approval consultation",
    "when": "Within 48 hours",
    "approach": "Emphasize buying power knowledge",
    "channelPreference": "phone",
    "talking_points": ["Current market conditions", "Rate environment", "Inventory levels"]
  },
  "personaInsights": {
    "persona": "first_time_buyer",
    "specialConsiderations": ["Education needed", "Budget conscious"],
    "compassionateApproach": "We understand this is a big decision.",
    "resources": ["First-time buyer guide", "Loan calculator"]
  },
  "predictedBehavior": {
    "likelyToRequestShowing": true,
    "optimalShowingDay": "Saturday",
    "propertiesToShow": 4,
    "decisionMakingStyle": "analytical",
    "negotiationStyle": "collaborative"
  },
  "riskFactors": [
    {"risk": "May be shopping multiple agents", "mitigation": "Demonstrate unique value"}
  ]
}`

  try {
    const result = await generateAIJSON<LeadPrediction>(prompt)
    
    if (!result.data) {
      return { error: result.error || "Prediction failed" }
    }

    const prediction = result.data

    // Save prediction to ai_predictions table
    try {
      await supabase.from("ai_predictions").insert({
        prediction_type: "lead_conversion",
        entity_type: "lead",
        entity_id: leadId,
        prediction_value: prediction,
        confidence_score: (prediction as any).confidence,
        prediction_factors: extractFactors(lead as any, leadIntelligence, engagementScores, propertyInteractions) as any,
        model_version: "v1.0",
      })
    } catch (e) {
      console.error("[v0] Failed to save ai_predictions:", e)
    }

    // Save/update predictive lead score
    try {
      await supabase.from("predictive_lead_scores").upsert({
        lead_id: leadId,
        conversion_probability: prediction.conversionProbability,
        predicted_conversion_date: prediction.predictedConversionDate,
        predicted_deal_size: prediction.predictedDealSize,
        predicted_timeline_days: prediction.predictedTimelineDays,
        overall_ai_score: prediction.conversionProbability,
        score_tier: prediction.scoreTier,
        recommended_actions: prediction.optimalStrategy,
        optimal_contact_time: calculateOptimalContactTime(behavioralData),
        best_communication_channel: prediction.optimalStrategy.channelPreference,
        personalized_approach: prediction.optimalStrategy.approach,
        model_version: "v1.0",
      })
    } catch (e) {
      console.error("[v0] Failed to save predictive_lead_scores:", e)
    }

    return prediction
  } catch (error) {
    console.error("[v0] AI prediction failed:", error)
    return { error: "Prediction unavailable" }
  }
}

function extractFactors(
  lead: Record<string, unknown>,
  intelligence: unknown,
  engagement: unknown,
  interactions: unknown[]
): Record<string, unknown>[] {
  const factors: Record<string, unknown>[] = []
  const engagementRecord = engagement as Record<string, unknown> | null
  const intelligenceRecord = intelligence as Record<string, unknown> | null

  if ((engagementRecord?.overall_score as number) > 70) {
    factors.push({
      factor: "high_engagement",
      weight: 0.3,
      value: engagementRecord?.overall_score,
    })
  }

  if ((interactions || []).length >= 5) {
    factors.push({
      factor: "active_property_viewing",
      weight: 0.25,
      value: interactions.length,
    })
  }

  if ((intelligenceRecord?.timeline as string) === "immediate") {
    factors.push({ factor: "urgent_timeline", weight: 0.15, value: 1 })
  }

  if ((intelligenceRecord?.motivation_score as number) > 70) {
    factors.push({
      factor: "high_motivation",
      weight: 0.2,
      value: intelligenceRecord?.motivation_score,
    })
  }

  return factors
}

function calculateOptimalContactTime(behavioralData: unknown[]): string {
  // Analyze past engagement patterns
  const hourCounts: Record<number, number> = {};

  (behavioralData || []).forEach((e: unknown) => {
    const record = e as Record<string, unknown> | null
    if (record?.occurred_at) {
      const hour = new Date(record.occurred_at as string).getHours()
      hourCounts[hour] = (hourCounts[hour] || 0) + 1
    }
  })

  const bestHour =
    (Object.entries(hourCounts) as Array<[string, number]>).sort((a, b) => b[1] - a[1])[0]?.[0] || "14" // Default to 2pm

  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(parseInt(bestHour), 0, 0, 0)

  return tomorrow.toISOString()
}

// ============================================
// GET LEAD PREDICTION HISTORY
// ============================================

export async function getLeadPredictions(leadId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("ai_predictions")
    .select("*")
    .eq("entity_id", leadId)
    .eq("entity_type", "lead")
    .order("created_at", { ascending: false })
    .limit(10)

  if (error) {
    console.error("[v0] Error fetching lead predictions:", error)
    return []
  }

  return data || []
}

// ============================================
// GET PREDICTIVE LEAD SCORE
// ============================================

export async function getPredictiveLeadScore(leadId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("predictive_lead_scores")
    .select("*")
    .eq("lead_id", leadId)
    .maybeSingle()

  if (error) {
    console.error("[v0] Error fetching predictive score:", error)
    return null
  }

  return data
}

// ============================================
// BATCH PREDICT FOR MULTIPLE LEADS
// ============================================

export async function batchPredictLeadConversions(leadIds: string[]) {
  const results = await Promise.allSettled(
    leadIds.map((id) => predictLeadConversion(id))
  )

  return results.map((result, index) => ({
    leadId: leadIds[index],
    prediction: result.status === "fulfilled" ? result.value : { error: "Failed" },
  }))
}

// ============================================
// GET TOP CONVERSION CANDIDATES
// ============================================

export async function getTopConversionCandidates(limit = 10) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("predictive_lead_scores")
    .select("*, leads(*), contacts(*)")
    .order("conversion_probability", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("[v0] Error fetching top candidates:", error)
    return []
  }

  return data || []
}

// ============================================
// REFRESH STALE PREDICTIONS
// ============================================

export async function refreshStalePredictions(olderThanDays = 7) {
  const supabase = await createClient()

  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - olderThanDays)

  const { data: staleScores, error } = await supabase
    .from("predictive_lead_scores")
    .select("lead_id")
    .lt("updated_at", cutoffDate.toISOString())
    .limit(50)

  if (error || !staleScores?.length) {
    return { refreshed: 0 }
  }

  const leadIds = staleScores.map((s) => s.lead_id)
  await batchPredictLeadConversions(leadIds)

  return { refreshed: leadIds.length }
}

// ============================================
// AI AUTO-PILOT MODE FOR LEAD NURTURING
// ============================================

export async function enableAIPilot(data: {
  agentId: string
  leadId: string
  autopilotLevel: "conservative" | "moderate" | "aggressive"
}) {
  const supabase = await createClient()

  // Check agent authorization
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (user?.id !== data.agentId) {
    return { success: false, error: "Unauthorized" }
  }

  // Gather comprehensive lead data
  const { data: lead } = await supabase.from("leads").select("*").eq("id", data.leadId).maybeSingle()

  if (!lead) {
    // Fallback to contacts table
    const { data: contact } = await supabase.from("contacts").select("*").eq("id", data.leadId).maybeSingle()
    if (!contact) {
      return { success: false, error: "Lead not found" }
    }
  }

  // Get additional intelligence data
  const { data: leadIntelligence } = await supabase
    .from("lead_intelligence")
    .select("*")
    .eq("lead_id", data.leadId)
    .maybeSingle()

  const { data: behavioralData } = await supabase
    .from("lead_behavioral_data")
    .select("*")
    .eq("lead_id", data.leadId)

  const { data: persona } = await supabase
    .from("client_detailed_personas")
    .select("*")
    .eq("contact_id", data.leadId)
    .maybeSingle()

  const { data: predictionScore } = await supabase
    .from("predictive_lead_scores")
    .select("*")
    .eq("lead_id", data.leadId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Generate AI nurture plan using Vercel AI Gateway
  const prompt = `You are an AI agent assistant. Create a complete auto-pilot nurture plan:

Lead: ${lead?.first_name || "Unknown"} ${lead?.last_name || "Contact"}
Persona: ${persona?.primary_persona || "general"}
Engagement Score: ${behavioralData?.length || 0} interactions
Predicted Conversion: ${predictionScore?.conversion_probability || 50}%
Timeline: ${leadIntelligence?.timeline || "unknown"}

Auto-Pilot Level: ${data.autopilotLevel}
- Conservative: Monthly check-ins, educational content only
- Moderate: Bi-weekly check-ins, property recommendations
- Aggressive: Weekly contact, proactive showing scheduling

Create a 90-day nurture plan with:
1. Email cadence (all must be compliance-approved templates)
2. Property recommendation frequency
3. Check-in schedule
4. Content themes (them-first focused)
5. Trigger-based actions (e.g., if they view property, send similar listings immediately)
6. Escalation points (when to hand back to agent)

CRITICAL: All communications must:
- Use them-first language
- Be compassionate to their persona (military, divorce, probate, etc.)
- Respect cold lead rules (email/print only if applicable)
- Use approved content only

Respond with JSON matching this structure:
{
  "duration_days": 90,
  "touchpoints": [
    {
      "day": 1,
      "action": "send_email",
      "template": "them_first_welcome",
      "subject": "Your Home Search Journey",
      "personalization": {},
      "channel": "email"
    }
  ],
  "triggers": [
    {
      "event": "property_viewed",
      "action": "send_similar_properties_within_1_hour"
    }
  ],
  "escalationCriteria": [
    "Conversion probability reaches 80%",
    "Lead requests showing"
  ],
  "compassionateNotes": {}
}`

  try {
    const { data: aiResponse } = await generateAIJSON(prompt)

    if (!aiResponse) {
      return { success: false, error: "Failed to generate nurture plan" }
    }

    // Calculate next action date (first touchpoint)
    const firstTouchpoint = aiResponse.touchpoints?.[0]
    const nextActionDate = new Date()
    if (firstTouchpoint?.day) {
      nextActionDate.setDate(nextActionDate.getDate() + firstTouchpoint.day)
    }

    // Save auto-pilot plan to database
    const { data: savedPlan, error: saveError } = await supabase
      .from("ai_autopilot_plans")
      .insert({
        lead_id: data.leadId,
        agent_id: data.agentId,
        autopilot_level: data.autopilotLevel,
        nurture_plan: aiResponse,
        is_active: true,
        started_at: new Date().toISOString(),
        next_action_at: nextActionDate.toISOString(),
        total_touchpoints: aiResponse.touchpoints?.length || 0,
      })
      .select()
      .single()

    if (saveError) {
      console.error("[v0] Error saving autopilot plan:", saveError)
      return { success: false, error: "Failed to save nurture plan" }
    }

    return {
      success: true,
      plan: aiResponse,
      planId: savedPlan.id,
      message: `AI Auto-Pilot enabled! I'll nurture ${lead?.first_name || "this lead"} with them-first communication and alert you when they're ready.`,
    }
  } catch (error) {
    console.error("[v0] Error in enableAIPilot:", error)
    return { success: false, error: "Failed to generate auto-pilot plan" }
  }
}

// Get active auto-pilot plans for an agent
export async function getActiveAutoPilotPlans(agentId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("ai_autopilot_plans")
    .select("*, leads(*), contacts(*)")
    .eq("agent_id", agentId)
    .eq("is_active", true)
    .order("next_action_at", { ascending: true })

  if (error) {
    console.error("[v0] Error fetching autopilot plans:", error)
    return []
  }

  return data || []
}

// Pause/resume auto-pilot for a lead
export async function toggleAutoPilot(planId: string, pause: boolean) {
  const supabase = await createClient()

  const { error } = await supabase
    .from("ai_autopilot_plans")
    .update({
      is_active: !pause,
      paused_at: pause ? new Date().toISOString() : null,
    })
    .eq("id", planId)

  if (error) {
    console.error("[v0] Error toggling autopilot:", error)
    return { success: false }
  }

  return { success: true }
}

// ============================================
// DEAL CLOSE PROBABILITY PREDICTION
// ============================================

export async function predictDealCloseProbability(transactionId: string) {
  const supabase = await createClient()

  // Gather comprehensive transaction data
  const { data: transaction, error } = await supabase
    .from("transactions")
    .select(
      `
      *,
      contacts(*),
      transaction_milestones(*),
      transaction_lenders(*),
      transaction_inspections(*),
      transaction_repair_negotiations(*)
    `,
    )
    .eq("id", transactionId)
    .maybeSingle()

  if (error || !transaction) {
    console.error("[v0] Error fetching transaction:", error)
    throw new Error("Transaction not found")
  }

  const daysToClosing = transaction.closing_date
    ? Math.floor((new Date(transaction.closing_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : 0

  // Calculate milestone progress
  const milestones = transaction.transaction_milestones || []
  const completedMilestones = milestones.filter((m: any) => m.status === "completed").length
  const overdueMilestones = milestones.filter((m: any) => m.status === "overdue").length

  // Get lender data
  const lender = transaction.transaction_lenders?.[0]
  const conditionsCleared = lender?.conditions_cleared || 0
  const totalConditions = lender?.conditions_list?.length || 0

  // Get inspection data
  const inspections = transaction.transaction_inspections || []
  const completedInspections = inspections.filter((i: any) => i.status === "completed")
  const issuesFound = completedInspections.reduce((sum: number, i: any) => sum + (i.issues_found?.length || 0), 0)

  // Get repair negotiation data
  const repairNegotiation = transaction.transaction_repair_negotiations?.[0]
  const repairsRequested = repairNegotiation?.requested_repairs?.length || 0

  // Generate AI prediction
  const prompt = `You are a real estate transaction AI. Predict if this deal will close successfully:

Transaction: ${transaction.property_address || "Unknown Property"}
Contract Price: $${transaction.sale_price?.toLocaleString() || transaction.contract_price?.toLocaleString() || "Unknown"}
Days to Closing: ${daysToClosing}
Progress: ${transaction.progress_percentage || 0}%

Milestones:
- Completed: ${completedMilestones}/${milestones.length}
- Overdue: ${overdueMilestones}

Financing:
- Status: ${lender?.underwriting_status || "Unknown"}
- Loan Type: ${lender?.loan_type || "Unknown"}
- Conditions Cleared: ${conditionsCleared}/${totalConditions}

Inspection:
- Completed: ${completedInspections.length > 0}
- Issues Found: ${issuesFound}
- Repairs Requested: ${repairsRequested}
- Negotiation Status: ${repairNegotiation?.status || "N/A"}

Predict:
1. Close probability (0-100%)
2. Risk factors that could derail the deal
3. Recommended actions to increase probability
4. Predicted final close date
5. Probability of price renegotiation

Respond with JSON:
{
  "closeProbability": 85,
  "confidence": 0.90,
  "tier": "high_confidence",
  "predictedCloseDate": "2026-03-01",
  "onTimeCloseProbability": 75,
  "riskFactors": [
    {
      "risk": "Loan approval delayed",
      "severity": "high",
      "probability": 0.35,
      "mitigation": "Daily check-ins with lender",
      "impact": "Could delay closing 7-14 days"
    }
  ],
  "successFactors": [
    "Strong financing",
    "Motivated seller",
    "Clean inspection"
  ],
  "recommendedActions": [
    {
      "action": "Order appraisal immediately",
      "priority": "high",
      "deadline": "5_days_before_closing"
    }
  ],
  "priceRenegotiationProbability": 15,
  "estimatedFinalPrice": 447500,
  "dealHealthScore": 88
}`

  try {
    const prediction = await generateAIJSON(prompt)

    if (!prediction) {
      throw new Error("Failed to generate prediction")
    }

    // Save prediction to database
    const { data: savedPrediction, error: saveError } = await supabase
      .from("ai_predictions")
      .insert({
        prediction_type: "deal_close_probability",
        entity_type: "transaction",
        entity_id: transactionId,
        prediction_value: prediction,
        confidence_score: (prediction as any).confidence || 0.5,
        model_version: "v1.0",
      })
      .select()
      .maybeSingle()

    if (saveError) {
      console.error("[v0] Error saving prediction:", saveError)
    }

    // Create AI insights for critical risks
    if ((prediction as any).riskFactors?.some((r: any) => r.severity === "high")) {
      const criticalRisks = (prediction as any).riskFactors.filter((r: any) => r.severity === "high")

      for (const risk of criticalRisks) {
        await supabase.from("ai_insights").insert({
          insight_type: "risk",
          entity_type: "transaction",
          entity_id: transactionId,
          insight_title: `High Risk: ${risk.risk}`,
          insight_description: risk.mitigation,
          actionable_steps: [risk.mitigation],
          priority: "critical",
          estimated_impact: { probability: risk.probability },
        })
      }
    }

    return {
      success: true,
      prediction,
      predictionId: savedPrediction?.id,
    }
  } catch (error) {
    console.error("[v0] Error in predictDealCloseProbability:", error)
    throw new Error("Failed to predict deal outcome")
  }
}

// ============================================
// CONVERSATION INTELLIGENCE ANALYZER
// ============================================

export async function analyzeConversation(data: {
  leadId: string
  agentId: string
  conversationType: "call" | "email" | "sms" | "chat"
  conversationId: string
  transcript: string
}) {
  const supabase = await createClient()

  // Build comprehensive AI analysis prompt
  const prompt = `You are an AI conversation analyst for real estate. Analyze this ${data.conversationType}:

TRANSCRIPT:
${data.transcript}

Analyze:
1. **Sentiment**: How does the client feel? (positive/neutral/negative/frustrated/excited)
2. **Intent**: What do they really want? (buy now/research/price shop/validation)
3. **Buying Signals**: Phrases indicating readiness to move forward
4. **Objections**: Concerns or hesitations expressed
5. **Pain Points**: What problems are they trying to solve?
6. **Decision Makers**: Who else is involved? (spouse, parents, etc.)
7. **Timeline Urgency**: How soon do they need to act?
8. **Budget Reality**: Are they being honest about budget or holding back?
9. **Them-First Score**: Did agent focus on client needs or pitch themselves? (0-100)
10. **Compliance Issues**: Any Fair Housing violations or prohibited language?

Provide ACTIONABLE coaching. Respond with JSON:
{
  "summary": "Brief summary of conversation (2-3 sentences)",
  "sentiment": {
    "overall": "excited",
    "confidence": 0.88,
    "emotional_state": "hopeful but anxious about timeline"
  },
  "intent": {
    "primary": "ready_to_buy",
    "secondary": ["wants_validation", "comparing_agents"],
    "urgency": "high"
  },
  "buyingSignals": [
    {"signal": "Asked about closing timeline", "strength": "strong"},
    {"signal": "Mentioned spouse is ready", "strength": "strong"}
  ],
  "objections": [
    {
      "objection": "Worried about mortgage approval",
      "severity": "high",
      "how_to_handle": "Connect with lender TODAY"
    }
  ],
  "painPoints": [
    "Current rental lease ending in 60 days",
    "Kids need to enroll in school by August"
  ],
  "decisionMakers": {
    "primary": "Client",
    "spouse_involvement": "high",
    "others": ["Father (financial advisor)"]
  },
  "budgetReality": {
    "stated_max": 450000,
    "actual_comfort": 480000,
    "reasoning": "Asked about properties at $465k without price concern"
  },
  "themFirstScore": 72,
  "themFirstAnalysis": {
    "good": ["Asked about their timeline multiple times"],
    "improve": ["Said 'I can help' 4 times - switch to 'You deserve expert guidance'"]
  },
  "complianceIssues": [],
  "nextSteps": {
    "immediate": [
      "Send pre-approval info within 2 hours",
      "Schedule showing for this Saturday"
    ],
    "within_24_hours": [
      "Send properties in $450-480k range"
    ],
    "avoid": ["Don't pressure on timeline"]
  },
  "recommendedFollowup": {
    "when": "Tomorrow morning 9am",
    "channel": "phone",
    "talking_points": [
      "Thank them for sharing their situation",
      "Confirm pre-approval consultation"
    ],
    "themFirstApproach": "You deserve to feel confident about this investment."
  },
  "dealProbability": 85,
  "predictedTimelineToClose": 45
}`

  try {
    const analysis = await generateAIJSON(prompt)

    if (!analysis.data) {
      throw new Error("Conversation analysis failed")
    }

    const result = analysis.data

    // Save conversation intelligence to database
    const { data: intelligence, error: saveError } = await supabase
      .from("conversation_intelligence")
      .insert({
        lead_id: data.leadId,
        agent_id: data.agentId,
        conversation_type: data.conversationType,
        conversation_id: data.conversationId,
        transcript: data.transcript,
        summary: result.summary,
        key_points: [
          ...(result.buyingSignals?.map((s: any) => s.signal) || []),
          ...(result.objections?.map((o: any) => o.objection) || []),
        ],
        sentiment_score: result.sentiment?.confidence || 0.5,
        intent_detected: [result.intent?.primary, ...(result.intent?.secondary || [])],
        objections_raised: result.objections?.map((o: any) => o.objection) || [],
        buying_signals: result.buyingSignals?.map((s: any) => s.signal) || [],
        pain_points: result.painPoints || [],
        them_first_score: result.themFirstScore || 50,
        coaching_suggestions: result.themFirstAnalysis?.improve || [],
        missed_opportunities: [],
        ai_recommended_followup: result.recommendedFollowup?.themFirstApproach || "",
        optimal_followup_time: result.recommendedFollowup?.when || "Within 24 hours",
        analyzed_at: new Date().toISOString(),
      })
      .select()
      .maybeSingle()

    if (saveError) {
      console.error("[v0] Error saving conversation intelligence:", saveError)
    }

    // Update lead temperature based on deal probability
    const leadTemperature =
      result.dealProbability >= 70 ? "hot" : result.dealProbability >= 40 ? "warm" : "cold"

    try {
      await supabase
        .from("leads")
        .update({
          lead_temperature: leadTemperature,
          last_contact_date: new Date().toISOString(),
        })
        .eq("id", data.leadId)
    } catch (e) {
      // Try contacts table if leads doesn't exist
      await supabase
        .from("contacts")
        .update({
          last_contact_date: new Date().toISOString(),
        })
        .eq("id", data.leadId)
    }

    // Create AI insight for immediate actions
    if (result.nextSteps?.immediate?.length > 0) {
      await supabase.from("ai_insights").insert({
        insight_type: "opportunity",
        entity_type: "lead",
        entity_id: data.leadId,
        insight_title: "🚨 Take Action NOW",
        insight_description: result.nextSteps.immediate.join("\n"),
        actionable_steps: result.nextSteps.immediate,
        priority: "critical",
        estimated_impact: {
          deal_probability_increase: "+15%",
          if_not_acted_on: "Lead may go cold or choose another agent",
        },
      })
    }

    // Flag compliance issues if any
    if (result.complianceIssues?.length > 0) {
      await supabase.from("compliance_flags").insert({
        entity_type: "conversation",
        entity_id: intelligence?.id || data.conversationId,
        flag_type: "fair_housing_violation",
        severity: "high",
        description: `Compliance issues detected: ${result.complianceIssues.join(", ")}`,
        flagged_content: data.transcript,
        status: "open",
      })
    }

    return {
      success: true,
      analysis: result,
      intelligenceId: intelligence?.id,
    }
  } catch (error) {
    console.error("[v0] Error in analyzeConversation:", error)
    throw new Error("Conversation analysis failed")
  }
}

// Get conversation intelligence history for a lead
export async function getConversationIntelligence(leadId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("conversation_intelligence")
    .select("*")
    .eq("lead_id", leadId)
    .order("analyzed_at", { ascending: false })
    .limit(20)

  if (error) {
    console.error("[v0] Error fetching conversation intelligence:", error)
    return []
  }

  return data || []
}

// Get agent coaching insights
export async function getAgentCoachingInsights(agentId: string, limit = 10) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("conversation_intelligence")
    .select("them_first_score, coaching_suggestions, conversation_type, analyzed_at")
    .eq("agent_id", agentId)
    .order("analyzed_at", { ascending: false })
    .limit(limit)

  if (error) {
    console.error("[v0] Error fetching coaching insights:", error)
    return []
  }

  // Calculate average them-first score
  const avgScore =
    data.reduce((sum, c) => sum + (c.them_first_score || 0), 0) / (data.length || 1)

  return {
    conversations: data,
    averageThemFirstScore: Math.round(avgScore),
    improvementAreas: data.flatMap((c) => c.coaching_suggestions || []).slice(0, 5),
  }
}

// ============================================
// AI PROPERTY MATCH GENIUS
// ============================================

export async function aiPropertyMatchGenius(leadId: string) {
  const supabase = await createClient()
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
  const idxClient = new IDXBrokerClient()

  // Gather comprehensive lead data with all property interactions
  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select(
      `
      *,
      saved_properties(*),
      lead_idx_property_interactions(*),
      client_detailed_personas(*),
      client_journey_preferences(*)
    `,
    )
    .eq("id", leadId)
    .maybeSingle()

  if (leadError || !lead) {
    // Try contacts table as fallback
    const { data: contact } = await supabase
      .from("contacts")
      .select(
        `
        *,
        saved_properties(*),
        client_detailed_personas(*)
      `,
      )
      .eq("id", leadId)
      .maybeSingle()

    if (!contact) {
      throw new Error("Lead not found")
    }
  }

  // Get property family ratings from collaborative searches
  const { data: familyRatings } = await supabase
    .from("property_family_ratings")
    .select(
      `
      *,
      collaborative_searches!inner(contact_id)
    `,
    )
    .eq("collaborative_searches.contact_id", leadId)
    .limit(20)

  // Build AI prompt to learn true preferences
  const savedProps = lead?.saved_properties || []
  const viewedProps = lead?.lead_idx_property_interactions || []
  const preferences = lead?.client_journey_preferences?.[0] || {}
  const persona = lead?.client_detailed_personas?.[0] || {}

  const prompt = `You are an AI real estate matchmaker. Learn this buyer's TRUE preferences from their behavior:

SAVED PROPERTIES (${savedProps.length}):
${savedProps
  .slice(0, 10)
  .map(
    (p: any) => `
- ${p.property_address || "Unknown"}: ${p.property_data?.bedrooms || "?"}bd/${p.property_data?.bathrooms || "?"}ba, $${p.property_data?.price?.toLocaleString() || "Unknown"}
  Rating: ${p.rating || "N/A"}/5
  Notes: "${p.notes || "No notes"}"
  Features: ${p.property_data?.features?.join(", ") || "No features listed"}
`,
  )
  .join("\n")}

PROPERTIES VIEWED BUT NOT SAVED (${viewedProps.length}):
${viewedProps
  .slice(0, 5)
  .map(
    (i: any) => `
- ${i.property_address || "Unknown"}: $${i.property_details?.price?.toLocaleString() || "Unknown"}
  Time Spent: ${i.time_spent_seconds || 0}s
  Action: ${i.interaction_type || "viewed"}
`,
  )
  .join("\n")}

FAMILY RATINGS (${familyRatings?.length || 0}):
${(familyRatings || [])
  .slice(0, 5)
  .map(
    (r: any) => `
- ${r.member_email}: ${r.rating}⭐ ${r.vote}
  Pros: ${r.pros?.join(", ") || "None"}
  Cons: ${r.cons?.join(", ") || "None"}
`,
  )
  .join("\n")}

STATED PREFERENCES:
- Must-Haves: ${preferences.must_have_features?.join(", ") || "None specified"}
- Deal Breakers: ${preferences.deal_breakers?.join(", ") || "None specified"}
- Neighborhoods: ${preferences.preferred_neighborhoods?.join(", ") || "None specified"}
- Price Range: $${preferences.min_price?.toLocaleString() || "?"} - $${preferences.max_price?.toLocaleString() || "?"}

PERSONA: ${persona.primary_persona || "General buyer"}

LEARN PATTERNS:
1. What do saved properties have in common? (lot type, features, architecture)
2. What features get consistently high ratings?
3. What makes family members vote "yes" vs "pass"?
4. What is the REAL budget? (actual behavior vs stated)
5. What features do they view but never mention?
6. Hidden priorities (corner lots, cul-de-sacs, specific schools, walking distance to amenities)

Generate PERFECT search criteria based on learned behavior:

{
  "learnedPreferences": {
    "actualBudgetRange": {
      "min": 400000,
      "max": 475000,
      "reasoning": "Consistently saves properties $10-15k above stated max"
    },
    "hiddenMustHaves": ["corner lot", "updated kitchen", "2-car garage", "hardwood floors"],
    "familyPriorities": {
      "spouse": ["quiet street", "good schools"],
      "kids": ["big backyard", "neighborhood playground"]
    },
    "avoidancePatterns": ["busy roads", "small yards (<0.2 acres)", "HOA fees >$200/month"],
    "preferredArchitecture": ["craftsman", "colonial"],
    "locationPatterns": ["near parks", "walkable to coffee shops"]
  },
  "optimalSearchCriteria": {
    "price_min": 400000,
    "price_max": 475000,
    "bedrooms_min": 3,
    "bathrooms_min": 2,
    "features": ["corner lot", "updated kitchen", "large yard", "2-car garage", "hardwood floors"],
    "neighborhoods": ["Riverside", "Oak Hills", "Maple Grove"],
    "exclude_features": ["busy street", "small lot"],
    "lot_size_min": 0.2
  },
  "whyThisWillWork": "Analysis shows they consistently favor corner lots (80% of saves) and large yards despite not stating these. Family votes yes when yard >0.25 acres and quiet street.",
  "expectedMatchRate": 0.92,
  "confidenceScore": 0.88
}`

  try {
    const analysis = await generateAIJSON(prompt)

    if (!analysis.data) {
      throw new Error("Failed to generate property matching analysis")
    }

    const aiMatch = analysis.data

    // Search IDX with AI-optimized criteria
    const searchQuery = {
      minPrice: aiMatch.optimalSearchCriteria?.price_min,
      maxPrice: aiMatch.optimalSearchCriteria?.price_max,
      bedrooms: aiMatch.optimalSearchCriteria?.bedrooms_min,
      bathrooms: aiMatch.optimalSearchCriteria?.bathrooms_min,
    }

    const properties = await idxClient.getProperties(searchQuery)

    // Score each property against learned preferences
    const scoredProperties = properties.map((prop: any) => {
      let matchScore = 50 // Base score
      const reasons: string[] = []

      // Check hidden must-haves
      aiMatch.learnedPreferences?.hiddenMustHaves?.forEach((feature: string) => {
        const featureText = JSON.stringify(prop).toLowerCase()
        if (featureText.includes(feature.toLowerCase())) {
          matchScore += 15
          reasons.push(`Has ${feature} (you love these!)`)
        }
      })

      // Check family priorities
      const spousePriorities = aiMatch.learnedPreferences?.familyPriorities?.spouse || []
      const kidsPriorities = aiMatch.learnedPreferences?.familyPriorities?.kids || []

      spousePriorities.forEach((pref: string) => {
        if (JSON.stringify(prop).toLowerCase().includes(pref.toLowerCase())) {
          matchScore += 10
          reasons.push(`Matches spouse priority: ${pref}`)
        }
      })

      kidsPriorities.forEach((pref: string) => {
        if (JSON.stringify(prop).toLowerCase().includes(pref.toLowerCase())) {
          matchScore += 10
          reasons.push(`Great for kids: ${pref}`)
        }
      })

      // Check price alignment with actual budget
      if (
        prop.listPrice >= aiMatch.learnedPreferences?.actualBudgetRange?.min &&
        prop.listPrice <= aiMatch.learnedPreferences?.actualBudgetRange?.max
      ) {
        matchScore += 10
        reasons.push("Within your actual budget sweet spot")
      }

      return {
        ...prop,
        aiMatchScore: Math.min(100, Math.max(0, matchScore)),
        aiReasons: reasons,
        whyPerfectForYou: reasons.join("; "),
      }
    })

    // Sort by AI match score
    const topMatches = scoredProperties.sort((a: any, b: any) => b.aiMatchScore - a.aiMatchScore).slice(0, 10)

    // Save the learned preferences for future use
    await supabase.from("ai_insights").insert({
      insight_type: "learned_preferences",
      entity_type: "lead",
      entity_id: leadId,
      insight_title: "AI Property Match Preferences Learned",
      insight_description: aiMatch.whyThisWillWork,
      actionable_steps: [`Show properties matching learned criteria`, `Focus on: ${aiMatch.learnedPreferences?.hiddenMustHaves?.join(", ")}`],
      priority: "medium",
      estimated_impact: {
        expectedMatchRate: aiMatch.expectedMatchRate,
        confidenceScore: aiMatch.confidenceScore,
      },
    })

    return {
      success: true,
      topMatches,
      learnedPreferences: aiMatch.learnedPreferences,
      whyThese: aiMatch.whyThisWillWork,
      confidenceScore: aiMatch.confidenceScore,
      message: `I found ${topMatches.length} properties that match your TRUE preferences (not just what you said, but what you actually love!)`,
    }
  } catch (error) {
    console.error("[v0] Error in aiPropertyMatchGenius:", error)
    throw new Error("AI property matching failed")
  }
}

// ============================================
// AI CMA GENERATOR (State-Compliant)
// ============================================

async function getStateAppraisalGuidelines(state: string) {
  const guidelines: Record<string, any> = {
    TX: {
      name: "Texas USPAP Guidelines",
      maxDaysSold: 90,
      maxDistanceMiles: 1,
      requirements: [
        "Must use sales within 90 days",
        "Must be within 1 mile radius",
        "Minimum 3 comparable sales required",
        "Document all adjustments",
        "Include market conditions statement",
      ],
    },
    CA: {
      name: "California USPAP Guidelines",
      maxDaysSold: 90,
      maxDistanceMiles: 1,
      requirements: [
        "Must use sales within 90 days",
        "Must be within 1 mile radius",
        "Minimum 3 comparable sales required",
        "Include seismic disclosure",
        "Document all adjustments",
      ],
    },
    FL: {
      name: "Florida USPAP Guidelines",
      maxDaysSold: 90,
      maxDistanceMiles: 1,
      requirements: [
        "Must use sales within 90 days",
        "Must be within 1 mile radius",
        "Minimum 3 comparable sales required",
        "Include flood zone disclosure",
        "Document all adjustments",
      ],
    },
  }

  return guidelines[state] || guidelines.TX
}

// DEPRECATED: use generateAICMA from ./ai-cma instead — this version saves to a non-existent table and is not used.
async function _legacyGenerateAICMA(data: {
  propertyAddress: string
  leadId: string
  purpose: "listing" | "buyer_offer" | "seller_consultation"
  state: string
}) {
  const supabase = await createClient()
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
  const { BatchDataClient } = await import("@/lib/batchdata-client")

  const idxClient = new IDXBrokerClient()
  const batchData = new BatchDataClient()

  // Get property details from BatchData
  const propertyDetails = await batchData.searchByAddress(data.propertyAddress, "", data.state)

  // Get comparables from IDX
  const comparables = await idxClient.getProperties({
    city: propertyDetails[0]?.city,
    status: "sold",
  })

  // Get state appraiser guidelines
  const stateGuidelines = await getStateAppraisalGuidelines(data.state)

  // AI CMA generation
  const prompt = `You are a licensed real estate appraiser AI. Generate a comprehensive CMA following ${data.state} appraiser guidelines:

Subject Property: ${data.propertyAddress}
${JSON.stringify(propertyDetails[0], null, 2)}

Comparable Sales (MUST use properties sold within ${stateGuidelines.maxDaysSold} days, within ${stateGuidelines.maxDistanceMiles} miles):
${comparables
  .slice(0, 10)
  .map(
    (comp: any) => `
Address: ${comp.address}
Sold: $${comp.soldPrice?.toLocaleString()} on ${comp.soldDate}
List: $${comp.listPrice?.toLocaleString()}
Beds/Baths: ${comp.bedrooms}/${comp.bathrooms}
Sqft: ${comp.sqft}
DOM: ${comp.daysOnMarket}
`,
  )
  .join("\n")}

State Guidelines (${data.state}):
- ${stateGuidelines.requirements.join("\n- ")}

Generate CMA with:
1. Property valuation using sales comparison approach
2. Adjustments for differences (documented)
3. Market conditions analysis
4. Days on market estimate
5. Pricing recommendation
6. Required state disclaimers

CRITICAL: Include disclaimer that this is a CMA (Comparative Market Analysis), NOT an appraisal. Only licensed appraisers can provide official appraisals.

Response JSON structure:
{
  "subjectProperty": {
    "address": "${data.propertyAddress}",
    "details": {}
  },
  "comparableAnalysis": [
    {
      "address": "...",
      "soldPrice": 450000,
      "adjustments": {
        "sqft_difference": "+5000 (250 sqft larger)",
        "condition": "-8000 (needs updates)",
        "lot_size": "+3000 (larger lot)",
        "total_adjustment": "+0"
      },
      "adjusted_value": 450000,
      "weight": 0.30
    }
  ],
  "valuationConclusion": {
    "estimatedValue": 465000,
    "valuationRange": {
      "low": 455000,
      "high": 475000
    },
    "confidence": "high",
    "methodology": "Sales Comparison Approach per ${data.state} USPAP guidelines"
  },
  "marketAnalysis": {
    "absorption_rate": "2.8 months inventory",
    "market_trend": "balanced",
    "days_on_market_average": 32,
    "sold_to_list_ratio": 98.2
  },
  "pricingRecommendation": {
    "suggested_list_price": 469900,
    "reasoning": "Price just below estimated value to attract multiple offers while maximizing return",
    "predicted_sale_price": 467500,
    "predicted_days_to_sell": 28
  },
  "requiredDisclosures": [
    "This is a Comparative Market Analysis (CMA) prepared by a licensed real estate agent, not an appraisal.",
    "Only a licensed appraiser can provide an official property appraisal.",
    "All data deemed reliable but not guaranteed.",
    "Market conditions subject to change."
  ],
  "stateCompliance": {
    "state": "${data.state}",
    "guidelines_followed": "${stateGuidelines.name}",
    "appraiser_review_required": false
  }
}`

  try {
    const cmaData = await generateAIJSON(prompt)

    if (!cmaData.data) {
      throw new Error("Failed to generate CMA")
    }

    const cma = cmaData.data

    // Save CMA to database
    const { data: savedCMA, error: saveError } = await supabase
      .from("ai_generated_cmas")
      .insert({
        lead_id: data.leadId,
        property_address: data.propertyAddress,
        generated_for: data.purpose,
        estimated_value: cma.valuationConclusion?.estimatedValue,
        value_range_low: cma.valuationConclusion?.valuationRange?.low,
        value_range_high: cma.valuationConclusion?.valuationRange?.high,
        confidence_level: cma.valuationConclusion?.confidence,
        comparable_properties: cma.comparableAnalysis,
        market_trends: cma.marketAnalysis,
        optimal_list_price: cma.pricingRecommendation?.suggested_list_price,
        days_on_market_estimate: cma.pricingRecommendation?.predicted_days_to_sell,
        state: data.state,
        appraiser_guidelines_used: stateGuidelines.name,
        compliance_disclaimers: cma.requiredDisclosures,
      })
      .select()
      .maybeSingle()

    if (saveError) {
      console.error("[v0] Error saving CMA:", saveError)
    }

    return {
      success: true,
      cma,
      cmaId: savedCMA?.id,
      message: "State-compliant CMA generated! Ready to share with client.",
    }
  } catch (error) {
    console.error("[v0] Error in generateAICMA:", error)
    throw new Error("CMA generation failed")
  }
}

// Mass generate CMAs for all property owners
export async function massGenerateCMAs(agentId: string) {
  const supabase = await createClient()

  // Get agent's brokerage for commission structure
  const { data: agent } = await supabase
    .from("agents")
    .select("*, profiles!inner(brokerage_id)")
    .eq("id", agentId)
    .single()

  const brokerageId = agent?.profiles?.brokerage_id
  if (!brokerageId) {
    throw new Error("Agent brokerage not found")
  }

  const commissionStructure = await getDefaultCommissionStructure(brokerageId)

  // Get all leads with property ownership in agent's service areas
  const { data: leads, error } = await supabase
    .from("leads")
    .select(
      `
      *,
      lead_property_ownership(*)
    `,
    )
    .eq("agent_id", agentId)
    .not("lead_property_ownership", "is", null)

  if (error || !leads) {
    console.error("[v0] Error fetching leads with property ownership:", error)
    return {
      totalCMAsGenerated: 0,
      significantOpportunities: 0,
      results: [],
      message: "No property owners found",
    }
  }

  const cmaResults = []

  for (const lead of leads) {
    const propertyOwnership = lead.lead_property_ownership || []

    for (const property of propertyOwnership) {
      try {
        // Use the canonical generateAICMA from ai-cma.ts which saves to cma_reports
        const { generateAICMA: generateRealCMA } = await import("./ai-cma")

        const cma = await generateRealCMA({
          agentId,
          contactId: lead.id,
          propertyAddress: property.property_address,
          propertyCity: lead.city || "",
          propertyState: lead.state || "TX",
          propertyZip: lead.zip || "",
          propertyType: "single_family",
          bedrooms: property.bedrooms ?? 0,
          bathrooms: property.bathrooms ?? 0,
          squareFeet: property.sqft ?? 0,
          listingType: "seller",
        })

        const estimatedValue = cma.success ? cma.pricingStrategy?.recommendedListPrice ?? 0 : 0
        const equityGain = estimatedValue - (property.estimated_value || 0)

        cmaResults.push({
          leadId: lead.id,
          leadName: `${lead.first_name} ${lead.last_name}`,
          propertyAddress: property.property_address,
          currentValue: property.estimated_value,
          newCMAValue: estimatedValue,
          equityGain,
          cmaId: cma.success ? cma.id : null,
        })
      } catch (error) {
        console.error(`[v0] Failed to generate CMA for ${property.property_address}:`, error)
      }
    }
  }

  // Create insights for significant equity gains (>$50k)
  const significantGains = cmaResults.filter((r) => r.equityGain > 50000)

  for (const gain of significantGains) {
    await supabase.from("ai_insights").insert({
      insight_type: "opportunity",
      entity_type: "lead",
      entity_id: gain.leadId,
      insight_title: "Significant Equity Growth Detected",
      insight_description: `${gain.leadName}'s home at ${gain.propertyAddress} has gained $${gain.equityGain.toLocaleString()} in equity. This could be a selling opportunity.`,
      actionable_steps: [
        "Send personalized market update showing their equity growth",
        "Schedule consultation to discuss upgrade options",
        "Generate full CMA presentation",
      ],
      priority: "high",
      estimated_impact: {
        potential_listing: true,
        estimated_commission: gain.equityGain * commissionStructure.agentListingSideRate,
      },
    })
  }

  return {
    totalCMAsGenerated: cmaResults.length,
    significantOpportunities: significantGains.length,
    results: cmaResults,
    message: `Generated ${cmaResults.length} CMAs. Found ${significantGains.length} high-equity opportunities!`,
  }
}

// ============================================
// WINNING OFFER PREDICTION
// ============================================

export async function predictWinningOffer(data: {
  propertyMlsId: string
  listPrice: number
  leadId: string
}) {
  const supabase = await createClient()
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
  const idxClient = new IDXBrokerClient()

  // Get property intelligence
  const property = await (idxClient.getProperties as any)({ ids: [data.propertyMlsId] }).then((r: any) => r?.[0])

  const { data: insights } = await supabase
    .from("property_smart_insights")
    .select("*")
    .eq("property_mls_id", data.propertyMlsId)
    .maybeSingle()

  const prompt = `You are an AI real estate strategist. Predict the winning offer amount:

Property: ${property?.address || "Unknown"}
List Price: $${data.listPrice.toLocaleString()}
Days on Market: ${insights?.days_on_market || 0}
Price Reductions: ${insights?.price_reduction_count || 0}
Market Position: ${insights?.market_position || "unknown"}

Competition Indicators:
- Property Views (last 7 days): ${property?.viewCount || 0}
- Showing Requests: ${property?.showingCount || 0}
- Other Offers: ${property?.offerCount || 0}

Seller Signals:
- Motivated? ${insights?.days_on_market > 60 ? "YES (60+ DOM)" : "Unknown"}
- Price Reduction Frequency: ${insights?.price_reduction_count || 0}

Predict the winning offer strategy:

{
  "winningOfferStrategy": {
    "minimumConsideredOffer": 440000,
    "likelyWinningOffer": 455000,
    "maximumNeeded": 465000,
    "confidence": 0.83,
    "reasoning": "Property overpriced initially, now 45 DOM with 2 reductions. Seller motivated. Competition appears low."
  },
  "offerStructure": {
    "initialOffer": 445000,
    "escalationClause": {
      "include": true,
      "maxEscalation": 460000,
      "increment": 1000
    },
    "earnestMoney": 10000,
    "contingencies": {
      "inspection": "include",
      "financing": "include",
      "appraisal": "include"
    }
  },
  "strengthFactors": [
    "Pre-approved buyer",
    "Quick close possible",
    "Flexible on possession"
  ],
  "negotiationScript": {
    "opening": "My buyers are pre-approved and ready to close quickly...",
    "justification": "Based on recent sales, we believe this is fair market value"
  },
  "counterofferStrategy": {
    "if_465k": "Counter at $455k - meet in middle",
    "if_455k": "Accept - excellent outcome",
    "if_475k": "Hold at $450k or walk"
  },
  "winProbability": 0.78
}`

  try {
    const offerStrategy = await generateAIJSON(prompt)

    if (!offerStrategy.data) {
      throw new Error("Offer analysis failed")
    }

    // Save prediction
    await supabase.from("ai_predictions").insert({
      prediction_type: "winning_offer",
      entity_type: "property",
      entity_id: data.propertyMlsId,
      prediction_value: offerStrategy.data,
      confidence_score: offerStrategy.data.winningOfferStrategy?.confidence || 0.5,
      model_version: "v1.0",
    })

    return {
      success: true,
      strategy: offerStrategy.data,
    }
  } catch (error) {
    console.error("[v0] Error in predictWinningOffer:", error)
    throw new Error("Offer analysis failed")
  }
}

// ============================================
// AI NEGOTIATION ADVISOR
// ============================================

export async function aiNegotiationAdvisor(data: {
  transactionId: string
  scenario: "initial_offer" | "counteroffer" | "inspection_repairs" | "appraisal_gap" | "final_negotiations"
  currentOffer?: number
  listPrice?: number
  inspectionIssues?: any[]
}) {
  const supabase = await createClient()

  const { data: transaction } = await supabase
    .from("transactions")
    .select(
      `
      *,
      contacts(*),
      transaction_lenders(*),
      transaction_inspections(*)
    `,
    )
    .eq("id", data.transactionId)
    .maybeSingle()

  if (!transaction) {
    throw new Error("Transaction not found")
  }

  const prompt = `You are a master real estate negotiator AI. Provide winning negotiation strategy:

Scenario: ${data.scenario}
Property: ${transaction.property_address || "Unknown"}
List Price: $${data.listPrice?.toLocaleString() || transaction.contract_price?.toLocaleString()}
${data.currentOffer ? `Current Offer: $${data.currentOffer.toLocaleString()}` : ""}

Financing: ${transaction.transaction_lenders?.[0]?.loan_type || "Unknown"}
${data.inspectionIssues ? `Inspection Issues: ${JSON.stringify(data.inspectionIssues)}` : ""}

Provide strategic negotiation advice:

{
  "recommendedOffer": {
    "amount": 445000,
    "reasoning": "Property overpriced by 3%, been on market 45 days, seller shows motivation.",
    "negotiatingRoom": 10000,
    "walkAwayPrice": 455000
  },
  "negotiationTactics": [
    {
      "tactic": "Create urgency",
      "script": "They're viewing 2 other properties this weekend - need response by Monday"
    }
  ],
  "counterofferStrategy": {
    "if_they_counter_at": {
      "465000": "Accept immediately - great deal",
      "475000": "Counter at $460k, cite comparables",
      "485000": "Hold firm or walk - overpriced"
    }
  },
  "winProbability": 0.82,
  "recommendedApproach": "Start reasonable, emphasize buyer strengths, be prepared to walk if unrealistic"
}`

  try {
    const strategy = await generateAIJSON(prompt)

    if (!strategy.data) {
      throw new Error("Negotiation analysis failed")
    }

    // Save negotiation strategy
    await supabase.from("ai_insights").insert({
      insight_type: "recommendation",
      entity_type: "transaction",
      entity_id: data.transactionId,
      insight_title: `Negotiation Strategy: ${data.scenario}`,
      insight_description: strategy.data.recommendedApproach,
      actionable_steps: strategy.data.negotiationTactics?.map((t: any) => t.script) || [],
      priority: "high",
      estimated_impact: {
        win_probability: strategy.data.winProbability,
        potential_savings: (data.listPrice || 0) - (strategy.data.recommendedOffer?.amount || 0),
      },
    })

    return {
      success: true,
      strategy: strategy.data,
    }
  } catch (error) {
    console.error("[v0] Error in aiNegotiationAdvisor:", error)
    throw new Error("Negotiation analysis failed")
  }
}

// ============================================
// MARKET SHIFT PREDICTION
// ============================================

export async function predictMarketShift(data: { city: string; state: string }) {
  const supabase = await createClient()
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
  const idxClient = new IDXBrokerClient()

  // Get current inventory
  const currentListings = await idxClient.getProperties({ city: data.city, status: "active" })

  const prompt = `You are a real estate market economist AI. Predict market shifts:

Market: ${data.city}, ${data.state}

Current Snapshot:
- Active Listings: ${currentListings?.length || 0}
- Average DOM: ${currentListings?.reduce((sum: number, p: any) => sum + (p.daysOnMarket || 0), 0) / (currentListings?.length || 1)}

Predict for next 90 days:

{
  "prediction": {
    "direction": "shifting_to_buyer",
    "confidence": 0.78,
    "timeframe": "30-60 days",
    "magnitude": "moderate"
  },
  "factors": [
    {"factor": "Inventory increasing 15% month-over-month", "impact": "negative_for_sellers"}
  ],
  "predictions": {
    "medianPrice60Days": 458000,
    "priceChange": "-1.5%",
    "daysOnMarket60Days": 42,
    "marketType": "balanced_to_buyer"
  },
  "actionableIntelligence": {
    "forSellers": ["List NOW before shift becomes obvious"],
    "forBuyers": ["Wait 30 days for better negotiating position"],
    "forAgents": ["Advise seller clients to list immediately"]
  }
}`

  try {
    const prediction = await generateAIJSON(prompt)

    if (!prediction.data) {
      throw new Error("Market prediction failed")
    }

    // Save prediction
    await supabase.from("predictive_market_alerts").insert({
      alert_type: "market_shift_prediction",
      market_area: data.city,
      prediction: prediction.data.prediction,
      confidence: prediction.data.prediction?.confidence || 0.5,
      predicted_timeframe: prediction.data.prediction?.timeframe,
      opportunity_type: prediction.data.prediction?.direction,
      recommended_actions: prediction.data.actionableIntelligence,
    })

    // Create insights for affected leads
    const { data: leads } = await supabase
      .from("contacts")
      .select("id")
      .eq("city", data.city)
      .limit(50)

    if (prediction.data.prediction?.direction?.includes("buyer") && leads) {
      for (const lead of leads) {
        await supabase.from("ai_insights").insert({
          insight_type: "opportunity",
          entity_type: "lead",
          entity_id: lead.id,
          insight_title: "Market Shift Detected - Act Now",
          insight_description: `AI predicts ${data.city} market shifting in ${prediction.data.prediction?.timeframe}.`,
          actionable_steps: prediction.data.actionableIntelligence?.forSellers || [],
          priority: "high",
          estimated_impact: { timing_advantage: "Critical" },
        })
      }
    }

    return {
      success: true,
      prediction: prediction.data,
    }
  } catch (error) {
    console.error("[v0] Error in predictMarketShift:", error)
    throw new Error("Market prediction failed")
  }
}

// ============================================
// MARKET ARBITRAGE FINDER
// ============================================

export async function findMarketArbitrage(data: { city: string; state: string; agentId: string }) {
  const supabase = await createClient()
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
  const { BatchDataClient } = await import("@/lib/batchdata-client")

  const idxClient = new IDXBrokerClient()
  const batchData = new BatchDataClient()

  // Get all active listings
  const activeListings = await idxClient.getProperties({
    city: data.city,
    status: "active",
  })

  // Get recent sales for comparison
  const recentSales = await idxClient.getProperties({
    city: data.city,
    status: "sold",
  })

  const prompt = `You are an AI investment analyzer. Find underpriced properties:

Active Listings: ${activeListings?.length || 0}
Recent Sales: ${recentSales?.length || 0}

Analyze active listings:
${activeListings
  ?.slice(0, 20)
  .map(
    (listing: any) => `
${listing.address}: $${listing.listPrice?.toLocaleString()}
${listing.bedrooms}bd/${listing.bathrooms}ba, ${listing.sqft} sqft
DOM: ${listing.daysOnMarket}
Price/sqft: $${Math.round((listing.listPrice || 0) / (listing.sqft || 1))}
`,
  )
  .join("\n")}

Compare to recent sales:
${recentSales
  ?.slice(0, 10)
  .map(
    (sale: any) => `
${sale.address}: SOLD $${sale.soldPrice?.toLocaleString()}
${sale.bedrooms}bd/${sale.bathrooms}ba, ${sale.sqft} sqft
Price/sqft: $${Math.round((sale.soldPrice || 0) / (sale.sqft || 1))}
`,
  )
  .join("\n")}

Find TOP 10 arbitrage opportunities:
- Priced 10%+ below comparable sales
- In appreciating neighborhoods
- Show seller motivation (high DOM, price reductions)
- Hidden value potential (needs cosmetics only)

{
  "opportunities": [
    {
      "mlsId": "...",
      "address": "123 Oak St",
      "listPrice": 385000,
      "estimatedValue": 425000,
      "belowMarket": 40000,
      "belowMarketPercent": 9.4,
      "reasoning": [
        "Recent comps sold $420-430k",
        "Listed 60 days - seller motivated",
        "Needs cosmetic updates only ($15k)",
        "Neighborhood appreciating 8%/year"
      ],
      "investmentPotential": {
        "buyAt": 385000,
        "investIn": 15000,
        "sellAt": 440000,
        "profit": 40000,
        "roi": 10.4,
        "timeline": "6 months"
      },
      "buyerTypes": ["investor", "handy_buyer", "first_time_with_vision"],
      "urgency": "high",
      "competitionLevel": "low",
      "actionRequired": "Make offer this week before market catches on"
    }
  ],
  "marketInsights": {
    "total_mispriced": 15,
    "avg_opportunity": 8.2,
    "best_neighborhoods": ["Oak Hills - 3 opportunities", "Riverside - 2 opportunities"]
  }
}`

  try {
    const arbitrageData = await generateAIJSON(prompt)

    if (!arbitrageData.data) {
      throw new Error("Arbitrage analysis failed")
    }

    const arbitrage = arbitrageData.data

    // Save opportunities to database
    for (const opp of arbitrage.opportunities || []) {
      await supabase.from("ai_insights").insert({
        insight_type: "opportunity",
        entity_type: "property",
        entity_id: opp.mlsId,
        insight_title: `Hidden Gem: ${opp.belowMarketPercent}% Below Market`,
        insight_description: `${opp.address} - $${opp.belowMarket?.toLocaleString()} below market value`,
        insight_data: opp,
        actionable_steps: [opp.actionRequired],
        priority: opp.urgency === "high" ? "critical" : "high",
        estimated_impact: {
          potential_profit: opp.investmentPotential?.profit,
          roi: opp.investmentPotential?.roi,
        },
      })
    }

    // Find and alert investor clients
    const { data: investors } = await supabase
      .from("contacts")
      .select("id, email, first_name, last_name")
      .eq("agent_id", data.agentId)
      .eq("city", data.city)
      .contains("tags", ["investor"])
      .limit(50)

    // Create alerts for investor clients
    if (investors && investors.length > 0) {
      for (const investor of investors) {
        await supabase.from("ai_insights").insert({
          insight_type: "opportunity",
          entity_type: "lead",
          entity_id: investor.id,
          insight_title: `${arbitrage.opportunities?.length || 0} Investment Opportunities in ${data.city}`,
          insight_description: `Found ${arbitrage.opportunities?.length || 0} underpriced properties perfect for investors`,
          actionable_steps: [
            "Send personalized investment report",
            "Schedule property tour for top 3 opportunities",
            "Prepare ROI analysis for each property",
          ],
          priority: "high",
          estimated_impact: {
            avg_profit_per_deal: arbitrage.marketInsights?.avg_opportunity || 0,
            total_opportunities: arbitrage.opportunities?.length || 0,
          },
        })
      }
    }

    return {
      success: true,
      opportunities: arbitrage.opportunities || [],
      marketInsights: arbitrage.marketInsights,
      investorClientsAlerted: investors?.length || 0,
      message: `Found ${arbitrage.opportunities?.length || 0} hidden gems! Alerted ${investors?.length || 0} investor clients.`,
    }
  } catch (error) {
    console.error("[v0] Error in findMarketArbitrage:", error)
    throw new Error("Market arbitrage detection failed")
  }
}

// ============================================
// CLIENT CHURN DETECTION
// ============================================

export async function detectClientChurn(leadId: string) {
  const supabase = await createClient()

  // Fetch lead without embedded joins — lead_behavioral_data, chat_sessions,
  // communications, and showings are not FK-registered on leads/contacts in PostgREST.
  const { data: lead, error } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle()

  let resolvedLead: Record<string, any> | null = lead ?? null
  if (error || !lead) {
    // Try contacts table as fallback
    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", leadId)
      .maybeSingle()

    if (!contact) {
      throw new Error("Lead not found")
    }
    resolvedLead = contact
  }

  if (!resolvedLead) throw new Error("Lead not found")

  const daysInPipeline = Math.floor((Date.now() - new Date(resolvedLead.created_at).getTime()) / (1000 * 60 * 60 * 24))
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000

  const recentCommunications = (resolvedLead.communications || []).filter(
    (c: any) => new Date(c.created_at).getTime() > thirtyDaysAgo,
  )
  const recentBehavior = (resolvedLead.lead_behavioral_data || []).filter(
    (b: any) => new Date(b.occurred_at).getTime() > thirtyDaysAgo && b.event_type === "property_view",
  )

  const prompt = `You are an AI churn detection expert. Analyze client engagement:

Lead: ${resolvedLead.first_name} ${resolvedLead.last_name}
Days in Pipeline: ${daysInPipeline}

Recent Activity (30 days):
- Communications: ${recentCommunications.length}
- Property Views: ${recentBehavior.length}
- Last Contact: ${resolvedLead.last_contact_date || "Never"}
- Showings: ${resolvedLead.showings?.length || 0}

Detect churn risk and provide save strategy:

{
  "churnRisk": "high",
  "churnProbability": 0.72,
  "timeToChurn": "7-14 days",
  "warningSignals": [
    {"signal": "Email engagement dropped 60%", "severity": "high"},
    {"signal": "No property views in 18 days", "severity": "high"}
  ],
  "likelyReasons": [
    "Working with another agent",
    "Timeline changed",
    "Budget concerns"
  ],
  "saveStrategy": {
    "immediate": [
      "Personal phone call (don't text/email)",
      "Acknowledge their silence: 'I noticed you've been quiet - everything okay?'",
      "Reset expectations: 'No pressure, just want to make sure you have what you need'"
    ],
    "themFirstApproach": "It seems like we might not be finding what you're looking for. Your happiness is what matters - let's recalibrate together.",
    "doNot": ["Don't be pushy", "Don't guilt trip"]
  },
  "saveProbability": 0.45
}`

  try {
    const churnAnalysis = await generateAIJSON(prompt)

    if (!churnAnalysis.data) {
      throw new Error("Churn analysis failed")
    }

    const result = churnAnalysis.data

    if (result.churnRisk === "high") {
      await supabase.from("ai_insights").insert({
        insight_type: "risk",
        entity_type: "lead",
        entity_id: leadId,
        insight_title: "CLIENT CHURN RISK - Act Now",
        insight_description: `${resolvedLead?.first_name ?? "Client"} showing signs of disengagement. ${result.timeToChurn} to potential churn.`,
        actionable_steps: result.saveStrategy?.immediate || [],
        priority: "critical",
        estimated_impact: {
          save_probability: result.saveProbability,
        },
      })
    }

    return {
      success: true,
      analysis: result,
    }
  } catch (error) {
    console.error("[v0] Error in detectClientChurn:", error)
    throw new Error("Churn detection failed")
  }
}

// ============================================
// SHOWING ROUTE OPTIMIZER
// ============================================

export async function optimizeShowingRoute(data: {
  leadId: string
  propertyIds: string[]
  preferredDate: string
  startLocation: string
}) {
  const supabase = await createClient()
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
  const idxClient = new IDXBrokerClient()

  const properties = (await Promise.all(data.propertyIds.map((id) => idxClient.searchProperties(id)))).flat()

  const prompt = `You are an AI showing coordinator. Optimize this showing route:

Start Location: ${data.startLocation}
Date: ${data.preferredDate}
Properties to Show (${properties.length}):
${properties
  .map(
    (p: any, i: number) => `
${i + 1}. ${p.address}
   Price: $${p.listPrice?.toLocaleString()}
   Type: ${p.propertyType}
`,
  )
  .join("\n")}

Optimize for:
1. Minimize drive time
2. Group by neighborhood
3. Save "best" for last
4. Allow 30 min per property
5. Account for traffic

{
  "optimizedRoute": {
    "totalDriveTime": 45,
    "totalShowingTime": 150,
    "suggestedStartTime": "10:00 AM",
    "properties": [
      {
        "order": 1,
        "address": "...",
        "arrivalTime": "10:00 AM",
        "durationMinutes": 30,
        "why_first": "Warm up property",
        "talking_points": ["Good schools", "Move-in ready"]
      }
    ],
    "themFirstApproach": "I've organized these to help you see the progression. We're saving the best for last!",
    "postShowingPlan": {
      "immediate": "Get feedback while in car",
      "same_day": "Send summary email",
      "next_day": "Follow up to discuss favorites"
    }
  }
}`

  try {
    const optimizedRoute = await generateAIJSON(prompt)

    if (!optimizedRoute.data) {
      throw new Error("Route optimization failed")
    }

    await supabase.from("smart_showing_recommendations").insert({
      lead_id: data.leadId,
      recommended_properties: optimizedRoute.data.optimizedRoute?.properties,
      showing_route: optimizedRoute.data.optimizedRoute,
      total_drive_time: optimizedRoute.data.optimizedRoute?.totalDriveTime,
      suggested_order: optimizedRoute.data.optimizedRoute?.properties?.map((p: any) => p.address),
      recommended_day: data.preferredDate,
      why_these_properties: "AI-optimized for maximum impact",
    })

    return {
      success: true,
      route: optimizedRoute.data.optimizedRoute,
    }
  } catch (error) {
    console.error("[v0] Error in optimizeShowingRoute:", error)
    throw new Error("Route optimization failed")
  }
}

// ============================================
// HIDDEN OPPORTUNITIES FINDER
// ============================================

export async function findHiddenOpportunities(agentId: string) {
  const supabase = await createClient()

  const { data: agent } = await supabase
    .from("agents")
    .select(
      `
      *,
      leads(*),
      transactions(*)
    `,
    )
    .eq("id", agentId)
    .maybeSingle()

  if (!agent) {
    throw new Error("Agent not found")
  }

  const serviceAreas = agent.service_areas || []

  const prompt = `You are an AI opportunity finder. Scan database for hidden opportunities:

Agent Service Areas: ${serviceAreas.join(", ")}
Contacts in Database: ${agent.leads?.length || 0}

Find opportunities:
1. Past clients ready to move again (5-7 years, equity built)
2. Sphere of influence (neighbors of recent sales)
3. Motivated sellers (life events, financial signals)
4. Rental to ownership (renters ready to buy)
5. Empty nesters (seniors downsizing)

{
  "opportunities": [
    {
      "type": "past_client_ready",
      "leadId": "...",
      "leadName": "John Smith",
      "reason": "Bought 6 years ago, home value up 35%, kids growing",
      "confidence": 0.88,
      "estimatedDealSize": 550000,
      "urgency": "medium",
      "recommendedAction": "Send market update showing equity growth",
      "themFirstApproach": "Your home's value has grown significantly. You have options worth exploring."
    }
  ],
  "totalOpportunities": 15,
  "estimatedPipelineValue": 4500000
}`

  try {
    const opportunities = await generateAIJSON(prompt)

    if (!opportunities.data) {
      throw new Error("Opportunity detection failed")
    }

    for (const opp of opportunities.data.opportunities?.slice(0, 20) || []) {
      await supabase.from("ai_insights").insert({
        insight_type: "opportunity",
        entity_type: "lead",
        entity_id: opp.leadId,
        insight_title: opp.type.replace(/_/g, " ").toUpperCase(),
        insight_description: opp.reason,
        actionable_steps: [opp.recommendedAction],
        priority: opp.urgency === "high" ? "critical" : "medium",
        estimated_impact: {
          estimated_deal_size: opp.estimatedDealSize,
          confidence: opp.confidence,
        },
      })
    }

    return {
      success: true,
      opportunities: opportunities.data.opportunities || [],
      totalOpportunities: opportunities.data.totalOpportunities || 0,
      estimatedPipelineValue: opportunities.data.estimatedPipelineValue || 0,
    }
  } catch (error) {
    console.error("[v0] Error in findHiddenOpportunities:", error)
    throw new Error("Opportunity detection failed")
  }
}

// ============================================
// SPHERE OF INFLUENCE MINER
// ============================================

export async function mineSphereOfInfluence(agentId: string) {
  const supabase = await createClient()

  const { data: pastClients } = await supabase
    .from("leads")
    .select(
      `
      *,
      transactions(*),
      lead_property_ownership(*),
      lead_people_data(*)
    `,
    )
    .eq("agent_id", agentId)
    .eq("lead_status", "closed_client")

  const prompt = `You are an AI sphere of influence miner. Find referral opportunities:

Past Clients: ${pastClients?.length || 0}

Analyze for:
1. Neighbors (same street referrals)
2. Life events (marriage, baby = moving triggers)
3. Equity position (ready to move up?)
4. Anniversary dates (time to check in)
Output example:{
  "referralOpportunities": [
    {
      "source_client": "John Smith",
      "opportunity_type": "neighbor_referral",
      "reason": "Has 3 neighbors on same street",
      "approach": "Ask John for warm introduction",
      "estimated_probability": 0.35
    },
    {
      "source_client": "Sarah Johnson",
      "opportunity_type": "repeat_client",
      "reason": "Equity up $95k, life event (new baby), likely upsizing",
      "approach": "Send: 'Your equity could help you move to bigger space'",
      "estimated_deal_size": 550000,
      "urgency": "high",
      "probability": 0.62
    }
  ],
  "totalOpportunities": 25,
  "estimatedPipelineValue": 8500000,
  "immediateActions": [
    "Contact Sarah Johnson about upsizing",
    "Ask John Smith for neighbor referrals"
  ]
}`

  try {
    const sphereMining = await generateAIJSON(prompt)

    if (!sphereMining.data) {
      throw new Error("Sphere mining failed")
    }

    for (const opp of sphereMining.data.referralOpportunities || []) {
      if ((opp.probability || 0) > 0.4) {
        await supabase.from("ai_insights").insert({
          insight_type: "opportunity",
          entity_type: "lead",
          entity_id: opp.source_client_id,
          insight_title: opp.opportunity_type.replace("_", " ").toUpperCase(),
          insight_description: opp.reason,
          actionable_steps: [opp.approach],
          priority: opp.urgency === "high" ? "critical" : "medium",
          estimated_impact: {
            estimated_deal_size: opp.estimated_deal_size,
            probability: opp.probability,
          },
        })
      }
    }

    return {
      success: true,
      opportunities: sphereMining.data.referralOpportunities || [],
      totalOpportunities: sphereMining.data.totalOpportunities || 0,
      estimatedPipelineValue: sphereMining.data.estimatedPipelineValue || 0,
    }
  } catch (error) {
    console.error("[v0] Error in mineSphereOfInfluence:", error)
    throw new Error("Sphere mining failed")
  }
}

// ============================================
// COMPETITIVE INTELLIGENCE
// ============================================

export async function competitiveIntelligence(data: { agentId: string; marketArea: string }) {
  const supabase = await createClient()
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
  const idxClient = new IDXBrokerClient()

  const listings = await idxClient.getProperties({
    city: data.marketArea,
    status: "active",
  })

  const prompt = `Analyze competitive landscape:

Market: ${data.marketArea}
Active Listings: ${listings?.length || 0}

Find:
1. Most active competitor agents
2. Overpriced listings (steal buyers)
3. Underpriced listings (steal for investors)
4. Market share by agent
5. Competitor strategies
Output Example:
{
  "competitorRankings": [
    {
      "agent": "Jane Smith",
      "activeListings": 8,
      "marketShare": 12.5,
      "avgDaysOnMarket": 28,
      "pricingStrategy": "aggressive",
      "threat_level": "high"
    }
  ],
  "opportunities": {
    "overpriced_listings": [
      {"address": "...", "overpriced_by": 25000, "strategy": "Show comparable sales"}
    ],
    "steal_deals": [
      {"address": "...", "underpriced_by": 15000, "perfect_for": "Investor clients"}
    ]
  },
  "marketGaps": [
    "No agents specializing in military buyers",
    "Luxury market underserved"
  ],
  "recommendations": [
    "Target military buyer niche",
    "Undercut competitor pricing by 2%"
  ]
}`

  try {
    const intel = await generateAIJSON(prompt)

    if (!intel.data) {
      throw new Error("Competitive analysis failed")
    }

    return {
      success: true,
      intel: intel.data,
    }
  } catch (error) {
    console.error("[v0] Error in competitiveIntelligence:", error)
    throw new Error("Competitive intelligence failed")
  }
}
