import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runAIOverageBilling, VIDEO_OVERAGE_METRIC } from "@/lib/billing/ai-overage"

/**
 * Cron route — AI overage billing at period close (m479: over-quota AI is
 * SERVED AND BILLED, not refused).
 *
 * Runs monthly, shortly after the UTC month rolls over, and bills the CLOSED
 * period: each brokerage's overage is DERIVED from usage_counters
 * (max(0, used − included_total); lib/billing/ai-overage.ts — one usage
 * canon, no second accrual) and written through as ONE Stripe invoice item on
 * the brokerage's subscription customer.
 *
 * Idempotent via the ai_overage_invoices UNIQUE(brokerage_id, period_start,
 * metric) claim — the row is claimed before Stripe is called and marked
 * 'billed' only with the provider's invoice-item id, so reruns (or a daily
 * schedule) cannot double-bill. Without STRIPE_SECRET_KEY the run refuses
 * loudly and records nothing.
 *
 * Registered in lib/kernel/cron-dispatch.ts:
 *   { "path": "/api/cron/ai-overage-billing", "schedule": "23 1 1 * *" }
 */
export const maxDuration = 300

export async function GET(req: NextRequest) {
  // Fail-closed cron auth — missing CRON_SECRET is 500, mismatch is 401.
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const result = await runAIOverageBilling()
  if (!result.ok) {
    // A refused run (e.g. Stripe unconfigured) is a loud 503, never a quiet 200
    // — nothing was recorded and nothing was billed.
    console.error("[ai-overage-billing] run refused:", result.error)
    return NextResponse.json(result, { status: 503 })
  }
  if (result.refused > 0 || result.needsReconciliation > 0) {
    console.error(
      "[ai-overage-billing] attention:",
      JSON.stringify(result.outcomes.filter(o => o.status !== "billed" && o.status !== "skipped").slice(0, 20)),
    )
  }
  // VIDEO OVERAGE (wave 86, lane 86B — owner answer 4: video is tier-METERED and its
  // overage flows to billing). The SAME writethrough, keyed on video_minutes; a video
  // run's refusal is reported beside the AI result, never allowed to hide it.
  const video = await runAIOverageBilling({ metric: VIDEO_OVERAGE_METRIC })
  if (!video.ok) console.error("[ai-overage-billing] video overage run refused:", video.error)
  else if (video.refused > 0 || video.needsReconciliation > 0) {
    console.error(
      "[ai-overage-billing] video attention:",
      JSON.stringify(video.outcomes.filter(o => o.status !== "billed" && o.status !== "skipped").slice(0, 20)),
    )
  }
  return NextResponse.json({ ...result, video })
}
