import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { verifyCronAuth } from "@/lib/cron-auth"
import {
  createCronRunContextAction, recordCronStartAction, recordCronSuccessAction, recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { resolveActiveScrapeTerritories } from "@/lib/lead-pipeline/scrape-territories"
import { ingestPermitSignals, type PermitScanTerritory } from "@/lib/external/permit-signals"
import { listSupportedMarkets } from "@/lib/external/socrata-market-registry"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * PERMIT SIGNAL SCAN — the daily cadence lib/external/socrata-market-registry.ts described and
 * nobody built: "run recentPermits() against each dataset descriptor on a daily cadence per active
 * brokerage market".
 *
 * City building permits are public, dated and address-keyed. Where one lands on a lead the
 * brokerage already owns, that is a motivated-seller signal, and it is filed into the OS's ONE
 * signal table — `motivated_seller_signals`, the same table lead scoring and conversion prediction
 * already read. No parallel signal spine, no new table.
 *
 * SCOPE. Territories come from the canonical pre-scrape resolver
 * (lib/lead-pipeline/scrape-territories.ts): active-subscription tenants only, their own configured
 * markets only. No active subscribers or no configured territory → an honest no-op with the reason
 * stated, never a fallback to scraping fixed geography.
 *
 * COVERAGE. Every ACTIVE TERRITORY gets a verdict every run — `market_coverage`, and its
 * actionable half `market_gaps` — because the owner ruling is "all markets from the active tenant
 * territories", and a sweep that reports only what the registry happens to contain is answering a
 * different question. A tenant farming a city nobody registered is now NAMED in the output
 * ("FL:Pensacola (unregistered)") instead of receiving a zero.
 *
 * TWO SIGNAL KINDS. Building permits (`permit_activity`) and city code violations
 * (`code_violation`). A permit says money is going INTO a house; a violation says the city is
 * billing the owner for one they are not maintaining. Both are public, dated and address-keyed.
 *
 * HONESTY. Per-brokerage errors are collected and returned; a run with any refusal reports
 * `ok: false` with the refusals verbatim, so a Socrata outage or a refused insert can never read
 * as "no permits today".
 *
 * Scheduled by lib/kernel/cron-dispatch.ts (the single-heartbeat dispatcher); owned by
 * data_steward in CRON_MANAGER. Auth matches every neighbour: Bearer CRON_SECRET via verifyCronAuth.
 */
export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "permit-signal-scan",
    cron_path: "/app/api/cron/permit-signal-scan/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()

  try {
    const resolution = await resolveActiveScrapeTerritories(supabase)
    if (resolution.noOp) {
      await recordCronSuccessAction({
        context_id: contextId,
        records_processed: 0,
        metadata: { no_op_reason: resolution.reason, error: resolution.error ?? null },
      }).catch(() => {})
      // A FAILED territory query is not an idle pipeline — it is reported as a failure status.
      const failed = resolution.reason === "territory_query_failed"
      return NextResponse.json(
        { ok: !failed, no_op_reason: resolution.reason, error: resolution.error ?? null },
        { status: failed ? 500 : 200 },
      )
    }

    // Permits publish with a lag and datasets backfill, so the window is wider than the cadence.
    // Re-seeing a permit is free: ingestPermitSignals dedupes on signal_details.dedupe_key.
    const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    const byBrokerage = new Map<string, PermitScanTerritory[]>()
    for (const t of resolution.territories as PermitScanTerritory[]) {
      if (!t.brokerage_id) continue
      const list = byBrokerage.get(t.brokerage_id)
      if (list) list.push(t)
      else byBrokerage.set(t.brokerage_id, [t])
    }

    const errors: string[] = []
    const unavailableReasons = new Set<string>()
    /**
     * ONE ROW PER DATASET ACTUALLY QUERIED, deduped across brokerages (many tenants can name the
     * same market, and the dataset's health is a fact about the PORTAL, not about the tenant).
     *
     * This is the run's answer to the question the totals below cannot answer: `permits_fetched`
     * is a sum, so a feed that died reads as a smaller number and nothing says which one. With
     * this, "served 0 rows" and "refused" are two different lines with two different `ok` values.
     */
    const datasetHealth = new Map<string, { dataset: string; label: string; provider: string; status: number | null; ok: boolean; rows: number; matched: number; truncated: boolean; error: string | null }>()
    /** market label → { status, reasons }, deduped across brokerages. THE coverage answer. */
    const coverageByMarket = new Map<string, { status: string; reasons: string[] }>()
    const totals = {
      brokerages: 0,
      datasets_queried: 0,
      datasets_skipped_no_date_column: 0,
      datasets_unavailable: 0,
      markets_unregistered: 0,
      permits_fetched: 0,
      skipped_no_address: 0,
      skipped_no_lead_match: 0,
      skipped_outside_window: 0,
      skipped_no_event_date: 0,
      already_recorded: 0,
      signals_written: 0,
    }

    for (const [brokerageId, territories] of byBrokerage) {
      totals.brokerages++
      try {
        const r = await ingestPermitSignals({ supabase, brokerageId, territories, sinceIso })
        totals.datasets_queried += r.datasetsQueried
        totals.datasets_skipped_no_date_column += r.datasetsSkippedNoDateColumn
        totals.datasets_unavailable += r.datasetsUnavailable
        for (const reason of r.unavailableReasons) unavailableReasons.add(reason)
        for (const c of r.coverage) coverageByMarket.set(c.market, { status: c.status, reasons: c.reasons })
        // Keep the FIRST verdict per dataset. A later brokerage querying the same portal in the
        // same run gets the same answer, and overwriting would let a second tenant's read hide
        // the first's refusal.
        for (const p of r.datasetHealth) if (!datasetHealth.has(p.dataset)) datasetHealth.set(p.dataset, p)
        totals.markets_unregistered += r.marketsUnregistered
        totals.permits_fetched += r.permitsFetched
        totals.skipped_no_address += r.skippedNoAddress
        totals.skipped_no_lead_match += r.skippedNoLeadMatch
        totals.skipped_outside_window += r.skippedOutsideWindow
        totals.skipped_no_event_date += r.skippedNoEventDate
        totals.already_recorded += r.alreadyRecorded
        totals.signals_written += r.signalsWritten
        for (const e of r.errors) errors.push(`${brokerageId}: ${e}`)
      } catch (e) {
        errors.push(`${brokerageId}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // ── THE COVERAGE ANSWER, ALWAYS PRESENT ──────────────────────────────────
    //
    // OWNER RULING: "all markets from the active tenant territories for motivational sellers."
    // The run therefore reports one verdict per ACTIVE TERRITORY, every run, whether or not
    // anything was found — because the failure this lane keeps re-learning is that a market we
    // CANNOT READ looks exactly like a market with nothing happening in it. `market_coverage` is
    // that answer, and `market_gaps` is its actionable half: every territory that produced no
    // queryable dataset, BY NAME, with which of the four kinds of gap it is:
    //   covered      — a verified, bounded, serving dataset exists
    //   unregistered — this OS has no dataset for this market at all (the loudest gap)
    //   unavailable  — registered and known broken; the reason is in unavailable_datasets
    //   unboundable  — registered and alive, but no verified date column to bound "recent" on
    const marketCoverage = [...coverageByMarket.entries()]
      .map(([market, v]) => ({ market, status: v.status }))
      .sort((a, b) => a.market.localeCompare(b.market))
    // A gap carries its stated reasons, so "TX:Dallas (unavailable)" is never a dead end — the
    // operator sees WHY without opening the registry. `unregistered` has none by construction:
    // there is nothing registered to state a reason about, and that IS the reason.
    const marketGaps = marketCoverage
      .filter((m) => m.status !== "covered")
      .map((m) => ({ ...m, reasons: coverageByMarket.get(m.market)?.reasons ?? [] }))

    // The supported list rides along whenever ANY territory fell through, so the operator can see
    // what IS covered next to what is not. socrata-market-registry.MARKETS is the place to extend.
    const supportedMarkets = marketGaps.length > 0 ? listSupportedMarkets() : undefined

    // A dataset the registry itself marks broken is a REGISTRY DEFECT, and it rides back with the
    // reason attached. Without this the run reports "0 signals" for a tenant whose only market is
    // a dead portal, and the operator has no way to tell that from a week with no permits.
    const unavailable = unavailableReasons.size > 0 ? [...unavailableReasons] : undefined

    // Sorted so the FAILURES read first. A run that queried nine healthy datasets and one dead
    // one should not bury the dead one ten lines down in an operator's log.
    const health = [...datasetHealth.values()].sort((a, b) =>
      a.ok === b.ok ? a.dataset.localeCompare(b.dataset) : (a.ok ? 1 : -1))
    /** Datasets that served but returned NOTHING — the state that used to be invisible. Named
     *  here so a feed going quiet is something an operator can watch, not something they infer
     *  from a total that got smaller. */
    const silent = health.filter((h) => h.ok && h.rows === 0).map((h) => h.dataset)

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: totals.signals_written,
      metadata: {
        ...totals, since: sinceIso,
        market_coverage: marketCoverage, market_gaps: marketGaps,
        supported_markets: supportedMarkets,
        dataset_health: health,
        datasets_silent: silent.length > 0 ? silent : undefined,
        unavailable_datasets: unavailable, errors: errors.slice(0, 20),
      },
    }).catch(() => {})

    return NextResponse.json({
      ok: errors.length === 0,
      since: sinceIso,
      ...totals,
      markets_covered: marketCoverage.length - marketGaps.length,
      market_coverage: marketCoverage,
      market_gaps: marketGaps,
      supported_markets: supportedMarkets,
      // PER-DATASET, ALWAYS PRESENT. `permits_fetched` is the sum; this is the breakdown, and it
      // is the only thing in this response that can distinguish a quiet portal from a dead one.
      dataset_health: health,
      datasets_silent: silent.length > 0 ? silent : undefined,
      unavailable_datasets: unavailable,
      errors: errors.slice(0, 20),
    })
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 })
  }
}
