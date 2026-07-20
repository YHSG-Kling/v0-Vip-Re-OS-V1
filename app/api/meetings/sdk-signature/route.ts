// app/api/meetings/sdk-signature/route.ts
// ─────────────────────────────────────────────────────────────────────────────
// MEETING SDK SIGNATURE MINTING (round 40) — the server half of the in-page
// Zoom embed. The meeting room page's client component POSTs { eventId } here
// and gets back everything the @zoom/meetingsdk/embedded client needs to join:
// { signature, sdkKey, meetingNumber, role, password?, userName }.
//
// ACCESS: the SAME check as the meeting room page itself — the session user's
// RLS-scoped read of calendar_events. If RLS won't show the caller the event,
// no signature is minted (404). Role 1 (host) only when the caller IS the
// event's owning agent (calendar_events.agent_user_id); everyone else gets a
// role-0 attendee signature.
//
// CREDENTIALS: ZOOM_SDK_KEY/ZOOM_SDK_SECRET (a dedicated Meeting SDK app), or
// the ZOOM_CLIENT_ID/ZOOM_CLIENT_SECRET pair on newer Zoom "General" apps
// where the Meeting SDK shares the OAuth credentials (see
// resolveZoomSdkCredentials). Not configured → an honest 428 stating exactly
// which env is missing — the page then renders the join-launch fallback tier.
//
// OPS: the Zoom app must have the Meeting SDK feature enabled and the OS host
// on its Domain Allow List — see the note above the SDK section in
// lib/connections/zoom.ts.

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import {
  currentZoomSdkEnv,
  resolveZoomSdkCredentials,
  zoomSdkGap,
  zoomSdkRoleForViewer,
  mintZoomSdkSignature,
  zoomPasswordFromJoinUrl,
} from "@/lib/connections/zoom"

export const dynamic = "force-dynamic"

export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  }

  let eventId: string | null = null
  try {
    const body = await req.json()
    eventId = typeof body?.eventId === "string" ? body.eventId : null
  } catch {
    // fall through to the honest 400 below
  }
  if (!eventId) {
    return NextResponse.json({ error: "eventId is required" }, { status: 400 })
  }

  // Same access check as the meeting room page: an RLS-scoped read — the event
  // resolves only within the viewer's brokerage. Invisible event → 404.
  const { data: event } = await supabase
    .from("calendar_events")
    .select("id, agent_user_id, metadata")
    .eq("id", eventId)
    .maybeSingle()
  if (!event) {
    return NextResponse.json({ error: "Meeting not found" }, { status: 404 })
  }

  const meta = (event.metadata ?? {}) as Record<string, any>
  const zoom = (meta.zoom ?? null) as { meeting_id?: string; join_url?: string; password?: string } | null
  const meetingNumber = zoom?.meeting_id ? String(zoom.meeting_id) : null
  if (!meetingNumber) {
    return NextResponse.json(
      { error: "This appointment has no Zoom meeting stamped on it — nothing to embed." },
      { status: 409 },
    )
  }

  // Credential gating: no usable SDK pair → honest 428 (Precondition Required)
  // naming exactly what is missing. The page degrades to the join-launch tier.
  const env = currentZoomSdkEnv()
  const creds = resolveZoomSdkCredentials(env)
  if (!creds) {
    return NextResponse.json({ error: zoomSdkGap(env), reason: "sdk_unconfigured" }, { status: 428 })
  }

  const role = zoomSdkRoleForViewer({ viewerUserId: user.id, eventAgentUserId: event.agent_user_id })
  const signature = mintZoomSdkSignature({
    sdkKey: creds.sdkKey,
    sdkSecret: creds.sdkSecret,
    meetingNumber,
    role,
  })

  // The session user's display name for the Zoom roster.
  const { data: profile } = await supabase
    .from("users")
    .select("first_name, last_name")
    .eq("id", user.id)
    .maybeSingle()
  const userName =
    [profile?.first_name ?? "", profile?.last_name ?? ""].join(" ").trim() ||
    user.email?.split("@")[0] ||
    "Guest"

  // Stamped meeting password when present; else the pwd Zoom embeds in the
  // join_url query string (the embedded client wants it as a separate field).
  const password = zoom?.password ?? zoomPasswordFromJoinUrl(zoom?.join_url) ?? undefined

  return NextResponse.json({
    signature,
    sdkKey: creds.sdkKey,
    meetingNumber,
    role,
    ...(password ? { password } : {}),
    userName,
  })
}
