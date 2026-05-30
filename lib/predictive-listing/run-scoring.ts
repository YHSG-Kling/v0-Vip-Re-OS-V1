/**
 * PLS SCORING ORCHESTRATOR
 *
 * Daily cron entry. For each brokerage, load active contacts in round-robin
 * order, run signal generators, apply deltas via the existing pipeline,
 * compute the rollup PLS score, and upsert into predictive_listing_scores.
 *
 * Round-robin: contacts are processed in `last_pls_scored_at NULLS FIRST`
 * order so newly-added contacts get scored quickly and the sphere refreshes
 * over time. Daily batch size capped per run to keep cron under timeout.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { applySignalDelta } from "@/lib/lead-intelligence/signal-extensions"
import {
  runTenureEquityGenerator,
  runNeighborSoldGenerator,
  runLifeEventGenerator,
  containsSensitiveSignal,
  type ContactForScoring,
  type RecentComp,
  type MarketContext,
  type PriorTransaction,
} from "./signal-generators"
import { evaluateAutoSendEligibility, queueAutoTouch } from "./auto-send"

interface RunScoringSummary {
  brokeragesProcessed: number
  contactsProcessed: number
  signalsApplied: number
  scoresAboveThreshold: number
  autoSendQueued: number
  errors: number
}

const PLS_BASE_SCORE = 30
const PLS_LIFETIME_CUSTOMER_BONUS = 10
const PLS_THRESHOLD = 60

/**
 * Cron entry point — process up to `maxContactsPerBrokerage` for each
 * brokerage with active contacts.
 */
export async function runDailyPredictiveListingScoring(params?: {
  maxContactsPerBrokerage?: number
  brokerageId?: string  // optional single-brokerage run for testing
}): Promise<RunScoringSummary> {
  const supabase = createServiceClient()
  const limit = params?.maxContactsPerBrokerage ?? 500

  const summary: RunScoringSummary = {
    brokeragesProcessed: 0,
    contactsProcessed: 0,
    signalsApplied: 0,
    scoresAboveThreshold: 0,
    autoSendQueued: 0,
    errors: 0,
  }

  // 1. Load brokerage list
  const brokerageQuery = supabase.from("brokerages").select("id")
  const { data: brokerages } = params?.brokerageId
    ? await brokerageQuery.eq("id", params.brokerageId)
    : await brokerageQuery

  if (!brokerages || brokerages.length === 0) return summary

  for (const brokerage of brokerages as Array<{ id: string }>) {
    try {
      const brokerageSummary = await processBrokerage(brokerage.id, limit)
      summary.brokeragesProcessed++
      summary.contactsProcessed += brokerageSummary.contactsProcessed
      summary.signalsApplied += brokerageSummary.signalsApplied
      summary.scoresAboveThreshold += brokerageSummary.scoresAboveThreshold
      summary.autoSendQueued += brokerageSummary.autoSendQueued
    } catch (err) {
      summary.errors++
      console.error(`[pls] brokerage ${brokerage.id} scoring failed:`, err)
    }
  }

  return summary
}

async function processBrokerage(
  brokerageId: string,
  contactLimit: number
): Promise<{
  contactsProcessed: number
  signalsApplied: number
  scoresAboveThreshold: number
  autoSendQueued: number
}> {
  const supabase = createServiceClient()

  // 1. Load contact batch in round-robin order
  const { data: contactsData } = await supabase
    .from("contacts")
    .select(
      "id, brokerage_id, agent_id, contact_type, zip_code, city, state, " +
        "home_value_estimate, home_owner_status, length_of_residence, " +
        "life_events, last_life_event_detected"
    )
    .eq("brokerage_id", brokerageId)
    .is("deleted_at", null)
    .not("agent_id", "is", null)
    .order("last_pls_scored_at", { ascending: true, nullsFirst: true })
    .limit(contactLimit)

  if (!contactsData || contactsData.length === 0) {
    return { contactsProcessed: 0, signalsApplied: 0, scoresAboveThreshold: 0, autoSendQueued: 0 }
  }

  const contacts = contactsData as unknown as ContactForScoring[]

  // 2. Pre-fetch shared data: market_data per zip + recent comps per zip + transactions per contact
  const zips = Array.from(new Set(contacts.map((c) => c.zip_code).filter(Boolean) as string[]))
  const contactIds = contacts.map((c) => c.id)

  const [marketByZip, compsByZip, priorByContact] = await Promise.all([
    fetchMarketData(zips),
    fetchRecentCompsByZip(zips, brokerageId),
    fetchPriorTransactionsByContact(contactIds),
  ])

  // 3. Per-contact scoring
  let signalsApplied = 0
  let scoresAboveThreshold = 0
  let autoSendQueued = 0

  for (const contact of contacts) {
    const market = contact.zip_code ? marketByZip.get(contact.zip_code) ?? null : null
    const comps = contact.zip_code ? compsByZip.get(contact.zip_code) ?? [] : []
    const prior = priorByContact.get(contact.id) ?? null

    // Run all 3 generators
    const allDeltas = [
      ...runTenureEquityGenerator({ contact, prior, market }),
      ...runNeighborSoldGenerator({ contact, recentCompsInZip: comps }),
      ...runLifeEventGenerator({ contact }),
    ]

    if (allDeltas.length === 0) {
      // Still update last_pls_scored_at so we don't re-process this contact
      // tomorrow with the same null result
      await supabase
        .from("contacts")
        .update({ last_pls_scored_at: new Date().toISOString() })
        .eq("id", contact.id)
      continue
    }

    // Apply each via the existing pipeline (idempotent + only-pushes-up)
    for (const delta of allDeltas) {
      const r = await applySignalDelta(delta)
      if (r.applied) signalsApplied++
    }

    // 4. Compute the PLS rollup score for this contact
    const motivationContrib = allDeltas.reduce(
      (sum, d) => sum + (d.boosts.motivation ?? 0),
      0
    )
    const isLifetimeCustomer = contact.contact_type === "lifetime_customer"
    const baseScore = PLS_BASE_SCORE + (isLifetimeCustomer ? PLS_LIFETIME_CUSTOMER_BONUS : 0)
    const plsScore = Math.min(100, baseScore + motivationContrib)
    const confidence = Math.max(0, Math.min(1, allDeltas.length / 4))

    // Top 3 signals by motivation contribution
    const topSignals = allDeltas
      .map((d) => ({
        key: (d.evidence as { signalKey?: string } | undefined)?.signalKey ?? "unknown",
        label: d.reason.replace(/^Predictive seller signal:\s*/, "").replace(/\s*\(confidence.*\)\.$/, ""),
        confidence: (d.evidence as { confidence?: number } | undefined)?.confidence ?? 0,
        motivationBoost: d.boosts.motivation ?? 0,
      }))
      .sort((a, b) => b.motivationBoost - a.motivationBoost)
      .slice(0, 3)

    // 5. Upsert rollup
    await supabase
      .from("predictive_listing_scores")
      .upsert(
        {
          contact_id: contact.id,
          agent_id: contact.agent_id,
          brokerage_id: brokerageId,
          pls_score: plsScore,
          confidence,
          signals_fired: allDeltas.length,
          contributing_motivation_total: motivationContrib,
          top_signals: topSignals,
          avm_value: contact.home_value_estimate,
          avm_source: "cached",
          scored_at: new Date().toISOString(),
        },
        { onConflict: "contact_id,brokerage_id" }
      )

    // 6. Update last_pls_scored_at for round-robin
    await supabase
      .from("contacts")
      .update({ last_pls_scored_at: new Date().toISOString() })
      .eq("id", contact.id)

    if (plsScore >= PLS_THRESHOLD) {
      scoresAboveThreshold++

      // 7. Auto-send eligibility — only fires if all gates pass
      const sensitive = containsSensitiveSignal(allDeltas)
      const eligibility = await evaluateAutoSendEligibility({
        contactId: contact.id,
        agentId: contact.agent_id,
        brokerageId,
        plsScore,
        containsSensitive: sensitive,
      })

      if (eligibility.eligible) {
        const queued = await queueAutoTouch({
          contactId: contact.id,
          agentId: contact.agent_id,
          brokerageId,
          plsScore,
          topSignals,
          channel: eligibility.channel,
          reviewWindowHours: eligibility.reviewWindowHours,
        })
        if (queued) autoSendQueued++
      }
    }
  }

  return {
    contactsProcessed: contacts.length,
    signalsApplied,
    scoresAboveThreshold,
    autoSendQueued,
  }
}

// ─── Pre-fetch helpers ──────────────────────────────────────────────────────

async function fetchMarketData(zips: string[]): Promise<Map<string, MarketContext>> {
  const map = new Map<string, MarketContext>()
  if (zips.length === 0) return map

  const supabase = createServiceClient()
  const { data } = await supabase
    .from("market_data")
    .select("zip_code, price_trend_pct_1yr, median_sale_price")
    .in("zip_code", zips)

  for (const row of (data as Array<{ zip_code: string; price_trend_pct_1yr: number | null; median_sale_price: number | null }>) ?? []) {
    map.set(row.zip_code, {
      zipCode: row.zip_code,
      // market_data stores percentages already (e.g., 5 for 5%); convert to decimal
      priceTrendPct1yr: row.price_trend_pct_1yr != null ? row.price_trend_pct_1yr / 100 : null,
      medianSalePrice: row.median_sale_price,
    })
  }
  return map
}

async function fetchRecentCompsByZip(
  zips: string[],
  _brokerageId: string
): Promise<Map<string, RecentComp[]>> {
  const map = new Map<string, RecentComp[]>()
  if (zips.length === 0) return map

  const supabase = createServiceClient()
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

  // cma_comparables doesn't have zip_code as a column; we filter by sale_date
  // and let the per-contact zip filtering happen in memory. For larger sets a
  // dedicated view would be ideal.
  const { data } = await supabase
    .from("cma_comparables")
    .select("id, address, sale_price, sale_date")
    .gte("sale_date", since)
    .order("sale_date", { ascending: false })
    .limit(1000)

  // Group by inferred zip from address
  for (const comp of (data as Array<{ id: string; address: string | null; sale_price: number | null; sale_date: string | null }>) ?? []) {
    if (!comp.address) continue
    const zipMatch = comp.address.match(/\b(\d{5})(?:-\d{4})?\b/)
    if (!zipMatch) continue
    const zip = zipMatch[1]
    if (!zips.includes(zip)) continue
    const list = map.get(zip) ?? []
    list.push({ ...comp, zip_code: zip })
    map.set(zip, list)
  }
  return map
}

async function fetchPriorTransactionsByContact(
  contactIds: string[]
): Promise<Map<string, PriorTransaction>> {
  const map = new Map<string, PriorTransaction>()
  if (contactIds.length === 0) return map

  const supabase = createServiceClient()
  const { data } = await supabase
    .from("transactions")
    .select("contact_id, purchase_price, close_date, status")
    .in("contact_id", contactIds)
    .eq("status", "closed")
    .not("close_date", "is", null)
    .order("close_date", { ascending: false })

  for (const txn of (data as Array<{ contact_id: string; purchase_price: number | null; close_date: string | null }>) ?? []) {
    if (!map.has(txn.contact_id)) {
      map.set(txn.contact_id, {
        contact_id: txn.contact_id,
        purchase_price: txn.purchase_price,
        close_date: txn.close_date,
      })
    }
  }
  return map
}
