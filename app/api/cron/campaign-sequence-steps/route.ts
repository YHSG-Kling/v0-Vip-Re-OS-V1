import {
NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { executeSequenceStep } from "@/lib/campaign-sequences/step-executor"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * Cron: campaign-sequence step worker.
 *
 * Polls sequence_enrollments where status='active' AND
 * next_step_at <= now, then calls executeSequenceStep on each. The
 * step executor sends the channel-specific message (email/SMS/etc.),
 * advances current_step, and sets next_step_at to the next step's
 * delay. Workflow Builder sequences + the seeded default sequences
 * both flow through here.
 *
 * Without this cron the kernel-event fan-out enrolls contacts into
 * sequences but the steps never actually fire — auto-enrollment
 * becomes a silent no-op. This route is the missing piece that makes
 * the trigger → enroll → deliver loop close.
 *
 * Schedule (vercel.json): every 5 minutes.
 */
export async function GET(request: Request) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "campaign-sequence-steps",
    cron_path: "/app/api/cron/campaign-sequence-steps/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const supabase = createServiceClient()
    const nowIso = new Date().toISOString()

    const { data: due, error } = await supabase
      .from("sequence_enrollments")
      .select("id")
      .eq("status", "active")
      .lte("next_step_at", nowIso)
      .order("next_step_at", { ascending: true })
      .limit(200)

    if (error) {
      await recordCronFailureAction({ context_id: contextId, error, stage: "fetch-due" })
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 })
    }

    if (!due || due.length === 0) {
      await recordCronSuccessAction({ context_id: contextId, records_processed: 0 })
      return NextResponse.json({ ok: true, processed: 0 })
    }

    // Fire each step. Run sequentially to avoid hammering external APIs +
    // to keep per-enrollment errors isolated. 200 enrollments at ~50ms each
    // is ~10s — well inside the cron window.
    let succeeded = 0
    let failed = 0
    for (const e of due) {
      try {
        const res = await executeSequenceStep(e.id)
        if ((res as any).status === "error") failed++
        else succeeded++
      } catch (err) {
        console.error(`[campaign-sequence-steps] enrollment ${e.id} failed:`, err)
        failed++
      }
    }

    await recordCronSuccessAction({ context_id: contextId, records_processed: succeeded })
    return NextResponse.json({ ok: true, processed: succeeded, failed })
  } catch (err) {
    console.error("[campaign-sequence-steps] failed:", err)
    await recordCronFailureAction({ context_id: contextId, error: err as Error | string, stage: "main-processing" })
    return NextResponse.json({ ok: false, context_id: contextId }, { status: 500 })
  }
}
