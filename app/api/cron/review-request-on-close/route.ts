import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
// WAVE 143 (lane 143E): THE ONE REVIEW-ASK ENGINE. This route used to read the delays, compose and send inline with its
// own "any review_requests row for this contact ⇒ skip" dedupe — which four other writers (closeTransactionCommand, the
// closed-stage hook, the transaction.closed handler, the UI) fed first, so the autonomous ask skipped nearly every
// client. The sweep keeps only what a cron owns — WHICH closings to look at, and the run log; WHETHER / WHEN / WHERE /
// WHAT / HOW is lib/reputation/review-ask.ts askForReviewAtClose (timing = the tenant's review_request_delay_days,
// moved there from here with its default and window; the lane 86E/86H history of this file lives in that engine's header
// and in lib/reputation/review-request-delay.ts).
import { askForReviewAtClose } from "@/lib/reputation/review-ask"
import { REVIEW_REQUEST_LOOKBACK_DAYS, REVIEW_REQUEST_MIN_AGE_DAYS } from "@/lib/reputation/review-request-delay"

const DAY_MS = 24 * 60 * 60 * 1000

export async function GET(req: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "review-request-on-close",
    cron_path: "/app/api/cron/review-request-on-close/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const supabase = createServiceClient()
  let processed = 0
  let skipped = 0
  let drafted = 0
  const errors: string[] = []

  try {
    // The sweep window only bounds the READ — the engine re-checks the tenant's delay, the verified closing and the
    // duplicate rule on every transaction. `funded` joins `closed`: the ladder is closed → funded (the lifetime
    // anniversary cron keys on the same pair).
    const now = new Date()
    const windowStart = new Date(now.getTime() - REVIEW_REQUEST_LOOKBACK_DAYS * DAY_MS).toISOString()
    const windowEnd   = new Date(now.getTime() - REVIEW_REQUEST_MIN_AGE_DAYS  * DAY_MS).toISOString()

    const { data: closedTxns, error: txnError } = await supabase
      .from("transactions")
      .select("id, brokerage_id")
      .in("status", ["closed", "funded"])
      .gte("close_date", windowStart)
      .lte("close_date", windowEnd)

    if (txnError) throw txnError

    for (const txn of closedTxns ?? []) {
      try {
        const run = await askForReviewAtClose(supabase, { brokerageId: txn.brokerage_id, transactionId: txn.id, source: "cron" })
        for (const r of run.results) {
          if (r.status === "sent") processed++
          else if (r.status === "staged") drafted++
          else if (r.status === "skipped") skipped++
          else errors.push(`txn ${txn.id}: ${r.error}`)
        }
      } catch (err: any) {
        errors.push(`txn ${txn.id}: ${err?.message ?? String(err)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: processed,
      metadata: { skipped, drafted, errors },
    })

    return NextResponse.json({ ok: true, processed, skipped, drafted, errors })
  } catch (err: any) {
    const msg = err?.message ?? String(err)
    await recordCronFailureAction({ context_id: contextId, error: msg })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
