// SYSTEM: QR Form Submit → Contact creation (Contact-first, Track B)
// Form submission = TCPA consent. Creates contact via captureContact().

import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import { captureContact } from '@/lib/contact-pipeline/contact-capture'
import { KernelEvent } from '@/lib/kernel/events'

export const dynamic = 'force-dynamic'

interface QRSubmitBody {
  slug: string
  qrCodeId: string
  first_name: string
  last_name: string
  email?: string
  phone?: string
  tcpa_checked: boolean
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = (await req.json()) as QRSubmitBody
    const { slug, qrCodeId, first_name, last_name, email, phone, tcpa_checked } = body

    // ── Step 1: TCPA channel check — do not block lead creation ─────────────
    // Per TCPA corrected rule: create contact regardless of consent.
    // Suppress phone/SMS when tcpa_checked is false.
    const consentGiven = tcpa_checked === true

    if (!slug || !qrCodeId) {
      return NextResponse.json(
        { success: false, error: 'Missing slug or qrCodeId' },
        { status: 400 },
      )
    }

    const supabase = createServiceClient()

    // ── Step 2: Fetch QR code ─────────────────────────────────────────────────
    // Schema: qr_codes.agent_id (NOT agent_user_id — old name in earlier
    // migrations). Previously this select silently failed and agent_user_id
    // came back undefined, dropping the per-agent attribution on captured
    // leads.
    //
    // `is_active` is NOT part of the lookup, and `expires_at` is now read: a
    // paused code, an expired code and an id that matches nothing are three
    // different facts. THIS IS THE REFUSAL THAT MATTERS — /api/qr/scan can only
    // speak for scans it routes, but this endpoint is reachable directly from a
    // bookmarked landing page, and capturing a lead through a retired code
    // writes a contact the tenant will read as coming from a live campaign.
    const { data: qr, error: qrError } = await supabase
      .from('qr_codes')
      .select('id, brokerage_id, agent_id, lead_count, is_active, expires_at, marketing_campaign_id')
      .eq('id', qrCodeId)
      .maybeSingle()

    if (qrError || !qr) {
      return NextResponse.json(
        { success: false, error: 'QR code not found' },
        { status: 404 },
      )
    }

    if (!qr.is_active) {
      return NextResponse.json(
        {
          success: false,
          error: 'This code is paused — the agent who created this QR code has paused it, so it is not accepting submissions right now.',
        },
        { status: 403 },
      )
    }
    if (qr.expires_at && new Date(qr.expires_at).getTime() <= Date.now()) {
      return NextResponse.json(
        {
          success: false,
          error: 'This code has expired — this QR code was set to expire and that date has passed, so it is no longer accepting submissions.',
        },
        { status: 410 },
      )
    }

    // ── Step 3: captureContact (dedup → merge/create → enrich queue → score) ─
    // qr_codes.agent_id is agents.id — pass it through directly. captureContact
    // routes through resolveAgentForContact() so the brokerage's assignment
    // rules apply when no QR is agent-tagged.
    const ownerAgentId: string | null = qr.agent_id ?? null

    const now = new Date().toISOString()
    const { contactId, action } = await captureContact({
      brokerageId: qr.brokerage_id,
      ownerAgentId,
      source: 'qr_scan',
      first_name: first_name || null,
      last_name: last_name || null,
      email: email || null,
      // Only store phone when TCPA consent given; omit to prevent calling
      phone: consentGiven ? (phone || null) : null,
      preferred_channel: consentGiven ? 'phone' : 'email',
      tcpa_consent: consentGiven,
      tcpa_consent_date: consentGiven ? now : null,
      rawPayload: { slug, qrCodeId, first_name, last_name, email, phone },
    })

    // ── Step 4: Increment lead_count only on new contact creation ─────────────
    if (action === 'created') {
      await supabase
        .from('qr_codes')
        .update({ lead_count: (qr.lead_count ?? 0) + 1 })
        .eq('id', qr.id)

      // Wave 36 — variant lead attribution. If this QR was attached to
      // a direct_mail_campaigns row that carried a variant_id, bump the
      // variant's outcomes.leads_count so the bandit can optimize for
      // LEADS (the action we actually care about) rather than just
      // scans (a noisier proxy). Multiple campaigns may share the same
      // QR over time; we pick the most-recently-mailed one as the
      // attribution target.
      try {
        const { data: attribCampaign } = await supabase
          .from('direct_mail_campaigns')
          .select('id, variant_id, per_piece_cost, pieces_mailed')
          .eq('brokerage_id', qr.brokerage_id)
          .eq('qr_code_id', qr.id)
          .not('variant_id', 'is', null)
          .order('mailing_date', { ascending: false, nullsFirst: false })
          .limit(1)
          .maybeSingle()
        const c = attribCampaign as {
          id: string; variant_id: string;
          per_piece_cost: number | null; pieces_mailed: number | null
        } | null
        if (c?.variant_id) {
          // Bump leads_count atomically via SELECT-then-UPDATE. Same
          // best-effort increment pattern as recordVariantSend; lost
          // increments under concurrent contention are acceptable for
          // a learning signal.
          const { data: existingOutcomes } = await supabase
            .from('direct_mail_variant_outcomes')
            .select('id, leads_count')
            .eq('variant_id', c.variant_id)
            .eq('brokerage_id', qr.brokerage_id)
            .maybeSingle()
          if (existingOutcomes) {
            await supabase
              .from('direct_mail_variant_outcomes')
              .update({
                leads_count: ((existingOutcomes.leads_count as number) ?? 0) + 1,
                updated_at:  new Date().toISOString(),
              })
              .eq('id', existingOutcomes.id)
          } else {
            await supabase.from('direct_mail_variant_outcomes').insert({
              variant_id:   c.variant_id,
              brokerage_id: qr.brokerage_id,
              sends_count:  0,
              scans_count:  0,
              leads_count:  1,
              updated_at:   new Date().toISOString(),
            })
          }
        }
      } catch (e) {
        console.error('[qr/submit] variant lead attribution failed:', e)
      }
    }

    // ── Step 4b: Record the CAMPAIGN TOUCHPOINT ───────────────────────────────
    // This is the moment a QR scan stops being anonymous: the code is known, the
    // contact is now known, and if the code belongs to a marketing campaign then
    // that campaign has just touched that person. marketing_campaign_touchpoints
    // is the shared ledger de-confliction (the over-messaging frequency cap),
    // attribution and the team bullpen all read — and 'qr_scan' is a channel its
    // live CHECK admits that NOTHING was writing, so a QR-driven touch was
    // invisible to every one of them.
    //
    // Only when the code carries a marketing_campaign_id: the table's
    // origin CHECK requires campaign_id OR sequence_id, and a QR with no campaign
    // has no campaign to credit. external_table/external_id point back at the QR
    // itself so the touch is traceable to the exact code that produced it.
    //
    // Best-effort and non-blocking — recordCampaignTouchpointSafe never throws,
    // and an attribution write must never fail the capture the prospect is
    // waiting on.
    if (qr.marketing_campaign_id) {
      try {
        const { recordCampaignTouchpointSafe } = await import('@/lib/marketing/touchpoint-recorder')
        void recordCampaignTouchpointSafe({
          brokerageId:   qr.brokerage_id as string,
          campaignId:    qr.marketing_campaign_id as string,
          contactId,
          channel:       'qr_scan',
          externalTable: 'qr_codes',
          externalId:    qr.id as string,
          source:        'trigger',
          status:        'converted',
          metadata:      { slug, action },
        })
      } catch (err) {
        console.error('[qr/submit] touchpoint record failed:', err)
      }
    }

    // ── Step 5: Link most recent unlinked scan event to contact ───────────────
    const { data: scanEvent } = await supabase
      .from('qr_scan_events')
      .select('id')
      .eq('qr_code_id', qr.id)
      .is('contact_id', null)
      .order('scanned_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (scanEvent) {
      await supabase
        .from('qr_scan_events')
        .update({ contact_id: contactId })
        .eq('id', scanEvent.id)
    }

    // ── Step 6: Emit lifecycle event + fan out ────────────────────────────────
    // fanOutKernelEvent fires staff notifications + auto-enrolls any
    // campaign_sequences with trigger_event='contact_captured' (so e.g.
    // a "QR-captured lead" nurture drip starts immediately) AND emits a
    // welcome portal message for the new contact.
    await supabase.from('lifecycle_events').insert({
      brokerage_id: qr.brokerage_id,
      entity_type: 'contact',
      entity_id: contactId,
      event_type: KernelEvent.CONTACT_CAPTURED,
      metadata: { source: 'qr_scan', slug, qrCodeId, action },
    })

    if (action === 'created') {
      try {
        const { fanOutKernelEvent } = await import('@/lib/kernel/event-fanout')
        await fanOutKernelEvent({
          event:       KernelEvent.CONTACT_CAPTURED,
          brokerageId: qr.brokerage_id,
          entityType:  'contact',
          entityId:    contactId,
          contactId,
          agentUserId: undefined,
          metadata:    { source: 'qr_scan', slug, qrCodeId, ownerAgentId },
        })
      } catch { /* non-blocking */ }
    }

    return NextResponse.json({ success: true, contactId, action })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return NextResponse.json({ success: false, error: message }, { status: 500 })
  }
}
