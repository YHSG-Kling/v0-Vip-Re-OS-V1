/**
 * lib/ai-isa/brand-voice-prompt.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Loads the resolved brand voice profile for a brokerage/agent scope and
 * returns a system-prompt block suitable for injection into AI SDK generateText
 * calls. Reads brand_voice_profile directly — does NOT call applyBrandVoice
 * (that is the compliance gate's job; this is prompt construction only).
 *
 * Used by: handle-inbound-email.ts, vapi webhook post-call follow-up
 */

import { createServiceClient } from "@/lib/supabase/service"

export interface BrandVoicePromptContext {
  brokerageId: string
  agentId?: string | null
}

export interface BrandVoicePromptResult {
  /** Injected as a paragraph at the end of the base system prompt */
  systemBlock: string
  /** Raw values for use in other contexts */
  tone: string | null
  formalityLevel: string | null
  prohibitedWords: string[]
  preferredWords: string[]
  tagline: string | null
}

export async function loadBrandVoicePrompt(
  ctx: BrandVoicePromptContext
): Promise<BrandVoicePromptResult> {
  const supabase = createServiceClient()

  // 1. Brokerage-level profile (most permissive — overridden by agent below)
  const { data: brokProfile } = await supabase
    .from("brand_voice_profile")
    .select(
      "tone, formality_level, key_brand_messages, prohibited_words, preferred_words, tagline, mission_statement"
    )
    .eq("brokerage_id", ctx.brokerageId)
    .is("agent_id", null)
    .is("team_id", null)
    .maybeSingle()

  // 2. Agent-level profile (most specific — merges on top)
  let agentProfile: typeof brokProfile = null
  if (ctx.agentId) {
    const { data } = await supabase
      .from("brand_voice_profile")
      .select(
        "tone, formality_level, key_brand_messages, prohibited_words, preferred_words, tagline, mission_statement"
      )
      .eq("agent_id", ctx.agentId)
      .maybeSingle()
    agentProfile = data
  }

  // Merge: agent overrides brokerage where present, prohibited/preferred words accumulate
  const resolved = {
    tone: agentProfile?.tone ?? brokProfile?.tone ?? null,
    formalityLevel:
      agentProfile?.formality_level ?? brokProfile?.formality_level ?? null,
    keyBrandMessages: [
      ...(brokProfile?.key_brand_messages ?? []),
      ...(agentProfile?.key_brand_messages ?? []),
    ] as string[],
    prohibitedWords: [
      ...(brokProfile?.prohibited_words ?? []),
      ...(agentProfile?.prohibited_words ?? []),
    ] as string[],
    preferredWords: [
      ...(brokProfile?.preferred_words ?? []),
      ...(agentProfile?.preferred_words ?? []),
    ] as string[],
    tagline: agentProfile?.tagline ?? brokProfile?.tagline ?? null,
    missionStatement:
      agentProfile?.mission_statement ?? brokProfile?.mission_statement ?? null,
  }

  // Build the system prompt block
  const parts: string[] = []

  if (resolved.tone) {
    parts.push(`Write in a ${resolved.tone} tone.`)
  }
  if (resolved.formalityLevel) {
    parts.push(`Formality level: ${resolved.formalityLevel}.`)
  }
  if (resolved.tagline) {
    parts.push(`Brand tagline (use accurately or not at all): "${resolved.tagline}".`)
  }
  if (resolved.missionStatement) {
    parts.push(`Brand mission: "${resolved.missionStatement}".`)
  }
  if (resolved.preferredWords.length > 0) {
    parts.push(`Preferred vocabulary: ${resolved.preferredWords.join(", ")}.`)
  }
  if (resolved.prohibitedWords.length > 0) {
    parts.push(
      `NEVER use these words or phrases: ${resolved.prohibitedWords.join(", ")}.`
    )
  }
  if (resolved.keyBrandMessages.length > 0) {
    parts.push(
      `Reinforce these brand messages where natural: ${resolved.keyBrandMessages.join(" | ")}.`
    )
  }

  return {
    systemBlock: parts.length > 0 ? parts.join(" ") : "",
    tone: resolved.tone,
    formalityLevel: resolved.formalityLevel,
    prohibitedWords: resolved.prohibitedWords,
    preferredWords: resolved.preferredWords,
    tagline: resolved.tagline,
  }
}
