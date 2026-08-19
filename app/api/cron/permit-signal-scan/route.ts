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
    const totals = {
      brokerages: 0,
      datasets_queried: 0,
      datasets_skipped_no_date_column: 0,
      markets_unregistered: 0,
      permits_fetched: 0,
      skipped_no_address: 0,
      skipped_no_lead_match: 0,
      already_recorded: 0,
      signals_written: 0,
    }

    for (const [brokerageId, territories] of byBrokerage) {
      totals.brokerages++
      try {
        const r = await ingestPermitSignals({ supabase, brokerageId, territories, sinceIso })
        totals.datasets_queried += r.datasetsQueried
        totals.datasets_skipped_no_date_column += r.datasetsSkippedNoDateColumn
        totals.markets_unregistered += r.marketsUnregistered
        totals.permits_fetched += r.permitsFetched
        totals.skipped_no_address += r.skippedNoAddress
        totals.skipped_no_lead_match += r.skippedNoLeadMatch
        totals.already_recorded += r.alreadyRecorded
        totals.signals_written += r.signalsWritten
        for (const e of r.errors) errors.push(`${brokerageId}: ${e}`)
      } catch (e) {
        errors.push(`${brokerageId}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // "markets_unregistered > 0" is a REGISTRY GAP, not an empty market, and it is only
    // actionable if the operator can see what IS covered — so the supported list rides along
    // whenever a territory fell through. socrata-market-registry.MARKETS is the place to extend.
    const supportedMarkets = totals.markets_unregistered > 0 ? listSupportedMarkets() : undefined

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: totals.signals_written,
      metadata: { ...totals, since: sinceIso, supported_markets: supportedMarkets, errors: errors.slice(0, 20) },
    }).catch(() => {})

    return NextResponse.json({
      ok: errors.length === 0,
      since: sinceIso,
      ...totals,
      supported_markets: supportedMarkets,
      errors: errors.slice(0, 20),
    })
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e))
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 })
  }
}
