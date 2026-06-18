// POST /api/widget/intake
// Canonical contact-first intake route for consented widget and form submissions.
// Per spec: customer-facing consented submissions create/update CONTACTS (not leads).
// Flow: validate → dedup → create or update contact → assign agent →
//       enrichment queue → notify agent → emit lifecycle event → return.

import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'

function normalizePhone(raw: string | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/\D/g, '')
  return digits.length >= 10 ? digits : null
}

function normalizeEmail(raw: string | undefined): string | null {
  if (!raw) return null
  const trimmed = raw.trim().toLowerCase()
  return trimmed.includes('@') ? trimmed : null
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json()

    const {
      // Identity fields
      first_name,
      last_name,
      email: rawEmail,
      phone: rawPhone,
      message,
      // Attribution / routing
      agent_id,
      brokerage_id,
      session_token,
      source = 'widget',
      source_page_url,
      utm_source,
      utm_medium,
      utm_campaign,
      // Consent
      tcpa_consent,
      tcpa_consent_text,
      ip_address,
      user_agent,
    } = body

    if (!brokerage_id) {
      return NextResponse.json({ error: 'brokerage_id is required' }, { status: 400 })
    }
    if (!rawEmail && !rawPhone) {
      return NextResponse.json({ error: 'email or phone is required' }, { status: 400 })
    }

    const email = normalizeEmail(rawEmail)
    const phoneDigits = normalizePhone(rawPhone)
    const supabase = createServiceClient()

    // ── 1. DEDUP: check existing contact by email, then phone ────────────────
    let existingContact: any = null

    if (email) {
      const { data } = await supabase
        .from('contacts')
        .select('id, first_name, last_name, email, phone, phone_digits, agent_id, brokerage_id, tcpa_consent')
        .eq('brokerage_id', brokerage_id)
        .eq('email', email)
        .maybeSingle()
      existingContact = data
    }

    if (!existingContact && phoneDigits) {
      const { data } = await supabase
        .from('contacts')
        .select('id, first_name, last_name, email, phone, phone_digits, agent_id, brokerage_id, tcpa_consent')
        .eq('brokerage_id', brokerage_id)
        .eq('phone_digits', phoneDigits)
        .maybeSingle()
      existingContact = data
    }

    // ── 2. Resolve agent assignment ──────────────────────────────────────────
    // Use widget-provided agent_id first; fall back to brokerage routing
    let assignedAgentId: string | null = agent_id ?? null

    if (!assignedAgentId) {
      // Simple round-robin fallback: pick first active agent in brokerage.
      // contacts.agent_id is agents.id (per migration 111) — select id, NOT user_id,
      // or the contact is RLS-invisible to the agent and orphaned from their CRM.
      const { data: fallbackAgent } = await supabase
        .from('agents')
        .select('id')
        .eq('brokerage_id', brokerage_id)
        .eq('is_active', true)
        .limit(1)
        .maybeSingle()
      assignedAgentId = fallbackAgent?.id ?? null
    }

    let contactId: string
    let isNewContact = false

    // ── 3a. UPDATE existing contact ──────────────────────────────────────────
    if (existingContact) {
      contactId = existingContact.id

      const updatePayload: Record<string, any> = {
        updated_at: new Date().toISOString(),
        source_channel: 'widget',
        source_family: 'direct',
      }
      if (first_name && !existingContact.first_name) updatePayload.first_name = first_name
      if (last_name && !existingContact.last_name) updatePayload.last_name = last_name
      if (email && !existingContact.email) updatePayload.email = email
      if (phoneDigits && !existingContact.phone_digits) {
        updatePayload.phone = rawPhone
        updatePayload.phone_digits = phoneDigits
      }
      if (tcpa_consent && !existingContact.tcpa_consent) {
        updatePayload.tcpa_consent = true
        updatePayload.tcpa_consent_at = new Date().toISOString()
        updatePayload.tcpa_consent_text = tcpa_consent_text ?? null
        updatePayload.tcpa_consent_source = 'widget'
        updatePayload.tcpa_consent_ip = ip_address ?? null
      }

      await supabase
        .from('contacts')
        .update(updatePayload)
        .eq('id', contactId)

    } else {
      // ── 3b. CREATE new contact ───────────────────────────────────────────
      isNewContact = true

      const { data: newContact, error: insertError } = await supabase
        .from('contacts')
        .insert({
          brokerage_id,
          agent_id: assignedAgentId,
          first_name: first_name ?? null,
          last_name: last_name ?? null,
          email: email ?? null,
          phone: rawPhone ?? null,
          phone_digits: phoneDigits ?? null,
          source,
          source_channel: 'widget',
          source_family: 'direct',
          metadata: { source_page_url: source_page_url ?? null },
          notes: message ?? null,
          contact_type: 'prospect',
          tcpa_consent: !!tcpa_consent,
          tcpa_consent_at: tcpa_consent ? new Date().toISOString() : null,
          tcpa_consent_text: tcpa_consent_text ?? null,
          tcpa_consent_source: tcpa_consent ? 'widget' : null,
          tcpa_consent_ip: ip_address ?? null,
          status: 'active',
        })
        .select('id')
        .maybeSingle()

      if (insertError || !newContact) {
        console.error('[widget/intake] contact insert error:', insertError)
        return NextResponse.json({ error: 'Failed to create contact' }, { status: 500 })
      }

      contactId = newContact.id
    }

    // ── 4. Attach session to contact (if session_token provided) ────────────
    if (session_token) {
      await supabase
        .from('chat_sessions')
        .update({ contact_id: contactId, capture_state: 'captured', updated_at: new Date().toISOString() })
        .eq('widget_session_token', session_token)
    }

    // ── 5. Log consent event ─────────────────────────────────────────────────
    if (tcpa_consent) {
      await supabase.from('contact_consent_events').insert({
        contact_id: contactId,
        brokerage_id,
        agent_id: assignedAgentId,
        consent_type: 'tcpa',
        consented: true,
        consent_source: 'widget',
        consent_text: tcpa_consent_text ?? 'TCPA consent captured via website intake widget.',
        ip_address: ip_address ?? null,
        user_agent: user_agent ?? null,
      })
    }

    // ── 6. Create activity record for audit trail ────────────────────────────
    await supabase.from('activities').insert({
      brokerage_id,
      agent_id: assignedAgentId,
      contact_id: contactId,
      activity_type: 'widget_intake',
      title: isNewContact ? 'New contact via website widget' : 'Contact updated via website widget',
      notes: message ?? null,
      status: 'completed',
      completed_at: new Date().toISOString(),
    })

    // ── 7. Enrichment queue ──────────────────────────────────────────────────
    await supabase.from('lead_enrichment_queue').insert({
      contact_id: contactId,
      brokerage_id,
      status: 'pending',
      trigger_type: 'widget_intake',
      enrichment_type: 'skip_trace',
      enrichments_needed: ['email_verify', 'phone_verify', 'social_lookup'],
      retry_count: 0,
      max_retries: 3,
    })

    // ── 8. Notify assigned agent ─────────────────────────────────────────────
    if (assignedAgentId) {
      await supabase.from('notifications').insert({
        user_id: assignedAgentId,
        brokerage_id,
        type: 'new_widget_contact',
        title: isNewContact ? 'New contact from website widget' : 'Returning contact via widget',
        body: `${first_name ?? 'Someone'} ${last_name ?? ''} reached out via the website widget${message ? `: "${message.substring(0, 100)}"` : '.'}`,
        entity_type: 'contact',
        entity_id: contactId,
        priority: 'normal',
        channel: 'in_app',
      })
    }

    // ── 9. Emit lifecycle event ──────────────────────────────────────────────
    await supabase.from('lifecycle_events').insert({
      brokerage_id,
      event_type: isNewContact ? 'contact_created' : 'contact_updated',
      entity_type: 'contact',
      entity_id: contactId,
      actor_user_id: assignedAgentId,
      metadata: {
        source: 'widget_intake',
        is_new_contact: isNewContact,
        tcpa_consent: !!tcpa_consent,
        utm_source: utm_source ?? null,
        utm_medium: utm_medium ?? null,
        utm_campaign: utm_campaign ?? null,
      },
    })

    return NextResponse.json({
      success: true,
      contact_id: contactId,
      is_new_contact: isNewContact,
      message: isNewContact
        ? 'Thank you! Your information has been received and a team member will be in touch shortly.'
        : 'Welcome back! Your information has been updated and a team member will follow up.',
    })

  } catch (err) {
    console.error('[widget/intake] Unexpected error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
