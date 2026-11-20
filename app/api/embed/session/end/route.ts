/**
 * POST /api/embed/session/end
 *
 * Public, anon-friendly sibling of app/api/did/agents/session/end/route.ts —
 * the embed widget's own beacon/keepalive-fetch on unload (wave 60 §3.1).
 * Embed had NO minute-level metering at all before this pass; only the
 * per-session counter at mint. This is that missing half.
 *
 * Tenant/brokerage is resolved OFF THE `live_agent_sessions` ROW BY ID
 * (lib/did/live-session-metering.ts::endLiveAgentSession), never off the
 * body — an anonymous visitor's request has no session to authenticate it,
 * so the row lookup itself is the only trust boundary here. A liveSessionId
 * for a DIFFERENT tenant's row still only closes THAT row (scoped by its own
 * brokerage_id, read back out of the row, never supplied by the caller) —
 * there is nothing for a forged id to escalate into beyond closing a session
 * that was already going to close on its own via the sweeper.
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { endLiveAgentSession } from "@/lib/did/live-session-metering"
import { createServiceClient } from "@/lib/supabase/service"
import { decidePublicDoor, callerIpFrom } from "@/lib/security/public-rate-limit"

export const runtime = "nodejs"

// Mirrors app/api/did/agents/session/end/route.ts's MAX_SECONDS — one live
// session realistically tops out well under 2 hours; anything larger is a
// stuck timer or a forged report.
const MAX_SECONDS = 2 * 60 * 60
// Clock skew between the visitor's tab and the server, allowed on top of the elapsed time.
const ELAPSED_SLACK_SECONDS = 60

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as
    | { liveSessionId?: string; seconds?: number }
    | null
  const liveSessionId = body?.liveSessionId
  const seconds = Number(body?.seconds)
  if (!liveSessionId || !Number.isFinite(seconds) || seconds <= 0) {
    return NextResponse.json({ error: "liveSessionId and positive seconds required" }, { status: 400 })
  }

  // WAVE 155 (lane 155R18 — G10, P0): the DECISION before any write or meter — the per-IP cap, then the TENANT'S OWN OPT-IN:
  // the ACTIVE session row the tenant's widget minted (app/api/widget/session decides the tenant's widget_enabled at mint; the
  // id it handed this visitor is the sealed credential). A report can bill no more time than has ELAPSED since that row
  // started (a 30-second session reported as two hours was billed two hours: a wrong invoice, CLAUDE.md §5).
  const seen: { startedAt: number | null } = { startedAt: null }
  const door = await decidePublicDoor({
    surface: "embed-session-end", callerKey: callerIpFrom(request.headers), cap: { limit: 30, windowMs: 60_000 },
    optIn: async () => {
      const { data: row, error } = await createServiceClient().from("live_agent_sessions")
        .select("id, brokerage_id, status, started_at, created_at").eq("id", liveSessionId).maybeSingle()
      const r = row as { brokerage_id: string | null; status: string | null; started_at: string | null; created_at: string | null } | null
      if (error || !r?.brokerage_id || r.status !== "active") return null
      const t = Date.parse(r.started_at ?? r.created_at ?? "")
      seen.startedAt = Number.isFinite(t) ? t : null
      return { brokerageId: r.brokerage_id, basis: "live_agent_sessions row (active, minted by the tenant's widget)" }
    },
  })
  // Not found / already closed / throttled — not an error the visitor's page needs to see or retry.
  if (!door.allowed) return NextResponse.json({ ok: true, minutesLogged: 0 })
  const elapsed = seen.startedAt === null ? MAX_SECONDS : Math.floor((Date.now() - seen.startedAt) / 1000) + ELAPSED_SLACK_SECONDS
  const clamped = Math.min(Math.max(seconds, 1), MAX_SECONDS, Math.max(1, elapsed))
  // WAVE 155 (lane 155R21, LAW 5): ONE receipt per booking of live-agent minutes — FINANCIAL (the minutes feed the tenant's
  // invoice). The tenant is the one the door PROVED (the session row's brokerage — never the body); the actor is `system` (an
  // anonymous visitor's beacon); the subject is the session row. No key: endLiveAgentSession is its own at-most-once (a closed
  // row books 0 and settles 'skipped'). A refusing ledger changes nothing — the booking still runs.
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  type Booked = Awaited<ReturnType<typeof endLiveAgentSession>>
  const bookMinutes = (): Promise<Booked> => endLiveAgentSession(liveSessionId, clamped)
  const result = door.brokerageId ? await withActionLedger<Booked>({
    brokerageId: door.brokerageId, action: "billing.live_agent_minutes.book", actor: { type: "system", userId: null },
    subject: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(liveSessionId) ? { type: "live_agent_session", id: liveSessionId } : { type: "live_agent_session", ref: liveSessionId },
    riskClass: "FINANCIAL", reasonCode: "CONVERSATION_RESPONSE", reasonDetail: "embed widget session ended (visitor beacon)", channel: "web", systemSource: "embed_widget",
    detail: { reported_seconds: seconds, billed_seconds: clamped, door: door.basis },
  }, bookMinutes, {
    settle: (r) => !r.ok ? { status: "failed", outcome: "close_refused", error: r.error ?? null }
      : (r.minutesBilled ?? 0) > 0 ? { status: "executed", outcome: "minutes_booked" } : { status: "skipped", outcome: "already_closed" },
    replay: (claim) => ({ ok: false, error: claim.kind === "refused" ? `the action ledger refused this booking's receipt: ${claim.error}` : "this session's minutes were already booked" }),
  }) : await bookMinutes()
  if (!result.ok) {
    // Not found / already closed — not an error the visitor's page needs to
    // see or retry; the beacon fired, its job is done either way.
    return NextResponse.json({ ok: true, minutesLogged: 0 })
  }
  return NextResponse.json({ ok: true, minutesLogged: Number((result.minutesBilled ?? 0).toFixed(2)) })
}
