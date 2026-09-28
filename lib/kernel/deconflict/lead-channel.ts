// lib/kernel/deconflict/lead-channel.ts
// PURE (no I/O, no server-only) — so simulators can import it directly.
// ─────────────────────────────────────────────────────────────────────────────
// ONE ENGINE CHANNEL, THREE SOURCE VOCABULARIES.
//
// The de-confliction engine has its OWN channel names (email|sms|phone|mail) and
// sums touches across three ledgers — each of which spells its channels
// differently, under its own CHECK:
//
//   isa_outreach_log.channel
//     email | direct_mail | video | sms | in_app | voice | social
//   marketing_campaign_touchpoints.channel
//     email | sms | direct_mail | social | qr_scan | blog | podcast |
//     newsletter | phone | portal | video
//   lifetime_customer_touchpoints.channel
//     video | sms | email | call | in_app | direct_mail | push
//
// This module used to translate ONE of those pairs (mail → direct_mail) and only
// on the lead side. Everywhere else the engine's own word went straight into the
// filter, and a filter on a value a column cannot hold returns zero rows — which
// on an over-touch cap is not an error, it is a PERMISSION. The two channels
// that were wrong are the two with the most exposure:
//
//   · phone — countPhoneTouches asked isa_outreach_log for channel='phone'. That
//     column says 'voice'. Every AI-ISA call was invisible to the cap, so the
//     "1 call / 7 days" policy could never fire. It also never queried
//     lifetime_customer_touchpoints at all, whose word is 'call'.
//   · mail  — countMailTouches asked BOTH touchpoint tables for channel='mail'.
//     Both say 'direct_mail'. Only direct_mail_recipients was ever counted, so a
//     campaign or lifetime mail piece did not count toward "1 piece / 30 days".
//
// email / sms happened to spell the same in every table, which is why half the
// channels worked and the failure looked like normal quiet.
//
// The mapping is now per TABLE, exhaustive, and pinned by
// scripts/deconflict-channel-simulator.ts against the live CHECK vocabularies —
// so a source table that renames a channel breaks the guard instead of silently
// uncapping a lane.

// OWNER RULING: video is NOT a channel. The channels are email / phone /
// voicedrop / in-app / sms / blog / direct mail / ad / newsletter / podcast — and
// a video is DELIVERED IN an sms or an email. The de-confliction cap therefore
// governs the delivery channels; a video send consumes the allowance of whatever
// carried it (dispatchVideo takes a recipientEmail, so it consumes email).
export type DeconflictChannel = "email" | "sms" | "phone" | "mail"

/** The ledgers the engine sums, each with its own channel vocabulary. */
export type TouchSourceTable =
  | "isa_outreach_log"
  | "marketing_campaign_touchpoints"
  | "lifetime_customer_touchpoints"

/**
 * Every engine channel mapped to the literal each table actually stores.
 *
 * `null` means "this table has no lane for that channel" — the counter must
 * then SKIP the query rather than run one that cannot match, which is the exact
 * mistake this module exists to prevent. Nothing maps to null today; the type
 * keeps the honest answer available when a fourth source is added.
 */
const CHANNEL_BY_TABLE: Record<TouchSourceTable, Record<DeconflictChannel, string | null>> = {
  isa_outreach_log: {
    email: "email",
    sms:   "sms",
    phone: "voice",          // the log's word for a call
    mail:  "direct_mail",
  },
  marketing_campaign_touchpoints: {
    email: "email",
    sms:   "sms",
    phone: "phone",          // this table really does say 'phone'
    mail:  "direct_mail",
  },
  lifetime_customer_touchpoints: {
    email: "email",
    sms:   "sms",
    phone: "call",           // this table's word for a call
    mail:  "direct_mail",
  },
}

/** PURE — the channel literal `table` stores for this engine channel. */
export function sourceChannel(table: TouchSourceTable, channel: DeconflictChannel): string | null {
  return CHANNEL_BY_TABLE[table][channel] ?? null
}

/**
 * PURE — the isa_outreach_log.channel value for a de-confliction channel.
 * Kept as the named export the lead-side counter already used; it is now just
 * the isa_outreach_log row of the table above, so the two can never disagree.
 */
export function leadLogChannel(channel: DeconflictChannel): string {
  return CHANNEL_BY_TABLE.isa_outreach_log[channel] ?? channel
}

/** Every table the engine reads, for the guard to iterate. */
export const TOUCH_SOURCE_TABLES = [
  "isa_outreach_log",
  "marketing_campaign_touchpoints",
  "lifetime_customer_touchpoints",
] as const satisfies readonly TouchSourceTable[]

// ─── THE CONTACT TOUCH LEDGER — shared with contact fatigue (wave 88, lane 88A) ──────────────
//
// Owner, verbatim: "I feel like over contacting is already built." It is — this engine. So contact
// fatigue (lib/fatigue/fatigue-calculator.ts) does not keep a second list of "what counts as a
// touch": it READS the over-touch engine's own ledgers, timestamps, channel words and policy from
// here, and lib/kernel/deconflict/index.ts counts through the same descriptors. One vocabulary (§6):
// a touch the cap counts is a follow-up fatigue counts, and a channel the cap calls saturated is the
// channel fatigue reports as saturated.

/** Every ledger the over-touch cap counts for a CONTACT: the two channel-implicit tables (the whole
 *  table is one channel) plus the three channel-mapped ones above. */
export const CONTACT_TOUCH_LEDGERS = [
  "email_sends",
  "direct_mail_recipients",
  ...TOUCH_SOURCE_TABLES,
] as const
export type ContactTouchLedger = (typeof CONTACT_TOUCH_LEDGERS)[number]

/** PURE — the column that dates a touch in each ledger (the one the cap's window filters on). */
export function touchTimestampColumn(table: ContactTouchLedger): "sent_at" | "mailed_at" | "created_at" {
  if (table === "direct_mail_recipients") return "mailed_at"
  if (table === "lifetime_customer_touchpoints") return "created_at"
  return "sent_at"
}

/** PURE — the engine channel a stored ledger row belongs to (the inverse of sourceChannel).
 *  email_sends / direct_mail_recipients are channel-implicit; a stored word no engine channel maps
 *  to (a 'video' / 'social' / 'in_app' row) is null — it is not a capped channel. */
export function touchChannelOf(table: ContactTouchLedger, stored: string | null | undefined): DeconflictChannel | null {
  if (table === "email_sends") return "email"
  if (table === "direct_mail_recipients") return "mail"
  if (!stored) return null
  for (const ch of DECONFLICT_CHANNELS) if (CHANNEL_BY_TABLE[table][ch] === stored) return ch
  return null
}

export interface DeconflictChannelPolicy {
  maxTouches: number
  windowDays: number
}

/** THE default per-contact over-touch policy (per channel, rolling window) — moved here from
 *  lib/kernel/deconflict/index.ts (which imports it) so the PURE fatigue reader shares it. */
export const DEFAULT_DECONFLICT_POLICY: Record<DeconflictChannel, DeconflictChannelPolicy> = {
  email: { maxTouches: 3, windowDays: 14 },
  sms:   { maxTouches: 1, windowDays: 7 },
  phone: { maxTouches: 1, windowDays: 7 },
  mail:  { maxTouches: 1, windowDays: 30 },
}

export interface SaturatedChannel {
  channel: DeconflictChannel
  touchesInWindow: number
  policyMax: number
  windowDays: number
}

/** PURE — the channels on which a contact is AT or OVER the over-touch cap right now: the next send
 *  on that channel is the one evaluateDeconflict would suppress (`touches < maxTouches` is its allow
 *  rule, so `touches >= maxTouches` is saturated). Each channel counts over its OWN window. */
export function saturatedChannels(
  touches: ReadonlyArray<{ channel: DeconflictChannel | null; at: string | null }>,
  now: number = Date.now(),
  policy: Record<DeconflictChannel, DeconflictChannelPolicy> = DEFAULT_DECONFLICT_POLICY,
): SaturatedChannel[] {
  const out: SaturatedChannel[] = []
  for (const channel of DECONFLICT_CHANNELS) {
    const p = policy[channel]
    const since = now - p.windowDays * 86_400_000
    const n = touches.filter((t) => {
      if (t.channel !== channel || !t.at) return false
      const at = Date.parse(t.at)
      return Number.isFinite(at) && at >= since && at <= now
    }).length
    if (n >= p.maxTouches) out.push({ channel, touchesInWindow: n, policyMax: p.maxTouches, windowDays: p.windowDays })
  }
  return out
}

/** @proofSeam the engine reads channels per touch row through CHANNEL_BY_TABLE / leadLogChannel and is typed by DeconflictChannel; the roster exists so scripts/deconflict-channel-simulator.ts can sweep every channel × every touch table (TOUCH_SOURCE_TABLES) and prove each spelling round-trips. */
export const DECONFLICT_CHANNELS = ["email", "sms", "phone", "mail"] as const
