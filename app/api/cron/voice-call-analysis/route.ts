import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { sweepVoiceCallIntelligence } from "@/lib/voice/call-analysis"
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
 * Voice Call Analysis Cron — every completed AI call (Twilio inbound
 * reception, outbound ISA, legacy Vapi — one ledger) gets its transcript
 * analyzed into the intelligence columns the coaching loop reads
 * (objections / urgency / coaching / intent). Idempotent by voice_call_id;
 * capped per run for LLM cost control; the Monday week-in-review and the
 * call-intel brief consume the results.
 */
export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "voice-call-analysis",
    cron_path: "/app/api/cron/voice-call-analysis/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const summary = await sweepVoiceCallIntelligence(createServiceClient())
    await recordCronSuccessAction({ context_id: contextId, records_processed: summary.analyzed, metadata: summary as any })
    return NextResponse.json({ message: "Voice intelligence sweep complete", summary })
  } catch (e) {
    const message = e instanceof Error ? e.message : "Sweep failed"
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
