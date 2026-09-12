/**
 * lib/did/live-session-metering.ts
 *
 * THE ONE PLACE a live D-ID Agents session (portal / embed widget / public
 * website — lib/did/agents.ts's three surfaces) is booked as vendor usage
 * (wave 60, docs/live-agent-provider-recommendation-2026-09.md §3.1:
 * "Meter live minutes to the tenant… Every session start/end must book a
 * vendor-usage row… keyed on the brokerage from the embed/portal session —
 * never the body").
 *
 * FOUR entry points, each a thin wrapper around one `live_agent_sessions` row
 * (supabase/migrations/m624-live-agent-sessions.sql — WRITTEN, NOT APPLIED):
 *
 *   startLiveAgentSession   — session-start routes call this to open the row.
 *   heartbeatLiveAgentSession — the client beacons this periodically so the
 *                               sweeper below can tell a live tab from a dead
 *                               one.
 *   endLiveAgentSession     — the client's explicit end (unload/mode-exit)
 *                               reports its own LIVE-mode elapsed seconds —
 *                               the ACCURATE number, when it arrives.
 *   sweepStaleLiveAgentSessions — a cron closes any session whose heartbeat
 *                               went silent for >10 min, billing the
 *                               HEARTBEAT-DERIVED duration (last_seen_at −
 *                               started_at) because the accurate number never
 *                               arrived (tab crash, network death, browser
 *                               kill — the exact case a beacon cannot cover).
 *
 * TENANT NEVER FROM THE BODY (CLAUDE.md §4): every function here either takes
 * the tenant from a caller who already resolved it off session/embed state
 * (startLiveAgentSession), or re-reads it OFF THE ROW by id
 * (heartbeat/end/sweep) rather than trusting a brokerageId a client could
 * forge. All writes go through the service client — RLS on
 * live_agent_sessions grants no authenticated-role write policy at all
 * (m624's own header), so this module IS the write path.
 *
 * THIS MODULE OWNS ONE LEDGER: `vendor_usage_tracking` (logVendorUsage) — the
 * PLATFORM's D-ID cost rail (§5 "platform pays, tenant is metered"). The
 * TENANT's own cap/dashboard rail (lib/usage/log-media-usage.ts's
 * `live_avatar_minutes` metric, usage_events/usage_counters) is a SEPARATE
 * ledger that the calling routes already wrote before this pass (portal's
 * session/end) or now write alongside this module's call (embed's new
 * session/end) — kept as a second call at the route, not duplicated in here,
 * so a route with no metering row yet (defensive: startLiveAgentSession
 * failed) still books the tenant-facing minute even though the vendor row
 * cannot close.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { logVendorUsage } from "@/lib/vendor-governance/usage-logger"
import {
  roundUpToNearest15Seconds,
  estimateStreamingMinutesCostUsd,
} from "@/lib/video/realism-profile"
import { collectError } from "@/lib/errors/collect-error"

/**
 * D-ID SESSION INIT FAILURE, logged to the ops feed (wave 60 §3.2 — "so the
 * provider decision can be measured"). ONE helper for both session doors
 * (portal app/api/did/agents/session, embed app/api/embed/session) — each
 * used to carry its own hand-rolled automation_errors insert, which is both
 * a §6 second spelling and the exact defect test:automation-errors ratchets
 * against: the collector (lib/errors/collect-error.ts) owns the vocabulary
 * (status, severity, location) and never throws. automation_errors rather
 * than a new KernelEvents signal: this is a per-request reliability
 * measurement with no manager action to take.
 */
export async function recordLiveAgentInitFailure(params: {
  brokerageId: string
  surface: LiveAgentSurface
  reason: string
  latencyMs: number
}): Promise<void> {
  await collectError({
    brokerageId: params.brokerageId,
    workflowName: "did_live_agent_init",
    errorMessage: `D-ID live agent session init failed (${params.surface}, ${params.latencyMs}ms): ${params.reason}`,
    severity: "medium",
    errorType: "provider_init",
    context: { surface: params.surface, reason: params.reason, latency_ms: params.latencyMs, provider: "did" },
  })
}

type Svc = ReturnType<typeof createServiceClient>

export type LiveAgentSurface = "site" | "widget" | "portal"

export interface StartLiveAgentSessionParams {
  brokerageId: string
  agentId?: string | null
  contactId?: string | null
  surface: LiveAgentSurface
  didAgentId?: string | null
}

/** Opens the metering row. Called from the session-start routes right after
 *  a client_key is issued — a session that fails to mint never reaches here. */
export async function startLiveAgentSession(
  params: StartLiveAgentSessionParams,
  svc: Svc = createServiceClient(),
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const { data, error } = await svc
    .from("live_agent_sessions")
    .insert({
      brokerage_id: params.brokerageId,
      agent_id: params.agentId ?? null,
      contact_id: params.contactId ?? null,
      surface: params.surface,
      did_agent_id: params.didAgentId ?? null,
      provider: "did",
      status: "active",
    })
    .select("id")
    .single()

  if (error || !data) {
    console.error("[live-session-metering] start insert failed:", error?.message)
    return { ok: false, error: error?.message ?? "insert failed" }
  }
  return { ok: true, id: data.id }
}

/** The client's periodic proof-of-life. Silently no-ops on an id that is not
 *  active/does not exist — a heartbeat racing an already-ended session (the
 *  tab closed between ticks) is not an error, it is the ordinary shutdown
 *  race, and heartbeating must never throw into a `pagehide` handler. */
export async function heartbeatLiveAgentSession(
  sessionId: string,
  svc: Svc = createServiceClient(),
): Promise<void> {
  if (!sessionId) return
  await svc
    .from("live_agent_sessions")
    .update({ last_seen_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("status", "active")
    .then(() => {}, (e) => console.warn("[live-session-metering] heartbeat failed", e))
}

interface CloseResult {
  ok: boolean
  minutesBilled?: number
  error?: string
}

/** Shared close path for BOTH the explicit-end and sweep callers — the only
 *  difference between them is which duration they pass in, so the billing
 *  arithmetic (round-up, vendor ledger, tenant ledger) can never drift (§6). */
async function closeLiveAgentSession(
  svc: Svc,
  row: { id: string; brokerage_id: string; agent_id: string | null; contact_id: string | null; surface: string },
  seconds: number,
  status: "ended" | "swept",
  source: "client_report" | "sweep",
): Promise<CloseResult> {
  const billedSeconds = roundUpToNearest15Seconds(seconds)
  const minutes = billedSeconds / 60

  const { error: updateError } = await svc
    .from("live_agent_sessions")
    .update({
      status,
      ended_at: new Date().toISOString(),
      minutes_billed: minutes,
    })
    .eq("id", row.id)
    .eq("status", "active")

  if (updateError) {
    console.error("[live-session-metering] close update failed:", updateError.message)
    return { ok: false, error: updateError.message }
  }

  if (minutes > 0) {
    // THE VENDOR LEDGER (platform-pays, §5) — what the platform owes D-ID.
    void logVendorUsage({
      vendorName: "did",
      usageType: "streaming_minutes",
      unitCount: minutes,
      estimatedCost: estimateStreamingMinutesCostUsd(billedSeconds),
      systemSource: `live_agent_${row.surface}`,
      brokerageId: row.brokerage_id,
      agentId: row.agent_id ?? undefined,
      metadata: { live_agent_session_id: row.id, surface: row.surface, close_source: source, seconds_reported: seconds, seconds_billed: billedSeconds },
    })
  }

  return { ok: true, minutesBilled: minutes }
}

/** The client's own accurate report — LIVE-mode elapsed seconds it tracked
 *  itself (liveSecondsRef in AgentsWidget/EmbedWidget), clamped by the
 *  caller. Tenant is read OFF THE ROW, never trusted from the request. */
export async function endLiveAgentSession(
  sessionId: string,
  seconds: number,
  svc: Svc = createServiceClient(),
): Promise<CloseResult> {
  if (!sessionId) return { ok: false, error: "sessionId required" }
  const { data: row, error } = await svc
    .from("live_agent_sessions")
    .select("id, brokerage_id, agent_id, contact_id, surface, status")
    .eq("id", sessionId)
    .maybeSingle()
  if (error || !row) return { ok: false, error: error?.message ?? "session not found" }
  if (row.status !== "active") return { ok: true, minutesBilled: 0 } // already closed — idempotent no-op
  return closeLiveAgentSession(svc, row, Math.max(0, seconds), "ended", "client_report")
}

/** CRON-SAFE SWEEPER (registered app/api/cron/live-agent-session-sweep,
 *  CRON_REGISTRY). Any session whose last_seen_at is older than
 *  STALE_AFTER_MS with no explicit end is a tab that never got to report —
 *  crashed, lost network, or the visitor just closed the laptop lid. Billed
 *  at the HEARTBEAT-DERIVED duration (last_seen_at − started_at): an
 *  underestimate of true wall time by at most one heartbeat interval, which
 *  is the honest number when the accurate one never arrives. */
const STALE_AFTER_MS = 10 * 60 * 1000

export async function sweepStaleLiveAgentSessions(
  svc: Svc = createServiceClient(),
): Promise<{ swept: number; errors: number }> {
  const staleBefore = new Date(Date.now() - STALE_AFTER_MS).toISOString()
  const { data: stale, error } = await svc
    .from("live_agent_sessions")
    .select("id, brokerage_id, agent_id, contact_id, surface, started_at, last_seen_at, status")
    .eq("status", "active")
    .lt("last_seen_at", staleBefore)
    .limit(200)

  if (error) {
    console.error("[live-session-metering] sweep query failed:", error.message)
    return { swept: 0, errors: 1 }
  }

  let swept = 0
  let errors = 0
  for (const row of stale ?? []) {
    const seconds = (new Date(row.last_seen_at).getTime() - new Date(row.started_at).getTime()) / 1000
    const res = await closeLiveAgentSession(svc, row, Math.max(0, seconds), "swept", "sweep")
    if (res.ok) swept += 1
    else errors += 1
  }
  return { swept, errors }
}

// ─── READER (wave 60): what a tenant was metered for, session by session ──────
//
// The four ledger columns below (provider, did_agent_id, ended_at,
// minutes_billed) were written by startLiveAgentSession / endLiveAgentSession /
// sweepStaleLiveAgentSessions and read by nobody — the readerless-write census
// caught them the moment m624 went live. The reader is the superadmin billing
// diagnostics drill-down (app/api/admin/billing/live-agent-sessions), so a
// support question about a tenant's live-agent minutes is answered from the
// same rows the vendor ledger was fed from, never re-derived.
export interface LiveAgentSessionLedgerRow {
  id: string
  surface: LiveAgentSurface
  provider: string
  did_agent_id: string | null
  status: "active" | "ended" | "swept"
  started_at: string
  ended_at: string | null
  minutes_billed: number | null
}

export async function listLiveAgentSessionsForBrokerage(params: {
  brokerageId: string
  days?: number
  limit?: number
}): Promise<
  | { success: true; sessions: LiveAgentSessionLedgerRow[]; totals: { sessions: number; minutesBilled: number; estimatedUsd: number; active: number } }
  | { success: false; error: string }
> {
  const svc = createServiceClient()
  const since = new Date(Date.now() - (params.days ?? 30) * 86_400_000).toISOString()
  const { data, error } = await svc
    .from("live_agent_sessions")
    .select("id, surface, provider, did_agent_id, status, started_at, ended_at, minutes_billed")
    .eq("brokerage_id", params.brokerageId)
    .gte("started_at", since)
    .order("started_at", { ascending: false })
    .limit(params.limit ?? 200)
  if (error) return { success: false, error: error.message }
  const sessions = (data ?? []) as LiveAgentSessionLedgerRow[]
  const minutesBilled = sessions.reduce((sum, s) => sum + Number(s.minutes_billed ?? 0), 0)
  return {
    success: true,
    sessions,
    totals: {
      sessions: sessions.length,
      minutesBilled,
      estimatedUsd: estimateStreamingMinutesCostUsd(minutesBilled),
      active: sessions.filter((s) => s.status === "active").length,
    },
  }
}
