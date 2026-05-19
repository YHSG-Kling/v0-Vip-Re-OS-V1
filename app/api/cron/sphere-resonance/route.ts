import { NextResponse } from "next/server"
import { runDailySphereResonanceScan } from "@/lib/sphere-resonance/run-resonance-scan"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Daily Sphere Resonance scan. Reads contacts.life_events from the last 7
 * days, generates contextual AI touchpoints for each new event, queues them
 * via the predictive_listing_actions infrastructure (capability-gated +
 * cancel-able). Sensitive events surface for human review only.
 * Schedule: `30 7 * * *` (7:30am UTC, after wealth scan at 7am).
 */
export async function GET(request: Request) {
  const auth = request.headers.get("authorization")
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctx = await createCronRunContextAction({
    cron_name: "sphere-resonance",
    cron_path: "/app/api/cron/sphere-resonance/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  await recordCronStartAction({ context_id: ctx.data.context_id })

  try {
    const summary = await runDailySphereResonanceScan({
      lookbackDays: 7,
      maxContactsPerBrokerage: 500,
    })
    await recordCronSuccessAction({
      context_id: ctx.data.context_id,
      records_processed: summary.contactsScanned,
      metadata: summary,
    })
    return NextResponse.json({ success: true, ...summary })
  } catch (err: any) {
    await recordCronFailureAction({
      context_id: ctx.data.context_id,
      error: err?.message ?? "Unknown error in sphere-resonance",
      stage: "runDailySphereResonanceScan",
    })
    return NextResponse.json({ error: err?.message ?? "Unknown error" }, { status: 500 })
  }
}
