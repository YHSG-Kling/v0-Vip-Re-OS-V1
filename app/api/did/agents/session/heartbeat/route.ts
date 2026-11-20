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

  // WAVE 155 (lane 155R23): THE SESSION ROW MUST BE THIS CONTACT'S. The gate above proved access to `contactId`, then stamped
  // ANY `liveSessionId` — so a caller with access to one contact could keep another tenant's session alive, and the sweeper
  // bills the heartbeat-derived duration (lib/did/live-session-metering.ts: last_seen_at − started_at). Read the row first: it
  // must be ACTIVE, belong to this contact and to this contact's brokerage. Anything else is answered like a closed session.
  const { createServiceClient } = await import("@/lib/supabase/service")
  const { data: live, error: liveErr } = await createServiceClient().from("live_agent_sessions")
    .select("id, brokerage_id, contact_id, status").eq("id", liveSessionId).maybeSingle()
  const row = live as { id: string; brokerage_id: string | null; contact_id: string | null; status: string | null } | null
  if (liveErr || !row || row.status !== "active" || row.contact_id !== contact.id || !row.brokerage_id || row.brokerage_id !== contact.brokerage_id) {
    return NextResponse.json({ ok: true })
  }
  // LAW 5: ONE receipt per heartbeat — FINANCIAL, because each stamp extends the duration the sweeper bills to the tenant's
  // invoice. Tenant = the brokerage of the record the gate proved (the contact's, equal to the session row's), actor = the
  // signed-in caller, subject = the session row. No key: each heartbeat is a new proof of life. heartbeatLiveAgentSession is a
  // no-op on a row that closed in between (the ordinary shutdown race); the receipt then records the attempt.
  const { ledgerSessionAction } = await import("@/lib/kernel/action-ledger")
  await ledgerSessionAction({
    brokerageId: row.brokerage_id, action: "billing.live_agent_session.heartbeat", actor: { type: "user", userId: user.id },
    subject: { type: "live_agent_session", id: row.id }, riskClass: "FINANCIAL", reasonCode: "HUMAN_REQUESTED", channel: "portal",
    detail: { contact_id: contact.id },
  }, async () => { await heartbeatLiveAgentSession(row.id); return { success: true } })
  return NextResponse.json({ ok: true })
}
