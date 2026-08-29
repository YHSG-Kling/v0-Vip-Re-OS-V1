/**
 * POST /api/agent-assistant/session
 *
 * Auth-gated. Mints a short-lived signed_url for the @elevenlabs/client SDK
 * and returns it to the browser, along with the conversation_id we'll use to
 * attribute later tool calls back to this session.
 *
 * Authorization: requires a logged-in staff user (resolveWriteContext). The
 * widget itself is staff-only (gated by FloatingVoiceFAB visibility) but we
 * re-check on the server.
 *
 * Cap check: live_assistant_minutes — if the brokerage is at the cap, we
 * short-circuit with 429 so the staff member sees a friendly message.
 *
 * Returns: { signedUrl, sessionId, convAiAgentId, softWarning? }
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { createServiceClient } from "@/lib/supabase/service"
import { ensureAssistantAgent, ensureStaffAssistantAgent, issueAssistantSession } from "@/lib/elevenlabs/conv-ai"
import { checkUsageCap } from "@/lib/usage/check-cap"
import { logMediaUsage } from "@/lib/usage/log-media-usage"
import { resolveSelfVoice } from "@/lib/voice/voice-resolver"
import { getVoiceAssistantExpandedRoles } from "@/lib/brokerage/get-brokerage-settings"
import { isPlatformStaffIdentity } from "@/lib/auth/resolve-user-role"

// VOICE ACCESS POLICY (owner): the voice assistant is principal/agent-scoped
// by default. The PRINCIPAL may expand it to additional tenant staff roles
// via the brokerage-level setting voice_assistant_expanded_roles (managed on
// Settings → Voice Assistant Access), and PLATFORM STAFF always have it.
// Expansion grants SURFACE access only — per-intent permissions stay each
// role's existing tool-registry authority gates, never widened here.
// 'superadmin' removed (task #211): dead as users.user_type — 0 live rows store
// it; platform staff are admitted via isPlatformStaffIdentity below.
const PRINCIPAL_VOICE_ROLES = new Set(["broker", "broker_owner", "broker_admin", "admin"])

export const runtime = "nodejs"

interface Body {
  contextUrl?: string | null
  contextContactId?: string | null
  contextListingId?: string | null
  contextTransactionId?: string | null
}

export async function POST(request: NextRequest) {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as Body

  const supabase = createServiceClient()

  // ── Resolve which lane owns the assistant ────────────────────────────────
  // Agent users (an agents row exists) get their personal assistant with their
  // chosen voice. Non-agent users are admitted only per the VOICE ACCESS
  // POLICY above: principals, platform staff, and the staff roles the
  // principal expanded via voice_assistant_expanded_roles. Everyone else gets
  // a clear error naming the management setting.
  let staffLane = false
  if (!ctx.agentId) {
    const { data: profileRow } = await supabase
      .from("users").select("platform_role").eq("id", ctx.userId).maybeSingle()
    const platformStaff = isPlatformStaffIdentity(ctx.userType, (profileRow as any)?.platform_role ?? null)
    const principal = PRINCIPAL_VOICE_ROLES.has(ctx.userType)
    const expanded = !principal && !platformStaff
      ? (await getVoiceAssistantExpandedRoles(ctx.brokerageId)).includes(ctx.userType)
      : false
    if (!principal && !platformStaff && !expanded) {
      return NextResponse.json(
        {
          error:
            "Voice assistant is not enabled for your role — your broker can enable it under Settings → Voice Assistant Access.",
        },
        { status: 403 },
      )
    }
    staffLane = true
  }

  // Cap check — fail fast before we burn an ElevenLabs API call.
  const cap = await checkUsageCap({
    brokerageId: ctx.brokerageId,
    metric: "live_assistant_sessions",
    addQuantity: 1,
  })
  if (!cap.allowed) {
    return NextResponse.json(
      { error: cap.message ?? "Assistant temporarily unavailable. Please try again later." },
      { status: 429 },
    )
  }

  // ── Resolve identity + the assistant voice, then provision the Conv-AI
  // agent for the right lane ───────────────────────────────────────────────
  // Agent lane: voice is sourced from the user's settings (Settings →
  // Assistant); the resolver honors voice_preference ('clone' uses
  // agent.voice_id, 'generic' uses agent.assistant_voice_id) and only falls
  // back to FALLBACK_VOICE_ID when the user hasn't picked yet.
  // Staff lane (expanded roles / principals / platform staff without an
  // agents row): the shared per-brokerage staff assistant with the platform
  // fallback voice — tool calls still attribute to THIS user via the session.
  let ensured: Awaited<ReturnType<typeof ensureAssistantAgent>>
  if (!staffLane) {
    const { data: agentRow } = await supabase
      .from("agents")
      .select("id, conv_ai_agent_id, users(first_name, last_name, email, phone)")
      .eq("id", ctx.agentId)
      .maybeSingle()

    if (!agentRow) {
      return NextResponse.json({ error: "Agent profile not found" }, { status: 404 })
    }

    const agentName = [(agentRow.users as any)?.first_name, (agentRow.users as any)?.last_name].filter(Boolean).join(" ").trim() || "Agent"
    const resolved = await resolveSelfVoice(ctx.userId)

    ensured = await ensureAssistantAgent({
      agentId: agentRow.id,
      agentName,
      voiceId: resolved.voiceId,
    })
  } else {
    const { data: staffUser } = await supabase
      .from("users").select("first_name, last_name").eq("id", ctx.userId).maybeSingle()
    const displayName = [(staffUser as any)?.first_name, (staffUser as any)?.last_name].filter(Boolean).join(" ").trim() || "Staff"
    const resolved = await resolveSelfVoice(ctx.userId) // no agents row → platform fallback voice
    ensured = await ensureStaffAssistantAgent({
      brokerageId: ctx.brokerageId,
      displayName,
      voiceId: resolved.voiceId,
    })
  }
  if (!ensured.ok) {
    return NextResponse.json({ error: ensured.error }, { status: 502 })
  }

  // ── Issue a signed_url for the browser SDK ───────────────────────────────
  const session = await issueAssistantSession({ convAiAgentId: ensured.convAiAgentId })
  if (!session.ok) {
    return NextResponse.json({ error: session.error }, { status: 502 })
  }

  // ── Create the session row so the tool-call webhook can attribute calls ──
  // We don't have ElevenLabs' conversation_id yet — that arrives on the first
  // tool call (or via SDK callback). The webhook will UPDATE this row when it
  // sees a conversation_id it doesn't yet know.
  const { data: sessionRow } = await supabase
    .from("agent_assistant_sessions")
    .insert({
      brokerage_id: ctx.brokerageId,
      agent_id: ctx.agentId,
      user_id: ctx.userId,
      context_url: body.contextUrl ?? null,
      context_contact_id: body.contextContactId ?? null,
      context_listing_id: body.contextListingId ?? null,
      context_transaction_id: body.contextTransactionId ?? null,
    })
    .select("id")
    .single()

  // ── Log the session-open as a usage event ────────────────────────────────
  logMediaUsage({
    brokerageId: ctx.brokerageId,
    metric: "live_assistant_sessions",
    quantity: 1,
    agentId: ctx.agentId,
    userId: ctx.userId,
    sessionRef: sessionRow?.id ?? null,
    feature: "agent_assistant",
  }).catch(() => {})

  return NextResponse.json({
    signedUrl: session.signedUrl,
    sessionId: sessionRow?.id ?? null,
    convAiAgentId: ensured.convAiAgentId,
    softWarning: cap.soft_warning ? cap.message : undefined,
  })
}

/**
 * PATCH /api/agent-assistant/session — CLOSE a voice-assistant session.
 *
 * `agent_assistant_sessions.ended_at` was READ BY CODE AND WRITTEN BY NOBODY
 * (census 1b). The tool-call webhook reads it twice — `.is("ended_at", null)` on
 * the conversation lookup and again on the unattributed-session fallback
 * (app/api/agent-assistant/tool-call/route.ts:90,106) — so with no writer, every
 * session this route has ever opened is still OPEN.
 *
 * That is not a cosmetic ledger gap. The fallback picks "the most-recent
 * unattributed open session" with NO tenant and NO user predicate — ElevenLabs
 * does not pass our session id, so recency is the only attribution there is. An
 * open-forever backlog is exactly the set that fallback searches, so a session
 * abandoned days ago by another user was a candidate owner for today's first
 * tool call.
 *
 * Closing is not an egress and mints nothing, but it still writes a row, so it
 * is gated the same way the open is and scoped to the caller's OWN session: the
 * id is caller-supplied into an authenticated route, so the predicate carries
 * `user_id` from the SESSION (§4) and never trusts the body for whose session
 * this is. `ended_at IS NULL` makes a double-fire (the SDK teardown and the
 * unmount cleanup both run) idempotent rather than overwriting the real end
 * time with a later one.
 */
export async function PATCH(request: NextRequest) {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as { sessionId?: string | null }
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 })
  }

  const supabase = createServiceClient()
  // `.select()` the update and COUNT it: an UPDATE that matches NOTHING also
  // resolves with error null and empty data, byte-identical to one that worked
  // (§3), and here a zero-row result means the tenant/owner predicate refused —
  // somebody else's session id — which the caller must not read as "closed".
  const { data: closed, error } = await supabase
    .from("agent_assistant_sessions")
    .update({ ended_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("user_id", ctx.userId)
    .is("ended_at", null)
    .select("id")

  if (error) {
    console.error("[agent-assistant] session close REFUSED — the session stays open to the attribution fallback:", error.message)
    return NextResponse.json({ error: "Could not close the session" }, { status: 500 })
  }

  // Zero rows is the ALREADY-CLOSED case as often as it is the wrong-owner case,
  // and the browser cannot tell them apart or act on either, so it is reported
  // as a non-error with the count rather than as a failure.
  return NextResponse.json({ ok: true, closed: (closed ?? []).length })
}
