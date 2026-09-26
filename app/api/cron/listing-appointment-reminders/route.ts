import { NextRequest, NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { sendAppointmentReminders } from "@/lib/ai-isa/listing-appointment"

/**
 * LISTING APPOINTMENT REMINDER CADENCE — wave 75C, owner verbatim: "the
 * workflow creates the follow up until the appt." Sweeps every CONFIRMED
 * ('scheduled') listing_appointment calendar_events row and sends the 5-day
 * / 2-day / morning-of touch it is due for, idempotent per appointment via
 * calendar_events.metadata.reminder_tiers_sent. A row that was rescheduled
 * (cancelled by bookListingAppointment's supersede step) or is still
 * pending_agent_confirmation is never in this query's WHERE — that is how
 * "cancel on reschedule" holds: the cadence stops the moment the row is no
 * longer 'scheduled'.
 *
 * Daily cadence (0 13 * * *, same slot pattern as contingency-scan) is
 * sufficient for a 3-tier day-granularity reminder — no sub-hour polling
 * needed, keeping this off the sub-5-minute cron-cost list (CLAUDE.md wave
 * 62 ruling: "vercel cron usage and billing should be considered").
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "listing-appointment-reminders",
    cron_path: "/app/api/cron/listing-appointment-reminders/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const result = await sendAppointmentReminders()
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.scanned,
      output_count: result.remindersSent,
      metadata: result,
    })
    return NextResponse.json({ success: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[ListingAppointmentReminders] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
