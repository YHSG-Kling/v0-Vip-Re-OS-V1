// NOTE: The agent WEEKLY/PERFORMANCE coaching report that used to live here has been
// RETIRED. The single source of truth for agent coaching is now the outcome-based loop in
// lib/kernel/agent-coaching.ts (composeCoachingBrief → strengths/leaks/focus from REAL
// stats, delivered as a gated manager-facing brief). This module now owns ONLY the distinct
// BUYER-FACING per-stage coaching playbook feature (getBuyerCoaching).
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { createServiceClient } from "@/lib/supabase/service"

export type BuyerPersona =
  | "first_time"
  | "investor"
  | "relocating"
  | "upgrading"
  | "downsizing"
  | "analytical"
  | null

export interface BuyerCoachingContent {
  id?: string
  buyer_stage: string
  persona: string | null
  brokerage_id?: string | null
  coaching_headline: string
  coaching_body: string
  suggested_talking_points: string[]
  avoid_pitfalls: string[]
  buyer_needs_now: string
  common_objections: { objection: string; response: string }[]
  next_action_prompt: string
  estimated_stage_duration: string | null
  success_signals: string[]
  risk_signals: string[]
  ai_generated: boolean
  updated_at?: string
  generated_by?: string
}

/**
 * getBuyerCoaching
 * Priority: brokerage-specific + persona-specific > brokerage-specific + generic >
 *           system-default + persona-specific > system-default + generic
 * If no cached row found, generates via AI and caches as system default.
 */
export async function getBuyerCoaching(
  buyerStage: string,
  persona: BuyerPersona,
  brokerageId: string
): Promise<BuyerCoachingContent> {
  const supabase = createServiceClient()

  // 1. Cache lookup — priority: brokerage-specific wins, persona-specific wins
  const { data: cached } = await supabase
    .from("buyer_stage_coaching")
    .select("*")
    .eq("buyer_stage", buyerStage)
    .or(persona ? `persona.eq.${persona},persona.is.null` : `persona.is.null`)
    .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
    .order("brokerage_id", { ascending: false, nullsFirst: false })
    .order("persona", { ascending: false, nullsFirst: false })
    .limit(1)
    .single()

  if (cached) {
    // 7-day freshness check — stale rows are regenerated
    const updatedAt = cached.updated_at ? new Date(cached.updated_at).getTime() : 0
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    const isFresh = Date.now() - updatedAt < sevenDays
    if (isFresh) return cached as BuyerCoachingContent
    // STALE — regenerate INTO THE SCOPE THE STALE ROW CAME FROM.
    //
    // Until 2026-08-24 the regeneration always wrote a system-default row
    // (brokerage_id = null) while the lookup above RANKS a brokerage-scoped row
    // first. A stale BROKERAGE row therefore never got replaced: the refresh
    // landed on a different row, the stale one kept winning the next lookup, and
    // every call re-paid the model. `ai_tool_usage` is the cost ledger (CLAUDE.md
    // §5), so that loop is a wrong invoice, not just a slow page.
    return generateBuyerCoachingWithAI(buyerStage, persona, cached.brokerage_id ?? "")
  }

  // 2. No cache at all — generate ONE shared system default. Deliberately not
  //    scoped to `brokerageId`: a per-brokerage row on every first view would
  //    multiply model spend across tenants for identical generic coaching. The
  //    brokerage half of this feature is the LOOKUP predicate on line 58, which
  //    prefers a brokerage row wherever one has been authored.
  return generateBuyerCoachingWithAI(buyerStage, persona, "")
}

/**
 * `brokerageId` IS THE ROW SCOPE, not decoration — it was accepted here and read by
 * NOTHING until 2026-08-24, while both the content object and the upsert hardcoded
 * `brokerage_id: null`. Pass "" for the shared system default; pass a brokerage id to
 * refresh that brokerage's own row in place. The upsert's conflict target already
 * names `brokerage_id`, so writing the wrong scope silently created a SECOND row
 * instead of replacing the stale one.
 */
async function generateBuyerCoachingWithAI(
  buyerStage: string,
  persona: BuyerPersona,
  brokerageId: string
): Promise<BuyerCoachingContent> {
  const supabase = createServiceClient()
  const rowScope: string | null = brokerageId || null
  const personaLabel = persona ?? "standard"
  const stageLabel = buyerStage.replace(/_/g, " ").toLowerCase()

  const { text } = await generateText({
    model: resolveModel("anthropic/claude-sonnet-4-20250514"),
    system:
      "You are a real estate coaching AI. Generate coaching for a buyer's agent at a specific " +
      "stage of the buyer journey. Return JSON only with keys: " +
      "talking_points (array of 3 strings), avoid_pitfalls (array of 2 strings), " +
      "buyer_needs_now (string, 1 sentence empathy prompt).",
    prompt: `Stage: ${stageLabel}. Buyer persona: ${personaLabel}. Generate coaching for this agent.`,
  })

  type AIPayload = {
    talking_points: string[]
    avoid_pitfalls: string[]
    buyer_needs_now: string
  }

  let ai: AIPayload

  try {
    const clean = text.trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "")
    ai = JSON.parse(clean) as AIPayload
  } catch {
    ai = {
      talking_points: [
        "Confirm buyer's must-haves and deal-breakers",
        "Review recent market activity in their target areas",
        "Set expectations for the next step in their journey",
      ],
      avoid_pitfalls: [
        "Overwhelming buyers with too many options too soon",
        "Skipping the financing conversation early in the process",
      ],
      buyer_needs_now: "Your buyer needs reassurance that you understand their priorities and timeline.",
    }
  }

  // Build full content object
  const content: Omit<BuyerCoachingContent, "id" | "updated_at"> = {
    buyer_stage: buyerStage,
    persona: persona ?? null,
    brokerage_id: rowScope, // null = shared system default; else this brokerage's own row
    coaching_headline: `AI Coaching — ${stageLabel.replace(/\b\w/g, (c) => c.toUpperCase())}`,
    coaching_body: `Focus on the ${personaLabel} buyer's priorities at this stage.`,
    suggested_talking_points: ai.talking_points,
    avoid_pitfalls: ai.avoid_pitfalls,
    buyer_needs_now: ai.buyer_needs_now,
    common_objections: [],
    next_action_prompt: "Schedule a follow-up with your buyer within 24 hours.",
    estimated_stage_duration: null,
    success_signals: [],
    risk_signals: [],
    ai_generated: true,
    generated_by: "anthropic/claude-sonnet-4-20250514",
  }

  // UPSERT
  const { data: upserted, error: upsertError } = await supabase
    .from("buyer_stage_coaching")
    .upsert(
      {
        brokerage_id: rowScope,
        buyer_stage: buyerStage,
        persona: persona ?? null,
        coaching_headline: content.coaching_headline,
        coaching_body: content.coaching_body,
        suggested_talking_points: content.suggested_talking_points,
        avoid_pitfalls: content.avoid_pitfalls,
        buyer_needs_now: content.buyer_needs_now,
        common_objections: content.common_objections,
        next_action_prompt: content.next_action_prompt,
        estimated_stage_duration: content.estimated_stage_duration,
        success_signals: content.success_signals,
        risk_signals: content.risk_signals,
        ai_generated: true,
        generated_by: content.generated_by,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "buyer_stage,persona,brokerage_id" }
    )
    .select("*")
    .single()

  // supabase-js RESOLVES refusals (CLAUDE.md §3): an unread `error` here turns a
  // failed cache write into a page that looks cached and silently re-pays the model
  // on the next request.
  if (upsertError) {
    console.error("[buyer-coaching] cache upsert refused", {
      buyerStage,
      persona,
      brokerageId: rowScope,
      error: upsertError.message,
    })
  }

  return (upserted ?? content) as BuyerCoachingContent
}
