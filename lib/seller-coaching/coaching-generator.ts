import { generateText } from "ai"
import { createServiceClient } from "@/lib/supabase/service"

export type SellerPersona =
  | "motivated"
  | "skeptical"
  | "emotional"
  | "investor"
  | "indecisive"
  | "analytical"
  | null

export interface SellerCoachingContent {
  id?: string
  listing_stage: string
  persona: string | null
  coaching_headline: string
  coaching_body: string
  suggested_talking_points: string[]
  common_objections: { objection: string; response: string }[]
  next_action_prompt: string
  estimated_stage_duration: string | null
  success_signals: string[]
  risk_signals: string[]
  ai_generated: boolean
}

/**
 * getSellerCoaching
 * Priority: brokerage-specific + persona-specific > brokerage-specific + generic >
 *           system-default + persona-specific > system-default + generic
 * If no cached row found, generates via AI and caches as system default.
 */
export async function getSellerCoaching(
  listingStage: string,
  persona: SellerPersona,
  brokerageId: string
): Promise<SellerCoachingContent> {
  const supabase = createServiceClient()

  // 1. Cache lookup — priority: brokerage-specific wins, persona-specific wins
  const { data: cached } = await supabase
    .from("seller_stage_coaching")
    .select("*")
    .eq("listing_stage", listingStage)
    .or(
      persona
        ? `persona.eq.${persona},persona.is.null`
        : `persona.is.null`
    )
    .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
    .order("brokerage_id", { ascending: false, nullsFirst: false })
    .order("persona", { ascending: false, nullsFirst: false })
    .limit(1)
    .single()

  if (cached) {
    return cached as SellerCoachingContent
  }

  // 2. No cache — generate with AI
  return generateSellerCoachingWithAI(listingStage, persona)
}

async function generateSellerCoachingWithAI(
  listingStage: string,
  persona: SellerPersona
): Promise<SellerCoachingContent> {
  const supabase = createServiceClient()

  const personaLabel = persona ?? "standard"
  const stageLabel   = listingStage.replace(/_/g, " ").toLowerCase()

  const { text } = await generateText({
    model: "anthropic/claude-opus-4.6",
    system:
      "You are an expert real estate coaching assistant. " +
      "Generate concise, actionable coaching content for real estate agents. " +
      "Respond ONLY with valid JSON — no markdown fences, no explanation.",
    prompt:
      `Generate coaching content for a real estate agent working with a ` +
      `${personaLabel} seller at the ${stageLabel} stage. ` +
      `Return ONLY valid JSON matching this schema exactly:\n` +
      `{\n` +
      `  "coaching_headline": "string (max 60 chars)",\n` +
      `  "coaching_body": "string (2-3 sentences, what agent should focus on)",\n` +
      `  "suggested_talking_points": ["string","string","string","string"],\n` +
      `  "common_objections": [\n` +
      `    {"objection":"string","response":"string"},\n` +
      `    {"objection":"string","response":"string"}\n` +
      `  ],\n` +
      `  "next_action_prompt": "string (one clear action for agent)",\n` +
      `  "estimated_stage_duration": "string (e.g. '3-7 days')",\n` +
      `  "success_signals": ["string","string","string"],\n` +
      `  "risk_signals": ["string","string"]\n` +
      `}`,
  })

  let parsed: Omit<SellerCoachingContent, "id" | "listing_stage" | "persona" | "ai_generated">

  try {
    // Strip any accidental markdown fences
    const clean = text.trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "")
    parsed = JSON.parse(clean)
  } catch {
    // Fallback content if parse fails
    parsed = {
      coaching_headline:        `Agent guidance for ${stageLabel}`,
      coaching_body:            "Review this stage's requirements with your seller and confirm next steps.",
      suggested_talking_points: ["Confirm seller's timeline", "Review stage milestones", "Address any questions", "Set clear expectations"],
      common_objections:        [
        { objection: "Is this really necessary?", response: "Each step protects your net proceeds and timeline." },
        { objection: "How long will this take?", response: "Typically a few days — I'll keep you updated daily." },
      ],
      next_action_prompt:       "Schedule a check-in call with your seller within 24 hours.",
      estimated_stage_duration: "3-7 days",
      success_signals:          ["Seller responds promptly", "Documents submitted on time", "No new objections raised"],
      risk_signals:             ["Seller stops responding", "Repeated delays in required actions"],
    }
  }

  // 3. Cache as system default (brokerage_id = null, usable by all brokerages)
  const { data: inserted } = await supabase
    .from("seller_stage_coaching")
    .insert({
      brokerage_id:             null,
      listing_stage:            listingStage,
      persona:                  persona ?? null,
      coaching_headline:        parsed.coaching_headline,
      coaching_body:            parsed.coaching_body,
      suggested_talking_points: parsed.suggested_talking_points,
      common_objections:        parsed.common_objections,
      next_action_prompt:       parsed.next_action_prompt,
      estimated_stage_duration: parsed.estimated_stage_duration,
      success_signals:          parsed.success_signals,
      risk_signals:             parsed.risk_signals,
      ai_generated:             true,
    })
    .select("*")
    .single()

  return (inserted ?? { ...parsed, listing_stage: listingStage, persona, ai_generated: true }) as SellerCoachingContent
}
