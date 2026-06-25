// lib/ai-isa/reengagement-policy.ts
//
// THE AI ISA RE-ENGAGEMENT POLICY — the pure, testable heart of the follow-up loop.
//
// The ISA re-engagement crons (ghost-detection, stale-contact-monitor) run governed
// outreach in production, but the DECISIONS that govern them — the send cadence, the
// stop conditions, the stale-eligibility predicate — used to live inline in the cron
// runners with NO unit coverage. A bug in the cadence silently over- or under-contacts
// every ghosting lead; a bug in a stop condition messages someone who opted out.
//
// This module extracts those decisions as PURE functions so they are (a) the SINGLE
// source of truth shared by the production runners (lib/ai-isa/ghost-reengagement.ts +
// lib/ai-isa/stale-contact-detector.ts) and (b) exhaustively unit-testable with no DB,
// no network, no mocks. The runners keep doing the I/O; this module decides.
//
// Pure module — no imports, no I/O, no server-only. Behavior is preserved EXACTLY from
// the prior inline logic; the simulator (scripts/isa-reengagement-simulator.ts) locks it.

const DAY_MS = 86_400_000

// ── Defaults (overridable per brokerage via ai_isa_settings) ──────────────────
export const DEFAULT_STALE_DAYS = 14
export const DEFAULT_GHOSTED_DAYS = 21
export const DEFAULT_MAX_BATCH = 50
/** Max AI-ISA re-engagement touches before the ISA GIVES UP on a non-responding ghost
 *  and hands it to a human (≈ 6 Phase-1 touches + a few monthly Phase-2 touches ≈ 3+
 *  months of follow-up). Without a ceiling the loop re-messages a ghost forever. */
export const DEFAULT_MAX_GHOST_ATTEMPTS = 9

/** Phase-1 (fresh ghost) send days: Mon/Wed/Fri only — aggressive while the lead is
 *  still warm. getDay(): 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat. */
export const PHASE1_SEND_DAYS = [1, 3, 5] as const
/** The window (days from first outreach) that counts as Phase 1. */
export const PHASE1_WINDOW_DAYS = 14
/** Phase-2 (long-haul) minimum spacing between sends, in days. */
export const PHASE2_SPACING_DAYS = 30

// ─────────────────────────────────────────────────────────────────────────────
// 1. GHOST-LEAD STOP CONDITIONS — when the ISA must go (or stay) dormant
// ─────────────────────────────────────────────────────────────────────────────

/** The honest, enumerated reasons the ISA stops re-engaging a ghost lead. */
export type GhostStopReason =
  | "representation" // the lead has entered active representation — the human owns it now
  | "inactive" // the lead row was deactivated
  | "reengage_disallowed" // the linked contact has isa_reengage_allowed = false
  | "opted_out" // the lead explicitly opted out of re-engagement
  | "reply_received" // the lead replied — hand back to the live qualification flow
  | "exhausted" // the ISA gave up after MAX attempts without a reply — escalate to a human

/** The minimal lead shape the stop check reads. */
export interface GhostStopInput {
  lifecycle_state: string | null
  is_active: boolean | null
  reengagement_status: string | null
  /** isa_reengage_allowed from the JOINED contact row (null when no contact yet). */
  contactReengageAllowed: boolean | null
  /** True when a positive reply (ISA_REPLY_RECEIVED) has been recorded for the lead. */
  replyReceived: boolean
  /** How many re-engagement touches have already been sent (reengagement_attempt_count). */
  outreachAttempts?: number | null
}

/**
 * ghostReengagementStopReason — PURE. Returns the FIRST applicable stop reason, or null
 * when the ISA may continue. Order: the "human now owns it / must not contact" reasons
 * (representation / inactive / reengage-disallowed / opted-out), then a positive reply,
 * then EXHAUSTED — the ISA has sent maxAttempts touches with no reply and must give up
 * and hand the ghost to a human instead of looping forever.
 */
export function ghostReengagementStopReason(
  input: GhostStopInput,
  opts?: { maxAttempts?: number },
): GhostStopReason | null {
  if (input.lifecycle_state === "representation") return "representation"
  if (input.is_active === false) return "inactive"
  if (input.contactReengageAllowed === false) return "reengage_disallowed"
  if (input.reengagement_status === "opted_out") return "opted_out"
  if (input.replyReceived) return "reply_received"
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_GHOST_ATTEMPTS
  if ((input.outreachAttempts ?? 0) >= maxAttempts) return "exhausted"
  return null
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. GHOST CADENCE — WHEN to send the next re-engagement touch
// ─────────────────────────────────────────────────────────────────────────────

export interface CadenceInput {
  /** When the FIRST re-engagement outreach went out (null = none yet → starts today). */
  firstSentAt: Date | string | null
  /** When the MOST RECENT outreach went out (null = none yet). */
  lastSentAt: Date | string | null
  /** "Now" — injectable for deterministic tests. */
  now: Date
}

export interface CadenceDecision {
  shouldSend: boolean
  /** 1 = fresh window (≤14d, Mon/Wed/Fri), 2 = long-haul (every 30d). */
  phase: 1 | 2
  /** Whole days since the cadence phase started (first outreach, or 0 on day one). */
  daysSinceStart: number
  /** Honest WHY for the decision (for audit + the simulator). */
  reason:
    | "phase1_send_day"
    | "phase1_off_day"
    | "phase2_first_send"
    | "phase2_due"
    | "phase2_too_soon"
}

function toMs(d: Date | string | null): number | null {
  if (!d) return null
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime()
  return Number.isNaN(t) ? null : t
}

/**
 * shouldSendGhostOutreach — PURE. The follow-up cadence decision, preserved EXACTLY
 * from runGhostReengagement:
 *   · Phase 1 (≤14 days since first outreach): send only on Mon/Wed/Fri.
 *   · Phase 2 (>14 days): send if never sent, else only when ≥30 days since the last.
 * "now" and the timestamps are injectable so every branch is deterministically testable.
 */
export function shouldSendGhostOutreach(input: CadenceInput): CadenceDecision {
  const nowMs = input.now.getTime()
  const firstMs = toMs(input.firstSentAt) ?? nowMs // no prior send → phase starts now
  const daysSinceStart = Math.floor((nowMs - firstMs) / DAY_MS)
  const inPhase1 = daysSinceStart <= PHASE1_WINDOW_DAYS

  if (inPhase1) {
    const isSendDay = (PHASE1_SEND_DAYS as readonly number[]).includes(input.now.getDay())
    return {
      shouldSend: isSendDay,
      phase: 1,
      daysSinceStart,
      reason: isSendDay ? "phase1_send_day" : "phase1_off_day",
    }
  }

  const lastMs = toMs(input.lastSentAt)
  if (lastMs === null) {
    return { shouldSend: true, phase: 2, daysSinceStart, reason: "phase2_first_send" }
  }
  const daysSinceLast = Math.floor((nowMs - lastMs) / DAY_MS)
  const due = daysSinceLast >= PHASE2_SPACING_DAYS
  return {
    shouldSend: due,
    phase: 2,
    daysSinceStart,
    reason: due ? "phase2_due" : "phase2_too_soon",
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. STALE-CONTACT ELIGIBILITY — who the contact-side re-engagement may touch
// ─────────────────────────────────────────────────────────────────────────────

/** The minimal contact shape the eligibility predicate reads. */
export interface StaleEligibilityInput {
  last_contacted_at: string | null
  dnc_status: boolean | null
  ai_outreach_paused: boolean | null
  isa_reengage_allowed: boolean | null
  status: string | null
  deleted_at: string | null
  /** True when the contact has an open transaction (active/under_contract/closing/pending). */
  hasActiveTransaction: boolean
}

export type StaleIneligibleReason =
  | "dnc"
  | "outreach_paused"
  | "reengage_disallowed"
  | "do_not_contact_status"
  | "deleted"
  | "active_transaction"
  | "not_yet_stale"

export interface StaleEligibilityResult {
  eligible: boolean
  reason: StaleIneligibleReason | "stale"
  daysSinceContact: number
}

/**
 * staleContactEligibility — PURE. The full, authoritative predicate for whether a
 * converted CONTACT may receive AI ISA re-engagement. Encodes EVERY exclusion the
 * detector applies (the cron pre-filters most at the query for efficiency; this is the
 * single source of truth that the runner's post-fetch loop honors). A contact never
 * contacted (last_contacted_at = null) is maximally stale (daysSinceContact = 999),
 * matching the detector's sentinel.
 */
export function staleContactEligibility(
  c: StaleEligibilityInput,
  opts: { now: Date; staleDays?: number },
): StaleEligibilityResult {
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS
  const lastMs = toMs(c.last_contacted_at)
  const daysSinceContact = lastMs === null ? 999 : Math.floor((opts.now.getTime() - lastMs) / DAY_MS)

  if (c.dnc_status === true) return { eligible: false, reason: "dnc", daysSinceContact }
  if (c.ai_outreach_paused === true) return { eligible: false, reason: "outreach_paused", daysSinceContact }
  if (c.isa_reengage_allowed === false) return { eligible: false, reason: "reengage_disallowed", daysSinceContact }
  if (c.status === "do_not_contact") return { eligible: false, reason: "do_not_contact_status", daysSinceContact }
  if (c.deleted_at !== null) return { eligible: false, reason: "deleted", daysSinceContact }
  if (c.hasActiveTransaction) return { eligible: false, reason: "active_transaction", daysSinceContact }
  if (daysSinceContact < staleDays) return { eligible: false, reason: "not_yet_stale", daysSinceContact }

  return { eligible: true, reason: "stale", daysSinceContact }
}

/** resolveStaleThreshold — PURE. Reads a brokerage's isa_ghost_threshold_days setting,
 *  honestly falling back to the default when unset/invalid. */
export function resolveStaleThreshold(setting: unknown, fallback = DEFAULT_STALE_DAYS): number {
  return typeof setting === "number" && Number.isFinite(setting) && setting > 0 ? setting : fallback
}
