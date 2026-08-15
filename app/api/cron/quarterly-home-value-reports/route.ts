/**
 * Cron: quarterly-home-value-reports
 * Runs daily — finds past clients whose property purchase is at a quarterly
 * mark (3m / 6m / 9m / 15m / 18m / 21m / etc since close_date) and sends a
 * fresh "Your home is worth $X" email. Annual marks (12m / 24m / 36m) are
 * handled by /api/cron/annual-home-value-reports so contacts never get two
 * emails on the same day.
 *
 * This is the missing piece that turns the platform into a HomeBot
 * replacement — past clients hear from the agent ~4x/year, every email is
 * brand-compliant, and every send credits back to the agent's ROI dashboard.
 */

import { type NextRequest, NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { generateQuarterlyHomeValueReportsCronTick } from "@/app/actions/annual-home-value-report"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "quarterly-home-value-reports",
    cron_path: "/app/api/cron/quarterly-home-value-reports/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const result = await generateQuarterlyHomeValueReportsCronTick()
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.processed,
      output_count: result.generated.filter((g) => g.ok).length,
      metadata: result,
    })
    return NextResponse.json({ success: true, ...result })
  } catch (err: any) {
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
    return NextResponse.json({ error: err.message ?? "Cron failed" }, { status: 500 })
  }
}
