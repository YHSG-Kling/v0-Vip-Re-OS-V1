// lib/campaigns/channels.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE canonical campaign-channel taxonomy — the ONE source of truth every campaign
// surface derives from, so the creation picker and the engagement feed can never
// drift (the bug: creation offered email/sms/video/direct_mail while the feed also
// showed phone). PURE data (no imports) so client components AND server actions can
// share it without pulling the server-side channel-registry adapters into the bundle.
//
// TRUE channels (owner: "channels like email, direct mail, phone, ads, socials,
// blog, newsletter, podcast"). Each carries:
//   · scope        — "outreach" (1:1 to a lead/contact) vs "broadcast" (to an audience).
//                    ISA campaigns are 1:1 outreach; marketing campaigns broadcast.
//   · adapterChannel — the lib/workflow adapter that EXECUTES a 1:1 step (null for
//                    broadcast-only content channels that aren't per-contact sends).
//   · requiresActivation — superadmin-gated capability (video/direct mail).

export type CampaignChannelKey =
  | "email"
  | "sms"
  | "phone"
  | "direct_mail"
  | "video"
  | "social"
  | "ads"
  | "newsletter"
  | "blog"
  | "podcast"

export interface CampaignChannelSpec {
  key: CampaignChannelKey
  label: string
  scope: "outreach" | "broadcast"
  /** The workflow channel adapter key that runs a 1:1 step, if any (see lib/workflow/adapters). */
  adapterChannel: string | null
  /** Superadmin-gated capability (contact platform admin to enable). */
  requiresActivation?: boolean
}

export const CAMPAIGN_CHANNELS: readonly CampaignChannelSpec[] = [
  { key: "email",       label: "Email",           scope: "outreach",  adapterChannel: "email" },
  { key: "sms",         label: "SMS",             scope: "outreach",  adapterChannel: "sms" },
  { key: "phone",       label: "Phone (AI call)", scope: "outreach",  adapterChannel: "ai_call" },
  { key: "direct_mail", label: "Direct Mail",     scope: "outreach",  adapterChannel: "direct_mail", requiresActivation: true },
  { key: "video",       label: "Video (D-ID)",    scope: "outreach",  adapterChannel: "video",       requiresActivation: true },
  { key: "social",      label: "Social",          scope: "broadcast", adapterChannel: "social_post" },
  { key: "ads",         label: "Ads",             scope: "broadcast", adapterChannel: "ad_campaign" },
  { key: "newsletter",  label: "Newsletter",      scope: "broadcast", adapterChannel: "newsletter" },
  { key: "blog",        label: "Blog",            scope: "broadcast", adapterChannel: null },
  { key: "podcast",     label: "Podcast",         scope: "broadcast", adapterChannel: null },
] as const

/** 1:1 outreach channels — what an ISA (lead/contact) campaign may use. */
export const OUTREACH_CHANNELS: readonly CampaignChannelSpec[] =
  CAMPAIGN_CHANNELS.filter((c) => c.scope === "outreach")

/** Broadcast/content channels — the marketing-campaign surface (campaign_orchestrator). */
export const BROADCAST_CHANNELS: readonly CampaignChannelSpec[] =
  CAMPAIGN_CHANNELS.filter((c) => c.scope === "broadcast")

const CHANNEL_KEYS = new Set<string>(CAMPAIGN_CHANNELS.map((c) => c.key))
const OUTREACH_KEYS = new Set<string>(OUTREACH_CHANNELS.map((c) => c.key))

/** Keep only recognized channel keys (drops unknown/garbage). */
export function sanitizeChannels(channels: string[]): CampaignChannelKey[] {
  return channels.filter((c): c is CampaignChannelKey => CHANNEL_KEYS.has(c))
}

/** Keep only valid 1:1 OUTREACH channels — what an ISA campaign is allowed to run. */
export function sanitizeOutreachChannels(channels: string[]): CampaignChannelKey[] {
  const seen = new Set<string>()
  const out: CampaignChannelKey[] = []
  for (const c of channels) {
    if (OUTREACH_KEYS.has(c) && !seen.has(c)) { seen.add(c); out.push(c as CampaignChannelKey) }
  }
  return out
}
