// lib/campaigns/channels.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE canonical campaign-channel taxonomy — the ONE source of truth every campaign
// surface derives from, so the creation picker and the engagement feed can never
// drift (the bug: creation offered email/sms/video/direct_mail while the feed also
// showed phone). PURE data (no imports) so client components AND server actions can
// share it without pulling the server-side channel-registry adapters into the bundle.
//
// ── A CHANNEL IS HOW A MESSAGE TRAVELS, NOT WHAT IS IN IT ────────────────────
// Owner ruling, applied here: "video is not a channel. email/phone/voicedrop/
// inapp/sms/blog/direct mail/ad/newsletter/podcast. video is delivered in a sms
// or email."
//
// This file used to list `video` as an OUTREACH channel labelled "Video (D-ID)",
// which put it in the ISA campaign picker as a peer of email and SMS. It is not
// a peer: the video adapter PRODUCES a reel and then delivers it over email —
// read lib/workflow/adapters/video.ts and the last thing it does is
// "Deliver via email if contact has email". So picking "video" was really
// picking "email, with a video in it", and the picker could not say so.
//
// Two things were also MISSING while video sat in their place, both of them
// real, live, dispatchable rails:
//   · voice_drop — voiceDropAdapter, on the canonical TCPA-gated voicedrop rail
//     with a brokerage preset and a provider behind it.
//   · in_app     — inAppAdapter, the portal push notification.
// Both are registered in the workflow registry and both are allowed by the live
// campaign_sequence_steps.channel CHECK. The executor could run them and the
// database would accept them; only THIS layer — the taxonomy the UI reads —
// did not know they existed, so no human could ever choose them.
//
// Each channel carries:
//   · scope        — "outreach" (1:1 to a lead/contact) vs "broadcast" (to an audience).
//                    ISA campaigns are 1:1 outreach; marketing campaigns broadcast.
//   · adapterChannel — the lib/workflow adapter that EXECUTES a 1:1 step (null for
//                    broadcast-only content channels that aren't per-contact sends).
//   · requiresActivation — superadmin-gated capability (direct mail).
//   · carriesVideo — this channel can DELIVER a video attachment (see below).

export type CampaignChannelKey =
  | "email"
  | "sms"
  | "phone"
  | "voice_drop"
  | "in_app"
  | "direct_mail"
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
  /** This channel can carry a rendered video as its payload (see VIDEO_DELIVERY_CHANNELS). */
  carriesVideo?: boolean
}

export const CAMPAIGN_CHANNELS: readonly CampaignChannelSpec[] = [
  { key: "email",       label: "Email",              scope: "outreach",  adapterChannel: "email",       carriesVideo: true },
  { key: "sms",         label: "SMS",                scope: "outreach",  adapterChannel: "sms",         carriesVideo: true },
  { key: "phone",       label: "Phone (AI call)",    scope: "outreach",  adapterChannel: "ai_call" },
  // The ringless voicemail rail — live, provider-backed, TCPA-gated. It was
  // dispatchable by the executor and invisible to every picker.
  { key: "voice_drop",  label: "Voicemail Drop",     scope: "outreach",  adapterChannel: "voice_drop" },
  // The portal push notification — the one channel a client already consented to
  // by having an account, and the cheapest touch the OS owns end to end.
  { key: "in_app",      label: "In-App / Portal",    scope: "outreach",  adapterChannel: "in_app",      carriesVideo: true },
  { key: "direct_mail", label: "Direct Mail",        scope: "outreach",  adapterChannel: "direct_mail", requiresActivation: true },
  { key: "social",      label: "Social",             scope: "broadcast", adapterChannel: "social_post", carriesVideo: true },
  { key: "ads",         label: "Ads",                scope: "broadcast", adapterChannel: "ad_campaign", carriesVideo: true },
  { key: "newsletter",  label: "Newsletter",         scope: "broadcast", adapterChannel: "newsletter",  carriesVideo: true },
  { key: "blog",        label: "Blog",               scope: "broadcast", adapterChannel: null,          carriesVideo: true },
  { key: "podcast",     label: "Podcast",            scope: "broadcast", adapterChannel: null },
] as const

// ── PAYLOADS: what rides a channel, and which channels can carry it ──────────
// Video and a QR code are ATTACHMENTS, not destinations. Modelling them here
// (rather than as fake channels) is what lets a picker say the true thing:
// "send an email, with the reel in it" instead of "send a video".

export type CampaignPayloadKey = "video" | "qr_code"

export interface CampaignPayloadSpec {
  key: CampaignPayloadKey
  label: string
  /** Plain-language statement of what it is and how it reaches a person. */
  what: string
  /** The channels that can deliver it. Empty is impossible — a payload with no
   *  carrier is a payload that never reaches anybody. */
  deliveredBy: readonly CampaignChannelKey[]
  requiresActivation?: boolean
}

export const CAMPAIGN_PAYLOADS: readonly CampaignPayloadSpec[] = [
  {
    key: "video", label: "Video",
    what: "A rendered reel — the agent's avatar and cloned voice, or a templated market/listing cut. It is produced, then delivered inside another channel's message.",
    deliveredBy: ["email", "sms", "in_app", "social", "ads", "newsletter", "blog"],
    requiresActivation: true,
  },
  {
    key: "qr_code", label: "QR Code",
    what: "A tracked code printed on or embedded in a piece. It is a destination marker, not a send — it reaches a person because a postcard, video outro, or flyer carried it.",
    deliveredBy: ["direct_mail", "email", "in_app", "social"],
  },
] as const

/** The channels a rendered video can be delivered through (owner: "video is
 *  delivered in a sms or email"). Structural, so no picker can offer video as a
 *  destination again. */
export const VIDEO_DELIVERY_CHANNELS: readonly CampaignChannelKey[] =
  CAMPAIGN_PAYLOADS.find((p) => p.key === "video")!.deliveredBy

/** The 1:1 subset of the above — what an ISA campaign can attach a reel to. */
export const VIDEO_OUTREACH_CHANNELS: readonly CampaignChannelKey[] =
  VIDEO_DELIVERY_CHANNELS.filter((k) =>
    CAMPAIGN_CHANNELS.some((c) => c.key === k && c.scope === "outreach"))

/** True when this channel can carry a rendered reel. */
export function channelCarriesVideo(key: string): boolean {
  return (VIDEO_DELIVERY_CHANNELS as readonly string[]).includes(key)
}

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
