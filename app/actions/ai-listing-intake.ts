"use server"

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateObject } from "@/lib/ai/generate"
import { resolveModel } from "@/lib/ai/resolve-model"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { guardContent } from "@/lib/content-guardian"
import { getAgentContext } from "@/lib/identity/get-agent-context"
import { z } from "zod"

// ============================================
// AI LISTING INTAKE SYSTEM
// Complete workflow for agents creating listings
// with state-specific forms, Dotloop integration,
// and AI-powered assistance
// ============================================

// State-specific form configurations
const STATE_FORMS: Record<string, { required: string[]; optional: string[]; disclosures: string[] }> = {
  TX: {
    required: [
      "TAR 1101 - Listing Agreement",
      "TAR 1406 - Seller's Disclosure Notice",
      "TAR 1407 - Lead-Based Paint Disclosure",
      "TAR 2301 - Information About Brokerage Services",
    ],
    optional: ["TAR 1915 - MUD Notice", "TAR 1918 - Coastal Area Property Notice"],
    disclosures: ["seller_disclosure", "lead_paint", "hoa_docs", "survey"],
  },
  CA: {
    required: [
      "CAR RLA - Residential Listing Agreement",
      "CAR TDS - Transfer Disclosure Statement",
      "CAR SPQ - Seller Property Questionnaire",
      "CAR AD - Agency Disclosure",
    ],
    optional: ["CAR NHD - Natural Hazard Disclosure", "CAR MHTDS - Manufactured Home TDS"],
    disclosures: ["transfer_disclosure", "natural_hazard", "lead_paint", "earthquake"],
  },
  FL: {
    required: [
      "FAR/BAR Listing Agreement",
      "Seller's Property Disclosure",
      "Lead-Based Paint Disclosure",
      "Agency Disclosure",
    ],
    optional: ["HOA/COA Disclosure", "Flood Zone Disclosure"],
    disclosures: ["seller_disclosure", "lead_paint", "hoa_docs", "flood_zone"],
  },
  // Add more states as needed
  DEFAULT: {
    required: ["Listing Agreement", "Seller's Disclosure", "Lead-Based Paint Disclosure", "Agency Disclosure"],
    optional: [],
    disclosures: ["seller_disclosure", "lead_paint"],
  },
}

interface ListingIntakeData {
  agentId: string
  brokerageId: string
  propertyAddress: string
  city: string
  state: string
  zipCode: string
  propertyType: "single_family" | "condo" | "townhouse" | "multi_family" | "land" | "commercial"
  sellerId?: string | null
  listPrice?: number
  propertyDetails?: any
}

// ============================================
// 1. AI PROPERTY DATA ENRICHMENT
// ============================================
export async function aiEnrichPropertyData(address: string, agentId: string) {
  try {
    if (!isValidUUID(agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    // Call external data enrichment APIs (tax records, MLS history, etc.)
    // This would integrate with BatchData, CoreLogic, or similar
    const enrichmentPrompt = `You are a real estate data analyst. Based on this address, estimate property details.
Address: ${address}

Provide realistic estimates in JSON format:
{
  "beds": number,
  "baths": number,
  "sqft": number,
  "yearBuilt": number,
  "lotSize": number,
  "stories": number,
  "garage": number,
  "pool": boolean,
  "propertyType": "single_family" | "condo" | "townhouse",
  "style": "modern" | "traditional" | "craftsman" | "mediterranean" | "contemporary",
  "roofType": string,
  "hvac": string,
  "estimatedValue": number,
  "estimatedRent": number,
  "schoolDistrict": string,
  "walkScore": number,
  "floodZone": string
}`

    const { object: propertyData } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: z.object({
        beds: z.number(),
        baths: z.number(),
        sqft: z.number(),
        yearBuilt: z.number(),
        lotSize: z.number(),
        stories: z.number(),
        garage: z.number(),
        pool: z.boolean(),
        propertyType: z.enum(["single_family", "condo", "townhouse"]),
        style: z.string(),
        roofType: z.string(),
        hvac: z.string(),
        estimatedValue: z.number(),
        estimatedRent: z.number(),
        schoolDistrict: z.string(),
        walkScore: z.number(),
        floodZone: z.string(),
      }),
      prompt: enrichmentPrompt,
    })

    // Log the enrichment
    await supabase.from("ai_usage_log").insert({
      agent_id: agentId,
      action_type: "property_enrichment",
      input_data: { address },
      output_data: propertyData,
      tokens_used: 500,
    })

    return { success: true, data: propertyData }
  } catch (error) {
    console.error("[AI Listing Intake] Enrichment error:", error)
    return handleError(error, "aiEnrichPropertyData")
  }
}

// ============================================
// 2. AI STATE FORM RECOMMENDER
// ============================================
export async function aiGetRequiredForms(params: {
  state: string
  propertyType: string
  transactionType: "standard" | "short_sale" | "foreclosure" | "new_construction"
  hasHoa: boolean
  hasPool: boolean
  isHistoric: boolean
  leadPaintYear?: number
}) {
  try {
    const stateConfig = STATE_FORMS[params.state] || STATE_FORMS.DEFAULT

    // Start with required forms
    const forms = [...stateConfig.required]
    const disclosures = [...stateConfig.disclosures]

    // Add conditional forms
    if (params.hasHoa) {
      forms.push("HOA Disclosure Package")
      disclosures.push("hoa_financials", "hoa_rules")
    }

    if (params.hasPool) {
      forms.push("Pool Safety Disclosure")
      disclosures.push("pool_inspection")
    }

    if (params.leadPaintYear && params.leadPaintYear < 1978) {
      if (!forms.some((f) => f.toLowerCase().includes("lead"))) {
        forms.push("Lead-Based Paint Disclosure")
      }
    }

    if (params.transactionType === "short_sale") {
      forms.push("Short Sale Addendum")
      forms.push("Lender Authorization")
    }

    // AI enhancement for special circumstances
    const { text: aiRecommendations } = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: `As a real estate compliance expert for ${params.state}, review this listing:
Property Type: ${params.propertyType}
Transaction: ${params.transactionType}
Has HOA: ${params.hasHoa}
Has Pool: ${params.hasPool}
Historic Property: ${params.isHistoric}
Built: ${params.leadPaintYear || "Unknown"}

Are there any additional state-specific forms or disclosures required?
List only the form names, one per line. If none, respond with "NONE".`,
    })

    const additionalForms =
      aiRecommendations !== "NONE"
        ? aiRecommendations
            .split("\n")
            .filter((f) => f.trim())
            .map((f) => f.trim())
        : []

    return {
      success: true,
      forms: {
        required: forms,
        optional: stateConfig.optional,
        aiRecommended: additionalForms,
        disclosures,
      },
    }
  } catch (error) {
    console.error("[AI Listing Intake] Form recommender error:", error)
    return handleError(error, "aiGetRequiredForms")
  }
}

// ============================================
// 3. AI LISTING DESCRIPTION GENERATOR
// ============================================
export async function aiGenerateListingDescription(params: {
  agentId: string
  propertyData: any
  style: "luxury" | "family" | "investor" | "first_time_buyer"
  highlights?: string[]
  neighborhood?: string
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    // Resolve brokerage for the agent (used for compliance/brand-voice scoping).
    // getAgentContext() resolves the CURRENT session user, which may differ from
    // params.agentId when a broker acts on behalf of another agent. Fall back to a
    // direct DB lookup on the agents table so brand-voice / compliance scope is
    // always tied to the generating agent, not the caller.
    const agentCtx = await getAgentContext().catch(() => null)
    let brokerageId: string | null = agentCtx?.brokerageId ?? null
    if (!brokerageId || agentCtx?.agentId !== params.agentId) {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("brokerage_id")
        .eq("id", params.agentId)
        .maybeSingle()
      brokerageId = agentRow?.brokerage_id ?? null
      if (!brokerageId) {
        return { success: false, error: "Unable to resolve agent brokerage for compliance checks" }
      }
    }

    // Get agent's brand voice
    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("agent_id", params.agentId)
      .maybeSingle()

    const { object: descriptions } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        mlsDescription: z.string().describe("MLS-compliant description, 500 chars max, no superlatives"),
        marketingDescription: z.string().describe("Marketing headline and paragraph for websites"),
        socialCaption: z.string().describe("Instagram/Facebook caption with hashtags"),
        emailTeaser: z.string().describe("Email preview text, 150 chars"),
        videoScript: z.string().describe("30-second video walkthrough script"),
        seoTitle: z.string().describe("SEO-optimized page title"),
        seoDescription: z.string().describe("Meta description for search engines"),
      }),
      prompt: `You are a real estate copywriter. Generate multiple descriptions for this listing.

Property Details:
${JSON.stringify(params.propertyData, null, 2)}

Target Audience: ${params.style}
Highlights: ${params.highlights?.join(", ") || "None specified"}
Neighborhood: ${params.neighborhood || "Not specified"}
${brandVoice ? `Brand Voice: ${brandVoice.tone}, ${brandVoice.style}` : ""}

IMPORTANT RULES:
- MLS description must be factual, no "best" or "amazing"
- Include Fair Housing compliant language
- Marketing can be more persuasive
- Social should be engaging with relevant hashtags
- All content must be original`,
    })

    // Run compliance + BrandVoice guard on MLS description (the regulated channel)
    const guardResult = brokerageId
      ? await guardContent({
          content:     descriptions.mlsDescription,
          agentId:     params.agentId,
          brokerageId,
          contentType: "listing_description",
        }).catch((err) => {
            console.error("[compliance-guard] guardContent threw — treating as guard failure:", err)
            return { flagged: false, guardFailed: true, violations: [], notes: [], content: "", brandVoiceChecked: false }
          })
      : null

    // Save generated content
    await supabase.from("listing_marketing_content").insert({
      agent_id: params.agentId,
      content_type: "ai_descriptions",
      content: descriptions,
      target_audience: params.style,
      status: "draft",
    })

    return {
      success: true,
      descriptions,
      guardResult: guardResult ? {
        flagged:     guardResult.flagged,
        violations:  guardResult.violations,
        notes:       guardResult.notes,
      } : null,
    }
  } catch (error) {
    console.error("[AI Listing Intake] Description error:", error)
    return handleError(error, "aiGenerateListingDescription")
  }
}

// ============================================
// 4. AI PRICING RECOMMENDATION
// ============================================
export async function aiSuggestListPrice(params: {
  agentId: string
  propertyData: any
  comparables?: any[]
  marketConditions?: "hot" | "balanced" | "cooling"
  motivation?: "quick_sale" | "maximize_price" | "balanced"
}) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const { object: pricing } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        suggestedListPrice: z.number(),
        priceRangeLow: z.number(),
        priceRangeHigh: z.number(),
        pricePerSqFt: z.number(),
        daysOnMarketEstimate: z.number(),
        competitivePosition: z.enum(["aggressive", "market", "premium"]),
        reasoning: z.string(),
        adjustments: z.array(
          z.object({
            factor: z.string(),
            impact: z.number(),
            explanation: z.string(),
          })
        ),
        marketAnalysis: z.string(),
      }),
      prompt: `You are a real estate pricing expert. Analyze and recommend list price.

Property:
${JSON.stringify(params.propertyData, null, 2)}

Comparables:
${params.comparables ? JSON.stringify(params.comparables, null, 2) : "No comps provided - estimate based on property details"}

Market Conditions: ${params.marketConditions || "balanced"}
Seller Motivation: ${params.motivation || "balanced"}

Provide:
1. Suggested list price with reasoning
2. Price range (low to high)
3. Estimated days on market
4. Key adjustments from comps
5. Market positioning strategy`,
    })

    return { success: true, pricing }
  } catch (error) {
    console.error("[AI Listing Intake] Pricing error:", error)
    return handleError(error, "aiSuggestListPrice")
  }
}

// ============================================
// 5. AI COMPLIANCE CHECKER
// ============================================
export async function aiCheckListingCompliance(params: {
  agentId: string
  description: string
  photos?: string[]
  state: string
}) {
  try {
    const { object: compliance } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        isCompliant: z.boolean(),
        overallScore: z.number().min(0).max(100),
        issues: z.array(
          z.object({
            severity: z.enum(["critical", "warning", "suggestion"]),
            category: z.string(),
            issue: z.string(),
            suggestion: z.string(),
            location: z.string().optional(),
          })
        ),
        fairHousingCheck: z.object({
          passed: z.boolean(),
          flaggedPhrases: z.array(z.string()),
        }),
        mlsCompliance: z.object({
          passed: z.boolean(),
          issues: z.array(z.string()),
        }),
        suggestedRevisions: z.string().optional(),
      }),
      prompt: `You are a real estate compliance officer for ${params.state}. Review this listing for compliance issues.

Listing Description:
${params.description}

Check for:
1. Fair Housing violations (no discriminatory language)
2. MLS compliance (no unauthorized claims, proper format)
3. State-specific requirements for ${params.state}
4. Accuracy of claims
5. Required disclosures

Be thorough - missing compliance can result in fines or license issues.`,
    })

    return { success: true, compliance }
  } catch (error) {
    console.error("[AI Listing Intake] Compliance error:", error)
    return handleError(error, "aiCheckListingCompliance")
  }
}

// ============================================
// 6. DOTLOOP INTEGRATION - CREATE OR PULL LOOP
// ============================================
export async function createOrPullDotloop(params: {
  agentId: string
  listingId?: string
  propertyAddress: string
  sellerId: string
  transactionType: "listing" | "purchase"
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

    // If existing loop, pull data from it
    if (params.existingLoopId) {
      const response = await fetch(
        `https://api-gateway.dotloop.com/public/v2/profile/${DOTLOOP_PROFILE_ID}/loop/${params.existingLoopId}`,
        {
          headers: { Authorization: `Bearer ${DOTLOOP_API_KEY}` },
        }
      )

      if (!response.ok) {
        throw new Error(`Dotloop API error: ${response.statusText}`)
      }

      const loopData = await response.json()

      // Get documents
      const docsResponse = await fetch(
        `https://api-gateway.dotloop.com/public/v2/profile/${DOTLOOP_PROFILE_ID}/loop/${params.existingLoopId}/folder`,
        {
          headers: { Authorization: `Bearer ${DOTLOOP_API_KEY}` },
        }
      )

      const docsData = await docsResponse.json()

      return {
        success: true,
        loopId: params.existingLoopId,
        loopData: loopData.data,
        documents: docsData.data || [],
        pulled: true,
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
          name: `${params.propertyAddress} - ${params.transactionType === "listing" ? "Listing" : "Purchase"}`,
          status: "Active",
          transaction_type: params.transactionType === "listing" ? "Listing for Sale" : "Purchase",
          street_address: params.propertyAddress,
        }),
      }
    )

    if (!response.ok) {
      throw new Error(`Dotloop API error: ${response.statusText}`)
    }

    const result = await response.json()
    const loopId = result.data?.loop_id

    // Update listing with loop ID
    if (params.listingId) {
      await supabase.from("listings").update({ dotloop_loop_id: loopId }).eq("id", params.listingId)
    }

    return {
      success: true,
      loopId,
      loopUrl: `https://www.dotloop.com/loop/${loopId}`,
      created: true,
    }
  } catch (error) {
    console.error("[AI Listing Intake] Dotloop error:", error)
    return handleError(error, "createOrPullDotloop")
  }
}

// ============================================
// 7. AI DOCUMENT STATUS CHECKER
// ============================================
export async function aiCheckDocumentStatus(params: { loopId: string; agentId: string }) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    // Resolve Dotloop credentials from platform_credentials (brokerage-scoped, not env vars)
    const supabase = await createClient()
    const { data: agentRow2 } = await supabase
      .from("agents")
      .select("brokerage_id")
      .eq("id", params.agentId)
      .maybeSingle()
    if (!agentRow2?.brokerage_id) {
      return { success: false, error: "Agent or brokerage not found" }
    }
    const serviceClient2 = createServiceClient()
    const { data: dotloopCred2 } = await serviceClient2
      .from("platform_credentials")
      .select("access_token, account_id")
      .eq("brokerage_id", agentRow2.brokerage_id)
      .eq("platform", "dotloop")
      .eq("is_active", true)
      .maybeSingle()
    if (!dotloopCred2?.access_token || !dotloopCred2?.account_id) {
      return {
        success: false,
        error: "Dotloop is not configured for your brokerage. Go to Settings > Integrations.",
        notConfigured: true,
      }
    }
    const DOTLOOP_API_KEY = dotloopCred2.access_token
    const DOTLOOP_PROFILE_ID = dotloopCred2.account_id

    // Fetch documents from Dotloop
    const response = await fetch(
      `https://api-gateway.dotloop.com/public/v2/profile/${DOTLOOP_PROFILE_ID}/loop/${params.loopId}/folder`,
      {
        headers: { Authorization: `Bearer ${DOTLOOP_API_KEY}` },
      }
    )

    const folders = await response.json()
    const documents: any[] = []

    for (const folder of folders.data || []) {
      for (const doc of folder.documents || []) {
        documents.push({
          id: doc.document_id,
          name: doc.name,
          folder: folder.name,
          status: doc.is_signed ? "signed" : doc.signature_pending ? "pending_signature" : "not_started",
          signedDate: doc.signed_date,
        })
      }
    }

    const summary = {
      total: documents.length,
      signed: documents.filter((d) => d.status === "signed").length,
      pending: documents.filter((d) => d.status === "pending_signature").length,
      notStarted: documents.filter((d) => d.status === "not_started").length,
    }

    // AI recommendation
    const { text: recommendation } = await generateText({
      model: resolveModel("openai/gpt-4o-mini"),
      prompt: `As a transaction coordinator, review these document statuses and provide a brief action recommendation:

${documents.map((d) => `- ${d.name}: ${d.status}`).join("\n")}

Summary: ${summary.signed}/${summary.total} signed, ${summary.pending} pending, ${summary.notStarted} not started

Provide a 1-2 sentence recommendation for the agent.`,
    })

    return {
      success: true,
      documents,
      summary,
      aiRecommendation: recommendation,
    }
  } catch (error) {
    console.error("[AI Listing Intake] Document status error:", error)
    return handleError(error, "aiCheckDocumentStatus")
  }
}

// ============================================
// 8. CREATE COMPLETE LISTING
// ============================================
export async function createListing(params: ListingIntakeData) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    // Create the listing — use live schema column names only
    const { data: listing, error } = await supabase
      .from("listings")
      .insert({
        agent_id:          params.agentId,
        brokerage_id:      params.brokerageId,
        seller_contact_id: params.sellerId && isValidUUID(params.sellerId) ? params.sellerId : null,
        address:           params.propertyAddress,
        city:              params.city,
        state:             params.state,
        zip:               params.zipCode,
        property_type:     params.propertyType,
        list_price:        params.listPrice ?? null,
        bedrooms:          params.propertyDetails?.beds,
        bathrooms:         params.propertyDetails?.baths,
        sqft:              params.propertyDetails?.sqft,
        status:            "draft",
        current_stage:     "LEAD",
        lifecycle_stage:   "LEAD",
      })
      .select()
      .maybeSingle()

    if (error || !listing) throw error ?? new Error("Failed to create listing")

    // Create transaction record — seller_contact_id is the FK in transactions
    const { data: transaction } = await supabase
      .from("transactions")
      .insert({
        agent_id:          params.agentId,
        brokerage_id:      params.brokerageId,
        seller_contact_id: params.sellerId && isValidUUID(params.sellerId) ? params.sellerId : null,
        listing_id:        listing.id,
        transaction_type:  "seller_side",
        status:            "pre_listing",
        property_address:  params.propertyAddress,
      })
      .select()
      .maybeSingle()

    // Create Dotloop loop
    const dotloopResult = await createOrPullDotloop({
      agentId: params.agentId,
      listingId: listing.id,
      propertyAddress: params.propertyAddress,
      sellerId: params.sellerId ?? "",
      transactionType: "listing",
    })

    // Update listing with loop ID
    if (dotloopResult.success && dotloopResult.loopId) {
      await supabase
        .from("listings")
        .update({ dotloop_loop_id: dotloopResult.loopId })
        .eq("id", listing.id)
    }

    revalidatePath("/dashboard/listings")
    revalidatePath("/dashboard/listings/[id]", "page")
    revalidatePath("/dashboard/transactions")

    return {
      success: true,
      listing,
      transaction,
      dotloop: dotloopResult,
    }
  } catch (error) {
    console.error("[AI Listing Intake] Create listing error:", error)
    return handleError(error, "createListing")
  }
}

// ============================================
// 9. AI PHOTO ORDERING OPTIMIZER
// ============================================
export async function aiOptimizePhotoOrder(params: { listingId: string; photos: string[]; agentId: string }) {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const { object: optimization } = await generateObject({
      model: resolveModel("openai/gpt-4o"),
      schema: z.object({
        optimizedOrder: z.array(z.number()).describe("Indices of photos in optimal order"),
        heroPhoto: z.number().describe("Index of the best hero/cover photo"),
        reasoning: z.string(),
        suggestions: z.array(z.string()).describe("Suggestions for improving photos"),
      }),
      prompt: `You are a real estate photography expert. Analyze these ${params.photos.length} listing photos and determine the optimal order.

Photo URLs: ${params.photos.join(", ")}

Best practices:
1. Hero shot should be the most appealing exterior or dramatic interior
2. Follow a logical flow (exterior > entry > main living > kitchen > bedrooms > bathrooms > backyard)
3. Save the best for strategic placement
4. Group similar spaces together

Provide the optimal order and reasoning.`,
    })

    return { success: true, optimization }
  } catch (error) {
    console.error("[AI Listing Intake] Photo optimization error:", error)
    return handleError(error, "aiOptimizePhotoOrder")
  }
}

// ============================================
// 10. COMPLETE LISTING INTAKE WORKFLOW
// ============================================
export async function runCompleteListingIntake(params: {
  agentId: string
  address: string
  city: string
  state: string
  zipCode: string
  sellerId: string
  propertyType: "single_family" | "condo" | "townhouse" | "multi_family" | "land" | "commercial"
  hasHoa?: boolean
  hasPool?: boolean
}) {
  try {
    const agentCtx = await getAgentContext()
    const brokerageId = agentCtx.brokerageId
    if (!brokerageId) return { success: false, error: "Missing brokerage context" }

    // Step 1: Enrich property data
    const enrichResult = await aiEnrichPropertyData(params.address, params.agentId)
    if (!enrichResult.success) return enrichResult

    // Step 2: Get required forms
    const formsResult = await aiGetRequiredForms({
      state: params.state,
      propertyType: params.propertyType,
      transactionType: "standard",
      hasHoa: params.hasHoa || false,
      hasPool: params.hasPool || false,
      isHistoric: false,
      leadPaintYear: enrichResult.data?.yearBuilt,
    })

    // Step 3: Generate listing description
    const descResult = await aiGenerateListingDescription({
      agentId: params.agentId,
      propertyData: enrichResult.data,
      style: "family",
    })

    // Step 4: Get pricing recommendation
    const pricingResult = await aiSuggestListPrice({
      agentId: params.agentId,
      propertyData: enrichResult.data,
    })

    // Step 5: Check compliance
    const complianceResult = await aiCheckListingCompliance({
      agentId: params.agentId,
      description: descResult.success ? descResult.descriptions?.mlsDescription || "" : "",
      state: params.state,
    })

    // Step 6: Create the listing
    const listingResult = await createListing({
      agentId: params.agentId,
      brokerageId,
      propertyAddress: params.address,
      city: params.city,
      state: params.state,
      zipCode: params.zipCode,
      propertyType: params.propertyType,
      sellerId: params.sellerId,
      listPrice: pricingResult.success ? pricingResult.pricing?.suggestedListPrice : undefined,
      propertyDetails: enrichResult.data,
    })

    return {
      success: true,
      workflow: {
        propertyData: enrichResult.data,
        requiredForms: formsResult.success ? formsResult.forms : null,
        descriptions: descResult.success ? descResult.descriptions : null,
        pricing: pricingResult.success ? pricingResult.pricing : null,
        compliance: complianceResult.success ? complianceResult.compliance : null,
        listing: listingResult.success ? listingResult.listing : null,
        dotloop: listingResult.success ? listingResult.dotloop : null,
      },
    }
  } catch (error) {
    console.error("[AI Listing Intake] Complete workflow error:", error)
    return handleError(error, "runCompleteListingIntake")
  }
}

// ============================================
// WORKFLOW OS — generate listing agreement draft
// ============================================
/**
 * Generates an AI-drafted listing agreement for a seller contact.
 * Called by the draft_document workflow adapter when document_type = "listing_agreement".
 */
export async function generateListingAgreement(params: {
  brokerageId: string
  contactId?: string | null
  agentUserId?: string | null
  /** 2-letter US state code from the PROPERTY ADDRESS — required, no default. */
  state: string
  documentId?: string | null
  propertyAddress?: string
}): Promise<{ success: boolean; documentId?: string; error?: string }> {
  try {
    const supabase = await createClient()

    // Canonical 50-state forms registry — every state explicit, no DEFAULT.
    const { getStateForms } = await import("@/lib/state-forms/registry")
    const forms = getStateForms(params.state, "listing")
    const state = params.state.trim().toUpperCase()

    const prompt = `You are a real estate broker. Generate a concise listing agreement outline for a
seller in ${state}${params.propertyAddress ? ` (property at ${params.propertyAddress})` : ""}.
Required forms: ${forms.required.join(", ")}.
Brokerage representation form: ${forms.brokerageRepresentation}.
Include: listing price strategy, commission structure, marketing obligations,
seller responsibilities, timeline, and key terms.
Professional tone. Under 400 words. Clear sections.`

    const { text } = await generateText({
      feature: "listing_agreement_draft",
      messages: [{ role: "user", content: prompt }],
    })

    if (params.documentId) {
      await supabase
        .from("documents")
        .update({
          content: text,
          status: "draft_ready",
          metadata: {
            state,
            required_forms: forms.required,
            available_addenda: forms.addenda,
            brokerage_representation_form: forms.brokerageRepresentation,
          },
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

// ============================================
// WORKFLOW OS — generate listing landing page
// ============================================
/**
 * Creates or updates a listing micro-site / landing page.
 * Called by the listing_landing_page workflow adapter.
 */
export async function generateListingLandingPage(params: {
  brokerageId: string
  agentUserId: string
  templateId?: string
  slug?: string
  contactId?: string | null
  listingId?: string | null
}): Promise<{
  success: boolean
  pageId?: string
  pageUrl?: string
  slug?: string
  error?: string
}> {
  try {
    const supabase = await createClient()

    const pageSlug = params.slug ?? `listing-${Math.random().toString(36).slice(2, 9)}`

    // Fetch listing data if linked
    let listingData: Record<string, unknown> = {}
    if (params.listingId) {
      const { data: listing } = await supabase
        .from("listings")
        .select("address, city, state, price, bedrooms, bathrooms, sqft, description, photos")
        .eq("id", params.listingId)
        .maybeSingle()
      if (listing) listingData = listing as Record<string, unknown>
    }

    // Generate AI description for the landing page
    const prompt = `Write a compelling property landing page headline and description.
Property: ${JSON.stringify(listingData)}.
Output a JSON object with: headline (string, max 80 chars), subheadline (string, max 120 chars), body (string, max 300 chars).
Them-first: focus on what the buyer gains, not agent promotion.`

    let pageContent: Record<string, string> = {
      headline: `Beautiful Home — ${listingData.address ?? "Available Now"}`,
      subheadline: "Contact us to schedule a showing",
      body: "",
    }

    try {
      const { generateTextRouted } = await import("@/lib/ai/models")
      const { text } = await generateTextRouted({
        feature: "listing_landing_page",
        messages: [{ role: "user", content: prompt }],
      })
      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim())
      if (parsed?.headline) pageContent = parsed
    } catch { /* use defaults */ }

    const { data: page, error } = await supabase
      .from("listing_landing_pages")
      .upsert({
        brokerage_id: params.brokerageId,
        contact_id: params.contactId ?? null,
        template_id: params.templateId ?? null,
        listing_id: params.listingId ?? null,
        slug: pageSlug,
        content: pageContent,
        status: "published",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: "slug" })
      .select("id")
      .maybeSingle()

    if (error) throw error

    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.platform.com"
    const pageUrl = `${baseUrl}/p/${pageSlug}`

    return { success: true, pageId: page?.id, pageUrl, slug: pageSlug }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    return { success: false, error: msg }
  }
}
