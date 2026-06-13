import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import {
  runAppointmentNoShowAutopilot,
  APPOINTMENT_EVENT_TYPES,
  DEFAULT_REMINDER_WINDOW_HOURS,
} from "@/lib/kernel/appointment-noshow-autopilot"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * APPOINTMENT NO-SHOW / RESCHEDULE AUTOPILOT cron (hourly). For every brokerage with an
 * open client appointment near the window, MISSED appointments get marked no_show + a
 * GATED warm re-book + fed to the existing AI-ISA re-engage loop; UPCOMING appointments
 * get ONE gated reminder. Idempotent per (appointment, stage). Nothing auto-sends.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "appointment-noshow",
    cron_path: "/app/api/cron/appointment-noshow/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let remindersProposed = 0, noShowsMarked = 0, rebooksProposed = 0, reengaged = 0

  try {
    // Brokerages with an open client appointment in the relevant window (past 3 days for
    // freshly-missed → next reminder window for upcoming).
    const from = new Date(Date.now() - 3 * 86_400_000).toISOString()
    const to = new Date(Date.now() + DEFAULT_REMINDER_WINDOW_HOURS * 3_600_000).toISOString()
    const { data: rows, error } = await supabase
      .from("calendar_events")
      .select("brokerage_id")
      .eq("entity_type", "contact")
      .in("event_type", APPOINTMENT_EVENT_TYPES as unknown as string[])
      .gte("start_at", from)
      .lte("start_at", to)
      .limit(2000)
    if (error) throw error
    const brokerages = Array.from(
      new Set(((rows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id)),
    )

    for (const brokerageId of brokerages) {
      try {
        const r = await runAppointmentNoShowAutopilot(brokerageId, {}, supabase)
        remindersProposed += r.remindersProposed
        noShowsMarked += r.noShowsMarked
        rebooksProposed += r.rebooksProposed
        reengaged += r.reengaged
      } catch (e: any) {
        errors.push(`${brokerageId}: ${e?.message ?? String(e)}`)
      }
    }

    const processed = remindersProposed + noShowsMarked + rebooksProposed
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: processed,
      metadata: { remindersProposed, noShowsMarked, rebooksProposed, reengaged, brokerages: brokerages.length, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, remindersProposed, noShowsMarked, rebooksProposed, reengaged, brokerages: brokerages.length })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
