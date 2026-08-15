/**
 * POST /api/widget/avatar-session
 * Public (no auth). Creates a D-ID WebRTC streaming session for the website widget Live Agent mode.
 * Validates that the agent belongs to the stated brokerage, then opens a D-ID stream.
 *
 * PATCH /api/widget/avatar-session
 * Relays SDP answer back to D-ID for WebRTC handshake.
 *
 * DELETE /api/widget/avatar-session?sessionId=...
 * Destroys the D-ID streaming session on widget close.
 */
import { type NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"

const DID_API_BASE = "https://api.d-id.com"

function didAuth(apiKey: string) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`
}

export async function POST(request: NextRequest) {
  const { agentId, brokerageId } = await request.json()
  if (!agentId || !brokerageId) {
    return NextResponse.json({ error: "agentId and brokerageId required" }, { status: 400 })
  }

  const didApiKey = process.env.DID_API_KEY
  if (!didApiKey) return NextResponse.json({ error: "Live Agent unavailable" }, { status: 503 })

  const supabase = createServiceClient()

  // Verify agent belongs to brokerage
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id, user_id")
    .eq("user_id", agentId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  if (!agentRow) return NextResponse.json({ error: "Agent not found" }, { status: 404 })

  // Fetch avatar source (video clip preferred over photo)
  const { data: voiceProfile } = await supabase
    .from("agent_voice_profiles")
    .select("did_photo_url, did_video_url")
    .eq("user_id", agentId)
    .maybeSingle()

  const sourceUrl = voiceProfile?.did_video_url ?? voiceProfile?.did_photo_url ?? null
  const sourceType: "video" | "photo" = voiceProfile?.did_video_url ? "video" : "photo"

  if (!sourceUrl) return NextResponse.json({ error: "Agent has no avatar configured" }, { status: 404 })

  const endpoint = sourceType === "video"
    ? `${DID_API_BASE}/clips/streams`
    : `${DID_API_BASE}/talks/streams`

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: didAuth(didApiKey),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ source_url: sourceUrl }),
  })

  const data = await res.json()
  if (!res.ok) {
    return NextResponse.json({ error: data.description ?? "D-ID stream init failed" }, { status: 500 })
  }

  return NextResponse.json({
    sessionId: data.id,
    sdpOffer: data.offer?.sdp ?? data.sdp,
    iceServers: data.ice_servers ?? [],
    sourceType,
  })
}

export async function PATCH(request: NextRequest) {
  const { sessionId, sdpAnswer } = await request.json()
  if (!sessionId || !sdpAnswer) {
    return NextResponse.json({ error: "sessionId and sdpAnswer required" }, { status: 400 })
  }

  const didApiKey = process.env.DID_API_KEY
  if (!didApiKey) return NextResponse.json({ error: "Live Agent unavailable" }, { status: 503 })

  const res = await fetch(`${DID_API_BASE}/talks/streams/${sessionId}/sdp`, {
    method: "POST",
    headers: {
      Authorization: didAuth(didApiKey),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ answer: sdpAnswer, session_id: sessionId }),
  })

  return res.ok
    ? NextResponse.json({ ok: true })
    : NextResponse.json({ error: "SDP relay failed" }, { status: 500 })
}

export async function DELETE(request: NextRequest) {
  const didApiKey = process.env.DID_API_KEY
  if (!didApiKey) return NextResponse.json({ ok: true })

  const sessionId = request.nextUrl.searchParams.get("sessionId")
  if (!sessionId) return NextResponse.json({ ok: true })

  await fetch(`${DID_API_BASE}/talks/streams/${sessionId}`, {
    method: "DELETE",
    headers: { Authorization: didAuth(didApiKey) },
  }).catch(() => {})

  return NextResponse.json({ ok: true })
}
