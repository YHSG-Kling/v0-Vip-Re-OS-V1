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
import { createServiceClient } from "@/lib/supabase/service"
import { decidePublicDoor, callerIpFrom } from "@/lib/security/public-rate-limit"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { liveSessionId?: string } | null
  const liveSessionId = body?.liveSessionId
  if (!liveSessionId) return NextResponse.json({ error: "liveSessionId required" }, { status: 400 })
  // WAVE 155 (lane 155R18 — G10): the DECISION before the stamp — the per-IP cap, then the ACTIVE session row the tenant's
  // widget minted (the sealed credential the visitor holds). A heartbeat every ~30 s per tab fits well under the cap.
  const door = await decidePublicDoor({
    surface: "embed-session-heartbeat", callerKey: callerIpFrom(request.headers), cap: { limit: 240, windowMs: 60_000 },
    optIn: async () => {
      const { data: row, error } = await createServiceClient().from("live_agent_sessions").select("brokerage_id, status").eq("id", liveSessionId).maybeSingle()
      const r = row as { brokerage_id: string | null; status: string | null } | null
      if (error || !r?.brokerage_id || r.status !== "active") return null
      return { brokerageId: r.brokerage_id, basis: "live_agent_sessions row (active, minted by the tenant's widget)" }
    },
  })
  if (!door.allowed) return NextResponse.json({ ok: true })
  await heartbeatLiveAgentSession(liveSessionId)
  return NextResponse.json({ ok: true })
}
