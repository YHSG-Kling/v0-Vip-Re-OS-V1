import { createClient } from "@/lib/supabase/server"
import { generateAIResponse } from "@/lib/ai"
import { logContentGeneration } from "@/app/actions/ai-content-generation"
import { getAgentContext } from "@/lib/identity/get-agent-context"

export async function POST(request: Request) {
  try {
    const body = await request.json()
    const { agentId, contentType, platform, topic, targetAudience, tone, keywords, propertyDetails, contactId } = body

    const supabase = await createClient()

    // Get brand voice profile
    const { data: brandVoice } = await supabase
      .from("brand_voice_profile")
      .select("*")
      .eq("agent_id", agentId)
      .maybeSingle()

    // Get contact persona if contactId provided
    let personaContext = ""
    if (contactId) {
      const { data: contact } = await supabase.from("contacts").select("*").eq("id", contactId).maybeSingle()

      if (contact) {
        personaContext = `
Target Contact Profile:
- Name: ${contact.first_name} ${contact.last_name}
- Buyer Type: ${contact.buyer_type || "Not specified"}
- Price Range: ${contact.price_range || "Not specified"}
- Preferred Locations: ${contact.preferred_locations?.join(", ") || "Not specified"}
- Stage: ${contact.lifecycle_stage || "Not specified"}
        `
      }
    }

    // Build persona-aware prompt
    const prompt = buildContentPrompt({
      contentType,
      platform,
      topic,
      targetAudience,
      tone: tone || brandVoice?.tone,
      style: brandVoice?.style,
      keywords: keywords || brandVoice?.keywords,
      avoidWords: brandVoice?.avoid_words,
      propertyDetails,
      personaContext,
    })

    const startTime = Date.now()

    // Get actor context for governance
    const agentCtx = await getAgentContext()
    const actorContext = agentCtx
      ? { userId: agentCtx.userId, brokerageId: agentCtx.brokerageId }
      : undefined

    // Generate content using AI SDK
    const response = await generateAIResponse({
      prompt,
      temperature: 0.7,
      maxOutputTokens: 400: contentType === "blog_post" ? 2000 : 500,
      metadata: {
        userId: agentId,
        brokerageId: actorContext?.brokerageId,
        feature: "email_generation",
      },
    })
    const text = response.text

    const generationTime = Date.now() - startTime

    // Log generation
    await logContentGeneration({
      agentId,
      contentType,
      prompt,
      model: response.model || "email_generation",
      tokensUsed: (response.usage?.promptTokens || 0) + (response.usage?.completionTokens || 0),
      generationTime,
      success: true,
    })

    // Extract hashtags if social post
    let hashtags: string[] = []
    if (platform && ["instagram", "facebook", "twitter", "linkedin"].includes(platform)) {
      const hashtagMatches = text.match(/#[\w]+/g)
      hashtags = hashtagMatches || []
    }

    // Extract SEO keywords if blog post
    let seoKeywords: string[] = []
    if (contentType === "blog_post") {
      seoKeywords = keywords || []
    }

    return Response.json({
      success: true,
      content: text,
      hashtags,
      seoKeywords,
      tokensUsed: response.usage?.totalTokens || 0,
      generationTime,
    })
  } catch (error: any) {
    console.error("Content generation error:", error)

    // Log failed generation
    const body = await request.json() // Declare body variable here
    if (body?.agentId) {
      await logContentGeneration({
        agentId: body.agentId,
        contentType: body.contentType,
        prompt: body.topic || "",
        success: false,
        errorMessage: error.message,
      })
    }

    return Response.json({ success: false, error: error.message }, { status: 500 })
  }
}

function buildContentPrompt(params: {
  contentType: string
  platform?: string
  topic: string
  targetAudience?: string
  tone?: string
  style?: string
  keywords?: string[]
  avoidWords?: string[]
  propertyDetails?: any
  personaContext?: string
}) {
  const {
    contentType,
    platform,
    topic,
    targetAudience,
    tone,
    style,
    keywords,
    avoidWords,
    propertyDetails,
    personaContext,
  } = params

  let prompt = ""

  // Base instruction
  if (contentType === "social_post") {
    prompt = `Create an engaging ${platform || "social media"} post about: ${topic}\n\n`
  } else if (contentType === "blog_post") {
    prompt = `Write a comprehensive blog post about: ${topic}\n\n`
  } else if (contentType === "email") {
    prompt = `Write a personalized email about: ${topic}\n\n`
  } else if (contentType === "listing_description") {
    prompt = `Write a compelling property listing description.\n\n`
  } else if (contentType === "newsletter") {
    prompt = `Create an engaging newsletter section about: ${topic}\n\n`
  }

  // Add brand voice guidelines
  if (tone) {
    prompt += `Tone: ${tone}\n`
  }
  if (style) {
    prompt += `Writing Style: ${style}\n`
  }

  // Add target audience
  if (targetAudience) {
    prompt += `Target Audience: ${targetAudience}\n`
  }

  // Add persona context
  if (personaContext) {
    prompt += `\n${personaContext}\n`
  }

  // Add property details if provided
  if (propertyDetails) {
    prompt += `\nProperty Details:\n`
    if (propertyDetails.address) prompt += `- Address: ${propertyDetails.address}\n`
    if (propertyDetails.price) prompt += `- Price: $${propertyDetails.price.toLocaleString()}\n`
    if (propertyDetails.beds) prompt += `- Bedrooms: ${propertyDetails.beds}\n`
    if (propertyDetails.baths) prompt += `- Bathrooms: ${propertyDetails.baths}\n`
    if (propertyDetails.sqft) prompt += `- Square Feet: ${propertyDetails.sqft}\n`
    if (propertyDetails.features) prompt += `- Features: ${propertyDetails.features.join(", ")}\n`
  }

  // Add keywords to incorporate
  if (keywords && keywords.length > 0) {
    prompt += `\nNaturally incorporate these keywords: ${keywords.join(", ")}\n`
  }

  // Add words to avoid
  if (avoidWords && avoidWords.length > 0) {
    prompt += `\nAvoid using these words: ${avoidWords.join(", ")}\n`
  }

  // Add platform-specific guidelines
  if (platform === "instagram") {
    prompt += `\nInclude 5-10 relevant hashtags at the end. Keep it engaging and visual-focused. Max 2200 characters.`
  } else if (platform === "facebook") {
    prompt += `\nMake it conversational and community-focused. Include a call-to-action.`
  } else if (platform === "linkedin") {
    prompt += `\nMaintain a professional tone. Focus on market insights and expertise.`
  } else if (platform === "twitter") {
    prompt += `\nKeep it concise and punchy. Max 280 characters.`
  }

  // Add content type specific guidelines
  if (contentType === "blog_post") {
    prompt += `\n\nStructure:
1. Engaging headline
2. Introduction hook
3. 3-5 main sections with subheadings
4. Actionable takeaways
5. Strong call-to-action

Include SEO-optimized content with natural keyword placement. Target length: 800-1200 words.`
  } else if (contentType === "email") {
    prompt += `\n\nStructure:
1. Personalized greeting
2. Relevant opening (reference their interests/needs)
3. Main message with value
4. Clear call-to-action
5. Professional sign-off

Keep it concise and scannable. Use short paragraphs.`
  }

  return prompt
}
