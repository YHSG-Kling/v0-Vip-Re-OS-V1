// lib/ai-isa/next-best-touch.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE NEXT-BEST-TOUCH DECISION — the manager (AI ISA) autonomously DECIDES which channel a
// contact's next follow-up should use, instead of always firing the one stored preference.
// The decision blends three signals, in priority:
//
//   1. LEARNED ENGAGEMENT — the channels this person (or the brokerage) actually REPLIES to
//      (rankChannelsByReplyRate). What works beats what we guessed.
//   2. AGE-GROUP PSYCHOLOGY — how each generation prefers to be reached (gen-z is text/video-
//      first and screens calls; boomers answer the phone; the silent gen wants a call or mail).
//      This is the them-first, relationship-science layer that converts.
//   3. ROTATION — never hammer the same channel twice in a row when alternatives exist; a
//      multi-touch sequence that varies channels out-converts a monotonous one.
//
// Always within the CONSENT-permitted set (voice/SMS need TCPA). PURE — no I/O, exhaustively
// testable; engageContact resolves the inputs and dispatches the chosen channel.

import type { GenerationalCohort } from "@/lib/kernel/education"

/** The dispatchable 1:1 channels the ISA chooses between (portal always rides along separately). */
export type TouchChannel = "email" | "sms" | "phone" | "voicedrop" | "direct_mail"

export interface ContactConsentState {
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

/** PURE. The channels CONSENT permits for this contact (voice/SMS require TCPA + a clean line). */
export function permittedContactChannels(c: ContactConsentState): TouchChannel[] {
  const out: TouchChannel[] = []
  if (c.email && !c.email_opt_out) out.push("email")
  const voiceOk = !!c.phone && c.tcpa_consent === true && !c.phone_opt_out
  if (voiceOk && !c.sms_opt_out) out.push("sms")
  if (voiceOk && !c.call_stop_flag) { out.push("phone"); out.push("voicedrop") }
  if (c.mailing_address && !c.direct_mail_opt_out) out.push("direct_mail")
  return out
}

/** PURE. How each generation prefers to be reached — the relationship-science channel order. */
export function ageGroupChannelAffinity(cohort: GenerationalCohort): TouchChannel[] {
  switch (cohort) {
    case "gen_z":      return ["sms", "voicedrop", "email", "direct_mail", "phone"]   // text/video-first, screens live calls
    case "millennial": return ["email", "sms", "voicedrop", "phone", "direct_mail"]   // email + text
    case "gen_x":      return ["email", "phone", "sms", "direct_mail", "voicedrop"]    // email, will pick up
    case "boomer":     return ["phone", "email", "voicedrop", "direct_mail", "sms"]    // phone + email + mail
    case "silent":     return ["phone", "direct_mail", "email", "voicedrop", "sms"]    // phone + mail
    case "unknown":    return ["email", "sms", "phone", "voicedrop", "direct_mail"]
  }
}

export interface NextChannelDecision {
  channel: TouchChannel | "no_channel"
  reason: string
}

/**
 * decideNextChannel — PURE. Pick the contact's next-touch channel: the best-engaged permitted
 * channel, then age-group affinity, ROTATED off the last channel used when an alternative
 * exists. Returns "no_channel" only when consent permits nothing.
 */
export function decideNextChannel(args: {
  permitted: TouchChannel[]
  cohort: GenerationalCohort
  /** Channels ranked by this contact's / brokerage's real reply rate (best first). Optional. */
  learnedRanked?: string[]
  /** The channel used on the PREVIOUS touch — rotated away from when possible. */
  lastChannel?: string | null
}): NextChannelDecision {
  const permitted = new Set(args.permitted)
  if (permitted.size === 0) return { channel: "no_channel", reason: "consent permits no channel" }

  // Candidate order: learned engagement first, then age-group affinity; dedup; keep permitted.
  const ordered: TouchChannel[] = []
  const push = (ch: string) => { if (permitted.has(ch as TouchChannel) && !ordered.includes(ch as TouchChannel)) ordered.push(ch as TouchChannel) }
  for (const ch of args.learnedRanked ?? []) push(ch)
  for (const ch of ageGroupChannelAffinity(args.cohort)) push(ch)

  if (ordered.length === 0) {
    // Permitted set didn't intersect the ranked/affinity lists — fall to any permitted.
    const any = args.permitted[0]
    return { channel: any, reason: `only ${any} is permitted` }
  }

  // ROTATION — avoid repeating the last channel when there's another option.
  let chosen = ordered[0]
  let rotated = false
  if (args.lastChannel && chosen === args.lastChannel && ordered.length > 1) {
    chosen = ordered.find((c) => c !== args.lastChannel) ?? chosen
    rotated = true
  }

  const why = (args.learnedRanked ?? []).includes(chosen)
    ? "best-engaged"
    : `${args.cohort.replace("_", "-")} affinity`
  return { channel: chosen, reason: `${chosen} (${why}${rotated ? `, rotated off ${args.lastChannel}` : ""})` }
}
