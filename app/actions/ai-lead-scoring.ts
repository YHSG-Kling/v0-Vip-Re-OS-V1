"use server"

import { createClient } from "@/lib/supabase/server"
import { handleError } from "@/lib/errors"
import { generateTextRouted as generateText } from "@/lib/ai/models"

/**
 * AI-Powered Lead Scoring System
 * Analyzes lead behavior, engagement, and intent to provide actionable scores
 */

export async function scoreLeadWithAI(params: {
  contactId: string
  agentId: string
}) {
  try {
    const supabase = await createClient()

    // Get contact data with behavioral signals
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select(`
        *,
        behavioral_signals(*),
        site_activity(*),
        property_views(*),
        lead_engagement_scores(*)
      `)
      .eq("id", params.contactId)
      .single()

    if (contactError) throw contactError

    // Get interaction history
    const { data: interactions } = await supabase
      .from("messages")
      .select("*")
      .eq("contact_id", params.contactId)
      .order("created_at", { ascending: false })
      .limit(20)

    // AI scoring analysis
    const { text: analysis } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `You are an AI real estate lead scoring expert. Analyze this lead comprehensively.

Contact Details:
- Name: ${contact.first_name} ${contact.last_name}
- Email: ${contact.email}
- Phone: ${contact.phone || "Not provided"}
- Current Stage: ${contact.lead_stage || "New"}
- Source: ${contact.lead_source || "Unknown"}
- Budget: ${contact.budget_min ? `$${contact.budget_min} - $${contact.budget_max}` : "Not specified"}
- Preferred Areas: ${contact.preferred_areas?.join(", ") || "Not specified"}
- Timeline: ${contact.buying_timeline || "Unknown"}

Behavioral Data:
- Total Sessions: ${contact.behavioral_signals?.[0]?.total_sessions || 0}
- Pages Viewed: ${contact.site_activity?.length || 0}
- Properties Viewed: ${contact.property_views?.length || 0}
- Recent Interactions: ${interactions?.length || 0}
- Last Contact: ${contact.last_contact_date || "Never"}

Provide a JSON response with:
{
  "overallScore": 0-100,
  "engagement": 0-100,
  "intent": 0-100,
  "qualification": 0-100,
  "motivation": 0-100,
  "readiness": "cold" | "warm" | "hot",
  "nextBestAction": "specific recommendation",
  "reasoning": "brief explanation",
  "priorities": ["priority1", "priority2", "priority3"]
}`,
    })

    const scores = JSON.parse(analysis)

    // Update contact with scores
    await supabase
      .from("contacts")
      .update({
        lead_score: scores.overallScore,
        engagement_score: scores.engagement,
        intent_score: scores.intent,
        qualification_score: scores.qualification,
        motivation_score: scores.motivation,
        readiness_level: scores.readiness,
      })
      .eq("id", params.contactId)

    // Log scoring event
    await supabase.from("lead_score_history").insert({
      contact_id: params.contactId,
      agent_id: params.agentId,
      overall_score: scores.overallScore,
      engagement_score: scores.engagement,
      intent_score: scores.intent,
      qualification_score: scores.qualification,
      motivation_score: scores.motivation,
      factors: scores.reasoning,
      ai_recommendations: scores.priorities,
    })

    return {
      success: true,
      scores,
    }
  } catch (error) {
    return handleError(error, "scoreLeadWithAI")
  }
}

/**
 * Get lead insights and score breakdown
 */
export async function getLeadInsights(contactId: string) {
  try {
    const supabase = await createClient()

    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select(`
        *,
        lead_score_history(* order by scored_at desc limit 5)
      `)
      .eq("id", contactId)
      .single()

    if (contactError) throw contactError

    return {
      success: true,
      currentScore: {
        overall: contact.lead_score || 0,
        engagement: contact.engagement_score || 0,
        intent: contact.intent_score || 0,
        qualification: contact.qualification_score || 0,
        motivation: contact.motivation_score || 0,
        readiness: contact.readiness_level || "cold",
      },
      history: contact.lead_score_history || [],
      contact,
    }
  } catch (error) {
    return handleError(error, "getLeadInsights")
  }
}

/**
 * Bulk score multiple leads
 */
export async function bulkScoreLeads(params: {
  agentId: string
  contactIds?: string[]
  leadStage?: string
}) {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("contacts")
      .select("id, first_name, last_name")
      .eq("agent_id", params.agentId)

    if (params.contactIds) {
      query = query.in("id", params.contactIds)
    } else if (params.leadStage) {
      query = query.eq("lead_stage", params.leadStage)
    } else {
      // Score all active leads by default
      query = query.in("lead_stage", ["new", "nurturing", "qualified"])
    }

    const { data: contacts, error } = await query.limit(50)

    if (error) throw error

    const results = []
    for (const contact of contacts || []) {
      const result = await scoreLeadWithAI({
        contactId: contact.id,
        agentId: params.agentId,
      })
      results.push({
        contactId: contact.id,
        name: `${contact.first_name} ${contact.last_name}`,
        ...result,
      })
    }

    return {
      success: true,
      totalScored: results.length,
      results,
    }
  } catch (error) {
    return handleError(error, "bulkScoreLeads")
  }
}
