/**
 * /api/did/agents/session/heartbeat
 *
 * The portal live-avatar widget's proof-of-life beacon (wave 60,
 * docs/live-agent-provider-recommendation-2026-09.md §3.1). Sent every ~2
 * minutes while AgentsWidget is mounted. Without this, a session that never
 * calls /session/end (tab crash, force-quit, lost network) would stay
 * `status='active'` in `live_agent_sessions` forever — this row is what
 * lib/did/live-session-metering.ts's cron sweeper reads to tell a live tab
 * from a dead one and close/bill the dead ones after 10 minutes of silence.
 *
 * Auth: identical portal-access gate as the session-start/end routes — a
 * heartbeat is a write, same as end, so it gets the same gate, not a lighter
 * one.
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { heartbeatLiveAgentSession } from "@/lib/did/live-session-metering"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await request.json().catch(() => null) as
    | { contactId?: string; liveSessionId?: string }
    | null
  const contactId = body?.contactId
  const liveSessionId = body?.liveSessionId
  if (!contactId || !liveSessionId) {
    return NextResponse.json({ error: "contactId and liveSessionId required" }, { status: 400 })
  }

  // ── Same portal-access gate as session-start/end ──────────────────────────
  const { data: contact } = await supabase
    .from("contacts")
    .select("id, agent_id, brokerage_id, email")
    .eq("id", contactId)
    .maybeSingle()
  if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 })

  let hasAccess = user.email?.toLowerCase() === contact.email?.toLowerCase()
  if (!hasAccess && contact.agent_id) {
    const { data: ag } = await supabase
      .from("agents")
      .select("id")
      .eq("user_id", user.id)
      .eq("id", contact.agent_id)
      .maybeSingle()
    if (ag) hasAccess = true
  }
  if (!hasAccess) {
    const { data: ur } = await supabase
      .from("users")
      .select("user_type, brokerage_id")
      .eq("id", user.id)
      .maybeSingle()
    const STAFF_TYPES = ["agent", "team_lead", "tc", "admin", "broker", "broker_owner"]
    if (ur?.brokerage_id === contact.brokerage_id && STAFF_TYPES.includes(ur?.user_type ?? "")) {
      hasAccess = true
    }
  }
  if (!hasAccess) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  await heartbeatLiveAgentSession(liveSessionId)
  return NextResponse.json({ ok: true })
}
