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

import type { AIISASettings } from "./settings-types"
import { DEFAULT_AISA_SETTINGS } from "./settings-types"
import { pickLeadOutreachChannel } from "./lead-channel-policy"
import { permittedLeadChannels, decideNextChannel } from "./next-best-touch"
import type { GenerationalCohort } from "@/lib/kernel/education"

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

export interface LeadTouchPlan {
  code: LeadTouchPlanCode
  /** The step to run when `code === "due"`. */
  step: LeadPlanStep | null
  /** The channel the step will actually ride, after consent narrowing. */
  channel: LeadPlanChannel | null
  reason: string
  /** When the next touch becomes due, when it is not due yet. */
  dueAt: Date | null
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
export function planNextLeadTouch(input: {
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
}): LeadTouchPlan {
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
    const res = await approveClientMessage(messageId, null, undefined, supabase)

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
  })
  if (!compliance.allowed) {
    return { ok: false, reason: `compliance gate blocked the body: ${compliance.blockedReason ?? (compliance.violations ?? []).join("; ")}` }
  }

  return { ok: true, reason: personalized.reason }
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
      "mailing_address, mailing_address_verified, mailing_city, mailing_state, mailing_zip, enrichment_profile",
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

  const { cohortFromEnrichment } = await import("./adaptive-reengagement")
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")

  for (const lead of (leads ?? []) as Array<Record<string, any>>) {
    out.examined++
    const leadId = lead.id as string

    if (lead.ai_outreach_paused === true || lead.dnc_status === true) {
      out.skipped.push({ leadId, code: "blocked_lifecycle", reason: "ai_outreach_paused or dnc_status is set" })
      continue
    }

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
      .select("channel, status")
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

    const plan = planNextLeadTouch({
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
    })

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
