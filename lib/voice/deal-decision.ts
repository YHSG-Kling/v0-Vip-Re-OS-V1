// lib/voice/deal-decision.ts
//
// VOICE DEAL DECISION — the spoken "accept the offer" lands in the SAME kernel
// transition as the click, with the SAME guard the approvals queue enforces.
//
// Transition (never forked):
//   acceptOfferConditionally (lib/kernel/transactions.ts) — the canonical,
//   compliance-gated acceptance the compliance-bridge panel's "Accept Offer"
//   click calls (app/actions/compliance-bridge-actions.ts). Its own contract:
//   "offer.status is ONLY written to 'accepted' from this function"; it runs
//   the System-7.1B compliance gate, records an explicit HOLD when compliance
//   hasn't passed, and creates the transaction through the canonical bridge.
//   It is service-client based end-to-end, so it is executable from the
//   sessionless ElevenLabs tool webhook.
//
// ROUND 36 — the rest of the decision family is closed the same way:
//   rejectOffer / issueCounterOffer / withdrawOffer (lib/kernel/offers.ts) now
//   take an optional injected client (cookie client remains the default for
//   every click path), so voiceRejectOffer / voiceCounterOffer /
//   voiceWithdrawOffer below run the SAME kernel transitions with the service
//   client AFTER the same mirrored guard — no forked writes, same
//   OFFER_OS_* lifecycle events, same negotiation outcome loop.
//
// Guard (mirrors loadInboundOfferForDecision in
// lib/kernel/approval-queue-aggregator.ts — the approvals-queue "of:" lane —
// same checks, same order; that helper is module-private so the logic is
// mirrored here and pinned by scripts/voice-command-coverage-simulator.ts):
//   1. tenant     — offer.brokerage_id must equal the session's brokerage
//   2. agent scope — a plain agent may decide only their own offers
//                    (offers.agent_id is agents.id); broker / broker_admin /
//                    admin / superadmin / team_lead act brokerage-wide (the
//                    same override set as requireContactOwnership and the
//                    same agentScopeId rule as /api/approvals/approve)
//   3. inbound only — listing_id set (the offer is ON our seller listing);
//                    our buyer's offer on an outside property awaits the
//                    OTHER side, nothing to decide here
//   4. not a counter — a counter row is OUR side's and awaits the buyer
//   5. still open  — status pending/submitted (idempotence: a raced click
//                    or double-spoken command can't re-run the transition)
//
// Audit parity: the kernel command writes the same rows as the click
// (transaction_compliance_log + canonical transaction bridge). Voice origin is
// recorded by the SAME idioms every other voice action already uses — the
// agent_assistant_tool_calls row the webhook writes for every call, plus a
// manager-bus voice_action signal (lib/voice/voice-bus.ts).

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

/** Same override set as requireContactOwnership (tool-call route) and the
 *  approvals routes: these roles decide brokerage-wide; agents self-scope. */
const DECISION_OVERRIDE_ROLES = new Set(["broker", "broker_admin", "admin", "superadmin", "team_lead"])

export interface VoiceAcceptOfferInput {
  brokerageId: string
  /** users.id of the speaking staff user (agent_assistant_sessions.user_id). */
  actorUserId: string
  /** Explicit offers.id when the assistant already knows it (e.g. from get_pending_offers). */
  offerId?: string | null
  /** Free-spoken hint — buyer name or property address ("the Hendersons", "44 Birch"). */
  query?: string | null
}

export interface VoiceDealDecisionResult {
  ok: boolean
  spoken: string
  data?: Record<string, unknown>
}

interface DecisionOfferRow {
  id: string
  brokerage_id: string
  agent_id: string | null
  status: string
  listing_id: string | null
  offer_type: string | null
  offer_price: number | null
  property_address: string | null
  contact_id: string | null
}

const DECISION_COLUMNS =
  "id, brokerage_id, agent_id, status, listing_id, offer_type, offer_price, property_address, contact_id"

function spokenPrice(price: number | null): string {
  if (!price) return "an unlisted price"
  if (price >= 1_000_000) return `$${(price / 1_000_000).toFixed(1)} million`
  return `$${Math.round(price / 1000)} thousand`
}

/** Resolve the actor's user_type + agents.id (agents.id ≠ users.id). */
async function resolveActor(svc: Svc, input: VoiceAcceptOfferInput): Promise<{
  userType: string
  agentScopeId: string | null
} | { error: string }> {
  const { data: userRow } = await svc
    .from("users")
    .select("user_type, brokerage_id")
    .eq("id", input.actorUserId)
    .maybeSingle()
  if (!userRow) return { error: "Acting user not found" }
  const userType = String((userRow as { user_type?: string | null }).user_type ?? "agent")

  // Authority — same shape as tool-registry authority "agent": the acting
  // agent plus the override roles. Enforced here too (not only at the route
  // gate) because the run_team_command free-text lane reaches this backend
  // without a per-tool registry check.
  if (userType !== "agent" && !DECISION_OVERRIDE_ROLES.has(userType)) {
    return { error: "Deal decisions aren't available for your role — ask the assigned agent or your broker." }
  }

  let agentScopeId: string | null = null
  if (userType === "agent") {
    const { data: agentRow } = await svc
      .from("agents")
      .select("id")
      .eq("user_id", input.actorUserId)
      .maybeSingle()
    agentScopeId = (agentRow as { id?: string } | null)?.id ?? null
    if (!agentScopeId) {
      return { error: "No agent profile found for this account — a broker can decide this offer instead." }
    }
  }
  return { userType, agentScopeId }
}

/** Load decision-ready inbound offers (same shape the guard accepts) for name/address matching. */
async function findDecisionReadyOffers(svc: Svc, brokerageId: string): Promise<DecisionOfferRow[]> {
  const { data } = await svc
    .from("offers")
    .select(DECISION_COLUMNS)
    .eq("brokerage_id", brokerageId)
    .in("status", ["pending", "submitted"])
    .not("listing_id", "is", null)
    .order("submitted_at", { ascending: false })
    .limit(10)
  // Counters are our side's and await the buyer — never decision candidates.
  return ((data ?? []) as DecisionOfferRow[]).filter((o) => o.offer_type !== "counter")
}

async function contactNames(svc: Svc, contactIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (contactIds.length === 0) return out
  const { data } = await svc
    .from("contacts")
    .select("id, first_name, last_name")
    .in("id", contactIds)
  for (const c of (data ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
    const name = `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim()
    if (name) out.set(c.id, name)
  }
  return out
}

/**
 * Shared spoken-offer resolution — explicit id, else spoken hint, else the
 * only open candidate. Ambiguity always refuses with the numbered list (an
 * acting verb never fires on a guess). Used by ALL decision verbs so the
 * matching behavior can't drift between accept/reject/counter/withdraw.
 */
async function resolveSpokenOffer(
  svc: Svc,
  input: VoiceAcceptOfferInput,
  actor: { agentScopeId: string | null },
  finder: (svc: Svc, brokerageId: string) => Promise<DecisionOfferRow[]>,
): Promise<
  | { found: true; offer: DecisionOfferRow }
  | { found: false; refusal: VoiceDealDecisionResult }
> {
  if (input.offerId) {
    const { data } = await svc
      .from("offers")
      .select(DECISION_COLUMNS)
      .eq("id", input.offerId)
      .maybeSingle()
    const offer = (data as DecisionOfferRow | null) ?? null
    if (!offer) return { found: false, refusal: { ok: false, spoken: "I couldn't find that offer." } }
    return { found: true, offer }
  }

  const candidates = await finder(svc, input.brokerageId)
  // Agent self-scope applies to matching too — an agent only hears their own.
  const scoped = actor.agentScopeId
    ? candidates.filter((o) => !o.agent_id || o.agent_id === actor.agentScopeId)
    : candidates
  if (scoped.length === 0) {
    return { found: false, refusal: { ok: false, spoken: "There are no open offers waiting on a decision right now." } }
  }
  const names = await contactNames(svc, scoped.map((o) => o.contact_id).filter(Boolean) as string[])
  const q = (input.query ?? "").trim().toLowerCase()
  const matches = q
    ? scoped.filter((o) => {
        const addr = (o.property_address ?? "").toLowerCase()
        const buyer = (o.contact_id ? names.get(o.contact_id) ?? "" : "").toLowerCase()
        return (addr && addr.includes(q)) || (buyer && buyer.includes(q)) ||
               // loose token match ("Hendersons" vs "Henderson")
               q.split(/\s+/).every((tok) => addr.includes(tok) || buyer.includes(tok))
      })
    : scoped
  if (matches.length === 0) {
    return { found: false, refusal: { ok: false, spoken: `I don't see an open offer matching "${input.query}". Say "what offers are pending" to hear the list.` } }
  }
  if (matches.length > 1) {
    const spokenList = matches.slice(0, 3).map((o, i) => {
      const buyer = o.contact_id ? names.get(o.contact_id) ?? "a buyer" : "a buyer"
      return `${i + 1}: ${buyer} at ${spokenPrice(o.offer_price)}${o.property_address ? ` on ${o.property_address}` : ""}`
    }).join(". ")
    return {
      found: false,
      refusal: {
        ok: false,
        spoken: `There ${matches.length === 2 ? "are two" : `are ${matches.length}`} open offers that could match. ${spokenList}. Which one — give me the buyer's name or the address.`,
        data: { candidates: matches.map((o) => ({ offer_id: o.id, property_address: o.property_address, offer_price: o.offer_price })) },
      },
    }
  }
  return { found: true, offer: matches[0] }
}

/**
 * The approvals-queue decision guard, mirrored check-for-check (see module
 * header). Returns null when the offer may be decided, else the spoken refusal.
 */
export function offerDecisionGuardReason(
  offer: DecisionOfferRow,
  ctx: { brokerageId: string; agentScopeId: string | null },
): string | null {
  if (offer.brokerage_id !== ctx.brokerageId) return "That offer isn't in your brokerage."
  if (ctx.agentScopeId && offer.agent_id && offer.agent_id !== ctx.agentScopeId) {
    return "That offer belongs to a different agent — only they (or a broker) can decide it."
  }
  if (!offer.listing_id) {
    return "That's our buyer's offer on an outside property — the other side responds; there's nothing to decide here."
  }
  if (offer.offer_type === "counter") {
    return "That's our counter — it's waiting on the buyer's response, not a decision from us."
  }
  if (offer.status !== "pending" && offer.status !== "submitted") {
    return `That offer is already ${offer.status} — it's no longer awaiting a decision.`
  }
  return null
}

/**
 * Accept an inbound offer by voice — SAME kernel transition as the
 * compliance-bridge click (acceptOfferConditionally), SAME guard as the
 * approvals queue. When compliance hasn't passed, the kernel records the HOLD
 * and we speak the hold reason instead of pretending it went through.
 */
export async function voiceAcceptOffer(
  input: VoiceAcceptOfferInput,
  client?: Svc,
): Promise<VoiceDealDecisionResult> {
  const svc = client ?? createServiceClient()
  if (!input.brokerageId || !input.actorUserId) return { ok: false, spoken: "I can't tell who's asking — reopen the assistant and try again." }

  const actor = await resolveActor(svc, input)
  if ("error" in actor) return { ok: false, spoken: actor.error }

  const resolved = await resolveSpokenOffer(svc, input, actor, findDecisionReadyOffers)
  if (!resolved.found) return resolved.refusal
  const offer = resolved.offer

  // ── Guard — the approvals-queue rule set, same order ──
  const refusal = offerDecisionGuardReason(offer, { brokerageId: input.brokerageId, agentScopeId: actor.agentScopeId })
  if (refusal) return { ok: false, spoken: refusal }

  // ── SAME kernel transition as the compliance-bridge click ──
  const { acceptOfferConditionally } = await import("@/lib/kernel/transactions")
  const res = await acceptOfferConditionally({
    offerId:     offer.id,
    agentId:     input.actorUserId, // users.id — same arg idiom as acceptOfferConditionallyAction
    brokerageId: input.brokerageId,
    listingId:   offer.listing_id as string,
  })

  if (!res.success || !res.data) {
    return { ok: false, spoken: `The acceptance didn't go through: ${res.error ?? "kernel command failed"}.` }
  }

  const buyerName = offer.contact_id
    ? (await contactNames(svc, [offer.contact_id])).get(offer.contact_id) ?? "the buyer"
    : "the buyer"

  if (!res.data.accepted) {
    // Business HOLD — the compliance gate refused; the kernel already logged
    // it to transaction_compliance_log (same row the click path produces).
    return {
      ok: false,
      spoken: `I can't accept ${buyerName}'s offer yet — compliance hasn't cleared it. ${res.data.holdReason ?? "The compliance-passed event is missing."} It stays open; once compliance clears, tell me again.`,
      data: { offer_id: offer.id, accepted: false, hold_reason: res.data.holdReason ?? null },
    }
  }

  // Voice-origin receipt on the manager bus — the same idiom every acting
  // voice tool uses (create_task / log_activity / send_portal_message).
  try {
    const { surfaceVoiceActionOnBus } = await import("@/lib/voice/voice-bus")
    await surfaceVoiceActionOnBus({
      brokerageId: input.brokerageId,
      tool: "accept_offer",
      message: `Voice admin accepted ${buyerName}'s offer${offer.property_address ? ` on ${offer.property_address}` : ""} (${spokenPrice(offer.offer_price)}) — kernel acceptOfferConditionally`,
      entityType: "offer",
      entityId: offer.id,
      contactId: offer.contact_id,
      payload: { transaction_id: res.data.transactionId ?? null },
    }, svc)
  } catch { /* visibility best-effort — the transition already landed */ }

  return {
    ok: true,
    spoken: `Done — ${buyerName}'s offer at ${spokenPrice(offer.offer_price)} is accepted${offer.property_address ? ` on ${offer.property_address}` : ""}. Compliance had already passed, and the transaction is open — the deal file takes it from here.`,
    data: {
      offer_id: offer.id,
      accepted: true,
      transaction_id: res.data.transactionId ?? null,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUND 36 — the rest of the decision family. Each verb runs the SAME kernel
// transition the click path calls (lib/kernel/offers.ts, now client-param
// capable) behind the SAME mirrored guard, and surfaces the SAME voice-origin
// receipts (agent_assistant_tool_calls row via the webhook + voice_action bus
// signal here). No forked writes — the kernel command owns the offers update,
// the OFFER_OS_* lifecycle event, and the negotiation outcome loop.
// ─────────────────────────────────────────────────────────────────────────────

export interface VoiceOfferDecisionInput extends VoiceAcceptOfferInput {
  /** Spoken reason ("...because the earnest money is too low"). Lands in offers.notes. */
  reason?: string | null
}

export interface VoiceCounterOfferInput extends VoiceAcceptOfferInput {
  /** REQUIRED — the resolved counter price in dollars. The backend refuses a
   *  counter without an explicit price (an acting verb never guesses terms). */
  counterPrice?: number | null
  notes?: string | null
}

async function busReceipt(
  svc: Svc,
  input: { brokerageId: string; tool: "reject_offer" | "counter_offer" | "withdraw_offer"; message: string; offer: DecisionOfferRow; payload?: Record<string, unknown> },
): Promise<void> {
  try {
    const { surfaceVoiceActionOnBus } = await import("@/lib/voice/voice-bus")
    await surfaceVoiceActionOnBus({
      brokerageId: input.brokerageId,
      tool: input.tool,
      message: input.message,
      entityType: "offer",
      entityId: input.offer.id,
      contactId: input.offer.contact_id,
      payload: input.payload ?? {},
    }, svc)
  } catch { /* visibility best-effort — the transition already landed */ }
}

async function buyerNameFor(svc: Svc, offer: DecisionOfferRow): Promise<string> {
  return offer.contact_id
    ? (await contactNames(svc, [offer.contact_id])).get(offer.contact_id) ?? "the buyer"
    : "the buyer"
}

/**
 * Reject an inbound offer by voice — SAME kernel transition as the
 * offer-workspace click and the approvals-queue 'of:' reject cascade
 * (lib/kernel/offers.rejectOffer), SAME guard as the accept lane. The spoken
 * reason lands in offers.notes exactly like the cascade's reviewer notes.
 */
export async function voiceRejectOffer(
  input: VoiceOfferDecisionInput,
  client?: Svc,
): Promise<VoiceDealDecisionResult> {
  const svc = client ?? createServiceClient()
  if (!input.brokerageId || !input.actorUserId) return { ok: false, spoken: "I can't tell who's asking — reopen the assistant and try again." }

  const actor = await resolveActor(svc, input)
  if ("error" in actor) return { ok: false, spoken: actor.error }

  const resolved = await resolveSpokenOffer(svc, input, actor, findDecisionReadyOffers)
  if (!resolved.found) return resolved.refusal
  const offer = resolved.offer

  // ── Guard — the approvals-queue rule set, same order as accept ──
  const refusal = offerDecisionGuardReason(offer, { brokerageId: input.brokerageId, agentScopeId: actor.agentScopeId })
  if (refusal) return { ok: false, spoken: refusal }

  // ── SAME kernel transition as the click (injected service client) ──
  const { rejectOffer } = await import("@/lib/kernel/offers")
  const res = await rejectOffer({
    offerId:     offer.id,
    agentId:     input.actorUserId, // users.id — same actor idiom as the 'of:' cascade
    brokerageId: input.brokerageId,
    reason:      input.reason ?? undefined,
  }, svc)
  if (!res.success) return { ok: false, spoken: `The rejection didn't go through: ${res.error ?? "kernel command failed"}.` }

  const buyerName = await buyerNameFor(svc, offer)
  await busReceipt(svc, {
    brokerageId: input.brokerageId,
    tool: "reject_offer",
    message: `Voice admin rejected ${buyerName}'s offer${offer.property_address ? ` on ${offer.property_address}` : ""} (${spokenPrice(offer.offer_price)}) — kernel rejectOffer${input.reason ? `; reason: ${input.reason.slice(0, 80)}` : ""}`,
    offer,
    payload: { reason: input.reason ?? null },
  })

  return {
    ok: true,
    spoken: `Done — ${buyerName}'s offer at ${spokenPrice(offer.offer_price)} is rejected${offer.property_address ? ` on ${offer.property_address}` : ""}${input.reason ? `, with the reason noted` : ""}. The buyer's side sees the same status the dashboard would show.`,
    data: { offer_id: offer.id, rejected: true, reason: input.reason ?? null },
  }
}

/**
 * Counter an inbound offer by voice — SAME kernel transition as the seller
 * counter slide-over and the approvals-queue cascadeCounterOffer lane
 * (lib/kernel/offers.issueCounterOffer). Requires an explicit price — the
 * backend never invents terms; without one it asks instead of acting.
 */
export async function voiceCounterOffer(
  input: VoiceCounterOfferInput,
  client?: Svc,
): Promise<VoiceDealDecisionResult> {
  const svc = client ?? createServiceClient()
  if (!input.brokerageId || !input.actorUserId) return { ok: false, spoken: "I can't tell who's asking — reopen the assistant and try again." }

  const actor = await resolveActor(svc, input)
  if ("error" in actor) return { ok: false, spoken: actor.error }

  const counterPrice = typeof input.counterPrice === "number" && Number.isFinite(input.counterPrice) && input.counterPrice > 0
    ? input.counterPrice
    : null
  if (!counterPrice) {
    return { ok: false, spoken: "What price should the counter go out at? Say something like: counter the Hendersons' offer at 450." }
  }

  const resolved = await resolveSpokenOffer(svc, input, actor, findDecisionReadyOffers)
  if (!resolved.found) return resolved.refusal
  const offer = resolved.offer

  // ── Guard — the approvals-queue rule set (a counter is a seller DECISION on
  //    an inbound, still-open, non-counter offer — same rule set as accept) ──
  const refusal = offerDecisionGuardReason(offer, { brokerageId: input.brokerageId, agentScopeId: actor.agentScopeId })
  if (refusal) return { ok: false, spoken: refusal }

  // ── SAME kernel transition as the click (injected service client) ──
  const { issueCounterOffer } = await import("@/lib/kernel/offers")
  const res = await issueCounterOffer({
    offerId:      offer.id,
    agentId:      input.actorUserId,
    brokerageId:  input.brokerageId,
    counterPrice,
    notes:        input.notes ?? undefined,
  }, svc)
  if (!res.success || !res.data) return { ok: false, spoken: `The counter didn't go through: ${res.error ?? "kernel command failed"}.` }

  const buyerName = await buyerNameFor(svc, offer)
  await busReceipt(svc, {
    brokerageId: input.brokerageId,
    tool: "counter_offer",
    message: `Voice admin countered ${buyerName}'s offer${offer.property_address ? ` on ${offer.property_address}` : ""} at ${spokenPrice(counterPrice)} (round ${res.data.round}) — kernel issueCounterOffer`,
    offer,
    payload: { counter_id: res.data.counterId, round: res.data.round, counter_price: counterPrice },
  })

  return {
    ok: true,
    spoken: `Done — countered ${buyerName} at ${spokenPrice(counterPrice)}${offer.property_address ? ` on ${offer.property_address}` : ""}. That's round ${res.data.round}; the original offer shows countered and the ball is in the buyer's court.`,
    data: { offer_id: offer.id, counter_id: res.data.counterId, round: res.data.round, counter_price: counterPrice },
  }
}

/** Candidates for a spoken withdraw — any still-open offer in the tenancy
 *  (pending / submitted / countered). Counters are excluded from FUZZY
 *  matching (say the counter's id explicitly to retract it) so "withdraw the
 *  Hendersons' offer" can never silently pick the wrong row of a chain. */
async function findWithdrawableOffers(svc: Svc, brokerageId: string): Promise<DecisionOfferRow[]> {
  const { data } = await svc
    .from("offers")
    .select(DECISION_COLUMNS)
    .eq("brokerage_id", brokerageId)
    .in("status", ["pending", "submitted", "countered"])
    .order("submitted_at", { ascending: false })
    .limit(10)
  return ((data ?? []) as DecisionOfferRow[]).filter((o) => o.offer_type !== "counter")
}

/**
 * The withdraw guard — the click path (offer-workspace withdraw) runs on the
 * caller's session under tenant RLS with no extra role rule, so the voice
 * lane's equivalent-or-stricter set is: tenant match, agent self-scope
 * (broker/team_lead override, same as every decision verb), and still-open
 * status. Inbound-only does NOT apply — a withdraw retracts OUR side's offer,
 * whichever direction the deal runs.
 */
export function withdrawGuardReason(
  offer: DecisionOfferRow,
  ctx: { brokerageId: string; agentScopeId: string | null },
): string | null {
  if (offer.brokerage_id !== ctx.brokerageId) return "That offer isn't in your brokerage."
  if (ctx.agentScopeId && offer.agent_id && offer.agent_id !== ctx.agentScopeId) {
    return "That offer belongs to a different agent — only they (or a broker) can withdraw it."
  }
  if (offer.status !== "pending" && offer.status !== "submitted" && offer.status !== "countered") {
    return `That offer is already ${offer.status} — there's nothing left to withdraw.`
  }
  return null
}

/**
 * Withdraw an offer by voice — SAME kernel transition as the offer-workspace
 * withdraw click (lib/kernel/offers.withdrawOffer), spoken reason in notes.
 */
export async function voiceWithdrawOffer(
  input: VoiceOfferDecisionInput,
  client?: Svc,
): Promise<VoiceDealDecisionResult> {
  const svc = client ?? createServiceClient()
  if (!input.brokerageId || !input.actorUserId) return { ok: false, spoken: "I can't tell who's asking — reopen the assistant and try again." }

  const actor = await resolveActor(svc, input)
  if ("error" in actor) return { ok: false, spoken: actor.error }

  const resolved = await resolveSpokenOffer(svc, input, actor, findWithdrawableOffers)
  if (!resolved.found) return resolved.refusal
  const offer = resolved.offer

  const refusal = withdrawGuardReason(offer, { brokerageId: input.brokerageId, agentScopeId: actor.agentScopeId })
  if (refusal) return { ok: false, spoken: refusal }

  // ── SAME kernel transition as the click (injected service client) ──
  const { withdrawOffer } = await import("@/lib/kernel/offers")
  const res = await withdrawOffer({
    offerId:     offer.id,
    agentId:     input.actorUserId,
    brokerageId: input.brokerageId,
    reason:      input.reason ?? undefined,
  }, svc)
  if (!res.success) return { ok: false, spoken: `The withdrawal didn't go through: ${res.error ?? "kernel command failed"}.` }

  const buyerName = await buyerNameFor(svc, offer)
  await busReceipt(svc, {
    brokerageId: input.brokerageId,
    tool: "withdraw_offer",
    message: `Voice admin withdrew ${buyerName}'s offer${offer.property_address ? ` on ${offer.property_address}` : ""} (${spokenPrice(offer.offer_price)}) — kernel withdrawOffer${input.reason ? `; reason: ${input.reason.slice(0, 80)}` : ""}`,
    offer,
    payload: { reason: input.reason ?? null },
  })

  return {
    ok: true,
    spoken: `Done — the offer at ${spokenPrice(offer.offer_price)}${offer.property_address ? ` on ${offer.property_address}` : ""} is withdrawn${input.reason ? ", with the reason noted" : ""}.`,
    data: { offer_id: offer.id, withdrawn: true, reason: input.reason ?? null },
  }
}
