import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  attributeTransactionSafe,
  findTransactionsNeedingAttribution,
} from "@/lib/marketing/attribution"
import { resolveSequenceConversions } from "@/lib/campaign-sequences/sequence-conversion"
import { verifyCronAuth } from "@/lib/cron-auth"
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
  const results: Array<{ txnId: string; totalCredits?: number; enrollmentsConverted?: number; error?: string }> = []

  try {
    const candidates = await findTransactionsNeedingAttribution(svc, LOOKBACK_DAYS)
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
        try {
          const c = await resolveSequenceConversions(svc, txnId)
          enrollmentsConverted = c?.enrollmentsConverted
        } catch (convErr) {
          console.error(`[attribution] sequence conversion failed for ${txnId}:`, convErr)
        }
        if (r) {
          results.push({ txnId, totalCredits: r.totalCredits, enrollmentsConverted })
        }
      } catch (err) {
        results.push({ txnId, error: err instanceof Error ? err.message : String(err) })
      }
    }

    const summary = {
      candidates_found: candidates.length,
      processed:        toProcess.length,
      attributed:       results.filter(r => !r.error).length,
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
