// POST /api/widget/intake
// Canonical contact-first intake route for consented widget and form submissions.
// Per spec: customer-facing consented submissions create/update CONTACTS (not leads).
// Flow: validate → dedup → create or update contact → assign agent →
//       enrichment queue → notify agent → emit lifecycle event → return.
//
// THE TENANT COMES FROM THE SESSION, NOT THE BODY. This route is public and it
// used to take `brokerage_id` and `agent_id` straight off the POST, which meant
// anyone could write a consented contact — with a TCPA consent record, an
// enrichment queue row that spends money, and a notification — into ANY
// brokerage, attributed to ANY agent. Both now come off the chat_sessions row
// the `session_token` identifies; that token is opaque and was issued by
// /api/widget/session against a slug-resolved tenant, so there is no
// caller-supplied identity left to trust.

import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
import { queueContactEnrichment } from '@/lib/enrichment/contact-enrichment-core'
// The ONE way a notifications row gets its recipient and tenant — agents.id is
// RESOLVED to users.id, never substituted into it.
import { resolveAgentRecipient } from '@/lib/notifications/recipient-tenant'

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
      // Attribution / routing — the widget session is the ONLY thing that
      // says which tenant (and which agent) this submission belongs to.
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

    if (!session_token) {
      return NextResponse.json({ error: 'session_token is required' }, { status: 400 })
    }
    if (!rawEmail && !rawPhone) {
      return NextResponse.json({ error: 'email or phone is required' }, { status: 400 })
    }

    const email = normalizeEmail(rawEmail)
    const phoneDigits = normalizePhone(rawPhone)
    const supabase = createServiceClient()

    // ── 0. Resolve the tenant from the session token ─────────────────────────
    // Destructured error, not a bare `!session`: supabase-js reports a failed
    // read as an empty result, and answering a database outage with "invalid
    // session" would tell a real visitor their form was rejected.
    const { data: session, error: sessionError } = await supabase
      .from('chat_sessions')
      .select('id, brokerage_id, agent_id, status')
      .eq('widget_session_token', session_token)
      .maybeSingle()

    if (sessionError) {
      console.error('[widget/intake] session lookup failed:', sessionError.message)
      return NextResponse.json({ error: 'Intake is temporarily unavailable.' }, { status: 503 })
    }
    if (!session || !session.brokerage_id || session.status === 'closed') {
      return NextResponse.json({ error: 'Invalid or closed session' }, { status: 403 })
    }

    const brokerage_id: string = session.brokerage_id
    const agent_id: string | null = session.agent_id ?? null

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
    // Use the session's agent_id first; fall back to brokerage routing
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

      // FAIL CLOSED (CLAUDE.md §4). `updatePayload` CARRIES TCPA CONSENT — the
      // block above stamps tcpa_consent/at/text/source/ip when the visitor ticks
      // the box on a contact that had not consented before. supabase-js RESOLVES
      // a refused UPDATE, so this returned 200 with the consent event logged at
      // step 5 while the contact row still said `tcpa_consent = false`: an audit
      // trail asserting a consent the gate would never see. The CREATE branch
      // below already refuses on `insertError`; this branch now answers the same.
      const { error: updateError } = await supabase
        .from('contacts')
        .update(updatePayload)
        .eq('id', contactId)
      if (updateError) {
        console.error('[widget/intake] contact update error:', updateError)
        return NextResponse.json({ error: 'Failed to update contact' }, { status: 500 })
      }

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

    // ── 4. Attach session to contact ────────────────────────────────────────
    // Keyed on the row already resolved above rather than re-matching the token.
    await supabase
      .from('chat_sessions')
      .update({ contact_id: contactId, capture_state: 'captured', updated_at: new Date().toISOString() })
      .eq('id', session.id)

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
    // A PUBLIC endpoint's record of an inbound consumer submission — this is
    // the row that says the person made contact and when.
    const { error: intakeActivityError } = await supabase.from('activities').insert({
      brokerage_id,
      agent_id: assignedAgentId,
      contact_id: contactId,
      activity_type: 'widget_intake',
      title: isNewContact ? 'New contact via website widget' : 'Contact updated via website widget',
      notes: message ?? null,
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    if (intakeActivityError) {
      console.error('[Widget/intake] widget_intake activity REJECTED — the contact exists but the inbound submission has no record:', intakeActivityError.message)
    }

    // ── 7. Enrichment queue ──────────────────────────────────────────────────
    // This route is PUBLIC (a website widget posts to it), and it used to write
    // the queue row inline with no guards at all: no freshness check and no
    // already-pending check, so a visitor who submitted the form five times
    // queued five paid enrichments of the same person. It also could not observe
    // the owner's rule that a contact in a live listing or transaction is not
    // enriched.
    //
    // Delegated to the single writer, which carries all three
    // (lib/enrichment/contact-enrichment-core.ts:queueContactEnrichment).
    // `enrichments_needed` is derived there from which identifiers the contact is
    // actually missing rather than being a fixed list.
    await queueContactEnrichment({
      contactId,
      brokerageId: brokerage_id,
      triggerType: 'widget_intake',
      supabase,
    })

    // ── 8. Notify assigned agent ─────────────────────────────────────────────
    // `assignedAgentId` is an `agents.id` — that is what `contacts.agent_id`,
    // `activities.agent_id` and `contact_consent_events.agent_id` all take, and
    // the fallback branch above selects `agents.id` explicitly. But
    // `notifications.user_id` is `REFERENCES users(id)`: DISJOINT spaces, so the
    // id was RESOLVED across rather than reused, and the insert now destructures
    // its error. Before this, every widget-intake notification was refused 23503
    // and the refusal was discarded, so the assigned agent has never once been
    // told a website lead came in.
    //
    // The tenant was already correct here (`brokerage_id` shorthand, at depth 1)
    // and is left as the route resolved it: the recipient is an agent OF THIS
    // BROKERAGE by construction — the fallback selects `.eq('brokerage_id',
    // brokerage_id)` — so the recipient's `users.brokerage_id` IS `brokerage_id`
    // and no second read is needed. That is the one resolver's stated no-op case,
    // not a second resolver.
    const widgetRecipient = await resolveAgentRecipient(supabase, assignedAgentId)
    if (!widgetRecipient.ok) {
      console.error(`[widget/intake] ${widgetRecipient.reason} — agent notification NOT written`)
    } else if (assignedAgentId && !widgetRecipient.userId) {
      console.error(
        `[widget/intake] agent ${assignedAgentId} has no user account — agent notification NOT written rather than written with an agents.id in a users FK`,
      )
    } else if (widgetRecipient.userId) {
      const { error: widgetNotifyError } = await supabase.from('notifications').insert({
        user_id: widgetRecipient.userId,
        brokerage_id,
        type: 'new_widget_contact',
        title: isNewContact ? 'New contact from website widget' : 'Returning contact via widget',
        body: `${first_name ?? 'Someone'} ${last_name ?? ''} reached out via the website widget${message ? `: "${message.substring(0, 100)}"` : '.'}`,
        entity_type: 'contact',
        entity_id: contactId,
        priority: 'medium', // CHECK vocabulary (pass 9): 'normal' was silently rejected
        channel: 'in_app',
      })
      if (widgetNotifyError) {
        console.error('[widget/intake] agent notification insert refused:', widgetNotifyError.message)
      }
    }

    // ── 9. Emit lifecycle event ──────────────────────────────────────────────
    // OBSERVED, NOT FIXED HERE: `actor_user_id` is also handed an `agents.id`.
    // `lifecycle_events` is a different table with its own readers and belongs
    // to a different census than this wave's two; it is named rather than
    // silently changed.
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
