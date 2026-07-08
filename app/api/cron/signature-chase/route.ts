import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runSignatureChase } from "@/lib/kernel/signature-chase"
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
 * Signature Chase Cron — provider-agnostic (the tenant picks their e-sign
 * provider in settings; the chase runs on OUR ledgers): stalled envelopes get
 * ONE agent nudge at 48h and ONE broker escalation at 96h, deduped per
 * row+tier. No client egress — humans get nudged, humans call clients.
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "signature-chase",
    cron_path: "/app/api/cron/signature-chase/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const summary = await runSignatureChase(createServiceClient())
    await recordCronSuccessAction({ context_id: contextId, records_processed: summary.nudged + summary.escalated, metadata: summary as any })
    return NextResponse.json({ message: "Signature chase complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Chase failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
