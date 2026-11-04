// lib/ai-isa/followup-arbiter.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE FOLLOW-UP ARBITER — "AI always listening" (wave 143, lane 143E).
//
// OWNER RULING (wave 143): "Follow-up/touchpoints must NOT be hard-coded: managers check intent and determine the
// proper follow-up, which can include an avatar video generated on the fly. The follow-up timetable must not depend
// on code — autonomous AI, 'AI always listening', so customers feel an agent is always helping."
//
// THE SPLIT (CONSTITUTION LAW 4 — AI manager → tool → authority → policy → capability → domain service; never LLM → SQL):
//   DETERMINISTIC, UNCHANGED  every legal / consent / delivery / spend limit. The planners
//                            (lib/ai-isa/lead-action-plan.ts planNextBestExperience / planNextContactTouch, the
//                            re-engagement stop conditions in reengagement-policy.ts, the dispatch gate) still decide
//                            what is POSSIBLE: a dead end, an opt-out, DNC, no TCPA consent, quiet hours, an active
//                            appointment, an agent already handling it, a hard compliance flag, the fatigue floor.
//                            Those produce a LOCKED verdict and the model is never asked.
//   AI, THIS MODULE           what is BEST among what is permitted. Given intent, history, recent events, journey stage,
//                            urgency, preferences, engagement, relationship, fatigue and the tenant's own guidance
//                            (lib/ai-isa/followup-policy.ts), the model picks ONE option from a closed menu built by
//                            the planner — email / SMS / task for a human / property or market info / education /
//                            an on-the-fly avatar video (the Asset Manager's existing video rail) / wait — and, for a
//                            wait, HOW LONG. It cannot name an option that is not on the menu, a channel that is not
//                            permitted, or a wait outside the policy's bounds; anything invalid keeps the planner's own
//                            verdict (source "deterministic", reason stated) — so a model outage degrades to the old
//                            behaviour, never to an unchecked send.
//   EVIDENCE                 every decision carries its rationale, the fact keys it used, its confidence and its source;
//                            the callers write it onto the action ledger (recordAndExecuteExperience → detail.arbitration;
//                            recordArbitration for the cadence). Spend is booked by generateObjectRouted
//                            (feature `followup_arbitration`, ai_tool_usage) behind mayUseAndAfford, and one sweep
//                            spends at most policy.arbiter.maxDecisionsPerRun decisions.
//
// WHAT THE MODEL NEVER SEES: financials (commission, cost, margin, payout), protected-class-adjacent memory (only
// ARBITER_MEMORY_KEYS pass), the generational cohort the channel-affinity table keys on, or another tenant's data.
//
// Not server-only: scripts/intent-driven-followup-guard.ts drives it with an injected `decide`. The model call is a
// lazy import at the call.
//
// ── WAVE 144 (lane 144F) — THE CHANNEL SPACE, THE STANCE, THE SIGNALS ─────────────────────────────────────────────────────
// OWNER RULINGS 11-13: "The arbiter's channel space is missing DIRECT MAIL (and must consider voice call, voice drop where lawful,
// AI avatar/personalized video, social, ads, portal, human task, other registered channels) … Never conflate a creative format
// with a delivery channel. Follow-up timing is dynamic (… → ACT NOW / WAIT / EDUCATE / NOTIFY HUMAN / CHANGE CHANNEL).
// Explicit exceptions: speed-to-lead and the ONE fixed send." and "If a customer's life changes or online intent behaviour shows
// they are thinking of moving, possibly refinancing … that TRIGGERS an action … through a governed evaluation and next-best action."
//
// WHAT WAS MEASURED AT 967a4866 (the defect this section fixes):
//   · `ArbiterChannel = email | sms | voice | video | portal` — a FIFTH channel vocabulary beside the campaign taxonomy
//     (lib/campaigns/channels.ts CAMPAIGN_CHANNELS: email/sms/phone/voice_drop/in_app/direct_mail/social/ads/…), the ISA
//     settings (`contact_allowed_channels`: email/sms/PHONE/direct_mail), the next-best-touch engine (phone/VOICEDROP) and the
//     de-confliction cap (email/sms/phone/MAIL). The menu filtered "voice" against the settings' "phone", so a live call or a
//     voice drop could NEVER be offered (ai_isa_settings has 0 rows live — every tenant runs the defaults, which permit phone);
//     direct mail was PERMITTED by every tenant's settings and never on the menu; "portal" never matched any setting, so
//     education/properties could not ride the portal; and "video" sat in the channel list although the dispatcher and the
//     campaign taxonomy both rule that video is a payload delivered BY a channel (lib/providers/dispatch.ts "VIDEO IS NOT A CHANNEL").
//   · consent, frequency, cost and provider were never asked per channel: the menu knew only the tenant's checkbox list.
//
// THE SURVIVORS THIS SECTION IS BUILT ON (nothing re-implemented):
//   · the vocabulary   ArbiterChannel IS the 1:1 half of CampaignChannelKey (+ human_task) — a Record keyed by the arbiter's
//                       channels with CampaignChannelKey values makes any drift a compile error; video rides a channel through
//                       the taxonomy's own VIDEO_DELIVERY_CHANNELS (channelCarriesVideo).
//   · consent           the same rules lib/ai-isa/next-best-touch.ts permittedContactChannels and lead-channel-policy encode
//                       (TCPA for sms / call / voice drop, CAN-SPAM opt-out for email, mail opt-out, leads = email + mail only).
//   · frequency         the de-confliction cap's SATURATED channels as the fatigue calculator measured them
//                       (buyer_fatigue_scores.contributing_factors.saturated_channels ← lib/kernel/deconflict/lead-channel.ts
//                       saturatedChannels) — one vocabulary with the cap the dispatcher enforces.
//   · cost / budget     VENDOR_PRICING / DIRECT_MAIL_PIECE_COST_USD (lib/vendor-governance/cost-normalizer.ts, the ONE price) and
//                       mayUseAndAfford (lib/billing/billing-access.ts, the ONE budget answer).
//   · provider          getBrokerageProviderReadiness (lib/platform/provider-posture.ts, the ONE readiness scan).
// Every one of these is a PRE-CHECK that shapes the menu; the dispatcher's own gates stay authoritative at the send.
//
// Not server-only (unchanged): the readiness function is pure; its loader takes an injected client and lazy-imports the rest.
//
// ── WAVE 145 (lane 145E) — SPEED-TO-LEAD IS THE ARBITER'S DECISION; PROVIDER TRUTH COMES FROM ONE MATRIX ───────────────────────
// OWNER RULING 16 (2026-10-27): "Speed to lead should be consumed by the followup-arbiter and should be the arbiter decision." This
// SUPERSEDES the wave-144 reading (ruling 12) that made the speed-to-lead first touch a FIXED send the model was never asked about.
// Now `priority: "speed_to_lead"` is a HIGH-PRIORITY REQUIREMENT inside the judgment, not an exemption from it:
//   · the hard stops still LOCK first (DNC, opt-out, the NBA's blocking verdicts) — the model is never asked about a locked person;
//   · the menu is narrowed to the ways of ANSWERING NOW — a first touch on any permitted channel, or a person (notify human) —
//     and WAIT is never offered, so the requirement cannot be deferred;
//   · the model weighs stage, authority (approval), consent, channel, urgency, preference, budget and existing activity and picks;
//   · an outage / refused reply / spent budget / a tenant that turned the arbiter off falls to the deterministic first touch on the
//     planner's channel — speed-to-lead never degrades into a wait.
// The LEAD half (an unassigned, ISA-owned lead — email / direct mail only, CLAUDE.md §5) is arbitrateSpeedToLead below; the
// sweeper lib/ai-isa/speed-to-lead.ts now dispatches the ARBITER's channel for both halves instead of its own fixed cascade.
// CONTRACT C1: the channel → provider readiness rules are lane 145D's CHANNEL_PROVIDER_MATRIX (lib/providers/channel-provider-matrix.ts),
// imported — the inline CHANNEL_PROVIDER_RULES this file carried is retired (tombstone at the readiness loader).

import type { ExperienceKind, NextBestExperienceInput, NextBestExperiencePlan, RankedExperience } from "./lead-action-plan"
import type { FollowupPolicy } from "./followup-policy"
import { channelCarriesVideo, type CampaignChannelKey } from "@/lib/campaigns/channels"
import { CHANNEL_PROVIDER_MATRIX } from "@/lib/providers/channel-provider-matrix"
import { canonicalPartyFor } from "@/lib/contact-promotion/lead-domain-boundary"
import { LEAD_ALLOWED_CHANNELS } from "./lead-channel-policy"
import {
  LIFE_EVENT_TYPES, LIFE_EVENT_VOCAB, canonicalLifeEventType, lifeEventVocabEntry,
  type LifeEventType, type LifeEventEngagementMode, type LifeEventSensitivity,
} from "@/lib/enrichment/life-event-vocabulary"

/** Contract C1's row shape, local on purpose (one line): the arbiter depends on the matrix's VALUES, never on lane D's type names. */
type ChannelProviderRule = { categories?: readonly string[]; providers?: readonly string[] }

/** Memory facts the model may read — preferences and timing, never anything that describes who the person is. */
export const ARBITER_MEMORY_KEYS: readonly string[] = ["channel_preference", "timeline", "price_expectation", "preferred_contact_time", "language"]

// ── THE CHANNEL SPACE (wave 144) ───────────────────────────────────────────────────────────────

/** HOW a follow-up travels — the 1:1 + audience half of the campaign taxonomy, plus a task for a person. Never a format. */
export const ARBITER_CHANNELS = Object.freeze(["email", "sms", "phone", "voice_drop", "in_app", "direct_mail", "social", "ads", "human_task"] as const)
export type ArbiterChannel = (typeof ARBITER_CHANNELS)[number]

/** Each delivery channel spelled as lib/campaigns/channels.ts spells it — the value type makes a drift a COMPILE error (§6). */
const CAMPAIGN_CHANNEL_OF: Readonly<Record<Exclude<ArbiterChannel, "human_task">, CampaignChannelKey>> = Object.freeze({
  email: "email", sms: "sms", phone: "phone", voice_drop: "voice_drop", in_app: "in_app", direct_mail: "direct_mail", social: "social", ads: "ads",
})

/** WHAT a follow-up is — the creative format a channel carries. A format is never a channel (owner ruling 12). */
export const ARBITER_FORMATS = Object.freeze(["written_message", "avatar_video", "video_reel", "live_call", "voicemail_audio", "printed_letter", "postcard", "handwritten_card", "social_post", "ad_creative", "task"] as const)
export type ArbiterFormat = (typeof ARBITER_FORMATS)[number]

const BASE_FORMATS: Readonly<Record<ArbiterChannel, readonly ArbiterFormat[]>> = Object.freeze({
  email: ["written_message"], sms: ["written_message"], in_app: ["written_message"], phone: ["live_call"], voice_drop: ["voicemail_audio"],
  direct_mail: ["printed_letter", "postcard", "handwritten_card"], social: ["social_post"], ads: ["ad_creative"], human_task: ["task"],
})

/** PURE. The formats a channel can carry: its own, plus a rendered video wherever the campaign taxonomy says video rides it. */
function formatsForChannel(c: ArbiterChannel): ArbiterFormat[] {
  const out = [...BASE_FORMATS[c]]
  if (c !== "human_task" && channelCarriesVideo(CAMPAIGN_CHANNEL_OF[c])) out.push("avatar_video", "video_reel")
  return out
}

/**
 * The other spellings of the same channels that live in this repo (settings 'phone', isa_outreach_log 'voice', next-best-touch
 * 'voicedrop', de-confliction 'mail', the old arbiter's 'portal' …) — READ-side tolerance only; every value this module writes is
 * an ArbiterChannel. "video" is deliberately absent: it is a FORMAT (see canonicalArbiterChannel).
 */
export const ARBITER_CHANNEL_ALIASES: Readonly<Record<string, ArbiterChannel>> = Object.freeze({
  voice: "phone", call: "phone", ai_call: "phone", voicedrop: "voice_drop", portal: "in_app", portal_push: "in_app", push: "in_app",
  mail: "direct_mail", social_post: "social", ad: "ads", ad_campaign: "ads", task: "human_task",
})
const FORMAT_WORDS: ReadonlySet<string> = new Set(["video", "video_email", "reel", ...ARBITER_FORMATS])

/** PURE. Any stored / model-supplied spelling → the canonical channel, or null (a format word, or nothing we know). */
function canonicalArbiterChannel(raw: unknown): ArbiterChannel | null {
  if (typeof raw !== "string") return null
  const v = raw.trim().toLowerCase()
  if ((ARBITER_CHANNELS as readonly string[]).includes(v)) return v as ArbiterChannel
  return ARBITER_CHANNEL_ALIASES[v] ?? null
}

/** The ISA settings vocabulary (lib/ai-isa/settings-types.ts contact_allowed_channels) → the channels each checkbox grants.
 *  'phone' grants the live call AND the voice drop: both ride the phone line under the same TCPA consent. */
const SETTINGS_GRANTS: Readonly<Record<string, readonly ArbiterChannel[]>> = Object.freeze({
  email: ["email"], sms: ["sms"], phone: ["phone", "voice_drop"], voice: ["phone", "voice_drop"], voicedrop: ["voice_drop"], voice_drop: ["voice_drop"], direct_mail: ["direct_mail"], mail: ["direct_mail"],
})
/** Channels the tenant's ISA channel checkboxes govern (the rest are governed elsewhere: the portal is the client's own surface,
 *  a human task is a person, social / ads are the Campaign Orchestrator's / Ads Manager's broadcast decisions). */
const TENANT_GOVERNED: ReadonlySet<ArbiterChannel> = new Set(["email", "sms", "phone", "voice_drop", "direct_mail"])

function grantedBySettings(allowed: readonly string[]): Set<ArbiterChannel> {
  const out = new Set<ArbiterChannel>()
  for (const a of allowed) for (const c of SETTINGS_GRANTS[String(a).toLowerCase()] ?? []) out.add(c)
  return out
}

/** The de-confliction cap's channel for each arbiter channel (lib/kernel/deconflict/lead-channel.ts DeconflictChannel). */
const CAP_CHANNEL: Readonly<Partial<Record<ArbiterChannel, "email" | "sms" | "phone" | "mail">>> = Object.freeze({ email: "email", sms: "sms", phone: "phone", voice_drop: "phone", direct_mail: "mail" })
const PROVIDER_GATED: ReadonlySet<ArbiterChannel> = new Set(["email", "sms", "phone", "voice_drop", "direct_mail", "social", "ads"])
const COSTED: ReadonlySet<ArbiterChannel> = new Set(["email", "sms", "phone", "voice_drop", "direct_mail"])

export type SpendTier = "none" | "trivial" | "low" | "high" | "unknown"

/** What every channel check needs about the person (the contact / lead columns, as the live schema spells them). */
// Module scope (wave 144, lane 144Z): read only by the module-private channel checks (see ChannelReadinessInput).
interface ChannelConsent {
  email?: string | null
  email_opt_out?: boolean | null
  email_unsubscribed?: boolean | null
  phone?: string | null
  tcpa_consent?: boolean | null
  sms_opt_out?: boolean | null
  phone_opt_out?: boolean | null
  call_stop_flag?: boolean | null
  dnc_status?: boolean | null
  direct_mail_opt_out?: boolean | null
  mailing_address?: string | null
  mailing_address_verified?: boolean | null
  opt_out_channels?: string[] | null
  /** contacts.has_login — a portal account exists, so an in-app message is seen. */
  has_login?: boolean | null
}

/** The checks are for a CONTACT (the only subject the experience paths arbitrate). A lead's channels are lib/ai-isa/lead-channel-policy.ts
 *  (email + mail only) and a raw lead gets none — respondToLifeChangeSignal routes those deterministically, never through this menu.
 *  Module scope (wave 144, lane 144Z — test:opposite-missing category 3): the input of the module-private evaluateChannelReadiness /
 *  loadChannelReadiness; no importer and no exported signature carries it. */
interface ChannelReadinessInput {
  consent: ChannelConsent
  /** The tenant's ISA channel settings, in the settings vocabulary (an unreadable settings row arrives as [] — fail closed). */
  tenantAllowed: readonly string[]
  /** De-confliction channels at the cap (email | sms | phone | mail); null = not read (the dispatcher's cap still decides). */
  saturated: readonly string[] | null
  /** Provider readiness per channel; null = the scan could not run (the dispatcher's provider gate still decides). */
  providers: Partial<Record<ArbiterChannel, "ready" | "not_ready">> | null
  /** Unit price per costed channel; a null value = the price is unknown on the vendor row (priceState 'unknown'). */
  unitCostUsd: Partial<Record<ArbiterChannel, number | null>>
  /** Remaining platform usage this period (mayUseAndAfford); null = unmetered / unknown; undefined = not read. */
  budgetRemainingUsd?: number | null
  /** mayUseAndAfford refused comms.send outright (a lapsed subscription …) — its machine reason; every costed channel is refused. */
  sendsBlocked?: string | null
  /** An appended online-audience identifier exists for this person (lane 144E's online_audience_append); unknown = false. */
  audienceMatch?: boolean | null
}

export interface ChannelCheck {
  channel: ArbiterChannel
  available: boolean
  /** "dispatch_gate" = the dispatcher's autonomy / consent / suppression / de-confliction / budget gates run at the send;
   *  "human" = a person decides before anything leaves. */
  approval: "dispatch_gate" | "human"
  spendTier: SpendTier
  formats: ArbiterFormat[]
  /** Every check that refused, and every caveat that rode through. Never empty for an unavailable channel. */
  reasons: string[]
}

const tierOf = (usd: number | null | undefined): SpendTier => (usd === undefined ? "none" : usd === null ? "unknown" : usd <= 0 ? "none" : usd < 0.01 ? "trivial" : usd < 0.1 ? "low" : "high")

/**
 * PURE. One verdict per channel in ARBITER_CHANNELS — consent, tenant policy, frequency, cost / budget, provider, approval —
 * so a channel is a DECISION OPTION with its checks, not a string. The menu offers only `available` channels; every channel,
 * available or not, is shown to the model and written to the ledger with its reasons. Module-private (like every arbiter step):
 * scripts/intent-driven-followup-guard.ts drives every arm THROUGH arbitrateAndRecordExperience with seeded rows + seams.
 */
function evaluateChannelReadiness(input: ChannelReadinessInput): ChannelCheck[] {
  const c = input.consent
  const granted = grantedBySettings(input.tenantAllowed)
  const optedOut = new Set((c.opt_out_channels ?? []).map(canonicalArbiterChannel).filter((x): x is ArbiterChannel => !!x))
  const voiceLine = (refuse: (r: string) => void, channel: ArbiterChannel) => {
    if (!c.phone) refuse("no phone number on file")
    if (c.tcpa_consent !== true) refuse(channel === "voice_drop"
      ? "no recorded TCPA consent — a ringless voicemail is a call under the TCPA (FCC declaratory ruling, Nov 2022), so it needs the same prior express consent"
      : "no recorded TCPA consent for an AI / autodialed call (an AI-generated voice is an 'artificial voice' under the TCPA — FCC declaratory ruling, Feb 2024)")
    if (c.phone_opt_out) refuse("opted out of calls")
    if (c.call_stop_flag) refuse("asked us to stop calling (call_stop_flag)")
    if (c.dnc_status) refuse("on a do-not-call list")
  }
  return ARBITER_CHANNELS.map((channel): ChannelCheck => {
    const reasons: string[] = []
    let ok = true
    const refuse = (r: string) => { ok = false; reasons.push(r) }
    // CONSENT — per channel.
    switch (channel) {
      case "email":
        if (!c.email) refuse("no email on file")
        if (c.email_opt_out || c.email_unsubscribed) refuse("opted out of email (CAN-SPAM)")
        break
      case "sms":
        if (!c.phone) refuse("no phone number on file")
        if (c.tcpa_consent !== true) refuse("no recorded TCPA consent for texts")
        if (c.sms_opt_out) refuse("opted out of texts")
        if (c.dnc_status) refuse("on a do-not-call list")
        break
      case "phone": case "voice_drop":
        voiceLine(refuse, channel)
        break
      case "direct_mail":
        if (!c.mailing_address) refuse("no mailing address on file")
        if (c.direct_mail_opt_out) refuse("opted out of mail")
        if (ok && c.mailing_address_verified !== true) reasons.push("caveat: the address is not CASS-verified yet — the send-time CASS gate verifies it (lib/providers/mailing-cass-gate.ts)")
        break
      case "in_app":
        if (c.has_login !== true) refuse("no portal sign-in yet — an in-app message would sit unseen")
        break
      case "social":
        refuse("social is a BROADCAST channel here — no 1:1 social-message rail exists (the social_post adapter publishes to an audience); reaching this person socially is a published post the Campaign Orchestrator decides")
        break
      case "ads":
        if (!input.audienceMatch) refuse("no appended online-audience identifier on file for this person (Versium online_audience_append — lane 144E)")
        refuse("an ad audience is a separate governed Ads-Manager action (housing special ad category, human approval) — a 1:1 follow-up never rides it, and appended ad identifiers are never a message address")
        break
      case "human_task":
        break
    }
    if (optedOut.has(channel)) refuse(`opted out of ${channel} (contacts.opt_out_channels)`)
    // TENANT POLICY — the brokerage's own ISA channel settings.
    if (TENANT_GOVERNED.has(channel) && !granted.has(channel)) refuse("not enabled in the brokerage's AI ISA channel settings (or the settings were unreadable — fail closed)")
    // FREQUENCY — the over-touch cap, one vocabulary with the dispatcher's de-confliction.
    const cap = CAP_CHANNEL[channel]
    if (cap && input.saturated && input.saturated.includes(cap)) refuse(`at the over-touch cap on ${cap} (the de-confliction policy the dispatcher enforces)`)
    else if (cap && input.saturated === null && ok) reasons.push("caveat: over-touch counts were not read here — the dispatcher's de-confliction gate decides at the send")
    // COST / BUDGET.
    const unit = COSTED.has(channel) ? (input.unitCostUsd[channel] === undefined ? null : input.unitCostUsd[channel]) : undefined
    const spendTier = tierOf(unit)
    if (COSTED.has(channel) && input.sendsBlocked) refuse(`the brokerage's subscription does not currently cover sends (${input.sendsBlocked}) — the dispatcher's billing gate would refuse it`)
    else if (typeof unit === "number" && unit > 0 && typeof input.budgetRemainingUsd === "number" && unit > input.budgetRemainingUsd) refuse("over the brokerage's remaining platform usage this period — the dispatcher's budget pre-flight would refuse it")
    else if (unit === null && ok) reasons.push("caveat: this channel's unit price is unknown on the vendor row — the send books it with price_state 'unknown', never a guess")
    else if (typeof unit === "number" && unit > 0 && input.budgetRemainingUsd === undefined && ok) reasons.push("caveat: the usage budget was not read here — the dispatcher's mayUseAndAfford pre-flight decides")
    // PROVIDER.
    const prov = input.providers?.[channel]
    if (PROVIDER_GATED.has(channel) && prov === "not_ready") refuse("no provider is connected or configured for this channel (lib/platform/provider-posture.ts readiness)")
    else if (PROVIDER_GATED.has(channel) && input.providers === null && ok) reasons.push("caveat: provider readiness was not verified here — the dispatcher's provider gate decides")
    if (ok && reasons.length === 0) reasons.push("permitted: consent, tenant policy, frequency, budget and provider all clear")
    return {
      channel, available: ok,
      approval: channel === "social" || channel === "ads" || channel === "human_task" ? "human" : "dispatch_gate",
      spendTier, formats: formatsForChannel(channel), reasons,
    }
  })
}

/** Which channels each experience can ride. `video` rides only a channel that carries a video (the taxonomy's own rule). */
const KIND_CHANNELS: Readonly<Record<ExperienceKind, readonly ArbiterChannel[]>> = Object.freeze({
  communication: ["email", "sms", "phone", "voice_drop", "direct_mail", "in_app"],
  video: ["email", "sms", "in_app"],
  education: ["in_app", "email", "sms", "direct_mail"],
  properties: ["email", "sms", "in_app", "direct_mail"],
  market_update: ["email", "sms", "in_app", "direct_mail"],
  portal_task: ["in_app"],
  document_explanation: ["in_app"],
  agent_intervention: ["human_task"],
  // WAVE 144 (lane 144Z): a referral to a qualified professional is a person's introduction — it rides the agent's task only.
  professional_referral: ["human_task"],
  appointment: [],
  wait: [],
})
/** The format an experience fixes (a video experience is an avatar video, whatever carries it). */
const KIND_FORMAT: Readonly<Partial<Record<ExperienceKind, ArbiterFormat>>> = Object.freeze({ video: "avatar_video", agent_intervention: "task", professional_referral: "task" })

/** What the experience paths' CALLERS can deliver themselves for `communication` (lib/sphere/followup-moments.ts and the ISA engage
 *  path both send email / SMS today). A caller that can deliver more passes its own list (CONTACT_ENGAGEMENT_DELIVERABLE). */
const DEFAULT_COMMUNICATION_DELIVERABLE: readonly ArbiterChannel[] = ["email", "sms"]
/** Every channel app/actions/ai-isa/engage-contact.ts dispatchContactChannel can deliver for a contact (email / sms / direct mail /
 *  AI call / voice drop) — the list that caller passes once it honours the arbiter's channel (wave 144 Outside-lane note). */
export const CONTACT_ENGAGEMENT_DELIVERABLE: readonly ArbiterChannel[] = Object.freeze(["email", "sms", "phone", "voice_drop", "direct_mail"])

/** The ArbiterChannel → the TouchChannel spelling engage-contact's dispatcher uses (lib/ai-isa/next-best-touch.ts). */
const TOUCH_CHANNEL_OF: Readonly<Partial<Record<ArbiterChannel, "email" | "sms" | "phone" | "voicedrop" | "direct_mail">>> = Object.freeze({ email: "email", sms: "sms", phone: "phone", voice_drop: "voicedrop", direct_mail: "direct_mail" })

/** PURE. The channel engage-contact dispatches for an AI decision on a communication, or null (it keeps its own choice). */
export function touchChannelForDecision(d: Pick<ArbiterDecision, "source" | "kind" | "channel"> | null | undefined): "email" | "sms" | "phone" | "voicedrop" | "direct_mail" | null {
  if (!d || d.source !== "ai" || d.kind !== "communication" || !d.channel) return null
  return TOUCH_CHANNEL_OF[d.channel] ?? null
}

// ── THE STANCE (ruling 12: ACT NOW / WAIT / EDUCATE / NOTIFY HUMAN / CHANGE CHANNEL) ─────────────

export const ARBITER_STANCES = Object.freeze(["act_now", "wait", "educate", "notify_human", "change_channel"] as const)
export type ArbiterStance = (typeof ARBITER_STANCES)[number]

/** PURE. The decision, named in the owner's five words — derived, never asked of the model separately (one decision, one truth). */
function arbiterStance(d: { kind: ExperienceKind; channel: ArbiterChannel | null }, lastChannel: string | null): ArbiterStance {
  if (d.kind === "wait") return "wait"
  if (d.kind === "education") return "educate"
  if (d.kind === "agent_intervention" || d.kind === "professional_referral" || d.channel === "human_task") return "notify_human"
  const last = canonicalArbiterChannel(lastChannel)
  if (d.channel && last && d.channel !== last) return "change_channel"
  return "act_now"
}

// ── LIFE-CHANGE / INTENT SIGNALS (ruling 11) ────────────────────────────────────────────────────

/** What a recorded signal MEANS for the follow-up (the kinds the planner's candidates key on). */
export type LifeChangeKind = "moving" | "home_sale" | "buying" | "refinance" | "equity" | "life_event" | "engagement"

/**
 * THE SIGNAL VOCABULARY — `signal_reactivations.signal_type` (no CHECK; the writers are recordReactivationSignal in
 * lib/ai-isa/long-term-nurture.ts and respondToLifeChangeSignal below) → its kind. Exact names first, then the prefix families the
 * inbound-intent classifier writes (`returning_<side>_<reason>`). An unknown type is `engagement` — real intent, no assumption.
 */
export const LIFE_CHANGE_SIGNAL_KINDS: Readonly<Record<string, LifeChangeKind>> = Object.freeze({
  // WAVE 148 (lane 148F, C20): every spelling of every life event in THE chronological map (lib/enrichment/life-event-vocabulary.ts
  // LIFE_EVENT_VOCAB — canonical + aliases) reads as its follow-up kind, so a signal written under any spelling (`probate_filing`,
  // `divorce`, `death_in_family`, `wedding` …) reaches the life-event branch; the explicit rows below win where they overlap.
  ...Object.fromEntries(LIFE_EVENT_TYPES.flatMap((t) => [t, ...LIFE_EVENT_VOCAB[t].aliases].map((k) => [k, LIFE_EVENT_VOCAB[t].followupKind as LifeChangeKind]))),
  refinance_opportunity: "refinance", rate_drop_refinance: "refinance",
  equity_milestone: "equity", equity_event: "equity",
  next_move_intent: "moving", relocation_referral_request: "moving", moving_intent: "moving", change_of_address: "moving",
  home_value_seller_intent: "home_sale", seller_intent_hot: "home_sale", listing_expired: "home_sale", fsbo_pulled: "home_sale", neighbor_sold_high: "home_sale", home_sale_interest: "home_sale",
  buying_intent: "buying", search_portal_activity: "buying", portal_activity_resumed: "buying",
  divorce_filing: "life_event", probate_filing: "life_event", life_event: "life_event",
})

/**
 * PURE (wave 144, lane 144Z). The signal_type a NEW stored provider fact is answered under (lane 144E's intent sources →
 * LIFE_CHANGE_SIGNAL_KINDS, so the responder files it under the kind its source declares — never "engagement" by default). A
 * `life_event` fact is a service topic answered only by a person; an `age` or a stored property fact is not a change and maps to
 * null (the caller publishes nothing for it). Used by the AI ISA's `online_intent_detected` handler (lib/kernel/manager-signals.ts).
 */
export function intentFactSignalType(fact: { intents: readonly string[]; sensitivity: string }): string | null {
  if (fact.sensitivity === "life_event") return "life_event"
  if (fact.sensitivity !== "behaviour") return null
  const first = fact.intents[0] ?? ""
  const byIntent: Readonly<Record<string, string>> = { moving: "moving_intent", home_sale: "home_sale_interest", home_purchase: "buying_intent", refinance: "refinance_opportunity" }
  return byIntent[first] ?? (INTENT_TO_LIFE_CHANGE[first] === "engagement" ? "property_engagement" : null)
}

/** PURE. A stored signal_type → its kind. */
function lifeChangeKindOf(signalType: string | null | undefined): LifeChangeKind {
  const t = String(signalType ?? "").toLowerCase()
  if (LIFE_CHANGE_SIGNAL_KINDS[t]) return LIFE_CHANGE_SIGNAL_KINDS[t]
  if (/^returning_buyer/.test(t)) return "buying"
  if (/^returning_seller/.test(t)) return "home_sale"
  if (/refinanc/.test(t)) return "refinance"
  if (/relocat|moving|move/.test(t)) return "moving"
  return "engagement"
}

export interface LifeChangeSignal {
  type: string; kind: LifeChangeKind; strength: number | null; daysAgo: number
  /** WAVE 148 (148F, ruling 17): how good the evidence behind the signal is — automated, event-agnostic help for a life event needs
   *  `grounded` (a verified / reported record) AND `identityConfirmed` (never a name-only match); `lifeEvent` is the canonical event
   *  (LIFE_EVENT_VOCAB) so the draft screen knows which words may never appear. Absent = unknown = not enough for automated help. */
  evidence?: { grounded: boolean; identityConfirmed: boolean; lifeEvent: LifeEventType | null; source: string }
}

/**
 * PURE. The SIGNAL slice of the candidate set: a recent life-change / intent signal adds the experiences that serve that moment,
 * each with its reason (the evidence the model and the ledger see). A LOCKED plan is returned untouched — a signal never unlocks a
 * hard verdict (consent, dead end, fatigue, compliance) — and the chosen experience is re-derived only when nothing forced it.
 * Referrals to a professional (a lender for a refinance) are ALWAYS a person's call: they ride `agent_intervention`, never an
 * automated hand-off (RESPA §8 — the referral is the consumer's choice, never a paid steer). Module-private: the proof drives it
 * through arbitrateAndRecordExperience with seeded signal rows.
 */
function planWithLifeChangeSignals(
  plan: NextBestExperiencePlan,
  signals: readonly LifeChangeSignal[],
  person: { contactType: string | null },
  /** The planner's OWN tables (lib/ai-isa/lead-action-plan.ts EXPERIENCE_EXECUTORS + EXPERIENCE_KINDS) — never a second copy. */
  planner: { executors: Readonly<Record<ExperienceKind, { manager: RankedExperience["manager"]; capability: RankedExperience["capability"] }>>; kinds: readonly ExperienceKind[] },
): NextBestExperiencePlan {
  // A locked plan is a hard verdict (and locked ⇔ forced in planNextBestExperience): a signal never unlocks it.
  if (plan.locked || signals.length === 0) return plan
  const type = (person.contactType ?? "").toLowerCase()
  const buyerish = type === "buyer" || type === "both"
  const ownerish = type !== "buyer" // a seller, both, a lifetime client (they own the home they bought), or unknown
  const add = new Map<ExperienceKind, { delta: number; reasons: string[] }>()
  const push = (k: ExperienceKind, delta: number, reason: string) => { const e = add.get(k) ?? { delta: 0, reasons: [] }; e.delta = Math.max(e.delta, delta); e.reasons.push(reason); add.set(k, e) }
  for (const s of signals) {
    const when = `${s.type} ${s.daysAgo}d ago${s.strength !== null ? ` (strength ${s.strength})` : ""}`
    switch (s.kind) {
      case "refinance":
        push("agent_intervention", 55, `signal: ${when} — a refinance question needs a person: offer an introduction to a qualified lender the client chooses (never an automated referral)`)
        // WAVE 144 (lane 144Z, ruling 11): the introduction itself is its own option — the ISA writes the agent's task with the
        // brokerage's lender bench (lead-action-plan.ts prepareProfessionalIntroduction); the client chooses, nothing is sent.
        push("professional_referral", 50, `signal: ${when} — a referral to a qualified professional: the agent offers an introduction to a lender on the brokerage's bench; the client chooses (RESPA §8 — no fee, never automated)`)
        push("education", 40, `signal: ${when} — a plain-language refinance lesson (costs, break-even, what changes)`)
        break
      case "equity":
        if (ownerish) push("market_update", 50, `signal: ${when} — an equity milestone: a market update on their home`)
        push("agent_intervention", 25, `signal: ${when} — the agent may want to talk options (stay, sell, borrow) in person`)
        if (ownerish) push("professional_referral", 20, `signal: ${when} — if borrowing against the equity is on the table, the agent can offer an introduction to a qualified lender the client chooses`)
        break
      case "moving":
        if (ownerish) push("market_update", 50, `signal: ${when} — thinking of moving: what their home could sell for now`)
        if (buyerish) push("properties", 50, `signal: ${when} — thinking of moving: homes that fit what they told us`)
        push("agent_intervention", 35, `signal: ${when} — a move is a high-stakes moment: a personal call from the agent`)
        break
      case "home_sale":
        push("market_update", 55, `signal: ${when} — home-sale interest: a market update / CMA on their home`)
        push("agent_intervention", 30, `signal: ${when} — offer a no-obligation listing conversation`)
        break
      case "buying":
        if (buyerish || type === "") push("properties", 55, `signal: ${when} — buying intent: matching properties`)
        break
      case "life_event":
        // WAVE 148 (lane 148F, owner ruling 17 — REVERSES wave 144's "a person only"): a life event is about THEM and how they feel
        // right now. Quiet monitoring is the empathetic default; helpful, event-agnostic education is the gentlest automated help; a
        // person may reach out personally. The arbiter's life-event branch (lifeEventMenu) decides among them — automated help
        // only on confirmed evidence under the tenant's explicit autonomy — and nothing ever names the event.
        push("wait", 45, `signal: ${when} — a significant personal moment: quiet monitoring is the kind default (no message about it, no pressure)`)
        push("education", 30, `signal: ${when} — helpful, event-agnostic education (something useful to anyone) — never about the moment itself`)
        push("agent_intervention", 25, `signal: ${when} — a person's conversation when judgment is needed: the agent may reach out personally about something useful, never the event`)
        break
      case "engagement":
        push("communication", 15, `signal: ${when} — fresh engagement: a personal, useful touch`)
        break
    }
  }
  const byKind = new Map(plan.ranked.map((r) => [r.kind, { ...r, reasons: [...r.reasons] }]))
  for (const [kind, e] of add) {
    const cur = byKind.get(kind)
    if (cur) { cur.score += e.delta; cur.reasons.push(...e.reasons) }
    // A kind the planner did not rank: its executor comes from the planner's own table (no second routing).
    else byKind.set(kind, { kind, score: e.delta, reasons: e.reasons, manager: planner.executors[kind].manager, capability: planner.executors[kind].capability, dueAt: null })
  }
  // The planner's own ordering rule: score, then the fixed kind order (no randomness).
  const ranked = [...byKind.values()].sort((a, b) => b.score - a.score || planner.kinds.indexOf(a.kind) - planner.kinds.indexOf(b.kind))
  return { ...plan, ranked, chosen: ranked[0], contributed: [...new Set([...plan.contributed, "signal"])] }
}

export interface ArbiterOption {
  id: string
  kind: ExperienceKind
  /** Channels this option may ride (the permitted set, never wider); empty = the option has no channel (a wait, an appointment). */
  channels: ArbiterChannel[]
  /** Why the planner argued for it (its own evidence lines). */
  why: string[]
}

export interface ArbiterFacts {
  subject: "lead" | "contact"
  relationship: { type: string | null; persona: string | null; hasAssignedAgent: boolean }
  intent: { score: number; trend: string } | null
  history: { hoursSinceAnyTouch: number | null; hoursSinceAgentTouch: number | null; campaignTouches7d: number | null; lastChannel: string | null; portalEducationViews: number | null }
  journey: { transactionStage: string | null; nextMilestone: string | null; openLessons: number | null; nextLesson: string | null }
  preferences: Array<{ key: string; value: string }>
  fatigueRisk: string | null
  localHour: number | null
  moment: { key: string; intent: string; daysSinceOpen: number } | null
  blindSpots: string[]
  /** Wave 144: every channel considered, with its verdict and reasons (spend as a TIER — the model never sees a price). */
  channels?: Array<{ channel: ArbiterChannel; available: boolean; approval: ChannelCheck["approval"]; spendTier: SpendTier; why: string }>
  /** Wave 144: recent life-change / intent signals on this person (signal_reactivations) — evidence, never a schedule. */
  signals?: Array<{ type: string; kind: LifeChangeKind; daysAgo: number }>
  /** Wave 144: how soon the evidence says a touch matters (a fresh moving / sale / refinance signal or a rising high intent). */
  urgency?: "high" | "normal" | null
  /** Wave 147 (147Z, lane 147B C9): the neighbourly helpers the verified / reported movement evidence supports — OPTIONS the
   *  model may weigh (each names the planner experience that carries it), never a schedule and never the signal's source. */
  neighbourlyHelpers?: Array<{ key: string; title: string; offer: string; experience: string }>
  /** Wave 148 (148F, ruling 17): present when the DECISIVE signal is a life event — the brief the empathetic branch decides under
   *  (never the words to say: the sensitivity, the tone, what the evidence and the tenant's authority permit). */
  lifeEvent?: { sensitivity: LifeEventSensitivity | "unknown"; category: string; tone: string; modesOffered: LifeEventEngagementMode[]; automatedHelpOffered: boolean; whyNotAutomated: string[]; evidence: { grounded: boolean; identityConfirmed: boolean } }
  /** Wave 149 (149Z, lane 149H ruling 18): the combined-signal opportunity reading — the decision kind, its stage, and the
   *  engagement modes the reading permits (never a not_eligible one). Evidence for the model; it carries no time. */
  opportunity?: { kind: string; stage: string; sensitive: boolean; modes: Array<{ mode: string; status: string; why: string; experience: string; requiresApproval: boolean }>; floor: string }
}

export interface ArbiterDecision {
  optionId: string
  kind: ExperienceKind
  channel: ArbiterChannel | null
  /** Wave 144: the creative format the channel carries (a video rides email / SMS / the portal — it is never the channel). */
  format?: ArbiterFormat | null
  /** Wave 144: the decision in the owner's five words (act_now / wait / educate / notify_human / change_channel). */
  stance?: ArbiterStance
  /** Hours to wait, only when kind === "wait" (bounded by the policy). */
  waitHours: number | null
  rationale: string
  /** The fact keys the decision rests on. */
  evidence: string[]
  confidence: number
  source: "ai" | "deterministic"
  /** Why the planner's verdict stood instead of a model choice (locked / disabled / budget / invalid / outage). */
  fallbackReason: string | null
  menu: string[]
  /** Wave 148 (148F, ruling 17): the life-event guard every downstream writer honours — the mode chosen, the canonical event (or
   *  null), the words a draft may never contain and the tone. Present only when the decisive signal was a life event. */
  lifeEvent?: LifeEventDecisionGuard
}

/** What a life-event decision hands downstream (and to the ledger): the mode, and the rules of the words. */
export interface LifeEventDecisionGuard { mode: LifeEventEngagementMode; canonical: LifeEventType | null; sensitivity: LifeEventSensitivity | "unknown"; neverMention: string[]; tone: string; automatedHelpOffered: boolean }

export interface ArbiterRaw {
  optionId?: unknown
  channel?: unknown
  format?: unknown
  waitHours?: unknown
  rationale?: unknown
  evidence?: unknown
  confidence?: unknown
}

export type ArbiterDecide = (a: { brokerageId: string; system: string; prompt: string }) => Promise<ArbiterRaw>

export interface ArbiterBudget { remaining: number }

// ── facts ────────────────────────────────────────────────────────────────────────────────────

const hoursSince = (d: Date | null | undefined, now: Date): number | null => (d ? Math.max(0, Math.round((now.getTime() - d.getTime()) / 3_600_000)) : null)

/** PURE. The compact, financial-free, protected-class-free evidence the model reads for one person. */
function arbiterFactsFromExperienceInput(
  input: NextBestExperienceInput,
  moment: ArbiterFacts["moment"] = null,
  extra: { checks?: ChannelCheck[] | null; signals?: readonly LifeChangeSignal[]; helpers?: readonly ArbiterMovementHelper[] } = {},
): ArbiterFacts {
  const n = input.nba
  const signals = (extra.signals ?? []).map((s) => ({ type: s.type, kind: s.kind, daysAgo: s.daysAgo }))
  const freshHigh = signals.some((s) => s.daysAgo <= 2 && s.kind !== "engagement") || (!!n.intent && n.intent.score >= 80 && String(n.intent.trend) === "rising")
  const helpers = (extra.helpers ?? []).slice(0, 4).map((h) => ({ key: h.key, title: h.title, offer: h.offer, experience: h.experience }))
  return {
    ...(extra.checks ? { channels: extra.checks.map((c) => ({ channel: c.channel, available: c.available, approval: c.approval, spendTier: c.spendTier, why: c.reasons[0] ?? "" })) } : {}),
    ...(signals.length > 0 ? { signals } : {}),
    ...(helpers.length > 0 ? { neighbourlyHelpers: helpers } : {}),
    urgency: freshHigh ? "high" : n.intent || signals.length > 0 ? "normal" : null,
    subject: input.subject,
    relationship: { type: input.person.contactType, persona: input.person.persona, hasAssignedAgent: input.person.hasAssignedAgent },
    intent: n.intent ? { score: n.intent.score, trend: String(n.intent.trend) } : null,
    history: {
      hoursSinceAnyTouch: hoursSince(n.lastAnyTouchAt ?? null, input.now),
      hoursSinceAgentTouch: hoursSince(n.lastAgentTouchAt ?? null, input.now),
      campaignTouches7d: input.behavior.touchpoints7d,
      lastChannel: input.behavior.lastTouchpointChannel,
      portalEducationViews: input.behavior.portalEducationViews,
    },
    journey: {
      transactionStage: input.transaction?.stage ?? input.transaction?.status ?? null,
      nextMilestone: input.transaction?.nextMilestone?.name ?? null,
      openLessons: input.education?.open ?? null,
      nextLesson: input.education?.nextModule?.title ?? null,
    },
    preferences: (n.memoryFacts ?? []).filter((f) => ARBITER_MEMORY_KEYS.includes(f.key)).map((f) => ({ key: f.key, value: String(f.value).slice(0, 120) })),
    fatigueRisk: input.fatigue.riskLevel,
    localHour: n.recipientLocalHour ?? null,
    moment,
    blindSpots: [...(input.blindSpots ?? [])],
  }
}

// ── the menu ─────────────────────────────────────────────────────────────────────────────────

interface ChannelContext {
  /** The tenant's ISA channel settings (settings vocabulary). */
  allowedChannels: readonly string[]
  videoAllowed: boolean
  /** Wave 144: the per-channel verdicts; null = the readiness inputs could not be read (the tenant list alone shapes the menu). */
  checks?: ChannelCheck[] | null
  /** What the caller can deliver itself for `communication` (DEFAULT_COMMUNICATION_DELIVERABLE when not said). */
  deliverable?: readonly ArbiterChannel[] | null
}

/**
 * PURE. The channels an experience may ride for THIS person. With readiness: the kind's channels that every check cleared
 * (and, for a communication the CALLER delivers, that the caller can deliver). Without readiness (an unreadable person row —
 * published as a blind spot): the tenant's settings alone, exactly the pre-144 behaviour minus the dead spellings.
 */
function channelsForKind(kind: ExperienceKind, ctx: ChannelContext): ArbiterChannel[] {
  const deliverable = new Set(ctx.deliverable ?? DEFAULT_COMMUNICATION_DELIVERABLE)
  const callerDelivered = (c: ArbiterChannel) => kind !== "communication" || deliverable.has(c)
  if (kind === "video" && !ctx.videoAllowed) return []
  if (ctx.checks) {
    const avail = new Set(ctx.checks.filter((c) => c.available).map((c) => c.channel))
    return KIND_CHANNELS[kind].filter((c) => avail.has(c) && callerDelivered(c) && (kind !== "video" || formatsForChannel(c).includes("avatar_video")))
  }
  const granted = grantedBySettings(ctx.allowedChannels)
  const legacyOk = (c: ArbiterChannel) => {
    if (c === "human_task") return true
    // The portal: offered for the portal kinds (as before) and as a video's carrier (the memory / anniversary video lands on a portal card).
    if (c === "in_app") return kind === "portal_task" || kind === "document_explanation" || kind === "video"
    return granted.has(c)
  }
  return KIND_CHANNELS[kind].filter((c) => legacyOk(c) && callerDelivered(c))
}

export interface ArbiterMenu {
  menu: ArbiterOption[]
  /** A hard verdict the model is never asked about (and why). */
  locked: { kind: ExperienceKind; reason: string } | null
  /** Wave 147 (147Z) / 148 (148F): the menu was shaped by the life-event branch (lifeEventMenu) because the decisive signal is a life event. */
  narrowedForLifeEvent?: boolean
  /** Wave 148 (148F): the brief + guard of that branch. */
  lifeEvent?: { brief: NonNullable<ArbiterFacts["lifeEvent"]>; guard: Omit<LifeEventDecisionGuard, "mode"> }
}

/**
 * PURE. The closed set of options the model may choose from — built ONLY from the planner's own ranked candidates:
 *   · a LOCKED plan (hard compliance flag, a blocking NBA verdict, high / critical fatigue) → no menu to choose from;
 *   · a candidate with score <= 0 is a candidate the planner argued AGAINST (e.g. video the policy forbids) → excluded;
 *   · `wait` is always offered — "do nothing yet" is a legitimate action — except once a moment has been deferred for
 *     policy.arbiter.maxDeferDays (then the person is not left unattended: act, or route to a human).
 */
function arbiterMenuFromPlan(
  plan: NextBestExperiencePlan,
  policy: FollowupPolicy,
  ctx: ChannelContext & { daysSinceMomentOpen?: number | null },
): ArbiterMenu {
  if (plan.locked) return { menu: [], locked: plan.locked }
  const overdue = typeof ctx.daysSinceMomentOpen === "number" && ctx.daysSinceMomentOpen >= policy.arbiter.maxDeferDays
  const menu: ArbiterOption[] = plan.ranked
    .filter((r) => (r.kind === "wait" ? !overdue : r.score > 0))
    .map((r: RankedExperience) => ({ id: r.kind, kind: r.kind, channels: channelsForKind(r.kind, ctx), why: r.reasons.slice(0, 4) }))
    // An option that needs a channel but has none permitted cannot be executed — it is not offered.
    .filter((o) => !(["communication", "video"] as ExperienceKind[]).includes(o.kind) || o.channels.length > 0)
  if (menu.length === 0) {
    // Overdue moment with nothing else on the table: a human decides (never silence).
    return { menu: [{ id: "agent_intervention", kind: "agent_intervention", channels: ["human_task"], why: ["no automated option remains and waiting is exhausted"] }], locked: null }
  }
  return { menu, locked: null }
}

/**
 * PURE (wave 147, lane 147Z — lane 147B's advisory, owner ruling 3). The DECISIVE signal is the freshest one that is not mere
 * engagement (a tie goes to the life event — the conservative reading).
 */
export function decisiveLifeChangeSignal(signals: readonly LifeChangeSignal[]): LifeChangeSignal | null {
  let best: LifeChangeSignal | null = null
  for (const s of signals) {
    if (s.kind === "engagement") continue
    if (!best || s.daysAgo < best.daysAgo || (s.daysAgo === best.daysAgo && s.kind === "life_event" && best.kind !== "life_event")) best = s
  }
  return best
}

/** Wave 148 (148F): whether the tenant has EXPLICITLY granted the AI ISA autonomy (the same grant the inbound responder honours —
 *  lib/managers/autonomy-gate.ts posture `autonomous` + the authority ladder + no halt). Unreadable = not granted (fail closed). */
export interface LifeEventAuthority { allowed: boolean; reason: string | null }

/** The automated experiences the life-event branch may offer when nothing names the event (a generic `life_event` signal). */
const GENERIC_LIFE_EVENT_AUTOMATED: readonly ExperienceKind[] = ["education", "communication"]

/** PURE. The mode (ruling 17's five words) an experience carries for a life event. */
function lifeEventModeOf(kind: ExperienceKind): LifeEventEngagementMode {
  if (kind === "wait") return "quiet_monitoring"
  if (kind === "education") return "helpful_education"
  if (kind === "agent_intervention" || kind === "professional_referral") return "human"
  return "appropriate_outreach"
}

/**
 * PURE (wave 148, lane 148F — owner ruling 17; REPLACES wave 147's narrowMenuForLifeEvent, which cut the menu to a person or a
 * wait). "A life event signal should never just send to a human and the arbiter should decide the best way to warm engagement
 * without mentioning the life event — it is about them and their emotions at this time." When the DECISIVE signal is a life event,
 * the closed menu becomes the empathetic branch:
 *   · QUIET MONITORING (`wait`) — always offered unless the moment is overdue; the policy's own fallback (a person is never the reflex);
 *   · HELPFUL EDUCATION / APPROPRIATE OUTREACH — the automated experiences LIFE_EVENT_VOCAB allows for this event (education /
 *     communication; market updates / homes only where the map allows), offered ONLY when the evidence is grounded with a CONFIRMED
 *     identity (never a name-only match) AND the tenant has explicitly granted the AI ISA autonomy — otherwise the reasons are said;
 *   · A HUMAN (`agent_intervention`) — always present: escalation for distress, contradiction or anything needing judgment;
 *   · RESEARCH is the movement manager's own step (lib/intent/movement-signals.ts decideMovementNextAction) — here it is quiet
 *     monitoring while evidence gathers.
 * Every option outside those is removed (no video, no portal task, no referral rides a life event). Never applied to a locked menu
 * (the hard verdict stands) or to a requirement (speed-to-lead / a promised deliverable — the person asked).
 */
function lifeEventMenu(menu: ArbiterMenu, signals: readonly LifeChangeSignal[], priority: ArbiterPriority | null, authority: LifeEventAuthority | null): ArbiterMenu {
  if (menu.locked || priority) return menu
  const decisive = decisiveLifeChangeSignal(signals)
  if (!decisive || decisive.kind !== "life_event") return menu
  const entry = lifeEventVocabEntry(decisive.evidence?.lifeEvent ?? decisive.type)
  const automated: readonly ExperienceKind[] = entry ? entry.allowedOutreach.automatedExperiences : GENERIC_LIFE_EVENT_AUTOMATED
  const grounded = decisive.evidence?.grounded === true
  const confirmed = decisive.evidence?.identityConfirmed === true
  const whyNot: string[] = []
  if (!grounded) whyNot.push("the evidence is not grounded in a verified or reported record")
  if (!confirmed) whyNot.push("the identity is not confirmed (it may be someone else)")
  if (!authority?.allowed) whyNot.push(authority?.reason ?? "the tenant has not explicitly granted the AI ISA autonomy for help it sends itself")
  const autoOk = whyNot.length === 0
  const sensitivity: LifeEventSensitivity | "unknown" = entry?.sensitivity ?? "unknown"
  const tone = entry?.allowedOutreach.tone ?? LIFE_EVENT_VOCAB.death_in_household.allowedOutreach.tone
  const note = `a life event is decisive (${decisive.daysAgo}d ago, ${sensitivity}) — warm engagement that is about them, never the event`
  const kept = menu.menu
    .filter((o) => o.kind === "wait" || o.kind === "agent_intervention" || (autoOk && automated.includes(o.kind)))
    .map((o) => ({ ...o, why: [...o.why, o.kind === "wait" ? "quiet monitoring — the kind default while the moment breathes" : o.kind === "agent_intervention" ? "a person, when judgment is needed (distress, a question, a contradiction)" : "warm, event-agnostic help — the draft is screened and may never name or allude to the event", note].slice(-4) }))
  const person = kept.some((o) => o.kind === "agent_intervention") ? [] : [{ id: "agent_intervention", kind: "agent_intervention" as ExperienceKind, channels: ["human_task" as ArbiterChannel], why: ["a person, when judgment is needed (distress, a question, a contradiction)", note] }]
  const out = [...kept, ...person]
  const modes = [...new Set(out.map((o) => lifeEventModeOf(o.kind)))]
  const neverMention = entry ? [...entry.allowedOutreach.neverMention] : [...new Set(LIFE_EVENT_TYPES.flatMap((t) => [...LIFE_EVENT_VOCAB[t].allowedOutreach.neverMention]))]
  return {
    menu: out, locked: null, narrowedForLifeEvent: true,
    lifeEvent: {
      brief: { sensitivity, category: entry?.category ?? "unknown", tone, modesOffered: modes, automatedHelpOffered: autoOk && out.some((o) => automated.includes(o.kind)), whyNotAutomated: whyNot, evidence: { grounded, identityConfirmed: confirmed } },
      guard: { canonical: entry?.canonical ?? null, sensitivity, neverMention, tone, automatedHelpOffered: autoOk && out.some((o) => automated.includes(o.kind)) },
    },
  }
}

// ── prompt + validation ──────────────────────────────────────────────────────────────────────

export const ARBITER_SYSTEM = [
  "You are the follow-up judgment of a real-estate brokerage's AI team. You decide the single next best follow-up for ONE person.",
  "Choose ONLY an option id from the menu. Platform limits (consent, opt-out, do-not-contact, quiet hours, fatigue, spend) are enforced after you and cannot be changed — do not try to work around them.",
  "Reason from the evidence given: intent and its trend, how recently and how often they were touched, what they did, where they are in their journey, what they said they prefer, and the tenant's own guidance.",
  "Prefer being useful over selling. Prefer waiting over pestering. Route to a human when the situation needs judgment (a complaint, distress, a complicated question, a high-stakes moment).",
  "Never invent facts, never mention prices, commissions or costs, and never reason from any personal characteristic — only from the evidence keys supplied.",
  "Your choice is one of five stances: ACT NOW (a useful touch on the best permitted channel), WAIT (a bounded hold), EDUCATE (a lesson), NOTIFY HUMAN (a task for the agent), or CHANGE CHANNEL (a touch on a different permitted channel than the last one).",
  "A channel is HOW a message travels (email, text, call, voice drop, mail, the portal, a task for a person); a video is a FORMAT that rides email, text or the portal — never name it as a channel. Consider every channel in `channels` with its reasons; choose only one marked available.",
  "When moment.key is speed_to_lead the person is NEW and must be answered now: a fast first response is a high-priority requirement, so waiting is not offered — choose the best permitted way to answer (the first touch on the channel that fits their stage, consent, preference, urgency and any existing activity, or a person when the situation needs one). The one welcome on becoming a contact is a fixed send outside this judgment.",
  "When moment.key is promised_deliverable we promised this person something (a guide, report, video or book) and it has not reached them: deliver it now on the permitted channel that fits them, or hand it to a person — never wait.",
  "When moment.key starts with inbound_ the person just wrote to us: answer usefully (reply), or hand it to a person when it needs judgment (a complaint, distress, a legal or fair-housing question, a negotiation). A public comment is read by everyone — the reply stays general and invites a private conversation.",
  "evidence.signals are recent life-change / intent signals — evidence, not certainty (a movement signal reaches you only when a verified or reported record carries it). A life event (divorce, a death or estate, financial hardship, a household or career change) is about the person and how they feel right now: it is never the subject of a message, and it is never simply handed to a person either — the life-event brief (evidence.lifeEvent) says what the evidence and the tenant's authority permit. evidence.neighbourlyHelpers, when present, are neighbourly ways to help that the evidence supports (each names the experience that carries it) — weigh them as options, never mention the signal or where it came from, and never assume more than the evidence says.",
  "Reply with JSON only: {optionId, channel|null, format|null, waitHours|null, rationale (1-3 sentences, plain words), evidence (the fact keys you used), confidence 0..1}.",
].join(" ")

/** Wave 149 (149Z, lane 149H): how the model reads evidence.opportunity — appended (with OPPORTUNITY_COMBINATION_BRIEF) only when
 *  the C9 hook returned a reading. The mapping is the owner's five stances; a mode absent from evidence.opportunity.modes is not
 *  eligible and must not be the reason for a choice. */
const ARBITER_OPPORTUNITY_NOTE ="evidence.opportunity, when present, is the combined-signal reading for this person (a decision kind and its stage — a single observation never raises intent) and the engagement modes it permits: quiet_monitoring maps to WAIT, helpful_education to EDUCATE, appropriate_outreach to ACT NOW, human to NOTIFY HUMAN; research is internal and never a message. Choose only among the menu's options; never pick a stance because of a mode that is not listed in evidence.opportunity.modes, respect requiresApproval (an approver sees it before anything leaves), and never mention what was observed, from where, or any life event."

/**
 * WAVE 148 (lane 148F, owner ruling 17 — "a life event signal should never just send to a human and the arbiter should decide the
 * best way to warm engagement without mentioning the life event — it is about them and their emotions at this time"): THE
 * LIFE-EVENT BRANCH'S DECISION PROMPT. Used (through arbitrateFollowUp's `system`) whenever lifeEventMenu shaped the menu; the SAME
 * closed-menu validator applies (an option off the menu, an uncited reason or a confidence under the tenant's floor keeps the
 * policy's quiet-monitoring default). Business voice from .claude/skills/real-estate-client-communication (trusted advisor,
 * emotionally aware, never pushy — the agent's reputation is on every word) and .claude/skills/real-estate-expert (fair housing,
 * state-varying solicitation rules for estates; no legal or financial advice).
 */
export const ARBITER_LIFE_EVENT_SYSTEM = [
  "ROLE. You are the most emotionally intelligent member of a licensed real-estate brokerage's AI team — part seasoned agent, part trusted neighbour, part counsellor who knows when to say nothing. You decide how the team shows up for ONE person who may be living through a significant personal moment. The AI is the first line of the agent's business and every choice reflects on that agent: be kind and neighbourly.",
  "BUSINESS CONTEXT. A signal suggests a life event — a loss or an estate, a separation, financial hardship, a household change, a new job or a move. In real estate these moments often precede a home decision, and the brokerage that is genuinely helpful (never opportunistic) is the one people remember and call when THEY are ready. A person who senses they are being watched, sold to, or 'targeted because of what happened' is lost for good — and may be hurt. It is about them and their emotions at this time, not about a transaction.",
  "FACTS YOU MAY RELY ON — ONLY the JSON given: evidence.lifeEvent (the sensitivity, the category, the tone brief, which modes are on the menu, whether automated help is offered and — if not — exactly why), evidence.signals (types and how many days ago; evidence, never certainty), evidence.relationship, evidence.history (when they were last touched and how), evidence.preferences, evidence.channels (what is permitted per channel), evidence.blindSpots (each is UNKNOWN, never 'fine'), the options menu with the planner's reasons, and tenant_guidance. Never invent what happened, who was involved, how they feel, a timeline, a price or a reason.",
  "THE DECISION YOU OWN — choose exactly ONE option id from the menu: QUIET MONITORING ('wait': hold, keep listening, let the moment breathe — often the kindest answer, especially soon after a loss or a separation); HELPFUL EDUCATION ('education', when offered: something useful to ANY homeowner — a seasonal home-care checklist, trusted local services, how to read the local market — chosen because it fits their stage, never because of the event); APPROPRIATE OUTREACH ('communication' / 'market_update' / 'properties', when offered: a warm, low-pressure touch that would make sense even if nothing had happened); or A HUMAN ('agent_intervention': the agent reaches out personally — when judgment is genuinely needed). Research continues through the movement manager whatever you choose. You do NOT write the message; whoever writes it receives the same rules and a screen refuses any draft that names or alludes to the event.",
  "WHAT 'WARM' MEANS HERE. Lead with usefulness and choice, never urgency. No congratulations, no condolences used as an opener, no 'I noticed', no 'heard about', no valuation nudge, no 'now is a great time'. The person must never be able to infer that we know about the event. Consider timing: a fresh, painful event usually calls for quiet monitoring; an older or upbeat one (a new job) may welcome gentle, useful help. Frequency matters: if they were touched recently, prefer quiet monitoring.",
  "AUTONOMY AND EVIDENCE. Automated help appears on the menu only when the evidence is grounded with a CONFIRMED identity AND the tenant explicitly granted the AI ISA autonomy; when evidence.lifeEvent.automatedHelpOffered is false, choose between quiet monitoring and a person — and do not choose a person merely because the topic is sensitive.",
  "ESCALATION RULE (choose agent_intervention). Signs of distress, danger, grief expressed TO US, a dispute or a legal matter; contradictory or confusing evidence; a person who asked to speak to someone; a relationship where the agent clearly knows them personally and a human note is what a friend would send; anything you are unsure a machine should touch. Estate-solicitation and outreach rules vary by state — when in doubt about the law, a person.",
  "COMPLIANCE BOUNDARY. Never reason from race, colour, religion, sex, disability, familial status, national origin, marital status or age, and never let a protected trait or its proxy (a marriage, a baby, a retirement) steer a housing offer — a household change never selects homes or neighbourhoods. Consent, opt-out, do-not-contact, quiet hours and fatigue are enforced around you and cannot be changed. Fair-housing copy screening applies to public marketing; your decision rests only on the evidence keys supplied.",
  "OUTPUT CONTRACT. Reply with JSON only: {\"optionId\": one menu id, \"channel\": one of that option's channels or null, \"format\": null, \"waitHours\": hours to hold when optionId is 'wait' (within the bounds given) else null, \"rationale\": 1-3 plain sentences a broker would accept, written WITHOUT naming the event, \"evidence\": [the top-level evidence keys you relied on, e.g. \"lifeEvent\", \"signals\", \"history\"], \"confidence\": 0..1}.",
].join("\n")

/**
 * WAVE 147 (lane 147G, owner rulings 12 + 18 — "sms needs to reach the arbiter's responder"; "prompts are detailed, expert,
 * creative and structured"): THE INBOUND RESPONDER'S DECISION PROMPT. The general ARBITER_SYSTEM above stays the follow-up
 * judgment for planned touches; a person who just WROTE TO US is a different moment (they are waiting, the thread is live,
 * and the reply is a conversation, not a campaign), so the responder decides under this expert brief — passed through
 * arbitrateFollowUp's `system`, validated by the SAME closed-menu validator (an option off the menu, an uncited reason or a
 * confidence below the tenant's floor still falls back to a person). Business voice from
 * .claude/skills/real-estate-client-communication (trusted advisor, emotionally aware, action-oriented, never pushy).
 */
export const ARBITER_INBOUND_SYSTEM = [
  "ROLE. You are the response judgment of a licensed real-estate brokerage's AI team — the colleague who reads every message a client, prospect or neighbour sends the moment it arrives and decides how the team answers. You are a trusted advisor, not a salesperson: calm, specific, emotionally aware, and you never let a person who wrote to us go unanswered.",
  "BUSINESS CONTEXT. The message arrived on a channel the brokerage owns (a text to its number, an email, a DM or a comment on its page). The person may be a client in a live transaction, a past client, a prospect, or someone we have never spoken to. A text is answered in minutes; a public comment is read by everyone. The brokerage's licensed agents own every judgment call; the AI team answers routine questions and hands the rest to the agent who owns the relationship.",
  "FACTS YOU MAY RELY ON — ONLY the JSON you are given: moment (the channel, surface and how the message was read), evidence.intent (the per-message classifier's reading and its confidence), evidence.relationship (whether this is a known contact, a first-time texter we just met, or an unidentified public sender, and whether an agent owns them), evidence.history (the last channel), evidence.preferences (channel / time / language the person told us), evidence.blindSpots (what could NOT be read — treat each as unknown, never as 'fine'), the options menu with the planner's reasons, and tenant_guidance.",
  "WHAT YOU MUST NOT INVENT. Never assume a price, an availability, a showing time, a contract term, a commission, a lender figure or a legal answer — none of them are in your evidence. Never infer anything about who the person is (family, origin, religion, disability, age, income) and never let such a guess shape the choice. If the answer depends on a fact you were not given, the right choice is a person.",
  "THE DECISION YOU OWN. Choose exactly ONE option id from the menu: 'reply' (the team answers in the thread it came in — routine questions, thanks, scheduling interest, 'is it still available' where the reply can promise a follow-up without stating facts), 'notify_human' (the agent answers personally), or 'audience_reengagement' when offered (a consented 1:1 follow-up to a person who answered an ad). You do NOT write the reply and you do NOT decide whether it is sent unattended — the tenant's autonomy grant, consent, do-not-contact, quiet hours, the content-safety screen and the provider's own gates decide that after you, and anything they refuse goes to a person with the draft.",
  "ESCALATION RULE (choose notify_human). A complaint, distress, anger or grief; anything legal, a dispute or a threat of one; a fair-housing or discrimination question; money, an offer, a counter, a negotiation, a contract term or a deadline; a lender, title or appraisal question; a request to speak to a person; a message you could not read confidently (intent confidence under 60 or a blind spot on the person); a first message from a texter we have never met that asks for anything beyond a hello or general interest; and every case where you are unsure. When in doubt, a person — a slow human answer beats a confident wrong one.",
  "COMPLIANCE BOUNDARY. Consent, opt-out and do-not-contact are enforced before and after you; an opt-out never reaches you. A PUBLIC comment's reply stays general and invites a private conversation — never a personal detail in public. Fair-housing screening applies to any public reply's copy; your decision itself must rest only on the evidence keys supplied.",
  "OUTPUT CONTRACT. Reply with JSON only: {\"optionId\": one menu id, \"channel\": one of that option's channels or null, \"format\": null, \"waitHours\": null, \"rationale\": 1-3 plain sentences a broker would accept as the reason, \"evidence\": [the top-level evidence keys you relied on, e.g. \"intent\", \"relationship\", \"moment\"], \"confidence\": 0..1}. An answer off the menu, without evidence, or under the tenant's confidence floor is refused and a person answers instead.",
].join("\n")

function buildArbiterPrompt(a: { facts: ArbiterFacts; menu: ArbiterOption[]; policy: FollowupPolicy }): string {
  return JSON.stringify({
    tenant_guidance: a.policy.guidance || "(none set — use judgment)",
    moment: a.facts.moment,
    evidence: a.facts,
    options: a.menu.map((o) => ({ id: o.id, kind: o.kind, channels: o.channels, formats: Object.fromEntries(o.channels.map((c) => [c, formatsForChannel(c)])), planner_reasons: o.why })),
    wait_bounds_hours: { min: 1, max: Math.max(1, a.policy.arbiter.maxDeferDays * 24) },
    platform_defaults_not_orders: { min_hours_between_touches: a.policy.guardrails.minHoursBetweenTouches },
  })
}

type ArbiterValidation = { ok: true; decision: Omit<ArbiterDecision, "source" | "fallbackReason" | "menu" | "stance"> } | { ok: false; why: string }

/** PURE. The model's reply → a decision the platform will honour, or the reason it will not. (Module-private: scripts/intent-driven-followup-guard.ts drives every refusal THROUGH arbitrateAndRecordExperience.) */
function validateArbiterReply(raw: ArbiterRaw | null | undefined, menu: ArbiterOption[], facts: ArbiterFacts, policy: FollowupPolicy): ArbiterValidation {
  if (!raw || typeof raw !== "object") return { ok: false, why: "no reply" }
  const opt = menu.find((o) => o.id === raw.optionId)
  if (!opt) return { ok: false, why: `option "${String(raw.optionId)}" is not on the menu` }
  let channel: ArbiterChannel | null = null
  if (raw.channel !== null && raw.channel !== undefined && raw.channel !== "") {
    const canon = canonicalArbiterChannel(raw.channel)
    if (!canon && typeof raw.channel === "string" && FORMAT_WORDS.has(raw.channel.trim().toLowerCase())) return { ok: false, why: `"${raw.channel}" is a creative format, not a channel — it is not permitted for ${opt.id} as a channel` }
    if (!canon || !opt.channels.includes(canon)) return { ok: false, why: `channel "${String(raw.channel)}" is not permitted for ${opt.id}` }
    channel = canon
  } else if (opt.channels.length > 0) {
    channel = opt.channels[0]
  }
  let format: ArbiterFormat | null = KIND_FORMAT[opt.kind] ?? (channel ? formatsForChannel(channel)[0] ?? null : null)
  if (raw.format !== null && raw.format !== undefined && raw.format !== "") {
    const f = typeof raw.format === "string" ? raw.format.trim().toLowerCase() : ""
    if (!channel || !(formatsForChannel(channel) as string[]).includes(f)) return { ok: false, why: `format "${String(raw.format)}" cannot ride ${channel ?? "no channel"}` }
    if (KIND_FORMAT[opt.kind] && f !== KIND_FORMAT[opt.kind]) return { ok: false, why: `a ${opt.kind} experience is a ${KIND_FORMAT[opt.kind]} — not "${f}"` }
    format = f as ArbiterFormat
  }
  let waitHours: number | null = null
  if (opt.kind === "wait") {
    const max = Math.max(1, policy.arbiter.maxDeferDays * 24)
    if (typeof raw.waitHours !== "number" || !Number.isFinite(raw.waitHours)) return { ok: false, why: "a wait needs waitHours" }
    waitHours = Math.round(raw.waitHours)
    if (waitHours < 1 || waitHours > max) return { ok: false, why: `waitHours ${waitHours} is outside 1..${max}` }
  } else if (raw.waitHours !== null && raw.waitHours !== undefined && raw.waitHours !== 0) {
    return { ok: false, why: "waitHours is only for a wait" }
  }
  if (typeof raw.rationale !== "string" || raw.rationale.trim().length < 10) return { ok: false, why: "no rationale" }
  const known = new Set(Object.entries(facts).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0)).map(([k]) => k))
  const evidence = Array.isArray(raw.evidence) ? [...new Set((raw.evidence as unknown[]).filter((e): e is string => typeof e === "string" && known.has(e)))] : []
  if (evidence.length === 0) return { ok: false, why: "the reply cites no evidence the platform supplied" }
  const confidence = typeof raw.confidence === "number" && Number.isFinite(raw.confidence) ? Math.min(1, Math.max(0, raw.confidence)) : 0
  if (confidence < policy.arbiter.minConfidence) return { ok: false, why: `confidence ${confidence} is below the policy floor ${policy.arbiter.minConfidence}` }
  return { ok: true, decision: { optionId: opt.id, kind: opt.kind, channel, format, waitHours, rationale: raw.rationale.trim().slice(0, 600), evidence, confidence } }
}

// ── the decision ─────────────────────────────────────────────────────────────────────────────

async function defaultDecide(a: { brokerageId: string; system: string; prompt: string }): Promise<ArbiterRaw> {
  const [{ generateObjectRouted }, { z }] = await Promise.all([import("@/lib/ai/models"), import("zod")])
  const schema = z.object({
    optionId: z.string(),
    channel: z.string().nullable(),
    format: z.string().nullable(),
    waitHours: z.number().nullable(),
    rationale: z.string(),
    evidence: z.array(z.string()),
    confidence: z.number(),
  })
  const { object } = await generateObjectRouted({ feature: "followup_arbitration", brokerageId: a.brokerageId, manager: "ai_isa", system: a.system, prompt: a.prompt, schema, temperature: 0.2, maxTokens: 500 })
  return object
}

/**
 * Decide the next follow-up for ONE person. Never throws, never returns an option off the menu.
 * `planned` is the planner's own verdict (the thing that happens if the model does not answer).
 */
export async function arbitrateFollowUp(
  a: {
    brokerageId: string; facts: ArbiterFacts; menu: ArbiterMenu; planned: ArbiterOption; policy: FollowupPolicy; budget?: ArbiterBudget; priority?: ArbiterPriority | null
    /** Wave 147 (147G): the expert brief for this moment (ARBITER_INBOUND_SYSTEM for a person who wrote in); default ARBITER_SYSTEM. The validator is the same either way. */
    system?: string | null
  },
  deps: { decide?: ArbiterDecide } = {},
): Promise<ArbiterDecision> {
  const withStance = (d: Omit<ArbiterDecision, "stance">): ArbiterDecision => ({ ...d, stance: arbiterStance(d, a.facts.history.lastChannel) })
  const base = (over: Partial<ArbiterDecision> & { fallbackReason: string }): ArbiterDecision => {
    const kind = over.kind ?? a.planned.kind
    const channel = over.channel !== undefined ? over.channel : (a.planned.channels[0] ?? null)
    return withStance({
      optionId: a.planned.id, kind, channel, format: KIND_FORMAT[kind] ?? (channel ? formatsForChannel(channel)[0] ?? null : null), waitHours: null,
      rationale: `The planner's verdict stands: ${over.fallbackReason}.`, evidence: [], confidence: 1, source: "deterministic",
      menu: a.menu.menu.map((o) => o.id), ...over,
    })
  }
  /** Ask the model over a CLOSED menu; anything it cannot or may not answer falls to `fallback` with the reason (never an unchecked send). */
  const ask = async (menu: ArbiterOption[], facts: ArbiterFacts, fallback: (why: string) => ArbiterDecision): Promise<ArbiterDecision> => {
    if (a.budget && a.budget.remaining <= 0) return fallback("this sweep's decision budget is spent")
    if (a.budget) a.budget.remaining -= 1
    let raw: ArbiterRaw
    try {
      raw = await (deps.decide ?? defaultDecide)({ brokerageId: a.brokerageId, system: a.system?.trim() ? a.system : ARBITER_SYSTEM, prompt: buildArbiterPrompt({ facts, menu, policy: a.policy }) })
    } catch (e) {
      return fallback(`the model was unavailable (${e instanceof Error ? e.message : String(e)})`)
    }
    const v = validateArbiterReply(raw, menu, facts, a.policy)
    if (!v.ok) return fallback(`the model's reply was refused — ${v.why}`)
    return withStance({ ...v.decision, source: "ai", fallbackReason: null, menu: menu.map((o) => o.id) })
  }
  if (a.menu.locked) return base({ kind: a.menu.locked.kind, optionId: a.menu.locked.kind, channel: null, fallbackReason: `locked — ${a.menu.locked.reason}` })
  // SPEED-TO-LEAD IS THE ARBITER'S DECISION (owner ruling 16, wave 145 — supersedes ruling 12's "fixed send"). The hard stops above
  // still lock first. The menu narrows to the ways of ANSWERING NOW (a first touch on a permitted channel, or a person); WAIT and
  // every slower experience are not offered, so the requirement cannot be deferred. When there is a real choice (two ways to
  // answer, or two permitted channels for the touch) the model makes it from the full evidence; otherwise — and on any outage /
  // refusal / spent budget / arbiter switched off — the first touch goes on the planner's channel (never a wait).
  // WAVE 146 (lane 146B, owner ruling 10): a PROMISED lead-magnet deliverable that has not been delivered is the same kind of
  // requirement — deliver now, on a permitted channel or through a person; never a wait (contract C4's undelivered moment).
  if (a.priority === "speed_to_lead" || a.priority === "promised_deliverable") {
    const label = a.priority === "speed_to_lead" ? "Speed-to-lead: the first response goes now" : "A promised deliverable is owed: it goes now"
    const answerNow = a.menu.menu.filter((o) => SPEED_TO_LEAD_KINDS.has(o.kind) && (o.kind !== "communication" || o.channels.length > 0))
    const touch = answerNow.find((o) => o.kind === "communication")
    const first = touch ?? answerNow[0]
    const ids = answerNow.map((o) => o.id)
    const fallback = (why: string): ArbiterDecision => first
      ? base({ optionId: first.id, kind: first.kind, channel: first.channels[0] ?? null, menu: ids, rationale: `${label} — ${why}.`, fallbackReason: `${a.priority} — ${why}` })
      : base({ menu: ids, fallbackReason: `${a.priority} — ${why}` })
    if (!first) return fallback("no permitted channel carries a first touch and no person can take it; the planner's verdict stands")
    const hasChoice = answerNow.length > 1 || (touch?.channels.length ?? 0) > 1
    if (!hasChoice) return fallback("only one way to answer is permitted")
    if (!a.policy.arbiter.enabled) return fallback("the tenant turned the arbiter off")
    return ask(answerNow, a.facts, fallback)
  }
  if (!a.policy.arbiter.enabled) return base({ fallbackReason: "the tenant turned the arbiter off" })
  if (a.menu.menu.length <= 1) {
    // ONE permitted option is not a choice to ask the model about — but it is not necessarily the planner's verdict either: an
    // overdue moment with nothing automated left offers ONLY a human (never silence), while the planner's own pick may still be
    // `wait`. The permitted option wins; if there is none the planner's verdict stands.
    const sole = a.menu.menu[0]
    if (sole && sole.id !== a.planned.id) return base({ optionId: sole.id, kind: sole.kind, channel: sole.channels[0] ?? null, fallbackReason: "only one option is permitted" })
    return base({ fallbackReason: "only one option is permitted" })
  }
  return ask(a.menu.menu, a.facts, (why) => base({ fallbackReason: why }))
}

/** The experiences that ANSWER a speed-to-lead requirement now: the first touch itself, or a person (notify human). */
const SPEED_TO_LEAD_KINDS: ReadonlySet<ExperienceKind> = new Set<ExperienceKind>(["communication", "agent_intervention"])

/** The facts' moment for a speed-to-lead decision (the prompt's cue that waiting is not on the table). */
function speedToLeadMoment(): NonNullable<ArbiterFacts["moment"]> {
  return { key: "speed_to_lead", intent: "A new lead / newly assigned contact must be answered now — choose HOW to answer (channel, or a person), not whether.", daysSinceOpen: 0 }
}

// ── experience-plan integration ──────────────────────────────────────────────────────────────

type ArbitratedPlan = { plan: NextBestExperiencePlan; decision: ArbiterDecision }

/**
 * Apply the arbiter to a planner verdict: the returned plan's `chosen` is the model's pick (re-timed for a wait), every
 * other field is the planner's. The plan keeps `ranked`, `nba`, `contributed` — the evidence — untouched.
 */
async function arbitrateExperiencePlan(
  a: {
    brokerageId: string; input: NextBestExperienceInput; plan: NextBestExperiencePlan; policy: FollowupPolicy; budget?: ArbiterBudget; moment?: ArbiterFacts["moment"]; daysDeferred?: number | null
    checks?: ChannelCheck[] | null; deliverable?: readonly ArbiterChannel[] | null; signals?: readonly LifeChangeSignal[]; priority?: ArbiterPriority | null
    /** Wave 147 (147Z): the neighbourly helpers lane B's C9 evidence supports — options for the model, never a timetable. */
    helpers?: readonly ArbiterMovementHelper[]
    /** Wave 148 (148F): the tenant's explicit autonomy grant, read only when the decisive signal is a life event (null = not granted). */
    lifeEventAuthority?: LifeEventAuthority | null
    /** Wave 149 (149Z, lane 149H): the combined-signal opportunity reading + menu from the C9 hook (evidence; null = none). */
    opportunity?: ArbiterOpportunityInput | null
  },
  deps: { decide?: ArbiterDecide } = {},
): Promise<ArbitratedPlan> {
  const moment = a.moment ?? (a.priority === "speed_to_lead" ? speedToLeadMoment() : null)
  // Days the person has ALREADY been held: a moment's age since it OPENED, else the arbiter's own prior waits for this person.
  const ctx: ChannelContext & { daysSinceMomentOpen: number | null } = {
    allowedChannels: a.input.policy.allowedChannels, videoAllowed: a.input.policy.videoAllowed, checks: a.checks ?? null, deliverable: a.deliverable ?? null,
    daysSinceMomentOpen: a.moment?.daysSinceOpen ?? a.daysDeferred ?? null,
  }
  // WAVE 148 (148F, owner ruling 17 — REPLACES wave 147's narrowing to a person or a wait): a LIFE EVENT that is the decisive
  // signal opens the empathetic branch (lifeEventMenu): quiet monitoring, helpful education, appropriate outreach (automated help
  // only on confirmed evidence under the tenant's explicit autonomy) or a person — decided under ARBITER_LIFE_EVENT_SYSTEM, with
  // QUIET MONITORING as the policy's own fallback (never a person by reflex). A requirement (speed-to-lead, a promised
  // deliverable) is not reshaped: the person asked for that, and its own branch already offers a person.
  const menu = lifeEventMenu(arbiterMenuFromPlan(a.plan, a.policy, ctx), a.signals ?? [], a.priority ?? null, a.lifeEventAuthority ?? null)
  const lifeDefault: ExperienceKind | null = menu.lifeEvent ? (menu.menu.some((o) => o.kind === "wait") ? "wait" : "agent_intervention") : null
  const plannedKind: ExperienceKind = lifeDefault ?? a.plan.chosen.kind
  const plannedRanked = a.plan.ranked.find((r) => r.kind === plannedKind)
  const chosenOpt: ArbiterOption = { id: plannedKind, kind: plannedKind, channels: channelsForKind(plannedKind, ctx), why: (plannedKind === a.plan.chosen.kind ? a.plan.chosen.reasons : plannedRanked?.reasons ?? ["quiet monitoring — the kind default for a significant personal moment"]).slice(0, 4) }
  const facts = arbiterFactsFromExperienceInput(a.input, moment, { checks: a.checks ?? null, signals: a.signals, helpers: a.helpers })
  if (menu.lifeEvent) facts.lifeEvent = menu.lifeEvent.brief
  // WAVE 149 (149Z — lane 149H Outside-lane 1 / lane 149C Outside-lane 2): the combined-signal reading reaches the decision as
  // EVIDENCE (eligible modes only) and as urgency (an `emerging`-or-stronger reading is at least "normal"; it never raises "high"
  // alone — a combination is still not a fresh stated move). The expert brief for reading a combination rides the system prompt.
  // The menu stays the planner's: the reading never adds an outbound option and carries no time (timing is the arbiter's).
  let system: string | null = menu.lifeEvent ? ARBITER_LIFE_EVENT_SYSTEM : null
  if (a.opportunity?.reading?.primary) {
    const { OPPORTUNITY_COMBINATION_BRIEF, opportunityFactsFrom } = await import("@/lib/intent/opportunity-discovery")
    const opp = opportunityFactsFrom(a.opportunity)
    if (opp) {
      facts.opportunity = opp
      if (facts.urgency == null && ["emerging", "likely", "stated"].includes(opp.stage)) facts.urgency = "normal"
      system = `${system ?? ARBITER_SYSTEM}\n${ARBITER_OPPORTUNITY_NOTE}\n${OPPORTUNITY_COMBINATION_BRIEF}`
    }
  }
  const decided = await arbitrateFollowUp({ brokerageId: a.brokerageId, facts, menu, planned: chosenOpt, policy: a.policy, budget: a.budget, priority: a.priority ?? null, system }, deps)
  const decision: ArbiterDecision = menu.lifeEvent ? { ...decided, lifeEvent: { ...menu.lifeEvent.guard, mode: lifeEventModeOf(decided.kind) } } : decided
  if (decision.kind === a.plan.chosen.kind && decision.waitHours === null) return { plan: a.plan, decision }
  let found: RankedExperience | undefined = a.plan.ranked.find((r) => r.kind === decision.kind)
  if (!found && decision.kind === "agent_intervention") {
    // The menu offered a human because nothing automated was left (arbiterMenuFromPlan) — a candidate the planner never ranked. The
    // person is handed to the agent, not left on the planner's `wait`.
    const { EXPERIENCE_EXECUTORS } = await import("./lead-action-plan")
    const exec = EXPERIENCE_EXECUTORS.agent_intervention
    found = { kind: "agent_intervention", score: 0, reasons: ["no automated option remains and waiting is exhausted — a person decides"], manager: exec.manager, capability: exec.capability, dueAt: a.input.now }
  }
  const pick = found ?? a.plan.chosen
  const dueAt = decision.waitHours !== null ? new Date(a.input.now.getTime() + decision.waitHours * 3_600_000) : pick.dueAt
  return { plan: { ...a.plan, chosen: { ...pick, dueAt } }, decision }
}

/** The ledger detail every arbitrated decision carries (LAW 5: who/what, why, which evidence, which policy). */
export function arbitrationLedgerDetail(d: ArbiterDecision, policyRef: string | null, extra: { checks?: ChannelCheck[] | null; signals?: readonly LifeChangeSignal[]; blindSpots?: readonly string[] } = {}): Record<string, unknown> {
  return {
    source: d.source, option: d.optionId, channel: d.channel, format: d.format ?? null, stance: d.stance ?? null, wait_hours: d.waitHours, rationale: d.rationale, evidence: d.evidence, confidence: d.confidence, fallback_reason: d.fallbackReason, menu: d.menu, policy_ref: policyRef,
    // Wave 144: every channel CONSIDERED, with the check that decided it (LAW 5 — which policy permitted, and which refused).
    ...(extra.checks ? { channels_considered: extra.checks.map((c) => ({ channel: c.channel, available: c.available, approval: c.approval, spend_tier: c.spendTier, reasons: c.reasons.slice(0, 3) })) } : {}),
    ...(extra.signals && extra.signals.length > 0 ? { signals: extra.signals.map((s) => ({ type: s.type, kind: s.kind, days_ago: s.daysAgo })) } : {}),
    ...(extra.blindSpots && extra.blindSpots.length > 0 ? { channel_blind_spots: [...extra.blindSpots] } : {}),
    // Wave 148 (148F, ruling 17 — LAW 5): the life-event mode chosen and the rules of the words, for every downstream writer and audit.
    ...(d.lifeEvent ? { life_event: { mode: d.lifeEvent.mode, canonical: d.lifeEvent.canonical, sensitivity: d.lifeEvent.sensitivity, automated_help_offered: d.lifeEvent.automatedHelpOffered, never_mention: d.lifeEvent.neverMention, tone: d.lifeEvent.tone } } : {}),
  }
}

/** A HIGH-PRIORITY REQUIREMENT the arbiter decides under (owner ruling 16, wave 145): `speed_to_lead` = answer now — the model
 *  chooses how (channel, or a person), never whether or when. Replaces wave 144's `FixedSendException` (ruling 12's "fixed send, the
 *  arbiter is not consulted"), which the owner reversed. (The one welcome when a lead becomes a contact never reaches the arbiter:
 *  lib/contact-promotion/conversion-welcome.ts sends it.) */
export type ArbiterPriority = "speed_to_lead" | "promised_deliverable"

// ── the re-engagement cadence integration (ghost leads) ──────────────────────────────────────

export interface CadenceArbitrationInput {
  brokerageId: string
  policy: FollowupPolicy
  /** The deterministic cadence envelope's verdict (reengagement-policy.ts shouldSendGhostOutreach). */
  cadence: { shouldSend: boolean; phase: 1 | 2 | 3; daysSinceStart: number; reason: string }
  facts: {
    leadTemperature: string | null
    leadScore: number | null
    timeline: string | null
    attempts: number
    hoursSinceLastOutreach: number | null
    hoursSinceLastActivity: number | null
    /** Days this send has ALREADY been deferred by the arbiter (countArbiterWaits; an unreadable count is passed as the policy's maxDeferDays → no more waiting). */
    daysDeferred: number
    source: string | null
    preferences: Array<{ key: string; value: string }>
  }
  budget?: ArbiterBudget
  /**
   * WAVE 149 (lane 149C, owner ruling 7 / contract C29): what the OTHER planners propose for this touch — options the model
   * weighs, never orders. `angles` = lib/ai-isa/adaptive-reengagement.ts's opening angles (its attempt-indexed pick is the
   * SUGGESTION, the fallback when the model does not answer); `newsletter` = lib/ai-isa/next-best-touch.ts's downshift to the
   * passive newsletter (its decideNextChannel verdict is the suggestion). Omitted = a single send option (long-term-nurture).
   */
  proposals?: {
    angles?: { suggested: string; offered: readonly string[] } | null
    newsletter?: { suggested: boolean; reason: string } | null
  }
}

export interface CadenceArbitration {
  /** true = release the send now; false = hold it (the runner skips this lead this run). */
  sendNow: boolean
  decision: ArbiterDecision | null
  /** Why the arbiter was not consulted (the spacing guidance holds with nothing new / the fatigue floor), when it was not. */
  skippedReason: string | null
  /** Wave 149 (C29): the opening angle the arbiter chose among `proposals.angles` (null = none was offered). */
  angle?: string | null
  /** Wave 149 (C29): true when the arbiter chose the newsletter downshift (`proposals.newsletter`) over a 1:1 send. */
  newsletter?: boolean
}

/** The option id of a 1:1 send carrying a given opening angle (a stable spelling the runner parses back). */
const SEND_ANGLE_PREFIX = "send_now:"

/**
 * The arbiter's say over a cadence touch. WAVE 149 (lane 149C, owner ruling 7 — "nothing fixed in communications … the arbiter
 * or the manager decides timing, channel and content from the situation"; contract C29): the tenant's spacing (Mon/Wed/Fri,
 * the 30- / 90-day spacing — followup_policy.reengagement) is no longer a GATE in front of the judgment, it is the PLANNER'S
 * GUIDANCE inside it: when the guidance says a touch is due the planner proposes `send_now`; when it says "not yet" the planner
 * proposes `wait` — and in BOTH cases the model decides from the evidence whenever there is something to decide on:
 *   · due                               → the model chooses send (which angle / the newsletter) or a bounded wait;
 *   · not due, and the lead DID something since our last touch (fresh activity) → the model may answer that evidence now
 *     (send) or keep waiting — the guidance's `wait` is the fallback, so an outage never sends early;
 *   · not due and nothing new           → the guidance stands without a model call (no evidence = nothing to judge; the
 *     sweep's budget is kept for people with evidence) — recorded as the skip reason, never as a schedule.
 * What stays DETERMINISTIC and is never asked: the fatigue floor (policy.guardrails.minHoursBetweenTouches — a floor, never a
 * schedule), every stop condition (reengagement-policy.ts ghostReengagementStopReason), consent / channel rules (leads: email +
 * mail only, CLAUDE.md §5) and the dispatcher's gates. Once a person has been held policy.arbiter.maxDeferDays the wait option is
 * withdrawn so nobody is deferred forever.
 */
export async function arbitrateCadence(a: CadenceArbitrationInput, deps: { decide?: ArbiterDecide } = {}): Promise<CadenceArbitration> {
  const floor = a.policy.guardrails.minHoursBetweenTouches
  if (a.facts.hoursSinceLastOutreach !== null && a.facts.hoursSinceLastOutreach < floor) {
    return { sendNow: false, decision: null, skippedReason: `inside the ${floor}h fatigue floor (last outreach ${a.facts.hoursSinceLastOutreach}h ago)`, angle: null, newsletter: false }
  }
  // "Fresh" = the lead's own activity is at least an hour newer than our last touch (our send stamps last_activity_at too).
  const freshActivity = a.facts.hoursSinceLastActivity !== null && (a.facts.hoursSinceLastOutreach === null || a.facts.hoursSinceLastActivity + 1 <= a.facts.hoursSinceLastOutreach)
  if (!a.cadence.shouldSend && !freshActivity) {
    return { sendNow: false, decision: null, skippedReason: `the tenant's spacing guidance holds and nothing new happened since the last touch (${a.cadence.reason})`, angle: null, newsletter: false }
  }
  const guidance = a.cadence.shouldSend
    ? `the tenant's spacing guidance says a touch is due (${a.cadence.reason}, phase ${a.cadence.phase}, day ${a.cadence.daysSinceStart})`
    : `the tenant's spacing guidance says not yet (${a.cadence.reason}) — but the lead was active ${a.facts.hoursSinceLastActivity}h ago, after our last touch`
  const angles = a.proposals?.angles && a.proposals.angles.offered.length > 0 ? a.proposals.angles : null
  const sends: ArbiterOption[] = angles
    ? [...new Set(angles.offered)].map((ang) => ({ id: `${SEND_ANGLE_PREFIX}${ang}`, kind: "communication" as const, channels: [], why: [guidance, ang === angles.suggested ? `the adaptive planner's suggested opening angle for attempt ${a.facts.attempts + 1}: ${ang.replace(/_/g, " ")}` : `a different opening angle: ${ang.replace(/_/g, " ")}`] }))
    : [{ id: "send_now", kind: "communication", channels: [], why: [guidance] }]
  const newsletter: ArbiterOption | null = a.proposals?.newsletter
    ? { id: "newsletter_handoff", kind: "communication", channels: [], why: [guidance, `hand the relationship to the passive newsletter instead of another 1:1 note${a.proposals.newsletter.suggested ? ` (the next-best-touch planner's pick: ${a.proposals.newsletter.reason})` : ""}`] }
    : null
  const wait: ArbiterOption = { id: "wait", kind: "wait", channels: [], why: ["hold for a bounded time if the evidence says now is the wrong moment"] }
  const overdue = a.facts.daysDeferred >= a.policy.arbiter.maxDeferDays
  const menu: ArbiterMenu = { menu: [...sends, ...(newsletter ? [newsletter] : []), ...(overdue ? [] : [wait])], locked: null }
  const suggestedSend = sends.find((s) => s.id === `${SEND_ANGLE_PREFIX}${angles?.suggested}`) ?? sends[0]
  const send: ArbiterOption = !a.cadence.shouldSend && !overdue ? wait : newsletter && a.proposals?.newsletter?.suggested ? newsletter : suggestedSend
  const factsForModel: ArbiterFacts = {
    subject: "lead",
    relationship: { type: "lead", persona: a.facts.leadTemperature, hasAssignedAgent: false },
    intent: a.facts.leadScore === null ? null : { score: a.facts.leadScore, trend: a.facts.leadTemperature ?? "unknown" },
    history: { hoursSinceAnyTouch: a.facts.hoursSinceLastOutreach, hoursSinceAgentTouch: null, campaignTouches7d: null, lastChannel: null, portalEducationViews: null },
    journey: { transactionStage: a.facts.timeline, nextMilestone: null, openLessons: null, nextLesson: null },
    preferences: a.facts.preferences.filter((p) => ARBITER_MEMORY_KEYS.includes(p.key)),
    fatigueRisk: null,
    localHour: null,
    moment: { key: `reengagement_phase_${a.cadence.phase}`, intent: `Re-engage a lead who has gone quiet (attempt ${a.facts.attempts + 1}); ${a.cadence.shouldSend ? "the tenant's spacing guidance says a touch is due" : "the spacing guidance says not yet, but the lead has been active since our last touch"} — decide whether now is right, and how to open.`, daysSinceOpen: a.facts.daysDeferred },
    blindSpots: [],
  }
  const decision = await arbitrateFollowUp({ brokerageId: a.brokerageId, facts: factsForModel, menu, planned: send, policy: a.policy, budget: a.budget }, deps)
  const angle = decision.optionId.startsWith(SEND_ANGLE_PREFIX) ? decision.optionId.slice(SEND_ANGLE_PREFIX.length) : null
  return { sendNow: decision.kind !== "wait", decision, skippedReason: null, angle, newsletter: decision.optionId === "newsletter_handoff" }
}

// ── WAVE 149 (lane 149C, contract C29) — EVERY PLANNER PROPOSES, THE ARBITER DECIDES ──────────────────────────────────────

/**
 * THE SIX PLANNER ENTRY POINTS (lane 148Z Still open, 143E-SO-03 — "adaptive-reengagement, next-best-touch, stale-contact-detector,
 * saved-home-nudge, ghost-escalation, lead-nurture onto the arbiter") and the ONE arbiter door each one's proposal now passes.
 * Each planner keeps its own knowledge (what the angle is, which channel the person replies to, who is stale, what changed on a
 * saved home, when the active cadence is spent, which verified channel a hot seller has) and hands it to the arbiter as OPTIONS
 * with its own verdict as the fallback; the arbiter decides timing, channel and content. scripts/arbiter-timing-guard.ts reads
 * this table and proves every `door` calls its `via` in stripped source.
 * @proofSeam the census guard reads the table; production reads no field of it (each door calls the arbiter directly).
 */
export const ARBITER_PLANNER_ENTRY_POINTS = Object.freeze({
  adaptive_reengagement: { planner: "lib/ai-isa/adaptive-reengagement.ts", door: "lib/ai-isa/ghost-reengagement.ts", via: "arbitrateCadence", what: "the attempt's opening angle is a SUGGESTION among the angles offered (proposals.angles)" },
  next_best_touch: { planner: "lib/ai-isa/next-best-touch.ts", door: "lib/ai-isa/ghost-reengagement.ts", via: "arbitrateCadence", what: "the newsletter downshift is an option (proposals.newsletter); for contacts the picker is the fallback behind arbitrateAndRecordExperience in app/actions/ai-isa/engage-contact.ts" },
  stale_contact_detector: { planner: "lib/ai-isa/stale-contact-detector.ts", door: "app/actions/ai-isa/engage-contact.ts", via: "arbitrateAndRecordExperience", what: "the detector names CANDIDATES (app/api/cron/stale-contact-monitor/route.ts → initiateAIISAContactEngagement → engageContact); the touch is the arbiter's" },
  saved_home_nudge: { planner: "lib/ai-isa/saved-home-nudge.ts", door: "lib/ai-isa/saved-home-nudge.ts", via: "arbitratePlannedTouch", what: "decideSavedHomeNudge: a personal reel, a written note or the agent — the classifier's pick is the fallback" },
  ghost_escalation: { planner: "lib/ai-isa/ghost-escalation.ts", door: "lib/ai-isa/ghost-escalation.ts", via: "arbitratePlannedTouch", what: "decideGhostEscalation: tell a person (offer a personal call) or let the quiet nurture continue — the FYI is the fallback" },
  lead_nurture: { planner: "lib/ai-isa/lead-nurture.ts", door: "lib/ai-isa/lead-nurture.ts", via: "arbitratePlannedTouch", what: "proposeLeadNurture: which verified channel(s) carry the hot-seller nurture, or the agent, or a bounded wait — both channels is the fallback" },
  // Beyond the six (C29 "every outbound touch … funnel step"): a tenant-authored sequence step's delay is its author's proposal.
  sequence_step: { planner: "lib/campaign-sequences/enrollment-engine.ts", door: "lib/campaign-sequences/step-executor.ts", via: "arbitratePlannedTouch", what: "a due step (after the first) sends now or waits a bounded time — the author's spacing is the fallback" },
  // Owner ruling 8 (C24 extended): when the person's window passes, the arbiter decides how the team answers for them.
  unattended_answer: { planner: "lib/communications/unattended-answer.ts", door: "lib/communications/unattended-answer.ts", via: "arbitratePlannedTouch", what: "a written answer on the client's channel (text / email / portal), that answer plus a personal video update, or a person after all — the written answer is the fallback" },
  // C32 / C29 (wave 149Z, lane 149C Outside-lane 1): event reminders and the no-show nurture are arbiter decisions, never a
  // T-<n>d table. Lane 149F's producer asks the arbiter's own door (arbitrateFollowUp) with a closed two-option menu.
  event_reminder: { planner: "lib/open-house/event-touches.ts", door: "lib/open-house/event-touches.ts", via: "arbitrateFollowUp", what: "event_registrant_upcoming: remind the registrant now on their consented channel, or wait — waiting is the fallback" },
  event_no_show: { planner: "lib/open-house/event-touches.ts", door: "lib/open-house/event-touches.ts", via: "arbitrateFollowUp", what: "event_registrant_no_show: hand the registrant to the host (a person) or let it rest under the AI ISA's normal consented engagement — resting is the fallback" },
} as const)
export type PlannerEntryPoint = keyof typeof ARBITER_PLANNER_ENTRY_POINTS

export interface PlannedTouchInput {
  brokerageId: string
  planner: PlannerEntryPoint
  subject: { type: "lead" | "contact"; id: string }
  now: Date
  /** The planner's CLOSED menu (its own knowledge as options) — the model can never pick off it. */
  options: ArbiterOption[]
  /** The planner's own verdict: what happens when the model does not answer (outage, refusal, spent budget, arbiter off). */
  planned: string
  /** What this moment is (the prompt's cue). */
  moment: { key: string; intent: string }
  relationship?: ArbiterFacts["relationship"]
  intent?: ArbiterFacts["intent"]
  history?: Partial<ArbiterFacts["history"]>
  urgency?: ArbiterFacts["urgency"]
  blindSpots?: string[]
  /** Offer a bounded wait (default true). Withdrawn once the person was held policy.arbiter.maxDeferDays days, or the waits are unreadable. */
  offerWait?: boolean
  policy?: FollowupPolicy
  budget?: ArbiterBudget
  /** The decision prompt (default ARBITER_SYSTEM). */
  system?: string | null
}

export interface PlannedTouchArbitration {
  /** The option id the arbiter chose (or the planner's, on a fallback). */
  choice: string
  decision: ArbiterDecision
  /** The decision row on the action ledger (LAW 5) — false = it could not be written (said, never pretended). */
  recorded: boolean
  ledgerError?: string
}

/**
 * THE ONE DOOR A PLANNER'S PROPOSAL PASSES (contract C29). The planner builds the options from what it knows, names its own
 * verdict, and the arbiter decides (arbitrateFollowUp — the same closed-menu validator as every other decision: an option off
 * the menu, an uncited reason or a confidence under the tenant's floor keeps the planner's verdict). A bounded `wait` is offered
 * unless the planner says the moment cannot wait. Every decision is ledgered (followup.decision.*, one row per planner per subject
 * per day). Never throws.
 */
export async function arbitratePlannedTouch(
  svc: { from: (t: string) => any },
  a: PlannedTouchInput,
  deps: { decide?: ArbiterDecide; record?: boolean } = {},
): Promise<PlannedTouchArbitration> {
  let policy = a.policy
  if (!policy) {
    try { policy = (await (await import("./followup-policy")).loadFollowupPolicy(svc as never, a.brokerageId)).policy }
    catch { policy = (await import("./followup-policy")).platformFollowupPolicy() }
  }
  const options = a.options.filter((o) => o.kind !== "wait")
  let withWait = a.offerWait !== false
  if (withWait) {
    const held = await countArbiterWaits(svc, { brokerageId: a.brokerageId, subject: a.subject, now: a.now, policy }).catch(() => null)
    if (held === null || held >= policy.arbiter.maxDeferDays) withWait = false
  }
  const wait: ArbiterOption = { id: "wait", kind: "wait", channels: [], why: ["hold for a bounded time if the evidence says now is the wrong moment"] }
  const menu: ArbiterMenu = { menu: [...options, ...(withWait ? [wait] : [])], locked: null }
  const planned = menu.menu.find((o) => o.id === a.planned) ?? options[0] ?? wait
  const facts: ArbiterFacts = {
    subject: a.subject.type,
    relationship: a.relationship ?? { type: a.subject.type, persona: null, hasAssignedAgent: false },
    intent: a.intent ?? null,
    history: { hoursSinceAnyTouch: null, hoursSinceAgentTouch: null, campaignTouches7d: null, lastChannel: null, portalEducationViews: null, ...(a.history ?? {}) },
    journey: { transactionStage: null, nextMilestone: null, openLessons: null, nextLesson: null },
    preferences: [],
    fatigueRisk: null,
    localHour: null,
    moment: { key: a.moment.key, intent: a.moment.intent, daysSinceOpen: 0 },
    blindSpots: [...(a.blindSpots ?? [])],
    ...(a.urgency ? { urgency: a.urgency } : {}),
  }
  let decision: ArbiterDecision
  try {
    decision = await arbitrateFollowUp({ brokerageId: a.brokerageId, facts, menu, planned, policy, budget: a.budget, system: a.system ?? null }, { decide: deps.decide })
  } catch (e) {
    decision = { optionId: planned.id, kind: planned.kind, channel: planned.channels[0] ?? null, format: null, waitHours: null, rationale: `The planner's verdict stands: the arbiter threw (${e instanceof Error ? e.message : String(e)}).`, evidence: [], confidence: 1, source: "deterministic", fallbackReason: "arbiter threw", menu: menu.menu.map((o) => o.id) }
  }
  let recorded = false
  let ledgerError: string | undefined
  if (deps.record !== false) {
    const r = await recordArbitration(svc, { brokerageId: a.brokerageId, subject: a.subject, decision, now: a.now, policyRef: null, systemSource: a.planner, cycleScope: a.planner })
    recorded = r.recorded
    ledgerError = r.error
  }
  return { choice: decision.optionId, decision, recorded, ...(ledgerError ? { ledgerError } : {}) }
}

// ── speed-to-lead, the LEAD half (owner ruling 16, wave 145) ──────────────────────────────────

/** The channels an UNASSIGNED, unconsented lead may be reached on — THE lead roster (CLAUDE.md §5; lib/ai-isa/lead-channel-policy.ts
 *  LEAD_ALLOWED_CHANNELS), read rather than retyped (§6). */
export type SpeedToLeadLeadChannel = (typeof LEAD_ALLOWED_CHANNELS)[number]
const isLeadRosterChannel = (c: unknown): c is SpeedToLeadLeadChannel => (LEAD_ALLOWED_CHANNELS as readonly unknown[]).includes(c)

export interface SpeedToLeadArbitrationInput {
  brokerageId: string
  policy: FollowupPolicy
  /** What the deterministic eligibility PERMITS for this lead — never wider — with its default FIRST
   *  (lib/ai-isa/speed-to-lead-policy.ts firstTouchDecision: verified email, else verified mail). */
  permitted: readonly SpeedToLeadLeadChannel[]
  facts: {
    leadTemperature: string | null
    leadScore: number | null
    timeline: string | null
    /** Where the lead came from (a portal, an open house, a form) — context, never an identity trait. */
    source: string | null
    minutesSinceArrival: number | null
    hoursSinceLastOutreach: number | null
    preferences: Array<{ key: string; value: string }>
  }
  budget?: ArbiterBudget
}

export interface SpeedToLeadArbitration {
  /** The channel the first touch goes on; null only when nothing is permitted (the sweep then does not touch the lead). */
  channel: SpeedToLeadLeadChannel | null
  decision: ArbiterDecision | null
  skippedReason: string | null
}

/**
 * The first touch for a NEW, ISA-owned lead is the ARBITER's decision (ruling 16) — the sweeper no longer dispatches its own fixed
 * email-then-mail cascade. The deterministic eligibility decides what is PERMITTED (verified email / verified mail; never SMS / call —
 * a lead consented to nothing); the arbiter decides which, from the evidence, under the speed-to-lead priority (no wait is offered;
 * one permitted channel or any outage → the default channel at once). The caller ledgers the decision (recordArbitration) and
 * dispatches the arbiter's channel through the ONE lead door (initiateAIISAEngagement forceChannel). Never throws.
 */
export async function arbitrateSpeedToLead(a: SpeedToLeadArbitrationInput, deps: { decide?: ArbiterDecide } = {}): Promise<SpeedToLeadArbitration> {
  const permitted = [...new Set(a.permitted)].filter(isLeadRosterChannel)
  if (permitted.length === 0) {
    return { channel: null, decision: null, skippedReason: "no permitted first-touch channel — an unconsented lead is reached by verified email or verified mail only" }
  }
  const touch: ArbiterOption = {
    id: "first_touch", kind: "communication", channels: permitted,
    why: ["a new lead must be answered now (speed-to-lead)", `permitted for an unconsented lead: ${permitted.join(" / ")}`],
  }
  const facts: ArbiterFacts = {
    subject: "lead",
    relationship: { type: "lead", persona: a.facts.leadTemperature, hasAssignedAgent: false },
    intent: a.facts.leadScore === null ? null : { score: a.facts.leadScore, trend: a.facts.leadTemperature ?? "unknown" },
    history: { hoursSinceAnyTouch: a.facts.hoursSinceLastOutreach, hoursSinceAgentTouch: null, campaignTouches7d: null, lastChannel: null, portalEducationViews: null },
    journey: { transactionStage: a.facts.timeline, nextMilestone: null, openLessons: null, nextLesson: null },
    preferences: a.facts.preferences.filter((p) => ARBITER_MEMORY_KEYS.includes(p.key)),
    fatigueRisk: null,
    localHour: null,
    moment: {
      ...speedToLeadMoment(),
      intent: `A new lead${a.facts.source ? ` from ${a.facts.source}` : ""}${a.facts.minutesSinceArrival !== null ? ` arrived ${a.facts.minutesSinceArrival} minute(s) ago` : ""} must be answered now — choose the channel for the first touch, not whether.`,
    },
    blindSpots: ["a lead has no recorded channel consent beyond email / mail — the menu is the deterministic lead rule"],
    urgency: "high",
  }
  try {
    const decision = await arbitrateFollowUp({ brokerageId: a.brokerageId, facts, menu: { menu: [touch], locked: null }, planned: touch, policy: a.policy, budget: a.budget, priority: "speed_to_lead" }, deps)
    const channel: SpeedToLeadLeadChannel = isLeadRosterChannel(decision.channel) ? decision.channel : permitted[0]
    return { channel, decision, skippedReason: null }
  } catch (e) {
    // Never block a first touch on the judgment: the deterministic default answers now.
    return { channel: permitted[0], decision: null, skippedReason: `arbiter threw (${e instanceof Error ? e.message : String(e)}) — the default channel answers` }
  }
}

/**
 * How many days the arbiter has already held this subject: its own `followup.decision.wait` rows on the action ledger inside
 * the last policy.arbiter.maxDeferDays days (one row per subject per day). This is what bounds a deferral — the cadence keeps
 * no state of its own. An unreadable ledger returns null: the caller then offers no wait (the deterministic send stands).
 */
export async function countArbiterWaits(
  svc: { from: (t: string) => any },
  a: { brokerageId: string; subject: { type: "lead" | "contact"; id: string }; now: Date; policy: FollowupPolicy },
): Promise<number | null> {
  const since = new Date(a.now.getTime() - a.policy.arbiter.maxDeferDays * 86_400_000).toISOString()
  const { data, error } = await svc.from("agent_action_ledger").select("id")
    .eq("brokerage_id", a.brokerageId).eq("subject_type", a.subject.type).eq("subject_id", a.subject.id)
    .eq("action", "followup.decision.wait").gte("created_at", since)
  if (error) return null
  return (data ?? []).length
}

/** Evidence for a decision that has no ledger row of its own (the cadence): one non-action row, idempotent per subject per day. */
export async function recordArbitration(
  svc: unknown,
  a: {
    brokerageId: string; subject: { type: "lead" | "contact"; id: string }; decision: ArbiterDecision; now: Date; policyRef: string | null; systemSource: string
    /** Wave 149 (C29): a planner's own scope in the idempotency cycle, so two planners deciding about one person the same day are two rows. */
    cycleScope?: string | null
  },
): Promise<{ recorded: boolean; error?: string }> {
  try {
    const { recordNonAction } = await import("@/lib/kernel/action-ledger")
    const wait = a.decision.kind === "wait"
    const r = await recordNonAction({
      brokerageId: a.brokerageId, domain: "followup", decision: wait ? "wait" : "send_touch",
      actor: { type: "manager", managerKey: "ai_isa" }, subject: a.subject,
      reasonCode: wait ? "WAIT_COOLDOWN" : "NURTURE_TOUCH", reasonDetail: a.decision.rationale.slice(0, 500),
      cycle: `arb:${a.cycleScope ? `${a.cycleScope}:` : ""}${a.subject.type}:${a.subject.id}:${a.now.toISOString().slice(0, 10)}`,
      systemSource: a.systemSource, policyKey: "followup_policy",
      until: wait && a.decision.waitHours !== null ? new Date(a.now.getTime() + a.decision.waitHours * 3_600_000).toISOString() : null,
      detail: arbitrationLedgerDetail(a.decision, a.policyRef),
    }, { client: svc as never })
    return { recorded: r.recorded, error: r.error }
  } catch (e) {
    return { recorded: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ── "route to a human" must PRODUCE something a human sees ───────────────────────────────────

/**
 * An `agent_intervention` the arbiter (or a moment with no automated option left) chose is a promise that a person will look. The
 * experience ledger row alone is a record, not a bell — so this writes the agent's task (activities, the same surface the closing-gift
 * and review reminders use), idempotent per contact per UTC day so a re-run or two moments the same day make ONE task. Returns whether
 * a task exists afterwards (false = no agent to give it to, or the write was refused — the caller says so, never pretends).
 */
export async function routeToAgent(
  svc: { from: (t: string) => any },
  a: { brokerageId: string; contactId: string; agentId: string | null; title: string; description: string; now: Date; transactionId?: string | null },
): Promise<boolean> {
  if (!a.agentId || !a.contactId || !a.brokerageId) return false
  const dayStart = `${a.now.toISOString().slice(0, 10)}T00:00:00.000Z`
  const { data: existing, error: readErr } = await svc.from("activities").select("id")
    .eq("brokerage_id", a.brokerageId).eq("contact_id", a.contactId).eq("activity_type", "followup_moment_due").gte("created_at", dayStart).limit(1)
  if (readErr) { console.error(`[followup-arbiter] agent task existence read refused: ${readErr.message}`); return false }
  if ((existing ?? []).length > 0) return true
  const { error } = await svc.from("activities").insert({
    brokerage_id: a.brokerageId, agent_id: a.agentId, contact_id: a.contactId, transaction_id: a.transactionId ?? null,
    activity_type: "followup_moment_due", title: a.title.slice(0, 200), description: a.description.slice(0, 900),
    status: "pending", priority: "medium", entity_type: "contact", scheduled_at: a.now.toISOString(), created_at: a.now.toISOString(),
  })
  if (error) { console.error(`[followup-arbiter] agent task not written: ${error.message}`); return false }
  return true
}

// ── the readiness loader (wave 144) — every input through its survivor reader ──────────────────

const DAY_MS = 86_400_000

/** The contact columns the channel checks read (live names — scripts/schema-snapshot.ts contacts). */
const READINESS_CONTACT_COLUMNS = "id, email, email_opt_out, email_unsubscribed, phone, tcpa_consent, sms_opt_out, phone_opt_out, call_stop_flag, dnc_status, direct_mail_opt_out, mailing_address, mailing_address_verified, opt_out_channels, has_login"

// TOMBSTONE (wave 145, lane 145E, contract C1) — the inline `CHANNEL_PROVIDER_RULES` table that stood here (channel → readiness
// category / provider names) is RETIRED. It was the arbiter's own copy of provider truth, and the owner found it wrong ("the channel
// provider rules are incorrect again"). Survivor: lib/providers/channel-provider-matrix.ts CHANNEL_PROVIDER_MATRIX (lane 145D owns
// it — one matrix for every channel reader), consumed at loadChannelReadiness below. A channel whose matrix row names no category
// and no provider is not provider-gated here (PROVIDER_GATED decides which channels a provider check applies to).

export type ChannelReadinessLoad =
  | { ok: true; checks: ChannelCheck[]; blindSpots: string[] }
  | { ok: false; reason: string }

/**
 * The TENANT-level inputs (provider scan + usage budget) are the same for every person a sweep arbitrates, so they are read once
 * per brokerage per minute in a warm process instead of once per person (a 500-contact stale sweep would otherwise run 500 readiness
 * scans). Only the production readers are memoised — an injected seam is never cached.
 */
const TENANT_READINESS_MEMO_MS = 60_000
const tenantReadinessMemo = new Map<string, { at: number; providers: ChannelReadinessInput["providers"]; budget: number | null | undefined; sendsBlocked: string | null; blindSpots: string[] }>()

/**
 * Load the channel checks for ONE contact. The CONSENT read fails closed (an unreadable / foreign contact → { ok: false }: the
 * caller keeps the tenant-list menu and publishes the blind spot); the frequency / provider / budget reads are EVIDENCE — a refused
 * one becomes a caveat on the check and a blind spot, never a silent "clear", because the dispatcher's own gate decides at the send.
 * `deps` are the seams (the readiness scan and the budget answer are server-side lookups the proof replaces).
 */
async function loadChannelReadiness(
  svc: { from: (t: string) => any },
  a: { brokerageId: string; contactId: string; tenantAllowed: readonly string[] },
  deps: {
    providers?: (svc: unknown, brokerageId: string) => Promise<{ rows: Array<{ provider: string; category: string; ready: boolean }> }>
    budget?: (brokerageId: string) => Promise<{ allowed?: boolean; reason?: string; remainingBudget: number | null }>
    prices?: () => Promise<Partial<Record<ArbiterChannel, number | null>>>
  } = {},
): Promise<ChannelReadinessLoad> {
  if (!a.brokerageId || !a.contactId) return { ok: false, reason: "no brokerage / contact" }
  const { data: contact, error } = await svc.from("contacts").select(READINESS_CONTACT_COLUMNS).eq("id", a.contactId).eq("brokerage_id", a.brokerageId).maybeSingle()
  if (error) return { ok: false, reason: `contact consent read refused: ${error.message}` }
  if (!contact) return { ok: false, reason: "contact not in this brokerage" }
  const blindSpots: string[] = []

  // FREQUENCY — the fatigue calculator's measurement of the de-confliction cap (one vocabulary with the dispatcher's cap).
  let saturated: string[] | null = null
  const ft = await svc.from("buyer_fatigue_scores").select("contributing_factors, last_calculated_at").eq("brokerage_id", a.brokerageId).eq("contact_id", a.contactId).maybeSingle()
  if (ft.error) blindSpots.push(`frequency: buyer_fatigue_scores read refused (${ft.error.message}) — the dispatcher's de-confliction gate decides`)
  else if (!ft.data) blindSpots.push("frequency: no fatigue score row yet for this contact — the dispatcher's de-confliction gate decides")
  else {
    const raw = (ft.data as { contributing_factors?: { saturated_channels?: unknown } | null }).contributing_factors?.saturated_channels
    saturated = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : []
  }

  // PROVIDER — the ONE readiness scan; BUDGET — the ONE "may this tenant afford it" answer (tenant-level: memoised, see above).
  const memoable = !deps.providers && !deps.budget
  const memo = memoable ? tenantReadinessMemo.get(a.brokerageId) : undefined
  let providers: ChannelReadinessInput["providers"] = null
  let budgetRemainingUsd: number | null | undefined = undefined
  let sendsBlocked: string | null = null
  if (memo && Date.now() - memo.at < TENANT_READINESS_MEMO_MS) {
    providers = memo.providers
    budgetRemainingUsd = memo.budget
    sendsBlocked = memo.sendsBlocked
    blindSpots.push(...memo.blindSpots)
  } else {
    const tenantSpots: string[] = []
    try {
      const scan = deps.providers ?? (async (s: unknown, b: string) => (await import("@/lib/platform/provider-posture")).getBrokerageProviderReadiness(s, b))
      const r = await scan(svc, a.brokerageId)
      providers = {}
      // Contract C1: lane 145D's matrix is the ONE channel → provider truth (keyed by the nine arbiter channel names).
      for (const [ch, rule] of Object.entries(CHANNEL_PROVIDER_MATRIX) as Array<[ArbiterChannel, ChannelProviderRule]>) {
        if (!(rule.categories?.length || rule.providers?.length)) continue
        const rows = r.rows.filter((row) => (rule.categories ?? []).includes(row.category) || (rule.providers ?? []).includes(row.provider))
        providers[ch] = rows.some((row) => row.ready) ? "ready" : "not_ready"
      }
    } catch (e) {
      tenantSpots.push(`provider: the readiness scan could not run (${e instanceof Error ? e.message : String(e)}) — the dispatcher's provider gate decides`)
    }
    try {
      const ask = deps.budget ?? (async (b: string) => (await import("@/lib/billing/billing-access")).mayUseAndAfford({ brokerageId: b, capability: "comms.send", estCostUsd: 0, client: svc }))
      const v = await ask(a.brokerageId)
      budgetRemainingUsd = v.remainingBudget
      // A refusal that is not the budget's own (that one is judged per channel against the remaining usage) blocks every paid send.
      if (v.allowed === false && v.reason !== "vendor_budget_exhausted") sendsBlocked = v.reason ?? "refused"
    } catch (e) {
      tenantSpots.push(`budget: mayUseAndAfford could not answer (${e instanceof Error ? e.message : String(e)}) — the dispatcher's pre-flight decides`)
    }
    blindSpots.push(...tenantSpots)
    if (memoable) tenantReadinessMemo.set(a.brokerageId, { at: Date.now(), providers, budget: budgetRemainingUsd, sendsBlocked, blindSpots: tenantSpots })
  }

  // COST — the ONE price table.
  let unitCostUsd: ChannelReadinessInput["unitCostUsd"] = {}
  try {
    unitCostUsd = await (deps.prices ?? (async () => {
      const { VENDOR_PRICING, DIRECT_MAIL_PIECE_COST_USD } = await import("@/lib/vendor-governance/cost-normalizer")
      const price = (k: string): number | null => { const v = VENDOR_PRICING[k]; return !v || (v as { priceState?: string }).priceState === "unknown" ? null : v.costPerUnit }
      return { email: price("sendgrid"), sms: price("twilio_sms"), phone: price("twilio_voice"), voice_drop: price("voicedrop"), direct_mail: DIRECT_MAIL_PIECE_COST_USD.postcard }
    }))()
  } catch (e) {
    blindSpots.push(`cost: the price table could not load (${e instanceof Error ? e.message : String(e)})`)
  }
  blindSpots.push("ads: no online-audience identifier is read here (lane 144E's append) — ads stays an audience action, never a 1:1 rail")

  const checks = evaluateChannelReadiness({
    consent: contact as ChannelConsent, tenantAllowed: a.tenantAllowed,
    saturated, providers, unitCostUsd, budgetRemainingUsd, sendsBlocked, audienceMatch: false,
  })
  return { ok: true, checks, blindSpots }
}

/**
 * The recent life-change / intent signals on a contact (signal_reactivations — the store recordReactivationSignal writes and the
 * long-term-nurture / returning-customer loops consume). Read by triggered_at inside the tenant's life-event window
 * (followup_policy.sphere.lifeEventWindowDays) whether or not a loop already consumed it: here it is EVIDENCE, not a queue.
 */
async function loadLifeChangeSignals(
  svc: { from: (t: string) => any },
  a: { brokerageId: string; contactId: string; now: Date; policy: FollowupPolicy; movementConsumer?: MovementSignalConsumer | null },
): Promise<{ signals: LifeChangeSignal[]; blindSpot: string | null; helpers: ArbiterMovementHelper[]; opportunity: ArbiterOpportunityInput | null }> {
  const since = new Date(a.now.getTime() - a.policy.sphere.lifeEventWindowDays * DAY_MS).toISOString()
  const { data, error } = await svc.from("signal_reactivations").select("signal_type, signal_strength, triggered_at, signal_data")
    .eq("brokerage_id", a.brokerageId).eq("contact_id", a.contactId).gte("triggered_at", since).order("triggered_at", { ascending: false }).limit(20)
  const blind: string[] = []
  const seen = new Set<string>()
  const signals: LifeChangeSignal[] = []
  if (error) blind.push(`signals: signal_reactivations read refused (${error.message})`)
  for (const r of (error ? [] : (data ?? [])) as Array<{ signal_type: string | null; signal_strength: number | null; triggered_at: string | null; signal_data?: Record<string, unknown> | null }>) {
    const type = String(r.signal_type ?? "")
    if (!type || seen.has(type)) continue
    seen.add(type)
    const at = r.triggered_at ? Date.parse(r.triggered_at) : NaN
    // WAVE 148 (148F): a signal's evidence quality. Only the C9 movement path (the bus line from lib/intent/movement-signals.ts —
    // offer_help is allowed there only on verified / reported evidence with a confirmed identity) is grounded + confirmed; every
    // other writer's row is unknown evidence (fail closed: not enough for automated help on a life event).
    const source = String(r.signal_data?.source ?? "")
    const c9 = source === "enrichment:movement_signals" || source.startsWith("movement:")
    const kind = lifeChangeKindOf(type)
    signals.push({ type, kind, strength: typeof r.signal_strength === "number" ? r.signal_strength : null, daysAgo: Number.isFinite(at) ? Math.max(0, Math.floor((a.now.getTime() - at) / DAY_MS)) : 0,
      ...(kind === "life_event" ? { evidence: { grounded: c9, identityConfirmed: c9, lifeEvent: canonicalLifeEventType(type), source: source || "signal_reactivations" } } : {}) })
  }
  // Lane 144E's provider-backed signals (`## Signals available`): STORED facts on the contact row, read through ITS pure reader
  // (lib/enrichment/intent-signal-sources.ts intentSignalsFromContact — no call, no spend). Tenant-pinned read by the PK.
  const { data: person, error: personErr } = await svc.from("contacts").select(STORED_SIGNAL_CONTACT_COLUMNS).eq("id", a.contactId).eq("brokerage_id", a.brokerageId).maybeSingle()
  if (personErr) blind.push(`signals: stored provider facts not read (${personErr.message})`)
  else if (person) {
    try {
      const { intentSignalsFromContact } = await import("@/lib/enrichment/intent-signal-sources")
      const stored = storedFactSignals(intentSignalsFromContact(person, a.now), since, a.now)
      for (const s of stored.signals) if (!seen.has(s.type)) { seen.add(s.type); signals.push(s) }
      if (stored.notAChange.length > 0) blind.push(`signals: ${stored.notAChange.length} stored provider fact(s) not read as a life CHANGE (${stored.notAChange.join(", ")})`)
    } catch (e) {
      // Evidence, not a gate: an unreadable source is a published blind spot, never a failed evaluation.
      blind.push(`signals: stored provider facts not read (${(e as Error)?.message ?? String(e)})`)
    }
  }
  // Wave 147 — lane 147B's C9 movement signals (verified / reported only reach here), through the named seam below.
  const moved = await readMovementSignals(svc, { brokerageId: a.brokerageId, contactId: a.contactId, now: a.now, sinceIso: since }, a.movementConsumer)
  for (const s of moved.signals) if (!seen.has(s.type)) { seen.add(s.type); signals.push(s) }
  if (moved.blindSpot) blind.push(moved.blindSpot)
  return { signals, blindSpot: blind.length ? blind.join("; ") : null, helpers: moved.helpers, opportunity: moved.opportunity }
}

/**
 * SEAM — MOVEMENT_SIGNAL_CONSUMER (wave 147: lane 147G left it, lane 147B's hook fills it; WIRED by lane 147Z, convergence; owner
 * ruling 3 — "life changes … it is also a real estate event … signalled to the manager/arbiter"). Lane B's contract C9 records
 * reach the arbiter as LifeChangeSignals here and nowhere else, through lib/intent/movement-signals.ts movementSignalsForArbiter
 * (the ONE hook — lane G's notes named it `arbiterMovementSignals`, lane B shipped `movementSignalsForArbiter`; one name, B's, so
 * no twin was written). The hook returns ONLY a dominant relevance that at least one verified or reported record carries (an
 * `inferred`-only combination is never read as a life change — C9's own rule, enforced in the hook), already licence / consent /
 * outreach-checked at the record, plus the neighbourly helpers that evidence supports (described to the model as OPTIONS with
 * the evidence they need, never a timetable). Lazily imported so the page graph stays light (test:proxy-graph-budget). A thrown
 * or refused read is a blind spot — an unread source is never "no signal".
 */
interface ArbiterMovementHelper { key: string; title: string; offer: string; experience: string }
/** Wave 149 (149Z — lane 149H Outside-lane 1): the per-decision opportunity reading + its closed engagement menu, as the hook
 *  returns it (lib/intent/movement-signals.ts ArbiterOpportunityContext). Structural here so this module imports nothing eager. */
interface ArbiterOpportunityInput {
  reading: { primary?: { kind?: string | null; stage?: string | null } | null; sensitive?: boolean; screenEvents?: readonly string[] }
  menu: { options: ReadonlyArray<{ mode: string; status: string; why: string; experience: string; brief: string | null; tone?: string | null; requiresApproval?: boolean; research?: ReadonlyArray<unknown> }>; floor: string }
}
type MovementSignalConsumer = (svc: { from: (t: string) => any }, a: { brokerageId: string; contactId: string; now: Date; sinceIso: string; autonomy?: "autonomous" | "supervised" | "unknown"; paidResearchAffordable?: boolean | null }) =>
  Promise<LifeChangeSignal[] | { signals: LifeChangeSignal[]; blindSpot?: string | null; helpers?: ReadonlyArray<ArbiterMovementHelper> | null; opportunity?: ArbiterOpportunityInput | null }>
// autonomy / paidResearchAffordable are NOT read here (unread = "unknown" / null, which the menu treats as fail-closed: outreach
// needs approval, paid research waits) — reading them costs a tenant read + an entitlement read on EVERY arbitration (149Z notes).
const MOVEMENT_SIGNAL_CONSUMER: MovementSignalConsumer | null = async (svc, a) => (await import("@/lib/intent/movement-signals")).movementSignalsForArbiter(svc as never, a)

/** Read the movement signals through the seam (or an injected consumer — the proofs). Evidence, never a gate. */
async function readMovementSignals(
  svc: { from: (t: string) => any },
  a: { brokerageId: string; contactId: string; now: Date; sinceIso: string },
  injected?: MovementSignalConsumer | null,
): Promise<{ signals: LifeChangeSignal[]; blindSpot: string | null; helpers: ArbiterMovementHelper[]; opportunity: ArbiterOpportunityInput | null }> {
  const consumer = injected === undefined ? MOVEMENT_SIGNAL_CONSUMER : injected
  if (!consumer) return { signals: [], blindSpot: "signals: movement signals (contract C9, lane 147B) are not wired into the arbiter", helpers: [], opportunity: null }
  try {
    const got = await consumer(svc, a)
    const list = Array.isArray(got) ? got : (got?.signals ?? [])
    const helpers = Array.isArray(got) ? [] : (got?.helpers ?? []).map((h) => ({ key: String(h.key), title: String(h.title), offer: String(h.offer), experience: String(h.experience) }))
    const opportunity = Array.isArray(got) ? null : (got?.opportunity && Array.isArray(got.opportunity.menu?.options) ? got.opportunity : null)
    return { signals: list.filter((s) => !!s && typeof s.type === "string" && s.type.length > 0), blindSpot: Array.isArray(got) ? null : (got?.blindSpot ?? null), helpers, opportunity }
  } catch (e) {
    return { signals: [], blindSpot: `signals: movement signals not read (${(e as Error)?.message ?? String(e)})`, helpers: [], opportunity: null }
  }
}

// The facts shaping (only the eligible modes) is lib/intent/opportunity-discovery.ts opportunityFactsFrom — the reading's own
// module, lazily imported with the brief in arbitrateExperiencePlan (149Z).

const STORED_SIGNAL_CONTACT_COLUMNS = "id, enrichment_profile, life_events, last_life_event_detected, home_anniversary"

/** Lane 144E's IntentKind → this module's kind; null = not a 1:1 follow-up signal (an ad-audience match is an audience fact
 *  for the governed ads action, ruling 10; a relationship moment is the moments conductor's). */
const INTENT_TO_LIFE_CHANGE: Readonly<Record<string, LifeChangeKind | null>> = Object.freeze({
  moving: "moving", home_sale: "home_sale", home_purchase: "buying", refinance: "refinance", life_event: "life_event",
  property_engagement: "engagement", market_engagement: null, relationship_moment: null,
})

/**
 * PURE. Which of a contact's STORED provider facts count as a recent life CHANGE for the planner, by lane 144E's own sensitivity
 * flag — never by a threshold this module invents:
 *  · `age` (birthday month / birth date) — NEVER: cards and the education format only, never a targeting or follow-up input.
 *  · `life_event` (relocation, job change, a public life event) — a SERVICE TOPIC: it routes only to a person's conversation
 *    (kind life_event → agent_intervention), never to content about the event, never a segment.
 *  · `behaviour` — online real-estate / investing / home-improvement activity: its first intent.
 *  · `property_fact` / `engagement` — a STORED FACT, not a change: reading a refinance date or a residence length as intent needs a
 *    threshold, which the equity / refinance triggers own (they arrive here as signal_reactivations / reactor signals instead).
 * A fact counts only when the record dates it inside the tenant's life-event window: a date value by ITS date (a year alone is
 * too coarse to be "recent"), a flag by when the provider observed it; a COUNT (e.g. how many places someone has lived) is a
 * tally of history, never a dated change; an undated fact is never "recent".
 */
function storedFactSignals(
  observed: ReadonlyArray<{ key: string; intents: readonly string[]; provider: string; field: string; value: string | number | boolean; observedAt: string | null; monthsSince: number | null; sensitivity: string }>,
  sinceIso: string,
  now: Date,
): { signals: LifeChangeSignal[]; notAChange: string[] } {
  const signals: LifeChangeSignal[] = []
  const notAChange: string[] = []
  const since = Date.parse(sinceIso)
  for (const o of observed) {
    const type = `${o.provider}.${o.key}`
    if (o.sensitivity === "age") continue // never surfaced, not even as a count
    if (o.sensitivity !== "behaviour" && o.sensitivity !== "life_event") { notAChange.push(type); continue }
    const v = o.value
    const at = typeof v === "number" ? NaN // a count: history, not a change
      : typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? Date.parse(v.slice(0, 10))
      : typeof v === "string" && /^\d{4}-\d{2}/.test(v) ? Date.parse(`${v.slice(0, 7)}-01`)
      : typeof v === "string" && /^\d{4}$/.test(v) ? NaN // a year alone is too coarse to be "recent"
      : o.observedAt ? Date.parse(o.observedAt) : NaN
    if (!Number.isFinite(at) || at < since) { notAChange.push(`${type} (not dated inside the window)`); continue }
    const kind: LifeChangeKind | null = o.sensitivity === "life_event" ? "life_event" : (INTENT_TO_LIFE_CHANGE[o.intents[0] ?? ""] ?? null)
    if (!kind) { notAChange.push(type); continue }
    // WAVE 148 (148F): a public web mention (osint) is a NAME-ONLY match — never confirmed; a licensed provider's field rides the
    // enrichment's identity match (reported, confirmed). The canonical event is read from the stored value through the vocabulary.
    const lifeEvent = kind === "life_event" ? (String(v).split(",").map((x) => canonicalLifeEventType(x)).find((x): x is LifeEventType => !!x) ?? (o.key === "job_change" ? "job_change" : null)) : null
    signals.push({ type, kind, strength: null, daysAgo: Math.max(0, Math.floor((now.getTime() - at) / DAY_MS)),
      ...(kind === "life_event" ? { evidence: { grounded: true, identityConfirmed: o.provider !== "osint", lifeEvent, source: `${o.provider}.${o.key}` } } : {}) })
  }
  return { signals, notAChange }
}

// ── THE LIFE-CHANGE RESPONDER (ruling 11) — ONE entry every signal source calls ─────────────────

export interface LifeChangeSignalInput {
  /** The VERIFIED tenant of the source that detected the signal (a cron's scanned brokerage, an event's brokerage). */
  brokerageId: string
  subject: { type: "raw_lead" | "lead" | "contact"; id: string }
  /** signal_reactivations.signal_type — see LIFE_CHANGE_SIGNAL_KINDS. */
  signalType: string
  strength?: number | null
  /** Which process / provider detected it (provenance rides signal_data.source and the ledger). */
  source: string
  detail?: Record<string, unknown> | null
  now?: Date
}

export type LifeChangeAction =
  /** A raw lead: consented to nothing — recorded, no outreach; the promotion gate decides. */
  | "recorded_no_outreach"
  /** A lead: the signal joins signal_reactivations; the ISA's lead loops (long-term nurture wake at the score bar, arbitrated cadence) act on it. */
  | "lead_signal_recorded"
  /** A lifetime client: the signal joins signal_reactivations; the Sphere's returning-customer loop proposes a gated, memory-aware touch. */
  | "sphere_signal_recorded"
  /** A contact: the signal is recorded AND the ISA's governed engagement runs now (NBA hard stops → planner + this signal → arbiter → consent-gated dispatch). */
  | "isa_engagement"
  /** Refused (foreign / unknown subject, unreadable read, replayed) — said, never pretended. */
  | "refused"
  | "replayed"

export interface LifeChangeResponse {
  action: LifeChangeAction
  subjectClass: "raw_lead" | "lead" | "contact" | "lifetime" | null
  kind: LifeChangeKind
  reason: string
  signalId?: string | null
  engagement?: { success: boolean; channel?: string; reason?: string } | null
}

/** The ledger WHY of a signal kind (the m693 vocabulary — no new code, no CHECK owed). */
function lifeChangeReasonCode(kind: LifeChangeKind): "SELLER_FOLLOWUP_INTENT_INCREASE" | "PROPERTY_VALUE_CHANGE" | "BUYER_PROPERTY_MATCH" | "NURTURE_TOUCH" {
  if (kind === "home_sale" || kind === "moving") return "SELLER_FOLLOWUP_INTENT_INCREASE"
  if (kind === "equity" || kind === "refinance") return "PROPERTY_VALUE_CHANGE"
  if (kind === "buying") return "BUYER_PROPERTY_MATCH"
  return "NURTURE_TOUCH"
}

/**
 * A life change / intent signal → a GOVERNED evaluation and next-best action through the existing manager fabric. One ledger row per
 * (subject, signal type, UTC day) — a retried event replays, never acts twice. NEVER THROWS.
 *   raw lead → recorded, no outreach (the identity / dedup gate decides promotion first);
 *   lead     → signal_reactivations (lead_id) — long-term nurture wakes it at the tenant's score bar; leads are reached by email / mail only;
 *   lifetime → signal_reactivations (contact_id) — the Sphere's returning-customer loop proposes a gated, memory-aware re-engagement;
 *   contact  → signal_reactivations (contact_id) + engageContact NOW (reason brokerage_rule): every NBA hard stop, the planner WITH this
 *              signal as its SIGNAL slice, the arbiter over the permitted channels (voice call / voice drop included where consented),
 *              the consent-gated dispatch.
 * A converted lead is answered as its contact (conversion is final).
 * @proofSeam the first production caller is lib/kernel/event-reactor.ts (EQUITY_MILESTONE / REFINANCE_OPPORTUNITY); lane 144E's signal sources join through this one door.
 */
export async function respondToLifeChangeSignal(
  svc: { from: (t: string) => any },
  input: LifeChangeSignalInput,
  deps: {
    recordSignal?: (p: { leadId?: string; contactId?: string; brokerageId: string; signalType: string; signalStrength?: number; signalData?: Record<string, unknown> }) => Promise<{ id: string | null }>
    engage?: (p: { contactId: string; brokerageId: string; reason: "brokerage_rule" }) => Promise<{ success: boolean; channel?: string; reason?: string }>
    ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
  } = {},
): Promise<LifeChangeResponse> {
  const kind = lifeChangeKindOf(input.signalType)
  const now = input.now ?? new Date()
  const refused = (reason: string, subjectClass: LifeChangeResponse["subjectClass"] = null): LifeChangeResponse => ({ action: "refused", subjectClass, kind, reason })
  try {
    if (!input.brokerageId || !input.subject?.id || !input.signalType) return refused("missing brokerage, subject or signal type")
    const recordSignal = deps.recordSignal ?? (async (p) => (await import("@/lib/ai-isa/long-term-nurture")).recordReactivationSignal(p))
    const engage = deps.engage ?? (async (p) => (await import("@/app/actions/ai-isa/engage-contact")).engageContact(p))
    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
    const signalData = { source: input.source, kind, ...(input.detail ?? {}) }

    // ── resolve WHO this is, tenant-pinned (a service client: the brokerage on the query is the only pin) ──
    let subject = input.subject
    let subjectClass: NonNullable<LifeChangeResponse["subjectClass"]>
    if (subject.type === "raw_lead") {
      const { data, error } = await svc.from("raw_scraped_leads").select("id").eq("id", subject.id).eq("brokerage_id", input.brokerageId).maybeSingle()
      if (error) return refused(`raw lead read refused: ${error.message}`)
      if (!data) return refused("raw lead not in this brokerage")
      subjectClass = "raw_lead"
    } else if (subject.type === "lead") {
      const { data, error } = await svc.from("leads").select("id, contact_id, is_active").eq("id", subject.id).eq("brokerage_id", input.brokerageId).maybeSingle()
      if (error) return refused(`lead read refused: ${error.message}`)
      if (!data) return refused("lead not in this brokerage")
      // Contract C2 (owner ruling 15): a lead with a contact_id is OUT of the lead domain — the signal is answered on the contact.
      const party = canonicalPartyFor(data as { id?: string | null; contact_id?: string | null })
      if (party.type === "unresolved") return refused(party.reason)
      if (party.type === "contact") subject = { type: "contact", id: party.id }
      subjectClass = "lead"
    } else subjectClass = "contact"
    let contactType: string | null = null
    if (subject.type === "contact") {
      const { data, error } = await svc.from("contacts").select("id, contact_type").eq("id", subject.id).eq("brokerage_id", input.brokerageId).maybeSingle()
      if (error) return refused(`contact read refused: ${error.message}`)
      if (!data) return refused("contact not in this brokerage")
      contactType = (data as { contact_type?: string | null }).contact_type ?? null
      const { isLifetimeRelationshipType } = await import("@/lib/contact-types")
      subjectClass = isLifetimeRelationshipType(contactType) ? "lifetime" : "contact"
    }

    const day = now.toISOString().slice(0, 10)
    let out: LifeChangeResponse = { action: "replayed", subjectClass, kind, reason: "this signal was already answered today for this person — not acted on twice" }
    // The ledger answers with the run's result, or the replay hook's on a non-acting claim — that answer IS the response.
    const answered = await ledger<LifeChangeResponse>(
      {
        // WAVE 146 (lane 146B): was "life_change.respond" — two segments, which lib/kernel/action-ledger.ts ACTION_NAME_PATTERN
        // (domain.entity.action) REFUSES: the claim came back "unledgered", nothing was recorded, and the promised once-per-day
        // replay never happened (a retried signal engaged the contact again). The proof injected its own ledger and could not see it.
        brokerageId: input.brokerageId, action: "life_change.signal.respond", actor: { type: "manager", managerKey: subjectClass === "lifetime" ? "sphere_of_influence" : "ai_isa" },
        subject: { type: subject.type, id: subject.id }, reasonCode: lifeChangeReasonCode(kind),
        reasonDetail: `${input.signalType} (${kind}) detected by ${input.source}`.slice(0, 500), cycle: `life_change:${input.signalType}:${day}`,
        systemSource: "life_change_signal", policyKey: "followup_policy",
        detail: { signal_type: input.signalType, kind, source: input.source, subject_class: subjectClass, strength: input.strength ?? null },
      },
      async () => {
        if (subjectClass === "raw_lead") {
          return (out = { action: "recorded_no_outreach", subjectClass, kind, reason: "a raw lead has consented to nothing — no outreach; the identity / dedup gate decides promotion, and the signal is evidence for it" })
        }
        const rec = await recordSignal({
          ...(subject.type === "lead" ? { leadId: subject.id } : { contactId: subject.id }), brokerageId: input.brokerageId,
          signalType: input.signalType, ...(typeof input.strength === "number" ? { signalStrength: input.strength } : {}), signalData,
        })
        if (subject.type === "lead") {
          return (out = { action: "lead_signal_recorded", subjectClass, kind, signalId: rec.id, reason: rec.id ? "recorded for the ISA's lead loops (long-term nurture wakes the lead at the tenant's score bar; leads are reached by email / mail only)" : "the signal row was refused — nothing recorded" })
        }
        if (subjectClass === "lifetime") {
          return (out = { action: "sphere_signal_recorded", subjectClass, kind, signalId: rec.id, reason: rec.id ? "recorded for the Sphere's returning-customer loop — a gated, memory-aware re-engagement the agent approves" : "the signal row was refused — nothing recorded" })
        }
        const r = await engage({ contactId: subject.id, brokerageId: input.brokerageId, reason: "brokerage_rule" })
        return (out = { action: "isa_engagement", subjectClass, kind, signalId: rec.id, engagement: { success: r.success, channel: r.channel, reason: r.reason }, reason: r.success ? `the ISA engaged on ${r.channel ?? "its chosen channel"}` : `the ISA's governed path held the touch (${r.reason ?? "no reason given"})` })
      },
      {
        settle: (r) => ({ status: r.action === "refused" ? "failed" : r.action === "isa_engagement" && r.engagement?.success ? "executed" : "skipped", outcome: r.action, error: r.action === "refused" ? r.reason : null }),
        // WAVE 147 (lane 147Z — lane 147F Outside-lane 1): a REFUSED claim (the ledger could not record) is a refusal, never
        // "already answered today" — it did not act, and it says why (test:action-evidence-census, the five actions).
        replay: (claim) => claim.kind === "refused" ? refused(`the action ledger refused: ${claim.error}`, subjectClass) : out,
      },
      { client: svc as never },
    )
    if (answered) out = answered
    // C14 (wave 147, lane 147Z — lane 147G "Still open 2"): ONE completion per life-change decision, opened and evidenced in one
    // call. A person's answer (the ISA's governed path chose the agent) waits on that agent's task; every other answer — a
    // touch sent, a hold, a signal handed to the nurture / Sphere loop — closes on the decision (the loop's next touch is its
    // own decision). A replay or a refusal decided nothing new and opens nothing.
    if (out.action !== "refused" && out.action !== "replayed") {
      const toPerson = out.action === "isa_engagement" && !out.engagement?.success && /^experience:agent_intervention:/.test(String(out.engagement?.reason ?? ""))
      try {
        const { trackManagerDecision } = await import("@/lib/kernel/completion-tracking")
        const t = await trackManagerDecision(svc, {
          brokerageId: input.brokerageId, ownerManager: subjectClass === "lifetime" ? "sphere_of_influence" : "ai_isa",
          subject: { type: subject.type, id: subject.id }, sourceRef: `life_change:${subject.type}:${subject.id}:${input.signalType}:${day}`,
          what: `Answer a ${kind.replace(/_/g, " ")} signal (${input.signalType})`.slice(0, 200),
          decision: { outcome: `${out.action}: ${out.reason}`, source: "agent_action_ledger:life_change.signal.respond", ledgerRef: `life_change:${input.signalType}:${day}` },
          next: toPerson ? { kind: "human", contactId: subject.id } : { kind: "none" },
          context: { signal_type: input.signalType, kind, subject_class: subjectClass, signal_id: out.signalId ?? null },
        })
        if (!t.ok) console.warn(`[followup-arbiter] life-change completion not tracked for ${subject.type} ${subject.id}: ${t.reason}`)
      } catch (e) {
        console.warn(`[followup-arbiter] life-change completion tracking threw: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return out
  } catch (e) {
    return refused(`threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/**
 * Wave 148 (148F, ruling 17): the tenant's EXPLICIT grant for help the AI ISA sends ITSELF at a life event — the same standard the
 * inbound responder applies to an unattended reply (lib/communications/inbound-responder.ts): posture `autonomous` (never merely
 * "no signal"), the authority ladder, no platform / tenant halt. Fails CLOSED (an unreadable grant is no grant).
 */
async function defaultLifeEventAuthority(svc: { from: (t: string) => any }, brokerageId: string): Promise<LifeEventAuthority> {
  try {
    const g = await import("@/lib/managers/autonomy-gate")
    const posture = await g.resolveManagerAutonomy(brokerageId, "ai_isa", svc as never)
    const authority = await g.resolveAgentAuthorityLevel(brokerageId, "ai_isa", svc as never)
    const d = g.autonomyDecision({ managerKey: "ai_isa", effective: posture, authorityLevel: authority })
    if (!d.allow) return { allowed: false, reason: d.reason ?? "the autonomy gate holds the AI ISA" }
    if (posture !== "autonomous") return { allowed: false, reason: "the tenant has not explicitly granted the AI ISA autonomy (managed_agents ai_isa autonomy_tier) — automated help at a life event waits for that grant" }
    return { allowed: true, reason: null }
  } catch (e) {
    return { allowed: false, reason: `autonomy could not be read (${e instanceof Error ? e.message : String(e)}) — no automated help` }
  }
}

// ── the one call the experience paths make ───────────────────────────────────────────────────

/**
 * planner verdict → (arbiter) → ledger + event + hand-off. ONE function so every caller of recordAndExecuteExperience that
 * has an autonomous choice to make (the ISA engage path, the sequence enroller, the post-close moment conductor) arbitrates
 * the same way and writes the same evidence. A HUMAN-initiated run is the human's call: the planner's verdict is recorded
 * as before and the arbiter is not consulted. `deps` are the test seams (the model call, the ledger / delegate / emit of
 * recordAndExecuteExperience).
 */
export async function arbitrateAndRecordExperience(
  svc: any,
  a: {
    brokerageId: string; contactId: string; input: NextBestExperienceInput; plan: NextBestExperiencePlan; now: Date
    humanInitiated?: boolean; missionId?: string | null; systemSource?: string; moment?: ArbiterFacts["moment"]; budget?: ArbiterBudget; policy?: FollowupPolicy
    /** Wave 144: the channels THIS caller can deliver for a communication (default email + SMS — what every current caller sends). */
    deliverable?: readonly ArbiterChannel[] | null
    /** Wave 145: a high-priority requirement the arbiter DECIDES under (speed-to-lead — owner ruling 16: answer now; how is the arbiter's call). */
    priority?: ArbiterPriority | null
    /** Wave 144: preloaded channel checks (else loaded here through loadChannelReadiness). */
    channelReadiness?: ChannelReadinessLoad | null
  },
  deps: {
    decide?: ArbiterDecide; record?: Record<string, unknown>; readiness?: Parameters<typeof loadChannelReadiness>[2]
    /** Wave 147 (147Z): the C9 movement consumer (a proof injects one; null = unwired, undefined = the wired hook). */
    movement?: MovementSignalConsumer | null
    /** Wave 148 (148F): the tenant's explicit autonomy grant for life-event help (a proof injects one; default: lib/managers/autonomy-gate.ts). */
    lifeEventAuthority?: (brokerageId: string) => Promise<LifeEventAuthority>
  } = {},
): Promise<{ plan: NextBestExperiencePlan; decision: ArbiterDecision | null; recorded: Awaited<ReturnType<typeof import("./lead-action-plan").recordAndExecuteExperience>> }> {
  const { loadFollowupPolicy } = await import("./followup-policy")
  const { recordAndExecuteExperience, EXPERIENCE_EXECUTORS, EXPERIENCE_KINDS } = await import("./lead-action-plan")
  const policy = a.policy ?? (await loadFollowupPolicy(svc, a.brokerageId)).policy
  let plan = a.plan
  let decision: ArbiterDecision | null = null
  let checks: ChannelCheck[] | null = null
  let signals: LifeChangeSignal[] = []
  const channelBlindSpots: string[] = []
  if (!a.humanInitiated) {
    // A deferral must be BOUNDED even when nothing but the ledger remembers it (the engage path has no moment row): count this
    // person's prior arbiter waits; an unreadable ledger offers no wait at all (the planner's verdict stands).
    let daysDeferred: number | null = null
    if (!a.moment) {
      const waited = await countArbiterWaits(svc, { brokerageId: a.brokerageId, subject: { type: "contact", id: a.contactId }, now: a.now, policy })
      daysDeferred = waited ?? policy.arbiter.maxDeferDays
    }
    // WAVE 144 — the per-channel checks (consent / tenant / frequency / cost / provider). An unreadable person row keeps the
    // tenant-list menu and SAYS so (the dispatcher's gates still decide every send).
    const load = a.channelReadiness ?? await loadChannelReadiness(svc, { brokerageId: a.brokerageId, contactId: a.contactId, tenantAllowed: a.input.policy.allowedChannels }, deps.readiness)
    if (load.ok) { checks = load.checks; channelBlindSpots.push(...load.blindSpots) }
    else channelBlindSpots.push(`channel readiness not loaded (${load.reason}) — the menu used the tenant's channel settings alone`)
    // WAVE 144 — the SIGNAL slice: a recent life change / intent signal adds the experiences that serve it (never unlocks a hard verdict).
    const sig = await loadLifeChangeSignals(svc, { brokerageId: a.brokerageId, contactId: a.contactId, now: a.now, policy, movementConsumer: deps.movement })
    if (sig.blindSpot) channelBlindSpots.push(sig.blindSpot)
    signals = sig.signals
    const withSignals = planWithLifeChangeSignals(a.plan, signals, { contactType: a.input.person.contactType }, { executors: EXPERIENCE_EXECUTORS, kinds: EXPERIENCE_KINDS })
    // WAVE 148 (148F, ruling 17): the tenant's EXPLICIT autonomy grant is read only when a life event is decisive (the empathetic
    // branch offers automated help only under it). Unreadable = not granted, and the reason rides the brief.
    let lifeEventAuthority: LifeEventAuthority | null = null
    if (!a.priority && decisiveLifeChangeSignal(signals)?.kind === "life_event") {
      try { lifeEventAuthority = await (deps.lifeEventAuthority ?? ((b: string) => defaultLifeEventAuthority(svc, b)))(a.brokerageId) }
      catch (e) { lifeEventAuthority = { allowed: false, reason: `autonomy could not be read (${e instanceof Error ? e.message : String(e)}) — no automated help` } }
    }
    const arbitrated = await arbitrateExperiencePlan({ brokerageId: a.brokerageId, input: a.input, plan: withSignals, policy, budget: a.budget, moment: a.moment, daysDeferred, checks, deliverable: a.deliverable ?? null, signals, helpers: sig.helpers, priority: a.priority ?? null, lifeEventAuthority, opportunity: sig.opportunity }, { decide: deps.decide })
    plan = arbitrated.plan
    decision = arbitrated.decision
  }
  let policyRef: string | null = null
  if (decision) {
    try { policyRef = await (await import("@/lib/kernel/tenant-policy")).resolvePolicyRef(svc, a.brokerageId, "followup_policy") } catch { policyRef = null }
  }
  const recorded = await recordAndExecuteExperience(
    svc,
    { brokerageId: a.brokerageId, contactId: a.contactId, plan, now: a.now, missionId: a.missionId ?? null, systemSource: a.systemSource, arbitration: decision ? arbitrationLedgerDetail(decision, policyRef, { checks, signals, blindSpots: channelBlindSpots }) : null },
    (deps.record ?? {}) as never,
  )
  // The model's own WAIT is the one decision countArbiterWaits must be able to find tomorrow — it is what bounds the deferral.
  if (decision && decision.source === "ai" && decision.kind === "wait") {
    const w = await recordArbitration(svc, { brokerageId: a.brokerageId, subject: { type: "contact", id: a.contactId }, decision, now: a.now, policyRef, systemSource: a.systemSource ?? "next_best_experience" })
    if (!w.recorded && w.error) console.warn(`[followup-arbiter] wait not ledgered for contact ${a.contactId}: ${w.error}`)
  }
  return { plan, decision, recorded }
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
// WAVE 146 (lane 146B) — THE ARBITER'S INBOUND SIDE
//
// OWNER RULINGS (2026-10-29): 2 — "Arbiter needs to consider and send social responses back and also should do 1:1 ad follow
// up with audiences"; 3 — every inbound lands in ONE history and feeds the arbiter; 7 — "platforms prospect funnel should be
// arbitrated"; 10 — "the arbiter needs to make sure that any deliverables that were promised from the lead magnet are delivered".
// Same split as the rest of this file (LAW 4): deterministic locks first (opt-out, do-not-contact, risk → a person), then the
// model chooses among a CLOSED menu, then a governed executor acts within authority, and every decision is ledgered (LAW 5).
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════

// The INBOUND RESPONDER (respondToInboundCommunication — locks, the closed reply / person / 1:1-ad menu, explicit-autonomy
// sends, proposals, ONE ledger row per inbound) lives in lib/communications/inbound-responder.ts: it decides through THIS
// file's arbitrateFollowUp and ledgers through arbitrationLedgerDetail, and keeps its executors (social composer / sender,
// reply coach, content-safety screen, autonomy gate, Customer 360, the ad re-engagement door) out of every page that
// reaches this module (test:proxy-graph-budget).

// ── ruling 10: the PROMISED deliverable that has not been delivered (contract C4) ──────────────────────────────────────

export type PromisedDeliverableAction = "delivered" | "delivery_failed" | "human_task" | "nothing_owed" | "refused" | "replayed"

export interface PromisedDeliverableInput {
  brokerageId: string
  party: { kind: "lead" | "contact"; id: string }
  /** One promise (the signal's subject), else every undelivered promise for the person. */
  promiseId?: string | null
  /** The channels the CALLER can deliver on for this person (else: the deliverer's own — the governed email, and the portal card when the contact has a sign-in). */
  permitted?: readonly ArbiterChannel[] | null
  now?: Date
}

export interface PromisedDeliverableResponse {
  action: PromisedDeliverableAction
  reason: string
  promiseIds: string[]
  channel: ArbiterChannel | null
  decision: ArbiterDecision | null
}

/** Contract C4 (lane 146F, lib/lead-magnets/promised-deliverables.ts), PASSED BY THE CALLER — see respondToPromisedDeliverable. */
export interface PromiseContract {
  /** undeliveredPromisesFor — ALWAYS asked about ONE contact. */
  undelivered: (p: { brokerageId: string; contactId: string; promiseId: string | null; now: Date }) => Promise<Array<{ id: string; status?: string | null; fulfilment?: string | null }>>
  /** deliverPromised — the deliverer; ONLY it may mark a promise delivered (never this arbiter). */
  deliver: (p: { brokerageId: string; promiseId: string }) => Promise<{ delivered: boolean; status?: string | null; reason?: string | null }>
}

export interface PromisedDeliverableDeps {
  /** Contract C4, passed by the caller (required — absent is a refusal, never a guess). */
  undelivered?: PromiseContract["undelivered"]
  deliver?: PromiseContract["deliver"]
  decide?: ArbiterDecide
  policy?: FollowupPolicy
  routeToAgent?: typeof routeToAgent
  /** A contact with no agent: the brokerage's admins are told (lib/notifications/brokerage-admins.ts). */
  notifyAdmins?: (p: { brokerageId: string; contactId: string; title: string; body: string }) => Promise<number>
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
}

/** The channels contract C4's deliverer really sends on (lib/lead-magnets/promised-deliverables.ts deliverPromised: the
 *  governed dispatchEmail, and the secure portal card when the person has a portal sign-in). It takes no channel argument —
 *  the arbiter decides deliver-now vs a person, and the channel it names is recorded, never forced onto the deliverer. */
function promiseDeliveryChannels(hasLogin: boolean): ArbiterChannel[] {
  return hasLogin ? ["email", "in_app"] : ["email"]
}

/**
 * THE HIGH-PRIORITY MOMENT (ruling 10, signal `lead_magnet_promise_undelivered`): something promised on a form has not reached
 * the person. Priority "promised_deliverable" — deliver NOW (contract C4's deliverer) or hand it to a person; WAIT is never
 * offered. Delivery is C4's deliverPromised (it confirms the asset exists and is approved and is the ONLY writer of
 * "delivered"); a delivery that does not come back `delivered` is handed to a person in the same step. This decides and leaves
 * evidence: one ledger row per (promise set, UTC day) — a retried signal replays, never delivers twice. Never throws.
 *
 * C4 records a promise only for a CONTACT (lib/kernel/lead-magnets.ts captureFormSubmission records it `if (contactId)`;
 * lead_magnet_promises.contact_id → contacts.id), so a converted lead is answered as its contact (contract C2) and an
 * unconverted lead has nothing owed. The C4 read is ALWAYS narrowed to one contact — never the tenant-wide list.
 *
 * C4 IS PASSED IN, NEVER IMPORTED HERE: this file is reached by every dashboard page (app/crm/page.tsx → workflows →
 * enrollment-engine → lead-action-plan → here), and C4's deliverer pulls the whole lead-magnet capture + delivery stack
 * (lib/kernel/lead-magnets.ts, the delivery runner, the booklet content …) — measured: app/crm/page.tsx 1297 → 1307 first-party
 * modules, over test:proxy-graph-budget's 1300. The callers that already run beside C4 pass it: the inbound chain
 * (lib/communications/inbound-record.ts — a person who writes in is answered on what they are owed first) and C4's own retry
 * sweep / the signal tick (lane notes, Outside-lane).
 */
export async function respondToPromisedDeliverable(svc: { from: (t: string) => any }, input: PromisedDeliverableInput, deps: PromisedDeliverableDeps = {}): Promise<PromisedDeliverableResponse> {
  const now = input.now ?? new Date()
  const refused = (reason: string): PromisedDeliverableResponse => ({ action: "refused", reason, promiseIds: [], channel: null, decision: null })
  try {
    if (!input.brokerageId || !input.party?.id) return refused("no tenant / no person")
    // ── who, tenant-pinned; a converted lead is answered as its contact (contract C2) ──
    let contactId: string | null = input.party.kind === "contact" ? input.party.id : null
    if (input.party.kind === "lead") {
      const { data, error } = await svc.from("leads").select("id, contact_id").eq("id", input.party.id).eq("brokerage_id", input.brokerageId).maybeSingle()
      if (error) return refused(`lead read refused: ${error.message}`)
      if (!data) return refused("lead not in this brokerage")
      const p = canonicalPartyFor(data as { id?: string | null; contact_id?: string | null })
      if (p.type === "unresolved") return refused(p.reason)
      if (p.type !== "contact") return { action: "nothing_owed", reason: "C4 records a promise only for a contact — an unconverted lead has none", promiseIds: [], channel: null, decision: null }
      contactId = p.id
    }
    if (!contactId) return refused("no contact")
    const { data: contact, error: contactErr } = await svc.from("contacts").select("id, agent_id, has_login").eq("id", contactId).eq("brokerage_id", input.brokerageId).maybeSingle()
    if (contactErr) return refused(`contact read refused: ${contactErr.message}`)
    if (!contact) return refused("contact not in this brokerage")
    const contactAgentId = (contact as { agent_id?: string | null }).agent_id ?? null
    const hasLogin = !!(contact as { has_login?: boolean | null }).has_login

    // ── what is owed (contract C4 — one contact's promises, never the tenant's list) ──
    const undelivered = deps.undelivered
    const deliver = deps.deliver
    if (!undelivered || !deliver) return refused("contract C4 (undeliveredPromisesFor / deliverPromised) was not passed by the caller — nothing is read, nothing is marked delivered")
    const owed = (await undelivered({ brokerageId: input.brokerageId, contactId, promiseId: input.promiseId ?? null, now }))
      .filter((r) => !input.promiseId || r.id === input.promiseId)
    if (owed.length === 0) return { action: "nothing_owed", reason: "no undelivered promise for this person", promiseIds: [], channel: null, decision: null }
    const promiseIds = owed.map((r) => r.id)

    // ── the permitted ways to deliver: what the C4 deliverer really sends on, narrowed by the caller when it says so ──
    const deliverable = promiseDeliveryChannels(hasLogin)
    const permitted: ArbiterChannel[] = input.permitted && input.permitted.length > 0 ? deliverable.filter((c) => input.permitted!.includes(c)) : deliverable
    const deliverOpt: ArbiterOption = { id: "deliver", kind: "communication", channels: permitted, why: ["the person asked for this on a form and has not received it", `permitted delivery: ${permitted.join(" / ") || "none"}`] }
    const humanOpt: ArbiterOption = { id: "notify_human", kind: "agent_intervention", channels: ["human_task"], why: ["a person delivers it or explains the delay"] }
    const facts: ArbiterFacts = {
      subject: "contact",
      relationship: { type: "contact", persona: null, hasAssignedAgent: !!contactAgentId },
      intent: null,
      history: { hoursSinceAnyTouch: null, hoursSinceAgentTouch: null, campaignTouches7d: null, lastChannel: null, portalEducationViews: null },
      journey: { transactionStage: null, nextMilestone: null, openLessons: null, nextLesson: null },
      preferences: [],
      fatigueRisk: null,
      localHour: null,
      moment: { key: "promised_deliverable", intent: `${owed.length} promised deliverable(s) have not reached this person — deliver now or hand it to a person.`, daysSinceOpen: 0 },
      blindSpots: owed.some((r) => r.fulfilment === "human") ? ["a promise a PERSON fulfils (an agent-prepared home value) is answered by that person — the system never fakes it"] : [],
      urgency: "high",
    }
    const policy = deps.policy ?? (await (await import("./followup-policy")).loadFollowupPolicy(svc, input.brokerageId)).policy
    const menu: ArbiterMenu = { menu: permitted.length > 0 ? [deliverOpt, humanOpt] : [humanOpt], locked: null }
    const decision = await arbitrateFollowUp({ brokerageId: input.brokerageId, facts, menu, planned: permitted.length > 0 ? deliverOpt : humanOpt, policy, priority: "promised_deliverable" }, { decide: deps.decide })
    const channel = decision.optionId === "deliver" ? (decision.channel && permitted.includes(decision.channel) ? decision.channel : permitted[0] ?? null) : null

    // A person is told (the contact's agent; no agent → the brokerage's admins). Deduped per contact per day by routeToAgent.
    const tellPerson = async (why: string): Promise<boolean> => {
      if (contactAgentId) return (deps.routeToAgent ?? routeToAgent)(svc, { brokerageId: input.brokerageId, contactId: contactId!, agentId: contactAgentId, now, title: "Deliver what we promised", description: why })
      const notify = deps.notifyAdmins ?? (async (p) => (await import("@/lib/notifications/brokerage-admins")).notifyBrokerageAdmins(svc as never, p.brokerageId, { type: "promise_undelivered", title: p.title, body: p.body, entityType: "contact", entityId: p.contactId, priority: "high" }))
      return (await notify({ brokerageId: input.brokerageId, contactId: contactId!, title: "A promised deliverable has not reached a contact", body: why })) > 0
    }

    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
    let out: PromisedDeliverableResponse = { action: "replayed", reason: "this promise moment was already answered today — not acted on twice", promiseIds, channel, decision }
    await ledger<PromisedDeliverableResponse>(
      {
        brokerageId: input.brokerageId, action: "lead_magnet.promise.deliver", actor: { type: "manager", managerKey: "ai_isa" },
        subject: { type: "contact", id: contactId }, reasonCode: "LEAD_FIRST_RESPONSE", reasonDetail: decision.rationale.slice(0, 500),
        cycle: `promise:${[...promiseIds].sort().join(",").slice(0, 200)}:${now.toISOString().slice(0, 10)}`, channel: channel ?? "human_task",
        riskClass: "COMMUNICATION", systemSource: "promised_deliverable", policyKey: "followup_policy",
        detail: { promise_ids: promiseIds, permitted, requested_party: input.party, arbitration: arbitrationLedgerDetail(decision, null) },
      },
      async () => {
        if (channel) {
          const results = await Promise.all(promiseIds.map((promiseId) => deliver({ brokerageId: input.brokerageId, promiseId })))
          const failed = results.filter((r) => !r.delivered)
          if (failed.length === 0) return (out = { action: "delivered", reason: `delivered (the C4 deliverer confirmed; arbiter's channel ${channel})`, promiseIds, channel, decision })
          const why = `${failed.length} of ${results.length} promised deliverable(s) NOT delivered: ${failed.map((f) => `${f.status ?? "error"} — ${f.reason ?? "no reason"}`).join("; ").slice(0, 300)}`
          const told = await tellPerson(why)
          return (out = { action: "delivery_failed", reason: `${why} — ${told ? "a person was told" : "NOBODY could be told"}; the deliverer keeps them undelivered for its retry`, promiseIds, channel, decision })
        }
        const why = `Promised deliverable not received: ${decision.rationale}`
        const told = await tellPerson(why)
        return (out = { action: told ? "human_task" : "refused", reason: told ? why : `${why} — nobody could be told`, promiseIds, channel: null, decision })
      },
      {
        settle: (r) => ({ status: r.action === "delivered" ? "executed" : r.action === "refused" || r.action === "delivery_failed" ? "failed" : "skipped", outcome: r.action, error: r.action === "refused" || r.action === "delivery_failed" ? r.reason : null }),
        // WAVE 147 (147Z): a REFUSED claim delivered nothing — it is a refusal that says why, never "already answered today".
        replay: (claim) => (claim.kind === "refused" ? (out = { action: "refused", reason: `the action ledger refused: ${claim.error}`, promiseIds, channel, decision }) : out),
      },
      { client: svc as never },
    )
    // C14 (wave 147, lane 147Z — lane 147G "Still open 2"): ONE completion per promise decision, opened and evidenced in one call.
    // Delivered → closed on the C4 deliverer's confirmation; handed to a person (or a failed delivery a person was told about) →
    // waits on that person's task; a refusal / replay decided nothing new.
    if (out.action !== "replayed" && out.action !== "refused") {
      try {
        const { trackManagerDecision } = await import("@/lib/kernel/completion-tracking")
        const toPerson = out.action === "human_task" || out.action === "delivery_failed"
        const t = await trackManagerDecision(svc, {
          brokerageId: input.brokerageId, ownerManager: "ai_isa", subject: { type: "contact", id: contactId },
          sourceRef: `promise:${[...promiseIds].sort().join(",").slice(0, 200)}:${now.toISOString().slice(0, 10)}`,
          what: `Deliver what we promised (${promiseIds.length} deliverable${promiseIds.length === 1 ? "" : "s"})`,
          decision: { outcome: `${out.action}: ${out.reason}`, source: "agent_action_ledger:lead_magnet.promise.deliver", ledgerRef: `promise:${now.toISOString().slice(0, 10)}` },
          next: toPerson && contactAgentId ? { kind: "human", contactId } : { kind: "none" },
          context: { promise_ids: promiseIds, channel: channel ?? "human_task" },
        })
        if (!t.ok) console.warn(`[followup-arbiter] promise completion not tracked for contact ${contactId}: ${t.reason}`)
      } catch (e) {
        console.warn(`[followup-arbiter] promise completion tracking threw: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    return out
  } catch (e) {
    return refused(`threw: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ── ruling 7: the PLATFORM's own B2B prospect funnel is arbitrated ──────────────────────────────────────────────────────

export interface ProspectFollowupArbitrationInput {
  /** The deterministic ladder rung that released this prospect (lib/platform/prospect-followup.ts — the envelope stays code). */
  rung: "intro" | "nudge"
  facts: {
    roleInterest: string | null
    source: string | null
    hoursSinceCreated: number | null
    hoursSinceLastFollowup: number | null
    followupCount: number
    /** The prospect wrote back after our last touch (details.last_inbound_at — lib/communications/inbound-record.ts). */
    repliedSinceLastTouch: boolean
    /** Days this rung was already held by the arbiter (superadmin_audit_log platform_prospect.followup_wait). */
    daysDeferred: number
  }
  policy?: FollowupPolicy
  budget?: ArbiterBudget
}

export interface ProspectFollowupArbitration {
  action: "send_now" | "wait" | "notify_staff"
  waitHours: number | null
  decision: ArbiterDecision | null
  skippedReason: string | null
}

/** The platform's model call: NO tenant (brokerageId null — booked as platform spend), the same routed feature. */
async function platformDecide(a: { system: string; prompt: string }): Promise<ArbiterRaw> {
  const [{ generateObjectRouted }, { z }] = await Promise.all([import("@/lib/ai/models"), import("zod")])
  const schema = z.object({ optionId: z.string(), channel: z.string().nullable(), format: z.string().nullable(), waitHours: z.number().nullable(), rationale: z.string(), evidence: z.array(z.string()), confidence: z.number() })
  const { object } = await generateObjectRouted({ feature: "followup_arbitration", brokerageId: null, manager: "data_steward", system: a.system, prompt: a.prompt, schema, temperature: 0.2, maxTokens: 500 })
  return object
}

/**
 * The platform prospect ladder's say (ruling 7). The ENVELOPE stays deterministic in the sweep (status new / contacted, age,
 * one nudge, the platform suppression list, an open human handoff or a requested callback). Inside it: a prospect who WROTE
 * BACK is a person's job (locked — never the automated ladder); otherwise the model chooses send now / a bounded wait / hand to
 * platform staff, from platform facts only — no tenant data, no cross-tenant memory (the prospect is not anyone's contact).
 * An outage keeps the ladder's send. Never throws.
 */
export async function arbitrateProspectFollowup(a: ProspectFollowupArbitrationInput, deps: { decide?: ArbiterDecide } = {}): Promise<ProspectFollowupArbitration> {
  try {
    if (a.facts.repliedSinceLastTouch) {
      return { action: "notify_staff", waitHours: null, decision: null, skippedReason: "the prospect wrote back — a person answers, never the automated ladder" }
    }
    const policy = a.policy ?? (await import("./followup-policy")).DEFAULT_FOLLOWUP_POLICY
    const send: ArbiterOption = { id: "send_now", kind: "communication", channels: ["email"], why: [`the ladder releases the ${a.rung} (touch ${a.facts.followupCount + 1})`] }
    const wait: ArbiterOption = { id: "wait", kind: "wait", channels: [], why: ["hold this touch for a bounded time if now is the wrong moment"] }
    const human: ArbiterOption = { id: "notify_staff", kind: "agent_intervention", channels: ["human_task"], why: ["a platform sales person should take this prospect"] }
    const overdue = a.facts.daysDeferred >= policy.arbiter.maxDeferDays
    const menu: ArbiterMenu = { menu: overdue ? [send, human] : [send, wait, human], locked: null }
    const facts: ArbiterFacts = {
      subject: "lead",
      relationship: { type: "platform_prospect", persona: a.facts.roleInterest, hasAssignedAgent: false },
      intent: null,
      history: { hoursSinceAnyTouch: a.facts.hoursSinceLastFollowup, hoursSinceAgentTouch: null, campaignTouches7d: null, lastChannel: a.facts.followupCount > 0 ? "email" : null, portalEducationViews: null },
      journey: { transactionStage: null, nextMilestone: null, openLessons: null, nextLesson: null },
      preferences: [],
      fatigueRisk: null,
      localHour: null,
      moment: { key: `platform_prospect_${a.rung}`, intent: `A brokerage / agent who raised their hand for the platform (${a.facts.source ?? "unknown source"}, ${a.facts.hoursSinceCreated ?? "?"}h ago): the ${a.rung === "intro" ? "first introduction" : "one follow-up nudge"} is due. Respectful, never pushy; one nudge then silence.`, daysSinceOpen: a.facts.daysDeferred },
      blindSpots: ["platform scope: no tenant data is read for a platform prospect"],
    }
    const decision = await arbitrateFollowUp({ brokerageId: "platform", facts, menu, planned: send, policy, budget: a.budget }, { decide: deps.decide ?? ((x) => platformDecide(x)) })
    const action = decision.optionId === "wait" ? "wait" : decision.optionId === "notify_staff" ? "notify_staff" : "send_now"
    return { action, waitHours: action === "wait" ? decision.waitHours : null, decision, skippedReason: null }
  } catch (e) {
    return { action: "send_now", waitHours: null, decision: null, skippedReason: `arbiter unavailable (${e instanceof Error ? e.message : String(e)}) — the ladder's send stands` }
  }
}
