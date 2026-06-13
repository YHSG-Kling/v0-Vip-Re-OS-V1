import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { runSpeedToLead } from "@/lib/ai-isa/speed-to-lead"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic    = "force-dynamic"
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "speed-to-lead",
    cron_path: "/app/api/cron/speed-to-lead/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const ranAt    = new Date()
  const supabase = createServiceClient()

  const results: Array<{
    brokerageId:     string
    leadsTouched:    number
    contactsTouched: number
    skipped:         number
    error?:          string
  }> = []

  // Fetch all brokerages — rely on per-brokerage query limits for safety
  const { data: brokerages } = await supabase
    .from("brokerages")
    .select("id")

  for (const brokerage of brokerages ?? []) {
    try {
      const result = await runSpeedToLead(brokerage.id, { now: ranAt })
      results.push({ brokerageId: brokerage.id, ...result })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({
        brokerageId:     brokerage.id,
        leadsTouched:    0,
        contactsTouched: 0,
        skipped:         0,
        error:           msg,
      })
    }
  }

  const totalLeads    = results.reduce((s, r) => s + r.leadsTouched, 0)
  const totalContacts = results.reduce((s, r) => s + r.contactsTouched, 0)

  await recordCronSuccessAction({
    context_id:        contextId,
    records_processed: results.length,
    output_count:      totalLeads + totalContacts,
    metadata:          { ranAt: ranAt.toISOString(), totalLeads, totalContacts },
  })

  return NextResponse.json({
    ok:             true,
    ranAt:          ranAt.toISOString(),
    results,
    totalLeads,
    totalContacts,
  })
}
