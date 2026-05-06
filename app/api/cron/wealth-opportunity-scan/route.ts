import { NextResponse } from "next/server"
import { runDailyWealthScan } from "@/lib/wealth-advisor/scan-opportunities"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"
export const maxDuration = 600

/**
 * Daily Generational Wealth Advisor scan. Walks lifetime customers, detects
 * refi/equity opportunities, generates AI narratives. Cost-controlled — uses
 * cached AVM values; refreshes a budgeted number per brokerage per day.
 * Schedule: `0 7 * * *` (7am UTC, after PLS scoring at 6am).
 */
export async function GET(request: Request) {
  const auth = request.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctx = await createCronRunContextAction({
    cron_name: "wealth-opportunity-scan",
    cron_path: "/app/api/cron/wealth-opportunity-scan/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  await recordCronStartAction({ context_id: ctx.data.context_id })

  try {
    const summary = await runDailyWealthScan({
      maxContactsPerBrokerage: 500,
    })
    await recordCronSuccessAction({
      context_id: ctx.data.context_id,
      records_processed: summary.contactsProcessed,
      metadata: summary,
    })
    return NextResponse.json({ success: true, ...summary })
  } catch (err: any) {
    await recordCronFailureAction({
      context_id: ctx.data.context_id,
      error: err?.message ?? "Unknown error in wealth-opportunity-scan",
      stage: "runDailyWealthScan",
    })
    return NextResponse.json({ error: err?.message ?? "Unknown error" }, { status: 500 })
  }
}
