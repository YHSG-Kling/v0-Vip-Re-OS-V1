// lib/ai-isa/speed-to-lead-policy.ts
//
// SPEED-TO-LEAD PURE DECISION LOGIC — no I/O, no side effects.
// Exhaustively testable. The engine (speed-to-lead.ts) imports this and the
// simulator proves every branch.

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

export interface FirstTouchLatencySummary {
  touchedCount: number
  medianSeconds: number | null
  /** Share (0..1) of touched rows that met the under-5-min SLA. */
  pctWithinSla: number | null
  channelBreakdown: Record<string, number>
}

function toMsOrNull(d: string | Date | null): number | null {
  if (!d) return null
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime()
  return Number.isNaN(t) ? null : t
}

export function summarizeFirstTouchLatency(rows: FirstTouchRow[]): FirstTouchLatencySummary {
  const latencies: number[] = []
  const channelBreakdown: Record<string, number> = {}

  for (const r of rows) {
    const created = toMsOrNull(r.createdAt)
    const touched = toMsOrNull(r.firstTouchedAt)
    // Only count rows with both timestamps and a non-negative latency (clock-skew guard).
    if (created !== null && touched !== null && touched >= created) {
      latencies.push(Math.floor((touched - created) / 1000))
    }
    const ch = (r.channel ?? "unknown") || "unknown"
    channelBreakdown[ch] = (channelBreakdown[ch] ?? 0) + 1
  }

  const touchedCount = latencies.length
  if (touchedCount === 0) {
    return { touchedCount: 0, medianSeconds: null, pctWithinSla: null, channelBreakdown }
  }

  latencies.sort((a, b) => a - b)
  const mid = Math.floor(touchedCount / 2)
  const medianSeconds =
    touchedCount % 2 === 0 ? Math.round((latencies[mid - 1] + latencies[mid]) / 2) : latencies[mid]
  const withinSla = latencies.filter((s) => s <= FIRST_TOUCH_SLA_SECONDS).length

  return {
    touchedCount,
    medianSeconds,
    pctWithinSla: withinSla / touchedCount,
    channelBreakdown,
  }
}
