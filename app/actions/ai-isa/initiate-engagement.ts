'use server'

import { createServiceClient } from '@/lib/supabase/service'
import {
  generatePersonalizedEmail,
  logEmailActivity,
  generateHeyGenVideo,
  embedVideoInEmail,
  shouldTriggerDirectMail,
  triggerDirectMailCampaign,
} from '@/lib/ai-isa'
import {
  logISAOutreach,
  checkMaxTouches,
  checkUnderContractPause,
} from '@/lib/ai-isa/isa-outreach-logger'
import { handleISAQualificationStarted } from '@/lib/kernel/lead-acquisition-handlers'
import { evaluateOutbound } from '@/lib/kernel'
import { dispatchEmail } from '@/lib/providers/dispatch'

export async function initiateAIISAEngagement(leadId: string) {
  console.log('[v0] Initiating AI ISA engagement for lead:', leadId)
  
  const supabase = createServiceClient()
  
  try {
    // Get lead details
    const { data: lead, error: leadError } = await supabase
      .from('leads')
      .select('*')
      .eq('id', leadId)
      .single()
    
    if (leadError || !lead) {
      throw new Error(`Lead not found: ${leadId}`)
    }
    
    // Validate lead is eligible for AI ISA (not assigned to agent yet)
    if (lead.agent_id) {
      return { success: false, reason: 'Lead already assigned to agent' }
    }

    // Check if email is available
    if (!lead.email) {
      return { success: false, reason: 'No email available' }
    }

    // ── Step A: Hard stops 1 + 2 (lead-level) ────────────────────────────────
    if (lead.lifecycle_state === 'representation') {
      return { success: false, reason: 'stop:representation' }
    }
    if (lead.is_active === false) {
      return { success: false, reason: 'stop:inactive' }
    }

    // Resolve contact_id if present (lead may have an associated contact)
    const contactId: string | null = lead.contact_id ?? null

    // ── Step B: Hard stops 3 + 4 (contact-level) ─────────────────────────────
    if (contactId) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('dnc_status, isa_reengage_allowed')
        .eq('id', contactId)
        .maybeSingle()

      if (contact?.dnc_status === true) {
        return { success: false, reason: 'stop:dnc' }
      }
      if (contact?.isa_reengage_allowed === false) {
        return { success: false, reason: 'stop:reengage_blocked' }
      }
    }

    // ── Step C: Under-contract pause ─────────────────────────────────────────
    if (contactId) {
      const paused = await checkUnderContractPause(
        lead.brokerage_id,
        contactId,
        'lead',
        leadId,
      )
      if (paused) {
        return { success: false, reason: 'paused:under_contract' }
      }
    }

    // ── Step D: Max touches check ─────────────────────────────────────────────
    const canContinue = await checkMaxTouches(leadId, 'lead', lead.brokerage_id)
    if (!canContinue) {
      return { success: false, reason: 'stop:max_touches' }
    }

    // Step 1: Generate personalized email
    const emailContext = {
      leadId: lead.id,
      firstName: lead.first_name || 'there',
      lastName: lead.last_name || '',
      email: lead.email,
      motivation_type: lead.motivation_type,
      property_interest: lead.property_interest,
      budget_min: lead.budget_min,
      budget_max: lead.budget_max,
      timeline: lead.timeline,
      lead_score: lead.lead_score
    }
    
    const { subject, body, fromName } = await generatePersonalizedEmail(emailContext)
    
    // Step 2: Generate avatar + voice video (non-blocking)
    const videoContext = {
      leadId: lead.id,
      firstName: lead.first_name || 'there',
      motivation_type: lead.motivation_type,
      property_interest: lead.property_interest,
      timeline: lead.timeline
    }
    
    const videoResult = await generateHeyGenVideo(videoContext)
    const finalEmailBody = await embedVideoInEmail(body, videoResult.videoUrl)
    
    // ── Step F: evaluateOutbound — stop 5 ────────────────────────────────────
    const compliance = await evaluateOutbound({
      brokerageId: lead.brokerage_id,
      entityType:  'lead',
      entityId:    leadId,
      channel:     'email',
    })
    if (!compliance.allowed) {
      return { success: false, reason: `stop:compliance:${compliance.reason ?? 'blocked'}` }
    }

    // ── Step G: Send via dispatch layer (honors kernel/providers selection) ──
    await dispatchEmail({
      brokerageId: lead.brokerage_id,
      from:        fromName,
      to:          lead.email,
      subject,
      html:        finalEmailBody,
      text:        finalEmailBody.replace(/<[^>]+>/g, ''),
      metadata:    { leadId, source: 'ai_isa' },
    })

    const emailSent = true

    // ── Step H: Log outreach ──────────────────────────────────────────────────
    await logISAOutreach({
      brokerageId:  lead.brokerage_id,
      entity:       { entityType: 'lead', leadId },
      channel:      'email',
      subject,
      bodySnippet:  finalEmailBody.substring(0, 500),
    })

    // ── Step I: Transition to isa_qualifying if unconsented ───────────────────
    if (lead.lifecycle_state === 'unconsented') {
      await handleISAQualificationStarted({
        leadId,
        brokerageId: lead.brokerage_id,
      })
    }

    // Log legacy email activity
    await logEmailActivity(leadId, lead.brokerage_id, emailSent)
    
    // Step 4: Check if direct mail should be triggered
    const shouldSendMail = await shouldTriggerDirectMail(leadId)
    
    if (shouldSendMail) {
      console.log('[v0] Triggering direct mail for lead:', leadId)
      
      await triggerDirectMailCampaign({
        leadId: lead.id,
        firstName: lead.first_name || '',
        lastName: lead.last_name || '',
        motivation_type: lead.motivation_type,
        property_interest: lead.property_interest
        // Address fields would come from enrichment data
      })
    }
    
    return {
      success: true,
      emailSent,
      videoGenerated: videoResult.success,
      directMailTriggered: shouldSendMail
    }
    
  } catch (error: any) {
    console.error('[v0] AI ISA engagement error:', error)
    
    // Log error
    await supabase.from('automation_errors').insert({
      workflow_name: 'ai_isa_engagement',
      error_message: error.message,
      context_json: JSON.stringify({ leadId }),
      severity: 'high',
      status: 'new',
      created_at: new Date().toISOString()
    })
    
    return {
      success: false,
      error: error.message
    }
  }
}

export async function getAIISAEngagementStatus(leadId: string) {
  const supabase = createServiceClient()
  
  // Get all AI ISA activities for this lead
  const { data: activities } = await supabase
    .from('activities')
    .select('*')
    .eq('contact_id', leadId)
    .in('activity_type', ['ai_isa_email', 'ai_isa_conversation', 'ai_isa_qualification', 'ai_isa_direct_mail'])
    .order('created_at', { ascending: false })
  
  // Get message count
  const { data: messages } = await supabase
    .from('messages')
    .select('id, direction')
    .eq('contact_id', leadId)
    .eq('type', 'email')
  
  const inboundCount = messages?.filter(m => m.direction === 'inbound').length || 0
  const outboundCount = messages?.filter(m => m.direction === 'outbound').length || 0
  
  // Get current lead stage
  const { data: lead } = await supabase
    .from('leads')
    .select('lead_stage, lead_score, agent_id')
    .eq('id', leadId)
    .single()
  
  return {
    activities: activities || [],
    conversationStats: {
      inboundMessages: inboundCount,
      outboundMessages: outboundCount,
      totalExchanges: Math.max(inboundCount, outboundCount)
    },
    currentStage: lead?.lead_stage || 'new',
    leadScore: lead?.lead_score || 0,
    assignedToAgent: !!lead?.agent_id
  }
}
