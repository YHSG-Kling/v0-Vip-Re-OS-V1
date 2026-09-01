/**
 * lib/kernel/compliance/outbound-predicates.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * PURE OUTBOUND SUPPRESSION PREDICATES — the client-safe leaf.
 *
 * WHY THIS FILE EXISTS (and why it is not a resurrection of the deleted twin):
 * lib/kernel/communication-compliance.ts is the kernel gate; its very first
 * import is `createServiceClient`, so any `"use client"` component that wanted
 * the eligibility rule had to either drag the server kernel into the browser
 * bundle or hand-roll the rule again. It hand-rolled it — twice, and both
 * copies were WEAKER than the real one:
 *
 *   app/crm/page.tsx (portal-invite button)   checked 2 of the 6 arms
 *   app/dashboard/admin/compliance/tcpa/page.tsx  spelled 2 arms as a PostgREST
 *                                             filter chain
 *
 * The tombstone at lib/kernel/communication-compliance.ts:286 already ruled on
 * the fix: "If a client-safe pure split is ever actually needed, re-extract
 * from these survivors — do not resurrect the twin." This IS that re-extraction:
 * the bodies below were MOVED (not copied) out of those survivors, and
 * communication-compliance.ts now re-exports them, so the names the tombstone
 * points at still resolve at that path and no second definition exists.
 *
 * CLIENT-SAFE CONTRACT — enforced by review, and cheap to re-verify:
 * the ONLY import in this file is a TYPE-ONLY import of ContactStatus from
 * lib/contact-promotion/qualification.ts, which itself imports nothing at all
 * (and is already imported by the "use client" app/crm/page.tsx, proving it
 * bundles). No createServiceClient, no next/headers, no "server-only", no
 * process/fs/net. Anything added here that reaches the server kernel puts the
 * service-role client back in the browser bundle — do not add one.
 *
 * ── THE ARMS, AND WHY THEY ARE NAMED SEPARATELY ─────────────────────────────
 * `isEligibleForOutbound` is the union of two DIFFERENT questions, and callers
 * legitimately need one without the other:
 *
 *   hasRecordedOptOut()             "this person told us to stop"
 *   needsConsentInRestrictedState() "we never had permission here in the first
 *                                    place"
 *
 * The TCPA board's actionable list is exactly the second case — contacts you
 * should go COLLECT consent from — so it must filter on the first question
 * only, or it would hide the very people it exists to surface. That is one
 * vocabulary composed two ways (§6), not two spellings of one rule: there is
 * still exactly one definition of each arm, here.
 */

import type { ContactStatus } from "@/lib/contact-promotion/qualification"

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * EXACTLY the seven `contacts` columns the four predicates below read — nothing
 * else. This is the parameter type of every predicate in this file, deliberately
 * narrower than ContactData, so a caller holding any row shape carrying these
 * columns (a CRM page's own local `Contact` interface, a raw PostgREST row) can
 * pass it whole. Passing the WHOLE row is the point: hand-listing the fields at
 * a call site is how an arm added here silently stops being checked there.
 *
 * Deliberately nullable throughout — every one of these is a NULLABLE column on
 * hrvaqgvukzxfskkcrwbt.contacts.
 *
 * CALLER WARNING — this shape fails OPEN, by necessity: a field that was never
 * SELECTed is indistinguishable from a field that is false. Feed these
 * predicates a row loaded with `select("*")`, or one naming all seven columns
 * explicitly — never a narrow list projection.
 */
export interface OutboundSuppressionFields {
  dnc_status?: boolean | null
  email_opt_out?: boolean | null
  sms_opt_out?: boolean | null
  call_stop_flag?: boolean | null
  tcpa_consent?: boolean | null
  opt_out_channels?: string[] | null
  state?: string | null
}

/**
 * The compliance-relevant slice of a `contacts` row as the MASTER GATE
 * (lib/kernel/communication-compliance.ts evaluateOutboundCompliance) needs it:
 * the seven suppression columns above, plus the identity/routing fields and the
 * lifecycle status only the gate's RULE 8 reads. Deliberately partial — callers
 * routinely hold a partially-loaded row.
 */
export interface ContactData extends OutboundSuppressionFields {
  id: string
  email?: string | null
  phone?: string | null
  /** contacts.status — canonical vocabulary in
   *  lib/contact-promotion/qualification.ts CONTACT_STATUSES. Only 'inactive'
   *  matters to compliance (soft warn); the DNC fact lives on dnc_status. */
  status?: ContactStatus
}

/**
 * US states whose law requires prior express TCPA consent before outreach.
 * Tested against `contact.state` (geographic).
 *
 * NOT to be confused with REPRESENTATION_LOCK_STATES in lib/kernel/compliance.ts:94,
 * which is tested against `contact.status` (lifecycle). That set was renamed away
 * from this identifier on 2026-09-01 precisely so the two can never be merged by
 * accident — see the note at lib/kernel/compliance.ts:80.
 */
export const RESTRICTED_STATES = new Set([
  "CA", // California (CCPA strong)
  "NY", // New York
  "DC", // Washington DC
])

// ─────────────────────────────────────────────────────────────────────────────
// PREDICATES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ARM A — "this person told us to stop."
 *
 * True if ANY opt-out is recorded on ANY channel: the National DNC registry
 * flag, a phone STOP, an email or SMS opt-out, or any entry in the
 * `opt_out_channels` array. Strictly conservative — one recorded opt-out
 * anywhere fails the whole quick check, because this predicate cannot know
 * which channel the caller is about to use.
 *
 * Mirrors RULES 1-5 of the master gate
 * (lib/kernel/communication-compliance.ts evaluateOutboundCompliance).
 */
export function hasRecordedOptOut(contact: OutboundSuppressionFields): boolean {
  if (contact.dnc_status || contact.call_stop_flag) return true
  if (contact.email_opt_out || contact.sms_opt_out) return true
  if ((contact.opt_out_channels?.length ?? 0) > 0) return true
  // status === "do_not_contact" removed 2026-08-31 — never a contacts.status
  // value; the DNC fact is dnc_status, checked above.
  return false
}

/**
 * ARM B — "we never had permission in this jurisdiction."
 *
 * Mirrors RULE 6 of the master gate. The pure form checks only the explicit
 * `tcpa_consent` flag; the master gate additionally accepts IMPLIED consent
 * from an active representation relationship (open transaction / signed
 * agreement / live offer — lib/kernel/compliance/active-representation.ts),
 * which is a DB lookup no pure predicate can make. So this arm is strictly
 * MORE restrictive than the gate, never less: it can refuse a contact the
 * gate would allow, and never allows one the gate would refuse.
 */
export function needsConsentInRestrictedState(contact: OutboundSuppressionFields): boolean {
  return RESTRICTED_STATES.has(contact.state ?? "") && !contact.tcpa_consent
}

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
export function isEligibleForOutbound(contact: OutboundSuppressionFields): boolean {
  if (hasRecordedOptOut(contact)) return false
  if (needsConsentInRestrictedState(contact)) return false
  return true
}

/**
 * HELPER: Get all suppression reasons for a contact
 * (Used for UI display)
 *
 * Every arm `isEligibleForOutbound` can fail on names itself here, so a UI that
 * refuses a send can always say WHY. An empty array is the same statement as
 * `isEligibleForOutbound() === true`.
 */
export function getSuppressionReasons(contact: OutboundSuppressionFields): string[] {
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
  if (needsConsentInRestrictedState(contact)) {
    reasons.push(`Restricted State (${contact.state}) - No TCPA Consent`)
  }
  return reasons
}
