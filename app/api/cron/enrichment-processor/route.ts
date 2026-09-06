// app/api/cron/enrichment-processor/route.ts
// SEPARATE from /api/cron/contact-enrichment (legacy contacts-only path).
// Handles BOTH lead_id (Track A) and contact_id (Track B) queue entries.
// Schedule: */15 * * * * (registered in Phase 0-J)

import {
NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { processEnrichmentQueue } from '@/lib/lead-pipeline/enrichment-orchestrator'
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
    /** Rows the FREE OSINT lane (keyless OSM + US Census) contributed to, at $0.
     *  Reported alongside — never folded into — the paid counters, so the run
     *  summary can never read free coverage as paid coverage. */
    freeLaneRuns?: number
    /** Rows where the paid person lane was REQUIRED but withheld (vendor budget).
     *  Not successes: the person question went unanswered. */
    paidWithheld?: number
    leadsTopUp?: number
    error?: string
  }> = []

  for (const brokerage of brokerages) {
    try {
      // ── LEAD-TRACK NET (wave 5) ───────────────────────────────────────────
      // "enrichment also needs to still happen with raw leads" (owner).
      //
      // The create doors are hooked (event-reactor D-septies for the live one,
      // direct hooks for the two that emit nothing), but hooks alone leave three
      // populations un-enriched forever: every lead created before this shipped,
      // every lead refused by the per-tenant backlog cap while a scrape surge
      // drained, and every platform-origin lead that was PARKED (brokerage_id
      // NULL) at promotion time and only gained a tenant later. This is the net
      // under them — the same reason wave 3 revived the contact cron instead of
      // retiring it.
      //
      // UNATTENDED DOOR, NOT A SESSION ONE. The tenant comes from the brokerages
      // list read out of the database above; nothing here reads a tenant from the
      // request, and CRON_SECRET is verified at the top. This is the pattern the
      // contact lane's cron was rebuilt on after a session gate silently starved
      // it of rows.
      //
      // BOUNDED: LEAD_NET_PER_BROKERAGE (25) candidates per tenant per run, and
      // each candidate still crosses queueLeadEnrichment's full gate —
      // identifier, freshness-by-evidence, pending-row idempotency, live-deal
      // suppression, the backlog cap and the vendor-budget pre-flight. It only
      // ENQUEUES; the drain below is what spends, and its per-tenant
      // BATCH_SIZE is unchanged, so this pass cannot raise the spend ceiling.
      let leadsTopUp = 0
      try {
        const { listLeadsNeedingEnrichment, queueLeadEnrichment, LEAD_NET_PER_BROKERAGE } =
          await import('@/lib/enrichment/lead-enrichment-core')
        const net = await listLeadsNeedingEnrichment({
          brokerageId: brokerage.id,
          limit: LEAD_NET_PER_BROKERAGE,
        })
        if (net.error) {
          console.error(`[EnrichmentProcessor] ${brokerage.id} lead-net read failed:`, net.error)
        }
        for (const lead of net.leads) {
          const q = await queueLeadEnrichment({
            leadId: lead.id,
            brokerageId: brokerage.id,
            triggerType: 'lead_net',
          })
          if (q.queued) leadsTopUp++
          // A refusal is not an error: 'backlog' means this tenant already has
          // all the committed spend it is allowed, so stop asking this run.
          else if (q.reason === 'backlog' || q.reason === 'budget') break
        }
      } catch (err) {
        // The net is additive. A failure here must never stop the drain below,
        // which is what actually completes work already paid for.
        console.error(`[EnrichmentProcessor] ${brokerage.id} lead-net top-up failed:`, err)
      }

      const summary = await processEnrichmentQueue(brokerage.id)
      results.push({ brokerageId: brokerage.id, ...summary, leadsTopUp })
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
  const totalFreeLane = results.reduce((s, r) => s + (r.freeLaneRuns ?? 0), 0)
  const totalPaidWithheld = results.reduce((s, r) => s + (r.paidWithheld ?? 0), 0)

  await recordCronSuccessAction({
    context_id: contextId,
    records_processed: totalProcessed,
    output_count: totalSucceeded,
    metadata: {
      brokerages: results.length, totalProcessed, totalSucceeded,
      // Lane split, so a run that leaned on the free lane (or that withheld paid
      // spend against an exhausted budget) is legible from the cron ledger alone.
      totalFreeLane, totalPaidWithheld,
      duration_ms: Date.now() - startedAt,
    },
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
