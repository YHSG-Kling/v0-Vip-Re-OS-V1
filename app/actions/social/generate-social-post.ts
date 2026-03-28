"use server"

/**
 * generate-social-post.ts
 * Standalone AI social post generator.
 * Uses anthropic('claude-sonnet-4-20250514') per rule 9.
 * Called by SocialAiComposer and SocialCalendarAiPlanner.
 */

import { generateObject } from "ai"
import { z } from "zod"
import { resolveModel } from "@/lib/ai/resolve-model"
import { createClient } from "@/lib/supabase/server"

const GeneratedPostSchema = z.object({
  content: z.string().describe("Full social media post body, ready to publish"),
  hashtags: z.array(z.string()).describe("5-20 relevant hashtags without the # prefix"),
  hook: z.string().describe("The opening line / hook of the post"),
  cta: z.string().describe("Call to action at the end of the post"),
  estimated_engagement: z.enum(["low", "medium", "high"]).describe("AI confidence in engagement level"),
  compliance_notes: z.string().optional().describe("Any compliance considerations to flag"),
})

export type GeneratedPost = z.infer<typeof GeneratedPostSchema>

export async function generateSocialPostContent(params: {
  brief: string          // User's description: "Write a spring market post for Austin TX"
  platform: string       // facebook | instagram | linkedin | twitter | tiktok
  tone?: string          // professional | friendly | energetic | informative | casual
  contentType?: string   // market_update | just_listed | just_sold | tips | community | testimonial
  listingId?: string     // Pre-fill from listing if provided
  brokerageId: string
  agentId: string
}): Promise<{
  success: boolean
  data?: GeneratedPost
  error?: string
}> {
  try {
    const supabase = await createClient()

    // Get brand voice for this brokerage/agent
    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("tone, formality_level, preferred_words, prohibited_words, key_brand_messages, custom_instructions")
      .or(`agent_id.eq.${params.agentId},brokerage_id.eq.${params.brokerageId}`)
      .eq("is_active", true)
      .maybeSingle()

    // Get listing context if provided
    let listingContext = ""
    if (params.listingId) {
      const { data: listing } = await supabase
        .from("listings")
        .select("address, city, state, list_price, bedrooms, bathrooms, sqft")
        .eq("id", params.listingId)
        .maybeSingle()

      if (listing) {
        listingContext = `\n\nListing context:\n- Address: ${listing.address}, ${listing.city}, ${listing.state}\n- Price: $${listing.list_price?.toLocaleString()}\n- ${listing.bedrooms}BR / ${listing.bathrooms}BA / ${listing.sqft} sqft`
      }
    }

    // Platform-specific character limits
    const CHAR_LIMITS: Record<string, number> = {
      facebook: 63000,
      instagram: 2200,
      linkedin: 3000,
      twitter: 280,
      tiktok: 2200,
    }
    const charLimit = CHAR_LIMITS[params.platform] ?? 2200

    const systemPrompt = `You are an expert real estate social media strategist.
You write posts using the "Them First" framework: 40% empathy/feelings, 25% trust-building, 25% value, 10% solution.
NEVER use fair housing violations or protected-class language.
NEVER make guarantees about home values or investment returns.
NEVER use deceptive urgency tactics.
${brandVoice?.prohibited_words?.length ? `NEVER use these words: ${brandVoice.prohibited_words.join(", ")}.` : ""}
${brandVoice?.custom_instructions ? `Brand instructions: ${brandVoice.custom_instructions}` : ""}`

    const userPrompt = `Create a ${params.platform} social media post.

Brief: ${params.brief}
Content type: ${params.contentType ?? "general"}
Tone: ${params.tone ?? brandVoice?.tone ?? "professional"}
Character limit: ${charLimit}
${listingContext}
${brandVoice?.key_brand_messages?.length ? `Brand messages to incorporate: ${brandVoice.key_brand_messages.join("; ")}` : ""}
${brandVoice?.preferred_words?.length ? `Preferred words/phrases: ${brandVoice.preferred_words.join(", ")}` : ""}

Write the full post. For Twitter keep it under 280 characters. For Instagram use line breaks for readability.`

    const { object } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: GeneratedPostSchema,
      system: systemPrompt,
      prompt: userPrompt,
    })

    return { success: true, data: object }
  } catch (error: any) {
    console.error("[generate-social-post] Error:", error)
    return { success: false, error: error?.message ?? "Failed to generate post content" }
  }
}

/** Generate a full week's content calendar for an agent */
export async function generateWeeklyContentPlan(params: {
  brokerageId: string
  agentId: string
  marketArea?: string
  listingCount?: number
}): Promise<{
  success: boolean
  data?: Array<{
    day: string
    contentType: string
    platform: string
    hook: string
    suggestedTime: string
  }>
  error?: string
}> {
  try {
    const { data: brandVoice } = await (await createClient())
      .from("brand_voice_profile")
      .select("tone, key_brand_messages")
      .or(`agent_id.eq.${params.agentId},brokerage_id.eq.${params.brokerageId}`)
      .eq("is_active", true)
      .maybeSingle()

    const WeekPlanSchema = z.object({
      plan: z.array(z.object({
        day:          z.string(),
        contentType:  z.string(),
        platform:     z.string(),
        hook:         z.string(),
        suggestedTime: z.string(),
      }))
    })

    const { object } = await generateObject({
      model: resolveModel("anthropic/claude-sonnet-4-20250514"),
      schema: WeekPlanSchema,
      prompt: `Create a 7-day social media content calendar for a real estate agent.
Market area: ${params.marketArea ?? "local market"}
Active listings: ${params.listingCount ?? 0}
Brand tone: ${brandVoice?.tone ?? "professional and friendly"}
Include a mix of: market updates, listing highlights, tips, community spotlights, client stories, personal touches.
For each day provide: the day name, content type, best platform, hook (opening line), suggested posting time.`,
    })

    return { success: true, data: object.plan }
  } catch (error: any) {
    return { success: false, error: error?.message ?? "Failed to generate weekly plan" }
  }
}

/** Suggest hashtags for a given post and platform */
export async function suggestHashtags(params: {
  content: string
  platform: string
  location?: string
}): Promise<{ hashtags: string[] }> {
  try {
    const HashtagSchema = z.object({
      hashtags: z.array(z.string()).describe("Relevant hashtags without #"),
    })

    const { object } = await generateObject({
      model: resolveModel("openai/gpt-4o-mini"),
      schema: HashtagSchema,
      prompt: `Suggest 15 relevant ${params.platform} hashtags for this real estate post.
${params.location ? `Location: ${params.location}` : ""}
Post: ${params.content.slice(0, 500)}
Mix of: broad real estate (#RealEstate), location-specific, niche (#LuxuryHomes), and engagement (#HomeBuying).`,
    })

    return { hashtags: object.hashtags }
  } catch {
    return { hashtags: ["RealEstate", "HomesForSale", "RealEstateAgent", "NewListing", "PropertyForSale"] }
  }
}
