"use server"

import { createClient } from "@/lib/supabase/server"
import { generateAIResponse } from "@/lib/ai/models"
import { evaluateOutbound } from "@/lib/kernel/compliance"
import { isValidUUID } from "@/lib/validations"

export interface GenerateVideoScriptParams {
  brokerageId: string
  agentId: string
  userId: string
  /** What the video is about — free-text brief from the user */
  description: string
  /** Canonical video type */
  videoType:
    | "property_tour"
    | "market_update"
    | "agent_intro"
    | "listing_presentation"
    | "buyer_education"
    | "seller_update"
    | "testimonial"
    | "tips"
    | "custom"
  /** Delivery tone */
  tone: "professional" | "friendly" | "luxury" | "educational"
  /** Target duration in seconds — controls word-count target */
  targetDurationSeconds?: number
  /** Optional listing context pre-fill */
  listingContext?: {
    address: string
    city: string
    state: string
    listPrice: number
    bedrooms?: number
    bathrooms?: number
    sqft?: number
    features?: string[]
  }
  /** Optional brand voice tone from ai_identity_profiles */
  brandVoiceTone?: string
  saveToLibrary?: boolean
}

export interface GenerateVideoScriptResult {
  success: boolean
  script?: string
  wordCount?: number
  estimatedDurationSeconds?: number
  savedScriptId?: string
  error?: string
  complianceBlocked?: boolean
}

const TONE_INSTRUCTIONS: Record<string, string> = {
  professional: "Use a polished, authoritative tone. Speak with confidence and expertise. Avoid slang.",
  friendly:
    "Use a warm, conversational tone. Speak as if talking to a friend. Be approachable and genuine.",
  luxury:
    "Use elevated, aspirational language. Evoke exclusivity and lifestyle. Focus on the experience, not just facts.",
  educational:
    "Use a clear, informative tone. Explain concepts simply. Use structure (numbered points where helpful).",
}

const TYPE_SYSTEM_CONTEXT: Record<string, string> = {
  property_tour:
    "You are writing a property walkthrough narration for a real estate agent's avatar video. Focus on features, flow, and lifestyle benefits. Use vivid but accurate descriptions.",
  market_update:
    "You are writing a local market update script. Present stats and trends conversationally. Give buyers and sellers actionable takeaways.",
  agent_intro:
    "You are writing a personal brand introduction for a real estate agent. Build trust, highlight unique value, and end with a clear call to action.",
  listing_presentation:
    "You are writing a listing appointment presentation script. Focus on the agent's marketing plan, expertise, and why sellers should choose them.",
  buyer_education:
    "You are writing a buyer education video. Explain the home buying process in simple steps. Reduce anxiety and build confidence.",
  seller_update:
    "You are writing a seller update video. Give the homeowner a warm, transparent update on their listing's activity and market position.",
  testimonial:
    "You are writing a client testimonial highlight script for a real estate agent. Emphasize authentic outcomes and emotional results.",
  tips:
    "You are writing a quick tips video for a real estate agent's social media. Give 3-5 concrete, actionable tips. Keep it energetic and shareable.",
  custom:
    "You are writing a real estate video script for an agent. Follow the provided description closely.",
}

function targetWordCount(durationSeconds: number): number {
  // 150 words ≈ 60 seconds (2.5 words/second speaking pace)
  return Math.round((durationSeconds / 60) * 150)
}

export async function generateVideoScript(
  params: GenerateVideoScriptParams
): Promise<GenerateVideoScriptResult> {
  if (!isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid brokerage ID" }
  }
  if (!params.description?.trim()) {
    return { success: false, error: "Description is required" }
  }

  const supabase = await createClient()
  const duration = params.targetDurationSeconds ?? 60
  const wordTarget = targetWordCount(duration)

  // ── Build listing context block ──────────────────────────────────────────────
  let listingBlock = ""
  if (params.listingContext) {
    const l = params.listingContext
    listingBlock = `
Listing context:
- Address: ${l.address}, ${l.city}, ${l.state}
- List price: $${l.listPrice.toLocaleString()}
${l.bedrooms ? `- Bedrooms: ${l.bedrooms}` : ""}
${l.bathrooms ? `- Bathrooms: ${l.bathrooms}` : ""}
${l.sqft ? `- Square feet: ${l.sqft.toLocaleString()}` : ""}
${l.features?.length ? `- Key features: ${l.features.join(", ")}` : ""}
`
  }

  // ── Brand voice context ──────────────────────────────────────────────────────
  let brandVoiceBlock = ""
  if (params.brandVoiceTone) {
    brandVoiceBlock = `\nBrand voice tone: ${params.brandVoiceTone}`
  } else {
    // Try to load from brand_voice_profile
    const { data: bvp } = await supabase
      .from("brand_voice_profile")
      .select("tone, formality_level, key_brand_messages, preferred_words, prohibited_words")
      .eq("brokerage_id", params.brokerageId)
      .eq("is_active", true)
      .maybeSingle()

    if (bvp) {
      brandVoiceBlock = `
Brand voice guidelines:
- Tone: ${bvp.tone ?? "professional"}
- Formality: ${bvp.formality_level ?? "moderate"}
${bvp.key_brand_messages?.length ? `- Key messages: ${bvp.key_brand_messages.join("; ")}` : ""}
${bvp.preferred_words?.length ? `- Preferred words: ${bvp.preferred_words.join(", ")}` : ""}
${bvp.prohibited_words?.length ? `- NEVER use: ${bvp.prohibited_words.join(", ")}` : ""}
`
    }
  }

  // ── Compliance pre-check on description ─────────────────────────────────────
  try {
    const complianceResult = await evaluateOutbound({
      actorContext: {
        userId: params.userId,
        role: "agent",
        brokerageId: params.brokerageId,
      },
      journeyType: "buyer",
      persona: "first_time_buyer",
      messageType: "video_script",
      content: params.description,
      contact: {
        id: "broadcast",
        first_name: "Broadcast",
        last_name: "Audience",
        contact_type: "buyer",
        tcpa_consent: true,
        isa_reengage_allowed: false,
        dnc_status: false,
      },
    })
    if (!complianceResult.allowed) {
      return {
        success: false,
        complianceBlocked: true,
        error: `Script description failed compliance: ${complianceResult.violations?.[0] ?? "Content policy violation"}`,
      }
    }
  } catch {
    // Compliance check failure is non-blocking for script generation
  }

  // ── Claude script generation ─────────────────────────────────────────────────
  const systemPrompt = [
    TYPE_SYSTEM_CONTEXT[params.videoType] ?? TYPE_SYSTEM_CONTEXT.custom,
    TONE_INSTRUCTIONS[params.tone] ?? TONE_INSTRUCTIONS.professional,
    brandVoiceBlock,
    `Write ONLY the script content — no stage directions, no [pause] markers, no speaker labels.`,
    `Target approximately ${wordTarget} words (for a ${duration}-second video at a natural speaking pace).`,
    `Do NOT include any greeting before the script or explanation after it. Output the script only.`,
    `Comply with Fair Housing laws — never reference race, religion, national origin, sex, disability, or familial status.`,
  ]
    .filter(Boolean)
    .join("\n\n")

  const userPrompt = [
    `Video brief: ${params.description.trim()}`,
    listingBlock,
    `Video type: ${params.videoType.replace(/_/g, " ")}`,
    `Tone: ${params.tone}`,
    `Target duration: ${duration} seconds (~${wordTarget} words)`,
  ]
    .filter(Boolean)
    .join("\n")

  let script: string
  try {
    const { text } = await generateAIResponse({
      // Feature key maps to video_script_generation → claude-sonnet in AI_TASK_ROUTING.
      // resolveAIModel inside generateAIResponse applies brokerage tier caps automatically.
      model: "claude-sonnet",
      system: systemPrompt,
      prompt: userPrompt,
      maxTokens: 1024,
      temperature: 0.7,
      metadata: {
        feature: "video_script_generation",
        userId: params.userId,
        agentId: params.agentId,
        brokerageId: params.brokerageId,
      },
    })
    script = text.trim()
  } catch (err: any) {
    return { success: false, error: `AI generation failed: ${err.message}` }
  }

  // ── Post-generation compliance check on script ───────────────────────────────
  try {
    const postCheck = await evaluateOutbound({
      actorContext: {
        userId: params.userId,
        role: "agent",
        brokerageId: params.brokerageId,
      },
      journeyType: "buyer",
      persona: "first_time_buyer",
      messageType: "video_script",
      content: script,
      contact: {
        id: "broadcast",
        first_name: "Broadcast",
        last_name: "Audience",
        contact_type: "buyer",
        tcpa_consent: true,
        isa_reengage_allowed: false,
        dnc_status: false,
      },
    })
    if (!postCheck.allowed) {
      return {
        success: false,
        complianceBlocked: true,
        error: `Generated script failed compliance gate: ${postCheck.violations?.[0] ?? "Content policy violation"}. Please revise your description.`,
      }
    }
  } catch {
    // non-blocking
  }

  const words = script.split(/\s+/).filter(Boolean)
  const wordCount = words.length
  const estimatedDurationSeconds = Math.round((wordCount / 150) * 60)

  // ── Optionally save to video_scripts_library ─────────────────────────────────
  let savedScriptId: string | undefined
  if (params.saveToLibrary) {
    const { data: saved } = await supabase
      .from("video_scripts_library")
      .insert({
        brokerage_id: params.brokerageId,
        agent_id: params.agentId,
        script_type: params.videoType,
        title: `AI Script — ${params.videoType.replace(/_/g, " ")} — ${new Date().toLocaleDateString()}`,
        script_content: script,
        duration_target_seconds: estimatedDurationSeconds,
        brand_voice_tone: params.tone,
        ai_generated: true,
        approval_status: "draft",
        is_active: true,
        created_by: params.userId,
      })
      .select("id")
      .maybeSingle()

    savedScriptId = saved?.id
  }

  // Note: generateAIResponse already writes to ai_usage_logs via logAIUsage internally.
  // No separate insert needed here.

  return {
    success: true,
    script,
    wordCount,
    estimatedDurationSeconds,
    savedScriptId,
  }
}
