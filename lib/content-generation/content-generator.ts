"use server"

import { runPipelineSimple } from "@/lib/ai"
import { contentFeatureForType } from "@/lib/ai/content-features"

// ============================================
// SYSTEM 4.1 – CONTENT GENERATION ENGINE
// Draft-only content generation (no publishing/approval/compliance)
// ============================================

/**
 * Content Output Format (Runtime Only)
 * Never persisted to database except as activity signal
 */
export interface ContentGenerationOutput {
  content_type: string
  channel_intent: string
  raw_content: string
  source_inputs: Record<string, any>
  intended_audience?: string
  suggested_usage?: string
  generated_at: string
  metadata?: {
    subject?: string
    hashtags?: string[]
    cta?: string
    word_count?: number
    character_count?: number
    estimated_read_time?: number
  }
}

/**
 * Content Generation Parameters
 */
export interface ContentGenerationParams {
  content_type: "email" | "newsletter" | "sms_script" | "direct_mail" | "blog" | "social_post" | "listing_description" | "ad_copy" | "podcast_script" | "video_script" | "audio_script" | "image_prompt"
  channel_intent?: "facebook" | "instagram" | "linkedin" | "twitter" | "tiktok" | "youtube" | "google_ads" | "meta_ads" | "email" | "sms" | "direct_mail"
  
  // Context inputs
  listing_id?: string
  contact_id?: string
  transaction_id?: string
  
  // Custom inputs
  custom_prompt?: string
  target_audience?: string
  tone?: string
  length?: "short" | "medium" | "long"
  
  // Source material (URLs for research, not ownership)
  source_urls?: string[]
  
  // Variations
  generate_variations?: number
}

/**
 * Generate TEXT content (emails, newsletters, SMS, blogs, ads, social, listings)
 */
export async function generateTextContent(params: ContentGenerationParams): Promise<ContentGenerationOutput> {
  const prompt = buildTextPrompt(params)

  const text = await runPipelineSimple(prompt, {
    // WAS: feature: `content_generation_${params.content_type}` — a SYNTHESIZED
    // string that is not a key in AI_TASK_ROUTING (lib/ai/models.ts). Every one
    // of the 8 text content_types missed the table, so selectModelForTask fell
    // through to AI_TASK_ROUTING["unspecified"] and this lane was never routed
    // by designation — only by whatever "unspecified" happened to hold. It also
    // stamped ai_tool_usage.feature with a vocabulary no cost query knows, so
    // Lane A's spend could not be counted alongside Lane B's.
    // Do not "simplify" this back to a template literal. New content_types must
    // be added to CONTENT_TYPE_FEATURE in lib/ai/content-features.ts.
    feature: contentFeatureForType(params.content_type),
  })

  const parsed = parseGeneratedText(text, params)

  return {
    content_type: params.content_type,
    channel_intent: params.channel_intent || "general",
    raw_content: parsed.body,
    source_inputs: {
      custom_prompt: params.custom_prompt,
      target_audience: params.target_audience,
      tone: params.tone,
      length: params.length,
      source_urls: params.source_urls,
    },
    intended_audience: params.target_audience,
    suggested_usage: getSuggestedUsage(params.content_type),
    generated_at: new Date().toISOString(),
    metadata: {
      subject: parsed.subject,
      hashtags: parsed.hashtags,
      cta: parsed.cta,
      word_count: parsed.body.split(/\s+/).length,
      character_count: parsed.body.length,
      estimated_read_time: Math.ceil(parsed.body.split(/\s+/).length / 200), // 200 words per minute
    },
  }
}

/**
 * Generate AUDIO scripts (podcast, short-form audio)
 */
export async function generateAudioScript(params: ContentGenerationParams & { duration_minutes?: number }): Promise<ContentGenerationOutput> {
  const prompt = buildAudioPrompt(params)

  // WAS: feature: "content_generation_audio" — not an AI_TASK_ROUTING key, so
  // this missed the table and fell through to AI_TASK_ROUTING["unspecified"].
  //
  // buildAudioPrompt ALWAYS builds a spoken podcast script, whatever
  // content_type the caller declares, so the feature must describe a spoken
  // script — otherwise ai_tool_usage would record (say) "email_generation" for
  // a call that produced a podcast. Both audio content_types resolve to
  // `video_script_generation`, the registry's spoken/AV-script route.
  const audioContentType =
    params.content_type === "podcast_script" || params.content_type === "audio_script"
      ? params.content_type
      : "audio_script"
  const text = await runPipelineSimple(prompt, {
    feature: contentFeatureForType(audioContentType),
  })

  return {
    content_type: params.content_type,
    channel_intent: "audio",
    raw_content: text,
    source_inputs: {
      duration_minutes: params.duration_minutes,
      custom_prompt: params.custom_prompt,
      target_audience: params.target_audience,
    },
    intended_audience: params.target_audience,
    suggested_usage: "Review and approve before recording",
    generated_at: new Date().toISOString(),
    metadata: {
      word_count: text.split(/\s+/).length,
      estimated_read_time: params.duration_minutes || Math.ceil(text.split(/\s+/).length / 150), // 150 words per minute spoken
    },
  }
}

/**
 * Generate VIDEO scripts (long-form, short-form, social video)
 */
export async function generateVideoScript(params: ContentGenerationParams & { video_length_seconds?: number }): Promise<ContentGenerationOutput> {
  const prompt = buildVideoPrompt(params)

  // WAS: feature: "content_generation_video" — not an AI_TASK_ROUTING key.
  //
  // This is the FIFTH guarded Fair Housing script path: it is one of the five
  // `generateVideoScript` files hard-coded in
  // scripts/video-script-compliance-guard.ts. It must be stamped with the
  // registry's designated video route, `video_script_generation`
  // ("claude-sonnet — brand voice, persona-aware, Them-First scored"), not left
  // to the catch-all. (Measured: "unspecified" currently resolves to the same
  // model, so this changes routing from ACCIDENTAL to DESIGNATED and fixes the
  // ledger key — see docs/lane-a-feature-routing-notes.md for the full table.)
  //
  // buildVideoPrompt always builds a video script, so pin the feature to the
  // video family rather than trusting a caller-declared content_type.
  const videoContentType =
    params.content_type === "video_script" ? params.content_type : "video_script"
  const text = await runPipelineSimple(prompt, {
    feature: contentFeatureForType(videoContentType),
  })

  const parsed = parseVideoScript(text)

  return {
    content_type: params.content_type,
    channel_intent: params.channel_intent || "video",
    raw_content: parsed.script,
    source_inputs: {
      video_length_seconds: params.video_length_seconds,
      custom_prompt: params.custom_prompt,
      target_audience: params.target_audience,
    },
    intended_audience: params.target_audience,
    suggested_usage: "Review script and visual directions before production",
    generated_at: new Date().toISOString(),
    metadata: {
      word_count: parsed.script.split(/\s+/).length,
      estimated_read_time: params.video_length_seconds ? Math.ceil(params.video_length_seconds / 60) : undefined,
    },
  }
}

/**
 * Generate IMAGE prompts (for external image generation tools)
 */
export async function generateImagePrompt(params: ContentGenerationParams): Promise<ContentGenerationOutput> {
  const prompt = buildImagePromptGenerator(params)

  // WAS: feature: "content_generation_image_prompt" — not an AI_TASK_ROUTING
  // key, so it missed the table and took AI_TASK_ROUTING["unspecified"].
  //
  // Keyed off the LITERAL "image_prompt" because this function hardcodes
  // `content_type: "image_prompt"` in its own output regardless of what the
  // caller passed — the feature must describe the work actually done.
  // CONTENT_TYPE_FEATURE maps it to `generate_text` on purpose: this path
  // returns a PROMPT STRING for an external image tool, it does not generate an
  // image, so routing it to an image feature would describe work it never does.
  const text = await runPipelineSimple(prompt, {
    feature: contentFeatureForType("image_prompt"),
  })

  const parsed = parseImagePrompt(text)

  return {
    content_type: "image_prompt",
    channel_intent: params.channel_intent || "visual",
    raw_content: parsed.prompt,
    source_inputs: {
      custom_prompt: params.custom_prompt,
      style: params.tone,
    },
    intended_audience: params.target_audience,
    suggested_usage: "Use with DALL-E, Midjourney, or other image generation tools",
    generated_at: new Date().toISOString(),
    metadata: {
      ...parsed.metadata,
    },
  }
}

/**
 * Generate OMNIPRESENT content (one idea → many formats)
 *
 * ROUTING: this function passes NO feature of its own. Every branch delegates to
 * generateAudioScript / generateVideoScript / generateTextContent above, which
 * now resolve their feature through contentFeatureForType(). Checked explicitly
 * — there is no fifth synthesized feature string hiding in here. Keep it that
 * way: route by delegating, never by re-synthesizing a string.
 */
export async function generateOmnipresentContent(params: {
  core_idea: string
  target_audience?: string
  listing_id?: string
  contact_id?: string
  formats: Array<"podcast" | "video" | "newsletter" | "social_post" | "blog">
}): Promise<ContentGenerationOutput[]> {
  const outputs: ContentGenerationOutput[] = []

  // Generate each format
  for (const format of params.formats) {
    let content: ContentGenerationOutput

    switch (format) {
      case "podcast":
        content = await generateAudioScript({
          content_type: "podcast_script",
          custom_prompt: params.core_idea,
          target_audience: params.target_audience,
          listing_id: params.listing_id,
          contact_id: params.contact_id,
          duration_minutes: 15,
        })
        break

      case "video":
        content = await generateVideoScript({
          content_type: "video_script",
          custom_prompt: params.core_idea,
          target_audience: params.target_audience,
          listing_id: params.listing_id,
          contact_id: params.contact_id,
          video_length_seconds: 90,
        })
        break

      case "newsletter":
        content = await generateTextContent({
          content_type: "newsletter",
          custom_prompt: params.core_idea,
          target_audience: params.target_audience,
          listing_id: params.listing_id,
          contact_id: params.contact_id,
          length: "long",
        })
        break

      case "social_post":
        content = await generateTextContent({
          content_type: "social_post",
          custom_prompt: params.core_idea,
          target_audience: params.target_audience,
          listing_id: params.listing_id,
          contact_id: params.contact_id,
          channel_intent: "instagram",
          length: "short",
        })
        break

      case "blog":
        content = await generateTextContent({
          content_type: "blog",
          custom_prompt: params.core_idea,
          target_audience: params.target_audience,
          listing_id: params.listing_id,
          contact_id: params.contact_id,
          length: "long",
        })
        break

      default:
        continue
    }

    outputs.push(content)
  }

  return outputs
}

/**
 * Generate content VARIATIONS (for A/B testing, optimization)
 *
 * ROUTING: no feature of its own — each variation goes through
 * generateTextContent, so all N variations are stamped with the same registry
 * key as a single generation of that content_type. That is intended: N
 * variations are N billable calls of the same task and must aggregate together
 * in the ai_tool_usage ledger.
 */
export async function generateContentVariations(
  baseParams: ContentGenerationParams,
  count: number = 3
): Promise<ContentGenerationOutput[]> {
  const variations: ContentGenerationOutput[] = []

  for (let i = 0; i < count; i++) {
    const content = await generateTextContent({
      ...baseParams,
      custom_prompt: `${baseParams.custom_prompt || ""}\n\nVariation ${i + 1}: Use a ${i === 0 ? "formal" : i === 1 ? "conversational" : "enthusiastic"} tone.`,
    })
    variations.push(content)
  }

  return variations
}

// ============================================
// PROMPT BUILDERS
// ============================================

function buildTextPrompt(params: ContentGenerationParams): string {
  let prompt = ""

  if (params.custom_prompt) {
    prompt += `${params.custom_prompt}\n\n`
  }

  prompt += `Generate ${params.content_type} content for real estate marketing.\n\n`

  if (params.target_audience) {
    prompt += `TARGET AUDIENCE: ${params.target_audience}\n`
  }

  if (params.tone) {
    prompt += `TONE: ${params.tone}\n`
  }

  if (params.length) {
    const lengths = { short: "100-150 words", medium: "200-400 words", long: "500-800 words" }
    prompt += `LENGTH: ${lengths[params.length]}\n`
  }

  if (params.channel_intent) {
    const channelGuidelines: Record<string, string> = {
      instagram: "Use emojis, engaging hooks, max 2200 characters. Include 10-15 hashtags.",
      facebook: "Conversational tone, 400-500 characters optimal. Focus on community benefits.",
      linkedin: "Professional tone, industry insights, max 700 characters.",
      twitter: "Concise, punchy, max 280 characters. 2-3 hashtags max.",
      tiktok: "Casual, trendy, speak to younger buyers. Include trending phrases.",
      email: "Professional subject line (max 50 chars), clear CTA, personalized opening.",
      sms: "Max 160 characters, clear and actionable.",
    }
    if (channelGuidelines[params.channel_intent]) {
      prompt += `\nCHANNEL GUIDELINES: ${channelGuidelines[params.channel_intent]}\n`
    }
  }

  if (params.source_urls && params.source_urls.length > 0) {
    prompt += `\nSOURCE MATERIAL (for inspiration, not ownership): ${params.source_urls.join(", ")}\n`
  }

  prompt += `\nIMPORTANT: Focus on the buyer/reader benefits (you, your, imagine) rather than agent promotion (I, me, my). Score should be 70%+ buyer-focused.\n`

  prompt += `\nOUTPUT FORMAT (JSON):\n`
  prompt += `{\n`
  prompt += `  "subject": "Subject line or title",\n`
  prompt += `  "body": "Main content",\n`
  prompt += `  "hashtags": ["tag1", "tag2"],\n`
  prompt += `  "cta": "Call to action"\n`
  prompt += `}\n`

  return prompt
}

function buildAudioPrompt(params: ContentGenerationParams & { duration_minutes?: number }): string {
  let prompt = `Generate a ${params.duration_minutes || 10}-minute podcast script for real estate.\n\n`

  if (params.custom_prompt) {
    prompt += `TOPIC: ${params.custom_prompt}\n\n`
  }

  if (params.target_audience) {
    prompt += `TARGET AUDIENCE: ${params.target_audience}\n`
  }

  prompt += `\nSTRUCTURE:\n`
  prompt += `- Opening hook (30 seconds)\n`
  prompt += `- Main content (${(params.duration_minutes || 10) - 2} minutes)\n`
  prompt += `- Call to action and closing (30 seconds)\n\n`

  prompt += `Write in a conversational, spoken style. Include [PAUSE] markers for dramatic effect.\n`

  return prompt
}

function buildVideoPrompt(params: ContentGenerationParams & { video_length_seconds?: number }): string {
  let prompt = `Generate a ${params.video_length_seconds || 60}-second video script with visual directions.\n\n`

  if (params.custom_prompt) {
    prompt += `CONCEPT: ${params.custom_prompt}\n\n`
  }

  if (params.target_audience) {
    prompt += `TARGET AUDIENCE: ${params.target_audience}\n`
  }

  prompt += `\nOUTPUT FORMAT:\n`
  prompt += `[SCENE 1 - 0:00-0:10]\n`
  prompt += `VISUAL: Description of what's on screen\n`
  prompt += `NARRATION: What the speaker says\n`
  prompt += `\n[SCENE 2 - 0:10-0:20]\n`
  prompt += `...\n\n`

  prompt += `Keep narration natural and conversational. Use storytelling to create emotional connection.\n`

  return prompt
}

function buildImagePromptGenerator(params: ContentGenerationParams): string {
  let prompt = `Generate a detailed image prompt for AI image generation (DALL-E, Midjourney, etc.).\n\n`

  if (params.custom_prompt) {
    prompt += `CONCEPT: ${params.custom_prompt}\n\n`
  }

  prompt += `OUTPUT FORMAT (JSON):\n`
  prompt += `{\n`
  prompt += `  "prompt": "Detailed image generation prompt",\n`
  prompt += `  "style": "photorealistic|illustration|modern|etc",\n`
  prompt += `  "caption": "Social media caption for the image",\n`
  prompt += `  "alt_text": "Accessibility description",\n`
  prompt += `  "usage": "Suggested usage context"\n`
  prompt += `}\n`

  return prompt
}

// ============================================
// PARSERS
// ============================================

function parseGeneratedText(text: string, params: ContentGenerationParams): {
  subject?: string
  body: string
  hashtags?: string[]
  cta?: string
} {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        subject: parsed.subject || "",
        body: parsed.body || text,
        hashtags: parsed.hashtags || [],
        cta: parsed.cta || "",
      }
    }
  } catch (e) {
    // Fall through to return raw text
  }

  return {
    subject: params.content_type === "email" ? "Your Subject Line" : undefined,
    body: text,
    hashtags: [],
    cta: "",
  }
}

function parseVideoScript(text: string): { script: string; scenes?: any[] } {
  return {
    script: text,
    scenes: [], // Could parse [SCENE X] markers if needed
  }
}

function parseImagePrompt(text: string): { prompt: string; metadata: any } {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0])
      return {
        prompt: parsed.prompt || text,
        metadata: {
          style: parsed.style,
          caption: parsed.caption,
          alt_text: parsed.alt_text,
          usage: parsed.usage,
        },
      }
    }
  } catch (e) {
    // Fall through
  }

  return {
    prompt: text,
    metadata: {},
  }
}

// ============================================
// HELPERS
// ============================================

function getSuggestedUsage(content_type: string): string {
  const usageMap: Record<string, string> = {
    email: "Review subject line and body, then send through email platform after approval",
    newsletter: "Add to newsletter template, review for compliance, then schedule",
    sms_script: "Review for compliance (TCPA) before sending via SMS platform",
    direct_mail: "Print and mail after design review",
    blog: "Publish to website/blog after SEO optimization and proofreading",
    social_post: "Post to social media after image/video attachment",
    listing_description: "Add to MLS listing after agent review",
    ad_copy: "Use in Google/Meta ads after compliance review",
    podcast_script: "Record audio after script rehearsal",
    video_script: "Produce video after storyboard review",
    audio_script: "Record audio segment after script review",
    image_prompt: "Generate image using AI tool, then use in marketing materials",
  }

  return usageMap[content_type] || "Review and approve before use"
}
