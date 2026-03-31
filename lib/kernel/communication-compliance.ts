// lib/kernel/communication-compliance.ts
// KERNEL LAYER: Communication compliance governance
// Single source of truth for all outbound eligibility decisions
// Every dispatch path (email, SMS, voice, DM, mail) gates through this

import { createServiceClient } from "@/lib/supabase/service"
import type { SupabaseClient } from "@supabase/supabase-js"

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
  status?: "active" | "inactive" | "do_not_contact"
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

const HARD_BLOCKS = ["dnc", "call_stop_flag", "email_opt_out", "sms_opt_out", "opt_out_channel", "restricted_state_no_consent"]
const SOFT_WARNS = ["no_tcpa_consent", "lifecycle_stage_inactive"]

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

    // ─── RULE 6: Restricted State Without TCPA Consent ─────────────────────
    if (
      RESTRICTED_STATES.has(contact.state ?? "") &&
      contact.tcpa_consent !== true
    ) {
      violations.push({
        code: "restricted_state_no_consent",
        message: `No TCPA consent in restricted state (${contact.state})`,
        severity: "hard_block",
      })
    }

    // ─── RULE 7: TCPA Consent for Phone Calls (SOFT WARN) ──────────────────
    if (
      (channel === "phone" || channel === "voicemail") &&
      contact.tcpa_consent !== true
    ) {
      violations.push({
        code: "no_tcpa_consent",
        message: "No TCPA consent on file for phone communication",
        severity: "soft_warn",
      })
    }

    // ─── RULE 8: Contact Status (SOFT WARN if inactive) ────────────────────
    if (contact.status === "inactive" || contact.status === "do_not_contact") {
      violations.push({
        code: "lifecycle_stage_inactive",
        message: "Contact marked as inactive or do-not-contact",
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

    // Write audit log asynchronously (non-blocking)
    void (async () => {
      try {
        await supabase.from("communication_audit_log").insert(auditLogEntry)
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

/**
 * HELPER: Check if contact is eligible for ANY outbound
 * (Used for quick checks before queuing work)
 */
export function isEligibleForOutbound(contact: ContactData): boolean {
  if (contact.dnc_status || contact.call_stop_flag) return false
  if (contact.email_opt_out || contact.sms_opt_out) return false
  if (contact.status === "do_not_contact") return false
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
  if (contact.status === "do_not_contact") reasons.push("Marked Do Not Contact")
  if (RESTRICTED_STATES.has(contact.state ?? "") && !contact.tcpa_consent) {
    reasons.push(`Restricted State (${contact.state}) - No TCPA Consent`)
  }
  return reasons
}
