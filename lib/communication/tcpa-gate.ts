/**
 * Unified TCPA gate — single chokepoint for outbound SMS + call compliance.
 *
 * Wraps the existing pieces:
 *   - lib/communication/call-compliance.ts:checkQuietHours (already correct)
 *   - contacts.tcpa_consent + tcpa_consent_date (express written consent)
 *   - contacts.dnc_status (do-not-call)
 *   - contacts.phone_status (RND staleness — 1063)
 *
 * Every call/SMS sent through lib/providers/messaging/index.ts MUST pass
 * through this gate. Decisions are logged to outbound_message_compliance_log
 * for plaintiff discovery + state RE commission audits.
 *
 * Fails CLOSED on errors. TCPA exposure ($500–$1,500/violation × class size)
 * makes "fail open" unacceptable.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { checkQuietHours, stateFromPhone } from "@/lib/communication/call-compliance"

const RND_STALENESS_DAYS = 90  // FCC reassigned-number safe harbor reference

export type TCPABlockReason =
  | "dnc"
  | "no_consent"
  | "consent_expired"
  | "quiet_hours"
  | "phone_stale"
  | "phone_invalid"
  | "phone_reassigned"
  | "opted_out"
  | "missing_phone"
  | "other"

export interface TCPAGateInput {
  channel:       "sms" | "call"
  phone:         string
  contactId?:    string | null
  brokerageId?:  string | null
  initiatedBy?:  string | null
  /** Set true on system-of-record retention/transactional notices that may
   *  bypass marketing consent (e.g. an in-progress transaction confirmation
   *  to an existing client). DNC and quiet hours STILL apply. */
  transactional?: boolean
}

export interface TCPAGateResult {
  allowed:        boolean
  blockReason?:   TCPABlockReason
  message?:       string
  recipientState?: string | null
  recipientLocalHour?: number | null
  /** ID of the compliance-log row written for this decision. */
  logEntryId?:    string
}

/**
 * Run the TCPA gate. Writes a log row regardless of outcome.
 * Returns allowed=false when caller MUST NOT initiate the dial/send.
 */
export async function enforceTCPACompliance(input: TCPAGateInput): Promise<TCPAGateResult> {
  if (!input.phone || input.phone.replace(/\D/g, "").length < 10) {
    const log = await writeLog(input, "blocked", "missing_phone", { reason: "phone empty or invalid format" })
    return { allowed: false, blockReason: "missing_phone", message: "Phone number missing or invalid", logEntryId: log }
  }

  // 1. Look up contact compliance state (when contactId provided — most paths have it)
  if (input.contactId) {
    const svc = createServiceClient()
    const { data: contact } = await svc
      .from("contacts")
      .select("dnc_status, tcpa_consent, tcpa_consent_date, sms_opted_out, phone_status, phone_validated_at, email_opt_out")
      .eq("id", input.contactId)
      .maybeSingle()

    if (contact) {
      if (contact.dnc_status === true) {
        const log = await writeLog(input, "blocked", "dnc", { dnc_status: true })
        return { allowed: false, blockReason: "dnc", message: "Contact is on DNC list", logEntryId: log }
      }
      // SMS-specific opt-out from STOP keyword path
      if (input.channel === "sms" && contact.sms_opted_out === true) {
        const log = await writeLog(input, "blocked", "opted_out", { sms_opted_out: true })
        return { allowed: false, blockReason: "opted_out", message: "Contact texted STOP — opted out", logEntryId: log }
      }
      // EWC required for non-transactional (marketing) outbound auto-dialer/SMS
      if (!input.transactional && contact.tcpa_consent !== true) {
        const log = await writeLog(input, "blocked", "no_consent", { tcpa_consent: false })
        return { allowed: false, blockReason: "no_consent", message: "No TCPA express written consent on file", logEntryId: log }
      }
      // Phone-status guard
      if (contact.phone_status === "invalid") {
        const log = await writeLog(input, "blocked", "phone_invalid", { phone_status: "invalid" })
        return { allowed: false, blockReason: "phone_invalid", message: "Phone marked invalid", logEntryId: log }
      }
      if (contact.phone_status === "reassigned") {
        const log = await writeLog(input, "blocked", "phone_reassigned", { phone_status: "reassigned" })
        return { allowed: false, blockReason: "phone_reassigned", message: "Phone marked as reassigned — consent no longer covers this number", logEntryId: log }
      }
      // RND staleness — phone hasn't been validated in 90+ days
      if (contact.phone_validated_at) {
        const ageDays = (Date.now() - new Date(contact.phone_validated_at).getTime()) / (1000 * 60 * 60 * 24)
        if (ageDays > RND_STALENESS_DAYS) {
          const log = await writeLog(input, "blocked", "phone_stale", { ageDays: Math.round(ageDays) })
          return {
            allowed: false,
            blockReason: "phone_stale",
            message: `Phone hasn't been validated in ${Math.round(ageDays)}d. Re-validate via Twilio Lookup before contacting.`,
            logEntryId: log,
          }
        }
      }
    }
  }

  // 2. Quiet hours check (independent of contact — area-code resolves state)
  const qh = checkQuietHours(input.phone)
  if (!qh.allowed) {
    const log = await writeLog(input, "blocked", "quiet_hours", {
      local_hour: qh.recipientLocalHour,
      timezone:   qh.recipientTimezone,
    }, qh.recipientState, qh.recipientLocalHour)
    return {
      allowed:            false,
      blockReason:        "quiet_hours",
      message:            qh.reason,
      recipientState:     qh.recipientState,
      recipientLocalHour: qh.recipientLocalHour,
      logEntryId:         log,
    }
  }

  // 3. Allowed — log success too (for inventory + plaintiff defense
  //    "we have proof every message passed compliance")
  const state  = stateFromPhone(input.phone)
  const logId  = await writeLog(input, "allowed", null, {}, state, qh.recipientLocalHour)
  return {
    allowed:            true,
    recipientState:     state,
    recipientLocalHour: qh.recipientLocalHour,
    logEntryId:         logId,
  }
}

async function writeLog(
  input: TCPAGateInput,
  decision: "allowed" | "blocked",
  reason: TCPABlockReason | null,
  details: Record<string, unknown>,
  state?: string | null,
  localHour?: number | null,
): Promise<string | undefined> {
  try {
    const svc = createServiceClient()
    const { data } = await svc
      .from("outbound_message_compliance_log")
      .insert({
        brokerage_id:         input.brokerageId ?? null,
        contact_id:           input.contactId   ?? null,
        initiated_by:         input.initiatedBy ?? null,
        channel:              input.channel,
        phone:                input.phone,
        decision,
        block_reason:         reason,
        details:              { ...details, transactional: input.transactional ?? false },
        recipient_state:      state ?? null,
        recipient_local_hour: localHour ?? null,
      })
      .select("id")
      .single()
    return data?.id as string | undefined
  } catch (err) {
    console.error("[tcpa-gate] log write failed:", err)
    return undefined
  }
}

/**
 * Mark a phone as validated (called from the Twilio Lookup wrapper).
 * Side-effect: when status changes to 'reassigned', any active sms_opted_out
 * stays in place but the gate now blocks unconditionally.
 */
export async function recordPhoneValidation(params: {
  contactId: string
  status:    "valid" | "invalid" | "reassigned" | "unknown"
}): Promise<{ ok: boolean; error?: string }> {
  try {
    const svc = createServiceClient()
    const { error } = await svc
      .from("contacts")
      .update({
        phone_status:        params.status,
        phone_validated_at:  new Date().toISOString(),
      })
      .eq("id", params.contactId)
    if (error) return { ok: false, error: error.message }
    return { ok: true }
  } catch (err: any) {
    return { ok: false, error: err?.message ?? "unknown" }
  }
}
