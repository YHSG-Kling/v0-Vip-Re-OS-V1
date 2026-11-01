import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { addSuppression } from '@/lib/kernel/compliance/check-suppression'
import { validateTwilioSignature } from '@/lib/voice/twilio-voice'
import { resolveTenantByOwnNumber, twilioTokenCandidates } from '@/lib/voice/sms-inbound'
import { detectOptOutIntent } from '@/lib/ai-isa/opt-out-utils'
import { processOptOutFromVerifiedInbound } from '@/lib/ai-isa/opt-out-writer'

/**
 * app/api/sms/inbound-optout/route.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Receives inbound SMS webhooks from Twilio or similar providers.
 * Detects STOP keywords per TCPA/CTIA rules and immediately suppresses
 * the phone number from future SMS sends.
 *
 * CTIA recognized STOP keywords: STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT
 *
 * ── NOT THE CANONICAL INBOUND SMS INGRESS — KEPT, ADJUDICATED UNRESOLVED ────
 * (Webhook-currency adjudication 2026-08-27, provider console unreachable.)
 * The SmsUrl this platform actually binds on every provisioned tenant number is
 * /api/providers/inbound (set at lib/voice/twilio-voice.ts:151, described as the
 * one messaging rail in lib/kernel/manager-registry.ts). That route PROVABLY
 * handles STOP end-to-end: it verifies the Twilio signature against the OWNING
 * SUBACCOUNT's token, resolves the tenant from the CALLED number, captures an
 * unknown texter as a contact, and runs detectOptOutIntent →
 * app/actions/ai-isa/process-opt-out.ts, whose contact-flag writes are the
 * flag arm lib/kernel/compliance/check-suppression.ts reads; lead STOPs are
 * bound to contact_suppression_list via its step 8c. NOTHING here is missing
 * there, so no merge was needed in that direction.
 *
 * WHY THIS FILE IS NOT DELETED (CLAUDE.md §1: prove reachability or write
 * "unresolved"): a Twilio number has exactly ONE SmsUrl, and this URL may
 * still be pasted into a console for a number this repo's provisioning never
 * touched. We cannot see the console from here, so reachability is UNRESOLVED
 * — and a STOP that 404s is a TCPA defect, so this fails toward keeping the
 * route. Twilio-side research (support.twilio.com "Twilio support for opt-out
 * keywords", verified 2026-08-27): Twilio itself block-lists STOP/UNSUBSCRIBE/
 * etc. (plus REVOKE/OPTOUT since the 2025-04-29 FCC ruling) and STILL passes
 * the message to the webhook, sending its own confirmation reply — so the
 * TwiML reply below is belt-and-braces, and the app-side suppression writes
 * here remain the part only we can do.
 *
 * INTEGRATOR SELF-HEAL STEP (the owner's "research the latest path" ruling):
 * audit the Twilio console — every number's SmsUrl should be the canonical
 * /api/providers/inbound published by lib/providers/webhook-contract.ts; once
 * NO number points here, delete this route with a tombstone naming
 * app/api/providers/inbound/route.ts. Until that audit, this route is carried
 * in the webhook contract as a compat duplicate of the canonical ingress.
 *
 * ── WHY THE SIGNATURE CHECK BELOW EXISTS ────────────────────────────────────
 * It had NO caller authentication at all. The handler runs on the service client
 * and matched contacts by phone ACROSS EVERY BROKERAGE, so an unauthenticated
 * POST of `From=<any phone>&Body=STOP` suppressed that person in every tenant
 * that had them — a cross-tenant write and a denial-of-communication vector, and
 * the TwiML reply told the victim it had happened. The gate is the same one the
 * canonical ingress uses (subaccount token resolved by the To number, master env
 * token as fallback) so a request Twilio really signed still passes here.
 */

// TOMBSTONE (wave 148, lane 148B — CLAUDE.md §6, C16): this route's own STOP_KEYWORDS regex (stop|stopall|unsubscribe|cancel|
// end|quit — no "revoke", no "opt out") was a second revocation vocabulary beside the survivor. It reads THE one list now:
// lib/ai-isa/opt-out-utils.ts detectOptOutIntent / REVOCATION_KEYWORDS (the carrier keywords + the FCC 2024 revocation words).

const STOP_REPLY =
  'You have been successfully unsubscribed. You will receive no more messages from this number. Reply START to re-subscribe.'

export async function POST(req: NextRequest) {
  try {
    const body = await req.text()
    const params = new URLSearchParams(body)

    const from    = params.get('From')    ?? params.get('from')
    const msgBody = params.get('Body')    ?? params.get('body') ?? ''
    const to      = params.get('To')      ?? params.get('to')   ?? ''

    if (!from) {
      return NextResponse.json({ error: 'Missing From number' }, { status: 400 })
    }

    // ── Caller verification (X-Twilio-Signature) ────────────────────────────
    // Signed over the exact form params Twilio POSTed, so the object is built
    // from the parsed body rather than from the three fields read above.
    const signedParams: Record<string, string> = {}
    for (const [k, v] of params.entries()) signedParams[k] = v

    const signature = req.headers.get('x-twilio-signature')
    const svcForAuth = createServiceClient()
    const tokens = await twilioTokenCandidates(svcForAuth, signedParams)
    if (tokens.length === 0) {
      console.error('[sms-optout] no Twilio auth token available for To=%s — refusing', to)
      return NextResponse.json({ error: 'Not configured' }, { status: 503 })
    }
    if (!tokens.some((t) => validateTwilioSignature(t, req.url, signedParams, signature))) {
      console.warn('[sms-optout] invalid X-Twilio-Signature for To=%s — refused', to)
      return new NextResponse('invalid signature', { status: 403 })
    }


    const optOut = detectOptOutIntent(msgBody)
    if (!optOut.isOptOut || optOut.confidence !== 'high') {
      return NextResponse.json({ success: true, action: 'pass_through' })
    }

    // STOP keyword detected — suppress immediately
    const supabase = createServiceClient()

    // C16 — ONE WRITER (wave 148, lane 148B). The STOP is written through the ONE opt-out writer (lib/ai-isa/opt-out-writer.ts
    // processOptOutFromVerifiedInbound → writeOptOut: the contact's flags for every channel the word revokes — a bare STOP is
    // channel "all", the survivor's ruling — AND, since wave 148, one contact_suppression_list row per channel keyed by the
    // contact and the number). TOMBSTONE: this route used to suppress SMS ONLY through its own addSuppression loop, matched
    // contacts in EVERY tenant by an exact `phone.eq.<raw>` (a stored "(555) 123-4567" never matched the carrier's
    // "+15551234567"), so the same STOP left email / calls / mail open and missed reformatted numbers. Now: the tenant that owns
    // the To number (resolveTenantByOwnNumber) when it resolves, every contact of it whose phone_digits match the sender.
    const fromDigits = from.replace(/\D/g, '')
    const ten = fromDigits.length === 11 && fromDigits.startsWith('1') ? fromDigits.slice(1) : fromDigits
    const digitForms = ten.length === 10 ? [ten, `1${ten}`] : [fromDigits]
    const owner = await resolveTenantByOwnNumber(supabase, to)
    let contactsQuery = supabase.from('contacts').select('id, brokerage_id, phone').in('phone_digits', digitForms)
    if (owner?.brokerageId) contactsQuery = contactsQuery.eq('brokerage_id', owner.brokerageId)
    const { data: contacts, error: contactsError } = await contactsQuery

    if (contactsError) {
      console.error('[sms-optout] contact lookup refused:', contactsError.message)
      return NextResponse.json({ error: 'Could not process opt-out' }, { status: 503 })
    }

    if (contacts && contacts.length > 0) {
      const results = await Promise.all(
        contacts.map((c: { id: string; brokerage_id: string }) =>
          processOptOutFromVerifiedInbound({
            entityType: 'contact',
            entityId: c.id,
            brokerageId: c.brokerage_id,
            channel: optOut.channel,
            source: 'inbound_sms',
            rawMessage: `STOP keyword received: "${msgBody.trim().slice(0, 200)}"`,
          })
        )
      )

      const refused = results.filter((r) => !r.success)
      if (refused.length > 0) {
        console.error(
          `[sms-optout] ${refused.length}/${results.length} STOP suppression(s) REFUSED for ${from}:`,
          refused.map((r) => r.error ?? 'unknown').join(' | '),
        )
        return NextResponse.json({ error: 'Could not record opt-out' }, { status: 503 })
      }
      const unsynced = results.filter((r) => r.listSynced === false).length
      if (unsynced > 0) console.error(`[sms-optout] ${unsynced} STOP(s) landed on the contact flags but NOT on the suppression list — number-only sends may not see them`)
    } else {
      // Phone not in contacts. The comment here used to say the brokerage came from the
      // "to" number's provider config — but the query never used `to`. It took the FIRST
      // twilio credential row in the table, so an unknown number's STOP was suppressed
      // under an arbitrary tenant.
      //
      // `to` IS the tenant's own number, and phone_number_events records which brokerage
      // provisioned it. Resolve through that; if the number cannot be attributed, log and
      // do nothing rather than suppress under a brokerage that never messaged them.
      const { data: numberOwner } = await supabase
        .from('phone_number_events')
        .select('brokerage_id')
        .eq('phone_number', to)
        .not('brokerage_id', 'is', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      const providerConfig = (owner?.brokerageId ? { brokerage_id: owner.brokerageId } : numberOwner) as { brokerage_id?: string | null } | null
      if (!providerConfig?.brokerage_id) {
        console.warn(`[sms-optout] STOP from unknown number to unattributable number ${to} — not suppressed`)
      }

      if (providerConfig?.brokerage_id) {
        // A number with no contact yet: the list row IS the suppression (keyed by the number). A bare STOP revokes texts AND
        // calls for that number (the survivor reads it as "all"; email / mail have no address to key on here).
        const channels: Array<'sms' | 'phone'> = optOut.channel === 'all' ? ['sms', 'phone'] : optOut.channel === 'phone' ? ['phone'] : ['sms']
        const appliedAll = await Promise.all(channels.map((channel) => addSuppression({
          brokerageId: providerConfig.brokerage_id as string,
          phone:       from,
          channel,
          reason:      `STOP keyword received from unknown number: "${msgBody.trim().slice(0, 200)}"`,
          source:      'sms_stop',
        })))
        const applied = { suppressed: appliedAll.every((a) => a.suppressed), errors: appliedAll.flatMap((a) => a.errors) }
        if (!applied.suppressed) {
          console.error(
            `[sms-optout] STOP suppression for unknown number ${from} REFUSED:`,
            applied.errors.join(' | ') || '(no error reported)',
          )
          return NextResponse.json({ error: 'Could not record opt-out' }, { status: 503 })
        }
      }
    }

    // Return Twilio-compatible TwiML response
    return new NextResponse(
      `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${STOP_REPLY}</Message></Response>`,
      {
        status: 200,
        headers: { 'Content-Type': 'text/xml' },
      }
    )
  } catch (err: any) {
    console.error('[v0] SMS opt-out handler error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
