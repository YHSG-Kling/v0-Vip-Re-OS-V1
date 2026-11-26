// NOTE: The agent WEEKLY/PERFORMANCE coaching report that used to live here has been
// RETIRED. The single source of truth for agent coaching is now the outcome-based loop in
// lib/kernel/agent-coaching.ts (composeCoachingBrief → strengths/leaks/focus from REAL
// stats, delivered as a gated manager-facing brief). This module now owns ONLY the distinct
// BUYER-FACING per-stage coaching playbook feature (getBuyerCoaching).
// ROUTED, was raw — see lib/ai/models.ts:buyer_stage_coaching, pinned to
// claude-sonnet, the model this call site already passed. Only the ledger changes.
import { generateTextRouted } from "@/lib/ai/models"
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
// THE ONE getBuyerCoaching (wave 100, lane 100C — 99B open item, CLAUDE.md §1.1). There were two:
// this one and app/actions/buyer-coaching.ts's own cache-then-generate copy over the SAME table. This
// is the survivor (freshness window, scope-correct upsert, booked through generateTextRouted under the
// row's scope). What the other copy had and this one lacked was merged here FIRST: the `is_active`
// filter on the lookup, `.maybeSingle()` (single() raises on zero rows), the full playbook content
// (objections, next action, stage duration, success / risk signals — the CRM card renders them), and the
// requesting user on the ledger row (`actorUserId`). The action is now the session gate in front of this.
export async function getBuyerCoaching(
  buyerStage: string,
  persona: BuyerPersona,
  brokerageId: string,
  opts?: { actorUserId?: string | null },
): Promise<BuyerCoachingContent> {
  const supabase = createServiceClient()

  // 1. Cache lookup — priority: brokerage-specific wins, persona-specific wins
  const { data: cached, error: cacheError } = await supabase
    .from("buyer_stage_coaching")
    .select("*")
    .eq("buyer_stage", buyerStage)
    .or(persona ? `persona.eq.${persona},persona.is.null` : `persona.is.null`)
    .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
    .eq("is_active", true)
    .order("brokerage_id", { ascending: false, nullsFirst: false })
    .order("persona", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle()
  // A refused cache read is not "no cache": generating on it would re-pay the model on every view (§3).
  // Fail closed on the SPEND — serve the static playbook, labelled not-AI, and log the refusal.
  if (cacheError) {
    console.error("[buyer-coaching] cache read refused — serving the static playbook, no model call:", cacheError.message)
    return staticBuyerCoaching(buyerStage, persona)
  }

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
    return generateBuyerCoachingWithAI(buyerStage, persona, cached.brokerage_id ?? "", opts?.actorUserId ?? null)
  }

  // 2. No cache at all — generate ONE shared system default. Deliberately not
  //    scoped to `brokerageId`: a per-brokerage row on every first view would
  //    multiply model spend across tenants for identical generic coaching. The
  //    brokerage half of this feature is the LOOKUP predicate above, which
  //    prefers a brokerage row wherever one has been authored.
  return generateBuyerCoachingWithAI(buyerStage, persona, "", opts?.actorUserId ?? null)
}

/**
 * `brokerageId` IS THE ROW SCOPE, not decoration — it was accepted here and read by
 * NOTHING until 2026-08-24, while both the content object and the upsert hardcoded
 * `brokerage_id: null`. Pass "" for the shared system default; pass a brokerage id to
 * refresh that brokerage's own row in place. The upsert's conflict target already
 * names `brokerage_id`, so writing the wrong scope silently created a SECOND row
 * instead of replacing the stale one.
 */
/** The static playbook (no model) — the parse fallback, and what a refused cache read serves. */
function staticBuyerCoaching(buyerStage: string, persona: BuyerPersona): BuyerCoachingContent {
  const stageLabel = buyerStage.replace(/_/g, " ").toLowerCase()
  return {
    buyer_stage: buyerStage,
    persona: persona ?? null,
    coaching_headline: `Coaching for ${stageLabel}`,
    coaching_body: "Guide your buyer through this stage with clear communication and consistent follow-up.",
    suggested_talking_points: [
      "Confirm buyer's must-haves and deal-breakers",
      "Review recent market activity in their target areas",
      "Set expectations for the next step in their journey",
    ],
    avoid_pitfalls: [
      "Overwhelming buyers with too many options too soon",
      "Skipping the financing conversation early in the process",
    ],
    buyer_needs_now: "Your buyer needs reassurance that you understand their priorities and timeline.",
    common_objections: [],
    next_action_prompt: "Schedule a follow-up with your buyer within 24 hours.",
    estimated_stage_duration: null,
    success_signals: ["Engaged in conversation", "Actively reviewing properties"],
    risk_signals: ["Unresponsive for 3+ days"],
    ai_generated: false,
  }
}

const strArray = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : null
const nonBlankText = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null)

async function generateBuyerCoachingWithAI(
  buyerStage: string,
  persona: BuyerPersona,
  brokerageId: string,
  actorUserId: string | null = null,
): Promise<BuyerCoachingContent> {
  const supabase = createServiceClient()
  const rowScope: string | null = brokerageId || null
  const personaLabel = persona ?? "standard"
  const stageLabel = buyerStage.replace(/_/g, " ").toLowerCase()

  const { text } = await generateTextRouted({
    feature: "buyer_stage_coaching",
    // The SAME scope the row is written under. "" is the shared system default —
    // a PLATFORM-level generation with no tenant to bill, which lands as
    // brokerageId null rather than being attributed to someone who did not ask
    // for it. See the report at the end of lib/ai/cost-tracking.ts:122.
    brokerageId: rowScope,
    // Who asked (merged from app/actions/buyer-coaching.ts) — attribution on the ledger row.
    ...(actorUserId ? { userId: actorUserId } : {}),
    system:
      "You are a real estate coaching AI. Generate coaching for a buyer's agent at a specific " +
      "stage of the buyer journey. Return JSON only with keys: " +
      "coaching_headline (string, max 10 words), coaching_body (string, 2-3 sentences of guidance), " +
      "talking_points (array of 3-4 strings), avoid_pitfalls (array of 2 strings), " +
      "buyer_needs_now (string, 1 sentence empathy prompt), " +
      "common_objections (array of 2 {objection, response}), next_action_prompt (string, one clear next action), " +
      "estimated_stage_duration (string, e.g. '3-7 days'), success_signals (array of 3 strings), " +
      "risk_signals (array of 2 strings).",
    prompt: `Stage: ${stageLabel}. Buyer persona: ${personaLabel}. Generate coaching for this agent.`,
  })

  const fallback = staticBuyerCoaching(buyerStage, persona)
  let ai: Record<string, unknown> = {}
  try {
    const clean = text.trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "")
    const match = clean.match(/\{[\s\S]*\}/)
    ai = JSON.parse(match ? match[0] : clean) as Record<string, unknown>
  } catch {
    ai = {}
  }
  const objections = Array.isArray(ai.common_objections)
    ? (ai.common_objections as unknown[]).filter((o): o is { objection: string; response: string } =>
        !!o && typeof o === "object" && typeof (o as any).objection === "string" && typeof (o as any).response === "string")
    : null

  // Build full content object
  const content: Omit<BuyerCoachingContent, "id" | "updated_at"> = {
    buyer_stage: buyerStage,
    persona: persona ?? null,
    brokerage_id: rowScope, // null = shared system default; else this brokerage's own row
    coaching_headline: nonBlankText(ai.coaching_headline) ?? `AI Coaching — ${stageLabel.replace(/\b\w/g, (c) => c.toUpperCase())}`,
    coaching_body: nonBlankText(ai.coaching_body) ?? `Focus on the ${personaLabel} buyer's priorities at this stage.`,
    suggested_talking_points: strArray(ai.talking_points) ?? fallback.suggested_talking_points,
    avoid_pitfalls: strArray(ai.avoid_pitfalls) ?? fallback.avoid_pitfalls,
    buyer_needs_now: nonBlankText(ai.buyer_needs_now) ?? fallback.buyer_needs_now,
    common_objections: objections ?? [],
    next_action_prompt: nonBlankText(ai.next_action_prompt) ?? fallback.next_action_prompt,
    estimated_stage_duration: nonBlankText(ai.estimated_stage_duration),
    success_signals: strArray(ai.success_signals) ?? fallback.success_signals,
    risk_signals: strArray(ai.risk_signals) ?? fallback.risk_signals,
    ai_generated: true,
    generated_by: "routed:buyer_stage_coaching",
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
        // Merged from the retired app/actions/buyer-coaching.ts insert (wave 100): the lookup filters
        // is_active, so the writer stamps it — a regenerated row is the active one.
        is_active: true,
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
