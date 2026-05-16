/**
 * Cron: showing-prep
 * Runs every hour. Finds showings scheduled in the next 24 hours that don't
 * yet have a briefing in showing_briefings, generates one for each. The
 * briefing combines the buyer's inferred property_preferences, financial
 * profile, behavior predictions, recent signals, and stage-coaching with
 * the listing's facts and recent ZIP-level comps. AI produces 4-6 specific
 * talking points + likely objections + risk flags tied to THIS buyer.
 */

import { type NextRequest, NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { generateShowingBriefingsCronTick } from "@/lib/showings/showing-brief"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctx = await createCronRunContextAction({
    cron_name: "showing-prep",
    cron_path: "/app/api/cron/showing-prep/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const result = await generateShowingBriefingsCronTick({ lookaheadHours: 24, limit: 30 })
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.processed,
      output_count: result.generated,
      metadata: result,
    })
    return NextResponse.json({ success: true, ...result })
  } catch (err: any) {
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
    return NextResponse.json({ error: err.message ?? "Cron failed" }, { status: 500 })
  }
}
