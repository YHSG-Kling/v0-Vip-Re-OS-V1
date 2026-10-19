// THE /forms/[slug] CAPTURE DOOR — a THIN door onto the ONE kernel command (wave 142, lane 142E).
//
// TOMBSTONE (orphan doctrine §1.1): this route used to be a SECOND capture pipeline on lead_capture_forms /
// form_submissions beside lib/kernel/lead-magnets.ts captureFormSubmission — its own form_submissions insert,
// its own counter RPC, captureContact (Track B) for the contact, persistContactConsent, its own
// submission→contact link and its own event emit — so a /forms/<slug> submission got none of what a /lm/<slug>
// submission gets (deliverable, agent notification, manager handoff by intent, sequence enrolment,
// attribution + the touchpoint, the consent artifact the ISA gates read). SURVIVOR: captureFormSubmission.
// MERGED onto the survivor before this door was thinned: the declared persona
// (settings.default_contact_type → lib/lead-magnets/form-contact-types.ts) and the intake-time locale
// (resolveCapturedLanguage, still the ONE resolver, now passed in as `language`). KEPT here, because the kernel
// does not do it: the FORM_SUBMISSION_RECEIVED kernel event (the reactor's welcome for a declared persona).
// DELTA, stated: the person-identity evidence link on the contact rode captureContact (not client-injectable,
// lane D's survivor) — the kernel's contact path does not resolve a person; recorded in the lane notes.

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { checkPublicRateLimit } from '@/lib/security/public-rate-limit'
import { captureFormSubmission, trackMagnetEvent } from '@/lib/kernel/lead-magnets'
import { KernelEvent } from '@/lib/kernel/events'
import { emitKernelEvent } from '@/lib/kernel/emit'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  // PUBLIC-WRITE THROTTLE (lane 138F readiness audit, P1): an unauthenticated
  // contact-creating write. Same keep-one limiter + idiom as
  // app/api/track/visitor/route.ts (lib/security/public-rate-limit.ts).
  const rateIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown"
  const rateVerdict = checkPublicRateLimit("forms-submit", rateIp, { limit: 20, windowMs: 10 * 60_000 })
  if (!rateVerdict.allowed) {
    return NextResponse.json({ error: "Too many submissions from this connection — try again shortly." }, { status: 429, headers: { "Retry-After": String(rateVerdict.retryAfterSeconds) } })
  }
  try {
    const body = await req.json() as { slug: string; data: Record<string, unknown>; tcpaConsent?: boolean; tcpaConsentText?: string }
    const { slug, data, tcpaConsent } = body

    if (!slug || !data || typeof data !== 'object') {
      return NextResponse.json({ success: false, error: 'Missing slug or data' }, { status: 400 })
    }

    // Per TCPA corrected rule: do not block lead creation when consent is absent. The kernel stamps the
    // contact-level consent only when consent was given AND a phone was offered (one rule, in the kernel).
    const consentGiven = tcpaConsent === true
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined
    const userAgent = req.headers.get('user-agent') ?? undefined

    // ── Tier 3 of resolveContactLanguage: intake-time locale ──────────────────
    // THE ONE resolver (§6) — lib/contact-pipeline/contact-capture.ts resolveCapturedLanguage, shared by
    // every public intake door instead of each one re-deriving "form field vs. Accept-Language, which wins".
    const { resolveCapturedLanguage } = await import('@/lib/contact-pipeline/contact-capture')
    const formLocale = (data['language'] ?? data['locale'] ?? '') as string
    const capturedLanguage = resolveCapturedLanguage(formLocale, req.headers.get('accept-language'))

    const supabase = createServiceClient()

    // ── Step 1: the form by slug — the tenant comes from the ROW, never the body ──
    const { data: form, error: formError } = await supabase
      .from('lead_capture_forms')
      .select('id, brokerage_id, slug, is_active, redirect_url, thank_you_message')
      .eq('slug', slug)
      .eq('is_active', true)
      .maybeSingle()

    if (formError || !form) {
      return NextResponse.json({ success: false, error: 'Form not found' }, { status: 404 })
    }

    // ── Step 2: the ONE kernel command ─────────────────────────────────────────
    const result = await captureFormSubmission({
      formId: form.id,
      brokerageId: form.brokerage_id,
      submissionData: data,
      source: 'web_form',
      tcpaConsentGiven: consentGiven,
      ipAddress: ip,
      userAgent,
      language: capturedLanguage,
    })
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error ?? 'Submission failed' }, { status: 400 })
    }

    // ── Step 3: the same tracking event the other doors fire (the magnet's own performance count) ──
    trackMagnetEvent({
      magnetId: form.id,
      brokerageId: form.brokerage_id,
      eventType: 'form_submit',
      contactId: result.contactId,
      ipAddress: ip,
      userAgent,
      metadata: { source: 'web_form', door: '/forms/[slug]' },
    }).catch(() => {})

    // ── Step 4: the reactor's hop (welcome for a declared persona, notification rules) ──────────
    // Kept from the old door: the kernel emits its own form_submission_captured audit; this is the
    // REACTOR event the notification_rules row and resolveWelcomeManagers key on. void/catch so the emit
    // never fails the 200 the form's caller is waiting on.
    if (result.contactId) {
      void emitKernelEvent({
        event:       KernelEvent.FORM_SUBMISSION_RECEIVED,
        brokerageId: form.brokerage_id,
        entityType:  'contact',
        entityId:    result.contactId,
        contactId:   result.contactId,
        metadata:    { formId: form.id, submissionId: result.submissionId ?? null, door: '/forms/[slug]' },
      }).catch((err) => console.error('[forms/submit] FORM_SUBMISSION_RECEIVED emit failed:', err))
    }

    // ── Step 5: Return (the shape FormRenderer reads) ───────────────────────────
    return NextResponse.json({
      success: true,
      contactId: result.contactId ?? null,
      redirect: form.redirect_url ?? null,
      thankYouMessage: form.thank_you_message ?? null,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
