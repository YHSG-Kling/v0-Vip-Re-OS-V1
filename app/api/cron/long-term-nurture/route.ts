import { NextResponse } from "next/server"
import { runMonthlyNurtureCadence } from "@/lib/ai-isa/long-term-nurture"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Monthly nurture + signal re-activation cron.
 *
 * Schedule: weekly is fine — the function itself enforces 25-day spacing per
 * lead, so running weekly catches new reactivation signals quickly without
 * over-sending touchpoints.
 */
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const contextResult = await createCronRunContextAction({
    cron_name: "long-term-nurture",
    cron_path: "/app/api/cron/long-term-nurture/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const result = await runMonthlyNurtureCadence({ limit: 1000 })

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.total,
      metadata: {
        enrolledMonthly: result.enrolledMonthly,
        reactivated: result.reactivated,
        expired: result.expired,
      },
    })

    return NextResponse.json({ success: true, ...result })
  } catch (err: any) {
    await recordCronFailureAction({
      context_id: contextId,
      error: err?.message ?? "Unknown error in long-term-nurture",
      stage: "runMonthlyNurtureCadence",
    })
    return NextResponse.json({ error: err?.message ?? "Unknown error" }, { status: 500 })
  }
}
