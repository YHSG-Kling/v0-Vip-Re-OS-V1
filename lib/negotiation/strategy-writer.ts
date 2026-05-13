/**
 * Sprint 8 — Service-role strategy writer.
 *
 * Pure persistence path. No auth check — caller must enforce auth
 * (server action via requireAgentOrAdmin, cron via CRON_SECRET).
 *
 * Used by:
 *   - app/actions/negotiation-strategy.ts (after auth)
 *   - app/api/cron/negotiation-strategy-generator (after CRON_SECRET)
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { buildNegotiationContext } from "./analyzer"
import { draftNegotiationStrategy } from "./copilot-ai"

export interface WriteStrategyResult {
  ok:         boolean
  strategyId?: string
  side?:      "buyer" | "seller"
  brokerageId?: string
  error?:     string
}

/**
 * Build context, ask the AI to draft, persist, and emit the
 * 'negotiation.strategy_ready' lifecycle event.
 *
 * Idempotency: supersedes any open strategy on the same (offer_id, side)
 * before inserting.
 */
export async function writeNegotiationStrategy(
  offerId:  string,
  sideOverride?: "buyer" | "seller",
): Promise<WriteStrategyResult> {
  const svc = createServiceClient()

  const ctx = await buildNegotiationContext(svc, offerId)
  if (!ctx) return { ok: false, error: "Offer not found or not analyzable" }
  if (sideOverride) (ctx as { side: "buyer" | "seller" }).side = sideOverride

  // Supersede pre-existing open strategy for (offer_id, side)
  await svc
    .from("negotiation_strategies")
    .update({ status: "superseded", updated_at: new Date().toISOString() })
    .eq("offer_id", offerId)
    .eq("side", ctx.side)
    .eq("status", "open")

  let draft
  try {
    draft = await draftNegotiationStrategy(ctx)
  } catch (err) {
    return { ok: false, error: `AI draft failed: ${err instanceof Error ? err.message : String(err)}` }
  }

  const { data: inserted, error } = await svc
    .from("negotiation_strategies")
    .insert({
      brokerage_id:              ctx.brokerageId,
      offer_id:                  ctx.offerId,
      agent_user_id:             ctx.agentUserId,
      contact_id:                ctx.contactId,
      side:                      ctx.side,
      recommended_action:        draft.recommendedAction,
      recommended_counter_price: draft.recommendedCounterPrice,
      win_probability:           draft.winProbability,
      confidence:                draft.confidence,
      rationale_signals:         draft.rationaleSignals,
      agent_strategy_md:         draft.agentStrategyMd,
      customer_explanation_md:   draft.customerExplanationMd,
      drafted_counter_language:  draft.draftedCounterLanguage,
      generated_by:              "ai",
      status:                    "open",
    })
    .select("id")
    .maybeSingle()
  if (error || !inserted) return { ok: false, error: error?.message ?? "Insert failed" }

  // Sprint 5 portal projector picks this up to surface the customer-mirror.
  await svc.from("lifecycle_events").insert({
    event_type:   "negotiation.strategy_ready",
    entity_type:  "offer",
    entity_id:    ctx.offerId,
    brokerage_id: ctx.brokerageId,
    metadata: {
      strategy_id:        inserted.id,
      side:               ctx.side,
      recommended_action: draft.recommendedAction,
      win_probability:    draft.winProbability,
    },
    created_at: new Date().toISOString(),
  })

  return {
    ok:          true,
    strategyId:  inserted.id as string,
    side:        ctx.side,
    brokerageId: ctx.brokerageId,
  }
}
