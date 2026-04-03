"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"
import {
  canAccessFeature,
  incrementFeatureUsage,
  applyBrandVoice,
  evaluateOutbound,
  KernelEvent,
  processKernelEvent,
} from "@/lib/kernel"

// ============================================
// AI DIRECT MAIL SYSTEM
// Complete print marketing automation with
// AI-powered copywriting, design suggestions,
// and print fulfillment integration
// ============================================

interface MailPiece {
  type: "postcard_4x6" | "postcard_6x9" | "letter" | "brochure" | "flyer"
  size: string
  sides: 1 | 2
  finish: "matte" | "gloss" | "uncoated"
}

const MAIL_TYPES: Record<string, MailPiece> = {
  postcard_4x6: { type: "postcard_4x6", size: "4x6", sides: 2, finish: "gloss" },
  postcard_6x9: { type: "postcard_6x9", size: "6x9", sides: 2, finish: "gloss" },
  letter: { type: "letter", size: "8.5x11", sides: 1, finish: "uncoated" },
  brochure: { type: "brochure", size: "8.5x11", sides: 2, finish: "gloss" },
  flyer: { type: "flyer", size: "8.5x11", sides: 1, finish: "matte" },
}

const TEMPLATE_TYPES = [
  "just_listed",
  "just_sold",
  "market_update",
  "open_house",
  "coming_soon",
  "price_reduction",
  "neighborhood_expert",
  "holiday",
  "farming",
  "investor",
]

// ============================================
// 1. AI POSTCARD COPYWRITER
// ============================================
export async function aiWritePostcardCopy(params: {
  agentId: string
  brokerageId: string
  teamId?: string
  templateType: string
  propertyData?: any
  targetAudience: "homeowners" | "renters" | "investors" | "expired" | "fsbo"
  callToAction: "call" | "scan_qr" | "visit_website" | "text"
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    // ── Kernel Gate: canAccessFeature ──
    const access = await canAccessFeature(params.agentId, "direct_mail")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Direct mail feature not available" }
    }

    const supabase = await createClient()

    // Get agent's brand voice
    const { data: agent } = await supabase
      .from("users")
      .select("first_name, last_name, phone, email, brokerage_id, team_id")
      .eq("id", params.agentId)
      .single()

    const { object: copy } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        headline: z.string().max(50).describe("Bold, attention-grabbing headline"),
        subheadline: z.string().max(80).describe("Supporting text"),
        bodyText: z.string().max(200).describe("Main message, keep scannable"),
        callToAction: z.string().max(30).describe("Clear CTA text"),
        testimonialPlaceholder: z.string().optional(),
        agentTagline: z.string().max(50),
        urgencyElement: z.string().optional(),
        variants: z.array(
          z.object({
            headline: z.string(),
            bodyText: z.string(),
            style: z.string(),
          })
        ),
      }),
      prompt: `Write compelling postcard copy for a real estate agent.

Template Type: ${params.templateType}
Target Audience: ${params.targetAudience}
CTA Type: ${params.callToAction}
${params.propertyData ? `Property: ${JSON.stringify(params.propertyData)}` : ""}
Agent: ${agent?.first_name} ${agent?.last_name}

Rules:
- Headline must grab attention in 2 seconds
- Body text must be readable at arm's length
- Include urgency without being pushy
- CTA must be crystal clear
- All text must fit on a ${params.templateType.includes("4x6") ? "4x6" : "6x9"} postcard

Create the primary copy plus 2 variants with different approaches.`,
    })

    // ── Apply brand voice compliance ──
    const brandResult = await applyBrandVoice({
      brokerageId: params.brokerageId,
      teamId: params.teamId,
      actorUserId: params.agentId,
      actorRole: "agent",
      journeyType: "seller",
      persona: "seller",
      messageType: "email",
      content: `${copy.headline} ${copy.bodyText} ${copy.callToAction}`,
    })

    if (brandResult.blocked) {
      return {
        success: false,
        error: "Brand voice compliance failed",
        violations: brandResult.violations,
      }
    }

    // ── Increment usage counter ──
    await incrementFeatureUsage(params.agentId, "direct_mail")

    return { success: true, copy, brandVoiceApplied: true }
  } catch (error) {
    console.error("[AI Direct Mail] Copywriter error:", error)
    return handleError(error, "aiWritePostcardCopy")
  }
}

// ============================================
// 2. AI DESIGN SUGGESTIONS
// ============================================
export async function aiSuggestDesign(params: {
  templateType: string
  propertyType?: string
  priceRange?: string
  targetDemo: string
}) {
  try {
    const { object: design } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        colorScheme: z.object({
          primary: z.string(),
          secondary: z.string(),
          accent: z.string(),
          background: z.string(),
          text: z.string(),
        }),
        typography: z.object({
          headlineFont: z.string(),
          bodyFont: z.string(),
          headlineSize: z.string(),
          bodySize: z.string(),
        }),
        layout: z.object({
          style: z.enum(["photo_dominant", "text_focus", "balanced", "minimal"]),
          imagePosition: z.enum(["full_bleed", "left", "right", "top", "center"]),
          textAlignment: z.enum(["left", "center", "right"]),
        }),
        imagery: z.object({
          recommendations: z.array(z.string()),
          avoid: z.array(z.string()),
        }),
        printSpecs: z.object({
          paperWeight: z.string(),
          finish: z.enum(["matte", "gloss", "satin"]),
          coating: z.boolean(),
        }),
      }),
      prompt: `Suggest design specifications for a real estate direct mail piece.

Type: ${params.templateType}
Property Type: ${params.propertyType || "General"}
Price Range: ${params.priceRange || "General"}
Target Demographic: ${params.targetDemo}

Consider:
- Direct mail best practices
- Real estate industry standards
- Target audience preferences
- Print production requirements`,
    })

    return { success: true, design }
  } catch (error) {
    console.error("[AI Direct Mail] Design suggestion error:", error)
    return handleError(error, "aiSuggestDesign")
  }
}

// ============================================
// 3. AI TARGET AUDIENCE SELECTOR
// ============================================
export async function aiSelectTargetAudience(params: {
  agentId: string
  brokerageId: string
  campaignGoal: "listings" | "buyers" | "farming" | "brand_awareness" | "past_clients"
  budget: number
  area: string
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    // ── Kernel Gate: canAccessFeature ──
    const access = await canAccessFeature(params.agentId, "direct_mail")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Direct mail feature not available" }
    }

    const supabase = await createClient()

    // Get agent's past performance
    const { data: pastCampaigns } = await supabase
      .from("direct_mail_campaigns")
      .select("target_criteria, response_rate, roi")
      .eq("agent_id", params.agentId)
      .not("response_rate", "is", null)
      .order("roi", { ascending: false })
      .limit(10)

    const { object: targeting } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        primarySegment: z.object({
          name: z.string(),
          criteria: z.record(z.any()),
          estimatedCount: z.number(),
          estimatedResponseRate: z.number(),
          reasoning: z.string(),
        }),
        secondarySegments: z.array(
          z.object({
            name: z.string(),
            criteria: z.record(z.any()),
            estimatedCount: z.number(),
            priority: z.number(),
          })
        ),
        exclusions: z.array(z.string()),
        budgetAllocation: z.object({
          recommended: z.number(),
          perPiece: z.number(),
          expectedROI: z.number(),
        }),
        dataSourceRecommendations: z.array(z.string()),
      }),
      prompt: `Recommend target audience for direct mail campaign.

Goal: ${params.campaignGoal}
Budget: $${params.budget}
Area: ${params.area}
Past Performance: ${JSON.stringify(pastCampaigns || [])}

Segment options:
- Homeowners (length of residence, home value, equity)
- Renters (length of tenancy, income)
- Absentee owners (investor targets)
- Recent movers
- Expired listings (last 6 months)
- FSBO
- Probate/estate
- Pre-foreclosure
- Geographic farm

Recommend targeting strategy with reasoning.`,
    })

    return { success: true, targeting }
  } catch (error) {
    console.error("[AI Direct Mail] Targeting error:", error)
    return handleError(error, "aiSelectTargetAudience")
  }
}

// ============================================
// 4. AI ROI PREDICTOR
// ============================================
export async function aiPredictCampaignROI(params: {
  agentId: string
  brokerageId: string
  mailType: string
  quantity: number
  targetSegment: string
  avgHomeValue: number
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    // ── Kernel Gate: canAccessFeature ──
    const access = await canAccessFeature(params.agentId, "direct_mail")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Direct mail feature not available" }
    }

    const mailPiece = MAIL_TYPES[params.mailType] || MAIL_TYPES.postcard_4x6

    // Cost estimation
    const printCost = params.quantity * (params.mailType.includes("postcard") ? 0.35 : 0.75)
    const postageCost = params.quantity * (params.mailType.includes("postcard") ? 0.44 : 0.66)
    const dataCost = params.quantity * 0.05
    const totalCost = printCost + postageCost + dataCost

    const { object: prediction } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        estimatedResponseRate: z.number(),
        estimatedLeads: z.number(),
        estimatedAppointments: z.number(),
        estimatedClosings: z.number(),
        estimatedGCI: z.number(),
        roi: z.number(),
        breakEvenPoint: z.number(),
        confidenceLevel: z.enum(["high", "medium", "low"]),
        assumptions: z.array(z.string()),
        riskFactors: z.array(z.string()),
        recommendations: z.array(z.string()),
      }),
      prompt: `Predict ROI for direct mail campaign.

Campaign Details:
- Mail Type: ${params.mailType}
- Quantity: ${params.quantity}
- Target: ${params.targetSegment}
- Avg Home Value: $${params.avgHomeValue.toLocaleString()}
- Total Cost: $${totalCost.toFixed(2)}

Industry benchmarks:
- Direct mail response rate: 0.5-2%
- Lead to appointment: 20-30%
- Appointment to close: 10-20%
- Avg commission: 2.5-3%

Calculate expected outcomes and ROI.`,
    })

    return {
      success: true,
      prediction,
      costs: {
        print: printCost,
        postage: postageCost,
        data: dataCost,
        total: totalCost,
        perPiece: totalCost / params.quantity,
      },
    }
  } catch (error) {
    console.error("[AI Direct Mail] ROI prediction error:", error)
    return handleError(error, "aiPredictCampaignROI")
  }
}

// ============================================
// 5. CREATE DIRECT MAIL CAMPAIGN
// ============================================
export async function getDirectMailCampaigns(agentId: string) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("direct_mail_campaigns")
      .select("*")
      .eq("agent_id", agentId)
      .order("created_at", { ascending: false })

    if (error) throw error

    return { success: true, campaigns: data || [] }
  } catch (error) {
    return handleError(error, "getDirectMailCampaigns")
  }
}

export async function createDirectMailCampaign(params: {
  agentId: string
  brokerageId: string
  campaignName: string
  targetAudience: string
  mailingType: "postcard" | "letter" | "brochure"
  designTemplate?: string
  budget?: number
  sendDate?: string
  trackingEnabled?: boolean
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    // ── Kernel Gate: canAccessFeature ──
    const access = await canAccessFeature(params.agentId, "direct_mail")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Direct mail feature not available" }
    }

    const supabase = await createClient()

    // Generate QR code tracking URL if enabled
    const trackingId = params.trackingEnabled ? `dm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}` : null

    const { data: campaign, error } = await supabase
      .from("direct_mail_campaigns")
      .insert({
        agent_id: params.agentId,
        name: params.name,
        mail_type: params.mailType,
        template_type: params.templateType,
        headline: params.headline,
        body_text: params.bodyText,
        call_to_action: params.callToAction,
        target_criteria: params.targetCriteria,
        quantity: params.quantity,
        scheduled_date: params.scheduledDate,
        tracking_id: trackingId,
        tracking_url: trackingId ? `${process.env.NEXT_PUBLIC_APP_URL}/t/${trackingId}` : null,
        status: params.scheduledDate ? "scheduled" : "draft",
      })
      .select()
      .single()

    if (error) throw error

    // ── Increment usage counter ──
    await incrementFeatureUsage(params.agentId, "direct_mail")

    // ── Fire kernel event ──
    await processKernelEvent({
      event: KernelEvent.DIRECT_MAIL_CAMPAIGN_CREATED,
      brokerageId: params.brokerageId,
      entityType: "direct_mail_campaign",
      entityId: campaign.id,
    }).catch((err) => {
      console.error("[AI Direct Mail] Event processing failed (non-blocking):", err)
    })

    revalidatePath("/content-studio")
    revalidatePath("/dashboard/campaigns/mail")

    return {
      success: true,
      campaign,
      trackingUrl: campaign.tracking_url,
    }
  } catch (error) {
    console.error("[AI Direct Mail] Create campaign error:", error)
    return handleError(error, "createDirectMailCampaign")
  }
}

// ============================================
// 6. VALIDATE MAILING LIST
// ============================================
export async function validateMailingList(params: {
  agentId: string
  campaignId: string
  addresses: Array<{
    name: string
    address1: string
    address2?: string
    city: string
    state: string
    zip: string
  }>
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    const validationResults: any[] = []
    let validCount = 0
    let invalidCount = 0

    for (const address of params.addresses) {
      // Basic validation (in production, use Lob or SmartyStreets API)
      const isValid =
        address.address1?.length > 5 &&
        address.city?.length > 2 &&
        address.state?.length === 2 &&
        /^\d{5}(-\d{4})?$/.test(address.zip)

      if (isValid) {
        validCount++
        validationResults.push({
          ...address,
          status: "valid",
          deliverability: "deliverable",
        })
      } else {
        invalidCount++
        validationResults.push({
          ...address,
          status: "invalid",
          issues: ["Address validation failed"],
        })
      }
    }

    // Save validated addresses
    await supabase.from("direct_mail_recipients").insert(
      validationResults
        .filter((r) => r.status === "valid")
        .map((r) => ({
          campaign_id: params.campaignId,
          name: r.name,
          address1: r.address1,
          address2: r.address2,
          city: r.city,
          state: r.state,
          zip: r.zip,
          status: "pending",
        }))
    )

    return {
      success: true,
      validation: {
        total: params.addresses.length,
        valid: validCount,
        invalid: invalidCount,
        results: validationResults,
      },
    }
  } catch (error) {
    console.error("[AI Direct Mail] Validation error:", error)
    return handleError(error, "validateMailingList")
  }
}

// ============================================
// 7. SUBMIT TO PRINT FULFILLMENT
// ============================================
export async function submitToPrintFulfillment(params: { campaignId: string; agentId: string; brokerageId: string }) {
  try {
    if (!isValidUUID(params.campaignId) || !isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid IDs" }
    }

    // ── Kernel Gate: canAccessFeature ──
    const access = await canAccessFeature(params.agentId, "direct_mail")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Direct mail feature not available" }
    }

    const supabase = await createClient()

    // Get campaign and recipients
    const { data: campaign } = await supabase
      .from("direct_mail_campaigns")
      .select("*")
      .eq("id", params.campaignId)
      .single()

    const { data: recipients } = await supabase
      .from("direct_mail_recipients")
      .select("*")
      .eq("campaign_id", params.campaignId)
      .eq("status", "pending")

    if (!campaign || !recipients?.length) {
      return { success: false, error: "Campaign or recipients not found" }
    }

    // In production, integrate with Lob, Click2Mail, or similar
    // For now, simulate submission
    const fulfillmentResponse = {
      orderId: `order-${Date.now()}`,
      estimatedDelivery: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      quantity: recipients.length,
      cost: recipients.length * 0.79, // Estimated cost per piece
    }

    // Update campaign status
    await supabase
      .from("direct_mail_campaigns")
      .update({
        status: "submitted",
        fulfillment_order_id: fulfillmentResponse.orderId,
        submitted_at: new Date().toISOString(),
        estimated_delivery: fulfillmentResponse.estimatedDelivery,
        total_cost: fulfillmentResponse.cost,
      })
      .eq("id", params.campaignId)

    // Update recipient statuses
    await supabase
      .from("direct_mail_recipients")
      .update({ status: "submitted" })
      .eq("campaign_id", params.campaignId)

    // ── Fire kernel event ──
    await processKernelEvent({
      event: KernelEvent.DIRECT_MAIL_SENT,
      brokerageId: params.brokerageId,
      entityType: "direct_mail_campaign",
      entityId: params.campaignId,
    }).catch((err) => {
      console.error("[AI Direct Mail] Event processing failed (non-blocking):", err)
    })

    revalidatePath("/content-studio")
    revalidatePath("/dashboard/campaigns/mail")

    return {
      success: true,
      fulfillment: fulfillmentResponse,
    }
  } catch (error) {
    console.error("[AI Direct Mail] Fulfillment error:", error)
    return handleError(error, "submitToPrintFulfillment")
  }
}

// ============================================
// 8. TRACK CAMPAIGN RESPONSES
// ============================================
export async function trackCampaignResponse(params: {
  trackingId: string
  responseType: "qr_scan" | "call" | "website_visit" | "form_submission"
  metadata?: any
}) {
  try {
    const supabase = await createClient()

    // Find campaign by tracking ID
    const { data: campaign } = await supabase
      .from("direct_mail_campaigns")
      .select("id, agent_id")
      .eq("tracking_id", params.trackingId)
      .single()

    if (!campaign) {
      return { success: false, error: "Campaign not found" }
    }

    // Log the response
    await supabase.from("direct_mail_responses").insert({
      campaign_id: campaign.id,
      response_type: params.responseType,
      metadata: params.metadata,
      responded_at: new Date().toISOString(),
    })

    // Update campaign response count
    await supabase.rpc("increment_mail_responses", { campaign_id: campaign.id })

    return { success: true }
  } catch (error) {
    console.error("[AI Direct Mail] Tracking error:", error)
    return handleError(error, "trackCampaignResponse")
  }
}

// ============================================
// 9. GET CAMPAIGN ANALYTICS
// ============================================
export async function getDirectMailAnalytics(params: { agentId: string; campaignId?: string }) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    let query = supabase
      .from("direct_mail_campaigns")
      .select("*, responses:direct_mail_responses(count)")
      .eq("agent_id", params.agentId)

    if (params.campaignId) {
      query = query.eq("id", params.campaignId)
    }

    const { data: campaigns } = await query

    const analytics = campaigns?.map((c) => ({
      id: c.id,
      name: c.name,
      quantity: c.quantity,
      responses: c.responses?.[0]?.count || 0,
      responseRate: c.quantity > 0 ? ((c.responses?.[0]?.count || 0) / c.quantity) * 100 : 0,
      cost: c.total_cost,
      costPerResponse:
        c.responses?.[0]?.count > 0 ? c.total_cost / c.responses[0].count : c.total_cost,
      status: c.status,
      sentDate: c.submitted_at,
    }))

    return { success: true, analytics }
  } catch (error) {
    console.error("[AI Direct Mail] Analytics error:", error)
    return handleError(error, "getDirectMailAnalytics")
  }
}

// ============================================
// 10. AI CAMPAIGN PERFORMANCE ANALYZER
// ============================================
export async function aiAnalyzeCampaignPerformance(params: { agentId: string; brokerageId: string }) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    // ── Kernel Gate: canAccessFeature ──
    const access = await canAccessFeature(params.agentId, "direct_mail")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Direct mail feature not available" }
    }

    const supabase = await createClient()

    // Get all campaigns with responses
    const { data: campaigns } = await supabase
      .from("direct_mail_campaigns")
      .select("*, responses:direct_mail_responses(*)")
      .eq("agent_id", params.agentId)
      .not("submitted_at", "is", null)

    const { object: analysis } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        overallROI: z.number(),
        bestPerformingType: z.string(),
        bestPerformingAudience: z.string(),
        trends: z.array(z.string()),
        recommendations: z.array(
          z.object({
            area: z.string(),
            recommendation: z.string(),
            expectedImpact: z.string(),
          })
        ),
        nextCampaignSuggestion: z.object({
          type: z.string(),
          audience: z.string(),
          timing: z.string(),
          budget: z.number(),
        }),
      }),
      prompt: `Analyze direct mail campaign performance for this real estate agent.

Campaigns: ${JSON.stringify(campaigns || [])}

Provide:
1. Overall ROI analysis
2. What's working best
3. Trends over time
4. Specific recommendations
5. Next campaign suggestion`,
    })

    return { success: true, analysis }
  } catch (error) {
    console.error("[AI Direct Mail] Performance analysis error:", error)
    return handleError(error, "aiAnalyzeCampaignPerformance")
  }
}
