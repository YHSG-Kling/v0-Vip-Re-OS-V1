// lib/lead-pipeline/offer-rejection-recovery.ts
//
// OFFER-REJECTION RECOVERY — the pure engine.
//
// THE GAP (verified white space, from the follow-up audit): when a buyer's offer is REJECTED,
// the OFFER_REJECTED event fires and the loss is logged — but NOTHING re-engages the buyer.
// No regroup message, no agent next-step brief, no AI-ISA "are you still searching?" call.
// The 24-72h window after a rejection is the single highest abandonment risk in the buyer
// journey: a buyer who just lost a home they wanted is emotionally raw and prone to shopping
// other agents. The deconfliction engine, drips, and stale-contact monitor all exist, but
// none trigger on this acute moment — the stale-contact net only catches them at 14 days,
// long after the momentum is gone. Competitors don't catch this; an AI team that reaches out
// within hours of a tough rejection is exactly the "team that has your back" differentiator.
//
// PURE (no I/O): given when the offer was rejected and the response context, decide whether
// (and how urgently) to recover, and compose the deterministic fallback copy. HONEST: a
// COUNTERED offer is a live negotiation, NOT a rejection — never recover those; and past the
// recovery window the play expires rather than firing a stale, tone-deaf message.

export type RecoveryUrgency = "acute" | "followup" | "expired" | "not_eligible"

export interface RejectionRecoveryInput {
  /** ISO timestamp the offer was rejected (seller_response_received_at ?? responded_at) */
  rejectedAt: string | null
  /** ISO "now" — injectable for deterministic tests */
  now: string
  /** seller_response_type when known — 'countered' means the deal is still alive */
  sellerResponseType?: string | null
  hadCounter?: boolean
  buyerName?: string | null
  propertyAddress?: string | null
}

export interface RecoveryPlan {
  eligible: boolean
  urgency: RecoveryUrgency
  hoursSince: number | null
  /** route to the AI ISA for a same-day call (acute window only) */
  recommendCall: boolean
  /** internal next-step brief for the agent */
  agentBrief: string
  /** the gated buyer-facing regroup message (deterministic fallback) */
  buyerRegroup: string
  reason: string
}

// The acute, high-value window (hours) and the soft tail (hours) before the play expires.
export const ACUTE_WINDOW_HOURS = 72
export const FOLLOWUP_WINDOW_HOURS = 14 * 24

function buyerLabel(p: RejectionRecoveryInput): string {
  return p.buyerName ?? "your buyer"
}
function homeLabel(p: RejectionRecoveryInput): string {
  return p.propertyAddress ? `on ${p.propertyAddress}` : "on that home"
}

/** Decide the recovery play for one rejected offer. Pure. */
export function planRejectionRecovery(input: RejectionRecoveryInput): RecoveryPlan {
  const base = { hoursSince: null as number | null, recommendCall: false }

  // A countered offer is a LIVE negotiation — recovery would be wrong and confusing.
  const countered = input.hadCounter === true ||
    (input.sellerResponseType != null && /counter/i.test(input.sellerResponseType))
  if (countered) {
    return { ...base, eligible: false, urgency: "not_eligible", agentBrief: "", buyerRegroup: "", reason: "Offer was countered — this is a live negotiation, not a rejection." }
  }
  if (!input.rejectedAt) {
    return { ...base, eligible: false, urgency: "not_eligible", agentBrief: "", buyerRegroup: "", reason: "No rejection timestamp on file." }
  }

  const hoursSince = (new Date(input.now).getTime() - new Date(input.rejectedAt).getTime()) / 3_600_000
  if (hoursSince < 0) {
    return { ...base, hoursSince, eligible: false, urgency: "not_eligible", agentBrief: "", buyerRegroup: "", reason: "Rejection timestamp is in the future." }
  }
  if (hoursSince > FOLLOWUP_WINDOW_HOURS) {
    return { ...base, hoursSince, eligible: false, urgency: "expired", agentBrief: "", buyerRegroup: "", reason: "Past the recovery window — a regroup message now would feel tone-deaf." }
  }

  const acute = hoursSince <= ACUTE_WINDOW_HOURS
  const urgency: RecoveryUrgency = acute ? "acute" : "followup"
  const recommendCall = acute

  const agentBrief = acute
    ? `${buyerLabel(input)}'s offer ${homeLabel(input)} was just rejected. This is the make-or-break window — reach out within the day so they don't go shop other agents. Recommend a quick call to regroup on strategy (what to do differently next time) and re-point them at fresh inventory.`
    : `${buyerLabel(input)}'s offer ${homeLabel(input)} was rejected a few days ago. Re-engage before they cool off — a warm "still in your corner, here's what's new on the market" note keeps them with you.`

  const buyerRegroup = acute
    ? `I know that stings — losing out ${homeLabel(input)} after putting in an offer is never easy. The good news: it means you're ready to move, and the right one is still out there. Let's hop on a quick call to tweak our strategy so the next offer lands, and I'll send over a few fresh options that fit what you're looking for.`
    : `Thinking of you after the offer ${homeLabel(input)} didn't work out. The market keeps moving and new homes are coming up that fit your criteria — whenever you're ready, I've got your back and a refreshed shortlist to walk through.`

  return { eligible: true, urgency, hoursSince, recommendCall, agentBrief, buyerRegroup, reason: acute ? "Acute recovery window (≤72h) — reach out today." : "Follow-up window — warm re-engagement." }
}
