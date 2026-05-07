import { type NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

const DID_API_BASE = "https://api.d-id.com"

/** POST: create a D-ID WebRTC streaming session (photo or video source) */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const didApiKey = process.env.DID_API_KEY
  if (!didApiKey) return NextResponse.json({ error: "DID_API_KEY not configured" }, { status: 503 })

  const { source_type, source_url, presenter_id, sdpAnswer, sessionId: patchSessionId } = await request.json()

  // PATCH path: relay SDP answer back to D-ID
  if (patchSessionId && sdpAnswer) {
    const res = await fetch(`${DID_API_BASE}/talks/streams/${patchSessionId}/sdp`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ answer: sdpAnswer, session_id: patchSessionId }),
    })
    return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "SDP relay failed" }, { status: 500 })
  }

  if (!source_url && !presenter_id) {
    return NextResponse.json({ error: "presenter_id or source_url required" }, { status: 400 })
  }

  // Three source modes:
  //   presenter — the agent has a trained D-ID avatar (preferred)
  //   video     — start clips/streams from a source video URL
  //   photo     — start talks/streams from a source photo URL
  const endpoint = (source_type === "video" || source_type === "presenter")
    ? `${DID_API_BASE}/clips/streams`   // clips/streams supports both presenter + video source
    : `${DID_API_BASE}/talks/streams`

  const body: Record<string, unknown> = {}
  if (presenter_id) body.presenter_id = presenter_id
  else if (source_url) body.source_url = source_url

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  })

  const data = await res.json()
  if (!res.ok) return NextResponse.json({ error: data.description ?? "D-ID stream init failed" }, { status: 500 })

  return NextResponse.json({
    sessionId: data.id,
    sdpOffer: data.offer?.sdp ?? data.sdp,
    iceServers: data.ice_servers ?? [],
  })
}

/** PATCH: relay SDP answer (alternate method — body-based) */
export async function PATCH(request: NextRequest) {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return auth.response

  const didApiKey = process.env.DID_API_KEY
  if (!didApiKey) return NextResponse.json({ error: "DID_API_KEY not configured" }, { status: 503 })

  const { sessionId, sdpAnswer } = await request.json()
  if (!sessionId || !sdpAnswer) return NextResponse.json({ error: "sessionId and sdpAnswer required" }, { status: 400 })

  const res = await fetch(`${DID_API_BASE}/talks/streams/${sessionId}/sdp`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ answer: sdpAnswer, session_id: sessionId }),
  })

  return res.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "SDP relay failed" }, { status: 500 })
}

/** DELETE: destroy a D-ID streaming session */
export async function DELETE(request: NextRequest) {
  const didApiKey = process.env.DID_API_KEY
  if (!didApiKey) return NextResponse.json({ ok: true })

  const sessionId = request.nextUrl.searchParams.get("sessionId")
  if (!sessionId) return NextResponse.json({ ok: true })

  await fetch(`${DID_API_BASE}/talks/streams/${sessionId}`, {
    method: "DELETE",
    headers: { Authorization: `Basic ${Buffer.from(`${didApiKey}:`).toString("base64")}` },
  }).catch(() => {})

  return NextResponse.json({ ok: true })
}
