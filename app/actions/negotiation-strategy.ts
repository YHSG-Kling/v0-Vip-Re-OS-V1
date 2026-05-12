"use server"

/**
 * Sprint 8 — Negotiation Strategy persistence + customer-mirror layer.
 *
 * The existing app/actions/negotiation-copilot.ts:negotiationCoPilot() does
 * a rich in-memory analysis (counter strategy, comps, escalation cap,
 * concession matrix, drafted response) but never persists. Sprint 8 adds
 * the PERSISTENCE + CUSTOMER-MIRROR layer on top, so the same analysis
 * the agent saw can be rendered side-by-side to the customer in plain
 * language — that's the move competitors haven't made.
 *
 * Exports:
 *   generateAndPersistNegotiationStrategyAction(offerId, side?)
 *     — orchestrates: existing negotiationCoPilot for rich analysis,
 *       new buildNegotiationContext for peer-pattern + agent-track-record
 *       signals, new draftNegotiationStrategy for customer-mirror, persists
 *       to negotiation_strategies table.
 *   acceptStrategyAction(strategyId, disposition)
 *   dismissStrategyAction(strategyId, reason?)
 *   recordStrategyOutcomeAction(strategyId, outcome)
 *   getNegotiationStrategyForOfferAction(offerId, side?)
 *   listOpenNegotiationStrategiesForAgentAction()
 *
 * Composes:
 *   - Sprint 4 brokerage_intelligence_insights (peer patterns)
 *   - Sprint 5 portal_event_stream (emits lifecycle event so customer sees mirror)
 *   - Sprint 6 agent_action_queue (open strategies become queue items via composer)
 *   - Sprint 7 learning_modules (no_negotiation_copilot_use gap_tag emission
 *     on repeated dismissals — handled out-of-band by the gap-tag emitter)
 */

import { revalidatePath } from "next/cache"
import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"
import { buildNegotiationContext } from "@/lib/negotiation/analyzer"
import { draftNegotiationStrategy } from "@/lib/negotiation/copilot-ai"

const ADMIN_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

async function requireAgentOrAdmin(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const { data: row } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (!row?.brokerage_id) return { ok: false, error: "Brokerage not configured" }

  const userType = row.user_type as string
  if (userType !== "agent" && !ADMIN_ROLES.has(userType)) {
    return { ok: false, error: "Forbidden" }
  }
  return {
    ok:          true,
    userId:      user.id,
    brokerageId: row.brokerage_id as string,
    userType,
  }
}

// ─── Generate + persist ─────────────────────────────────────────────────────
export async function generateAndPersistNegotiationStrategyAction(
  offerId: string,
  side?:   "buyer" | "seller",
): Promise<{ ok: true; strategyId: string } | { ok: false; error: string }> {
  const auth = await requireAgentOrAdmin()
  if (!auth.ok) return auth

  const svc = createServiceClient()

  // Build NegotiationContext (peer patterns + agent track record +
  // inspection findings + prior rounds chain).
  const ctx = await buildNegotiationContext(svc, offerId)
  if (!ctx) return { ok: false, error: "Offer not found or not analyzable" }
  if (ctx.brokerageId !== auth.brokerageId) return { ok: false, error: "Forbidden: offer outside your brokerage" }

  if (side) (ctx as { side: "buyer" | "seller" }).side = side

  // Supersede any pre-existing open strategy for this offer+side.
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

  // Emit a lifecycle_event so the Sprint 5 portal projector can surface
  // the customer-mirror strategy alongside the offer.countered event.
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

  revalidatePath("/dashboard/agent")
  if (ctx.contactId) revalidatePath(`/portal/${ctx.contactId}`)
  return { ok: true, strategyId: inserted.id as string }
}

// ─── Accept (agent disposition) ─────────────────────────────────────────────
export async function acceptStrategyAction(
  strategyId:  string,
  disposition: "did_now" | "did_already" | "let_ai_do_it",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAgentOrAdmin()
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const { data: strat } = await svc
    .from("negotiation_strategies")
    .select("id, brokerage_id, agent_user_id, recommended_action, recommended_counter_price, offer_id")
    .eq("id", strategyId)
    .maybeSingle()
  if (!strat) return { ok: false, error: "Strategy not found" }
  if (strat.brokerage_id !== auth.brokerageId) return { ok: false, error: "Forbidden" }
  if (strat.agent_user_id && strat.agent_user_id !== auth.userId && !ADMIN_ROLES.has(auth.userType)) {
    return { ok: false, error: "Forbidden: not your strategy" }
  }

  const { error } = await svc
    .from("negotiation_strategies")
    .update({
      status:               "accepted_by_agent",
      agent_disposition:    disposition,
      agent_disposition_at: new Date().toISOString(),
      updated_at:           new Date().toISOString(),
    })
    .eq("id", strategyId)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/agent")
  return { ok: true }
}

// ─── Dismiss ────────────────────────────────────────────────────────────────
export async function dismissStrategyAction(
  strategyId: string,
  reason?:    string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAgentOrAdmin()
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const update: Record<string, unknown> = {
    status:               "dismissed",
    agent_disposition:    "dismissed",
    agent_disposition_at: new Date().toISOString(),
    updated_at:           new Date().toISOString(),
  }
  if (reason) update.rationale_signals = { dismiss_reason: reason }

  const { error } = await svc
    .from("negotiation_strategies")
    .update(update)
    .eq("id", strategyId)
    .eq("brokerage_id", auth.brokerageId)
  if (error) return { ok: false, error: error.message }

  revalidatePath("/dashboard/agent")
  return { ok: true }
}

// ─── Record outcome (learning loop) ─────────────────────────────────────────
export async function recordStrategyOutcomeAction(
  strategyId: string,
  outcome:    "accepted" | "countered" | "rejected" | "withdrawn" | "closed" | "lost",
): Promise<{ ok: true } | { ok: false; error: string }> {
  const auth = await requireAgentOrAdmin()
  if (!auth.ok) return auth

  const svc = createServiceClient()
  const { error } = await svc
    .from("negotiation_strategies")
    .update({
      status:              "outcome_recorded",
      outcome,
      outcome_recorded_at: new Date().toISOString(),
      updated_at:          new Date().toISOString(),
    })
    .eq("id", strategyId)
    .eq("brokerage_id", auth.brokerageId)
  if (error) return { ok: false, error: error.message }

  return { ok: true }
}

// ─── Fetch (UI) ─────────────────────────────────────────────────────────────
export interface NegotiationStrategyView {
  id:                       string
  offerId:                  string
  side:                     "buyer" | "seller"
  status:                   string
  recommendedAction:        string
  recommendedCounterPrice:  number | null
  winProbability:           number | null
  confidence:               number | null
  agentStrategyMd:          string
  customerExplanationMd:    string | null
  draftedCounterLanguage:   string | null
  createdAt:                string
}

export async function getNegotiationStrategyForOfferAction(
  offerId: string,
  side?:   "buyer" | "seller",
): Promise<{ ok: true; strategy: NegotiationStrategyView | null } | { ok: false; error: string }> {
  const supabase = await createClient()
  let q = supabase
    .from("negotiation_strategies")
    .select("id, offer_id, side, status, recommended_action, recommended_counter_price, win_probability, confidence, agent_strategy_md, customer_explanation_md, drafted_counter_language, created_at")
    .eq("offer_id", offerId)
    .order("created_at", { ascending: false })
    .limit(1)
  if (side) q = q.eq("side", side)

  const { data, error } = await q.maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true, strategy: null }

  const r = data as Record<string, unknown>
  return {
    ok: true,
    strategy: {
      id:                      r.id as string,
      offerId:                 r.offer_id as string,
      side:                    r.side as "buyer" | "seller",
      status:                  r.status as string,
      recommendedAction:       r.recommended_action as string,
      recommendedCounterPrice: (r.recommended_counter_price as number | null) ?? null,
      winProbability:          (r.win_probability as number | null) ?? null,
      confidence:              (r.confidence as number | null) ?? null,
      agentStrategyMd:         r.agent_strategy_md as string,
      customerExplanationMd:   (r.customer_explanation_md as string | null) ?? null,
      draftedCounterLanguage:  (r.drafted_counter_language as string | null) ?? null,
      createdAt:               r.created_at as string,
    },
  }
}

export async function listOpenNegotiationStrategiesForAgentAction(): Promise<
  | { ok: true; strategies: NegotiationStrategyView[] }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const { data, error } = await supabase
    .from("negotiation_strategies")
    .select("id, offer_id, side, status, recommended_action, recommended_counter_price, win_probability, confidence, agent_strategy_md, customer_explanation_md, drafted_counter_language, created_at")
    .eq("agent_user_id", user.id)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(10)
  if (error) return { ok: false, error: error.message }

  const strategies = ((data ?? []) as Array<Record<string, unknown>>).map(r => ({
    id:                      r.id as string,
    offerId:                 r.offer_id as string,
    side:                    r.side as "buyer" | "seller",
    status:                  r.status as string,
    recommendedAction:       r.recommended_action as string,
    recommendedCounterPrice: (r.recommended_counter_price as number | null) ?? null,
    winProbability:          (r.win_probability as number | null) ?? null,
    confidence:              (r.confidence as number | null) ?? null,
    agentStrategyMd:         r.agent_strategy_md as string,
    customerExplanationMd:   (r.customer_explanation_md as string | null) ?? null,
    draftedCounterLanguage:  (r.drafted_counter_language as string | null) ?? null,
    createdAt:               r.created_at as string,
  }))
  return { ok: true, strategies }
}

export async function getNegotiationStrategyForContactAction(
  contactId: string,
): Promise<
  | { ok: true; strategy: NegotiationStrategyView | null }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from("negotiation_strategies")
    .select("id, offer_id, side, status, recommended_action, recommended_counter_price, win_probability, confidence, agent_strategy_md, customer_explanation_md, drafted_counter_language, created_at")
    .eq("contact_id", contactId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true, strategy: null }
  const r = data as Record<string, unknown>
  return {
    ok: true,
    strategy: {
      id:                      r.id as string,
      offerId:                 r.offer_id as string,
      side:                    r.side as "buyer" | "seller",
      status:                  r.status as string,
      recommendedAction:       r.recommended_action as string,
      recommendedCounterPrice: (r.recommended_counter_price as number | null) ?? null,
      winProbability:          (r.win_probability as number | null) ?? null,
      confidence:              (r.confidence as number | null) ?? null,
      agentStrategyMd:         r.agent_strategy_md as string,
      customerExplanationMd:   (r.customer_explanation_md as string | null) ?? null,
      draftedCounterLanguage:  (r.drafted_counter_language as string | null) ?? null,
      createdAt:               r.created_at as string,
    },
  }
}
