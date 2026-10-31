// POST /api/widget/intake
// The /widget/chat intake form's door (app/widget/chat/widget-chat-client.tsx). Per owner ruling 1 a consented submission is a
// CONTACT, never a lead. Flow (wave 147, lane 147Z): validate → the session's tenant → C8 captureConsentedContact (dedupe →
// contact upsert → consent record → enrichment → welcome → the AI ISA desk) → session attach → activity → agent bell →
// lifecycle row → return.
//
// THE TENANT COMES FROM THE SESSION, NOT THE BODY. This route is public and it
// used to take `brokerage_id` and `agent_id` straight off the POST, which meant
// anyone could write a consented contact — with a TCPA consent record, an
// enrichment queue row that spends money, and a notification — into ANY
// brokerage, attributed to ANY agent. Both now come off the chat_sessions row
// the `session_token` identifies; that token is opaque and was issued by
// /api/widget/session against a slug-resolved tenant, so there is no
// caller-supplied identity left to trust.

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { createServiceClient } from '@/lib/supabase/service'
import { NextRequest, NextResponse } from 'next/server'
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

// The consent wording the visitor SAW under the intake form (app/widget/chat/widget-chat-client.tsx), verbatim — the C8 record
// hashes it. A change to the label is a new version here.
const WIDGET_INTAKE_CONSENT_TEXT = 'By submitting, you agree to be contacted by a real estate professional via phone, email, or text. Standard messaging rates may apply.'
const WIDGET_INTAKE_CONSENT_VERSION = 'widget_chat_intake:v1'

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

    // ── 1–3. THE CONSENTED SUBMISSION → CONTACT (contract C8 — wave 147, lane 147Z; owner ruling 1) ──────────────────
    // TOMBSTONE (orphan doctrine §1.1 — lane 147A "Still open" 1: this route was "the clearest twin"): the dedup (email, then
    // phone_digits), the round-robin agent fallback, the contact create / fill-if-empty update with its own tcpa_* stamp, the
    // route's own contact_consent_events insert and its own enrichment-queue call that stood here were a SECOND upsert of a
    // consented person. They are merged onto THE ONE survivor — lib/contact-pipeline/contact-capture.ts:818
    // captureConsentedContact → captureContact (fuzzy dedupe, the assignment precedence, the welcome, the enrichment queue
    // under its budget gates, person identity) → completeConsentedIntake (the consent record with the wording hash + version,
    // purposes and channels through THE one consent writer; any same-person open lead closed onto the contact; the kernel event;
    // the AI ISA desk told). Kept here, door-specific: the session attach, the activity row, the agent bell, the utm lifecycle
    // row. Semantics preserved: the session's agent owns a new contact (ownerAgentId — the C8 owner hint), source
    // 'website_widget', the visitor's message as notes, the consent IP / user agent as evidence.
    // THE WORDING IS THE DOOR'S, never the body's: the visitor saw WIDGET_INTAKE_CONSENT_TEXT under the form
    // (app/widget/chat/widget-chat-client.tsx — "By submitting, you agree …"); a body-supplied text is ignored (a forged text
    // would put words in a person's mouth). Submitting IS the act of consent on this form (no checkbox), so `tcpa_consent`
    // from the client is read as the submit; an email / phone the visitor did not give grants nothing for that family.
    const consentGiven = tcpa_consent === true
    void tcpa_consent_text // the client's copy of the wording is not trusted (above)
    const { captureConsentedContact } = await import('@/lib/contact-pipeline/contact-capture')
    const intake = await captureConsentedContact({
      brokerageId: brokerage_id,
      ownerAgentId: agent_id,
      source: source || 'website_widget',
      first_name: first_name ?? null,
      last_name: last_name ?? null,
      email,
      phone: phoneDigits ? rawPhone : null,
      notes: message ?? null,
      preferred_channel: consentGiven && phoneDigits ? 'phone' : 'email',
      rawPayload: { session_token, source_page_url: source_page_url ?? null, utm_source: utm_source ?? null, utm_medium: utm_medium ?? null, utm_campaign: utm_campaign ?? null },
      consents: [
        { family: 'phone', given: consentGiven && !!phoneDigits, text: WIDGET_INTAKE_CONSENT_TEXT, textVersion: WIDGET_INTAKE_CONSENT_VERSION },
        { family: 'email', given: consentGiven && !!email, text: WIDGET_INTAKE_CONSENT_TEXT, textVersion: WIDGET_INTAKE_CONSENT_VERSION },
      ],
      intake: {
        channel: 'chat_widget', sourceUrl: source_page_url ?? '/api/widget/intake',
        evidence: { chat_session_id: session.id, ip: ip_address ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null, user_agent: user_agent ?? req.headers.get('user-agent') ?? null, door: 'widget_intake' },
        formOwner: { table: 'chat_sessions', id: session.id },
      },
    })
    if (!intake.ok || !intake.contactId) {
      // A fragment (no name, or no email / phone) is not a contact — it keeps the raw-lead gates (said, never silently created).
      return NextResponse.json({ error: intake.reason ?? 'Failed to capture contact' }, { status: intake.refused === 'not_identifiable' ? 400 : intake.refused === 'cross_tenant_form' ? 403 : 500 })
    }
    const contactId: string = intake.contactId
    const isNewContact = intake.action === 'created' && !intake.replay
    for (const w of intake.warnings) console.warn(`[widget/intake] ${w}`)
    // The owner the capture resolved (agents.id) — the activity row and the agent bell below name it.
    const { data: owned, error: ownedErr } = await supabase.from('contacts').select('agent_id').eq('id', contactId).eq('brokerage_id', brokerage_id).maybeSingle()
    if (ownedErr) console.error('[widget/intake] contact owner read refused (the bell falls back to the session agent):', ownedErr.message)
    const assignedAgentId: string | null = (owned as { agent_id?: string | null } | null)?.agent_id ?? agent_id

    // ── 4. Attach session to contact ────────────────────────────────────────
    // Keyed on the row already resolved above rather than re-matching the token.
    await sentinelWrite(supabase, supabase
      .from('chat_sessions')
      .update({ contact_id: contactId, capture_state: 'captured', updated_at: new Date().toISOString() })
      .eq('id', session.id), { table: "chat_sessions", flow: "chat_sessions_write", reason: "session capture-state stamp; the contact is already captured" })

    // ── 5. TOMBSTONE (wave 147, lane 147Z): the route's own contact_consent_events insert is C8's consent record now
    //    (completeConsentedIntake → persistContactConsent — wording hash + version, purposes, channels, evidence).

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

    // ── 7. TOMBSTONE (wave 147, lane 147Z): the enrichment queue is captureContact's (queueContactEnrichmentAndScore →
    //    queueContactEnrichment — freshness, already-pending and live-deal suppression), read back by C8 (enrichmentQueued).

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
    await sentinelWrite(supabase, supabase.from('lifecycle_events').insert({
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
    }), { table: "lifecycle_events", flow: "lifecycle_events_echo", reason: "lifecycle_events audit echo of a change the caller already made; a lost row is ledgered (service client) or logged (user client), never silently dropped" })

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
