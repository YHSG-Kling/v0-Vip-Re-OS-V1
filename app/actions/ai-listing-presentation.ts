"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { getDefaultCommissionStructure } from "@/lib/brokerage/get-default-commission-structure"
import { createServiceClient } from "@/lib/supabase/service"
import {
  generateAiListingPresentation,
  type AiListingPresentationPropertyData,
} from "@/lib/listing-presentation/generate-ai-presentation"
import { z } from "zod"

// ============================================================================
// AI LISTING PRESENTATION GENERATOR
// Dynamic presentations for seller consultations and listings
// ============================================================================

// Auth gate — every function here makes paid AI inference. Without auth,
// unauthenticated callers could burn AI budget at will.
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

/**
 * Generate a complete listing presentation package.
 *
 * THE AUTHENTICATED DOOR. The work itself lives in
 * lib/listing-presentation/generate-ai-presentation.ts so the UNATTENDED caller —
 * step 2 of the listing-appt-prep chain, which the AI-ISA drives from a webhook
 * with no session — has a door of its own instead of being turned away by the
 * gate below. The tenant is derived from the session here and from the run row
 * there; neither takes it from the caller.
 */
export async function generateListingPresentation(params: {
  agentId: string
  contactId?: string | null
  appointmentId?: string | null
  appointmentAt?: string | null
  propertyData: AiListingPresentationPropertyData
  sellerInfo?: {
    name: string
    concerns?: string[]
    previousAgentExperience?: string
  }
  /** The agent's own note to this seller, typed on the CMA → Presentation tab. */
  agentMessage?: string
  presentationType?: "full" | "mini" | "digital"
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  try {
    return await generateAiListingPresentation({
      brokerageId:    auth.brokerageId,
      agentId:        params.agentId,
      contactId:      params.contactId ?? null,
      appointmentId:  params.appointmentId ?? null,
      appointmentAt:  params.appointmentAt ?? null,
      propertyData:   params.propertyData,
      sellerInfo:     params.sellerInfo,
      agentMessage:   params.agentMessage,
      presentationType: params.presentationType,
    })
  } catch (error) {
    console.error("[v0] Generate listing presentation error:", error)
    return handleError(error, "generateListingPresentation")
  }
}

/**
 * Generate seller net sheet with AI explanations
 */
export async function generateSellerNetSheet(params: {
  agentId: string
  salePrice: number
  mortgagePayoff?: number
  commissionRate?: number
  state: string
  county?: string
  additionalCosts?: { name: string; amount: number }[]
}) {
  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  try {
    // Resolve commission rate: caller-supplied → brokerage default → 3%
    let commissionRate = params.commissionRate
    if (commissionRate == null) {
      try {
        const service = createServiceClient()
        const { data: agentRow } = await service
          .from("agents")
          .select("brokerage_id")
          .eq("id", params.agentId)
          .maybeSingle()
        if (agentRow?.brokerage_id) {
          const structure = await getDefaultCommissionStructure(agentRow.brokerage_id, params.agentId)
          commissionRate = structure.grossRateDecimal * 100
        }
      } catch {
        // No default structure configured — fall back to industry default
      }
      commissionRate = commissionRate ?? 3
    }
    
    const { object: netSheet } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        summary: z.object({
          salePrice: z.number(),
          totalDeductions: z.number(),
          estimatedNet: z.number(),
          netPercentage: z.number()
        }),
        deductions: z.array(z.object({
          category: z.string(),
          item: z.string(),
          amount: z.number(),
          explanation: z.string(),
          isEstimate: z.boolean()
        })),
        taxes: z.object({
          transferTax: z.number(),
          propertyTaxProration: z.number(),
          capitalGainsNote: z.string()
        }),
        closingCosts: z.object({
          titleInsurance: z.number(),
          escrowFees: z.number(),
          recordingFees: z.number(),
          otherFees: z.number()
        }),
        scenarios: z.array(z.object({
          scenarioName: z.string(),
          salePrice: z.number(),
          estimatedNet: z.number(),
          notes: z.string()
        })),
        recommendations: z.array(z.string()),
        disclaimer: z.string()
      }),
      prompt: `Generate a detailed seller net sheet:

Sale Price: $${params.salePrice}
Mortgage Payoff: $${params.mortgagePayoff || 0}
Commission Rate: ${commissionRate}%
State: ${params.state}
County: ${params.county || "N/A"}

Additional Costs:
${JSON.stringify(params.additionalCosts || [], null, 2)}

Calculate and explain:
1. All typical seller closing costs for ${params.state}
2. Transfer taxes and prorations
3. Commission breakdown
4. Three price scenarios (+/- 5%)
5. Clear explanations for each line item
6. Recommendations to maximize net
7. Required legal disclaimer`
    })

    return {
      success: true,
      netSheet
    }
  } catch (error) {
    console.error("[v0] Generate seller net sheet error:", error)
    return handleError(error, "generateSellerNetSheet")
  }
}

/**
 * Generate property highlight video script
 */
export async function generateVideoScript(params: {
  agentId: string
  listingId: string
  videoType: "walkthrough" | "highlight" | "neighborhood" | "aerial"
  duration?: number
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.agentId) || !isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: listing } = await supabase
      .from("listings")
      .select("*")
      .eq("id", params.listingId)
      .eq("brokerage_id", auth.brokerageId)
      .single()
    if (!listing) return { success: false, error: "Listing not found in your brokerage" }

    const { object: script } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        title: z.string(),
        hook: z.string(),
        scenes: z.array(z.object({
          sceneNumber: z.number(),
          location: z.string(),
          duration: z.number(),
          narration: z.string(),
          visualDirection: z.string(),
          bRoll: z.array(z.string()),
          textOverlay: z.string().optional()
        })),
        callToAction: z.object({
          narration: z.string(),
          contactInfo: z.string(),
          urgencyElement: z.string()
        }),
        musicSuggestions: z.array(z.object({
          genre: z.string(),
          mood: z.string(),
          example: z.string()
        })),
        socialMediaCuts: z.array(z.object({
          platform: z.string(),
          duration: z.number(),
          focusScenes: z.array(z.number()),
          hashtags: z.array(z.string())
        })),
        totalDuration: z.number()
      }),
      prompt: `Create a video script for this listing:

Property:
${JSON.stringify(listing || {}, null, 2)}

Video Type: ${params.videoType}
Target Duration: ${params.duration || 60} seconds

Create:
1. Attention-grabbing hook
2. Scene-by-scene breakdown with narration
3. Visual direction for each scene
4. Strong call to action
5. Music suggestions
6. Social media cut variations`
    })

    return {
      success: true,
      script
    }
  } catch (error) {
    console.error("[v0] Generate video script error:", error)
    return handleError(error, "generateVideoScript")
  }
}

/**
 * Generate property brochure content
 */
export async function generateBrochureContent(params: {
  agentId: string
  listingId: string
  brochureType: "luxury" | "standard" | "investment" | "new_construction"
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.agentId) || !isValidUUID(params.listingId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data: listing } = await supabase
      .from("listings")
      .select("*")
      .eq("id", params.listingId)
      .eq("brokerage_id", auth.brokerageId)
      .single()
    if (!listing) return { success: false, error: "Listing not found in your brokerage" }

    // TENANT SCOPE + narrowed projection. The listing read above was already
    // pinned to the caller's brokerage; this one was not, so a caller-supplied
    // `agentId` selected `*` from ANY brokerage's `agents` row and the contact
    // details off it were written into the brochure and into the model prompt.
    // Only the four identity fields are ever used, so only those are selected —
    // `select("*")` on a table this wide is how columns nobody intended to
    // expose end up in an LLM context window.
    //
    // IDENTITY LIVES ON `users`, NOT `agents`. Verified against the live schema:
    // `agents` has no first_name / last_name / email / phone at all — the name
    // and email are on `users` (reached via agents.user_id) and the phone is
    // `agents.phone_mobile` / `phone_office`. The original `select("*")` hid
    // this: every `agent?.first_name` resolved to `undefined`, so the brochure's
    // agent section has always been built from "undefined undefined" with no
    // phone and no email, and the prompt said so to the model. This is the same
    // embed shape the rest of the tree already uses (see
    // app/actions/ai-listing-packet.ts and app/actions/home-value.ts).
    //
    // `.single()` → `.maybeSingle()`: a missing agent is an answer, not a throw.
    const { data: agent } = await supabase
      .from("agents")
      .select("phone_mobile, phone_office, users(first_name, last_name, email)")
      .eq("id", params.agentId)
      .eq("brokerage_id", auth.brokerageId)
      .maybeSingle()

    // The embed comes back as an object (or an array, depending on how PostgREST
    // resolves the relationship), so normalise before reading.
    const agentUser = (Array.isArray(agent?.users) ? agent?.users[0] : agent?.users) as
      | { first_name?: string | null; last_name?: string | null; email?: string | null }
      | undefined
    const agentName = [agentUser?.first_name, agentUser?.last_name].filter(Boolean).join(" ")

    const { object: brochure } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        headline: z.string(),
        tagline: z.string(),
        propertyDescription: z.object({
          opening: z.string(),
          features: z.string(),
          lifestyle: z.string(),
          neighborhood: z.string(),
          closing: z.string()
        }),
        featureHighlights: z.array(z.object({
          feature: z.string(),
          description: z.string(),
          icon: z.string()
        })),
        quickFacts: z.array(z.object({
          label: z.string(),
          value: z.string()
        })),
        floorplanDescription: z.string().optional(),
        neighborhoodHighlights: z.array(z.string()),
        schoolInfo: z.array(z.object({
          name: z.string(),
          type: z.string(),
          rating: z.string()
        })).optional(),
        callToAction: z.string(),
        agentSection: z.object({
          intro: z.string(),
          credentials: z.array(z.string())
        }),
        disclaimers: z.array(z.string())
      }),
      prompt: `Create brochure content:

Listing:
${JSON.stringify(listing || {}, null, 2)}

Agent:
${JSON.stringify(
  {
    name:  agentName || "the listing agent",
    phone: agent?.phone_mobile ?? agent?.phone_office ?? null,
    email: agentUser?.email ?? null,
  },
  null,
  2,
)}

Brochure Type: ${params.brochureType}

Create compelling content for:
1. Headline and tagline
2. Multi-paragraph property description
3. Feature highlights
4. Quick facts
5. Neighborhood highlights
6. Call to action
7. Agent section`
    })

    return {
      success: true,
      brochure
    }
  } catch (error) {
    console.error("[v0] Generate brochure content error:", error)
    return handleError(error, "generateBrochureContent")
  }
}
