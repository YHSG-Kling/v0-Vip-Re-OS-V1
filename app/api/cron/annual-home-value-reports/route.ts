/**
 * Cron: annual-home-value-reports
 * Runs daily at 7am — finds lifetime customers whose closing anniversary is
 * today and writes a touchpoint with the generated home-value report.
 */

import { type NextRequest, NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { generateAnnualHomeValueReportsCronTick } from "@/app/actions/annual-home-value-report"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctx = await createCronRunContextAction({
    cron_name: "annual-home-value-reports",
    cron_path: "/app/api/cron/annual-home-value-reports/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const result = await generateAnnualHomeValueReportsCronTick()
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
