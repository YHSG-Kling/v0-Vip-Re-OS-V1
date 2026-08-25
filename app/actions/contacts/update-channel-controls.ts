'use server'

/**
 * app/actions/crm/contacts/update-channel-controls.ts
 *
 * Server actions for managing per-contact channel preferences:
 *   - preferred_channel  — which channel the AI ISA should use first
 *   - social_handles     — platform handle map {facebook, instagram, linkedin, twitter}
 *   - call_stop_flag     — kill switch that blocks all inbound + outbound calls
 *
 * Also syncs call_stop_flag to the associated lead row when present.
 */

import { createClient } from '@/lib/supabase/server'
import { createServiceClient } from '@/lib/supabase/service'
import { revalidatePath } from 'next/cache'

// Both actions in this file were unauthenticated. updateChannelControls
// could be called by any signed-in user (or even an unauthenticated client
// via the RPC layer) to flip the call_stop_flag on ANY contact (suppressing
// their phone), change their preferred_channel, or update their social
// handles — including injecting attacker-controlled URLs that could fool
// the AI ISA into making outbound to attacker-controlled handles.
//
// Fix: require an authenticated session + verify the contact belongs to
// caller's brokerage before any read or mutation.
async function authorizeContactAccess(contactId: string): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: 'Unauthorized' }
  const svc = createServiceClient()
  const { data: u } = await svc
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: 'Unauthorized' }
  const { data: contact } = await svc
    .from('contacts')
    .select('brokerage_id')
    .eq('id', contactId)
    .maybeSingle()
  if (!contact) return { ok: false, error: 'Contact not found' }
  if (contact.brokerage_id !== u.brokerage_id) return { ok: false, error: 'Forbidden' }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

export type PreferredChannel =
  | 'email'
  | 'sms'
  | 'phone'
  | 'direct_mail'
  | 'facebook'
  | 'instagram'
  | 'linkedin'
  | 'twitter'

export interface SocialHandles {
  facebook?: string
  instagram?: string
  linkedin?: string
  twitter?: string
}

export interface UpdateChannelControlsInput {
  contactId: string
  preferredChannel?: PreferredChannel
  socialHandles?: SocialHandles
  callStopFlag?: boolean
}

export interface UpdateChannelControlsResult {
  success: boolean
  error?: string
}

export async function updateChannelControls(
  input: UpdateChannelControlsInput
): Promise<UpdateChannelControlsResult> {
  const auth = await authorizeContactAccess(input.contactId)
  if (!auth.ok) return { success: false, error: auth.error }

  const supabase = createServiceClient()

  try {
    const updates: Record<string, unknown> = {}

    if (input.preferredChannel !== undefined) {
      updates.preferred_channel = input.preferredChannel
    }
    if (input.socialHandles !== undefined) {
      updates.social_handles = input.socialHandles
    }
    if (input.callStopFlag !== undefined) {
      updates.call_stop_flag = input.callStopFlag
    }

    if (Object.keys(updates).length === 0) {
      return { success: true }
    }

    const { error: contactError } = await supabase
      .from('contacts')
      .update(updates)
      .eq('id', input.contactId)
      .eq('brokerage_id', auth.brokerageId)

    if (contactError) {
      return { success: false, error: contactError.message }
    }

    // Sync call_stop_flag to any associated leads (brokerage-scoped)
    if (input.callStopFlag !== undefined) {
      await supabase
        .from('leads')
        .update({ call_stop_flag: input.callStopFlag })
        .eq('contact_id', input.contactId)
        .eq('brokerage_id', auth.brokerageId)
    }

    // Sync preferred_channel to any associated leads (brokerage-scoped)
    if (input.preferredChannel !== undefined) {
      await supabase
        .from('leads')
        .update({ preferred_channel: input.preferredChannel })
        .eq('contact_id', input.contactId)
        .eq('brokerage_id', auth.brokerageId)
    }

    // Log the change as a compliance event for audit trail
    if (input.callStopFlag !== undefined) {
      const { error: auditError } = await supabase.from('compliance_events').insert({
        brokerage_id: auth.brokerageId,
        gate_name: input.callStopFlag
          ? 'call_stop_flag_set'
          : 'call_stop_flag_removed',
        allowed: true,
        violations: [],
        blocked_reason: input.callStopFlag
          ? 'Contact requested no calls — call_stop_flag set'
          : null,
        actor_role: 'agent',
        actor_user_id: auth.userId,
        entity_type: 'contact',
        entity_id: input.contactId,
        message_type: 'phone',
        created_at: new Date().toISOString(),
      })
      if (auditError) {
        // The consent flag itself DID commit — the contacts update above is
        // error-checked and returns on failure — so the caller is still told the
        // truth by returning success. What did not happen is the audit trail of
        // WHO set the contact's call-stop flag and WHEN, which is what a TCPA
        // complaint is answered with. It must not vanish unsaid.
        console.error(
          `[update-channel-controls] compliance_events insert REFUSED for contact ${input.contactId} — the call_stop_flag change committed but is UNAUDITED:`,
          auditError.message,
        )
      }
    }

    revalidatePath(`/crm/contacts`)

    return { success: true }
  } catch (err: any) {
    return { success: false, error: err.message }
  }
}

// Lightweight read for UI hydration
export async function getContactChannelControls(contactId: string): Promise<{
  preferredChannel: PreferredChannel | null
  socialHandles: SocialHandles | null
  callStopFlag: boolean
}> {
  const auth = await authorizeContactAccess(contactId)
  if (!auth.ok) {
    return { preferredChannel: null, socialHandles: null, callStopFlag: false }
  }

  const supabase = createServiceClient()
  const { data } = await supabase
    .from('contacts')
    .select('preferred_channel, social_handles, call_stop_flag')
    .eq('id', contactId)
    .eq('brokerage_id', auth.brokerageId)
    .single()

  return {
    preferredChannel: (data?.preferred_channel as PreferredChannel) ?? null,
    socialHandles: (data?.social_handles as SocialHandles) ?? null,
    callStopFlag: data?.call_stop_flag ?? false,
  }
}
