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
//   sessionless ElevenLabs tool webhook — unlike lib/kernel/offers.ts
//   acceptOffer/rejectOffer/issueCounterOffer, which run on the caller's
//   auth-cookie client (RLS 'authenticated' + tenant policies) and therefore
//   CANNOT run from this webhook. Those stay speakable:false in
//   lib/voice/command-coverage.ts with that exact reason.
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

  // ── Resolve the offer (explicit id, else spoken hint, else the only open one) ──
  let offer: DecisionOfferRow | null = null
  if (input.offerId) {
    const { data } = await svc
      .from("offers")
      .select(DECISION_COLUMNS)
      .eq("id", input.offerId)
      .maybeSingle()
    offer = (data as DecisionOfferRow | null) ?? null
    if (!offer) return { ok: false, spoken: "I couldn't find that offer." }
  } else {
    const candidates = await findDecisionReadyOffers(svc, input.brokerageId)
    // Agent self-scope applies to matching too — an agent only hears their own.
    const scoped = actor.agentScopeId
      ? candidates.filter((o) => !o.agent_id || o.agent_id === actor.agentScopeId)
      : candidates
    if (scoped.length === 0) {
      return { ok: false, spoken: "There are no open offers waiting on a decision right now." }
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
      return { ok: false, spoken: `I don't see an open offer matching "${input.query}". Say "what offers are pending" to hear the list.` }
    }
    if (matches.length > 1) {
      const spokenList = matches.slice(0, 3).map((o, i) => {
        const buyer = o.contact_id ? names.get(o.contact_id) ?? "a buyer" : "a buyer"
        return `${i + 1}: ${buyer} at ${spokenPrice(o.offer_price)}${o.property_address ? ` on ${o.property_address}` : ""}`
      }).join(". ")
      return {
        ok: false,
        spoken: `There ${matches.length === 2 ? "are two" : `are ${matches.length}`} open offers that could match. ${spokenList}. Which one — give me the buyer's name or the address.`,
        data: { candidates: matches.map((o) => ({ offer_id: o.id, property_address: o.property_address, offer_price: o.offer_price })) },
      }
    }
    offer = matches[0]
  }

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
