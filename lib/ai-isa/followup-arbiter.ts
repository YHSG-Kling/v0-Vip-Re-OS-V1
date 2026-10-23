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

import type { ExperienceKind, NextBestExperienceInput, NextBestExperiencePlan, RankedExperience } from "./lead-action-plan"
import type { FollowupPolicy } from "./followup-policy"

/** Memory facts the model may read — preferences and timing, never anything that describes who the person is. */
export const ARBITER_MEMORY_KEYS: readonly string[] = ["channel_preference", "timeline", "price_expectation", "preferred_contact_time", "language"]

export type ArbiterChannel = "email" | "sms" | "voice" | "video" | "portal"

export interface ArbiterOption {
  id: string
  kind: ExperienceKind
  /** Channels this option may ride (the permitted set, never wider); empty = the option has no channel (a task, a wait). */
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
}

export interface ArbiterDecision {
  optionId: string
  kind: ExperienceKind
  channel: ArbiterChannel | null
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
function arbiterFactsFromExperienceInput(input: NextBestExperienceInput, moment: ArbiterFacts["moment"] = null): ArbiterFacts {
  const n = input.nba
  return {
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

const CHANNELS_FOR_KIND = (kind: ExperienceKind, allowed: readonly string[], videoAllowed: boolean): ArbiterChannel[] => {
  const keep = (...c: ArbiterChannel[]) => c.filter((x) => allowed.includes(x))
  switch (kind) {
    case "communication": return keep("email", "sms", "voice")
    case "video": return videoAllowed ? ["video"] : []
    case "education": case "properties": case "market_update": return keep("email", "sms", "portal")
    case "portal_task": case "document_explanation": return ["portal"]
    default: return []
  }
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
  ctx: { allowedChannels: readonly string[]; videoAllowed: boolean; daysSinceMomentOpen?: number | null },
): ArbiterMenu {
  if (plan.locked) return { menu: [], locked: plan.locked }
  const overdue = typeof ctx.daysSinceMomentOpen === "number" && ctx.daysSinceMomentOpen >= policy.arbiter.maxDeferDays
  const menu: ArbiterOption[] = plan.ranked
    .filter((r) => (r.kind === "wait" ? !overdue : r.score > 0))
    .map((r: RankedExperience) => ({ id: r.kind, kind: r.kind, channels: CHANNELS_FOR_KIND(r.kind, ctx.allowedChannels, ctx.videoAllowed), why: r.reasons.slice(0, 4) }))
    // An option that needs a channel but has none permitted cannot be executed — it is not offered.
    .filter((o) => !(["communication", "video"] as ExperienceKind[]).includes(o.kind) || o.channels.length > 0)
  if (menu.length === 0) {
    // Overdue moment with nothing else on the table: a human decides (never silence).
    return { menu: [{ id: "agent_intervention", kind: "agent_intervention", channels: [], why: ["no automated option remains and waiting is exhausted"] }], locked: null }
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
  "Reply with JSON only: {optionId, channel|null, waitHours|null, rationale (1-3 sentences, plain words), evidence (the fact keys you used), confidence 0..1}.",
].join(" ")

function buildArbiterPrompt(a: { facts: ArbiterFacts; menu: ArbiterOption[]; policy: FollowupPolicy }): string {
  return JSON.stringify({
    tenant_guidance: a.policy.guidance || "(none set — use judgment)",
    moment: a.facts.moment,
    evidence: a.facts,
    options: a.menu.map((o) => ({ id: o.id, kind: o.kind, channels: o.channels, planner_reasons: o.why })),
    wait_bounds_hours: { min: 1, max: Math.max(1, a.policy.arbiter.maxDeferDays * 24) },
    platform_defaults_not_orders: { min_hours_between_touches: a.policy.guardrails.minHoursBetweenTouches },
  })
}

type ArbiterValidation = { ok: true; decision: Omit<ArbiterDecision, "source" | "fallbackReason" | "menu"> } | { ok: false; why: string }

/** PURE. The model's reply → a decision the platform will honour, or the reason it will not. (Module-private: scripts/intent-driven-followup-guard.ts drives every refusal THROUGH arbitrateAndRecordExperience.) */
function validateArbiterReply(raw: ArbiterRaw | null | undefined, menu: ArbiterOption[], facts: ArbiterFacts, policy: FollowupPolicy): ArbiterValidation {
  if (!raw || typeof raw !== "object") return { ok: false, why: "no reply" }
  const opt = menu.find((o) => o.id === raw.optionId)
  if (!opt) return { ok: false, why: `option "${String(raw.optionId)}" is not on the menu` }
  let channel: ArbiterChannel | null = null
  if (raw.channel !== null && raw.channel !== undefined && raw.channel !== "") {
    if (typeof raw.channel !== "string" || !opt.channels.includes(raw.channel as ArbiterChannel)) return { ok: false, why: `channel "${String(raw.channel)}" is not permitted for ${opt.id}` }
    channel = raw.channel as ArbiterChannel
  } else if (opt.channels.length > 0) {
    channel = opt.channels[0]
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
  return { ok: true, decision: { optionId: opt.id, kind: opt.kind, channel, waitHours, rationale: raw.rationale.trim().slice(0, 600), evidence, confidence } }
}

// ── the decision ─────────────────────────────────────────────────────────────────────────────

async function defaultDecide(a: { brokerageId: string; system: string; prompt: string }): Promise<ArbiterRaw> {
  const [{ generateObjectRouted }, { z }] = await Promise.all([import("@/lib/ai/models"), import("zod")])
  const schema = z.object({
    optionId: z.string(),
    channel: z.string().nullable(),
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
  a: { brokerageId: string; facts: ArbiterFacts; menu: ArbiterMenu; planned: ArbiterOption; policy: FollowupPolicy; budget?: ArbiterBudget },
  deps: { decide?: ArbiterDecide } = {},
): Promise<ArbiterDecision> {
  const base = (over: Partial<ArbiterDecision> & { fallbackReason: string }): ArbiterDecision => ({
    optionId: a.planned.id, kind: a.planned.kind, channel: a.planned.channels[0] ?? null, waitHours: null,
    rationale: `The planner's verdict stands: ${over.fallbackReason}.`, evidence: [], confidence: 1, source: "deterministic",
    menu: a.menu.menu.map((o) => o.id), ...over,
  })
  if (a.menu.locked) return base({ kind: a.menu.locked.kind, optionId: a.menu.locked.kind, channel: null, fallbackReason: `locked — ${a.menu.locked.reason}` })
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
  return { ...v.decision, source: "ai", fallbackReason: null, menu: a.menu.menu.map((o) => o.id) }
}

// ── experience-plan integration ──────────────────────────────────────────────────────────────

type ArbitratedPlan = { plan: NextBestExperiencePlan; decision: ArbiterDecision }

/**
 * Apply the arbiter to a planner verdict: the returned plan's `chosen` is the model's pick (re-timed for a wait), every
 * other field is the planner's. The plan keeps `ranked`, `nba`, `contributed` — the evidence — untouched.
 */
async function arbitrateExperiencePlan(
  a: { brokerageId: string; input: NextBestExperienceInput; plan: NextBestExperiencePlan; policy: FollowupPolicy; budget?: ArbiterBudget; moment?: ArbiterFacts["moment"]; daysDeferred?: number | null },
  deps: { decide?: ArbiterDecide } = {},
): Promise<ArbitratedPlan> {
  // Days the person has ALREADY been held: a moment's age since it OPENED, else the arbiter's own prior waits for this person.
  const ctx = { allowedChannels: a.input.policy.allowedChannels, videoAllowed: a.input.policy.videoAllowed, daysSinceMomentOpen: a.moment?.daysSinceOpen ?? a.daysDeferred ?? null }
  const menu = arbiterMenuFromPlan(a.plan, a.policy, ctx)
  const chosenOpt: ArbiterOption = { id: a.plan.chosen.kind, kind: a.plan.chosen.kind, channels: CHANNELS_FOR_KIND(a.plan.chosen.kind, ctx.allowedChannels, ctx.videoAllowed), why: a.plan.chosen.reasons.slice(0, 4) }
  const decision = await arbitrateFollowUp({ brokerageId: a.brokerageId, facts: arbiterFactsFromExperienceInput(a.input, a.moment ?? null), menu, planned: chosenOpt, policy: a.policy, budget: a.budget }, deps)
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
function arbitrationLedgerDetail(d: ArbiterDecision, policyRef: string | null): Record<string, unknown> {
  return { source: d.source, option: d.optionId, channel: d.channel, wait_hours: d.waitHours, rationale: d.rationale, evidence: d.evidence, confidence: d.confidence, fallback_reason: d.fallbackReason, menu: d.menu, policy_ref: policyRef }
}

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
  },
  deps: { decide?: ArbiterDecide; record?: Record<string, unknown> } = {},
): Promise<{ plan: NextBestExperiencePlan; decision: ArbiterDecision | null; recorded: Awaited<ReturnType<typeof import("./lead-action-plan").recordAndExecuteExperience>> }> {
  const { loadFollowupPolicy } = await import("./followup-policy")
  const { recordAndExecuteExperience } = await import("./lead-action-plan")
  const policy = a.policy ?? (await loadFollowupPolicy(svc, a.brokerageId)).policy
  let plan = a.plan
  let decision: ArbiterDecision | null = null
  if (!a.humanInitiated) {
    // A deferral must be BOUNDED even when nothing but the ledger remembers it (the engage path has no moment row): count this
    // person's prior arbiter waits; an unreadable ledger offers no wait at all (the planner's verdict stands).
    let daysDeferred: number | null = null
    if (!a.moment) {
      const waited = await countArbiterWaits(svc, { brokerageId: a.brokerageId, subject: { type: "contact", id: a.contactId }, now: a.now, policy })
      daysDeferred = waited ?? policy.arbiter.maxDeferDays
    }
    const arbitrated = await arbitrateExperiencePlan({ brokerageId: a.brokerageId, input: a.input, plan: a.plan, policy, budget: a.budget, moment: a.moment, daysDeferred }, { decide: deps.decide })
    plan = arbitrated.plan
    decision = arbitrated.decision
  }
  let policyRef: string | null = null
  if (decision) {
    try { policyRef = await (await import("@/lib/kernel/tenant-policy")).resolvePolicyRef(svc, a.brokerageId, "followup_policy") } catch { policyRef = null }
  }
  const recorded = await recordAndExecuteExperience(
    svc,
    { brokerageId: a.brokerageId, contactId: a.contactId, plan, now: a.now, missionId: a.missionId ?? null, systemSource: a.systemSource, arbitration: decision ? arbitrationLedgerDetail(decision, policyRef) : null },
    (deps.record ?? {}) as never,
  )
  // The model's own WAIT is the one decision countArbiterWaits must be able to find tomorrow — it is what bounds the deferral.
  if (decision && decision.source === "ai" && decision.kind === "wait") {
    const w = await recordArbitration(svc, { brokerageId: a.brokerageId, subject: { type: "contact", id: a.contactId }, decision, now: a.now, policyRef, systemSource: a.systemSource ?? "next_best_experience" })
    if (!w.recorded && w.error) console.warn(`[followup-arbiter] wait not ledgered for contact ${a.contactId}: ${w.error}`)
  }
  return { plan, decision, recorded }
}
