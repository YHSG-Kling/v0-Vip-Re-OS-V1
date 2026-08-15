/**
 * PREDICTIVE LISTING SIGNAL GENERATORS
 *
 * Three pure functions that examine a single contact and produce zero or more
 * SignalDeltas via the existing buildPredictiveSellerSignal builder. Each
 * delta is then applied via applySignalDelta (idempotent, only-pushes-up).
 *
 * Generators:
 *   1. Tenure + Equity      → fires when long ownership + meaningful equity
 *   2. Neighbor Sold High   → fires when nearby comp closed > 5% over their AVM
 *   3. Life Event Fan-out   → fires when life_events show seller-correlated events
 *
 * Each generator is cron-friendly: it batches its data dependencies once, then
 * runs against many contacts in memory.
 */

import "server-only"
import {
  buildPredictiveSellerSignal,
  type SignalDelta,
} from "@/lib/lead-intelligence/signal-extensions"
import { computeEquityRatio, parseLengthOfResidence } from "@/lib/avm/provider-chain"

export interface ContactForScoring {
  id: string
  brokerage_id: string
  agent_id: string | null
  contact_type: string | null
  zip_code: string | null
  city: string | null
  state: string | null
  home_value_estimate: number | null
  home_owner_status: string | null
  length_of_residence: string | null
  life_events: Array<{ event: string; date?: string; source: string }> | null
  last_life_event_detected: string | null
}

export interface RecentComp {
  id: string
  address: string | null
  sale_price: number | null
  sale_date: string | null
  zip_code?: string | null
}

export interface MarketContext {
  zipCode: string
  priceTrendPct1yr: number | null  // already in decimal (e.g., 0.05 for 5%)
  medianSalePrice: number | null
}

export interface PriorTransaction {
  contact_id: string
  purchase_price: number | null
  close_date: string | null
}

// ─── Generator 1: Tenure + Equity ──────────────────────────────────────────

const QUARTER = () => Math.floor(new Date().getMonth() / 3) + 1
const QUARTER_KEY = () => `${new Date().getFullYear()}-Q${QUARTER()}`

export function runTenureEquityGenerator(input: {
  contact: ContactForScoring
  prior?: PriorTransaction | null
  market?: MarketContext | null
}): SignalDelta[] {
  const { contact, prior, market } = input
  const out: SignalDelta[] = []

  const tenure =
    parseLengthOfResidence(contact.length_of_residence) ??
    (prior?.close_date
      ? (Date.now() - new Date(prior.close_date).getTime()) / (365.25 * 24 * 60 * 60 * 1000)
      : null)

  if (!tenure || tenure < 3) return out  // too new to be a likely seller

  const equity = computeEquityRatio({
    currentAvm: contact.home_value_estimate,
    purchasePrice: prior?.purchase_price,
    purchaseDate: prior?.close_date,
    yearsOwned: tenure,
    zipAnnualAppreciation: market?.priceTrendPct1yr,
  })

  // Idempotency keys are quarterly so this signal contributes once per quarter
  const evidence = `tenure-equity:${contact.id}:${QUARTER_KEY()}`

  if (equity != null && equity >= 0.75 && tenure >= 5) {
    out.push(
      buildPredictiveSellerSignal({
        contactId: contact.id,
        signalKey: "equity_75pct",
        signalLabel: `${Math.round(equity * 100)}% equity, ${tenure.toFixed(0)}+ years owned`,
        confidence: 0.85,
        evidenceId: evidence,
        evidence: { tenureYears: tenure, equityRatio: equity },
      })
    )
    return out
  }

  if (equity != null && equity >= 0.5 && tenure >= 7) {
    out.push(
      buildPredictiveSellerSignal({
        contactId: contact.id,
        signalKey: "long_tenure_high_equity",
        signalLabel: `${Math.round(equity * 100)}% equity, ${tenure.toFixed(0)} years owned`,
        confidence: 0.7,
        evidenceId: evidence,
        evidence: { tenureYears: tenure, equityRatio: equity },
      })
    )
    return out
  }

  if (tenure >= 10) {
    out.push(
      buildPredictiveSellerSignal({
        contactId: contact.id,
        signalKey: "long_tenure",
        signalLabel: `${Math.floor(tenure)} years owned`,
        confidence: 0.5,
        evidenceId: evidence,
        evidence: { tenureYears: tenure },
      })
    )
  }

  return out
}

// ─── Generator 2: Neighbor Sold High ────────────────────────────────────────

export function runNeighborSoldGenerator(input: {
  contact: ContactForScoring
  recentCompsInZip: RecentComp[]
  /** Premium threshold — comp must close at >= this much over the contact's AVM */
  premiumThreshold?: number
}): SignalDelta[] {
  const { contact, recentCompsInZip } = input
  const premiumThreshold = input.premiumThreshold ?? 1.05  // 5% over

  const out: SignalDelta[] = []

  if (!contact.home_value_estimate || contact.home_value_estimate <= 0) return out
  if (!recentCompsInZip || recentCompsInZip.length === 0) return out

  // Find the highest premium comp in their zip in the last 90 days
  let bestPremium = 0
  let bestComp: RecentComp | null = null
  for (const comp of recentCompsInZip) {
    if (!comp.sale_price || comp.sale_price <= 0) continue
    const ratio = comp.sale_price / contact.home_value_estimate
    if (ratio >= premiumThreshold && ratio > bestPremium) {
      bestPremium = ratio
      bestComp = comp
    }
  }

  if (!bestComp) return out

  // Confidence scales with premium magnitude:
  //   5% over → 0.6
  //   10% over → 0.75
  //   15%+ over → 0.9
  const overPct = (bestPremium - 1) * 100
  const confidence = Math.min(0.95, 0.55 + (overPct / 20))

  out.push(
    buildPredictiveSellerSignal({
      contactId: contact.id,
      signalKey: "neighbor_sold_high",
      signalLabel: `Nearby comp sold ${overPct.toFixed(0)}% over your est. value`,
      confidence,
      evidenceId: `neighbor:${bestComp.id}:${contact.id}`,
      evidence: {
        compId: bestComp.id,
        compAddress: bestComp.address,
        compSalePrice: bestComp.sale_price,
        compSaleDate: bestComp.sale_date,
        contactAvm: contact.home_value_estimate,
        premiumPct: overPct,
      },
    })
  )

  return out
}

// ─── Generator 3: Life Event Fan-out ───────────────────────────────────────

const LIFE_EVENT_CONFIDENCE: Record<string, { confidence: number; sensitive: boolean; label: string }> = {
  divorce_filing: { confidence: 0.85, sensitive: true, label: "Divorce filing detected" },
  foreclosure_filing: { confidence: 0.95, sensitive: true, label: "Pre-foreclosure filing detected" },
  job_change_to_non_local: { confidence: 0.7, sensitive: false, label: "Recent job change to a non-local employer" },
  job_change: { confidence: 0.45, sensitive: false, label: "Recent job change" },
  retirement: { confidence: 0.6, sensitive: false, label: "Retirement signal" },
  kids_graduated: { confidence: 0.5, sensitive: false, label: "Kids graduated (downsizing window)" },
  empty_nester: { confidence: 0.55, sensitive: false, label: "Empty nest transition" },
  inheritance: { confidence: 0.6, sensitive: true, label: "Inherited property" },
  death_in_household: { confidence: 0.3, sensitive: true, label: "Household change requiring careful timing" },
}

export function runLifeEventGenerator(input: {
  contact: ContactForScoring
  /** Only consider events from the last N days (default 90) */
  lookbackDays?: number
}): SignalDelta[] {
  const { contact } = input
  const lookbackDays = input.lookbackDays ?? 90
  const out: SignalDelta[] = []

  const events = (contact.life_events ?? []) as Array<{ event: string; date?: string; source: string }>
  if (events.length === 0) return out

  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000

  for (const evt of events) {
    const eventDate = evt.date ? new Date(evt.date).getTime() : null
    if (eventDate != null && eventDate < cutoff) continue

    const cfg = LIFE_EVENT_CONFIDENCE[evt.event]
    if (!cfg) continue

    out.push(
      buildPredictiveSellerSignal({
        contactId: contact.id,
        signalKey: `life:${evt.event}`,
        signalLabel: cfg.label,
        confidence: cfg.confidence,
        evidenceId: `life:${evt.event}:${evt.date ?? "undated"}`,
        evidence: { event: evt.event, source: evt.source, sensitive: cfg.sensitive, date: evt.date },
      })
    )
  }

  return out
}

/**
 * Identifies whether ANY signal involves a sensitive life event. Auto-send
 * eligibility checks this before queuing a touch — sensitive events require
 * human-in-the-loop.
 */
export function containsSensitiveSignal(signals: SignalDelta[]): boolean {
  return signals.some((s) => {
    const ev = s.evidence as { sensitive?: boolean } | undefined
    return ev?.sensitive === true
  })
}
