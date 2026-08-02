"use server"

import { createClient } from "@/lib/supabase/server"
import { generateTextRouted as generateText } from "@/lib/ai/models"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"

// ─── Deleted here (orphan burn-down): five drifted twins ──────────────────────
// generateAINewsletter / generateNewsletterSubjectVariants  → app/actions/ai-newsletter.ts
//   (aiWriteNewsletterContent + createNewsletterCampaign + aiGenerateSubjectLines) is the
//   canonical newsletter system — it owns sections, sends, analytics and subscribers.
// createAIListing / enhanceListingDescription → app/actions/ai-listing-intake.ts
//   (createListing + aiGenerateListingDescription). enhanceListingDescription also read
//   listings.mls_description / .marketing_description, neither of which exists.
// createAIOffer / generateCounterOfferStrategy → app/actions/ai-offer-creation.ts
//   (submitCompleteOffer + aiCounterOfferStrategy) — the strategy/escalation/contingency
//   path. generateCounterOfferStrategy also read offers.offer_amount / .close_date
//   (real columns: offer_price / closing_date).

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
      supabase.from("agents").select("users(first_name, last_name, phone, email)").eq("id", params.agentId).maybeSingle(),
      supabase.from("brand_voice_profile").select("*").eq("agent_id", params.agentId).maybeSingle(),
      params.propertyId
        ? supabase.from("listings").select("*").eq("id", params.propertyId).single()
        : Promise.resolve({ data: null }),
    ])

    // Unwrap the nested users row from the agents join above.
    const agent = (agentResult.data as { users?: { first_name?: string; last_name?: string; phone?: string; email?: string } | null } | null)?.users ?? null
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
    // Map to the canonical direct_mail_campaigns columns: mail_type→piece_type
    // (free text), target_count→quantity, estimated_cost→per_piece_cost (unit;
    // total derives as quantity*per_piece_cost), headline+content→copy_text.
    // status must satisfy the CHECK (planning|approved|printed|mailed).
    const { data: saved, error: saveError } = await supabase
      .from("direct_mail_campaigns")
      .insert({
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
