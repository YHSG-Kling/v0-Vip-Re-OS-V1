/**
 * AI Team Daily Briefing ("Morning Huddle") Cron — the multi-manager differentiator, governed.
 *
 * A human real-estate team starts the day with a huddle: every desk reports, and the lead
 * knows the ONE prioritized picture. Our 14 AI managers already produce that picture at
 * READ time (generateManagerStandup, surfaced in the Command Center) — but until now it was
 * never a first-class event: nothing ran it on a schedule, and it never crossed the manager
 * SIGNAL BUS, so the "team working together" was a render, not an auditable act.
 *
 * This cron convenes the huddle once a day per brokerage: it runs the SAME generateManagerStandup
 * (no new aggregation — zero drift), composes one roundup, and publishes ONE governed
 * `team_daily_briefing` signal (cron_manager → the busiest-needing-human desk) so it:
 *   - renders automatically on the existing "managers talking" feed (loadRecentManagerTalk),
 *   - is auditable on the bus like every other coordination act, and
 *   - is voiceable ("what should I do today?" → the same standup brain).
 *
 * feed_only + kind:update (classifyCoordination('team_daily_briefing') === 'update'); idempotent
 * per (brokerage, day) so a manual re-trigger never double-posts.
 *
 * Schedule: 30 6 * * * (6:30 AM — right after the per-agent daily-briefing at 6:00).
 * Authorization: Bearer CRON_SECRET (see lib/cron-auth.ts).
 */

import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { generateManagerStandup } from "@/lib/intelligence/manager-standup"
import { publishManagerSignal } from "@/lib/kernel/manager-signals"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

/** UTC calendar day label, e.g. 2026-07-26 — carried in the payload for display. */
function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Midnight UTC today, ISO — the per-day idempotency boundary (manager_signals.entity_id
 *  is a uuid column, so the day cannot live there; we dedupe on created_at instead). */
function startOfUtcDayIso(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()
}

export async function GET(request: NextRequest) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "team-daily-briefing",
    cron_path: "/app/api/cron/team-daily-briefing/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const supabase = createServiceClient()
    const startTime = Date.now()
    const day = utcDayKey()
    const dayStart = startOfUtcDayIso()

    // Enumerate brokerages that have at least one active agent (the population that
    // gets value from a team huddle) — same source the per-agent daily-briefing uses.
    const { data: agentRows, error: agentsError } = await supabase
      .from("agents")
      .select("brokerage_id")
      .eq("is_active", true)
    if (agentsError) throw new Error(`Failed to fetch agents: ${agentsError.message}`)

    const brokerageIds = [
      ...new Set((agentRows ?? []).map((a) => a.brokerage_id).filter(Boolean) as string[]),
    ]

    let published = 0
    let skipped = 0
    let errors = 0
    const errorDetails: Array<{ brokerageId: string; error: string }> = []

    for (const brokerageId of brokerageIds) {
      try {
        // Idempotency: one huddle per brokerage per UTC day, regardless of which desk it
        // was addressed to (recipient is chosen dynamically below). Keyed on created_at —
        // entity_id is a uuid column and cannot hold the day.
        const { data: already } = await supabase
          .from("manager_signals")
          .select("id")
          .eq("brokerage_id", brokerageId)
          .eq("signal_type", "team_daily_briefing")
          .gte("created_at", dayStart)
          .limit(1)
        if (already && already.length > 0) {
          skipped++
          continue
        }

        const lines = await generateManagerStandup(brokerageId, supabase)
        if (!lines.length) {
          skipped++
          continue
        }

        const totalActivity = lines.reduce((s, l) => s + l.activity_24h, 0)
        const totalNeeds = lines.reduce((s, l) => s + l.needs_human, 0)
        const totalReaped = lines.reduce((s, l) => s + l.reaped_24h, 0)

        // Point the huddle at the desk that most needs the human today (tiebreak: most
        // active), so the feed line "leads with" where attention is owed. Deterministic.
        // cron_manager is the sender, so it can never be the recipient (from !== to) — the
        // standup never emits it today, but filter defensively so a future line can't break
        // the route.
        const ranked = [...lines]
          .filter((l) => l.manager !== "cron_manager")
          .sort((a, b) => b.needs_human - a.needs_human || b.activity_24h - a.activity_24h)
        if (!ranked.length) {
          skipped++
          continue
        }
        const lead = ranked[0]
        const top = ranked.slice(0, 3)

        const summary =
          `AI team morning huddle — ${totalActivity} action${totalActivity === 1 ? "" : "s"} across the team in 24h, ` +
          `${totalNeeds} awaiting your OK` +
          (totalReaped ? `, ${totalReaped} auto-cleaned` : "") +
          `. ` +
          top.map((l) => `${l.label}: ${l.headline}`).join(" · ")

        const res = await publishManagerSignal(
          {
            brokerageId,
            fromManager: "cron_manager",
            toManager: lead.manager,
            signalType: "team_daily_briefing",
            message: summary,
            entityType: "briefing",
            // entity_id is a uuid column — the day lives in the payload; idempotency is by created_at.
            payload: { day, totalActivity, totalNeeds, totalReaped, lines },
          },
          supabase,
        )
        if (res.ok) published++
        else {
          errors++
          errorDetails.push({ brokerageId, error: res.reason ?? "publish failed" })
        }
      } catch (err) {
        errors++
        errorDetails.push({
          brokerageId,
          error: err instanceof Error ? err.message : "Unknown error",
        })
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: brokerageIds.length,
      output_count: published,
      metadata: { day, brokerages: brokerageIds.length, published, skipped, errors },
    })

    return NextResponse.json({
      message: "AI team daily briefing complete",
      day,
      brokerages: brokerageIds.length,
      published,
      skipped,
      errors,
      duration_ms: Date.now() - startTime,
      ...(errorDetails.length > 0 && { error_details: errorDetails.slice(0, 10) }),
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    await recordCronFailureAction({
      context_id: contextId,
      error: error as Error | string,
      stage: "main-processing",
    })
    return NextResponse.json({ error: errorMessage, context_id: contextId }, { status: 500 })
  }
}
