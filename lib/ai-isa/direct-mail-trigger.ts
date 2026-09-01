'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { dispatchDirectMail, type DirectMailPieceType } from '@/lib/providers/dispatch'

/**
 * DUAL-CLASS LANE (lane W3 2026-09-01). `leads.id` and `contacts.id` are
 * DISJOINT id spaces, and this trigger used to be leads-only: engage-contact
 * passed a contacts.id into `leadId`, the leads read below returned null, and
 * `shouldTriggerDirectMail` answered false forever — while the caller logged the
 * mail as sent anyway. The context now names its identity explicitly: EXACTLY
 * ONE of `leadId` / `contactId`, and every read/write below keys the matching
 * table and column. This is not a rename — lead callers
 * (app/actions/ai-isa/initiate-engagement.ts) keep the leadId arm unchanged.
 */
export interface DirectMailIdentity {
  /** leads.id — mutually exclusive with contactId. */
  leadId?: string
  /** contacts.id — mutually exclusive with leadId. */
  contactId?: string
}

export interface DirectMailContext extends DirectMailIdentity {
  brokerageId: string
  agentUserId?: string
  /** Lob template id for the (default) postcard piece. */
  templateId?: string
  /** Optional Lob template id for the letter piece (used when 'letter' is in `pieceTypes`). */
  letterTemplateId?: string
  firstName: string
  lastName: string
  /** Address fields — required for the LEADS arm; the CONTACTS arm resolves the
   *  verified mailing address off the contacts row itself and ignores these. */
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

/** Exactly one identity, or nothing at all — a caller that names both classes
 *  (or neither) is confused about who it is mailing, and guessing would put one
 *  person's touch on another person's record. Fail closed (§4). */
function resolveIdentity(id: DirectMailIdentity):
  | { cls: 'lead'; id: string }
  | { cls: 'contact'; id: string }
  | null {
  const named = (id.leadId ? 1 : 0) + (id.contactId ? 1 : 0)
  if (named !== 1) return null
  return id.leadId ? { cls: 'lead', id: id.leadId } : { cls: 'contact', id: id.contactId! }
}

interface MailableRow {
  mailing_address_verified: boolean | null
  mailing_address:          string | null
  mailing_city:             string | null
  mailing_state:            string | null
  mailing_zip:              string | null
}

/** The verified mailing fields for either identity class, or null when the row
 *  is absent. `contacts` carries the SAME columns as `leads` here —
 *  mailing_address_verified / mailing_address / mailing_city / mailing_state /
 *  mailing_zip (scripts/schema-snapshot.ts, contacts row) — so the contacts arm
 *  mirrors the leads arm's verification gate exactly rather than inventing a
 *  proxy. */
async function loadMailableRow(
  who: { cls: 'lead' | 'contact'; id: string },
): Promise<MailableRow | null> {
  const supabase = createServiceClient()
  const { data, error } = await supabase
    .from(who.cls === 'lead' ? 'leads' : 'contacts')
    .select('mailing_address_verified, mailing_address, mailing_city, mailing_state, mailing_zip')
    .eq('id', who.id)
    .maybeSingle()
  if (error) {
    // supabase-js RESOLVES a refusal — read it, and treat a refused read as
    // "not mailable" rather than as an empty success.
    console.error('[directMailTrigger] mailing-field read refused:', error.message)
    return null
  }
  return (data as MailableRow | null) ?? null
}

export async function shouldTriggerDirectMail(identity: DirectMailIdentity): Promise<boolean> {
  // Wave 36 — gate on the canonical `mailing_address_verified` column,
  // not the enrichment-confidence proxy (which could be high for a record
  // whose mailing address still failed Lob US verification, the only
  // signal that actually predicts deliverability).
  //
  // Removed the "low email engagement" filter — direct mail is one of
  // the two channels we're allowed to use for an unconsented lead, so
  // gating it behind "no email reply yet" gave up the channel for any
  // lead who briefly engaged. The de-conflict gate inside dispatch
  // still suppresses over-touches at the 30-day cap.
  const who = resolveIdentity(identity)
  if (!who) return false
  const l = await loadMailableRow(who)
  if (!l) return false
  if (l.mailing_address_verified !== true) return false
  return !!(l.mailing_address && l.mailing_city && l.mailing_state && l.mailing_zip)
}

export async function triggerDirectMailCampaign(context: DirectMailContext) {
  const who = resolveIdentity(context)
  if (!who) {
    return { success: false, error: 'Exactly one of leadId/contactId is required' }
  }

  const supabase = createServiceClient()

  // Wave 36 — defense in depth. The hard gate inside dispatchDirectMail
  // would also block an unverified send, but failing fast here lets us
  // avoid creating a direct_mail_campaigns row we'll never use.
  const eligible = await shouldTriggerDirectMail(context)
  if (!eligible) {
    return { success: false, error: `${who.cls === 'lead' ? 'Lead' : 'Contact'} mailing address not verified — Lob send blocked` }
  }

  // THE ADDRESS THAT GETS PRINTED. The leads arm keeps its existing contract
  // (the caller supplies the address in context). The contacts arm reads the
  // VERIFIED mailing_* columns off the contacts row — engage-contact only holds
  // the contact's residence city/state/zip under aliased names, and printing an
  // unverified residence address would defeat the gate above.
  let mailingAddress = context.mailingAddress
  let city  = context.city
  let state = context.state
  let zip   = context.zip
  if (who.cls === 'contact') {
    const row = await loadMailableRow(who)
    mailingAddress = row?.mailing_address ?? undefined
    city  = row?.mailing_city  ?? undefined
    state = row?.mailing_state ?? undefined
    zip   = row?.mailing_zip   ?? undefined
  }
  if (!mailingAddress || !city || !state || !zip) {
    return { success: false, error: 'Missing address data' }
  }

  // Wave 36 — idempotency window. Match the existing 30-day de-conflict
  // cap inside dispatchDirectMail: if this person got an individual_lead
  // campaign in the last 30 days, don't re-fire the trigger (it'd just
  // collide with the de-conflict gate downstream and burn a row). Older
  // re-engagement mailers > 30 days out can still go through. Keyed on the
  // column that matches the identity class — a contacts.id can never match a
  // lead_id row, so keying the wrong column reads as "no prior mail" forever.
  const identityColumn = who.cls === 'lead' ? 'lead_id' : 'contact_id'
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const { count: priorWelcomeCount } = await supabase
    .from('direct_mail_campaigns')
    .select('id', { count: 'exact', head: true })
    .eq(identityColumn, who.id)
    .eq('target_audience', 'individual_lead')
    .gte('created_at', thirtyDaysAgo)
  if ((priorWelcomeCount ?? 0) > 0) {
    return { success: false, error: 'recent_welcome_kit_within_30d', skipped: true }
  }

  const pieceTypes: DirectMailPieceType[] = (context.pieceTypes && context.pieceTypes.length > 0)
    ? context.pieceTypes
    : ['postcard']

  const sendOnePiece = async (piece: DirectMailPieceType, templateId: string) => {
    const { data: campaign, error: campaignInsertError } = await supabase
      .from('direct_mail_campaigns')
      .insert({
        brokerage_id:   context.brokerageId,
        // Exactly one of the two identity columns — direct_mail_campaigns
        // carries BOTH (contact_id is live per scripts/schema-snapshot.ts:277;
        // its FK + not-both CHECK are m596, WRITTEN NOT APPLIED).
        lead_id:        who.cls === 'lead' ? who.id : null,
        contact_id:     who.cls === 'contact' ? who.id : null,
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

    // The ledger row is the record that this mail existed. On the CONTACTS arm a
    // refused insert (e.g. the m596 CHECK/FK landing in a different shape, or a
    // schema cache that predates contact_id) must be a refusal the caller can
    // see — returning success here is how the ledger came to record mail that
    // was never sent. The LEADS arm keeps its long-standing tolerance (the
    // dispatch is still attempted and the failure is logged) so this fix does
    // not change lead behavior.
    if (campaignInsertError) {
      console.error('[directMailTrigger] direct_mail_campaigns insert refused:', campaignInsertError.message)
      if (who.cls === 'contact') {
        return {
          piece,
          success: false as const,
          campaignId: undefined,
          error: `direct_mail_campaigns insert refused (${campaignInsertError.message}) — if this names contact_id or its constraint, migration m596 is pending`,
        }
      }
    }

    const result = await dispatchDirectMail({
      brokerageId:    context.brokerageId,
      userId:         context.agentUserId,
      recipientName:  `${context.firstName} ${context.lastName}`.trim(),
      mailingAddress: mailingAddress ?? '',
      city:           city ?? '',
      state:          state ?? '',
      zip:            zip ?? '',
      templateId,
      pieceType:      piece,
      mergeVars: {
        first_name:        context.firstName,
        motivation_type:   context.motivation_type ?? '',
        property_interest: context.property_interest ?? '',
      },
      systemSource: 'ai_isa',
      // The dispatcher's compliance lookup picks its table from which of these
      // is set (`params.contactId ? "contacts" : "leads"`) — handing a
      // contacts.id to leadId is the alert-notifier defect
      // (app/actions/communications.ts:69-76 tombstone) and skips the gate.
      leadId:       who.cls === 'lead' ? who.id : undefined,
      contactId:    who.cls === 'contact' ? who.id : undefined,
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

    // The record that a physical mail piece was sent to this person.
    const { error: directMailActivityError } = await supabase.from('activities').insert({
      // activities.contact_id FKs contacts(id) — verified live against
      // activities_contact_id_fkey — so the CONTACTS arm writes it directly.
      // LEADS travel on entity_type/entity_id instead (writing a leads.id into
      // the contacts FK was FK-rejected 23503 on every send until this was
      // split): the shape lib/ai-isa/conversation-handler.ts:115 and
      // lib/ai-isa/tools.ts:120 already carry.
      contact_id:    who.cls === 'contact' ? who.id : null,
      entity_type:   who.cls === 'contact' ? 'contact' : 'lead',
      entity_id:     who.id,
      brokerage_id:  context.brokerageId,
      activity_type: 'ai_isa_direct_mail',
      title:         `Direct Mail (${piece}) Triggered`,
      description:   `${piece} sent to ${mailingAddress}`,
      status:        result.success ? 'completed' : 'failed',
      created_at:    new Date().toISOString(),
    })
    if (directMailActivityError) {
      console.error('[directMailTrigger] ai_isa_direct_mail activity REJECTED — the piece was dispatched but the touch is not on the record:', directMailActivityError.message)
    }

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
