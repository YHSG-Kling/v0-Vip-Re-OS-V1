/**
 * Cron: gbp-auto-posts
 * Runs every hour — looks at listings whose lifecycle_stage flipped to
 * 'active' or status flipped to 'closed' in the last 24h and creates a
 * Google Business Profile post (idempotent — won't double-post the same
 * listing).
 */

import { type NextRequest, NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { gbpAutoPostsCronTick } from "@/app/actions/gbp-auto-posts"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "gbp-auto-posts",
    cron_path: "/app/api/cron/gbp-auto-posts/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const result = await gbpAutoPostsCronTick()
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: result.processed,
      output_count: result.results.filter((r) => (r.outcome as any)?.success).length,
      metadata: { count: result.results.length },
    })
    return NextResponse.json({ success: true, ...result })
  } catch (err: any) {
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
    return NextResponse.json({ error: err.message ?? "Cron failed" }, { status: 500 })
  }
}
