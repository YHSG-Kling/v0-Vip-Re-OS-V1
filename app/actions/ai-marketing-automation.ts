"use server"

import { createClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { getAgentContext } from "@/lib/identity/get-agent-context"

/**
 * TENANT + IDENTITY GUARD for every action in this file.
 *
 * `params.agentId` throughout this module is an AGENTS id — brand_voice_profile
 * .agent_id, direct_mail_campaigns.agent_id, newsletter_campaigns.agent_id,
 * listings.agent_id and offers.agent_id ALL FK agents(id), never users(id).
 * Trusting a caller-supplied id also means trusting a caller-supplied tenant,
 * so resolve the session and confirm the requested agent lives inside the
 * caller's brokerage before reading or writing anything on their behalf.
 */
async function requireAgentInCallerBrokerage(agentId: string): Promise<
  | { ok: true; brokerageId: string; userId: string; callerAgentId: string | null }
  | { ok: false; error: string }
> {
  const ctx = await getAgentContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }
  if (!ctx.brokerageId) return { ok: false, error: "No brokerage associated with your account." }

  const supabase = await createClient()
  const { data: agentRow, error: agentError } = await supabase
    .from("agents")
    .select("id")
    .eq("id", agentId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (agentError) return { ok: false, error: `Could not verify agent: ${agentError.message}` }
  if (!agentRow) {
    return { ok: false, error: "That agent is not in your brokerage." }
  }
  return { ok: true, brokerageId: ctx.brokerageId, userId: ctx.userId, callerAgentId: ctx.agentId }
}

/** Strips ```json fences the models keep emitting before JSON.parse. */
function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim()
}

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

    const auth = await requireAgentInCallerBrokerage(params.agentId)
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()

    // Get agent's brand voice and market data. market_data carries a
    // brokerage_id — the unfiltered read below used to pick whichever row in
    // the whole platform was most recent, so a newsletter could quote another
    // brokerage's market. Anchored to the caller's brokerage.
    const [brandVoiceResult, marketDataResult, listingsResult] = await Promise.all([
      supabase.from("brand_voice_profile").select("*").eq("agent_id", params.agentId).maybeSingle(),
      params.includeMarketData
        ? supabase
            .from("market_data")
            .select("median_sale_price, median_list_price, avg_days_on_market, active_listings, recorded_date:data_date")
            .eq("brokerage_id", auth.brokerageId)
            .order("data_date", { ascending: false })
            .limit(1)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      params.includeListings
        ? supabase
            .from("listings")
            .select("id, address, city, list_price, bedrooms, bathrooms, photos")
            .eq("agent_id", params.agentId)
            .eq("brokerage_id", auth.brokerageId)
            .eq("status", "active")
            .limit(3)
        : Promise.resolve({ data: [], error: null }),
    ])

    // Every one of these can be REFUSED and still resolve. Reading only `data`
    // turns a blocked query into "this agent has no brand voice / no market /
    // no listings" and the newsletter silently ships without them.
    if (brandVoiceResult.error) throw brandVoiceResult.error
    if (marketDataResult.error) throw marketDataResult.error
    if (listingsResult.error) throw listingsResult.error

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
${brandVoice ? `Tone: ${brandVoice.tone || "professional"}${brandVoice.style ? ` (${brandVoice.style})` : ""}` : "Professional and helpful"}
${brandVoice?.key_brand_messages ? `Key phrases: ${Array.isArray(brandVoice.key_brand_messages) ? brandVoice.key_brand_messages.join(", ") : brandVoice.key_brand_messages}` : ""}

AUDIENCE: ${params.audienceSegment}
${audiencePrompts[params.audienceSegment]}

TOPIC: ${params.topic || "Monthly Real Estate Update"}
TONE: ${params.tone || "friendly"}

${marketData ? `MARKET DATA:
- Median Price: $${marketData.median_sale_price?.toLocaleString() || "N/A"}
- Days on Market: ${marketData.avg_days_on_market || "N/A"}
- Active Inventory: ${marketData.active_listings || "N/A"} homes
- Median List Price: $${marketData.median_list_price?.toLocaleString() || "N/A"}` : ""}

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

    // PERSIST THROUGH THE CANONICAL WRITER — not a second insert.
    // newsletter_campaigns already has one writer, app/actions/ai-newsletter.ts
    // ::createNewsletterCampaign, and it does four things this insert did not:
    // resolves agents.id from the session (agent_id FKs agents), sets
    // brokerage_id (this insert omitted it, so every AI newsletter landed with
    // a NULL tenant and never appeared in any brokerage-scoped list) and
    // created_by, decomposes sections into newsletter_sections (without which
    // every recipient gets one flat body), and fires NEWSLETTER_SCHEDULED.
    // This action keeps the them-first generation and hands the row to it.
    const SECTION_TYPE_MAP: Record<string, "hero" | "featured_listings" | "market_update" | "tips" | "testimonial" | "cta" | "custom"> = {
      intro: "hero",
      hero: "hero",
      market_update: "market_update",
      tips: "tips",
      listings: "featured_listings",
      featured_listings: "featured_listings",
      testimonial: "testimonial",
      community: "custom",
      cta: "cta",
    }

    const sections = (Array.isArray(newsletter.sections) ? newsletter.sections : []).map(
      (s: { type?: string; title?: string; content?: string }, i: number) => ({
        type: SECTION_TYPE_MAP[String(s.type ?? "custom")] ?? "custom",
        section_type: SECTION_TYPE_MAP[String(s.type ?? "custom")] ?? "custom",
        title: s.title ?? `Section ${i + 1}`,
        content: s.content ?? "",
      })
    )

    const { createNewsletterCampaign } = await import("@/app/actions/ai-newsletter")
    const saveResult = await createNewsletterCampaign({
      title: newsletter.subject ?? "AI Newsletter",
      subjectLine: newsletter.subject ?? "AI Newsletter",
      preheaderText: newsletter.preheader ?? "",
      template: "ai_generated",
      content: sections,
      audienceSegment: params.audienceSegment,
    })

    if (!saveResult.success || !(saveResult as { newsletter?: { id: string } }).newsletter) {
      return {
        success: false,
        error: (saveResult as { error?: string }).error ?? "Failed to save newsletter",
      }
    }

    revalidatePath("/dashboard/marketing/studio")
    revalidatePath("/newsletters")

    return {
      success: true,
      newsletter: {
        id: (saveResult as { newsletter: { id: string } }).newsletter.id,
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

    const auth = await requireAgentInCallerBrokerage(agentId)
    if (!auth.ok) return { success: false, error: auth.error }

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

    // The model wraps JSON in ```json fences often enough that a bare
    // JSON.parse(text) threw and the whole action reported a generic failure.
    let parsed: unknown
    try {
      parsed = JSON.parse(stripCodeFences(text))
    } catch {
      const arrayMatch = text.match(/\[[\s\S]*\]/)
      if (!arrayMatch) return { success: false, error: "AI did not return subject variants" }
      try {
        parsed = JSON.parse(arrayMatch[0])
      } catch {
        return { success: false, error: "AI did not return subject variants" }
      }
    }

    const variants = Array.isArray(parsed)
      ? parsed.map((v) => (typeof v === "string" ? v : String((v as { subject?: string })?.subject ?? ""))).filter(Boolean)
      : []

    if (variants.length === 0) return { success: false, error: "AI did not return subject variants" }

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

    // IDENTITY CLASS (m347). params.agentId is an AGENTS id — its only caller,
    // AgentSuperpowersPanel, is handed agentRow.id by app/dashboard/agent/page.tsx
    // — and direct_mail_campaigns.agent_id FKs agents, so the write below is
    // right. But this lookup read `users` BY THAT ID, which matched nothing, so
    // `agent` came back null and the prompt on the line building the piece read
    // literally "AGENT: undefined undefined". Every AI-generated direct mail
    // piece went out attributed to an agent with no name, phone or email.
    // Read the users row THROUGH the agents row instead of guessing the class.
    const [agentResult, brandResult, propertyResult] = await Promise.all([
      // brokerage_id rides along on the lookup already being made: it is the
      // TENANT of the campaign written at the end of this function. See the
      // stamp on the insert below.
      supabase.from("agents").select("brokerage_id, users(first_name, last_name, phone, email)").eq("id", params.agentId).maybeSingle(),
      supabase.from("brand_voice_profile").select("*").eq("agent_id", params.agentId).maybeSingle(),
      params.propertyId
        ? supabase.from("listings").select("*").eq("id", params.propertyId).single()
        : Promise.resolve({ data: null }),
    ])

    // Unwrap the nested users row from the agents join above.
    const agentRow = agentResult.data as {
      brokerage_id?: string | null
      users?: { first_name?: string; last_name?: string; phone?: string; email?: string } | null
    } | null
    const agent = agentRow?.users ?? null

    // TENANT — the AGENTS row this piece is filed under. direct_mail_campaigns
    // .agent_id FKs agents(id) (see the identity-class note above), and agents
    // carries brokerage_id; `params.agentId` itself is never used as the tenant,
    // because agents.id and brokerages.id are disjoint spaces.
    //
    // supabase-js RESOLVES a refused query, so the error is read explicitly:
    // without it, "this read was denied" and "no such agent" are the same empty
    // result, and this function would go on to spend an AI call and then write a
    // campaign nobody can see.
    if (agentResult.error) {
      return { success: false, error: `Agent lookup refused: ${agentResult.error.message}` }
    }
    const mailBrokerageId = (agentRow?.brokerage_id as string | null) ?? null
    if (!mailBrokerageId) {
      // Every direct-mail surface narrows: listDirectMailCampaigns,
      // getDirectMailPerformance, the marketing approval queue and the bundle
      // attribution cron all filter `.eq("brokerage_id", …)`, and `NULL = <uuid>`
      // is NULL, never true. An unstamped piece is generated, costed, and then
      // absent from the queue that is supposed to approve it before it mails.
      return {
        success: false,
        error:
          "That agent profile carries no brokerage, so the mail piece could not be filed where the approval queue can see it.",
      }
    }
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
BRAND VOICE: ${brandVoice?.tone || "professional, approachable"}

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
    // Map to the canonical direct_mail_campaigns columns: mail_type→piece_type
    // (free text), target_count→quantity, estimated_cost→per_piece_cost (unit;
    // total derives as quantity*per_piece_cost), headline+content→copy_text.
    // status must satisfy the CHECK (planning|approved|printed|mailed).
    const { data: saved, error: saveError } = await supabase
      .from("direct_mail_campaigns")
      .insert({
        brokerage_id: mailBrokerageId, // resolved above from the agents row
        agent_id: params.agentId,
        campaign_name: `${params.mailType} – ${params.targetAudience}`,
        piece_type: params.mailType,
        target_audience: params.targetAudience,
        copy_text: JSON.stringify({ headline: mailContent.headline, ...mailContent }),
        quantity: estimatedTargets,
        per_piece_cost: costPerPiece[params.mailType],
        status: "planning",
        is_ai_generated: true,
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
 *
 * ⚠ NOT SURFACED FROM MARKETING. This action INSERTS into `listings`, and
 * `listings` already has its owning writer on the listing rail
 * (app/actions/listings-kernel.ts + app/actions/ai-listing-intake.ts, which
 * carry the lifecycle_stage ladder, MLS validation and kernel events this does
 * not). Creating a listing from a marketing surface would be a second writer
 * for that table. Its correct home is the listing intake page; reported rather
 * than wired here. The defects below were still fixed so it is not broken when
 * that owner picks it up.
 */
export async function createAIListing(params: ListingCreationParams): Promise<ListingCreationResult> {
  try {
    if (!isValidUUID(params.agentId)) {
      return { success: false, error: "Invalid agent ID" }
    }

    const supabase = await createClient()
    const { propertyData } = params

    // IDENTITY CLASS. listings.agent_id FKs agents(id) — as do
    // brand_voice_profile.agent_id and direct_mail_campaigns.agent_id
    // elsewhere in this file — so params.agentId is an AGENTS id. This used to
    // read the `users` table BY THAT ID, which matched nothing, so brokerageId
    // came back null and the action returned "Could not resolve brokerage for
    // the agent" on EVERY call: no AI listing was ever created. Read the
    // agents row, and take the brokerage from it.
    const auth = await requireAgentInCallerBrokerage(params.agentId)
    if (!auth.ok) return { success: false, error: auth.error }
    const brokerageId = auth.brokerageId

    // Get comparable sales for pricing
    const { data: comps, error: compsError } = await supabase
      .from("listings")
      // listings has no sold_price/sold_date/price columns — use list_price + go_live_date.
      .select("list_price, sqft, bedrooms, bathrooms")
      // tenant anchor (scope burn-down): comps from the agent's own brokerage inventory
      .eq("brokerage_id", brokerageId)
      .eq("city", propertyData.city)
      .eq("status", "sold")
      .order("go_live_date", { ascending: false })
      .limit(10)

    if (compsError) throw compsError

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
    const { error: marketingContentError } = await supabase.from("listing_marketing_content").insert([
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

    // A refused marketing-content insert used to be invisible: the listing was
    // created and every piece of AI marketing silently vanished.
    if (marketingContentError) throw marketingContentError

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

    const auth = await requireAgentInCallerBrokerage(agentId)
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()
    // PHANTOM COLUMNS. This read `listing.mls_description || listing
    // .marketing_description`; neither column exists on `listings`. The public
    // marketing copy lives in `public_remarks`, so the rewrite prompt used to
    // read literally "Original: undefined" and the model invented a listing.
    // Also: `.single()` on an unscoped read — a listing from another brokerage
    // was fetchable by id, and a refusal was swallowed with the row.
    const { data: listing, error: listingError } = await supabase
      .from("listings")
      .select("id, address, city, state, public_remarks")
      .eq("id", listingId)
      .eq("brokerage_id", auth.brokerageId)
      .maybeSingle()

    if (listingError) throw listingError
    if (!listing) return { success: false, error: "Listing not found in your brokerage" }

    const original = (listing.public_remarks ?? "").trim()
    if (!original) {
      return {
        success: false,
        error: "This listing has no public remarks yet — add a description before enhancing it.",
      }
    }

    const stylePrompts: Record<string, string> = {
      luxury: "Emphasize premium finishes, exclusivity, prestige, and sophisticated lifestyle",
      family: "Focus on space for growing family, schools, safety, and community amenities",
      investment: "Highlight ROI potential, rental income, appreciation, and cap rate",
      first_time_buyer: "Emphasize value, starter home benefits, low maintenance, and affordability",
    }

    const { text } = await generateText({
      model: "openai/gpt-4o-mini",
      prompt: `Rewrite this listing description for a ${style} buyer:

Property: ${listing.address ?? ""}${listing.city ? `, ${listing.city}` : ""}${listing.state ? `, ${listing.state}` : ""}

Original: ${original}

Style focus: ${stylePrompts[style]}

Keep it under 300 words. Make it compelling and specific.
Do NOT reference protected classes (race, religion, familial status, disability,
national origin, sex) or characterize the neighbourhood's people.`,
    })

    // Read-only by design: this returns copy for the agent to review. Writing
    // it back to listings.public_remarks is the listing surface's job — see
    // app/actions/listings-kernel.ts, which owns that column.
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
 *
 * ⚠ NOT SURFACED FROM MARKETING. This INSERTS into `offers`, a transaction-rail
 * table that already has its writers (app/actions/buyer-offer/* and
 * lib/kernel/offers.ts, which carry the compliance package, e-sign and
 * counter-offer chain). Wiring an offer-creating button onto a marketing page
 * would be a second writer for `offers` and would bypass the buyer-offer
 * compliance submission. Reported, not wired. Defects fixed below.
 */
export async function createAIOffer(params: OfferCreationParams): Promise<OfferCreationResult> {
  try {
    if (!isValidUUID(params.agentId) || !isValidUUID(params.buyerId) || !isValidUUID(params.listingId)) {
      return { success: false, error: "Invalid ID" }
    }

    const auth = await requireAgentInCallerBrokerage(params.agentId)
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()

    // Get listing and market context.
    // BROKEN EMBED: `agent:users(first_name, last_name)` asked PostgREST to
    // follow listings → users, but listings.agent_id FKs agents(id); there is
    // no listings→users relationship, so the whole select errored and
    // `listingResult.data` was null — which `.single()` reported as
    // "Listing not found" for every listing that exists. Go through agents.
    const [listingResult, buyerResult, compsResult] = await Promise.all([
      supabase
        .from("listings")
        .select("*, agent:agents(users(first_name, last_name))")
        .eq("id", params.listingId)
        .eq("brokerage_id", auth.brokerageId)
        .maybeSingle(),
      supabase
        .from("contacts")
        .select("*")
        .eq("id", params.buyerId)
        .eq("brokerage_id", auth.brokerageId)
        .maybeSingle(),
      supabase
        .from("offers")
        .select("offer_price, status")
        .eq("listing_id", params.listingId)
        .eq("brokerage_id", auth.brokerageId)
        .order("created_at", { ascending: false })
        .limit(5),
    ])

    if (listingResult.error) throw listingResult.error
    if (buyerResult.error) throw buyerResult.error
    if (compsResult.error) throw compsResult.error

    const listing = listingResult.data
    const buyer = buyerResult.data
    const existingOffers = compsResult.data || []

    if (!listing) return { success: false, error: "Listing not found in your brokerage" }

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
- Listing Agent: ${listing.agent?.users?.first_name ?? ""} ${listing.agent?.users?.last_name ?? ""}

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
${existingOffers.length > 0 ? `- Recent offer amounts: ${existingOffers.map((o: any) => `$${o.offer_price?.toLocaleString()}`).join(", ")}` : ""}

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
        // offers.escalation_clause is BOOLEAN in the live schema, not the
        // {maxPrice, increment} object this used to push into it — the insert
        // was rejected outright. The terms ride in the notes/ai_analysis.
        escalation_clause: Boolean(params.escalationClause),
        escalation_cap: params.escalationClause?.maxPrice ?? null,
        notes: params.additionalTerms ?? null,
        ai_analysis: aiAnalysis,
        // offers is brokerage-scoped; omitting this left the row untenanted.
        brokerage_id: auth.brokerageId,
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
 *
 * ⚠ NOT SURFACED FROM MARKETING — NAMED DUPLICATE.
 * app/actions/ai-offer-creation.ts::aiCounterOfferStrategy does the same job
 * and is already wired (app/actions/negotiation-copilot.ts) with validated
 * output, escalation maths and the negotiation-round context this lacks.
 * This variant is kept (not deleted) because it reads the live offer row
 * instead of taking hand-typed numbers, which the copilot version cannot do.
 * Its home is the offer/negotiation surface, which is owned elsewhere.
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

    const auth = await requireAgentInCallerBrokerage(agentId)
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()

    const { data: offer, error: offerError } = await supabase
      .from("offers")
      .select(`
        *,
        listing:listings(*),
        buyer:contacts(*)
      `)
      .eq("id", offerId)
      .eq("brokerage_id", auth.brokerageId)
      .maybeSingle()

    if (offerError) throw offerError
    if (!offer) return { success: false, error: "Offer not found in your brokerage" }

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt: `You are a real estate negotiation expert. Create a counter-offer strategy.

You are representing the ${representingSide.toUpperCase()}.

CURRENT OFFER:
- List Price: $${offer.listing?.list_price?.toLocaleString() ?? "N/A"}
- Offer: $${offer.offer_price?.toLocaleString() ?? "N/A"}
- Earnest: $${offer.earnest_money?.toLocaleString() ?? "N/A"}
- Financing: ${offer.financing_type ?? "N/A"}
- Contingencies: ${offer.contingencies?.join(", ") ?? "none"}
- Close Date: ${offer.closing_date ?? "N/A"}

Provide a strategic counter-offer recommendation with:
1. Recommended counter price
2. Terms to negotiate
3. Concessions to offer/request
4. Timeline strategy
5. Psychological tactics

Return JSON with detailed strategy.`,
    })

    let strategy: unknown
    try {
      strategy = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || stripCodeFences(text))
    } catch {
      return { success: false, error: "AI returned a counter-offer strategy that could not be parsed" }
    }
    return { success: true, strategy }
  } catch (error) {
    return handleError(error, "generateCounterOfferStrategy") as any
  }
}

/**
 * AI-Powered Offer Comparison for Sellers
 *
 * ⚠ NOT SURFACED FROM MARKETING — NAMED DUPLICATE.
 * app/actions/seller-offers.ts (→ analyzeAndCompareOffers) is the fuller
 * comparison: it is brokerage-scoped, computes seller-net with the commission
 * rate, and PERSISTS the result to `offer_comparison` so it survives a
 * refresh (loadLatestOfferComparison reads it back). This one is ephemeral.
 * Kept, not deleted; its home is the seller offer-comparison surface.
 */
export async function compareOffers(
  listingId: string,
  agentId: string
): Promise<{ success: boolean; comparison?: any; error?: string }> {
  try {
    if (!isValidUUID(listingId) || !isValidUUID(agentId)) {
      return { success: false, error: "Invalid ID" }
    }

    const auth = await requireAgentInCallerBrokerage(agentId)
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()

    const { data: offers, error: offersError } = await supabase
      .from("offers")
      .select(`
        *,
        buyer:contacts(first_name, last_name, contact_persona)
      `)
      .eq("listing_id", listingId)
      .eq("brokerage_id", auth.brokerageId)
      .in("status", ["pending", "countered"])
      .order("offer_price", { ascending: false })

    if (offersError) throw offersError
    if (!offers || offers.length === 0) {
      return { success: false, error: "No offers to compare" }
    }

    const { data: listing, error: listingError } = await supabase
      .from("listings")
      .select("address, list_price")
      .eq("id", listingId)
      .eq("brokerage_id", auth.brokerageId)
      .maybeSingle()

    if (listingError) throw listingError

    const { text } = await generateText({
      model: "openai/gpt-4o",
      prompt: `You are a seller's agent analyzing multiple offers.

LISTING:
- Address: ${listing?.address ?? "N/A"}
- List Price: $${listing?.list_price?.toLocaleString() ?? "N/A"}

OFFERS (${offers.length} total):
${offers.map((o: any, i: number) => `
Offer ${i + 1}:
- Amount: $${o.offer_price?.toLocaleString() ?? "N/A"}
- Earnest: $${o.earnest_money?.toLocaleString() ?? "N/A"}
- Down Payment: ${o.down_payment_percent ?? "N/A"}%
- Financing: ${o.financing_type ?? "N/A"}
- Contingencies: ${o.contingencies?.join(", ") ?? "none"}
- Close Date: ${o.closing_date ?? "N/A"}
${o.escalation_clause ? `- Escalation: Up to $${o.escalation_cap?.toLocaleString() ?? "cap not recorded"}` : ""}`).join("\n")}

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

    let comparison: unknown
    try {
      comparison = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || stripCodeFences(text))
    } catch {
      return { success: false, error: "AI returned a comparison that could not be parsed" }
    }
    return { success: true, comparison }
  } catch (error) {
    return handleError(error, "compareOffers") as any
  }
}
