import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
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
  brokerage_id?: string | null
  coaching_headline: string
  coaching_body: string
  suggested_talking_points: string[]
  avoid_pitfalls: string[]             // spec: "What to Avoid" column
  seller_needs_now: string             // spec: "Seller Needs Now" column
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
    // 7-day freshness check — stale rows are regenerated
    const updatedAt  = cached.updated_at ? new Date(cached.updated_at).getTime() : 0
    const sevenDays  = 7 * 24 * 60 * 60 * 1000
    const isFresh    = Date.now() - updatedAt < sevenDays
    if (isFresh) return cached as SellerCoachingContent
    // STALE — regenerate INTO THE SCOPE THE STALE ROW CAME FROM. Same defect and
    // same fix as the buyer half at lib/intelligence/coaching-engine.ts:64 (§6 —
    // one vocabulary per function): the refresh used to always write the
    // system-default row while the lookup RANKS a brokerage row first, so a stale
    // brokerage row was never replaced and every call re-paid the model.
    return generateSellerCoachingWithAI(listingStage, persona, cached.brokerage_id ?? "")
  }

  // 2. No cache at all — generate ONE shared system default. Deliberately not
  //    scoped to `brokerageId`: a per-brokerage row on first view would multiply
  //    model spend across tenants for identical generic coaching. The brokerage
  //    half of this feature is the LOOKUP predicate above.
  return generateSellerCoachingWithAI(listingStage, persona, "")
}

/**
 * `brokerageId` IS THE ROW SCOPE — accepted here and read by NOTHING until
 * 2026-08-24, while the content object and the upsert both hardcoded
 * `brokerage_id: null`. "" = the shared system default; a brokerage id refreshes
 * that brokerage's own row in place, which is what the conflict target
 * (listing_stage, persona, brokerage_id) has always required.
 */
async function generateSellerCoachingWithAI(
  listingStage: string,
  persona: SellerPersona,
  brokerageId: string
): Promise<SellerCoachingContent> {
  const supabase    = createServiceClient()
  const rowScope: string | null = brokerageId || null
  const personaLabel = persona ?? "standard"
  const stageLabel   = listingStage.replace(/_/g, " ").toLowerCase()

  const { text } = await generateText({
    model: resolveModel("anthropic/claude-sonnet-4-20250514"),
    system:
      "You are a real estate coaching AI. Generate coaching for a listing agent at a specific " +
      "stage of the seller journey. Return JSON only with keys: " +
      "talking_points (array of 3 strings), avoid_pitfalls (array of 2 strings), " +
      "seller_needs_now (string, 1 sentence empathy prompt).",
    prompt: `Stage: ${stageLabel}. Seller persona: ${personaLabel}. Generate coaching for this agent.`,
  })

  type AIPayload = {
    talking_points:   string[]
    avoid_pitfalls:   string[]
    seller_needs_now: string
  }

  let ai: AIPayload

  try {
    const clean = text.trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "")
    ai = JSON.parse(clean) as AIPayload
  } catch {
    ai = {
      talking_points:   [
        "Confirm seller's timeline and next availability",
        "Review stage milestones and what to expect",
        "Set clear expectations for this step",
      ],
      avoid_pitfalls:   [
        "Making promises about timeline you cannot guarantee",
        "Skipping the stage briefing — sellers feel lost without context",
      ],
      seller_needs_now: "Your seller needs reassurance that the process is on track and you are in control.",
    }
  }

  // Build full content object with extended fields
  const content: Omit<SellerCoachingContent, "id" | "updated_at"> = {
    listing_stage:            listingStage,
    persona:                  persona ?? null,
    brokerage_id:             rowScope,        // null = shared system default; else this brokerage's own row
    coaching_headline:        `AI Coaching — ${stageLabel.replace(/\b\w/g, c => c.toUpperCase())}`,
    coaching_body:            `Focus on the ${personaLabel} seller's priorities at this stage.`,
    suggested_talking_points: ai.talking_points,
    avoid_pitfalls:           ai.avoid_pitfalls,
    seller_needs_now:         ai.seller_needs_now,
    common_objections:        [],
    next_action_prompt:       "Schedule a follow-up with your seller within 24 hours.",
    estimated_stage_duration: null,
    success_signals:          [],
    risk_signals:             [],
    ai_generated:             true,
    generated_by:             "anthropic/claude-sonnet-4-20250514",
  }

  // UPSERT — ON CONFLICT (listing_stage, persona, brokerage_id) DO UPDATE
  const { data: upserted, error: upsertError } = await supabase
    .from("seller_stage_coaching")
    .upsert(
      {
        brokerage_id:             rowScope,
        listing_stage:            listingStage,
        persona:                  persona ?? null,
        coaching_headline:        content.coaching_headline,
        coaching_body:            content.coaching_body,
        suggested_talking_points: content.suggested_talking_points,
        avoid_pitfalls:           content.avoid_pitfalls,
        seller_needs_now:         content.seller_needs_now,
        common_objections:        content.common_objections,
        next_action_prompt:       content.next_action_prompt,
        estimated_stage_duration: content.estimated_stage_duration,
        success_signals:          content.success_signals,
        risk_signals:             content.risk_signals,
        ai_generated:             true,
        generated_by:             content.generated_by,
        updated_at:               new Date().toISOString(),
      },
      { onConflict: "listing_stage,persona,brokerage_id" }
    )
    .select("*")
    .single()

  // supabase-js RESOLVES refusals (CLAUDE.md §3): an unread `error` here turns a
  // failed cache write into a page that looks cached and re-pays the model next call.
  if (upsertError) {
    console.error("[seller-coaching] cache upsert refused", {
      listingStage,
      persona,
      brokerageId: rowScope,
      error: upsertError.message,
    })
  }

  return (upserted ?? content) as SellerCoachingContent
}
