import { NextResponse } from "next/server"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"
import { sweepStaleLiveAgentSessions } from "@/lib/did/live-session-metering"

/**
 * LIVE AGENT SESSION SWEEP — wave 60, docs/live-agent-provider-recommendation-
 * 2026-09.md §3.1 ("a cron-safe sweeper closes sessions with no
 * heartbeat for > 10 min at the heartbeat-derived duration").
 *
 * A `live_agent_sessions` row (m624, WRITTEN NOT APPLIED) opened at session-
 * start is normally closed by the client's own explicit end (unload/mode-exit
 * beacon, an ACCURATE LIVE-mode-second report). This sweep is the case that
 * beacon can never cover: a crashed tab, killed browser, or dead network
 * never fires `pagehide`/`beforeunload` at all. Every session's heartbeat
 * (2min cadence — AgentsWidget.tsx / embed-widget.tsx) keeps `last_seen_at`
 * moving; this cron finds every row still `status='active'` whose heartbeat
 * went silent for >10 minutes and closes it at the HEARTBEAT-DERIVED duration
 * (last_seen_at − started_at) — an honest, if slightly conservative (by up to
 * one heartbeat interval), number when the accurate one never arrives.
 *
 * Same pattern as did-agent-sync (lib/did/agents.ts::syncDIDAgent /
 * app/api/cron/did-agent-sync): a SWEEP, not a per-request cleanup, because a
 * dead session must close even when nothing ever calls its own end route —
 * exactly the case a button-only or beacon-only design misses (CLAUDE.md §3).
 *
 * TENANCY: a platform cron reading across tenants ON PURPOSE (CLAUDE.md §4);
 * every row acted on stays scoped to its own brokerage (sweepStaleLiveAgent-
 * Sessions reads brokerage_id off each row, never off the request).
 */
export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET(request: Request) {
  const unauth = verifyCronAuth(request)
  if (unauth) return unauth

  const contextResult = await createCronRunContextAction({
    cron_name: "live-agent-session-sweep",
    cron_path: "/app/api/cron/live-agent-session-sweep/route.ts",
  })
  if (!contextResult.success || !contextResult.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = contextResult.data.context_id
  await recordCronStartAction({ context_id: contextId })

  try {
    const { swept, errors } = await sweepStaleLiveAgentSessions()
    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: swept + errors,
      output_count: swept,
      metadata: { swept, errors },
    })
    return NextResponse.json({ success: true, swept, errors })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error("[LiveAgentSessionSweep] failed:", message)
    await recordCronFailureAction({ context_id: contextId, error: message })
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
