import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  attributeTransactionSafe,
  findTransactionsNeedingAttribution,
} from "@/lib/marketing/attribution"
import { resolveSequenceConversions } from "@/lib/campaign-sequences/sequence-conversion"
import { rollupSequenceCounters, type SequenceCounterRollup } from "@/lib/campaign-sequences/sequence-counters"
import { verifyCronAuth } from "@/lib/cron-auth"
import { platformScope } from "@/lib/kernel/tenant-scope"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"

/**
 * Marketing Attribution Engine — Sprint 9 cont.
 *
 * Daily cron. Finds recently-closed (or under-contract) transactions
 * that haven't been attributed yet and runs all 4 attribution models
 * (first_touch / last_touch / linear / time_decay) against each.
 *
 * Writes marketing_attribution_credits rows + rolls the linear model
 * into marketing_campaigns.attributed_gci_total so the admin UI shows
 * per-campaign ROI without extra queries.
 *
 * Cap: 50 transactions per run to bound cost.
 */

const MAX_PER_RUN  = 50
const LOOKBACK_DAYS = 14

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "marketing-attribution-engine",
    cron_path: "/app/api/cron/marketing-attribution-engine/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const svc = createServiceClient()
  // Wave 152 (152B): candidates are NEW and STALE work — a credited deal whose commission changed is refreshed, a
  // credited deal that fell through is RETRACTED (lib/marketing/attribution.ts). Both are counted below.
  const results: Array<{ txnId: string; totalCredits?: number; outcome?: "credited" | "retracted"; removedRows?: number; enrollmentsConverted?: number; error?: string }> = []

  try {
    // Platform-wide BY DESIGN (verifyCronAuth above): the scan crosses tenants; each candidate is credited only
    // inside its own tenant. Stated, not inferred (lib/kernel/tenant-scope.ts).
    const candidates = await findTransactionsNeedingAttribution(
      svc,
      platformScope("daily marketing-attribution cron (CRON_SECRET-verified): finds every tenant's recently changed deals; each is credited only within its own brokerage"),
      LOOKBACK_DAYS,
    )
    const toProcess  = candidates.slice(0, MAX_PER_RUN)

    for (const txnId of toProcess) {
      try {
        const r = await attributeTransactionSafe(svc, txnId)
        // SEQUENCE-SIDE CONVERSION, same event, same pass. The campaign side
        // splits GCI across touching campaigns; the sequence side answers the
        // simpler question its own report asks — did a sequence that was
        // working this contact end in a deal? Both were previously unanswered
        // for sequences: status='converted', converted_at and conversions_total
        // all existed with no writer, so the Workflow Reports conversion tiles
        // showed a permanent zero. Failing here must not lose the attribution
        // that already succeeded, so it is caught separately.
        let enrollmentsConverted: number | undefined
        // A deal that fell through is not a conversion — only a credited (live) deal reaches the sequence side.
        if (r?.outcome !== "retracted") {
          try {
            const c = await resolveSequenceConversions(svc, txnId)
            enrollmentsConverted = c?.enrollmentsConverted
          } catch (convErr) {
            console.error(`[attribution] sequence conversion failed for ${txnId}:`, convErr)
          }
        }
        if (r) {
          results.push({ txnId, totalCredits: r.totalCredits, outcome: r.outcome, removedRows: r.removedRows, enrollmentsConverted })
        }
      } catch (err) {
        results.push({ txnId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    // SEQUENCE COUNTERS, same daily pass (wave 84E). completions_total had no writer
    // at all and enrollments_total was bumped by only three of seven enrollment writers,
    // so the sequences list rendered "0 completed" and an under-count. Reconciled from
    // sequence_enrollments here; a failure is reported by name and never loses the
    // attribution above.
    let sequenceCounters: SequenceCounterRollup | { error: string }
    try {
      sequenceCounters = await rollupSequenceCounters(svc)
    } catch (counterErr) {
      sequenceCounters = { error: counterErr instanceof Error ? counterErr.message : String(counterErr) }
      console.error("[attribution] sequence counter rollup failed:", counterErr)
    }

    const summary = {
      sequence_counters: sequenceCounters,
      candidates_found: candidates.length,
      processed:        toProcess.length,
      attributed:       results.filter(r => !r.error && r.outcome === "credited").length,
      retracted:        results.filter(r => r.outcome === "retracted").length,
      credit_rows_removed: results.reduce((s, r) => s + (r.removedRows ?? 0), 0),
      failed:           results.filter(r => r.error).length,
      enrollments_converted: results.reduce((s, r) => s + (r.enrollmentsConverted ?? 0), 0),
    }

    await recordCronSuccessAction({
      context_id:        contextId,
      records_processed: summary.attributed,
      metadata:          { ...summary, results },
    })

    return NextResponse.json({ message: "Attribution complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Attribution failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
