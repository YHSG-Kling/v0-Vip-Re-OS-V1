"use server"

import { createClient } from "@/lib/supabase/server"
import { LIFETIME_CUSTOMER_SEGMENT } from "@/lib/contact-types"
// THE METERED LANE, which this file imported and never used.
//
// Every AI call here went through `generateObject` (lib/ai/generate.ts:120) —
// the UNROUTED compatibility shim, whose own header says it "never calls
// logAIUsage". So five model calls a day per agent produced NO `ai_tool_usage`
// row, and `ai_tool_usage` is the cost ledger that feeds
// `meter_readings.ai_tokens` and the per-tier overage projection (§5: "a wrong
// number there is a wrong invoice"). The whole direct-mail feature was invisible
// spend.
//
// The import that was sitting here dead was `generateTextRouted as generateText`
// — the right lane, wrong shape: every call in this file is structured output.
// The structured sibling is what it should have been, and it books the row
// itself when handed a brokerageId (lib/ai/models.ts:722).
import { generateObjectRouted } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { z } from "zod"
import {
  canAccessFeature,
  incrementFeatureUsage,
} from "@/lib/kernel"
// TOMBSTONE (dead-import tranche): `KernelEvent` / `processKernelEvent` were
// imported here and never called. The wire is real but it is made ONE LAYER
// DOWN, by the writers this file delegates every state change to:
//   · createMailCampaign  → app/actions/direct-mail.ts:149 emits
//     KernelEvent.DIRECT_MAIL_CAMPAIGN_CREATED (called from :524 below)
//   · sendCampaign        → app/actions/direct-mail.ts:893 emits
//     KernelEvent.DIRECT_MAIL_SENT (called from :736 below)
//   · addRecipients / logResponse are handled by the same module.
// This file is the AI/authoring layer over those; a second emission here would
// have double-fired both events on every campaign.
import { applyKernelBrandVoice, isBrandVoiceBlocked } from "@/lib/kernel/adapters/brand-voice"
import {
  createMailCampaign,
  addRecipients,
  sendCampaign,
  logResponse,
} from "@/app/actions/direct-mail"
import { createQrCodeAction } from "@/app/actions/marketing-studio"

/**
 * WHO THE MODEL SPEND IS BILLED TO — from the SESSION, never from the request.
 *
 * `generateObjectRouted` writes the `ai_tool_usage` row itself when it is handed
 * a `brokerageId` (lib/ai/models.ts:722), and that row is what
 * `meter_readings.ai_tokens` and the per-tier overage projection are computed
 * from. Every exported function in this file is a public HTTP endpoint (§4), and
 * several of them accept `brokerageId` as an ARGUMENT — so passing that argument
 * through to the cost ledger would let a caller bill another tenant for its own
 * model calls. The tenant comes from `getAgentContext()` instead, the same
 * resolver `aiAnalyzeCampaignPerformance` below already uses.
 *
 * A null tenant means the routed lane books NOTHING rather than booking it to
 * the wrong tenant — which is the fail-closed direction for a money column. The
 * `canAccessFeature` gate on each function is what keeps that from being a way
 * to get free inference: no session, no gate, no call.
 */
async function ledgerActorForSpend(): Promise<{ userId?: string; brokerageId: string | null }> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated || !ctx.brokerageId) return { brokerageId: null }
  return { userId: ctx.userId, brokerageId: ctx.brokerageId }
}

// Direct mail piece types — matches the piece_type column on direct_mail_campaigns.
export type DirectMailPieceType = "postcard" | "letter" | "handwritten_letter" | "thank_you_note"

// REMOVED in the QR merge (wave Q): `buildQrImageUrl(absoluteScanUrl, size)`.
// It returned an api.qrserver.com URL, so the tracked scan URL for every postcard was handed to a
// third party, and a print/PDF path depended on an outside host being reachable. The QR image now
// comes back from the minter as a data: URI rendered by the vendored `qrcode` package — see
// lib/marketing/tracked-qr.ts:renderQrPng, the only QR image source in the tree.

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
    | typeof LIFETIME_CUSTOMER_SEGMENT
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

    const spendActor = await ledgerActorForSpend()
    const { object: copy } = await generateObjectRouted({
      ...spendActor,
      feature: "direct_mail_copy",
      // NOTE: OpenAI strict structured-output (used by generateObject through the
      // gateway) rejects string length constraints (.max → maxLength) and optional
      // properties (.optional). Encode length as guidance in .describe() and use
      // .nullable() (a required-but-null field) instead of .optional() — this is
      // why the plain-string aiSuggestDesign schema below works and this one used
      // to throw "invalid schema".
      schema: z.object({
        headline: z.string().describe("Bold, attention-grabbing headline (≤50 characters)"),
        subheadline: z.string().describe("Supporting text (≤80 characters)"),
        bodyText: z.string().describe("Main message, keep scannable (≤200 characters)"),
        callToAction: z.string().describe("Clear CTA text (≤30 characters)"),
        testimonialPlaceholder: z.string().nullable().describe("Optional testimonial placeholder, or null"),
        agentTagline: z.string().describe("Short agent tagline (≤50 characters)"),
        urgencyElement: z.string().nullable().describe("Optional urgency element, or null"),
        variants: z.array(
          z.object({
            headline: z.string(),
            bodyText: z.string(),
            style: z.string(),
          })
        ).describe("Two alternate copy variants with different approaches"),
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
    const spendActor = await ledgerActorForSpend()
    const { object: design } = await generateObjectRouted({
      ...spendActor,
      feature: "direct_mail_design",
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
  campaignGoal: "listings" | "buyers" | "farming" | "brand_awareness" | typeof LIFETIME_CUSTOMER_SEGMENT
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
      .select("target_audience, estimated_response_rate")
      .eq("agent_id", params.agentId)
      .not("estimated_response_rate", "is", null)
      .order("estimated_response_rate", { ascending: false })
      .limit(10)

    const spendActor = await ledgerActorForSpend()
    const { object: targeting } = await generateObjectRouted({
      ...spendActor,
      feature: "direct_mail_targeting",
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

    const spendActor = await ledgerActorForSpend()
    const { object: prediction } = await generateObjectRouted({
      ...spendActor,
      feature: "direct_mail_roi_forecast",
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
/**
 * The caller's own direct-mail campaigns.
 *
 * The parameter is IGNORED and the identity comes from the session, matching
 * getNewsletters. Two reasons, both real:
 *   · direct_mail_campaigns.agent_id is an FK to agents(id). Every UI that
 *     wanted this list had a users(id) in hand, so passing it through would
 *     have matched nothing — silently, since a mismatched uuid is a valid
 *     query that returns zero rows. Resolution belongs on the server.
 *   · trusting a caller-supplied agent_id let any signed-in agent read another
 *     agent's campaigns. The brokerage filter closes that even if the resolved
 *     agent row ever spans tenants.
 */
export async function getDirectMailCampaigns(_agentId?: string /* ignored — derived from session */) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not signed in" }
    if (!ctx.agentId || !ctx.brokerageId) {
      return { success: false, error: "No agent profile is attached to this account" }
    }

    const supabase = await createClient()

    const { data, error } = await supabase
      .from("direct_mail_campaigns")
      .select("*")
      .eq("agent_id", ctx.agentId)
      .eq("brokerage_id", ctx.brokerageId)
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
 * Delegates the actual `direct_mail_campaigns` insert to the canonical
 * `createMailCampaign` in `app/actions/direct-mail.ts`. This function only
 * layers AI-driven enhancements on top:
 *   - Budget → quantity calculation (per-piece cost economics)
 *   - Piece-type tagging (postcard | letter | brochure)
 *   - QR-code generation + tracking link when tracking enabled
 *
 * The kernel event (DIRECT_MAIL_CAMPAIGN_CREATED) and feature gate are
 * handled by `createMailCampaign`; this fn does NOT duplicate them.
 *
 * Use `createMailCampaign` directly for manual / non-AI flows. Do NOT
 * introduce a third creator that bypasses both.
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
  /** ★ TRACKING LINKED TO CAMPAIGN ★ marketing_campaigns.id when this mailer belongs to an
   *  umbrella marketing campaign — stamped onto qr_codes.marketing_campaign_id so the scans roll
   *  up in lib/marketing/campaign-measurer.ts. Verified against the caller's brokerage inside
   *  createQrCodeAction; an FK proves a campaign exists, never that it is ours. */
  marketingCampaignId?: string
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
      // The mint no longer needs a placeholder target_url patched after the fact: the minter owns
      // the slug and returns the scan URL, and it defaults target_url to this code's own public
      // /qr/<slug> landing when (as here) there is no other semantic destination.
      //
      // ★ TRACKING LINKED TO CAMPAIGN ★ `marketingCampaignId` is the FORWARD link to
      // marketing_campaigns and is stamped only when the caller actually has one. It is NOT the
      // same thing as `direct_mail_campaigns.qr_code_id` set below, which is a separate REVERSE
      // link that already worked and is what /api/qr/scan reads for direct-mail attribution.
      // Collapsing either into the other would break one of the two lanes.
      const qrResult = await createQrCodeAction({
        brokerageId: params.brokerageId,
        agentId: params.agentId,
        label: `${params.campaignName} (${trackingId})`,
        purpose: "campaign",
        destinationType: "landing_page",
        campaignId: params.marketingCampaignId,
        // trackingId is unique per campaign, so this doubles as the idempotency key: a retried
        // create reuses the same tracked code instead of minting a second one.
        idempotencyLabel: `direct_mail:${trackingId}`,
      })

      if (qrResult.success && qrResult.qrCode) {
        qrCodeId = qrResult.qrCode.id
        qrSlug = qrResult.qrCode.slug

        // Link the QR to the campaign for scan attribution (the REVERSE link).
        const { error: linkError } = await supabase
          .from("direct_mail_campaigns")
          .update({ qr_code_id: qrResult.qrCode.id })
          .eq("id", campaign.id)
        if (linkError) {
          // Without this link /api/qr/scan cannot attribute a scan to the mail campaign, so the
          // Responses tab and cost-per-response stay at zero. Say so rather than reporting a
          // tracked campaign that is not tracked.
          console.error("[AI Direct Mail] QR created but NOT linked to the campaign:", linkError.message)
        }

        trackingUrl = qrResult.qrCode.scan_url
        qrImageUrl = qrResult.qrCode.image_url
      } else {
        console.error("[AI Direct Mail] QR code was NOT created:", (qrResult as { error?: string }).error)
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
/**
 * Record a response against a mailed piece, addressed by its printed tracking id.
 *
 * GATED (was not) — this is the `trackDelivery` class. `"use server"` makes it a
 * public endpoint, and its only key was `tracking_id`, a low-entropy string
 * minted as `dm-<Date.now()>-<9 base36 chars>` and *printed on the mail piece*.
 * Anyone holding or guessing one could post unlimited "qr_scan" / "call" /
 * "form_submission" rows against another brokerage's paid campaign. Those rows
 * are the numerator of the response-rate and cost-per-response figures
 * `getDirectMailAnalytics` and `aiAnalyzeCampaignPerformance` report, so the
 * hole was a write into someone else's marketing P&L, not just noise.
 *
 * Now: authenticated, and the campaign must belong to the caller's own brokerage.
 * The tenant id passed to `logResponse` still comes from the campaign row (never
 * from the caller), and it is now cross-checked against the session.
 *
 * NOTE for whoever wires this: the anonymous QR path does NOT come through here —
 * `/api/qr/scan?slug=…` records scans on its own and is the surface built for
 * untrusted visitors. This action is the operator-side logger (an agent recording
 * "this seller called off the postcard"), which is why gating it is correct
 * rather than restrictive. If a genuinely public response sink is ever needed, it
 * belongs in a route handler with its own rate limiting and a high-entropy token,
 * not on a server action.
 */
export async function trackCampaignResponse(params: {
  trackingId: string
  responseType: "qr_scan" | "call" | "website_visit" | "form_submission"
  metadata?: any
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Not signed in" }
    }

    if (typeof params.trackingId !== "string" || params.trackingId.trim().length === 0) {
      return { success: false, error: "Invalid tracking ID" }
    }

    const supabase = await createClient()

    const { data: campaign, error: campaignError } = await supabase
      .from("direct_mail_campaigns")
      .select("id, brokerage_id")
      .eq("tracking_id", params.trackingId)
      .eq("brokerage_id", ctx.brokerageId)
      .maybeSingle()

    // A refused read is not "no such campaign". Report it rather than letting a
    // blocked query look like a bad tracking id.
    if (campaignError) {
      return { success: false, error: `Could not look up the campaign: ${campaignError.message}` }
    }
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
/**
 * Per-campaign spend / response / cost-per-response for the calling agent.
 *
 * GATED + SESSION-SCOPED (was neither). This is a `"use server"` export, so a
 * public HTTP endpoint, and it authenticated nothing: it filtered on a
 * caller-supplied `agent_id` and handed back that agent's whole paid-mail book —
 * campaign names, quantities, per-piece and total spend, response counts. One
 * uuid read another brokerage's marketing budget.
 *
 * `agentId` is now ignored and derived from the session, matching the already
 * remediated sibling `getDirectMailCampaigns` in this file. The brokerage
 * predicate is added too: a mismatched uuid is a *valid* query that returns zero
 * rows, so tenant scope has to be stated, not assumed from the agent id.
 */
export async function getDirectMailAnalytics(params: {
  /** Ignored — derived from the session. */
  agentId?: string
  campaignId?: string
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not signed in" }
    if (!ctx.agentId || !ctx.brokerageId) {
      return { success: false, error: "No agent profile is attached to this account" }
    }

    const supabase = await createClient()

    let query = supabase
      .from("direct_mail_campaigns")
      .select("*, responses:direct_mail_responses(count)")
      .eq("agent_id", ctx.agentId)
      .eq("brokerage_id", ctx.brokerageId)

    if (params.campaignId) {
      if (!isValidUUID(params.campaignId)) {
        return { success: false, error: "Invalid campaign ID" }
      }
      query = query.eq("id", params.campaignId)
    }

    // Destructure `error`: supabase-js RESOLVES a refused read, so `{ data }`
    // alone reports a blocked query as "this agent has no campaigns".
    const { data: campaigns, error } = await query
    if (error) {
      return { success: false, error: `Could not read campaigns: ${error.message}` }
    }

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
    sentDate: c.mailing_date ?? null,
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
/**
 * AI read of the calling agent's direct-mail performance.
 *
 * GATED + SESSION-SCOPED (was neither). `canAccessFeature(params.agentId, …)` is
 * an *entitlement* check, not an authentication check — it answers "is this
 * agent's plan allowed direct mail", which a caller satisfies simply by naming an
 * agent whose plan is. With that as the only barrier the endpoint would, for any
 * uuid supplied by anyone: read that agent's entire paid-mail history including
 * spend and response rows, serialise the whole thing into a prompt, and bill a
 * gpt-4o-mini call to the platform. Unauthenticated AI spend on top of an
 * unauthenticated cross-tenant read.
 *
 * `agentId`/`brokerageId` are now ignored and derived from the session; the
 * entitlement gate is kept and now runs against the *resolved* agent.
 */
export async function aiAnalyzeCampaignPerformance(params?: {
  /** Ignored — derived from the session. */
  agentId?: string
  /** Ignored — derived from the session. */
  brokerageId?: string
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not signed in" }
    if (!ctx.agentId || !ctx.brokerageId) {
      return { success: false, error: "No agent profile is attached to this account" }
    }

    // ── Kernel Gate: canAccessFeature (entitlement, on the RESOLVED agent) ──
    const access = await canAccessFeature(ctx.agentId, "direct_mail")
    if (!access.allowed) {
      return { success: false, error: access.reason ?? "Direct mail feature not available" }
    }

    const supabase = await createClient()

    // Get all campaigns with responses
    const { data: campaigns, error: campaignsError } = await supabase
      .from("direct_mail_campaigns")
      .select("*, responses:direct_mail_responses(*)")
      .eq("agent_id", ctx.agentId)
      .eq("brokerage_id", ctx.brokerageId)
      .not("mailing_date", "is", null)

    // Do not pay for a model call on a read that was refused — a blocked query
    // and an empty campaign list are the same shape here, and only one of them
    // is worth analysing.
    if (campaignsError) {
      return { success: false, error: `Could not read campaigns: ${campaignsError.message}` }
    }
    if (!campaigns || campaigns.length === 0) {
      return { success: false, error: "No mailed campaigns yet — nothing to analyse." }
    }

    const { object: analysis } = await generateObjectRouted({
      // The tenant is already resolved from the session in this function.
      userId: ctx.userId,
      brokerageId: ctx.brokerageId,
      feature: "direct_mail_performance",
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
