"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"
import {
  canAccessFeature,
  incrementFeatureUsage,
  KernelEvent,
  processKernelEvent,
} from "@/lib/kernel"
import { applyKernelBrandVoice, isBrandVoiceBlocked } from "@/lib/kernel/adapters/brand-voice"
import {
  createMailCampaign,
  addRecipients,
  sendCampaign,
  logResponse,
} from "@/app/actions/direct-mail"
import { createQrCodeAction } from "@/app/actions/marketing-studio"

// Direct mail piece types — matches the piece_type column on direct_mail_campaigns.
export type DirectMailPieceType = "postcard" | "letter" | "handwritten_letter" | "thank_you_note"

// Build a public QR PNG URL using a free renderer service. The QR resolves to
// /api/qr/scan?slug=<slug>, which records the scan and redirects to the landing.
function buildQrImageUrl(absoluteScanUrl: string, size = 300) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(absoluteScanUrl)}`
}

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
  targetAudience:
    | "homeowners"
    | "renters"
    | "fsbo"
    | "expired"
    | "divorce_probate"
    | "investors"
    | "lifetime_customers"
    | "geographic_farm"
    | "new_movers"
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
        const brandResult = await applyKernelBrandVoice({
      brokerageId: params.brokerageId,
      teamId: params.teamId,
      actorUserId: params.agentId,
      actorRole: "agent",
      journeyType: "marketing",
      persona: "seller",
      messageType: "email",
      content: `${copy.headline} ${copy.bodyText} ${copy.callToAction}`,
    })

    if (isBrandVoiceBlocked(brandResult)) {
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
  campaignGoal: "listings" | "buyers" | "farming" | "brand_awareness" | "lifetime_customers"
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
          criteria: z.record(z.string(), z.any()),
          estimatedCount: z.number(),
          estimatedResponseRate: z.number(),
          reasoning: z.string(),
        }),
        secondarySegments: z.array(
          z.object({
            name: z.string(),
            criteria: z.record(z.string(), z.any()),
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

/**
 * AI-enhanced direct mail campaign creation.
 *
 * NOTE — overlaps with `createMailCampaign` in `app/actions/direct-mail.ts`.
 * Both insert into `direct_mail_campaigns`. Long-term plan: this function
 * should DELEGATE the table insert to `createMailCampaign` and only layer
 * AI-driven content (ai-generated copy, audience selection, ROI prediction)
 * on top. Until that consolidation lands, callers should prefer:
 *   - `createDirectMailCampaign` (this fn) for AI-driven flows
 *   - `createMailCampaign` for manual / minimal flows
 * Do NOT introduce a third creator.
 */
export async function createDirectMailCampaign(params: {
  agentId: string
  brokerageId: string
  campaignName: string
  targetAudience: string
  mailingType: "postcard" | "letter" | "brochure"
  pieceType?: DirectMailPieceType
  designTemplate?: string
  budget?: number
  sendDate?: string
  trackingEnabled?: boolean
  /** Optional absolute origin (e.g. "https://app.example.com"); QR link defaults
   *  to NEXT_PUBLIC_APP_URL or a relative path if not provided. */
  appOrigin?: string
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const access = await canAccessFeature(params.agentId, "direct_mail")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Direct mail feature not available" }
    }

    const quantity =
      params.budget && params.budget > 0
        ? Math.max(1, Math.floor(params.budget / 0.79))
        : 100

    const perPieceCost =
      params.budget && quantity > 0
        ? Number((params.budget / quantity).toFixed(2))
        : 0.79
    const trackingId = params.trackingEnabled
      ? `dm-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
      : null

    const campaignResult = await createMailCampaign({
      brokerageId: params.brokerageId,
      agentId: params.agentId,
      campaignName: params.campaignName,
      targetAudience: params.targetAudience,
      designUrl: params.designTemplate ?? undefined,
      copyText: [params.campaignName, params.targetAudience].filter(Boolean).join(" "),
      quantity,
      mailingDate: params.sendDate ?? undefined,
      perPieceCost,
      createdBy: params.agentId,
    })

    if (!campaignResult.success) {
      return {
        success: false,
        error: campaignResult.error || "Failed to create direct mail campaign",
      }
    }

    const campaign = campaignResult.campaign as { id: string } | null
    const supabase = await createClient()
    const pieceType: DirectMailPieceType = params.pieceType ?? "postcard"

    // Persist piece type + tracking id on the campaign row regardless of QR.
    if (campaign?.id) {
      await supabase
        .from("direct_mail_campaigns")
        .update({ piece_type: pieceType, tracking_id: trackingId })
        .eq("id", campaign.id)
    }

    // Generate the QR code + image URL when tracking is enabled.
    let qrCodeId: string | null = null
    let qrSlug: string | null = null
    let qrImageUrl: string | null = null
    let trackingUrl: string | null = null

    if (params.trackingEnabled && trackingId && campaign?.id) {
      const origin =
        params.appOrigin ?? process.env.NEXT_PUBLIC_APP_URL ?? ""
      // Pre-build the canonical scan URL; the QR slug will be embedded once
      // createQrCodeAction returns it. We use the trackingId as a stable label.
      const qrResult = await createQrCodeAction({
        brokerageId: params.brokerageId,
        agentId: params.agentId,
        label: `${params.campaignName} (${trackingId})`,
        targetUrl: `${origin}/api/qr/scan?slug=__placeholder__`,
        purpose: "campaign",
      })

      if (qrResult.success && qrResult.qrCode) {
        qrCodeId = qrResult.qrCode.id
        qrSlug = qrResult.qrCode.slug
        const scanUrl = `${origin}/api/qr/scan?slug=${qrResult.qrCode.slug}`

        // Update qr_codes.target_url with the real scan URL now that we know the slug.
        await supabase
          .from("qr_codes")
          .update({ target_url: scanUrl })
          .eq("id", qrResult.qrCode.id)

        // Link the QR to the campaign for scan attribution.
        await supabase
          .from("direct_mail_campaigns")
          .update({ qr_code_id: qrResult.qrCode.id })
          .eq("id", campaign.id)

        trackingUrl = scanUrl
        qrImageUrl = buildQrImageUrl(scanUrl)
      }
    }

    revalidatePath("/content-studio")
    revalidatePath("/dashboard/campaigns/mail")

    return {
      success: true,
      campaign: campaign
        ? { ...campaign, piece_type: pieceType, qr_code_id: qrCodeId, tracking_id: trackingId }
        : null,
      trackingUrl,
      qrImageUrl,
      qrSlug,
      pieceType,
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

    const validationResults: any[] = []
    let validCount = 0
    let invalidCount = 0

    for (const address of params.addresses) {
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

    const validRecipients = validationResults
      .filter((r) => r.status === "valid")
      .map((r) => {
        const [firstName, ...rest] = String(r.name || "").trim().split(" ")
        const lastName = rest.join(" ")

        return {
          firstName: firstName || "Resident",
          lastName: lastName || "Current",
          addressLine1: r.address1,
          addressLine2: r.address2 ?? undefined,
          city: r.city,
          state: r.state,
          zip: r.zip,
        }
      })

    if (validRecipients.length > 0) {
      const recipientResult = await addRecipients({
        campaignId: params.campaignId,
        recipients: validRecipients,
      })

      if (!recipientResult.success) {
        return {
          success: false,
          error: recipientResult.error || "Failed to save recipients",
        }
      }
    }

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
export async function submitToPrintFulfillment(params: {
  campaignId: string
  agentId: string
  brokerageId: string
  teamId?: string
}) {
  try {
    if (!isValidUUID(params.campaignId) || !isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid IDs" }
    }

    const result = await sendCampaign({
      campaignId: params.campaignId,
      actorUserId: params.agentId,
      brokerageId: params.brokerageId,
      teamId: params.teamId,
    })

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Failed to submit campaign to print fulfillment",
      }
    }

    revalidatePath("/content-studio")
    revalidatePath("/dashboard/campaigns/mail")

    return {
      success: true,
      fulfillment: {
        orderId: result.lobOrderId,
        quantity: result.piecesMailed,
        provider: result.provider,
      },
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

    const { data: campaign } = await supabase
      .from("direct_mail_campaigns")
      .select("id, brokerage_id")
      .eq("tracking_id", params.trackingId)
      .maybeSingle()

    if (!campaign) {
      return { success: false, error: "Campaign not found" }
    }

    const responseTypeMap: Record<string, "qr_scan" | "landing_visit" | "call" | "form_submit"> = {
      qr_scan: "qr_scan",
      call: "call",
      website_visit: "landing_visit",
      form_submission: "form_submit",
    }

    const result = await logResponse({
      brokerageId: campaign.brokerage_id,
      campaignId: campaign.id,
      responseType: responseTypeMap[params.responseType],
      responseMetadata: params.metadata,
    })

    if (!result.success) {
      return {
        success: false,
        error: result.error || "Failed to track response",
      }
    }

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

 const analytics = campaigns?.map((c) => {
  const responseCount = c.responses?.[0]?.count || 0
  const totalCost =
    typeof c.total_cost === "number"
      ? c.total_cost
      : (c.per_piece_cost || 0) * (c.quantity || 0)

  return {
    id: c.id,
    name: c.campaign_name,
    quantity: c.quantity,
    responses: responseCount,
    responseRate: c.quantity > 0 ? (responseCount / c.quantity) * 100 : 0,
    cost: totalCost,
    costPerResponse: responseCount > 0 ? totalCost / responseCount : totalCost,
    status: c.status,
    sentDate: c.submitted_at ?? c.mailing_date ?? null,
  }
})
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
