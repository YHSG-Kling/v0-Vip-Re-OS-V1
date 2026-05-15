/**
 * Cron: closing-orchestration
 * Runs every 6 hours. For every active transaction, evaluates the typed
 * detector library in lib/transactions/closing-orchestration.ts and writes
 * (or supersedes) rows in transaction_pending_actions. This is the
 * orchestration engine that turns "tracked milestones" into "do this today."
 */

import { type NextRequest, NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { runClosingOrchestration } from "@/lib/transactions/closing-orchestration"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization")
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const ctx = await createCronRunContextAction({
    cron_name: "closing-orchestration",
    cron_path: "/app/api/cron/closing-orchestration/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const result = await runClosingOrchestration({ limit: 200 })
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.scanned,
      output_count: result.opened + result.superseded,
      metadata: result,
    })
    return NextResponse.json({ success: true, ...result })
  } catch (err: any) {
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
    return NextResponse.json({ error: err.message ?? "Cron failed" }, { status: 500 })
  }
}
