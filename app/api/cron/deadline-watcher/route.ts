import {
NextResponse } from "next/server"
import { checkUpcomingDeadlines } from "@/lib/kernel"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

export async function GET(request: Request) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "deadline-watcher",
    cron_path: "/app/api/cron/deadline-watcher/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error("[DeadlineWatcher] Failed to record cron start:", startRecordResult.error)
  }

  try {
    await checkUpcomingDeadlines()

    // THE AUTONOMY RATCHET SWEEP — same deadline domain, same heartbeat: for
    // every brokerage with human-resolved document-kernel decisions, check
    // whether any amber shape EARNED a green grant (≥10 approvals, zero
    // declines) and propose it to the broker on the feed. Best-effort.
    let ratchetsProposed = 0
    try {
      const { createServiceClient } = await import("@/lib/supabase/service")
      const { runAutonomyRatchetSweep } = await import("@/lib/documents/autonomy-ratchet")
      const svc = createServiceClient()
      const { data: resolved } = await svc
        .from("policy_decisions")
        .select("brokerage_id")
        .eq("target_type", "transaction_deadline")
        .in("recommended_action", ["human_adopted_document_date", "human_kept_tracked_date"])
        .limit(2000)
      const brokerageIds = Array.from(new Set(((resolved ?? []) as Array<{ brokerage_id: string }>).map((r) => r.brokerage_id)))
      for (const brokerageId of brokerageIds) {
        const r = await runAutonomyRatchetSweep(svc as any, { brokerageId })
        ratchetsProposed += r.proposed
      }
    } catch (e) {
      console.error("[cron/deadline-watcher] ratchet sweep failed (non-fatal):", e)
    }

    await recordCronSuccessAction({ context_id: contextId, records_processed: ratchetsProposed })
    return NextResponse.json({ ok: true, ratchetsProposed }, { status: 200 })
  } catch (err) {
    console.error("[cron/deadline-watcher] Failed:", err)
    await recordCronFailureAction({ context_id: contextId, error: err as Error | string, stage: "main-processing" })
    return NextResponse.json({ ok: false, context_id: contextId }, { status: 500 })
  }
}
