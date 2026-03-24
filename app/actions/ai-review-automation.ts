"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "ai"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"

/**
 * AI Review & Testimonial Automation System
 * Handles review requests, sentiment analysis, response generation, and reputation management
 */

// ============================================================================
// AI REVIEW REQUEST TIMING
// ============================================================================

export async function aiDetermineReviewTiming(params: {
  transactionId: string
  agentId: string
}) {
  if (!isValidUUID(params.transactionId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    // Get transaction and client sentiment data
    const { data: transaction } = await supabase
      .from("transactions")
      .select(`
        *,
        contacts(*),
        interactions(interaction_type, notes, sentiment, interaction_date)
      `)
      .eq("id", params.transactionId)
      .single()

    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    const recentInteractions = transaction.interactions?.slice(0, 10) || []
    const sentimentScores = recentInteractions
      .filter((i: any) => i.sentiment)
      .map((i: any) => i.sentiment)

    const { object: timing } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        readyForReview: z.boolean(),
        confidence: z.number().min(0).max(100),
        optimalTiming: z.enum(["immediate", "wait_3_days", "wait_1_week", "wait_2_weeks", "not_recommended"]),
        reasoning: z.string(),
        sentimentAssessment: z.enum(["euphoric", "positive", "neutral", "negative", "at_risk"]),
        preReviewActions: z.array(z.object({
          action: z.string(),
          priority: z.enum(["high", "medium", "low"]),
          script: z.string(),
        })),
        bestChannel: z.enum(["email", "text", "phone", "in_person"]),
        bestTimeOfDay: z.string(),
      }),
      prompt: `Analyze this transaction to determine optimal review request timing:

Transaction: ${transaction.property_address || "Property"}
Close date: ${transaction.close_date}
Client: ${transaction.contacts?.first_name} ${transaction.contacts?.last_name}
Days since close: ${transaction.close_date ? Math.floor((Date.now() - new Date(transaction.close_date).getTime()) / (1000 * 60 * 60 * 24)) : "N/A"}

Recent interaction sentiment: ${JSON.stringify(sentimentScores)}
Last interaction notes: ${recentInteractions[0]?.notes || "None"}

Determine:
1. Is client ready for a review request?
2. Optimal timing (immediate, wait, or not recommended)
3. Current sentiment assessment
4. Any pre-review actions needed (address concerns first)
5. Best channel and time of day to ask`,
    })

    // Save timing recommendation
    await supabase.from("review_timing_analysis").insert({
      transaction_id: params.transactionId,
      agent_id: params.agentId,
      analysis: timing,
      created_at: new Date().toISOString(),
    })

    return { success: true, data: timing }
  } catch (error) {
    return handleError(error, "aiDetermineReviewTiming")
  }
}

// ============================================================================
// AI REVIEW REQUEST GENERATION
// ============================================================================

export async function aiGenerateReviewRequest(params: {
  transactionId: string
  agentId: string
  platform: "google" | "zillow" | "realtor" | "facebook" | "yelp"
  channel: "email" | "text" | "in_person"
}) {
  if (!isValidUUID(params.transactionId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: transaction } = await supabase
      .from("transactions")
      .select(`
        *,
        contacts(first_name, last_name, email, phone)
      `)
      .eq("id", params.transactionId)
      .single()

    const { data: agent } = await supabase
      .from("agents")
      .select("first_name, last_name")
      .eq("id", params.agentId)
      .single()

    if (!transaction) {
      return { success: false, error: "Transaction not found" }
    }

    // Platform-specific review URLs
    const platformUrls: Record<string, string> = {
      google: "https://g.page/r/YOUR_PLACE_ID/review",
      zillow: "https://www.zillow.com/profile/YOUR_ID/reviews",
      realtor: "https://www.realtor.com/realestateagents/YOUR_ID/reviews",
      facebook: "https://facebook.com/YOUR_PAGE/reviews",
      yelp: "https://www.yelp.com/writeareview/biz/YOUR_BIZ_ID",
    }

    const { object: request } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        subject: z.string().optional(),
        message: z.string(),
        callScript: z.string().optional(),
        keyPoints: z.array(z.string()),
        personalizedOpener: z.string(),
        softAsk: z.string(),
        directAsk: z.string(),
        followUpSequence: z.array(z.object({
          day: z.number(),
          channel: z.string(),
          message: z.string(),
        })),
      }),
      prompt: `Generate a ${params.channel} review request for ${params.platform}:

Agent: ${agent?.first_name} ${agent?.last_name}
Client: ${transaction.contacts?.first_name} ${transaction.contacts?.last_name}
Property: ${transaction.property_address}
Transaction type: ${transaction.deal_type}
Close date: ${transaction.close_date}

Guidelines:
- Be genuine and grateful, not pushy
- Reference specific positive moments from the transaction
- Make it easy with a direct link
- For ${params.platform}, the review URL is: ${platformUrls[params.platform]}

Generate:
1. ${params.channel === "email" ? "Email subject and body" : params.channel === "text" ? "Text message (under 300 chars)" : "In-person script"}
2. Key points to mention
3. Both a soft ask and direct ask version
4. 3-touch follow-up sequence if no response`,
    })

    // Save the request
    await supabase.from("review_requests").insert({
      transaction_id: params.transactionId,
      agent_id: params.agentId,
      contact_id: transaction.contact_id,
      platform: params.platform,
      channel: params.channel,
      content: request,
      status: "pending",
      created_at: new Date().toISOString(),
    })

    return { success: true, data: request }
  } catch (error) {
    return handleError(error, "aiGenerateReviewRequest")
  }
}

// ============================================================================
// AI REVIEW RESPONSE GENERATOR
// ============================================================================

export async function aiGenerateReviewResponse(params: {
  reviewId: string
  agentId: string
  reviewText: string
  rating: number
  platform: string
  reviewerName: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    const { data: agent } = await supabase
      .from("agents")
      .select("first_name, last_name")
      .eq("id", params.agentId)
      .single()

    const isPositive = params.rating >= 4
    const isNegative = params.rating <= 2

    const { object: response } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        publicResponse: z.string(),
        internalNotes: z.string(),
        sentiment: z.enum(["positive", "neutral", "negative", "mixed"]),
        keyThemes: z.array(z.string()),
        actionItems: z.array(z.object({
          action: z.string(),
          priority: z.enum(["high", "medium", "low"]),
          assignTo: z.string(),
        })),
        escalationNeeded: z.boolean(),
        privateFollowUp: z.string().optional(),
      }),
      prompt: `Generate a response to this ${params.platform} review:

Reviewer: ${params.reviewerName}
Rating: ${params.rating}/5 stars
Review: "${params.reviewText}"
Agent: ${agent?.first_name} ${agent?.last_name}

Guidelines:
${isPositive ? `
- Thank them warmly and specifically
- Reference details they mentioned
- Express genuine appreciation
- Invite referrals subtly
` : isNegative ? `
- Acknowledge their concerns professionally
- Don't be defensive
- Offer to discuss offline
- Show commitment to improvement
- Keep it brief and professional
` : `
- Thank them for feedback
- Address any specific points
- Maintain professional tone
`}

Generate:
1. Public response (appropriate length for ${params.platform})
2. Internal notes for team
3. Key themes identified
4. Any action items needed
5. Whether escalation is needed
6. Private follow-up message if appropriate`,
    })

    // Save the response
    await supabase.from("review_responses").insert({
      review_id: params.reviewId,
      agent_id: params.agentId,
      platform: params.platform,
      original_review: params.reviewText,
      rating: params.rating,
      response: response,
      status: "draft",
      created_at: new Date().toISOString(),
    })

    revalidatePath("/reviews")
    return { success: true, data: response }
  } catch (error) {
    return handleError(error, "aiGenerateReviewResponse")
  }
}

// ============================================================================
// AI NEGATIVE REVIEW RECOVERY
// ============================================================================

export async function aiCreateRecoveryPlan(params: {
  reviewId: string
  agentId: string
  reviewText: string
  rating: number
  clientId?: string
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get client history if available
    let clientHistory = null
    if (params.clientId && isValidUUID(params.clientId)) {
      const { data } = await supabase
        .from("contacts")
        .select(`
          *,
          transactions(*),
          interactions(*)
        `)
        .eq("id", params.clientId)
        .single()
      clientHistory = data
    }

    const { object: recoveryPlan } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        severity: z.enum(["critical", "serious", "moderate", "minor"]),
        rootCauseAnalysis: z.array(z.string()),
        immediateActions: z.array(z.object({
          action: z.string(),
          owner: z.string(),
          deadline: z.string(),
          script: z.string(),
        })),
        recoveryOutreach: z.object({
          channel: z.string(),
          timing: z.string(),
          message: z.string(),
          offerCompensation: z.boolean(),
          compensationType: z.string().optional(),
        }),
        publicResponseStrategy: z.string(),
        internalProcessChanges: z.array(z.string()),
        successMetrics: z.array(z.string()),
        escalationPath: z.string(),
      }),
      prompt: `Create a recovery plan for this negative review:

Rating: ${params.rating}/5
Review: "${params.reviewText}"
${clientHistory ? `
Client history:
- Total transactions: ${clientHistory.transactions?.length || 0}
- Total interactions: ${clientHistory.interactions?.length || 0}
- Last interaction: ${clientHistory.interactions?.[0]?.notes || "N/A"}
` : "No client history available"}

Create a comprehensive recovery plan including:
1. Severity assessment
2. Root cause analysis
3. Immediate action items with scripts
4. Outreach strategy to the client
5. Public response approach
6. Internal process improvements
7. Success metrics`,
    })

    // Save recovery plan
    await supabase.from("review_recovery_plans").insert({
      review_id: params.reviewId,
      agent_id: params.agentId,
      client_id: params.clientId,
      plan: recoveryPlan,
      status: "active",
      created_at: new Date().toISOString(),
    })

    return { success: true, data: recoveryPlan }
  } catch (error) {
    return handleError(error, "aiCreateRecoveryPlan")
  }
}

// ============================================================================
// AI TESTIMONIAL EXTRACTION
// ============================================================================

export async function aiExtractTestimonials(params: {
  agentId: string
  source: "reviews" | "emails" | "texts" | "surveys"
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get positive reviews/feedback
    const { data: reviews } = await supabase
      .from("agent_reviews")
      .select("*")
      .eq("agent_id", params.agentId)
      .gte("rating", 4)
      .order("created_at", { ascending: false })
      .limit(50)

    if (!reviews || reviews.length === 0) {
      return { success: true, data: { testimonials: [] } }
    }

    const { object: extraction } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        testimonials: z.array(z.object({
          originalText: z.string(),
          extractedQuote: z.string(),
          themes: z.array(z.string()),
          useCase: z.array(z.enum(["website", "social", "email", "print", "video"])),
          clientName: z.string(),
          propertyType: z.string().optional(),
          impactScore: z.number().min(1).max(10),
        })),
        themeAnalysis: z.object({
          topStrengths: z.array(z.string()),
          frequentPraise: z.array(z.string()),
          uniqueDifferentiators: z.array(z.string()),
        }),
        recommendations: z.array(z.string()),
      }),
      prompt: `Extract compelling testimonials from these reviews:

${reviews.map(r => `---
Rating: ${r.rating}/5
From: ${r.reviewer_name}
Review: "${r.review_text}"
Date: ${r.created_at}
---`).join("\n")}

For each review:
1. Extract the most quotable portion
2. Identify themes (responsiveness, knowledge, negotiation, etc.)
3. Suggest best use cases (website, social media, email, print, video)
4. Score impact (1-10)

Also provide:
- Analysis of top strengths mentioned
- Most frequent praise points
- Unique differentiators to highlight`,
    })

    return { success: true, data: extraction }
  } catch (error) {
    return handleError(error, "aiExtractTestimonials")
  }
}

// ============================================================================
// AI REVIEW MONITORING ALERTS
// ============================================================================

export async function aiSetupReviewMonitoring(params: {
  agentId: string
  platforms: string[]
  alertThreshold: number
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Save monitoring configuration
    const { data: config } = await supabase
      .from("review_monitoring_config")
      .upsert({
        agent_id: params.agentId,
        platforms: params.platforms,
        alert_threshold: params.alertThreshold,
        notification_email: true,
        notification_sms: true,
        auto_respond_positive: false,
        escalate_negative: true,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single()

    return {
      success: true,
      data: {
        configId: config?.id,
        message: `Review monitoring configured for ${params.platforms.join(", ")}. You'll be alerted for reviews ${params.alertThreshold} stars or below.`,
      },
    }
  } catch (error) {
    return handleError(error, "aiSetupReviewMonitoring")
  }
}
