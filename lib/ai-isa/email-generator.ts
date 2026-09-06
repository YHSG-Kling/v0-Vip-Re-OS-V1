// NOT a server-action module (2026-09-03, lane R3-A; template
// lib/behavior-learning/preference-updater.ts:1-9). The module-level "use server"
// that stood here published generatePersonalizedEmail(context) (pure copy
// assembly) and logEmailActivity(leadId, brokerageId, …) as public HTTP doors
// with no gate — the second one a service client WRITING an activities row
// under a caller-supplied brokerageId: section 4's named IDOR shape, on a
// write. Every caller is in-process server code (re-verified 2026-09-03):
//   · lib/ai-isa/index.ts (the barrel), whose only value importers are the
//     "use server" actions app/actions/ai-isa/engage-contact.ts:30,
//     handle-inbound-email.ts:19 and initiate-engagement.ts:31
// so the directive published nothing anyone needed. `server-only` makes a future
// client import fail at build time instead of bundling the service credential.
// brokerageId is now an IN-PROCESS CONTRACT: with the door closed, the server
// caller that supplies it is the gate.
import "server-only"

import { createServiceClient } from '@/lib/supabase/service'
import { collectError } from '@/lib/errors/collect-error'
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
  // This row is the ONLY record of whether the ISA's first-touch email went out
  // — it is written for both the sent and the failed case. Losing it silently
  // means the OS cannot say whether a lead was ever contacted, which is exactly
  // the question the ISA's next-touch logic asks.
  const { error: activityError } = await supabase.from('activities').insert({
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

  if (activityError) {
    console.error('[ai-isa/email-generator] ISA email activity NOT recorded:', activityError.message)
  }

  if (!emailSent && errorMessage) {
    await collectError({
      workflowName: 'ai_isa_first_email',
      errorMessage,
      severity: 'medium',
      brokerageId,
      leadId,
      context: { leadId },
      client: supabase,
    })
  }
}
