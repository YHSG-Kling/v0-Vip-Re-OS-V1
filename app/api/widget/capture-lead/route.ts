// POST /api/widget/capture-lead
// Called by the widget client when the visitor submits the capture form
// (name / email / phone / intent). Widget form fill = TCPA consent.
// Creates/merges a contact record (never a lead) and assigns agent from session
// or brokerage primary fallback. Updates chat_session.capture_state → 'captured'.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { captureContact } from '@/lib/contact-pipeline/contact-capture'
import { bestEffort } from "@/lib/db/best-effort"
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
    }: {
      session_token: string
      first_name?: string | null
      last_name?: string | null
      email?: string | null
      phone?: string | null
      intent_type?: 'buyer' | 'seller' | 'unknown'
      notes?: string | null
      tcpa_consent?: boolean
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
      agentUserId: session.agent_id ?? null,
      source: 'website_widget',
      first_name: first_name ?? null,
      last_name: last_name ?? null,
      email: email ?? null,
      phone: consentGiven ? (phone ?? null) : null,
      preferred_channel: consentGiven ? 'phone' : 'email',
      tcpa_consent: consentGiven,
      tcpa_consent_date: consentGiven ? consentNow : null,
      rawPayload: { session_token, intent_type, notes },
    })

    // ── Persist consent audit record (merged from /api/widget/capture) ────
    // The TCPA disclosure the widget shows is only worth what the ledger can
    // prove later; the wired door recorded the consented phone but never the
    // consent EVENT. Best-effort: the contact is already written above and a
    // refused audit row must not turn a captured lead into a visitor-facing 500.
    if (consentGiven) {
      const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
      const userAgent = req.headers.get('user-agent') ?? null
      await persistContactConsent({
        brokerageId: session.brokerage_id,
        agentId: session.agent_id ?? null,
        contactId,
        consentText: 'Widget chat consent — TCPA disclosure accepted in chat widget',
        consentSource: '/api/widget/capture-lead',
        consented: true,
        ipAddress: ip,
        userAgent,
      }).catch(() => {})
    }

    // ── Update session with contact_id and capture state ─────────────────
    await supabase
      .from('chat_sessions')
      .update({
        capture_state: 'captured',
        contact_id: contactId,
        updated_at: new Date().toISOString(),
      })
      .eq('id', session.id)

    // ── Emit lifecycle event (merged from /api/widget/capture) ────────────
    // The kernel's CONTACT_CAPTURED consumers (notification engine, timeline)
    // saw captures from every other intake but not from the wired widget door.
    await bestEffort(
      supabase.from('lifecycle_events').insert({
        brokerage_id: session.brokerage_id,
        entity_type: 'contact',
        entity_id: contactId,
        event_type: KernelEvent.CONTACT_CAPTURED,
        metadata: { source: 'website_widget', action },
      }),
      'the contact and its session link are already written; a lifecycle row must not turn a captured lead into a 500 the visitor sees',
    )

    // ── Log activity note if provided ─────────────────────────────────────
    if (notes) {
      await bestEffort(
        supabase.from('activities').insert({
          activity_type: 'widget_capture',
          contact_id: contactId,
          brokerage_id: session.brokerage_id,
          title: 'Widget lead capture',
          description: notes,
        }),
        "this is a PUBLIC widget endpoint and the contact plus the chat_sessions link are already written above; a note row must not turn a captured lead into a 500 the visitor sees",
      )
    }

    return NextResponse.json({ success: true, contact_id: contactId, action })
  } catch (err: any) {
    console.error('[Widget/capture-lead] Unhandled error:', err?.message)
    return NextResponse.json({ error: 'Server error' }, { status: 500 })
  }
}
