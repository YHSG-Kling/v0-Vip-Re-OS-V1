/**
 * POST /api/objection-training/voice-turn
 *
 * Logs one side of the live practice transcript (prospect or agent) to
 * objection_training_turns. The client component fires this on each onMessage
 * callback from the ElevenLabs Conv AI SDK so the transcript persists in
 * real time. No per-turn scoring here — the holistic score happens at end.
 *
 * Body: { sessionId, speaker: 'prospect' | 'agent', text }
 *
 * Auth: resolveWriteContext + verify the session is owned by this user.
 */

import "server-only"
import { type NextRequest, NextResponse } from "next/server"
import { resolveWriteContextForTenant } from "@/lib/platform/acting-context"
import { createServiceClient } from "@/lib/supabase/service"

export const runtime = "nodejs"

interface Body {
  sessionId?: string
  speaker?: "prospect" | "agent"
  text?: string
}

export async function POST(request: NextRequest) {
  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as Body
  if (!body.sessionId || !body.speaker || !body.text?.trim()) {
    return NextResponse.json({ error: "sessionId + speaker + text required" }, { status: 400 })
  }

  const supabase = createServiceClient()

  // Verify ownership — never let a stray request log into someone else's session.
  const { data: session } = await supabase
    .from("objection_training_sessions")
    .select("id, agent_user_id, status")
    .eq("id", body.sessionId)
    .maybeSingle()
  if (!session || session.agent_user_id !== ctx.userId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 })
  }
  if (session.status !== "active") {
    return NextResponse.json({ error: "Session is closed" }, { status: 409 })
  }

  // Compute the next turn_index — we don't trust the client to pass it.
  const { data: lastTurn } = await supabase
    .from("objection_training_turns")
    .select("turn_index")
    .eq("session_id", body.sessionId)
    .order("turn_index", { ascending: false })
    .limit(1)
    .maybeSingle()
  const nextIndex = (lastTurn?.turn_index ?? -1) + 1

  await supabase.from("objection_training_turns").insert({
    session_id: body.sessionId,
    turn_index: nextIndex,
    speaker: body.speaker,
    text: body.text.trim(),
  })

  return NextResponse.json({ ok: true, turnIndex: nextIndex })
}
