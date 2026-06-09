"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { getDefaultCommissionStructure } from "@/lib/brokerage/get-default-commission-structure"
import { createServiceClient } from "@/lib/supabase/service"
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
 * Generate a complete listing presentation package
 */
export async function generateListingPresentation(params: {
  agentId: string
  propertyData: {
    address: string
    city: string
    state: string
    zipCode: string
    bedrooms: number
    bathrooms: number
    sqft: number
    lotSize?: number
    yearBuilt?: number
    propertyType: string
    features?: string[]
    condition?: string
    sellerMotivation?: string
    timeline?: string
  }
  sellerInfo?: {
    name: string
    concerns?: string[]
    previousAgentExperience?: string
  }
  presentationType?: "full" | "mini" | "digital"
}) {
  const auth = await requireCaller()
  if (!auth.ok) return { success: false, error: auth.error }

  if (!isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid agent ID" }
  }

  const supabase = await createClient()

  try {
    // Get agent profile — must be in caller's brokerage
    const { data: agent } = await supabase
      .from("agents")
      .select("*, brand_voice_profile(*)")
      .eq("id", params.agentId)
      .eq("brokerage_id", auth.brokerageId)
      .single()
    if (!agent) return { success: false, error: "Agent not found in your brokerage" }

    // Get comparable sales
    const { data: comps } = await supabase
      .from("listings")
      .select("*")
      .eq("zip", params.propertyData.zipCode)
      .eq("status", "sold")
      .order("go_live_date", { ascending: false })
      .limit(10)

    // Get market data
    const { data: marketData } = await supabase
      .from("market_data")
      .select("*")
      .eq("zip", params.propertyData.zipCode)
      .order("data_date", { ascending: false })
      .limit(5)

    const { object: presentation } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        title: z.string(),
        subtitle: z.string(),
        sections: z.array(z.object({
          sectionNumber: z.number(),
          title: z.string(),
          content: z.string(),
          bulletPoints: z.array(z.string()).optional(),
          visualSuggestion: z.string().optional(),
          talkingPoints: z.array(z.string())
        })),
        marketAnalysis: z.object({
          summary: z.string(),
          comparablesSummary: z.string(),
          pricingStrategy: z.object({
            recommendedPrice: z.number(),
            priceRange: z.object({ low: z.number(), high: z.number() }),
            reasoning: z.string()
          }),
          marketTrends: z.array(z.object({
            trend: z.string(),
            impact: z.string()
          })),
          daysOnMarketExpectation: z.number()
        }),
        marketingPlan: z.object({
          overview: z.string(),
          strategies: z.array(z.object({
            strategy: z.string(),
            description: z.string(),
            timeline: z.string()
          })),
          digitalMarketing: z.array(z.string()),
          traditionalMarketing: z.array(z.string()),
          photography: z.string(),
          staging: z.string(),
          openHousePlan: z.string()
        }),
        timeline: z.object({
          preListing: z.array(z.object({ task: z.string(), days: z.string() })),
          activeListing: z.array(z.object({ task: z.string(), days: z.string() })),
          underContract: z.array(z.object({ task: z.string(), days: z.string() }))
        }),
        valueProposition: z.object({
          mainMessage: z.string(),
          differentiators: z.array(z.string()),
          testimonialSuggestion: z.string(),
          guarantees: z.array(z.string()).optional()
        }),
        objectionHandlers: z.array(z.object({
          objection: z.string(),
          response: z.string(),
          supporting: z.string()
        })),
        closingSlide: z.object({
          headline: z.string(),
          callToAction: z.string(),
          nextSteps: z.array(z.string())
        }),
        appendix: z.object({
          detailedComps: z.array(z.object({
            address: z.string(),
            soldPrice: z.number(),
            soldDate: z.string(),
            comparison: z.string()
          })),
          agentBio: z.string(),
          testimonials: z.array(z.string())
        })
      }),
      prompt: `Create a compelling listing presentation:

Property Details:
${JSON.stringify(params.propertyData, null, 2)}

Seller Information:
${JSON.stringify(params.sellerInfo || {}, null, 2)}

Agent Profile:
Name: ${agent?.first_name} ${agent?.last_name}
Specializations: ${agent?.specializations?.join(", ") || "N/A"}
Years Experience: ${agent?.years_experience || "N/A"}

Comparable Sales:
${JSON.stringify(comps?.slice(0, 5) || [], null, 2)}

Market Data:
${JSON.stringify(marketData || [], null, 2)}

Presentation Type: ${params.presentationType || "full"}

Create:
1. Engaging title and introduction
2. Market analysis with pricing recommendation
3. Comprehensive marketing plan
4. Clear timeline
5. Strong value proposition
6. Objection handlers for common concerns
7. Powerful closing with clear next steps
8. Supporting appendix materials`
    })

    // Save presentation
    const { data: saved, error } = await supabase
      .from("listing_presentations")
      .insert({
        agent_id: params.agentId,
        property_address: params.propertyData.address,
        property_data: params.propertyData,
        presentation: presentation,
        presentation_type: params.presentationType || "full",
        created_at: new Date().toISOString()
      })
      .select()
      .single()

    return {
      success: true,
      presentation,
      presentationId: saved?.id
    }
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

    const { data: agent } = await supabase
      .from("agents")
      .select("*")
      .eq("id", params.agentId)
      .single()

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
${JSON.stringify({ name: `${agent?.first_name} ${agent?.last_name}`, phone: agent?.phone, email: agent?.email }, null, 2)}

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
