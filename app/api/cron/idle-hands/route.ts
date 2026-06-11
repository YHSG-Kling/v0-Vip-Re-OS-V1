import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runIdleHands } from "@/lib/kernel/idle-hands"

/**
 * IDLE-HANDS cron (hourly, via the dispatcher) — managers do proactive work between
 * commands and crons: stale-listing social drafts, just_sold reels (policy-gated),
 * anniversary notes, self-healing enrichment, and the pre-drafted re-engage. The
 * idle rule keeps initiative from piling onto an existing backlog.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "idle-hands",
    cron_path: "/app/api/cron/idle-hands/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let social = 0, reels = 0, anniversaries = 0, enrichments = 0, predrafts = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error

    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runIdleHands(b.id, {}, supabase)
        social += r.socialDrafts; reels += r.justSoldReels; anniversaries += r.anniversaryNotes
        enrichments += r.enrichmentsQueued; predrafts += r.reengagePredrafts
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }

    const total = social + reels + anniversaries + enrichments + predrafts
    await recordCronSuccessAction({
      context_id: contextId, records_processed: total,
      metadata: { social, reels, anniversaries, enrichments, predrafts, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, social, reels, anniversaries, enrichments, predrafts })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
