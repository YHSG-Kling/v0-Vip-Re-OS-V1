// lib/ai-isa/speed-to-lead-policy.ts
//
// SPEED-TO-LEAD PURE DECISION LOGIC — no I/O, no side effects.
// Exhaustively testable. The engine (speed-to-lead.ts) imports this and the
// simulator proves every branch. The one import below is itself pure (no I/O):
// the follow-up ladder's day constants, read rather than retyped (§6).

import { PHASE1_WINDOW_DAYS, PHASE2_SPACING_DAYS, PHASE3_SPACING_DAYS } from "./reengagement-policy"

export type FirstTouchKind    = "lead" | "contact"
export type FirstTouchChannel = "email" | "sms" | "phone" | "direct_mail"

export interface FirstTouchConsentInput {
  // Lead channels
  email_verified?:           boolean | null
  email_opt_out?:            boolean | null
  mailing_address_verified?: boolean | null
  // Contact channels (TCPA-gated)
  tcpa_consent?:             boolean | null
  dnc_status?:               boolean | null
  phone_opt_out?:            boolean | null
  sms_opt_out?:              boolean | null
  preferred_channel?:        string | null
}

export interface FirstTouchInput {
  kind:              FirstTouchKind
  now:               Date
  createdAt:         Date
  /** When the contact was assigned to the current agent (contacts only) */
  assignedAt?:       Date | null
  /** Null = has never been first-touched */
  firstTouchedAt?:   Date | null
  /** Null = agent has never contacted this person */
  agentLastTouchAt?: Date | null
  consent:           FirstTouchConsentInput
  /** Minutes after assignment before ISA may jump in (contacts). Default 5. */
  agentGraceMinutes?: number
}

export interface FirstTouchDecision {
  shouldTouch: boolean
  channel:     FirstTouchChannel | null
  reason:      string
}

export const DEFAULT_AGENT_GRACE_MINUTES = 5

/**
 * Pure: decide whether and on which channel the AI ISA should send the first touch.
 *
 * LEAD path  — email only (if verified); direct_mail fallback (if address verified);
 *              else skip. NEVER phone/SMS — unconsented leads.
 *
 * CONTACT path — skip if already first-touched OR agent already touched them.
 *               Wait for agentGraceMinutes after assignment before ISA jumps in.
 *               Then pick best consented channel: preferred_channel → phone → sms
 *               → email; respect all opt-outs.
 */
export function firstTouchDecision(input: FirstTouchInput): FirstTouchDecision {
  const { kind, now, assignedAt, firstTouchedAt, agentLastTouchAt, consent } = input
  const graceMinutes = input.agentGraceMinutes ?? DEFAULT_AGENT_GRACE_MINUTES

  // ── Idempotency guard ────────────────────────────────────────────────────
  if (firstTouchedAt != null) {
    return { shouldTouch: false, channel: null, reason: "already_first_touched" }
  }

  // ── LEAD path ────────────────────────────────────────────────────────────
  if (kind === "lead") {
    // Email: only if verified AND not opted out
    if (consent.email_verified && !consent.email_opt_out) {
      return { shouldTouch: true, channel: "email", reason: "lead_email_verified" }
    }
    // Direct mail: only if address verified
    if (consent.mailing_address_verified) {
      return { shouldTouch: true, channel: "direct_mail", reason: "lead_mailing_address_verified" }
    }
    // Honest skip — no permitted channel
    return { shouldTouch: false, channel: null, reason: "lead_no_permitted_channel" }
  }

  // ── CONTACT path ─────────────────────────────────────────────────────────

  // Skip if agent has already been in contact
  if (agentLastTouchAt != null) {
    return { shouldTouch: false, channel: null, reason: "agent_already_contacted" }
  }

  // Grace period: wait for agent to reach out first
  if (assignedAt != null) {
    const elapsedMinutes = (now.getTime() - assignedAt.getTime()) / 60_000
    if (elapsedMinutes < graceMinutes) {
      return {
        shouldTouch: false,
        channel:     null,
        reason:      `within_agent_grace_period (${Math.round(elapsedMinutes)}/${graceMinutes} min)`,
      }
    }
  } else {
    // No assignment → ISA should not jump in
    return { shouldTouch: false, channel: null, reason: "contact_not_assigned" }
  }

  // Pick best consented channel
  const preferred = (consent.preferred_channel ?? "email") as string

  // Try preferred channel first, then cascade
  const channel = resolveContactChannel(preferred, consent)
  if (channel) {
    return { shouldTouch: true, channel, reason: `contact_grace_elapsed_channel_${channel}` }
  }

  return { shouldTouch: false, channel: null, reason: "contact_no_permitted_channel" }
}

/** Pure: resolve the best permitted channel for a contact from their consent state. */
function resolveContactChannel(
  preferred: string,
  consent: FirstTouchConsentInput,
): FirstTouchChannel | null {
  // Evaluate preferred first
  if (preferred === "phone" && isPhoneAllowed(consent))  return "phone"
  if (preferred === "sms"   && isSmsAllowed(consent))    return "sms"
  if (preferred === "email" && isEmailAllowed(consent))  return "email"
  if (preferred === "direct_mail")                        return "direct_mail"

  // Cascade: phone → sms → email → direct_mail → null
  if (isPhoneAllowed(consent)) return "phone"
  if (isSmsAllowed(consent))   return "sms"
  if (isEmailAllowed(consent)) return "email"
  // direct_mail has no extra gates (no opt-out field checked at decision layer)
  return "direct_mail"
}

function isPhoneAllowed(c: FirstTouchConsentInput): boolean {
  return !!(c.tcpa_consent && !c.dnc_status && !c.phone_opt_out)
}

function isSmsAllowed(c: FirstTouchConsentInput): boolean {
  return !!(c.tcpa_consent && !c.sms_opt_out)
}

function isEmailAllowed(c: FirstTouchConsentInput): boolean {
  return !consent_emailOptedOut(c)
}

function consent_emailOptedOut(c: FirstTouchConsentInput): boolean {
  return c.email_opt_out === true
}

// ─────────────────────────────────────────────────────────────────────────────
// SPEED-TO-LEAD LATENCY SUMMARY — pure metric math for the ISA console KPI strip.
// Given the rows that have been first-touched (createdAt + firstTouchedAt + channel),
// compute median latency, the share touched within the SLA, and a channel breakdown.
// No I/O — unit-testable; the server action just feeds it real rows.
// ─────────────────────────────────────────────────────────────────────────────

const FIRST_TOUCH_SLA_SECONDS = 5 * 60 // the "speed to lead" promise: under 5 minutes

export interface FirstTouchRow {
  createdAt: string | Date | null
  firstTouchedAt: string | Date | null
  channel?: string | null
}

/** Lane 90C — the SLA meter PER CHANNEL (89D P2-8: "first-response seconds per
 *  lead per channel"). Same rows, same math, bucketed by first_touch_channel. */
export interface ChannelLatencySummary {
  touchedCount: number
  medianSeconds: number | null
  pctWithinSla: number | null
}

export interface FirstTouchLatencySummary {
  touchedCount: number
  medianSeconds: number | null
  /** Share (0..1) of touched rows that met the under-5-min SLA. */
  pctWithinSla: number | null
  channelBreakdown: Record<string, number>
  /** Lane 90C — median + SLA share per channel (email / sms / phone / direct_mail / unknown). */
  perChannel: Record<string, ChannelLatencySummary>
}

function toMsOrNull(d: string | Date | null): number | null {
  if (!d) return null
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime()
  return Number.isNaN(t) ? null : t
}

/** PURE: median of an unsorted list; null on empty. Shared by every summary here (§6). */
function medianOf(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}

function latencySummary(latencies: number[]): ChannelLatencySummary {
  if (latencies.length === 0) return { touchedCount: 0, medianSeconds: null, pctWithinSla: null }
  const withinSla = latencies.filter((s) => s <= FIRST_TOUCH_SLA_SECONDS).length
  return { touchedCount: latencies.length, medianSeconds: medianOf(latencies), pctWithinSla: withinSla / latencies.length }
}

export function summarizeFirstTouchLatency(rows: FirstTouchRow[]): FirstTouchLatencySummary {
  const latencies: number[] = []
  const channelBreakdown: Record<string, number> = {}
  const perChannelLatencies: Record<string, number[]> = {}

  for (const r of rows) {
    const created = toMsOrNull(r.createdAt)
    const touched = toMsOrNull(r.firstTouchedAt)
    const ch = (r.channel ?? "unknown") || "unknown"
    // Only count rows with both timestamps and a non-negative latency (clock-skew guard).
    if (created !== null && touched !== null && touched >= created) {
      const secs = Math.floor((touched - created) / 1000)
      latencies.push(secs)
      ;(perChannelLatencies[ch] ??= []).push(secs)
    }
    channelBreakdown[ch] = (channelBreakdown[ch] ?? 0) + 1
  }

  const perChannel: Record<string, ChannelLatencySummary> = {}
  for (const [ch, secs] of Object.entries(perChannelLatencies)) perChannel[ch] = latencySummary(secs)

  const overall = latencySummary(latencies)
  return {
    touchedCount: overall.touchedCount,
    medianSeconds: overall.medianSeconds,
    pctWithinSla: overall.pctWithinSla,
    channelBreakdown,
    perChannel,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE THREE PROOF NUMBERS COMPETITORS PUBLISH (lane 90C; 89D §7: Ylopo "48% text
// response, 30%+ voice connect, 90-day follow-up" — "we record all three and
// publish none"). Pure math over rows the ISA already writes:
//   · response rate  — isa_outreach_log: leads with ≥1 reply ÷ leads with ≥1 send,
//                      overall and per channel (a reply is replied_at set OR
//                      status='replied' — both spellings the ledger carries).
//   · connect rate   — voice_calls (call_type ai_isa_call, outbound): calls that
//                      reached a person ÷ calls that finished dialing.
//   · days of follow-up — per lead, last send − first send in days; the median
//                      and the max across leads with ≥2 sends, beside the POLICY
//                      horizon (reengagement-policy.ts: the ladder never stops —
//                      phase 3 keeps sending every PHASE3_SPACING_DAYS).
// No I/O; the server action feeds real rows. A reader with NO rows returns
// honest nulls, never 0% (a zero here would read as "nobody ever answers").
// ─────────────────────────────────────────────────────────────────────────────

/** voice_calls.status values that mean a PERSON was reached (a completed call).
 *  Subset of the live CHECK (scripts/check-vocabularies.ts voice_calls.status) —
 *  the proof holds it there so a retired spelling cannot sit here unnoticed. */
export const VOICE_CONNECTED_STATUSES: readonly string[] = ["completed"]
/** voice_calls.status values that mean the dial FINISHED (answered or not).
 *  initiated / ringing / in_progress are still live; blocked never dialed. */
export const VOICE_DIALED_TERMINAL_STATUSES: readonly string[] = ["completed", "no_answer", "voicemail", "failed"]

export interface OutreachLedgerRow {
  leadId: string | null
  contactId?: string | null
  channel: string | null
  sentAt: string | Date | null
  repliedAt?: string | Date | null
  status?: string | null
}

export interface VoiceCallLedgerRow {
  status: string | null
  direction?: string | null
}

export interface RateNumber {
  numerator: number
  denominator: number
  /** 0..1, or null when the denominator is 0 (never a fabricated 0%). */
  rate: number | null
}

export interface IsaProofNumbers {
  /** Leads replied ÷ leads sent-to (a lead counts once no matter how many touches). */
  responseRate: RateNumber
  responseRateByChannel: Record<string, RateNumber>
  /** AI ISA outbound calls answered by a person ÷ calls that finished dialing. */
  connectRate: RateNumber
  followUp: {
    /** Leads/contacts with ≥ 2 sends in the window. */
    personsWithFollowUp: number
    medianDays: number | null
    maxDays: number | null
    /** The ladder's own horizon: phase 1 window, then phase 2 / phase 3 spacing. */
    policy: { phase1WindowDays: number; phase2SpacingDays: number; phase3SpacingDays: number }
  }
}

function rate(numerator: number, denominator: number): RateNumber {
  return { numerator, denominator, rate: denominator > 0 ? numerator / denominator : null }
}

function personKey(r: OutreachLedgerRow): string | null {
  if (r.leadId) return `lead:${r.leadId}`
  if (r.contactId) return `contact:${r.contactId}`
  return null
}

export function summarizeIsaProofNumbers(input: { outreach: OutreachLedgerRow[]; calls: VoiceCallLedgerRow[] }): IsaProofNumbers {
  // ── response rate — per person, per channel ──
  const sentBy = new Set<string>()
  const repliedBy = new Set<string>()
  const sentByChannel: Record<string, Set<string>> = {}
  const repliedByChannel: Record<string, Set<string>> = {}
  const sendTimes: Record<string, number[]> = {}

  for (const r of input.outreach) {
    const key = personKey(r)
    const sentMs = toMsOrNull(r.sentAt)
    if (!key || sentMs === null) continue
    const ch = (r.channel ?? "unknown") || "unknown"
    sentBy.add(key)
    ;(sentByChannel[ch] ??= new Set()).add(key)
    ;(sendTimes[key] ??= []).push(sentMs)
    const replied = toMsOrNull(r.repliedAt ?? null) !== null || r.status === "replied"
    if (replied) {
      repliedBy.add(key)
      ;(repliedByChannel[ch] ??= new Set()).add(key)
    }
  }

  const responseRateByChannel: Record<string, RateNumber> = {}
  for (const [ch, sent] of Object.entries(sentByChannel)) {
    responseRateByChannel[ch] = rate(repliedByChannel[ch]?.size ?? 0, sent.size)
  }

  // ── connect rate — outbound AI ISA dials that finished ──
  let dialed = 0, connected = 0
  for (const c of input.calls) {
    if (c.direction && c.direction !== "outbound") continue
    const st = c.status ?? ""
    if (!VOICE_DIALED_TERMINAL_STATUSES.includes(st)) continue
    dialed++
    if (VOICE_CONNECTED_STATUSES.includes(st)) connected++
  }

  // ── days of follow-up — last send − first send per person, ≥ 2 sends ──
  const spans: number[] = []
  for (const times of Object.values(sendTimes)) {
    if (times.length < 2) continue
    const first = Math.min(...times), last = Math.max(...times)
    spans.push(Math.floor((last - first) / 86_400_000))
  }

  return {
    responseRate: rate(repliedBy.size, sentBy.size),
    responseRateByChannel,
    connectRate: rate(connected, dialed),
    followUp: {
      personsWithFollowUp: spans.length,
      medianDays: medianOf(spans),
      maxDays: spans.length > 0 ? Math.max(...spans) : null,
      policy: { phase1WindowDays: PHASE1_WINDOW_DAYS, phase2SpacingDays: PHASE2_SPACING_DAYS, phase3SpacingDays: PHASE3_SPACING_DAYS },
    },
  }
}
