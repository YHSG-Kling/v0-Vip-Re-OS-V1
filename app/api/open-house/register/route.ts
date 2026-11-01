import { NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import { checkPublicRateLimit } from "@/lib/security/public-rate-limit"
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
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown"
  const rate = checkPublicRateLimit("open-house-register", ip, { limit: 30, windowMs: 10 * 60_000 })
  if (!rate.allowed) {
    return NextResponse.json({ error: "Too many registrations from this connection — try again shortly." }, { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } })
  }
  let body: Record<string, any>
  try { body = await req.json() } catch { return NextResponse.json({ error: "Invalid request" }, { status: 400 }) }

  const result = await registerForEvent(createServiceClient(), {
    eventId: String(body.eventId ?? ""),
    firstName: String(body.firstName ?? ""),
    lastName: String(body.lastName ?? ""),
    email: String(body.email ?? ""),
    phone: typeof body.phone === "string" ? body.phone : null,
    situation: (body.situation && typeof body.situation === "object") ? body.situation : null,
    consent: {
      serviceDelivery: body.consent?.serviceDelivery === true,
      textReminders: body.consent?.textReminders === true,
      marketing: body.consent?.marketing === true,
      capturedAt: new Date().toISOString(),
    },
    evidence: { ip: ip === "unknown" ? null : ip, userAgent: req.headers.get("user-agent"), sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl.slice(0, 500) : null },
    language: resolveCapturedLanguage(null, req.headers.get("accept-language")),
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  for (const w of result.warnings) console.warn(`[open-house/register] ${w}`)
  return NextResponse.json({ success: true, registered: true, alreadyRegistered: result.replay, joinPath: result.joinPath, personalZoomLink: result.zoomRegistered })
}
