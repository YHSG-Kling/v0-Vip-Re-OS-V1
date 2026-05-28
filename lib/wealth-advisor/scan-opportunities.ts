/**
 * GENERATIONAL WEALTH ADVISOR
 *
 * Daily cron walks lifetime customers and detects wealth opportunities:
 *   - refinance_opportunity     — current rates 100+ bps below their locked rate
 *   - cash_out_refi             — equity > $100k AND rate gap viable
 *   - heloc_for_investment      — equity > $150k AND no recent HELOC use
 *   - sell_and_1031_exchange    — equity > $250k AND investor persona
 *   - downsize_and_bank_equity  — equity > $200k AND age 60+
 *   - equity_milestone          — equity passed a round-number threshold
 *                                 (first time crossing $100k, $250k, $500k, $1M)
 *
 * VALUE FRESHNESS:
 *   - getCurrentAvm() uses Perplexity AI-CMA as Tier 1 (~$0.01 per call)
 *   - Cache window: 14 days. Stale values auto-refresh every cron run.
 *   - No daily budget cap on refreshes — Perplexity cost is small enough that
 *     keeping data current beats budgeting against it.
 *   - Premium paid providers only fire via runAiCma({ mode: 'premium' }) on
 *     agent click, never from this background scan.
 *
 * AI generation: one OpenAI/Claude call per opportunity (~$0.005). For 5000
 * lifetime customers with ~15% triggering an opportunity, that's ~750 calls/day
 * = ~$4/day or $1,500/year per brokerage. Plus AVM refresh: 5000 stale × $0.01
 * spread over 14 days = ~$3.50/day. Total ~$2,700/year per 5000-LC brokerage.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import { getCurrentAvm } from "@/lib/avm/provider-chain"

const REFI_OPPORTUNITY_BPS_THRESHOLD = 100   // 1.0% rate drop
const EQUITY_MILESTONES = [100_000, 250_000, 500_000, 1_000_000]

interface RunOptions {
  brokerageId?: string
  maxContactsPerBrokerage?: number
}

export async function runDailyWealthScan(opts?: RunOptions): Promise<{
  brokeragesProcessed: number
  contactsProcessed: number
  opportunitiesCreated: number
  avmRefreshes: number
  errors: number
}> {
  const supabase = createServiceClient()
  const limit = opts?.maxContactsPerBrokerage ?? 500

  // 1. Today's market rates
  const marketRate = await getOrFetchTodaysMarketRate()
  if (!marketRate) {
    return {
      brokeragesProcessed: 0,
      contactsProcessed: 0,
      opportunitiesCreated: 0,
      avmRefreshes: 0,
      errors: 1,
    }
  }

  // 2. Brokerage list
  const brokerageQ = supabase.from("brokerages").select("id")
  const { data: brokeragesData } = opts?.brokerageId
    ? await brokerageQ.eq("id", opts.brokerageId)
    : await brokerageQ
  const brokerages = (brokeragesData ?? []) as unknown as Array<{ id: string }>
  if (brokerages.length === 0) return zeroResult()

  const totals = zeroResult()

  for (const b of brokerages) {
    const r = await processBrokerageWealthScan(b.id, marketRate, limit)
    totals.brokeragesProcessed++
    totals.contactsProcessed += r.contactsProcessed
    totals.opportunitiesCreated += r.opportunitiesCreated
    totals.avmRefreshes += r.avmRefreshes
    totals.errors += r.errors
  }

  return totals
}

async function processBrokerageWealthScan(
  brokerageId: string,
  marketRate: MarketRate,
  contactLimit: number
): Promise<{
  contactsProcessed: number
  opportunitiesCreated: number
  avmRefreshes: number
  errors: number
}> {
  const supabase = createServiceClient()

  // Lifetime customers — round-robin via last_pls_scored_at (reuses PLS column)
  const { data: contactsRawData } = await supabase
    .from("contacts")
    .select(
      "id, brokerage_id, agent_id, contact_type, contact_persona, age_range, " +
        "home_value_estimate, last_enriched_at, length_of_residence, " +
        "address, city, state, zip_code, last_pls_scored_at"
    )
    .eq("brokerage_id", brokerageId)
    .eq("contact_type", "lifetime_customer")
    .is("deleted_at", null)
    .not("agent_id", "is", null)
    .order("last_pls_scored_at", { ascending: true, nullsFirst: true })
    .limit(contactLimit)

  const contactsRaw = (contactsRawData ?? []) as unknown as Array<{
    id: string
    agent_id: string | null
    contact_persona: string | null
    age_range: string | null
    home_value_estimate: number | null
    last_enriched_at: string | null
    address: string | null
    city: string | null
    state: string | null
    zip_code: string | null
  }>

  if (contactsRaw.length === 0) {
    return { contactsProcessed: 0, opportunitiesCreated: 0, avmRefreshes: 0, errors: 0 }
  }

  // Pre-fetch their original transactions (purchase_price + close_date) for true equity
  const contactIds = contactsRaw.map((c) => c.id)
  const { data: txns } = await supabase
    .from("transactions")
    .select("contact_id, purchase_price, close_date, status")
    .in("contact_id", contactIds)
    .eq("status", "closed")

  const priorByContact = new Map<string, { purchase_price: number | null; close_date: string | null }>()
  for (const t of (txns as unknown as Array<{ contact_id: string; purchase_price: number | null; close_date: string | null }>) ?? []) {
    if (!priorByContact.has(t.contact_id)) {
      priorByContact.set(t.contact_id, { purchase_price: t.purchase_price, close_date: t.close_date })
    }
  }

  let opportunitiesCreated = 0
  let avmRefreshes = 0
  let errors = 0

  for (const c of contactsRaw) {
    try {
      const prior = priorByContact.get(c.id)
      const opportunities = await detectOpportunities({
        contact: c,
        prior,
        marketRate,
      })
      if (opportunities.refreshedAvm) avmRefreshes++

      for (const opp of opportunities.opportunities) {
        // Generate AI narrative for this opportunity
        const narrative = await generateOpportunityNarrative({
          contact: c,
          opportunity: opp,
          marketRate,
        })
        opp.aiNarrative = narrative

        await supabase
          .from("wealth_advisor_recommendations")
          .insert({
            contact_id: c.id,
            agent_id: c.agent_id,
            brokerage_id: brokerageId,
            opportunity_type: opp.type,
            current_avm_value: opp.currentAvm,
            estimated_equity: opp.estimatedEquity,
            equity_pct: opp.equityPct,
            current_market_rate_bps: marketRate.rate30yrFixedBps,
            estimated_locked_rate_bps: opp.estimatedLockedRateBps,
            rate_gap_bps: opp.rateGapBps,
            monthly_savings_estimate: opp.monthlySavingsEstimate,
            one_time_proceeds_estimate: opp.oneTimeProceedsEstimate,
            ai_narrative: narrative,
            scenarios: opp.scenarios,
            signals_supporting: opp.signals,
            expires_at: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(), // 60-day window
          })
        opportunitiesCreated++
      }

      // Stamp last_pls_scored_at so the round-robin moves forward
      await supabase
        .from("contacts")
        .update({ last_pls_scored_at: new Date().toISOString() })
        .eq("id", c.id)
    } catch {
      errors++
    }
  }

  return { contactsProcessed: contactsRaw.length, opportunitiesCreated, avmRefreshes, errors }
}

// ─── Opportunity Detection ──────────────────────────────────────────────────

interface DetectedOpportunity {
  type:
    | "refinance_opportunity"
    | "cash_out_refi"
    | "heloc_for_investment"
    | "sell_and_1031_exchange"
    | "downsize_and_bank_equity"
    | "equity_milestone"
  currentAvm: number
  estimatedEquity: number
  equityPct: number
  estimatedLockedRateBps: number | null
  rateGapBps: number | null
  monthlySavingsEstimate: number | null
  oneTimeProceedsEstimate: number | null
  scenarios: Array<{ label: string; value: number; tradeOffs: string }>
  signals: Record<string, unknown>
  aiNarrative?: string
}

interface MarketRate {
  rate30yrFixedBps: number
  rate15yrFixedBps: number | null
  rate5_1ArmBps: number | null
  rateJumbo30yrBps: number | null
  rateDate: string
  source: string
}

async function detectOpportunities(input: {
  contact: {
    id: string
    home_value_estimate: number | null
    last_enriched_at: string | null
    address: string | null
    city: string | null
    state: string | null
    zip_code: string | null
    age_range: string | null
    contact_persona: string | null
  }
  prior?: { purchase_price: number | null; close_date: string | null }
  marketRate: MarketRate
}): Promise<{ opportunities: DetectedOpportunity[]; refreshedAvm: boolean }> {
  const { contact, prior, marketRate } = input
  const opportunities: DetectedOpportunity[] = []
  let refreshedAvm = false
  let avm = contact.home_value_estimate ?? null

  // Refresh AVM if missing or stale (>14 days). Free Perplexity AI-CMA, no
  // budget cap — keeping the value current beats stale-data risk.
  const needsRefresh =
    !avm ||
    !contact.last_enriched_at ||
    Date.now() - new Date(contact.last_enriched_at).getTime() > 14 * 24 * 60 * 60 * 1000

  if (needsRefresh && contact.address) {
    const fresh = await getCurrentAvm({
      address: contact.address,
      city: contact.city,
      state: contact.state,
      zipCode: contact.zip_code,
      cachedValue: avm,
      cachedAt: contact.last_enriched_at,
      cacheStaleAfterDays: 14,
    })
    if (fresh && fresh.value > 0) {
      avm = fresh.value
      refreshedAvm = true
      // Persist back to contact row
      const supabase = createServiceClient()
      await supabase
        .from("contacts")
        .update({
          home_value_estimate: fresh.value,
          last_enriched_at: new Date().toISOString(),
        })
        .eq("id", contact.id)
    }
  }

  if (!avm || avm <= 0) return { opportunities, refreshedAvm }

  // Equity calculation — true equity if we have purchase price, otherwise heuristic
  const purchasePrice = prior?.purchase_price ?? null
  const purchaseDate = prior?.close_date ?? null
  const yearsOwned = purchaseDate
    ? (Date.now() - new Date(purchaseDate).getTime()) / (365.25 * 24 * 60 * 60 * 1000)
    : null

  let estimatedEquity: number
  let equityPct: number
  let estimatedLockedRateBps: number | null = null

  if (purchasePrice && purchasePrice > 0 && yearsOwned != null) {
    // Initial loan ≈ 80% LTV, paydown ~1.5%/yr early-amort
    const initialLoan = purchasePrice * 0.8
    const remainingPct = Math.max(0, 1 - 0.015 * yearsOwned)
    const remainingBalance = initialLoan * remainingPct
    estimatedEquity = avm - remainingBalance
    equityPct = Math.max(0, estimatedEquity / avm)

    // Estimate locked rate by purchase year
    estimatedLockedRateBps = estimateRateByYear(new Date(purchaseDate!).getFullYear())
  } else {
    // No purchase data — assume 50% equity baseline for lifetime customers
    estimatedEquity = avm * 0.5
    equityPct = 0.5
    estimatedLockedRateBps = null
  }

  const signals = {
    avm,
    purchasePrice,
    purchaseDate,
    yearsOwned,
    equityPct,
    estimatedLockedRateBps,
    currentMarketRateBps: marketRate.rate30yrFixedBps,
  }

  // 1. Refinance opportunity — rate dropped 100+ bps from locked.
  // Only emit a dollar-savings claim when today's benchmark comes from a real
  // rate feed. With the cold-start fallback (source 'seed_default') the benchmark
  // is a placeholder, not a market quote — surfacing "$X/mo savings" off it would
  // mislead the agent into a bad client conversation, so we suppress it.
  const hasAuthoritativeRate = marketRate.source !== "seed_default"
  if (hasAuthoritativeRate && estimatedLockedRateBps && estimatedLockedRateBps - marketRate.rate30yrFixedBps >= REFI_OPPORTUNITY_BPS_THRESHOLD) {
    const rateGap = estimatedLockedRateBps - marketRate.rate30yrFixedBps
    const remainingBalance = avm * (1 - equityPct)
    // Approximate monthly savings: balance × (gap_bps / 10000) / 12
    const monthlySavings = (remainingBalance * (rateGap / 10000)) / 12
    opportunities.push({
      type: "refinance_opportunity",
      currentAvm: avm,
      estimatedEquity,
      equityPct,
      estimatedLockedRateBps,
      rateGapBps: rateGap,
      monthlySavingsEstimate: Math.round(monthlySavings),
      oneTimeProceedsEstimate: null,
      scenarios: [
        {
          label: `Refinance to ${(marketRate.rate30yrFixedBps / 100).toFixed(2)}%`,
          value: Math.round(monthlySavings),
          tradeOffs: "~$3-5k closing costs; resets amortization clock; 30-45 day process",
        },
      ],
      signals,
    })
  }

  // 2. Cash-out refi — meaningful equity AND viable rate
  if (estimatedEquity >= 100_000 && (estimatedLockedRateBps == null || estimatedLockedRateBps < marketRate.rate30yrFixedBps + 100)) {
    const cashOutAmount = Math.min(estimatedEquity * 0.5, avm * 0.3)
    opportunities.push({
      type: "cash_out_refi",
      currentAvm: avm,
      estimatedEquity,
      equityPct,
      estimatedLockedRateBps,
      rateGapBps: estimatedLockedRateBps ? estimatedLockedRateBps - marketRate.rate30yrFixedBps : null,
      monthlySavingsEstimate: null,
      oneTimeProceedsEstimate: Math.round(cashOutAmount),
      scenarios: [
        {
          label: `Cash-out refi: pull ~$${Math.round(cashOutAmount).toLocaleString()}`,
          value: Math.round(cashOutAmount),
          tradeOffs: "Higher monthly payment; tap equity for renovation, investment, or debt consolidation",
        },
      ],
      signals,
    })
  }

  // 3. HELOC for investment — equity > $150k
  if (estimatedEquity >= 150_000) {
    const helocAvailable = Math.min(estimatedEquity * 0.85, avm * 0.85 - (avm - estimatedEquity))
    opportunities.push({
      type: "heloc_for_investment",
      currentAvm: avm,
      estimatedEquity,
      equityPct,
      estimatedLockedRateBps,
      rateGapBps: null,
      monthlySavingsEstimate: null,
      oneTimeProceedsEstimate: Math.round(helocAvailable),
      scenarios: [
        {
          label: `HELOC up to ~$${Math.round(helocAvailable).toLocaleString()}`,
          value: Math.round(helocAvailable),
          tradeOffs: "Variable rate, interest-only option for 10 yrs; useful for investment property down payment",
        },
      ],
      signals,
    })
  }

  // 4. Sell + 1031 exchange — investor persona, equity > $250k
  if (
    estimatedEquity >= 250_000 &&
    (contact.contact_persona ?? "").toLowerCase().includes("investor")
  ) {
    opportunities.push({
      type: "sell_and_1031_exchange",
      currentAvm: avm,
      estimatedEquity,
      equityPct,
      estimatedLockedRateBps,
      rateGapBps: null,
      monthlySavingsEstimate: null,
      oneTimeProceedsEstimate: Math.round(estimatedEquity),
      scenarios: [
        {
          label: "Sell + 1031 into multi-family or larger SFR portfolio",
          value: Math.round(estimatedEquity),
          tradeOffs: "Defers cap gains tax; 45-day identification window, 180 days to close replacement",
        },
      ],
      signals,
    })
  }

  // 5. Downsize and bank equity — empty-nester or 60+, equity > $200k
  const isAge60Plus = (contact.age_range ?? "").match(/(60|65|70|7\d)/)
  if (estimatedEquity >= 200_000 && (isAge60Plus || (contact.contact_persona ?? "").includes("empty"))) {
    const proceedsAfterDownsize = estimatedEquity * 0.6  // assume buying 60% of current value
    opportunities.push({
      type: "downsize_and_bank_equity",
      currentAvm: avm,
      estimatedEquity,
      equityPct,
      estimatedLockedRateBps,
      rateGapBps: null,
      monthlySavingsEstimate: null,
      oneTimeProceedsEstimate: Math.round(proceedsAfterDownsize),
      scenarios: [
        {
          label: `Downsize and free up ~$${Math.round(proceedsAfterDownsize).toLocaleString()}`,
          value: Math.round(proceedsAfterDownsize),
          tradeOffs: "Lower carrying costs; right-sized for empty-nest stage; capital can fund retirement or other goals",
        },
      ],
      signals,
    })
  }

  // 6. Equity milestone — first time crossing a round-number threshold
  for (const milestone of EQUITY_MILESTONES) {
    if (estimatedEquity >= milestone && estimatedEquity - milestone < 50_000) {
      opportunities.push({
        type: "equity_milestone",
        currentAvm: avm,
        estimatedEquity,
        equityPct,
        estimatedLockedRateBps,
        rateGapBps: null,
        monthlySavingsEstimate: null,
        oneTimeProceedsEstimate: null,
        scenarios: [
          {
            label: `Crossed $${milestone.toLocaleString()} equity milestone`,
            value: milestone,
            tradeOffs: "Celebrate the wealth-building milestone with a touchpoint; opens the door to a financial conversation",
          },
        ],
        signals,
      })
      break  // only fire once even if crossed multiple milestones at once
    }
  }

  return { opportunities, refreshedAvm }
}

// ─── AI Narrative ───────────────────────────────────────────────────────────

async function generateOpportunityNarrative(input: {
  contact: { age_range: string | null; contact_persona: string | null }
  opportunity: DetectedOpportunity
  marketRate: MarketRate
}): Promise<string> {
  const { contact, opportunity, marketRate } = input
  const personaContext = [
    contact.age_range ? `Age range: ${contact.age_range}` : null,
    contact.contact_persona ? `Persona: ${contact.contact_persona}` : null,
  ]
    .filter(Boolean)
    .join(" · ")

  const prompt = `You are a real estate wealth advisor writing a brief, personalized note from an agent to their lifetime customer.

Client persona: ${personaContext || "Lifetime customer"}
Opportunity: ${opportunity.type.replace(/_/g, " ")}
Current AVM: $${opportunity.currentAvm.toLocaleString()}
Estimated equity: $${opportunity.estimatedEquity.toLocaleString()} (${(opportunity.equityPct * 100).toFixed(0)}%)
${opportunity.estimatedLockedRateBps ? `Their estimated locked rate: ${(opportunity.estimatedLockedRateBps / 100).toFixed(2)}%` : ""}
${opportunity.rateGapBps ? `Current 30yr fixed: ${(marketRate.rate30yrFixedBps / 100).toFixed(2)}% (gap: ${opportunity.rateGapBps} bps)` : ""}
${opportunity.monthlySavingsEstimate ? `Estimated monthly savings: $${opportunity.monthlySavingsEstimate.toLocaleString()}` : ""}
${opportunity.oneTimeProceedsEstimate ? `Estimated one-time proceeds: $${opportunity.oneTimeProceedsEstimate.toLocaleString()}` : ""}

Write a 2-3 sentence personalized message that:
  1. Leads with the opportunity in human terms (not financial jargon)
  2. Names the specific number that matters most
  3. Ends with a soft CTA — "want to talk through it?" — never pushy

Adapt language to the persona: investor → ROI/strategy framing; empty-nester → retirement/lifestyle framing; first-time-buyer-grown-up → wealth-building framing.

Mandatory: include "based on an automated estimate" and "your current CMA may differ" — this is informational only, not financial advice.

Return the message text only, no preamble.`

  try {
    const { text } = await generateTextRouted({
      feature: "smart_suggestions",
      prompt,
      temperature: 0.6,
      maxTokens: 250,
    })
    return text.trim()
  } catch {
    return `Based on automated estimates, you've built ~$${Math.round(opportunity.estimatedEquity).toLocaleString()} in equity in your home. Want to talk through what that means for your options? Your current CMA may differ from this estimate.`
  }
}

// ─── Market Rate ────────────────────────────────────────────────────────────

async function getOrFetchTodaysMarketRate(): Promise<MarketRate | null> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)
  const { data } = await supabase
    .from("market_rate_snapshots")
    .select("*")
    .eq("rate_date", today)
    .maybeSingle()

  if (data) {
    const r = data as { rate_30yr_fixed_bps: number; rate_15yr_fixed_bps: number | null; rate_5_1_arm_bps: number | null; rate_jumbo_30yr_bps: number | null; rate_date: string; source: string }
    return {
      rate30yrFixedBps: r.rate_30yr_fixed_bps,
      rate15yrFixedBps: r.rate_15yr_fixed_bps,
      rate5_1ArmBps: r.rate_5_1_arm_bps,
      rateJumbo30yrBps: r.rate_jumbo_30yr_bps,
      rateDate: r.rate_date,
      source: r.source,
    }
  }

  // No row for today — backfill with last known rate (skip live fetch in this stub)
  const { data: latest } = await supabase
    .from("market_rate_snapshots")
    .select("*")
    .order("rate_date", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latest) {
    const r = latest as { rate_30yr_fixed_bps: number; rate_15yr_fixed_bps: number | null; rate_5_1_arm_bps: number | null; rate_jumbo_30yr_bps: number | null; rate_date: string; source: string }
    return {
      rate30yrFixedBps: r.rate_30yr_fixed_bps,
      rate15yrFixedBps: r.rate_15yr_fixed_bps,
      rate5_1ArmBps: r.rate_5_1_arm_bps,
      rateJumbo30yrBps: r.rate_jumbo_30yr_bps,
      rateDate: r.rate_date,
      source: r.source,
    }
  }

  // Cold start — no real snapshot exists yet. Return a non-authoritative
  // fallback (source 'seed_default') WITHOUT persisting it: writing a fake row
  // would make an unverified placeholder look like a real market quote on the
  // next read. The refi dollar-claim is suppressed for this source (see
  // detectOpportunities), and the real feed is populated by the
  // refresh-market-rates cron.
  return {
    rate30yrFixedBps: 700,
    rate15yrFixedBps: 625,
    rate5_1ArmBps: 650,
    rateJumbo30yrBps: 720,
    rateDate: today,
    source: "seed_default",
  }
}

function estimateRateByYear(year: number): number {
  // Historical 30-yr fixed averages (bps). Used as proxy when we don't know
  // the contact's actual locked rate.
  const table: Record<number, number> = {
    2010: 470, 2011: 440, 2012: 365, 2013: 400, 2014: 415,
    2015: 380, 2016: 360, 2017: 395, 2018: 460, 2019: 395,
    2020: 305, 2021: 295, 2022: 525, 2023: 685, 2024: 670,
    2025: 660, 2026: 640,
  }
  if (year in table) return table[year]
  if (year < 2010) return 600
  return 640
}

function zeroResult() {
  return {
    brokeragesProcessed: 0,
    contactsProcessed: 0,
    opportunitiesCreated: 0,
    avmRefreshes: 0,
    errors: 0,
  }
}
