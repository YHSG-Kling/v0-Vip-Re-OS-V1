import {
NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { runGhostReengagement } from '@/lib/ai-isa/ghost-reengagement'
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from '@/app/actions/cron-kernel'
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: 'ghost-detection',
    cron_path: '/app/api/cron/ghost-detection/route.ts',
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: 'Failed to create cron context' }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error('[GhostDetection] Failed to record cron start:', startRecordResult.error)
  }

  try {
    const supabase = createServiceClient()

    // Fetch all active brokerages
    const { data: brokerages, error: brErr } = await supabase
      .from('brokerages')
      .select('id')
      .eq('is_active', true)

    if (brErr) throw new Error(`Failed to load brokerages: ${brErr.message}`)

    // Ghost thresholds live in global_settings.additional_settings (per brokerage),
    // not on brokerages.
    const { data: settingsRows } = await supabase
      .from('global_settings')
      .select('brokerage_id, additional_settings')
    const settingsByBrokerage = new Map<string, Record<string, unknown>>()
    for (const r of settingsRows ?? []) {
      if (r.brokerage_id) settingsByBrokerage.set(r.brokerage_id as string, (r.additional_settings as Record<string, unknown>) ?? {})
    }

    const results: Array<{
      brokerageId: string
      processed: number
      sent: number
      paused: number
      stopped: number
      skipped: number
      error?: string
    }> = []

    for (const brokerage of brokerages ?? []) {
      try {
        const settings = settingsByBrokerage.get(brokerage.id) ?? null
        const thresholdDays =
          typeof settings?.ghost_threshold_days === 'number'
            ? settings.ghost_threshold_days
            : 14

        const result = await runGhostReengagement(brokerage.id, thresholdDays)

        console.log(`[cron/ghost-detection] brokerage=${brokerage.id}`, result)

        results.push({ brokerageId: brokerage.id, ...result })
      } catch (err) {
        console.error(`[cron/ghost-detection] Error for brokerage ${brokerage.id}:`, err)
        results.push({
          brokerageId: brokerage.id,
          processed: 0,
          sent: 0,
          paused: 0,
          stopped: 0,
          skipped: 0,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }

    const totalSent = results.reduce((s, r) => s + r.sent, 0)
    const totalProcessed = results.reduce((s, r) => s + r.processed, 0)

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: totalProcessed,
      output_count: totalSent,
      metadata: { brokerages: results.length, totalSent, totalProcessed },
    })

    return NextResponse.json({ success: true, results }, { status: 200 })
  } catch (err) {
    console.error('[cron/ghost-detection] Fatal error:', err)
    await recordCronFailureAction({ context_id: contextId, error: err as Error | string, stage: 'main-processing' })
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err), context_id: contextId },
      { status: 500 },
    )
  }
}
