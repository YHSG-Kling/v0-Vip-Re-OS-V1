import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runObjectionLibrary } from "@/lib/kernel/objection-library"

/**
 * OBJECTION LIBRARY cron (weekly via the dispatcher) — for each brokerage, the AI ISA
 * mines its recent real call outcomes, categorizes every objection ("too expensive",
 * "using another agent", "just browsing", "bad timing", "not interested"), tracks which
 * rebuttal (script_used) actually booked appointments, and proposes ONE agent-facing
 * summary of the winning rebuttals into the gate. Min-sample gated, one summary per
 * brokerage per ISO week, nothing sends. Sales intelligence that compounds.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "objection-library",
    cron_path: "/app/api/cron/objection-library/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  const errors: string[] = []
  let calls = 0, objections = 0, winners = 0, summaries = 0

  try {
    const { data: rows, error } = await supabase.from("brokerages").select("id").limit(500)
    if (error) throw error
    for (const b of (rows ?? []) as Array<{ id: string }>) {
      try {
        const r = await runObjectionLibrary(b.id, {}, supabase)
        calls += r.callsAnalyzed; objections += r.objectionsCovered
        winners += r.winningRebuttals; if (r.summaryProposed) summaries += 1
      } catch (e: any) { errors.push(`${b.id}: ${e?.message ?? String(e)}`) }
    }
    await recordCronSuccessAction({
      context_id: contextId, records_processed: summaries,
      metadata: { calls, objections, winners, summaries, errors: errors.slice(0, 10) },
    }).catch(() => {})
    return NextResponse.json({ ok: true, calls, objections, winners, summaries })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e), errors }, { status: 500 })
  }
}
