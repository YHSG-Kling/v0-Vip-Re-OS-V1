// lib/kernel/offer-net-sheet.ts
//
// OFFER NET SHEET — the seller's "which offer do I actually keep the most from?" play.
//
// When OUR in-house listing (listings.seller_contact_id set + agent_id set) receives
// one or more pending offers, the Listing Concierge gives the seller a side-by-side
// NET PROCEEDS comparison so the seller↔agent conversation is productive: per offer,
// NET = offer price − (mortgage payoff + county/city taxes + HOA dues/prorations +
// other prorated fees + commission + buyer closing-cost credit). The play surfaces
// WHICH OFFER NETS THE SELLER MOST — not just the highest sticker price.
//
// CONSOLIDATION (do not rebuild):
//   · calcNetToSeller (lib/offers/offer-analyzer) — the canonical commission/credit math.
//     computeNetProceeds EXTENDS it with the seller-responsible deductions (payoff,
//     taxes, HOA, other) the offer/listing rows don't carry — those are INPUTS with
//     sensible defaults the agent/seller edit on the interactive net sheet.
//   · buildMultiOfferMatrix (lib/workflow/intelligence/multi-offer-matrix) is the
//     server-only AI comparison engine for the agent's offer view; this kernel module
//     is the NON-server-only proactive trigger + portal delivery + gated agent summary.
//
// GATING: nothing auto-sends to the seller EXCEPT the read-only portal VALUE card
// (transparency_updates) — that's the point: always give the portal value to keep the
// seller engaged. The agent-facing comparison goes through proposeClientMessage
// (audience 'agent') — proposed, never auto-sent.
//
// IDEMPOTENT: one comparison per listing per offer-set per 24h (keyed on the agent
// summary's rationale + an offer-set signature so a NEW offer re-triggers).
//
// NOT server-only (simulator-driven). Pure helpers carry the math; the runner does I/O.

import { createServiceClient } from "@/lib/supabase/service"
import type { CopyGenerator } from "@/lib/kernel/ai-copy"
// The PURE net-sheet math + copy moved to lib/offers/net-sheet-calc (client-safe — no server
// chain). A CLIENT component imports that module directly; this server runner re-exports the full
// pure API so every existing importer of @/lib/kernel/offer-net-sheet is unchanged.
export * from "@/lib/offers/net-sheet-calc"
import {
  fmtUsd, defaultSellerCosts, offerSetSignature, rankOffersByNet, composeComparisonFallback,
  defaultProvenance, decideNetSheetPolicy, resolveAgreedCommission,
  type OfferNetInput, type SellerCosts, type OfferNetSheetResult,
  type AgreementCommissionFields,
} from "@/lib/offers/net-sheet-calc"
// The seller closing-cost model (round 36) — pure, supplies the net sheet's
// closing-cost section from the same 50-state convention table the buyer
// breakdown uses (keep-one: this runner stays the canonical seller surface).
import { deriveNetSheetClosingCostSection } from "@/lib/offers/seller-closing-costs"

type Svc = ReturnType<typeof createServiceClient>

const OPEN_OFFER_STATUSES = ["pending", "submitted", "under_review", "countered"]
const COMPARISON_WINDOW_HOURS = 24

/**
 * Detect OUR in-house listings (seller_contact_id + agent_id set) with open offer(s)
 * that need a fresh net-sheet comparison, compute per-offer net proceeds, propose a
 * GATED agent summary, and PUSH a read-only value card to the seller's portal.
 * Idempotent: one comparison per listing per offer-set per 24h.
 */
export async function runOfferNetSheets(
  brokerageId: string,
  opts: {
    now?: Date
    copyGenerator?: CopyGenerator
    /** override the cost assumptions (the simulator passes known costs) */
    costsResolver?: (ctx: {
      listingId: string
      listPrice: number | null
      commissionRateDecimal: number
      hoaDuesMonthly: number | null
    }) => Promise<Omit<SellerCosts, "buyerClosingCredit">> | Omit<SellerCosts, "buyerClosingCredit">
    /** EVENT-DRIVEN: scope the run to ONE listing (the one that just received an offer). The cron
     *  omits this and sweeps the whole brokerage as the safety net. */
    listingId?: string
  } = {},
  client?: Svc,
): Promise<OfferNetSheetResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const result: OfferNetSheetResult = { listingsScanned: 0, comparisonsProposed: 0, portalCardsPushed: 0 }

  // OUR in-house listings: seller is a contact (has a portal) AND we have a listing agent.
  let listingsQuery = supabase
    .from("listings")
    .select("id, address, city, state, list_price, agent_id, seller_contact_id, hoa_dues, commission_rate, brokerage_id")
    .eq("brokerage_id", brokerageId)
    .not("seller_contact_id", "is", null)
    .not("agent_id", "is", null)
    .in("status", ["active", "pending", "coming_soon"])
    .limit(200)
  if (opts.listingId) listingsQuery = listingsQuery.eq("id", opts.listingId)
  const { data: listings } = await listingsQuery

  for (const lst of (listings ?? []) as any[]) {
    // Open offers on this listing.
    const { data: offers } = await supabase
      .from("offers")
      .select("id, contact_id, offer_price, closing_cost_contribution, financing_type, status, submitted_at")
      .eq("listing_id", lst.id)
      .in("status", OPEN_OFFER_STATUSES)
      .order("offer_price", { ascending: false })

    const open = (offers ?? []) as any[]
    if (open.length === 0) continue
    result.listingsScanned += 1

    const signature = offerSetSignature(open.map((o) => o.id as string))

    // IDEMPOTENCY: one comparison per (listing, offer-set) per 24h. Keyed on the agent
    // summary's rationale prefix + the offer-set signature.
    const sinceIso = new Date(now.getTime() - COMPARISON_WINDOW_HOURS * 3_600_000).toISOString()
    const { data: existing } = await supabase
      .from("agent_client_messages")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .eq("entity_id", lst.id)
      .ilike("rationale", `OFFER NET SHEET — sig:${signature}%`)
      .gte("created_at", sinceIso)
      .limit(1)
      .maybeSingle()
    if (existing) continue

    // Resolve buyer names (best-effort).
    const buyerNameById = new Map<string, string | null>()
    const buyerIds = Array.from(new Set(open.map((o) => o.contact_id).filter(Boolean)))
    if (buyerIds.length > 0) {
      const { data: cs } = await supabase
        .from("contacts").select("id, first_name, last_name").in("id", buyerIds as string[])
      for (const c of (cs ?? []) as any[]) {
        buyerNameById.set(c.id, `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() || null)
      }
    }

    // Agreed commission terms for this listing.
    const { data: agreementRow } = await supabase
      .from("listing_agreements")
      .select("listing_commission_rate, buyer_commission_rate, total_commission_rate, commission_is_flat_fee, commission_flat_amount")
      .eq("listing_id", lst.id)
      .eq("brokerage_id", brokerageId)
      .order("fully_executed_at", { ascending: false, nullsFirst: false })
      .limit(1)
      .maybeSingle()

    // The seller pays BOTH sides. A listing-side-only rate understates the
    // commission and overstates the net on the seller's own portal card.
    const agreed = resolveAgreedCommission({
      agreement: agreementRow as AgreementCommissionFields | null,
      listingCommissionRatePercent: lst.commission_rate ?? null,
      referencePrice: lst.list_price != null ? Number(lst.list_price) : null,
    })
    const commissionRateDecimal = agreed.rate
    let costs = opts.costsResolver
      ? await opts.costsResolver({
          listingId: lst.id,
          listPrice: lst.list_price != null ? Number(lst.list_price) : null,
          commissionRateDecimal,
          hoaDuesMonthly: lst.hoa_dues != null ? Number(lst.hoa_dues) : null,
        })
      : defaultSellerCosts({
          listPrice: lst.list_price != null ? Number(lst.list_price) : null,
          commissionRateDecimal,
          hoaDuesMonthly: lst.hoa_dues != null ? Number(lst.hoa_dues) : null,
        })

    // PROVENANCE — every line knows where its number came from. HOA from the
    // listing row counts as confirmed data; an injected costsResolver (the
    // simulator / a live agent session) supplies KNOWN figures.
    const provenance = defaultProvenance()
    // The commission line carries the agreement's own provenance: "confirmed" when
    // an executed agreement backed it, "template"/"default" when it did not.
    provenance.commissionRate = agreed.source
    if (opts.costsResolver) {
      provenance.mortgagePayoff = "confirmed"
      provenance.countyCityTaxes = "confirmed"
      provenance.hoaDuesProration = "confirmed"
      provenance.otherProratedFees = "confirmed"
    } else if (lst.hoa_dues != null) {
      provenance.hoaDuesProration = "confirmed"
    }

    // REGIONAL CLOSING-COST SECTION (round 36, keep-one): the net sheet stays
    // the canonical seller-money surface; lib/offers/seller-closing-costs
    // supplies its CLOSING-COST section. When the listing's state is known,
    // the flat 1%-of-price "other prorated fees" default is replaced by the
    // midpoint of the state-convention seller band (transfer/deed tax seller
    // share, owner's-title seller share, settlement share, deed + payoff-
    // release recording), labeled regional_estimate — still an estimate on
    // the disclose-first list, never presented as a fact. An injected
    // costsResolver (live agent session / simulator) always wins.
    if (!opts.costsResolver && lst.list_price != null) {
      const addrState = /,\s*([A-Za-z]{2})\s+\d{5}/.exec(String(lst.address ?? ""))?.[1] ?? null
      const section = deriveNetSheetClosingCostSection(Number(lst.list_price), (lst as any).state ?? addrState)
      if (section) {
        costs = { ...costs, otherProratedFees: section.midpoint }
        provenance.otherProratedFees = "regional_estimate"
      }
    }

    // PUBLIC-RECORD PRELOAD — the tax line arrives REAL when the records rail
    // is configured (provider-gated; a skip leaves the template default AND
    // its 'default' provenance — never a fabricated "verified").
    if (!opts.costsResolver && lst.address) {
      try {
        const { preloadPublicRecordCosts } = await import("@/lib/offers/public-record-preload")
        const addr = String(lst.address)
        const m = /^(.*?),\s*([^,]+),\s*([A-Za-z]{2})\s+(\d{5})/.exec(addr)
        const rec = await preloadPublicRecordCosts(
          m
            ? { street: m[1], city: m[2], state: m[3].toUpperCase(), zip: m[4] }
            : { street: addr, city: (lst as any).city ?? null, state: (lst as any).state ?? null, zip: (lst as any).zip_code ?? null },
        )
        if (rec.annualTaxAmount !== null) {
          // Seller owes the prorated share to close — half a year is the honest
          // mid-point when the close date isn't fixed yet; the agent adjusts live.
          costs = { ...costs, countyCityTaxes: Math.round(rec.annualTaxAmount / 2) }
          provenance.countyCityTaxes = "public_record"
        }
      } catch { /* preload is additive — the default stands */ }
    }

    // POLICY — may these numbers go seller-facing? Recorded on the SAME
    // policy ledger the document kernel writes; red keeps dollar figures
    // agent-only (the portal card carries no numbers by design).
    const netPolicy = decideNetSheetPolicy(provenance)
    try {
      const { recordPolicyDecision } = await import("@/lib/documents/policy-decisions")
      await recordPolicyDecision(supabase as any, {
        brokerageId,
        targetType: "seller_net_sheet",
        targetId: lst.id,
        verdict: {
          decision: netPolicy.decision,
          reasons: netPolicy.reasons,
          recommendedAction: netPolicy.decision === "green" ? "present_to_seller"
            : netPolicy.decision === "amber" ? "disclose_estimates_then_present" : "confirm_payoff_before_presenting",
          requiredApproverRole: null,
        },
        evidence: { provenance, needs_confirmation: netPolicy.needsConfirmation, offer_set_signature: signature },
      })
    } catch { /* ledger best-effort */ }

    const inputs: OfferNetInput[] = open.map((o) => ({
      offerId: o.id,
      buyerName: o.contact_id ? buyerNameById.get(o.contact_id) ?? null : null,
      offerPrice: Number(o.offer_price),
      financingType: o.financing_type ?? null,
      buyerClosingCredit: o.closing_cost_contribution != null ? Number(o.closing_cost_contribution) : 0,
    }))

    const ranking = rankOffersByNet(inputs, costs)
    const fallback = composeComparisonFallback({ listingAddress: lst.address ?? "your listing", ranking })

    // PERSONA-AWARE COPY for the seller card (deterministic fallback = composeComparisonFallback).
    const { generatePersonaCopy, loadContactPersona } = await import("@/lib/kernel/ai-copy")
    const sellerPersona = await loadContactPersona(supabase, lst.seller_contact_id).catch(() => ({ audience: "seller" as const }))
    const facts = [
      `We compared ${inputs.length === 1 ? "your offer" : `${inputs.length} offers`} on your home by net proceeds (what you keep after costs)`,
      ranking.netBeatsPrice
        ? "The offer that nets you the most is not the highest-priced one"
        : "The highest-priced offer also nets you the most",
      "This is a read-only summary — your agent will walk you through every number",
    ]
    const sellerBody = (await generatePersonaCopy(
      {
        goal: "a short, warm portal update telling the seller their offer net-proceeds comparison is ready (read-only, no pressure)",
        facts,
        channel: "portal",
        persona: { ...sellerPersona, audience: "seller", situation: "home seller weighing offers" },
        words: 60,
      },
      { body: fallback.sellerCardBody },
      { generator: opts.copyGenerator },
    )).body

    // (a) GATED agent-facing comparison summary — proposed, audience 'agent', never auto-sent.
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const winnerLine = ranking.lines.find((l) => l.offerId === ranking.topByNet)
    const priceLine = ranking.lines.find((l) => l.offerId === ranking.topByPrice)
    const deltaNote =
      ranking.netBeatsPrice && winnerLine && priceLine
        ? ` nets ~${fmtUsd(winnerLine.netProceeds - priceLine.netProceeds)} more despite a lower price`
        : ""
    const proposed = await proposeClientMessage(
      {
        brokerageId,
        // Listing Concierge owns the seller side; Deal Coordinator is the other valid kind.
        agentKind: "listing_concierge",
        entityType: "listing",
        entityId: lst.id,
        recipientContactId: null, // audience 'agent' — internal gated summary
        audience: "agent",
        subject: `Offer comparison ready for ${lst.address ?? "your listing"}${deltaNote}`,
        body: [
          // THE TRUST HEADER — the agent sees the confidence state before the numbers.
          netPolicy.decision === "green"
            ? "✅ Presentation-grade: payoff and prorations are verified or confirmed."
            : netPolicy.decision === "amber"
              ? `⚠️ Estimates remain (${netPolicy.needsConfirmation.map((k) => k.replace(/([A-Z])/g, " $1").toLowerCase()).join(", ")}) — disclose before presenting to the seller.`
              : "⛔ The mortgage payoff is an unconfirmed default — these net figures OVERSTATE what the seller keeps. Confirm the payoff on the interactive sheet before presenting any dollar amounts.",
          fallback.agentSummary,
        ].join("\n\n"),
        rationale: `OFFER NET SHEET — sig:${signature} — ${inputs.length} offer(s); ranked by net proceeds (payoff/taxes/HOA/commission/credit); confidence ${netPolicy.decision}; net winner ${ranking.netBeatsPrice ? "BEATS" : "matches"} price winner; seller portal value card pushed.`,
        channel: "portal",
      },
      supabase,
    )
    if (proposed.ok) result.comparisonsProposed += 1

    // (b) PORTAL VALUE CARD — read-only, seller-safe, auto-pushed (the point: always
    // give the portal value to keep the seller engaged). transparency_updates is the
    // canonical "what's happening on my deal" card the portal reads.
    const { error: cardErr } = await supabase.from("transparency_updates").insert({
      brokerage_id: brokerageId,
      contact_id: lst.seller_contact_id,
      listing_id: lst.id,
      title: inputs.length === 1 ? "Your offer: net proceeds summary" : "Your offers: side-by-side net comparison",
      plain_language_summary: sellerBody,
      message: sellerBody,
      update_type: "offer_net_sheet",
      is_visible_to_client: true,
      metadata: {
        offer_set_signature: signature,
        offer_count: inputs.length,
        net_winner_offer_id: ranking.topByNet,
        price_winner_offer_id: ranking.topByPrice,
        net_beats_price: ranking.netBeatsPrice,
        agent_summary_id: proposed.id ?? null,
        seller_safe: true,
        net_policy: netPolicy.decision, // green/amber/red — the portal shows numbers only via the agent anyway
      },
      created_at: now.toISOString(),
    })
    if (!cardErr) result.portalCardsPushed += 1
  }

  return result
}

