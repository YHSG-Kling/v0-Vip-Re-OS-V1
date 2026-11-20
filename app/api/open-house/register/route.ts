import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { decidePublicDoor, callerIpFrom } from "@/lib/security/public-rate-limit"
import { resolveCapturedLanguage } from "@/lib/contact-pipeline/contact-capture"
import { registerForEvent } from "@/lib/open-house/event-attendance"

/**
 * THE EVENT REGISTRATION DOOR (C22 — wave 148, lane 148H; owner rulings 12 + 14 + 20). Public, unauthenticated: the branded
 * registration page (app/open-house/[eventId]/register) posts here for every kind the registry routes to registration — virtual
 * open houses, webinars and education sessions.
 *
 *   · the tenant is the EVENT row's (a forged body names an event, never a brokerage); the event must be published (its
 *     AI-drafted page APPROVED by a permitted approver) and open;
 *   · the person is captured through THE consented-intake survivor (C8 captureConsentedContact via registerForEvent): identity,
 *     the situation they told us (intent, timeline bucket, working with an agent, their question), the consent boxes they ticked
 *     with the SERVER's wording + version, and the event's creating agent as the owner the person is assigned back to;
 *   · ONE registration per (event, person) — a second submit is the same registration (no second contact, no second email);
 *   · a Zoom event mints the person's own Zoom registrant (the key the participant webhook verifies attendance on).
 */
export async function POST(req: NextRequest) {
  const ip = callerIpFrom(req.headers)
  let body: Record<string, any>
  try { body = await req.json() } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }) }
  const eventId = String(body.eventId ?? "")
  const svc = createServiceClient()
  // WAVE 155 (lane 155R18 — G10, P0): the DECISION before any capture, consent row, contact or Zoom registrant — the per-IP cap
  // (unchanged: 30 per 10 minutes), then the TENANT'S OWN OPT-IN: an event its tenant PUBLISHED (registerForEvent re-reads the
  // same row and still refuses a cancelled / completed event with its own words).
  const door = await decidePublicDoor({
    surface: "open-house-register", callerKey: ip, cap: { limit: 30, windowMs: 10 * 60_000 },
    optIn: async () => {
      if (!eventId) return null
      const { data: ev, error } = await svc.from("open_house_events").select("id, brokerage_id, is_published").eq("id", eventId).maybeSingle()
      const e = ev as { brokerage_id: string | null; is_published: boolean | null } | null
      if (error || !e?.brokerage_id || e.is_published !== true) return null
      return { brokerageId: e.brokerage_id, basis: "open_house_events.is_published" }
    },
  })
  if (!door.allowed) {
    return door.reason === "rate_limited"
      ? NextResponse.json({ error: "Too many registrations from this connection — try again shortly." }, { status: 429, headers: { "Retry-After": String(door.retryAfterSeconds) } })
      : NextResponse.json({ error: "Registration for this event is not open yet" }, { status: 404 })
  }

  const result = await registerForEvent(createServiceClient(), {
    eventId,
    firstName: String(body.firstName ?? ""),
    lastName: String(body.lastName ?? ""),
    email: String(body.email ?? ""),
    phone: typeof body.phone === "string" ? body.phone : null,
    situation: (body.situation && typeof body.situation === "object") ? body.situation : null,
    // C15 (wave 148Z): the ONE consent component's submission, as posted — registerForEvent parses it strictly and re-renders
    // the words server-side (consentGrantsFromComponent); the booleans this route used to pick out are gone with their wording.
    consent: body.consent ?? null,
    consentCapturedAt: new Date().toISOString(),
    evidence: { ip: ip === "unknown" ? null : ip, userAgent: req.headers.get("user-agent"), sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl.slice(0, 500) : null },
    language: resolveCapturedLanguage(null, req.headers.get("accept-language")),
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  for (const w of result.warnings) console.warn(`[open-house/register] ${w}`)
  return NextResponse.json({ success: true, registered: true, alreadyRegistered: result.replay, joinPath: result.joinPath, personalZoomLink: result.zoomRegistered })
}
