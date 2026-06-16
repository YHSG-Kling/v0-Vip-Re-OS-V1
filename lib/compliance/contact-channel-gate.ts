// lib/compliance/contact-channel-gate.ts
//
// CANONICAL pre-dispatch suppression gate — the single place that answers "is it
// legal to send this channel to this contact RIGHT NOW?". Every outbound client
// message flows through here before it leaves the building (approveClientMessage).
// Conservative by design: any opt-out / unsubscribe / DNC on the relevant channel
// is a HARD block (TCPA/CAN-SPAM lawsuit-safe), and portal/portal_push (the
// consumer's own logged-in portal, not outbound marketing) is always allowed.
//
// Pure (no I/O): callers pass the contact's consent columns, so this is unit-tested
// directly and reused by both the dispatch gate and the compliance ledger.

export type DispatchChannel = "portal" | "portal_push" | "email" | "sms" | "voice_drop"

/** The consent-relevant columns on a contact (all live booleans + the array). */
export interface ContactConsentState {
  tcpa_consent?:       boolean | null
  dnc_status?:         boolean | null
  email_opt_out?:      boolean | null
  email_unsubscribed?: boolean | null
  sms_opt_out?:        boolean | null
  sms_unsubscribed?:   boolean | null
  phone_opt_out?:      boolean | null
  opt_out_channels?:   string[] | null
}

export interface ChannelGateResult {
  allowed: boolean
  /** Lawsuit-safe, human-readable reason a send was blocked (logged + surfaced). */
  reason?: string
}

function optedOutOfChannel(state: ContactConsentState, channel: string): boolean {
  return Array.isArray(state.opt_out_channels) && state.opt_out_channels.includes(channel)
}

/**
 * Decide whether `channel` may be dispatched to a contact in the given consent state.
 * Pure + conservative — a missing/false consent for a regulated channel blocks.
 */
export function canDispatchToContact(state: ContactConsentState, channel: DispatchChannel): ChannelGateResult {
  switch (channel) {
    case "portal":
    case "portal_push":
      // The consumer's own portal — consumer-initiated surface, never outbound marketing.
      return { allowed: true }

    case "email": {
      // CAN-SPAM: honor unsubscribe / opt-out. No prior express consent required for
      // transactional client updates, but a recorded opt-out is an absolute block.
      if (state.email_unsubscribed) return { allowed: false, reason: "contact unsubscribed from email" }
      if (state.email_opt_out)      return { allowed: false, reason: "contact opted out of email" }
      if (optedOutOfChannel(state, "email")) return { allowed: false, reason: "email in contact opt_out_channels" }
      return { allowed: true }
    }

    case "sms": {
      // TCPA: SMS requires prior express consent AND no opt-out / DNC.
      if (!state.tcpa_consent)    return { allowed: false, reason: "TCPA consent required for SMS — not sent" }
      if (state.dnc_status)       return { allowed: false, reason: "contact is on the do-not-call list" }
      if (state.sms_unsubscribed) return { allowed: false, reason: "contact replied STOP / unsubscribed from SMS" }
      if (state.sms_opt_out)      return { allowed: false, reason: "contact opted out of SMS" }
      if (optedOutOfChannel(state, "sms")) return { allowed: false, reason: "sms in contact opt_out_channels" }
      return { allowed: true }
    }

    case "voice_drop": {
      // TCPA: ringless voicemail to a client requires consent AND no opt-out / DNC.
      if (!state.tcpa_consent) return { allowed: false, reason: "TCPA consent required for voice — not sent" }
      if (state.dnc_status)    return { allowed: false, reason: "contact is on the do-not-call list" }
      if (state.phone_opt_out) return { allowed: false, reason: "contact opted out of phone contact" }
      if (optedOutOfChannel(state, "voice") || optedOutOfChannel(state, "voice_drop"))
        return { allowed: false, reason: "voice in contact opt_out_channels" }
      return { allowed: true }
    }

    default:
      return { allowed: false, reason: `unknown channel '${channel}'` }
  }
}

/** The contact columns the gate needs — for a `.select()` in the dispatch path. */
export const CONTACT_CONSENT_COLUMNS =
  "tcpa_consent, dnc_status, email_opt_out, email_unsubscribed, sms_opt_out, sms_unsubscribed, phone_opt_out, opt_out_channels"

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL PREFERENCE (distinct from consent).
//
// The consent gate above answers "is it LEGAL to send this channel?". This answers
// a different question: "does the contact WANT this channel?". A client who told us
// "email me, don't text" has given SMS consent (tcpa_consent=true) yet still doesn't
// want texts — consent says yes, preference says no. AI-ISA speed-to-lead already
// honors preferred_channel; the manager/agent send path did not, so a manager could
// fire an SMS at someone who asked for email-only. This closes that gap at the same
// provable chokepoint as consent (approveClientMessage), keeping the human in control:
// a violating send is BLOCKED with a reason that names the channel to re-propose on.
//
// Pure + conservative: only an EXPLICIT preference that maps to one of our dispatch
// rails blocks a mismatched channel. No preference, or a preference we can't honor on
// these rails (direct_mail / social), never blocks — we don't fabricate enforcement.

/** Map a stored preferred_channel value to the dispatch "family" it corresponds to. */
function preferenceFamily(preferred: string | null | undefined): "email" | "sms" | "voice" | null {
  switch ((preferred ?? "").trim().toLowerCase()) {
    case "email": return "email"
    case "sms":   case "text": return "sms"
    case "phone": case "call": case "voice": return "voice"
    // direct_mail / facebook / instagram / linkedin / twitter / "" → not a rail we honor here
    default: return null
  }
}

/** Map a dispatch channel to the family a preference is expressed in. */
function channelFamily(channel: DispatchChannel): "email" | "sms" | "voice" | "portal" {
  if (channel === "email") return "email"
  if (channel === "sms") return "sms"
  if (channel === "voice_drop") return "voice"
  return "portal"
}

/**
 * Decide whether dispatching `channel` honors the contact's stated channel preference.
 * Pure. Portal is always honored (the consumer's own surface). A blocked result names
 * the preferred channel so the manager can re-propose on the right rail.
 */
export function honorsChannelPreference(
  preferredChannel: string | null | undefined,
  channel: DispatchChannel,
): ChannelGateResult {
  const fam = channelFamily(channel)
  if (fam === "portal") return { allowed: true } // consumer's own surface — preference n/a

  const pref = preferenceFamily(preferredChannel)
  if (!pref) return { allowed: true }            // no honorable preference on file
  if (pref === fam) return { allowed: true }      // proposed channel matches preference

  const label = pref === "voice" ? "phone/voice" : pref
  return { allowed: false, reason: `contact prefers ${label} — re-propose on their preferred channel instead of ${fam}` }
}

/** The preference column the preference gate needs — for a `.select()` in the dispatch path. */
export const CONTACT_PREFERENCE_COLUMN = "preferred_channel"
