import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { updateConversationMemory } from "@/lib/intelligence/conversation-insights"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * CONVERSATION-INSIGHTS REFRESH CRON — the missing TRIGGER for the one
 * conversation_insights writer.
 *
 * updateConversationMemory (lib/intelligence/conversation-insights.ts) is the
 * only thing that writes conversation_insights, and until this cron NOTHING in
 * the tree ever invoked it: its only door was POST /api/intelligence/memory/
 * update, an INTERNAL_API_SECRET endpoint no in-tree code addresses (opposite-
 * missing census, category 6b). So the communications-intelligence dashboard's
 * health/KPI/coaching tabs, the AI-quality panel's review-pressure count and
 * the buyer-search intent merge all read a table that only ever grew by hand.
 *
 * This sweep finds conversations whose message activity is NEWER than their
 * stored insight (or that have no insight at all) and refreshes them through
 * the same writer the internal endpoint uses — one code path, two doors.
 *
 * COST DISCIPLINE: each refresh is an AI extraction call (platform-covered,
 * metered per-tenant through generateObjectRouted's ai_tool_usage ledger — a
 * wrong number there is a wrong invoice), so the batch is CAPPED per run and
 * only conversations with RECENT activity are considered. A conversation that
 * stays quiet is never re-billed.
 *
 * FAILURE HONESTY (§3): a refused read THROWS into recordCronFailureAction;
 * per-conversation failures are collected and reported in the success metadata
 * rather than silently swallowed — a partial sweep must never read as a full
 * one.
 */

/** How far back "recent activity" reaches. Two dispatch windows overlap so a
 *  run lost to a deploy is healed by the next one. */
const ACTIVITY_WINDOW_HOURS = 26
/** AI-call ceiling per run — the cost bound. */
const MAX_REFRESHES_PER_RUN = 25

export async function GET(req: NextRequest) {
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "conversation-insights-refresh",
    cron_path: "/app/api/cron/conversation-insights-refresh/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const supabase = createServiceClient()
  const cutoff = new Date(Date.now() - ACTIVITY_WINDOW_HOURS * 3_600_000).toISOString()

  let refreshed = 0
  let skippedFresh = 0
  const failures: string[] = []

  try {
    // Conversations with recent message activity. brokerage_id is REQUIRED:
    // the writer stamps it on every insight row (the tenant predicate the
    // memory reads filter on), so a conversation without one cannot be
    // refreshed honestly and is not selected at all.
    const { data: convs, error: convErr } = await supabase
      .from("conversations")
      .select("id, brokerage_id, last_message_at")
      .not("brokerage_id", "is", null)
      .gte("last_message_at", cutoff)
      .order("last_message_at", { ascending: false })
      .limit(200)

    if (convErr) throw new Error(`conversations read refused: ${convErr.message}`)

    const candidates = (convs ?? []) as Array<{ id: string; brokerage_id: string; last_message_at: string }>

    // Existing insight freshness, one query for the whole batch.
    const staleness = new Map<string, string>() // conversation_id → last_updated_at
    if (candidates.length > 0) {
      const { data: existing, error: insErr } = await supabase
        .from("conversation_insights")
        .select("conversation_id, last_updated_at")
        .in("conversation_id", candidates.map((c) => c.id))
      if (insErr) throw new Error(`conversation_insights read refused: ${insErr.message}`)
      for (const row of (existing ?? []) as Array<{ conversation_id: string; last_updated_at: string | null }>) {
        staleness.set(row.conversation_id, row.last_updated_at ?? "")
      }
    }

    for (const conv of candidates) {
      if (refreshed >= MAX_REFRESHES_PER_RUN) break
      const insightAt = staleness.get(conv.id)
      const isStale =
        insightAt === undefined || // no insight row at all
        insightAt === "" ||
        new Date(insightAt).getTime() < new Date(conv.last_message_at).getTime()
      if (!isStale) { skippedFresh++; continue }

      try {
        await updateConversationMemory(conv.id, conv.brokerage_id)
        refreshed++
      } catch (err: any) {
        // Collected, never swallowed — and never allowed to sink the sweep.
        failures.push(`conversation ${conv.id}: ${err?.message ?? String(err)}`)
      }
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: refreshed,
      metadata: {
        candidates: candidates.length,
        refreshed,
        skippedFresh,
        capped: refreshed >= MAX_REFRESHES_PER_RUN,
        failures: failures.slice(0, 10),
      },
    })

    return NextResponse.json({
      ok: true,
      candidates: candidates.length,
      refreshed,
      skippedFresh,
      failures,
    })
  } catch (err: any) {
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "insights-refresh" })
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 })
  }
}
