// lib/ads/audience-eligibility.ts
//
// PII-SHARE GATE for ad audiences — uploading a contact's email/phone to a Meta Custom Audience is
// a MARKETING DATA-SHARE (CCPA "do not sell/share"), not just an internal use. A contact who has
// WITHDRAWN, or who can no longer be lawfully marketed to on ANY channel (opted out of both email
// and SMS), has revoked that share — their identifiers must not be uploaded for ad targeting.
//
// Pure. Reuses the CANONICAL consent gate (canDispatchToContact) so there is exactly ONE consent
// interpretation across the dispatch path and the audience-sync path — no drift.

import { canDispatchToContact, type ContactConsentState } from "@/lib/compliance/contact-channel-gate"

export interface AudienceEligibilityState extends ContactConsentState {
  nurture_status?: string | null
}

/** The contact columns the eligibility check needs — for the audience-sync `.select()`. */
export const AUDIENCE_CONSENT_COLUMNS =
  "nurture_status, tcpa_consent, dnc_status, email_opt_out, email_unsubscribed, sms_opt_out, sms_unsubscribed, phone_opt_out, opt_out_channels"

/**
 * PURE: may we share this contact's PII with an ad platform? A withdrawn relationship is an
 * outright block; otherwise the contact must still be lawfully marketable on at least one channel
 * (email OR sms) — if they've opted out of every marketing channel, sharing their identifiers for
 * cross-context ad targeting is inconsistent with that opt-out, so we exclude them.
 */
export function isAudienceUploadEligible(c: AudienceEligibilityState): boolean {
  if ((c.nurture_status ?? "").toLowerCase() === "withdrawn") return false
  const emailOk = canDispatchToContact(c, "email").allowed
  const smsOk = canDispatchToContact(c, "sms").allowed
  return emailOk || smsOk
}
