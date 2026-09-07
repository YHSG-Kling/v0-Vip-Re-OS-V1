"use server"

import { createClient } from "@/lib/supabase/server"
import { LIFETIME_CUSTOMER_SEGMENT } from "@/lib/contact-types"
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
  audienceSegment: "buyers" | "sellers" | "investors" | typeof LIFETIME_CUSTOMER_SEGMENT | "sphere" | "all"
  topic?: string
  tone?: "professional" | "friendly" | "educational" | "urgent"
  includeMarketData?: boolean
  includeListings?: boolean
  customSections?: string[]
  /** Optional umbrella marketing_campaigns id. Passed THROUGH to the canonical
   *  createNewsletterCampaign, which verifies it against the session brokerage
   *  before writing — this action never touches the column itself. The AI
   *  Newsletter dialog offers it from the campaigns already loaded on the
   *  studio page. */
  marketingCampaignId?: string
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
            // `median_list_price` IS DELIBERATELY ABSENT. The column carries
            // DEFAULT 0 and has no writer anywhere — the only upsert into this
            // table (lib/intelligence/market-insight-generator.ts:233) does not
            // name it — so every row answers 0, and `(0).toLocaleString()` is
            // the truthy string "0", which slipped straight past the `|| "N/A"`
            // below and put the line "Median List Price: $0" into the prompt of
            // a newsletter that goes to the agent's whole contact list. A
            // fabricated market number in front of clients is worse than an
            // absent one. The median this newsletter quotes is
            // median_sale_price, written at market-insight-generator.ts:244.
            .select("median_sale_price, avg_days_on_market, active_listings, recorded_date:data_date")
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
- Active Inventory: ${marketData.active_listings || "N/A"} homes` : ""}

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
      brokerageId: auth.brokerageId,
      userId: auth.userId,
      agentId: params.agentId,
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
      // The umbrella link — the canonical writer verifies the id belongs to
      // the session's brokerage before writing it (never trusted from here).
      marketingCampaignId: params.marketingCampaignId,
    })

    if (!saveResult.success || !(saveResult as { newsletter?: { id: string } }).newsletter) {
      return {
        success: false,
        error: (saveResult as { error?: string }).error ?? "Failed to save newsletter",
      }
    }

    revalidatePath("/dashboard/marketing/studio")
    revalidatePath("/newsletters")

    // createNewsletterCampaign's success shape types `newsletter` loosely
    // (Record<string, any> — it gained upsert-by-id edit semantics this wave),
    // so the id is read with a runtime check instead of the old hard cast: a
    // save that came back id-less must surface as a failure, not crash the
    // spread below.
    const savedId = (saveResult as { newsletter?: { id?: unknown } }).newsletter?.id
    if (typeof savedId !== "string" || !savedId) {
      return { success: false, error: "Newsletter was saved but no id came back" }
    }
    return {
      success: true,
      newsletter: {
        id: savedId,
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
      brokerageId: auth.brokerageId,
      userId: auth.userId,
      agentId,
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
      brokerageId: mailBrokerageId,
      agentId: params.agentId,
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

    // /dashboard/marketing/direct-mail has no page.tsx. direct_mail_campaigns is read
    // by the full manager at app/dashboard/campaigns/mail and mirrored on the studio
    // "mail" tab (app/dashboard/marketing/studio/marketing-studio-client.tsx:3354).
    revalidatePath("/dashboard/campaigns/mail")
    revalidatePath("/dashboard/marketing/studio")

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

// TOMBSTONE (§1.1, 2026-09-07): createAIListing deleted — survivor
// app/actions/listings-kernel.ts:createListingWithSellerContact (the listing
// insert + seller-side deal + dotloop container) together with
// app/actions/ai-listing-intake.ts:aiGenerateListingDescription (MLS/marketing/
// social/email/video/SEO copy, run through guardContent's Fair Housing scan —
// this deleted action had no compliance guard at all) and
// :aiSuggestListPrice (comps-based pricing with confidence/positioning/timing,
// pulling the brokerage's own sold inventory when no comps are supplied — this
// deleted action only averaged its own naive 10-comp query). Merged: nothing —
// the survivor pair already covers every field this produced (MLS + marketing
// description, social content, priced comps analysis) and does strictly more
// (the compliance guard, confidence/positioning/timing fields, listing_marketing_content
// persistence already wired). Not carried over: target buyer personas and a
// discrete marketing-strategy list, which are content-shape additions, not a
// validation/guard/column fix, and have no survivor home — recorded here as an
// open product gap, not silently dropped.

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
      brokerageId: auth.brokerageId,
      userId: auth.userId,
      agentId,
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

// TOMBSTONE (§1.1, 2026-09-07): createAIOffer deleted — survivor
// app/actions/buyer-offers.ts:createOffer (the canonical offer writer, per
// app/actions/buyer-offer/* + lib/kernel/offers.ts). Merged: nothing — the
// survivor already writes `escalation_clause` as a real boolean and
// `escalation_cap` as its cap (OfferFormData types the field boolean, so the
// column is never handed the {maxPrice, increment} object this deleted action
// used to before its own Boolean(...) coercion fix), already uses the real
// offer_price/closing_date columns, and already fence-extracts its one AI-JSON
// response (getOrGenerateStrategyRecommendation). It also enforces three gates
// this deleted action never had: buyer-lifecycle eligibility, financial
// verification, and the pending-offer limit.

// TOMBSTONE (§1.1, 2026-09-07): generateCounterOfferStrategy deleted —
// survivor app/actions/ai-offer-creation.ts:aiCounterOfferStrategy (wired
// through app/actions/negotiation-copilot.ts, with validated output,
// escalation maths and negotiation-round context this lacked). Merged: the
// one thing the survivor was missing — JSON fence/brace-extraction robustness
// on the model's response (the survivor called a bare
// `JSON.parse(strategyResult.text)`, which throws on a fenced or prose-wrapped
// reply) — is now on aiCounterOfferStrategy at
// app/actions/ai-offer-creation.ts:487. Not carried over: reading the live
// offer row by id instead of taking hand-typed price/terms numbers, which is a
// call-signature change, not a validation/guard/column fix — recorded as an
// open product gap on the negotiation-copilot surface, not silently dropped.

// TOMBSTONE (§1.1, 2026-09-07): compareOffers deleted — survivor
// app/actions/seller-offers.ts:triggerOfferComparison (→
// lib/offers/offer-analyzer.ts:analyzeAndCompareOffers), which is
// brokerage-scoped, computes seller-net with the brokerage's real commission
// rate, and PERSISTS the result to `offer_comparison` (loadLatestOfferComparison
// reads it back) plus `offers.ai_recommendation`/`ai_analysis` per offer. Merged:
// nothing — the survivor already reads listings.list_price (never the phantom
// `listing.price`), already reads escalation_clause/escalation_cap, and already
// fence-strips the model's JSON (`.replace(/^\`\`\`json\n?/, "")` before
// `JSON.parse`, guarded in try/catch) — a different but equally sufficient
// technique to this deleted action's brace-regex extraction.
