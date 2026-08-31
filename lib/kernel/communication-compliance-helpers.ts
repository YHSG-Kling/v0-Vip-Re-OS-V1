/**
 * lib/kernel/communication-compliance-helpers.ts
 *
 * Pure (no DB, no service client) helpers extracted from
 * lib/kernel/communication-compliance.ts so client components can import
 * them without dragging in the server-only Supabase service client.
 *
 * The canonical entry surface for eligibility evaluation is still
 * evaluateOutboundCompliance() in the parent module — those checks are
 * inherently server-side. These helpers are the read-only projections
 * useful for UI badges + quick checks against a contact row already
 * loaded into the client.
 */

export interface ContactData {
  id?: string
  email?: string | null
  phone?: string | null
  state?: string | null
  dnc_status?: boolean | null
  call_stop_flag?: boolean | null
  email_opt_out?: boolean | null
  sms_opt_out?: boolean | null
  status?: string | null
  tcpa_consent?: boolean | null
  brokerage_id?: string | null
}

/** States where active TCPA consent is required for outbound contact.
 *  MUST stay in sync with the RESTRICTED_STATES set in the parent
 *  lib/kernel/communication-compliance.ts module. */
const RESTRICTED_STATES = new Set([
  "CA", // California (CCPA strong)
  "NY", // New York
  "DC", // Washington DC
])

export function isEligibleForOutbound(contact: ContactData): boolean {
  if (contact.dnc_status) return false
  if (contact.call_stop_flag) return false
  // status === "do_not_contact" check removed 2026-08-31: no writer has ever
  // stored that value on contacts.status (the DNC fact lives on dnc_status,
  // checked above), and m587's CHECK does not admit it. Vocabulary:
  // lib/contact-promotion/qualification.ts CONTACT_STATUSES.
  if (RESTRICTED_STATES.has(contact.state ?? "") && !contact.tcpa_consent) return false
  return true
}

export function getSuppressionReasons(contact: ContactData): string[] {
  const reasons: string[] = []
  if (contact.dnc_status) reasons.push("Do Not Call Registry")
  if (contact.call_stop_flag) reasons.push("Call Stop Flag")
  if (contact.email_opt_out) reasons.push("Email Opt-Out")
  if (contact.sms_opt_out) reasons.push("SMS Opt-Out")
  // "Marked Do Not Contact" via status removed 2026-08-31 — the DNC fact lives
  // on dnc_status (reported above); 'do_not_contact' was never a contacts.status
  // value and m587's CHECK does not admit it.
  if (RESTRICTED_STATES.has(contact.state ?? "") && !contact.tcpa_consent) {
    reasons.push(`Restricted State (${contact.state}) - No TCPA Consent`)
  }
  return reasons
}
