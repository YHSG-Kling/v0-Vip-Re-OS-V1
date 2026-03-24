'use server'

/**
 * app/actions/contacts/update-channel-controls.ts
 *
 * Server actions for managing per-contact channel preferences:
 *   - preferred_channel  — which channel the AI ISA should use first
 *   - social_handles     — platform handle map {facebook, instagram, linkedin, twitter}
 *   - call_stop_flag     — kill switch that blocks all inbound + outbound calls
 *
 * Also syncs call_stop_flag to the associated lead row when present.
 */

import { createServiceClient } from '@/lib/supabase/service'
import { revalidatePath } from 'next/cache'

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

    if (contactError) {
      return { success: false, error: contactError.message }
    }

    // Sync call_stop_flag to any associated leads
    if (input.callStopFlag !== undefined) {
      await supabase
        .from('leads')
        .update({ call_stop_flag: input.callStopFlag })
        .eq('contact_id', input.contactId)
    }

    // Sync preferred_channel to any associated leads
    if (input.preferredChannel !== undefined) {
      await supabase
        .from('leads')
        .update({ preferred_channel: input.preferredChannel })
        .eq('contact_id', input.contactId)
    }

    // Log the change as a compliance event for audit trail
    if (input.callStopFlag !== undefined) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('brokerage_id')
        .eq('id', input.contactId)
        .single()

      if (contact) {
        await supabase.from('compliance_events').insert({
          brokerage_id: contact.brokerage_id,
          gate_name: input.callStopFlag
            ? 'call_stop_flag_set'
            : 'call_stop_flag_removed',
          allowed: true,
          violations: [],
          blocked_reason: input.callStopFlag
            ? 'Contact requested no calls — call_stop_flag set'
            : null,
          actor_role: 'agent',
          actor_user_id: 'system',
          entity_type: 'contact',
          entity_id: input.contactId,
          message_type: 'phone',
          created_at: new Date().toISOString(),
        })
      }
    }

    revalidatePath(`/dashboard/contacts`)

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
  const supabase = createServiceClient()

  const { data } = await supabase
    .from('contacts')
    .select('preferred_channel, social_handles, call_stop_flag')
    .eq('id', contactId)
    .single()

  return {
    preferredChannel: (data?.preferred_channel as PreferredChannel) ?? null,
    socialHandles: (data?.social_handles as SocialHandles) ?? null,
    callStopFlag: data?.call_stop_flag ?? false,
  }
}
