// POST /api/track/identify
// Body: { sessionId, email?, phone? }
// RULE: No contact creation here. Only links an EXISTING lead/contact to a session.
//
// ─── THE CALLER THIS ROUTE NEVER HAD ─────────────────────────────────────────
//
// BUILT, not tidied. `website_visitors.identified_at` had exactly one writer —
// this route — and this route had ZERO callers: no fetch, no template literal,
// no cron registry line, no config entry, and no database caller (checked live
// on `hrvaqgvukzxfskkcrwbt`: zero edge functions, zero pg_proc bodies naming an
// `/api/` path). Meanwhile the READER was already shipped and prominent:
// app/dashboard/admin/visitor-tracking/page.tsx renders `identified_at` three
// times — the "Identified" stat tile, the per-row Identified/Anonymous badge,
// and the Identified-at column — under page copy that promises "identification
// only occurs when a visitor is matched to an existing lead or contact".
//
// So the Identified tile was structurally 0 for every brokerage, forever, and
// nothing about the surface said so. No duplicate identifier exists anywhere in
// the tree, so §1's answer is the second one: BUILD the missing half. The
// caller now lives in the installer snippet that already carries the session id
// — app/dashboard/admin/visitor-tracking/page.tsx, the `snippet` template —
// which fires this endpoint when a visitor submits a form carrying an email or
// phone the brokerage already holds.
//
// AND THE GATE THAT MADE ALL OF IT MOOT. `/api/track` sat in PROTECTED_ROUTES
// (app/constants/auth.ts), under the heading "API routes requiring session
// auth", so proxy.ts:158 prefix-matched it and redirected EVERY anonymous hit
// to /login — this route AND the pixel beside it. A 307 to a login page is
// invisible from both ends: the <img> simply never loads and a beacon is
// discarded without a word. That is why the EARLIER fix did not take — a
// previous wave found the snippet pointing at a relative `/api/track/pixel`,
// resolving against the installer's own domain, and made it absolute; the
// absolute URL then landed on this gate. `website_visitors` holds 0 rows to
// this day. The prefix is now PUBLIC, which widens nothing real: neither of
// these two routes reads a session, and an authenticated caller was never
// possible here.
//
// THREE THINGS WERE HARDENED IN THE SAME PASS, because a caller that did not
// exist could not have exposed any of them:
//
//   1. THE TENANT NO LONGER COMES FROM THE BODY (§4). This is an unauthenticated
//      endpoint on the SERVICE client, and it took `brokerageId` as a request
//      field — the exact IDOR shape this repo keeps finding. `session_id` is
//      UNIQUE on website_visitors (`uq_website_visitors_session`, read live), so
//      the session row itself names the only tenant this call may touch. The
//      body field is gone; the row is the authority.
//
//   2. NO MORE POSTGREST FILTER INJECTION. The matcher built `.or()` grammar by
//      string concatenation — `email.eq.${email}` — from an unauthenticated
//      body. A value containing a comma or a dot rewrites the filter list, on a
//      service client, against contacts and leads. Both lookups are now plain
//      `.eq()` predicates with no grammar to escape, and the inputs are
//      format-validated before they are used at all.
//
//   3. THE RESPONSE IS NO LONGER AN ENUMERATION ORACLE. It used to answer
//      `no_match` vs `already_identified` vs `session_not_found`, which told an
//      anonymous caller whether a given email is in a given brokerage's contact
//      list. The beacon that calls this ignores the body entirely, so the answer
//      is now a constant and the detail goes to the server log instead.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { decidePublicDoor, callerIpFrom } from '@/lib/security/public-rate-limit'
import { processKernelEvent } from '@/lib/kernel'
import { KernelEvent } from '@/lib/kernel/events'

export const dynamic = 'force-dynamic'

type IdentifyBody = {
  sessionId: string
  email?: string | null
  phone?: string | null
}

/** A constant answer. See note 3 above — nothing reads this body. */
const OPAQUE_OK = { ok: true } as const

/**
 * Accept only a shape that cannot carry PostgREST filter grammar. `,` `.` `(`
 * `)` and whitespace are the separators `.or()` parses, and a plain `.eq()` is
 * used regardless — this is belt-and-braces, and it also stops a junk value
 * costing a round trip.
 */
function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toLowerCase()
  if (v.length < 5 || v.length > 254) return null
  if (!/^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(v)) return null
  return v
}

/** Digits only, and only if the count is plausibly a phone number. */
function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const digits = raw.replace(/\D+/g, '')
  if (digits.length < 10 || digits.length > 15) return null
  return digits
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: IdentifyBody

  try {
    // sendBeacon posts text/plain; Request.json() parses the body regardless of
    // content-type, which is what keeps the call a CORS "simple request" and so
    // preflight-free from the installer's own domain.
    body = (await req.json()) as IdentifyBody
  } catch {
    return NextResponse.json(OPAQUE_OK)
  }

  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  const email = normalizeEmail(body?.email)
  const phone = normalizePhone(body?.phone)

  if (!sessionId || sessionId.length > 128) return NextResponse.json(OPAQUE_OK)
  if (!email && !phone) return NextResponse.json(OPAQUE_OK)

  const supabase = createServiceClient()

  // ── The session row is the tenant ───────────────────────────────────────────
  // session_id is UNIQUE, so this is single-valued by construction. `error` is
  // destructured because supabase-js RESOLVES a refusal: without it a refused
  // read arrives as data:null and reads exactly like "no such session".
  //
  // WAVE 155 (lane 155R18 — G10): that read is now the DECISION's opt-in read, made BEFORE any match or stamp — the
  // PUBLIC-WRITE THROTTLE first (lane 138F readiness audit, P1: unchanged at 60 per minute per IP; over the ceiling the answer
  // stays the constant OPAQUE_OK, note 3 — a throttle must not become the oracle this route refuses to be), then the TENANT'S
  // OWN OPT-IN: the visitor row the tenant's own installed pixel minted.
  type VisitorRow = { id: string; brokerage_id: string | null; lead_id: string | null; contact_id: string | null }
  const seen: { visitor: VisitorRow | null; error: string | null } = { visitor: null, error: null }
  const door = await decidePublicDoor({
    surface: 'track-identify', callerKey: callerIpFrom(req.headers), cap: { limit: 60, windowMs: 60_000 },
    optIn: async () => {
      const { data, error } = await supabase
        .from('website_visitors')
        .select('id, brokerage_id, lead_id, contact_id')
        .eq('session_id', sessionId)
        .maybeSingle()
      if (error) { seen.error = error.message; return null }
      seen.visitor = (data as VisitorRow | null) ?? null
      return seen.visitor?.brokerage_id ? { brokerageId: seen.visitor.brokerage_id, basis: "website_visitors row minted by the tenant's installed pixel" } : null
    },
  })
  const visitor = seen.visitor
  if (!door.allowed) {
    if (seen.error) console.error('[track/identify] visitor lookup refused:', seen.error)
    return NextResponse.json(OPAQUE_OK)
  }
  if (!visitor?.brokerage_id) return NextResponse.json(OPAQUE_OK)
  // Already linked — nothing to do, and re-stamping would move identified_at.
  if (visitor.contact_id || visitor.lead_id) return NextResponse.json(OPAQUE_OK)

  const brokerageId = visitor.brokerage_id as string

  // ── Step 1: contacts, then Step 2: active leads ─────────────────────────────
  // One `.eq()` per identifier rather than one `.or()` string — see note 2.
  //
  // WAVE 156 (lane 156F) — A LOW-CONFIDENCE MATCH IS SUPPRESSED, NEVER GUESSED. This read `.limit(1).maybeSingle()`
  // and took whichever row came first: a household phone or a shared family inbox held by TWO contacts linked the
  // session to an arbitrary one of them, and a form that carried one person's email and ANOTHER person's phone (a
  // "send to a friend" form, a co-buyer field) linked it to whichever identifier was read first. That is a guessed
  // identity. The rule is now decideVisitorLink (lib/lead-intelligence/visitor-link-decision.ts): every identifier
  // the visitor typed must resolve to exactly ONE row, and all of them to the SAME row — or nothing is linked. A
  // refused read is not "no match", it is "cannot decide": nothing is linked (fail closed).
  const { decideVisitorLink } = await import('@/lib/lead-intelligence/visitor-link-decision')
  let suppressed = false
  async function matchIn(table: 'contacts' | 'leads'): Promise<string | null> {
    if (suppressed) return null
    const found: Array<{ ids: string[]; refused: boolean }> = []
    for (const [column, value] of [['email', email], ['phone', phone]] as const) {
      if (!value) continue
      let q = supabase.from(table).select('id').eq('brokerage_id', brokerageId).eq(column, value)
      if (table === 'leads') q = q.eq('is_active', true)
      const { data, error } = await q.limit(2)
      if (error) console.error(`[track/identify] ${table}.${column} lookup refused:`, error.message)
      found.push({ ids: ((data ?? []) as Array<{ id: string }>).map((r) => r.id), refused: !!error })
    }
    const verdict = decideVisitorLink(found)
    // An uncertain contact match does not fall through to the leads table — that would be a second guess.
    if (!verdict.link && verdict.reason !== 'no_match') { suppressed = true; console.warn(`[track/identify] ${table} match suppressed:`, verdict.reason) }
    return verdict.link ? verdict.id : null
  }

  const contactId = await matchIn('contacts')
  const leadId = contactId ? null : await matchIn('leads')

  if (!contactId && !leadId) return NextResponse.json(OPAQUE_OK)

  // ── Step 3: stamp the visitor row ───────────────────────────────────────────
  // `.select()` the update and COUNT it. An UPDATE that matches nothing resolves
  // with error null and an empty array — byte-identical to one that worked — so
  // reading the error alone would let a silently unmatched write report success,
  // and the Identified tile this whole path exists to fill would stay at zero
  // with nothing anywhere saying why.
  //
  // WRITTEN AS A LITERAL, ON PURPOSE. This was a `Record<string, string>` built
  // by bracket assignment — `updatePayload['contact_id'] = contactId` — which is
  // an OPAQUE write object: no static reader (the opposite-missing census
  // included) can see which columns it names, so both `contact_id` and
  // `lead_id` were reported as "read by code, written by NOBODY" while this
  // very line wrote them. A finding list that accuses live code teaches its
  // readers to stop reading it (CLAUDE.md §2), so the write now says what it
  // writes. Behaviour is unchanged: exactly one of the two is non-null on this
  // path (`leadId` is computed as null whenever a contact matched), and the
  // other is already null on the row — the guard above returns early when
  // either is set, so this never clears an existing link.
  //
  // WAVE 155 (lane 155R21, LAW 5): ONE receipt per identification. The tenant is the one the door PROVED (the visitor row's
  // brokerage — never the body); the actor is not a user (an anonymous visitor's beacon) so it is `system`; the subject is the
  // visitor row. The receipt names only WHICH kind matched — never the Lead's id (Leads belong to the tenant; CLAUDE.md §5).
  // No key: the early return above (already linked) is this act's own at-most-once. A refusing ledger changes nothing.
  const { withActionLedger } = await import('@/lib/kernel/action-ledger')
  type Stamp = { stamped: true } | { stamped: false; why: string }
  const stamp = await withActionLedger<Stamp>({
    brokerageId: door.brokerageId ?? brokerageId, action: 'marketing.website_visitor.identify', actor: { type: 'system', userId: null },
    subject: { type: 'website_visitor', id: visitor.id }, riskClass: 'LOW_RISK_WRITE', reasonCode: 'CONVERSATION_RESPONSE',
    channel: 'web', systemSource: 'website_pixel', detail: { matched: contactId ? 'contact' : 'lead', door: door.basis },
  }, async (): Promise<Stamp> => {
  const { data: stamped, error: updateError } = await supabase
    .from('website_visitors')
    .update({
      identified_at: new Date().toISOString(),
      contact_id: contactId,
      lead_id: leadId,
    })
    .eq('id', visitor.id)
    .select('id')

  if (updateError) {
    console.error('[track/identify] identify update refused:', updateError.message)
    return { stamped: false, why: 'update_refused' }
  }
  if (!stamped || stamped.length === 0) {
    console.error('[track/identify] identify update matched 0 rows for visitor', visitor.id)
    return { stamped: false, why: 'matched_zero_rows' }
  }
  return { stamped: true }
  }, {
    settle: (r) => r.stamped ? { status: 'executed', outcome: 'identified' } : { status: 'failed', outcome: r.why },
    replay: (claim) => ({ stamped: false, why: claim.kind === 'refused' ? 'ledger_refused' : 'already_recorded' }),
  })
  if (!stamp.stamped) return NextResponse.json(OPAQUE_OK)

  // ── Step 4: lifecycle event ─────────────────────────────────────────────────
  try {
    await processKernelEvent({
      brokerageId,
      entityType: contactId ? 'contact' : 'lead',
      entityId: (contactId ?? leadId) as string,
      event: KernelEvent.WEBSITE_VISITOR_IDENTIFIED,
    })
  } catch (err) {
    // Non-fatal: identification is already recorded.
    console.error('[track/identify] kernel event failed:', err)
  }

  return NextResponse.json(OPAQUE_OK)
}
