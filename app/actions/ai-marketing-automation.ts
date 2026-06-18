"use server"

import { createClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"

// ============================================
// NEWSLETTER SYSTEM WITH AI
// ============================================

export interface NewsletterGenerationParams {
  agentId: string
  audienceSegment: "buyers" | "sellers" | "investors" | "lifetime_customers" | "sphere" | "all"
  topic?: string
  tone?: "professional" | "friendly" | "educational" | "urgent"
  includeMarketData?: boolean
  includeListings?: boolean
  customSections?: string[]
}

export interface NewsletterResult {
  success: boolean
  newsletter?: {
    id: string
    subject: string
    preheader: string
    sections: {
      type: string
      title: string
      content: string
    }[]
    callToAction: {
      text: string
      url: string
    }
    qualityScore: number
    themPercentage: number
  }
  error?: string
}

/**
 * AI-Powered Newsletter Generation
 * Creates personalized, segmented newsletters with market data and listings
 */
export async function generateAINewsletter(params: NewsletterGenerationParams): Promise<NewsletterResult> {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    // Get agent's brand voice and market data
    const [brandVoiceResult, marketDataResult, listingsResult] = await Promise.all([
      supabase.from("brand_voice_profile").select("*").eq("agent_id", params.agentId).maybeSingle(),
      params.includeMarketData
        ? supabase
            .from("market_data")
            .select("median_sale_price, avg_days_on_market, active_listings, price_per_sqft, recorded_date")
            .order("recorded_date", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      params.includeListings
        ? supabase
            .from("listings")
            .select("id, address, city, list_price, bedrooms, bathrooms, photos")
            .eq("agent_id", params.agentId)
            .eq("status", "active")
            .limit(3)
        : Promise.resolve({ data: [] }),
    ])

    const brandVoice = brandVoiceResult.data
    const marketData = marketDataResult.data
    const featuredListings = listingsResult.data || []

    // Audience-specific prompts
    const audiencePrompts: Record<string, string> = {
      buyers: "Focus on buying opportunities, market timing, financing tips, and new listings",
      sellers: "Focus on selling strategies, home value insights, staging tips, and market conditions",
      investors: "Focus on ROI analysis, market trends, cap rates, and investment opportunities",
      lifetime_customers: "Focus on home maintenance, refinancing opportunities, and referral programs",
      sphere: "Focus on community events, market updates, and staying connected",
      all: "Balance content for buyers, sellers, and homeowners with broad appeal",
    }

    const prompt = `You are an expert real estate newsletter writer. Create a high-quality, them-first newsletter.

BRAND VOICE:
${brandVoice ? `Tone: ${brandVoice.tone_attributes?.join(", ") || "professional"}` : "Professional and helpful"}
${brandVoice?.key_brand_messages ? `Key phrases: ${brandVoice.key_brand_messages.join(", ")}` : ""}

AUDIENCE: ${params.audienceSegment}
${audiencePrompts[params.audienceSegment]}

TOPIC: ${params.topic || "Monthly Real Estate Update"}
TONE: ${params.tone || "friendly"}

${marketData ? `MARKET DATA:
- Median Price: $${marketData.median_sale_price?.toLocaleString() || "N/A"}
- Days on Market: ${marketData.avg_days_on_market || "N/A"}
- Active Inventory: ${marketData.active_listings || "N/A"} homes
- Price Per Sqft: $${marketData.price_per_sqft || "N/A"}` : ""}

${featuredListings.length > 0 ? `FEATURED LISTINGS:
${featuredListings.map((l: any) => `- ${l.address}, ${l.city} - $${l.list_price?.toLocaleString()} | ${l.bedrooms}bd/${l.bathrooms}ba`).join("\n")}` : ""}

${params.customSections ? `INCLUDE SECTIONS: ${params.customSections.join(", ")}` : ""}

RULES:
1. 85% about THEIR needs, 15% about your expertise
2. Lead with value, not promotion
3. Include actionable insights
4. Keep paragraphs short and scannable
5. Include ONE clear call-to-action

Return JSON:
{
  "subject": "compelling subject line (max 50 chars)",
  "preheader": "preview text (max 100 chars)",
  "sections": [
    { "type": "intro|market_update|tips|listings|community|cta", "title": "...", "content": "..." }
  ],
  "callToAction": { "text": "button text", "url": "/path" },
  "qualityScore": 0-100,
  "themPercentage": 0-100
}`

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    // Parse AI response
    let newsletter
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      newsletter = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text)
    } catch {
      return { success: false, error: "Failed to parse newsletter content" }
    }

    // Save to database
    const { data: saved, error: saveError } = await supabase
      .from("newsletters")
      .insert({
        agent_id: params.agentId,
        subject: newsletter.subject,
        preheader: newsletter.preheader,
        content: newsletter,
        audience_segment: params.audienceSegment,
        quality_score: newsletter.qualityScore,
        them_percentage: newsletter.themPercentage,
        status: "draft",
      })
      .select()
      .single()

    if (saveError) throw saveError

    revalidatePath("/dashboard/marketing/newsletters")

    return {
      success: true,
      newsletter: {
        id: saved.id,
        ...newsletter,
      },
    }
  } catch (error) {
    console.error("[AI Newsletter] Error:", error)
    return handleError(error, "generateAINewsletter") as NewsletterResult
  }
}

/**
 * AI-Powered Newsletter Subject Line A/B Testing
 */
export async function generateNewsletterSubjectVariants(
  agentId: string,
  topic: string,
  audience: string
): Promise<{ success: boolean; variants?: string[]; error?: string }> {
  try {
    if (!isValidUUID(agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Generate 5 A/B test subject line variants for a real estate newsletter.

Topic: ${topic}
Audience: ${audience}

Create 5 different approaches:
1. Question-based
2. Number/statistic-based
3. Curiosity-driven
4. Benefit-focused
5. Urgency-based

Return JSON array of strings, each max 50 characters.`,
    })

    const variants = JSON.parse(text)
    return { success: true, variants }
  } catch (error) {
    return handleError(error, "generateNewsletterSubjectVariants") as any
  }
}

// ============================================
// DIRECT MAIL SYSTEM WITH AI
// ============================================

export interface DirectMailParams {
  agentId: string
  mailType: "postcard" | "letter" | "flyer" | "door_hanger" | "market_report"
  targetAudience: "fsbo" | "expired" | "absentee" | "equity_rich" | "farm_area" | "just_sold" | "just_listed"
  propertyId?: string
  farmAreaZip?: string
  customMessage?: string
}

export interface DirectMailResult {
  success: boolean
  mailPiece?: {
    id: string
    headline: string
    body: string
    callToAction: string
    designNotes: string
    targetCount: number
    estimatedCost: number
    qrCodeUrl?: string
  }
  error?: string
}

/**
 * AI-Powered Direct Mail Generation
 * Creates targeted mailers with compelling copy and design suggestions
 */
export async function generateAIDirectMail(params: DirectMailParams): Promise<DirectMailResult> {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()

    // Get agent info and brand voice
    const [agentResult, brandResult, propertyResult] = await Promise.all([
      supabase.from("users").select("first_name, last_name, phone, email").eq("id", params.agentId).single(),
      supabase.from("brand_voice_profile").select("*").eq("agent_id", params.agentId).maybeSingle(),
      params.propertyId
        ? supabase.from("listings").select("*").eq("id", params.propertyId).single()
        : Promise.resolve({ data: null }),
    ])

    const agent = agentResult.data
    const brandVoice = brandResult.data
    const property = propertyResult.data

    // Audience-specific messaging
    const audienceStrategies: Record<string, string> = {
      fsbo: "Address FSBO pain points: time commitment, legal risks, pricing challenges. Offer free consultation.",
      expired: "Acknowledge their frustration. Focus on what went wrong and your different approach.",
      absentee: "Focus on property management concerns, market value updates, and investment optimization.",
      equity_rich: "Highlight market opportunity, potential returns, and downsizing/upgrading options.",
      farm_area: "Build neighborhood expertise, share recent sales, position as the local expert.",
      just_sold: "Celebrate the sale, introduce yourself to neighbors, create urgency with buyer interest.",
      just_listed: "Announce new listing to neighbors, invite to open house, generate referrals.",
    }

    const mailTypeSpecs: Record<string, string> = {
      postcard: "4x6 or 6x9 postcard with bold headline, one key message, clear CTA. Front: image + headline. Back: message + contact.",
      letter: "Personal letter format. Conversational tone. 1-2 pages max. Include handwritten elements.",
      flyer: "8.5x11 full color. Multiple sections. Property photos if applicable. QR code for digital follow-up.",
      door_hanger: "3.5x8.5 door hanger. Bold, simple message. Weather-resistant. Immediate impact.",
      market_report: "4-page folded report. Market stats, graphs, neighborhood data. Position as expert resource.",
    }

    const prompt = `You are a direct mail copywriting expert for real estate. Create compelling mail piece content.

MAIL TYPE: ${params.mailType}
${mailTypeSpecs[params.mailType]}

TARGET AUDIENCE: ${params.targetAudience}
${audienceStrategies[params.targetAudience]}

AGENT: ${agent?.first_name} ${agent?.last_name}
BRAND VOICE: ${brandVoice?.tone_attributes?.join(", ") || "professional, approachable"}

${property ? `PROPERTY DETAILS:
- Address: ${property.address}
- Price: $${property.price?.toLocaleString()}
- Beds/Baths: ${property.bedrooms}/${property.bathrooms}
- Features: ${property.features?.slice(0, 5).join(", ")}` : ""}

${params.customMessage ? `CUSTOM MESSAGE: ${params.customMessage}` : ""}

${params.farmAreaZip ? `FARM AREA: ${params.farmAreaZip}` : ""}

RULES:
1. Lead with THEIR problem or opportunity
2. One clear, compelling headline
3. Emotional hook + logical support
4. Single, specific call-to-action
5. Include sense of urgency without being pushy

Return JSON:
{
  "headline": "attention-grabbing headline (max 10 words)",
  "subheadline": "supporting message (max 15 words)",
  "body": "main message content (150-300 words based on mail type)",
  "callToAction": "specific action to take",
  "designNotes": "layout and visual suggestions",
  "colorScheme": "suggested colors",
  "imageRecommendation": "what image to feature"
}`

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    let mailContent
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      mailContent = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text)
    } catch {
      return { success: false, error: "Failed to parse mail content" }
    }

    // Estimate mailing costs
    const costPerPiece: Record<string, number> = {
      postcard: 0.75,
      letter: 1.25,
      flyer: 0.95,
      door_hanger: 0.65,
      market_report: 2.50,
    }

    // Get target count (placeholder - would integrate with list provider)
    const estimatedTargets = params.farmAreaZip ? 500 : 100

    // Save to database
    const { data: saved, error: saveError } = await supabase
      .from("direct_mail_campaigns")
      .insert({
        agent_id: params.agentId,
        mail_type: params.mailType,
        target_audience: params.targetAudience,
        property_id: params.propertyId,
        headline: mailContent.headline,
        content: mailContent,
        target_count: estimatedTargets,
        estimated_cost: estimatedTargets * costPerPiece[params.mailType],
        status: "draft",
      })
      .select()
      .single()

    if (saveError) throw saveError

    revalidatePath("/dashboard/marketing/direct-mail")

    return {
      success: true,
      mailPiece: {
        id: saved.id,
        headline: mailContent.headline,
        body: mailContent.body,
        callToAction: mailContent.callToAction,
        designNotes: mailContent.designNotes,
        targetCount: estimatedTargets,
        estimatedCost: estimatedTargets * costPerPiece[params.mailType],
        qrCodeUrl: `/api/qr/${saved.id}`,
      },
    }
  } catch (error) {
    console.error("[AI Direct Mail] Error:", error)
    return handleError(error, "generateAIDirectMail") as DirectMailResult
  }
}

// ============================================
// LISTING CREATION SYSTEM WITH AI
// ============================================

export interface ListingCreationParams {
  agentId: string
  propertyData: {
    address: string
    city: string
    state: string
    zip: string
    price: number
    bedrooms: number
    bathrooms: number
    sqft: number
    lotSize?: number
    yearBuilt?: number
    propertyType: string
    features?: string[]
    photos?: string[]
  }
  sellerId?: string
}

export interface ListingCreationResult {
  success: boolean
  listing?: {
    id: string
    mlsDescription: string
    marketingDescription: string
    socialMediaPosts: {
      facebook: string
      instagram: string
      linkedin: string
    }
    suggestedPrice: {
      min: number
      max: number
      recommended: number
      reasoning: string
    }
    targetBuyerPersonas: string[]
    marketingStrategy: string[]
  }
  error?: string
}

/**
 * AI-Powered Listing Creation
 * Creates MLS descriptions, marketing content, and pricing recommendations
 */
export async function createAIListing(params: ListingCreationParams): Promise<ListingCreationResult> {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()
    const { propertyData } = params

    // Get comparable sales for pricing
    const { data: comps } = await supabase
      .from("listings")
      // listings has no sold_price/sold_date/price columns — use list_price + go_live_date.
      .select("list_price, sqft, bedrooms, bathrooms")
      .eq("city", propertyData.city)
      .eq("status", "sold")
      .order("go_live_date", { ascending: false })
      .limit(10)

    // Calculate price per sqft from comps
    const pricePerSqft = comps?.length
      ? comps.reduce((sum: number, c: any) => sum + (c.list_price || 0) / (c.sqft || 1), 0) / comps.length
      : 250

    const prompt = `You are a real estate listing expert. Create comprehensive listing content and analysis.

PROPERTY DETAILS:
- Address: ${propertyData.address}, ${propertyData.city}, ${propertyData.state} ${propertyData.zip}
- Price: $${propertyData.price.toLocaleString()}
- Type: ${propertyData.propertyType}
- Beds/Baths: ${propertyData.bedrooms}/${propertyData.bathrooms}
- Sqft: ${propertyData.sqft.toLocaleString()}
${propertyData.lotSize ? `- Lot: ${propertyData.lotSize.toLocaleString()} sqft` : ""}
${propertyData.yearBuilt ? `- Built: ${propertyData.yearBuilt}` : ""}
${propertyData.features?.length ? `- Features: ${propertyData.features.join(", ")}` : ""}

MARKET DATA:
- Avg Price/Sqft in area: $${pricePerSqft.toFixed(0)}
- Recent comps: ${comps?.length || 0} sales in last 6 months

Create:
1. MLS Description (250 words max, factual, highlights key features)
2. Marketing Description (300 words, emotional, lifestyle-focused)
3. Social media posts for Facebook, Instagram, LinkedIn
4. Price analysis with recommendation
5. Target buyer personas
6. Marketing strategy recommendations

Return JSON:
{
  "mlsDescription": "MLS-compliant description",
  "marketingDescription": "lifestyle-focused marketing copy",
  "socialMediaPosts": {
    "facebook": "post with emojis, engaging",
    "instagram": "visual-focused, hashtags included",
    "linkedin": "professional, investment angle"
  },
  "suggestedPrice": {
    "min": number,
    "max": number,
    "recommended": number,
    "reasoning": "explanation"
  },
  "targetBuyerPersonas": ["persona1", "persona2"],
  "marketingStrategy": ["strategy1", "strategy2", "strategy3"]
}`

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    let aiContent
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      aiContent = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text)
    } catch {
      return { success: false, error: "Failed to parse listing content" }
    }

    // brokerage_id is NOT NULL on listings — resolve it from the agent (Marketing Manager's listing).
    const { data: agentRow } = await supabase.from("users").select("brokerage_id").eq("id", params.agentId).maybeSingle()
    const brokerageId = (agentRow as { brokerage_id: string | null } | null)?.brokerage_id ?? null
    if (!brokerageId) return { success: false, error: "Could not resolve brokerage for the agent" }

    // Create the listing with ONLY valid columns. The MLS description is the public remarks;
    // the marketing analysis (description/strategy/personas/suggested price) is AI-generated
    // CONTENT and lives in listing_marketing_content, not as listings columns (the old insert
    // wrote 5 phantom columns + spread propertyData's price/propertyType/etc. + omitted
    // brokerage_id, so it always failed and no listing was ever created).
    const { data: listing, error: listingError } = await supabase
      .from("listings")
      .insert({
        agent_id: params.agentId,
        brokerage_id: brokerageId,
        seller_contact_id: params.sellerId ?? null,
        address: propertyData.address,
        city: propertyData.city,
        state: propertyData.state,
        zip: propertyData.zip,
        list_price: propertyData.price,
        property_type: propertyData.propertyType,
        bedrooms: propertyData.bedrooms,
        bathrooms: propertyData.bathrooms,
        sqft: propertyData.sqft,
        public_remarks: aiContent.mlsDescription,
        status: "draft",
      })
      .select()
      .single()

    if (listingError) throw listingError

    // Save the AI marketing analysis + social content (content_type rows, brokerage-scoped).
    await supabase.from("listing_marketing_content").insert([
      {
        listing_id: listing.id, brokerage_id: brokerageId, content_type: "ai_marketing",
        content: {
          marketingDescription: aiContent.marketingDescription,
          suggestedPrice:       aiContent.suggestedPrice,
          targetPersonas:       aiContent.targetBuyerPersonas,
          marketingStrategy:    aiContent.marketingStrategy,
        },
      },
      { listing_id: listing.id, brokerage_id: brokerageId, content_type: "social_posts", content: aiContent.socialMediaPosts },
    ])

    revalidatePath("/dashboard/listings")

    return {
      success: true,
      listing: {
        id: listing.id,
        ...aiContent,
      },
    }
  } catch (error) {
    console.error("[AI Listing Creation] Error:", error)
    return handleError(error, "createAIListing") as ListingCreationResult
  }
}

/**
 * AI-Powered Listing Description Enhancement
 */
export async function enhanceListingDescription(
  listingId: string,
  agentId: string,
  style: "luxury" | "family" | "investment" | "first_time_buyer"
): Promise<{ success: boolean; enhanced?: string; error?: string }> {
  try {
    if (!isValidUUID(listingId) || !isValidUUID(agentId)) {
      return { success: false, error: "Invalid ID" }
    }

    const supabase = await createClient()
    const { data: listing } = await supabase.from("listings").select("*").eq("id", listingId).single()

    if (!listing) return { success: false, error: "Listing not found" }

    const stylePrompts: Record<string, string> = {
      luxury: "Emphasize premium finishes, exclusivity, prestige, and sophisticated lifestyle",
      family: "Focus on space for growing family, schools, safety, and community amenities",
      investment: "Highlight ROI potential, rental income, appreciation, and cap rate",
      first_time_buyer: "Emphasize value, starter home benefits, low maintenance, and affordability",
    }

    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Rewrite this listing description for a ${style} buyer:

Original: ${listing.mls_description || listing.marketing_description}

Style focus: ${stylePrompts[style]}

Keep it under 300 words. Make it compelling and specific.`,
    })

    return { success: true, enhanced: text }
  } catch (error) {
    return handleError(error, "enhanceListingDescription") as any
  }
}

// ============================================
// OFFER CREATION SYSTEM WITH AI
// ============================================

export interface OfferCreationParams {
  agentId: string
  buyerId: string
  listingId: string
  offerAmount: number
  earnestMoney?: number
  downPaymentPercent?: number
  financingType: "conventional" | "fha" | "va" | "cash" | "other"
  contingencies?: string[]
  closeDate?: string
  escalationClause?: {
    maxPrice: number
    increment: number
  }
  additionalTerms?: string
}

export interface OfferCreationResult {
  success: boolean
  offer?: {
    id: string
    summary: string
    strengthScore: number
    competitiveAnalysis: string
    suggestedImprovements: string[]
    negotiationStrategy: string
    riskAssessment: {
      level: "low" | "medium" | "high"
      factors: string[]
    }
  }
  error?: string
}

/**
 * AI-Powered Offer Creation and Analysis
 * Creates competitive offers with strategic recommendations
 */
export async function createAIOffer(params: OfferCreationParams): Promise<OfferCreationResult> {
  try {
    if (!isValidUUID(params.agentId) || !isValidUUID(params.buyerId) || !isValidUUID(params.listingId)) {
      return { success: false, error: "Invalid ID" }
    }

    const supabase = await createClient()

    // Get listing and market context
    const [listingResult, buyerResult, compsResult] = await Promise.all([
      supabase.from("listings").select("*, agent:users(first_name, last_name)").eq("id", params.listingId).single(),
      supabase.from("contacts").select("*").eq("id", params.buyerId).single(),
      supabase
        .from("offers")
        .select("offer_amount:offer_price, status")
        .eq("listing_id", params.listingId)
        .order("created_at", { ascending: false })
        .limit(5),
    ])

    const listing = listingResult.data
    const buyer = buyerResult.data
    const existingOffers = compsResult.data || []

    if (!listing) return { success: false, error: "Listing not found" }

    // Calculate offer metrics
    const offerToListRatio = (params.offerAmount / listing.list_price) * 100
    const daysOnMarket = listing.listing_date
      ? Math.floor((Date.now() - new Date(listing.listing_date).getTime()) / (1000 * 60 * 60 * 24))
      : 0

    const defaultContingencies = params.contingencies || ["inspection", "financing", "appraisal"]
    const defaultEarnest = params.earnestMoney || params.offerAmount * 0.01
    const defaultDownPayment = params.downPaymentPercent || (params.financingType === "cash" ? 100 : 20)

    const prompt = `You are a real estate offer strategist. Analyze and optimize this offer.

LISTING:
- Address: ${listing.address}
- List Price: $${listing.list_price.toLocaleString()}
- Days on Market: ${daysOnMarket}
- Listing Agent: ${listing.agent?.first_name} ${listing.agent?.last_name}

OFFER DETAILS:
- Offer Amount: $${params.offerAmount.toLocaleString()} (${offerToListRatio.toFixed(1)}% of list)
- Earnest Money: $${defaultEarnest.toLocaleString()}
- Down Payment: ${defaultDownPayment}%
- Financing: ${params.financingType}
- Contingencies: ${defaultContingencies.join(", ")}
- Close Date: ${params.closeDate || "30 days"}
${params.escalationClause ? `- Escalation: Up to $${params.escalationClause.maxPrice.toLocaleString()} in $${params.escalationClause.increment.toLocaleString()} increments` : ""}
${params.additionalTerms ? `- Additional Terms: ${params.additionalTerms}` : ""}

COMPETITION:
- ${existingOffers.length} other offers on file
${existingOffers.length > 0 ? `- Recent offer amounts: ${existingOffers.map((o: any) => `$${o.offer_amount?.toLocaleString()}`).join(", ")}` : ""}

Analyze the offer and provide:
1. Overall strength score (0-100)
2. Competitive analysis
3. Specific improvements to make it stronger
4. Negotiation strategy for the listing agent
5. Risk assessment

Return JSON:
{
  "summary": "one-paragraph offer summary",
  "strengthScore": 0-100,
  "competitiveAnalysis": "detailed competitive position",
  "suggestedImprovements": ["improvement1", "improvement2"],
  "negotiationStrategy": "how to present and negotiate",
  "riskAssessment": {
    "level": "low|medium|high",
    "factors": ["risk1", "risk2"]
  },
  "recommendedCounterPoints": ["point1", "point2"]
}`

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt,
    })

    let aiAnalysis
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      aiAnalysis = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text)
    } catch {
      return { success: false, error: "Failed to parse offer analysis" }
    }

    // Create the offer
    const { data: offer, error: offerError } = await supabase
      .from("offers")
      .insert({
        listing_id: params.listingId,
        contact_id: params.buyerId,
        agent_id: params.agentId,
        offer_price: params.offerAmount,
        earnest_money: defaultEarnest,
        down_payment_percent: defaultDownPayment,
        financing_type: params.financingType,
        contingencies: defaultContingencies,
        closing_date: params.closeDate || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        escalation_clause: params.escalationClause,
        notes: params.additionalTerms ?? null,
        ai_analysis: aiAnalysis,
        status: "draft",
      })
      .select()
      .single()

    if (offerError) throw offerError

    revalidatePath(`/dashboard/offers`)
    revalidatePath(`/listings/${params.listingId}`)

    return {
      success: true,
      offer: {
        id: offer.id,
        ...aiAnalysis,
      },
    }
  } catch (error) {
    console.error("[AI Offer Creation] Error:", error)
    return handleError(error, "createAIOffer") as OfferCreationResult
  }
}

/**
 * AI-Powered Counter Offer Strategy
 */
export async function generateCounterOfferStrategy(
  offerId: string,
  agentId: string,
  representingSide: "buyer" | "seller"
): Promise<{ success: boolean; strategy?: any; error?: string }> {
  try {
    if (!isValidUUID(offerId) || !isValidUUID(agentId)) {
      return { success: false, error: "Invalid ID" }
    }

    const supabase = await createClient()

    const { data: offer } = await supabase
      .from("offers")
      .select(`
        *,
        listing:listings(*),
        buyer:contacts(*)
      `)
      .eq("id", offerId)
      .single()

    if (!offer) return { success: false, error: "Offer not found" }

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt: `You are a real estate negotiation expert. Create a counter-offer strategy.

You are representing the ${representingSide.toUpperCase()}.

CURRENT OFFER:
- List Price: $${offer.listing.list_price.toLocaleString()}
- Offer: $${offer.offer_amount.toLocaleString()}
- Earnest: $${offer.earnest_money.toLocaleString()}
- Financing: ${offer.financing_type}
- Contingencies: ${offer.contingencies?.join(", ")}
- Close Date: ${offer.close_date}

Provide a strategic counter-offer recommendation with:
1. Recommended counter price
2. Terms to negotiate
3. Concessions to offer/request
4. Timeline strategy
5. Psychological tactics

Return JSON with detailed strategy.`,
    })

    const strategy = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text)
    return { success: true, strategy }
  } catch (error) {
    return handleError(error, "generateCounterOfferStrategy") as any
  }
}

/**
 * AI-Powered Offer Comparison for Sellers
 */
export async function compareOffers(
  listingId: string,
  agentId: string
): Promise<{ success: boolean; comparison?: any; error?: string }> {
  try {
    if (!isValidUUID(listingId) || !isValidUUID(agentId)) {
      return { success: false, error: "Invalid ID" }
    }

    const supabase = await createClient()

    const { data: offers } = await supabase
      .from("offers")
      .select(`
        *,
        buyer:contacts(first_name, last_name, contact_persona)
      `)
      .eq("listing_id", listingId)
      .in("status", ["pending", "countered"])
      .order("offer_price", { ascending: false })

    if (!offers || offers.length === 0) {
      return { success: false, error: "No offers to compare" }
    }

    const { data: listing } = await supabase.from("listings").select("*").eq("id", listingId).single()

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt: `You are a seller's agent analyzing multiple offers.

LISTING:
- Address: ${listing?.address}
- List Price: $${listing?.price.toLocaleString()}

OFFERS (${offers.length} total):
${offers.map((o: any, i: number) => `
Offer ${i + 1}:
- Amount: $${o.offer_price.toLocaleString()}
- Earnest: $${o.earnest_money.toLocaleString()}
- Down Payment: ${o.down_payment_percent}%
- Financing: ${o.financing_type}
- Contingencies: ${o.contingencies?.join(", ")}
- Close Date: ${o.closing_date}
${o.escalation_clause ? `- Escalation: Up to $${o.escalation_clause.maxPrice.toLocaleString()}` : ""}`).join("\n")}

Analyze and rank these offers. Consider:
1. Net to seller
2. Certainty of close
3. Timeline
4. Contingency risk
5. Buyer qualification signals

Return JSON:
{
  "ranking": [
    { "offerId": "...", "rank": 1, "score": 95, "reasoning": "..." }
  ],
  "recommendation": "which offer to accept or counter",
  "negotiationOpportunities": ["opportunity1", "opportunity2"],
  "riskAnalysis": "overall risk assessment"
}`,
    })

    const comparison = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || text)
    return { success: true, comparison }
  } catch (error) {
    return handleError(error, "compareOffers") as any
  }
}
