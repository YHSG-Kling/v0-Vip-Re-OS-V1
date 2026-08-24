import {
NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { initiateAIISAContactEngagement } from '@/app/actions/ai-isa/initiate-contact-engagement'
import { detectAllEligibleContacts, DEFAULT_MAX_BATCH } from '@/lib/ai-isa/stale-contact-detector'
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from '@/app/actions/cron-kernel'
import { verifyCronAuth } from "@/lib/cron-auth"
import { ISA_SERVICE_IDENTITY, isaTenantWorkQueue } from "@/lib/ai-isa/isa-acting-scope"
import { scopeBrokerageId } from "@/lib/kernel/tenant-scope"

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

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
    /** How many of staleCount were GHOSTED (messaged, no reply) rather than merely quiet. */
    ghostedCount: number
    reengaged: number
    skipped: number
    errors: string[]
  }> = []

  // brokerages table has no is_active column — fetch all and rely on contacts filter
  const { data: brokerages, error: brokeragesErr } = await supabase
    .from('brokerages')
    .select('id')

  // supabase-js RESOLVES a failed query, so an unchecked read here would loop over
  // zero brokerages and then report `ok: true, totalReengaged: 0` — a refused read
  // and a genuinely quiet night are indistinguishable to every consumer of this
  // response. They must not be.
  if (brokeragesErr) {
    await recordCronFailureAction({ context_id: contextId, error: brokeragesErr.message, stage: 'load-brokerages' })
    return NextResponse.json({ ok: false, error: brokeragesErr.message, context_id: contextId }, { status: 500 })
  }

  // Thresholds live in global_settings.additional_settings (per brokerage).
  const { data: settingsRows, error: settingsErr } = await supabase
    .from('global_settings')
    .select('brokerage_id, additional_settings')
  if (settingsErr) {
    // Not fatal — every brokerage falls back to the module default — but it must
    // not pass as "nobody configured a threshold".
    console.error('[cron/stale-contact-monitor] global_settings read refused:', settingsErr.message)
  }
  const settingsByBrokerage = new Map<string, Record<string, unknown>>()
  for (const r of settingsRows ?? []) {
    if (r.brokerage_id) settingsByBrokerage.set(r.brokerage_id as string, (r.additional_settings as Record<string, unknown>) ?? {})
  }

  // ── THE ISA WORKS FOR ONE TENANT AT A TIME (owner ruling, 2026-08-24) ──────
  //
  // This cron IS the AI ISA acting for the PLATFORM: it sweeps every brokerage.
  // That is legitimate — the ruling says the ISA "works for 1 tenant at a time
  // and works for the platform as well" — but the platform-wide half must execute
  // as a SEQUENCE of single-tenant scopes, never as one wide one. The loop used
  // to carry a raw `brokerage.id` string, which is the shape that lets a tenant
  // predicate be forgotten on any one of the ~15 reads below and silently return
  // every brokerage's rows through the service client.
  //
  // `isaTenantWorkQueue` turns the brokerage list into exactly that sequence:
  // each element is a TenantScope of kind "tenant" carrying ONE id, and it
  // REFUSES rather than widening if a tenant is unset. A brokerage row with a
  // blank id no longer becomes an unfiltered pass over the platform; it is simply
  // not in the queue.
  const isaWork = isaTenantWorkQueue({
    ...ISA_SERVICE_IDENTITY,
    brokerageIds: (brokerages ?? []).map((b) => b.id as string | null),
    where: 'cron/stale-contact-monitor',
  })

  for (const isaScope of isaWork) {
    // Singular by construction — scopeBrokerageId returns null only for a
    // platform scope, and the queue never contains one.
    const brokerageId = scopeBrokerageId(isaScope)
    if (!brokerageId) continue
    const settings = settingsByBrokerage.get(brokerageId) ?? null

    // Use brokerage-configured threshold or default 14 days
    const staleDays =
      typeof settings?.isa_ghost_threshold_days === 'number'
        ? settings.isa_ghost_threshold_days
        : 14

    let reengaged = 0
    let skipped = 0
    const errors: string[] = []

    try {
      // THE CANONICAL DETECTOR, not a fourth copy of the query.
      //
      // This block used to hand-roll the stale read, and its filter was
      // `.lt('created_at', cutoff)` under a comment asserting that
      // contacts.last_contacted_at "is not in schema". It is (verified against
      // scripts/schema-snapshot.ts), and the consequence of the wrong column was
      // not cosmetic: created_at never moves, so every contact older than the
      // threshold stayed permanently inside the stale net and was auto-messaged
      // no matter how recently their agent had spoken to them. The inline query
      // also had no exclusion for an OPEN TRANSACTION — a client under contract
      // was a re-engagement candidate.
      //
      // detectAllEligibleContacts applies last_contacted_at, the open-transaction
      // exclusion, ai_outreach_paused, deleted_at, the lifetime long-horizon
      // threshold, AND the two exclusions this cron used to own (status
      // archived/inactive, assigned-agent-required) — which were merged into the
      // shared policy before this query was removed, so nothing was lost.
      //
      // It also returns the GHOSTED half (messaged, no reply) that no caller had
      // ever asked for, labelled per contact so the engine can tell the two apart.
      const staleContacts = await detectAllEligibleContacts(brokerageId, {
        staleDays,
        ghostedDays: staleDays,
        // The old inline query took 20 per brokerage per run; keep that ceiling
        // rather than inheriting the module's larger default batch.
        maxBatch: Math.min(20, DEFAULT_MAX_BATCH),
        requireAssignedAgent: true,
      })

      for (const contact of staleContacts) {
        try {
          // COLD-CONTACT CHECKPOINT — before another auto-touch, if this contact has gone
          // cold (≥ COLD_CONTACT_TOUCHES unanswered ISA follow-ups), loop in the OWNING AGENT
          // once for a personal call (the automation still nurtures). The contact-side mirror
          // of the ghost-lead escalation — no cold relationship auto-loops without a human.
          const { count: noReplyTouches, error: touchErr } = await supabase
            .from('isa_outreach_log')
            .select('id', { count: 'exact', head: true })
            .eq('contact_id', contact.id)
            .is('replied_at', null)
          if (touchErr) {
            // A refused count reads as 0, i.e. "not cold" — which silently
            // withholds the one human checkpoint on an endlessly-nurtured
            // relationship. Surface it instead of escalating on a guess.
            errors.push(`${contact.id}: cold-check read refused: ${touchErr.message}`)
          } else {
            const { coldContactReengagementCheck } = await import('@/lib/ai-isa/reengagement-policy')
            if (coldContactReengagementCheck(noReplyTouches ?? 0).isCold) {
              const { escalateColdContact } = await import('@/lib/ai-isa/cold-contact-escalation')
              await escalateColdContact(supabase, {
                contactId: contact.id, brokerageId, agentId: contact.agent_id,
                touches: noReplyTouches ?? 0, firstName: contact.first_name ?? null,
              })
            }
          }

          // THE DETECTED SITUATION, not a fixed label. detection_type is 'stale'
          // or 'ghosted', and engageContact treats them differently — 'ghosted'
          // routes the AI call to the ghost_recovery purpose and arms the
          // situational voicemail's fresh hook. Passing the real one is what
          // makes the ghosted half of the detector mean anything downstream.
          const result = await initiateAIISAContactEngagement(contact.id, contact.detection_type)
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

      // OFFER-REJECTION RECOVERY — the ACUTE window the 14-day stale net misses: a buyer
      // whose offer was just rejected gets a gated regroup + (acute) an AI-ISA call routed,
      // before they go shop another agent. Honest: countered offers are live, not recovered.
      try {
        const { runOfferRejectionRecovery } = await import('@/lib/lead-pipeline/offer-rejection-recovery-runner')
        const rec = await runOfferRejectionRecovery({ brokerageId }, supabase)
        reengaged += rec.recovered
      } catch (err: unknown) {
        errors.push(`offer-rejection-recovery: ${err instanceof Error ? err.message : String(err)}`)
      }

      // EXPIRED/WITHDRAWN LISTING RE-LIST RECOVERY (seller-side mirror) — re-engage a seller
      // whose listing came off the market without selling, before a competitor calls.
      try {
        const { runRelistRecovery } = await import('@/lib/listings/relist-recovery-runner')
        const rel = await runRelistRecovery({ brokerageId }, supabase)
        reengaged += rel.recovered
      } catch (err: unknown) {
        errors.push(`relist-recovery: ${err instanceof Error ? err.message : String(err)}`)
      }

      // STALE PRE-APPROVAL RE-ENGAGE — a quiet pre-contract buyer whose pre-approval lapsed
      // can't make a competitive offer; refresh their financing before they drift away.
      try {
        const { runStalePreApprovalReengage } = await import('@/lib/lead-pipeline/stale-preapproval-reengage-runner')
        const pa = await runStalePreApprovalReengage({ brokerageId }, supabase)
        reengaged += pa.reengaged
      } catch (err: unknown) {
        errors.push(`stale-preapproval: ${err instanceof Error ? err.message : String(err)}`)
      }

      // OVER-DEFERRAL ACCOUNTABILITY — a manager deferred-to repeatedly on one contact with no
      // action gets an "act or release" nudge. Turns visible coordination into accountability.
      try {
        const { runStalledDeferralNudges } = await import('@/lib/kernel/stalled-deferrals-runner')
        await runStalledDeferralNudges(brokerageId, supabase)
      } catch (err: unknown) {
        errors.push(`deferral-nudge: ${err instanceof Error ? err.message : String(err)}`)
      }

      // PERSONA-DRIFT REFRESH — re-queue records whose enrichment has aged past the freshness
      // window so the next persona-grounded touch is built on CURRENT facts, not a stale snapshot.
      try {
        const { runPersonaDriftRefresh } = await import('@/lib/lead-pipeline/persona-drift-runner')
        await runPersonaDriftRefresh({ brokerageId }, supabase)
      } catch (err: unknown) {
        errors.push(`persona-drift: ${err instanceof Error ? err.message : String(err)}`)
      }

      // AI-ISA REACTIVATION — enroll quiet contacts & leads into the multi-channel reactivation
      // SEQUENCE (consolidated into the real sequencer: de-confliction + shared touch ledger +
      // response-driven stop + persona copy). Replaces the old hand-built ladders.
      try {
        const { runReactivationEnrollment } = await import('@/lib/lead-pipeline/reactivation-enroller')
        const re = await runReactivationEnrollment({ brokerageId }, supabase)
        reengaged += re.enrolledContacts + re.enrolledLeads
      } catch (err: unknown) {
        errors.push(`reactivation-enrollment: ${err instanceof Error ? err.message : String(err)}`)
      }

      results.push({
        brokerageId,
        staleCount: staleContacts.length,
        ghostedCount: staleContacts.filter((c) => c.detection_type === 'ghosted').length,
        reengaged,
        skipped,
        errors,
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ brokerageId, staleCount: 0, ghostedCount: 0, reengaged: 0, skipped: 0, errors: [msg] })
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
