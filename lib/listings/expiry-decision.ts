/**
 * lib/listings/expiry-decision.ts
 *
 * THE LISTING-EXPIRY DECISION SURFACE — the terminal seller decision the
 * OS was detecting but not composing. The stall predictor fires EARLY
 * (momentum dying mid-term, rides proactive-intelligence); THIS composes
 * the END-OF-AGREEMENT decision as expiration_date approaches: RELIST /
 * REPRICE / RELEASE, each with the real evidence (DOM vs area pace,
 * showing volume, offer activity) and the reprice option carrying REAL
 * price-cut nets from the canonical net-sheet math — the same house
 * methodology (preload → decide → explain → gate → audit).
 *
 * Nothing auto-renews or auto-releases: the composed decision arrives as
 * a GATED agent proposal (Listing Concierge), the verdict lands on the
 * policy ledger (amber — an agreement decision is always human), and the
 * accept/counter conversations stay where they are.
 *
 * Pure composer; the runner rides the listing-health-scan cron.
 * NOT server-only (simulator-driven).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { computeNetProceeds, defaultSellerCosts, fmtUsd } from "@/lib/offers/net-sheet-calc"

type Svc = SupabaseClient<any, any, any>

export interface ExpiryFacts {
  daysToExpiry: number
  daysOnMarket: number | null
  /** area median DOM when known — null never fabricates a pace claim. */
  areaMedianDom: number | null
  showingsLast30: number
  offersReceived: number
  listPrice: number | null
  /** real nets at candidate reprice points (canonical net math). */
  priceCutNets: Array<{ price: number; net: number; cutPct: number }>
}

export type ExpiryOptionKey = "relist" | "reprice" | "release"

export interface ExpiryOption {
  key: ExpiryOptionKey
  headline: string
  evidence: string
  tradeoff: string
}

export interface ExpiryDecision {
  options: ExpiryOption[]
  recommended: ExpiryOptionKey
  reason: string
}

/** PURE: facts → the three options + a deterministic recommendation.
 *  Honest: pace claims only when areaMedianDom is known; live offer
 *  activity always recommends relist (you don't release a listing with
 *  offers on the table). */
export function composeExpiryDecision(f: ExpiryFacts): ExpiryDecision {
  const paceKnown = f.areaMedianDom !== null && f.daysOnMarket !== null
  const slowVsPace = paceKnown ? (f.daysOnMarket as number) > 1.5 * (f.areaMedianDom as number) : false
  const deadVsPace = paceKnown ? (f.daysOnMarket as number) > 2 * (f.areaMedianDom as number) : false
  const domLine = f.daysOnMarket === null
    ? "days on market unknown"
    : `${f.daysOnMarket} days on market${paceKnown ? ` vs an area median of ${f.areaMedianDom}` : ""}`
  const showLine = `${f.showingsLast30} showing${f.showingsLast30 === 1 ? "" : "s"} in the last 30 days`
  const bestCut = f.priceCutNets[0] ?? null

  const options: ExpiryOption[] = [
    {
      key: "relist",
      headline: "Renew the agreement as-is",
      evidence: `${domLine}; ${showLine}; ${f.offersReceived} offer${f.offersReceived === 1 ? "" : "s"} received.`,
      tradeoff: f.offersReceived > 0
        ? "Offer activity is live — renewing keeps the leverage; releasing now walks away from real demand."
        : "Keeps the marketing machine running unchanged — the right move only if demand supports the current price.",
    },
    {
      key: "reprice",
      headline: "Renew with a price move",
      evidence: bestCut
        ? `A ${bestCut.cutPct}% cut to ${fmtUsd(bestCut.price)} still nets an estimated ${fmtUsd(bestCut.net)} (estimate — confirm payoff on the net sheet).`
        : `${domLine}; ${showLine}.`,
      tradeoff: "A visible price move re-triggers portal alerts and buyer searches — the strongest demand lever short of a relist.",
    },
    {
      key: "release",
      headline: "Let the agreement lapse",
      evidence: `${domLine}; ${showLine}; ${f.offersReceived} offer${f.offersReceived === 1 ? "" : "s"}.`,
      tradeoff: "Preserves the relationship for a re-list when conditions change; the sphere engine keeps the seller warm.",
    },
  ]

  if (f.offersReceived > 0) {
    return { options, recommended: "relist", reason: "Live offer activity — renew and press the negotiation; this is not an expiry problem." }
  }
  if (f.showingsLast30 === 0 && deadVsPace) {
    return { options, recommended: "release", reason: "Zero showings in 30 days at more than twice the area pace — demand isn't there at any nearby price; release respectfully and stay in the seller's corner." }
  }
  if (f.showingsLast30 >= 4 && !slowVsPace) {
    return { options, recommended: "relist", reason: "Healthy showing volume at a normal market pace — the term ran out, not the demand." }
  }
  return {
    options,
    recommended: "reprice",
    reason: bestCut
      ? `Showings are thin for the runway used — a ${bestCut.cutPct}% move to ${fmtUsd(bestCut.price)} re-triggers buyer alerts and still nets ~${fmtUsd(bestCut.net)} (estimate).`
      : "Showings are thin for the runway used — a price move is the strongest demand lever available.",
  }
}

export interface ExpiryRunResult { listingsScanned: number; decisionsProposed: number }

const EXPIRY_WINDOW_DAYS = 21
const PROPOSAL_DEDUP_DAYS = 14

/** Sweep listings whose agreement expires inside the window; compose the
 *  decision; record the amber policy verdict; propose the gated agent
 *  brief. Idempotent per listing per 14d. Rides listing-health-scan. */
export async function runExpiryDecisions(
  svc: Svc,
  input: { brokerageId: string; now?: Date },
): Promise<ExpiryRunResult> {
  const now = input.now ?? new Date()
  const out: ExpiryRunResult = { listingsScanned: 0, decisionsProposed: 0 }
  const horizon = new Date(now.getTime() + EXPIRY_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)

  const { data: listings } = await svc
    .from("listings")
    .select("id, address, list_price, agent_id, seller_contact_id, expiration_date, go_live_date, listing_date, hoa_dues, commission_rate, brokerage_id")
    .eq("brokerage_id", input.brokerageId)
    .eq("status", "active")
    .not("expiration_date", "is", null)
    .lte("expiration_date", horizon)
    .gte("expiration_date", now.toISOString().slice(0, 10))
    .limit(100)

  for (const lst of ((listings ?? []) as any[])) {
    out.listingsScanned++

    // Idempotency: one expiry brief per listing per window.
    const dedupSince = new Date(now.getTime() - PROPOSAL_DEDUP_DAYS * 86_400_000).toISOString()
    const { data: dup } = await svc.from("agent_client_messages").select("id")
      .eq("brokerage_id", input.brokerageId).eq("entity_id", lst.id)
      .ilike("rationale", "LISTING EXPIRY DECISION%")
      .gte("created_at", dedupSince).limit(1).maybeSingle()
    if (dup) continue

    const [{ count: showings }, { count: offers }] = await Promise.all([
      svc.from("showings").select("id", { count: "exact", head: true })
        .eq("listing_id", lst.id).gte("scheduled_at", new Date(now.getTime() - 30 * 86_400_000).toISOString()),
      svc.from("offers").select("id", { count: "exact", head: true })
        .eq("listing_id", lst.id).in("status", ["pending", "submitted", "under_review", "countered"]),
    ])

    const goLive = lst.go_live_date ?? lst.listing_date
    const daysOnMarket = goLive ? Math.max(0, Math.floor((now.getTime() - new Date(goLive).getTime()) / 86_400_000)) : null
    const daysToExpiry = Math.max(0, Math.floor((new Date(lst.expiration_date).getTime() - now.getTime()) / 86_400_000))

    const listPrice = lst.list_price != null ? Number(lst.list_price) : null
    const costs = defaultSellerCosts({
      listPrice,
      commissionRateDecimal: lst.commission_rate != null ? Number(lst.commission_rate) / 100 : 0.06,
      hoaDuesMonthly: lst.hoa_dues != null ? Number(lst.hoa_dues) : null,
    })
    const priceCutNets = listPrice
      ? [3, 5].map((cutPct) => {
          const price = Math.round(listPrice * (1 - cutPct / 100))
          return { price, cutPct, net: computeNetProceeds({ offerPrice: price, buyerClosingCredit: 0 }, costs) }
        })
      : []

    const decision = composeExpiryDecision({
      daysToExpiry,
      daysOnMarket,
      areaMedianDom: null, // pace joins when the market-pulse rollup carries the area figure
      showingsLast30: showings ?? 0,
      offersReceived: offers ?? 0,
      listPrice,
      priceCutNets,
    })

    // The verdict on the ledger — ALWAYS amber: an agreement decision is human.
    try {
      const { recordPolicyDecision } = await import("@/lib/documents/policy-decisions")
      await recordPolicyDecision(svc as any, {
        brokerageId: input.brokerageId,
        targetType: "listing_expiry",
        targetId: lst.id,
        verdict: {
          decision: "amber",
          reasons: [decision.reason],
          recommendedAction: `recommend_${decision.recommended}`,
          requiredApproverRole: "agent",
        },
        evidence: {
          days_to_expiry: daysToExpiry, days_on_market: daysOnMarket,
          showings_last_30: showings ?? 0, offers_open: offers ?? 0,
          price_cut_nets: priceCutNets,
        },
      })
    } catch { /* ledger best-effort */ }

    // The gated agent brief — the decision arrives composed, never auto-acted.
    const body = [
      `${lst.address ?? "Your listing"} — the listing agreement expires in ${daysToExpiry} day${daysToExpiry === 1 ? "" : "s"}. The team composed the decision:`,
      ...decision.options.map((o) => `${o.key === decision.recommended ? "★" : "·"} ${o.headline.toUpperCase()} — ${o.evidence} ${o.tradeoff}`),
      `Recommendation: ${decision.recommended.toUpperCase()} — ${decision.reason}`,
      `Open the interactive net sheet to model the reprice with the seller live; nothing changes until you act.`,
    ].join("\n")

    try {
      const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
      const proposed = await proposeClientMessage(
        {
          brokerageId: input.brokerageId,
          agentKind: "listing_concierge",
          entityType: "listing",
          entityId: lst.id,
          recipientContactId: null,
          audience: "agent",
          subject: `Listing agreement expires in ${daysToExpiry}d — decision composed (${decision.recommended})`,
          body,
          rationale: `LISTING EXPIRY DECISION — ${decision.recommended}; ${decision.reason}`,
          channel: "portal",
        },
        svc as any,
      )
      if (proposed.ok) out.decisionsProposed++
    } catch { /* best-effort per listing */ }
  }

  return out
}
