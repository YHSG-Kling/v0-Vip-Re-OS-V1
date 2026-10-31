import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { checkPublicRateLimit } from "@/lib/security/public-rate-limit"

/**
 * THE VIRTUAL OPEN HOUSE JOIN DOOR (wave 147, lane 147Z — lane 147F "Still open": the live open_house_events.event_type CHECK
 * admits `virtual_open_house`, nothing produced one and nothing recorded who attended one; orphan doctrine §1.2 — build the
 * missing half). The producer is the ONE scheduling door, app/actions/open-house.ts createOpenHouse (eventType
 * "virtual_open_house" + an https joinUrl stored as the event's check_in_url). This door is the attendance half:
 *
 *   GET /open-house/<eventId>/join?i=<invitationId>
 *     · the event must be a virtual open house with an https check-in URL — anything else is 404 (this door never forwards
 *       to a URL it did not read off a virtual event's own row, so it cannot be used as an open redirect);
 *     · with an invitation id, the invitation is re-read FOR THIS EVENT and this event's brokerage — the unguessable pair
 *       (eventId, invitationId) is the credential, the same model as the RSVP page
 *       (app/open-house/[eventId]/rsvp/[invitationId]/page.tsx) — and the invited contact's tracking row becomes
 *       `attended` (the reading every attendance reader already uses: lib/listing-health/health-scorer.ts, the listing's
 *       Marketing tab). Tenant from the EVENT row, never from the link;
 *     · then the visitor is forwarded to the meeting.
 *
 * What it does NOT do: an anonymous click (no invitation id) is forwarded but recorded nowhere — there is no identity to file
 * and no consent to claim; and it does not prove the visitor stayed in the meeting (a meeting-provider participant webhook
 * would; that integration does not exist — lane 147Z notes, WAITING_EXTERNAL).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(req: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  const rateIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown"
  const rateVerdict = checkPublicRateLimit("open-house-virtual-join", rateIp, { limit: 120, windowMs: 10 * 60_000 })
  if (!rateVerdict.allowed) {
    return NextResponse.json({ error: "Too many requests from this connection — try again shortly." }, { status: 429, headers: { "Retry-After": String(rateVerdict.retryAfterSeconds) } })
  }

  const { eventId } = await params
  if (!UUID_RE.test(eventId)) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Service client: the visitor is anonymous and the tenant RLS on open_house_events / open_house_invitations refuses an
  // anonymous session. The event row is the ONLY thing that knows which brokerage this visit belongs to.
  const supabase = createServiceClient()
  const { data: event, error: eventErr } = await supabase
    .from("open_house_events")
    .select("id, brokerage_id, event_type, check_in_url")
    .eq("id", eventId)
    .maybeSingle()
  if (eventErr) {
    console.error("[open-house/join] event read failed:", eventErr.message)
    return NextResponse.json({ error: "This open house could not be loaded" }, { status: 500 })
  }
  const ev = event as { id: string; brokerage_id: string | null; event_type: string | null; check_in_url: string | null } | null
  let meetingUrl: string | null = null
  try { const u = new URL(String(ev?.check_in_url ?? "")); if (u.protocol === "https:") meetingUrl = u.toString() } catch { meetingUrl = null }
  if (!ev || ev.event_type !== "virtual_open_house" || !meetingUrl || !ev.brokerage_id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const invitationId = req.nextUrl.searchParams.get("i")
  if (invitationId && UUID_RE.test(invitationId)) {
    const { data: invitation, error: invErr } = await supabase
      .from("open_house_invitations")
      .select("id, contact_id, channel")
      .eq("id", invitationId)
      .eq("event_id", ev.id)
      .eq("brokerage_id", ev.brokerage_id)
      .maybeSingle()
    if (invErr) console.error("[open-house/join] invitation read failed:", invErr.message)
    const inv = invitation as { id: string; contact_id: string | null; channel: string | null } | null
    if (inv?.contact_id) {
      const { error: rsvpErr } = await supabase
        .from("open_house_rsvp_tracking")
        .upsert(
          {
            event_id: ev.id,
            contact_id: inv.contact_id,
            brokerage_id: ev.brokerage_id,
            rsvp_status: "attended",
            source: inv.channel === "sms" ? "sms" : "email",
            rsvp_updated_at: new Date().toISOString(),
          },
          { onConflict: "event_id,contact_id" },
        )
      // Non-fatal: the visitor still reaches the meeting. Logged, never swallowed — supabase-js RESOLVES a refused write.
      if (rsvpErr) console.error("[open-house/join] attendance upsert failed:", rsvpErr.message)
    }
  }

  return NextResponse.redirect(meetingUrl, 302)
}
