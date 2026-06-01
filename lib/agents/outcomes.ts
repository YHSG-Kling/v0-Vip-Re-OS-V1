/**
 * lib/agents/outcomes.ts
 *
 * Per-agent rubric builders for Anthropic Managed Agents' outcome-graded sessions
 * (user.define_outcome event + automated grader loop).
 *
 * Today the three Managed Agents (Deal Coordinator / Buyer Concierge / Listing
 * Concierge) get spawned with a one-shot user.message and return a single drafted
 * update. With outcomes:
 *
 *   1. The kickoff sends user.define_outcome instead of user.message — the agent
 *      receives a description of the goal AND a rubric of measurable success
 *      criteria. Anthropic's grader (a separate context window) scores the agent's
 *      output against the rubric on each iteration. The agent self-iterates until
 *      "satisfied" OR until max_iterations.
 *
 *   2. Each iteration produces a span.outcome_evaluation_end event on the webhook,
 *      with `result` ∈ {satisfied, needs_revision, max_iterations_reached, failed,
 *      interrupted}. We persist these to agent_outcome_evaluations (m110) so the
 *      coaching engine + admin UI can show rubric progress.
 *
 *   3. The rubric criteria are framed against the SAME canonical lifecycle states
 *      the kernel uses — buyer_stage, listing.lifecycle_stage, transactions.stage
 *      — so the agent's notion of "done" matches the rest of the app.
 */
import "server-only"

export type AgentOutcomeKind = "buyer_concierge" | "listing_concierge" | "deal_coordinator"

export interface OutcomeRubric {
  /** Short description for the agent (what they're working toward, in plain language). */
  description: string
  /** Markdown rubric with explicit, gradeable criteria. Each line is a separate
   *  check the grader runs against the agent's output. */
  rubric:      string
  /** Maximum iterations the grader loop runs before giving up (default 5; max 20
   *  per Anthropic). Keep tight so a stuck agent doesn't burn budget. */
  maxIterations: number
}

/** Buyer Concierge — "buyer reaches offer-eligible state". */
function buildBuyerConciergeRubric(params: {
  brokerageName: string
  buyerName:     string
}): OutcomeRubric {
  return {
    description:
      `Move the buyer "${params.buyerName}" from contact-created through to OFFER ELIGIBLE for ` +
      `${params.brokerageName}. Output produces the next set of buyer-side updates and agent ` +
      `briefings until the buyer is ready to write an offer.`,
    rubric: `
The buyer is OFFER ELIGIBLE when ALL of the following are true (each line is a separate criterion):

1. The buyer has an active Buyer Broker Agreement (BBA) — signed, not expired, with this brokerage.
2. The buyer has at least one verified financial step on file — either a pre-approval letter,
   proof of funds, or a verified lender introduction.
3. The buyer has a configured saved search (geography + price + property type) so the agent
   can match new listings.
4. The buyer has toured at least one property OR explicitly declined to tour after seeing listings.
5. Every drafted buyer_digest and agent_briefing in the session matches the brokerage's brand voice
   (no prohibited words, ≥60% client-focused pronouns) and respects the buyer's persona register.
6. No drafted message violates NAR Code of Ethics Article 16 (no poaching language toward
   buyers represented by other agents) or Fair Housing Act protected-class references.
7. Each iteration's response is valid JSON matching the documented response format
   (phase, buyer_digest, agent_briefing, next_step_for_buyer, recommended_tours,
   bba_renewal_due_in_days, next_check_at).

You PASS when all 7 are satisfied for the current state. You DO NOT pass when any one fails.
`.trim(),
    maxIterations: 5,
  }
}

/** Listing Concierge — "listing reaches signed agreement and (if active) maintains health". */
function buildListingConciergeRubric(params: {
  brokerageName: string
  sellerName:    string
}): OutcomeRubric {
  return {
    description:
      `Move the seller "${params.sellerName}" from contact-created through to a fully-signed ` +
      `listing agreement for ${params.brokerageName}, then maintain the listing's health while ` +
      `it's active. Output produces the next set of seller-side updates and agent briefings.`,
    rubric: `
The session is SATISFIED when ALL of the following are true:

1. The seller has had a listing appointment scheduled OR held (the kernel listing-appt-prep
   chain auto-runs CMA + presentation + DID video on the appointment_set event).
2. If the listing exists in the listings table, it has lifecycle_stage progression past LEAD
   (i.e. LISTING_AGREEMENT_INITIATED or beyond).
3. If a fully-signed listing_agreement exists, the listing is in active marketing AND the
   most recent seller_update reflects current showings + feedback.
4. No price_recommendation is included without supporting comp data from the CMA tools.
5. Every drafted seller_update and agent_briefing matches brand voice + brokerage compliance gates.
6. No drafted message reveals one buyer's offer / showing feedback to a different audience.
7. Each iteration's response is valid JSON matching the documented response format.

If the seller is still pre-appointment, you PASS only when the agent_briefing has driven
toward scheduling the listing appointment (no price recommendations yet).
`.trim(),
    maxIterations: 5,
  }
}

/** Deal Coordinator — "transaction reaches CLOSED with all milestones complete". */
function buildDealCoordinatorRubric(params: {
  brokerageName: string
  dealName:      string
}): OutcomeRubric {
  return {
    description:
      `Coordinate the transaction "${params.dealName}" for ${params.brokerageName} through ` +
      `every milestone from UNDER_CONTRACT to CLOSED. Output buyer + seller updates and ` +
      `agent briefings on each iteration.`,
    rubric: `
The session is SATISFIED for an iteration when ALL of the following are true:

1. buyer_update is ≤80 words, in the buyer's persona voice, no jargon left unexplained.
2. seller_update is ≤80 words, in the seller's persona voice, no jargon left unexplained.
3. agent_briefing names the SPECIFIC items at risk in the next 7-14 days, with the responsible
   party identified (lender / title / inspector / appraiser / buyer / seller).
4. risk_score (0-100) is justified by the current deal-health score AND any provider-document
   sync gaps surfaced in transaction_documents.
5. next_check_at is a real ISO8601 timestamp not more than 24 hours in the future for high-risk
   deals (score ≥ 60), or 72 hours for healthy deals (score < 60).
6. No update reveals one side's negotiation posture to the other.
7. No update makes commitments on behalf of the title / lender / inspector / appraiser.
8. Brand voice + Fair Housing + Them-First gates pass on both updates.

You PASS when all 8 hold. Iterate until they do.
`.trim(),
    maxIterations: 5,
  }
}

export function buildOutcomeFor(
  kind: AgentOutcomeKind,
  params: { brokerageName: string; subjectName: string },
): OutcomeRubric {
  switch (kind) {
    case "buyer_concierge":    return buildBuyerConciergeRubric({   brokerageName: params.brokerageName, buyerName:  params.subjectName })
    case "listing_concierge":  return buildListingConciergeRubric({ brokerageName: params.brokerageName, sellerName: params.subjectName })
    case "deal_coordinator":   return buildDealCoordinatorRubric({  brokerageName: params.brokerageName, dealName:   params.subjectName })
  }
}

/**
 * Render the user.define_outcome event payload that the spawn-helper sends as the
 * kickoff (instead of user.message). Anthropic's grader runs against the rubric on
 * every agent idle.
 */
export function buildDefineOutcomeEvent(rubric: OutcomeRubric, contextBlock: string): Record<string, unknown> {
  return {
    type: "user.define_outcome",
    description: `${contextBlock}

YOUR GOAL FOR THIS SESSION:
${rubric.description}`,
    rubric: { type: "text", content: rubric.rubric },
    max_iterations: rubric.maxIterations,
  }
}
