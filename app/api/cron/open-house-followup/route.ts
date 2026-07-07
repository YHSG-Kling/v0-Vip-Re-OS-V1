import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { processEventFollowups } from "@/app/actions/open-house-automation"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * Open-House Follow-up Cron — the post-event half the loop was missing: the
 * sign-in kiosk, attendee scoring, hot-lead handoff and feedback logic all
 * existed but only fired when an agent clicked a button. Hourly sweep: events
 * that ENDED 1–25h ago and aren't completed get processEventFollowups (which
 * marks them completed — the idempotency flip).
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "open-house-followup",
    cron_path: "/app/api/cron/open-house-followup/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const summary = { swept: 0, processed: 0, skippedNoAttendees: 0, errors: 0 }
  try {
    const svc = createServiceClient()
    const now = new Date()
    const dayAgo = new Date(now.getTime() - 25 * 3_600_000).toISOString().slice(0, 10)
    // Events dated today or yesterday, not yet completed — end-time checked in JS
    // (event_date is a date + end_time a time; keep the query coarse, filter exact).
    const { data: events } = await svc.from("open_house_events")
      .select("id, event_date, end_time, status")
      .gte("event_date", dayAgo).lte("event_date", now.toISOString().slice(0, 10))
      .neq("status", "completed").limit(100)

    for (const e of (events ?? []) as any[]) {
      summary.swept += 1
      try {
        const endIso = `${e.event_date}T${e.end_time ?? "23:59:59"}`
        const ended = new Date(endIso).getTime()
        if (Number.isNaN(ended) || ended > now.getTime() - 3_600_000) continue // not ended (or <1h ago)
        const r = await processEventFollowups(e.id, svc)
        if ((r as any)?.success === false && /no attendees/i.test((r as any)?.error ?? "")) summary.skippedNoAttendees += 1
        else summary.processed += 1
      } catch { summary.errors += 1 }
    }

    await recordCronSuccessAction({ context_id: contextId, records_processed: summary.processed, metadata: summary as any })
    return NextResponse.json({ message: "Open-house follow-up sweep complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sweep failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
