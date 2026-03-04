// app/api/cron/enrichment-processor/route.ts
// SEPARATE from /api/cron/contact-enrichment (legacy contacts-only path).
// Handles BOTH lead_id (Track A) and contact_id (Track B) queue entries.
// Schedule: */15 * * * * (registered in Phase 0-J)

import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { processEnrichmentQueue } from '@/lib/lead-pipeline/enrichment-orchestrator'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const startedAt = Date.now()
  const supabase = createServiceClient()

  // Fetch all active brokerages
  const { data: brokerages, error: brokErr } = await supabase
    .from('brokerages')
    .select('id')
    .eq('is_active', true)

  if (brokErr || !brokerages) {
    return NextResponse.json(
      { success: false, error: brokErr?.message ?? 'No brokerages' },
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

  return NextResponse.json({
    success: true,
    results,
    duration_ms: Date.now() - startedAt,
  })
}
