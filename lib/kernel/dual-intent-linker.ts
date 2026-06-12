// lib/kernel/dual-intent-linker.ts
//
// DUAL-INTENT LINKER — ONE contact who is BOTH a seller AND a buyer (the owner's
// "must sell to buy" case): a person wants to buy but has to sell their current
// home first. The team must work this ONE person across BOTH journeys without
// losing context, and the buyer journey is typically GATED on / sequenced after
// the seller's sale closing (the sale funds the purchase).
//
// WHAT THIS REUSES (no new tables, no new columns — honors both contracts):
//   · contacts.contact_type = 'both'  — the canonical dual vocabulary the CHECK
//     constraint already allows AND that every downstream consumer already honors:
//       - event-reactor.ts spawns BOTH the Shopping Agent (buyer) AND the Listing
//         Concierge (seller) for a 'both' contact (lib/kernel/event-reactor L208-215);
//       - both agents accept 'both' (shopping-agent L150 / listing-concierge L141);
//       - communications.ts maps 'both' → "dual" tone.
//     The GAP this module fills: the lead→contact spine NEVER actually WRITES
//     'both' (motivationToContactType maps 'both'→'buyer'). So a person with both
//     a seller listing and buyer criteria stays mono-typed and only ONE manager
//     wakes up. linkDualJourneys closes that gap.
//   · journey_states — the canonical buyer/seller journey ROLLUP table
//     (LIFECYCLE_EVENT_CONTRACT §1: "journey_states.current_stage = buyer/seller
//     journey rollups"). The live table has a UNIQUE(user_id) constraint, so a
//     contact cannot have two rows keyed on the same user_id. We key ONE row PER
//     JOURNEY via a composite user_id (`${contactId}:buyer` / `${contactId}:seller`),
//     both pointing at the SAME contact_id, distinguished by `persona`. This is
//     how ONE contact carries TWO journeys without violating the constraint.
//   · transparency_updates via pushPortalValueCard — the existing idempotent
//     portal/agent-visible surface (no new table) for the actionable dependency.
//
// JOURNEY_PROGRESS_CONTRACT §70 already blesses this: "A contact may be both a
// buyer AND seller simultaneously with independent journeys." This module is the
// missing machinery that LINKS them and surfaces the cross-journey dependency.
//
// Dependency-light: imports only the service-client TYPE (like portal-value.ts),
// so cron, server actions, and the simulator can all import it. No "server-only".

import type { createServiceClient } from "@/lib/supabase/service"
import { pushPortalValueCard } from "./portal-value"

type Svc = ReturnType<typeof createServiceClient>

// ─── PUBLIC TYPES ─────────────────────────────────────────────────────────────

/** The two sides of one person's real-estate intent. */
export type IntentSide = "buyer" | "seller"

/**
 * Evidence that a contact has BUYER intent and/or SELLER intent. Pass the REAL
 * signals you have — a saved-search/criteria/financial-profile row on the buyer
 * side, a listing or seller contact_type on the seller side. Booleans are honest:
 * only set true when the underlying evidence exists.
 */
export interface DualIntentSignals {
  /** Buyer-side evidence present (e.g. property_preferences / buyer_financial_profiles / buyer_stage). */
  hasBuyerSignal: boolean
  /** Seller-side evidence present (e.g. a listings row this contact sells, or contact_type='seller'). */
  hasSellerSignal: boolean
}

/** A minimal view of the contact the detector reasons over (no DB read in the pure layer). */
export interface DualIntentContactView {
  contactType?: string | null
  /** 13-state buyer journey column. A non-prospect value is itself buyer evidence. */
  buyerStage?: string | null
}

/** The detector's verdict. */
export interface DualIntentVerdict {
  /** True only when BOTH sides have real signal. */
  isDual: boolean
  /** The sides that have signal (for honest reporting when only one is present). */
  sides: IntentSide[]
  /** Plain reason, e.g. "buyer+seller signal" or "buyer signal only". */
  reason: string
}

/** The buyer-side financial picture relevant to the sale→purchase dependency. */
export interface BuyerFinancialsView {
  /** True when the buyer pays cash and needs NO sale proceeds / financing. */
  isCashBuyer?: boolean | null
  /** True when the buyer's purchase REQUIRES the proceeds of selling their current home. */
  requiresSaleProceeds?: boolean | null
  /** A non-sale funding source exists (e.g. a verified pre-approval that does NOT
   *  depend on the sale, a bridge loan). When true, the purchase is NOT gated on the sale. */
  hasIndependentFunding?: boolean | null
}

/** The seller-side listing picture relevant to the dependency. */
export interface SellerListingView {
  /** The listing's lifecycle_stage (uppercase machine: … MLS_ACTIVE → UNDER_CONTRACT → CLOSED). */
  lifecycleStage?: string | null
}

/** Structured cross-journey dependency: does the SALE have to precede the PURCHASE? */
export interface SaleBeforeBuyDependency {
  /** True = the buyer journey is gated on the sale (sale funds the purchase). */
  gated: boolean
  /** Machine reason: why (or why not) it's gated. */
  reason:
    | "sale_funds_purchase"
    | "cash_buyer_not_gated"
    | "independent_funding_not_gated"
    | "no_sale_dependency"
  /** The seller-side stage that must be reached to UNGATE the buyer side (sale closed). */
  blockingStage: "CLOSED" | null
  /** True once the seller listing has reached the blocking stage (dependency satisfied). */
  satisfied: boolean
  /** Human-readable, portal-safe explanation. */
  explanation: string
}

// ─── LAYER 1: PURE DETECTORS (no I/O) ─────────────────────────────────────────

/**
 * detectDualIntent — is this ONE contact BOTH a buyer and a seller?
 *
 * Buyer evidence = an explicit buyer signal OR contact_type buyer/both OR a
 * buyer_stage that has moved past the initial prospect state. Seller evidence =
 * an explicit seller signal OR contact_type seller/both. Dual ONLY when BOTH
 * sides have evidence — honest: one side only → not dual.
 */
export function detectDualIntent(
  contact: DualIntentContactView,
  signals: DualIntentSignals,
): DualIntentVerdict {
  const ct = (contact.contactType ?? "").toLowerCase()
  const stage = (contact.buyerStage ?? "").toLowerCase()

  // A buyer_stage that exists and isn't the bare initial state is itself buyer evidence.
  const stageIsBuyerEvidence =
    stage.length > 0 && stage !== "prospect" && stage !== "buyer_contact_created"

  const hasBuyer =
    signals.hasBuyerSignal ||
    ct === "buyer" ||
    ct === "both" ||
    stageIsBuyerEvidence

  const hasSeller =
    signals.hasSellerSignal ||
    ct === "seller" ||
    ct === "both"

  const sides: IntentSide[] = []
  if (hasBuyer) sides.push("buyer")
  if (hasSeller) sides.push("seller")

  const isDual = hasBuyer && hasSeller
  const reason = isDual
    ? "buyer+seller signal"
    : hasBuyer
      ? "buyer signal only"
      : hasSeller
        ? "seller signal only"
        : "no intent signal"

  return { isDual, sides, reason }
}

/**
 * sellMustPrecedeBuy — the cross-journey dependency. For a "must sell to buy"
 * contact, the PURCHASE is typically contingent on the SALE closing (the sale
 * funds the purchase). Returns a structured dependency object.
 *
 *   · cash buyer                → NOT gated (cash_buyer_not_gated).
 *   · has independent funding   → NOT gated (independent_funding_not_gated).
 *   · requires sale proceeds    → GATED, blockingStage = CLOSED (sale_funds_purchase).
 *   · none of the above known   → NOT gated, honest "no_sale_dependency".
 *
 * `satisfied` is true once the seller listing has actually reached CLOSED — the
 * point at which the buyer side may proceed.
 */
export function sellMustPrecedeBuy(
  buyerFinancials: BuyerFinancialsView,
  sellerListing: SellerListingView,
): SaleBeforeBuyDependency {
  const sellerStage = (sellerListing.lifecycleStage ?? "").toUpperCase()
  const saleClosed = sellerStage === "CLOSED"

  // Cash buyer never depends on the sale.
  if (buyerFinancials.isCashBuyer) {
    return {
      gated: false,
      reason: "cash_buyer_not_gated",
      blockingStage: null,
      satisfied: true,
      explanation:
        "This buyer is paying cash, so their purchase does not depend on selling the current home first.",
    }
  }

  // Independent funding (sale-independent pre-approval / bridge loan) — not gated.
  if (buyerFinancials.hasIndependentFunding && !buyerFinancials.requiresSaleProceeds) {
    return {
      gated: false,
      reason: "independent_funding_not_gated",
      blockingStage: null,
      satisfied: true,
      explanation:
        "This buyer has funding that does not rely on the sale, so the purchase is not contingent on the sale closing.",
    }
  }

  // The "must sell to buy" case — the purchase needs the sale proceeds.
  if (buyerFinancials.requiresSaleProceeds) {
    return {
      gated: true,
      reason: "sale_funds_purchase",
      blockingStage: "CLOSED",
      satisfied: saleClosed,
      explanation: saleClosed
        ? "The current home has sold — the proceeds are available, so the purchase can now move forward."
        : "The purchase is contingent on selling the current home first: the sale proceeds fund the purchase. The buyer side is sequenced after the sale closes.",
    }
  }

  // No evidence the purchase depends on the sale.
  return {
    gated: false,
    reason: "no_sale_dependency",
    blockingStage: null,
    satisfied: true,
    explanation:
      "No dependency on file between selling the current home and the new purchase.",
  }
}

// ─── ROLLUP KEY HELPERS (pure) ────────────────────────────────────────────────

/**
 * The composite journey_states.user_id for one side of one contact's dual journey.
 * journey_states has UNIQUE(user_id); keying per (contact, side) lets ONE contact
 * carry TWO independent journey rollups without colliding.
 */
export function journeyUserKey(contactId: string, side: IntentSide): string {
  return `${contactId}:${side}`
}

// ─── LAYER 2: LIVE LINKER ─────────────────────────────────────────────────────

export interface LinkDualJourneysResult {
  /** True when both sides had signal and the link was ensured (or already present). */
  linked: boolean
  /** Why a link was NOT made (e.g. "not_dual", "contact_not_found"). */
  reason?: string
  /** The contact's contact_type after this call. */
  contactType?: string | null
  /** journey_states.id for the buyer-side rollup (when linked). */
  buyerJourneyId?: string
  /** journey_states.id for the seller-side rollup (when linked). */
  sellerJourneyId?: string
  /** The structured dependency stamped on both sides (when linked). */
  dependency?: SaleBeforeBuyDependency
  /** True when a portal/agent-visible dependency card was written this call. */
  dependencyCardPushed?: boolean
}

/**
 * linkDualJourneys — the LIVE linker. For ONE contact that genuinely has BOTH a
 * seller listing and buyer criteria, this:
 *   1. ensures contacts.contact_type = 'both' (waking BOTH concierges via the reactor),
 *   2. ensures BOTH journey_states rollup rows exist (buyer + seller) for the one
 *      contact, cross-linked to each other in metadata_json,
 *   3. computes + stamps the sale→buy dependency on both sides so each manager
 *      (Listing Concierge sells; Shopping Agent buys) sees the other journey and
 *      the gate, and
 *   4. when the dependency is gating, surfaces ONE idempotent portal/agent-visible
 *      card ("contingent on the sale") via the existing transparency_updates rail.
 *
 * IDEMPOTENT: re-running creates no duplicate journeys (upsert on user_id) and no
 * duplicate portal cards (pushPortalValueCard's 24h dedupe). HONEST: when only one
 * side has signal it is a NO-OP (returns linked:false, reason:"not_dual") — it
 * never fabricates a journey or a stage.
 */
export async function linkDualJourneys(
  contactId: string,
  client?: Svc,
): Promise<LinkDualJourneysResult> {
  if (!contactId) return { linked: false, reason: "missing_contact_id" }

  const supabase = client ?? (await import("@/lib/supabase/service")).createServiceClient()

  // ── Read the one contact + its real buyer/seller evidence ───────────────────
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, brokerage_id, contact_type, contact_persona, buyer_stage")
    .eq("id", contactId)
    .maybeSingle()

  if (!contact) return { linked: false, reason: "contact_not_found" }
  const brokerageId = (contact as any).brokerage_id as string | null

  // Seller evidence — a listing this contact is selling (any non-terminal-ish stage),
  // plus its lifecycle_stage for the dependency.
  const { data: listings } = await supabase
    .from("listings")
    .select("id, lifecycle_stage, status")
    .eq("seller_contact_id", contactId)
    .order("created_at", { ascending: false })
    .limit(1)
  const sellerListing = (listings ?? [])[0] ?? null

  // Buyer evidence — a saved-search / criteria row, or a financial profile.
  const [{ data: prefs }, { data: finProfile }] = await Promise.all([
    supabase.from("property_preferences").select("id").eq("contact_id", contactId).maybeSingle(),
    supabase
      .from("buyer_financial_profiles")
      .select("id, is_cash_buyer, finance_type, verified")
      .eq("contact_id", contactId)
      .maybeSingle(),
  ])

  const signals: DualIntentSignals = {
    hasBuyerSignal: !!prefs || !!finProfile,
    hasSellerSignal:
      !!sellerListing || (contact as any).contact_type === "seller",
  }

  const verdict = detectDualIntent(
    { contactType: (contact as any).contact_type, buyerStage: (contact as any).buyer_stage },
    signals,
  )

  // HONEST no-op when not genuinely dual.
  if (!verdict.isDual) {
    return { linked: false, reason: "not_dual", contactType: (contact as any).contact_type }
  }

  // ── Compute the cross-journey dependency from REAL data ─────────────────────
  // "must sell to buy" is not a stored column on buyer_financial_profiles; it's
  // derived honestly: a non-cash, non-independently-funded buyer who is ALSO
  // selling a home is the classic sale-funds-purchase case. We treat a cash buyer
  // as not gated; everyone else who is dual + selling is gated on the sale closing.
  const isCashBuyer = !!(finProfile as any)?.is_cash_buyer
  const dependency = sellMustPrecedeBuy(
    {
      isCashBuyer,
      // dual + selling + not cash → the purchase needs the sale proceeds.
      requiresSaleProceeds: !isCashBuyer,
      hasIndependentFunding: false,
    },
    { lifecycleStage: (sellerListing as any)?.lifecycle_stage ?? null },
  )

  // ── 1. Ensure contact_type = 'both' (idempotent) ────────────────────────────
  let contactType = (contact as any).contact_type as string | null
  if (contactType !== "both") {
    const { error: ctErr } = await supabase
      .from("contacts")
      .update({ contact_type: "both", updated_at: new Date().toISOString() })
      .eq("id", contactId)
    if (!ctErr) contactType = "both"
  }

  // ── 2. Ensure BOTH journey_states rollups, cross-linked + dependency stamped ─
  const persona = (contact as any).contact_persona ?? "both"
  const nowIso = new Date().toISOString()

  // Honest current_stage per side — no fabrication: use the real buyer_stage and
  // the real listing lifecycle_stage where present; fall back to the contract's
  // documented entry stage only when the journey hasn't started.
  const buyerStage = ((contact as any).buyer_stage as string | null) ?? "BUYER_CONTACT_CREATED"
  const sellerStage =
    ((sellerListing as any)?.lifecycle_stage as string | null) ?? "SELLER_CONTACT_CREATED"

  const buyerKey = journeyUserKey(contactId, "buyer")
  const sellerKey = journeyUserKey(contactId, "seller")

  const crossLink = {
    dual_intent: true,
    counterpart_user_id: "" as string, // filled per-side below
    counterpart_side: "" as IntentSide,
    dependency,
    linked_at: nowIso,
  }

  const buyerRow = {
    user_id: buyerKey,
    persona,
    contact_id: contactId,
    listing_id: null as string | null,
    brokerage_id: brokerageId,
    current_stage: buyerStage,
    metadata_json: JSON.stringify({
      ...crossLink,
      side: "buyer" as IntentSide,
      counterpart_user_id: sellerKey,
      counterpart_side: "seller" as IntentSide,
      // The buyer side is the GATED side — surface the gate to the Shopping Agent.
      gated_on_counterpart: dependency.gated,
    }),
    updated_at: nowIso,
  }

  const sellerRow = {
    user_id: sellerKey,
    persona,
    contact_id: contactId,
    listing_id: (sellerListing as any)?.id ?? null,
    brokerage_id: brokerageId,
    current_stage: sellerStage,
    metadata_json: JSON.stringify({
      ...crossLink,
      side: "seller" as IntentSide,
      counterpart_user_id: buyerKey,
      counterpart_side: "buyer" as IntentSide,
      // The seller side GATES the buyer side — surface that the buyer waits on this sale.
      gates_counterpart: dependency.gated,
    }),
    updated_at: nowIso,
  }

  const { data: buyerJourney } = await supabase
    .from("journey_states")
    .upsert(buyerRow, { onConflict: "user_id" })
    .select("id")
    .maybeSingle()

  const { data: sellerJourney } = await supabase
    .from("journey_states")
    .upsert(sellerRow, { onConflict: "user_id" })
    .select("id")
    .maybeSingle()

  // ── 3. Surface the dependency (only when it actually gates) ──────────────────
  let dependencyCardPushed = false
  if (dependency.gated && !dependency.satisfied && brokerageId) {
    const card = await pushPortalValueCard(
      {
        brokerageId,
        contactId,
        listingId: (sellerListing as any)?.id ?? null,
        title: "Your move is a two-step: sell, then buy",
        summary: dependency.explanation,
        updateType: "dual_intent_dependency",
        metadata: {
          dependency,
          buyer_journey_user_id: buyerKey,
          seller_journey_user_id: sellerKey,
        },
      },
      supabase,
    )
    dependencyCardPushed = card.pushed
  }

  return {
    linked: true,
    contactType,
    buyerJourneyId: (buyerJourney as any)?.id,
    sellerJourneyId: (sellerJourney as any)?.id,
    dependency,
    dependencyCardPushed,
  }
}
