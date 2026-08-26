"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { callConnector } from "@/lib/agentic-os/connector-gateway"
// generateObjectRouted replaces direct `generateText` from "ai" — keeps
// brokerage routing + fallback + gateway wrapping for structured outputs.
import { generateObjectRouted } from "@/lib/ai/models"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
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

// ============================================
// 1. AI OFFER STRATEGY ADVISOR
// ============================================
export async function aiOfferStrategyAdvisor(params: {
  agentId?: string  // ignored — derived from session
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
    // Auth gate — burns paid AI inference. Was previously open to any
    // caller via a spoofed agentId param.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    // Shared brain — the SAME core the autonomous offer-strategy producer uses (no drift).
    const { generateBuyerOfferStrategy } = await import("@/lib/offers/offer-strategy-advisor")
    const strategy = await generateBuyerOfferStrategy({
      listPrice: params.listPrice,
      daysOnMarket: params.daysOnMarket,
      competingOffers: params.competingOffers,
      marketConditions: params.marketConditions,
      buyerMotivation: params.buyerMotivation,
      buyerMaxBudget: params.buyerMaxBudget,
    }, {
      // §4 — the session, resolved above; `params.agentId` is ignored here.
      brokerageId: ctx.brokerageId,
      userId: ctx.userId || null,
    })
    if (!strategy) return { success: false, error: "Strategy generation failed" }
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
    // Tenant for the AI cost ledger — SESSION (§4).
    const spendActor = await getAgentContext()
    const { object: escalation } = await generateObjectRouted({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
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
    // Tenant for the AI cost ledger — SESSION (§4).
    const spendActor = await getAgentContext()
    const contingencyResult = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
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
  agentId?: string  // ignored — derived from session
  buyerFirstName: string
  buyerStory: string
  propertyAddress: string
  whyThisHome: string
}) {
  try {
    // Auth gate — burns paid OpenAI inference.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    const { text: letter } = await generateText({
      brokerageId: ctx.brokerageId,
      userId: ctx.userId,
      agentId: ctx.agentId,
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
    // Tenant for the AI cost ledger — SESSION (§4).
    const spendActor = await getAgentContext()
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
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
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
  agentId?: string  // ignored — derived from session
  buyerId: string
  propertyAddress: string
  transactionId?: string
  existingLoopId?: string
}) {
  try {
    // CRITICAL auth gate — previously took caller-supplied agentId,
    // resolved it to a brokerage_id, then pulled THAT brokerage's Dotloop
    // OAuth credentials and made API calls under them. Any signed-in user
    // (or unauthenticated, since there was no auth.getUser() check) could
    // create loops on any brokerage's Dotloop account with their tokens.
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    const brokerageId = ctx.brokerageId

    const supabase = await createClient()

    // Verify the transaction (if provided) belongs to caller's brokerage
    // before we both link it and use the brokerage's Dotloop creds.
    if (params.transactionId && isValidUUID(params.transactionId)) {
      const { data: tx } = await supabase
        .from("transactions").select("brokerage_id").eq("id", params.transactionId).maybeSingle()
      if (!tx || tx.brokerage_id !== brokerageId) {
        return { success: false, error: "Forbidden: transaction not in your brokerage" }
      }
    }

    // Resolve Dotloop credentials from caller's session brokerage only
    const serviceClient = createServiceClient()
    const { data: dotloopCred } = await serviceClient
      .from("platform_credentials")
      .select("access_token, account_id")
      .eq("brokerage_id", brokerageId)
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

    // If existing loop provided, link to it (transaction ownership was
    // already verified above)
    if (params.existingLoopId) {
      if (params.transactionId) {
        await supabase
          .from("transactions")
          .update({ external_provider_transaction_id: params.existingLoopId, external_provider_source: "dotloop" })
          .eq("id", params.transactionId)
          .eq("brokerage_id", brokerageId)
      }

      return {
        success: true,
        loopId: params.existingLoopId,
        loopUrl: `https://www.dotloop.com/loop/${params.existingLoopId}`,
        linked: true,
      }
    }

    // Create new loop — routed through the canonical connector-gateway so this Dotloop call gets
    // the same single-egress, healer-observable, retry-instrumented treatment as every other
    // vendor call (single source of truth: lib/agentic-os/connector-gateway.ts). The previous bare
    // `fetch(...)` to api-gateway.dotloop.com bypassed all of that. Uses per-brokerage credentials
    // from platform_credentials (not env vars) so multi-tenant routing is preserved.
    const response = await callConnector<{ data?: { loop_id?: string } }>({
      connector: "dotloop",
      baseUrl:   "https://api-gateway.dotloop.com/public/v2",
      path:      `/profile/${DOTLOOP_PROFILE_ID}/loop`,
      method:    "POST",
      auth:      { style: "bearer", token: DOTLOOP_API_KEY },
      body: {
        name: `${params.propertyAddress} - Buyer Offer`,
        status: "Active",
        deal_type: "Purchase",
        street_address: params.propertyAddress,
      },
    })

    if (!response.ok) {
      throw new Error(`Dotloop API error: ${response.error ?? `HTTP ${response.status ?? "?"}`}`)
    }

    const loopId = response.data?.data?.loop_id

    // Update transaction (ownership verified above). Stamps the generic m106
    // provider-tracking columns so the provider-agnostic sync helper
    // (lib/transactions/sync-from-provider.ts) can pull documents for this transaction.
    if (params.transactionId && loopId) {
      await supabase.from("transactions")
        .update({
          external_provider_source:         "dotloop",
          external_provider_transaction_id: loopId,
        })
        .eq("id", params.transactionId)
        .eq("brokerage_id", brokerageId)
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
    // Tenant for the AI cost ledger — SESSION (§4).
    const spendActor = await getAgentContext()
    const strategyResult = await generateText({
      brokerageId: spendActor.brokerageId,
      userId: spendActor.userId || null,
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
// 8. SUBMIT COMPLETE OFFER — REMOVED (duplicate writer)
// ============================================
// `submitCompleteOffer` used to live here: a SECOND offer writer that inserted
// into `transactions` + `offers` directly. The canonical writer is
// app/actions/buyer-offers.ts:createOffer, which is the one the offer wizard
// actually uses and is strictly more complete. This copy was not merely
// redundant, it was unsafe:
//   · it BYPASSED the financial-verification gate (buyer_financial_profiles
//     .verified) that createOffer enforces at the API boundary, so any
//     signed-in agent could bind an unverified buyer to an offer through it;
//   · it wrote the offers row with NO brokerage_id and NO agent_id, so the
//     resulting offer was invisible to every tenant-scoped offers surface;
//   · it minted a status:'active' `transactions` row per SUBMITTED offer,
//     before any acceptance — one phantom deal in the pipeline per offer;
//   · its "offer received" activities insert omitted brokerage_id (NOT NULL),
//     so that notification wrote zero rows while reporting success. The real
//     listing-side notification lives at the wizard
//     (offer-form-wizard.tsx:notifyListingSide) and supplies the tenant.
// Nothing was lost by removing it: the Dotloop step it performed is
// `createOfferDotloop` above, still exported and still reached through
// lib/workflow/adapters/send-for-esign.ts.

// Backward compatibility aliases — wrapped because "use server" rejects `const = fn`
export async function aiAnalyzeOfferStrategy(...args: Parameters<typeof aiOfferStrategyAdvisor>) {
  return aiOfferStrategyAdvisor(...args)
}
export async function generateOfferLetter(...args: Parameters<typeof aiGenerateBuyerLetter>) {
  return aiGenerateBuyerLetter(...args)
}

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
    // Auth gate — workflow chain makes paid AI calls
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    // NOT `?? ctx.userId` (m360) — every consumer below is agents-class.
    const effectiveAgentId = ctx.agentId
    if (!effectiveAgentId) return { success: false, error: "No agent profile for this user yet — finish account setup." }

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

    // Buyer must belong to caller's brokerage
    const { data: buyer } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.buyerId)
      .single()
    if (!buyer || buyer.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Forbidden" }
    }

    // Step 1: AI Strategy
    const strategyResult = await aiOfferStrategyAdvisor({
      agentId: effectiveAgentId,
      buyerId: params.buyerId,
      listingId: params.listingId,
      listPrice: listing.list_price,
      daysOnMarket: Math.floor((Date.now() - new Date(listing.created_at).getTime()) / (1000 * 60 * 60 * 24)),
      marketConditions: "balanced",
      buyerMotivation: params.buyerMotivation,
      buyerMaxBudget: params.buyerMaxBudget,
    })

    // Financing type comes from the buyer's REAL pre-approval record (buyer_financial_profiles)
    // — never assumed conventional (owner correction). Cash flag wins; a missing profile reads
    // honestly as unknown so the AI reasons about the uncertainty instead of a fiction.
    let buyerFinancingType = "unknown (no pre-approval or lender record on file)"
    try {
      const { data: finProfile } = await supabase
        .from("buyer_financial_profiles")
        .select("finance_type, is_cash_buyer")
        .eq("contact_id", params.buyerId)
        .maybeSingle()
      if (finProfile?.is_cash_buyer === true) buyerFinancingType = "cash"
      else if (finProfile?.finance_type) buyerFinancingType = String(finProfile.finance_type)
    } catch { /* honest unknown */ }

    // Step 2: Contingency recommendations
    const contingencyResult = await aiRecommendContingencies({
      buyerFinancingType,
      propertyAge: listing.year_built ? new Date().getFullYear() - listing.year_built : 20,
      propertyCondition: "good",
      competitionLevel: "medium",
      buyerRiskTolerance: params.buyerRiskTolerance,
    })

    // Step 3: Escalation calculation
    let escalationResult = null
    if (strategyResult.success && strategyResult.strategy?.escalationRecommendation?.recommended) {
      escalationResult = await aiCalculateEscalation({
        listPrice: listing.list_price,
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
        agentId: effectiveAgentId,
        buyerFirstName: buyer?.first_name || "Buyer",
        buyerStory: params.buyerStory,
        propertyAddress: listing.address,
        whyThisHome: params.whyThisHome,
      })
    }

    // Step 5: Get required forms
    const formsResult = await getOfferForms({
      state: listing.state || "DEFAULT",
      financingType: buyerFinancingType, // real record or honest "unknown" — never assumed conventional
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
          price: listing.list_price,
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
/**
 * Stage an offer PACKET for an agent to complete in the FormWizard.
 *
 * An offer cannot be fully auto-generated by a workflow — it requires the
 * buyer's legal full name (driver's license), the property address, and
 * specific terms (price, EMD, contingencies, close date, financing) that
 * the agent has to decide with the buyer.
 *
 * Instead, this action prepares an OFFER PACKET:
 *   1. Pulls the state-specific required + addenda forms
 *   2. Prefills the fields we DO know (buyer info, property, agent info)
 *   3. Flags the fields the AGENT must complete (offer terms)
 *   4. Stores the packet on the documents row with status='needs_agent_input'
 *   5. Notifies the agent with a deep link into the offer FormWizard so they
 *      can finalize. After they approve, they trigger the eSign step which
 *      uses THEIR configured eSign provider (Dotloop / DocuSign / etc.).
 *
 * This is NOT marketing content — no brand-voice or them-first checks apply.
 * It IS legal/financial paperwork that always needs human approval.
 */
export async function generateOfferDraft(params: {
  brokerageId: string
  contactId?: string | null
  agentUserId?: string | null
  /** 2-letter US state code from the PROPERTY ADDRESS — required, no default. */
  state: string
  documentId?: string | null
  propertyAddress?: string
  listingId?: string | null
}): Promise<{ success: boolean; documentId?: string; error?: string }> {
  try {
    const supabase = await createClient()

    const { getStateForms } = await import("@/lib/state-forms/registry")
    const forms = getStateForms(params.state, "offer")
    const state = params.state.trim().toUpperCase()

    // ── Prefill what we know ─────────────────────────────────────────────
    let buyerName: string | null = null
    let buyerEmail: string | null = null
    let buyerPhone: string | null = null
    if (params.contactId) {
      const { data: c } = await supabase
        .from("contacts")
        .select("first_name, last_name, email, phone")
        .eq("id", params.contactId)
        .maybeSingle()
      if (c) {
        buyerName  = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || null
        buyerEmail = c.email ?? null
        buyerPhone = c.phone ?? null
      }
    }

    let agentName: string | null = null
    let agentLicense: string | null = null
    if (params.agentUserId) {
      const { data: a } = await supabase
        .from("agents")
        .select("license_number, license_state, user_id")
        .eq("user_id", params.agentUserId)
        .maybeSingle()
      if (a) agentLicense = a.license_number ?? null
      const { data: u } = await supabase
        .from("users")
        .select("first_name, last_name")
        .eq("id", params.agentUserId)
        .maybeSingle()
      if (u) agentName = `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || null
    }

    let listingPrice: number | null = null
    let listingAddress: string | null = params.propertyAddress ?? null
    if (params.listingId) {
      const { data: listing } = await supabase
        .from("listings")
        .select("address, city, state, zip, list_price")
        .eq("id", params.listingId)
        .maybeSingle()
      if (listing) {
        listingPrice   = listing.list_price ?? null
        listingAddress = listing.address ?? listingAddress
      }
    }

    // ── Build the packet ─────────────────────────────────────────────────
    const packet = {
      packet_type: "offer",
      state,
      created_at: new Date().toISOString(),
      forms: {
        required: forms.required,
        addenda:  forms.addenda,
        brokerage_representation: forms.brokerageRepresentation,
      },
      // Fields the workflow has prefilled — agent should verify
      prefilled: {
        buyer_legal_name: buyerName,
        buyer_email:      buyerEmail,
        buyer_phone:      buyerPhone,
        agent_name:       agentName,
        agent_license:    agentLicense,
        property_address: listingAddress,
        list_price:       listingPrice,
      },
      // Fields the AGENT must complete in the FormWizard
      needs_agent_input: [
        { field: "buyer_legal_name_verified",  reason: "Must match driver's license exactly", suggested: buyerName },
        { field: "offer_price",                reason: "Strategy decision with buyer" },
        { field: "earnest_money_amount",       reason: "Negotiated separately" },
        { field: "down_payment_percent",       reason: "From buyer's lender or POF" },
        { field: "financing_type",             reason: "conventional | fha | va | cash | usda | other" },
        { field: "contingencies",              reason: "Inspection / appraisal / financing / sale-of-other-property" },
        { field: "close_date",                 reason: "Coordinate with title + lender" },
        { field: "escalation_clause",          reason: "Optional, set max + increment" },
        { field: "additional_addenda",         reason: `Available for ${state}: ${forms.addenda.slice(0,3).join(", ")}…` },
      ],
      formwizard_url: params.contactId
        ? `/crm?contact=${params.contactId}&action=new_offer`
        : "/crm",
    }

    // ── Persist packet on documents row ──────────────────────────────────
    //
    // MERGE, NEVER REPLACE. This update used to assign `content` and `metadata`
    // wholesale, and it runs immediately AFTER the caller has staged the row —
    // draft-offer-from-voice.ts writes `content = { filledPacket, intake }` and
    // `metadata.linked_offer_id`, then calls this function. The wholesale assign
    // destroyed BOTH:
    //   · `metadata.linked_offer_id` is the ONLY key
    //     lib/workflow/intelligence/scan-offer-packet.ts uses to find an offer's
    //     packet. Losing it makes the packet unfindable, forever.
    //   · `content.filledPacket` is the ONLY thing that scan reads. The object
    //     built here has no `filledPacket` key at all, so even a found row
    //     scanned as empty.
    // Together those made the completeness scan silently unrunnable on the one
    // path that stages a packet — which the audit gate then read as "nothing
    // missing" (wave 9, D1). With the gate now failing closed, an un-merged
    // write here would refuse EVERY offer instead, so this is load-bearing in
    // both directions.
    //
    // The two shapes share no keys, so a top-level merge is lossless: the scan
    // keeps `filledPacket` + `intake`, packet consumers keep theirs.
    if (params.documentId) {
      const { data: existingDoc, error: existingErr } = await supabase
        .from("documents")
        .select("content, metadata")
        .eq("id", params.documentId)
        .eq("brokerage_id", params.brokerageId)
        .maybeSingle()
      if (existingErr) {
        console.error("[AI Offer Creation] Could not read the staged document before merging the packet — refusing to overwrite it blind:", existingErr.message)
        return handleError(existingErr, "generateOfferDraft")
      }

      let priorContent: Record<string, unknown> = {}
      try {
        const parsed = JSON.parse((existingDoc?.content as string | null) ?? "{}")
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) priorContent = parsed
      } catch { /* unparseable prior content is replaced, not merged */ }
      const priorMetadata = (existingDoc?.metadata ?? {}) as Record<string, unknown>

      const packetUpdate = {
        content: JSON.stringify({ ...priorContent, ...packet }, null, 2),
        status: "needs_agent_input",         // NOT draft_ready — packet awaits human finalization
        metadata: {
          ...priorMetadata,                  // keeps linked_offer_id and anything else staged
          state,
          packet_type: "offer",
          required_forms: forms.required,
          available_addenda: forms.addenda,
          brokerage_representation_form: forms.brokerageRepresentation,
          prefilled: packet.prefilled,
          unknown_fields: packet.needs_agent_input.map(f => f.field),
          formwizard_url: packet.formwizard_url,
        },
        updated_at: new Date().toISOString(),
      }
      // CHECKED: a silently-dropped update here is what produced the unfindable
      // packet in the first place, and supabase-js RESOLVES a refused write.
      const { error: packetWriteErr } = await supabase
        .from("documents")
        .update(packetUpdate)
        .eq("id", params.documentId)
        // tenant anchor (scope burn-down): document must belong to the workflow's brokerage
        .eq("brokerage_id", params.brokerageId)
      if (packetWriteErr) {
        console.error("[AI Offer Creation] Packet did not persist to the document row:", packetWriteErr.message)
        return handleError(packetWriteErr, "generateOfferDraft")
      }
    }

    // ── Notify agent that the packet is ready for review ─────────────────
    if (params.agentUserId) {
      void Promise.resolve(supabase.from("notifications").insert({
        user_id: params.agentUserId,
        brokerage_id: params.brokerageId,
        type: "offer_packet_ready",
        title: `Offer packet ready for ${buyerName ?? "buyer"}`,
        body: `Required forms for ${state} are staged with prefilled fields. Open the offer FormWizard to complete terms and approve before sending for signature.`,
        priority: "high",
        entity_type: "document",
        entity_id: params.documentId ?? null,
        channel: "in_app",
      })).catch(() => {})
    }

    return { success: true, documentId: params.documentId ?? undefined }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
