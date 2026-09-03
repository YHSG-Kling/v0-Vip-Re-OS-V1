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

import { createServiceClient } from '@/lib/supabase/service'
import { requireCaller } from '@/lib/auth/require-caller'
import { isCrmContactStaff } from '@/lib/auth/crm-contact-staff'
import { revalidatePath } from 'next/cache'

// Both actions in this file were unauthenticated. updateChannelControls
// could be called by any signed-in user (or even an unauthenticated client
// via the RPC layer) to flip the call_stop_flag on ANY contact (suppressing
// their phone), change their preferred_channel, or update their social
// handles — including injecting attacker-controlled URLs that could fool
// the AI ISA into making outbound to attacker-controlled handles.
//
// Fix (wave 14): require an authenticated session + verify the contact belongs
// to the caller's brokerage before any read or mutation.
//
// ── WHAT THAT FIX STILL LEFT OPEN (wave 26, lane SEC3) ───────────────────────
//
// Tenancy was doing a role's job. This function read the caller's
// `users.brokerage_id`, read the contact's `brokerage_id`, and admitted on
// EQUALITY ALONE — there was no role test at all. `users.user_type` can hold
// `contact`, `vendor` and `lender`, and those rows carry a brokerage_id, so
// every such seat passed this gate for EVERY contact in the brokerage.
//
// On a READ that is a §5 violation. Here it is worse, because what it gates is
// a WRITE: `updateChannelControls` flips `call_stop_flag` — the kill switch that
// suppresses a contact's phone across inbound AND outbound — rewrites
// `preferred_channel`, and rewrites `social_handles`, the handle map the AI ISA
// dials out against. A vendor seat could silence another client's phone, or
// point that client's outbound at handles the vendor controls, and the only
// record would be a compliance_events row naming the vendor as `actor_role:
// 'agent'`. This is a back-office surface (the CRM contact pane and the
// communications inbox) and the roster is now asked explicitly.
//
// Three other things this gate did wrong, all of them §3:
//   · The `users` read discarded `error`. supabase-js RESOLVES a refused query,
//     so an RLS refusal of the caller's own row came back as `data: null` and
//     was reported as 'Unauthorized' — a permissions outage wearing a
//     "you aren't signed in" label. `requireCaller()` reads that error and
//     returns `reason: 'unreadable'`.
//   · The `contacts` read discarded `error` too, so a refused ownership read was
//     reported as 'Contact not found' — a clean negative, which is the one
//     answer a refusal must never be laundered into. It now has its own
//     sentence, 'Access check failed'.
//   · An unresolvable role was invisible. `requireCaller()` returns `user_type`
//     EXACTLY AS STORED — not defaulted to "agent" — and `isCrmContactStaff`
//     answers `false` to null, which is the fail-closed reading (§4).
//
// The ownership read stays on the SERVICE client on purpose: a contact in
// another tenant must come BACK so the comparison can refuse it. Read through
// RLS it would come back empty and be reported as 'Contact not found' — a
// different answer wearing the same shape.
async function authorizeContactAccess(contactId: string): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  // Identity and tenant from the SESSION (§4), via the survivor — never from a
  // parameter, and never from a thirty-third file-local copy of this read.
  const caller = await requireCaller()
  if (!caller.ok) {
    return { ok: false, error: caller.reason === 'unauthenticated' ? 'Unauthorized' : caller.error }
  }

  // THE TEST THAT WAS MISSING — asked BEFORE the service client is built and
  // before the first privileged read, so a refusal costs nothing and reads
  // nothing.
  if (!isCrmContactStaff(caller.userType)) return { ok: false, error: 'Forbidden' }

  const svc = createServiceClient()
  const { data: contact, error: contactError } = await svc
    .from('contacts')
    .select('brokerage_id')
    .eq('id', contactId)
    .maybeSingle()
  if (contactError) return { ok: false, error: 'Access check failed' }
  if (!contact || !contact.brokerage_id) return { ok: false, error: 'Contact not found' }
  if (contact.brokerage_id !== caller.brokerageId) return { ok: false, error: 'Forbidden' }
  return { ok: true, userId: caller.userId, brokerageId: caller.brokerageId }
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

    // COUNTED, not merely error-checked (§3): an UPDATE that matches NOTHING
    // also RESOLVES — `error` is null and the call is byte-identical to one that
    // worked. The gate above already proved this contact is in `auth.brokerageId`,
    // so zero rows here means the predicate refused, and reporting that as
    // "saved" would tell an agent the phone is suppressed when it is not.
    const { data: updatedContacts, error: contactError } = await supabase
      .from('contacts')
      .update(updates)
      .eq('id', input.contactId)
      .eq('brokerage_id', auth.brokerageId)
      .select('id')

    if (contactError) {
      return { success: false, error: contactError.message }
    }
    if (!updatedContacts || updatedContacts.length === 0) {
      return { success: false, error: 'Contact not found' }
    }

    // Sync call_stop_flag to any associated leads (brokerage-scoped).
    //
    // NOT counted, deliberately, and this is the caller's call rather than the
    // client's: a contact with no lead row is the ordinary case, so zero rows
    // here is a legitimate outcome. A REFUSAL is not, and it was being dropped —
    // supabase-js resolves it, so `await` alone threw the error away and the
    // contact's kill switch could be set while the lead the dialer actually
    // reads kept calling. That must not vanish unsaid.
    if (input.callStopFlag !== undefined) {
      const { error: leadStopError } = await supabase
        .from('leads')
        .update({ call_stop_flag: input.callStopFlag })
        .eq('contact_id', input.contactId)
        .eq('brokerage_id', auth.brokerageId)
      if (leadStopError) {
        return {
          success: false,
          error: `Contact updated, but the lead's call-stop flag was REFUSED and may still allow calls: ${leadStopError.message}`,
        }
      }
    }

    // Sync preferred_channel to any associated leads (brokerage-scoped)
    if (input.preferredChannel !== undefined) {
      const { error: leadChannelError } = await supabase
        .from('leads')
        .update({ preferred_channel: input.preferredChannel })
        .eq('contact_id', input.contactId)
        .eq('brokerage_id', auth.brokerageId)
      if (leadChannelError) {
        console.error(
          `[update-channel-controls] leads.preferred_channel sync REFUSED for contact ${input.contactId} — the contact row carries the new channel and the lead row does not:`,
          leadChannelError.message,
        )
      }
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

export interface ContactChannelControlsResult {
  /** false = the read did NOT happen. The three fields below mean nothing. */
  ok: boolean
  error?: string
  preferredChannel: PreferredChannel | null
  socialHandles: SocialHandles | null
  callStopFlag: boolean
}

// Lightweight read for UI hydration.
//
// A REFUSAL USED TO RENDER AS "CALLS ARE ALLOWED". This returned the same
// all-nulls / `callStopFlag: false` object for three completely different
// facts: the contact really has no preferences, the caller was FORBIDDEN, and
// the ownership read was REFUSED by the database. The panel then painted the
// kill switch OFF and enabled Save. For a TCPA suppression flag that is the one
// direction the failure must not fall — "nobody could check" must never render
// as "checked, and this contact may be called" (§4, fail closed).
//
// `ok` is now the discriminant, and it is the ONLY honest way to report this:
// the field being read is a boolean whose `false` is a real, meaningful value,
// so there is no in-band value left to mean "unknown".
export async function getContactChannelControls(
  contactId: string,
): Promise<ContactChannelControlsResult> {
  const auth = await authorizeContactAccess(contactId)
  if (!auth.ok) {
    return { ok: false, error: auth.error, preferredChannel: null, socialHandles: null, callStopFlag: false }
  }

  const supabase = createServiceClient()
  // `.maybeSingle()`, not `.single()`: `.single()` raises PGRST116 for zero rows,
  // which made "this contact has no row here" indistinguishable from a refused
  // read once the error is actually looked at. maybeSingle separates them.
  const { data, error } = await supabase
    .from('contacts')
    .select('preferred_channel, social_handles, call_stop_flag')
    .eq('id', contactId)
    .eq('brokerage_id', auth.brokerageId)
    .maybeSingle()

  if (error) {
    return { ok: false, error: 'Access check failed', preferredChannel: null, socialHandles: null, callStopFlag: false }
  }
  if (!data) {
    return { ok: false, error: 'Contact not found', preferredChannel: null, socialHandles: null, callStopFlag: false }
  }

  return {
    ok: true,
    preferredChannel: (data.preferred_channel as PreferredChannel) ?? null,
    socialHandles: (data.social_handles as SocialHandles) ?? null,
    callStopFlag: data.call_stop_flag ?? false,
  }
}
