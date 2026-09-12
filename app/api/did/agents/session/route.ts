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
import { checkUsageCap } from "@/lib/usage/check-cap"
import { logMediaUsage } from "@/lib/usage/log-media-usage"
import { startLiveAgentSession, recordLiveAgentInitFailure } from "@/lib/did/live-session-metering"

export const runtime = "nodejs"

// recordLiveAgentInitFailure MERGED onto lib/did/live-session-metering.ts (one helper for both session doors, routed through lib/errors/collect-error.ts) — wave 60.

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
    // SCOPE LADDER (staff roster): 'superadmin' removed — dead as users.user_type
    // (0 live rows); broker_owner added — storable same-tenant seat that owns the brokerage.
    const STAFF_TYPES = ["agent", "team_lead", "tc", "admin", "broker", "broker_owner"]
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
    .select("id, voice_id, users(first_name, last_name, email, phone)")
    .eq("id", contact.agent_id)
    .maybeSingle()

  if (!agentRow) {
    return NextResponse.json({ error: "Assigned agent not found" }, { status: 404 })
  }

  // Twin Studio: prefer the agent's default twin (look + voice + personality
  // bundled). Fall back to agent_voice_profiles for agents who haven't migrated
  // to the per-twin model yet.
  const { data: defaultTwin } = await supabase
    .from("agent_avatar_assets")
    .select("id, did_avatar_id, voice_id, personality, greeting, greeting_sentiment, status, approval_status")
    .eq("agent_id", agentRow.id)
    .eq("is_default", true)
    .maybeSingle()

  let twinId: string | undefined
  let presenterId: string | null = null
  let voiceId: string | null = null
  let personality: string | null = null
  let greeting: string | null = null
  let greetingSentiment: string | null = null

  if (defaultTwin) {
    if (defaultTwin.status !== "ready") {
      return NextResponse.json(
        { error: "Your agent's twin is still processing — try again in a minute" },
        { status: 409 },
      )
    }
    if (defaultTwin.approval_status !== "approved") {
      return NextResponse.json(
        { error: "Your agent's twin is awaiting brokerage approval" },
        { status: 409 },
      )
    }
    twinId = defaultTwin.id
    presenterId = defaultTwin.did_avatar_id
    voiceId = defaultTwin.voice_id
    personality = defaultTwin.personality
    greeting = defaultTwin.greeting ?? null
    greetingSentiment = defaultTwin.greeting_sentiment ?? null
  } else {
    const { data: voiceProfile } = await supabase
      .from("agent_voice_profiles")
      .select("did_avatar_id, elevenlabs_voice_id")
      .eq("agent_id", agentRow.id)
      .maybeSingle()
    presenterId = voiceProfile?.did_avatar_id ?? null
    voiceId = voiceProfile?.elevenlabs_voice_id ?? agentRow.voice_id ?? null
  }

  if (!presenterId) {
    return NextResponse.json(
      { error: "Agent has no twin configured yet" },
      { status: 409 },
    )
  }

  // ── Usage cap — hard-block live avatar sessions when brokerage is over ───
  // Sessions are the cheap pre-flight check; LIVE-mode minute consumption is
  // metered by /api/did/agents/session/end (widget beacons elapsed live
  // seconds on teardown — D-ID's Agents SDK has no server-side end webhook).
  // The sessions cap stays as the abuse hard-cap floor.
  const cap = await checkUsageCap({
    brokerageId: contact.brokerage_id!,
    metric: "live_avatar_sessions",
    addQuantity: 1,
  })
  if (!cap.allowed) {
    return NextResponse.json(
      { error: cap.message ?? "Usage limit reached", capExceeded: true },
      { status: 429 },
    )
  }

  // ── Ensure D-ID Agent exists for this twin ───────────────────────────────
  // WALL-CLOCK + OUTCOME (wave 60, §3.2 "instrument the turn — log D-ID
  // session init success/failure … so the provider decision can be
  // measured"). initStartedAt spans ensureDIDAgent + issueClientKey — the two
  // calls that decide whether a visitor ever sees a live avatar at all.
  const initStartedAt = Date.now()
  const ensured = await ensureDIDAgent({
    agentId: agentRow.id,
    twinId,
    presenterId,
    elevenLabsVoiceId: voiceId,
    personality,
    greeting,
    agentName: [(agentRow.users as any)?.first_name, (agentRow.users as any)?.last_name].filter(Boolean).join(" ") || "Agent",
  })

  if (!ensured.ok) {
    void recordLiveAgentInitFailure({
      brokerageId: contact.brokerage_id!, surface: "portal",
      reason: ensured.error, latencyMs: Date.now() - initStartedAt,
    })
    return NextResponse.json({ error: ensured.error }, { status: 502 })
  }
  // Realism scan on the greeting is ADVISORY (CLAUDE.md §5 — warnings pass
  // through, never a silent block) — logged for whoever reads the deploy
  // console rather than blocking a live session over a redraftable line.
  if (ensured.realismWarnings?.length) {
    console.warn(`[did/agents/session] AI-tell findings on twin ${twinId ?? agentRow.id} greeting:`, ensured.realismWarnings)
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
    void recordLiveAgentInitFailure({
      brokerageId: contact.brokerage_id!, surface: "portal",
      reason: keyResult.error, latencyMs: Date.now() - initStartedAt,
    })
    return NextResponse.json({ error: keyResult.error }, { status: 502 })
  }

  // ── Log the session start ────────────────────────────────────────────────
  // Per-session counter (abuse hard-cap). Minute-level consumption lands via
  // /api/did/agents/session/end as live_avatar_minutes + the vendor ledger
  // (lib/did/live-session-metering.ts).
  logMediaUsage({
    brokerageId: contact.brokerage_id!,
    metric: "live_avatar_sessions",
    quantity: 1,
    agentId: agentRow.id,
    contactId,
    sessionRef: ensured.didAgentId,
    feature: "portal_widget",
    metadata: { init_success: true, init_latency_ms: Date.now() - initStartedAt },
  }).catch(() => {})

  // THE METERING ROW (m624, WRITTEN NOT APPLIED) — opened here so the
  // heartbeat/end/sweeper trio has something to close. A failure to open it
  // must never break the live session itself (metering is observability).
  const liveSession = await startLiveAgentSession({
    brokerageId: contact.brokerage_id!,
    agentId: agentRow.id,
    contactId,
    surface: "portal",
    didAgentId: ensured.didAgentId,
  }).catch((e) => { console.warn("[did/agents/session] live_agent_sessions insert threw", e); return { ok: false as const, error: String(e) } })

  return NextResponse.json({
    didAgentId: ensured.didAgentId,
    clientKey: keyResult.clientKey,
    liveSessionId: liveSession.ok ? liveSession.id : null,
    // The presenter FAMILY, so the browser knows what it may offer before it
    // connects. The live widget's microphone and sentiment are Expressive (V4)
    // only, and streamOptions are v2/v3 only — sending the client a capability
    // it cannot use is how a dead button gets shipped.
    presenterType: ensured.presenterType,
    // The agent's OWN opening line, or null. Null is the common case and it is
    // not a gap: an avatar that waits to be spoken to is better than one
    // reciting a sentence its owner never wrote.
    greeting,
    greetingSentiment,
    softWarning: cap.soft_warning ? cap.message : undefined,
  })
}
