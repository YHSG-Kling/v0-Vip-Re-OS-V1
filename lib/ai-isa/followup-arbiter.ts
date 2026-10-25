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

import type { ExperienceKind, NextBestExperienceInput, NextBestExperiencePlan, RankedExperience } from "./lead-action-plan"
import type { FollowupPolicy } from "./followup-policy"
import { channelCarriesVideo, type CampaignChannelKey } from "@/lib/campaigns/channels"

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
export interface ChannelConsent {
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
 *  (email + mail only) and a raw lead gets none — respondToLifeChangeSignal routes those deterministically, never through this menu. */
export interface ChannelReadinessInput {
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
  appointment: [],
  wait: [],
})
/** The format an experience fixes (a video experience is an avatar video, whatever carries it). */
const KIND_FORMAT: Readonly<Partial<Record<ExperienceKind, ArbiterFormat>>> = Object.freeze({ video: "avatar_video", agent_intervention: "task" })

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
  if (d.kind === "agent_intervention" || d.channel === "human_task") return "notify_human"
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
  refinance_opportunity: "refinance", rate_drop_refinance: "refinance",
  equity_milestone: "equity", equity_event: "equity",
  next_move_intent: "moving", relocation_referral_request: "moving", moving_intent: "moving", change_of_address: "moving",
  home_value_seller_intent: "home_sale", seller_intent_hot: "home_sale", listing_expired: "home_sale", fsbo_pulled: "home_sale", neighbor_sold_high: "home_sale", home_sale_interest: "home_sale",
  buying_intent: "buying", search_portal_activity: "buying", portal_activity_resumed: "buying",
  divorce_filing: "life_event", probate_filing: "life_event", life_event: "life_event",
})

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

export interface LifeChangeSignal { type: string; kind: LifeChangeKind; strength: number | null; daysAgo: number }

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
        push("education", 40, `signal: ${when} — a plain-language refinance lesson (costs, break-even, what changes)`)
        break
      case "equity":
        if (ownerish) push("market_update", 50, `signal: ${when} — an equity milestone: a market update on their home`)
        push("agent_intervention", 25, `signal: ${when} — the agent may want to talk options (stay, sell, borrow) in person`)
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
        push("agent_intervention", 45, `signal: ${when} — a life event is a person's conversation, never an automated message about it`)
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
}

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
  extra: { checks?: ChannelCheck[] | null; signals?: readonly LifeChangeSignal[] } = {},
): ArbiterFacts {
  const n = input.nba
  const signals = (extra.signals ?? []).map((s) => ({ type: s.type, kind: s.kind, daysAgo: s.daysAgo }))
  const freshHigh = signals.some((s) => s.daysAgo <= 2 && s.kind !== "engagement") || (!!n.intent && n.intent.score >= 80 && String(n.intent.trend) === "rising")
  return {
    ...(extra.checks ? { channels: extra.checks.map((c) => ({ channel: c.channel, available: c.available, approval: c.approval, spendTier: c.spendTier, why: c.reasons[0] ?? "" })) } : {}),
    ...(signals.length > 0 ? { signals } : {}),
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

// ── prompt + validation ──────────────────────────────────────────────────────────────────────

export const ARBITER_SYSTEM = [
  "You are the follow-up judgment of a real-estate brokerage's AI team. You decide the single next best follow-up for ONE person.",
  "Choose ONLY an option id from the menu. Platform limits (consent, opt-out, do-not-contact, quiet hours, fatigue, spend) are enforced after you and cannot be changed — do not try to work around them.",
  "Reason from the evidence given: intent and its trend, how recently and how often they were touched, what they did, where they are in their journey, what they said they prefer, and the tenant's own guidance.",
  "Prefer being useful over selling. Prefer waiting over pestering. Route to a human when the situation needs judgment (a complaint, distress, a complicated question, a high-stakes moment).",
  "Never invent facts, never mention prices, commissions or costs, and never reason from any personal characteristic — only from the evidence keys supplied.",
  "Your choice is one of five stances: ACT NOW (a useful touch on the best permitted channel), WAIT (a bounded hold), EDUCATE (a lesson), NOTIFY HUMAN (a task for the agent), or CHANGE CHANNEL (a touch on a different permitted channel than the last one).",
  "A channel is HOW a message travels (email, text, call, voice drop, mail, the portal, a task for a person); a video is a FORMAT that rides email, text or the portal — never name it as a channel. Consider every channel in `channels` with its reasons; choose only one marked available.",
  "Speed-to-lead and the one welcome on becoming a contact are fixed sends outside this judgment.",
  "Reply with JSON only: {optionId, channel|null, format|null, waitHours|null, rationale (1-3 sentences, plain words), evidence (the fact keys you used), confidence 0..1}.",
].join(" ")

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
async function arbitrateFollowUp(
  a: { brokerageId: string; facts: ArbiterFacts; menu: ArbiterMenu; planned: ArbiterOption; policy: FollowupPolicy; budget?: ArbiterBudget; fixedSend?: FixedSendException | null },
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
  if (a.menu.locked) return base({ kind: a.menu.locked.kind, optionId: a.menu.locked.kind, channel: null, fallbackReason: `locked — ${a.menu.locked.reason}` })
  // THE EXPLICIT EXCEPTIONS (owner ruling 12): a speed-to-lead first touch is a FIXED send — the model is never asked whether to
  // wait on it or to swap it for another experience. The hard gates above (locked) still apply; consent / quiet hours / DNC still
  // gate the dispatch. The planner's communication option is the touch when it is on the menu; otherwise the planner's verdict.
  if (a.fixedSend) {
    const touch = a.menu.menu.find((o) => o.kind === "communication")
    return touch
      ? base({ optionId: touch.id, kind: touch.kind, channel: touch.channels[0] ?? null, fallbackReason: `${a.fixedSend} — a fixed send (owner ruling 12); the arbiter is not consulted` })
      : base({ fallbackReason: `${a.fixedSend} — a fixed send, but no permitted channel carries a touch; the planner's verdict stands` })
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
  if (a.budget && a.budget.remaining <= 0) return base({ fallbackReason: "this sweep's decision budget is spent" })
  if (a.budget) a.budget.remaining -= 1
  let raw: ArbiterRaw
  try {
    raw = await (deps.decide ?? defaultDecide)({ brokerageId: a.brokerageId, system: ARBITER_SYSTEM, prompt: buildArbiterPrompt({ facts: a.facts, menu: a.menu.menu, policy: a.policy }) })
  } catch (e) {
    return base({ fallbackReason: `the model was unavailable (${e instanceof Error ? e.message : String(e)})` })
  }
  const v = validateArbiterReply(raw, a.menu.menu, a.facts, a.policy)
  if (!v.ok) return base({ fallbackReason: `the model's reply was refused — ${v.why}` })
  return withStance({ ...v.decision, source: "ai", fallbackReason: null, menu: a.menu.menu.map((o) => o.id) })
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
    checks?: ChannelCheck[] | null; deliverable?: readonly ArbiterChannel[] | null; signals?: readonly LifeChangeSignal[]; fixedSend?: FixedSendException | null
  },
  deps: { decide?: ArbiterDecide } = {},
): Promise<ArbitratedPlan> {
  // Days the person has ALREADY been held: a moment's age since it OPENED, else the arbiter's own prior waits for this person.
  const ctx: ChannelContext & { daysSinceMomentOpen: number | null } = {
    allowedChannels: a.input.policy.allowedChannels, videoAllowed: a.input.policy.videoAllowed, checks: a.checks ?? null, deliverable: a.deliverable ?? null,
    daysSinceMomentOpen: a.moment?.daysSinceOpen ?? a.daysDeferred ?? null,
  }
  const menu = arbiterMenuFromPlan(a.plan, a.policy, ctx)
  const chosenOpt: ArbiterOption = { id: a.plan.chosen.kind, kind: a.plan.chosen.kind, channels: channelsForKind(a.plan.chosen.kind, ctx), why: a.plan.chosen.reasons.slice(0, 4) }
  const facts = arbiterFactsFromExperienceInput(a.input, a.moment ?? null, { checks: a.checks ?? null, signals: a.signals })
  const decision = await arbitrateFollowUp({ brokerageId: a.brokerageId, facts, menu, planned: chosenOpt, policy: a.policy, budget: a.budget, fixedSend: a.fixedSend ?? null }, deps)
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
function arbitrationLedgerDetail(d: ArbiterDecision, policyRef: string | null, extra: { checks?: ChannelCheck[] | null; signals?: readonly LifeChangeSignal[]; blindSpots?: readonly string[] } = {}): Record<string, unknown> {
  return {
    source: d.source, option: d.optionId, channel: d.channel, format: d.format ?? null, stance: d.stance ?? null, wait_hours: d.waitHours, rationale: d.rationale, evidence: d.evidence, confidence: d.confidence, fallback_reason: d.fallbackReason, menu: d.menu, policy_ref: policyRef,
    // Wave 144: every channel CONSIDERED, with the check that decided it (LAW 5 — which policy permitted, and which refused).
    ...(extra.checks ? { channels_considered: extra.checks.map((c) => ({ channel: c.channel, available: c.available, approval: c.approval, spend_tier: c.spendTier, reasons: c.reasons.slice(0, 3) })) } : {}),
    ...(extra.signals && extra.signals.length > 0 ? { signals: extra.signals.map((s) => ({ type: s.type, kind: s.kind, days_ago: s.daysAgo })) } : {}),
    ...(extra.blindSpots && extra.blindSpots.length > 0 ? { channel_blind_spots: [...extra.blindSpots] } : {}),
  }
}

/** A send the owner FIXED (ruling 12) that reaches this path: the arbiter never defers or swaps it. (The other fixed send — the one
 *  welcome when a lead becomes a contact — never reaches the arbiter: lib/contact-promotion/conversion-welcome.ts sends it.) */
export type FixedSendException = "speed_to_lead"

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
}

export interface CadenceArbitration {
  /** true = release the deterministic send now; false = hold it (the runner skips this lead this run). */
  sendNow: boolean
  decision: ArbiterDecision | null
  /** Why the arbiter was not consulted (cadence says wait / the fatigue floor / etc.), when it was not. */
  skippedReason: string | null
}

/**
 * The arbiter's say over a DUE cadence send. The cadence ENVELOPE stays deterministic: a lead the cadence does not release
 * is never pulled forward (these people have consented to nothing — CLAUDE.md §5), and a lead inside the fatigue floor is
 * held without asking. For a due send the model chooses `send_now` or a bounded `wait` from the evidence; once the send has
 * been overdue for policy.arbiter.maxDeferDays the wait option is withdrawn so a lead is never deferred forever.
 */
export async function arbitrateCadence(a: CadenceArbitrationInput, deps: { decide?: ArbiterDecide } = {}): Promise<CadenceArbitration> {
  if (!a.cadence.shouldSend) return { sendNow: false, decision: null, skippedReason: `the cadence does not release a send (${a.cadence.reason})` }
  const floor = a.policy.guardrails.minHoursBetweenTouches
  if (a.facts.hoursSinceLastOutreach !== null && a.facts.hoursSinceLastOutreach < floor) {
    return { sendNow: false, decision: null, skippedReason: `inside the ${floor}h fatigue floor (last outreach ${a.facts.hoursSinceLastOutreach}h ago)` }
  }
  const send: ArbiterOption = { id: "send_now", kind: "communication", channels: [], why: [`the tenant's cadence releases a send (${a.cadence.reason}, phase ${a.cadence.phase}, day ${a.cadence.daysSinceStart})`] }
  const wait: ArbiterOption = { id: "wait", kind: "wait", channels: [], why: ["hold the send for a bounded time if the evidence says now is the wrong moment"] }
  const overdue = a.facts.daysDeferred >= a.policy.arbiter.maxDeferDays
  const menu: ArbiterMenu = { menu: overdue ? [send] : [send, wait], locked: null }
  const factsForModel: ArbiterFacts = {
    subject: "lead",
    relationship: { type: "lead", persona: a.facts.leadTemperature, hasAssignedAgent: false },
    intent: a.facts.leadScore === null ? null : { score: a.facts.leadScore, trend: a.facts.leadTemperature ?? "unknown" },
    history: { hoursSinceAnyTouch: a.facts.hoursSinceLastOutreach, hoursSinceAgentTouch: null, campaignTouches7d: null, lastChannel: null, portalEducationViews: null },
    journey: { transactionStage: a.facts.timeline, nextMilestone: null, openLessons: null, nextLesson: null },
    preferences: a.facts.preferences.filter((p) => ARBITER_MEMORY_KEYS.includes(p.key)),
    fatigueRisk: null,
    localHour: null,
    moment: { key: `reengagement_phase_${a.cadence.phase}`, intent: `Re-engage a lead who has gone quiet (attempt ${a.facts.attempts + 1}); the tenant's cadence says a touch is due.`, daysSinceOpen: a.facts.daysDeferred },
    blindSpots: [],
  }
  const decision = await arbitrateFollowUp({ brokerageId: a.brokerageId, facts: factsForModel, menu, planned: send, policy: a.policy, budget: a.budget }, deps)
  return { sendNow: decision.kind !== "wait", decision, skippedReason: null }
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
  a: { brokerageId: string; subject: { type: "lead" | "contact"; id: string }; decision: ArbiterDecision; now: Date; policyRef: string | null; systemSource: string },
): Promise<{ recorded: boolean; error?: string }> {
  try {
    const { recordNonAction } = await import("@/lib/kernel/action-ledger")
    const wait = a.decision.kind === "wait"
    const r = await recordNonAction({
      brokerageId: a.brokerageId, domain: "followup", decision: wait ? "wait" : "send_touch",
      actor: { type: "manager", managerKey: "ai_isa" }, subject: a.subject,
      reasonCode: wait ? "WAIT_COOLDOWN" : "NURTURE_TOUCH", reasonDetail: a.decision.rationale.slice(0, 500),
      cycle: `arb:${a.subject.type}:${a.subject.id}:${a.now.toISOString().slice(0, 10)}`,
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

/** Channel → the readiness rows that can serve it (any-of): a readiness CATEGORY or a canonical provider name. */
const CHANNEL_PROVIDER_RULES: Readonly<Partial<Record<ArbiterChannel, { categories?: readonly string[]; providers?: readonly string[] }>>> = Object.freeze({
  email: { categories: ["email"] }, sms: { categories: ["voice_sms"] }, phone: { categories: ["voice_sms"], providers: ["vapi", "retell"] },
  voice_drop: { providers: ["voicedrop", "slybroadcast"] }, direct_mail: { categories: ["mail"], providers: ["lob"] },
  social: { categories: ["social"] }, ads: { providers: ["meta", "google_ads", "facebook_ads"] },
})

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
      for (const [ch, rule] of Object.entries(CHANNEL_PROVIDER_RULES) as Array<[ArbiterChannel, { categories?: readonly string[]; providers?: readonly string[] }]>) {
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
  a: { brokerageId: string; contactId: string; now: Date; policy: FollowupPolicy },
): Promise<{ signals: LifeChangeSignal[]; blindSpot: string | null }> {
  const since = new Date(a.now.getTime() - a.policy.sphere.lifeEventWindowDays * DAY_MS).toISOString()
  const { data, error } = await svc.from("signal_reactivations").select("signal_type, signal_strength, triggered_at")
    .eq("brokerage_id", a.brokerageId).eq("contact_id", a.contactId).gte("triggered_at", since).order("triggered_at", { ascending: false }).limit(20)
  const blind: string[] = []
  const seen = new Set<string>()
  const signals: LifeChangeSignal[] = []
  if (error) blind.push(`signals: signal_reactivations read refused (${error.message})`)
  for (const r of (error ? [] : (data ?? [])) as Array<{ signal_type: string | null; signal_strength: number | null; triggered_at: string | null }>) {
    const type = String(r.signal_type ?? "")
    if (!type || seen.has(type)) continue
    seen.add(type)
    const at = r.triggered_at ? Date.parse(r.triggered_at) : NaN
    signals.push({ type, kind: lifeChangeKindOf(type), strength: typeof r.signal_strength === "number" ? r.signal_strength : null, daysAgo: Number.isFinite(at) ? Math.max(0, Math.floor((a.now.getTime() - at) / DAY_MS)) : 0 })
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
  return { signals, blindSpot: blind.length ? blind.join("; ") : null }
}

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
    signals.push({ type, kind, strength: null, daysAgo: Math.max(0, Math.floor((now.getTime() - at) / DAY_MS)) })
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
      const contactId = (data as { contact_id?: string | null }).contact_id ?? null
      if (contactId) subject = { type: "contact", id: contactId }
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
    await ledger<LifeChangeResponse>(
      {
        brokerageId: input.brokerageId, action: "life_change.respond", actor: { type: "manager", managerKey: subjectClass === "lifetime" ? "sphere_of_influence" : "ai_isa" },
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
        replay: () => out,
      },
      { client: svc as never },
    )
    return out
  } catch (e) {
    return refused(`threw: ${e instanceof Error ? e.message : String(e)}`)
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
    /** Wave 144: a fixed send (speed-to-lead) — the arbiter is not consulted on it (owner ruling 12). */
    fixedSend?: FixedSendException | null
    /** Wave 144: preloaded channel checks (else loaded here through loadChannelReadiness). */
    channelReadiness?: ChannelReadinessLoad | null
  },
  deps: { decide?: ArbiterDecide; record?: Record<string, unknown>; readiness?: Parameters<typeof loadChannelReadiness>[2] } = {},
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
    const sig = await loadLifeChangeSignals(svc, { brokerageId: a.brokerageId, contactId: a.contactId, now: a.now, policy })
    if (sig.blindSpot) channelBlindSpots.push(sig.blindSpot)
    signals = sig.signals
    const withSignals = planWithLifeChangeSignals(a.plan, signals, { contactType: a.input.person.contactType }, { executors: EXPERIENCE_EXECUTORS, kinds: EXPERIENCE_KINDS })
    const arbitrated = await arbitrateExperiencePlan({ brokerageId: a.brokerageId, input: a.input, plan: withSignals, policy, budget: a.budget, moment: a.moment, daysDeferred, checks, deliverable: a.deliverable ?? null, signals, fixedSend: a.fixedSend ?? null }, { decide: deps.decide })
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
