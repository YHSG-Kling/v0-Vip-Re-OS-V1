/**
 * app/api/cron/lead-action-plan/route.ts
 *
 * THE LEAD ACTION PLAN LOOP — the scheduler and the governor for pre-conversion,
 * ISA-owned leads. See lib/ai-isa/lead-action-plan.ts for the full accounting of
 * what already existed and what did not.
 *
 * Two passes per active brokerage, in this order and for this reason:
 *
 *   1. ADVANCE — `advanceLeadActionPlans` asks the plan what is due for each
 *      ISA-owned lead that has already had its first touch, and re-arms the
 *      EXISTING producer (asset_manager:lead_creative_handoff) when a step is due.
 *      /api/cron/speed-to-lead only ever fires touch ONE (it selects
 *      `first_touched_at IS NULL`), so before this loop existed nothing scheduled
 *      touches 2..N and `max_touches_lead` / `touch_interval_days` had no reader.
 *
 *   2. RELEASE — `releaseDueLeadTouches` walks the LEAD-recipient proposals those
 *      producers wrote and releases only the ones the brokerage authorised via
 *      `ai_isa_settings` (master switch ON, `require_broker_approval` FALSE,
 *      channel in `lead_allowed_channels`). Everything else stays at
 *      status='proposed' — a human's approval queue, never a silent drop.
 *
 * ADVANCE RUNS FIRST on purpose: a creative commissioned this minute is not
 * releasable this minute (the reel has to render), so ordering it the other way
 * would only delay every plan by one tick with no benefit.
 *
 * FAIL CLOSED (CLAUDE.md §4): an unreadable settings tier, a refused lead read and
 * a refused proposal read all end in "staged", never in "sent". A per-brokerage
 * throw is isolated so one tenant's failure never stops the fleet.
 *
 * Auth: verifyCronAuth (CRON_SECRET) — the same gate the rest of the cron fleet
 * uses. Registered in lib/kernel/cron-dispatch.ts, which is the single source of
 * truth for schedules (vercel.json carries one dispatcher cron, not 100+).
 */
import { NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { advanceLeadActionPlans, releaseDueLeadTouches } from "@/lib/ai-isa/lead-action-plan"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 300

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "lead-action-plan",
    cron_path: "/app/api/cron/lead-action-plan/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  // EVERYTHING AFTER THE START RECORD RUNS INSIDE THE FAILURE WIRE. A run that
  // opens a cron_execution_logs row at 'started' and only ever closes it on the
  // success path leaves that row at 'started' forever on a throw, and
  // cron_health_snapshot then reports the run BEFORE it as the last known state —
  // a cron that has never failed, on a cron that has.
  try {
    const supabase = createServiceClient()

    const { data: brokerages, error } = await supabase
      .from("brokerages")
      .select("id")
      .eq("is_active", true)

    if (error) {
      await recordCronFailureAction({ context_id: contextId, error, stage: "brokerage-fetch" })
      return NextResponse.json({ ok: false, error: error.message, context_id: contextId }, { status: 500 })
    }

    let examinedLeads = 0
    let advanced = 0
    let examinedProposals = 0
    let sent = 0
    let staged = 0
    let failed = 0
    const warnings: string[] = []

    for (const brokerage of (brokerages ?? []) as Array<{ id: string }>) {
      try {
        const adv = await advanceLeadActionPlans({ brokerageId: brokerage.id })
        examinedLeads += adv.examined
        advanced += adv.advanced
        for (const w of adv.warnings) warnings.push(`${brokerage.id}: ${w}`)

        const rel = await releaseDueLeadTouches({ brokerageId: brokerage.id })
        examinedProposals += rel.examined
        sent += rel.sent
        staged += rel.staged
        failed += rel.failed
        for (const w of rel.warnings) warnings.push(`${brokerage.id}: ${w}`)
      } catch (err) {
        // One tenant's failure never stops the fleet — and it is REPORTED, not
        // swallowed, so a brokerage whose plans stopped advancing is visible.
        warnings.push(`${brokerage.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: examinedLeads + examinedProposals,
      metadata: {
        brokerages: (brokerages ?? []).length,
        // Every count carries its denominator (CLAUDE.md §2): `examinedLeads` is
        // the denominator for `advanced`, `examinedProposals` for sent/staged/failed.
        examinedLeads, advanced,
        examinedProposals, sent, staged, failed,
        warnings: warnings.slice(0, 20),
      },
    })

    return NextResponse.json({
      ok: true,
      brokerages: (brokerages ?? []).length,
      examinedLeads, advanced,
      examinedProposals, sent, staged, failed,
      warnings: warnings.slice(0, 20),
    })
  } catch (err) {
    await recordCronFailureAction({
      context_id: contextId,
      error: err as Error | string,
      stage: "main-processing",
    })
    return NextResponse.json({ ok: false, context_id: contextId }, { status: 500 })
  }
}
