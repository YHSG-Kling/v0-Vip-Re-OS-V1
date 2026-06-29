// lib/transactions/stranded-offer-policy.ts
// ─────────────────────────────────────────────────────────────────────────────
// PURE policy for the STRANDED-OFFER reaper. The offer→under-contract boundary is the highest-stakes
// handoff in the system: an accepted offer MUST become a tracked transaction (Deal Coordinator + seeded
// milestones). The agent-facing offer workspace accepts via the kernel offer path, which only links a
// transaction when one already exists — and createTransactionFromOffer is COMPLIANCE-GATED (it refuses
// until the contract is executed + compliance passed). So an offer can be 'accepted' with no transaction
// (the agent accepted before the contract/compliance is finished) and then sit there silently — no deal,
// no milestones, no portal. Nothing watched for this.
//
// This is the un-bypassable safety net: after a grace period, an accepted-but-transaction-less offer is
// ESCALATED to the responsible agent (finish the executed contract + compliance so the deal opens). We
// do NOT auto-create the transaction — the compliance gate is real; a human must complete it. Pure +
// unit-tested; the runner does the I/O + escalation.

export const STRANDED_OFFER_GRACE_HOURS = 24

export interface StrandedOfferInput {
  status: string
  transactionId: string | null
  /** when the offer was accepted (offers.responded_at); falls back to created_at. */
  respondedAt: string | null
  createdAt: string
  now: number
}

export type StrandedOfferAction = "escalate" | "keep"

/** PURE. An accepted offer with NO transaction, past the grace window, is a stranded handoff → escalate.
 *  Everything else (not accepted, already has a transaction, or still inside the grace window) is kept. */
export function classifyStrandedOffer(i: StrandedOfferInput): StrandedOfferAction {
  if (i.status !== "accepted") return "keep"   // only accepted offers can strand
  if (i.transactionId) return "keep"           // it became a deal — exactly what we want
  const ref = i.respondedAt ?? i.createdAt
  const ageHours = (i.now - new Date(ref).getTime()) / 3_600_000
  return ageHours >= STRANDED_OFFER_GRACE_HOURS ? "escalate" : "keep"
}
