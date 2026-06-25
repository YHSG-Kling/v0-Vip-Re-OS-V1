// lib/ai-isa/contact-channel-policy.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE CONTACT-SIDE CHANNEL AUTHORITY (pure). A CONVERTED contact consented to a
// relationship, so — unlike an unconsented lead (email / direct-mail only) — the AI ISA
// may use its FULL toolbox: an outbound AI phone CALL, a ringless VOICE DROP, SMS, email,
// or direct mail. This resolves the right channel from the contact's stored preference +
// per-channel opt-outs + TCPA consent. The voice channels (phone / voicedrop) require TCPA
// consent and a clean line; without it the resolver honestly downgrades to a written channel.
//
// PURE — no I/O, exhaustively unit-testable. engage-contact.ts (the server engine) imports
// this so the decision and the dispatch can never drift, and the test can pin every branch.

export interface ContactChannelSignals {
  preferred_channel?: string | null
  email?: string | null
  phone?: string | null
  tcpa_consent?: boolean | null
  email_opt_out?: boolean | null
  sms_opt_out?: boolean | null
  phone_opt_out?: boolean | null
  call_stop_flag?: boolean | null
  direct_mail_opt_out?: boolean | null
  mailing_address?: string | null
}

/** True when a live AI CALL or a voice drop is permitted (consent + a clean, opted-in line). */
export function voiceReachable(c: ContactChannelSignals): boolean {
  return !!c.phone && c.tcpa_consent === true && !c.phone_opt_out && !c.call_stop_flag
}

/**
 * resolveContactChannel — PURE. Map the contact's preference + consent + opt-outs to the
 * channel the ISA should use. Voice channels downgrade to email when not consent-reachable;
 * email downgrades to direct mail when opted out + a mailing address is on file.
 */
export function resolveContactChannel(c: ContactChannelSignals): string {
  const preferred = (c.preferred_channel ?? 'email') as string

  if (preferred === 'phone') {
    return voiceReachable(c) ? 'phone' : 'email'
  }
  if (preferred === 'voicedrop') {
    return voiceReachable(c) ? 'voicedrop' : 'email'
  }
  if (preferred === 'sms') {
    if (c.sms_opt_out || !c.tcpa_consent || !c.phone) return 'email'
    return 'sms'
  }
  if (preferred === 'direct_mail') {
    return c.mailing_address ? 'direct_mail' : 'email'
  }
  // email (default)
  if (c.email_opt_out) {
    return c.mailing_address ? 'direct_mail' : 'email'
  }
  return c.email ? 'email' : 'direct_mail'
}
