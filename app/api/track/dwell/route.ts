// POST /api/track/dwell
// Body: { sessionId, pageUrl, seconds }
// RULE: dwell measurement only. No contact creation, no identification, no new
// rows — this can only stamp a duration onto a session the pixel already made.
//
// ─── THE WRITER time_on_page_seconds NEVER HAD ───────────────────────────────
//
// BUILT, not tidied (§1 case 2). `website_visitors.time_on_page_seconds` had a
// shipped reader — the principal digest's site-traffic insight
// (lib/kernel/site-traffic-insights.ts), which buckets pages by average dwell
// and deliberately fails closed on the absent value — and ZERO writers: the
// pixel (app/api/track/pixel/route.ts) upserts the visit without it. So the
// "stickiest page" verdict was structurally silent for every brokerage. No
// duplicate dwell recorder exists anywhere in the tree, so the missing half is
// built: the installer snippet (app/dashboard/admin/visitor-tracking/page.tsx)
// now starts a timer at load and posts {sessionId, pageUrl, seconds} from a
// `pagehide` listener. The reader turns on with no change.
//
// Modeled line-for-line on app/api/track/identify/route.ts, whose header
// carries the three hardening findings this route inherits:
//   · TENANT FROM THE ROW, NEVER THE BODY (§4) — the update is keyed on
//     session_id alone, which is UNIQUE on website_visitors
//     (uq_website_visitors_session); the row it lands on is the only tenant
//     this unauthenticated call can ever touch, and no brokerage field is
//     accepted at all.
//   · NO FILTER GRAMMAR — every predicate is a plain .eq(); the inputs are
//     format-validated before they are used.
//   · CONSTANT OPAQUE RESPONSE — the beacon ignores the body, and a variable
//     answer would be an enumeration oracle for session ids; detail goes to
//     the server log.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

export const dynamic = 'force-dynamic'

type DwellBody = {
  sessionId: string
  pageUrl?: string | null
  seconds?: number | null
}

/** A constant answer — nothing reads this body, and a variable one enumerates. */
const OPAQUE_OK = { ok: true } as const

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: DwellBody

  try {
    // sendBeacon posts text/plain; Request.json() parses the body regardless of
    // content-type, which is what keeps the call a CORS "simple request" and so
    // preflight-free from the installer's own domain.
    body = (await req.json()) as DwellBody
  } catch {
    return NextResponse.json(OPAQUE_OK)
  }

  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  if (!sessionId || sessionId.length > 128) return NextResponse.json(OPAQUE_OK)

  // Integer 1..7200 (2h), mirroring the snippet's own guard: a sub-second blip
  // is noise, and anything past two hours is a tab someone forgot, not dwell.
  const seconds = body?.seconds
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds < 1 || seconds > 7200) {
    return NextResponse.json(OPAQUE_OK)
  }

  const pageUrl = typeof body?.pageUrl === 'string' ? body.pageUrl.trim() : ''
  if (!pageUrl || pageUrl.length > 2048) return NextResponse.json(OPAQUE_OK)

  const supabase = createServiceClient()

  // page_url is written ALONGSIDE the seconds, on purpose: the digest reader
  // (lib/kernel/site-traffic-insights.ts) buckets on the (page_url,
  // time_on_page_seconds) PAIR from this same row. The pixel stamps page_url at
  // arrival; if the visitor navigated within the site before leaving, a
  // seconds-only write would attribute this dwell to a page the visitor was no
  // longer on. Last-page-wins keeps the pair from ever disagreeing — one row is
  // one session, and its dwell belongs to the page it was measured on.
  //
  // `.select('id')` and COUNT the write (§3): an UPDATE that matches nothing
  // resolves with error null and an empty array — byte-identical to one that
  // worked — so a dwell for a session the pixel never recorded (or a purged
  // row) would silently vanish and the digest would stay blind with nothing
  // anywhere saying why.
  const { data: stamped, error: updateError } = await supabase
    .from('website_visitors')
    .update({
      page_url: pageUrl,
      time_on_page_seconds: seconds,
      last_seen_at: new Date().toISOString(),
    })
    .eq('session_id', sessionId)
    .select('id')

  if (updateError) {
    console.error('[track/dwell] dwell update refused:', updateError.message)
    return NextResponse.json(OPAQUE_OK)
  }
  if (!stamped || stamped.length === 0) {
    console.error('[track/dwell] dwell update matched 0 rows for session', sessionId)
    return NextResponse.json(OPAQUE_OK)
  }

  return NextResponse.json(OPAQUE_OK)
}
