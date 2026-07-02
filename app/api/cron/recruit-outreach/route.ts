import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { sweepStaleRecruits } from "@/lib/agents/recruit-outreach-producer"
import { refreshAllRecruitingRoi } from "@/lib/recruiting/recruiting-roi-writer"

/**
 * Weekly RECRUITING MANAGER sweep — keeps the talent pipeline warm. For every
 * brokerage with active recruits, propose the next stage-appropriate outreach for
 * recruits that have gone stale (no contact in 7+ days) into the client-message gate.
 * Idempotent per recruit (de-dupes a pending proposal), so re-running is safe.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "recruit-outreach",
    cron_path: "/app/api/cron/recruit-outreach/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let proposed = 0
  let scanned = 0
  let roiWritten = 0

  try {
    const { data: rows, error } = await supabase
      .from("recruits")
      .select("brokerage_id")
      .in("status", ["prospect", "contacted", "interviewing", "offer_extended"])
      .limit(1000)
    if (error) throw error

    const brokerages = Array.from(new Set(((rows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id)))
    for (const brokerageId of brokerages) {
      try {
        const r = await sweepStaleRecruits(brokerageId, 7, supabase)
        proposed += r.proposed
        scanned += r.scanned
      } catch (e: any) {
        errors.push(`${brokerageId}: ${e?.message ?? String(e)}`)
      }
    }

    // AUTONOMOUS ROI refresh — safety net beyond the event-driven recompute (first-close + cost entry).
    // Covers EVERY brokerage with recruited-agent production/cost, not just those with active recruits,
    // so the recruiting_roi dashboard stays current with no agent action.
    const { data: roiRows } = await supabase.from("recruiting_analytics").select("brokerage_id").not("recruited_agent_id", "is", null).limit(2000)
    const roiBrokerages = Array.from(new Set([...brokerages, ...((roiRows ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id)]))
    for (const brokerageId of roiBrokerages) {
      try {
        const r = await refreshAllRecruitingRoi(supabase, { brokerageId })
        roiWritten += r.written
      } catch (e: any) {
        errors.push(`roi ${brokerageId}: ${e?.message ?? String(e)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: proposed,
      metadata: { proposed, scanned, roiWritten, brokerages: brokerages.length, errors },
    }).catch(() => {})
    return NextResponse.json({ ok: true, proposed, scanned, roiWritten, brokerages: brokerages.length, errors })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
