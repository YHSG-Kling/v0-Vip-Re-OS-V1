// lib/ai-isa/lead-action-plan.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE LEAD ACTION PLAN — pre-conversion, ISA-owned, keyed on a **LEAD**.
//
// OWNER RULING (2026-08-25), verbatim:
//
//   "make sure that there are automatic action plans for just leads which i
//    belive we built for emails and direct mail and video emails which brokerage
//    settings are use so the ai isa will automatically send. also ... we only
//    sent content to leads and contacts that are personalized and situation,
//    them first messaging."
//
// ── THIS IS NOT THE AGENT ACTION PLAN ───────────────────────────────────────
// lib/agent-orchestration/action-plan-generator.ts is keyed on a CONTACT and
// fires at conversion, because an agent cannot read a lead at all: live RLS on
// `public.leads` gates on `is_lead_visible_role()`, which admits broker /
// broker_admin / broker_owner / admin / team_lead / the ISA service role /
// platform — and NOT `agent`. This file is the other side of that wall: the ISA
// acting on an UNCONVERTED lead with no agent involved. Neither one calls the
// other and neither one duplicates the other.
//
// ── WHAT WAS ALREADY BUILT, MEASURED BEFORE ANY CODE WAS WRITTEN ────────────
// Every CHANNEL HALF the ruling names already exists. What did not exist was the
// PLAN that sequences them and the GATE that lets a brokerage authorise a send:
//
//   EMAIL          — sender: app/actions/ai-isa/initiate-engagement.ts (email
//                    branch). Scheduled by /api/cron/speed-to-lead, which selects
//                    `first_touched_at IS NULL` inside a 24h window. So it fires
//                    EXACTLY ONCE per lead and then never looks at that lead
//                    again. Touch 2..N had no scheduler at all.
//   VIDEO EMAIL    — producer: the lead_creative_handoff play (ISA → Asset
//                    Manager → commissionVideo, compliance-first) whose completion
//                    reaches lib/kernel/manager-signals.ts
//                    `campaign_orchestrator:lead_outreach_ready`, which writes an
//                    `agent_client_messages` row at status='proposed'. NOTHING
//                    could ever release it: there is no auto-send path for a lead
//                    proposal, so the first-touch email's own promise —
//                    "[Note: Personalized video intro is being prepared and will
//                    be sent shortly]" — was kept only if a human happened to
//                    approve. /api/cron/intro-video-email-backfill is the
//                    CONTACT-side backfill (trigger='contact_agent_assigned',
//                    joins `contacts`); it never sees a lead.
//   DIRECT MAIL    — two halves. The welcome-kit LETTER auto-sends inline from the
//                    email branch (triggerDirectMailCampaign). The persona
//                    POSTCARD is staged GATED by proposeLeadIntroPostcard and,
//                    like the video email, had no release path.
//
//   THE SETTINGS GATE — `ai_isa_settings.require_broker_approval` (BOOLEAN NOT
//                    NULL DEFAULT TRUE since migration 061) was named in
//                    resolve-isa-settings.ts's SELECT list and then DROPPED by
//                    `rowToSettings`, which folded only `settings` + `is_active`.
//                    Zero readers acted on it; zero writers set it. The one
//                    switch a broker would look for before letting an AI mail
//                    their leads reached no decision anywhere in the tree. Both
//                    halves are built now (§1 case 2) — on the EXISTING resolver,
//                    not a second one (§6).
//
// ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
// A PLAN and a GOVERNOR, no new sender and no second sequencer:
//
//   · `leadAutoSendVerdict`  — PURE. The settings gate: auto-send, or stage for a
//                              human. Mutation-tested by
//                              scripts/lead-action-plan-simulator.ts.
//   · `planNextLeadTouch`    — PURE. Which of the three named channels is due
//                              next, and when — from the settings the broker
//                              actually set (`max_touches_lead`,
//                              `touch_interval_days`, `lead_allowed_channels`,
//                              `blocked_lifecycle_states`).
//   · `releaseDueLeadTouches`— the governor. Walks the LEAD-recipient proposals
//                              the existing producers wrote and releases only the
//                              ones the brokerage authorised, through the EXISTING
//                              sender (approveClientMessage), behind the EXISTING
//                              consent gates.
//   · `advanceLeadActionPlans` — the scheduler for touches 2..N. Re-arms the
//                              EXISTING producers via the EXISTING manager signal.
//
// ── FAIL CLOSED, EVERYWHERE (CLAUDE.md §4) ──────────────────────────────────
// An unreadable settings tier does NOT auto-send. A refused lead read does NOT
// auto-send. A refused suppression check does NOT auto-send. Nothing here ever
// renders "we could not check" as "checked and fine" — the touch stays
// `proposed`, which is a human's queue, not a silent drop.
//
// ── CONSENT IS NOT NEGOTIABLE ON THIS PATH ──────────────────────────────────
// These are leads who have consented to NOTHING — which is exactly why they are
// not assigned to agents (CLAUDE.md §5). This file invents no consent rule. It
// composes the ones that already exist: `pickLeadOutreachChannel`
// (lib/ai-isa/lead-channel-policy.ts) for channel eligibility, `checkSuppression`
// (lib/kernel/compliance/check-suppression.ts) for suppression,
// `conversionVerdictForRow` for conversion finality, `checkMaxTouches` for the
// touch cap, and `evaluateOutbound` for the content gate.
//
// NOT server-only: the PURE half is driven directly by the simulator. The async
// half takes an injected client and imports the service client lazily.

import type { AIISASettings, DeadEndOutcome, DeadEndEvidence } from "./settings-types"
import { DEFAULT_AISA_SETTINGS, ALWAYS_TERMINAL_DEAD_ENDS, canonicalDeadEnd, deadEndsFromLeadSources } from "./settings-types"
import { pickLeadOutreachChannel } from "./lead-channel-policy"
import { permittedLeadChannels, decideNextChannel } from "./next-best-touch"
import type { GenerationalCohort } from "@/lib/kernel/education"
import type { DecayedIntent } from "@/lib/lead-intelligence/behavioral-summary"
import type { recordNonAction as recordNonActionType } from "@/lib/kernel/action-ledger"

// ─────────────────────────────────────────────────────────────────────────────
// THE PLAN'S VOCABULARY
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The three channels the ruling names. `video_email` is an EMAIL that carries the
 * lead's persona intro reel — it is NOT a separate transport, and it deliberately
 * is not a new `agent_client_messages.channel` member: the live CHECK admits
 * {portal, portal_push, email, sms, voice_drop, direct_mail} and a reel email is
 * an email. The distinction lives in the PLAN, which is where it means something.
 */
export type LeadPlanChannel = "email" | "video_email" | "direct_mail"

/** What a lead-plan step maps to on the wire. */
export type LeadWireChannel = "email" | "direct_mail"

/** PURE. The transport a plan channel actually rides. */
export function wireChannelFor(channel: LeadPlanChannel): LeadWireChannel {
  return channel === "direct_mail" ? "direct_mail" : "email"
}

export interface LeadPlanStep {
  channel: LeadPlanChannel
  /** 1-based position in the plan. */
  order: number
  /** WHO already builds this touch. Named so nobody writes a second producer. */
  producer: string
  /** The one-word WHY carried onto `agent_client_messages.outreach_reason`. */
  outreachReason: "welcome" | "check_in"
}

/**
 * THE PLAN. Ordered, them-first, and deliberately short: three touches across
 * three channels beats five emails. Every step names the producer that already
 * exists, because the missing piece was never a producer (§1).
 *
 * The ORDER is the them-first order, not a convenience order: the introduction
 * comes first, the personal video second (it earns its place only after an
 * unanswered introduction), and physical mail last (it is the slowest and the
 * most expensive, and it is the only one that still works when the inbox does
 * not).
 */
export const LEAD_PLAN_STEPS: readonly LeadPlanStep[] = [
  {
    channel: "email",
    order: 1,
    producer: "app/actions/ai-isa/initiate-engagement.ts (email branch), scheduled by /api/cron/speed-to-lead",
    outreachReason: "welcome",
  },
  {
    channel: "video_email",
    order: 2,
    producer: "lib/kernel/manager-signals.ts campaign_orchestrator:lead_outreach_ready (reel from asset_manager:lead_creative_handoff)",
    outreachReason: "check_in",
  },
  {
    channel: "direct_mail",
    order: 3,
    producer: "lib/kernel/manager-signals.ts proposeLeadIntroPostcard (asset_manager:lead_creative_handoff, direct-mail half)",
    outreachReason: "check_in",
  },
] as const

// ─────────────────────────────────────────────────────────────────────────────
// THE SETTINGS GATE — PURE
// ─────────────────────────────────────────────────────────────────────────────

export type LeadAutoSendMode = "auto_send" | "stage_for_approval"

export type LeadAutoSendCode =
  | "authorised"
  | "settings_unreadable"
  | "isa_disabled"
  | "broker_approval_required"
  | "channel_not_allowed"

export interface LeadAutoSendVerdict {
  mode: LeadAutoSendMode
  code: LeadAutoSendCode
  reason: string
}

/**
 * The status shape `resolveIsaSettingsResult` answers with, narrowed to what this
 * gate needs. Passing the STATUS (not just the settings) is the whole point:
 * "resolved with these settings" and "we could not read the tier" are different
 * answers, and collapsing them is how a refused query becomes a send.
 */
export type LeadSettingsResolution =
  | { status: "resolved" | "default"; settings: AIISASettings }
  | { status: "unreadable"; detail: string }

/**
 * leadAutoSendVerdict — PURE, and the single decision this whole lane turns on.
 *
 * Extracted so it can be exercised and MUTATION-TESTED without a database: the
 * simulator flips `require_broker_approval` to auto-send anyway and proves the
 * guard goes red. Four ways to be refused, one way to be authorised, and the
 * refusals are ORDERED so the reason a broker sees is the most specific true one.
 *
 * ORDER MATTERS AND IS DELIBERATE:
 *   1. unreadable        — we could not read the policy. Never a send (§4).
 *   2. isa disabled      — the master switch is off; nothing else can override it.
 *   3. approval required — the brokerage wants a human. THE DEFAULT.
 *   4. channel excluded  — the brokerage allows sending, but not on this rail.
 *
 * A refusal is never a DROP. `stage_for_approval` means the drafted touch stays
 * at `agent_client_messages.status='proposed'`, which is a human's approval queue
 * — the broker still gets the work, they just release it themselves.
 */
export function leadAutoSendVerdict(input: {
  resolution: LeadSettingsResolution
  /** The transport this touch rides — the class `lead_allowed_channels` speaks. */
  channel: LeadWireChannel
}): LeadAutoSendVerdict {
  const { resolution, channel } = input

  if (resolution.status === "unreadable") {
    return {
      mode: "stage_for_approval",
      code: "settings_unreadable",
      reason:
        `AI ISA settings could not be read (${resolution.detail}) — staging this lead touch for a human. ` +
        `"Nobody checked" must never render as "checked and fine".`,
    }
  }

  const settings = resolution.settings

  if (settings.enabled === false) {
    return {
      mode: "stage_for_approval",
      code: "isa_disabled",
      reason: "The AI ISA master switch is OFF for this owner — the touch is drafted and staged, never sent.",
    }
  }

  if (settings.require_broker_approval !== false) {
    return {
      mode: "stage_for_approval",
      code: "broker_approval_required",
      reason:
        "This brokerage requires broker approval before the AI ISA sends (ai_isa_settings.require_broker_approval) — " +
        "the touch is staged for a human to release.",
    }
  }

  const allowed = settings.lead_allowed_channels ?? DEFAULT_AISA_SETTINGS.lead_allowed_channels
  if (!allowed.includes(channel)) {
    return {
      mode: "stage_for_approval",
      code: "channel_not_allowed",
      reason: `'${channel}' is not in this owner's lead_allowed_channels (${allowed.join(", ") || "none"}) — staged, not sent.`,
    }
  }

  return {
    mode: "auto_send",
    code: "authorised",
    reason: `Auto-send authorised: the AI ISA is on, broker approval is not required, and '${channel}' is an allowed lead channel.`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PERSONALIZATION FLOOR — PURE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * "we only sent content to leads and contacts that are personalized and
 * situation, them first messaging" is a RULING, not a preference — so generic
 * blast copy on this path is a DEFECT, and the only place it can be caught before
 * it reaches a stranger's inbox is immediately before the send.
 *
 * This is a FLOOR, not a scorer. It asks two things a genuine one-to-one message
 * always satisfies and a blast never does:
 *
 *   1. IT ADDRESSES THEM. The lead's own first name appears in the body.
 *   2. IT KNOWS THEIR SITUATION. At least one fact this lead actually gave us —
 *      what they are looking for, their timeline, their motivation, their city,
 *      or the video that was made for them personally — appears in the body.
 *
 * Deliberately NOT a fair-housing or tone check: `evaluateOutbound` (Gate 4) and
 * the brand prohibited-word screen own those, and a second copy of a compliance
 * rule is the §6 defect. This checks only the thing no other gate checks.
 *
 * Failing it does NOT drop the touch — it DOWNGRADES it to
 * `stage_for_approval`, where a human sees copy that reads like a blast and can
 * fix it. Silently sending it is the outcome the ruling forbids.
 */
export function isPersonalizedForLead(input: {
  body: string
  firstName?: string | null
  situationFacts: Array<string | null | undefined>
}): { ok: boolean; reason: string } {
  const body = (input.body ?? "").toLowerCase()
  if (!body.trim()) return { ok: false, reason: "empty body" }

  const first = (input.firstName ?? "").trim().toLowerCase()
  const addressesThem = first.length > 1 && body.includes(first)
  if (!addressesThem) {
    return {
      ok: false,
      reason: first.length > 1
        ? `body never uses the lead's own name ("${input.firstName}") — reads as a blast`
        : "no first name on the lead to address them by",
    }
  }

  const facts = (input.situationFacts ?? [])
    .map((f) => (typeof f === "string" ? f.trim().toLowerCase() : ""))
    .filter((f) => f.length > 2)
  const matched = facts.filter((f) => body.includes(f))
  if (matched.length === 0) {
    return {
      ok: false,
      reason:
        facts.length === 0
          ? "no situation facts on file for this lead — nothing to be situational about"
          : `body carries none of this lead's own facts (${facts.slice(0, 4).join(", ")}) — not situational`,
    }
  }

  return { ok: true, reason: `addresses ${input.firstName} and carries their own situation (${matched[0]})` }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE PLAN — PURE
// ─────────────────────────────────────────────────────────────────────────────

export type LeadTouchPlanCode =
  | "due"
  | "blocked_lifecycle"
  | "max_touches_reached"
  | "interval_not_elapsed"
  | "no_permitted_channel"
  | "plan_complete"
  // Lane 97B — the next-best-action checks (NBA_CHECKS below).
  | "convert_on_callback"
  | "duplicate"
  | "outreach_paused"
  | "appointment_scheduled"
  | "agent_handling"
  | "recently_contacted"
  | "quiet_hours"
  // Wave 98 (98C) — NEGATIVE INTELLIGENCE: a recorded dead end (settings-types.ts DEAD_END_OUTCOMES).
  | "dead_end"
  | "postponed"

// ─────────────────────────────────────────────────────────────────────────────
// NEXT-BEST-ACTION (lane 97B, blueprint row 13): WAIT and DO_NOTHING are real
// actions, and every decision carries the REASONS NOT TO ACT it weighed. Policy
// lives here, in code — never in a prompt. The LLM may write the touch; it never
// decides whether one goes.
// ─────────────────────────────────────────────────────────────────────────────

/** send_touch = run the plan step · convert = hand to the human/contact rail
 *  (owner ruling: a callback is positive intent → convert) · wait = not now, a
 *  time is known · do_nothing = no touch from this plan, with the reason. */
export type NextBestAction = "send_touch" | "convert" | "wait" | "do_nothing"

export type ReasonNotToActCode =
  | "duplicate"
  | "outreach_paused"
  | "appointment_scheduled"
  | "agent_handling"
  | "recently_contacted"
  | "quiet_hours"
  | "channel_restricted_no_consent"
  | "low_confidence"
  | "intent_declining"
  | "dead_end"
  | "postponed"

export interface ReasonNotToAct {
  code: ReasonNotToActCode
  /** true = this check alone stops the touch; false = recorded, weighed, not decisive. */
  blocking: boolean
  detail: string
  /** Wave 98 (98C): the canonical dead end behind a `dead_end` / `postponed` reason. */
  outcome?: DeadEndOutcome
  /** `postponed` only — when the person asked to be left until. */
  until?: Date | null
}

/** Fatigue scope: no new ISA touch within this many hours of ANY touch (agent, ISA,
 *  campaign) — the ISA's own interval governs only its own sends. */
export const NBA_FATIGUE_HOURS = 48
/** Local-hour window a staged touch may be released in (same 8am-9pm window the
 *  TCPA call gate uses — lib/communication/call-compliance.ts checkQuietHours). */
export const NBA_QUIET_HOURS = Object.freeze({ startHour: 8, endHour: 21 })
/** An agent touch inside this many days means a human is actively handling it. */
export const NBA_AGENT_ACTIVE_DAYS = 7

export interface NextBestActionContext {
  /** The decayed intent (lib/lead-intelligence/behavioral-summary.ts scoreDecayedIntent). */
  intent?: DecayedIntent | null
  /** Positive intent: the person asked to be called back. LEAD subject → convert on it. CONTACT
   *  subject (wave 101C) → a callback is PENDING (an open ai_callback task / scheduled call
   *  activity): the agent's call is the next touch, so the ISA waits for it (see decideNextAction). */
  callbackRequested?: boolean
  /** Wave 101C: when the pending callback is due (contact subject) — the wait's dueAt. */
  callbackDueAt?: Date | null
  /** The survivor this row duplicates (leads.duplicate_of_lead_id / duplicate_of_contact_id). */
  duplicateOf?: string | null
  /** ai_outreach_paused — a human paused the ISA on this person. */
  outreachPaused?: boolean
  /** An appointment already on the calendar — no touch until it has happened. */
  appointmentAt?: Date | null
  /** The last touch by a human agent — inside NBA_AGENT_ACTIVE_DAYS they own it. */
  lastAgentTouchAt?: Date | null
  /** The last touch from ANY sender (fatigue scope). */
  lastAnyTouchAt?: Date | null
  /** On the DNC registry, or no TCPA consent — channel narrows to email + direct mail. */
  dncOrNoConsent?: boolean
  /** The recipient's local hour, when resolvable; null = not evaluated. */
  recipientLocalHour?: number | null
  /** Wave 98 (98C) — NEGATIVE INTELLIGENCE: the dead ends already recorded for this person
   *  (deadEndsFromLeadSources), so the plan never rediscovers one by touching again. */
  deadEnds?: readonly DeadEndEvidence[]
  /** The tenant's ai_isa_settings.suppress_on_outcomes (any spelling; canonicalised on read). */
  suppressOnOutcomes?: readonly string[]
  /** Wave 100 (100B): the person's CURRENT memory facts (lib/kernel/conversation-memory.ts
   *  currentMemoryFacts — expired facts never reach here). Evidence the decision read, never a blocker. */
  memoryFacts?: ReadonlyArray<{ key: string; value: string; confidence: number; observedAt: string }>
  /** Wave 102 (102B): the contact's HOUSEHOLD from the relationship graph (lib/kernel/relationship-graph.ts
   *  household — spouse / household member / co-buyer / co-owner contact ids). Evidence the decision
   *  read, never a blocker; a represented_by edge to an OUTSIDE agent lands in deadEnds instead. */
  householdContactIds?: readonly string[]
}

export interface NbaEvidence { kind: string; detail: string }

export interface LeadTouchPlan {
  code: LeadTouchPlanCode
  /** The step to run when `code === "due"`. */
  step: LeadPlanStep | null
  /** The channel the step will actually ride, after consent narrowing. */
  channel: LeadPlanChannel | null
  reason: string
  /** When the next touch becomes due, when it is not due yet. */
  dueAt: Date | null
  /** Lane 97B: the next-best-action verdict. */
  action: NextBestAction
  /** Machine-readable reason (=== code). */
  reasonCode: LeadTouchPlanCode
  /** What the decision read (intent, its trend, the signals behind it). */
  evidence: NbaEvidence[]
  /** EVERY check that argued against acting — the decisive one and the weighed ones. */
  reasonsNotToAct: ReasonNotToAct[]
  /** Ordering key across people: the intent momentum rank (rising moderate intent
   *  outranks high-but-declining intent); 0 when no intent was supplied. */
  priority: number
}

type CorePlan = Pick<LeadTouchPlan, "code" | "step" | "channel" | "reason" | "dueAt">

const ACTION_FOR_CODE: Readonly<Record<LeadTouchPlanCode, NextBestAction>> = Object.freeze({
  due: "send_touch",
  convert_on_callback: "convert",
  interval_not_elapsed: "wait",
  appointment_scheduled: "wait",
  recently_contacted: "wait",
  quiet_hours: "wait",
  blocked_lifecycle: "do_nothing",
  max_touches_reached: "do_nothing",
  no_permitted_channel: "do_nothing",
  plan_complete: "do_nothing",
  duplicate: "do_nothing",
  outreach_paused: "do_nothing",
  agent_handling: "do_nothing",
  dead_end: "do_nothing",
  postponed: "wait",
})

/** PURE. Every reason-not-to-act check, in precedence order. */
/** @proofSeam exported so scripts/lead-action-plan-simulator.ts asserts every reason-not-to-act check on the pure function directly. */
export function reasonsNotToAct(ctx: NextBestActionContext | undefined, now: Date): ReasonNotToAct[] {
  const out: ReasonNotToAct[] = []
  if (!ctx) return out
  const H = 3_600_000
  if (ctx.duplicateOf) out.push({ code: "duplicate", blocking: true, detail: `duplicate of ${ctx.duplicateOf} — act on the survivor` })
  if (ctx.outreachPaused) out.push({ code: "outreach_paused", blocking: true, detail: "a human paused the AI on this person" })
  // NEGATIVE INTELLIGENCE (wave 98, 98C): every recorded dead end, once per canonical outcome (newest
  // evidence wins). Always-terminal ones (opt-out, represented elsewhere) block whatever the settings
  // say; the rest block when the tenant suppresses on them; `postponed` waits until its date; `paused`
  // is the human switch already read above.
  const suppress = new Set((ctx.suppressOnOutcomes ?? DEFAULT_AISA_SETTINGS.suppress_on_outcomes).map(canonicalDeadEnd).filter(Boolean))
  const seen = new Set<DeadEndOutcome>()
  const newestFirst = [...(ctx.deadEnds ?? [])].sort((a, b) => (b.at?.getTime() ?? 0) - (a.at?.getTime() ?? 0))
  for (const d of newestFirst) {
    if (seen.has(d.outcome)) continue
    seen.add(d.outcome)
    if (d.outcome === "paused") {
      if (!ctx.outreachPaused) out.push({ code: "outreach_paused", blocking: true, detail: `paused (${d.source})`, outcome: d.outcome })
      continue
    }
    if (d.outcome === "postponed") {
      if (d.until && d.until.getTime() > now.getTime()) {
        out.push({ code: "postponed", blocking: true, detail: `asked to be left until ${d.until.toISOString()} (${d.source})`, outcome: d.outcome, until: d.until })
      }
      continue
    }
    const blocking = ALWAYS_TERMINAL_DEAD_ENDS.has(d.outcome) || suppress.has(d.outcome)
    out.push({
      code: "dead_end",
      blocking,
      outcome: d.outcome,
      detail: `${d.outcome} recorded${d.at ? ` ${d.at.toISOString()}` : ""} (${d.source})${blocking ? "" : " — not in this brokerage's suppression rules, weighed only"}`,
    })
  }
  if (ctx.appointmentAt && ctx.appointmentAt.getTime() > now.getTime()) {
    out.push({ code: "appointment_scheduled", blocking: true, detail: `appointment on the calendar ${ctx.appointmentAt.toISOString()}` })
  }
  if (ctx.lastAgentTouchAt && now.getTime() - ctx.lastAgentTouchAt.getTime() < NBA_AGENT_ACTIVE_DAYS * 24 * H) {
    out.push({ code: "agent_handling", blocking: true, detail: `an agent touched this person ${ctx.lastAgentTouchAt.toISOString()} (inside ${NBA_AGENT_ACTIVE_DAYS}d)` })
  }
  if (ctx.lastAnyTouchAt && now.getTime() - ctx.lastAnyTouchAt.getTime() < NBA_FATIGUE_HOURS * H) {
    out.push({ code: "recently_contacted", blocking: true, detail: `touched ${ctx.lastAnyTouchAt.toISOString()} — inside the ${NBA_FATIGUE_HOURS}h fatigue window` })
  }
  if (typeof ctx.recipientLocalHour === "number" && (ctx.recipientLocalHour < NBA_QUIET_HOURS.startHour || ctx.recipientLocalHour >= NBA_QUIET_HOURS.endHour)) {
    out.push({ code: "quiet_hours", blocking: true, detail: `recipient local hour ${ctx.recipientLocalHour} is outside ${NBA_QUIET_HOURS.startHour}:00-${NBA_QUIET_HOURS.endHour}:00` })
  }
  if (ctx.dncOrNoConsent) {
    out.push({ code: "channel_restricted_no_consent", blocking: false, detail: "DNC or no TCPA consent — email and direct mail only, never SMS/phone/voicedrop" })
  }
  if (ctx.intent && (ctx.intent.confidence === "low" || ctx.intent.confidence === "none")) {
    out.push({ code: "low_confidence", blocking: false, detail: `intent ${ctx.intent.score}/100 rests on ${ctx.intent.independentSources} independent source(s)` })
  }
  if (ctx.intent && ctx.intent.trend === "falling") {
    out.push({ code: "intent_declining", blocking: false, detail: `intent falling ${ctx.intent.velocityPerDay}/day` })
  }
  return out
}

// deadEndsFromLeadSources lives beside the vocabulary it maps onto: lib/ai-isa/settings-types.ts.

/** The plan code a blocking reason maps to (same spelling — one vocabulary). */
const CODE_FOR_BLOCKING: Partial<Record<ReasonNotToActCode, LeadTouchPlanCode>> = {
  duplicate: "duplicate", outreach_paused: "outreach_paused", appointment_scheduled: "appointment_scheduled",
  agent_handling: "agent_handling", recently_contacted: "recently_contacted", quiet_hours: "quiet_hours",
  dead_end: "dead_end", postponed: "postponed",
}

function intentEvidence(intent: DecayedIntent | null | undefined): NbaEvidence[] {
  if (!intent) return []
  return [
    { kind: "intent", detail: `${intent.score}/100, ${intent.trend} ${intent.velocityPerDay}/day (accel ${intent.accelerationPerDay2}/day²), ${intent.confidence} confidence from ${intent.independentSources} source(s)` },
    ...intent.evidence.slice(0, 5).map((e) => ({
      kind: `signal:${e.type}`,
      detail: `${e.source} ${e.ageUnknown ? "age unknown" : `${e.ageDays}d old`} (half-life ${e.halfLifeDays}d) → +${e.contribution}`,
    })),
  ]
}

/**
 * planNextLeadTouch — PURE. What the plan says should happen to this lead next.
 *
 * Reads the settings a broker ACTUALLY SET rather than a constant, which is the
 * point: `max_touches_lead`, `touch_interval_days`, `lead_allowed_channels` and
 * `blocked_lifecycle_states` were written by the settings screen and read by
 * NOTHING that decides a send. This is their reader.
 *
 * Consent narrows the plan rather than the plan overriding consent:
 * `pickLeadOutreachChannel` and `permittedLeadChannels` (the canonical lead rule —
 * email or verified direct mail, never SMS / phone / social) decide what is even
 * possible, and the plan picks within that. A step whose channel is not permitted
 * is SKIPPED, not downgraded into a channel the lead never allowed.
 */
export function planNextLeadTouch(input: PlanNextLeadTouchInput): LeadTouchPlan {
  return decideNextAction(input.context, input.now, () => planLeadTouchCore(input), "lead")
}

/**
 * planNextContactTouch — PURE (wave 100, lane 100B). The CONTACT subject of the SAME NBA
 * (no second engine): the same reasonsNotToAct (dead ends, postponed-until, pause, appointment,
 * agent handling, fatigue, quiet hours, consent), the same intent priority, the same verdicts.
 * What differs is only the core once nothing argues against acting: a contact's cadence and
 * channel are engageContact's (decideNextChannel over the consent-permitted set), so the core
 * answers "due" and the channel stays the engine's call.
 * Wired: app/actions/ai-isa/engage-contact.ts (before the channel decision).
 */
export function planNextContactTouch(input: { now: Date; context?: NextBestActionContext }): LeadTouchPlan {
  return decideNextAction(input.context, input.now, () => ({
    code: "due", step: null, channel: null, reason: "no reason not to act — the contact engine picks the channel", dueAt: input.now,
  }), "contact")
}

function memoryEvidence(facts: NextBestActionContext["memoryFacts"]): NbaEvidence[] {
  return (facts ?? []).slice(0, 4).map((f) => ({ kind: `memory:${f.key}`, detail: `${f.value} (confidence ${f.confidence}, observed ${f.observedAt})` }))
}

/** THE NBA — one decision for both subjects; `core` is the subject's own plan when nothing blocks. */
function decideNextAction(ctx: NextBestActionContext | undefined, now: Date, core: () => CorePlan, subject: "lead" | "contact"): LeadTouchPlan {
  const reasons = reasonsNotToAct(ctx, now)
  const evidence = [...intentEvidence(ctx?.intent), ...memoryEvidence(ctx?.memoryFacts)]
  const priority = ctx?.intent ? ctx.intent.momentumRank : 0
  const finish = (plan: CorePlan): LeadTouchPlan =>
    ({ ...plan, action: ACTION_FOR_CODE[plan.code], reasonCode: plan.code, evidence, reasonsNotToAct: reasons, priority })

  // A duplicate is never worked — not even converted; the survivor is.
  const dup = reasons.find((r) => r.code === "duplicate")
  if (dup) return finish({ code: "duplicate", step: null, channel: null, reason: dup.detail, dueAt: null })
  // OWNER RULING: a callback is positive intent → convert. It outranks cadence,
  // fatigue and the plan itself (the conversion rail books the call).
  // A callback never overrides a terminal dead end (an opt-out, or represented by another agent).
  const terminal = reasons.some((r) => r.code === "dead_end" && r.outcome && ALWAYS_TERMINAL_DEAD_ENDS.has(r.outcome))
  if (ctx?.callbackRequested && !terminal && !reasons.some((r) => r.code === "outreach_paused")) {
    // A CONTACT is already converted: the same positive intent means the callback is PENDING on the
    // agent's desk (wave 101C) — the call IS the next touch, so an automated touch on top of it waits
    // until it is due (the appointment verdict: a call is a booked conversation).
    if (subject === "contact") {
      return finish({ code: "appointment_scheduled", step: null, channel: null, reason: "a callback is pending — the agent's call is the next touch", dueAt: ctx.callbackDueAt ?? null })
    }
    return finish({ code: "convert_on_callback", step: null, channel: null, reason: "callback requested — positive intent; convert and book the call", dueAt: now })
  }
  const blocking = reasons.find((r) => r.blocking)
  if (blocking) {
    const code = CODE_FOR_BLOCKING[blocking.code] ?? "blocked_lifecycle"
    const dueAt = code === "appointment_scheduled" ? (ctx?.appointmentAt ?? null)
      : code === "postponed" ? (blocking.until ?? null)
      : code === "recently_contacted" && ctx?.lastAnyTouchAt ? new Date(ctx.lastAnyTouchAt.getTime() + NBA_FATIGUE_HOURS * 3_600_000)
      : null
    return finish({ code, step: null, channel: null, reason: blocking.detail, dueAt })
  }
  return finish(core())
}

export interface PlanNextLeadTouchInput {
  now: Date
  settings: AIISASettings
  /** Touches already delivered on this lead, from isa_outreach_log. */
  touchesSoFar: number
  /** When the last ISA touch went out, if any. */
  lastTouchAt: Date | null
  /** The channel of the last touch — the rotation anchor. */
  lastChannel: string | null
  /** Which plan channels already have a staged-or-sent touch on this lead. */
  channelsAlreadyStaged: readonly LeadPlanChannel[]
  emailUsable: boolean
  mailingVerified: boolean
  /** True once a persona intro reel exists for this lead (the video-email input). */
  reelReady: boolean
  lifecycleState: string | null
  cohort?: GenerationalCohort
  /** Lane 97B: the next-best-action context. Omitted = the plan alone decides. */
  context?: NextBestActionContext
}

function planLeadTouchCore(input: PlanNextLeadTouchInput): CorePlan {
  const s = input.settings

  // HARD LIFECYCLE STOP, from the broker's own list. Note for whoever reads this
  // next: DEFAULT_AISA_SETTINGS.blocked_lifecycle_states carries four members and
  // only ONE of them ('representation') is a live `leads_lifecycle_state_check`
  // value — 'active_transaction', 'closing' and 'do_not_contact' can never match a
  // lead row. That is reported, not silently "fixed" here: the list is the
  // broker's, this is its reader, and narrowing it in code would put the rule in
  // two places (§6).
  const blocked = s.blocked_lifecycle_states ?? DEFAULT_AISA_SETTINGS.blocked_lifecycle_states
  if (input.lifecycleState && blocked.includes(input.lifecycleState)) {
    return {
      code: "blocked_lifecycle",
      step: null,
      channel: null,
      reason: `lifecycle_state '${input.lifecycleState}' is in this owner's blocked_lifecycle_states`,
      dueAt: null,
    }
  }

  const maxTouches = s.max_touches_lead ?? DEFAULT_AISA_SETTINGS.max_touches_lead
  if (input.touchesSoFar >= maxTouches) {
    return {
      code: "max_touches_reached",
      step: null,
      channel: null,
      reason: `${input.touchesSoFar} touches delivered, cap is max_touches_lead=${maxTouches}`,
      dueAt: null,
    }
  }

  // CADENCE. `touch_interval_days` had no reader anywhere before this.
  const intervalDays = s.touch_interval_days ?? DEFAULT_AISA_SETTINGS.touch_interval_days
  if (input.lastTouchAt) {
    const dueAt = new Date(input.lastTouchAt.getTime() + intervalDays * 24 * 60 * 60 * 1000)
    if (dueAt.getTime() > input.now.getTime()) {
      return {
        code: "interval_not_elapsed",
        step: null,
        channel: null,
        reason: `last touch ${input.lastTouchAt.toISOString()}; touch_interval_days=${intervalDays} makes the next one due ${dueAt.toISOString()}`,
        dueAt,
      }
    }
  }

  // WHAT CONSENT PERMITS — the canonical lead rule, not a local re-spelling.
  const permitted = new Set<string>(
    permittedLeadChannels({ emailUsable: input.emailUsable, mailingVerified: input.mailingVerified }),
  )
  if (permitted.size === 0) {
    return {
      code: "no_permitted_channel",
      step: null,
      channel: null,
      reason: "neither the email nor the mailing address is verified — pickLeadOutreachChannel answers no_outreach",
      dueAt: null,
    }
  }

  // WHAT THE BROKERAGE ALLOWS on top of what consent permits.
  const allowedWire = new Set(s.lead_allowed_channels ?? DEFAULT_AISA_SETTINGS.lead_allowed_channels)

  const staged = new Set(input.channelsAlreadyStaged)
  const eligible = LEAD_PLAN_STEPS.filter((step) => {
    if (staged.has(step.channel)) return false
    const wire = wireChannelFor(step.channel)
    if (!allowedWire.has(wire)) return false
    if (wire === "email" && !permitted.has("email")) return false
    if (wire === "direct_mail" && !permitted.has("direct_mail")) return false
    // The video email needs a reel; without one it is just another email, and
    // sending "here is your personal video" with no video is the promise the
    // first-touch email already fails to keep.
    if (step.channel === "video_email" && !input.reelReady) return false
    return true
  })

  if (eligible.length === 0) {
    return {
      code: "plan_complete",
      step: null,
      channel: null,
      reason: "every plan step is already staged, disallowed by settings, or unsupported by this lead's verified channels",
      dueAt: null,
    }
  }

  // ROTATION, through the ONE decision brain (lib/ai-isa/next-best-touch.ts), so
  // a lead gets the same cohort-aware, don't-hammer-one-rail treatment a contact
  // does — over the narrower lead set. The plan order is the tie-break; the brain
  // only gets to move a step forward when it would otherwise repeat the last rail.
  let chosen = eligible[0]
  if (input.lastChannel && eligible.length > 1) {
    const rotation = decideNextChannel({
      permitted: Array.from(permitted) as Array<"email" | "direct_mail" | "newsletter">,
      cohort: input.cohort ?? "unknown",
      lastChannel: input.lastChannel,
    })
    const preferred = eligible.find((step) => wireChannelFor(step.channel) === rotation.channel)
    if (preferred && wireChannelFor(chosen.channel) === input.lastChannel) chosen = preferred
  }

  return {
    code: "due",
    step: chosen,
    channel: chosen.channel,
    reason: `plan step ${chosen.order} (${chosen.channel}) is due — produced by ${chosen.producer}`,
    dueAt: input.now,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE GOVERNOR — async
// ─────────────────────────────────────────────────────────────────────────────

/** One lead-recipient proposal, and what the governor decided about it. */
export interface LeadTouchRelease {
  messageId: string
  leadId: string
  channel: LeadWireChannel
  mode: LeadAutoSendMode
  code: LeadAutoSendCode | "refused"
  /**
   * WHAT THE SETTINGS GATE ITSELF ANSWERED, always, independently of what
   * happened afterwards. Kept separate from `code` because "the brokerage never
   * authorised this" and "the brokerage authorised it and then the lead's own
   * consent refused it" are different facts, and a single field that collapses
   * them cannot answer the only question that matters here: did the SETTINGS let
   * this through? The simulator asserts on THIS field, so a gate that opened is
   * provable without any provider ever being called.
   */
  gate: LeadAutoSendCode
  /** Set only when the governor actually released it through the sender. */
  sendStatus?: "sent" | "skipped" | "failed"
  reason: string
}

export interface ReleaseDueLeadTouchesResult {
  /** Lead-recipient proposals examined. The DENOMINATOR for every count below. */
  examined: number
  /** Released through approveClientMessage and confirmed sent. */
  sent: number
  /** Left at status='proposed' for a human — the fail-closed outcome. */
  staged: number
  /** Released but the sender itself refused (opt-out, no address, provider). */
  failed: number
  decisions: LeadTouchRelease[]
  warnings: string[]
}

/**
 * releaseDueLeadTouches — THE MISSING HALF (§1 case 2).
 *
 * The producers already write LEAD-recipient proposals into
 * `agent_client_messages` at status='proposed'. Until this function existed, the
 * ONLY thing that could move one of those rows was a human clicking approve in the
 * Command Center — so a brokerage that wanted its AI ISA to send simply could not
 * say so, and the video email the first-touch email promises was never sent by
 * anything.
 *
 * It adds NO sender. `approveClientMessage` is the sender, and it already carries
 * the lead-recipient branch, the CAN-SPAM email gate, the direct-mail opt-out
 * gate, the deliverable-address check and the "leads support email + direct mail
 * only" refusal. This function decides ONLY whether the brokerage authorised the
 * release — and re-checks the gates that could have changed since the proposal was
 * written.
 *
 * Every read destructures `{ data, error }` and READS the error (§3): supabase-js
 * RESOLVES a refusal, and a refused lead read that reads as "no stops on file" is
 * how an auto-sender mails somebody who opted out yesterday.
 *
 * ── SCOPE, STATED SO IT IS NOT A SURPRISE ───────────────────────────────────
 * This governs EVERY `audience='lead'` proposal in the brokerage, not only the
 * ones the three plan steps produce — including the hot-seller nurture proposals
 * from lib/ai-isa/lead-nurture.ts. That is deliberate and it is the ruling: a
 * lead proposal can only ever ride email or verified direct mail (the canonical
 * channel rule), which are two of the three channels the owner named, and
 * filtering by `agent_kind` would be a SECOND rule about who may send — the
 * §6 defect — layered on top of the brokerage's own switch.
 *
 * It changes nothing until a broker acts: `require_broker_approval` is NOT NULL
 * DEFAULT TRUE live, and DEFAULT_AISA_SETTINGS agrees, so every existing
 * brokerage keeps a human in the loop until one explicitly turns that off.
 */
export async function releaseDueLeadTouches(input: {
  brokerageId: string
  /** Restrict to one lead — used by the per-lead path and by the simulator. */
  leadId?: string | null
  limit?: number
  now?: Date
  supabase?: any
}): Promise<ReleaseDueLeadTouchesResult> {
  const out: ReleaseDueLeadTouchesResult = {
    examined: 0, sent: 0, staged: 0, failed: 0, decisions: [], warnings: [],
  }

  // FAIL CLOSED (§4): with no tenant this refuses rather than running an
  // un-scoped read on the service client, which bypasses RLS. Tenant comes from
  // the caller's session or from a per-brokerage cron sweep — never from a body.
  if (!input.brokerageId) {
    out.warnings.push("releaseDueLeadTouches requires a brokerageId — refusing an un-scoped service-client read")
    return out
  }

  const supabase = input.supabase ?? (await import("@/lib/supabase/service")).createServiceClient()
  const now = input.now ?? new Date()
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200))

  // ── THE POLICY, ONCE PER SWEEP ────────────────────────────────────────────
  // Resolved through the EXISTING resolver (§6). A LEAD has no agent by
  // definition — CLAUDE.md §5, and `initiateAIISAEngagement` refuses a lead with
  // an `agent_id` outright — so the scope is the BROKERAGE tier and the cascade
  // falls through agent → team → brokerage → platform on its own.
  const resolution = await resolveLeadSettingsResolution({ brokerageId: input.brokerageId })

  let q = supabase
    .from("agent_client_messages")
    .select("id, recipient_lead_id, recipient_contact_id, channel, subject, body, status, brokerage_id, proposed_at")
    .eq("brokerage_id", input.brokerageId)
    .eq("audience", "lead")
    .eq("status", "proposed")
    .not("recipient_lead_id", "is", null)
    .order("proposed_at", { ascending: true })
    .limit(limit)
  if (input.leadId) q = q.eq("recipient_lead_id", input.leadId)

  const { data: proposals, error: proposalsError } = await q
  if (proposalsError) {
    // A refused read is NOT an empty queue. Say so rather than reporting a clean
    // sweep of zero (§2: a broken finder and a clean tree both report zero).
    out.warnings.push(`agent_client_messages read refused (${proposalsError.message}) — NOTHING was released this sweep`)
    return out
  }

  for (const row of (proposals ?? []) as Array<Record<string, any>>) {
    out.examined++
    const messageId = row.id as string
    const leadId = row.recipient_lead_id as string
    const wire: LeadWireChannel = row.channel === "direct_mail" ? "direct_mail" : "email"

    // A proposal that names BOTH a lead and a contact is the conversion race.
    // `approveClientMessage` would take the CONTACT branch; the governor refuses
    // to auto-release it rather than guess which person it is for.
    const verdict = leadAutoSendVerdict({ resolution, channel: wire })

    if (row.recipient_contact_id) {
      out.staged++
      out.decisions.push({
        messageId, leadId, channel: wire, mode: "stage_for_approval", code: "refused", gate: verdict.code,
        reason: "proposal names both a lead and a contact — staged for a human rather than auto-routed",
      })
      continue
    }

    if (verdict.mode === "stage_for_approval") {
      out.staged++
      out.decisions.push({ messageId, leadId, channel: wire, mode: verdict.mode, code: verdict.code, gate: verdict.code, reason: verdict.reason })
      continue
    }

    // ── THE BROKERAGE SAID YES. NOW RE-CHECK EVERYTHING THAT COULD HAVE MOVED ──
    const eligibility = await leadStillSendable({
      supabase, brokerageId: input.brokerageId, leadId, channel: wire,
      body: String(row.body ?? ""), settings: resolutionSettings(resolution), now,
    })
    if (!eligibility.ok) {
      out.staged++
      out.decisions.push({
        messageId, leadId, channel: wire, mode: "stage_for_approval", code: "refused", gate: verdict.code,
        reason: eligibility.reason,
      })
      continue
    }

    // ── RELEASE, THROUGH THE EXISTING SENDER ──────────────────────────────────
    // `null` approver: no human approved this. The brokerage's own
    // `require_broker_approval = false` IS the standing authorisation, and there
    // is no person to name. Stamping some human's id here would be a false audit
    // trail on the exact record a regulator would ask for.
    const { approveClientMessage } = await import("@/lib/agents/agent-client-messages")
    // ACTION LEDGER (wave 98): WHY = the lead plan's step; the proposal id is the cycle
    // (approveClientMessage), so a re-swept proposal never sends twice. Wave 100A: a lead-plan
    // touch is the ISA's NURTURE_TOUCH (action-ledger.ts REASON_CODE_MAP.nba_plan.due), not a
    // campaign-sequence step — one spelling for both hid the ISA's revenue inside campaigns'.
    const res = await approveClientMessage(messageId, null, undefined, supabase, {
      reasonCode: "NURTURE_TOUCH",
      reasonDetail: `lead action plan auto-release (${verdict.code})`,
    })

    if (res.status === "sent") out.sent++
    else if (res.status === "failed") out.failed++
    else out.staged++

    out.decisions.push({
      messageId, leadId, channel: wire, mode: "auto_send", code: verdict.code, gate: verdict.code,
      sendStatus: res.status,
      reason: res.status === "sent" ? verdict.reason : `sender answered '${res.status}': ${JSON.stringify(res.result)}`,
    })
  }

  return out
}

/** Narrow a resolution to its settings, or the constant default when unreadable. */
function resolutionSettings(resolution: LeadSettingsResolution): AIISASettings {
  return resolution.status === "unreadable" ? DEFAULT_AISA_SETTINGS : resolution.settings
}

/**
 * Resolve the ISA policy for a lead's brokerage through THE EXISTING RESOLVER,
 * preserving the three-state answer. `resolveIsaSettings` (the compatibility
 * shape) collapses `unreadable` onto the defaults and would therefore hand this
 * gate `require_broker_approval: true` — which happens to be the safe answer, but
 * for the wrong reason and with no way to SAY that nobody could look. The gate
 * needs to distinguish "the broker chose this" from "we could not read it", so it
 * calls `resolveIsaSettingsResult` and keeps the status.
 */
export async function resolveLeadSettingsResolution(scope: {
  brokerageId: string
  teamId?: string | null
  agentId?: string | null
}): Promise<LeadSettingsResolution> {
  try {
    const { resolveIsaSettingsResult } = await import("./resolve-isa-settings")
    const result = await resolveIsaSettingsResult(scope)
    if (result.status === "unreadable") {
      return { status: "unreadable", detail: `${result.ownerType} tier: ${result.detail}` }
    }
    return { status: result.status, settings: result.settings }
  } catch (err) {
    // A THROW is not "no settings". It is "we could not look" — same fail-closed
    // answer as a refused read, and said out loud rather than swallowed.
    return { status: "unreadable", detail: `resolver threw — ${(err as Error)?.message ?? "unknown error"}` }
  }
}

/**
 * Re-run every gate that could have changed between the proposal being written
 * and the governor releasing it. A staged touch can sit for days; consent moves.
 *
 * Nothing here is a NEW rule. It is the existing ones, composed, in the order that
 * costs least when it refuses:
 *   conversion finality → lead stops → channel policy → touch cap → suppression →
 *   personalization floor → content compliance.
 */
async function leadStillSendable(args: {
  supabase: any
  brokerageId: string
  leadId: string
  channel: LeadWireChannel
  body: string
  settings: AIISASettings
  now: Date
}): Promise<{ ok: boolean; reason: string }> {
  const { supabase, brokerageId, leadId, channel } = args

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select(
      "id, brokerage_id, agent_id, contact_id, is_active, lifecycle_state, ai_outreach_paused, dnc_status, " +
      "email, email_verified, email_opt_out, direct_mail_opt_out, " +
      "mailing_address, mailing_address_verified, mailing_city, mailing_state, mailing_zip, " +
      "first_name, last_name, city, property_interest, timeline, motivation_type, preferred_channel",
    )
    .eq("id", leadId)
    .eq("brokerage_id", brokerageId)
    .maybeSingle()

  // FAIL CLOSED. A refused read is not an unblocked lead.
  if (leadError) return { ok: false, reason: `lead read refused (${leadError.message}) — refusing to auto-send on an unverified state` }
  if (!lead) return { ok: false, reason: `lead ${leadId} not found in brokerage ${brokerageId}` }

  // CONVERSION FINALITY — the survivor gate, not a re-spelling of it. A lead that
  // became a client while its touch sat in the queue must not be mailed as a lead.
  const { conversionVerdictForRow } = await import("@/lib/contact-promotion/conversion-finality")
  const verdict = conversionVerdictForRow(lead as { id?: string; contact_id?: string | null }, leadId)
  if (!verdict.allowed) return { ok: false, reason: `conversion finality: ${verdict.reason}` }

  if (lead.agent_id) return { ok: false, reason: "lead now has an agent — it converted; the CONTACT owns every action from here" }
  if (lead.is_active === false) return { ok: false, reason: "lead is inactive" }
  if (lead.ai_outreach_paused === true) return { ok: false, reason: "ai_outreach_paused is set on this lead" }
  if (lead.dnc_status === true) return { ok: false, reason: "lead is on DNC" }

  const blocked = args.settings.blocked_lifecycle_states ?? DEFAULT_AISA_SETTINGS.blocked_lifecycle_states
  if (lead.lifecycle_state && blocked.includes(lead.lifecycle_state)) {
    return { ok: false, reason: `lifecycle_state '${lead.lifecycle_state}' is blocked by this owner's settings` }
  }

  // THE CANONICAL LEAD CHANNEL RULE. Not a second copy — the same pure function
  // initiateAIISAEngagement routes through.
  const emailUsable = !!(lead.email && lead.email_verified === true && lead.email_opt_out !== true)
  const mailingVerified = !!(
    lead.mailing_address_verified === true &&
    lead.mailing_address && lead.mailing_city && lead.mailing_state && lead.mailing_zip &&
    lead.direct_mail_opt_out !== true
  )
  const permitted = pickLeadOutreachChannel({ requestedChannel: channel, emailUsable, mailingVerified })
  if (permitted !== channel) {
    return {
      ok: false,
      reason: `pickLeadOutreachChannel answers '${permitted}' for this lead, not '${channel}' — refusing to send on a channel the lead's verification does not permit`,
    }
  }

  // THE TOUCH CAP — the existing governor, which also refuses a suppressed entity.
  const { checkMaxTouches } = await import("./isa-outreach-logger")
  const underCap = await checkMaxTouches(leadId, "lead", brokerageId)
  if (!underCap) return { ok: false, reason: "checkMaxTouches refused — touch cap reached or the lead is suppressed" }

  // SUPPRESSION — the designated writer's designated reader. `mail` carries the
  // printed address so the address arm of contact_suppression_list can bind; a
  // lead has no contact row, so contactId is honestly omitted rather than faked.
  const { checkSuppression } = await import("@/lib/kernel/compliance/check-suppression")
  const suppression = await checkSuppression({
    brokerageId,
    contactId: null,
    email: channel === "email" ? (lead.email ?? null) : null,
    phone: null,
    channel: channel === "direct_mail" ? "mail" : "email",
    mailingStreet: channel === "direct_mail" ? (lead.mailing_address ?? null) : null,
    mailingZip: channel === "direct_mail" ? (lead.mailing_zip ?? null) : null,
  })
  if (suppression.suppressed) return { ok: false, reason: `suppressed: ${suppression.reason ?? "on the suppression list"}` }

  // THE PERSONALIZATION FLOOR — the owner's ruling, checked where it can still
  // stop something. A body that reads as a blast is STAGED, never sent.
  const personalized = isPersonalizedForLead({
    body: args.body,
    firstName: lead.first_name ?? null,
    situationFacts: [lead.property_interest, lead.timeline, lead.motivation_type, lead.city, "video"],
  })
  if (!personalized.ok) {
    return { ok: false, reason: `not them-first / situational (${personalized.reason}) — staged for a human to rewrite, not sent` }
  }

  // CONTENT COMPLIANCE — the kernel gate, on the exact bytes about to go out.
  const { evaluateOutbound } = await import("@/lib/kernel")
  const compliance = await evaluateOutbound({
    actorContext: { userId: brokerageId, role: "isa", brokerageId },
    journeyType: "buyer",
    persona: "other",
    messageType: channel === "direct_mail" ? "direct_mail" : "email",
    content: args.body.replace(/<[^>]+>/g, " "),
    contact: {
      id: leadId,
      first_name: lead.first_name ?? "",
      last_name: lead.last_name ?? "",
      email: lead.email ?? undefined,
      contact_type: "buyer",
      tcpa_consent: false,
      isa_reengage_allowed: true,
      dnc_status: false,
    } as any,
  }, { client: supabase })
  if (!compliance.allowed) {
    return { ok: false, reason: `compliance gate blocked the body: ${compliance.blockedReason ?? (compliance.violations ?? []).join("; ")}` }
  }

  return { ok: true, reason: personalized.reason }
}

// TOMBSTONE (wave 102C): `nonActionRecordFor` (lane 98B — the recordNonAction context for a wait /
// do_nothing verdict, null when the plan acts) was MERGED onto its survivor `decisionRecordFor` below
// (this file), which records EVERY verdict with the same shape; the wait / do_nothing rows it writes
// are byte-identical to the ones nonActionRecordFor wrote (test:lead-action-plan NBA-LEDGER-*).

/** The ledger reason of each verdict — the m687/m693 vocabulary (nba_plan map in action-ledger.ts:
 *  due → NURTURE_TOUCH, convert_on_callback → CONVERSATION_RESPONSE; WAIT_COOLDOWN / NO_ACTION_NEEDED as before). */
const DECISION_REASON_CODE: Record<NextBestAction, "WAIT_COOLDOWN" | "NO_ACTION_NEEDED" | "NURTURE_TOUCH" | "CONVERSATION_RESPONSE"> = {
  wait: "WAIT_COOLDOWN", do_nothing: "NO_ACTION_NEEDED", send_touch: "NURTURE_TOUCH", convert: "CONVERSATION_RESPONSE",
}

/**
 * PURE (lane 98B, widened in wave 102C — owner answer 3: "acting decisions ARE ledgered as decisions
 * with the same snapshot"). The recordNonAction context for EVERY verdict — wait / do_nothing (the
 * 98B rows: WAIT_COOLDOWN / NO_ACTION_NEEDED, the plan's own reasonCode and every reason-not-to-act
 * in `detail`), and since 102C send_touch / convert too — so lib/kernel/decision-replay.ts replays
 * the acting verdicts as well. The acting row is the DECISION, not the act: it stays status 'skipped'
 * (recordNonAction), the act is its chokepoint's own 'executed' row, and attribution's "executed"
 * rule is untouched (lib/intelligence/roi-ledger.ts:195 — a `*.decision.send_touch` row is not
 * attribution-eligible). Cycle = verdict code + UTC day: the sweep's re-runs hold each verdict to one
 * row per day. `decisionInput` (wave 101B) is the compact planner input the replay harness re-runs.
 */
/** @proofSeam exported so scripts/lead-action-plan-simulator.ts asserts the verdict → ledger mapping (wait, do_nothing, send_touch, convert) on the pure function directly; the sweep and engageContact are its runtime callers. */
export function decisionRecordFor(
  plan: LeadTouchPlan,
  at: { brokerageId: string; leadId: string; now: Date } | { brokerageId: string; contactId: string; now: Date },
  decisionInput?: DecisionInputSnapshot,
): NonActionRecord {
  // Wave 100 (100B): the contact subject of the same NBA records on the same ledger, its own domain.
  const subject = "contactId" in at ? { type: "contact" as const, id: at.contactId } : { type: "lead" as const, id: at.leadId }
  return {
    brokerageId: at.brokerageId,
    domain: subject.type,
    decision: plan.action,
    actor: { type: "manager", managerKey: "ai_isa" },
    subject,
    reasonCode: DECISION_REASON_CODE[plan.action],
    reasonDetail: `${plan.reasonCode}: ${plan.reason}`.slice(0, 500),
    cycle: `${plan.reasonCode}:${at.now.toISOString().slice(0, 10)}`,
    until: plan.dueAt ? plan.dueAt.toISOString() : null,
    systemSource: subject.type === "contact" ? "contact_next_action" : "lead_action_plan",
    detail: {
      plan_code: plan.reasonCode,
      reasons_not_to_act: plan.reasonsNotToAct,
      evidence: plan.evidence.slice(0, 6),
      priority: plan.priority,
      ...(decisionInput ? { decision_input: decisionInput } : {}),
    },
  }
}
type NonActionRecord = Parameters<typeof recordNonActionType>[0]

// ─────────────────────────────────────────────────────────────────────────────
// DECISION INPUT SNAPSHOT (wave 101, lane 101B; gap map row 20) — the recorded input the replay
// harness re-runs. The ledger row already carried the VERDICT (plan_code, reasons_not_to_act) but
// not what it was decided ON, so a changed rule could not be replayed against past decisions. This
// is that input, compact: settings narrowed to the four keys the core reads, dates as ISO, intent
// without its evidence list (evidence never decides), memory facts as a count (evidence only), at
// most 20 dead ends. Rides ledger `detail.decision_input` — no new table.
// ─────────────────────────────────────────────────────────────────────────────

export const DECISION_INPUT_VERSION = 1

export interface DecisionInputSnapshot {
  v: number
  subject: "lead" | "contact"
  now: string
  /** Lead only — the core plan's inputs. */
  core?: {
    settings: Pick<AIISASettings, "blocked_lifecycle_states" | "max_touches_lead" | "touch_interval_days" | "lead_allowed_channels">
    touchesSoFar: number
    lastTouchAt: string | null
    lastChannel: string | null
    channelsAlreadyStaged: LeadPlanChannel[]
    emailUsable: boolean
    mailingVerified: boolean
    reelReady: boolean
    lifecycleState: string | null
    cohort: string | null
  }
  context?: {
    intent: Omit<DecayedIntent, "evidence"> | null
    callbackRequested: boolean
    duplicateOf: string | null
    outreachPaused: boolean
    appointmentAt: string | null
    lastAgentTouchAt: string | null
    lastAnyTouchAt: string | null
    dncOrNoConsent: boolean
    recipientLocalHour: number | null
    deadEnds: Array<{ outcome: DeadEndOutcome; at: string | null; source: string; until?: string | null }>
    suppressOnOutcomes: string[] | null
    memoryFactCount: number
  }
}

const iso = (d: Date | null | undefined): string | null => (d instanceof Date && Number.isFinite(d.getTime()) ? d.toISOString() : null)
const dateOf = (s: string | null | undefined): Date | null => (s && Number.isFinite(Date.parse(s)) ? new Date(s) : null)

function contextSnapshot(ctx: NextBestActionContext | undefined): DecisionInputSnapshot["context"] {
  if (!ctx) return undefined
  let intent: Omit<DecayedIntent, "evidence"> | null = null
  if (ctx.intent) {
    const { evidence: _evidence, ...rest } = ctx.intent
    void _evidence
    intent = rest
  }
  return {
    intent,
    callbackRequested: ctx.callbackRequested === true,
    duplicateOf: ctx.duplicateOf ?? null,
    outreachPaused: ctx.outreachPaused === true,
    appointmentAt: iso(ctx.appointmentAt),
    lastAgentTouchAt: iso(ctx.lastAgentTouchAt),
    lastAnyTouchAt: iso(ctx.lastAnyTouchAt),
    dncOrNoConsent: ctx.dncOrNoConsent === true,
    recipientLocalHour: typeof ctx.recipientLocalHour === "number" ? ctx.recipientLocalHour : null,
    deadEnds: (ctx.deadEnds ?? []).slice(0, 20).map((d) => ({ outcome: d.outcome, at: iso(d.at), source: d.source, ...(d.until !== undefined ? { until: iso(d.until) } : {}) })),
    suppressOnOutcomes: ctx.suppressOnOutcomes ? [...ctx.suppressOnOutcomes] : null,
    memoryFactCount: (ctx.memoryFacts ?? []).length,
  }
}

/** PURE. The compact, JSON-safe input of one NBA decision. */
export function decisionInputSnapshot(
  input: { subject: "lead"; plan: PlanNextLeadTouchInput } | { subject: "contact"; now: Date; context?: NextBestActionContext },
): DecisionInputSnapshot {
  if (input.subject === "contact") {
    return { v: DECISION_INPUT_VERSION, subject: "contact", now: input.now.toISOString(), context: contextSnapshot(input.context) }
  }
  const p = input.plan
  return {
    v: DECISION_INPUT_VERSION,
    subject: "lead",
    now: p.now.toISOString(),
    core: {
      settings: {
        blocked_lifecycle_states: p.settings.blocked_lifecycle_states,
        max_touches_lead: p.settings.max_touches_lead,
        touch_interval_days: p.settings.touch_interval_days,
        lead_allowed_channels: p.settings.lead_allowed_channels,
      },
      touchesSoFar: p.touchesSoFar,
      lastTouchAt: iso(p.lastTouchAt),
      lastChannel: p.lastChannel,
      channelsAlreadyStaged: [...p.channelsAlreadyStaged],
      emailUsable: p.emailUsable,
      mailingVerified: p.mailingVerified,
      reelReady: p.reelReady,
      lifecycleState: p.lifecycleState,
      cohort: p.cohort ?? null,
    },
    context: contextSnapshot(p.context),
  }
}

function contextFromSnapshot(c: DecisionInputSnapshot["context"]): NextBestActionContext | undefined {
  if (!c) return undefined
  return {
    intent: c.intent ? { ...c.intent, evidence: [] } : undefined,
    callbackRequested: c.callbackRequested,
    duplicateOf: c.duplicateOf,
    outreachPaused: c.outreachPaused,
    appointmentAt: dateOf(c.appointmentAt),
    lastAgentTouchAt: dateOf(c.lastAgentTouchAt),
    lastAnyTouchAt: dateOf(c.lastAnyTouchAt),
    dncOrNoConsent: c.dncOrNoConsent,
    recipientLocalHour: c.recipientLocalHour,
    deadEnds: (c.deadEnds ?? []).map((d) => ({ outcome: d.outcome, at: dateOf(d.at), source: d.source, ...(d.until !== undefined ? { until: dateOf(d.until) } : {}) })),
    suppressOnOutcomes: c.suppressOnOutcomes ?? undefined,
  }
}

/**
 * PURE. Re-run the CURRENT planner on a recorded snapshot. null = not replayable (unknown version,
 * or a lead snapshot without its core inputs). Deterministic: the clock is the snapshot's `now`.
 */
export function planFromDecisionInput(snap: DecisionInputSnapshot | null | undefined): LeadTouchPlan | null {
  if (!snap || snap.v !== DECISION_INPUT_VERSION || !Number.isFinite(Date.parse(snap.now))) return null
  const now = new Date(snap.now)
  const context = contextFromSnapshot(snap.context)
  if (snap.subject === "contact") return planNextContactTouch({ now, context })
  if (snap.subject !== "lead" || !snap.core) return null
  const c = snap.core
  return planNextLeadTouch({
    now,
    settings: { ...DEFAULT_AISA_SETTINGS, ...c.settings } as AIISASettings,
    touchesSoFar: c.touchesSoFar,
    lastTouchAt: dateOf(c.lastTouchAt),
    lastChannel: c.lastChannel,
    channelsAlreadyStaged: c.channelsAlreadyStaged,
    emailUsable: c.emailUsable,
    mailingVerified: c.mailingVerified,
    reelReady: c.reelReady,
    lifecycleState: c.lifecycleState,
    cohort: (c.cohort ?? undefined) as GenerationalCohort | undefined,
    context,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// THE CONTACT SUBJECT'S INPUTS (wave 100, lane 100B) — the SAME inputs the lead
// sweep feeds planNextLeadTouch, through the SAME helpers, keyed by contact:
//   · dead ends — deadEndsFromLeadSources over ai_isa_activities.outcome and
//     voice_calls.outcome (the call disposition) keyed by contact_id OR by a
//     lineage lead (leads.contact_id), contacts.qualification_summary (already
//     represented), and the lineage lead's long_term_nurture_until (postponed
//     with its date); ai_outreach_paused rides as `paused`;
//   · decayed intent — buildBehavioralIntentSummary(...).decayedIntent;
//   · memory — loadContactMemoryForPrompt → currentMemoryFacts (current only);
//   · reasons-not-to-act — fatigue from contacts.last_contacted_at on an
//     AUTONOMOUS run (a human who asks for the touch is not fatigued by their own
//     ask), the tenant's suppress_on_outcomes.
// FAIL CLOSED: a refused dead-end read returns ok:false — "nobody checked whether
// this person said no" must never render as "they never said no" (§4).
// ─────────────────────────────────────────────────────────────────────────────

export interface ContactNbaRow {
  id: string
  ai_outreach_paused?: boolean | null
  qualification_summary?: string | null
  last_contacted_at?: string | null
}

// ─── WAVE 101C — THE THREE INPUTS THE CONTACT NBA WAS NOT FED ───────────────
// reasonsNotToAct already weighed `lastAgentTouchAt` (agent_handling), `appointmentAt`
// (appointment_scheduled) and `callbackRequested`; nothing loaded them for a contact, so a
// person the agent called yesterday, or with a showing tomorrow, or waiting on a callback, got
// an automated touch anyway. Sources (each one's WRITER named):
//   · agent touch — `activities` a human agent COMPLETED with the person: a touch type
//     (AGENT_TOUCH_ACTIVITY_TYPES), an agent named (agent_id / agent_user_id), completed
//     (status 'completed' or completed_at). Scheduled rows are commitments, not touches.
//   · appointment — the earliest FUTURE of: `showings.scheduled_at` (the showing writers) and
//     `activities` meeting / showing / listing_appointment rows still open
//     (lib/ai-isa/qualification-signals.ts writeFollowUpActivity writes status 'scheduled').
//   · pending callback — `tasks` source 'ai_callback' status 'pending' (lib/ai-isa/callback-task.ts
//     createCallbackTask; the reader app/api/cron/ai-callback-dispatch uses the same predicate) and
//     `activities` call rows still open (landCallbackOnAgentContact → scheduleFollowUp).
const AGENT_TOUCH_ACTIVITY_TYPES: ReadonlySet<string> = new Set(["call", "email", "text", "sms", "meeting", "showing", "listing_appointment", "video_call"])
const APPOINTMENT_ACTIVITY_TYPES: ReadonlySet<string> = new Set(["meeting", "showing", "listing_appointment"])
const CLOSED_ACTIVITY_STATUSES: ReadonlySet<string> = new Set(["completed", "cancelled", "canceled", "failed", "no_show", "missed"])

export interface ContactTouchRows {
  activities: ReadonlyArray<{ activity_type: string | null; status: string | null; agent_id?: string | null; agent_user_id?: string | null; scheduled_at?: string | null; completed_at?: string | null; created_at?: string | null }>
  showings: ReadonlyArray<{ scheduled_at: string | null; status: string | null }>
  callbackTasks: ReadonlyArray<{ due_date: string | null; status: string | null }>
}

const at = (v: string | null | undefined): Date | null => (v && Number.isFinite(Date.parse(v)) ? new Date(v) : null)

/** PURE (wave 101C). The three NBA inputs from the rows above. */
/** @proofSeam exported so scripts/lead-action-plan-simulator.ts asserts each input's rule (and its positive control) on the pure function directly. */
export function contactTouchSignals(rows: ContactTouchRows, now: Date): Pick<NextBestActionContext, "lastAgentTouchAt" | "appointmentAt" | "callbackRequested" | "callbackDueAt"> {
  let lastAgentTouchAt: Date | null = null
  let appointmentAt: Date | null = null
  let callbackDueAt: Date | null = null
  let callbackRequested = false
  const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b)
  const sooner = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a < b ? a : b)
  for (const a of rows.activities) {
    const type = (a.activity_type ?? "").toLowerCase()
    const status = (a.status ?? "").toLowerCase()
    const done = status === "completed" || !!a.completed_at
    if (done && AGENT_TOUCH_ACTIVITY_TYPES.has(type) && (a.agent_id || a.agent_user_id)) {
      lastAgentTouchAt = later(lastAgentTouchAt, at(a.completed_at) ?? at(a.created_at))
    }
    if (done || CLOSED_ACTIVITY_STATUSES.has(status)) continue
    const when = at(a.scheduled_at)
    if (APPOINTMENT_ACTIVITY_TYPES.has(type) && when && when > now) appointmentAt = sooner(appointmentAt, when)
    if (type === "call") { callbackRequested = true; callbackDueAt = sooner(callbackDueAt, when) }
  }
  for (const s of rows.showings) {
    const when = at(s.scheduled_at)
    if (when && when > now && !CLOSED_ACTIVITY_STATUSES.has((s.status ?? "").toLowerCase())) appointmentAt = sooner(appointmentAt, when)
  }
  for (const t of rows.callbackTasks) {
    if ((t.status ?? "").toLowerCase() !== "pending") continue
    callbackRequested = true
    callbackDueAt = sooner(callbackDueAt, at(t.due_date))
  }
  return { lastAgentTouchAt, appointmentAt, callbackRequested, callbackDueAt }
}

/**
 * PURE (wave 101C). THE ORDER of a contact batch by the NBA: people the NBA would act on come
 * first, then by the NBA's own priority (intent momentum — rising moderate intent outranks
 * high-but-declining), then the detector's order (ghosted before stale, oldest first). A person
 * whose inputs could not be read sorts LAST (engageContact refuses them anyway — fail closed).
 * Wired: app/api/cron/stale-contact-monitor/route.ts.
 */
/** @proofSeam exported so scripts/lead-action-plan-simulator.ts asserts the order (and its controls) on the pure function directly. */
export function rankContactsForTouch<T>(items: ReadonlyArray<{ item: T; plan: LeadTouchPlan | null }>): T[] {
  const acts = (p: LeadTouchPlan | null) => (p && (p.action === "send_touch" || p.action === "convert") ? 1 : 0)
  return items
    .map((x, i) => ({ ...x, i }))
    .sort((a, b) =>
      Number(!!b.plan) - Number(!!a.plan)
      || acts(b.plan) - acts(a.plan)
      || (b.plan?.priority ?? 0) - (a.plan?.priority ?? 0)
      || a.i - b.i)
    .map((x) => x.item)
}

export type ContactNbaContextResult =
  | { ok: true; context: NextBestActionContext }
  | { ok: false; error: string }

export async function loadContactNbaContext(
  supabase: any,
  input: { brokerageId: string; contact: ContactNbaRow; humanInitiated: boolean; now: Date },
): Promise<ContactNbaContextResult> {
  const { brokerageId, contact, now } = input
  const { data: lineage, error: lineageErr } = await supabase
    .from("leads").select("id, long_term_nurture_until")
    .eq("brokerage_id", brokerageId).eq("contact_id", contact.id).limit(20)
  if (lineageErr) return { ok: false, error: `lineage leads read refused: ${lineageErr.message}` }
  const leadIds = ((lineage ?? []) as Array<{ id: string }>).map((l) => l.id)
  const keyed = leadIds.length > 0 ? `contact_id.eq.${contact.id},lead_id.in.(${leadIds.join(",")})` : `contact_id.eq.${contact.id}`
  const [isaRes, callRes] = await Promise.all([
    supabase.from("ai_isa_activities").select("outcome, created_at")
      .eq("brokerage_id", brokerageId).eq("activity_type", "outcome_recorded").or(keyed)
      .not("outcome", "is", null).order("created_at", { ascending: false }).limit(200),
    supabase.from("voice_calls").select("outcome, created_at")
      .eq("brokerage_id", brokerageId).or(keyed)
      .not("outcome", "is", null).order("created_at", { ascending: false }).limit(200),
  ])
  if (isaRes.error || callRes.error) {
    return { ok: false, error: `dead-end outcome read refused: ${(isaRes.error ?? callRes.error)?.message}` }
  }
  // Wave 101C: agent touch / appointment / pending callback (contactTouchSignals above). FAIL CLOSED
  // like the dead-end read: "nobody checked for a booked showing" never renders as "none booked".
  const [actRes, showRes, cbRes] = await Promise.all([
    supabase.from("activities").select("activity_type, status, agent_id, agent_user_id, scheduled_at, completed_at, created_at")
      .eq("brokerage_id", brokerageId).eq("contact_id", contact.id)
      .order("created_at", { ascending: false }).limit(200),
    supabase.from("showings").select("scheduled_at, status")
      .eq("brokerage_id", brokerageId).eq("contact_id", contact.id)
      .gte("scheduled_at", now.toISOString()).order("scheduled_at", { ascending: true }).limit(20),
    supabase.from("tasks").select("due_date, status")
      .eq("brokerage_id", brokerageId).eq("contact_id", contact.id)
      .eq("source", "ai_callback").eq("status", "pending").limit(20),
  ])
  if (actRes.error || showRes.error || cbRes.error) {
    return { ok: false, error: `touch / appointment / callback read refused: ${(actRes.error ?? showRes.error ?? cbRes.error)?.message}` }
  }
  const touch = contactTouchSignals({ activities: actRes.data ?? [], showings: showRes.data ?? [], callbackTasks: cbRes.data ?? [] }, now)
  const nurtureUntil = ((lineage ?? []) as Array<{ long_term_nurture_until: string | null }>)
    .map((l) => l.long_term_nurture_until).filter((v): v is string => !!v).sort().pop() ?? null
  const deadEnds = deadEndsFromLeadSources({
    isaOutcomes: isaRes.data ?? [],
    callOutcomes: callRes.data ?? [],
    qualificationSummary: contact.qualification_summary ?? null,
    longTermNurtureUntil: nurtureUntil,
    subject: "contact",
  })
  if (contact.ai_outreach_paused === true) deadEnds.push({ outcome: "paused", at: null, source: "contacts.ai_outreach_paused" })

  // Wave 102 (102B): the RELATIONSHIP GRAPH — household (evidence) and represented_by. A contact
  // represented by an OUTSIDE agent is another brokerage's client: an always-terminal
  // already_represented dead end (reasonsNotToAct blocks it whatever the settings say). A refused
  // read fails closed like the reads above; "no graph yet" (m698 unapplied) is an empty graph.
  const { neighbors: graphNeighbors, household: graphHousehold, representedByOutsideAgent } = await import("@/lib/kernel/relationship-graph")
  const [repRes, hhRes] = await Promise.all([
    graphNeighbors(supabase, { brokerageId, entity: { type: "contact", id: contact.id }, types: ["represented_by"], direction: "out" }),
    graphHousehold(supabase, { brokerageId, contactId: contact.id }),
  ])
  if (!repRes.ok || !hhRes.ok) return { ok: false, error: `relationship graph read refused: ${repRes.error ?? hhRes.error}` }
  const outsideRep = representedByOutsideAgent(repRes.edges, contact.id)
  if (outsideRep) {
    const at = Number.isFinite(Date.parse(outsideRep.evidence?.observed_at ?? "")) ? new Date(outsideRep.evidence.observed_at) : null
    deadEnds.push({ outcome: "already_represented", at, source: "relationship_edges.represented_by" })
  }
  const householdContactIds = hhRes.members.map((m) => m.contactId)

  const resolution = await resolveLeadSettingsResolution({ brokerageId })
  // An unreadable policy narrows to the DEFAULT suppressions — the always-terminal dead ends
  // (opt-out, represented) block regardless, so the fallback can only be stricter-or-equal.
  const suppressOnOutcomes = resolution.status === "unreadable"
    ? DEFAULT_AISA_SETTINGS.suppress_on_outcomes
    : (resolution.settings.suppress_on_outcomes ?? DEFAULT_AISA_SETTINGS.suppress_on_outcomes)

  const { buildBehavioralIntentSummary } = await import("@/lib/lead-intelligence/behavioral-summary")
  const { loadContactMemoryForPrompt, currentMemoryFacts } = await import("@/lib/kernel/conversation-memory")
  const [summary, memory] = await Promise.all([
    buildBehavioralIntentSummary(contact.id, brokerageId, supabase, { now }),
    loadContactMemoryForPrompt({ contactId: contact.id, brokerageId, client: supabase, now }),
  ])
  const lastAny = contact.last_contacted_at && Number.isFinite(Date.parse(contact.last_contacted_at)) ? new Date(contact.last_contacted_at) : null
  return {
    ok: true,
    context: {
      intent: summary.decayedIntent.independentSources > 0 ? summary.decayedIntent : undefined,
      outreachPaused: contact.ai_outreach_paused === true,
      lastAnyTouchAt: input.humanInitiated ? null : lastAny,
      // AUTONOMOUS runs only, like fatigue: a human who asks for the touch is never told "an agent is
      // handling it" / "wait for the showing" / "wait for the callback" by their own desk's work.
      lastAgentTouchAt: input.humanInitiated ? null : touch.lastAgentTouchAt,
      appointmentAt: input.humanInitiated ? null : touch.appointmentAt,
      callbackRequested: input.humanInitiated ? false : touch.callbackRequested,
      callbackDueAt: input.humanInitiated ? null : touch.callbackDueAt,
      deadEnds,
      suppressOnOutcomes,
      memoryFacts: memory ? currentMemoryFacts(memory.spine, now) : [],
      householdContactIds,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// THE SCHEDULER FOR TOUCHES 2..N — async
// ─────────────────────────────────────────────────────────────────────────────

export interface AdvanceLeadPlansResult {
  /** ISA-owned, unconverted, unassigned leads the sweep looked at. */
  examined: number
  /** Leads where the plan said a step was due and the producer was re-armed. */
  advanced: number
  /** Leads with nothing due, and WHY — the denominator's other half. */
  skipped: Array<{ leadId: string; code: LeadTouchPlanCode; reason: string }>
  warnings: string[]
}

/**
 * advanceLeadActionPlans — the scheduler nothing was.
 *
 * /api/cron/speed-to-lead selects `first_touched_at IS NULL` inside a 24-hour
 * window, so it fires the FIRST touch and then never sees that lead again. That
 * is the whole reason `max_touches_lead` and `touch_interval_days` had no reader:
 * there was never a second touch for them to govern.
 *
 * This adds NO producer. When the plan says a step is due it publishes the
 * EXISTING `asset_manager:lead_creative_handoff` signal, which is what already
 * commissions the persona intro reel (compliance-first, through the Director) and
 * stages the persona postcard. `publishManagerSignal` dedupes on an open signal
 * for the same entity, so re-arming is idempotent by construction.
 */
export async function advanceLeadActionPlans(input: {
  brokerageId: string
  leadId?: string | null
  limit?: number
  now?: Date
  supabase?: any
}): Promise<AdvanceLeadPlansResult> {
  const out: AdvanceLeadPlansResult = { examined: 0, advanced: 0, skipped: [], warnings: [] }

  if (!input.brokerageId) {
    out.warnings.push("advanceLeadActionPlans requires a brokerageId — refusing an un-scoped service-client read")
    return out
  }

  const supabase = input.supabase ?? (await import("@/lib/supabase/service")).createServiceClient()
  const now = input.now ?? new Date()
  const limit = Math.max(1, Math.min(input.limit ?? 50, 200))

  const resolution = await resolveLeadSettingsResolution({ brokerageId: input.brokerageId })
  const settings = resolutionSettings(resolution)

  // An unreadable policy does not schedule new outreach either. Advancing a plan
  // is not itself a send, but it COMMISSIONS one — and doing that against a policy
  // we could not read is the same failure one hop earlier.
  if (resolution.status === "unreadable") {
    out.warnings.push(`ISA settings unreadable (${resolution.detail}) — no lead plan advanced this sweep`)
    return out
  }
  if (settings.enabled === false) {
    out.warnings.push("AI ISA master switch is OFF for this owner — no lead plan advanced")
    return out
  }

  // The population: ISA-owned, unconverted, unassigned leads that have HAD a first
  // touch (the plan starts at step 2 — step 1 is speed-to-lead's, and duplicating
  // it is how a lead gets two hellos).
  const { excludeConvertedLeads } = await import("@/lib/contact-promotion/conversion-finality")
  let q = supabase
    .from("leads")
    .select(
      "id, brokerage_id, first_touched_at, first_touch_channel, lifecycle_state, is_active, agent_id, contact_id, " +
      "ai_outreach_paused, dnc_status, email, email_verified, email_opt_out, direct_mail_opt_out, " +
      "mailing_address, mailing_address_verified, mailing_city, mailing_state, mailing_zip, enrichment_profile, " +
      "duplicate_of_lead_id, duplicate_of_contact_id, qualification_summary, long_term_nurture_until, timeline",
    )
    .eq("brokerage_id", input.brokerageId)
    .eq("ai_isa_owner", true)
    .eq("is_active", true)
    .not("first_touched_at", "is", null)
    .is("agent_id", null)
    .limit(limit)
  if (input.leadId) q = q.eq("id", input.leadId)

  const { data: leads, error: leadsError } = await excludeConvertedLeads(q)
  if (leadsError) {
    out.warnings.push(`leads read refused (${leadsError.message}) — NO plan advanced this sweep`)
    return out
  }

  // NEGATIVE INTELLIGENCE (wave 98, 98C) — the dead ends already recorded for this page of leads, in
  // TWO batched reads (not one per lead). A refused read stops the sweep: "nobody checked whether this
  // person said no" must never render as "they never said no" (§4 fail closed).
  const pageIds = ((leads ?? []) as Array<{ id: string }>).map((l) => l.id)
  const isaOutcomesByLead = new Map<string, Array<{ outcome: string | null; created_at: string | null }>>()
  const callOutcomesByLead = new Map<string, Array<{ outcome: string | null; created_at: string | null }>>()
  if (pageIds.length > 0) {
    const [isaRes, callRes] = await Promise.all([
      supabase.from("ai_isa_activities").select("lead_id, outcome, created_at")
        .eq("brokerage_id", input.brokerageId).eq("activity_type", "outcome_recorded").in("lead_id", pageIds)
        .not("outcome", "is", null).order("created_at", { ascending: false }).limit(1000),
      supabase.from("voice_calls").select("lead_id, outcome, created_at")
        .eq("brokerage_id", input.brokerageId).in("lead_id", pageIds)
        .not("outcome", "is", null).order("created_at", { ascending: false }).limit(1000),
    ])
    if (isaRes.error || callRes.error) {
      out.warnings.push(`dead-end outcome read refused (${(isaRes.error ?? callRes.error)?.message}) — NO plan advanced this sweep`)
      return out
    }
    for (const r of (isaRes.data ?? []) as Array<{ lead_id: string; outcome: string | null; created_at: string | null }>) {
      const a = isaOutcomesByLead.get(r.lead_id) ?? []; a.push(r); isaOutcomesByLead.set(r.lead_id, a)
    }
    for (const r of (callRes.data ?? []) as Array<{ lead_id: string; outcome: string | null; created_at: string | null }>) {
      const a = callOutcomesByLead.get(r.lead_id) ?? []; a.push(r); callOutcomesByLead.set(r.lead_id, a)
    }
  }

  const { cohortFromEnrichment } = await import("./adaptive-reengagement")
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  const { buildLeadDecayedIntent } = await import("@/lib/lead-intelligence/behavioral-summary")
  const { recordNonAction } = await import("@/lib/kernel/action-ledger")

  for (const lead of (leads ?? []) as Array<Record<string, any>>) {
    out.examined++
    const leadId = lead.id as string

    // TOMBSTONE (lane 97B): `ai_outreach_paused || dnc_status` used to skip the lead
    // outright here. DNC is a PHONE registry; the ruling is "non-consenting leads get
    // email + direct mail only", and a lead plan never rides anything else — so DNC
    // now NARROWS (recorded as channel_restricted_no_consent) and the pause is a
    // blocking reason-not-to-act. Survivor: planNextLeadTouch's context (this file).

    // Touches DELIVERED, from the ISA's own record of truth.
    const { count: touchCount, error: touchError } = await supabase
      .from("isa_outreach_log")
      .select("id", { count: "exact", head: true })
      .eq("lead_id", leadId)
      .eq("brokerage_id", input.brokerageId)
    if (touchError) {
      out.skipped.push({ leadId, code: "blocked_lifecycle", reason: `isa_outreach_log count refused (${touchError.message}) — not advancing on an unknown touch count` })
      continue
    }

    const { data: lastTouch, error: lastTouchError } = await supabase
      .from("isa_outreach_log")
      .select("channel, created_at")
      .eq("lead_id", leadId)
      .eq("brokerage_id", input.brokerageId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (lastTouchError) {
      out.skipped.push({ leadId, code: "blocked_lifecycle", reason: `isa_outreach_log read refused (${lastTouchError.message})` })
      continue
    }

    // What the producers have ALREADY staged for this lead — so the plan never
    // asks for a second copy of a touch that is already waiting on a human.
    const { data: staged, error: stagedError } = await supabase
      .from("agent_client_messages")
      .select("channel, status, sent_at")
      .eq("brokerage_id", input.brokerageId)
      .eq("recipient_lead_id", leadId)
      .in("status", ["proposed", "approved", "sent"])
    if (stagedError) {
      out.skipped.push({ leadId, code: "blocked_lifecycle", reason: `agent_client_messages read refused (${stagedError.message})` })
      continue
    }

    // A staged EMAIL row could be the video email or a plain one; the reel's own
    // presence is what distinguishes them, so both are marked and the plan simply
    // has nothing email-shaped left to ask for.
    const stagedChannels: LeadPlanChannel[] = []
    for (const s of (staged ?? []) as Array<{ channel: string }>) {
      if (s.channel === "direct_mail") stagedChannels.push("direct_mail")
      else if (s.channel === "email") { stagedChannels.push("email"); stagedChannels.push("video_email") }
    }
    // Step 1 already went out — speed-to-lead stamped first_touched_at for it.
    if (lead.first_touched_at) stagedChannels.push("email")
    // FATIGUE SCOPE (lane 97B): the newest SENT touch from any producer, not only the ISA log.
    const sentTimes = ((staged ?? []) as Array<{ sent_at?: string | null }>)
      .map((r) => (r.sent_at ? new Date(r.sent_at).getTime() : NaN)).filter((t) => Number.isFinite(t))
    const lastSentAt = sentTimes.length > 0 ? new Date(Math.max(...sentTimes)) : null

    // THE REEL IS KEYED INSIDE THE JSONB, NOT IN A COLUMN. `ai_video_projects`
    // has NO `lead_id` column (live information_schema, 2026-08-25) — the lead
    // reel play stamps `video_metadata.audience='lead'` + `video_metadata.lead_id`
    // so the completion publisher can route it 1:1 instead of broadcasting it.
    // Querying a `lead_id` COLUMN here would have been a 42703 on every sweep, and
    // an unchecked one would have read as "this lead has no reel", forever.
    const { count: reelCount, error: reelError } = await supabase
      .from("ai_video_projects")
      .select("id", { count: "exact", head: true })
      .eq("brokerage_id", input.brokerageId)
      .eq("video_metadata->>lead_id", leadId)
    if (reelError) {
      out.warnings.push(`ai_video_projects count refused for lead ${leadId} (${reelError.message}) — treating the reel as absent`)
    }

    const planInput: PlanNextLeadTouchInput = {
      now,
      settings,
      touchesSoFar: touchCount ?? 0,
      lastTouchAt: lastTouch?.created_at ? new Date(lastTouch.created_at as string) : (lead.first_touched_at ? new Date(lead.first_touched_at as string) : null),
      lastChannel: (lastTouch?.channel as string | null) ?? (lead.first_touch_channel as string | null) ?? null,
      channelsAlreadyStaged: stagedChannels,
      emailUsable: !!(lead.email && lead.email_verified === true && lead.email_opt_out !== true),
      mailingVerified: !!(
        lead.mailing_address_verified === true &&
        lead.mailing_address && lead.mailing_city && lead.mailing_state && lead.mailing_zip &&
        lead.direct_mail_opt_out !== true
      ),
      reelReady: (reelCount ?? 0) > 0,
      lifecycleState: (lead.lifecycle_state as string | null) ?? null,
      cohort: cohortFromEnrichment(lead.enrichment_profile as { age?: number | null; age_range?: string | null } | null),
      context: {
        duplicateOf: (lead.duplicate_of_lead_id as string | null) ?? (lead.duplicate_of_contact_id as string | null) ?? null,
        outreachPaused: lead.ai_outreach_paused === true,
        dncOrNoConsent: true, // a lead is pre-consent by definition; dnc_status only confirms it
        lastAnyTouchAt: lastSentAt,
        deadEnds: deadEndsFromLeadSources({
          isaOutcomes: isaOutcomesByLead.get(leadId),
          callOutcomes: callOutcomesByLead.get(leadId),
          qualificationSummary: (lead.qualification_summary as string | null) ?? null,
          longTermNurtureUntil: (lead.long_term_nurture_until as string | null) ?? null,
        }),
        suppressOnOutcomes: settings.suppress_on_outcomes,
        // LANE 98B: the decayed intent of an UNCONVERTED lead, from its lead-keyed rows
        // (lib/lead-intelligence/behavioral-summary.ts buildLeadDecayedIntent). Null → omitted,
        // and the plan decides on cadence alone exactly as before.
        intent: (await buildLeadDecayedIntent(supabase, input.brokerageId, { id: leadId, timeline: (lead.timeline as string | null) ?? null }, now)) ?? undefined,
      },
    }
    const plan = planNextLeadTouch(planInput)

    // NBA → LEDGER (lane 98B): a wait / do_nothing verdict is an action too — recorded on
    // agent_action_ledger with its reason code and every reason-not-to-act, once per lead per
    // verdict per UTC day (the sweep re-runs; the idempotency key holds it to one row).
    // Wave 101 (101B): + the compact planner input (detail.decision_input) the replay harness re-runs.
    // Wave 102 (102C): EVERY verdict is a decision row — the acting ones (send_touch / convert) too,
    // with the same snapshot; the send below is its own 'executed' row (decisionRecordFor).
    const decisionRow = decisionRecordFor(plan, { brokerageId: input.brokerageId, leadId, now }, decisionInputSnapshot({ subject: "lead", plan: planInput }))
    {
      const rec = await recordNonAction(decisionRow, { client: supabase })
      if (!rec.recorded && rec.error) out.warnings.push(`lead ${leadId}: ${decisionRow.decision} not ledgered — ${rec.error}`)
    }

    if (plan.code !== "due" || !plan.step) {
      out.skipped.push({ leadId, code: plan.code, reason: plan.reason })
      continue
    }

    // RE-ARM THE EXISTING PRODUCER. Nothing new is authored here: the handoff is
    // what commissions the compliance-first reel and stages the persona postcard,
    // and it dedupes on its own open signal.
    const pub = await publishManagerSignal({
      brokerageId: input.brokerageId,
      fromManager: "ai_isa",
      toManager: "asset_manager",
      signalType: "lead_creative_handoff",
      message: `Lead action plan step ${plan.step.order} (${plan.step.channel}) is due — build the persona creative for this lead.`,
      entityType: "lead",
      entityId: leadId,
      payload: { lead_action_plan_step: plan.step.order, plan_channel: plan.step.channel },
    }, supabase)

    if (pub.ok) out.advanced++
    else out.warnings.push(`lead ${leadId}: could not publish lead_creative_handoff — ${pub.reason ?? "unknown"}`)
  }

  return out
}
