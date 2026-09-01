// lib/kernel/communication-compliance.ts
// KERNEL LAYER: Communication compliance governance
// Single source of truth for all outbound eligibility decisions
// Every dispatch path (email, SMS, voice, DM, mail) gates through this

import { createServiceClient } from "@/lib/supabase/service"
import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { hasActiveRepresentation } from "@/lib/kernel/compliance/active-representation"
import type { ContactStatus } from "@/lib/contact-promotion/qualification"

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACTS: Explicit normalized data contracts
// ─────────────────────────────────────────────────────────────────────────────

export type CommunicationChannel = "email" | "sms" | "phone" | "voicemail" | "direct_mail" | "social_dm"

export interface ContactData {
  id: string
  email?: string | null
  phone?: string | null
  dnc_status?: boolean
  email_opt_out?: boolean
  sms_opt_out?: boolean
  call_stop_flag?: boolean
  tcpa_consent?: boolean
  opt_out_channels?: string[]
  /** contacts.status — canonical vocabulary in
   *  lib/contact-promotion/qualification.ts CONTACT_STATUSES. Only 'inactive'
   *  matters to compliance (soft warn); the DNC fact lives on dnc_status. */
  status?: ContactStatus
  state?: string | null
}

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

const RESTRICTED_STATES = new Set([
  "CA", // California (CCPA strong)
  "NY", // New York
  "DC", // Washington DC
])

const HARD_BLOCKS = ["dnc", "call_stop_flag", "email_opt_out", "sms_opt_out", "opt_out_channel", "restricted_state_no_consent", "no_tcpa_consent"]
const SOFT_WARNS = ["lifecycle_stage_inactive"]

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

/**
 * HELPER: Check if contact is eligible for ANY outbound
 * (Used for quick checks before queuing work)
 *
 * Union of every per-channel HARD block the master gate can raise: a contact
 * this returns true for can still be blocked per-channel (RULE 2-4/7 are
 * channel-scoped and RULE 6 consults active representation, a DB lookup this
 * pure predicate cannot make) — but it never passes a contact the master gate
 * would hard-block on every channel. Strictly conservative: any recorded
 * opt-out on any channel fails the quick check.
 */
export function isEligibleForOutbound(contact: ContactData): boolean {
  if (contact.dnc_status || contact.call_stop_flag) return false
  if (contact.email_opt_out || contact.sms_opt_out) return false
  if ((contact.opt_out_channels?.length ?? 0) > 0) return false
  if (RESTRICTED_STATES.has(contact.state ?? "") && !contact.tcpa_consent) return false
  // status === "do_not_contact" removed 2026-08-31 — never a contacts.status
  // value; the DNC fact is dnc_status, checked above.
  return true
}

/**
 * HELPER: Get all suppression reasons for a contact
 * (Used for UI display)
 */
export function getSuppressionReasons(contact: ContactData): string[] {
  const reasons: string[] = []
  if (contact.dnc_status) reasons.push("Do Not Call Registry")
  if (contact.call_stop_flag) reasons.push("Call Stop Flag")
  if (contact.email_opt_out) reasons.push("Email Opt-Out")
  if (contact.sms_opt_out) reasons.push("SMS Opt-Out")
  for (const channel of contact.opt_out_channels ?? []) {
    reasons.push(`Channel Opt-Out (${channel})`)
  }
  // "Marked Do Not Contact" via status removed 2026-08-31 — dnc_status (above)
  // is the DNC rail; 'do_not_contact' was never a contacts.status value.
  if (RESTRICTED_STATES.has(contact.state ?? "") && !contact.tcpa_consent) {
    reasons.push(`Restricted State (${contact.state}) - No TCPA Consent`)
  }
  return reasons
}
