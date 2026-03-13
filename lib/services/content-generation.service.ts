

import { runPipelineSimple } from "@/lib/ai"
import { createClient } from "@/lib/supabase/server"
import { isValidUUID } from "@/lib/validations"
import { CONTENT_TYPES } from "@/lib/constants"
import { handleError, ValidationError, NotFoundError } from "@/lib/errors"

// ============================================
// UNIFIED CONTENT GENERATION SERVICE
// Consolidates all AI content generation across the app
// Replaces duplicates in: ai-content-generation.tsx, social-publishing.ts, link-to-video.ts
// ============================================

export interface ContentGenerationParams {
  agentId: string
  contentType: keyof typeof CONTENT_TYPES
  targetAudience?: string
  propertyId?: string
  contactId?: string
  transactionId?: string
  customPrompt?: string
  platform?: "facebook" | "instagram" | "linkedin" | "twitter" | "tiktok"
  emailType?: "welcome" | "follow_up" | "property_alert" | "market_update" | "check_in" | "reengagement" | "newsletter"
  metadata?: Record<string, any>
}

export interface ContentGenerationResult {
  success: boolean
  content?: {
    id: string
    generated_content: string
    subject?: string
    hashtags?: string[]
    call_to_action?: string
    platform_specific?: Record<string, any>
  }
  error?: string
}

/**
 * Master content generation function - handles all AI content creation
 */
export async function generateContent(params: ContentGenerationParams): Promise<ContentGenerationResult> {
  try {
    // Validate inputs
    if (!isValidUUID(params.agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    console.log("[v0] Generating content:", params.contentType, "for platform:", params.platform)

    const supabase = await createClient()

    // Get context data based on content type
    const contextData = await gatherContextData(params)

    // Generate content using AI
    const generatedContent = await generateContentWithAI(params, contextData)

    // Save to database
    const { data: savedContent, error } = await supabase
      .from("ai_generated_content")
      .insert({
        agent_id: params.agentId,
        content_type: params.contentType,
        platform: params.platform,
        generated_content: generatedContent.body,
        subject_line: generatedContent.subject,
        hashtags: generatedContent.hashtags,
        metadata: {
          ...params.metadata,
          context_data: contextData,
          generation_params: params,
        },
        quality_score: generatedContent.qualityScore || 85,
        approval_status: "pending",
      })
      .select()
      .single()

    if (error) throw error

    return {
      success: true,
      content: {
        id: savedContent.id,
        generated_content: generatedContent.body,
        subject: generatedContent.subject,
        hashtags: generatedContent.hashtags,
        call_to_action: generatedContent.cta,
        platform_specific: generatedContent.platformSpecific,
      },
    }
  } catch (error) {
    return handleError(error, "generateContent")
  }
}

/**
 * Gather all relevant context data for content generation
 */
async function gatherContextData(params: ContentGenerationParams) {
  const supabase = await createClient()
  const context: any = {}

  // Get property details if provided
  if (params.propertyId && isValidUUID(params.propertyId)) {
    const { data: property } = await supabase.from("listings").select("*").eq("id", params.propertyId).single()
    context.property = property
  }

  // Get contact details if provided
  if (params.contactId && isValidUUID(params.contactId)) {
    const { data: contact } = await supabase
      .from("contacts")
      .select("*, lead_intelligence(*), buyer_persona(*)")
      .eq("id", params.contactId)
      .single()
    context.contact = contact
    context.persona = contact?.buyer_persona?.[0]
  }

  // Get transaction details if provided
  if (params.transactionId && isValidUUID(params.transactionId)) {
    const { data: transaction } = await supabase
      .from("transactions")
      .select("*, listings(*), contacts(*)")
      .eq("id", params.transactionId)
      .single()
    context.transaction = transaction
    context.property = transaction?.listings
    context.contact = transaction?.contacts
  }

  return context
}

/**
 * Generate content using AI with platform-specific optimizations
 */
async function generateContentWithAI(params: ContentGenerationParams, contextData: any) {
  const prompt = buildPrompt(params, contextData)

  const text = await runPipelineSimple(prompt, {
    feature: `content_service_${params.contentType}`,
  })

  // Parse AI response
  const parsed = parseAIResponse(text, params)

  return parsed
}

/**
 * Build AI prompt based on content type and context
 */
function buildPrompt(params: ContentGenerationParams, contextData: any): string {
  let prompt = ""

  // Base context
  if (params.customPrompt) {
    prompt += `${params.customPrompt}\n\n`
  }

  // Content type specific prompts
  switch (params.contentType) {
    case "email":
      prompt += buildEmailPrompt(params, contextData)
      break
    case "social_post":
      prompt += buildSocialPrompt(params, contextData)
      break
    case "listing_description":
      prompt += buildListingPrompt(params, contextData)
      break
    case "video_script":
      prompt += buildVideoPrompt(params, contextData)
      break
    default:
      prompt += `Generate ${params.contentType} content.\n\n`
  }

  // Add "Them First" instruction
  prompt += `\nIMPORTANT: Focus on the buyer/reader benefits (you, your, imagine) rather than agent promotion (I, me, my). Score should be 70%+ buyer-focused.\n`

  // Add output format
  prompt += `\nOUTPUT FORMAT (JSON):\n`
  prompt += `{\n`
  prompt += `  "subject": "Subject line or title",\n`
  prompt += `  "body": "Main content",\n`
  prompt += `  "hashtags": ["tag1", "tag2"],\n`
  prompt += `  "cta": "Call to action",\n`
  prompt += `  "qualityScore": 85\n`
  prompt += `}\n`

  return prompt
}

function buildEmailPrompt(params: ContentGenerationParams, contextData: any): string {
  const contact = contextData.contact
  const property = contextData.property

  let prompt = `Generate a professional real estate ${params.emailType} email.\n\n`

  if (contact) {
    prompt += `RECIPIENT: ${contact.full_name || contact.first_name}\n`
    prompt += `Lead Temperature: ${contact.lead_temperature || "warm"}\n`
    if (contextData.persona) {
      prompt += `Buyer Persona: ${contextData.persona.persona_name}\n`
    }
  }

  if (property) {
    prompt += `\nPROPERTY:\n`
    prompt += `- Address: ${property.address}\n`
    prompt += `- Price: $${property.price?.toLocaleString()}\n`
    prompt += `- ${property.bedrooms}BR/${property.bathrooms}BA\n`
    prompt += `- ${property.square_feet} sqft\n`
  }

  // Platform-specific character limits
  if (params.platform === "twitter") {
    prompt += `\nKeep under 280 characters.\n`
  }

  return prompt
}

function buildSocialPrompt(params: ContentGenerationParams, contextData: any): string {
  const property = contextData.property
  const platform = params.platform || "instagram"

  let prompt = `Generate an engaging ${platform} post for a real estate listing.\n\n`

  if (property) {
    prompt += `PROPERTY:\n`
    prompt += `- ${property.address}, ${property.city}\n`
    prompt += `- $${property.price?.toLocaleString()}\n`
    prompt += `- ${property.bedrooms}BR/${property.bathrooms}BA\n`
    prompt += `- ${property.property_type}\n`
  }

  // Platform-specific guidelines
  const platformGuidelines: Record<string, string> = {
    instagram: "Use emojis, engaging hooks, max 2200 characters. Include 10-15 hashtags.",
    facebook: "Conversational tone, 400-500 characters optimal. Focus on community benefits.",
    linkedin: "Professional tone, industry insights, max 700 characters.",
    twitter: "Concise, punchy, max 280 characters. 2-3 hashtags max.",
    tiktok: "Casual, trendy, speak to younger buyers. Include trending phrases.",
  }

  prompt += `\n${platformGuidelines[platform] || platformGuidelines.instagram}\n`

  return prompt
}

function buildListingPrompt(params: ContentGenerationParams, contextData: any): string {
  const property = contextData.property

  let prompt = `Generate a compelling MLS listing description.\n\n`

  if (property) {
    prompt += `PROPERTY DETAILS:\n`
    prompt += `- ${property.address}, ${property.city}, ${property.state} ${property.zip_code}\n`
    prompt += `- List Price: $${property.price?.toLocaleString()}\n`
    prompt += `- ${property.bedrooms} Bedrooms, ${property.bathrooms} Bathrooms\n`
    prompt += `- ${property.square_feet} Square Feet\n`
    prompt += `- Property Type: ${property.property_type}\n`
    if (property.year_built) prompt += `- Year Built: ${property.year_built}\n`
    if (property.lot_size_acres) prompt += `- Lot Size: ${property.lot_size_acres} acres\n`
  }

  prompt += `\nCreate a description that highlights the lifestyle benefits and unique features.\n`

  return prompt
}

function buildVideoPrompt(params: ContentGenerationParams, contextData: any): string {
  const property = contextData.property

  let prompt = `Generate a 30-second video narration script for a property video.\n\n`

  if (property) {
    prompt += `PROPERTY:\n`
    prompt += `- ${property.address}\n`
    prompt += `- $${property.price?.toLocaleString()}\n`
    prompt += `- ${property.bedrooms}BR/${property.bathrooms}BA\n`
  }

  prompt += `\nCreate an engaging script that flows naturally with video footage. Use storytelling to create emotional connection.\n`

  return prompt
}

/**
 * Parse AI response into structured format
 */
function parseAIResponse(text: string, params: ContentGenerationParams) {
  try {
    // Try to extract JSON from response
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        subject: parsed.subject || "",
        body: parsed.body || text,
        hashtags: parsed.hashtags || [],
        cta: parsed.cta || "",
        qualityScore: parsed.qualityScore || 85,
        platformSpecific: parsed.platformSpecific || {},
      }
    }
  } catch (e) {
    console.log("[v0] Failed to parse JSON, using raw text")
  }

  // Fallback: use raw text
  return {
    subject: "",
    body: text,
    hashtags: [],
    cta: "",
    qualityScore: 80,
    platformSpecific: {},
  }
}

/**
 * Batch generate content for multiple items
 */
export async function bulkGenerateContent(params: {
  agentId: string
  contentType: keyof typeof CONTENT_TYPES
  targets: string[] // Property IDs, Contact IDs, etc.
  platform?: string
}): Promise<{ success: boolean; generated: number; failed: number }> {
  let generated = 0
  let failed = 0

  for (const targetId of params.targets) {
    const result = await generateContent({
      agentId: params.agentId,
      contentType: params.contentType,
      propertyId: targetId,
      platform: params.platform as any,
    })

    if (result.success) {
      generated++
    } else {
      failed++
    }

    // Rate limiting
    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  return { success: true, generated, failed }
}
