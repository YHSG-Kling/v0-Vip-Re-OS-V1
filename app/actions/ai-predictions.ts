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

// ─────────────────────────────────────────────────────────────────────────────
// DELIBERATELY NOT WIRED — READ THIS BEFORE GIVING IT A CALLER.
//
// (1) IT WOULD BE THE THIRD LEAD SCORER. Two already exist and one is canonical:
//       lib/services/lead-management.service.ts:calculateLeadScore  — writes
//         contacts.lead_score + lead_scores + lead_engagement_scores; every other
//         scoring path in the repo has already been re-pointed at it (see the
//         keep-one notes in app/actions/ai-auto-response.ts and
//         app/actions/ai-lead-nurturing.ts:133).
//       app/actions/ai-lead-scoring.ts:scoreLeadWithAI — the agent-triggered
//         override, WIRED at app/crm/page.tsx:1201.
//     This one is a third independent model of the same subject with its own
//     storage. It is not a second writer of contacts.lead_score — it writes
//     predictive_lead_scores, a different table — but standing it up as a rival
//     verdict on "will this lead convert" is the collision the owner named.
//
// (2) THE WRITE HAS NEVER SUCCEEDED, ONCE, EVER. predictive_lead_scores.brokerage_id
//     is NOT NULL and the row was inserted without it, inside a try/catch that only
//     logs — and supabase-js RESOLVES a refused write, so even the catch never fired.
//     predictive_lead_scores holds 0 rows on the live database. Every reader hanging
//     off it (getPredictiveLeadScore, getTopConversionCandidates,
//     refreshStalePredictions, and the prompt at line ~515) has therefore always
//     returned nothing while looking like a working query. brokerage_id is now
//     supplied and the refusal is surfaced.
//
// (3) RLS EXCLUDES THE AGENT ANYWAY. predictive_lead_scores_insert and _select both
//     require is_lead_visible_role(), which is broker / broker_owner / admin /
//     superadmin only. Under the anon key an AGENT can neither write nor read this
//     table, so a wiring onto any agent-facing surface would be refused at the
//     database even with the columns correct.
//
// (4) IDENTITY CLASS. predictive_lead_scores.lead_id FKs leads(id), but this
//     function's own fallback resolves the id against `contacts` when it misses in
//     `leads` — so a contacts.id reached a leads FK. That is now refused explicitly
//     rather than being written and rejected silently.
//
// Its defects are fixed so the next pass inherits a correct function, not a trap.
// ─────────────────────────────────────────────────────────────────────────────
export async function predictLeadConversion(leadId: string): Promise<LeadPrediction | { error: string }> {
  const supabase = await createClient()

  // Tenant anchor for the two prediction writes below. Both tables carry
  // brokerage_id and both RLS policies test it.
  const { data: { user: predictionCaller } } = await supabase.auth.getUser()
  if (!predictionCaller) return { error: "Unauthorized" }
  const { data: callerRow, error: callerError } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", predictionCaller.id)
    .maybeSingle()
  if (callerError) return { error: `Caller lookup failed: ${callerError.message}` }
  const callerBrokerageId = callerRow?.brokerage_id as string | undefined
  if (!callerBrokerageId) return { error: "Unauthorized" }

  // Try to gather lead data - handle tables that may not exist
  let lead: unknown = null
  let leadIntelligence: unknown = null
  let behavioralData: unknown[] = []
  let engagementScores: unknown = null
  let propertyOwnership: unknown[] = []
  let peopleData: unknown = null
  let motivatedSellerSignals: unknown[] = []
  let chatSessions: unknown[] = []

  // Get base lead data - try leads table first, then contacts
  const { data: leadData, error: leadError } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle()

  // Whether the id is LEADS-class decides where the prediction may be stored:
  // predictive_lead_scores.lead_id FKs leads(id) and nothing else.
  const isLeadsClassId = !!leadData

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
    // motivated_seller_signals is the canonical signal table (the lead_-prefixed
    // name never existed as a written table — pure name drift, repointed).
    const { data } = await supabase
      .from("motivated_seller_signals")
      .select("*")
      .eq("lead_id", leadId)
    motivatedSellerSignals = data || []
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
- Property Views: not collected for pre-conversion records (property search is a contact capability)
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

    // Save prediction to ai_predictions table. brokerage_id was omitted, which
    // made the row invisible to has_brokerage_access() in every scoped reader.
    const { error: predictionInsertError } = await supabase.from("ai_predictions").insert({
      brokerage_id: callerBrokerageId,
      prediction_type: "lead_conversion",
      entity_type: isLeadsClassId ? "lead" : "contact",
      entity_id: leadId,
      prediction_value: prediction,
      confidence_score: (prediction as any).confidence,
      prediction_factors: extractFactors(lead as any, leadIntelligence, engagementScores) as any,
      model_version: "v1.0",
    })
    if (predictionInsertError) {
      console.error("[ai-predictions] ai_predictions insert refused:", predictionInsertError.message)
    }

    // Save/update predictive lead score. predictive_lead_scores.lead_id FKs
    // leads(id): a contacts.id here is a foreign-key violation, not a fallback.
    if (!isLeadsClassId) {
      console.warn(
        "[ai-predictions] predictive_lead_scores skipped — id is contacts-class and lead_id FKs leads(id)",
      )
    } else {
      const { error: scoreError } = await supabase.from("predictive_lead_scores").upsert(
        {
          lead_id: leadId,
          brokerage_id: callerBrokerageId, // NOT NULL, and both halves of the RLS policy
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
          updated_at: new Date().toISOString(),
        },
        { onConflict: "lead_id" }, // predictive_lead_scores_lead_id_key
      )
      if (scoreError) {
        console.error("[ai-predictions] predictive_lead_scores upsert refused:", scoreError.message)
      }
    }

    return prediction
  } catch (error) {
    console.error("[v0] AI prediction failed:", error)
    return { error: "Prediction unavailable" }
  }
}

/**
 * NOTE — the `interactions` parameter and its `active_property_viewing` factor
 * were REMOVED (wave 18): pre-conversion records have no IDX property-interaction lane at all: property search is a contacts capability (owner ruling, wave 18), the only table that carried it is keyed on the pre-conversion id with no contacts column, and its writer was removed because it was filing a contacts id in that column. So this signal is not 'zero' — it is NOT COLLECTED, and printing a zero would read as a fact about the person.
 * A factor that can never fire is not a conservative default, it is a silently
 * missing input to a score somebody reads as complete.
 */
function extractFactors(
  lead: Record<string, unknown>,
  intelligence: unknown,
  engagement: unknown,
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
    // predictLeadConversion accepts a leads.id OR a contacts.id and stamps
    // entity_type accordingly, so filtering on "lead" alone would hide half of
    // what it writes. entity_id is a uuid — no cross-class collision to worry about.
    .in("entity_type", ["lead", "contact"])
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

// UNWIRED BY CONSEQUENCE, not by choice: its only writer is predictLeadConversion
// above, which is deliberately unwired, and predictive_lead_scores_select requires
// is_lead_visible_role() (broker/admin only) so an agent surface could not read it
// even once rows exist. Wiring this before its writer would ship a card that is
// empty by construction.
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

// UNWIRED BY CONSEQUENCE: a fan-out over predictLeadConversion, so it inherits that
// function's verdict verbatim. It is one AI call per lead with no concurrency cap;
// whoever wires it should bound it.
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
          last_contacted_at: new Date().toISOString(),
        })
        .eq("id", data.leadId)
    } catch (e) {
      // Try contacts table if leads doesn't exist
      await supabase
        .from("contacts")
        .update({
          last_contacted_at: new Date().toISOString(),
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
      // compliance_flags canonical columns: violation_type/flagged_content/content_type;
      // status CHECK is flagged|reviewed|resolved|overridden (no 'open'); no entity_type/
      // entity_id/description/flag_type columns. (contact_id omitted: data.leadId may be a
      // leads.id, and contact_id FKs contacts — avoid an FK violation.)
      await supabase.from("compliance_flags").insert({
        content_type: data.conversationType,
        violation_type: "fair_housing_violation",
        severity: "high",
        flagged_content: `Compliance issues detected: ${result.complianceIssues.join(", ")} :: ${data.transcript}`,
        status: "flagged",
        detected_at: new Date().toISOString(),
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

// ─────────────────────────────────────────────────────────────────────────────
// THE CALLER'S OWN IDX BROKER ACCOUNT — RESOLVED, NEVER ASSUMED
//
// Six functions in this file used to open their property lane with
// `new IDXBrokerClient()`. That took no argument, so the client fell straight
// through to the platform's IDXBROKER_API_KEY and every brokerage — including one
// that had connected its own IDX Broker account precisely to get its own board's
// listings — was served the platform's feed instead. IDX Broker is
// TENANT-SETTABLE (lib/connections/scope.ts lists `idxbroker` under the
// per-tier-connectable `listing` domain); `IDXBrokerClient.forBrokerage` already
// walked agent → team → brokerage → platform correctly and simply had no callers
// here.
//
// This resolves the owner from the SESSION. It is not a parameter and it is not
// derivable from anything the caller passes: every one of these six functions is
// reached from an authenticated dashboard surface, and the feed they should read
// is the feed belonging to the signed-in tenant. getAgentContext is used rather
// than a raw users read because it is the impersonation-aware resolver — when
// platform staff are acting AS a tenant it returns THAT tenant, so an "act as"
// session sees the tenant's own IDX account rather than the platform's.
//
// ID CLASSES. `agentUserId` is a USERS.id — the class scopeCascade files an
// "agent"-scope credential under. `agents.id` (what contacts.agent_id holds) and
// `contacts.id` are DISJOINT spaces; neither is ever substituted for it here.
//
// FAILS CLOSED. With no session brokerage there is no answer to "whose feed is
// this?", and quietly answering "the platform's" is the exact defect being
// removed — so it refuses. A refusal must never be mistaken for "this brokerage's
// IDX feed has no listings", which is what every one of these prompts would
// otherwise have been told.
// ─────────────────────────────────────────────────────────────────────────────
async function idxForCallerBrokerage(surface: string) {
  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")

  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) {
    throw new Error(
      `${surface}: no signed-in brokerage, so there is no IDX Broker account to read from. This is a refusal, not an empty feed.`,
    )
  }

  // The team tier of the cascade. getAgentContext does not carry it, and skipping
  // it would quietly ignore a TEAM that connected its own IDX account — a smaller
  // copy of the defect above. A refused read leaves the team tier out (the agent
  // and brokerage tiers still resolve) and says so; it never widens anything.
  const supabaseForTeam = await createClient()
  const { data: teamRow, error: teamError } = await supabaseForTeam
    .from("users")
    .select("team_id")
    .eq("id", ctx.userId)
    .maybeSingle()
  if (teamError) {
    console.error(`[v0] ${surface}: team lookup refused, IDX team tier skipped:`, teamError.message)
  }

  const client = await IDXBrokerClient.forBrokerage(ctx.brokerageId, {
    agentUserId: ctx.userId || null,
    teamId: (teamRow?.team_id as string | null | undefined) ?? null,
  })
  return { client, brokerageId: ctx.brokerageId, agentUserId: ctx.userId }
}

// ============================================
// AI PROPERTY MATCH GENIUS
// ============================================

// CONTACTS ONLY — OWNER RULING. Property search through IDX Broker is a contacts
// capability, so this entry point resolves against ONE identity class and refuses
// everything else. It used to read the pre-conversion table FIRST, treat contacts
// as a fallback, and place the IDX call OUTSIDE every branch, so an id of either
// class reached the provider.
//
// THREE DEFECTS REMOVED TOGETHER, because they were holding each other up:
//   · THE FALLBACK NEVER FELL BACK. It bound `contact`, null-checked it, and
//     never assigned it — execution carried on reading `lead?.saved_properties`
//     off the row that had just failed to load.
//   · THE EMBED MIXED ID SPACES. saved_properties and client_detailed_personas
//     are keyed on contacts; lead_idx_property_interactions is keyed on the
//     pre-conversion class, and client_journey_preferences is not in the live
//     schema at all (see scripts/schema-snapshot.ts — it has no entry). One
//     PostgREST embed naming all four raises PGRST200, and that error was the
//     only thing standing between an unpromoted id and a paid property feed.
//     The embed now names only contacts-keyed tables that actually exist.
//   · THE CLIENT WAS BUILT FIRST. Constructing the provider client before the
//     lookup makes the decision to spend before the decision to proceed. It is
//     now constructed after the identity is proven.
export async function aiPropertyMatchGenius(contactId: string) {
  const supabase = await createClient()

  // Gather the contact and its contacts-keyed property signal.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select(
      `
      *,
      saved_properties(*),
      client_detailed_personas(*)
    `,
    )
    .eq("id", contactId)
    .maybeSingle()

  // supabase-js RESOLVES a refused query, so the error has to be read. A refusal
  // is not "no such contact" and must not be answered by searching a property
  // feed for an identity nothing has confirmed.
  if (contactError) {
    throw new Error(
      `aiPropertyMatchGenius: the contact lookup was refused (${contactError.message}). This is a refusal, not a missing record — no property search is run.`,
    )
  }
  if (!contact) {
    throw new Error(
      "aiPropertyMatchGenius: no contact carries that id. Property search runs for contacts only; an unconverted record has to be promoted first.",
    )
  }

  // ONLY NOW. The identity is proven to be a contact, so the provider client is
  // built against a decision that has already been made.
  const { client: idxClient } = await idxForCallerBrokerage("aiPropertyMatchGenius")

  // Get property family ratings from collaborative searches
  const { data: familyRatings } = await supabase
    .from("property_family_ratings")
    .select(
      `
      *,
      collaborative_searches!inner(contact_id)
    `,
    )
    .eq("collaborative_searches.contact_id", contactId)
    .limit(20)

  // Build AI prompt to learn true preferences
  const savedProps = contact.saved_properties || []
  const persona = contact.client_detailed_personas?.[0] || {}

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

PROPERTIES VIEWED BUT NOT SAVED: NOT AVAILABLE. The only viewed-not-saved record
in this system is keyed to the pre-conversion identity class, so a contact has no
such record — not an empty one, none at all. Treat browsing behaviour as UNKNOWN
and widen your confidence accordingly; do NOT read this as "they viewed nothing".

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

STATED PREFERENCES: NOT AVAILABLE. This deployment has no stated-preference
record for a contact (the table the old prompt read is absent from the live
schema), so there is nothing here to compare behaviour against. Say the
stated-vs-actual comparison is unavailable rather than reporting "none specified",
which reads as a client who stated no requirements.

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

    // Search IDX with AI-optimized criteria. searchActiveListings ACTUALLY applies
    // these filters (the removed getProperties advertised them and ignored them all,
    // so every buyer got the same unfiltered featured list).
    const properties = await idxClient.searchActiveListings({
      priceMin: aiMatch.optimalSearchCriteria?.price_min ?? undefined,
      priceMax: aiMatch.optimalSearchCriteria?.price_max ?? undefined,
      bedroomsMin: aiMatch.optimalSearchCriteria?.bedrooms_min ?? undefined,
      bathroomsMin: aiMatch.optimalSearchCriteria?.bathrooms_min ?? undefined,
    })

    // Score each property against learned preferences
    const scoredProperties = properties.map((prop) => {
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

      // Check price alignment with actual budget. NormalizedIdxListing calls this
      // `price` (the raw feed's listPrice/listingPrice/price collapse into it), and
      // it is nullable — a listing with no published price is not "in budget".
      const budgetMin = aiMatch.learnedPreferences?.actualBudgetRange?.min
      const budgetMax = aiMatch.learnedPreferences?.actualBudgetRange?.max
      if (
        prop.price != null &&
        typeof budgetMin === "number" &&
        typeof budgetMax === "number" &&
        prop.price >= budgetMin &&
        prop.price <= budgetMax
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
      entity_type: "contact",
      entity_id: contactId,
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

// pass 14: the deprecated _legacyGenerateAICMA (wrote the phantom ai_generated_cmas
// table, zero callers) was REMOVED — the canonical generateAICMA in ./ai-cma saves
// to the real cma_reports.

// Mass generate CMAs for all property owners
// The agentId parameter is intentionally ignored; identity is always resolved
// from the server-side session to prevent client-side impersonation.
export async function massGenerateCMAs(_ignoredAgentId?: string) {
  const supabase = await createClient()

  // Resolve identity server-side — never trust the client-supplied agentId
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) throw new Error("Unauthorized")

  const { getAgentContext } = await import("@/lib/identity/get-agent-context")
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) throw new Error("Not authenticated")
  if (!ctx.agentId) throw new Error("Agent profile not found")

  const agentId = ctx.agentId

  // Get agent's brokerage for commission structure
  const { data: agent } = await supabase
    .from("agents")
    .select("*, profiles!inner(brokerage_id)")
    .eq("id", agentId)
    .single()

  const brokerageId = agent?.profiles?.brokerage_id ?? ctx.brokerageId
  if (!brokerageId) {
    throw new Error("Agent brokerage not found")
  }

  const commissionStructure = await getDefaultCommissionStructure(brokerageId)

  // lead_property_ownership has no PostgREST FK to leads — embedding it errors the query.
  // Fetch leads, then their ownership rows separately (canonical pattern, see lead-intelligence.ts).
  const { data: agentLeads, error } = await supabase
    .from("leads")
    .select("*")
    .eq("agent_id", agentId)

  if (error || !agentLeads) {
    console.error("[v0] Error fetching leads with property ownership:", error)
    return {
      totalCMAsGenerated: 0,
      significantOpportunities: 0,
      results: [],
      message: "No property owners found",
    }
  }

  const { data: ownershipRows } = await supabase
    .from("lead_property_ownership")
    .select("*")
    .in("lead_id", agentLeads.map((l) => l.id))

  const ownershipByLead = new Map<string, any[]>()
  for (const row of ownershipRows || []) {
    const arr = ownershipByLead.get(row.lead_id) || []
    arr.push(row)
    ownershipByLead.set(row.lead_id, arr)
  }
  // Only owners that actually own property (replaces the phantom .not(...) filter)
  const owners = agentLeads.filter((l) => (ownershipByLead.get(l.id)?.length ?? 0) > 0)

  // ── CONTACTS ONLY — OWNER RULING ───────────────────────────────────────────
  // A CMA reaches RentCast, which is a contacts capability. This loop used to
  // hand each row's OWN id to a parameter named `contactId`, so an id from the
  // pre-conversion lane was spent against the comps provider and then written to
  // cma_reports.contact_id — a NOT NULL column that ai-cma.ts says in its own
  // comment must be tied to a contact.
  //
  // The capability is preserved for PROMOTED records rather than withdrawn: the
  // pre-conversion row carries a real, nullable `contact_id` column
  // (scripts/schema-snapshot.ts) naming the contact it was promoted into. That
  // id — never the row's own — is what a CMA is filed against, and it is
  // RESOLVED against the contacts table rather than trusted, because a stale or
  // dangling promotion pointer is not a contact.
  //
  // A record with no promotion is SKIPPED and COUNTED. Pre-rollout every table is
  // empty, so "produced nothing" is never health: the skip reasons are returned
  // so an empty run can be told apart from a run with nothing to do.
  const promotionTargets = [
    ...new Set(
      owners
        .map((l) => l.contact_id)
        .filter((v): v is string => typeof v === "string" && v.length > 0),
    ),
  ]

  const confirmedContactIds = new Set<string>()
  if (promotionTargets.length > 0) {
    const { data: contactRows, error: contactsError } = await supabase
      .from("contacts")
      .select("id")
      .in("id", promotionTargets)
    // supabase-js RESOLVES a refusal. Reading a refused lookup as "none of them
    // are contacts" would be harmless here, but reading it as "all of them are"
    // would spend the comps provider on unproven ids — so it refuses outright.
    if (contactsError) {
      console.error("[v0] massGenerateCMAs: promotion-target lookup refused:", contactsError.message)
      return {
        totalCMAsGenerated: 0,
        significantOpportunities: 0,
        results: [],
        skipped: [],
        message: `Could not confirm which owners are contacts (${contactsError.message}). No CMAs were generated — this is a refusal, not an empty book.`,
      }
    }
    for (const row of contactRows ?? []) confirmedContactIds.add(row.id as string)
  }

  const cmaResults = []
  const skipped: Array<{ ownerId: string; ownerName: string; reason: string }> = []

  for (const lead of owners) {
    const propertyOwnership = ownershipByLead.get(lead.id) || []
    const ownerName = `${lead.first_name ?? ""} ${lead.last_name ?? ""}`.trim()

    const promotedContactId = typeof lead.contact_id === "string" && lead.contact_id.length > 0 ? lead.contact_id : null
    if (!promotedContactId) {
      skipped.push({
        ownerId: lead.id,
        ownerName,
        reason: "not promoted to a contact — property valuation runs for contacts only",
      })
      continue
    }
    if (!confirmedContactIds.has(promotedContactId)) {
      skipped.push({
        ownerId: lead.id,
        ownerName,
        reason: "promotion target does not resolve to a contact this caller can read",
      })
      continue
    }

    for (const property of propertyOwnership) {
      try {
        // Use the canonical generateAICMA from ai-cma.ts which saves to cma_reports
        const { generateAICMA: generateRealCMA } = await import("./ai-cma")

        const cma = await generateRealCMA({
          agentId,
          contactId: promotedContactId,
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
          ownerId: lead.id,
          contactId: promotedContactId,
          leadName: ownerName,
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
    // The report this insight points at is filed on the CONTACT, so the insight
    // is too — type and id move together, never one without the other.
    await supabase.from("ai_insights").insert({
      insight_type: "opportunity",
      entity_type: "contact",
      entity_id: gain.contactId,
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
    skipped,
    message:
      `Generated ${cmaResults.length} CMAs. Found ${significantGains.length} high-equity opportunities!` +
      (skipped.length > 0
        ? ` ${skipped.length} property owner${skipped.length === 1 ? "" : "s"} skipped: a valuation is filed against a contact, and ${skipped.length === 1 ? "that record has" : "those records have"} not been converted yet.`
        : ""),
  }
}

// ============================================
// WINNING OFFER PREDICTION
// ============================================

// THE PERSON PARAMETER IS GONE, DELIBERATELY — OWNER RULING.
//
// This function used to take a `leadId`, and that identifier appeared EXACTLY
// ONCE in the whole body: its own declaration. It was never read against any
// table, never filtered anything, never reached the prompt and never reached the
// row this writes (which keys on the PROPERTY: entity_type "property",
// entity_id = the MLS id). It was inert.
//
// An inert identity parameter is worse than no parameter, because it reads like
// authorization: every caller and every reviewer saw an id being handed to a
// function that opens an IDX Broker feed and assumed something checked it.
// Nothing did — an id of ANY class, from any lane, reached the provider.
//
// The honest resolution is removal rather than a ceremonial gate. The offer
// prediction genuinely does not need a person: it works from the MLS id, the
// list price and property_smart_insights, and produces a strategy for the
// PROPERTY. The tenant whose IDX feed is read is resolved from the SESSION, not
// from any identifier a caller supplies, so with the parameter gone there is no
// identity of any class on this path at all.
export async function predictWinningOffer(data: {
  propertyMlsId: string
  listPrice: number
}) {
  const supabase = await createClient()
  const { client: idxClient } = await idxForCallerBrokerage("predictWinningOffer")

  // Get property intelligence. This used to call getProperties({ ids: [mlsId] }) —
  // the `ids` filter was ignored, so it received EVERY featured listing and took
  // [0]: an unrelated property, whose address and figures were then fed to the
  // offer prompt as if they were this one's. Now we pull the feed and RESOLVE the
  // MLS id against it; no match means no property record, not a substitute one.
  const feed = await idxClient.searchActiveListings({ limit: 200 })
  const property =
    feed.find((l) => l.mlsNumber === data.propertyMlsId || l.externalId === data.propertyMlsId) ?? null

  const { data: insights, error: insightsError } = await supabase
    .from("property_smart_insights")
    .select("*")
    .eq("property_mls_id", data.propertyMlsId)
    .maybeSingle()

  if (insightsError) {
    console.error("[v0] predictWinningOffer: property_smart_insights read refused:", insightsError.message)
  }
  const smartInsights = insightsError ? null : insights

  const domKnown = typeof smartInsights?.days_on_market === "number"
  const reductionsKnown = typeof smartInsights?.price_reduction_count === "number"

  const prompt = `You are an AI real estate strategist. Predict the winning offer amount.

Work ONLY from the facts below. Where a fact is marked "not available", say the
recommendation is uncertain on that axis — do NOT assume a value for it.

Property: ${
    property
      ? `${property.address}${property.city ? `, ${property.city}` : ""}${property.state ? `, ${property.state}` : ""}`
      : `MLS ${data.propertyMlsId} — not present in this brokerage's IDX feed, so no property record, address or listing detail is available`
  }
${property?.bedrooms != null || property?.bathrooms != null || property?.squareFeet != null
    ? `Property Facts: ${[
        property.bedrooms != null ? `${property.bedrooms} bd` : null,
        property.bathrooms != null ? `${property.bathrooms} ba` : null,
        property.squareFeet != null ? `${property.squareFeet} sqft` : null,
      ].filter(Boolean).join(" / ")}`
    : "Property Facts: not available"}
List Price: $${data.listPrice.toLocaleString()}
Days on Market: ${domKnown ? smartInsights!.days_on_market : "not available"}
Price Reductions: ${reductionsKnown ? smartInsights!.price_reduction_count : "not available"}
Market Position: ${smartInsights?.market_position ?? "not available"}

Competition Indicators: NOT AVAILABLE. The IDX feed exposes no view counts, no
showing counts and no competing-offer counts, and nothing else in this system
records them. Do not estimate competition — state that it is unknown and give the
strategy a wider band because of it.

Seller Signals:
- Motivated? ${domKnown ? (smartInsights!.days_on_market > 60 ? "YES (60+ days on market)" : "No DOM-based signal") : "not available (days on market unknown)"}
- Price Reduction Frequency: ${reductionsKnown ? smartInsights!.price_reduction_count : "not available"}

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
      throw new Error("No negotiation strategy was returned")
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
  // ONE tenant resolve for the whole function: the same brokerage whose IDX feed is
  // read below is the brokerage the alert row and the affected-contact sweep are
  // filed under. This used to resolve the session a second time, further down, and
  // two independent resolves of the same thing are two things that can disagree.
  const { client: idxClient, brokerageId: shiftBrokerageId } =
    await idxForCallerBrokerage("predictMarketShift")

  // Get current inventory. This is the BROKERAGE'S OWN IDX-enabled active listings
  // in the city, not the whole market's inventory — the prompt below says so.
  const currentListings = await idxClient.searchActiveListings({ city: data.city, state: data.state })

  // Average DOM over the listings that actually report one. The previous expression
  // divided by `(length || 1)`, so an empty feed produced a confident "Average DOM: 0"
  // — a fabricated market fact. No reported DOM now reads as unavailable.
  const domValues = currentListings
    .map((l) => l.daysOnMarket)
    .filter((d): d is number => typeof d === "number")
  const avgDom =
    domValues.length > 0
      ? Math.round(domValues.reduce((sum, d) => sum + d, 0) / domValues.length)
      : null

  const prompt = `You are a real estate market economist AI. Predict market shifts.

Market: ${data.city}, ${data.state}

Current Snapshot — SCOPE WARNING: this count is this brokerage's own IDX-enabled
active listings in the city, NOT total market inventory. Do not present it as the
market's inventory level or compute market share from it.
- Brokerage active listings in ${data.city}: ${currentListings.length}
- Average days on market across those listings: ${
    avgDom != null
      ? `${avgDom} (from ${domValues.length} of ${currentListings.length} listings that report DOM)`
      : "not available — no listing in this feed reports days on market"
  }

No independent inventory, absorption or price-history series is available to this
call. Where your prediction would depend on one, say what you would need rather
than asserting a figure.

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

    // Save prediction. pass 14: predictive_market_alerts was a PHANTOM table —
    // consolidated onto the real trend_alerts ledger (brokerage-scoped).
    if (shiftBrokerageId) {
      const conf = prediction.data.prediction?.confidence || 0.5
      await supabase.from("trend_alerts").insert({
        brokerage_id: shiftBrokerageId,
        alert_type: "market_shift_prediction",
        alert_message: `${data.city}, ${data.state}: ${prediction.data.prediction?.direction ?? "shift"} predicted (${prediction.data.prediction?.timeframe ?? "near term"}, confidence ${(conf * 100).toFixed(0)}%)`,
        severity: conf >= 0.7 ? "high" : "medium",
        source_table: "ai_market_prediction",
        is_resolved: false,
      })
    }

    // Create insights for affected leads — tenant anchor (scope burn-down):
    // only the caller's own brokerage's contacts get insights.
    let leads: { id: string }[] | null = null
    if (shiftBrokerageId) {
      const { data: leadRows } = await supabase
        .from("contacts")
        .select("id")
        .eq("brokerage_id", shiftBrokerageId)
        .eq("city", data.city)
        .limit(50)
      leads = leadRows
    }

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
  const { BatchDataClient } = await import("@/lib/batchdata-client")

  // `data.agentId` is a caller-supplied parameter and is NOT the tenant: it is
  // only stamped onto the insight rows below. The IDX account is resolved from the
  // session.
  const { client: idxClient } = await idxForCallerBrokerage("findMarketArbitrage")
  const batchData = new BatchDataClient()

  // Get all active listings the brokerage's IDX feed carries for this city.
  const activeListings = await idxClient.searchActiveListings({ city: data.city })

  // The sold side. This used to be a SECOND getProperties call with status:"sold"
  // — which returned the IDENTICAL array as the active call, and the prompt then
  // rendered `SOLD $${sale.soldPrice}` (a field active listings do not have) as
  // "SOLD $undefined" for every row, while telling the model the same properties
  // were simultaneously the current inventory AND the recent sales.
  //
  // IDX cannot serve sold comps from a bare API key. The real recent-sales
  // observation is the market_data table (writer: lib/intelligence/
  // market-insight-generator.ts). It may legitimately have no row for this city
  // yet — in that case the prompt below says there is no benchmark, rather than
  // inventing one.
  const { data: marketRow, error: marketError } = await supabase
    .from("market_data")
    .select("median_sale_price, sold_listings_30d, avg_days_on_market, list_to_sale_ratio, data_date")
    .eq("city", data.city)
    .eq("state", data.state)
    .order("data_date", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (marketError) {
    console.error("[v0] findMarketArbitrage: market_data read refused:", marketError.message)
  }
  const soldBenchmark = marketError ? null : marketRow

  const soldBenchmarkBlock = soldBenchmark
    ? `Recent-sales benchmark for ${data.city}, ${data.state} (observed ${soldBenchmark.data_date}):
- Median sale price: ${soldBenchmark.median_sale_price != null ? `$${Number(soldBenchmark.median_sale_price).toLocaleString()}` : "not available"}
- Homes sold in last 30 days: ${soldBenchmark.sold_listings_30d ?? "not available"}
- Average days on market: ${soldBenchmark.avg_days_on_market ?? "not available"}
- List-to-sale ratio: ${soldBenchmark.list_to_sale_ratio ?? "not available"}

This is an AREA-LEVEL benchmark, not a set of individual comparable sales. You
cannot adjust it for a specific property's condition, lot or finish level.`
    : `Recent-sales benchmark: NOT AVAILABLE. No recent-sales observation exists for
${data.city}, ${data.state}, and this system holds NO individual sold comparables —
the IDX feed serves active listings only.

Therefore: do NOT claim any listing is "below comparable sales", do not state an
estimated market value, and do not produce a profit or ROI figure — every one of
those requires sold data you do not have. Scope your analysis to what LIST PRICES
ALONE can support: relative price-per-square-foot within this list, unusually long
days on market, and outliers versus the rest of this same list. Say plainly in
"marketInsights" that no recent-sales benchmark was available and that the
opportunities are list-price-relative only.`

  const listingBlock =
    activeListings.length > 0
      ? activeListings
          .slice(0, 20)
          .map((listing) => {
            const ppsf =
              listing.price != null && listing.squareFeet
                ? `$${Math.round(listing.price / listing.squareFeet)}`
                : "not available"
            return `
${listing.address || "(address not published)"}${listing.mlsNumber ? ` [MLS ${listing.mlsNumber}]` : ""}: ${listing.price != null ? `$${listing.price.toLocaleString()}` : "list price not available"}
${listing.bedrooms ?? "?"}bd/${listing.bathrooms ?? "?"}ba, ${listing.squareFeet != null ? `${listing.squareFeet} sqft` : "sqft not available"}
DOM: ${listing.daysOnMarket ?? "not available"}
Price/sqft: ${ppsf}
`
          })
          .join("\n")
      : "(no active listings returned for this city — there is nothing to analyze)"

  const prompt = `You are an AI investment analyzer. Find underpriced properties.

SCOPE: the listings below are this brokerage's own IDX-enabled active listings in
${data.city}, not the whole market. Never assert a fact you were not given.

Active listings supplied: ${activeListings.length}

Analyze active listings:
${listingBlock}

${soldBenchmarkBlock}

Find up to 10 opportunities, using ONLY what is above:
- Priced low relative to the other listings here${soldBenchmark ? " and to the area median sale price" : ""}
- Show seller motivation (high days on market)
- Return an empty "opportunities" array if the data above does not support any.
- Leave any numeric field you cannot derive from the data above as null. Do not guess.

Shape only — every value below is illustrative. Fill each field from the data
above or set it to null. "estimatedValue", "belowMarket", "belowMarketPercent",
"investIn", "sellAt", "profit" and "roi" are only fillable when a recent-sales
benchmark was supplied; otherwise they are null. Never quote a property's
condition or renovation need — nothing above reports it.

{
  "opportunities": [
    {
      "mlsId": "...",
      "address": "123 Oak St",
      "listPrice": 385000,
      "estimatedValue": null,
      "belowMarket": null,
      "belowMarketPercent": null,
      "reasoning": [
        "Lowest price/sqft of the listings supplied",
        "Listed 60 days - longest days on market in this set"
      ],
      "investmentPotential": {
        "buyAt": 385000,
        "investIn": null,
        "sellAt": null,
        "profit": null,
        "roi": null,
        "timeline": null
      },
      "buyerTypes": ["investor", "first_time_with_vision"],
      "urgency": "medium",
      "competitionLevel": "unknown",
      "actionRequired": "Tour before advising an offer - no sold comparables available"
    }
  ],
  "marketInsights": {
    "total_mispriced": 0,
    "avg_opportunity": null,
    "data_limitations": "State here exactly which inputs were unavailable (e.g. no recent-sales benchmark, no condition data, brokerage-only listing set).",
    "best_neighborhoods": []
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
      // ai_insights has no insight_data column → fold the payload into estimated_impact
      // (jsonb). entity_id is uuid; opp.mlsId is an MLS string → keep it in the payload, not entity_id.
      //
      // "% Below Market" is only sayable when a recent-sales benchmark existed.
      // Without one the model returns nulls, and the title/description must not
      // render "null% Below Market" / "$undefined below market value" as if a
      // comparison had been made.
      const belowPct = typeof opp.belowMarketPercent === "number" ? opp.belowMarketPercent : null
      const belowAmt = typeof opp.belowMarket === "number" ? opp.belowMarket : null
      await supabase.from("ai_insights").insert({
        insight_type: "opportunity",
        entity_type: "property",
        insight_title:
          belowPct != null
            ? `Hidden Gem: ${belowPct}% Below Market`
            : `Possible Value: ${opp.address ?? "listing"} (no sold comparables available)`,
        insight_description:
          belowAmt != null
            ? `${opp.address} - $${belowAmt.toLocaleString()} below market value`
            : `${opp.address ?? "Listing"} - flagged on list price alone; no recent-sales benchmark was available for ${data.city}, ${data.state}, so no below-market figure can be stated.`,
        actionable_steps: [opp.actionRequired],
        priority: opp.urgency === "high" ? "critical" : "high",
        estimated_impact: {
          potential_profit: opp.investmentPotential?.profit,
          roi: opp.investmentPotential?.roi,
          mls_id: opp.mlsId,
          opportunity: opp,
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
            // null, not 0 — without a recent-sales benchmark there is no
            // per-deal figure, and a stored 0 reads as a measured zero.
            avg_profit_per_deal:
              typeof arbitrage.marketInsights?.avg_opportunity === "number"
                ? arbitrage.marketInsights.avg_opportunity
                : null,
            total_opportunities: arbitrage.opportunities?.length || 0,
            recent_sales_benchmark_available: soldBenchmark != null,
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
      // The lookup above reads CONTACTS. "Lead not found" sent the reader to a
      // different table and a different business object — this OS keeps leads
      // and contacts deliberately separate.
      throw new Error("Contact not found")
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

// STILL UNWIRED, AND THE READER IS ALREADY BUILT.
//
// app/crm/contacts/[contactId]/page.tsx:224 renders an "AI Showing Plan" card off
// smart_showing_recommendations and is complete — it even handles both target
// classes (contact_id directly, or any of the contact's leads). This function is
// the ONLY writer of that table, and it has no caller, so the card has never had a
// row to show. That reader lives on app/crm/**, which is outside the surface set
// this pass may edit, so the wire is left for the pass that owns it.
//
// TWO DEFECTS FIXED SO IT IS WIREABLE WHEN THAT HAPPENS:
//   · brokerage_id was omitted. smart_showing_recommendations_select is
//     `is_platform_admin() OR has_brokerage_access(brokerage_id)`, and
//     has_brokerage_access(NULL) is false — so every row this wrote would have been
//     unreadable by everyone, including the agent who asked for the route. A
//     write-only table wearing the costume of a working one.
//   · the insert's error was never destructured, so a refusal returned
//     `{ success: true }` with the route rendered on screen and nothing stored.
//
// CONTACTS ONLY — OWNER RULING (this wave). The route is built from an IDX Broker
// feed, so the identity is resolved against contacts BEFORE the client exists,
// and a non-contact is refused rather than served. The parameter is named for the
// class it now holds; it previously carried an unchecked id straight into the
// row's leads-class column.
export async function optimizeShowingRoute(data: {
  contactId: string
  propertyIds: string[]
  preferredDate: string
  startLocation: string
}) {
  const supabase = await createClient()

  // THE IDENTITY FIRST, THE PROVIDER SECOND.
  const { data: routeContact, error: routeContactError } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", data.contactId)
    .maybeSingle()
  if (routeContactError) {
    throw new Error(
      `optimizeShowingRoute: the contact lookup was refused (${routeContactError.message}). A refusal is not a missing record — no showing route is built and no property feed is read.`,
    )
  }
  if (!routeContact) {
    throw new Error(
      "optimizeShowingRoute: no contact carries that id. Showing routes are built for contacts only; an unconverted record has to be promoted first.",
    )
  }

  const { data: { user: routeCaller } } = await supabase.auth.getUser()
  if (!routeCaller) throw new Error("No signed-in caller")
  const { data: routeCallerRow, error: routeCallerError } = await supabase
    .from("users")
    .select("brokerage_id, team_id")
    .eq("id", routeCaller.id)
    .maybeSingle()
  if (routeCallerError) throw new Error(`Caller lookup failed: ${routeCallerError.message}`)
  const routeBrokerageId = routeCallerRow?.brokerage_id as string | undefined
  if (!routeBrokerageId) throw new Error("No brokerage on this account")
  // This function had ALREADY resolved its tenant for the row it writes; the IDX
  // client now uses THAT resolve rather than deriving the owner a second, different
  // way. `routeCaller.id` is a users.id, which is what the agent tier of the
  // ownership cascade is keyed on.
  const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
  const idxClient = await IDXBrokerClient.forBrokerage(routeBrokerageId, {
    agentUserId: routeCaller.id,
    teamId: (routeCallerRow?.team_id as string | null | undefined) ?? null,
  })

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

    // THE ROW IS CONTACTS-CLASS, SO IT IS FILED UNDER THE CONTACTS COLUMN.
    // `lead_id` is a real column on this table, but it is the OTHER class's
    // column, and the id here has just been PROVEN to be a contacts.id — writing
    // it there would be the same id-class error in the opposite direction, and
    // the reader (app/crm/contacts/[contactId]/page.tsx) resolves `lead_id` by
    // joining the contact's pre-conversion records, so a contacts.id parked in it
    // would never match anything. `contact_id` exists on this table
    // (scripts/schema-snapshot.ts) and is exactly what that reader matches first.
    const { error: recError } = await supabase.from("smart_showing_recommendations").insert({
      contact_id: data.contactId,
      brokerage_id: routeBrokerageId, // without this the row is unreadable by everyone
      recommended_properties: optimizedRoute.data.optimizedRoute?.properties ?? [],
      showing_route: optimizedRoute.data.optimizedRoute,
      total_drive_time: optimizedRoute.data.optimizedRoute?.totalDriveTime,
      suggested_order: optimizedRoute.data.optimizedRoute?.properties?.map((p: any) => p.address),
      recommended_day: data.preferredDate,
      why_these_properties: "AI-optimized for maximum impact",
    })
    if (recError) {
      console.error("[ai-predictions] smart_showing_recommendations insert refused:", recError.message)
      return { success: false as const, error: recError.message, route: optimizedRoute.data.optimizedRoute }
    }

    return {
      success: true as const,
      error: null,
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
1. Lifetime customers ready to move again (5-7 years, equity built)
2. Sphere of influence (neighbors of recent sales)
3. Motivated sellers (life events, financial signals)
4. Rental to ownership (renters ready to buy)
5. Empty nesters (seniors downsizing)

{
  "opportunities": [
    {
      "type": "lifetime_customer_ready",
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
      throw new Error("No opportunities were returned")
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

  // Past clients / lifetime customers live on CONTACTS, not leads (a lead that closed
  // was converted at assignment; Sphere = lifetime customers per the business process).
  // The previous query hit leads with a phantom lead_status column — it errored, so the
  // sphere miner always saw 0 lifetime customers and produced empty referral analyses.
  const { data: pastClients } = await supabase
    .from("contacts")
    .select(
      "id, first_name, last_name, email, phone, contact_type, status, " +
      "address, city, state, zip_code, home_value_estimate, equity_estimate, " +
      "life_events, last_contacted_at, created_at",
    )
    .eq("agent_id", agentId)
    .in("contact_type", ["past_client", "lifetime", "lifetime_customer", "client", "sphere"])

  const prompt = `You are an AI sphere of influence miner. Find referral opportunities:

Lifetime Customers: ${pastClients?.length || 0}

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
  // `data.agentId` is caller-supplied and is not used to pick a credential — the
  // listings below are "this brokerage's own IDX-enabled active listings", and the
  // prompt says so, so the brokerage has to be the SESSION'S, not a parameter's.
  const { client: idxClient } = await idxForCallerBrokerage("competitiveIntelligence")

  const listings = await idxClient.searchActiveListings({ city: data.marketArea })

  const listingBlock =
    listings.length > 0
      ? listings
          .slice(0, 25)
          .map((l) => {
            const ppsf =
              l.price != null && l.squareFeet ? `$${Math.round(l.price / l.squareFeet)}/sqft` : "price/sqft not available"
            return `- ${l.address || "(address not published)"}: ${l.price != null ? `$${l.price.toLocaleString()}` : "list price not available"}, ${l.bedrooms ?? "?"}bd/${l.bathrooms ?? "?"}ba, ${l.squareFeet != null ? `${l.squareFeet} sqft` : "sqft not available"}, DOM ${l.daysOnMarket ?? "not available"}, ${ppsf}`
          })
          .join("\n")
      : "(none returned)"

  const prompt = `Analyze what can be analyzed about the competitive position in ${data.marketArea}.

WHAT THIS DATA IS — read before answering. The listings below come from ONE source:
this brokerage's OWN IDX-enabled active listings. They are not the market's
listings, and they are not competitors' listings. Nothing here names an agent,
attributes a listing to a brokerage, counts total market inventory, or reports any
sold price.

Consequences you MUST honour:
- You CANNOT identify competitor agents. Return "competitorRankings": [].
- You CANNOT compute market share. Return "marketShare": null wherever it appears.
- You CANNOT call a listing overpriced or underpriced: that needs sold comparable
  sales, and there are none here. Only relative statements within this same set of
  listings are supportable (e.g. "highest price/sqft of the 12 listings supplied").
- Put every one of these gaps in "dataLimitations" so the reader sees what the
  answer is missing rather than assuming it was considered.

Brokerage active listings supplied: ${listings.length}
${listingBlock}

Output shape — illustrative values only; use null / [] wherever the data above
does not support a value:
{
  "competitorRankings": [],
  "marketShare": null,
  "listingSetObservations": [
    {"address": "...", "observation": "Highest price/sqft in the supplied set", "basis": "relative_to_supplied_listings_only"}
  ],
  "opportunities": {
    "overpriced_listings": [],
    "steal_deals": []
  },
  "marketGaps": [
    "Only state a gap that follows from the supplied listings (e.g. no listing in this set under $300k)"
  ],
  "recommendations": [
    "Actions that do not depend on competitor or sold data"
  ],
  "dataLimitations": [
    "Listings are this brokerage's own IDX feed, not the market",
    "No agent attribution, so no competitor ranking or market share",
    "No sold comparable sales, so no over/underpricing judgement"
  ]
}`

  try {
    const intel = await generateAIJSON(prompt)

    if (!intel.data) {
      throw new Error("No competitive intel was returned")
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
