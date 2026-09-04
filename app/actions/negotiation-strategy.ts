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
import { requireContactAccess } from "@/lib/portal/require-contact-access"
import { writeNegotiationStrategy } from "@/lib/negotiation/strategy-writer"
import { isAdminOrBroker, isAgentOrTenantAdmin } from "@/lib/auth/resolve-user-role"

/**
 * ONE SPELLING OF "AGENT, OR SOMEONE WHO ADMINISTERS THEM" (§6, wave 27).
 *
 * The test below was written out here as `userType !== "agent" &&
 * !isAdminOrBroker({ user_type: userType })` — a fourth hand-written spelling of
 * the staff ladder (lane SEC3 §8.3), duplicated verbatim at
 * lib/voice/deal-decision.ts:resolveActor. Both now ask
 * lib/auth/resolve-user-role.ts:isAgentOrTenantAdmin, which DERIVES the roster
 * from TENANT_ADMIN_USER_TYPES rather than restating it.
 *
 * MEMBERSHIP IS UNCHANGED — this is a repoint, not a widening. The predicate is
 * `agent` ∪ TENANT_ADMIN_USER_TYPES, exactly what stood here. In particular it
 * is NOT the CRM contact roster (lib/auth/crm-contact-staff.ts), which also
 * admits tc / isa / compliance_officer: right for working a contact's channels,
 * wrong for authoring a negotiation strategy on a deal.
 *
 * §3 ALSO CLOSED HERE: the `users` read discarded its error. supabase-js
 * RESOLVES a refusal, so an RLS denial of the caller's own row arrived as
 * `row === null` and was answered "Brokerage not configured" — an outage
 * reported as a configuration fact, on the sentence the agent would then act on.
 */
async function requireAgentOrAdmin(): Promise<
  | { ok: true; userId: string; brokerageId: string; userType: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }

  const { data: row, error: rowError } = await supabase
    .from("users")
    .select("brokerage_id, user_type")
    .eq("id", user.id)
    .maybeSingle()
  if (rowError) return { ok: false, error: "Access check failed" }
  if (!row?.brokerage_id) return { ok: false, error: "Brokerage not configured" }

  const userType = (row.user_type as string | null) ?? ""
  if (!isAgentOrTenantAdmin({ user_type: userType })) {
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

  // Tenant check: confirm the offer is in the caller's brokerage before
  // delegating to the service-role writer.
  const svc = createServiceClient()
  const { data: offer } = await svc
    .from("offers")
    .select("brokerage_id")
    .eq("id", offerId)
    .maybeSingle()
  if (!offer) return { ok: false, error: "Offer not found" }
  if (offer.brokerage_id !== auth.brokerageId) {
    return { ok: false, error: "Forbidden: offer outside your brokerage" }
  }

  const result = await writeNegotiationStrategy(offerId, side)
  if (!result.ok) return { ok: false, error: result.error ?? "Generation failed" }

  revalidatePath("/dashboard/agent")
  return { ok: true, strategyId: result.strategyId! }
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
  if (strat.agent_user_id && strat.agent_user_id !== auth.userId && !isAdminOrBroker({ user_type: auth.userType })) {
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
// TOMBSTONE (orphan tranche 3): recordStrategyOutcomeAction deleted — a manual
// per-strategyId variant of outcome recording that no surface ever called. The
// live survivor is lib/negotiation/auto-trigger.ts:recordOutcomeForOfferSafe,
// wired from lib/kernel/offers.ts on the offer lifecycle itself, which writes
// the IDENTICAL update (status 'outcome_recorded' + outcome +
// outcome_recorded_at) at the moment the offer actually resolves — no agent
// data entry required. lib/strategy-learning/close-strategy-loop.ts closes the
// remaining open strategies at transaction close. Nothing is lost: every
// outcome vocabulary member this action accepted is produced by those two
// automated writers.

// ─── Fetch (UI) ─────────────────────────────────────────────────────────────

/**
 * CURATED rationale_signals — never the raw JSON blob. rationale_signals is
 * written by two hands: the AI drafter (copilot-ai.ts SYSTEM_PROMPT schema:
 * list_price / dom / current_offer / prior_rounds_count / peer_pattern_keys /
 * agent_track_record / key_risks) and dismissStrategyAction ({dismiss_reason}).
 * The agent-facing card renders only the named fields below — a raw dump would
 * couple the UI to whatever a future writer stuffs in, and §5 (commission off
 * agent-facing display) means an unaudited passthrough is the wrong shape even
 * though today's schema carries prices, never commission.
 */
export interface StrategyRationale {
  keyRisks:         string[]
  peerPatternKeys:  string[]
  agentTrackRecord: string | null
  priorRoundsCount: number | null
  /** Written by dismissStrategyAction when the agent said why they passed. */
  dismissReason:    string | null
}

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
  /** 'ai' from the generator; attribution for "who wrote this strategy". */
  generatedBy:              string | null
  /** How and when the agent dispositioned it (did_now / did_already / let_ai_do_it / dismissed). */
  agentDisposition:         string | null
  agentDispositionAt:       string | null
  /** Set by the automated outcome recorders when the offer actually resolved. */
  outcome:                  string | null
  outcomeRecordedAt:        string | null
  rationale:                StrategyRationale | null
}

// Shared agent-facing select — the typed provenance/disposition/outcome columns
// were written (strategy-writer.ts, accept/dismiss actions, the auto outcome
// recorder) and read by nobody until orphan tranche X4 (2026-09-01).
const AGENT_STRATEGY_SELECT =
  "id, offer_id, side, status, recommended_action, recommended_counter_price, win_probability, confidence, agent_strategy_md, customer_explanation_md, drafted_counter_language, created_at, generated_by, agent_disposition, agent_disposition_at, outcome, outcome_recorded_at, rationale_signals"

function curateRationale(raw: unknown): StrategyRationale | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const strList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "").slice(0, 6) : []
  const out: StrategyRationale = {
    keyRisks:         strList(r.key_risks),
    peerPatternKeys:  strList(r.peer_pattern_keys),
    agentTrackRecord: typeof r.agent_track_record === "string" && r.agent_track_record.trim() ? r.agent_track_record : null,
    priorRoundsCount: typeof r.prior_rounds_count === "number" && Number.isFinite(r.prior_rounds_count) ? r.prior_rounds_count : null,
    dismissReason:    typeof r.dismiss_reason === "string" && r.dismiss_reason.trim() ? r.dismiss_reason : null,
  }
  const empty = out.keyRisks.length === 0 && out.peerPatternKeys.length === 0
    && out.agentTrackRecord == null && out.priorRoundsCount == null && out.dismissReason == null
  return empty ? null : out
}

function toAgentStrategyView(r: Record<string, unknown>): NegotiationStrategyView {
  return {
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
    generatedBy:             (r.generated_by as string | null) ?? null,
    agentDisposition:        (r.agent_disposition as string | null) ?? null,
    agentDispositionAt:      (r.agent_disposition_at as string | null) ?? null,
    outcome:                 (r.outcome as string | null) ?? null,
    outcomeRecordedAt:       (r.outcome_recorded_at as string | null) ?? null,
    rationale:               curateRationale(r.rationale_signals),
  }
}

export async function getNegotiationStrategyForOfferAction(
  offerId: string,
  side?:   "buyer" | "seller",
): Promise<{ ok: true; strategy: NegotiationStrategyView | null } | { ok: false; error: string }> {
  // ── THE ROLE TEST THAT WAS MISSING (wave 26 lane SEC3 §8.2, closed here) ────
  //
  // This had the identical shape to the twelve sites SEC3 fixed — session user,
  // `users.brokerage_id`, the target's brokerage_id, and admission on EQUALITY
  // ALONE — and it was outside that census only because it is keyed on an OFFER
  // rather than a contact. `users.user_type` can hold `contact` and `vendor` on
  // rows that carry a brokerage_id, so either seat could name
  // ANY offer id in the tenant and read back the AGENT-side negotiation playbook:
  // the counter strategy, the escalation cap, the concession matrix. Handing a
  // party's own seat the other side's walk-away number is the worst version of
  // this defect in the file. §5: those seats see only their own.
  //
  // (`lender` was a THIRD such seat when this was written and is no longer a
  // storable user_type at all — the owner's 2026-09-04 ruling made it a vendor
  // category and scripts/lender-is-not-a-user-type.sql dropped it from the
  // CHECK. Those seats are `vendor` now, so they are still in the class this
  // gate refuses; the count of spellings changed, the exposure did not.)
  //
  // The gate is this file's own `requireAgentOrAdmin` — the same one
  // generateAndPersistNegotiationStrategyAction and the disposition actions use,
  // now derived from the shared roster — because the only caller is the CRM
  // offer workspace (app/components/features/offers/negotiation-copilot-panel.tsx,
  // mounted at /crm/contacts/[contactId]/offers/[offerId]). The CUSTOMER-facing
  // mirror is a different export and keeps its portal gate:
  // getNegotiationStrategyForContactAction below.
  const auth = await requireAgentOrAdmin()
  if (!auth.ok) return { ok: false, error: auth.error }

  const supabase = await createClient()

  // Verify the offer belongs to caller's brokerage before reading strategy.
  // §3: the error is destructured and read — supabase-js RESOLVES a refusal, so
  // a denied read used to arrive as `offerRow === null` and be answered "Offer
  // not found", telling an agent a real offer does not exist.
  const { data: offerRow, error: offerError } = await supabase
    .from("offers")
    .select("brokerage_id")
    .eq("id", offerId)
    .maybeSingle()
  if (offerError) return { ok: false, error: "Access check failed" }
  if (!offerRow) return { ok: false, error: "Offer not found" }
  if (offerRow.brokerage_id !== auth.brokerageId) return { ok: false, error: "Forbidden" }

  let q = supabase
    .from("negotiation_strategies")
    .select(AGENT_STRATEGY_SELECT)
    .eq("offer_id", offerId)
    .eq("brokerage_id", auth.brokerageId)
    .order("created_at", { ascending: false })
    .limit(1)
  if (side) q = q.eq("side", side)

  const { data, error } = await q.maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true, strategy: null }

  return { ok: true, strategy: toAgentStrategyView(data as Record<string, unknown>) }
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
    .select(AGENT_STRATEGY_SELECT)
    .eq("agent_user_id", user.id)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(10)
  if (error) return { ok: false, error: error.message }

  const strategies = ((data ?? []) as Array<Record<string, unknown>>).map(toAgentStrategyView)
  return { ok: true, strategies }
}

export async function getNegotiationStrategyForContactAction(
  contactId: string,
): Promise<
  | { ok: true; strategy: NegotiationStrategyView | null }
  | { ok: false; error: string }
> {
  // ── PORTAL-FACING, SO THE PORTAL GATE IS THE RIGHT ONE (wave 26, lane SEC3) ──
  //
  // Its only caller is <NegotiationMirrorPanel>, mounted on the customer's own
  // portal home (app/portal/[contactId]/buyer-home.tsx and seller-home.tsx). The
  // person this is for is the CONTACT, reading their own negotiation — so the
  // fix is not "staff only", it is the shared gate that answers both halves.
  //
  // What was wrong: the caller's `users.brokerage_id` was compared to the
  // contact's and admitted on EQUALITY ALONE, with no role test. `users.user_type`
  // can hold `contact`, `vendor` and `lender` on rows carrying a brokerage_id, so
  // ANY other buyer — and any vendor or lender seat — in the same brokerage could
  // read a stranger's live negotiation: recommended counter price, win
  // probability, and the drafted counter language. CLAUDE.md §5 puts those seats
  // on their OWN record only, and this is the "only their own" case: the contact
  // themselves is legitimate, everyone else in the tenant who is not staff is not.
  //
  // `isContactSelf` is allowed here BECAUSE the payload is the contact's own
  // side of their own deal. It is not a brokerage financial: commission, CDA and
  // the books are elsewhere and stay staff-only.
  //
  // It also fixes a narrowing: a buyer whose `users` row has no brokerage_id was
  // refused on their own portal page, which the layout already admits them to.
  //
  // Both `users` and `contacts` reads discarded `error` (§3 — supabase-js
  // RESOLVES a refusal, so a denied read was reported as "Unauthorized" /
  // "Contact not found"). The gate destructures both and keeps "Access check
  // failed" apart from "Forbidden".
  const gate = await requireContactAccess(contactId)
  if (!gate.ok) return { ok: false, error: gate.error }

  // The PAYLOAD read stays on the session (RLS-bound) client, so policy
  // ns_contact_self is a second bound underneath the app gate rather than being
  // replaced by it.
  const supabase = await createClient()

  // CUSTOMER-FACING (the portal mirror panel) — deliberately does NOT select the
  // internal provenance/rationale columns (generated_by, agent_disposition*,
  // outcome*, rationale_signals). The mirror shows the customer the plain-language
  // explanation only; the agent-side internals stay on the agent surfaces above.
  const { data, error } = await supabase
    .from("negotiation_strategies")
    .select("id, offer_id, side, status, recommended_action, recommended_counter_price, win_probability, confidence, agent_strategy_md, customer_explanation_md, drafted_counter_language, created_at")
    .eq("contact_id", contactId)
    .eq("brokerage_id", gate.brokerageId)
    .eq("status", "open")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!data) return { ok: true, strategy: null }
  // toAgentStrategyView degrades the unselected internal columns to null, which
  // is exactly the customer-facing shape this endpoint should return.
  return { ok: true, strategy: toAgentStrategyView(data as Record<string, unknown>) }
}
