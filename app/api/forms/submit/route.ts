// TRACK B: Form submission → captureContact() → dedup → enrich queue → score
// tcpa_consent = TRUE (form fill = digital opt-in)
// No lead created. No lead_id set anywhere in this flow.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { captureContact } from '@/lib/contact-pipeline/contact-capture'
import { KernelEvent } from '@/lib/kernel/events'
import { persistContactConsent } from '@/lib/kernel/compliance/require-contact-consent'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as { slug: string; data: Record<string, unknown>; tcpaConsent?: boolean; tcpaConsentText?: string }
    const { slug, data, tcpaConsent, tcpaConsentText } = body

    if (!slug || !data) {
      return NextResponse.json({ success: false, error: 'Missing slug or data' }, { status: 400 })
    }

    // Per TCPA corrected rule: do not block lead creation when consent is absent.
    // Only suppress phone/SMS channel when tcpaConsent is false.
    const consentGiven = tcpaConsent === true
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null
    const userAgent = req.headers.get('user-agent') ?? null

    const supabase = createServiceClient()

    // ── Step 1: Fetch form definition ─────────────────────────────────────────
    const { data: form, error: formError } = await supabase
      .from('lead_capture_forms')
      .select('*')
      .eq('slug', slug)
      .eq('is_active', true)
      .single()

    if (formError || !form) {
      return NextResponse.json({ success: false, error: 'Form not found' }, { status: 404 })
    }

    // ── Step 2: Insert form_submissions ───────────────────────────────────────
    const { data: submission, error: submissionError } = await supabase
      .from('form_submissions')
      .insert({
        form_id: form.id,
        brokerage_id: form.brokerage_id,
        submission_data: data,
        ip_address: ip,
        user_agent: userAgent,
        tcpa_consent_given: consentGiven,
      })
      .select('id')
      .single()

    if (submissionError || !submission) {
      return NextResponse.json({ success: false, error: 'Failed to record submission' }, { status: 500 })
    }

    // ── Step 3: Increment submission_count ────────────────────────────────────
    await supabase.rpc('increment_form_submission_count', { form_id_input: form.id })

    // ── Step 4: Map fields ────────────────────────────────────────────────────
    const first_name =
      (data['first_name'] ?? data['firstName'] ?? '') as string
    const last_name =
      (data['last_name'] ?? data['lastName'] ?? '') as string
    const email = (data['email'] ?? '') as string
    const phone = (data['phone'] ?? '') as string

    // ── Step 5: captureContact ────────────────────────────────────────────────
    const consentNow = new Date().toISOString()
    const { contactId, action } = await captureContact({
      brokerageId: form.brokerage_id,
      // Use agent from form record; captureContact will fallback to brokerage primary if null
      agentUserId: form.agent_id ?? null,
      source: 'web_form',
      first_name: first_name || null,
      last_name: last_name || null,
      email: email || null,
      // Only store phone when TCPA consent given; omit to prevent calling
      phone: consentGiven ? (phone || null) : null,
      preferred_channel: consentGiven ? 'phone' : 'email',
      tcpa_consent: consentGiven,
      tcpa_consent_date: consentGiven ? consentNow : null,
      rawPayload: data,
    })

    // ── Persist consent audit event ────────────────────────────────────────
    const { persistContactConsent } = await import('@/lib/kernel/compliance/require-contact-consent')
    await persistContactConsent({
      brokerageId: form.brokerage_id,
      agentId: form.agent_id ?? null,
      contactId,
      consentText: tcpaConsentText ?? `Form consent given on ${form.slug}`,
      consentSource: `/forms/${slug}`,
      consented: true,
      ipAddress: ip,
      userAgent: userAgent,
    }).catch(() => {})

    // ── Step 6: Link submission to contact ────────────────────────────────────
    await supabase
      .from('form_submissions')
      .update({ contact_id: contactId })
      .eq('id', submission.id)

    // ── Step 7: Emit lifecycle event ──────────────────────────────────────────
    await supabase.from('lifecycle_events').insert({
      brokerage_id: form.brokerage_id,
      entity_type: 'contact',
      entity_id: contactId,
      event_type: KernelEvent.FORM_SUBMISSION_RECEIVED,
      metadata: { formId: form.id, action },
    })

    // ── Step 8: Return ────────────────────────────────────────────────────────
    return NextResponse.json({
      success: true,
      contactId,
      redirect: form.redirect_url ?? null,
      thankYouMessage: form.thank_you_message ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
