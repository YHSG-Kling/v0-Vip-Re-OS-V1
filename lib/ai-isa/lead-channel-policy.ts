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
// Wave 91 (lane 91B): the SEND doors ask `channelRefusalForRecipient` below — proof:
// scripts/lead-channel-rule-guard.ts (npm run test:lead-channel-rule).

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
  // The roster IS the rule: a requested channel outside LEAD_ALLOWED_CHANNELS
  // (sms/phone/social/…) is treated as if nothing was requested and falls into
  // the email-first ladder — so the compliance floor is decided by membership in
  // the one exported list the simulator proves, not by a literal comparison that
  // could drift from it (lane 80E: the roster was exported for the proof and
  // read by no runtime code).
  const raw = input.requestedChannel ?? "email"
  const requested = (LEAD_ALLOWED_CHANNELS as readonly string[]).includes(raw) ? raw : "email"
  if (requested === "direct_mail") {
    return input.mailingVerified ? "direct_mail" : input.emailUsable ? "email" : "no_outreach"
  }
  // email (or any non-allowed channel, collapsed above) → email-first ladder
  return input.emailUsable ? "email" : input.mailingVerified ? "direct_mail" : "no_outreach"
}

// ─── THE LEAD-STAGE SEND REFUSAL (wave 91, lane 91B) ─────────────────────────
//
// Owner, verbatim (2026-09-30): "Leads usually are non consenting so no sms or calls allowed
// only email and direct mail." `pickLeadOutreachChannel` above CHOOSES a channel for the ISA's
// own first touch; nothing enforced the rule at the doors that actually SEND. dispatchSms, the
// TCPA chokepoint (lib/communication/tcpa-gate.ts) and the pre-dial stack
// (lib/voice/outbound-call-gates.ts) all admitted a LEAD-keyed or number-only SMS/voice send
// whenever no contactId rode with it — the TCPA gate's consent block is skipped entirely
// without a contactId. This is the ONE predicate every such door now asks, on the same roster
// the chooser uses (LEAD_ALLOWED_CHANNELS), so the chooser and the doors cannot disagree.
//
// Contacts are NOT judged here: a contact's SMS/voice stays under its own consent rules
// (TCPA express consent, opt-outs, DNC — lib/ai-isa/contact-channel-policy.ts and the TCPA gate).

/** The stage a recipient is being addressed at. */
export type RecipientStage = "lead" | "contact"

/** Spellings across the tree's channel vocabularies that are CARRIED BY email or by mail.
 *  Everything else — sms / text / phone / call / voice / voicemail / voicedrop / ai_call /
 *  social / an unknown word — is refused for a lead (fail closed). */
const LEAD_CHANNEL_ALIASES: Record<string, (typeof LEAD_ALLOWED_CHANNELS)[number]> = {
  email: "email",
  newsletter: "email",
  video_email: "email",
  email_video: "email",
  direct_mail: "direct_mail",
  mail: "direct_mail",
  postcard: "direct_mail",
  letter: "direct_mail",
}

/** PURE — the canonical lead channel a spelling means, or null when it is not email/mail. */
function canonicalLeadChannel(channel: string | null | undefined): (typeof LEAD_ALLOWED_CHANNELS)[number] | null {
  const key = (channel ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_")
  return LEAD_CHANNEL_ALIASES[key] ?? null
}

/**
 * leadStageChannelRefusal — PURE. null when `channel` is permitted for a LEAD (email or direct
 * mail, by LEAD_ALLOWED_CHANNELS); otherwise the refusal reason. SMS and every voice spelling
 * are refused; so is any channel this module does not recognise (fail closed).
 */
export function leadStageChannelRefusal(channel: string | null | undefined): string | null {
  const canonical = canonicalLeadChannel(channel)
  if (canonical && (LEAD_ALLOWED_CHANNELS as readonly string[]).includes(canonical)) return null
  return (
    `lead-stage recipient: channel '${channel ?? "unknown"}' refused — leads are non-consenting, ` +
    `so no SMS and no calls; only email and direct mail. A lead reaches SMS/voice only after it ` +
    `converts to a contact (positive intent) and then under the contact's own consent rules.`
  )
}

/** PURE — which stage the keys a send carries address. A contactId means the contact (its own
 *  consent rules apply); a leadId without one means the LEAD; neither is unknown (null) — the
 *  TCPA gate resolves a number-only send by phone. */
function recipientStageOf(keys: { contactId?: string | null; leadId?: string | null }): RecipientStage | null {
  if (keys.contactId) return "contact"
  if (keys.leadId) return "lead"
  return null
}

/** PURE — THE question every SMS / voice door asks: refused for this recipient on this channel?
 *  null for a contact (consent is judged elsewhere) and for an unknown stage. */
export function channelRefusalForRecipient(
  keys: { contactId?: string | null; leadId?: string | null },
  channel: string | null | undefined,
): string | null {
  return recipientStageOf(keys) === "lead" ? leadStageChannelRefusal(channel) : null
}
