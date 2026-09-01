// lib/kernel/communication-compliance.ts
// KERNEL LAYER: Communication compliance governance
// Single source of truth for all outbound eligibility decisions
// Every dispatch path (email, SMS, voice, DM, mail) gates through this

import { createServiceClient } from "@/lib/supabase/service"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { hasActiveRepresentation } from "@/lib/kernel/compliance/active-representation"
import { RESTRICTED_STATES, type ContactData } from "@/lib/kernel/compliance/outbound-predicates"

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACTS: Explicit normalized data contracts
// ─────────────────────────────────────────────────────────────────────────────

export type CommunicationChannel = "email" | "sms" | "phone" | "voicemail" | "direct_mail" | "social_dm"

// ContactData, RESTRICTED_STATES, isEligibleForOutbound and getSuppressionReasons
// now LIVE in the pure leaf lib/kernel/compliance/outbound-predicates.ts and are
// re-exported from here (see the re-export block at the bottom of this file), so
// every name this module has ever published still resolves at this path — the
// tombstone below names these as the survivors of a §1.1 merge and that naming
// has to stay true. Moved, not copied: there is exactly one definition of each.
export type { ContactData }

export interface EvaluateOutboundInput {
  contact: ContactData
  channel: CommunicationChannel
  content: string
  actorContext: {
    brokerageId: string
    actorType: "ai_isa" | "agent" | "system"
    userId?: string
  }
  overrideValidation?: boolean
}

export interface ComplianceViolation {
  code: string
  message: string
  severity: "hard_block" | "soft_warn"
}

export interface EvaluateOutboundOutput {
  allowed: boolean
  violations: ComplianceViolation[]
  primaryReason?: string
  auditLogEntry: {
    contact_id: string
    channel: CommunicationChannel
    decision: "approved" | "blocked"
    reason?: string
    actor_type: string
    actor_id?: string
    timestamp: string
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPLIANCE RULES ENGINE
// ─────────────────────────────────────────────────────────────────────────────

// RESTRICTED_STATES moved to lib/kernel/compliance/outbound-predicates.ts:88
// (imported above). RULE 6 and the needsConsentCheck below read it from there.
//
// TOMBSTONE (orphan doctrine §1.1/§6, 2026-09-01): the module-private arrays
//   HARD_BLOCKS = ["dnc","call_stop_flag","email_opt_out","sms_opt_out",
//                  "opt_out_channel","restricted_state_no_consent","no_tcpa_consent"]
//   SOFT_WARNS  = ["lifecycle_stage_inactive"]
// are deleted. They were a SECOND home for a fact whose only live home is the
// inline `severity:` literal on each rule below — RULE 1 (:~93), RULE 2 (:~102),
// RULE 3 (:~114), RULE 4 (:~123), RULE 5 (:~132), RULE 6 (:~158), RULE 7 (:~178)
// all carry `severity: "hard_block"`, and RULE 8 (:~189) carries
// `severity: "soft_warn"`. SURVIVOR: those eight inline literals, in
// evaluateOutboundCompliance() in THIS file.
//
// Evidence for deleting rather than deriving severity from the arrays:
//   1. Zero readers. `grep -rn "HARD_BLOCKS\|SOFT_WARNS"` over the whole tree
//      (excluding node_modules) returned exactly these two declaration lines and
//      nothing else — for the arrays' entire life. They never governed anything;
//      the decision at "DETERMINE DECISION" below reads `v.severity`, never them.
//   2. Deriving would have BROKEN a guard outside this lane.
//      scripts/dispatch-recipient-identity-simulator.ts:83 asserts the literal
//      pairing `/code: "no_tcpa_consent"[\s\S]{0,120}?severity: "hard_block"/`
//      against this file's stripped source. The inline form is therefore
//      load-bearing and externally observed; the arrays were observed by no one.
// Adding a rule? Put its severity inline like its seven neighbours. One fact,
// one home (§6).

/**
 * KERNEL MASTER FUNCTION: Evaluate outbound eligibility
 * 
 * Input: EvaluateOutboundInput (contact, channel, content, actor context)
 * Output: EvaluateOutboundOutput (allowed, violations, audit log entry)
 * 
 * Single source of truth: Every outbound dispatch MUST call this.
 * Returns explicit decision with full audit trail.
 */
export async function evaluateOutboundCompliance(
  input: EvaluateOutboundInput
): Promise<EvaluateOutboundOutput> {
  const violations: ComplianceViolation[] = []
  const supabase = await createServiceClient()

  try {
    const { contact, channel, actorContext, overrideValidation } = input

    // ─── RULE 1: DNC Status (HARD BLOCK) ───────────────────────────────────
    if (contact.dnc_status === true) {
      violations.push({
        code: "dnc",
        message: "Contact on National Do-Not-Call Registry",
        severity: "hard_block",
      })
    }

    // ─── RULE 2: Call Stop Flag (HARD BLOCK for phone/voicemail) ───────────
    if (
      (channel === "phone" || channel === "voicemail") &&
      contact.call_stop_flag === true
    ) {
      violations.push({
        code: "call_stop_flag",
        message: "Contact has requested no phone calls",
        severity: "hard_block",
      })
    }

    // ─── RULE 3: Email Opt-Out (HARD BLOCK for email) ──────────────────────
    if (channel === "email" && contact.email_opt_out === true) {
      violations.push({
        code: "email_opt_out",
        message: "Contact has opted out of email",
        severity: "hard_block",
      })
    }

    // ─── RULE 4: SMS Opt-Out (HARD BLOCK for SMS) ─────────────────────────
    if (channel === "sms" && contact.sms_opt_out === true) {
      violations.push({
        code: "sms_opt_out",
        message: "Contact has opted out of SMS",
        severity: "hard_block",
      })
    }

    // ─── RULE 5: Channel-Specific Opt-Out Array ────────────────────────────
    if (contact.opt_out_channels?.includes(channel)) {
      violations.push({
        code: "opt_out_channel",
        message: `Contact has opted out of ${channel}`,
        severity: "hard_block",
      })
    }

    // Implied consent: an explicit tcpa_consent flag, OR an active representation
    // relationship (open transaction / signed buyer-broker or listing agreement /
    // live offer). Agreements carry consent and the client is actively in a deal,
    // so the servicing team must always be able to reach them. Only queried on the
    // consent-gated path (sms/phone or restricted state) — email/direct_mail to an
    // unconsented lead never triggers the lookup.
    const needsConsentCheck =
      channel === "sms" ||
      channel === "phone" ||
      channel === "voicemail" ||
      RESTRICTED_STATES.has(contact.state ?? "")
    const consentGiven =
      contact.tcpa_consent === true ||
      (needsConsentCheck
        ? await hasActiveRepresentation(supabase, contact.id, actorContext.brokerageId)
        : false)

    // ─── RULE 6: Restricted State Without Consent ──────────────────────────
    if (RESTRICTED_STATES.has(contact.state ?? "") && !consentGiven) {
      violations.push({
        code: "restricted_state_no_consent",
        message: `No TCPA consent in restricted state (${contact.state})`,
        severity: "hard_block",
      })
    }

    // ─── RULE 7: TCPA Consent for SMS / Phone (HARD BLOCK) ─────────────────
    // SMS, phone, and voicemail are consent-gated by TCPA. Email and
    // direct_mail are intentionally NOT gated here — unconsented leads may
    // receive email/direct-mail outreach (the ISA allowance); only live
    // telephony/text requires prior express consent. This mirrors the kernel
    // content gate (lib/kernel/compliance.ts Gate 2) so the physical-dispatch
    // "final straggler" gate cannot pass a send the content gate would block.
    if (
      (channel === "sms" || channel === "phone" || channel === "voicemail") &&
      !consentGiven
    ) {
      violations.push({
        code: "no_tcpa_consent",
        message: "No TCPA consent on file for SMS/phone communication",
        severity: "hard_block",
      })
    }

    // ─── RULE 8: Contact Status (SOFT WARN if inactive) ────────────────────
    // ('do_not_contact' removed 2026-08-31: never a contacts.status value — the
    // DNC fact is dnc_status, HARD-blocked at RULE 1; m587's CHECK does not
    // admit it. Vocabulary: lib/contact-promotion/qualification.ts.)
    if (contact.status === "inactive") {
      violations.push({
        code: "lifecycle_stage_inactive",
        message: "Contact marked as inactive",
        severity: "soft_warn",
      })
    }

    // ─── DETERMINE DECISION ─────────────────────────────────────────────────
    const hasHardBlocks = violations.some(v => v.severity === "hard_block")
    const allowed = !hasHardBlocks || overrideValidation === true

    const primaryReason = violations[0]?.code || (allowed ? "compliant" : "blocked")

    // ─── LOG AUDIT ENTRY ────────────────────────────────────────────────────
    const auditLogEntry = {
      contact_id: contact.id,
      channel,
      decision: allowed ? ("approved" as const) : ("blocked" as const),
      reason: violations.map(v => v.code).join(",") || undefined,
      actor_type: actorContext.actorType,
      actor_id: actorContext.userId,
      timestamp: new Date().toISOString(),
    }

    // Write the eval decision to compliance_events (the canonical compliance
    // audit table — gate_name/allowed/violations/blocked_reason all map cleanly,
    // and it is brokerage-scoped). communication_audit_log is for actual sends,
    // not eval decisions, and lacks columns for this shape. Non-blocking.
    void (async () => {
      try {
        // Declared non-blocking — but the try/catch around it could never see a
        // rejected write (supabase-js resolves), so a lost suppression-gate audit
        // row was invisible. The sentinel keeps it tolerated and LEDGERS the loss:
        // `supabase` here is the service-role client created at the top of this
        // function, which is the precondition that makes the sentinel stronger
        // than a console.warn (self_heal_events has no INSERT policy for any
        // non-service role, so a user-scoped client would be refused and the
        // refusal swallowed — see lib/kernel/write-sentinel.ts).
        await sentinelWrite(supabase, supabase.from("compliance_events").insert({
          brokerage_id: actorContext.brokerageId,
          actor_user_id: actorContext.userId ?? null,
          actor_role: actorContext.actorType,
          entity_type: "contact",
          entity_id: contact.id,
          message_type: channel,
          gate_name: "outbound_suppression",
          allowed,
          violations,
          blocked_reason: allowed ? null : primaryReason,
        }), {
          table: "compliance_events",
          flow: "outbound_suppression_audit",
          brokerageId: actorContext.brokerageId ?? null,
          reason: "outbound suppression audit row — the gate decision above has already been returned to the caller, so a lost audit echo must not turn a refusal into a throw",
        })
      } catch (err) {
        console.error("[Compliance] Failed to write audit log:", err)
      }
    })()

    return {
      allowed,
      violations,
      primaryReason,
      auditLogEntry,
    }
  } catch (error) {
    console.error("[Compliance] Error evaluating outbound:", error)
    return {
      allowed: false,
      violations: [
        {
          code: "system_error",
          message: "System error during compliance check",
          severity: "hard_block",
        },
      ],
      primaryReason: "system_error",
      auditLogEntry: {
        contact_id: input.contact.id,
        channel: input.channel,
        decision: "blocked",
        reason: "system_error",
        actor_type: input.actorContext.actorType,
        actor_id: input.actorContext.userId,
        timestamp: new Date().toISOString(),
      },
    }
  }
}

// TOMBSTONE (orphan doctrine §1.1, 2026-09-01): lib/kernel/communication-compliance-helpers.ts
// deleted. It was a byte-near twin of the two helpers below, split out so client components
// could import pure predicates without dragging in createServiceClient — a split no client
// component ever exercised (zero importers, static or dynamic, for the module's whole life).
// Survivors: isEligibleForOutbound / getSuppressionReasons in THIS file (below). The one
// check only the twin carried — restricted-state-without-TCPA-consent in the eligibility
// predicate — was merged onto the survivor before deletion, and both helpers now also cover
// the opt_out_channels arm that NEITHER twin checked but the master gate
// evaluateOutboundCompliance() hard-blocks (RULE 5 above). If a client-safe pure split is
// ever actually needed, re-extract from these survivors — do not resurrect the twin.
//
// ── 2026-09-01, LATER THE SAME DAY: the split WAS actually needed, and this is
// the re-extraction the paragraph above authorised. Two client/server-boundary
// re-spellings of this rule were found LIVE, both weaker than the survivors:
//
//   app/crm/page.tsx:1386-1392   the portal magic-link button, a "use client"
//                                file, checked 2 of the 6 arms — so a contact
//                                who had texted STOP (call_stop_flag), opted
//                                out of SMS, opted out of a specific channel
//                                (opt_out_channels), or lived in a restricted
//                                state with no TCPA consent STILL RECEIVED A
//                                PORTAL INVITE. Proven by positive control
//                                before the fix; all four now refuse by name.
//   app/dashboard/admin/compliance/tcpa/page.tsx:104-111
//                                spelled the same rule a THIRD way, as a
//                                PostgREST filter chain (.not dnc_status /
//                                .not sms_opt_out), blind to call_stop_flag,
//                                email_opt_out and opt_out_channels.
//
// The cause was mechanical, not careless: line 6 of this file imports
// createServiceClient, so importing the predicate from a client component drags
// the service-role kernel into the browser bundle. Per the ruling above, the
// bodies were RE-EXTRACTED FROM THESE SURVIVORS (moved verbatim, not re-derived)
// into the pure leaf lib/kernel/compliance/outbound-predicates.ts, which imports
// nothing but a type. Both re-spellings now call the one predicate.
// SURVIVOR NAMES ARE UNCHANGED AT THIS PATH — the re-export below keeps
// `isEligibleForOutbound` / `getSuppressionReasons` importable from
// "@/lib/kernel/communication-compliance" exactly as before, so the tombstone
// above stays true and no existing importer moves.
export {
  isEligibleForOutbound,
  getSuppressionReasons,
  // The two named arms isEligibleForOutbound is composed of. hasRecordedOptOut
  // ("they told us to stop") is the half the TCPA board needs alone: its
  // actionable list is people who have NOT consented yet, so filtering that list
  // on full eligibility would hide exactly the contacts it exists to surface.
  hasRecordedOptOut,
  needsConsentInRestrictedState,
  RESTRICTED_STATES,
} from "@/lib/kernel/compliance/outbound-predicates"
