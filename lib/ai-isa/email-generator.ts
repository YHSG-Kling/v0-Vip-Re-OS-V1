'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { buildFirstTouchEmail } from '@/lib/ai-isa/first-touch-copy'
import { generationalCohortFromAge, type GenerationalCohort } from '@/lib/kernel/education'

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
  /** Brand voice system block from loadBrandVoicePrompt — injected into email tone/vocabulary */
  brandVoiceBlock?: string
  /** Brokerage brand tagline (brand voice) — carried into the email sign-off. */
  brandTagline?: string | null
  /** Assistant name from ai_identity_profiles — used as the email sign-off name */
  assistantName?: string
  /** Persona label from ai_identity_profiles — shown in greeting context */
  personaLabel?: string | null
  /** The lead's generational cohort (from enrichment age) — tones the opener them-first. */
  cohort?: GenerationalCohort
}

export async function generatePersonalizedEmail(context: LeadEmailContext) {
  const signingName = context.assistantName ?? 'Your Real Estate Team'

  // Resolve cohort from the explicit value, else from any age in the enrichment context.
  const enrichAge = context.enrichment_context?.age
  const cohort: GenerationalCohort =
    context.cohort ?? (typeof enrichAge === 'number' ? generationalCohortFromAge(enrichAge) : 'unknown')

  // Cohort-toned + brand-voiced body (pure, Fair-Housing safe). The compliance gate +
  // brand prohibited-word screen still run downstream before any send.
  const { subject, body } = buildFirstTouchEmail({
    firstName: context.firstName,
    cohort,
    propertyInterest: context.property_interest ?? null,
    timeline: context.timeline ?? null,
    motivationType: context.motivation_type ?? null,
    budgetMin: context.budget_min ?? null,
    budgetMax: context.budget_max ?? null,
    assistantName: signingName,
    personaLabel: context.personaLabel ?? null,
    brandTagline: context.brandTagline ?? null,
    hasVideo: true,
  })

  return {
    subject,
    body,
    fromName: signingName,
    replyTo: context.email,
  }
}

export async function logEmailActivity(
  leadId: string, 
  brokerageId: string,
  emailSent: boolean,
  errorMessage?: string
) {
  const supabase = createServiceClient()
  
  // Agent task (correct location, no changes) — activity_type: ai_isa_email
  await supabase.from('activities').insert({
    contact_id: null, // leads are NOT contacts — activities.contact_id FKs contacts(id)
    entity_type: 'lead',
    entity_id: leadId,
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
