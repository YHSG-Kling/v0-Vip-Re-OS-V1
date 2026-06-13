// lib/ai-isa/speed-to-lead.ts
//
// SPEED-TO-LEAD ENGINE — the sweeper that runs every minute (via cron) and
// ensures every AI-ISA-owned lead gets a first touch, and every newly-assigned
// contact gets a jump-in after the agent grace window.
//
// Two sweeps per brokerage:
//   1. LEADS: first_touched_at IS NULL + ai_isa_owner=true, created in last 24h.
//      Uses firstTouchDecision (lead path) + initiateAIISAEngagement.
//   2. CONTACTS: first_touched_at IS NULL, assigned (agent_id set) at least
//      graceMinutes ago, no agent touch (last_contacted_at IS NULL).
//      Uses firstTouchDecision (contact path) + engageContact.
//
// Idempotent: first_touched_at stamp is written atomically; a concurrent run
// on the same row produces the "already_first_touched" skip at the policy layer.
// Never throws the loop — per-row failures go to automation_errors.

import { createServiceClient } from "@/lib/supabase/service"
import { firstTouchDecision, DEFAULT_AGENT_GRACE_MINUTES } from "@/lib/ai-isa/speed-to-lead-policy"
import type { FirstTouchConsentInput } from "@/lib/ai-isa/speed-to-lead-policy"
import { initiateAIISAEngagement } from "@/app/actions/ai-isa/initiate-engagement"
import { engageContact }           from "@/app/actions/ai-isa/engage-contact"

// ── Types ──────────────────────────────────────────────────────────────────

export interface SpeedToLeadOpts {
  /** Override "now" for testing */
  now?:          Date
  /** Override agent grace window (minutes) */
  graceMinutes?: number
}

export interface SpeedToLeadResult {
  leadsTouched:    number
  contactsTouched: number
  skipped:         number
}

export interface SpeedToLeadDeps {
  supabase?: ReturnType<typeof createServiceClient>
  initiateEngagement?: typeof initiateAIISAEngagement
  contactEngagement?:  typeof engageContact
}

// ── Main entry ─────────────────────────────────────────────────────────────

export async function runSpeedToLead(
  brokerageId: string,
  opts: SpeedToLeadOpts = {},
  deps: SpeedToLeadDeps = {},
): Promise<SpeedToLeadResult> {
  const supabase = deps.supabase ?? createServiceClient()
  const doLeadEngagement    = deps.initiateEngagement ?? initiateAIISAEngagement
  const doContactEngagement = deps.contactEngagement  ?? engageContact

  const now          = opts.now          ?? new Date()
  const graceMinutes = opts.graceMinutes ?? DEFAULT_AGENT_GRACE_MINUTES

  let leadsTouched    = 0
  let contactsTouched = 0
  let skipped         = 0

  // ── Sweep 1: LEADS ────────────────────────────────────────────────────────
  // Bound the sweep to last 24h to avoid revisiting ancient records on every run.
  const leadCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  const { data: leads, error: leadsError } = await supabase
    .from("leads")
    .select(
      `id, brokerage_id, created_at, first_touched_at,
       email_verified, email_opt_out, mailing_address_verified,
       ai_isa_owner, lifecycle_state`,
    )
    .eq("brokerage_id", brokerageId)
    .eq("ai_isa_owner", true)
    .is("first_touched_at", null)
    .gte("created_at", leadCutoff)
    .limit(50) // safety cap per sweep

  if (leadsError) {
    await logError(supabase, brokerageId, "speed_to_lead_leads_query", leadsError.message)
  }

  for (const lead of leads ?? []) {
    try {
      const consent: FirstTouchConsentInput = {
        email_verified:           !!(lead.email_verified),
        email_opt_out:            !!(lead.email_opt_out),
        mailing_address_verified: !!(lead.mailing_address_verified),
      }

      const decision = firstTouchDecision({
        kind:           "lead",
        now,
        createdAt:      new Date(lead.created_at),
        firstTouchedAt: lead.first_touched_at ? new Date(lead.first_touched_at) : null,
        consent,
      })

      if (!decision.shouldTouch) {
        skipped++
        continue
      }

      // Dispatch via the canonical entry — already consent/channel gated
      const result = await doLeadEngagement(lead.id)

      if (result?.success !== false) {
        // Stamp first touch
        await supabase
          .from("leads")
          .update({
            first_touched_at:    now.toISOString(),
            first_touch_channel: decision.channel,
            updated_at:          now.toISOString(),
          })
          .eq("id", lead.id)
          .is("first_touched_at", null) // idempotency guard at DB layer

        leadsTouched++
      } else {
        skipped++
      }
    } catch (err) {
      skipped++
      await logError(
        supabase,
        brokerageId,
        "speed_to_lead_lead_touch",
        err instanceof Error ? err.message : String(err),
        { leadId: lead.id },
      )
    }
  }

  // ── Sweep 2: CONTACTS ─────────────────────────────────────────────────────
  // Grace: assigned at least graceMinutes ago, no prior agent touch.
  const graceCutoff = new Date(now.getTime() - graceMinutes * 60 * 1000).toISOString()

  const { data: contacts, error: contactsError } = await supabase
    .from("contacts")
    .select(
      `id, brokerage_id, created_at, first_touched_at, last_contacted_at,
       agent_id,
       tcpa_consent, dnc_status, phone_opt_out, sms_opt_out, email_opt_out,
       preferred_channel, mailing_address`,
    )
    .eq("brokerage_id", brokerageId)
    .not("agent_id", "is", null)          // must be assigned
    .is("first_touched_at", null)          // not yet first-touched
    .is("last_contacted_at", null)         // agent has not reached out
    // contacts.created_at = the lead→agent conversion moment (createContactFromLead),
    // i.e. the assignment time — there is no separate assigned_at column.
    .lt("created_at", graceCutoff)        // grace window elapsed
    .limit(50)

  if (contactsError) {
    await logError(supabase, brokerageId, "speed_to_lead_contacts_query", contactsError.message)
  }

  for (const contact of contacts ?? []) {
    try {
      const consent: FirstTouchConsentInput = {
        tcpa_consent:      !!(contact.tcpa_consent),
        dnc_status:        !!(contact.dnc_status),
        phone_opt_out:     !!(contact.phone_opt_out),
        sms_opt_out:       !!(contact.sms_opt_out),
        email_opt_out:     !!(contact.email_opt_out),
        preferred_channel: contact.preferred_channel ?? null,
      }

      // Determine agent last touch from last_contacted_at (already filtered to IS NULL)
      const decision = firstTouchDecision({
        kind:             "contact",
        now,
        createdAt:        new Date(contact.created_at),
        assignedAt:       new Date(contact.created_at), // created_at = assignment moment (no separate assigned_at column)
        firstTouchedAt:   contact.first_touched_at ? new Date(contact.first_touched_at) : null,
        agentLastTouchAt: contact.last_contacted_at ? new Date(contact.last_contacted_at) : null,
        consent,
        agentGraceMinutes: graceMinutes,
      })

      if (!decision.shouldTouch) {
        skipped++
        continue
      }

      const result = await doContactEngagement({
        contactId:   contact.id,
        brokerageId: contact.brokerage_id,
        reason:      "speed_to_lead",
      })

      if (result?.success !== false) {
        await supabase
          .from("contacts")
          .update({
            first_touched_at:    now.toISOString(),
            first_touch_channel: decision.channel,
            updated_at:          now.toISOString(),
          })
          .eq("id", contact.id)
          .is("first_touched_at", null) // idempotency guard

        contactsTouched++
      } else {
        skipped++
      }
    } catch (err) {
      skipped++
      await logError(
        supabase,
        brokerageId,
        "speed_to_lead_contact_touch",
        err instanceof Error ? err.message : String(err),
        { contactId: contact.id },
      )
    }
  }

  return { leadsTouched, contactsTouched, skipped }
}

// ── Internal helpers ───────────────────────────────────────────────────────

async function logError(
  supabase: ReturnType<typeof createServiceClient>,
  brokerageId: string,
  workflow: string,
  message: string,
  context?: Record<string, unknown>,
): Promise<void> {
  try {
    await supabase.from("automation_errors").insert({
      brokerage_id:  brokerageId,
      workflow_name: workflow,
      error_message: message,
      context_json:  context ? JSON.stringify(context) : null,
      severity:      "medium",
      status:        "open",
      created_at:    new Date().toISOString(),
    })
  } catch {
    // never throw from the error logger
  }
}
