// lib/kernel/deconflict/lead-channel.ts
// PURE (no I/O, no server-only) — so simulators can import it directly. Maps a de-confliction
// channel to the isa_outreach_log.channel value used on the LEAD side: the log stores
// 'direct_mail', the over-touch cap calls that channel 'mail'.

export type DeconflictChannel = "email" | "sms" | "phone" | "mail" | "video"

export function leadLogChannel(channel: DeconflictChannel): string {
  return channel === "mail" ? "direct_mail" : channel
}
