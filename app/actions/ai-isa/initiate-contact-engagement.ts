'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { generatePersonalizedEmail } from '@/lib/ai-isa/email-generator'
import {
  logISAOutreach,
  checkMaxTouches,
  checkUnderContractPause,
} from '@/lib/ai-isa/isa-outreach-logger'
import { evaluateOutbound } from '@/lib/kernel'
import { dispatchEmail } from '@/lib/providers/dispatch'

export async function initiateAIISAContactEngagement(contactId: string): Promise<{
  success: boolean
  emailSent?: boolean
  contactId?: string
  reason?: string
  error?: string
}> {
  const supabase = createServiceClient()

  try {
    // Load contact record — this is NOT a lead. Nurture runs on the contact.
    const { data: contact, error: contactError } = await supabase
      .from('contacts')
      .select('id, first_name, last_name, email, agent_id, brokerage_id, status, dnc_status, isa_reengage_allowed, tcpa_consent, contact_type, engagement_score')
      .eq('id', contactId)
      .maybeSingle()

    if (contactError || !contact) {
      return { success: false, reason: 'Contact not found' }
    }

    // GATE A: Must have an assigned agent (converted contacts have agent_id)
    if (!contact.agent_id) {
      return { success: false, reason: 'Contact not yet assigned to agent' }
    }

    // GATE B: Must have an email
    if (!contact.email) {
      return { success: false, reason: 'No email available' }
    }

    // GATE C: Global DNC hard stop
    if (contact.dnc_status === true) {
      return { success: false, reason: 'stop:dnc' }
    }

    // GATE D: ISA re-engagement must be allowed
    if (contact.isa_reengage_allowed === false) {
      return { success: false, reason: 'stop:reengage_blocked' }
    }

    // GATE E: Under-contract pause check
    const paused = await checkUnderContractPause(
      contact.brokerage_id,
      contactId,
      'contact',
      contactId,
    )
    if (paused) {
      return { success: false, reason: 'paused:under_contract' }
    }

    // GATE F: Max touches check
    const canContinue = await checkMaxTouches(contactId, 'contact', contact.brokerage_id)
    if (!canContinue) {
      return { success: false, reason: 'stop:max_touches' }
    }

    // GATE G: Full compliance evaluation via kernel
    const compliance = await evaluateOutbound({
      actorContext: {
        brokerageId: contact.brokerage_id ?? '',
        userId: contact.agent_id ?? '',
        role: 'isa' as import('@/lib/kernel/types').ActorRole,
      },
      journeyType: contact.contact_type === 'seller' ? 'seller' : contact.contact_type === 'both' ? 'dual' : 'buyer',
      persona: 'other' as import('@/lib/kernel/types').Persona,
      messageType: 'email' as import('@/lib/kernel/types').MessageType,
      content: 'AI-ISA contact re-engagement',
      contact: {
        id:                   contactId,
        first_name:           contact.first_name ?? "",
        last_name:            contact.last_name ?? "",
        contact_type:         (contact.contact_type as "buyer" | "seller" | "both" | "investor" | "vendor" | "lender") ?? "buyer",
        status:               contact.status,
        dnc_status:           contact.dnc_status ?? false,
        tcpa_consent:         contact.tcpa_consent ?? false,
        isa_reengage_allowed: contact.isa_reengage_allowed ?? false,
      },
    })

    if (!compliance.allowed) {
      return { success: false, reason: `stop:compliance:${compliance.blockedReason ?? 'blocked'}` }
    }

    // Generate personalized re-engagement email using contact context
    // generatePersonalizedEmail accepts leadId param but works with contactId
    const emailContext = {
      leadId:           contactId,
      firstName:        contact.first_name || 'there',
      lastName:         contact.last_name || '',
      email:            contact.email,
      motivation_type:  contact.contact_type ?? undefined,
      lead_score:       contact.engagement_score ?? undefined,
    }

    const { subject, body, fromName } = await generatePersonalizedEmail(emailContext)

    // assembleEmail() runs inside dispatchEmail() — do NOT pre-assemble.
    await dispatchEmail({
      brokerageId:    contact.brokerage_id,
      agentId:        contact.agent_id,
      from:           fromName,
      to:             contact.email,
      subject,
      html:           body,
      channelPurpose: 'campaign',
      systemSource:   'ai_isa',
      contactId,
      metadata:       { contactId, source: 'ai_isa_contact_reengage' },
    })

    // Log outreach on the CONTACT entity (not lead)
    await logISAOutreach({
      brokerageId: contact.brokerage_id,
      agentId:     contact.agent_id,
      entity:      { entityType: 'contact', contactId },
      channel:     'email',
      subject,
      bodySnippet: body.substring(0, 500),
      compliancePassed: true,
    })

    // Notify the agent via activity record
    // activities has no metadata column — audit data goes into notes as JSON
    await supabase.from('activities').insert({
      agent_id:      contact.agent_id,
      contact_id:    contactId,
      brokerage_id:  contact.brokerage_id,
      activity_type: 'isa_contact_reengage',
      title:         'AI-ISA sent a re-engagement email',
      description:   `AI-ISA reached out to ${contact.first_name} on your behalf. Subject: "${subject}"`,
      status:        'completed',
      priority:      'medium',
      notes:         JSON.stringify({ source: 'ai_isa_contact_reengage', subject }),
    })

    return {
      success:   true,
      emailSent: true,
      contactId,
    }

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[initiateAIISAContactEngagement] Error:', message)

    // automation_errors: no entity_type/entity_id columns — use context_json
    await createServiceClient()
      .from('automation_errors')
      .insert({
        workflow_name:  'ai_isa_contact_engagement',
        error_message:  message,
        context_json:   JSON.stringify({ contactId }),
        severity:       'high',
        status:         'new',
      })
      .then(() => void 0)

    return { success: false, error: message }
  }
}
