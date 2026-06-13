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
