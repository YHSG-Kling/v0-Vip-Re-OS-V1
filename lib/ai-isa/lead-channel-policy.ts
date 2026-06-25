// lib/ai-isa/lead-channel-policy.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE canonical channel rule for a pre-conversion (unconsented) LEAD.
//
// A lead has NOT consented to anything, so the ONLY channels it may be reached on are:
//   • EMAIL — when the email is verified (CAN-SPAM: verified address + opt-out honored)
//   • DIRECT MAIL — when the mailing address is verified (physical mail needs no consent)
// SMS / phone / social are NEVER permitted for a lead (TCPA — no consent on record).
// Consented CONTACTS are a different policy (resolved separately, person-level).
//
// This is pulled out as a PURE function so the rule is the single source of truth and
// the lead-channel-policy simulator can prove no requested channel ever routes a lead
// to SMS / phone / social — the compliance floor can't silently drift.

export const LEAD_ALLOWED_CHANNELS = ["email", "direct_mail"] as const
export type LeadOutreachChannel = "email" | "direct_mail" | "no_outreach"

/**
 * pickLeadOutreachChannel — PURE. Resolve the permitted channel for a lead. Email-first
 * when usable; direct_mail only when requested-and-verified OR as the email fallback;
 * 'no_outreach' when neither is permitted (so the caller short-circuits before any
 * unverified send). ANY non-allowed requested channel (sms/phone/social/…) collapses to
 * the email-or-direct-mail-or-none ladder — a lead can never be SMS'd or called.
 */
export function pickLeadOutreachChannel(input: {
  requestedChannel?: string | null
  emailUsable: boolean
  mailingVerified: boolean
}): LeadOutreachChannel {
  const requested = input.requestedChannel ?? "email"
  if (requested === "direct_mail") {
    return input.mailingVerified ? "direct_mail" : input.emailUsable ? "email" : "no_outreach"
  }
  // email, or any non-allowed channel (sms/phone/social/...) → email-first ladder
  return input.emailUsable ? "email" : input.mailingVerified ? "direct_mail" : "no_outreach"
}
