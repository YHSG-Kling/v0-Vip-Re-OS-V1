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
// PURE, no I/O (lib/compliance/phone-scrub.ts carries no server-only import) — reused here
// rather than re-deriving the ten-digit normalization BatchData's DNC/TCPA tools expect.
import { toTenDigits as toTenDigitsForScrub } from "@/lib/compliance/phone-scrub"

const RND_STALENESS_DAYS = 90  // FCC reassigned-number safe harbor reference

// ── FRESH DNC/TCPA SCRUB (wave 68, owner verbatim: "we do want to make sure that the
// phone/scrub and email before using it") ───────────────────────────────────────────
// A stored dnc_status is only as good as the day it was last checked. This EXTENDS the
// existing TCPA gate (never a second gate stack) with a freshness requirement: a verdict
// older than DNC_TCPA_SCRUB_STALENESS_DAYS (or never checked) is re-verified LIVE against
// BatchData before the call/SMS proceeds — "the skip-trace record's own flags when
// present" is exactly `contacts.dnc_status` + `dnc_verified_at` when that timestamp is
// still fresh (stamped by lib/compliance/phone-scrub-runner.ts at intake, or by this gate
// itself on a prior send); otherwise the mirrors in lib/external/batchdata-mcp.ts
// (checkDncStatus/checkTcpaStatus — SAME tools phone-scrub-runner.ts already calls, one
// vocabulary §6) are queried live. FAIL CLOSED: unconfigured (no BatchData key) with a
// stale/missing stored verdict refuses the send rather than assuming clean.
export const DNC_TCPA_SCRUB_STALENESS_DAYS = 30

/** @proofSeam exported so scripts/outbound-call-gates-simulator.ts §8 can pin the
 *  freshness clock's boundary (29d fresh / 31d stale) directly — enforceTCPACompliance
 *  below is this function's only production caller, in the SAME file. */
/** PURE: is a stored DNC/TCPA verdict still fresh enough to trust without a live re-check? */
export function isDncTcpaVerdictFresh(verifiedAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!verifiedAt) return false
  const ts = new Date(verifiedAt).getTime()
  if (!Number.isFinite(ts)) return false
  const ageDays = (now - ts) / (1000 * 60 * 60 * 24)
  return ageDays >= 0 && ageDays <= DNC_TCPA_SCRUB_STALENESS_DAYS
}

/** Minimal shape of what lib/external/batchdata-mcp.ts::checkDncStatus returns — typed
 *  locally so this pure evaluator never imports the (server-only-adjacent) MCP client. */
export interface DncCheckLike { ok: boolean; dnc: boolean | null; unconfigured?: boolean; error?: string | null }
export interface TcpaCheckLike { ok: boolean; tcpaLitigator: boolean | null; unconfigured?: boolean; error?: string | null }

export type FreshScrubVerdict =
  | { verified: true; blocked: false }
  | { verified: true; blocked: true; blockReason: "dnc" | "tcpa_litigator" }
  | { verified: false; reason: string }

/** @proofSeam the four wave-68 dnc/tcpa/unconfigured/clean controls in
 *  scripts/outbound-call-gates-simulator.ts §8 execute this PURE decision core
 *  directly; enforceTCPACompliance below is its only production caller (same file). */
export function evaluateFreshScrubVerdict(dncResult: DncCheckLike, tcpaResult: TcpaCheckLike): FreshScrubVerdict {
  if (dncResult.unconfigured || tcpaResult.unconfigured) {
    return {
      verified: false,
      reason: "DNC/TCPA scrub is unconfigured (no BatchData key) and the stored verdict is stale — cannot verify a fresh status, so nothing was sent.",
    }
  }
  if (!dncResult.ok && !tcpaResult.ok) {
    return { verified: false, reason: `DNC/TCPA scrub failed: ${dncResult.error ?? tcpaResult.error ?? "unknown error"}` }
  }
  if (dncResult.ok && dncResult.dnc === true) return { verified: true, blocked: true, blockReason: "dnc" }
  if (tcpaResult.ok && tcpaResult.tcpaLitigator === true) return { verified: true, blocked: true, blockReason: "tcpa_litigator" }
  return { verified: true, blocked: false }
}

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
  | "tcpa_litigator"
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
    // THIS READ IS THE GATE. It used to be `const { data: contact }` with the
    // error dropped, and supabase-js RESOLVES a refused query — so a refused
    // read produced `contact === null`, the `if (contact)` block was skipped
    // whole, and DNC / STOP opt-out / express consent / phone-status / RND
    // staleness were ALL bypassed. Execution fell through to the quiet-hours
    // check, which knows nothing about consent, and the gate could return
    // allowed. A consent gate that fails OPEN is the one direction this must
    // never fail, and it covered SMS as well as voice.
    //
    // Both "the read was refused" and "an id was named but no row came back"
    // mean the same thing here — WE CANNOT VERIFY CONSENT — so both refuse.
    // The caller supplied the id; a missing row is a data fault, not consent.
    const { data: contact, error: contactError } = await svc
      .from("contacts")
      .select("dnc_status, tcpa_consent, tcpa_consent_date, sms_opt_out, phone_status, phone_validated_at, email_opt_out, dnc_verified_at")
      .eq("id", input.contactId)
      .maybeSingle()

    if (contactError) {
      const log = await writeLog(input, "blocked", "other", {
        reason: "compliance_state_unreadable",
        contact_id: input.contactId,
        db_error: contactError.message,
      })
      return {
        allowed: false,
        blockReason: "other",
        message: `Could not read this contact's compliance state (${contactError.message}) — nothing was sent. Consent cannot be assumed.`,
        logEntryId: log,
      }
    }
    if (!contact) {
      const log = await writeLog(input, "blocked", "other", {
        reason: "contact_not_found",
        contact_id: input.contactId,
      })
      return {
        allowed: false,
        blockReason: "other",
        message: "No contact record found for the id supplied, so there is no consent on file — nothing was sent.",
        logEntryId: log,
      }
    }

    {
      // FRESH DNC/TCPA SCRUB — see the header. A fresh stored verdict is trusted as-is
      // ("the skip-trace record's own flags when present"); a stale/missing one is
      // re-verified LIVE, fail-closed on an unconfigured provider.
      if (isDncTcpaVerdictFresh(contact.dnc_verified_at as string | null)) {
        if (contact.dnc_status === true) {
          const log = await writeLog(input, "blocked", "dnc", { dnc_status: true, source: "stored_fresh" })
          return { allowed: false, blockReason: "dnc", message: "Contact is on DNC list", logEntryId: log }
        }
      } else {
        const ten = toTenDigitsForScrub(input.phone)
        const [dncResult, tcpaResult]: [DncCheckLike, TcpaCheckLike] = ten
          ? await (async () => {
              const { checkDncStatus, checkTcpaStatus } = await import("@/lib/external/batchdata-mcp")
              return [await checkDncStatus(ten), await checkTcpaStatus(ten)]
            })()
          : [
              { ok: false, dnc: null, unconfigured: false, error: "phone could not be normalized for a DNC/TCPA scrub" },
              { ok: false, tcpaLitigator: null, unconfigured: false, error: "phone could not be normalized for a DNC/TCPA scrub" },
            ]
        const verdict = evaluateFreshScrubVerdict(dncResult, tcpaResult)
        if (!verdict.verified) {
          const log = await writeLog(input, "blocked", "other", { reason: "dnc_tcpa_scrub_unverifiable", detail: verdict.reason })
          return { allowed: false, blockReason: "other", message: `${verdict.reason}`, logEntryId: log }
        }
        if (verdict.blocked) {
          const log = await writeLog(input, "blocked", verdict.blockReason, { source: "fresh_scrub" })
          return {
            allowed: false,
            blockReason: verdict.blockReason,
            message: verdict.blockReason === "dnc"
              ? "Contact is on the DNC list (fresh scrub)"
              : "This number is associated with a known TCPA litigator (fresh scrub)",
            logEntryId: log,
          }
        }
        // Clean — persist so the NEXT send within the freshness window skips the live
        // call. Best-effort: a refused stamp never blocks a compliant send.
        if (input.contactId) {
          try {
            await svc.from("contacts").update({ dnc_status: false, dnc_verified_at: new Date().toISOString() }).eq("id", input.contactId)
          } catch { /* stamp is an optimization, not the gate */ }
        }
      }
      // SMS-specific opt-out from STOP keyword path
      if (input.channel === "sms" && contact.sms_opt_out === true) {
        const log = await writeLog(input, "blocked", "opted_out", { sms_opt_out: true })
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
