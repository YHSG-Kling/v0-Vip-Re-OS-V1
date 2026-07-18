import { NextRequest, NextResponse } from "next/server"
import { verifyCronAuth } from "@/lib/cron-auth"
import { accrueCommissions } from "@/lib/platform/affiliates"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * MONTHLY AFFILIATE COMMISSION ACCRUAL.
 *
 * Accrues one affiliate_commission_events row per (referral, period) for every
 * active referral inside its commission window on a tenant with live MRR —
 * mrr_cents from v_platform_margin, the SAME source as the platform margin
 * board. UNIQUE(referral_id, period) makes re-runs idempotent, so running
 * late-month (after the view reflects the month's tier pricing) and re-running
 * on demand are both safe.
 *
 * Schedule (monthly, 28th — a day every month has; vercel.json):
 *   { "path": "/api/cron/affiliate-commissions", "schedule": "0 6 28 * *" }
 *
 * NOT registered in lib/kernel/cron-dispatch.ts — the orchestrator wires the
 * scheduler entry.
 *
 * Optional override for backfills/re-runs: ?period=YYYY-MM (defaults to the
 * current UTC month).
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const period = new URL(req.url).searchParams.get("period") ?? undefined
  try {
    const summary = await accrueCommissions(period)
    return NextResponse.json({ ok: summary.errors.length === 0, ...summary })
  } catch (err) {
    console.error("[cron/affiliate-commissions] failed:", err)
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Accrual failed" },
      { status: 500 },
    )
  }
}
