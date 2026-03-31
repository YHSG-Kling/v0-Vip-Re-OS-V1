import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { initiateAIISAContactEngagement } from '@/app/actions/ai-isa/initiate-contact-engagement'
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from '@/app/actions/cron-kernel'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const contextResult = await createCronRunContextAction({
    cron_name: 'stale-contact-monitor',
    cron_path: '/app/api/cron/stale-contact-monitor/route.ts',
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: 'Failed to create cron context' }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  const startRecordResult = await recordCronStartAction({ context_id: contextId })
  if (!startRecordResult.success) {
    console.error('[StaleContactMonitor] Failed to record cron start:', startRecordResult.error)
  }

  const ranAt = new Date().toISOString()
  const supabase = createServiceClient()

  const results: Array<{
    brokerageId: string
    staleCount: number
    reengaged: number
    skipped: number
    errors: string[]
  }> = []

  // brokerages table has no is_active column — fetch all and rely on contacts filter
  const { data: brokerages } = await supabase
    .from('brokerages')
    .select('id, additional_settings')

  for (const brokerage of brokerages ?? []) {
    const brokerageId = brokerage.id
    const settings = brokerage.additional_settings as Record<string, unknown> | null

    // Use brokerage-configured threshold or default 14 days
    const staleDays =
      typeof settings?.isa_ghost_threshold_days === 'number'
        ? settings.isa_ghost_threshold_days
        : 14

    const cutoff = new Date(
      Date.now() - staleDays * 24 * 60 * 60 * 1000,
    ).toISOString()

    let reengaged = 0
    let skipped = 0
    const errors: string[] = []

    try {
      // Find assigned contacts with no recent activity.
      // These are converted leads (have agent_id) that have gone quiet.
      // contacts.last_contacted_at is not in schema — filter on created_at as fallback
      const { data: staleContacts } = await supabase
        .from('contacts')
        .select('id, first_name, last_name, email, agent_id, status, dnc_status, isa_reengage_allowed')
        .eq('brokerage_id', brokerageId)
        .not('agent_id', 'is', null)      // must be assigned to an agent
        .eq('dnc_status', false)           // not on DNC
        .neq('status', 'archived')
        .neq('status', 'inactive')
        .not('isa_reengage_allowed', 'eq', false)  // ISA re-engage must be allowed
        .lt('created_at', cutoff)          // no activity threshold — use created_at as proxy
        .limit(20)                         // max 20 per brokerage per run

      for (const contact of staleContacts ?? []) {
        try {
          const result = await initiateAIISAContactEngagement(contact.id)
          if (result.success) {
            reengaged++
          } else {
            skipped++
            // Only surface unexpected failures, not expected business stop reasons
            if (result.reason && !result.reason.startsWith('stop:') && !result.reason.startsWith('paused:')) {
              errors.push(`${contact.id}: ${result.reason}`)
            }
          }
          // Rate limit: 2 seconds between sends
          await new Promise((resolve) => setTimeout(resolve, 2000))
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          errors.push(`${contact.id}: ${msg}`)
          skipped++
        }
      }

      results.push({
        brokerageId,
        staleCount: staleContacts?.length ?? 0,
        reengaged,
        skipped,
        errors,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ brokerageId, staleCount: 0, reengaged: 0, skipped: 0, errors: [msg] })
    }
  }

  const totalReengaged = results.reduce((s, r) => s + r.reengaged, 0)

  await recordCronSuccessAction({
    context_id: contextId,
    records_processed: results.length,
    output_count: totalReengaged,
    metadata: { ranAt, totalReengaged },
  })

  return NextResponse.json({
    ok: true,
    ranAt,
    results,
    totalReengaged,
  })
}
