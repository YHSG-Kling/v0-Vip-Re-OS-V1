"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateText, generateObject } from "ai"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"

// ============================================================================
// AI LEAD NURTURING SYSTEM
// Smart drip campaigns, engagement scoring, and automated follow-ups
// ============================================================================

/**
 * AI-powered lead scoring with behavioral analysis
 */
export async function aiCalculateLeadScore(params: {
  contactId: string
  agentId: string
}): Promise<{ success: boolean; score?: number; factors?: any; recommendations?: string[]; error?: string }> {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs provided" }
  }

  const supabase = await createClient()

  try {
    // Get contact data
    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.contactId)
      .single()

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    // Get interactions
    const { data: interactions } = await supabase
      .from("interactions")
      .select("*")
      .eq("contact_id", params.contactId)
      .order("interaction_date", { ascending: false })
      .limit(50)

    // Get property views/searches
    const { data: propertyActivity } = await supabase
      .from("lead_property_searches")
      .select("*")
      .eq("lead_id", params.contactId)
      .limit(50)

    // Get email engagement
    const { data: emailActivity } = await supabase
      .from("email_tracking")
      .select("*")
      .eq("contact_id", params.contactId)
      .limit(50)

    // AI analysis
    const { object: analysis } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        overallScore: z.number().min(0).max(100),
        engagementScore: z.number().min(0).max(100),
        intentScore: z.number().min(0).max(100),
        timelineScore: z.number().min(0).max(100),
        financialReadinessScore: z.number().min(0).max(100),
        factors: z.object({
          positive: z.array(z.string()),
          negative: z.array(z.string()),
          neutral: z.array(z.string()),
        }),
        buyerPersona: z.enum(["first_time_buyer", "move_up_buyer", "investor", "downsizer", "relocating", "unknown"]),
        predictedTimeline: z.enum(["immediate", "1_3_months", "3_6_months", "6_12_months", "12_plus_months"]),
        recommendations: z.array(z.string()),
        nextBestAction: z.string(),
        riskOfLoss: z.enum(["low", "medium", "high"]),
      }),
      prompt: `Analyze this real estate lead and provide a comprehensive score:

CONTACT INFO:
- Name: ${contact.first_name} ${contact.last_name}
- Type: ${contact.contact_type}
- Persona: ${contact.contact_persona}
- Timeline: ${contact.timeline}
- Status: ${contact.status}
- Source: ${contact.source}
- Created: ${contact.created_at}
- Last Contact: ${contact.last_contact_date}

INTERACTIONS (${interactions?.length || 0} total):
${JSON.stringify(interactions?.slice(0, 10), null, 2)}

PROPERTY ACTIVITY (${propertyActivity?.length || 0} searches):
${JSON.stringify(propertyActivity?.slice(0, 10), null, 2)}

EMAIL ENGAGEMENT (${emailActivity?.length || 0} emails):
${JSON.stringify(emailActivity?.slice(0, 10), null, 2)}

Provide scores 0-100 for each category, identify positive/negative factors, and recommend next actions.`,
    })

    // Update contact with AI score
    await supabase
      .from("contacts")
      .update({
        lead_score: analysis.overallScore,
        ai_insights: {
          lastScored: new Date().toISOString(),
          engagementScore: analysis.engagementScore,
          intentScore: analysis.intentScore,
          timelineScore: analysis.timelineScore,
          financialReadinessScore: analysis.financialReadinessScore,
          buyerPersona: analysis.buyerPersona,
          predictedTimeline: analysis.predictedTimeline,
          riskOfLoss: analysis.riskOfLoss,
          nextBestAction: analysis.nextBestAction,
        },
      })
      .eq("id", params.contactId)

    revalidatePath("/dashboard/crm")
    return {
      success: true,
      score: analysis.overallScore,
      factors: analysis.factors,
      recommendations: analysis.recommendations,
    }
  } catch (error) {
    console.error("[v0] AI lead scoring error:", error)
    return handleError(error, "aiCalculateLeadScore")
  }
}

/**
 * Generate personalized drip campaign for a lead
 */
export async function aiGenerateDripCampaign(params: {
  contactId: string
  agentId: string
  campaignType: "buyer_nurture" | "seller_nurture" | "past_client" | "sphere" | "investor" | "relocation"
  duration: "30_days" | "60_days" | "90_days" | "6_months" | "12_months"
}): Promise<{ success: boolean; campaign?: any; error?: string }> {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs provided" }
  }

  const supabase = await createClient()

  try {
    // Get contact and agent info
    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.contactId)
      .single()

    const { data: agent } = await supabase
      .from("agents")
      .select("*")
      .eq("id", params.agentId)
      .single()

    if (!contact) {
      return { success: false, error: "Contact not found" }
    }

    const durationDays = {
      "30_days": 30,
      "60_days": 60,
      "90_days": 90,
      "6_months": 180,
      "12_months": 365,
    }[params.duration]

    // AI generates campaign
    const { object: campaign } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        campaignName: z.string(),
        description: z.string(),
        touchpoints: z.array(z.object({
          dayOffset: z.number(),
          channel: z.enum(["email", "sms", "call", "direct_mail", "social"]),
          subject: z.string().optional(),
          content: z.string(),
          purpose: z.string(),
          callToAction: z.string().optional(),
        })),
        totalTouchpoints: z.number(),
        estimatedEngagementRate: z.number(),
        personalizationNotes: z.string(),
      }),
      prompt: `Create a personalized ${params.campaignType} drip campaign for this contact over ${durationDays} days:

CONTACT:
- Name: ${contact.first_name} ${contact.last_name}
- Type: ${contact.contact_type}
- Persona: ${contact.contact_persona}
- Timeline: ${contact.timeline}
- Interests: ${contact.property_preferences ? JSON.stringify(contact.property_preferences) : "Not specified"}
- Notes: ${contact.notes}

AGENT:
- Name: ${agent?.first_name} ${agent?.last_name}
- Specialties: ${agent?.specialties?.join(", ") || "General"}

CAMPAIGN TYPE: ${params.campaignType}
DURATION: ${durationDays} days

Create a mix of email, SMS, and call touchpoints. Space them appropriately (not too frequent).
Each touchpoint should be personalized, provide value, and move the relationship forward.
Include market updates, educational content, and soft check-ins.
Make content warm and personal, not salesy.`,
    })

    // Save campaign
    const { data: savedCampaign, error } = await supabase
      .from("campaign_sequences")
      .insert({
        agent_id: params.agentId,
        contact_id: params.contactId,
        campaign_type: params.campaignType,
        campaign_name: campaign.campaignName,
        description: campaign.description,
        duration_days: durationDays,
        touchpoints: campaign.touchpoints,
        total_touchpoints: campaign.totalTouchpoints,
        status: "draft",
        ai_generated: true,
      })
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard/campaigns")
    return { success: true, campaign: savedCampaign }
  } catch (error) {
    console.error("[v0] AI drip campaign error:", error)
    return handleError(error, "aiGenerateDripCampaign")
  }
}

/**
 * AI-powered follow-up suggestion based on recent activity
 */
export async function aiSuggestFollowUp(params: {
  contactId: string
  agentId: string
}): Promise<{ success: boolean; suggestions?: any[]; error?: string }> {
  if (!isValidUUID(params.contactId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs provided" }
  }

  const supabase = await createClient()

  try {
    // Get contact with recent activity
    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.contactId)
      .single()

    const { data: recentInteractions } = await supabase
      .from("interactions")
      .select("*")
      .eq("contact_id", params.contactId)
      .order("interaction_date", { ascending: false })
      .limit(10)

    const { data: scheduledTasks } = await supabase
      .from("tasks")
      .select("*")
      .eq("contact_id", params.contactId)
      .eq("status", "pending")

    // AI generates suggestions
    const { object: suggestions } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        suggestions: z.array(z.object({
          priority: z.enum(["urgent", "high", "medium", "low"]),
          channel: z.enum(["email", "sms", "call", "in_person"]),
          timing: z.string(),
          reason: z.string(),
          suggestedContent: z.string(),
          expectedOutcome: z.string(),
        })),
        overallUrgency: z.enum(["immediate", "this_week", "next_week", "no_rush"]),
        relationshipHealth: z.enum(["excellent", "good", "needs_attention", "at_risk"]),
        insights: z.array(z.string()),
      }),
      prompt: `Analyze this contact and suggest follow-up actions:

CONTACT:
- Name: ${contact?.first_name} ${contact?.last_name}
- Type: ${contact?.contact_type}
- Status: ${contact?.status}
- Last Contact: ${contact?.last_contact_date}
- Timeline: ${contact?.timeline}

RECENT INTERACTIONS:
${JSON.stringify(recentInteractions, null, 2)}

SCHEDULED TASKS:
${JSON.stringify(scheduledTasks, null, 2)}

Provide 2-4 follow-up suggestions with specific timing and content recommendations.
Consider the relationship stage and avoid being too pushy.`,
    })

    return {
      success: true,
      suggestions: suggestions.suggestions,
    }
  } catch (error) {
    console.error("[v0] AI follow-up suggestion error:", error)
    return handleError(error, "aiSuggestFollowUp")
  }
}

/**
 * Smart lead distribution based on agent strengths
 */
export async function aiDistributeLead(params: {
  leadId: string
  teamId: string
}): Promise<{ success: boolean; assignedTo?: string; reason?: string; error?: string }> {
  if (!isValidUUID(params.leadId) || !isValidUUID(params.teamId)) {
    return { success: false, error: "Invalid IDs provided" }
  }

  const supabase = await createClient()

  try {
    // Get lead info
    const { data: lead } = await supabase
      .from("leads")
      .select("*")
      .eq("id", params.leadId)
      .single()

    // Get team agents
    const { data: agents } = await supabase
      .from("team_members")
      .select("*, agents(*)")
      .eq("team_id", params.teamId)
      .eq("status", "active")

    if (!lead || !agents?.length) {
      return { success: false, error: "Lead or team agents not found" }
    }

    // Get agent performance metrics
    const agentMetrics = await Promise.all(
      agents.map(async (agent) => {
        const { data: closedDeals } = await supabase
          .from("transactions")
          .select("id")
          .eq("agent_id", agent.user_id)
          .eq("status", "closed")
          .gte("close_date", new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString())

        const { data: activeLeads } = await supabase
          .from("contacts")
          .select("id")
          .eq("agent_id", agent.user_id)
          .in("status", ["new", "contacted", "qualified"])

        return {
          ...agent,
          closedDeals: closedDeals?.length || 0,
          activeLeads: activeLeads?.length || 0,
        }
      })
    )

    // AI determines best match
    const { object: assignment } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        assignedAgentId: z.string(),
        matchScore: z.number().min(0).max(100),
        reason: z.string(),
        alternativeAgent: z.string().optional(),
      }),
      prompt: `Match this lead to the best agent on the team:

LEAD:
- Source: ${lead.source}
- Type: ${lead.lead_type}
- Location: ${lead.city}, ${lead.state}
- Price Range: ${lead.price_range}
- Timeline: ${lead.timeline}

AVAILABLE AGENTS:
${agentMetrics.map((a) => `
- ID: ${a.user_id}
- Name: ${a.agents?.first_name} ${a.agents?.last_name}
- Specialties: ${a.agents?.specialties?.join(", ") || "General"}
- Areas: ${a.agents?.service_areas?.join(", ") || "All areas"}
- Closed Deals (12mo): ${a.closedDeals}
- Active Leads: ${a.activeLeads}
`).join("\n")}

Consider: agent expertise, workload balance, location match, and lead type fit.`,
    })

    // Assign lead
    await supabase
      .from("leads")
      .update({
        agent_id: assignment.assignedAgentId,
        ai_assigned: true,
        ai_assignment_reason: assignment.reason,
      })
      .eq("id", params.leadId)

    revalidatePath("/dashboard/leads")
    return {
      success: true,
      assignedTo: assignment.assignedAgentId,
      reason: assignment.reason,
    }
  } catch (error) {
    console.error("[v0] AI lead distribution error:", error)
    return handleError(error, "aiDistributeLead")
  }
}

/**
 * Batch re-engagement for cold leads
 */
export async function aiBatchReengagement(params: {
  agentId: string
  daysInactive: number
  maxLeads?: number
}): Promise<{ success: boolean; reengagementPlan?: any; error?: string }> {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()
  const maxLeads = params.maxLeads || 50

  try {
    const inactiveDate = new Date(Date.now() - params.daysInactive * 24 * 60 * 60 * 1000).toISOString()

    // Get cold leads
    const { data: coldLeads } = await supabase
      .from("contacts")
      .select("*")
      .eq("agent_id", params.agentId)
      .lt("last_contact_date", inactiveDate)
      .in("status", ["contacted", "qualified", "nurturing"])
      .limit(maxLeads)

    if (!coldLeads?.length) {
      return { success: true, reengagementPlan: { message: "No cold leads found", leads: [] } }
    }

    // AI creates re-engagement plan
    const { object: plan } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        totalLeads: z.number(),
        segments: z.array(z.object({
          segmentName: z.string(),
          leadIds: z.array(z.string()),
          reengagementStrategy: z.string(),
          emailTemplate: z.object({
            subject: z.string(),
            body: z.string(),
          }),
          smsTemplate: z.string().optional(),
          priorityOrder: z.number(),
        })),
        expectedRecoveryRate: z.number(),
        recommendations: z.array(z.string()),
      }),
      prompt: `Create a re-engagement plan for these ${coldLeads.length} inactive leads:

COLD LEADS:
${coldLeads.map((l) => `- ${l.id}: ${l.first_name} ${l.last_name}, Type: ${l.contact_type}, Last Contact: ${l.last_contact_date}, Notes: ${l.notes?.substring(0, 100) || "None"}`).join("\n")}

Segment them by similarity and create personalized re-engagement messages.
Focus on providing value, not being pushy.
Include a mix of email and SMS templates.`,
    })

    return { success: true, reengagementPlan: plan }
  } catch (error) {
    console.error("[v0] AI batch re-engagement error:", error)
    return handleError(error, "aiBatchReengagement")
  }
}

/**
 * Predict lead conversion probability
 */
export async function aiPredictConversion(params: {
  contactId: string
}): Promise<{ success: boolean; prediction?: any; error?: string }> {
  if (!isValidUUID(params.contactId)) {
    return { success: false, error: "Invalid contact ID" }
  }

  const supabase = await createClient()

  try {
    const { data: contact } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.contactId)
      .single()

    const { data: interactions } = await supabase
      .from("interactions")
      .select("*")
      .eq("contact_id", params.contactId)

    const { data: propertyViews } = await supabase
      .from("property_views")
      .select("*")
      .eq("contact_id", params.contactId)

    const { object: prediction } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        conversionProbability: z.number().min(0).max(100),
        predictedCloseDate: z.string().optional(),
        confidenceLevel: z.enum(["low", "medium", "high"]),
        keyFactors: z.array(z.object({
          factor: z.string(),
          impact: z.enum(["positive", "negative", "neutral"]),
          weight: z.number(),
        })),
        riskFactors: z.array(z.string()),
        accelerators: z.array(z.string()),
        recommendation: z.string(),
      }),
      prompt: `Predict conversion probability for this lead:

CONTACT:
${JSON.stringify(contact, null, 2)}

INTERACTIONS (${interactions?.length || 0}):
${JSON.stringify(interactions?.slice(0, 20), null, 2)}

PROPERTY VIEWS (${propertyViews?.length || 0}):
${JSON.stringify(propertyViews?.slice(0, 20), null, 2)}

Analyze engagement patterns, timeline, and behavior to predict conversion likelihood.`,
    })

    // Update contact with prediction
    await supabase
      .from("contacts")
      .update({
        ai_conversion_probability: prediction.conversionProbability,
        ai_predicted_close_date: prediction.predictedCloseDate,
      })
      .eq("id", params.contactId)

    return { success: true, prediction }
  } catch (error) {
    console.error("[v0] AI conversion prediction error:", error)
    return handleError(error, "aiPredictConversion")
  }
}
