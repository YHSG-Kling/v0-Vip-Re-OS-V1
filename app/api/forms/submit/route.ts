// TRACK B: Form submission → captureContact() → dedup → enrich queue → score
// tcpa_consent = TRUE (form fill = digital opt-in)
// No lead created. No lead_id set anywhere in this flow.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { captureContact } from '@/lib/contact-pipeline/contact-capture'
import { KernelEvent } from '@/lib/kernel/events'
import { emitKernelEvent } from '@/lib/kernel/emit'
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

    // ── Tier 3 of resolveContactLanguage: intake-time locale ──────────────────
    // Prefer a form field naming the locale explicitly (a form CAN carry a
    // `language`/`locale` field in its submission_data — nothing forces one to
    // exist), else fall back to the browser's Accept-Language header. Mapped
    // through the ONE locale table (localeToElevenLabsLanguage — §6, never a
    // second parser of "es-MX" → "es") so a garbage/unmapped value never reaches
    // storage as a fabricated language.
    const { localeToElevenLabsLanguage } = await import('@/lib/video/multilingual-reel')
    const formLocale = (data['language'] ?? data['locale'] ?? '') as string
    const acceptLanguage = req.headers.get('accept-language')?.split(',')[0]?.trim() ?? ''
    const capturedLanguage =
      localeToElevenLabsLanguage(formLocale) ?? localeToElevenLabsLanguage(acceptLanguage) ?? null

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

    // ── Step 4b: form-declared persona (BUILD, wave 51) ───────────────────────
    // `lead_capture_forms` carries no dedicated persona column, and this route's
    // fields are entirely admin-defined free text — there is no field this door
    // can safely READ as "buyer" or "seller" without guessing (CLAUDE.md §1: write
    // "unresolved" rather than invent). What CAN be built without a migration is
    // letting the admin who BUILT the form declare its persona up front, in the
    // `settings` jsonb column this table already has. Only a value already in the
    // live `contacts_contact_type_check` vocabulary is forwarded — an unrecognised
    // string is worse than none, because captureContact would carry it straight
    // into an INSERT the CHECK constraint refuses (PGRST/23514) and the whole
    // submission would fail closed on a typo. When absent (every form that
    // predates this wave), contact_type stays null and resolveWelcomeManagers
    // legitimately returns no manager for it — see the FORM_SUBMISSION_RECEIVED
    // reader in lib/kernel/event-reactor.ts for what that means for the welcome.
    const FORM_DECLARABLE_CONTACT_TYPES = new Set(['buyer', 'seller', 'both'])
    const declaredContactType = (() => {
      const raw = (form as { settings?: { default_contact_type?: string | null } | null }).settings
        ?.default_contact_type
      const v = (raw ?? '').toString().trim().toLowerCase()
      return FORM_DECLARABLE_CONTACT_TYPES.has(v) ? v : null
    })()

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
      contact_type: declaredContactType,
      rawPayload: data,
      ...(capturedLanguage ? { language: capturedLanguage } : {}),
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
    // Was a direct lifecycle_events insert — audit-only, no reactor fan-out, so
    // notification_rules' live form_submission_received row never fired. Real
    // moment: right after captureContact + consent land, tenant/contact from
    // the rows already loaded above. void/catch so the emit never fails the
    // 200 the form's caller is waiting on.
    void emitKernelEvent({
      event:       KernelEvent.FORM_SUBMISSION_RECEIVED,
      brokerageId: form.brokerage_id,
      entityType:  'contact',
      entityId:    contactId,
      contactId,
      metadata:    { formId: form.id, action },
    }).catch((err) => console.error('[forms/submit] FORM_SUBMISSION_RECEIVED emit failed:', err))

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
