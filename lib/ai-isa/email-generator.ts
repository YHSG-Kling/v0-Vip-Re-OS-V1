'use server'

import { createServiceClient } from '@/lib/supabase/service'

export interface LeadEmailContext {
  leadId: string
  firstName: string
  lastName: string
  email: string
  motivation_type?: string
  property_interest?: string
  budget_min?: number
  budget_max?: number
  timeline?: string
  lead_score?: number
  enrichment_context?: Record<string, any>
}

export async function generatePersonalizedEmail(context: LeadEmailContext) {
  console.log('[v0] Generating personalized email for lead:', context.leadId)
  
  // Generate email content focused on THEM, not us
  const emailBody = `Hi ${context.firstName},

I noticed you're exploring ${context.property_interest || 'properties'} in the area${context.timeline ? ` and looking to ${context.timeline}` : ''}. 

${context.motivation_type ? `Understanding that you're ${context.motivation_type}, I wanted to share some insights that might be helpful for your situation.` : 'I wanted to reach out with some information that might be valuable for you.'}

${context.budget_min && context.budget_max ? `Based on your budget range of $${context.budget_min.toLocaleString()} to $${context.budget_max.toLocaleString()}, ` : ''}I've put together a personalized video introduction below that explains exactly how our platform works to help you achieve your real estate goals.

[Video will be embedded here]

This isn't about pushing you into anything—it's about making sure you have the right information and support whenever you're ready to take the next step.

If you have any questions or just want to talk through your options, feel free to reply to this email. I'm here to help.

Best regards,
Your Real Estate Team`

  // Generate TCPA-compliant, deliverable subject line
  const subjectLine = context.motivation_type 
    ? `About Your ${context.property_interest || 'Property'} Search` 
    : `Information for ${context.firstName} - Real Estate Resources`

  return {
    subject: subjectLine,
    body: emailBody,
    fromName: 'Real Estate Support Team',
    replyTo: context.email
  }
}

export async function logEmailActivity(
  leadId: string, 
  brokerageId: string,
  emailSent: boolean,
  errorMessage?: string
) {
  const supabase = createServiceClient()
  
  await supabase.from('activities').insert({
    contact_id: leadId,
    brokerage_id: brokerageId,
    activity_type: 'ai_isa_email',
    title: emailSent ? 'AI ISA First Email Sent' : 'AI ISA Email Failed',
    description: emailSent 
      ? 'Personalized first-touch email sent by AI ISA system'
      : `Email send failed: ${errorMessage}`,
    status: emailSent ? 'completed' : 'failed',
    created_at: new Date().toISOString()
  })

  if (!emailSent && errorMessage) {
    await supabase.from('automation_errors').insert({
      workflow_name: 'ai_isa_first_email',
      error_message: errorMessage,
      context_json: JSON.stringify({ leadId }),
      severity: 'medium',
      status: 'new',
      created_at: new Date().toISOString()
    })
  }
}
