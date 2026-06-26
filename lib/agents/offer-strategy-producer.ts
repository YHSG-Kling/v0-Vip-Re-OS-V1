/**
 * lib/agents/offer-strategy-producer.ts
 *
 * Wave 57 — buyer-side AUTO-handoff (mirrors the tour-completed follow-up). When a buyer
 * reaches the `offer_strategy` journey stage (KernelEvent.OFFER_STRATEGY_RECOMMENDED) —
 * the "ready to write an offer" moment — nothing reacted before. This auto-proposes a
 * concrete offer-strategy brief to the buyer into the client_message deliverable gate
 * (Shopping Agent owns it; the human reviews/edits before it sends). Zero agent effort;
 * idempotent per buyer journey. No protected-class language, no fabricated numbers — the
 * agent fills in the comps/price in review.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

export interface OfferStrategyResult { proposed: number }

/** Pure: the buyer-safe "you're ready to make an offer — here's the plan" copy. */
export function buildOfferStrategyMessage(agentName: string): { subject: string; body: string } {
  const safeName = sanitizeProperNoun(agentName, 60) ?? "Your Agent"
  return {
    subject: "You're ready to make an offer — let's build your strategy",
    body: `You're in a strong spot to write an offer. Before we do, let's line up the essentials: I'll pull recent comparable sales so your number is grounded, we'll set your price and terms (timeline, contingencies, earnest money), and map how we respond if it's competitive. When you spot the home, we move fast and from a position of strength. Reply and we'll set a time to finalize your plan. — ${safeName}`,
  }
}

/**
 * Propose an offer-strategy brief to the buyer into the client_message gate.
 * Idempotent per (contact) — `offer_strategy` is a once-per-journey stage milestone.
 */
export async function produceOfferStrategyBrief(
  brokerageId: string, contactId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<OfferStrategyResult> {
  const supabase = client ?? createServiceClient()
  if (!brokerageId || !contactId) return { proposed: 0 }

  const { data: c } = await supabase
    .from("contacts").select("id, brokerage_id, agent_id, first_name").eq("id", contactId).maybeSingle()
  const contact = c as { id: string; brokerage_id: string | null; agent_id: string | null; first_name: string | null } | null
  if (!contact || contact.brokerage_id !== brokerageId) return { proposed: 0 }

  let agentName = "Your Agent"
  let agentUserId: string | null = null
  if (contact.agent_id) {
    const { data: a } = await supabase.from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
    agentUserId = (a as { user_id: string | null } | null)?.user_id ?? null
    if (agentUserId) {
      const { data: u } = await supabase.from("users").select("first_name, last_name").eq("id", agentUserId).maybeSingle()
      const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
      if (full) agentName = full
    }
  }

  // Idempotent — one offer-strategy brief per buyer journey.
  const { data: existing } = await supabase.from("agent_client_messages")
    .select("id").eq("brokerage_id", brokerageId).eq("entity_type", "offer_strategy_brief")
    .eq("entity_id", contactId).eq("recipient_contact_id", contactId)
    .in("status", ["proposed", "approved", "sent"]).maybeSingle()
  if (existing) return { proposed: 0 }

  // ── OFFER ACCELERATOR — fill the formerly-empty offer-strategy moment with a REAL,
  //    comps/market-grounded plan. Detect the buyer's hot target (most-recent active saved
  //    listing), ground the strategy in its real list price + days-on-market + the buyer's
  //    pre-approval, and hand the AGENT a concrete recommended offer (price + range + terms)
  //    instead of "go pull comps yourself." Numbers are gateway-generated from real facts;
  //    a missing target/budget degrades honestly to the generic brief. ──
  let strategySummary: string | null = null
  try {
    // Both IN-HOUSE (listing_id → listings) AND EXTERNAL (RentCast/IDX — list_price + url stored
    // on the saved_properties row itself, listing_id null) targets. Most buyers shop the whole
    // market, so the external case is the common one. Coalesce the price (row first, then the
    // in-house listing); DOM comes only from the in-house listing (external is honestly unknown).
    const { data: savedRows } = await supabase
      .from("saved_properties")
      .select("listing_id, external_property_id, source, list_price, listing_url, property_address, saved_at, dismissed, listings(list_price, status, listing_date)")
      .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("dismissed", false)
      .order("saved_at", { ascending: false }).limit(10)
    const flat = ((savedRows ?? []) as any[]).map((r) => {
      const l = Array.isArray(r.listings) ? r.listings[0] : r.listings
      return {
        listing_id: r.listing_id, external_property_id: r.external_property_id, source: r.source,
        saved_at: r.saved_at, dismissed: r.dismissed,
        list_price: (typeof r.list_price === "number" ? r.list_price : null) ?? l?.list_price ?? null,
        listing_url: r.listing_url ?? null, property_address: r.property_address ?? null,
        status: l?.status ?? (r.listing_id ? null : "active"), listing_date: l?.listing_date ?? null,
      }
    })
    const { pickBuyerTargetListing, marketConditionsFromDom, motivationFromBuyer, resolveBuyerMaxBudget } =
      await import("@/lib/offers/offer-target")
    const target = pickBuyerTargetListing(flat, new Date())
    if (target) {
      const { data: fin } = await supabase.from("buyer_financial_profiles")
        .select("pre_approval_amount").eq("contact_id", contactId).maybeSingle()
      const { data: cfull } = await supabase.from("contacts")
        .select("timeline, motivation_type, buyer_stage").eq("id", contactId).maybeSingle()
      const maxBudget = resolveBuyerMaxBudget((fin as any)?.pre_approval_amount ?? null, target.listPrice)
      if (maxBudget) {
        const { generateBuyerOfferStrategy, summarizeOfferStrategy } =
          await import("@/lib/offers/offer-strategy-advisor")
        const strategy = await generateBuyerOfferStrategy({
          listPrice: target.listPrice,
          daysOnMarket: target.daysOnMarket,
          marketConditions: marketConditionsFromDom(target.daysOnMarket),
          buyerMotivation: motivationFromBuyer((cfull as any) ?? {}),
          buyerMaxBudget: maxBudget,
        })
        if (strategy) strategySummary = summarizeOfferStrategy(strategy)
      }
    }
  } catch (e) {
    console.error("[offer-strategy-producer] strategy assembly failed; generic brief:", e)
  }

  // AI-generated, brand-voiced copy (THEM-FIRST, compliance-gated, NO fabricated price);
  // deterministic fallback only if the gateway is down.
  const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
  const msg = await generateClientMessage({
    brokerageId, agentUserId, audience: "buyer",
    purpose: "The buyer is ready to write an offer. Lay out the game plan — grounding their number in recent comparable sales and setting price + terms (timeline, contingencies, earnest money) — and invite them to finalize the plan together.",
    recipientFirstName: contact.first_name,
    allowNumbers: false,
    ctas: ["Review recent comparable sales together", "Set your price and terms", "Map how we respond if it's competitive"],
    fallback: buildOfferStrategyMessage(agentName),
  })
  // The agent sees the CONCRETE plan in the rationale (real, comps-grounded numbers); the
  // buyer-facing copy stays warm + number-free until the agent reviews and releases it.
  const rationale = strategySummary
    ? `Buyer reached offer-strategy stage. AI offer plan (review before sending): ${strategySummary}`
    : "Buyer reached offer-strategy stage — propose the offer game plan before they write."

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const r = await proposeClientMessage({
    brokerageId, agentKind: "shopping_agent", entityType: "offer_strategy_brief", entityId: contactId,
    recipientContactId: contactId, audience: "buyer", subject: msg.subject, body: msg.body,
    rationale, channel: "portal",
  }, supabase)

  // TEAM PLAY — pair the analytical plan with a human push: hand off to the Asset Manager to
  // commission a personal "offer confidence" reel (number-free, fronted by the assigned agent).
  // The reel rides the gated 1:1 email + portal CTA on completion. Managers working together to
  // get the buyer over the line, not a solo brief.
  try {
    const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
    await publishManagerSignal({
      brokerageId, fromManager: "shopping_agent", toManager: "asset_manager",
      signalType: "offer_confidence_reel_handoff",
      message: "A buyer reached the offer-strategy moment — commissioning a personal offer-confidence reel to pair with the plan.",
      entityType: "contact", entityId: contactId, contactId,
      payload: { audience: "buyer" },
    }, supabase)
  } catch (e) {
    console.error("[offer-strategy-producer] offer-confidence reel handoff failed:", e)
  }
  return { proposed: r.ok ? 1 : 0 }
}
