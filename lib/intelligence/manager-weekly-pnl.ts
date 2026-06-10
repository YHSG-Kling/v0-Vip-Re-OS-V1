// lib/intelligence/manager-weekly-pnl.ts
//
// The MANAGER WEEKLY P&L — the outcome layer on top of the daily standup.
// Where the standup answers "what did each manager DO in 24h", this answers the
// retention question: "what did each manager PRODUCE this week, and is it trending
// up or down?" Every metric is a real business outcome (qualified handoffs, offers
// written, showings held, deals under contract, closings, GCI, sphere touches),
// counted for the trailing 7 days against the prior 7 days for a week-over-week
// delta. No model narration in the numbers — these are COUNT(*)/SUM() over the
// operational tables the audit just made trustworthy.
//
// Manager-attributed via the same manager-registry keys as the standup, so the
// broker sees production rolled up by the Claude manager accountable for it.
// Surfaces in the broker brief + the Command Center landing beneath the standup.

import { createServiceClient } from '@/lib/supabase/service'
import { MANAGERS, type ManagerKey } from '@/lib/kernel/manager-registry'

export interface ManagerWeeklyMetric {
  label: string
  /** This-week value (trailing 7 days). */
  value: number
  /** Prior-week value (days 8-14 back) for the week-over-week comparison. */
  prior: number
  /** % change vs prior week; null when prior is 0 (no baseline to divide by). */
  deltaPct: number | null
  /** How to render the value — a plain count or a dollar figure (GCI). */
  unit: 'count' | 'currency'
}

export interface ManagerWeeklyScorecard {
  manager: ManagerKey
  label: string
  metrics: ManagerWeeklyMetric[]
  /** One broker-readable production line (leads with the headline metric). */
  headline: string
}

type Supa = ReturnType<typeof createServiceClient>

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** COUNT(*) over a table within [from, to) with optional equality / IN filters. */
async function countWindow(
  supabase: Supa,
  table: string,
  dateCol: string,
  brokerageId: string,
  fromIso: string,
  toIso: string,
  filters?: { eq?: Record<string, string | boolean>; inList?: { col: string; vals: string[] } },
): Promise<number> {
  let q = supabase.from(table).select('id', { count: 'exact', head: true })
    .eq('brokerage_id', brokerageId)
    .gte(dateCol, fromIso).lt(dateCol, toIso)
  if (filters?.eq) for (const [k, v] of Object.entries(filters.eq)) q = q.eq(k, v)
  if (filters?.inList) q = q.in(filters.inList.col, filters.inList.vals)
  const { count } = await q
  return count ?? 0
}

/** SUM(col) over a table within [from, to) with optional filters (for GCI). */
async function sumWindow(
  supabase: Supa,
  table: string,
  sumCol: string,
  dateCol: string,
  brokerageId: string,
  fromIso: string,
  toIso: string,
  filters?: { eq?: Record<string, string> },
): Promise<number> {
  let q = supabase.from(table).select(sumCol)
    .eq('brokerage_id', brokerageId)
    .gte(dateCol, fromIso).lt(dateCol, toIso)
  if (filters?.eq) for (const [k, v] of Object.entries(filters.eq)) q = q.eq(k, v)
  const { data } = await q
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  return rows.reduce((acc, row) => acc + (Number(row[sumCol]) || 0), 0)
}

function deltaPct(value: number, prior: number): number | null {
  if (prior === 0) return null
  return Math.round(((value - prior) / prior) * 100)
}

function metric(label: string, value: number, prior: number, unit: 'count' | 'currency' = 'count'): ManagerWeeklyMetric {
  return { label, value, prior, deltaPct: deltaPct(value, prior), unit }
}

export async function generateManagerWeeklyPnl(brokerageId: string): Promise<ManagerWeeklyScorecard[]> {
  const supabase = createServiceClient()
  const now = Date.now()
  const thisFrom = new Date(now - WEEK_MS).toISOString()
  const thisTo = new Date(now).toISOString()
  const priorFrom = new Date(now - 2 * WEEK_MS).toISOString()
  const priorTo = thisFrom
  // Closings compare on a date (not timestamp) column.
  const thisFromDate = thisFrom.slice(0, 10)
  const thisToDate = thisTo.slice(0, 10)
  const priorFromDate = priorFrom.slice(0, 10)
  const priorToDate = priorTo.slice(0, 10)

  // Fire every window count/sum concurrently — two windows per metric.
  const [
    isaThis, isaPrior,
    offersThis, offersPrior, matchesThis, matchesPrior,
    showingsThis, showingsPrior, listingsThis, listingsPrior,
    ucThis, ucPrior, closeThis, closePrior, gciThis, gciPrior,
    touchThis, touchPrior, referThis, referPrior,
    sentThis, sentPrior,
  ] = await Promise.all([
    // AI ISA — qualified handoffs
    countWindow(supabase, 'assignment_log', 'created_at', brokerageId, thisFrom, thisTo),
    countWindow(supabase, 'assignment_log', 'created_at', brokerageId, priorFrom, priorTo),
    // Shopping Agent — offers written + buyer matches
    countWindow(supabase, 'offers', 'created_at', brokerageId, thisFrom, thisTo),
    countWindow(supabase, 'offers', 'created_at', brokerageId, priorFrom, priorTo),
    countWindow(supabase, 'property_matches', 'created_at', brokerageId, thisFrom, thisTo),
    countWindow(supabase, 'property_matches', 'created_at', brokerageId, priorFrom, priorTo),
    // Listing Concierge — showings held + listings activated
    countWindow(supabase, 'showings', 'scheduled_at', brokerageId, thisFrom, thisTo, { eq: { status: 'completed' } }),
    countWindow(supabase, 'showings', 'scheduled_at', brokerageId, priorFrom, priorTo, { eq: { status: 'completed' } }),
    countWindow(supabase, 'listings', 'go_live_date', brokerageId, thisFromDate, thisToDate),
    countWindow(supabase, 'listings', 'go_live_date', brokerageId, priorFromDate, priorToDate),
    // Deal Coordinator — under contract, closings, GCI
    countWindow(supabase, 'transactions', 'contract_date', brokerageId, thisFromDate, thisToDate,
      { inList: { col: 'status', vals: ['under_contract', 'closing', 'closed'] } }),
    countWindow(supabase, 'transactions', 'contract_date', brokerageId, priorFromDate, priorToDate,
      { inList: { col: 'status', vals: ['under_contract', 'closing', 'closed'] } }),
    countWindow(supabase, 'transactions', 'close_date', brokerageId, thisFromDate, thisToDate, { eq: { status: 'closed' } }),
    countWindow(supabase, 'transactions', 'close_date', brokerageId, priorFromDate, priorToDate, { eq: { status: 'closed' } }),
    sumWindow(supabase, 'transactions', 'commission_amount', 'close_date', brokerageId, thisFromDate, thisToDate, { eq: { status: 'closed' } }),
    sumWindow(supabase, 'transactions', 'commission_amount', 'close_date', brokerageId, priorFromDate, priorToDate, { eq: { status: 'closed' } }),
    // Sphere Manager — lifetime touchpoints sent + referrals created
    countWindow(supabase, 'lifetime_customer_touchpoints', 'sent_date', brokerageId, thisFrom, thisTo),
    countWindow(supabase, 'lifetime_customer_touchpoints', 'sent_date', brokerageId, priorFrom, priorTo),
    countWindow(supabase, 'referrals', 'created_at', brokerageId, thisFrom, thisTo),
    countWindow(supabase, 'referrals', 'created_at', brokerageId, priorFrom, priorTo),
    // Campaign Orchestrator — client messages actually sent (released through the gate)
    countWindow(supabase, 'agent_client_messages', 'sent_at', brokerageId, thisFrom, thisTo, { eq: { status: 'sent' } }),
    countWindow(supabase, 'agent_client_messages', 'sent_at', brokerageId, priorFrom, priorTo, { eq: { status: 'sent' } }),
  ])

  const usd = (n: number) => `$${Math.round(n).toLocaleString()}`
  const cards: ManagerWeeklyScorecard[] = [
    {
      manager: 'ai_isa', label: MANAGERS.ai_isa.label,
      metrics: [metric('Qualified handoffs', isaThis, isaPrior)],
      headline: `${isaThis} qualified lead${isaThis === 1 ? '' : 's'} handed to agents this week`,
    },
    {
      manager: 'shopping_agent', label: MANAGERS.shopping_agent.label,
      metrics: [metric('Offers written', offersThis, offersPrior), metric('Buyer matches', matchesThis, matchesPrior)],
      headline: `${offersThis} offer${offersThis === 1 ? '' : 's'} written · ${matchesThis} buyer match${matchesThis === 1 ? '' : 'es'}`,
    },
    {
      manager: 'listing_concierge', label: MANAGERS.listing_concierge.label,
      metrics: [metric('Showings held', showingsThis, showingsPrior), metric('Listings activated', listingsThis, listingsPrior)],
      headline: `${showingsThis} showing${showingsThis === 1 ? '' : 's'} held · ${listingsThis} new listing${listingsThis === 1 ? '' : 's'} live`,
    },
    {
      manager: 'deal_coordinator', label: MANAGERS.deal_coordinator.label,
      metrics: [
        metric('Under contract', ucThis, ucPrior),
        metric('Closings', closeThis, closePrior),
        metric('GCI earned', gciThis, gciPrior, 'currency'),
      ],
      headline: closeThis > 0
        ? `${closeThis} closing${closeThis === 1 ? '' : 's'} · ${usd(gciThis)} GCI this week`
        : `${ucThis} deal${ucThis === 1 ? '' : 's'} under contract this week`,
    },
    {
      manager: 'sphere_of_influence', label: MANAGERS.sphere_of_influence.label,
      metrics: [metric('Lifetime touches', touchThis, touchPrior), metric('Referrals', referThis, referPrior)],
      headline: `${touchThis} past-client touch${touchThis === 1 ? '' : 'es'} · ${referThis} referral${referThis === 1 ? '' : 's'}`,
    },
    {
      manager: 'campaign_orchestrator', label: MANAGERS.campaign_orchestrator.label,
      metrics: [metric('Messages sent', sentThis, sentPrior)],
      headline: `${sentThis} approved client message${sentThis === 1 ? '' : 's'} sent this week`,
    },
  ]

  // Only show managers that produced something across either window (a card with
  // 0/0 on every metric is noise — the standup already covers idle managers).
  return cards.filter((c) => c.metrics.some((m) => m.value > 0 || m.prior > 0))
}
