"use server"

/**
 * app/actions/portal-offer-decision.ts — CLIENT OFFER DECISION SIGNAL.
 * Production audit fix: the portal's Accept/Counter/Decline offer buttons were
 * INERT (server components, no handlers) — a seller believed they accepted an
 * offer and nothing happened. The honest rail, consistent with the gated
 * architecture: the client's click is a DECISION SIGNAL, not a legal act —
 * it lands as the agent's top task ("execute this") + the ledger + the
 * engagement stream, and the client is told plainly that the agent makes it
 * official (paperwork/e-sign ride the existing signing rail). Party-anchored:
 * the caller must be the buyer on the offer or the seller on its listing.
 */

import { createServiceClient } from "@/lib/supabase/service"

const DECISIONS = {
  accept: "wants to ACCEPT",
  counter: "wants to COUNTER",
  decline: "wants to DECLINE",
  request_highest_best: "wants to call for HIGHEST & BEST from all buyers",
} as const

export type ClientOfferDecision = keyof typeof DECISIONS

export async function recordClientOfferDecision(input: {
  contactId: string
  offerId: string
  decision: string
  note?: string
}): Promise<{ success: boolean; error?: string; message?: string }> {
  if (!(input.decision in DECISIONS)) return { success: false, error: "Unknown decision" }
  const decision = input.decision as ClientOfferDecision
  const note = (input.note ?? "").trim().slice(0, 500)

  const svc = createServiceClient()
  const { data: offer } = await svc.from("offers")
    .select("id, contact_id, agent_id, brokerage_id, offer_price, status, listing_id, transaction_id, listing:listings(id, contact_id, seller_contact_id, agent_id, address)")
    .eq("id", input.offerId).maybeSingle()
  if (!offer) return { success: false, error: "Offer not found" }

  const listing: any = Array.isArray((offer as any).listing) ? (offer as any).listing[0] : (offer as any).listing
  const isBuyer = (offer as any).contact_id === input.contactId
  const isSeller = listing && (listing.contact_id === input.contactId || listing.seller_contact_id === input.contactId)
  if (!isBuyer && !isSeller) return { success: false, error: "You are not a party to this offer" }

  const side = isBuyer ? "Buyer" : "Seller"
  const price = (offer as any).offer_price ? `$${Number((offer as any).offer_price).toLocaleString("en-US")}` : "the offer"
  const where = listing?.address ? ` on ${listing.address}` : ""

  // The owning agent, resolved ONCE and reused: it stamps the engagement row below and it is the
  // task's assignee further down. Both `offers.agent_id` and `listings.agent_id` are AGENTS-class
  // (see lib/compliance/offer-flag-resolution.ts), so this coalesce stays inside one id space —
  // it is not a users/agents swap.
  const owningAgentId: string | null = (offer as any).agent_id ?? listing?.agent_id ?? null
  const owningBrokerageId: string | null = (offer as any).brokerage_id ?? null

  // The ledger — the client's word, timestamped. `.then(ok, err)` used to stand in for an error
  // check here: supabase-js RESOLVES a refused write, so the reject arm never ran and the failure
  // was dropped either way. Destructured now.
  const { error: ledgerError } = await svc.from("lifecycle_events").insert({
    brokerage_id: owningBrokerageId,
    entity_type: "offer",
    entity_id: input.offerId,
    event_type: "client_offer_decision",
    metadata: { decision, side: side.toLowerCase(), contact_id: input.contactId, note: note || null },
  })
  if (ledgerError) console.error("[portal-offer-decision] lifecycle event NOT recorded:", ledgerError.message)

  // The engagement stream the recognition rails already read. THE TENANT AND THE OWNING AGENT ARE
  // THE POINT: this row's SELECT policy admits the agent side only through
  // has_brokerage_access(brokerage_id) or agent_id = current_user_agent_id(). Written with both
  // null — as it was — the seller's accept/counter/decline is visible to the SELLER and to nobody
  // who can act on it. Both columns are nullable, so the insert succeeded and nothing complained.
  const activityRow = {
    brokerage_id: owningBrokerageId,
    contact_id: input.contactId,
    agent_id: owningAgentId,
    activity_type: "offer_decision",
    metadata: { offer_id: input.offerId, decision },
  }
  const { error: activityError } = await svc.from("client_portal_activity").insert(activityRow)
  if (activityError) console.error("[portal-offer-decision] portal activity NOT recorded:", activityError.message)

  // The agent's execute-this task (NOT-NULL assignee contract honored).
  const assignee = owningAgentId
  if (!assignee) {
    return { success: false, error: "No agent is attached to this offer yet — message your agent directly and they'll take it from here." }
  }
  const { error: taskError } = await svc.from("tasks").insert({
    brokerage_id: owningBrokerageId,
    transaction_id: (offer as any).transaction_id ?? null,
    contact_id: input.contactId,
    assigned_to_agent_id: assignee,
    title: `${side} ${DECISIONS[decision]} — ${price}${where}`,
    description: `The ${side.toLowerCase()} recorded this decision on their portal${note ? `: "${note}"` : "."} Confirm with them and execute — nothing is final until the paperwork is signed.`,
    due_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    assignee_type: "agent",
    source: "client_offer_decision",
    status: "pending",
  })
  if (taskError) return { success: false, error: "Your decision was recorded but we couldn't reach your agent's task list — message them directly to be safe." }

  return {
    success: true,
    message: "Got it — your agent has this at the top of their list and will make it official with you. Nothing is final until the paperwork is signed.",
  }
}
