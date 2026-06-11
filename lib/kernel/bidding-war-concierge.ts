// lib/kernel/bidding-war-concierge.ts
//
// THE BIDDING-WAR CONCIERGE — the BUYER-SIDE competitive play. When OUR buyer is writing
// an offer into a likely MULTIPLE-OFFER situation on someone ELSE's listing (an OUTSIDE
// listing agent, NOT our in-house listing), no AI OS prepares the buyer to WIN. Ours
// convenes the bench the moment the buyer's offer lands on an external listing:
//
//   · Shopping Agent       — the ESCALATION-STRATEGY brief to OUR agent (audience 'agent'):
//                            how high to go (escalation ceiling + cap rationale), escalation-
//                            clause logic, and which terms to tighten (contingency / earnest /
//                            close-timeline / rent-back tradeoffs). Pure math, agent-gated.
//   · Deal Coordinator     — the buyer-voice "highest-and-best" COVER LETTER, a DRAFT proposed
//                            for the BUYER to approve (audience 'buyer'). Persona-aware, written
//                            in the buyer's voice to the seller — about the OFFER'S STRENGTH only.
//                            FAIR HOUSING: NO protected-class/personal appeals (no family /
//                            religion / "we'll raise our kids here" steering) — enforced in the
//                            copy request's constraints.
//   · Campaign Orchestrator — the rapport / availability NOTE to the OUTSIDE listing agent
//                            (audience 'agent', a draft OUR agent can send) — warm, professional,
//                            "we're responsive, here's how to reach me."
//
// This is the COMPLEMENT to the in-house seller offer-comparison feature — it never touches
// it. Everything is GATED (nothing auto-sends) and IDEMPOTENT (one concierge bundle per
// offer). The bus carries the convening line. NOT server-only (simulator-driven).

import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"
import type { CopyGenerator } from "@/lib/kernel/ai-copy"

type Svc = ReturnType<typeof createServiceClient>

// Pre-acceptance offer statuses where a competitive prep still matters (the seller has not
// accepted/rejected/withdrawn — the buyer can still improve their position).
export const COMPETITIVE_OFFER_STATUSES = ["draft", "submitted", "pending", "countered", "negotiating"] as const

// ─── PURE LAYER 1 ─────────────────────────────────────────────────────────────

export type MarketHeat = "hot" | "warm" | "balanced"

/** Infer competitive heat from the signals we actually have: an escalation clause on the
 *  buyer's own offer signals they expect competition; an offer at/above list signals heat. */
export function inferMarketHeat(params: {
  offerPrice: number
  listPrice: number | null
  escalationClause: boolean | null
}): MarketHeat {
  const { offerPrice, listPrice, escalationClause } = params
  if (escalationClause) return "hot"
  if (listPrice && listPrice > 0) {
    const ratio = offerPrice / listPrice
    if (ratio >= 1.0) return "hot"
    if (ratio >= 0.97) return "warm"
  }
  return "balanced"
}

export interface EscalationPlan {
  /** Suggested escalation ceiling — the most the buyer should authorize. */
  ceiling: number
  /** Recommended increment to beat a competing offer by. */
  increment: number
  /** How far over list the ceiling sits (decimal, e.g. 0.08 = 8% over list). */
  overListPct: number | null
  rationale: string
}

/**
 * Pure: the escalation ceiling + cap rationale. Hotter markets justify a higher ceiling
 * over list; the ceiling is anchored on the buyer's CURRENT offer (never fabricated higher
 * than the buyer's demonstrated willingness + a heat-scaled headroom). Increment scales
 * with price so it's a meaningful beat, not a rounding error.
 */
export function escalationPlan(
  offerPrice: number,
  listPrice: number | null,
  marketHeat: MarketHeat = "warm",
): EscalationPlan {
  const headroomByHeat: Record<MarketHeat, number> = { hot: 0.10, warm: 0.06, balanced: 0.03 }
  const headroom = headroomByHeat[marketHeat]
  // Anchor: the higher of the buyer's offer or list (an offer below list still escalates
  // off list in a hot market). Ceiling adds heat-scaled headroom on top of the anchor.
  const anchor = Math.max(offerPrice, listPrice ?? 0)
  const rawCeiling = anchor * (1 + headroom)
  // Round the ceiling to a clean $1,000 so it reads like a real number.
  const ceiling = Math.round(rawCeiling / 1000) * 1000
  // Increment: ~0.25% of the anchor, floored at $1,000, rounded to $500.
  const increment = Math.max(1000, Math.round((anchor * 0.0025) / 500) * 500)
  const overListPct = listPrice && listPrice > 0 ? (ceiling - listPrice) / listPrice : null
  const rationale =
    marketHeat === "hot"
      ? `Hot, multiple-offer market: authorize up to $${ceiling.toLocaleString()} (about ${overListPct != null ? Math.round(overListPct * 100) : "—"}% over list) and beat competing offers by $${increment.toLocaleString()} increments. Cap is firm — do not chase past the ceiling; protect the buyer from overpaying on appraisal risk.`
      : marketHeat === "warm"
      ? `Competitive but not frenzied: a ceiling of $${ceiling.toLocaleString()} with $${increment.toLocaleString()} increments stays disciplined. Pair the escalation with strong terms before chasing price.`
      : `Balanced market: a modest ceiling of $${ceiling.toLocaleString()} is enough — terms (timeline, earnest, contingencies) will likely matter more than a higher number.`
  return { ceiling, increment, overListPct, rationale }
}

export interface OfferTermsSnapshot {
  offerPrice: number
  earnestMoney: number | null
  financingType: string | null
  closingDate: string | null
  inspectionPeriodDays: number | null
  financingContingencyDays: number | null
  appraisalContingencyDays: number | null
  appraisalGap: number | null
  contingencies: string[] | null
}

export interface TermSuggestion {
  term: string
  action: string
  tradeoff: string
}

/**
 * Pure: which terms to TIGHTEN to strengthen a competing buyer offer, each with the
 * tradeoff/risk spelled out (so the agent advises, not just pushes). Only suggests a
 * lever that is actually loose in the current offer — never recommends what's already done.
 */
export function strengthenTerms(offer: OfferTermsSnapshot): TermSuggestion[] {
  const out: TermSuggestion[] = []

  // Earnest money — a bigger deposit signals commitment (a strong, low-cost lever).
  const earnestPct = offer.offerPrice > 0 && offer.earnestMoney != null ? offer.earnestMoney / offer.offerPrice : null
  if (earnestPct == null || earnestPct < 0.03) {
    out.push({
      term: "Earnest money",
      action: "Raise earnest money toward 3-5% of the offer price.",
      tradeoff: "More cash at risk if the buyer defaults — but it credits to the purchase and signals serious intent.",
    })
  }

  // Inspection period — shortening (not waiving) reduces the seller's uncertainty.
  if (offer.inspectionPeriodDays == null || offer.inspectionPeriodDays > 7) {
    out.push({
      term: "Inspection period",
      action: "Shorten the inspection/due-diligence window (e.g. 5-7 days). Consider an information-only inspection rather than waiving.",
      tradeoff: "Less time to discover issues; waiving entirely transfers repair risk to the buyer — shorten, don't blindly waive.",
    })
  }

  // Financing contingency — a faster removal de-risks the deal for the seller.
  if (offer.financingType !== "cash" && (offer.financingContingencyDays == null || offer.financingContingencyDays > 21)) {
    out.push({
      term: "Financing contingency",
      action: "Tighten the financing contingency window with a fully-underwritten pre-approval in hand.",
      tradeoff: "If financing falls through after the window, earnest money is exposed — only tighten with lender confidence.",
    })
  }

  // Appraisal gap — covering a shortfall protects the seller against a low appraisal.
  if ((offer.appraisalGap == null || offer.appraisalGap <= 0) && offer.financingType !== "cash") {
    out.push({
      term: "Appraisal gap",
      action: "Offer to cover an appraisal gap up to a stated amount (only what the buyer can fund in cash).",
      tradeoff: "Requires extra cash at closing if the home appraises low — cap it at what the buyer can comfortably bring.",
    })
  }

  // Close timeline / rent-back — flexibility to the seller's preferred date is free leverage.
  out.push({
    term: "Close timeline & rent-back",
    action: "Offer flexibility on the closing date and a free or low-cost post-closing rent-back if the seller needs time to move.",
    tradeoff: "A rent-back delays the buyer's possession and adds occupancy/insurance considerations — but it's often the term that wins a tie.",
  })

  return out
}

export interface BiddingWarBrief {
  escalation: EscalationPlan
  terms: TermSuggestion[]
  marketHeat: MarketHeat
  /** The agent-facing escalation brief body (deterministic fallback for the copy seam). */
  agentBriefBody: string
}

/** Pure: assemble the agent escalation brief from the math (the deterministic fallback). */
export function composeEscalationBrief(params: {
  buyerName: string | null
  propertyAddress: string | null
  offer: OfferTermsSnapshot
  listPrice: number | null
  marketHeat: MarketHeat
}): BiddingWarBrief {
  const { buyerName, propertyAddress, offer, listPrice, marketHeat } = params
  const plan = escalationPlan(offer.offerPrice, listPrice, marketHeat)
  const terms = strengthenTerms(offer)
  const who = sanitizeProperNoun(buyerName, 60) ?? "your buyer"
  const where = propertyAddress ? ` on ${propertyAddress}` : ""
  const termLines = terms.map((t) => `• ${t.term}: ${t.action} (Tradeoff: ${t.tradeoff})`).join("\n")
  const agentBriefBody =
    `Bidding-war prep for ${who}${where} — this looks like a multiple-offer situation against an outside listing.\n\n` +
    `ESCALATION CEILING: ${plan.rationale}\n` +
    `Suggested escalation-clause logic: beat the highest competing offer by $${plan.increment.toLocaleString()} up to a hard cap of $${plan.ceiling.toLocaleString()}.\n\n` +
    `TERMS TO STRENGTHEN (with tradeoffs):\n${termLines}\n\n` +
    `Review and dial the ceiling to the buyer's real comfort before presenting. Nothing here sends to anyone — this is your brief.`
  return { escalation: plan, terms, marketHeat, agentBriefBody }
}

// ─── CONVENING LAYER ──────────────────────────────────────────────────────────

export interface BiddingWarResult {
  bundles: number
  escalationBriefs: number
  coverLetters: number
  outsideAgentNotes: number
  signalsPublished: number
}

interface CompetitiveOffer {
  offerId: string
  buyerContactId: string
  agentRowId: string | null
  listingId: string | null
  transactionId: string | null
  propertyAddress: string | null
  listPrice: number | null
  listingAgentName: string | null
  offer: OfferTermsSnapshot
}

/** Resolve an offer's listing context + decide whether it's an EXTERNAL (outside) listing.
 *  External = the listing is NOT one of OUR brokerage's listings (its agent_id is null or
 *  belongs to no agent in our brokerage) but has a named listing agent, OR the offer has a
 *  listing we don't own. An offer with NO listing (transaction-only buyer rep) is treated as
 *  external by definition (we represent the buyer, the listing is someone else's). */
async function loadCompetitiveContext(
  supabase: Svc,
  brokerageId: string,
  offerRow: any,
): Promise<CompetitiveOffer | null> {
  let listPrice: number | null = null
  let propertyAddress: string | null = offerRow.property_address ?? null
  let listingAgentName: string | null = null
  let isExternal = false

  if (offerRow.listing_id) {
    const { data: l } = await supabase
      .from("listings")
      .select("id, list_price, address, agent_id, listing_agent_name")
      .eq("id", offerRow.listing_id)
      .maybeSingle()
    const listing = l as
      | { id: string; list_price: number | null; address: string | null; agent_id: string | null; listing_agent_name: string | null }
      | null
    if (listing) {
      listPrice = listing.list_price ?? null
      propertyAddress = propertyAddress ?? listing.address ?? null
      listingAgentName = listing.listing_agent_name ?? null
      // Is this OUR listing? Our listing has an agent_id that maps to an agent in our brokerage.
      if (listing.agent_id) {
        const { data: a } = await supabase
          .from("agents")
          .select("id")
          .eq("id", listing.agent_id)
          .eq("brokerage_id", brokerageId)
          .maybeSingle()
        isExternal = !a // an agent_id that is NOT ours → external listing
      } else {
        // No in-house listing agent → external (an outside agent's listing in our MLS view).
        isExternal = true
      }
    }
  } else {
    // No listing on the offer → buyer-rep on someone else's listing by definition.
    isExternal = true
  }

  if (!isExternal) return null

  const offer: OfferTermsSnapshot = {
    offerPrice: Number(offerRow.offer_price),
    earnestMoney: offerRow.earnest_money != null ? Number(offerRow.earnest_money) : null,
    financingType: offerRow.financing_type ?? null,
    closingDate: offerRow.closing_date ?? null,
    inspectionPeriodDays: offerRow.inspection_period_days ?? null,
    financingContingencyDays: offerRow.financing_contingency_days ?? null,
    appraisalContingencyDays: offerRow.appraisal_contingency_days ?? null,
    appraisalGap: offerRow.appraisal_gap != null ? Number(offerRow.appraisal_gap) : null,
    contingencies: offerRow.contingencies ?? null,
  }

  return {
    offerId: offerRow.id,
    buyerContactId: offerRow.contact_id,
    agentRowId: offerRow.agent_id ?? null,
    listingId: offerRow.listing_id ?? null,
    transactionId: offerRow.transaction_id ?? null,
    propertyAddress,
    listPrice,
    listingAgentName,
    offer,
  }
}

/**
 * Find OUR buyers in a competitive offer situation on an external listing and propose a
 * GATED bundle to our agent: the escalation brief (audience 'agent', Shopping Agent), the
 * buyer-voice cover letter (a DRAFT proposed for the buyer to approve, audience 'buyer'),
 * and the outside-agent rapport note (audience 'agent', a draft the agent can send).
 *
 * All gated; idempotent (one concierge bundle per offer — keyed by the escalation brief's
 * entity_type/entity_id). Copy is AI-generated via generatePersonaCopy with a deterministic
 * fallback; the buyer cover letter is Fair-Housing constrained in the copy request.
 */
export async function runBiddingWarConcierge(
  brokerageId: string,
  opts: { now?: Date; copyGenerator?: CopyGenerator } = {},
  client?: Svc,
): Promise<BiddingWarResult> {
  const supabase = client ?? createServiceClient()
  const result: BiddingWarResult = {
    bundles: 0, escalationBriefs: 0, coverLetters: 0, outsideAgentNotes: 0, signalsPublished: 0,
  }
  if (!brokerageId) return result

  const { generatePersonaCopy } = await import("@/lib/kernel/ai-copy")
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")

  // Our buyer-written offers in a pre-acceptance, competitive-eligible status.
  const { data: offers } = await supabase
    .from("offers")
    .select(
      "id, contact_id, agent_id, listing_id, transaction_id, offer_price, earnest_money, financing_type, closing_date, inspection_period_days, financing_contingency_days, appraisal_contingency_days, appraisal_gap, escalation_clause, contingencies, property_address, status",
    )
    .eq("brokerage_id", brokerageId)
    .in("status", COMPETITIVE_OFFER_STATUSES as unknown as string[])
    .not("contact_id", "is", null)
    .limit(100)

  for (const offerRow of (offers ?? []) as any[]) {
    // Idempotency: one concierge bundle per offer — keyed on the escalation brief.
    const { data: existing } = await supabase
      .from("agent_client_messages")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("entity_type", "bidding_war_escalation")
      .eq("entity_id", offerRow.id)
      .limit(1)
      .maybeSingle()
    if (existing) continue

    const ctx = await loadCompetitiveContext(supabase, brokerageId, offerRow)
    if (!ctx) continue // not an external listing → not our competitive play

    // Confirm the buyer is OURS + a buyer contact; resolve name + persona.
    const { data: c } = await supabase
      .from("contacts")
      .select("id, brokerage_id, contact_type, first_name, last_name, buyer_stage")
      .eq("id", ctx.buyerContactId)
      .maybeSingle()
    const contact = c as
      | { id: string; brokerage_id: string | null; contact_type: string | null; first_name: string | null; last_name: string | null; buyer_stage: string | null }
      | null
    if (!contact || contact.brokerage_id !== brokerageId) continue

    const buyerName = [contact.first_name, contact.last_name].filter(Boolean).join(" ").trim() || null
    const marketHeat = inferMarketHeat({
      offerPrice: ctx.offer.offerPrice,
      listPrice: ctx.listPrice,
      escalationClause: offerRow.escalation_clause ?? null,
    })

    const brief = composeEscalationBrief({
      buyerName,
      propertyAddress: ctx.propertyAddress,
      offer: ctx.offer,
      listPrice: ctx.listPrice,
      marketHeat,
    })

    // ── 1) SHOPPING AGENT — the escalation-strategy brief to OUR agent (audience 'agent').
    const briefFacts = [
      ctx.propertyAddress ? `Property: ${ctx.propertyAddress}` : "An external listing",
      `This is a likely multiple-offer situation (market heat: ${marketHeat})`,
      `Escalation ceiling: $${brief.escalation.ceiling.toLocaleString()}, increment $${brief.escalation.increment.toLocaleString()}`,
      ...brief.terms.map((t) => `${t.term}: ${t.action} — tradeoff: ${t.tradeoff}`),
    ]
    const briefCopy = await generatePersonaCopy(
      {
        goal:
          "an internal escalation-strategy brief for the buyer's agent: how high to go (escalation ceiling + cap rationale), escalation-clause logic, and which terms to tighten with tradeoffs",
        facts: briefFacts,
        channel: "portal",
        persona: { audience: "agent", situation: "buyer's agent preparing a competitive offer on an outside listing" },
        words: 160,
      },
      { body: brief.agentBriefBody },
      { generator: opts.copyGenerator },
    )
    const briefRes = await proposeClientMessage(
      {
        brokerageId,
        agentKind: "shopping_agent",
        entityType: "bidding_war_escalation",
        entityId: ctx.offerId,
        recipientContactId: null,
        audience: "agent",
        subject: `⚔️ Bidding-war prep — ${ctx.propertyAddress ?? "an external listing"}`,
        body: briefCopy.body,
        rationale: `BIDDING WAR — escalation brief for ${buyerName ?? "the buyer"}'s offer on an outside listing; ceiling + term levers, agent-gated.`,
        channel: "portal",
      },
      supabase,
    )
    if (briefRes.ok) result.escalationBriefs += 1

    // ── 2) DEAL COORDINATOR — the buyer-voice "highest-and-best" cover letter DRAFT
    //       (audience 'buyer' — proposed for the BUYER to approve). FAIR HOUSING enforced.
    const letterFallback =
      `Dear Seller,\n\n` +
      `We're genuinely excited about your home and have put forward our strongest offer. ` +
      `We've structured it to be clean and dependable — a serious earnest-money deposit, a clear path to closing, ` +
      `and flexibility on timing to fit your plans. We're ready to move quickly and work in good faith to make this ` +
      `a smooth transaction for you. Thank you for considering our offer.\n\nSincerely,\n${sanitizeProperNoun(buyerName, 60) ?? "The Buyers"}`
    const letterCopy = await generatePersonaCopy(
      {
        goal:
          "a brief 'highest-and-best' cover letter in the BUYER'S OWN VOICE, addressed to the seller, that makes the case to accept this offer. " +
          "CONSTRAINTS: keep it strictly about the OFFER'S STRENGTH (price commitment, earnest money, clean terms, flexible/quick close, good faith). " +
          "DO NOT include any personal, family, religious, or lifestyle appeals; DO NOT mention children, family status, religion, or say things like 'we'll raise our kids here' or 'this is our forever home for our family' — this would violate Fair Housing. No protected-class or steering language whatsoever.",
        facts: [
          "The buyer has submitted a strong, competitive offer",
          "The offer includes serious earnest money and a clean, dependable structure",
          "The buyer is flexible on the closing timeline to fit the seller's needs",
          "The buyer is ready to move quickly and act in good faith",
        ],
        channel: "portal",
        persona: {
          name: buyerName,
          audience: "buyer",
          situation: contact.buyer_stage ?? "buyer making a competitive offer on an external listing",
        },
        words: 130,
      },
      { body: letterFallback },
      { generator: opts.copyGenerator },
    )
    const letterRes = await proposeClientMessage(
      {
        brokerageId,
        agentKind: "deal_coordinator",
        entityType: "bidding_war_cover_letter",
        entityId: ctx.offerId,
        recipientContactId: ctx.buyerContactId,
        audience: "buyer",
        subject: `Your offer letter to the seller — ${ctx.propertyAddress ?? "your offer"} (draft to approve)`,
        body: letterCopy.body,
        rationale:
          "BIDDING WAR — buyer-voice highest-and-best cover letter DRAFT for the buyer to approve; Fair-Housing constrained (offer strength only, no protected-class appeals).",
        channel: "portal",
      },
      supabase,
    )
    if (letterRes.ok) result.coverLetters += 1

    // ── 3) CAMPAIGN ORCHESTRATOR — rapport/availability note to the OUTSIDE listing agent
    //       (audience 'agent' — a DRAFT our agent can send).
    const outsideAgent = sanitizeProperNoun(ctx.listingAgentName, 60)
    const noteFallback =
      `Hi${outsideAgent ? ` ${outsideAgent}` : ""},\n\n` +
      `I'm representing the buyer on ${ctx.propertyAddress ?? "your listing"} and wanted to introduce myself. ` +
      `My buyer is serious and well-prepared, and we've put together a strong, clean offer. ` +
      `I'm very responsive — please reach out anytime with questions or if you need anything to move things forward. ` +
      `Looking forward to working with you.\n\nBest regards,`
    const noteCopy = await generatePersonaCopy(
      {
        goal:
          "a brief, warm, professional rapport + availability note from the buyer's agent to the OUTSIDE listing agent — introduce yourself, note the buyer is serious with a clean offer, and emphasize responsiveness/availability. Professional and collegial; no pressure, no personal appeals.",
        facts: [
          outsideAgent ? `The outside listing agent is ${outsideAgent}` : "Addressing the outside listing agent",
          ctx.propertyAddress ? `The listing is ${ctx.propertyAddress}` : "Regarding their listing",
          "Our buyer is serious, well-prepared, and has submitted a strong, clean offer",
          "We are highly responsive and available to keep the deal moving",
        ],
        channel: "portal",
        persona: { audience: "agent", situation: "buyer's agent reaching out to the outside listing agent" },
        words: 90,
      },
      { body: noteFallback },
      { generator: opts.copyGenerator },
    )
    const noteRes = await proposeClientMessage(
      {
        brokerageId,
        agentKind: "campaign_orchestrator",
        entityType: "bidding_war_outside_agent_note",
        entityId: ctx.offerId,
        recipientContactId: null,
        audience: "agent",
        subject: `Note to the listing agent — ${ctx.propertyAddress ?? "external listing"} (draft to send)`,
        body: noteCopy.body,
        rationale:
          "BIDDING WAR — rapport/availability note to the OUTSIDE listing agent; a draft the agent can review and send.",
        channel: "portal",
      },
      supabase,
    )
    if (noteRes.ok) result.outsideAgentNotes += 1

    // ── THE BUS — the convening line (the Command Center shows the bench converge).
    const conv = await publishManagerSignal(
      {
        brokerageId,
        fromManager: "shopping_agent",
        toManager: "deal_coordinator",
        signalType: "bidding_war_convened",
        message: `Bidding-war concierge convened for ${buyerName ?? "a buyer"} on ${ctx.propertyAddress ?? "an external listing"}: escalation brief (ceiling $${brief.escalation.ceiling.toLocaleString()}), buyer-voice cover-letter draft, and outside-agent note staged — all human-gated.`,
        entityType: "offer",
        entityId: ctx.offerId,
      },
      supabase,
    )
    if (conv.ok && conv.signalId && !conv.reason) {
      result.signalsPublished += 1
      await supabase
        .from("manager_signals")
        .update({ status: "consumed", consumed_at: (opts.now ?? new Date()).toISOString(), consumed_action: "bidding-war bundle staged (gated)" })
        .eq("id", conv.signalId)
    }

    if (briefRes.ok || letterRes.ok || noteRes.ok) result.bundles += 1
  }

  return result
}
