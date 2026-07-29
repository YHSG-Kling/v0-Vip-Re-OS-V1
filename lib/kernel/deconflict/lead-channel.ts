// lib/kernel/deconflict/lead-channel.ts
// PURE (no I/O, no server-only) — so simulators can import it directly.
// ─────────────────────────────────────────────────────────────────────────────
// ONE ENGINE CHANNEL, FOUR SOURCE VOCABULARIES.
//
// The de-confliction engine has its OWN channel names (email|sms|phone|mail|
// video) and sums touches across four ledgers — each of which spells its
// channels differently, under its own CHECK:
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
// email / sms / video happened to spell the same in every table, which is why
// three of five channels worked and the failure looked like normal quiet.
//
// The mapping is now per TABLE, exhaustive, and pinned by
// scripts/deconflict-channel-simulator.ts against the live CHECK vocabularies —
// so a source table that renames a channel breaks the guard instead of silently
// uncapping a lane.

export type DeconflictChannel = "email" | "sms" | "phone" | "mail" | "video"

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
    video: "video",
  },
  marketing_campaign_touchpoints: {
    email: "email",
    sms:   "sms",
    phone: "phone",          // this table really does say 'phone'
    mail:  "direct_mail",
    video: "video",
  },
  lifetime_customer_touchpoints: {
    email: "email",
    sms:   "sms",
    phone: "call",           // this table's word for a call
    mail:  "direct_mail",
    video: "video",
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

export const DECONFLICT_CHANNELS = ["email", "sms", "phone", "mail", "video"] as const
