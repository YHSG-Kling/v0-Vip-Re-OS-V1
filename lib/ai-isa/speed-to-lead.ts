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
//
// ── WAVE 145 (lane 145E) — SPEED-TO-LEAD IS CONSUMED BY THE ARBITER ─────────
// OWNER RULING 16 (2026-10-27): "Speed to lead should be consumed by the
// followup-arbiter and should be the arbiter decision." Measured at b364eb4b:
// the CONTACT half already went sweep → engageContact('speed_to_lead') →
// arbiter, but as a FIXED send the model never saw (wave 144); the LEAD half
// never reached the arbiter at all — this sweeper dispatched its own fixed
// email-then-mail cascade (firstTouchDecision → initiateAIISAEngagement with no
// channel decision). Now:
//   · firstTouchDecision stays the deterministic ELIGIBILITY (fresh, untouched,
//     past the agent grace window, something permitted) — law 4: the rules
//     decide what is possible;
//   · LEADS: the arbiter (arbitrateSpeedToLead) decides the channel among the
//     PERMITTED ones (verified email / verified mail — never SMS or a call); the
//     decision is ledgered (recordArbitration) and the ONE lead door dispatches
//     it (initiateAIISAEngagement forceChannel);
//   · CONTACTS: engageContact runs the arbiter under the speed-to-lead PRIORITY
//     (answer now, no wait; the channel or a person is the arbiter's call);
//   · `first_touch_channel` records the channel that ACTUALLY went out (the
//     engagement's own answer), no longer the eligibility's guess.
// CONTRACT C2 (owner ruling 15): a lead carrying a contact_id is out of the lead
// domain — excluded at the query, and re-checked per row (isInLeadDomain) so a
// conversion that lands between the select and the send never fires a lead touch.

import { createServiceClient } from "@/lib/supabase/service"
import { firstTouchDecision, DEFAULT_AGENT_GRACE_MINUTES } from "@/lib/ai-isa/speed-to-lead-policy"
import type { FirstTouchConsentInput } from "@/lib/ai-isa/speed-to-lead-policy"
import { initiateAIISAEngagement } from "@/app/actions/ai-isa/initiate-engagement"
import { engageContact }           from "@/app/actions/ai-isa/engage-contact"
import { excludeConvertedLeads }   from "@/lib/contact-promotion/conversion-finality"
import { isInLeadDomain }          from "@/lib/contact-promotion/lead-domain-boundary"
import { pickLeadOutreachChannel, LEAD_ALLOWED_CHANNELS } from "@/lib/ai-isa/lead-channel-policy"
// Types only — the arbiter itself is loaded lazily inside the lead sweep (it is not needed on a sweep with no fresh lead).
import type { SpeedToLeadArbitration, SpeedToLeadArbitrationInput, SpeedToLeadLeadChannel } from "@/lib/ai-isa/followup-arbiter"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"

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
  /** Wave 145: the arbiter's lead decision (the model call is behind it) — a seam for the proofs. */
  arbitrateLead?: (input: SpeedToLeadArbitrationInput) => Promise<SpeedToLeadArbitration>
}

/**
 * PURE. The channels the deterministic lead rule PERMITS for this lead, its default first (lib/ai-isa/lead-channel-policy.ts —
 * the roster). The consent inputs are firstTouchDecision's own (a VERIFIED email not opted out; a VERIFIED mailing address not
 * opted out); the address itself is re-checked by the one lead door at the send (initiateAIISAEngagement → dispatch).
 */
function permittedLeadChannels(lead: {
  email_verified?: boolean | null; email_opt_out?: boolean | null
  mailing_address_verified?: boolean | null; direct_mail_opt_out?: boolean | null
  preferred_channel?: string | null
}): SpeedToLeadLeadChannel[] {
  const emailUsable = lead.email_verified === true && lead.email_opt_out !== true
  const mailingVerified = lead.mailing_address_verified === true && lead.direct_mail_opt_out !== true
  const first = pickLeadOutreachChannel({ requestedChannel: lead.preferred_channel ?? null, emailUsable, mailingVerified })
  if (first === "no_outreach") return []
  const usable: Record<SpeedToLeadLeadChannel, boolean> = { email: emailUsable, direct_mail: mailingVerified }
  // The default first, then every other channel on THE lead roster that is usable (LEAD_ALLOWED_CHANNELS — never retyped).
  return [first, ...LEAD_ALLOWED_CHANNELS.filter((c) => c !== first && usable[c])]
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
  // The window opens on created_at OR distributed_at: a platform-origin lead can sit
  // PARKED (brokerage_id NULL — this per-brokerage query never sees it) until the
  // Engine 1 distribution sweep assigns a subscriber brokerage, which may be days or
  // weeks after created_at. Un-parking stamps distributed_at, so the distributed_at
  // leg is what starts AI ISA engagement for a freshly un-parked lead.
  const leadCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()

  //
  // CONVERSION FINALITY: this sweep had NEITHER a `contact_id` filter NOR an
  // `is_active` one — its only gate was `ai_isa_owner=true`, and the manual
  // converter (lib/kernel/crm.ts) left BOTH `ai_isa_owner` and `is_active`
  // untouched. So a lead converted through the lead desk was still a first-touch
  // candidate: the sweep would dispatch an ISA first touch at a person who had
  // already become a client, then stamp `first_touched_at` on their dead lead
  // row. `contact_id` is the marker; the sweep no longer selects them.
  const { data: leads, error: leadsError } = await excludeConvertedLeads(
    supabase
      .from("leads")
      .select(
        `id, brokerage_id, created_at, distributed_at, first_touched_at, contact_id,
       email, email_verified, email_opt_out, mailing_address, mailing_address_verified, direct_mail_opt_out,
       preferred_channel, lead_score, lead_temperature, timeline, source,
       ai_isa_owner, lifecycle_state`,
      )
      .eq("brokerage_id", brokerageId)
      .eq("ai_isa_owner", true)
      .is("first_touched_at", null)
      .or(`created_at.gte.${leadCutoff},distributed_at.gte.${leadCutoff}`)
      .limit(50), // safety cap per sweep
  )

  if (leadsError) {
    await logError(supabase, brokerageId, "speed_to_lead_leads_query", leadsError.message)
  }

  // The arbiter + the tenant's follow-up policy are loaded ONCE per sweep, and only when a lead is actually due.
  let arbiterMod: typeof import("@/lib/ai-isa/followup-arbiter") | null = null
  let leadPolicy: import("@/lib/ai-isa/followup-policy").FollowupPolicy | null = null
  const leadBudget = { remaining: 25 } // the sweep's model-decision ceiling (a 50-lead burst never becomes 50 model calls)

  for (const lead of leads ?? []) {
    try {
      // CONTRACT C2 (ruling 15): re-checked per row — a conversion that landed after the select makes this a CONTACT's
      // journey (its own sweep / engagement), never a lead touch.
      if (!isInLeadDomain(lead as { id?: string | null; contact_id?: string | null })) {
        skipped++
        continue
      }

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

      // ── THE ARBITER DECIDES THE FIRST TOUCH (ruling 16) among what the lead rule PERMITS ──
      const permitted = permittedLeadChannels(lead as Parameters<typeof permittedLeadChannels>[0])
      arbiterMod = arbiterMod ?? await import("@/lib/ai-isa/followup-arbiter")
      if (!leadPolicy) leadPolicy = (await (await import("@/lib/ai-isa/followup-policy")).loadFollowupPolicy(supabase, brokerageId)).policy
      const arrivedAt = lead.distributed_at && lead.distributed_at > lead.created_at ? lead.distributed_at : lead.created_at
      const arbInput: SpeedToLeadArbitrationInput = {
        brokerageId, policy: leadPolicy, permitted, budget: leadBudget,
        facts: {
          leadTemperature: (lead.lead_temperature as string | null) ?? null,
          leadScore: typeof lead.lead_score === "number" ? lead.lead_score : null,
          timeline: (lead.timeline as string | null) ?? null,
          source: (lead.source as string | null) ?? null,
          minutesSinceArrival: arrivedAt ? Math.max(0, Math.round((now.getTime() - new Date(arrivedAt).getTime()) / 60_000)) : null,
          hoursSinceLastOutreach: null, // a first touch: first_touched_at IS NULL is the sweep's own predicate
          preferences: [],
        },
      }
      const arb = await (deps.arbitrateLead ?? arbiterMod.arbitrateSpeedToLead)(arbInput)
      if (!arb.channel) {
        skipped++
        continue
      }
      if (arb.decision) {
        // LAW 5 — the decision is evidence before the send (one non-action row per lead per day; the send is its own row).
        const rec = await arbiterMod.recordArbitration(supabase, {
          brokerageId, subject: { type: "lead", id: lead.id }, decision: arb.decision, now, policyRef: null, systemSource: "speed_to_lead",
        })
        if (!rec.recorded && rec.error) console.warn(`[speed-to-lead] arbiter decision not ledgered for lead ${lead.id}: ${rec.error}`)
      }

      // Dispatch via the canonical entry — already consent/channel gated — on the ARBITER's channel.
      // Lane 86E: the cron has no session — it PRESENTS the internal secret
      // (the engagement door no longer treats the env var's presence as one).
      const result = await doLeadEngagement(lead.id, { internalSecret: process.env.CRON_SECRET, forceChannel: arb.channel })

      if (result?.success !== false) {
        // Stamp first touch — the channel the engagement actually used (its own answer), else the arbiter's.
        const sentOn = typeof (result as { channel?: unknown } | null)?.channel === "string" ? (result as { channel: string }).channel : arb.channel
        const { error: firstTouchErr } = await supabase
          .from("leads")
          .update({
            first_touched_at:    now.toISOString(),
            first_touch_channel: sentOn,
            updated_at:          now.toISOString(),
          })
          .eq("id", lead.id)
          .is("first_touched_at", null)
        if (firstTouchErr) console.error(`[speed-to-lead] first touch NOT stamped (speed-to-lead SLA will read as untouched): ${firstTouchErr.message}`) // idempotency guard at DB layer

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

      // The ARBITER decides this first touch (ruling 16): engageContact runs it under the speed-to-lead PRIORITY — the hard stops
      // lock first, no wait is offered, and the channel (or a person) is the arbiter's call over the readiness-checked channels.
      const result = await doContactEngagement({
        contactId:   contact.id,
        brokerageId: contact.brokerage_id,
        reason:      "speed_to_lead",
      })
      // A PERSON was the arbiter's answer (notify human — the agent's task exists, engage-contact routeToAgent): the requirement is
      // answered, so the claim is stamped `human_task` — otherwise this sweep would re-arbitrate the same contact every two minutes.
      const answeredByPerson = result?.success === false && /^experience:agent_intervention:/.test(String(result?.reason ?? ""))

      if (result?.success !== false || answeredByPerson) {
        await sentinelWrite(
          supabase,
          supabase
            .from("contacts")
            .update({
              first_touched_at:    now.toISOString(),
              // The channel the engagement ACTUALLY used (its own answer — the arbiter's decision, dispatched); `human_task` when a
              // person answers. Never the eligibility's guess: the sweep picks no channel of its own (ruling 16).
              first_touch_channel: answeredByPerson ? "human_task" : (result?.channel ?? null),
              updated_at:          now.toISOString(),
            })
            .eq("id", contact.id)
            .is("first_touched_at", null), // idempotency guard
          {
            table: "contacts",
            flow: "speed_to_lead_first_touch_claim",
            brokerageId: contact.brokerage_id,
            reason:
              "first-touch ledger claim, written AFTER the engagement already went out; the `.is(null)` guard means a lost claim only risks a second stand-down race with the drip lane, never an extra unconsented touch (dispatch re-gates every send)",
          },
        )

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
    await sentinelWrite(supabase, supabase.from("automation_errors").insert({
      brokerage_id:  brokerageId,
      workflow_name: workflow,
      error_message: message,
      context_json:  context ? JSON.stringify(context) : null,
      severity:      "medium",
      status:        "open",
      created_at:    new Date().toISOString(),
    }), { table: "automation_errors", flow: "automation_errors_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
  } catch {
    // never throw from the error logger
  }
}
