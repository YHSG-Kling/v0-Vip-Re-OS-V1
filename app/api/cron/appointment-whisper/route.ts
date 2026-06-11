import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { produceAppointmentWhispers } from "@/lib/intelligence/appointment-whisper"

/**
 * THE WHISPER cron (every 10 min) — T-minus-30 hallway briefings. For every brokerage
 * with client appointments starting in 25-40 minutes, the managers' combined knowledge
 * is whispered to the agent in their configured ASSISTANT voice on EVERY tier (text
 * only as the no-voice-configured fallback). Idempotent per calendar event.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "appointment-whisper",
    cron_path: "/app/api/cron/appointment-whisper/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let whispers = 0, audio = 0

  try {
    const from = new Date(Date.now() + 25 * 60_000).toISOString()
    const to = new Date(Date.now() + 40 * 60_000).toISOString()
    const { data: rows, error } = await supabase
      .from("calendar_events").select("brokerage_id")
      .eq("entity_type", "contact").gte("start_at", from).lte("start_at", to).limit(500)
    if (error) throw error
    const brokerages = Array.from(new Set(((rows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id)))

    for (const brokerageId of brokerages) {
      try {
        const r = await produceAppointmentWhispers(brokerageId, {}, supabase)
        whispers += r.whispers; audio += r.audio
      } catch (e: any) { errors.push(`${brokerageId}: ${e?.message ?? String(e)}`) }
    }

    await recordCronSuccessAction({
      context_id: contextId, records_processed: whispers,
      metadata: { whispers, audio, brokerages: brokerages.length, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, whispers, audio, brokerages: brokerages.length })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
