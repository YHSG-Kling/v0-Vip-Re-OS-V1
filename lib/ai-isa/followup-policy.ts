// lib/ai-isa/followup-policy.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE FOLLOW-UP POLICY — the ONE place a follow-up number lives (wave 143, lane 143E).
//
// OWNER RULING (wave 143): "Follow-up/touchpoints must NOT be hard-coded: managers check intent and
// determine the proper follow-up … The follow-up timetable must not depend on code — autonomous AI,
// 'AI always listening', so customers feel an agent is always helping."
//
// WHAT THIS MODULE IS. Before it, the follow-up timetable was spread over code literals that no tenant
// could see, edit or version:
//   · lib/ai-isa/lead-action-plan.ts      NBA_FATIGUE_HOURS 48 / NBA_QUIET_HOURS 8-21 / NBA_AGENT_ACTIVE_DAYS 7
//   · lib/ai-isa/reengagement-policy.ts   Mon/Wed/Fri phase 1, 14d window, 30d + 90d spacing, 14/60/21d staleness
//   · lib/kernel/lifetime-conversion.ts   POST_CLOSE_TOUCHPOINTS 3d video / 30d sms / 6mo email / 1yr video / 18mo sms
//   · lib/sphere/next-best-actions.ts     14d / 14d / 21d / 90d signal windows
//   · lib/ai-isa/voice-dial-batch.ts      CALL_COOLDOWN_DAYS 14 / COLD_COOLDOWN_DAYS 30 (the ISA's re-dial gap)
// They are now ONE typed policy, stored at brokerage_settings.settings.followup_policy (registered in
// lib/kernel/tenant-policy.ts TENANT_POLICY_SETTINGS_KEYS, so every change is an immutable, revertible
// tenant_policy_versions row and the key is promotable through a Manager-Trust policy proposal).
//
// WHAT THE NUMBERS ARE NOW. NOT a schedule the code executes. They are
//   · GUARDRAILS the deterministic gates enforce (fatigue floor, quiet hours, agent-handling window) —
//     the legal / consent / delivery limits that stay deterministic; and
//   · the ENVELOPE inside which the arbiter (lib/ai-isa/followup-arbiter.ts) reasons about intent,
//     history, engagement, relationship, urgency and preference to decide WHETHER, WHEN and HOW to
//     follow up (email / SMS / task / property or market info / on-the-fly avatar video / education /
//     route to a human / wait). Platform defaults are the historical literals, so a tenant that never
//     sets the policy behaves exactly as before; the model is told they are defaults, not orders.
//
// LEGAL FLOORS (never loosened by a tenant): the send window may only be NARROWED inside 8am-9pm local
// (47 CFR 64.1200(c)(1) — the same window lib/communication/call-compliance.ts checkQuietHours holds).
//
// PURE module (no server-only, no I/O except the injected-client loader) — driven directly by
// scripts/intent-driven-followup-guard.ts.

export const FOLLOWUP_POLICY_KEY = "followup_policy"

/** The legal send-window floor. A tenant narrows inside it; widening is clamped and reported. */
export const LEGAL_SEND_WINDOW = Object.freeze({ startHour: 8, endHour: 21 })

export type MomentChannel = "video" | "sms" | "email"

/**
 * The touchpoint types a moment may carry — a SUBSET of the live lifetime_customer_touchpoints.touchpoint_type CHECK
 * (scripts/check-vocabularies.ts; the guard asserts the subset). A key outside it would make the whole schedule insert
 * (lib/kernel/lifetime-conversion.ts writes every moment in ONE statement) fail with 23514, so the policy refuses it at read.
 * @proofSeam exported so scripts/intent-driven-followup-guard.ts asserts this list stays a subset of the live touchpoint_type CHECK (scripts/check-vocabularies.ts).
 */
export const MOMENT_TOUCHPOINT_TYPES: readonly string[] = ["post_close_3_day", "post_close_30_day", "post_close_6_month", "home_anniversary", "referral_request", "thank_you", "market_update", "holiday", "custom"]

export interface FollowupMoment {
  /** The `lifetime_customer_touchpoints.touchpoint_type` this moment opens (the vocabulary the rows carry). */
  key: string
  /** Days after the verified closing the moment OPENS — the earliest the arbiter may act, never an order. */
  afterClosingDays: number
  /** The channel the platform default would use; the arbiter may choose another permitted one. */
  defaultChannel: MomentChannel
  /** What this moment is FOR (the arbiter reasons over it; it is not the message). */
  intent: string
}

export interface FollowupPolicy {
  /** The tenant's follow-up philosophy in their own words — read by the arbiter, never parsed. */
  guidance: string
  guardrails: {
    /** Fatigue floor: no new automated touch within this many hours of ANY touch. */
    minHoursBetweenTouches: number
    /** Local-hour window a touch may be released in (narrow only — LEGAL_SEND_WINDOW is the outer edge). */
    quietHours: { startHour: number; endHour: number }
    /** An agent touch inside this many days means a human is actively handling the person. */
    agentActiveDays: number
    /** AI ISA voice (lib/ai-isa/voice-dial-batch.ts): no re-dial PROPOSAL inside this many days of ANY ISA call to the person. */
    callCooldownDays: number
    /** …and after a cold-quality call (the call told us they are not ready) this many days. */
    coldCallCooldownDays: number
  }
  reengagement: {
    staleDays: number
    lifetimeStaleDays: number
    ghostedDays: number
    phase1WindowDays: number
    /** getDay(): 0=Sun … 6=Sat. */
    phase1SendWeekdays: number[]
    phase2SpacingDays: number
    phase3SpacingDays: number
    maxGhostAttempts: number
    maxHorizonAttempts: number
  }
  sphere: {
    lifeEventWindowDays: number
    valueCheckWindowDays: number
    anniversaryLookaheadDays: number
    goneQuietDays: number
  }
  /** Long-term nurture (lib/ai-isa/long-term-nurture.ts): leads who said "not now". */
  nurture: {
    /** A re-activation signal counts for this many days. */
    signalWindowDays: number
    /** A nurture lead is not re-enrolled inside this many days of its last enrollment (the "monthly" envelope). */
    enrollmentSpacingDays: number
    /** A fresh signal wakes the ISA only when the lead's score is at or above this. */
    reactivationScoreThreshold: number
  }
  postClose: FollowupMoment[]
  arbiter: {
    /** false = the deterministic planner's verdict stands (no model call, no spend). */
    enabled: boolean
    /** Model decisions one sweep may spend; the rest keep the deterministic verdict, stated. */
    maxDecisionsPerRun: number
    /** The longest the arbiter may postpone a moment / cadence send. */
    maxDeferDays: number
    /** A model reply below this confidence keeps the planner's verdict (0..1). */
    minConfidence: number
  }
}

/** The platform defaults — the historical literals, moved here unchanged. */
export const DEFAULT_FOLLOWUP_POLICY: FollowupPolicy = Object.freeze({
  guidance: "",
  guardrails: Object.freeze({
    minHoursBetweenTouches: 48,
    quietHours: Object.freeze({ startHour: LEGAL_SEND_WINDOW.startHour, endHour: LEGAL_SEND_WINDOW.endHour }),
    agentActiveDays: 7,
    callCooldownDays: 14,
    coldCallCooldownDays: 30,
  }),
  reengagement: Object.freeze({
    staleDays: 14,
    lifetimeStaleDays: 60,
    ghostedDays: 21,
    phase1WindowDays: 14,
    phase1SendWeekdays: Object.freeze([1, 3, 5]) as unknown as number[],
    phase2SpacingDays: 30,
    phase3SpacingDays: 90,
    maxGhostAttempts: 9,
    maxHorizonAttempts: 13,
  }),
  sphere: Object.freeze({ lifeEventWindowDays: 14, valueCheckWindowDays: 14, anniversaryLookaheadDays: 21, goneQuietDays: 90 }),
  nurture: Object.freeze({ signalWindowDays: 7, enrollmentSpacingDays: 25, reactivationScoreThreshold: 65 }),
  postClose: Object.freeze([
    Object.freeze({ key: "post_close_3_day", afterClosingDays: 3, defaultChannel: "video", intent: "The first days in the new home: see that the move-in went well and that nothing is blocking them; offer practical help (utilities, vendors, questions about the closing documents)." }),
    Object.freeze({ key: "post_close_30_day", afterClosingDays: 30, defaultChannel: "sms", intent: "Settled-in check: ask how the home and the process felt, invite honest feedback, offer a local resource or vendor if they need one." }),
    Object.freeze({ key: "post_close_6_month", afterClosingDays: 180, defaultChannel: "email", intent: "Half-year check-in: stay genuinely in touch with something useful about their neighborhood or home value; no ask." }),
    Object.freeze({ key: "home_anniversary", afterClosingDays: 365, defaultChannel: "video", intent: "One year in the home: celebrate the milestone and share what has happened to their equity and neighborhood." }),
    Object.freeze({ key: "referral_request", afterClosingDays: 540, defaultChannel: "sms", intent: "When the relationship is warm: invite introductions to friends or family who are thinking about a move, without pressure." }),
  ]) as unknown as FollowupMoment[],
  arbiter: Object.freeze({ enabled: true, maxDecisionsPerRun: 25, maxDeferDays: 7, minConfidence: 0.35 }),
}) as FollowupPolicy

// ── parse / clamp ────────────────────────────────────────────────────────────────────────────

export interface ResolvedFollowupPolicy {
  policy: FollowupPolicy
  /** Every field the stored value had wrong and what was done — published, never silent. */
  adjustments: string[]
  /** Where the effective values came from. */
  source: string
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v)

function int(raw: unknown, def: number, min: number, max: number, name: string, adj: string[]): number {
  if (raw === undefined || raw === null) return def
  if (typeof raw !== "number" || !Number.isFinite(raw)) { adj.push(`${name}: not a number — default ${def} used`); return def }
  const n = Math.round(raw)
  if (n < min || n > max) { const c = Math.min(max, Math.max(min, n)); adj.push(`${name}: ${n} outside ${min}..${max} — clamped to ${c}`); return c }
  return n
}

function num01(raw: unknown, def: number, name: string, adj: string[]): number {
  if (raw === undefined || raw === null) return def
  if (typeof raw !== "number" || !Number.isFinite(raw)) { adj.push(`${name}: not a number — default ${def} used`); return def }
  if (raw < 0 || raw > 1) { const c = Math.min(1, Math.max(0, raw)); adj.push(`${name}: ${raw} outside 0..1 — clamped to ${c}`); return c }
  return raw
}

/** PURE. Any stored shape → a complete, clamped policy. Absent / malformed fields take the platform default. */
export function resolveFollowupPolicy(stored: unknown, source = "brokerage_settings.settings.followup_policy"): ResolvedFollowupPolicy {
  const D = DEFAULT_FOLLOWUP_POLICY
  const adj: string[] = []
  if (stored === undefined || stored === null) return { policy: clonePolicy(D), adjustments: adj, source: "platform default (never set)" }
  if (!isObj(stored)) return { policy: clonePolicy(D), adjustments: ["followup_policy is not an object — platform default used"], source }
  const g = isObj(stored.guardrails) ? stored.guardrails : {}
  const q = isObj(g.quietHours) ? g.quietHours : {}
  let startHour = int(q.startHour, D.guardrails.quietHours.startHour, 0, 23, "guardrails.quietHours.startHour", adj)
  let endHour = int(q.endHour, D.guardrails.quietHours.endHour, 1, 24, "guardrails.quietHours.endHour", adj)
  if (startHour < LEGAL_SEND_WINDOW.startHour) { adj.push(`guardrails.quietHours.startHour: ${startHour} is earlier than the legal floor ${LEGAL_SEND_WINDOW.startHour} — clamped`); startHour = LEGAL_SEND_WINDOW.startHour }
  if (endHour > LEGAL_SEND_WINDOW.endHour) { adj.push(`guardrails.quietHours.endHour: ${endHour} is later than the legal ceiling ${LEGAL_SEND_WINDOW.endHour} — clamped`); endHour = LEGAL_SEND_WINDOW.endHour }
  if (endHour <= startHour) { adj.push("guardrails.quietHours: empty window — platform window used"); startHour = LEGAL_SEND_WINDOW.startHour; endHour = LEGAL_SEND_WINDOW.endHour }
  const r = isObj(stored.reengagement) ? stored.reengagement : {}
  const s = isObj(stored.sphere) ? stored.sphere : {}
  const a = isObj(stored.arbiter) ? stored.arbiter : {}
  const nu = isObj(stored.nurture) ? stored.nurture : {}
  const weekdays = Array.isArray(r.phase1SendWeekdays)
    ? Array.from(new Set((r.phase1SendWeekdays as unknown[]).filter((d): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)))
    : null
  if (Array.isArray(r.phase1SendWeekdays) && (weekdays?.length ?? 0) === 0) adj.push("reengagement.phase1SendWeekdays: no valid weekday — default used")
  const postClose = resolveMoments(stored.postClose, adj)
  const guidance = typeof stored.guidance === "string" ? stored.guidance.trim().slice(0, 2000) : ""
  if (typeof stored.guidance === "string" && stored.guidance.trim().length > 2000) adj.push("guidance: truncated to 2000 characters")
  const policy: FollowupPolicy = {
    guidance,
    guardrails: {
      minHoursBetweenTouches: int(g.minHoursBetweenTouches, D.guardrails.minHoursBetweenTouches, 1, 24 * 30, "guardrails.minHoursBetweenTouches", adj),
      quietHours: { startHour, endHour },
      agentActiveDays: int(g.agentActiveDays, D.guardrails.agentActiveDays, 0, 90, "guardrails.agentActiveDays", adj),
      // A re-dial gap of zero would switch the call cooldown off — like the fatigue floor, a tenant can shorten it, never remove it.
      callCooldownDays: int(g.callCooldownDays, D.guardrails.callCooldownDays, 1, 180, "guardrails.callCooldownDays", adj),
      coldCallCooldownDays: int(g.coldCallCooldownDays, D.guardrails.coldCallCooldownDays, 1, 365, "guardrails.coldCallCooldownDays", adj),
    },
    reengagement: {
      staleDays: int(r.staleDays, D.reengagement.staleDays, 1, 365, "reengagement.staleDays", adj),
      lifetimeStaleDays: int(r.lifetimeStaleDays, D.reengagement.lifetimeStaleDays, 1, 730, "reengagement.lifetimeStaleDays", adj),
      ghostedDays: int(r.ghostedDays, D.reengagement.ghostedDays, 1, 365, "reengagement.ghostedDays", adj),
      phase1WindowDays: int(r.phase1WindowDays, D.reengagement.phase1WindowDays, 1, 120, "reengagement.phase1WindowDays", adj),
      phase1SendWeekdays: weekdays && weekdays.length > 0 ? weekdays.sort((x, y) => x - y) : [...D.reengagement.phase1SendWeekdays],
      phase2SpacingDays: int(r.phase2SpacingDays, D.reengagement.phase2SpacingDays, 1, 365, "reengagement.phase2SpacingDays", adj),
      phase3SpacingDays: int(r.phase3SpacingDays, D.reengagement.phase3SpacingDays, 1, 730, "reengagement.phase3SpacingDays", adj),
      maxGhostAttempts: int(r.maxGhostAttempts, D.reengagement.maxGhostAttempts, 1, 60, "reengagement.maxGhostAttempts", adj),
      maxHorizonAttempts: int(r.maxHorizonAttempts, D.reengagement.maxHorizonAttempts, 1, 120, "reengagement.maxHorizonAttempts", adj),
    },
    sphere: {
      lifeEventWindowDays: int(s.lifeEventWindowDays, D.sphere.lifeEventWindowDays, 1, 365, "sphere.lifeEventWindowDays", adj),
      valueCheckWindowDays: int(s.valueCheckWindowDays, D.sphere.valueCheckWindowDays, 1, 365, "sphere.valueCheckWindowDays", adj),
      anniversaryLookaheadDays: int(s.anniversaryLookaheadDays, D.sphere.anniversaryLookaheadDays, 1, 120, "sphere.anniversaryLookaheadDays", adj),
      goneQuietDays: int(s.goneQuietDays, D.sphere.goneQuietDays, 1, 730, "sphere.goneQuietDays", adj),
    },
    nurture: {
      signalWindowDays: int(nu.signalWindowDays, D.nurture.signalWindowDays, 1, 90, "nurture.signalWindowDays", adj),
      enrollmentSpacingDays: int(nu.enrollmentSpacingDays, D.nurture.enrollmentSpacingDays, 1, 365, "nurture.enrollmentSpacingDays", adj),
      reactivationScoreThreshold: int(nu.reactivationScoreThreshold, D.nurture.reactivationScoreThreshold, 1, 100, "nurture.reactivationScoreThreshold", adj),
    },
    postClose,
    arbiter: {
      enabled: typeof a.enabled === "boolean" ? a.enabled : D.arbiter.enabled,
      maxDecisionsPerRun: int(a.maxDecisionsPerRun, D.arbiter.maxDecisionsPerRun, 0, 500, "arbiter.maxDecisionsPerRun", adj),
      maxDeferDays: int(a.maxDeferDays, D.arbiter.maxDeferDays, 0, 60, "arbiter.maxDeferDays", adj),
      minConfidence: num01(a.minConfidence, D.arbiter.minConfidence, "arbiter.minConfidence", adj),
    },
  }
  return { policy, adjustments: adj, source }
}

function resolveMoments(raw: unknown, adj: string[]): FollowupMoment[] {
  if (raw === undefined || raw === null) return DEFAULT_FOLLOWUP_POLICY.postClose.map((m) => ({ ...m }))
  if (!Array.isArray(raw)) { adj.push("postClose: not a list — platform moments used"); return DEFAULT_FOLLOWUP_POLICY.postClose.map((m) => ({ ...m })) }
  const out: FollowupMoment[] = []
  const seen = new Set<string>()
  for (const [i, m] of raw.entries()) {
    if (!isObj(m) || typeof m.key !== "string" || !MOMENT_TOUCHPOINT_TYPES.includes(m.key) || seen.has(m.key)) { adj.push(`postClose[${i}]: key is not a storable touchpoint type, or duplicate — dropped`); continue }
    const days = typeof m.afterClosingDays === "number" && Number.isFinite(m.afterClosingDays) ? Math.round(m.afterClosingDays) : NaN
    if (!(days >= 0 && days <= 3650)) { adj.push(`postClose[${i}] (${m.key}): afterClosingDays outside 0..3650 — dropped`); continue }
    const channel: MomentChannel = m.defaultChannel === "video" || m.defaultChannel === "sms" || m.defaultChannel === "email" ? m.defaultChannel : "email"
    const intent = typeof m.intent === "string" && m.intent.trim() ? m.intent.trim().slice(0, 600) : "Stay genuinely in touch with something useful to this person."
    seen.add(m.key)
    out.push({ key: m.key, afterClosingDays: days, defaultChannel: channel, intent })
  }
  return out.sort((x, y) => x.afterClosingDays - y.afterClosingDays)
}

function clonePolicy(p: FollowupPolicy): FollowupPolicy {
  return {
    guidance: p.guidance,
    guardrails: { ...p.guardrails, quietHours: { ...p.guardrails.quietHours } },
    reengagement: { ...p.reengagement, phase1SendWeekdays: [...p.reengagement.phase1SendWeekdays] },
    sphere: { ...p.sphere },
    nurture: { ...p.nurture },
    postClose: p.postClose.map((m) => ({ ...m })),
    arbiter: { ...p.arbiter },
  }
}

/** The policy a caller holds when it never loaded one (pure functions keep their historical behaviour). */
export function platformFollowupPolicy(): FollowupPolicy { return clonePolicy(DEFAULT_FOLLOWUP_POLICY) }

type Client = { from: (table: string) => any }

/**
 * The ONE read of the policy. A refused read is SAID in `source` and the platform default applies —
 * the defaults carry the legal send window and the fatigue floor, so a failed read can never widen a limit.
 */
export async function loadFollowupPolicy(svc: Client, brokerageId: string): Promise<ResolvedFollowupPolicy> {
  if (!brokerageId) return { policy: platformFollowupPolicy(), adjustments: [], source: "no brokerage — platform default" }
  const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error) return { policy: platformFollowupPolicy(), adjustments: [], source: `brokerage_settings read refused (${error.message}) — platform default applied (legal floors intact)` }
  const settings = (data as { settings?: unknown } | null)?.settings
  const stored = isObj(settings) ? settings[FOLLOWUP_POLICY_KEY] : undefined
  return resolveFollowupPolicy(stored, data ? "brokerage_settings.settings.followup_policy" : "no brokerage_settings row — platform default")
}

/** PURE. The moment a touchpoint row belongs to (unknown custom rows get a generic intent, never a throw). */
export function momentForTouchpointType(policy: FollowupPolicy, touchpointType: string): FollowupMoment {
  return policy.postClose.find((m) => m.key === touchpointType)
    ?? { key: touchpointType, afterClosingDays: 0, defaultChannel: "email", intent: "Stay genuinely in touch with something useful to this person." }
}
