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
 *
 * Wave 14 — TWO ENTRY POINTS, ONE PRODUCER. The journey-stage lane (no property) is
 * unchanged: one brief per buyer journey. The BUTTON lane (the buyer clicked "help me make
 * an offer" ON a specific home) now names that home, so:
 *   · the plan the agent receives is about the property that was actually asked about
 *     (it used to be built from whatever sat at the top of the buyer's saved list), and
 *   · idempotency is keyed per (buyer, property) instead of per buyer, so the second
 *     property produces a second brief while the same property twice produces one.
 * Every outcome is NAMED (`outcome`), because `proposed: 0` used to mean six different
 * things — "already briefed", "the read was refused", and "this buyer has no saved homes"
 * were indistinguishable, and the caller told the buyer a plan was being prepared either way.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { sanitizeProperNoun } from "@/lib/compliance/client-text-guard"

/** entity_type on the gate row — one vocabulary for both lanes. */
export const OFFER_STRATEGY_BRIEF_ENTITY_TYPE = "offer_strategy_brief"

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The property a buyer explicitly asked about — the portal route's `[propertyId]`,
 *  which is a `saved_properties.id`. Absent for the journey-stage lane. */
export interface OfferStrategyTarget {
  savedPropertyId: string
  /** what the buyer was looking at when they asked (used when the row carries no address). */
  propertyAddress?: string | null
}

/**
 * Why a run ended. `proposed: 0` is never self-explanatory — pre-rollout every table is
 * empty, so "nothing came back" is not health. Callers MUST branch on this before telling
 * a client anything.
 */
export type OfferStrategyOutcome =
  | "proposed"            // a brief was written to the gate for the agent to approve
  | "already_proposed"    // one already exists for this (buyer, property) — a no-op, not a failure
  | "invalid_input"       // no tenant / no contact / a property id that is not a property id
  | "contact_unreadable"  // the contacts read was REFUSED (not "no such buyer")
  | "contact_not_found"   // the read succeeded and the buyer genuinely is not there
  | "wrong_tenant"        // the buyer belongs to another brokerage
  | "dedupe_unreadable"   // the idempotency probe was refused — fail CLOSED, never double-propose
  | "propose_failed"      // the gate row could not be written

export interface OfferStrategyResult {
  proposed: number
  outcome: OfferStrategyOutcome
  /** the address the brief is actually ABOUT, when a property was named. */
  propertyAddress: string | null
}

/** Pure: the buyer-safe "you're ready to make an offer — here's the plan" copy. */
export function buildOfferStrategyMessage(agentName: string): { subject: string; body: string } {
  const safeName = sanitizeProperNoun(agentName, 60) ?? "Your Agent"
  return {
    subject: "You're ready to make an offer — let's build your strategy",
    body: `You're in a strong spot to write an offer. Before we do, let's line up the essentials: I'll pull recent comparable sales so your number is grounded, we'll set your price and terms (timeline, contingencies, earnest money), and map how we respond if it's competitive. When you spot the home, we move fast and from a position of strength. Reply and we'll set a time to finalize your plan. — ${safeName}`,
  }
}

/**
 * THE BUYER-FACING PROMISE, DERIVED FROM WHAT ACTUALLY HAPPENED — pure.
 *
 * The button used to tell every buyer "your agent is preparing your offer plan" even on the
 * runs that produced nothing. One map, one source of truth: a plan is only ever promised on
 * the outcome that actually wrote one, and NO variant carries a price — the recommended
 * number is the agent's to deliver after they approve the brief (this product's egress
 * contract). The agent's own notification is derived from the same outcome so the two can
 * never disagree.
 */
export type OfferHelpOutcome = OfferStrategyOutcome | "no_tenant" | "accelerator_error"

export interface OfferHelpAcknowledgement {
  /** true ONLY when a brief really landed in the gate for this property. */
  planPrepared: boolean
  /** true when this exact property was already asked about — a no-op, not a failure. */
  duplicate: boolean
  agentTitle: string
  agentBody: string
  /** durable message written to the buyer's own portal thread. Never a price. */
  buyerMessage: string
  /** what the button says back, in the same words as the durable message. */
  clientMessage: string
}

export function buildOfferHelpAcknowledgement(input: {
  buyerFirstName?: string | null
  propertyAddress?: string | null
  outcome: OfferHelpOutcome
}): OfferHelpAcknowledgement {
  const who = sanitizeProperNoun(input.buyerFirstName ?? null, 60) ?? "Your buyer"
  const rawAddress = (input.propertyAddress ?? "").trim()
  const address = sanitizeProperNoun(rawAddress, 120) ?? "the home they're looking at"
  const onHome = rawAddress ? ` on ${address}` : ""
  const planPrepared = input.outcome === "proposed"
  const duplicate = input.outcome === "already_proposed"

  // What the BUYER is told. The only sentence that survives every branch is the one that is
  // always true: their agent has the request and will be in touch. Nothing here states or
  // implies a number, and nothing claims a plan exists unless one does.
  const asked = `You asked for help making an offer${onHome}.`
  const inTouch = "Your agent has been notified and will be in touch to walk you through price and terms."
  const notSubmitted = "Nothing has been sent to the seller — your agent writes and submits the offer with you."
  const buyerMessage = planPrepared
    ? `${asked} ${inTouch} They're preparing your offer plan now and will bring you their recommendation. ${notSubmitted}`
    : duplicate
    ? `You've already asked for help making an offer${onHome}, so we haven't sent your agent a second alert. They have your request and will be in touch. ${notSubmitted}`
    : `${asked} ${inTouch} ${notSubmitted}`

  // What the AGENT is told. "The offer plan is being prepared for your review" is now said
  // only when a brief is genuinely waiting in the Command Center.
  const agentBody = planPrepared
    ? `${who} asked for help writing an offer${onHome}. The offer plan for this home is waiting in your approval queue.`
    : duplicate
    ? `${who} asked again about writing an offer${onHome}. The plan for this home is already in your approval queue.`
    : `${who} asked for help writing an offer${onHome}. No plan could be drafted automatically — reach out and build it with them.`

  return {
    planPrepared,
    duplicate,
    agentTitle: "Buyer wants to make an offer",
    agentBody,
    buyerMessage,
    clientMessage: buyerMessage,
  }
}

/** PURE. Flatten a saved_properties row (+ its optional in-house listing join) into the
 *  shape the pure target picker reads. One mapping for both lanes. */
function flattenSavedRow(r: any) {
  const l = Array.isArray(r?.listings) ? r.listings[0] : r?.listings
  return {
    listing_id: r?.listing_id ?? null,
    external_property_id: r?.external_property_id ?? null,
    source: r?.source ?? null,
    saved_at: r?.saved_at ?? null,
    dismissed: r?.dismissed ?? null,
    list_price: (typeof r?.list_price === "number" ? r.list_price : null) ?? l?.list_price ?? null,
    listing_url: r?.listing_url ?? null,
    property_address: r?.property_address ?? null,
    status: l?.status ?? (r?.listing_id ? null : "active"),
    listing_date: l?.listing_date ?? null,
  }
}

const SAVED_PROPERTY_COLUMNS =
  "listing_id, external_property_id, source, list_price, listing_url, property_address, saved_at, dismissed, listings(list_price, status, listing_date)"

/**
 * Propose an offer-strategy brief to the buyer into the client_message gate.
 *
 * Idempotent per (buyer, property) when a property is named — the button is per property,
 * so keying on the buyer alone silently produced NOTHING from the second click onward.
 * Idempotent per buyer when none is named (the journey-stage lane, unchanged).
 */
export async function produceOfferStrategyBrief(
  brokerageId: string, contactId: string, client?: ReturnType<typeof createServiceClient>,
  target?: OfferStrategyTarget | null,
): Promise<OfferStrategyResult> {
  const supabase = client ?? createServiceClient()
  // The property the buyer actually asked about. It keys idempotency AND grounds the plan;
  // entity_id is a uuid column, so a non-uuid would be dropped to null and silently collapse
  // every property onto one brief again — refuse it instead.
  const savedPropertyId = target?.savedPropertyId?.trim() || null
  let propertyAddress = target?.propertyAddress?.trim() || null
  if (!brokerageId || !contactId) return { proposed: 0, outcome: "invalid_input", propertyAddress }
  if (savedPropertyId && !UUID_RE.test(savedPropertyId)) {
    console.error("[offer-strategy-producer] property reference is not a saved-property id:", savedPropertyId)
    return { proposed: 0, outcome: "invalid_input", propertyAddress }
  }
  const briefEntityId = savedPropertyId ?? contactId

  // DESTRUCTURE `error`: supabase-js RESOLVES a refused read, so `const { data: c }` alone
  // reported a denied read as "no such buyer" and the caller as "nothing to prepare".
  const { data: c, error: contactError } = await supabase
    .from("contacts").select("id, brokerage_id, agent_id, first_name").eq("id", contactId).maybeSingle()
  if (contactError) {
    console.error("[offer-strategy-producer] contact read refused:", contactError.message)
    return { proposed: 0, outcome: "contact_unreadable", propertyAddress }
  }
  const contact = c as { id: string; brokerage_id: string | null; agent_id: string | null; first_name: string | null } | null
  if (!contact) return { proposed: 0, outcome: "contact_not_found", propertyAddress }
  if (contact.brokerage_id !== brokerageId) return { proposed: 0, outcome: "wrong_tenant", propertyAddress }

  let agentName = "Your Agent"
  let agentUserId: string | null = null
  if (contact.agent_id) {
    const { data: a, error: agentError } = await supabase.from("agents").select("user_id").eq("id", contact.agent_id).maybeSingle()
    if (agentError) console.error("[offer-strategy-producer] agent read refused:", agentError.message)
    agentUserId = (a as { user_id: string | null } | null)?.user_id ?? null
    if (agentUserId) {
      const { data: u, error: userError } = await supabase.from("users").select("first_name, last_name").eq("id", agentUserId).maybeSingle()
      if (userError) console.error("[offer-strategy-producer] agent user read refused:", userError.message)
      const full = [(u as any)?.first_name, (u as any)?.last_name].filter(Boolean).join(" ").trim()
      if (full) agentName = full
    }
  }

  // Idempotent per (buyer, property) — or per buyer journey when no property was named.
  // A REFUSED probe fails CLOSED: we cannot prove a brief is absent, so we do not write one.
  const { data: existing, error: existingError } = await supabase.from("agent_client_messages")
    .select("id").eq("brokerage_id", brokerageId).eq("entity_type", OFFER_STRATEGY_BRIEF_ENTITY_TYPE)
    .eq("entity_id", briefEntityId).eq("recipient_contact_id", contactId)
    .in("status", ["proposed", "approved", "sent"]).maybeSingle()
  if (existingError) {
    console.error("[offer-strategy-producer] idempotency probe refused; refusing to propose:", existingError.message)
    return { proposed: 0, outcome: "dedupe_unreadable", propertyAddress }
  }
  if (existing) return { proposed: 0, outcome: "already_proposed", propertyAddress }

  // Shared read: the buyer's financing profile — grounds BOTH the strategy's max budget AND the
  // honest letter-strength note below. Same buyer_financial_profiles row the pre-approval record
  // sourcing reads; the OS records no explicit pre-qual vs pre-approval letter TYPE, so strength
  // keys off verified/letter-on-file/expiry (see lib/financing/letter-strength.ts).
  type FinProfileRow = { is_cash_buyer: boolean | null; verified: boolean | null; pre_approval_amount: number | null; pre_approval_letter_doc_id: string | null; pre_approval_expires_at: string | null; pre_approval_lender: string | null }
  let finProfile: FinProfileRow | null = null
  try {
    const { data: fin, error: finError } = await supabase.from("buyer_financial_profiles")
      .select("is_cash_buyer, verified, pre_approval_amount, pre_approval_letter_doc_id, pre_approval_expires_at, pre_approval_lender")
      .eq("contact_id", contactId).maybeSingle()
    if (finError) console.error("[offer-strategy-producer] financing profile read refused:", finError.message)
    finProfile = (fin as FinProfileRow | null) ?? null
  } catch { /* best-effort — a missing profile degrades to the no-letter note */ }

  // ── OFFER ACCELERATOR — fill the formerly-empty offer-strategy moment with a REAL,
  //    comps/market-grounded plan. Detect the buyer's hot target (most-recent active saved
  //    listing), ground the strategy in its real list price + days-on-market + the buyer's
  //    pre-approval, and hand the AGENT a concrete recommended offer (price + range + terms)
  //    instead of "go pull comps yourself." Numbers are gateway-generated from real facts;
  //    a missing target/budget degrades honestly to the generic brief. ──
  let strategySummary: string | null = null
  let targetUnusable = false
  // The address the plan was ACTUALLY grounded in — read off the row the strategy used, never
  // off the caller's input. Naming the clicked address over a plan built from a different home
  // is the W1 defect wearing the right label, which is worse than an unlabelled plan.
  let groundedAddress: string | null = null
  try {
    // WHICH property. When the buyer asked ABOUT one (the button), the plan is grounded in
    // THAT row — not in whatever happens to sit at the top of their saved list, which is what
    // the agent used to receive under a notification naming a different address. With no named
    // property (the journey-stage lane) the hot target is still detected from the saved list.
    //
    // Both IN-HOUSE (listing_id → listings) AND EXTERNAL (RentCast/IDX — list_price + url stored
    // on the row itself, listing_id null) targets. Most buyers shop the whole market, so the
    // external case is the common one. Coalesce the price (row first, then the in-house
    // listing); DOM comes only from the in-house listing (external is honestly unknown).
    let savedRows: any[] = []
    if (savedPropertyId) {
      const { data: one, error: oneError } = await supabase
        .from("saved_properties").select(SAVED_PROPERTY_COLUMNS)
        .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("id", savedPropertyId).maybeSingle()
      if (oneError) console.error("[offer-strategy-producer] saved-property read refused:", oneError.message)
      savedRows = one ? [one] : []
      propertyAddress = ((one as any)?.property_address as string | null)?.trim() || propertyAddress
    } else {
      const { data: rows, error: rowsError } = await supabase
        .from("saved_properties").select(SAVED_PROPERTY_COLUMNS)
        .eq("brokerage_id", brokerageId).eq("contact_id", contactId).eq("dismissed", false)
        .order("saved_at", { ascending: false }).limit(10)
      if (rowsError) console.error("[offer-strategy-producer] saved-properties read refused:", rowsError.message)
      savedRows = (rows ?? []) as any[]
    }
    const flat = savedRows.map(flattenSavedRow)
    const { pickBuyerTargetListing, marketConditionsFromDom, motivationFromBuyer, resolveBuyerMaxBudget } =
      await import("@/lib/offers/offer-target")
    const hotTarget = pickBuyerTargetListing(flat, new Date())
    if (savedPropertyId && !hotTarget) targetUnusable = true
    if (hotTarget) {
      groundedAddress = hotTarget.address
      const { data: cfull } = await supabase.from("contacts")
        .select("timeline, motivation_type, buyer_stage").eq("id", contactId).maybeSingle()
      // The ceiling is the buyer's REAL pre-approval or nothing — resolveBuyerMaxBudget no
      // longer fabricates a %-of-list budget (owner correction: loan figures come from the
      // pre-approval or the lender). No pre-approval → the generic brief below, honestly.
      const maxBudget = resolveBuyerMaxBudget(finProfile?.pre_approval_amount ?? null, hotTarget.listPrice)
      if (maxBudget) {
        const { generateBuyerOfferStrategy, summarizeOfferStrategy } =
          await import("@/lib/offers/offer-strategy-advisor")
        const strategy = await generateBuyerOfferStrategy({
          listPrice: hotTarget.listPrice,
          daysOnMarket: hotTarget.daysOnMarket,
          marketConditions: marketConditionsFromDom(hotTarget.daysOnMarket),
          buyerMotivation: motivationFromBuyer((cfull as any) ?? {}),
          buyerMaxBudget: maxBudget,
        })
        if (strategy) {
          // Provenance — downstream math names its source, the OS's own discipline.
          const lender = finProfile?.pre_approval_lender ?? null
          strategySummary = `${summarizeOfferStrategy(strategy)} Budget ceiling $${maxBudget.toLocaleString()} per the buyer's pre-approval${lender ? ` from ${lender}` : ""}.`
        }
      }
    }
  } catch (e) {
    console.error("[offer-strategy-producer] strategy assembly failed; generic brief:", e)
  }

  // AI-generated, brand-voiced copy (THEM-FIRST, compliance-gated, NO fabricated price);
  // deterministic fallback only if the gateway is down — or if the copy module itself cannot
  // load in this runtime (it is server-only), which must degrade to the neutral template
  // rather than lose the brief the agent is waiting for.
  const askedAbout = (groundedAddress ?? propertyAddress) ? ` They asked about ${groundedAddress ?? propertyAddress}.` : ""
  let msg: { subject: string; body: string }
  try {
    const { generateClientMessage } = await import("@/lib/agents/generate-client-message")
    msg = await generateClientMessage({
      brokerageId, agentUserId, audience: "buyer",
      purpose: `The buyer is ready to write an offer.${askedAbout} Lay out the game plan — grounding their number in recent comparable sales and setting price + terms (timeline, contingencies, earnest money) — and invite them to finalize the plan together.`,
      recipientFirstName: contact.first_name,
      allowNumbers: false,
      ctas: ["Review recent comparable sales together", "Set your price and terms", "Map how we respond if it's competitive"],
      fallback: buildOfferStrategyMessage(agentName),
    })
  } catch (e) {
    console.error("[offer-strategy-producer] client-message generation unavailable; neutral template:", e)
    msg = buildOfferStrategyMessage(agentName)
  }
  // MOMENT-OF-TRUTH HONESTY — if the buyer is about to offer with only a pre-qual-strength letter
  // (unverified), no letter, or an expired one, the AGENT brief says so plainly. Deterministic,
  // agent-facing only (the buyer-facing copy stays warm; the coaching happens through the agent
  // and the pre-qual vs pre-approval education modules).
  const { assessFinancingLetterStrength } = await import("@/lib/financing/letter-strength")
  const letterNote = assessFinancingLetterStrength(finProfile ? {
    isCashBuyer: finProfile.is_cash_buyer,
    verified: finProfile.verified,
    preApprovalAmount: finProfile.pre_approval_amount,
    preApprovalLetterDocId: finProfile.pre_approval_letter_doc_id,
    preApprovalExpiresAt: finProfile.pre_approval_expires_at,
  } : null).agentNote

  // The agent sees the CONCRETE plan in the rationale (real, comps-grounded numbers) and WHICH
  // HOME it is for; the buyer-facing copy stays warm + number-free until the agent reviews and
  // releases it. The recommended price never travels to the buyer un-approved.
  // What the agent's brief says it is about is what the plan is built from.
  const planAddress = groundedAddress ?? propertyAddress
  if (!propertyAddress) propertyAddress = groundedAddress
  const about = planAddress ? ` for ${planAddress}` : ""
  const opening = savedPropertyId
    ? `Buyer asked for help writing an offer${about}.`
    : `Buyer reached offer-strategy stage${about}.`
  const unusableNote = targetUnusable
    ? " Their saved record for this home carries no usable list price, so the plan below is generic — confirm the price with them."
    : ""
  const baseRationale = strategySummary
    ? `${opening} AI offer plan (review before sending): ${strategySummary}`
    : `${opening} Propose the offer game plan before they write.${unusableNote}`
  const rationale = letterNote ? `${baseRationale} ${letterNote}` : baseRationale

  // entity_id carries the PROPERTY when one was named — that is what makes the gate row
  // idempotent per (buyer, property) instead of per buyer.
  const proposal = {
    brokerageId, agentKind: "shopping_agent", entityType: OFFER_STRATEGY_BRIEF_ENTITY_TYPE,
    entityId: briefEntityId, recipientContactId: contactId, audience: "buyer" as const,
    subject: msg.subject, body: msg.body, rationale, channel: "portal" as const,
  }
  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  const r = await proposeClientMessage(proposal, supabase)
  if (!r.ok) {
    // No brief, no reel: nothing downstream is commissioned for a plan that was not written.
    console.error("[offer-strategy-producer] brief could not be proposed:", r.error)
    return { proposed: 0, outcome: "propose_failed", propertyAddress }
  }

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
  return { proposed: 1, outcome: "proposed", propertyAddress }
}
