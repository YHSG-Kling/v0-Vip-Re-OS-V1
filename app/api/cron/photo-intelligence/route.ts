import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Photo Intelligence Cron (daily, asset_manager) — real vision analysis for
 * every photo on an active listing (room type, 0-100 quality, hero-worthiness)
 * plus autonomous hero fill: listings with no is_hero photo get the best
 * exterior-front shot promoted, so nothing markets itself off a random first
 * upload. Bounded per run; the backlog drains across nights.
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "photo-intelligence",
    cron_path: "/app/api/cron/photo-intelligence/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const svc = createServiceClient()
    const { runPhotoIntelligenceSweep } = await import("@/lib/listings/photo-intelligence")
    const summary = await runPhotoIntelligenceSweep(svc)
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: summary.photosAnalyzed + summary.heroesSet,
      metadata: summary as any,
    })
    return NextResponse.json({ message: "Photo intelligence complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Photo intelligence failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
