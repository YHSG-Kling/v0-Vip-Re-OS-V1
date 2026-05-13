import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { findOffersNeedingStrategy } from "@/lib/negotiation/auto-trigger"
import { writeNegotiationStrategy } from "@/lib/negotiation/strategy-writer"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"

/**
 * Negotiation Strategy Generator — Sprint 8.
 *
 * Scans recent OFFER_OS_SUBMITTED + OFFER_OS_COUNTERED lifecycle events
 * and ensures each offer has a current negotiation_strategy. Idempotent —
 * skips offers that already have an open or accepted strategy on the
 * inferred side.
 *
 * Side inference:
 *   - OFFER_OS_SUBMITTED → seller side (their listing got an offer)
 *   - OFFER_OS_COUNTERED → buyer side  (the seller countered back)
 *
 * GET = scheduled (runs every minute via Vercel cron)
 * POST = admin / debug rerun
 */

const LOOKBACK_MINUTES = 90
const MAX_PER_RUN      = 10  // cap AI calls per run

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctx = await createCronRunContextAction({
    cron_name: "negotiation-strategy-generator",
    cron_path: "/app/api/cron/negotiation-strategy-generator/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const svc = createServiceClient()
  const results: Array<{ offerId: string; side: string; ok: boolean; strategyId?: string; error?: string }> = []

  try {
    const candidates = await findOffersNeedingStrategy(svc, LOOKBACK_MINUTES)
    const toProcess  = candidates.slice(0, MAX_PER_RUN)

    for (const c of toProcess) {
      const r = await writeNegotiationStrategy(c.offerId, c.side)
      results.push({
        offerId:    c.offerId,
        side:       c.side,
        ok:         r.ok,
        strategyId: r.strategyId,
        error:      r.error,
      })
    }

    const summary = {
      scanned:    candidates.length,
      processed:  toProcess.length,
      successful: results.filter(r => r.ok).length,
      failed:     results.filter(r => !r.ok).length,
    }

    await recordCronSuccessAction({
      context_id:        contextId,
      records_processed: summary.successful,
      metadata:          { ...summary, results },
    })

    return NextResponse.json({ message: "Generator complete", summary, results })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Generator failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  // Same auth + same flow as GET (admin rerun path).
  return GET(request)
}
