"use server"

import { isValidUUID } from "@/lib/validations"
import { handleError, ValidationError } from "@/lib/errors"
import {
  generateTextContent,
  generateAudioScript,
  generateVideoScript,
  generateImagePrompt,
  generateOmnipresentContent,
  generateContentVariations,
  gatherContext,
  enrichPromptWithContext,
  logContentGeneration,
  logOmnipresentGeneration,
  getContentGenerationHistory,
  getContentGenerationStats,
  type ContentGenerationParams,
  type ContentGenerationOutput,
} from "@/lib/content-generation"
import { v4 as uuidv4 } from "uuid"

// ============================================
// SYSTEM 4.1 – CONTENT GENERATION ENGINE
// Server Actions (Public API)
// Draft-only, no publishing/approval/compliance
// ============================================

export interface ContentGenerationResult {
  success: boolean
  content?: ContentGenerationOutput
  content_id?: string // Runtime-only UUID (not persisted)
  error?: string
}

export interface BatchContentGenerationResult {
  success: boolean
  contents?: ContentGenerationOutput[]
  generated_count?: number
  failed_count?: number
  error?: string
}

/**
 * Generate TEXT content (email, newsletter, SMS, blog, social, ads, listings)
 */
export async function generateText(params: {
  agent_id: string
  content_type: ContentGenerationParams["content_type"]
  channel_intent?: ContentGenerationParams["channel_intent"]
  listing_id?: string
  contact_id?: string
  transaction_id?: string
  custom_prompt?: string
  target_audience?: string
  tone?: string
  length?: "short" | "medium" | "long"
  source_urls?: string[]
}): Promise<ContentGenerationResult> {
  try {
    // Validate agent_id
    if (!isValidUUID(params.agent_id)) {
      throw new ValidationError("Invalid agent ID")
    }

    // Gather context from database
    const context = await gatherContext({
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      transaction_id: params.transaction_id,
    })

    // Enrich prompt with context
    const enrichedPrompt = params.custom_prompt
      ? enrichPromptWithContext(params.custom_prompt, context)
      : ""

    // Generate content
    const content = await generateTextContent({
      content_type: params.content_type,
      channel_intent: params.channel_intent,
      custom_prompt: enrichedPrompt || params.custom_prompt,
      target_audience: params.target_audience,
      tone: params.tone,
      length: params.length,
      source_urls: params.source_urls,
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      transaction_id: params.transaction_id,
    })

    // Generate runtime UUID (not persisted to database)
    const content_id = uuidv4()

    // Log to activities table (ONLY database write)
    await logContentGeneration({
      agent_id: params.agent_id,
      content_output: content,
      entity_id: content_id,
      entity_type: "content",
    })

    return {
      success: true,
      content,
      content_id,
    }
  } catch (error) {
    return handleError(error, "generateText")
  }
}

/**
 * Generate AUDIO script (podcast, short-form audio)
 */
export async function generateAudio(params: {
  agent_id: string
  content_type: "podcast_script" | "audio_script"
  duration_minutes?: number
  listing_id?: string
  contact_id?: string
  transaction_id?: string
  custom_prompt?: string
  target_audience?: string
}): Promise<ContentGenerationResult> {
  try {
    if (!isValidUUID(params.agent_id)) {
      throw new ValidationError("Invalid agent ID")
    }

    const context = await gatherContext({
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      transaction_id: params.transaction_id,
    })

    const enrichedPrompt = params.custom_prompt
      ? enrichPromptWithContext(params.custom_prompt, context)
      : ""

    const content = await generateAudioScript({
      content_type: params.content_type,
      duration_minutes: params.duration_minutes,
      custom_prompt: enrichedPrompt || params.custom_prompt,
      target_audience: params.target_audience,
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      transaction_id: params.transaction_id,
    })

    const content_id = uuidv4()

    await logContentGeneration({
      agent_id: params.agent_id,
      content_output: content,
      entity_id: content_id,
    })

    return {
      success: true,
      content,
      content_id,
    }
  } catch (error) {
    return handleError(error, "generateAudio")
  }
}

/**
 * Generate VIDEO script (long-form, short-form, social video)
 */
export async function generateVideo(params: {
  agent_id: string
  content_type: "video_script"
  channel_intent?: "youtube" | "tiktok" | "instagram" | "facebook"
  video_length_seconds?: number
  listing_id?: string
  contact_id?: string
  transaction_id?: string
  custom_prompt?: string
  target_audience?: string
}): Promise<ContentGenerationResult> {
  try {
    if (!isValidUUID(params.agent_id)) {
      throw new ValidationError("Invalid agent ID")
    }

    const context = await gatherContext({
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      transaction_id: params.transaction_id,
    })

    const enrichedPrompt = params.custom_prompt
      ? enrichPromptWithContext(params.custom_prompt, context)
      : ""

    const content = await generateVideoScript({
      content_type: params.content_type,
      channel_intent: params.channel_intent,
      video_length_seconds: params.video_length_seconds,
      custom_prompt: enrichedPrompt || params.custom_prompt,
      target_audience: params.target_audience,
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      transaction_id: params.transaction_id,
    })

    const content_id = uuidv4()

    await logContentGeneration({
      agent_id: params.agent_id,
      content_output: content,
      entity_id: content_id,
    })

    return {
      success: true,
      content,
      content_id,
    }
  } catch (error) {
    return handleError(error, "generateVideo")
  }
}

/**
 * Generate IMAGE prompt (for external image generation)
 */
export async function generateImage(params: {
  agent_id: string
  channel_intent?: string
  listing_id?: string
  contact_id?: string
  custom_prompt?: string
  tone?: string
}): Promise<ContentGenerationResult> {
  try {
    if (!isValidUUID(params.agent_id)) {
      throw new ValidationError("Invalid agent ID")
    }

    const context = await gatherContext({
      listing_id: params.listing_id,
      contact_id: params.contact_id,
    })

    const enrichedPrompt = params.custom_prompt
      ? enrichPromptWithContext(params.custom_prompt, context)
      : ""

    const content = await generateImagePrompt({
      content_type: "image_prompt",
      channel_intent: params.channel_intent as any,
      custom_prompt: enrichedPrompt || params.custom_prompt,
      tone: params.tone,
      listing_id: params.listing_id,
      contact_id: params.contact_id,
    })

    const content_id = uuidv4()

    await logContentGeneration({
      agent_id: params.agent_id,
      content_output: content,
      entity_id: content_id,
    })

    return {
      success: true,
      content,
      content_id,
    }
  } catch (error) {
    return handleError(error, "generateImage")
  }
}

/**
 * Generate OMNIPRESENT content (one idea → many formats)
 */
export async function generateOmnipresent(params: {
  agent_id: string
  core_idea: string
  target_audience?: string
  listing_id?: string
  contact_id?: string
  formats: Array<"podcast" | "video" | "newsletter" | "social_post" | "blog">
}): Promise<BatchContentGenerationResult> {
  try {
    if (!isValidUUID(params.agent_id)) {
      throw new ValidationError("Invalid agent ID")
    }

    const contents = await generateOmnipresentContent({
      core_idea: params.core_idea,
      target_audience: params.target_audience,
      listing_id: params.listing_id,
      contact_id: params.contact_id,
      formats: params.formats,
    })

    await logOmnipresentGeneration({
      agent_id: params.agent_id,
      core_idea: params.core_idea,
      formats_generated: contents,
    })

    return {
      success: true,
      contents,
      generated_count: contents.length,
      failed_count: 0,
    }
  } catch (error) {
    return handleError(error, "generateOmnipresent")
  }
}

/**
 * Generate content VARIATIONS (for A/B testing)
 */
export async function generateVariations(params: {
  agent_id: string
  content_type: ContentGenerationParams["content_type"]
  channel_intent?: ContentGenerationParams["channel_intent"]
  listing_id?: string
  contact_id?: string
  custom_prompt?: string
  target_audience?: string
  variation_count?: number
}): Promise<BatchContentGenerationResult> {
  try {
    if (!isValidUUID(params.agent_id)) {
      throw new ValidationError("Invalid agent ID")
    }

    const context = await gatherContext({
      listing_id: params.listing_id,
      contact_id: params.contact_id,
    })

    const enrichedPrompt = params.custom_prompt
      ? enrichPromptWithContext(params.custom_prompt, context)
      : ""

    const variations = await generateContentVariations(
      {
        content_type: params.content_type,
        channel_intent: params.channel_intent,
        custom_prompt: enrichedPrompt || params.custom_prompt,
        target_audience: params.target_audience,
        listing_id: params.listing_id,
        contact_id: params.contact_id,
      },
      params.variation_count || 3
    )

    // Log each variation
    for (const content of variations) {
      const content_id = uuidv4()
      await logContentGeneration({
        agent_id: params.agent_id,
        content_output: content,
        entity_id: content_id,
      })
    }

    return {
      success: true,
      contents: variations,
      generated_count: variations.length,
      failed_count: 0,
    }
  } catch (error) {
    return handleError(error, "generateVariations")
  }
}

/**
 * Get content generation history
 */
export async function getGenerationHistory(params: {
  agent_id: string
  limit?: number
  content_type?: string
}): Promise<{
  success: boolean
  history?: Array<any>
  error?: string
}> {
  try {
    if (!isValidUUID(params.agent_id)) {
      throw new ValidationError("Invalid agent ID")
    }

    const history = await getContentGenerationHistory({
      agent_id: params.agent_id,
      limit: params.limit,
      content_type: params.content_type,
    })

    return {
      success: true,
      history,
    }
  } catch (error) {
    return handleError(error, "getGenerationHistory")
  }
}

/**
 * Get content generation stats
 */
export async function getGenerationStats(params: {
  agent_id: string
  date_range?: { start: string; end: string }
}): Promise<{
  success: boolean
  stats?: {
    total_generated: number
    by_content_type: Record<string, number>
    by_channel: Record<string, number>
    recent_generations: number
  }
  error?: string
}> {
  try {
    if (!isValidUUID(params.agent_id)) {
      throw new ValidationError("Invalid agent ID")
    }

    const stats = await getContentGenerationStats({
      agent_id: params.agent_id,
      date_range: params.date_range,
    })

    return {
      success: true,
      stats,
    }
  } catch (error) {
    return handleError(error, "getGenerationStats")
  }
}

/**
 * Generate listing description from external URL (for repurposing)
 */
export async function generateFromURL(params: {
  agent_id: string
  source_url: string
  content_type: ContentGenerationParams["content_type"]
  custom_instructions?: string
}): Promise<ContentGenerationResult> {
  try {
    if (!isValidUUID(params.agent_id)) {
      throw new ValidationError("Invalid agent ID")
    }

    const content = await generateTextContent({
      content_type: params.content_type,
      source_urls: [params.source_url],
      custom_prompt: `Repurpose content from the following source:\n${params.source_url}\n\n${params.custom_instructions || ""}`,
    })

    const content_id = uuidv4()

    await logContentGeneration({
      agent_id: params.agent_id,
      content_output: content,
      entity_id: content_id,
    })

    return {
      success: true,
      content,
      content_id,
    }
  } catch (error) {
    return handleError(error, "generateFromURL")
  }
}
