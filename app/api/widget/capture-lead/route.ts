// POST /api/widget/capture-lead
// Called by the widget client when the visitor submits the capture form
// (name / email / phone / intent). Widget form fill = TCPA consent.
// Creates/merges a contact record (never a lead) and assigns agent from session
// or brokerage primary fallback. Updates chat_session.capture_state → 'captured'.
//
// TOMBSTONE (lane 86C, orphan doctrine §1.1): /api/widget/capture — this route's public twin,
// kept for waves only because "an off-repo caller cannot be disproved" — is DELETED on the
// owner's ruling (2026-09-27: "this platform os has not yet been pushed in production", so no
// deployed integration can exist). Everything it had that this survivor lacked was merged here
// first: the consent audit row, the CONTACT_CAPTURED lifecycle event and the fail-closed
// session read (lane M3), and the agents-class owner below (86C). An OFF-SITE form — the
// capability an external twin would have served — is the 85E lead-magnet embed:
// lib/lead-magnets/embed-snippet.ts posting to app/api/lead-magnets/submissions/route.ts.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { captureContact, resolveCapturedLanguage } from '@/lib/contact-pipeline/contact-capture'
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { KernelEvent } from '@/lib/kernel/events'
import { persistContactConsent } from '@/lib/kernel/compliance/require-contact-consent'

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      session_token,
      first_name,
      last_name,
      email,
      phone,
      intent_type,
      notes,
      tcpa_consent,
      visitor_id,
    }: {
      session_token: string
      first_name?: string | null
      last_name?: string | null
      email?: string | null
      phone?: string | null
      intent_type?: 'buyer' | 'seller' | 'unknown'
      notes?: string | null
      tcpa_consent?: boolean
      /** The widget's tracking cookie (vip_visitor_id) — the behavioral signal /api/track/visitor
       *  opened for this visitor. With it, the consent artifact written below also lets the ONE
       *  capture door stamp the consented email onto that signal and fire the identify loop
       *  (wave 103, lane 103D; m706). Optional: an older embed sends none and loses nothing else. */
      visitor_id?: string | null
    } = body

    if (!session_token) {
      return NextResponse.json({ error: 'session_token required' }, { status: 400 })
    }

    if (!email && !phone) {
      return NextResponse.json({ error: 'email or phone required' }, { status: 422 })
    }

    const supabase = createServiceClient()

    // ── Validate session ──────────────────────────────────────────────────
    // MERGED FROM THE SIBLING DOOR (§1.1 — /api/widget/capture, the unaddressed
    // twin of this wired route): read the ERROR before reading the absence.
    // supabase-js RESOLVES a refused read (CLAUDE.md §3), so without this a DB
    // refusal was byte-identical to "made-up token" and answered 403 for what
    // is really an outage. The twin also carried the consent audit row and the
    // CONTACT_CAPTURED lifecycle event this route was missing — both merged
    // below, so the wired door is no longer the poorer of the two.
    const { data: session, error: sessionError } = await supabase
      .from('chat_sessions')
      .select('id, brokerage_id, agent_id, status')
      .eq('widget_session_token', session_token)
      .maybeSingle()

    if (sessionError) {
      console.error('[Widget/capture-lead] session lookup failed:', sessionError.message)
      return NextResponse.json(
        { error: 'Capture is temporarily unavailable' },
        { status: 503 },
      )
    }
    if (!session || session.status === 'closed') {
      return NextResponse.json({ error: 'Invalid or closed session' }, { status: 403 })
    }

    // ── captureContact — dedup → merge/create → enrich → score ───────────
    // Widget form fill constitutes TCPA consent.
    // agentUserId from session; captureContact will resolve brokerage primary if null.
    const consentGiven = tcpa_consent !== false // default true when not explicitly false
    const consentNow = new Date().toISOString()

    const { contactId, action } = await captureContact({
      brokerageId: session.brokerage_id,
      // chat_sessions.agent_id is an AGENTS id (FK agents(id), live). It was passed as the
      // deprecated `agentUserId` (users.id), which captureContact crosses via agents.user_id —
      // an agents id matched no row there, so every widget capture lost its agent and fell to
      // the brokerage primary. MERGED from the retired twin /api/widget/capture (lane 86C),
      // which alone passed it as `ownerAgentId`, the agents-class contract (CLAUDE.md §3).
      ownerAgentId: session.agent_id ?? null,
      source: 'website_widget',
      first_name: first_name ?? null,
      last_name: last_name ?? null,
      email: email ?? null,
      phone: consentGiven ? (phone ?? null) : null,
      preferred_channel: consentGiven ? 'phone' : 'email',
      tcpa_consent: consentGiven,
      tcpa_consent_date: consentGiven ? consentNow : null,
      rawPayload: { session_token, intent_type, notes },
      // TIER 3 OF resolveContactLanguage — THE ONE resolver (§6).
      language: resolveCapturedLanguage(null, req.headers.get('accept-language')),
    })

    // ── Persist consent audit record (merged from /api/widget/capture) ────
    // The TCPA disclosure the widget shows is only worth what the ledger can
    // prove later; the wired door recorded the consented phone but never the
    // consent EVENT. Best-effort: the contact is already written above and a
    // refused audit row must not turn a captured lead into a visitor-facing 500.
    if (consentGiven) {
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
      const userAgent = req.headers.get('user-agent') ?? null
      const consentWrite = await persistContactConsent({
        brokerageId: session.brokerage_id,
        agentId: session.agent_id ?? null,
        contactId,
        consentText: 'Widget chat consent — TCPA disclosure accepted in chat widget',
        consentSource: '/api/widget/capture-lead',
        consented: true,
        ipAddress: ip,
        userAgent,
      }).catch(() => null)

      // ── CONSENTED EMAIL CAPTURE on the visitor's behavioral signal (wave 103, lane 103D; m706) ──
      // The SAME door as the tracking pixel: trackBehavior (the behavioral_signals writer) takes the
      // artifact persistContactConsent just wrote — by id, read back in this tenant — and stores the
      // email on the visitor's signal, then the identify loop links the signal to the contact captured
      // above. No artifact (refused ledger write) or no visitor id → nothing is stored; the capture
      // itself is already done and is never gated on this.
      if (consentWrite?.consentEventId && email && typeof visitor_id === 'string' && visitor_id.trim()) {
        try {
          const { trackBehavior } = await import('@/app/actions/lead-intelligence')
          const tracked = await trackBehavior({
            visitor_id: visitor_id.trim(),
            page_visited: '/api/widget/capture-lead',
            time_spent: 0,
            action_taken: 'widget_capture_form',
            ip_address: ip ?? undefined,
            user_agent: userAgent ?? undefined,
            brokerage_id: session.brokerage_id,
            email_capture: { email, consent_event_id: consentWrite.consentEventId },
          })
          const ec = (tracked as { emailCapture?: { stored: boolean; reason?: string } }).emailCapture
          if (!tracked.success || (ec && !ec.stored)) console.warn(`[Widget/capture-lead] visitor email not stamped on the signal: ${(tracked as { error?: string }).error ?? ec?.reason ?? 'unknown'}`)
        } catch (e) {
          console.warn('[Widget/capture-lead] visitor signal capture threw (contact already captured):', e instanceof Error ? e.message : String(e))
        }
      }
    }

    // ── Update session with contact_id and capture state ─────────────────
    await sentinelWrite(supabase, supabase
      .from('chat_sessions')
      .update({
        capture_state: 'captured',
        contact_id: contactId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', session.id), { table: "chat_sessions", flow: "chat_sessions_write", reason: "session capture-state stamp; the contact is already captured" })

    // ── Emit lifecycle event (merged from /api/widget/capture) ────────────
    // The kernel's CONTACT_CAPTURED consumers (notification engine, timeline)
    // saw captures from every other intake but not from the wired widget door.
    await sentinelWrite(
      supabase,
      supabase.from('lifecycle_events').insert({
        brokerage_id: session.brokerage_id,
        entity_type: 'contact',
        entity_id: contactId,
        event_type: KernelEvent.CONTACT_CAPTURED,
        metadata: { source: 'website_widget', action },
      }),
      {
        table: 'lifecycle_events',
        flow: 'widget_capture_lifecycle_event',
        brokerageId: session.brokerage_id,
        reason:
          'the contact and its session link are already written; a lifecycle row must not turn a captured lead into a 500 the visitor sees',
      },
    )

    // ── Log activity note if provided ─────────────────────────────────────
    if (notes) {
      await sentinelWrite(
        supabase,
        supabase.from('activities').insert({
          activity_type: 'widget_capture',
          contact_id: contactId,
          brokerage_id: session.brokerage_id,
          title: 'Widget lead capture',
          description: notes,
        }),
        {
          table: 'activities',
          flow: 'widget_capture_note',
          brokerageId: session.brokerage_id,
          reason:
            "this is a PUBLIC widget endpoint and the contact plus the chat_sessions link are already written above; a note row must not turn a captured lead into a 500 the visitor sees",
        },
      )
    }

    return NextResponse.json({ success: true, contact_id: contactId, action })
  } catch (err: any) {
    console.error('[Widget/capture-lead] Unhandled error:', err?.message)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
