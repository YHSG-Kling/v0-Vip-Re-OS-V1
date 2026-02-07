'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { generatePersonalizedEmail, logEmailActivity } from '@/lib/ai-isa/email-generator'
import { generateHeyGenVideo, embedVideoInEmail } from '@/lib/ai-isa/video-generator'
import { shouldTriggerDirectMail, triggerDirectMailCampaign } from '@/lib/ai-isa/direct-mail-trigger'

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
      console.log('[v0] Lead already assigned to agent, skipping AI ISA')
      return { success: false, reason: 'Lead already assigned to agent' }
    }
    
    // Check if email is available
    if (!lead.email) {
      console.log('[v0] No email available for lead')
      return { success: false, reason: 'No email available' }
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
    
    // Step 3: Send email (stub - implement actual email sending)
    // TODO: Integrate with email service (SendGrid, Resend, etc.)
    console.log('[v0] Would send email to:', lead.email)
    console.log('[v0] Subject:', subject)
    console.log('[v0] Body preview:', finalEmailBody.substring(0, 200))
    
    const emailSent = true // Assume success for now
    
    // Log email activity
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
