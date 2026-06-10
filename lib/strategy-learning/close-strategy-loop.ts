// lib/strategy-learning/close-strategy-loop.ts
//
// OUTCOME-CLOSING LOOP — the differentiator: the AI workforce learns from its own
// proposals. When an offer the Shopping Agent's strategy produced reaches a terminal
// state (seller accepts / rejects / counters, or the deal converts / is lost), this
// closes the loop AUTONOMOUSLY back to the recommendation that produced it:
//
//   strategy_recommendations  ──(offers.strategy_recommendation_id, m213)──▶  offer
//          │                                                                    │
//          ▼  on terminal state                                                ▼
//   strategy_outcomes  ◀── deviation_from_recommendation, final_price ── this closer
//   negotiation_strategies.outcome  ◀── the counter-strategy result ──┘
//
// Idempotent: a given (recommendation_id, offer_id) outcome is written once, so it is
// safe to call from multiple lifecycle handlers (acceptance fires it; conversion
// fires it again — the second call is a no-op). No model narration; pure bookkeeping
// over the tables the audit made trustworthy.
//
// NOT marked server-only (by convention, like lib/kernel/command-center.ts) so the
// strategy-learning simulator can drive it end-to-end against real rows. It only ever
// writes through a caller-supplied service client — never import into a client bundle.

import type { SupabaseClient } from "@supabase/supabase-js"

/** Terminal outcomes a strategy_outcomes row records (matches the live CHECK). */
export type StrategyOutcome = "accepted" | "rejected" | "countered" | "withdrawn"

/** negotiation_strategies.outcome vocabulary — a superset of StrategyOutcome that
 *  also covers a deal that died after acceptance (live CHECK). */
export type NegotiationOutcome = StrategyOutcome | "closed" | "lost"

/**
 * Close the negotiation_strategies loop for an offer (the counter-offer strategy).
 * Stand-alone so the post-acceptance "deal lost" path can record 'lost' — an
 * outcome strategy_outcomes can't hold. Idempotent: only an OPEN strategy is closed.
 */
export async function closeNegotiationStrategyForOffer(
  supabase: SupabaseClient,
  params: { offerId: string; brokerageId: string; outcome: NegotiationOutcome },
): Promise<boolean> {
  const { data: negStrat } = await supabase
    .from("negotiation_strategies")
    .select("id")
    .eq("offer_id", params.offerId)
    .eq("brokerage_id", params.brokerageId)
    .is("outcome", null)
    .in("status", ["open", "accepted_by_agent"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!negStrat) return false

  const { error } = await supabase
    .from("negotiation_strategies")
    .update({
      status:              "outcome_recorded",
      outcome:             params.outcome,
      outcome_recorded_at: new Date().toISOString(),
      updated_at:          new Date().toISOString(),
    })
    .eq("id", negStrat.id)
  return !error
}

/** strategy_recommendations.status terminal mapping (live CHECK: pending|accepted|modified|rejected). */
function recommendationStatusFor(outcome: StrategyOutcome): "accepted" | "modified" | "rejected" {
  switch (outcome) {
    case "accepted":  return "accepted"
    case "countered": return "modified"   // the recommendation was reshaped by negotiation
    case "rejected":
    case "withdrawn": return "rejected"
  }
}

export interface CloseStrategyLoopParams {
  offerId:     string
  brokerageId: string
  outcome:     StrategyOutcome
  /** Actual settled/seller-response price; defaults to the offer's own price. */
  finalPrice?: number | null
  /** Optional human/system note carried onto the outcome row. */
  notes?:      string
}

export interface CloseStrategyLoopResult {
  recommendationClosed: boolean
  negotiationClosed:    boolean
  /** Set when nothing was linked (no recommendation + no open negotiation strategy). */
  noop?:                boolean
}

/**
 * Close the learning loop for an offer's terminal state. Safe to call repeatedly
 * (idempotent per recommendation+offer, and per open negotiation strategy).
 */
export async function closeStrategyLoopForOffer(
  supabase: SupabaseClient,
  params: CloseStrategyLoopParams,
): Promise<CloseStrategyLoopResult> {
  const { offerId, brokerageId, outcome } = params

  const { data: offer } = await supabase
    .from("offers")
    .select("id, brokerage_id, offer_price, strategy_recommendation_id")
    .eq("id", offerId)
    .maybeSingle()

  if (!offer || offer.brokerage_id !== brokerageId) {
    return { recommendationClosed: false, negotiationClosed: false, noop: true }
  }

  const finalPrice = params.finalPrice ?? (offer.offer_price as number | null) ?? null
  let recommendationClosed = false
  let negotiationClosed = false

  // 1) Close the strategy_recommendations loop (the offer-strategy that produced it).
  const recId = offer.strategy_recommendation_id as string | null
  if (recId) {
    // Idempotency: only one outcome row per (recommendation, offer).
    const { data: existing } = await supabase
      .from("strategy_outcomes")
      .select("id")
      .eq("recommendation_id", recId)
      .eq("offer_id", offerId)
      .maybeSingle()

    if (!existing) {
      const { data: rec } = await supabase
        .from("strategy_recommendations")
        .select("recommended_price")
        .eq("id", recId)
        .maybeSingle()

      const deviation = rec?.recommended_price != null && finalPrice != null
        ? Math.abs(finalPrice - Number(rec.recommended_price))
        : null

      const { error: insErr } = await supabase.from("strategy_outcomes").insert({
        brokerage_id:                  brokerageId,
        recommendation_id:             recId,
        offer_id:                      offerId,
        outcome,
        final_price:                   finalPrice,
        deviation_from_recommendation: deviation,
        notes: params.notes ?? `Auto-closed on offer ${outcome}`,
      })
      if (!insErr) {
        await supabase
          .from("strategy_recommendations")
          .update({ status: recommendationStatusFor(outcome) })
          .eq("id", recId)
        recommendationClosed = true
      }
    } else {
      recommendationClosed = true // already closed — treated as success
    }
  }

  // 2) Close the negotiation_strategies loop (the counter-offer strategy, if any is
  //    still open for this offer). Shares the stand-alone closer; the 4-value
  //    StrategyOutcome is a valid NegotiationOutcome.
  negotiationClosed = await closeNegotiationStrategyForOffer(supabase, { offerId, brokerageId, outcome })

  return {
    recommendationClosed,
    negotiationClosed,
    noop: !recommendationClosed && !negotiationClosed,
  }
}
