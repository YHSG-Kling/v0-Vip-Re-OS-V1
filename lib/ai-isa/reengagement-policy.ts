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
// Lifetime / past clients are a LONG-HORIZON relationship — their primary nurture is the newsletter
// baseline + the situational equity/anniversary/life-event triggers, so the generic re-engagement should
// be a light QUARTERLY-ish touch, not the bi-weekly active-contact cadence. So a lifetime customer is
// only "stale" after this many quiet days (the detector passes is_lifetime; default applies otherwise).
export const LIFETIME_STALE_DAYS = 60
export const DEFAULT_GHOSTED_DAYS = 21
export const DEFAULT_MAX_BATCH = 50
/** Active-cadence ceiling: after this many touches the ISA stops the AGGRESSIVE follow-up
 *  (Phase 1/2 ≈ 3 months) and DOWNSHIFTS to a long-horizon quarterly nurture — it does NOT
 *  give up. Real-estate leads routinely take 6–18 months to transact; abandoning a viable,
 *  consented lead at 3 months throws away the agent's gold mine. The transition escalates
 *  ONCE to a human (FYI: consider a personal call) — the automated nurture keeps going. */
export const DEFAULT_MAX_GHOST_ATTEMPTS = 9
/** Long-horizon ceiling: after a year+ of quarterly seasonal touches with no reply, the
 *  ISA HANDS the long-tail to the Sphere of Influence manager (the lifetime-nurture owner)
 *  and rests its own automated loop — the relationship is preserved, not dropped. */
export const DEFAULT_MAX_HORIZON_ATTEMPTS = 13

/** Phase-1 (fresh ghost) send days: Mon/Wed/Fri only — aggressive while the lead is
 *  still warm. getDay(): 0=Sun 1=Mon 2=Tue 3=Wed 4=Thu 5=Fri 6=Sat. */
const PHASE1_SEND_DAYS = [1, 3, 5] as const
/** The window (days from first outreach) that counts as Phase 1. */
export const PHASE1_WINDOW_DAYS = 14
/** Phase-2 (long-haul) minimum spacing between sends, in days. */
export const PHASE2_SPACING_DAYS = 30
/** Phase-3 (long-horizon seasonal nurture) spacing — a light quarterly value-touch that
 *  keeps the agent top-of-mind for the months/years a real-estate decision can take. */
export const PHASE3_SPACING_DAYS = 90

// ─────────────────────────────────────────────────────────────────────────────
// 1. GHOST-LEAD STOP CONDITIONS — when the ISA must go (or stay) dormant
// ─────────────────────────────────────────────────────────────────────────────

/** The honest, enumerated reasons the ISA stops its OWN re-engagement loop on a ghost lead.
 *  Note: none of these is "gave up" — the lead is either owned by a human now, must not be
 *  contacted, replied, or has been HANDED to the Sphere manager for lifetime nurture. */
export type GhostStopReason =
  | "representation" // the lead has entered active representation — the human owns it now
  | "inactive" // the lead row was deactivated
  | "reengage_disallowed" // the linked contact has isa_reengage_allowed = false
  | "opted_out" // the lead explicitly opted out of re-engagement
  | "reply_received" // the lead replied — hand back to the live qualification flow
  | "handed_to_sphere" // a year+ of seasonal nurture with no reply — the ISA hands the long-tail to the Sphere of Influence manager (NOT abandonment)

/** The cadence phase the re-engagement loop is in for a given attempt count. */
export type ReengagementPhase = "active" | "seasonal"

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
 * ghostReengagementStopReason — PURE. Returns the FIRST applicable reason the ISA stops its
 * OWN loop, or null when it may continue. Order: the "human now owns it / must not contact"
 * reasons (representation / inactive / reengage-disallowed / opted-out), then a positive
 * reply, then HANDED_TO_SPHERE — after the long-horizon ceiling the ISA hands the long-tail
 * to the Sphere of Influence manager for lifetime nurture. Crucially, reaching the
 * active-cadence ceiling (DEFAULT_MAX_GHOST_ATTEMPTS) is NOT a stop — the loop downshifts to
 * the quarterly seasonal cadence (see ghostReengagementPhase) and keeps going.
 */
export function ghostReengagementStopReason(
  input: GhostStopInput,
  opts?: { maxHorizonAttempts?: number },
): GhostStopReason | null {
  if (input.lifecycle_state === "representation") return "representation"
  if (input.is_active === false) return "inactive"
  if (input.contactReengageAllowed === false) return "reengage_disallowed"
  if (input.reengagement_status === "opted_out") return "opted_out"
  if (input.replyReceived) return "reply_received"
  const maxHorizon = opts?.maxHorizonAttempts ?? DEFAULT_MAX_HORIZON_ATTEMPTS
  if ((input.outreachAttempts ?? 0) >= maxHorizon) return "handed_to_sphere"
  return null
}

/**
 * ghostReengagementPhase — PURE. Which cadence phase the loop is in for an attempt count,
 * and whether THIS run is the active→seasonal TRANSITION (escalate to a human exactly once).
 *   · attempts < maxAttempts (9)              → "active"   (Phase 1/2 aggressive cadence)
 *   · maxAttempts ≤ attempts < maxHorizon     → "seasonal" (Phase 3 quarterly nurture)
 * escalateOnEntry is true only at the boundary (attempts === maxAttempts) so the one-time
 * "auto-nurture continues quarterly — consider a personal call" escalation fires once.
 */
export function ghostReengagementPhase(
  attempts: number,
  opts?: { maxAttempts?: number },
): { phase: ReengagementPhase; escalateOnEntry: boolean } {
  const maxAttempts = opts?.maxAttempts ?? DEFAULT_MAX_GHOST_ATTEMPTS
  const a = attempts ?? 0
  if (a < maxAttempts) return { phase: "active", escalateOnEntry: false }
  return { phase: "seasonal", escalateOnEntry: a === maxAttempts }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2b. PERSONA / AGE / URGENCY-TUNED CADENCE — the WHEN, tailored to the human
//
// The base cadence (Phase 1/2/3) is uniform, but a 0–3-month buyer and a "someday"
// boomer browser should NOT be touched on the same clock. This is the WHEN counterpart
// to the next-best-CHANNEL decision (lib/ai-isa/next-best-touch.ts): the manager spaces
// the next follow-up to the human in front of it — tighter when the person is acting
// soon, wider for a long-horizon relationship — blending timeline urgency (dominant)
// with generational pacing. Frequency only; NO content and NO protected-class treatment.
//
// Default (no signals) ⇒ multiplier 1.0 ⇒ the canonical cadence, exactly unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/** Spacing-multiplier bounds — a tuned cadence never collapses to spam nor stretches to neglect. */
export const CADENCE_MULTIPLIER_MIN = 0.5
export const CADENCE_MULTIPLIER_MAX = 2.0

export interface CadenceProfileInput {
  /** Generational cohort (gen_z|millennial|gen_x|boomer|silent|unknown). Loosely typed to keep
   *  this module import-free (the cohort is resolved upstream via cohortFromEnrichment). */
  cohort?: string | null
  /** The contact/lead's stated timeline (free-text or enum, e.g. "0-3 months", "12+ months",
   *  "just browsing"). Drives how SOON they plan to act → how often we touch. */
  timeline?: string | null
}

export interface CadenceProfile {
  /** Multiplier applied to Phase-2/Phase-3 base spacing. <1 = tighter (more urgent), >1 = wider. */
  spacingMultiplier: number
  /** Honest WHY (for audit + the simulator). */
  reason: string
}

/** timelineUrgencyMultiplier — PURE. How SOON the person plans to act drives how often we touch:
 *  a 0–3-month buyer is spaced ~40% tighter; a "someday"/"just browsing" lead ~50% wider. */
export function timelineUrgencyMultiplier(timeline?: string | null): number {
  const t = (timeline ?? "").toLowerCase().trim()
  if (!t) return 1.0
  if (/(asap|immediate|ready now|0-3|0–3|under 3|1-3|this month|within (a )?month)/.test(t)) return 0.6
  if (/(someday|browsing|just looking|no rush|not sure|exploring|undecided|2\+ ?year)/.test(t)) return 1.5
  if (/(12\+|1-2 ?year|1–2 ?year|over a year|next year|12 ?months|long ?term)/.test(t)) return 1.3
  if (/(3-6|3–6|next few months|few months|this year)/.test(t)) return 0.8
  if (/(6-12|6–12|6 ?months|end of year)/.test(t)) return 1.0
  return 1.0
}

/** cohortCadenceMultiplier — PURE. Generational pacing psychology (frequency tolerance ONLY —
 *  no content, no protected-class treatment): younger cohorts tolerate (and expect) more
 *  frequent, lighter touches; older cohorts convert better on fewer, more spaced contacts. */
export function cohortCadenceMultiplier(cohort?: string | null): number {
  switch ((cohort ?? "").toLowerCase()) {
    case "gen_z": return 0.85
    case "millennial": return 0.9
    case "gen_x": return 1.0
    case "boomer": return 1.15
    case "silent": return 1.25
    default: return 1.0
  }
}

/** cadenceProfileFor — PURE. Blend timeline-urgency (dominant) with generational pacing into a
 *  single spacing multiplier, clamped to [0.5, 2.0]. Default (no signals) ⇒ 1.0 ⇒ unchanged. */
export function cadenceProfileFor(input: CadenceProfileInput): CadenceProfile {
  const urg = timelineUrgencyMultiplier(input.timeline)
  const age = cohortCadenceMultiplier(input.cohort)
  const raw = urg * age
  const spacingMultiplier = Math.min(CADENCE_MULTIPLIER_MAX, Math.max(CADENCE_MULTIPLIER_MIN, raw))
  const reason =
    `timeline×${urg.toFixed(2)} · cohort(${input.cohort ?? "unknown"})×${age.toFixed(2)}` +
    (raw !== spacingMultiplier ? ` · clamped→${spacingMultiplier}` : "")
  return { spacingMultiplier, reason }
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
  /** How many re-engagement touches have already been sent. At/above the active-cadence
   *  ceiling (DEFAULT_MAX_GHOST_ATTEMPTS) the loop is in the long-horizon SEASONAL phase
   *  (quarterly spacing) regardless of calendar window. Omitted/0 → active cadence. */
  attempts?: number | null
  /** OPTIONAL persona/age/urgency cadence profile (from cadenceProfileFor). Scales the
   *  Phase-2/Phase-3 spacing thresholds so the WHEN fits the human. Omitted ⇒ multiplier 1.0
   *  ⇒ the canonical spacing, unchanged. Phase-1 (warm Mon/Wed/Fri) is never tuned. */
  profile?: CadenceProfile | null
}

export interface CadenceDecision {
  shouldSend: boolean
  /** 1 = fresh window (≤14d, Mon/Wed/Fri), 2 = long-haul (every 30d), 3 = seasonal (every 90d). */
  phase: 1 | 2 | 3
  /** Whole days since the cadence phase started (first outreach, or 0 on day one). */
  daysSinceStart: number
  /** Honest WHY for the decision (for audit + the simulator). */
  reason:
    | "phase1_send_day"
    | "phase1_off_day"
    | "phase2_first_send"
    | "phase2_due"
    | "phase2_too_soon"
    | "phase3_first_send"
    | "phase3_due"
    | "phase3_too_soon"
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

  // Persona/age/urgency tuning — scales ONLY the long-haul spacing thresholds. Omitted ⇒ 1.0.
  const mult = input.profile?.spacingMultiplier ?? 1
  const phase2Spacing = Math.max(1, Math.round(PHASE2_SPACING_DAYS * mult))
  const phase3Spacing = Math.max(1, Math.round(PHASE3_SPACING_DAYS * mult))

  // PHASE 3 — long-horizon seasonal nurture. Once the aggressive cadence ceiling is hit the
  // loop spaces touches a QUARTER apart (a light value-touch), so the agent stays top-of-mind
  // for the months/years a real-estate decision can take instead of going silent.
  const inSeasonal = (input.attempts ?? 0) >= DEFAULT_MAX_GHOST_ATTEMPTS
  if (inSeasonal) {
    const lastMs = toMs(input.lastSentAt)
    if (lastMs === null) {
      return { shouldSend: true, phase: 3, daysSinceStart, reason: "phase3_first_send" }
    }
    const daysSinceLast = Math.floor((nowMs - lastMs) / DAY_MS)
    const due = daysSinceLast >= phase3Spacing
    return { shouldSend: due, phase: 3, daysSinceStart, reason: due ? "phase3_due" : "phase3_too_soon" }
  }

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
  const due = daysSinceLast >= phase2Spacing
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
/**
 * contacts.status values that make a contact NON-ENGAGEABLE by the ISA.
 *
 * 'do_not_contact' was the only one this predicate knew about, and that was a
 * MEASURED gap rather than a judgement: two hand-rolled copies of the same
 * stale-contact query — app/api/cron/stale-contact-monitor/route.ts and
 * app/dashboard/stale/actions.ts — each excluded 'archived' and 'inactive' at
 * the query, and this predicate (the declared single source of truth) did not.
 * So the canonical detector would have re-engaged an archived contact that both
 * inline copies correctly skipped. Collapsing those copies into the detector
 * therefore had to bring their exclusions WITH them, not drop them.
 *
 * Exported so the detector can pre-filter at the query for efficiency and still
 * be checked against the SAME list post-fetch — one vocabulary, two uses.
 *
 * 'do_not_contact' REMOVED 2026-08-31 (§1.1 merge — SURVIVOR: the dnc_status
 * boolean, which staleContactEligibility below already hard-stops on BEFORE this
 * list is consulted, and which every writer of the DNC fact actually sets).
 * No writer has ever stored 'do_not_contact' on contacts.status — the member
 * matched nothing — and m587 (pending apply) puts a CHECK behind the column
 * that does not admit it, so keeping it would be a permanently-dead spelling.
 * Not folded into 'inactive' here: this list is the STATUS half of the gate,
 * and DNC is a compliance rail, not a lifecycle state. Vocabulary:
 * lib/contact-promotion/qualification.ts CONTACT_STATUSES / TERMINAL_CONTACT_STATUSES
 * ('deleted' is deliberately absent from THIS list because both detectors
 * already gate on `deleted_at`).
 */
export const NON_ENGAGEABLE_CONTACT_STATUSES = ["archived", "inactive"] as const

export interface StaleEligibilityInput {
  last_contacted_at: string | null
  dnc_status: boolean | null
  ai_outreach_paused: boolean | null
  isa_reengage_allowed: boolean | null
  status: string | null
  deleted_at: string | null
  /** True when the contact has an open transaction (active/under_contract/closing/pending). */
  hasActiveTransaction: boolean
  /** True for a lifetime / past client (the detector resolves it via contact_type). When set, the
   *  long-horizon LIFETIME_STALE_DAYS threshold applies instead of the active-contact staleDays. */
  is_lifetime?: boolean
  /** contacts.agent_id — the assigned agent, or null. */
  agent_id?: string | null
}

export type StaleIneligibleReason =
  | "dnc"
  | "outreach_paused"
  | "reengage_disallowed"
  | "do_not_contact_status"
  | "deleted"
  | "active_transaction"
  | "unassigned"
  | "not_yet_stale"

export interface StaleEligibilityResult {
  /** May the ISA AUTO-SEND to this contact? Every exclusion applies. */
  eligible: boolean
  reason: StaleIneligibleReason | "stale"
  daysSinceContact: number
  /**
   * Is this contact DORMANT — past the threshold and not hard-blocked — REGARDLESS
   * of whether the ISA switch is on?
   *
   * `eligible` and `dormant` differ on exactly two inputs: ai_outreach_paused and
   * isa_reengage_allowed. That is a deliberate split, not a convenience. An
   * automated sender must key on `eligible`; an AGENT-FACING console must key on
   * `dormant`, because a contact whose ISA switch is OFF still needs to appear in
   * the agent's dormant list — turning the switch back ON is only possible from a
   * row the agent can still see. app/dashboard/stale/actions.ts held that
   * behaviour in its own hand-written query (it never filtered those two flags and
   * its UI badges such rows "ISA off"); folding that query into the canonical
   * detector required bringing the behaviour with it, or a paused contact would
   * have silently become invisible and therefore unrecoverable.
   *
   * A hard stop — DNC, do-not-contact status, deleted, an open transaction, or
   * unassigned when the caller requires an agent — clears BOTH.
   */
  dormant: boolean
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
  opts: { now: Date; staleDays?: number; requireAssignedAgent?: boolean },
): StaleEligibilityResult {
  // Lifetime/past clients are long-horizon — only stale after the longer LIFETIME_STALE_DAYS, so the
  // generic re-engagement stays a light quarterly-ish touch (newsletter + situational triggers lead).
  const staleDays = c.is_lifetime ? LIFETIME_STALE_DAYS : (opts.staleDays ?? DEFAULT_STALE_DAYS)
  const lastMs = toMs(c.last_contacted_at)
  const daysSinceContact = lastMs === null ? 999 : Math.floor((opts.now.getTime() - lastMs) / DAY_MS)

  // ── HARD STOPS — these clear `dormant` as well as `eligible`. No surface, human
  //    or automated, should present these as re-engageable dormancy. ──
  const hard = (reason: StaleIneligibleReason): StaleEligibilityResult =>
    ({ eligible: false, reason, daysSinceContact, dormant: false })

  if (c.dnc_status === true) return hard("dnc")
  if ((NON_ENGAGEABLE_CONTACT_STATUSES as readonly string[]).includes(String(c.status ?? ""))) {
    return hard("do_not_contact_status")
  }
  if (c.deleted_at !== null) return hard("deleted")
  if (c.hasActiveTransaction) return hard("active_transaction")
  // AN UNASSIGNED CONTACT CANNOT BE ENGAGED, so detecting one wastes the batch.
  // initiateAIISAContactEngagement refuses it outright ("Contact not yet assigned
  // to agent") and engageContact's portal touch needs agent_id (NOT NULL on
  // client_portal_messages). The cron copy encoded this as `.not('agent_id','is',null)`;
  // it is opt-IN here because the per-agent dashboard read is already scoped to
  // one agent and the ISA console legitimately wants to SEE unassigned dormancy.
  if (opts.requireAssignedAgent && !c.agent_id) return hard("unassigned")
  if (daysSinceContact < staleDays) return hard("not_yet_stale")

  // ── THE ISA SWITCH — blocks the SEND, not the LISTING. See `dormant` above. ──
  if (c.ai_outreach_paused === true) {
    return { eligible: false, reason: "outreach_paused", daysSinceContact, dormant: true }
  }
  if (c.isa_reengage_allowed === false) {
    return { eligible: false, reason: "reengage_disallowed", daysSinceContact, dormant: true }
  }

  return { eligible: true, reason: "stale", daysSinceContact, dormant: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. RESURRECTION — a reply re-arms a wound-down lead (the round-trip back to active)
// ─────────────────────────────────────────────────────────────────────────────

/** The SILENCE-driven wind-down states. A non-negative inbound reply re-arms ONLY these
 *  (a reply = signs of life) — it must NEVER resurrect a CONSENT stop (opted_out) or a
 *  conversion/representation ('completed'), which is why those are deliberately excluded. */
export const REENGAGEMENT_WINDDOWN_STATES = ["long_horizon", "handed_to_sphere"] as const

/**
 * shouldResurrectReengagement — PURE. When a lead the ISA had wound down (long-horizon
 * seasonal nurture, or handed to the Sphere) REPLIES non-negatively, the ISA reclaims it
 * into the active cadence — the lead is warm again. Consent stops are never resurrected.
 */
export function shouldResurrectReengagement(prevStatus: string | null | undefined): boolean {
  return !!prevStatus && (REENGAGEMENT_WINDDOWN_STATES as readonly string[]).includes(prevStatus)
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. COLD-CONTACT CHECKPOINT — the CONTACT-side analog of the lead exhausted→escalate.
//    A converted buyer/seller the ISA auto-re-engages repeatedly with NO reply is "cold":
//    the automation keeps nurturing (de-confliction caps the cadence) but the OWNING AGENT
//    must be told ONCE so a human can make the personal call the AI can't. Without this the
//    contact-side loop auto-touches a cold relationship forever with no human checkpoint.
// ─────────────────────────────────────────────────────────────────────────────

/** Consecutive no-reply ISA re-engagement touches that mean a CONTACT has gone cold and the
 *  owning agent should be looped in for a personal touch (≈ months of unanswered nurture). */
export const COLD_CONTACT_TOUCHES = 5

/**
 * coldContactReengagementCheck — PURE. Given how many ISA re-engagement touches a contact has
 * received with NO reply, decide whether the owning agent should be escalated (once). The
 * automation is NOT stopped — like the lead-side long-horizon, it keeps nurturing; this only
 * adds the human checkpoint the contact-side was missing.
 */
export function coldContactReengagementCheck(
  noReplyTouches: number,
  opts?: { coldTouches?: number },
): { isCold: boolean } {
  const threshold = opts?.coldTouches ?? COLD_CONTACT_TOUCHES
  return { isCold: (noReplyTouches ?? 0) >= threshold }
}

/** resolveStaleThreshold — PURE. Reads a brokerage's isa_ghost_threshold_days setting,
 *  honestly falling back to the default when unset/invalid. */
export function resolveStaleThreshold(setting: unknown, fallback = DEFAULT_STALE_DAYS): number {
  return typeof setting === "number" && Number.isFinite(setting) && setting > 0 ? setting : fallback
}
