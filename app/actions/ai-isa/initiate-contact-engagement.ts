'use server'

import { createServiceClient } from '@/lib/supabase/service'
import { getAgentContext } from '@/lib/identity/get-agent-context'
import { engageContact } from './engage-contact'

/**
 * initiateAIISAContactEngagement
 *
 * Thin auth + tenant-scoping wrapper around the canonical contact-side
 * engagement engine (engageContact). It exists as the public entry point used
 * by the stale-contact cron, the stale-contacts dashboard, and ghost
 * re-engagement — all of which previously hit a separate email-only
 * implementation. That duplicate engine has been removed; this now delegates to
 * engageContact so every caller gets the full consent-aware channel matrix
 * (email / sms / direct_mail), the DNC / active-transaction / under-contract /
 * max-touches stops, and the kernel compliance gate from one place.
 *
 * AUTH: Permitted callers are
 *   1. UI/session-authed server actions (verify ctx.brokerageId matches the
 *      contact row's brokerage_id).
 *   2. Internal trusted callers (cron stale-contact-monitor — already auth'd
 *      via verifyCronAuth at the route layer — and ghost-reengagement which
 *      runs inside cron). CRON_SECRET must be set in env to permit this.
 */
export async function initiateAIISAContactEngagement(contactId: string): Promise<{
  success: boolean
  emailSent?: boolean
  contactId?: string
  channel?: string
  reason?: string
  error?: string
}> {
  const supabase = createServiceClient()

  try {
    // ── AUTH GATE ────────────────────────────────────────────────────────
    const ctx = await getAgentContext()
    const hasSession = ctx.isAuthenticated && !!ctx.brokerageId
    const isTrustedInternal = !hasSession && !!process.env.CRON_SECRET
    if (!hasSession && !isTrustedInternal) {
      return { success: false, reason: 'Unauthorized' }
    }

    // Resolve the contact's brokerage and enforce tenant scoping for session callers.
    let contactQuery = supabase
      .from('contacts')
      .select('id, brokerage_id, agent_id')
      .eq('id', contactId)
    if (hasSession && ctx.brokerageId) {
      contactQuery = contactQuery.eq('brokerage_id', ctx.brokerageId)
    }
    const { data: contact, error: contactError } = await contactQuery.maybeSingle()

    if (contactError || !contact) {
      return { success: false, reason: 'Contact not found' }
    }
    if (hasSession && ctx.brokerageId && contact.brokerage_id !== ctx.brokerageId) {
      return { success: false, reason: 'Forbidden' }
    }
    // Converted contacts have an assigned agent; nurture runs on the contact.
    if (!contact.agent_id) {
      return { success: false, reason: 'Contact not yet assigned to agent' }
    }

    // ── DELEGATE to the canonical engine ───────────────────────────────────
    const result = await engageContact({
      contactId,
      brokerageId: contact.brokerage_id as string,
      reason: 'reactivation',
      actorId: ctx.userId || undefined,
    })

    return {
      success: result.success,
      emailSent: result.success && result.channel === 'email',
      contactId,
      channel: result.channel,
      reason: result.reason,
      error: result.error,
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
