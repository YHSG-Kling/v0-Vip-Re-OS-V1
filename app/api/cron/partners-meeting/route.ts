import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { producePartnersMeeting } from "@/lib/intelligence/partners-meeting"

/**
 * PARTNERS' MEETING cron (Mondays 01:00 UTC ≈ Sunday evening US) — the week presented
 * by the AI team: plays, fire drills, whispers, recoveries, dissents, deals, and the
 * one thing waiting on the human (the approval queue). D-ID avatar video / assistant-
 * voice audio / written memo, by what the user has configured — on every tier.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const phase = new URL(req.url).searchParams.get("phase") ?? "produce"
  const contextResult = await createCronRunContextAction({
    cron_name: phase === "deliver" ? "partners-meeting-deliver" : "partners-meeting",
    cron_path: "/app/api/cron/partners-meeting/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let meetings = 0, video = 0, audio = 0, memo = 0

  try {
    // ?phase=deliver (Monday afternoon): sweep the completed weekly-show
    // renders (the reel queued by the 01:00 produce pass) → notify leadership.
    if (phase === "deliver") {
      const { deliverPartnersMeetingReels } = await import("@/lib/intelligence/partners-meeting")
      const delivery = await deliverPartnersMeetingReels(supabase)
      await recordCronSuccessAction({ context_id: contextId, records_processed: delivery.notified, metadata: delivery as any }).catch(() => {})
      return NextResponse.json({ ok: true, ...delivery })
    }

    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error

    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await producePartnersMeeting(b.id, {}, supabase)
        meetings += r.meetings; video += r.video; audio += r.audio; memo += r.memo
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }

    await recordCronSuccessAction({
      context_id: contextId, records_processed: meetings,
      metadata: { meetings, video, audio, memo, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, meetings, video, audio, memo })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
