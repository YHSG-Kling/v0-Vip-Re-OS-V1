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
// SINGLE SOURCE OF TRUTH: the canonical commission + buyer-credit math lives in the
// PURE module lib/offers/offer-math (no "@/lib/ai", no server-only deps), so this
// non-server-only kernel module (client component + cron + simulator import it) shares
// the EXACT same formula as the server-side offer-analyzer AI surface — no drift.
import { calcNetToSeller } from "@/lib/offers/offer-math"

type Svc = ReturnType<typeof createServiceClient>

// ─── Types ────────────────────────────────────────────────────────────────────

/** The seller-responsible costs that net proceeds deducts. The offer/listing rows
 *  carry commission rate + buyer credit; payoff/taxes/other are INPUTS (defaults the
 *  seller/agent edit). HOA defaults from listings.hoa_dues when present. */
export interface SellerCosts {
  /** decimal, e.g. 0.06 */
  commissionRate: number
  mortgagePayoff: number
  countyCityTaxes: number
  hoaDuesProration: number
  otherProratedFees: number
  /** the buyer's requested closing-cost credit (offers.closing_cost_contribution) */
  buyerClosingCredit: number
}

export interface OfferNetInput {
  offerId: string
  buyerName: string | null
  offerPrice: number
  financingType: string | null
  buyerClosingCredit: number
}

export interface OfferNetLine {
  offerId: string
  buyerName: string | null
  offerPrice: number
  financingType: string | null
  commission: number
  mortgagePayoff: number
  countyCityTaxes: number
  hoaDuesProration: number
  otherProratedFees: number
  buyerClosingCredit: number
  netProceeds: number
}

export interface OfferNetRanking {
  lines: OfferNetLine[]
  /** offerId of the highest sticker price */
  topByPrice: string | null
  /** offerId of the highest net proceeds */
  topByNet: string | null
  /** true when the offer that nets the most is NOT the highest-priced offer */
  netBeatsPrice: boolean
}

// ─── Pure helpers ───────────────────────────────────────────────────────────────

/**
 * Net proceeds for ONE offer. REUSES calcNetToSeller (offer-analyzer) for the
 * commission + buyer-credit core, then subtracts the seller-responsible costs the
 * offer/listing rows don't carry (payoff, taxes, HOA, other).
 */
export function computeNetProceeds(
  offer: { offerPrice: number; buyerClosingCredit: number },
  costs: Omit<SellerCosts, "buyerClosingCredit">,
): number {
  // Canonical commission + buyer-credit math (offer-analyzer).
  const afterCommissionAndCredit = calcNetToSeller({
    offer_price: offer.offerPrice,
    closing_cost_contribution: offer.buyerClosingCredit,
    commission_rate: costs.commissionRate,
  })
  // The seller-responsible deductions the offer/listing rows don't carry.
  return (
    afterCommissionAndCredit -
    costs.mortgagePayoff -
    costs.countyCityTaxes -
    costs.hoaDuesProration -
    costs.otherProratedFees
  )
}

/** Build a per-offer net line (the breakdown the interactive sheet renders). */
export function buildNetLine(offer: OfferNetInput, costs: SellerCosts): OfferNetLine {
  const buyerClosingCredit = offer.buyerClosingCredit
  const netProceeds = computeNetProceeds(
    { offerPrice: offer.offerPrice, buyerClosingCredit },
    {
      commissionRate: costs.commissionRate,
      mortgagePayoff: costs.mortgagePayoff,
      countyCityTaxes: costs.countyCityTaxes,
      hoaDuesProration: costs.hoaDuesProration,
      otherProratedFees: costs.otherProratedFees,
    },
  )
  return {
    offerId: offer.offerId,
    buyerName: offer.buyerName,
    offerPrice: offer.offerPrice,
    financingType: offer.financingType,
    commission: offer.offerPrice * costs.commissionRate,
    mortgagePayoff: costs.mortgagePayoff,
    countyCityTaxes: costs.countyCityTaxes,
    hoaDuesProration: costs.hoaDuesProration,
    otherProratedFees: costs.otherProratedFees,
    buyerClosingCredit,
    netProceeds,
  }
}

/**
 * Rank offers by NET PROCEEDS (the whole point) and report whether the net winner
 * differs from the price winner. `costs` carries the shared seller-responsible costs;
 * each offer's own buyerClosingCredit is taken from its input row.
 */
export function rankOffersByNet(
  offers: OfferNetInput[],
  costs: Omit<SellerCosts, "buyerClosingCredit">,
): OfferNetRanking {
  const lines = offers.map((o) =>
    buildNetLine(o, { ...costs, buyerClosingCredit: o.buyerClosingCredit }),
  )
  if (lines.length === 0) {
    return { lines, topByPrice: null, topByNet: null, netBeatsPrice: false }
  }
  const byPrice = [...lines].sort((a, b) => b.offerPrice - a.offerPrice)[0]
  const byNet = [...lines].sort((a, b) => b.netProceeds - a.netProceeds)[0]
  return {
    lines,
    topByPrice: byPrice.offerId,
    topByNet: byNet.offerId,
    netBeatsPrice: byPrice.offerId !== byNet.offerId,
  }
}

function fmtUsd(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
}

function labelFor(line: OfferNetLine, idx: number): string {
  return line.buyerName ?? `Offer ${String.fromCharCode(65 + idx)}`
}

/**
 * Deterministic FALLBACK copy for the gated agent comparison summary. Earned lines
 * only (no fabrication) — names the listing, the net winner, and the dollar delta vs
 * the highest-priced offer when the net winner is NOT the price winner.
 */
export function composeComparisonFallback(args: {
  listingAddress: string
  ranking: OfferNetRanking
}): { agentSummary: string; sellerCardBody: string } {
  const { listingAddress, ranking } = args
  const lines = ranking.lines
  const netWinner = lines.find((l) => l.offerId === ranking.topByNet) ?? lines[0]
  const priceWinner = lines.find((l) => l.offerId === ranking.topByPrice) ?? lines[0]
  const netWinnerIdx = lines.findIndex((l) => l.offerId === ranking.topByNet)
  const priceWinnerIdx = lines.findIndex((l) => l.offerId === ranking.topByPrice)
  const netWinnerLabel = labelFor(netWinner, netWinnerIdx < 0 ? 0 : netWinnerIdx)
  const priceWinnerLabel = labelFor(priceWinner, priceWinnerIdx < 0 ? 0 : priceWinnerIdx)

  let headline: string
  if (lines.length === 1) {
    headline = `Net sheet ready for ${listingAddress}: ${netWinnerLabel} nets the seller about ${fmtUsd(netWinner.netProceeds)} after costs.`
  } else if (ranking.netBeatsPrice) {
    const delta = netWinner.netProceeds - priceWinner.netProceeds
    headline = `Offer comparison ready for ${listingAddress}: ${netWinnerLabel} nets ~${fmtUsd(delta)} more than the highest-priced offer (${priceWinnerLabel}) despite a lower price — net proceeds beat sticker price here.`
  } else {
    headline = `Offer comparison ready for ${listingAddress}: ${netWinnerLabel} is both the highest price and the highest net to the seller (${fmtUsd(netWinner.netProceeds)} after costs).`
  }

  const agentSummary = [
    headline,
    `Side-by-side net proceeds (offer price − commission − payoff − taxes − HOA − other − buyer credit):`,
    lines
      .map((l, i) => `· ${labelFor(l, i)}: ${fmtUsd(l.offerPrice)} → nets ${fmtUsd(l.netProceeds)}`)
      .join("\n"),
    `Open the interactive net sheet to adjust the payoff, taxes, HOA and commission with the seller live, then approve the portal summary.`,
  ].join("\n")

  const sellerCardBody = [
    `We compared ${lines.length === 1 ? "your offer" : `your ${lines.length} offers`} by what you actually KEEP at closing — not just the price on the page.`,
    ranking.netBeatsPrice
      ? `The offer that puts the most in your pocket isn't the highest-priced one. Your agent will walk you through the full net sheet.`
      : `Your agent has the full net sheet ready and will walk you through every number.`,
    `This is a read-only summary — nothing is decided until you and your agent talk it through.`,
  ].join(" ")

  return { agentSummary, sellerCardBody }
}

// ─── Idempotency signature ──────────────────────────────────────────────────────

/** A stable signature of the current offer-set so a NEW offer re-triggers, but the
 *  same set inside 24h does not. Sorted offerIds keep it order-independent. */
export function offerSetSignature(offerIds: string[]): string {
  return [...offerIds].sort().join(",")
}

// ─── Live runner ────────────────────────────────────────────────────────────────

export interface OfferNetSheetResult {
  listingsScanned: number
  comparisonsProposed: number
  portalCardsPushed: number
}

/** Default seller-responsible cost assumptions when the data isn't on file. The seller
 *  and agent edit these live on the interactive net sheet — they are STARTING POINTS,
 *  not claims. Payoff defaults to 0 (unknown until the seller provides it); taxes/other
 *  are conservative percentages of price; HOA comes from the listing when present. */
export function defaultSellerCosts(args: {
  listPrice: number | null
  commissionRateDecimal: number
  hoaDuesMonthly: number | null
}): Omit<SellerCosts, "buyerClosingCredit"> {
  const price = args.listPrice ?? 0
  return {
    commissionRate: args.commissionRateDecimal,
    mortgagePayoff: 0, // unknown until the seller provides it — editable
    countyCityTaxes: Math.round(price * 0.005), // ~0.5% prorated property taxes (editable)
    hoaDuesProration: args.hoaDuesMonthly ? Math.round(args.hoaDuesMonthly) : 0, // ~1 month proration
    otherProratedFees: Math.round(price * 0.01), // ~1% title/escrow/other (editable)
  }
}

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
  } = {},
  client?: Svc,
): Promise<OfferNetSheetResult> {
  const supabase = client ?? createServiceClient()
  const now = opts.now ?? new Date()
  const result: OfferNetSheetResult = { listingsScanned: 0, comparisonsProposed: 0, portalCardsPushed: 0 }

  // OUR in-house listings: seller is a contact (has a portal) AND we have a listing agent.
  const { data: listings } = await supabase
    .from("listings")
    .select("id, address, list_price, agent_id, seller_contact_id, hoa_dues, commission_rate, brokerage_id")
    .eq("brokerage_id", brokerageId)
    .not("seller_contact_id", "is", null)
    .not("agent_id", "is", null)
    .in("status", ["active", "pending", "coming_soon"])
    .limit(200)

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

    // Resolve seller-responsible costs (commission from the listing rate when set).
    const commissionRateDecimal =
      lst.commission_rate != null ? Number(lst.commission_rate) / 100 : 0.06
    const costs = opts.costsResolver
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
        body: fallback.agentSummary,
        rationale: `OFFER NET SHEET — sig:${signature} — ${inputs.length} offer(s); ranked by net proceeds (payoff/taxes/HOA/commission/credit); net winner ${ranking.netBeatsPrice ? "BEATS" : "matches"} price winner; seller portal value card pushed.`,
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
      },
      created_at: now.toISOString(),
    })
    if (!cardErr) result.portalCardsPushed += 1
  }

  return result
}
