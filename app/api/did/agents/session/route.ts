/**
 * /api/did/agents/session
 *
 * Issues a short-lived D-ID Agents `client_key` for the browser SDK to
 * connect to a real-time conversational avatar session.
 *
 * Flow:
 *   1. Auth gate: caller must be a contact with portal access OR an
 *      agent/admin previewing the portal (matches /portal layout rules).
 *   2. Resolve the assigned real-estate-agent for this contact and load
 *      their voice profile (presenter_id, voice clone id).
 *   3. ensureDIDAgent — idempotently creates / fetches the D-ID Agent for
 *      this real-estate-agent. One Agent per agent_user, reused across
 *      every contact's portal.
 *   4. issueClientKey — returns the origin-locked, short-lived key that
 *      the @d-id/client-sdk uses to connect.
 *
 * Returns:
 *   { didAgentId, clientKey }
 *
 * No PATCH/DELETE handlers — the SDK manages the WebRTC lifecycle on its
 * own once it has the client_key. The legacy talks/streams + clips/streams
 * routes can be deleted once the widget is migrated (Commit 5).
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { ensureDIDAgent, issueClientKey } from "@/lib/did/agents"

export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const supabase = await createClient()

  // ── Auth gate (matches portal layout's access rules) ─────────────────────
  const { data: { user }, error: authError } = await supabase.auth.getUser()
  if (authError || !user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await request.json().catch(() => null) as { contactId?: string } | null
  const contactId = body?.contactId
  if (!contactId) {
    return NextResponse.json({ error: "contactId required" }, { status: 400 })
  }

  // ── Verify caller has access to this contact's portal ────────────────────
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
    const STAFF_TYPES = ["agent", "team_lead", "tc", "admin", "broker", "superadmin"]
    if (
      ur?.brokerage_id === contact.brokerage_id &&
      STAFF_TYPES.includes(ur?.user_type ?? "")
    ) {
      hasAccess = true
    }
  }

  if (!hasAccess) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  // ── Resolve assigned agent's voice profile ───────────────────────────────
  if (!contact.agent_id) {
    return NextResponse.json({ error: "No agent assigned to this contact" }, { status: 409 })
  }

  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, full_name, voice_id")
    .eq("id", contact.agent_id)
    .maybeSingle()

  if (!agentRow) {
    return NextResponse.json({ error: "Assigned agent not found" }, { status: 404 })
  }

  const { data: voiceProfile } = await supabase
    .from("agent_voice_profiles")
    .select("did_avatar_id, elevenlabs_voice_id")
    .eq("agent_id", agentRow.id)
    .maybeSingle()

  const presenterId = voiceProfile?.did_avatar_id
  if (!presenterId) {
    return NextResponse.json(
      { error: "Agent has no D-ID avatar configured" },
      { status: 409 },
    )
  }

  // ── Ensure D-ID Agent exists ─────────────────────────────────────────────
  const ensured = await ensureDIDAgent({
    agentId: agentRow.id,
    presenterId,
    elevenLabsVoiceId: voiceProfile?.elevenlabs_voice_id ?? agentRow.voice_id ?? null,
    agentName: agentRow.full_name ?? "Agent",
  })

  if (!ensured.ok) {
    return NextResponse.json({ error: ensured.error }, { status: 502 })
  }

  // ── Issue client key locked to our portal origin ─────────────────────────
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!appUrl) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_APP_URL not configured" },
      { status: 503 },
    )
  }

  // The browser SDK loads from the portal origin. Allow a comma-separated
  // override for staging / preview deploys via DID_ALLOWED_ORIGINS.
  const extraOrigins = (process.env.DID_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  const allowedOrigins = Array.from(new Set([appUrl, ...extraOrigins]))

  const keyResult = await issueClientKey({
    didAgentId: ensured.didAgentId,
    allowedOrigins,
  })

  if (!keyResult.ok) {
    return NextResponse.json({ error: keyResult.error }, { status: 502 })
  }

  return NextResponse.json({
    didAgentId: ensured.didAgentId,
    clientKey: keyResult.clientKey,
  })
}
