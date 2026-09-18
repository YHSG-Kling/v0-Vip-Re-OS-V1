/**
 * /api/did/agents/session/end
 *
 * Minute-level consumption ingestion for live avatar sessions — closes the
 * metering TODO on the session-start route. D-ID's Agents SDK manages the
 * WebRTC lifecycle in the browser and offers no server-side session-end
 * webhook, so the portal widget itself reports elapsed LIVE-mode seconds
 * (sendBeacon on mode-exit / unmount). The value is clamped server-side and
 * the per-session counter on session-start remains the abuse hard-cap, so a
 * spoofed report can neither zero out billing (sessions still count) nor
 * inflate it unbounded (clamp).
 *
 * Auth: identical portal-access gate as the session-start route.
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { logMediaUsage } from "@/lib/usage/log-media-usage"
import { endLiveAgentSession } from "@/lib/did/live-session-metering"

export const runtime = "nodejs"

// One live session realistically tops out well under 2 hours; anything
// larger is a stuck timer or a forged report.
const MAX_SECONDS = 2 * 60 * 60

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await request.json().catch(() => null) as
    | { contactId?: string; didAgentId?: string; seconds?: number; liveSessionId?: string | null }
    | null
  const contactId = body?.contactId
  const seconds = Number(body?.seconds)
  if (!contactId || !Number.isFinite(seconds) || seconds <= 0) {
    return NextResponse.json({ error: "contactId and positive seconds required" }, { status: 400 })
  }

  // ── Same portal-access gate as the session-start route ───────────────────
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
    // SCOPE LADDER (staff roster): 'superadmin' removed — dead as users.user_type
    // (0 live rows); broker_owner added — storable same-tenant seat that owns the brokerage.
    const STAFF_TYPES = ["agent", "team_lead", "tc", "admin", "broker", "broker_owner"]
    if (ur?.brokerage_id === contact.brokerage_id && STAFF_TYPES.includes(ur?.user_type ?? "")) {
      hasAccess = true
    }
  }
  if (!hasAccess) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!contact.brokerage_id) return NextResponse.json({ error: "Contact has no brokerage" }, { status: 409 })

  const clamped = Math.min(Math.max(seconds, 1), MAX_SECONDS)
  const minutes = clamped / 60

  await logMediaUsage({
    brokerageId: contact.brokerage_id,
    metric: "live_avatar_minutes",
    quantity: minutes,
    agentId: contact.agent_id ?? null,
    contactId,
    sessionRef: body?.didAgentId ?? null,
    feature: "portal_widget",
    metadata: { reported_seconds: seconds, clamped_seconds: clamped, source: "widget_beacon" },
  })

  // THE VENDOR LEDGER (wave 60, m624) — closes the live_agent_sessions row
  // opened at session-start and books the platform's D-ID cost. Tenant is
  // read OFF THE ROW by endLiveAgentSession, never off this body — a missing/
  // stale liveSessionId (older client, or the insert at start failed) just
  // means no vendor row exists to close; the tenant ledger above still landed.
  if (body?.liveSessionId) {
    await endLiveAgentSession(body.liveSessionId, clamped).catch((e) =>
      console.warn("[did/agents/session/end] live_agent_sessions close failed", e),
    )
  }

  return NextResponse.json({ ok: true, minutesLogged: Number(minutes.toFixed(2)) })
}
