import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runDunningSweep } from "@/lib/billing/dunning"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"

/**
 * Billing Dunning Cron — daily past-due payment recovery. Walks every
 * past_due/unpaid subscription and sends the next due step of the dunning
 * ladder (in-app always, email when SendGrid creds exist), deduped per
 * episode via platform_dunning_events. See lib/billing/dunning.ts.
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "billing-dunning",
    cron_path: "/app/api/cron/billing-dunning/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const svc = createServiceClient()
    const summary = await runDunningSweep(svc)
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: summary.stepsSent,
      metadata: summary as any,
    })
    return NextResponse.json({ message: "Dunning sweep complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Dunning sweep failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
