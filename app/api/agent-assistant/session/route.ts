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
import { resolveWriteContext } from "@/lib/kernel/identity"
import { createServiceClient } from "@/lib/supabase/service"
import { ensureAssistantAgent, issueAssistantSession } from "@/lib/elevenlabs/conv-ai"
import { checkUsageCap } from "@/lib/usage/check-cap"
import { logMediaUsage } from "@/lib/usage/log-media-usage"
import { resolveSelfVoice } from "@/lib/voice/voice-resolver"

export const runtime = "nodejs"

interface Body {
  contextUrl?: string | null
  contextContactId?: string | null
  contextListingId?: string | null
  contextTransactionId?: string | null
}

export async function POST(request: NextRequest) {
  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = (await request.json().catch(() => ({}))) as Body

  const supabase = createServiceClient()

  // ── Resolve which real-estate agent owns the assistant ──────────────────
  // For agent users this is straightforward. For non-agent staff (TC, broker,
  // lender), we need a way to give them an assistant too. v1: only support
  // agent users; non-agent staff get a clear error pointing at the team_lead /
  // broker for setup.
  if (!ctx.agentId) {
    return NextResponse.json(
      { error: "Voice assistant is currently agent-only — no agent profile found for this user." },
      { status: 409 },
    )
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

  // ── Resolve agent identity + the agent's chosen assistant voice ──────────
  // Voice is sourced from the user's settings (Settings → Assistant). The
  // resolver honors voice_preference: 'clone' uses agent.voice_id, 'generic'
  // uses agent.assistant_voice_id, and only falls back to FALLBACK_VOICE_ID
  // when the user hasn't picked yet — never a hardcoded platform default.
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

  // ── Provision (or reuse) the ElevenLabs Conv-AI agent ────────────────────
  const ensured = await ensureAssistantAgent({
    agentId: agentRow.id,
    agentName,
    voiceId: resolved.voiceId,
  })
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
