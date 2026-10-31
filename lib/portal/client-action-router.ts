// lib/portal/client-action-router.ts
//
// THE CLIENT BECOMES AN ACTOR — the missing arrow in the agentic OS. Every other tool (and our own
// portal until now) treats the client as a passive recipient: updates, value cards, a read-only
// Q&A bot. This routes a CLIENT's portal request into the SAME manager bench + approval gate the
// agent uses, so the buyer/seller participates in the AI team — gated, compliant, on the same page.
//
// COMPLIANCE (NAR 2024): browsing / searching / saving / asking is OPEN — no Buyer Broker Agreement
// required. ONLY the in-person SHOWING is BBA-gated (enforced downstream by requestShowing). A
// seller's price/listing change is the AGENT's decision, so it's PROPOSED through the gate, never
// executed by the client. Questions stay advisory. Nothing reaches anyone without a human in the loop.
//
// PURE — no I/O. The deterministic classifier is the floor (an AI-gateway layer can enhance intent
// upstream, like the inbound_intent_classifier pattern); this is what the proof pins down.

export type ClientIntent = "showing_request" | "search_refine" | "seller_action" | "question"
export type ClientActionKind = "create_showing" | "open_search" | "propose_to_agent" | "advisory"

export interface RoutedClientAction {
  kind: ClientActionKind
  intent: ClientIntent
  /** True ONLY for the in-person showing path — the one place NAR 2024's BBA applies. */
  bbaRelevant: boolean
  /** True when the action is governed — it lands in the agent's approval queue, not auto-executed. */
  gated: boolean
  /** Which manager owns the action (for the gated proposal's attribution). */
  manager: "shopping_agent" | "listing_concierge" | null
  reason: string
}

const ADDRESS_HINT = /\b(\d{1,6}\s+\w+|st\b|ave\b|rd\b|ln\b|dr\b|blvd\b|street|avenue|road|lane|drive|court|ct\b|place|pl\b)\b/i
const SHOWING_VERB = /\b(see|tour|showing|show me (the|this)|view|visit|walk ?through|book a (time|tour|showing))\b/i
const SEARCH_VERB = /\b(show me more|more like|similar to|find( me)?|search|listings? (like|near|in)|homes? (like|near|in)|what('?s| is) (available|on the market))\b/i
const SELLER_ACTION = /\b((drop|lower|reduce|change|raise|increase|adjust)\b[^.]{0,24}\bprice\b|\bprice\b[^.]{0,24}\b(to|down|drop|change|reduce)\b|re-?list|withdraw|cancel (my|the) listing|take (it|my home) off)/i

/** Pure deterministic intent classifier (the floor). contactType: 'buyer' | 'seller' | 'both' | null. */
export function classifyClientIntent(message: string, contactType: string | null): ClientIntent {
  const m = (message ?? "").toLowerCase()
  const canSell = contactType === "seller" || contactType === "both"

  // Seller listing/price actions take precedence for a seller's own home.
  if (canSell && SELLER_ACTION.test(m)) return "seller_action"
  // "see 123 Oak this weekend" — a showing needs a showing verb AND a property reference.
  if (SHOWING_VERB.test(m) && ADDRESS_HINT.test(m)) return "showing_request"
  // "show me more like 44 Birch" / "find homes near…" — open search.
  if (SEARCH_VERB.test(m)) return "search_refine"
  return "question"
}

/** Pure routing decision — the compliance contract: search open, showing BBA-gated downstream,
 *  seller action proposed-through-the-gate, question advisory. */
export function routeClientIntent(intent: ClientIntent, contactType: string | null): RoutedClientAction {
  // `contactType` WAS ACCEPTED HERE AND READ BY NOTHING until 2026-08-24. Both this
  // function and `classifyClientIntent` are EXPORTED and separately importable, so
  // the seller gate lived in exactly one of the two halves: hand this an intent of
  // "seller_action" from anywhere other than the classifier — an AI-gateway layer
  // enhancing intent upstream, which the header of this file explicitly anticipates
  // — and a BUYER's message was routed to the Listing Concierge as a price change on
  // a listing they do not own.
  //
  // FAIL CLOSED (CLAUDE.md §4): a seller action from a non-seller is degraded to
  // advisory and SAYS SO, rather than being proposed into someone's approval queue.
  const canSell = contactType === "seller" || contactType === "both"
  if (intent === "seller_action" && !canSell) {
    return {
      kind: "advisory",
      intent,
      bbaRelevant: false,
      gated: false,
      manager: null,
      reason: "a listing/price change was requested by a contact who is not a seller on this brokerage — answered advisory-only, never proposed",
    }
  }

  switch (intent) {
    case "showing_request":
      return { kind: "create_showing", intent, bbaRelevant: true, gated: false, manager: "shopping_agent", reason: "in-person showing — BBA enforced downstream; if unsigned, a signing-link is proposed to the agent (never dropped)" }
    case "search_refine":
      return { kind: "open_search", intent, bbaRelevant: false, gated: false, manager: "shopping_agent", reason: "browse/search is OPEN — NAR 2024 gates the tour, not the search" }
    case "seller_action":
      return { kind: "propose_to_agent", intent, bbaRelevant: false, gated: true, manager: "listing_concierge", reason: "a seller's price/listing change is the agent's decision — proposed through the approval gate" }
    case "question":
      return { kind: "advisory", intent, bbaRelevant: false, gated: false, manager: null, reason: "informational — answered advisory-only, no action" }
  }
}
