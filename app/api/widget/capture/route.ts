// TRACK B: Widget chat lead capture → captureContact() → CONTACT (not lead)
//
// This route is called by the widget client after the user submits the
// capture form inside the chat widget. Widget submissions include implicit
// TCPA consent from the widget's built-in disclosure language.
//
// Result: a contact record assigned to the agent embedded in the widget,
// linked to the active chat session, with enrichment queued.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { captureContact } from '@/lib/contact-pipeline/contact-capture'
import { KernelEvent } from '@/lib/kernel/events'
import { persistContactConsent } from '@/lib/kernel/compliance/require-contact-consent'

export const dynamic = 'force-dynamic'

interface WidgetCaptureBody {
  brokerageSlug: string
  sessionToken: string
  name: string
  email?: string
  phone?: string
  /** Widgets always include TCPA consent in the UI; set this to true */
  tcpaConsent: boolean
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json()) as WidgetCaptureBody
    const { brokerageSlug, sessionToken, name, email, phone, tcpaConsent } = body

    if (!brokerageSlug || !sessionToken) {
      return NextResponse.json(
        { success: false, error: 'Missing brokerageSlug or sessionToken' },
        { status: 400 },
      )
    }

    if (!name?.trim()) {
      return NextResponse.json(
        { success: false, error: 'Name is required' },
        { status: 400 },
      )
    }

    const consentGiven = tcpaConsent === true
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
    const userAgent = req.headers.get('user-agent') ?? null
    const supabase = createServiceClient()

    // ── 1. Resolve brokerage from slug ─────────────────────────────────────
    const { data: brokerage, error: brokerageError } = await supabase
      .from('brokerages')
      .select('id')
      .eq('slug', brokerageSlug)
      .is('deleted_at', null)
      .maybeSingle()

    if (brokerageError || !brokerage) {
      return NextResponse.json(
        { success: false, error: 'Brokerage not found' },
        { status: 404 },
      )
    }

    // ── 2. Resolve chat session and agent ──────────────────────────────────
    // THE SESSION IS REQUIRED, not optional. It used to be read with `session?.`
    // throughout, so a POST carrying a real brokerage slug and a made-up token
    // still created a consented contact, a consent audit row and a lifecycle
    // event in that brokerage — the slug is public, so that was an open door
    // into any tenant's CRM. The token is opaque and server-issued, and it must
    // belong to THIS brokerage.
    const { data: session, error: sessionError } = await supabase
      .from('chat_sessions')
      .select('id, agent_id, brokerage_id')
      .eq('widget_session_token', sessionToken)
      .eq('brokerage_id', brokerage.id)
      .maybeSingle()

    if (sessionError) {
      console.error('[widget/capture] session lookup failed:', sessionError.message)
      return NextResponse.json(
        { success: false, error: 'Capture is temporarily unavailable' },
        { status: 503 },
      )
    }
    if (!session) {
      return NextResponse.json(
        { success: false, error: 'Invalid session' },
        { status: 403 },
      )
    }

    // chat_sessions.agent_id is agents.id (FK to agents). Pass through.
    const ownerAgentId = session.agent_id ?? null

    // ── 3. Parse name ──────────────────────────────────────────────────────
    const parts = name.trim().split(/\s+/)
    const first_name = parts[0] ?? null
    const last_name  = parts.slice(1).join(' ') || null

    // ── 4. captureContact (dedup → merge/create → enrich → score) ─────────
    const now = new Date().toISOString()
    const { contactId, action } = await captureContact({
      brokerageId:     brokerage.id,
      ownerAgentId,
      source:          'widget',
      first_name,
      last_name,
      email:           email?.trim() || null,
      // Only store phone when TCPA consent given
      phone:           consentGiven ? (phone?.trim() || null) : null,
      preferred_channel: consentGiven ? 'phone' : 'email',
      tcpa_consent:    consentGiven,
      tcpa_consent_date: consentGiven ? now : null,
      rawPayload: { brokerageSlug, sessionToken, name, email, phone },
    })

    // ── 5. Persist consent audit record ────────────────────────────────────
    if (consentGiven) {
      await persistContactConsent({
        brokerageId: brokerage.id,
        agentId: ownerAgentId,
        contactId,
        consentText: 'Widget chat consent — TCPA disclosure accepted in chat widget',
        consentSource: `/widget/${brokerageSlug}`,
        consented: true,
        ipAddress: ip,
        userAgent,
      }).catch(() => {})
    }

    // ── 6. Link chat session to contact ────────────────────────────────────
    await supabase
      .from('chat_sessions')
      .update({
        contact_id:    contactId,
        capture_state: 'captured',
        updated_at:    now,
      })
      .eq('id', session.id)

    // ── 7. Emit lifecycle event ────────────────────────────────────────────
    await supabase.from('lifecycle_events').insert({
      brokerage_id: brokerage.id,
      entity_type:  'contact',
      entity_id:    contactId,
      event_type:   KernelEvent.CONTACT_CAPTURED,
      metadata:     { source: 'widget', brokerageSlug, action },
    })

    return NextResponse.json({ success: true, contactId, action })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
