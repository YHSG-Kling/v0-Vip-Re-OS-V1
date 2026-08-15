import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { processLifecycleEventTriggers } from "@/lib/marketing/trigger-engine"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * Marketing Trigger Engine — Sprint 9 cont.
 *
 * Scans recent lifecycle_events for matches against active
 * marketing_campaign_triggers and auto-enrolls qualifying contacts in
 * the linked campaign by writing touchpoint rows. Respects per-trigger
 * cooldown_days to avoid re-enrolling the same contact rapidly.
 *
 * Runs every minute alongside the portal-stream-projector.
 */

const LOOKBACK_MINUTES = 90

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "marketing-trigger-engine",
    cron_path: "/app/api/cron/marketing-trigger-engine/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const svc = createServiceClient()
  try {
    const summary = await processLifecycleEventTriggers(svc, LOOKBACK_MINUTES)
    await recordCronSuccessAction({
      context_id:        contextId,
      records_processed: summary.enrolled,
      metadata:          summary,
    })
    return NextResponse.json({ message: "Trigger engine complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Trigger engine failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  return GET(request)
}
