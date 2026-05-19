/**
 * Sprint 8 — Negotiation Co-Pilot analyzer.
 *
 * Pure-data composition: pulls every signal that should price into a
 * negotiation strategy for a given offer, returns a NegotiationContext
 * that the AI drafter consumes.
 *
 * Composes:
 *   - the full offers chain (parent_offer_id walk back through rounds)
 *   - the listing (list_price, DOM, status, agent_id for listing-side)
 *   - the buyer/seller persona (drives the customer-mirror tone)
 *   - peer-pattern signals from Sprint 4 brokerage_intelligence_insights
 *   - the agent's recent negotiation outcomes (won / walked / avg concessions)
 *
 * The recommended_action + recommended_counter_price + win_probability +
 * confidence here are computed by the AI drafter (copilot-ai.ts) from the
 * context. This module is pure SQL composition — no AI calls.
 */

import "server-only"
import type { SupabaseClient } from "@supabase/supabase-js"
import { computeDaysOnMarket } from "@/lib/listings/compute-dom"

export interface NegotiationContext {
  offerId:              string
  brokerageId:          string
  listingId:            string
  side:                 "buyer" | "seller"
  agentUserId:          string | null
  contactId:            string | null

  listing: {
    listPrice:        number
    daysOnMarket:     number | null
    status:           string | null
    propertyAddress:  string | null
  }

  currentOffer: {
    id:               string
    offerPrice:       number
    earnestMoney:     number | null
    contingencies:    string[]
    financingType:    string | null
    closingDate:      string | null
    round:            number
    status:           string | null
    offerType:        string | null
  }

  /** Walk back through parent_offer_id. Newest first (index 0 = previous round). */
  priorRounds: Array<{
    id:           string
    offerPrice:   number
    offerType:    string | null
    submittedAt:  string | null
    round:        number
  }>

  /** Customer-side persona drives plain-language tone in the mirror. */
  buyerPersona:   string | null
  sellerPersona:  string | null

  peerPatterns: Array<{
    patternKey:   string
    severity:     string | null
    summary:      string | null
    confidence:   number | null
  }>

  agentPriorOutcomes: {
    totalClosed:                 number
    totalWalked:                 number
    avgConcessionsDollars:       number | null
    avgRoundsToClose:            number | null
  }

  /** Open inspection findings (if past inspection stage). */
  inspectionFindings: Array<{
    findingType:    string | null
    severity:       string | null
    costEstimate:   number | null
    description:    string | null
  }>
}

export async function buildNegotiationContext(
  supabase: SupabaseClient,
  offerId:  string,
): Promise<NegotiationContext | null> {
  // 1. Offer
  const { data: offer } = await supabase
    .from("offers")
    .select(`
      id, brokerage_id, listing_id, contact_id, agent_id, offer_price,
      earnest_money, contingencies, financing_type, closing_date, status,
      offer_type, parent_offer_id, current_round, submitted_at, transaction_id
    `)
    .eq("id", offerId)
    .maybeSingle()
  if (!offer) return null

  const brokerageId = offer.brokerage_id as string | null
  const listingId   = offer.listing_id as string
  if (!brokerageId) return null

  // 2. Listing — gives us list_price, listing-side agent, go_live_date (DOM).
  // DOM is computed from go_live_date only (the public-active date). The
  // pre-MLS period between listing_date and go_live_date doesn't count.
  const { data: listing } = await supabase
    .from("listings")
    .select("id, agent_id, list_price, go_live_date, status, address")
    .eq("id", listingId)
    .maybeSingle()
  if (!listing) return null

  const daysOnMarket = computeDaysOnMarket(listing.go_live_date as string | null)

  // Determine side: if the requesting agent is the listing-side agent, it's
  // a seller-side strategy. Otherwise buyer-side.
  // Listing.agent_id is FK to agents(id); offer.agent_id is FK to agents(id)
  // too (the buyer's agent). Convention: side='seller' when generating
  // strategy on behalf of the listing agent; side='buyer' otherwise.
  // For Sprint 8 we infer from caller intent — the action passes side.
  // This builder accepts the side as a parameter is the cleaner long-term
  // shape; for now we'll default to 'buyer' when offer.offer_type is
  // 'initial' and 'seller' when it's 'counter'. Callers may override.
  const side: "buyer" | "seller" =
    offer.offer_type === "counter" ? "seller" : "buyer"

  // 3. Walk back through parent_offer_id to assemble prior rounds
  const priorRounds: NegotiationContext["priorRounds"] = []
  let cursorId = offer.parent_offer_id as string | null
  let guard = 0
  while (cursorId && guard < 10) {
    const { data: prior } = await supabase
      .from("offers")
      .select("id, offer_price, offer_type, submitted_at, current_round, parent_offer_id")
      .eq("id", cursorId)
      .maybeSingle()
    if (!prior) break
    priorRounds.push({
      id:          prior.id as string,
      offerPrice:  Number(prior.offer_price ?? 0),
      offerType:   (prior.offer_type as string | null) ?? null,
      submittedAt: (prior.submitted_at as string | null) ?? null,
      round:       (prior.current_round as number | null) ?? 0,
    })
    cursorId = prior.parent_offer_id as string | null
    guard += 1
  }

  // 4. Buyer + seller personas
  let buyerPersona: string | null = null
  if (offer.contact_id) {
    const { data: c } = await supabase
      .from("contacts")
      .select("contact_persona")
      .eq("id", offer.contact_id)
      .maybeSingle()
    buyerPersona = (c?.contact_persona as string | null) ?? null
  }
  let sellerPersona: string | null = null
  {
    const { data: l } = await supabase
      .from("listings")
      .select("seller_contact_id")
      .eq("id", listingId)
      .maybeSingle()
    const sellerContactId = (l?.seller_contact_id as string | null) ?? null
    if (sellerContactId) {
      const { data: c } = await supabase
        .from("contacts")
        .select("contact_persona")
        .eq("id", sellerContactId)
        .maybeSingle()
      sellerPersona = (c?.contact_persona as string | null) ?? null
    }
  }

  // 5. Peer patterns (Sprint 4 brokerage intelligence — negotiation-relevant)
  const { data: insights } = await supabase
    .from("brokerage_intelligence_insights")
    .select("pattern_key, severity, summary, confidence")
    .eq("brokerage_id", brokerageId)
    .eq("status", "open")
    .in("pattern_key", [
      "counter_concession_curve",
      "win_rate_by_offer_strength",
      "appraisal_gap_outcomes",
      "inspection_credit_norms",
    ])
    .limit(5)
  const peerPatterns: NegotiationContext["peerPatterns"] = (insights ?? []).map(
    (i: Record<string, unknown>) => ({
      patternKey: i.pattern_key as string,
      severity:   (i.severity as string | null) ?? null,
      summary:    (i.summary as string | null) ?? null,
      confidence: (i.confidence as number | null) ?? null,
    }),
  )

  // 6. Agent prior outcomes (last 90 days) — count offers that closed vs.
  // were rejected/withdrawn, plus avg recommended counter price delta from
  // any prior negotiation_strategies that were accepted_by_agent.
  let agentClosed = 0
  let agentWalked = 0
  let agentRoundsAvg: number | null = null
  if (offer.agent_id) {
    const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const { data: closedOffers } = await supabase
      .from("offers")
      .select("id, current_round")
      .eq("agent_id", offer.agent_id)
      .eq("status", "accepted")
      .gte("submitted_at", since)
    agentClosed = (closedOffers ?? []).length

    const { data: lostOffers } = await supabase
      .from("offers")
      .select("id")
      .eq("agent_id", offer.agent_id)
      .in("status", ["rejected", "withdrawn"])
      .gte("submitted_at", since)
    agentWalked = (lostOffers ?? []).length

    if (closedOffers && closedOffers.length > 0) {
      const totalRounds = (closedOffers as Array<{ current_round: number | null }>)
        .reduce((sum, o) => sum + (o.current_round ?? 1), 0)
      agentRoundsAvg = Math.round((totalRounds / closedOffers.length) * 10) / 10
    }
  }

  // 7. Inspection signals (transaction_inspections is the live table — it
  // stores one row per inspection with an issues_found text blob, not a
  // per-finding structure. Surface those records with issues so the AI
  // drafter can frame inspection-credit asks.)
  const inspectionFindings: NegotiationContext["inspectionFindings"] = []
  if (offer.transaction_id) {
    const { data: inspections } = await supabase
      .from("transaction_inspections")
      .select("inspection_type, status, cost, issues_found")
      .eq("transaction_id", offer.transaction_id)
      .not("issues_found", "is", null)
      .neq("status", "cancelled")
      .limit(10)
    for (const f of (inspections ?? []) as Array<Record<string, unknown>>) {
      const issues = (f.issues_found as string | null) ?? null
      if (!issues || issues.trim().length === 0) continue
      inspectionFindings.push({
        findingType:  (f.inspection_type as string | null) ?? null,
        severity:     (f.status as string | null) ?? null,
        costEstimate: (f.cost as number | null) ?? null,
        description:  issues,
      })
    }
  }

  // Resolve agents.id → users.id for the strategy's agent_user_id column.
  // negotiation_strategies.agent_user_id is a users.id FK, but
  // offers.agent_id and listings.agent_id both target agents.id. We need
  // the user_id, so look it up from the agents table.
  const targetAgentsId = side === "seller"
    ? (listing.agent_id as string | null) ?? null
    : (offer.agent_id  as string | null) ?? null
  let agentUserId: string | null = null
  if (targetAgentsId) {
    const { data: agentRow } = await supabase
      .from("agents")
      .select("user_id")
      .eq("id", targetAgentsId)
      .maybeSingle()
    agentUserId = (agentRow?.user_id as string | null) ?? null
  }

  return {
    offerId:     offer.id as string,
    brokerageId,
    listingId,
    side,
    agentUserId,
    contactId:   offer.contact_id as string | null,
    listing: {
      listPrice:       Number(listing.list_price ?? 0),
      daysOnMarket,
      status:          (listing.status as string | null) ?? null,
      propertyAddress: (listing.address as string | null) ?? null,
    },
    currentOffer: {
      id:           offer.id as string,
      offerPrice:   Number(offer.offer_price ?? 0),
      earnestMoney: (offer.earnest_money as number | null) ?? null,
      contingencies: ((offer.contingencies as string[] | null) ?? []),
      financingType: (offer.financing_type as string | null) ?? null,
      closingDate:   (offer.closing_date as string | null) ?? null,
      round:         (offer.current_round as number | null) ?? 1,
      status:        (offer.status as string | null) ?? null,
      offerType:     (offer.offer_type as string | null) ?? null,
    },
    priorRounds,
    buyerPersona,
    sellerPersona,
    peerPatterns,
    agentPriorOutcomes: {
      totalClosed:           agentClosed,
      totalWalked:           agentWalked,
      avgConcessionsDollars: null,  // populated when we wire concession learning loop
      avgRoundsToClose:      agentRoundsAvg,
    },
    inspectionFindings,
  }
}

