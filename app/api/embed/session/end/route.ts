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

export const runtime = "nodejs"

// Mirrors app/api/did/agents/session/end/route.ts's MAX_SECONDS — one live
// session realistically tops out well under 2 hours; anything larger is a
// stuck timer or a forged report.
const MAX_SECONDS = 2 * 60 * 60

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as
    | { liveSessionId?: string; seconds?: number }
    | null
  const liveSessionId = body?.liveSessionId
  const seconds = Number(body?.seconds)
  if (!liveSessionId || !Number.isFinite(seconds) || seconds <= 0) {
    return NextResponse.json({ error: "liveSessionId and positive seconds required" }, { status: 400 })
  }

  const clamped = Math.min(Math.max(seconds, 1), MAX_SECONDS)
  const result = await endLiveAgentSession(liveSessionId, clamped)
  if (!result.ok) {
    // Not found / already closed — not an error the visitor's page needs to
    // see or retry; the beacon fired, its job is done either way.
    return NextResponse.json({ ok: true, minutesLogged: 0 })
  }
  return NextResponse.json({ ok: true, minutesLogged: Number((result.minutesBilled ?? 0).toFixed(2)) })
}
