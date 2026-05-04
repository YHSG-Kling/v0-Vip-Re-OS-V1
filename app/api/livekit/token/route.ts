/**
 * POST /api/livekit/token
 *
 * Issues a short-lived LiveKit access token so an authenticated user can
 * join a private assistant room. The room name is derived server-side from
 * the user identity — clients cannot request another user's room.
 *
 * The agent worker (deployed separately — see agent-worker/livekit-agent.ts)
 * dispatches into the same room when it sees a participant connect, then
 * runs the STT → LLM → TTS pipeline using the agent's ElevenLabs voice clone.
 *
 * This route is purely additive — VAPI calling and the D-ID streaming widget
 * remain unaffected.
 */

import { NextResponse, type NextRequest } from "next/server"
import { v4 as uuidv4 } from "uuid"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"
import { issueLivekitToken, isLivekitConfigured } from "@/lib/livekit/server"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  if (!isLivekitConfigured()) {
    return NextResponse.json(
      { error: "LiveKit is not configured on this environment" },
      { status: 503 },
    )
  }

  let body: { mode?: string; contactId?: string; context?: Record<string, unknown> } = {}
  try {
    body = await request.json()
  } catch {
    body = {}
  }

  const mode = body.mode === "portal" ? "portal" : "assistant"

  // Resolve the agent's voice + avatar so the worker can pick them up off
  // room metadata without an extra round-trip.
  const { data: voiceProfile } = await supabase
    .from("agent_voice_profiles")
    .select("elevenlabs_voice_id, did_avatar_id, did_video_url, did_photo_url")
    .eq("user_id", auth.userId)
    .maybeSingle()

  const roomName = `${mode}-${auth.userId}-${uuidv4().slice(0, 8)}`
  const identity = `user-${auth.userId}-${uuidv4().slice(0, 6)}`

  try {
    const result = await issueLivekitToken({
      roomName,
      identity,
      name: auth.user.email ?? auth.user.id,
      ttlSeconds: 60 * 15,
      metadata: {
        userId: auth.userId,
        agentId: auth.agentId,
        brokerageId: auth.brokerageId,
        userType: auth.userType,
        mode,
        contactId: body.contactId ?? null,
        context: body.context ?? null,
        elevenlabs_voice_id: voiceProfile?.elevenlabs_voice_id ?? null,
        did_avatar_id: voiceProfile?.did_avatar_id ?? null,
      },
    })

    return NextResponse.json({
      token: result.token,
      url: result.url,
      roomName: result.roomName,
      identity: result.identity,
      expiresAt: result.expiresAt,
    })
  } catch (err: any) {
    console.error("[livekit/token] failed to issue token:", err)
    return NextResponse.json(
      { error: err?.message ?? "Failed to issue LiveKit token" },
      { status: 500 },
    )
  }
}
