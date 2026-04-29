// app/api/cron/enrichment-processor/route.ts
// SEPARATE from /api/cron/contact-enrichment (legacy contacts-only path).
// Handles BOTH lead_id (Track A) and contact_id (Track B) queue entries.
// Schedule: */15 * * * * (registered in Phase 0-J)

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { processEnrichmentQueue } from '@/lib/lead-pipeline/enrichment-orchestrator'
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
    cron_name: 'enrichment-processor',
    cron_path: '/app/api/cron/enrichment-processor/route.ts',
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: 'Failed to create cron context' }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error('[EnrichmentProcessor] Failed to record cron start:', startRecordResult.error)
  }

  try {
  const startedAt = Date.now()
  const supabase = createServiceClient()

  // Fetch all active brokerages
  const { data: brokerages, error: brokErr } = await supabase
    .from('brokerages')
    .select('id')
    .eq('is_active', true)

  if (brokErr || !brokerages) {
    await recordCronFailureAction({ context_id: contextId, error: brokErr ?? new Error('No brokerages'), stage: 'database-fetch' })
    return NextResponse.json(
      { success: false, error: brokErr?.message ?? 'No brokerages', context_id: contextId },
      { status: 500 },
    )
  }

  const results: Array<{
    brokerageId: string
    processed: number
    succeeded: number
    failed: number
    totalCost: number
    error?: string
  }> = []

  for (const brokerage of brokerages) {
    try {
      const summary = await processEnrichmentQueue(brokerage.id)
      results.push({ brokerageId: brokerage.id, ...summary })
    } catch (err) {
      results.push({
        brokerageId: brokerage.id,
        processed: 0,
        succeeded: 0,
        failed: 0,
        totalCost: 0,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const totalProcessed = results.reduce((s, r) => s + r.processed, 0)
  const totalSucceeded = results.reduce((s, r) => s + r.succeeded, 0)

  await recordCronSuccessAction({
    context_id: contextId,
    records_processed: totalProcessed,
    output_count: totalSucceeded,
    metadata: { brokerages: results.length, totalProcessed, totalSucceeded, duration_ms: Date.now() - startedAt },
  })

  return NextResponse.json({
    success: true,
    results,
    duration_ms: Date.now() - startedAt,
  })
  } catch (error) {
    console.error('[EnrichmentProcessor] Cron failed:', error)
    await recordCronFailureAction({ context_id: contextId, error: error as Error | string, stage: 'main-processing' })
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error), context_id: contextId }, { status: 500 })
  }
}
