"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
// generateObjectRouted replaces direct `generateText` from "ai" — keeps
// brokerage routing + fallback + gateway wrapping for structured outputs.
import { generateObjectRouted } from "@/lib/ai/models"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
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

    const { object: strategy } = await generateObjectRouted({
      feature: "offer_analysis",
      schema: z.object({
        recommendedOfferPrice: z.number(),
        priceRangeLow: z.number(),
        priceRangeHigh: z.number(),
        winProbability: z.number().min(0).max(100),
        strategy: z.enum(["aggressive", "competitive", "conservative"]),
        reasoning: z.string(),
        escalationRecommendation: z.object({
          recommended: z.boolean(),
          suggestedMax: z.number().nullable(),
          suggestedIncrement: z.number().nullable(),
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
    const { object: escalation } = await generateObjectRouted({
      feature: "offer_analysis",
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
    const contingencyResult = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
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

Balance buyer protection with competitiveness.

Respond with JSON only: { "recommended": [{ "type": string, "duration": number, "critical": boolean, "reasoning": string }], "notRecommended": [{ "type": string, "reasoning": string }], "riskAnalysis": { "overallRisk": "low"|"medium"|"high", "buyerProtection": number, "competitiveness": number }, "suggestions": string[] }`,
    })
    let contingencies: unknown
    try {
      contingencies = JSON.parse(contingencyResult.text)
    } catch {
      return { success: false, error: "AI response was not valid JSON" }
    }
    const cont = contingencies as any
    if (
      typeof contingencies !== "object" ||
      contingencies === null ||
      !Array.isArray(cont.recommended) ||
      !Array.isArray(cont.notRecommended) ||
      typeof cont.riskAnalysis !== "object" ||
      cont.riskAnalysis === null ||
      typeof cont.riskAnalysis.overallRisk !== "string" ||
      typeof cont.riskAnalysis.buyerProtection !== "number" ||
      typeof cont.riskAnalysis.competitiveness !== "number" ||
      cont.recommended.some((r: any) => !r.type || r.duration === undefined || r.critical === undefined) ||
      cont.notRecommended.some((nr: any) => !nr.type || !nr.reasoning)
    ) {
      return { success: false, error: "AI returned malformed contingency data" }
    }

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
      model: resolveModel("openai/gpt-4o"),
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
      model: resolveModel("openai/gpt-4o-mini"),
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

    const supabase = await createClient()

    // Resolve Dotloop credentials from platform_credentials (brokerage-scoped, not env vars)
    const { data: agentRow } = await supabase
      .from("agents")
      .select("brokerage_id")
      .eq("id", params.agentId)
      .maybeSingle()
    if (!agentRow?.brokerage_id) {
      return { success: false, error: "Agent or brokerage not found" }
    }
    const serviceClient = createServiceClient()
    const { data: dotloopCred } = await serviceClient
      .from("platform_credentials")
      .select("access_token, account_id")
      .eq("brokerage_id", agentRow.brokerage_id)
      .eq("platform", "dotloop")
      .eq("is_active", true)
      .maybeSingle()
    if (!dotloopCred?.access_token || !dotloopCred?.account_id) {
      return {
        success: false,
        error: "Dotloop is not configured for your brokerage. Go to Settings > Integrations.",
        notConfigured: true,
      }
    }
    const DOTLOOP_API_KEY = dotloopCred.access_token
    const DOTLOOP_PROFILE_ID = dotloopCred.account_id

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
    const strategyResult = await generateText({
      model: resolveModel("openai/gpt-4o"),
      prompt: `Help strategize response to seller's counter offer.

Negotiation History:
- List Price: $${params.listPrice.toLocaleString()}
- Our Offer: $${params.originalOffer.toLocaleString()}
- Their Counter: $${params.counterAmount.toLocaleString()}
- Round: ${params.negotiationRound}

Buyer Budget: $${params.buyerMaxBudget.toLocaleString()}
Counter Terms: ${JSON.stringify(params.counterTerms)}

Analyze the gap and recommend next move with reasoning.

Respond with JSON only: { "recommendedResponse": "accept"|"counter"|"walk_away", "suggestedCounterPrice": number|null, "suggestedTerms": string[], "reasoning": string, "negotiationTactics": string[], "riskOfLosingDeal": number, "estimatedFinalPrice": number, "nextMoveTimeline": string }`,
    })
    let strategy: unknown
    try {
      strategy = JSON.parse(strategyResult.text)
    } catch {
      return { success: false, error: "AI response was not valid JSON" }
    }
    if (
      typeof strategy !== "object" ||
      strategy === null ||
      (!(strategy as any).recommendedResponse && !(strategy as any).strategy && !(strategy as any).offerStrategy)
    ) {
      return { success: false, error: "AI returned malformed strategy data" }
    }

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

// ============================================
// WORKFLOW OS — generate offer draft document
// ============================================
/**
 * Generates an AI-drafted purchase offer for a contact/listing combination.
 * Called by the draft_document workflow adapter when document_type = "offer".
 *
 * Retrieves the contact's most relevant active search + the brokerage's state
 * to select the correct state-specific forms, then produces a draft summary
 * and stores it on the documents record.
 */
export async function generateOfferDraft(params: {
  brokerageId: string
  contactId?: string | null
  agentUserId?: string | null
  state?: string
  documentId?: string | null
}): Promise<{ success: boolean; documentId?: string; error?: string }> {
  try {
    const supabase = await createClient()

    const state = (params.state ?? "CA").toUpperCase()
    const forms = STATE_OFFER_FORMS[state] ?? STATE_OFFER_FORMS.DEFAULT

    // Build offer draft outline via AI
    const prompt = `You are a real estate transaction coordinator. Generate a concise purchase offer
outline for a buyer in ${state}. Required forms: ${forms.required.join(", ")}.
Available addenda: ${forms.addenda.join(", ")}.
Output a structured summary of key terms, contingencies, and timeline recommendations.
Use professional language. Keep it under 400 words. Format with clear sections.`

    const { text } = await generateText({
      feature: "offer_draft",
      messages: [{ role: "user", content: prompt }],
    })

    // Update the documents record with the draft content
    if (params.documentId) {
      await supabase
        .from("documents")
        .update({
          content: text,
          status: "draft_ready",
          metadata: { state, required_forms: forms.required, available_addenda: forms.addenda },
          updated_at: new Date().toISOString(),
        })
        .eq("id", params.documentId)
    }

    return { success: true, documentId: params.documentId ?? undefined }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
