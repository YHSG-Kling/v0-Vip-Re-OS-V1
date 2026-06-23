import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runManagerLearning } from "@/lib/managers/learning-loop"

/**
 * MANAGER LEARNING cron — the loop that turns a graded team into a self-improving one. For each
 * brokerage it reads recent OUTCOMES (lost-deal categories + strategy outcomes) and writes LEARNED
 * ADJUSTMENTS to brokerage_settings.settings.learned_adjustments — the shared store the managers
 * read at decision time (first wired consumer: the Deal-Save Huddle tightens its financing
 * threshold when a brokerage keeps losing deals on financing). Honest: below a minimum sample it
 * derives nothing. Idempotent (overwrites the learned block each run); best-effort per brokerage.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "manager-learning",
    cron_path: "/app/api/cron/manager-learning/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let scanned = 0, tuned = 0, adjustments = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runManagerLearning(b.id, {}, supabase)
        scanned += 1
        if (r.adjustments.length > 0) { tuned += 1; adjustments += r.adjustments.length }
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: adjustments,
      metadata: { scanned, tuned, adjustments, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, scanned, tuned, adjustments })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
