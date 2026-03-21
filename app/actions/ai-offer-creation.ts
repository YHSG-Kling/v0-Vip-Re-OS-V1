"use server"

import { createClient } from "@/lib/supabase/server"
import { generateText, generateObject } from "ai"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { z } from "zod"

// ============================================
// AI OFFER CREATION SYSTEM
// Complete workflow for buyer agents creating offers
// with state-specific forms, Dotloop integration,
// and AI-powered strategy assistance
// ============================================

// State-specific offer forms
const STATE_OFFER_FORMS: Record<string, { required: string[]; addenda: string[] }> = {
  TX: {
    required: [
      "TAR 1601 - One to Four Family Contract",
      "TAR 2301 - Information About Brokerage Services",
      "TAR 1902 - Third Party Financing Addendum",
    ],
    addenda: [
      "TAR 1903 - Addendum for Sale of Other Property",
      "TAR 1904 - Addendum for Property Subject to Mandatory HOA",
      "TAR 1906 - Short Sale Addendum",
      "TAR 1907 - Addendum for Coastal Area Property",
    ],
  },
  CA: {
    required: ["CAR RPA - Residential Purchase Agreement", "CAR AD - Agency Disclosure", "CAR PRDS - Property Disclosure"],
    addenda: [
      "CAR RIPA - Residential Income Property PA",
      "CAR COP - Contingency for Sale of Buyer's Property",
      "CAR SBSA - Short Sale Addendum",
    ],
  },
  FL: {
    required: ["FAR/BAR Contract", "Agency Disclosure", "Pre-Approval Letter"],
    addenda: ["AS-IS Addendum", "Inspection Contingency", "Financing Contingency"],
  },
  DEFAULT: {
    required: ["Purchase Agreement", "Agency Disclosure", "Pre-Approval Letter"],
    addenda: ["Inspection Contingency", "Financing Contingency", "Appraisal Contingency"],
  },
}

interface OfferCreationParams {
  agentId: string
  buyerId: string
  listingId: string
  offerPrice: number
  earnestMoney: number
  downPaymentPercent: number
  financingType: "conventional" | "fha" | "va" | "cash" | "usda" | "other"
  contingencies: string[]
  closeDate: string
  escalationClause?: {
    enabled: boolean
    maxPrice: number
    increment: number
  }
  additionalTerms?: any
}

// ============================================
// 1. AI OFFER STRATEGY ADVISOR
// ============================================
export async function aiOfferStrategyAdvisor(params: {
  agentId: string
  buyerId: string
  listingId: string
  listPrice: number
  daysOnMarket: number
  competingOffers?: number
  marketConditions: "hot" | "balanced" | "cooling"
  buyerMotivation: "must_have" | "would_like" | "nice_to_have"
  buyerMaxBudget: number
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const { object: strategy } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        recommendedOfferPrice: z.number(),
        priceRangeLow: z.number(),
        priceRangeHigh: z.number(),
        winProbability: z.number().min(0).max(100),
        strategy: z.enum(["aggressive", "competitive", "conservative"]),
        reasoning: z.string(),
        escalationRecommendation: z.object({
          recommended: z.boolean(),
          suggestedMax: z.number().optional(),
          suggestedIncrement: z.number().optional(),
          reasoning: z.string(),
        }),
        contingencyStrategy: z.object({
          inspection: z.enum(["full", "limited", "waive"]),
          appraisal: z.enum(["full", "gap_coverage", "waive"]),
          financing: z.enum(["full", "shortened", "waive"]),
          reasoning: z.string(),
        }),
        earnestMoneyRecommendation: z.object({
          amount: z.number(),
          percentage: z.number(),
          reasoning: z.string(),
        }),
        closeDateStrategy: z.string(),
        personalLetterRecommendation: z.boolean(),
        additionalSuggestions: z.array(z.string()),
      }),
      prompt: `You are a buyer's agent strategist. Help craft a winning offer strategy.

Listing Details:
- List Price: $${params.listPrice.toLocaleString()}
- Days on Market: ${params.daysOnMarket}
- Competing Offers: ${params.competingOffers || "Unknown"}
- Market: ${params.marketConditions}

Buyer Situation:
- Motivation: ${params.buyerMotivation}
- Max Budget: $${params.buyerMaxBudget.toLocaleString()}

Consider:
1. Market conditions and competition
2. Buyer's budget and motivation
3. What will make this offer stand out
4. Risk vs reward tradeoffs

Provide a comprehensive offer strategy.`,
    })

    return { success: true, strategy }
  } catch (error) {
    console.error("[AI Offer Creation] Strategy error:", error)
    return handleError(error, "aiOfferStrategyAdvisor")
  }
}

// ============================================
// 2. AI ESCALATION CLAUSE CALCULATOR
// ============================================
export async function aiCalculateEscalation(params: {
  listPrice: number
  initialOffer: number
  maxBudget: number
  estimatedCompetition: "none" | "low" | "medium" | "high"
  marketTrend: "appreciating" | "stable" | "declining"
}) {
  try {
    const { object: escalation } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        recommended: z.boolean(),
        startingOffer: z.number(),
        escalationIncrement: z.number(),
        maxEscalationPrice: z.number(),
        capAtAppraisal: z.boolean(),
        proofRequired: z.array(z.string()),
        reasoning: z.string(),
        riskAssessment: z.string(),
        sampleClauseText: z.string(),
      }),
      prompt: `Calculate optimal escalation clause parameters:

List Price: $${params.listPrice.toLocaleString()}
Initial Offer: $${params.initialOffer.toLocaleString()}
Buyer Max Budget: $${params.maxBudget.toLocaleString()}
Competition Level: ${params.estimatedCompetition}
Market Trend: ${params.marketTrend}

Determine:
1. Whether escalation is recommended
2. Optimal increment amount
3. Maximum escalation price
4. Risk assessment
5. Sample clause language`,
    })

    return { success: true, escalation }
  } catch (error) {
    console.error("[AI Offer Creation] Escalation error:", error)
    return handleError(error, "aiCalculateEscalation")
  }
}

// ============================================
// 3. AI CONTINGENCY RECOMMENDER
// ============================================
export async function aiRecommendContingencies(params: {
  buyerFinancingType: string
  propertyAge: number
  propertyCondition: "excellent" | "good" | "fair" | "needs_work"
  competitionLevel: "none" | "low" | "medium" | "high"
  buyerRiskTolerance: "conservative" | "moderate" | "aggressive"
}) {
  try {
    const { object: contingencies } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        recommended: z.array(
          z.object({
            type: z.string(),
            duration: z.number().describe("Days"),
            critical: z.boolean(),
            reasoning: z.string(),
          })
        ),
        notRecommended: z.array(
          z.object({
            type: z.string(),
            reasoning: z.string(),
          })
        ),
        riskAnalysis: z.object({
          overallRisk: z.enum(["low", "medium", "high"]),
          buyerProtection: z.number().min(0).max(100),
          competitiveness: z.number().min(0).max(100),
        }),
        suggestions: z.array(z.string()),
      }),
      prompt: `Recommend contingencies for this buyer:

Financing: ${params.buyerFinancingType}
Property Age: ${params.propertyAge} years
Property Condition: ${params.propertyCondition}
Competition: ${params.competitionLevel}
Buyer Risk Tolerance: ${params.buyerRiskTolerance}

Standard contingencies:
- Inspection (5-10 days)
- Appraisal (loan-dependent)
- Financing (21-30 days)
- Title (standard)
- HOA review (3-5 days)

Balance buyer protection with competitiveness.`,
    })

    return { success: true, contingencies }
  } catch (error) {
    console.error("[AI Offer Creation] Contingency error:", error)
    return handleError(error, "aiRecommendContingencies")
  }
}

// ============================================
// 4. AI BUYER LETTER GENERATOR
// ============================================
export async function aiGenerateBuyerLetter(params: {
  agentId: string
  buyerFirstName: string
  buyerStory: string
  propertyAddress: string
  whyThisHome: string
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const { text: letter } = await generateText({
      model: "openai/gpt-4o",
      prompt: `Write a heartfelt, Fair Housing compliant buyer letter.

Buyer: ${params.buyerFirstName}
Property: ${params.propertyAddress}
Buyer's Story: ${params.buyerStory}
Why This Home: ${params.whyThisHome}

CRITICAL RULES:
1. DO NOT mention race, religion, national origin, familial status, or any protected class
2. Focus on the HOME FEATURES, not the neighborhood demographics
3. Keep it personal but professional
4. Express genuine appreciation for the home itself
5. Keep it under 300 words

Write a compelling letter that connects the buyer to the HOME, not the community.`,
    })

    return { success: true, letter }
  } catch (error) {
    console.error("[AI Offer Creation] Letter error:", error)
    return handleError(error, "aiGenerateBuyerLetter")
  }
}

// ============================================
// 5. GET STATE-SPECIFIC OFFER FORMS
// ============================================
export async function getOfferForms(params: {
  state: string
  financingType: string
  isShortSale: boolean
  hasHoa: boolean
  isNewConstruction: boolean
}) {
  try {
    const stateConfig = STATE_OFFER_FORMS[params.state] || STATE_OFFER_FORMS.DEFAULT

    const forms = [...stateConfig.required]
    const addenda: string[] = []

    // Add conditional addenda
    if (params.hasHoa) {
      const hoaAddendum = stateConfig.addenda.find((a) => a.toLowerCase().includes("hoa"))
      if (hoaAddendum) addenda.push(hoaAddendum)
    }

    if (params.isShortSale) {
      const ssAddendum = stateConfig.addenda.find((a) => a.toLowerCase().includes("short sale"))
      if (ssAddendum) addenda.push(ssAddendum)
    }

    if (params.financingType === "fha" || params.financingType === "va") {
      addenda.push(`${params.financingType.toUpperCase()} Financing Addendum`)
    }

    // AI enhancement for special circumstances
    const { text: additionalForms } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `As a real estate forms expert for ${params.state}, are there additional forms needed for:
- Financing: ${params.financingType}
- Short Sale: ${params.isShortSale}
- HOA: ${params.hasHoa}
- New Construction: ${params.isNewConstruction}

List only form names, one per line. If none needed, respond "NONE".`,
    })

    const aiRecommended =
      additionalForms !== "NONE"
        ? additionalForms
            .split("\n")
            .filter((f) => f.trim())
            .map((f) => f.trim())
        : []

    return {
      success: true,
      forms: {
        required: forms,
        addenda,
        aiRecommended,
      },
    }
  } catch (error) {
    console.error("[AI Offer Creation] Forms error:", error)
    return handleError(error, "getOfferForms")
  }
}

// ============================================
// 6. CREATE DOTLOOP FOR OFFER
// ============================================
export async function createOfferDotloop(params: {
  agentId: string
  buyerId: string
  propertyAddress: string
  transactionId?: string
  existingLoopId?: string
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const DOTLOOP_API_KEY = process.env.DOTLOOP_API_KEY
    const DOTLOOP_PROFILE_ID = process.env.DOTLOOP_PROFILE_ID

    if (!DOTLOOP_API_KEY || !DOTLOOP_PROFILE_ID) {
      return {
        success: true,
        loopId: `mock-offer-loop-${Date.now()}`,
        loopUrl: `https://dotloop.com/loop/mock-offer-${Date.now()}`,
        mock: true,
      }
    }

    const supabase = await createClient()

    // If existing loop provided, link to it
    if (params.existingLoopId) {
      if (params.transactionId) {
        await supabase
          .from("transactions")
          .update({ dotloop_loop_id: params.existingLoopId })
          .eq("id", params.transactionId)
      }

      return {
        success: true,
        loopId: params.existingLoopId,
        loopUrl: `https://www.dotloop.com/loop/${params.existingLoopId}`,
        linked: true,
      }
    }

    // Create new loop
    const response = await fetch(
      `https://api-gateway.dotloop.com/public/v2/profile/${DOTLOOP_PROFILE_ID}/loop`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${DOTLOOP_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: `${params.propertyAddress} - Buyer Offer`,
          status: "Active",
          deal_type: "Purchase",
          street_address: params.propertyAddress,
        }),
      }
    )

    if (!response.ok) {
      throw new Error(`Dotloop API error: ${response.statusText}`)
    }

    const result = await response.json()
    const loopId = result.data?.loop_id

    // Update transaction
    if (params.transactionId && loopId) {
      await supabase.from("transactions").update({ dotloop_loop_id: loopId }).eq("id", params.transactionId)
    }

    return {
      success: true,
      loopId,
      loopUrl: `https://www.dotloop.com/loop/${loopId}`,
      created: true,
    }
  } catch (error) {
    console.error("[AI Offer Creation] Dotloop error:", error)
    return handleError(error, "createOfferDotloop")
  }
}

// ============================================
// 7. AI COUNTER OFFER STRATEGIST
// ============================================
export async function aiCounterOfferStrategy(params: {
  originalOffer: number
  listPrice: number
  counterAmount: number
  counterTerms: any
  buyerMaxBudget: number
  negotiationRound: number
}) {
  try {
    const { object: strategy } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        recommendedResponse: z.enum(["accept", "counter", "walk_away"]),
        suggestedCounterPrice: z.number().optional(),
        suggestedTerms: z.array(z.string()),
        reasoning: z.string(),
        negotiationTactics: z.array(z.string()),
        riskOfLosingDeal: z.number().min(0).max(100),
        estimatedFinalPrice: z.number(),
        nextMoveTimeline: z.string(),
      }),
      prompt: `Help strategize response to seller's counter offer.

Negotiation History:
- List Price: $${params.listPrice.toLocaleString()}
- Our Offer: $${params.originalOffer.toLocaleString()}
- Their Counter: $${params.counterAmount.toLocaleString()}
- Round: ${params.negotiationRound}

Buyer Budget: $${params.buyerMaxBudget.toLocaleString()}
Counter Terms: ${JSON.stringify(params.counterTerms)}

Analyze the gap and recommend next move with reasoning.`,
    })

    return { success: true, strategy }
  } catch (error) {
    console.error("[AI Offer Creation] Counter strategy error:", error)
    return handleError(error, "aiCounterOfferStrategy")
  }
}

// ============================================
// 8. SUBMIT COMPLETE OFFER
// ============================================
export async function submitCompleteOffer(params: OfferCreationParams) {
  try {
    if (!isValidUUID(params.agentId) || !isValidUUID(params.buyerId) || !isValidUUID(params.listingId)) {
      return { success: false, error: "Invalid IDs provided" }
    }

    const supabase = await createClient()

    // Get listing details
    const { data: listing } = await supabase
      .from("listings")
      .select("*, agent_id, seller_id, address, state")
      .eq("id", params.listingId)
      .single()

    if (!listing) {
      return { success: false, error: "Listing not found" }
    }

    // Create transaction record
    const { data: transaction, error: txError } = await supabase
      .from("transactions")
      .insert({
        agent_id: params.agentId,
        buyer_id: params.buyerId,
        listing_id: params.listingId,
        deal_type: "buyer_side",
        status: "offer_submitted",
        property_address: listing.address,
        purchase_price: params.offerPrice,
        estimated_close_date: params.closeDate,
      })
      .select()
      .single()

    if (txError) throw txError

    // Create offer record (using canonical offers table with offer_price)
    const { data: offer, error: offerError } = await supabase
      .from("offers")
      .insert({
        transaction_id: transaction.id,
        listing_id: params.listingId,
        contact_id: params.buyerId,
        offer_price: params.offerPrice,
        earnest_money: params.earnestMoney,
        down_payment_percent: params.downPaymentPercent,
        financing_type: params.financingType,
        contingencies: params.contingencies,
        closing_date: params.closeDate,
        escalation_clause: params.escalationClause?.enabled || false,
        escalation_cap: params.escalationClause?.maxPrice,
        status: "pending",
        submitted_at: new Date().toISOString(),
      })
      .select()
      .single()

    if (offerError) throw offerError

    // Create Dotloop
    const dotloopResult = await createOfferDotloop({
      agentId: params.agentId,
      buyerId: params.buyerId,
      propertyAddress: listing.address,
      transactionId: transaction.id,
    })

    // Notify listing agent
    await supabase.from("activities").insert({
      user_id: listing.agent_id,
      activity_type: "offer_received",
      entity_type: "offer",
      entity_id: offer.id,
      description: `New offer of $${params.offerPrice.toLocaleString()} received on ${listing.address}`,
      metadata: { priority: "high" },
    })

    revalidatePath("/offers")
    revalidatePath(`/listings/${params.listingId}`)
    revalidatePath("/dashboard/transactions")

    return {
      success: true,
      offer,
      transaction,
      dotloop: dotloopResult,
    }
  } catch (error) {
    console.error("[AI Offer Creation] Submit error:", error)
    return handleError(error, "submitCompleteOffer")
  }
}

// Backward compatibility aliases
export const aiAnalyzeOfferStrategy = aiOfferStrategyAdvisor
export const generateOfferLetter = aiGenerateBuyerLetter

// ============================================
// 9. COMPLETE OFFER CREATION WORKFLOW
// ============================================
export async function runCompleteOfferWorkflow(params: {
  agentId: string
  buyerId: string
  listingId: string
  buyerMaxBudget: number
  buyerMotivation: "must_have" | "would_like" | "nice_to_have"
  buyerRiskTolerance: "conservative" | "moderate" | "aggressive"
  buyerStory?: string
  whyThisHome?: string
}) {
  try {
    const supabase = await createClient()

    // Get listing details
    const { data: listing } = await supabase
      .from("listings")
      .select("*")
      .eq("id", params.listingId)
      .single()

    if (!listing) {
      return { success: false, error: "Listing not found" }
    }

    // Get buyer details
    const { data: buyer } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.buyerId)
      .single()

    // Step 1: AI Strategy
    const strategyResult = await aiOfferStrategyAdvisor({
      agentId: params.agentId,
      buyerId: params.buyerId,
      listingId: params.listingId,
      listPrice: listing.price,
      daysOnMarket: Math.floor((Date.now() - new Date(listing.created_at).getTime()) / (1000 * 60 * 60 * 24)),
      marketConditions: "balanced",
      buyerMotivation: params.buyerMotivation,
      buyerMaxBudget: params.buyerMaxBudget,
    })

    // Step 2: Contingency recommendations
    const contingencyResult = await aiRecommendContingencies({
      buyerFinancingType: "conventional",
      propertyAge: listing.year_built ? new Date().getFullYear() - listing.year_built : 20,
      propertyCondition: "good",
      competitionLevel: "medium",
      buyerRiskTolerance: params.buyerRiskTolerance,
    })

    // Step 3: Escalation calculation
    let escalationResult = null
    if (strategyResult.success && strategyResult.strategy?.escalationRecommendation?.recommended) {
      escalationResult = await aiCalculateEscalation({
        listPrice: listing.price,
        initialOffer: strategyResult.strategy.recommendedOfferPrice,
        maxBudget: params.buyerMaxBudget,
        estimatedCompetition: "medium",
        marketTrend: "stable",
      })
    }

    // Step 4: Buyer letter (if recommended)
    let letterResult = null
    if (
      strategyResult.success &&
      strategyResult.strategy?.personalLetterRecommendation &&
      params.buyerStory &&
      params.whyThisHome
    ) {
      letterResult = await aiGenerateBuyerLetter({
        agentId: params.agentId,
        buyerFirstName: buyer?.first_name || "Buyer",
        buyerStory: params.buyerStory,
        propertyAddress: listing.address,
        whyThisHome: params.whyThisHome,
      })
    }

    // Step 5: Get required forms
    const formsResult = await getOfferForms({
      state: listing.state || "DEFAULT",
      financingType: "conventional",
      isShortSale: false,
      hasHoa: listing.has_hoa || false,
      isNewConstruction: listing.is_new_construction || false,
    })

    return {
      success: true,
      workflow: {
        strategy: strategyResult.success ? strategyResult.strategy : null,
        contingencies: contingencyResult.success ? contingencyResult.contingencies : null,
        escalation: escalationResult?.success ? escalationResult.escalation : null,
        buyerLetter: letterResult?.success ? letterResult.letter : null,
        requiredForms: formsResult.success ? formsResult.forms : null,
        listing: {
          address: listing.address,
          price: listing.price,
          state: listing.state,
        },
      },
    }
  } catch (error) {
    console.error("[AI Offer Creation] Workflow error:", error)
    return handleError(error, "runCompleteOfferWorkflow")
  }
}
