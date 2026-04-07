import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { runGhostReengagement } from '@/lib/ai-isa/ghost-reengagement'
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from '@/app/actions/cron-kernel'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
      .select('id, additional_settings')
      .eq('is_active', true)

    if (brErr) throw new Error(`Failed to load brokerages: ${brErr.message}`)

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
        const settings = brokerage.additional_settings as Record<string, unknown> | null
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
    await recordCronFailureAction({ context_id: contextId, error: err, stage: 'main-processing' })
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err), context_id: contextId },
      { status: 500 },
    )
  }
}
