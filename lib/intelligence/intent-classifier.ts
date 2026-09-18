// ROUTED, was raw. This file used to pull generateObject straight from the "ai"
// SDK and pass resolveModel('anthropic/claude-sonnet-4-20250514') — the raw
// lane, which books NO ai_tool_usage row.
//
// THE PREVIOUS LINE IS DELIBERATELY NOT SPELLED AS AN IMPORT STATEMENT, and that
// is not fussiness. scripts/data-guard-guard.ts:51 tests its raw-SDK regex
// against UNSTRIPPED source, so a tombstone containing the literal import syntax
// reads to it as a live import — the exact "A TOMBSTONE IS NOT A CALL SITE"
// failure CLAUDE.md §2 records five guards hitting in one wave. Written the
// obvious way, this comment pinned the file in that guard's baseline as an
// unmigrated raw-SDK importer forever, while the migration it describes had
// already happened. (scripts/ai-spend-booked-guard.ts strips comments and was
// never fooled; that difference is the whole argument for stripping.)
//
// The routing key below is pinned to that same
// model (MODEL_CONFIG["claude-sonnet"] IS anthropic/claude-sonnet-4-20250514),
// so the model, the prompt and the output are unchanged; what is added is the
// cost ledger, the fair-use pre-flight and the Data Guard redaction.
import { generateObjectRouted } from '@/lib/ai/models'
import { z } from 'zod'
import { createServiceClient } from '@/lib/supabase/service'
import { KernelEvent } from '@/lib/kernel/events'

export type IntentCategory =
  | 'schedule_showing'
  | 'price_reduction_request'
  | 'cancel_transaction'
  | 'ready_to_offer'
  | 'financing_question'
  | 'inspection_concern'
  | 'referral_inquiry'
  | 'general_question'
  | 'complaint'
  | 'positive_feedback'
  | 'refinance_interest'
  | 'unsubscribe'

export interface ClassificationResult {
  intent_primary: IntentCategory
  intent_secondary: IntentCategory | null
  confidence: number // 0-100
  suggested_action: string
  urgency: 'low' | 'medium' | 'high' | 'critical'
}

const INTENT_VALUES: IntentCategory[] = [
  'schedule_showing',
  'price_reduction_request',
  'cancel_transaction',
  'ready_to_offer',
  'financing_question',
  'inspection_concern',
  'referral_inquiry',
  'general_question',
  'complaint',
  'positive_feedback',
  'refinance_interest',
  'unsubscribe',
]

const classificationSchema = z.object({
  intent_primary: z.enum(INTENT_VALUES as [string, ...string[]]),
  intent_secondary: z.enum(INTENT_VALUES as [string, ...string[]]).nullable(),
  confidence: z.number().min(0).max(100),
  suggested_action: z.string(),
  urgency: z.enum(['low', 'medium', 'high', 'critical']),
})

export async function classifyIntent(
  message: string,
  contactId: string,
  conversationId: string,
  brokerageId: string
): Promise<ClassificationResult> {
  const supabase = createServiceClient()

  // Step 1: Call Claude to classify intent
  const { object: result } = await generateObjectRouted({
    feature: 'inbound_intent_classification',
    brokerageId,
    schema: classificationSchema,
    maxTokens: 200,
    system: `You are a real estate message intent classifier. Classify the incoming message into exactly one primary intent and optionally one secondary intent.

Valid intents:
- schedule_showing: Request to view a property
- price_reduction_request: Asking for price reduction or negotiation
- cancel_transaction: Signals wanting to cancel or back out
- ready_to_offer: Signals readiness to make an offer
- financing_question: Questions about mortgages, loans, financing
- inspection_concern: Issues or questions about home inspection
- referral_inquiry: Asking for agent referrals or recommendations
- general_question: General real estate questions
- complaint: Expressing dissatisfaction or complaint
- positive_feedback: Praise or positive feedback
- refinance_interest: Interest in refinancing
- unsubscribe: Requesting to stop communications / DNC

Set urgency based on time-sensitivity:
- critical: Cancel signals, urgent showings needed today
- high: Ready to offer, complaints, unsubscribe requests
- medium: Scheduling requests, financing questions
- low: General questions, positive feedback

Return the classification with a confidence score (0-100) and a brief suggested_action for the agent.`,
    prompt: message,
  })

  // Step 2: Confidence routing
  let finalResult = result as ClassificationResult

  // Low confidence - flag for human review
  if (result.confidence < 55) {
    finalResult = {
      ...result,
      intent_primary: 'general_question',
      intent_secondary: result.intent_primary as IntentCategory,
    } as ClassificationResult

    await supabase.from('smart_assistant_suggestions').insert({
      brokerage_id: brokerageId,
      title: 'Low-confidence message classification',
      description: `Message: "${message.slice(0, 200)}..." - Original classification: ${result.intent_primary} (${result.confidence}% confidence)`,
      priority: 'low',
      suggestion_type: 'review_needed',
      metadata: { contact_id: contactId }, // no contact_id column on smart_assistant_suggestions
    })
  }

  // Cancel transaction signal - high priority intervention
  if (result.intent_primary === 'cancel_transaction' && result.confidence >= 70) {
    // proactive_interventions requires NOT-NULL transaction_id (FK→transactions).
    // Resolve the contact's most recent active transaction; only insert if one exists.
    const { data: txn } = await supabase
      .from('transactions')
      .select('id')
      .eq('contact_id', contactId)
      .not('status', 'in', '(closed,lost)')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (txn?.id) {
      await supabase.from('proactive_interventions').insert({
        transaction_id: txn.id,
        brokerage_id: brokerageId,
        issue_detected: 'Customer cancellation signal detected',
        severity: 'high',
        ai_recommendation: result.suggested_action,
      })
    }

    await supabase.from('smart_assistant_suggestions').insert({
      brokerage_id: brokerageId,
      title: 'Urgent: Cancel transaction signal detected',
      description: `Customer message indicates potential cancellation. Confidence: ${result.confidence}%. Recommended action: ${result.suggested_action}`,
      priority: 'high',
      suggestion_type: 'intervention_needed',
      metadata: { contact_id: contactId },
    })
  }

  // Unsubscribe / DNC request
  if (result.intent_primary === 'unsubscribe' && result.confidence >= 60) {
    await supabase.from('smart_assistant_suggestions').insert({
      brokerage_id: brokerageId,
      title: 'DNC request detected',
      description: `Contact may want to unsubscribe from communications. Review and update contact preferences.`,
      priority: 'high',
      suggestion_type: 'compliance',
      metadata: { contact_id: contactId },
    })
  }

  // Ready to offer signal
  if (result.intent_primary === 'ready_to_offer' && result.confidence >= 75) {
    await supabase.from('smart_assistant_suggestions').insert({
      brokerage_id: brokerageId,
      title: 'Offer signal detected',
      description: result.suggested_action,
      priority: 'high',
      suggestion_type: 'opportunity',
      metadata: { contact_id: contactId },
    })
  }

  // Step 3: Update conversation with classification
  await supabase
    .from('conversations')
    .update({
      intent_primary: finalResult.intent_primary,
      intent_secondary: finalResult.intent_secondary,
      intent_confidence: finalResult.confidence,
      intent_classified_at: new Date().toISOString(),
    })
    .eq('id', conversationId)

  // Step 4: Kernel event — audit row + reactor (`payload` → `metadata`, the column
  // every reader uses).
  const { emitKernelEvent } = await import('@/lib/kernel/emit')
  await emitKernelEvent({
    event: KernelEvent.INTENT_CLASSIFIED,
    brokerageId,
    entityType: 'conversation',
    entityId: conversationId,
    contactId: contactId ?? undefined,
    metadata: {
      intent: finalResult.intent_primary,
      intent_secondary: finalResult.intent_secondary,
      confidence: finalResult.confidence,
      urgency: finalResult.urgency,
      contact_id: contactId,
    },
  })

  return finalResult
}
