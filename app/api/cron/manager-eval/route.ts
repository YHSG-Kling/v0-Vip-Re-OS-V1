import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { runManagerEval } from "@/lib/compliance/manager-eval-harness"

/**
 * CONTINUOUS MANAGER EVAL cron (weekly) — the "our AI team is continuously red-teamed" guarantee made
 * autonomous. Runs the deterministic adversarial eval harness (protected-class bait, prompt injection,
 * privacy-leak, fabricated figures) against the managers' REAL output guards. The eval is platform-
 * level (fixed adversarial inputs, not brokerage data), so on a RELEASE-BLOCKING failure — a guard
 * regression that would let a Fair-Housing / injection / privacy leak through — it escalates to PLATFORM
 * staff (superadmin/support). A green run is the auditable proof; a red run is a regression sentinel.
 */
export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "manager-eval",
    cron_path: "/app/api/cron/manager-eval/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId }).catch(() => {})

  const supabase = createServiceClient()
  try {
    const report = runManagerEval()

    if (report.releaseBlocked) {
      // A guard regression let an adversarial case through — escalate to platform staff ONCE.
      const failing = report.cases.filter((c) => !c.pass).slice(0, 8)
      const { data: staff } = await supabase
        .from("users")
        .select("id, brokerage_id")
        .in("user_type", ["superadmin", "support"])
        .limit(20)
      for (const u of (staff ?? []) as Array<{ id: string; brokerage_id: string | null }>) {
        await supabase.from("notifications").insert({
          user_id: u.id,
          brokerage_id: u.brokerage_id,
          type: "manager_eval_regression",
          title: `⚠️ Manager eval FAILED — ${report.failed} adversarial case(s) leaked`,
          body: `The autonomous-manager red-team eval blocked release: ${failing.map((c) => `${c.category}/${c.id}`).join(", ")}. A safety guard regressed — review before shipping.`,
          entity_type: "system",
          entity_id: contextId,
          priority: "high",
          channel: "in_app",
        }).then(() => {}, () => {})
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: report.total,
      metadata: {
        total: report.total, passed: report.passed, failed: report.failed,
        release_blocked: report.releaseBlocked,
        by_category: report.byCategory,
      },
    }).catch(() => {})

    return NextResponse.json({ ok: true, total: report.total, passed: report.passed, failed: report.failed, releaseBlocked: report.releaseBlocked })
  } catch (e: any) {
    await recordCronFailureAction({ context_id: contextId, error: e, stage: "main-processing" }).catch(() => {})
    return NextResponse.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 })
  }
}
