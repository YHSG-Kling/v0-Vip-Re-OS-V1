'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { dispatchDirectMail, type DirectMailPieceType } from '@/lib/providers/dispatch'

export interface DirectMailContext {
  leadId: string
  brokerageId: string
  agentUserId?: string
  /** Lob template id for the (default) postcard piece. */
  templateId?: string
  /** Optional Lob template id for the letter piece (used when 'letter' is in `pieceTypes`). */
  letterTemplateId?: string
  firstName: string
  lastName: string
  mailingAddress?: string
  city?: string
  state?: string
  zip?: string
  motivation_type?: string
  property_interest?: string
  /**
   * Wave 36 — which Lob piece types to send. Defaults to ['postcard'] (single
   * piece, the legacy behavior). The new-lead welcome kit passes
   * ['postcard', 'letter'] to fulfill the user's "both" requirement: a
   * tactile postcard for immediate hand-time + a letter for long-form intro.
   * Each piece gets its own direct_mail_campaigns row so cost + delivery
   * tracking stay per-piece.
   */
  pieceTypes?: DirectMailPieceType[]
}

export async function shouldTriggerDirectMail(leadId: string): Promise<boolean> {
  // Wave 36 — gate on the canonical `mailing_address_verified` column,
  // not the enrichment-confidence proxy (which could be high for a lead
  // whose mailing address still failed Lob US verification, the only
  // signal that actually predicts deliverability).
  //
  // Removed the "low email engagement" filter — direct mail is one of
  // the two channels we're allowed to use for an unconsented lead, so
  // gating it behind "no email reply yet" gave up the channel for any
  // lead who briefly engaged. The de-conflict gate inside dispatch
  // still suppresses over-touches at the 30-day cap.
  const supabase = createServiceClient()
  const { data: lead } = await supabase
    .from('leads')
    .select('mailing_address_verified, mailing_address, mailing_city, mailing_state, mailing_zip')
    .eq('id', leadId)
    .maybeSingle()
  const l = lead as {
    mailing_address_verified: boolean | null
    mailing_address:          string | null
    mailing_city:             string | null
    mailing_state:            string | null
    mailing_zip:              string | null
  } | null
  if (!l) return false
  if (l.mailing_address_verified !== true) return false
  return !!(l.mailing_address && l.mailing_city && l.mailing_state && l.mailing_zip)
}

export async function triggerDirectMailCampaign(context: DirectMailContext) {
  if (!context.mailingAddress || !context.city || !context.state || !context.zip) {
    return { success: false, error: 'Missing address data' }
  }

  const supabase = createServiceClient()

  // Wave 36 — defense in depth. The hard gate inside dispatchDirectMail
  // would also block an unverified send, but failing fast here lets us
  // avoid creating a direct_mail_campaigns row we'll never use.
  const eligible = await shouldTriggerDirectMail(context.leadId)
  if (!eligible) {
    return { success: false, error: 'Lead mailing address not verified — Lob send blocked' }
  }

  // Wave 36 — idempotency window. Match the existing 30-day de-conflict
  // cap inside dispatchDirectMail: if this lead got an individual_lead
  // campaign in the last 30 days, don't re-fire the trigger (it'd just
  // collide with the de-conflict gate downstream and burn a row). Older
  // re-engagement mailers > 30 days out can still go through.
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { count: priorWelcomeCount } = await supabase
    .from('direct_mail_campaigns')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', context.leadId)
    .eq('target_audience', 'individual_lead')
    .gte('created_at', thirtyDaysAgo)
  if ((priorWelcomeCount ?? 0) > 0) {
    return { success: false, error: 'recent_welcome_kit_within_30d', skipped: true }
  }

  const pieceTypes: DirectMailPieceType[] = (context.pieceTypes && context.pieceTypes.length > 0)
    ? context.pieceTypes
    : ['postcard']

  const sendOnePiece = async (piece: DirectMailPieceType, templateId: string) => {
    const { data: campaign } = await supabase
      .from('direct_mail_campaigns')
      .insert({
        brokerage_id:   context.brokerageId,
        lead_id:        context.leadId,
        campaign_name:  `AI ISA ${piece} - ${context.firstName} ${context.lastName}`.trim(),
        target_audience: 'individual_lead',
        quantity:       1,
        design_url:     null,
        status:         'planning',
        piece_type:     piece,
        is_ai_generated: true,
        created_at:     new Date().toISOString(),
      })
      .select()
      .single()

    const result = await dispatchDirectMail({
      brokerageId:    context.brokerageId,
      userId:         context.agentUserId,
      recipientName:  `${context.firstName} ${context.lastName}`.trim(),
      mailingAddress: context.mailingAddress ?? '',
      city:           context.city ?? '',
      state:          context.state ?? '',
      zip:            context.zip ?? '',
      templateId,
      pieceType:      piece,
      mergeVars: {
        first_name:        context.firstName,
        motivation_type:   context.motivation_type ?? '',
        property_interest: context.property_interest ?? '',
      },
      systemSource: 'ai_isa',
      leadId:       context.leadId,
    })

    supabase.from('message_provider_logs').insert({
      brokerage_id:        context.brokerageId,
      provider_key:        'lob',
      channel:             'direct_mail',
      direction:           'outbound',
      provider_message_id: result.messageId ?? null,
      provider_status:     result.success ? 'sent' : 'failed',
      error_message:       result.error ?? null,
    })

    // Patch the campaign row with the actual dispatch outcome so the row
    // doesn't sit in `pending` forever.
    if (campaign?.id) {
      await supabase
        .from('direct_mail_campaigns')
        .update({
          status:        result.success ? 'sent' : 'failed',
          lob_order_id:  result.messageId ?? null,
          mailing_date:  result.success ? new Date().toISOString().slice(0, 10) : null,
          pieces_mailed: result.success ? 1 : 0,
        })
        .eq('id', campaign.id)
    }

    await supabase.from('activities').insert({
      contact_id:    context.leadId,
      brokerage_id:  context.brokerageId,
      activity_type: 'ai_isa_direct_mail',
      title:         `Direct Mail (${piece}) Triggered`,
      description:   `${piece} sent to ${context.mailingAddress}`,
      status:        result.success ? 'completed' : 'failed',
      created_at:    new Date().toISOString(),
    })

    return { piece, success: result.success, campaignId: campaign?.id, error: result.error }
  }

  try {
    const postcardTpl = context.templateId ?? process.env.LOB_DEFAULT_TEMPLATE_ID ?? ''
    const letterTpl   = context.letterTemplateId ?? process.env.LOB_DEFAULT_LETTER_TEMPLATE_ID ?? postcardTpl

    const results = []
    for (const piece of pieceTypes) {
      const tpl = piece === 'letter' ? letterTpl : postcardTpl
      results.push(await sendOnePiece(piece, tpl))
    }

    const anySuccess  = results.some((r) => r.success)
    const allErrors   = results.every((r) => !r.success)
    const firstErr    = results.find((r) => !r.success)?.error
    const firstCampId = results.find((r) => r.success)?.campaignId ?? results[0]?.campaignId

    return {
      success:    anySuccess,
      campaignId: firstCampId,
      pieces:     results,
      error:      allErrors ? (firstErr ?? 'all_pieces_failed') : undefined,
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error)

    // TENANT — `context.brokerageId`, the brokerage this mailing was being sent
    // for. It is a PARAMETER of the enclosing function, so the catch holds it
    // unconditionally; nothing is resolved inside the error handler.
    //
    // Note it was already serialized INSIDE `context_json` — the same letters, at
    // the wrong depth, stamping nothing. `automation_errors` readers filter
    // `.eq("brokerage_id", …)` at depth 1 (`workflows.ts:531` as an OWNERSHIP
    // check that returns "Forbidden" on a miss), so a nested copy leaves the
    // failure both invisible and un-resolvable in the automations console.
    const { error: directMailLogError } = await supabase.from('automation_errors').insert({
      brokerage_id:  context.brokerageId,
      workflow_name: 'ai_isa_direct_mail',
      error_message: msg,
      context_json:  JSON.stringify(context),
      severity:      'low',
      status:        'open',
      created_at:    new Date().toISOString(),
    })
    if (directMailLogError) {
      // The original failure is returned below; a failure to FILE it is reported
      // beside it, never in place of it.
      console.error('[direct-mail-trigger] automation_errors insert refused:', directMailLogError.message)
    }

    return { success: false, error: msg }
  }
}
