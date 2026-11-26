import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { checkPublicRateLimit } from "@/lib/security/public-rate-limit"
import { isOnlineEvent } from "@/lib/open-house/event-registry"

/**
 * THE ONLINE EVENT JOIN DOOR (wave 147, lane 147Z — built as the virtual open house's attendance half; wave 148, lane 148H — C22,
 * owner ruling 20: "participant join/leave webhooks to verify attendance; an anonymous join click is NOT attendance").
 *
 * A CLICK IS NOT ATTENDANCE. This door used to write open_house_rsvp_tracking 'attended' the moment an invited contact clicked —
 * a person who clicked and closed the tab "attended". It now records only what a click IS, and forwards:
 *
 *   GET /open-house/<eventId>/join?r=<registrationId>   (the personal link in the registration confirmation)
 *     · the registration is re-read FOR THIS EVENT and this event's brokerage (the unguessable pair is the credential);
 *     · a Zoom registrant is forwarded to THEIR OWN Zoom join link (provider_join_url — the link that carries their Zoom
 *       registrant id, so the participant webhook can verify them); everyone else to the event's own https URL;
 *     · a YouTube registrant's open is recorded as `watch_link_opened` evidence (identity: the registration token) — never
 *       "watched": YouTube exposes no per-viewer identity.
 *   GET /open-house/<eventId>/join?i=<invitationId>     (an invitation's link)
 *     · the invitation is re-read for this event + brokerage and its clicked_at is stamped (a click, nothing more);
 *     · a Zoom event that registers attendees sends the invitee to the event's REGISTRATION page first (/open-house/<id>/register
 *       — same origin), so they register through the consented form and receive their own verifiable link.
 *   Anything else (an anonymous click) is forwarded and recorded nowhere.
 *
 * Attendance is written ONLY by the verified doors the registry names (the kiosk, the agent walk-in, the Zoom participant webhook
 * — lib/open-house/event-attendance.ts). The forward target is ALWAYS read off this event's own rows (check_in_url, or the
 * registration's provider_join_url), https-only, never from the link — not an open redirect. Tenant from the EVENT row.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const httpsOrNull = (v: unknown): string | null => { try { const u = new URL(String(v ?? "")); return u.protocol === "https:" ? u.toString() : null } catch { return null } }

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
    .select("id, brokerage_id, event_type, virtual_provider, check_in_url, provider_meta, is_published")
    .eq("id", eventId)
    .maybeSingle()
  if (eventErr) {
    console.error("[open-house/join] event read failed:", eventErr.message)
    return NextResponse.json({ error: "This event could not be loaded" }, { status: 500 })
  }
  const ev = event as { id: string; brokerage_id: string | null; event_type: string | null; virtual_provider: string | null; check_in_url: string | null; provider_meta: Record<string, unknown> | null; is_published: boolean | null } | null
  let meetingUrl: string | null = null
  try { const u = new URL(String(ev?.check_in_url ?? "")); if (u.protocol === "https:") meetingUrl = u.toString() } catch { meetingUrl = null }
  if (!ev || !isOnlineEvent(ev.event_type, ev.virtual_provider) || !meetingUrl || !ev.brokerage_id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  const registrationId = req.nextUrl.searchParams.get("r")
  if (registrationId && UUID_RE.test(registrationId)) {
    const { data: reg, error: regErr } = await supabase
      .from("open_house_rsvp_tracking")
      .select("id, contact_id, provider_join_url, registered_at")
      .eq("id", registrationId)
      .eq("event_id", ev.id)
      .eq("brokerage_id", ev.brokerage_id)
      .maybeSingle()
    if (regErr) console.error("[open-house/join] registration read failed:", regErr.message)
    const r = reg as { id: string; contact_id: string | null; provider_join_url: string | null; registered_at: string | null } | null
    if (r?.contact_id && r.registered_at) {
      if (ev.virtual_provider === "youtube") {
        // One watch-link open per registration per hour: the dedupe key is READ first (a repeat click in the hour is not new
        // evidence), the UNIQUE index stays the race net.
        const dedupeKey = `yt-open:${r.id}:${new Date().toISOString().slice(0, 13)}`
        const { data: seen, error: seenErr } = await supabase.from("event_attendance_evidence").select("id").eq("event_id", ev.id).eq("dedupe_key", dedupeKey).maybeSingle()
        if (seenErr) console.error("[open-house/join] watch-link evidence read failed:", seenErr.message)
        if (!seen && !seenErr) {
          const { error: evErr } = await supabase.from("event_attendance_evidence").insert({
            brokerage_id: ev.brokerage_id, event_id: ev.id, contact_id: r.contact_id, provider: "youtube", provider_event: "watch_link_opened",
            identity_match: "registration_token", occurred_at: new Date().toISOString(), dedupe_key: dedupeKey,
          })
          // Non-fatal (23505 = two clicks in flight). Logged, never swallowed — supabase-js RESOLVES a refused write.
          if (evErr && evErr.code !== "23505") console.error("[open-house/join] watch-link evidence not recorded:", evErr.message)
        }
      }
      const personal = ev.virtual_provider === "zoom" ? httpsOrNull(r.provider_join_url) : null
      if (personal) meetingUrl = personal
    }
    return NextResponse.redirect(meetingUrl, 302)
  }

  const invitationId = req.nextUrl.searchParams.get("i")
  if (invitationId && UUID_RE.test(invitationId)) {
    const { data: stamped, error: invErr } = await supabase
      .from("open_house_invitations")
      .update({ clicked_at: new Date().toISOString() })
      .eq("id", invitationId)
      .eq("event_id", ev.id)
      .eq("brokerage_id", ev.brokerage_id)
      .select("id, contact_id")
    // Non-fatal: the visitor still reaches the event. Logged, never swallowed.
    if (invErr) console.error("[open-house/join] invitation click not recorded:", invErr.message)
    const invited = Array.isArray(stamped) && stamped.length === 1
    // A Zoom event that registers attendees: register first (the consented form mints their own verifiable Zoom link).
    if (invited && ev.virtual_provider === "zoom" && (ev.provider_meta as { registration_enabled?: unknown } | null)?.registration_enabled === true && ev.is_published) {
      return NextResponse.redirect(new URL(`/open-house/${ev.id}/register`, req.nextUrl.origin), 302)
    }
  }

  return NextResponse.redirect(meetingUrl, 302)
}
