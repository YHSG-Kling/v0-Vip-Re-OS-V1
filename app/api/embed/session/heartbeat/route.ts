/**
 * POST /api/embed/session/heartbeat
 *
 * Public, anon-friendly sibling of
 * app/api/did/agents/session/heartbeat/route.ts. The embed widget's own
 * proof-of-life beacon while its D-ID Agents session is open — without this
 * an abandoned/crashed embed tab stays `status='active'` in
 * `live_agent_sessions` forever instead of being closed and billed by the
 * cron sweeper after 10 minutes of silence.
 *
 * Same trust shape as /api/embed/session/end: the row is looked up by id
 * inside heartbeatLiveAgentSession, scoped by its own status/id — no tenant
 * is trusted from this body at all, there is nothing here for a caller to
 * name.
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { heartbeatLiveAgentSession } from "@/lib/did/live-session-metering"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { liveSessionId?: string } | null
  const liveSessionId = body?.liveSessionId
  if (!liveSessionId) return NextResponse.json({ error: "liveSessionId required" }, { status: 400 })
  await heartbeatLiveAgentSession(liveSessionId)
  return NextResponse.json({ ok: true })
}
