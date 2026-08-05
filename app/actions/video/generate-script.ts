"use server"

import { toLibraryScriptType } from "@/app/types/video-generation"
import { createClient } from "@/lib/supabase/server"
import { generateAIResponse } from "@/lib/ai/models"
import {
  buildComplianceSystemBlocks,
  precheckBriefForFairHousing,
  postcheckScript,
} from "@/lib/video/script-compliance"
import { isValidUUID } from "@/lib/validations"
import {
  TONE_INSTRUCTIONS,
  targetWordCount,
  estimateDurationSeconds,
  videoTypeToContactType,
  type GenerateVideoScriptParams,
  type GenerateVideoScriptResult,
} from "@/lib/video/script-structure"

function buildTypeSystemContext(): Record<string, string> {
  const currentYear = new Date().getFullYear()
  return {
    property_tour:
      "You are writing a property walkthrough narration for a real estate agent's avatar video. Focus on features, flow, and lifestyle benefits. Use vivid but accurate descriptions.",
    market_update:
      `You are writing a local market update script for ${currentYear}. Present stats and trends conversationally. Reference current ${currentYear} market conditions — interest rates, inventory, price trends. Give buyers and sellers actionable takeaways relevant to today's market.`,
    agent_intro:
    "You are writing a personal brand introduction for a real estate agent. Build trust, highlight unique value, and end with a clear call to action.",
    listing_presentation:
      "You are writing a listing appointment presentation script. Focus on the agent's marketing plan, expertise, and why sellers should choose them.",
    buyer_education:
      `You are writing a buyer education video for ${new Date().getFullYear()}. Explain the home buying process in simple steps with current context. Reduce anxiety and build confidence.`,
    seller_update:
      "You are writing a seller update video. Give the homeowner a warm, transparent update on their listing's activity and market position.",
    testimonial:
      "You are writing a client testimonial highlight script for a real estate agent. Emphasize authentic outcomes and emotional results.",
    tips:
      "You are writing a quick tips video for a real estate agent's social media. Give 3-5 concrete, actionable tips. Keep it energetic and shareable.",
    custom:
      "You are writing a real estate video script for an agent. Follow the provided description closely.",
  }
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
  const contactType = videoTypeToContactType(params.videoType)

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

  // ── Brand voice + ThemFirst + Fair Housing: proactive AI guidelines ──────────
  // Brand voice is loaded here and also re-evaluated at post-generation gate.
  // The AI system prompt injects all three proactively so generated content
  // is already compliant before the post-generation check runs.
  //
  // These three blocks used to be written out inline here, which is why the
  // wizard was the only script generator that had them. They now live in
  // lib/video/script-compliance.ts so the other three generators enforce the
  // same gate instead of shipping ungated marketing copy.
  const actor = { userId: params.userId, brokerageId: params.brokerageId }
  const journeyType = contactType === "seller" ? ("seller" as const) : ("buyer" as const)
  const complianceBlocks = await buildComplianceSystemBlocks(
    params.brokerageId,
    params.brandVoiceTone,
  )

  // ── Pre-generation compliance check: Fair Housing only on description ─────────
  // We scan the brief for Fair Housing violations only — ThemFirst and Brand Voice
  // do not apply to a user's raw description input (they apply to outbound content).
  const preCheck = await precheckBriefForFairHousing(actor, params.description, journeyType)
  if (preCheck.blocked) {
    return {
      success: false,
      complianceBlocked: true,
      error: `Description contains a Fair Housing violation: ${preCheck.reason}`,
    }
  }

  // ── Claude script generation ─────────────────────────────────────────────────
  const typeSystemContext = buildTypeSystemContext()
  const { SCRIPT_QUALITY_CHARTER } = await import("@/lib/ai/script-standards")
  const systemPrompt = [
    typeSystemContext[params.videoType] ?? typeSystemContext.custom,
    TONE_INSTRUCTIONS[params.tone] ?? TONE_INSTRUCTIONS.professional,
    ...complianceBlocks,
    SCRIPT_QUALITY_CHARTER,
    `Write ONLY the script content — no stage directions, no [pause] markers, no speaker labels.`,
    `Target approximately ${wordTarget} words (for a ${duration}-second video at a natural speaking pace).`,
    `Do NOT include any greeting before the script or explanation after it. Output the script only.`,
  ]
    .filter(Boolean)
    .join("\n\n")

  const userPrompt = [
    `Video brief: ${params.description.trim()}`,
    listingBlock,
    `Video type: ${params.videoType.replace(/_/g, " ")}`,
    `Tone: ${params.tone}`,
    `Target duration: ${duration} seconds (~${wordTarget} words)`,
    `Current date: ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" })}`,
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

  // ── Post-generation compliance check: advisory (all gates, warnings only) ────
  // AI-generated content has already followed brand voice + ThemFirst + Fair Housing
  // proactively via the system prompt. Any remaining violations are surfaced as
  // advisory warnings alongside the script — not a hard block. The UI should
  // show these with a "Regenerate" option.
  const complianceWarnings = await postcheckScript(actor, script, journeyType)

  const words = script.split(/\s+/).filter(Boolean)
  const wordCount = words.length
  const estimatedDurationSeconds = estimateDurationSeconds(wordCount)

  // ── Optionally save to video_scripts_library ─────────────────────────────────
  let savedScriptId: string | undefined
  if (params.saveToLibrary) {
    const { data: saved } = await supabase
      .from("video_scripts_library")
      .insert({
        brokerage_id: params.brokerageId,
        agent_id: params.agentId,
        // live CHECK admits only the five canonical script types — the raw
        // videoType ("listing_tour"/"custom"/…) violated it and saveToLibrary
        // silently never saved. Map through the canonical vocabulary.
        script_type: toLibraryScriptType(params.videoType),
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
    complianceWarnings: complianceWarnings?.length ? complianceWarnings : undefined,
  }
}
