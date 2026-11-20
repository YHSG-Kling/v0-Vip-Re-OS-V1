/**
 * lib/sphere/lifetime-touch-arbitration.ts — THE CALENDAR LIFETIME TOUCHES PASS THE ARBITER (wave 153, lane 153P — owner B9:
 * "loop the bundles, omnipresence and refurbish, and lifetime and ghost. we need another plane or whatever starts an arbiter on").
 *
 * MEASURED AT BASE 1ef5df85: the lifetime starter is the daily cron app/api/cron/lifetime-customer-touchpoints (cron-dispatch
 * "0 9 * * *"). Its post-close MOMENTS already reached the arbiter (lib/sphere/followup-moments.ts → arbitrateAndRecordExperience),
 * but its two calendar touches — the home ANNIVERSARY (email) and the BIRTHDAY (sms) — went straight from the date match to
 * sendAnniversaryMessage / sendBirthdayMessage: no arbiter, no per-person timing, no "a person is already talking to them"
 * hold, and an opted-out past client was found out only when the send gate refused late.
 *
 * Now the cron hands each due calendar touch to arbitratePlannedTouch through planner `lifetime_touch` (appended to
 * ARBITER_PLANNER_ENTRY_POINTS) with a CLOSED menu and the planner's verdict (send now) as the fallback. The door itself:
 *   · HALTS when no lawful channel is left (requiredChannels → evaluateChannelReadiness: opt-out / no consent / DNC / no address);
 *   · HOLDS, with no model call, while a person on the team owns the conversation;
 *   · tells a RECENT INBOUND from an old quiet relationship (they wrote after our last touch → answer now, never deferred);
 *   · ledgers every decision (followup.decision.*, LAW 5).
 * A routine lawful lifetime touch needs NO human approval (owner B7) — the arbiter's choice is executed by the cron.
 * The model is asked only inside the application server (NEXT_RUNTIME — the review-ask precedent); elsewhere the planner's
 * verdict stands, still ledgered.
 *
 * WAVE 154 (lane 154H — owner R8, directive H7 / H8 / H9): THE ARBITER CHOOSES ACTION + CHANNEL + ARTIFACT + MANAGER, AND EVERY
 * FOLLOW-ON IS DURABLE. MEASURED AT BASE 6b53af30: the anniversary rode a hard-coded email; its sender
 * (app/actions/lifetime-customer-touchpoints.ts) fired the avatar video BESIDE every email (both, un-arbitrated); no-action was
 * not an answer; and a sent anniversary ended with nothing after it. Now:
 *   · CANDIDATES (a closed menu, each a verb + channels + artifact + manager): the warm sender-voice email (`send_now`), a
 *     personalized avatar greeting delivered on a channel that can PLAY it (`avatar_greeting` — the Asset Manager renders through
 *     the one anniversary video door; the portal card sweep distributes it), a private agent task to call (`agent_personally`),
 *     the coordinated pair (`send_with_agent` — ONE external delivery plus the task) — never all of them;
 *   · deterministic GATES screen them (identity of the verified milestone, consent per channel, tenant scope, the video opt-out,
 *     the agent's recorded voice / avatar, this year's video already given, relationship fatigue); the model recommends only among
 *     the eligible; nothing eligible and nothing lawful → the door halts; nothing eligible otherwise → an explicit `no_action`;
 *   · WHEN: the person's stated window and time zone, else the hour they actually reply in, else now inside the legal window
 *     (derivePersonTiming — no generic interval);
 *   · the whole record (why now, owner, refused / deferred options, the follow-on plan per option) rides the door's ledger row;
 *   · NEXT: a sent greeting persists a reply-watch follow-on (orchestrator_tasks, NEXT_ACTION_FOLLOW_ON_TASK) — a reply is the next
 *     trigger (lib/kernel/event-reactor.ts ISA_REPLY_RECEIVED → supersedeFollowOnsForPerson), silence ends the journey deliberately;
 *     a requested video persists a `video_render_ready` follow-on that delivers nothing itself, waits for the verified render, and
 *     on a failed or late render chooses the authorized alternate (or an agent task) with the SAME attribution and one delivery.
 */
import type { ArbiterChannel, ArbiterDecide, NextActionCandidate, NextActionFollowOnPayload, NextActionGate, NextActionNext, NextActionRecord, NextActionTiming, ProviderEvidence } from "@/lib/ai-isa/followup-arbiter"

type Svc = { from: (t: string) => any }

export type LifetimeTouchKind = "anniversary" | "birthday"
export type LifetimeTouchVerdict = "send" | "agent" | "wait" | "halt" | "video" | "no_action"

export interface LifetimeTouchInput {
  brokerageId: string
  contactId: string
  /** agents.id of the relationship owner (transactions.agent_id / contacts.agent_id) — the task's assignee. */
  agentId: string | null
  kind: LifetimeTouchKind
  channel: "email" | "sms"
  yearsAgo?: number | null
  transactionId?: string | null
  now: Date
}

export interface LifetimeTouchDecision {
  verdict: LifetimeTouchVerdict
  reason: string
  waitHours: number | null
  /** The agent task was written (verdict agent, or the pair). */
  routed: boolean
  source: string
  /** WAVE 154 (154H): what the cron executes — the greeting send (with or without the video) — and the full decision record. */
  plan?: { send: boolean; video: boolean; agentTask: boolean }
  record?: NextActionRecord
  /** The follow-on persisted by the door itself (video requested) — a send's follow-on is persisted by settleLifetimeTouchSend. */
  followOn?: { persisted: boolean; duplicate: boolean; error?: string } | null
}

type PlannedTouch = (svc: Svc, input: Record<string, unknown>, deps?: { decide?: ArbiterDecide }) => Promise<{ choice: string; decision: { waitHours: number | null; rationale: string; source: string }; halt?: { reason: string; refusals: Record<string, string[]> } | null }>

/** What the door reads about the person before it builds the menu (production: loadLifetimeContext). */
export interface LifetimeContext {
  contact: { found: boolean; hasEmail: boolean; hasLogin: boolean; videoOptOut: boolean; preferredTime: string | null; timeZone: string | null }
  lawful: { ok: true; lawful: ArbiterChannel[]; refusals: Record<string, string[]> } | { ok: false; reason: string }
  ownership: { owner: "ai" | "human" | "unknown"; why: string }
  inboundAts: string[]
  /** The agent's recorded voice + avatar (the anniversary video door's own precondition). */
  avatar: { ok: boolean | null; why: string }
  /** This year's anniversary video for this person, if one was already requested (agent_intro_videos, m121). */
  videoThisYear: { id: string | null; status: string | null }
  fatigue: string | null
  policy: { sendWindow: { startHour: number; endHour: number }; maxDeferDays: number }
  blindSpots: string[]
}

export interface LifetimeTouchDeps {
  /** @proofSeam scripts/marketing-loops-guard.ts — production uses arbitratePlannedTouch. */
  arbitrate?: PlannedTouch
  /** @proofSeam — production uses routeToAgent (lib/ai-isa/followup-arbiter.ts). */
  routeToAgent?: (svc: Svc, a: { brokerageId: string; contactId: string; agentId: string | null; title: string; description: string; now: Date; transactionId?: string | null }) => Promise<boolean>
  decide?: ArbiterDecide
  /** @proofSeam scripts/next-action-follow-on-guard.ts — production reads the live rows (loadLifetimeContext). */
  context?: (svc: Svc, a: LifetimeTouchInput) => Promise<LifetimeContext>
  /** @proofSeam — production asks the ONE anniversary video door (lib/video/intro-video-reactor.ts dispatchAnniversaryVideo). */
  requestVideo?: (svc: Svc, a: { brokerageId: string; contactId: string; agentId: string; yearsAgo: number }) => Promise<{ ok: boolean; status: string; introVideoId?: string | null; reason?: string | null }>
}

const LABEL: Record<LifetimeTouchKind, string> = { anniversary: "home anniversary", birthday: "birthday" }
const SPHERE_MANAGER = "sphere_of_influence"

/** The milestone's identity — one per contact per milestone year (the event the follow-on is keyed on). */
function milestoneEvent(a: LifetimeTouchInput): { type: string; id: string; version: number } {
  if (a.kind === "anniversary") return { type: "anniversary_triggered", id: a.transactionId ?? a.contactId, version: a.yearsAgo ?? a.now.getUTCFullYear() }
  return { type: "lifetime_birthday", id: a.contactId, version: a.now.getUTCFullYear() }
}

/** PURE. The closed menu for one due touch (ids are the door's option ids; `send_now` / `agent_personally` keep their wave-153 names). */
function lifetimeCandidates(a: LifetimeTouchInput, ctx: LifetimeContext): NextActionCandidate[] {
  const what = a.kind === "anniversary" && a.yearsAgo ? `${a.yearsAgo}-year ${LABEL[a.kind]}` : LABEL[a.kind]
  const greeting = { format: "written_message" as const, ref: null, readiness: "composed_at_send" as const, playableVia: [a.channel] as ArbiterChannel[], why: "written in the sender's voice by the brand-voice gateway and screened by the compliance gate at the one send door" }
  const out: NextActionCandidate[] = [
    { id: "send_now", verb: "send", channels: [a.channel], artifact: greeting, manager: SPHERE_MANAGER, supporting: ["ai_isa"], externalDeliveries: 1, why: [`today is the past client's ${what}`, `a warm ${a.channel} note in the sender's voice`] },
    { id: "agent_personally", verb: "notify_agent", channels: ["human_task"], artifact: null, manager: SPHERE_MANAGER, supporting: [], externalDeliveries: 0, why: ["a past client often answers the person, not the system — a private task for the agent to call"] },
    { id: "send_with_agent", verb: "send", channels: [a.channel, "human_task"], artifact: greeting, manager: SPHERE_MANAGER, supporting: ["ai_isa"], externalDeliveries: 1, why: ["one greeting plus a private reminder for the agent — one external delivery, never two"] },
  ]
  if (a.kind === "anniversary") {
    const playable: ArbiterChannel[] = ctx.contact.hasLogin ? ["in_app"] : []
    out.push({ id: "avatar_greeting", verb: "create", channels: playable, artifact: { format: "avatar_video", ref: ctx.videoThisYear.id ? { table: "agent_intro_videos", id: ctx.videoThisYear.id } : null, readiness: "creation_request", playableVia: playable, why: playable.length ? "the Asset Manager renders a personal greeting with the agent's recorded voice and avatar; only a verified ready render is delivered, on their portal" : "no portal sign-in — the anniversary video's delivery rail is the portal card, so nothing could play it to them" }, manager: "asset_manager", supporting: ["campaign_orchestrator", SPHERE_MANAGER], externalDeliveries: 1, why: [`a personal ${what} greeting from the agent, delivered on their portal once the render is verified ready`] })
  }
  return out
}

/** PURE. The deterministic gates for one due touch (H7.7). */
function lifetimeGates(a: LifetimeTouchInput, ctx: LifetimeContext): NextActionGate[] {
  const g: NextActionGate[] = []
  g.push({ gate: "tenant_scope", ok: ctx.contact.found, why: ctx.contact.found ? "the contact is in this tenant" : "the contact was not found in this tenant" })
  // The milestone's identity: a named closed / funded transaction. A caller that matched the date without naming one keeps the
  // wave-153 greeting / agent options, but the costly render is never commissioned on an unverified milestone (fail closed there).
  const verified = a.kind === "birthday" || !!a.transactionId
  g.push({ gate: "identity", ...(verified ? {} : { candidate: "avatar_greeting" }), ok: verified ? true : null, why: a.kind === "birthday" ? "the birthday on the contact's own record" : a.transactionId ? `the milestone is a closed / funded transaction (${a.transactionId})` : "no transaction named behind the anniversary — no render is commissioned on it" })
  const channels: ArbiterChannel[] = a.kind === "anniversary" ? [a.channel, "in_app"] : [a.channel]
  for (const ch of channels) {
    if (!ctx.lawful.ok) g.push({ gate: "consent", channel: ch, ok: null, why: ctx.lawful.reason })
    else g.push({ gate: "consent", channel: ch, ok: ctx.lawful.lawful.includes(ch), why: ctx.lawful.lawful.includes(ch) ? `${ch} is lawful for them (consent, opt-outs, DNC, an address)` : (ctx.lawful.refusals[ch] ?? ["not lawful"]).join("; ") })
  }
  const fatigued = ctx.fatigue === "high" || ctx.fatigue === "critical"
  for (const id of ["send_now", "send_with_agent", "avatar_greeting"]) {
    if (fatigued) g.push({ gate: "sensitivity", candidate: id, ok: false, why: `relationship fatigue is ${ctx.fatigue} — silence is the better answer than another message` })
  }
  g.push({ gate: "identity", candidate: "agent_personally", ok: !!a.agentId, why: a.agentId ? "an assigned agent can take the task" : "no assigned agent to give the task to" })
  g.push({ gate: "identity", candidate: "send_with_agent", ok: !!a.agentId, why: a.agentId ? "an assigned agent can take the reminder" : "no assigned agent to give the reminder to" })
  if (a.kind === "anniversary") {
    g.push({ gate: "consent", candidate: "avatar_greeting", ok: !ctx.contact.videoOptOut, why: ctx.contact.videoOptOut ? "they opted out of video" : "no video opt-out on file" })
    g.push({ gate: "licensing", candidate: "avatar_greeting", ok: a.agentId ? ctx.avatar.ok : false, why: a.agentId ? ctx.avatar.why : "no agent whose likeness and voice could front it" })
    const already = ctx.videoThisYear.status
    g.push({ gate: "artifact", candidate: "avatar_greeting", ok: already ? false : true, why: already ? `this year's anniversary video already exists (${already}) — never a second one` : "no anniversary video yet this year" })
    g.push({ gate: "spend", candidate: "avatar_greeting", ok: true, why: "the render's spend is checked at the one video door (dispatchVideo's vendor-budget gate), before any provider call" })
  }
  g.push({ gate: "review", ok: true, why: "a routine lawful lifetime touch needs no human approval (owner B7); the send gate still decides" })
  return g
}

/** PURE. What comes next for each option (the plan the ledger row carries; the chosen one is persisted). */
function nextFor(id: string, a: LifetimeTouchInput, windowEnd: string): NextActionNext {
  if ((id === "send_now" || id === "send_with_agent") && a.kind === "birthday") return { kind: "no_follow_on", reason: "a birthday greeting closes itself — a reply is answered by the inbound responder's own door, and no automated touch follows it" }
  if (id === "send_now" || id === "send_with_agent") return { kind: "follow_on", trigger: "timer_due", waitsFor: ["recipient_replied", "delivery_failed", "send_outcome_unknown"], condition: `a reply to the ${LABEL[a.kind]} greeting is the next trigger; at the window end, delivered or accepted with no reply ends the journey deliberately`, expectedEvidence: ["accepted", "delivered", "replied", "bounced", "failed", "unknown"], dependencies: ["the greeting's send settled"], windowEnd }
  if (id === "avatar_greeting") return { kind: "follow_on", trigger: "video_render_ready", waitsFor: ["video_render_ready", "recipient_replied"], condition: "the render is verified ready and the portal card delivered it; a failed or late render chooses the authorized alternate (or an agent task) under the same attribution", expectedEvidence: ["video_ready", "delivered", "failed"], dependencies: ["agent_intro_videos row (the Asset Manager's render request)"], windowEnd }
  if (id === "agent_personally") return { kind: "no_follow_on", reason: "the agent owns the next step (a private task) — no automated touch follows it" }
  if (id === "wait") return { kind: "follow_on", trigger: "timer_due", waitsFor: ["timer_due"], condition: "the deferred touch is a scheduled lifetime touchpoint the moments pass conducts through its own arbiter", expectedEvidence: ["lifetime_customer_touchpoints scheduled row"], dependencies: [], windowEnd: null }
  return { kind: "no_follow_on", reason: "no action was chosen" }
}

const EXPERIENCE_KIND: Record<string, "communication" | "video" | "agent_intervention"> = { send_now: "communication", send_with_agent: "communication", avatar_greeting: "video", agent_personally: "agent_intervention" }

export async function arbitrateLifetimeTouch(svc: Svc, a: LifetimeTouchInput, deps: LifetimeTouchDeps = {}): Promise<LifetimeTouchDecision> {
  const fa = await import("@/lib/ai-isa/followup-arbiter")
  const arbitrate: PlannedTouch = deps.arbitrate ?? (async (s, input, d) => fa.arbitratePlannedTouch(s, input as never, d) as never)
  const outsideApp = !process.env.NEXT_RUNTIME
  const decideDeps = deps.decide ? { decide: deps.decide } : outsideApp ? { decide: (async () => { throw new Error("no model call outside the application server") }) as ArbiterDecide } : {}
  const what = a.kind === "anniversary" && a.yearsAgo ? `${a.yearsAgo}-year ${LABEL[a.kind]}` : LABEL[a.kind]
  const ctx = await (deps.context ?? loadLifetimeContext)(svc, a).catch((e): LifetimeContext => ({ contact: { found: false, hasEmail: false, hasLogin: false, videoOptOut: false, preferredTime: null, timeZone: null }, lawful: { ok: false, reason: `context unreadable: ${e instanceof Error ? e.message : String(e)}` }, ownership: { owner: "unknown", why: "unreadable" }, inboundAts: [], avatar: { ok: null, why: "unreadable" }, videoThisYear: { id: null, status: null }, fatigue: null, policy: { sendWindow: { startHour: 8, endHour: 21 }, maxDeferDays: 1 }, blindSpots: ["the person's context could not be read"] }))
  const ev = milestoneEvent(a)
  const windowEnd = new Date(a.now.getTime() + Math.max(1, ctx.policy.maxDeferDays) * 86_400_000).toISOString()
  const timing: NextActionTiming = fa.derivePersonTiming({ statedTime: ctx.contact.preferredTime, timeZone: ctx.contact.timeZone, inboundAts: ctx.inboundAts, now: a.now, sendWindow: ctx.policy.sendWindow })
  const candidates = lifetimeCandidates(a, ctx)
  const gates = lifetimeGates(a, ctx)
  const screened = fa.screenNextActionCandidates(candidates, gates)
  const event = { type: ev.type, eventId: ev.id, version: ev.version, at: a.now.toISOString(), sourceEvidence: a.kind === "anniversary" ? `transaction ${a.transactionId ?? "?"} closed ${a.yearsAgo ?? "?"} year(s) ago today` : "the contact's birthday is today", causalParent: a.transactionId ?? null, brokerageId: a.brokerageId, recipient: { type: "contact" as const, id: a.contactId }, objective: `celebrate the past client's ${what} and stay genuinely in touch — no sales pressure` }
  const owner = { manager: SPHERE_MANAGER, responsibleSeat: a.agentId, conversationOwner: ctx.ownership, supporting: ["ai_isa", "asset_manager", "campaign_orchestrator"] }
  const plans = Object.fromEntries([...candidates.map((c) => c.id), "wait"].map((id) => [id, nextFor(id, a, windowEnd)]))
  const preRecord = fa.resolveNextActionRecord({ event, owner, candidates, gates, refused: screened.refused, chosen: null, held: null, decidedBy: "deterministic", timing, next: { kind: "no_follow_on", reason: "pending the door's choice — see next_by_option" } })
  const ledgerDetail = { ...fa.nextActionLedgerDetail(preRecord), next_by_option: Object.fromEntries(Object.entries(plans).map(([k, v]) => [k, v.kind === "follow_on" ? { kind: v.kind, trigger: v.trigger, waits_for: v.waitsFor } : v])), blind_spots: ctx.blindSpots.slice(0, 4) }

  // NOTHING ELIGIBLE: a lawful silence is an explicit, ledgered `no_action` (fatigue, a video-only menu that cannot run, no agent).
  // When the reason is that no channel is lawful at all, the door below halts it (the wave-153 rule, kept).
  const externalChannels = [...new Set(candidates.flatMap((c) => c.channels).filter((c) => c !== "human_task"))]
  if (screened.eligible.length === 0 && ctx.lawful.ok && externalChannels.some((c) => (ctx.lawful as { lawful: ArbiterChannel[] }).lawful.includes(c))) {
    const record = { ...preRecord, next: { kind: "no_follow_on" as const, reason: "no option passed its gates — the arbiter chose silence" } }
    const why = screened.refused.map((r) => `${r.id}: ${r.why[0] ?? "refused"}`).join(" | ")
    try {
      const { recordNonAction } = await import("@/lib/kernel/action-ledger")
      await recordNonAction({ brokerageId: a.brokerageId, domain: "followup", decision: "do_nothing", actor: { type: "manager", managerKey: "ai_isa" }, subject: { type: "contact", id: a.contactId }, reasonCode: "NO_ACTION_NEEDED", reasonDetail: `No ${LABEL[a.kind]} action: ${why}`.slice(0, 500), cycle: `arb:lifetime_touch:no_action:contact:${a.contactId}:${a.now.toISOString().slice(0, 10)}`, systemSource: "lifetime_touch", policyKey: "followup_policy", detail: { next_action: { ...ledgerDetail, next: record.next } } }, { client: svc as never })
    } catch { /* the verdict below still says why */ }
    return { verdict: "no_action", reason: `no option passed its gates: ${why}`, waitHours: null, routed: false, source: "deterministic", plan: { send: false, video: false, agentTask: false }, record }
  }

  // The planner's fallback, cheapest first: the greeting, else the agent, else the video (never the costliest by default).
  const eligibleIds = screened.eligible.map((c) => c.id)
  const planned = ["send_now", "agent_personally", "send_with_agent", "avatar_greeting"].find((id) => eligibleIds.includes(id)) ?? "send_now"
  let r: Awaited<ReturnType<PlannedTouch>>
  try {
    r = await arbitrate(svc, {
      brokerageId: a.brokerageId, planner: "lifetime_touch", subject: { type: "contact", id: a.contactId }, now: a.now,
      options: screened.eligible.map((c) => ({ id: c.id, kind: EXPERIENCE_KIND[c.id], channels: c.channels, why: c.why })),
      planned,
      // The touch's channel and every other channel a candidate would ride: when none is lawful, the door halts.
      requiredChannels: [a.channel, ...externalChannels.filter((c) => c !== a.channel)],
      moment: { key: `lifetime_${a.kind}`, intent: `A past client's ${what} is today — choose the one most fitting touch (a warm note, ${a.kind === "anniversary" ? "a personal video greeting, " : ""}the agent personally, or the note plus a reminder for the agent), or hold briefly if the evidence says now is the wrong moment. Never all of them.` },
      relationship: { type: "contact", persona: "past_client", hasAssignedAgent: !!a.agentId },
      nextAction: ledgerDetail,
    }, decideDeps)
  } catch (e) {
    // Fail closed: an arbitration that could not run is a WAIT (said), never a send nobody decided.
    return { verdict: "wait", reason: `arbiter unavailable: ${e instanceof Error ? e.message : String(e)}`, waitHours: null, routed: false, source: "error" }
  }
  const decidedBy: "ai" | "deterministic" = r.decision.source === "ai" || r.decision.source === "model" ? "ai" : "deterministic"
  if (r.halt) {
    const why = Object.entries(r.halt.refusals ?? {}).map(([c, rs]) => `${c}: ${rs.join("; ")}`).join(" | ")
    return { verdict: "halt", reason: `no lawful channel: ${why || r.halt.reason}`, waitHours: null, routed: false, source: r.decision.source, record: { ...preRecord, next: { kind: "no_follow_on", reason: "no lawful channel — the AI ISA's consented engagement continues on whatever is lawful" } } }
  }
  const chosen = screened.eligible.find((c) => c.id === r.choice) ?? null
  const record = fa.resolveNextActionRecord({ event, owner, candidates, gates, refused: screened.refused, chosen, held: chosen ? null : { waitHours: r.decision.waitHours, rationale: r.decision.rationale }, decidedBy, timing, next: plans[chosen?.id ?? "wait"] ?? { kind: "no_follow_on", reason: "unrecognised choice" } })
  const route = deps.routeToAgent ?? (async (s, x) => fa.routeToAgent(s, x))
  const routeAgent = (title: string) => route(svc, {
    brokerageId: a.brokerageId, contactId: a.contactId, agentId: a.agentId, now: a.now, transactionId: a.transactionId ?? null,
    title, description: `The follow-up arbiter chose a personal touch for this past client's ${what}: ${r.decision.rationale}`.slice(0, 900),
  }).catch(() => false)

  if (r.choice === "send_now") return { verdict: "send", reason: r.decision.rationale, waitHours: null, routed: false, source: r.decision.source, plan: { send: true, video: false, agentTask: false }, record }
  if (r.choice === "send_with_agent") {
    const routed = await routeAgent(`Personal follow-up: ${what}`)
    return { verdict: "send", reason: r.decision.rationale, waitHours: null, routed, source: r.decision.source, plan: { send: true, video: false, agentTask: true }, record }
  }
  if (r.choice === "agent_personally") {
    const routed = await routeAgent(`Reach out personally: ${what}`)
    return { verdict: "agent", reason: r.decision.rationale, waitHours: null, routed, source: r.decision.source, plan: { send: false, video: false, agentTask: true }, record }
  }
  if (r.choice === "avatar_greeting" && a.agentId && a.yearsAgo) {
    // THE ASSET MANAGER RENDERS (the one anniversary video door: consent, voice / avatar, pre-flight compliance, idempotent per
    // year); the portal card sweep (app/api/cron/intro-video-email-backfill) distributes ONLY the verified assembled render. The
    // follow-on below watches that render and owns the alternate — this door never claims the video was sent.
    const request = deps.requestVideo ?? defaultRequestVideo
    const v = await request(svc, { brokerageId: a.brokerageId, contactId: a.contactId, agentId: a.agentId, yearsAgo: a.yearsAgo }).catch((e) => ({ ok: false, status: "failed", introVideoId: null, reason: e instanceof Error ? e.message : String(e) }))
    const introId = v.introVideoId ?? null
    if (!v.ok || !introId || !["queued", "rendering", "already_queued"].includes(v.status)) {
      // The render could not even be requested: the follow-on is persisted at once, already due, so its executor picks the
      // authorized alternate with the same attribution (one decision, one trail) — never a silent drop.
      const fo = await persistLifetimeFollowOn(svc, a, record, { trigger: "video_render_ready", artifact: introId ? { table: "agent_intro_videos", id: introId } : null, windowEnd, scheduledFor: a.now.toISOString(), lawful: ctx.lawful.ok ? ctx.lawful.lawful : [], ownership: ctx.ownership.owner, failedRequest: v.reason ?? v.status })
      return { verdict: "video", reason: `the video could not be requested (${v.reason ?? v.status}) — the follow-on chooses the alternate`, waitHours: null, routed: false, source: r.decision.source, plan: { send: false, video: true, agentTask: false }, record, followOn: fo }
    }
    const { decideDeferral } = await import("@/lib/campaign-sequences/deferral-policy")
    const firstCheck = decideDeferral(0, a.now.getTime()).nextStepAt ?? a.now.toISOString()
    const fo = await persistLifetimeFollowOn(svc, a, record, { trigger: "video_render_ready", artifact: { table: "agent_intro_videos", id: introId }, windowEnd, scheduledFor: firstCheck, lawful: ctx.lawful.ok ? ctx.lawful.lawful : [], ownership: ctx.ownership.owner, failedRequest: null })
    return { verdict: "video", reason: r.decision.rationale, waitHours: null, routed: false, source: r.decision.source, plan: { send: false, video: true, agentTask: false }, record, followOn: fo }
  }
  // A WAIT IS PERSISTED, NEVER DROPPED: the cron matches the calendar date only on the day, so an unrecorded wait would lose
  // the touch. The deferral becomes a scheduled lifetime_customer_touchpoints row (tagged deferred_by: lifetime_touch) that the
  // SAME cron's moments pass (lib/sphere/followup-moments.ts) conducts through its own arbiter on the due date; the
  // lifetime-touchpoint reaper reports it if it ever slips.
  const deferred = await deferLifetimeTouch(svc, a, r.decision.waitHours, r.decision.rationale)
  return { verdict: "wait", reason: deferred.ok ? `${r.decision.rationale} — deferred to ${deferred.dueDate}` : `${r.decision.rationale} — DEFERRAL NOT RECORDED: ${deferred.reason}`, waitHours: r.decision.waitHours, routed: false, source: r.decision.source, plan: { send: false, video: false, agentTask: false }, record }
}

/** The touchpoint_type each calendar touch is stored under (live CHECK: lifetime_customer_touchpoints.touchpoint_type). */
export const LIFETIME_TOUCHPOINT_TYPE: Readonly<Record<LifetimeTouchKind, string>> = Object.freeze({ anniversary: "home_anniversary", birthday: "birthday" })
export const LIFETIME_DEFERRED_BY = "lifetime_touch"
/** When the arbiter held without naming hours, the touch is re-decided on the cron's NEXT DAILY PASS (the cron runs once a day —
 *  this is that schedule, not a contact cadence; census row 86 classification: a re-evaluation of the same decision). */
const NEXT_DAILY_PASS_HOURS = 24

/** Persist an arbiter wait as a due touchpoint (idempotent per contact · type · due date). Never throws. */
export async function deferLifetimeTouch(svc: Svc, a: LifetimeTouchInput, waitHours: number | null, rationale: string): Promise<{ ok: true; dueDate: string } | { ok: false; reason: string }> {
  try {
    const days = Math.max(1, Math.ceil((waitHours ?? NEXT_DAILY_PASS_HOURS) / 24))
    const dueDate = new Date(a.now.getTime() + days * 86_400_000).toISOString().slice(0, 10)
    const type = LIFETIME_TOUCHPOINT_TYPE[a.kind]
    const { data: existing, error: readErr } = await svc.from("lifetime_customer_touchpoints").select("id")
      .eq("brokerage_id", a.brokerageId).eq("contact_id", a.contactId).eq("touchpoint_type", type).eq("status", "scheduled").eq("scheduled_date", dueDate).limit(1)
    if (readErr) return { ok: false, reason: `existing deferral read refused: ${readErr.message}` }
    if ((existing ?? []).length > 0) return { ok: true, dueDate }
    const { data: ins, error } = await svc.from("lifetime_customer_touchpoints").insert({
      brokerage_id: a.brokerageId, contact_id: a.contactId, agent_id: a.agentId, related_transaction_id: a.transactionId ?? null,
      touchpoint_type: type, channel: a.channel, status: "scheduled", scheduled_date: dueDate,
      engagement_data: { deferred_by: LIFETIME_DEFERRED_BY, deferred_at: a.now.toISOString(), rationale: rationale.slice(0, 400), years_ago: a.yearsAgo ?? null },
    }).select("id")
    if (error) return { ok: false, reason: error.message }
    if (!Array.isArray(ins) || ins.length === 0) return { ok: false, reason: "deferral insert returned no row" }
    return { ok: true, dueDate }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

// ── WAVE 154 (154H): the live context, the post-send settle, and the follow-on executor ────────────────────────────────────────

/** Fail-soft read of everything the menu and gates need. Every unreadable slice is a blind spot (and a gate that fails closed). */
async function loadLifetimeContext(svc: Svc, a: LifetimeTouchInput): Promise<LifetimeContext> {
  const fa = await import("@/lib/ai-isa/followup-arbiter")
  const blindSpots: string[] = []
  const { data: c, error: cErr } = await svc.from("contacts").select("id, email, has_login, video_opt_out, preferred_contact_time, time_zone").eq("id", a.contactId).eq("brokerage_id", a.brokerageId).maybeSingle()
  if (cErr) blindSpots.push(`contact not read (${cErr.message})`)
  const row = (c ?? null) as { email?: string | null; has_login?: boolean | null; video_opt_out?: boolean | null; preferred_contact_time?: string | null; time_zone?: string | null } | null
  const lawfulRes = await fa.lawfulChannelsForContact(svc, { brokerageId: a.brokerageId, contactId: a.contactId })
  const own = await fa.loadConversationOwnership(svc, { brokerageId: a.brokerageId, contactId: a.contactId, conversationId: null, now: a.now })
  const ownership: LifetimeContext["ownership"] = !own.ok ? { owner: "unknown", why: own.reason } : own.ownership.humanEngagedAt || (own.ownership.humanOwnedUntil && Date.parse(own.ownership.humanOwnedUntil) > a.now.getTime()) ? { owner: "human", why: own.ownership.ownedReason ?? `a person on the team wrote at ${own.ownership.humanEngagedAt}` } : { owner: "ai", why: "no person is in a live conversation with them" }
  const { data: inbound, error: iErr } = await svc.from("messages").select("created_at").eq("brokerage_id", a.brokerageId).eq("contact_id", a.contactId).eq("direction", "inbound").order("created_at", { ascending: false }).limit(30)
  if (iErr) blindSpots.push(`reply history not read (${iErr.message})`)
  let avatar: LifetimeContext["avatar"] = { ok: false, why: "no agent" }
  if (a.agentId) {
    const { data: vp, error: vErr } = await svc.from("agent_voice_profiles").select("elevenlabs_voice_id, did_photo_url, did_video_url").eq("agent_id", a.agentId).limit(1).maybeSingle()
    const p = vp as { elevenlabs_voice_id?: string | null; did_photo_url?: string | null; did_video_url?: string | null } | null
    avatar = vErr ? { ok: null, why: `voice / avatar profile not read (${vErr.message})` } : p?.elevenlabs_voice_id && (p.did_photo_url || p.did_video_url) ? { ok: true, why: "the agent's recorded voice and avatar are on file (the video door re-checks consent)" } : { ok: false, why: "the agent has no recorded voice / avatar — Settings → Voice & Avatar" }
  }
  let videoThisYear: LifetimeContext["videoThisYear"] = { id: null, status: null }
  if (a.kind === "anniversary") {
    const { data: iv, error: ivErr } = await svc.from("agent_intro_videos").select("id, status").eq("brokerage_id", a.brokerageId).eq("contact_id", a.contactId).eq("trigger", "home_anniversary").eq("trigger_year", a.now.getUTCFullYear()).limit(1).maybeSingle()
    if (ivErr) { blindSpots.push(`this year's video not read (${ivErr.message})`); videoThisYear = { id: null, status: "unreadable" } }
    else if (iv) videoThisYear = { id: (iv as { id: string }).id, status: (iv as { status: string | null }).status }
  }
  const { data: f, error: fErr } = await svc.from("buyer_fatigue_scores").select("risk_level, last_calculated_at").eq("brokerage_id", a.brokerageId).eq("contact_id", a.contactId).order("last_calculated_at", { ascending: false }).limit(1).maybeSingle()
  if (fErr) blindSpots.push(`relationship fatigue not read (${fErr.message})`)
  let policy: LifetimeContext["policy"]
  try { const fp = (await (await import("@/lib/ai-isa/followup-policy")).loadFollowupPolicy(svc as never, a.brokerageId)).policy; policy = { sendWindow: fp.guardrails.quietHours, maxDeferDays: fp.arbiter.maxDeferDays } }
  catch { const fp = (await import("@/lib/ai-isa/followup-policy")).platformFollowupPolicy(); policy = { sendWindow: fp.guardrails.quietHours, maxDeferDays: fp.arbiter.maxDeferDays } }
  return {
    contact: { found: !!row, hasEmail: !!row?.email, hasLogin: row?.has_login === true, videoOptOut: row?.video_opt_out === true, preferredTime: row?.preferred_contact_time ?? null, timeZone: row?.time_zone ?? null },
    lawful: lawfulRes.ok ? { ok: true, lawful: [...lawfulRes.lawful], refusals: lawfulRes.refusals } : { ok: false, reason: lawfulRes.reason },
    ownership, inboundAts: ((inbound ?? []) as Array<{ created_at: string | null }>).map((m) => m.created_at).filter((x): x is string => !!x),
    avatar, videoThisYear, fatigue: ((f as { risk_level?: string | null } | null)?.risk_level ?? null), policy, blindSpots,
  }
}

async function defaultRequestVideo(_svc: Svc, a: { brokerageId: string; contactId: string; agentId: string; yearsAgo: number }) {
  const { dispatchAnniversaryVideo } = await import("@/lib/video/intro-video-reactor")
  const r = await dispatchAnniversaryVideo({ brokerageId: a.brokerageId, contactId: a.contactId, agentId: a.agentId, yearsAgo: a.yearsAgo, delivery: "portal" })
  return { ok: r.ok, status: r.status, introVideoId: r.introVideoId ?? null, reason: r.reason ?? null }
}

/** Build + persist ONE follow-on for a lifetime decision (the H8 envelope; ids only). */
async function persistLifetimeFollowOn(svc: Svc, a: LifetimeTouchInput, record: NextActionRecord, o: { trigger: "video_render_ready" | "timer_due"; artifact: { table: string; id: string } | null; windowEnd: string; scheduledFor: string; lawful: ArbiterChannel[]; ownership: string; failedRequest: string | null; providerMessageId?: string | null; originOverride?: { candidate: string; channels: ArbiterChannel[] } }): Promise<{ persisted: boolean; duplicate: boolean; error?: string }> {
  const fa = await import("@/lib/ai-isa/followup-arbiter")
  const ev = milestoneEvent(a)
  const plan = record.next.kind === "follow_on" ? record.next : null
  const waitsFor = o.trigger === "video_render_ready" ? ["video_render_ready", "recipient_replied"] as const : ["recipient_replied", "delivery_failed", "send_outcome_unknown"] as const
  const payload: NextActionFollowOnPayload = {
    idempotency_key: fa.nextActionFollowOnKey({ brokerageId: a.brokerageId, eventType: ev.type, eventId: ev.id, version: ev.version, subject: { type: "contact", id: a.contactId }, trigger: o.trigger }),
    planner: "lifetime_touch", brokerage_id: a.brokerageId,
    source_event: { type: ev.type, id: ev.id, version: ev.version, at: a.now.toISOString(), causal_parent: a.transactionId ?? null },
    subject_type: "contact", subject_id: a.contactId,
    actor: { agent_id: a.agentId, campaign_id: null, artifact: o.artifact },
    manager: o.trigger === "video_render_ready" ? "asset_manager" : SPHERE_MANAGER,
    trigger: o.trigger, waits_for: [...waitsFor],
    condition: plan?.condition ?? (o.trigger === "video_render_ready" ? "the render is verified ready, or the alternate is chosen" : "a reply is the next trigger; silence ends the journey"),
    expected_evidence: plan?.expectedEvidence ?? [],
    dependencies: plan?.dependencies ?? [],
    eligibility: { channels: o.originOverride?.channels ?? record.action.channels, lawful: o.lawful, conversation_owner: o.ownership, taken_at: a.now.toISOString() },
    window: { start: a.now.toISOString(), end: o.windowEnd },
    origin: { candidate: o.originOverride?.candidate ?? record.action.candidate, verb: record.action.verb, channels: o.originOverride?.channels ?? record.action.channels, years_ago: a.yearsAgo ?? null, transaction_id: a.transactionId ?? null, provider_message_id: o.providerMessageId ?? null },
    notify_agent_on_reply: !!a.agentId,
    state: "waiting", evaluations: 0, recovery_waits: 0,
    ...(o.failedRequest ? { outcome: { render_request: "failed", reason: o.failedRequest.slice(0, 300) } } : {}),
  }
  return fa.persistNextActionFollowOn(svc, payload, { scheduledFor: o.scheduledFor, now: a.now })
}

/**
 * AFTER THE CRON'S SEND (the greeting the arbiter chose): accepted → the reply-watch follow-on is persisted (the reply is the next
 * trigger; the window end evaluates silence honestly); a refused send persists nothing and says why (no fake receipt, no orphan).
 */
export async function settleLifetimeTouchSend(svc: Svc, a: LifetimeTouchInput, d: LifetimeTouchDecision, sent: { success: boolean; messageId?: string | null; error?: string }): Promise<{ followOn: "persisted" | "duplicate" | "none" | "error"; reason: string }> {
  if (!d.record || !d.plan?.send) return { followOn: "none", reason: "no greeting send was chosen" }
  if (d.record.next.kind === "no_follow_on") return { followOn: "none", reason: `no_follow_on: ${d.record.next.reason}` }
  if (!sent.success) return { followOn: "none", reason: `the send gate refused (${sent.error ?? "refused"}) — no receipt, no follow-on; the refusal is the record` }
  const windowEnd = d.record.next.kind === "follow_on" && d.record.next.windowEnd ? d.record.next.windowEnd : new Date(a.now.getTime() + 86_400_000).toISOString()
  const fo = await persistLifetimeFollowOn(svc, a, d.record, { trigger: "timer_due", artifact: null, windowEnd, scheduledFor: windowEnd, lawful: d.record.autonomy.gates.filter((g) => g.gate === "consent" && g.channel && g.ok === true).map((g) => g.channel as ArbiterChannel), ownership: d.record.owner.conversationOwner.owner, failedRequest: null, providerMessageId: sent.messageId ?? null })
  if (fo.error) return { followOn: "error", reason: fo.error }
  return { followOn: fo.duplicate ? "duplicate" : "persisted", reason: fo.duplicate ? "already persisted (idempotent)" : `reply watch until ${windowEnd}` }
}

export interface LifetimeFollowOnDeps {
  now?: () => Date
  /** @proofSeam — production: loadConversationOwnership. */
  ownership?: (svc: Svc, a: { brokerageId: string; contactId: string; now: Date }) => Promise<{ ok: true; lastInboundAt: string | null; humanActive: boolean; why: string } | { ok: false; reason: string }>
  /** @proofSeam — production: lawfulChannelsForContact. */
  lawful?: (svc: Svc, a: { brokerageId: string; contactId: string }) => Promise<{ ok: true; lawful: Set<ArbiterChannel> } | { ok: false; reason: string }>
  /** @proofSeam — production: the latest lifetime_customer_touchpoints status for this milestone, normalized (never upgraded). */
  evidence?: (svc: Svc, p: NextActionFollowOnPayload) => Promise<ProviderEvidence>
  /** @proofSeam — production: sendAnniversaryMessage (video: false) through the one email gate (its ledger cycle is per year). */
  sendGreeting?: (svc: Svc, p: NextActionFollowOnPayload) => Promise<{ success: boolean; messageId?: string | null; error?: string }>
  routeToAgent?: LifetimeTouchDeps["routeToAgent"]
}

type FollowOnVerdict = "completed" | "alternate" | "waiting" | "cancelled" | "suspended" | "failed" | "skipped"

/**
 * THE EXECUTOR of ONE due lifetime follow-on (app/api/cron/queue-drain routes NEXT_ACTION_FOLLOW_ON_TASK rows whose planner is
 * `lifetime_touch` here). Claim (pending → running, counted; a concurrent or replayed drain matches nothing) → refuse a wrong-tenant
 * or vanished person → RE-READ the person (a reply after the milestone consumes it; an agent in the conversation suppresses the
 * automation; a revoked seat suspends) → evaluate the trigger on its own evidence → settle. Never throws.
 */
export async function executeLifetimeFollowOn(svc: Svc, task: { id: string }, deps: LifetimeFollowOnDeps = {}): Promise<{ verdict: FollowOnVerdict; reason: string }> {
  const now = (deps.now ?? (() => new Date()))()
  const fa = await import("@/lib/ai-isa/followup-arbiter")
  try {
    const { data: claimed, error: claimErr } = await svc.from("orchestrator_tasks").update({ status: "running", updated_at: now.toISOString() })
      .eq("id", task.id).eq("task_type", fa.NEXT_ACTION_FOLLOW_ON_TASK).eq("status", "pending").select("id, brokerage_id, payload, attempts")
    if (claimErr) return { verdict: "skipped", reason: `claim refused: ${claimErr.message}` }
    if (!Array.isArray(claimed) || claimed.length !== 1) return { verdict: "skipped", reason: "already claimed or no longer pending (another drain took it)" }
    const t = claimed[0] as { id: string; brokerage_id: string; payload: NextActionFollowOnPayload; attempts: number | null }
    const B = t.brokerage_id
    const p = t.payload
    const settle = async (status: "completed" | "failed" | "cancelled" | "pending", o: Record<string, unknown>, patch: { scheduledFor?: string; payload?: Partial<NextActionFollowOnPayload>; lastError?: string | null } = {}): Promise<boolean> => {
      const terminal = status !== "pending"
      const { data: moved, error } = await svc.from("orchestrator_tasks").update({
        status, last_error: patch.lastError ? patch.lastError.slice(0, 500) : null, attempts: (t.attempts ?? 0) + 1,
        ...(patch.scheduledFor ? { scheduled_for: patch.scheduledFor } : {}), ...(terminal ? { executed_at: now.toISOString() } : {}), updated_at: now.toISOString(),
        payload: { ...p, ...(patch.payload ?? {}), evaluations: (p?.evaluations ?? 0) + 1, outcome: { ...(p?.outcome ?? {}), ...o, decided_at: now.toISOString() } },
      }).eq("id", t.id).eq("brokerage_id", B).eq("status", "running").select("id")
      if (error) { console.error(`[lifetime-follow-on] task ${t.id} → ${status} REFUSED: ${error.message}`); return false }
      return Array.isArray(moved) && moved.length === 1
    }
    // 1. The record must be readable and THIS tenant's.
    if (!p || p.planner !== "lifetime_touch" || p.subject_type !== "contact" || typeof p.subject_id !== "string") { await settle("failed", { status: "failed", reason: "unreadable follow-on payload — nothing was sent" }, { lastError: "unreadable payload" }); return { verdict: "failed", reason: "unreadable payload" } }
    if (p.brokerage_id !== B) { await settle("cancelled", { status: "cancelled", reason: "wrong tenant: the payload names another brokerage — nothing fires" }, { lastError: "wrong tenant" }); return { verdict: "cancelled", reason: "wrong tenant" } }
    const contactId = p.subject_id
    const { data: c, error: cErr } = await svc.from("contacts").select("id, deleted_at").eq("id", contactId).eq("brokerage_id", B).maybeSingle()
    const { decideDeferral } = await import("@/lib/campaign-sequences/deferral-policy")
    const holdRetry = async (why: string, counter: "evaluations" | "recovery_waits"): Promise<{ verdict: FollowOnVerdict; reason: string }> => {
      // A RETRY BACKOFF (census row 86: retry, never a contact cadence), bounded by the de-confliction deferral policy.
      const d = decideDeferral(p[counter] ?? 0, now.getTime())
      if (d.action === "reschedule" && d.nextStepAt) { await settle("pending", { last_check: why }, { scheduledFor: d.nextStepAt, payload: { [counter]: d.attempt } as Partial<NextActionFollowOnPayload> }); return { verdict: "waiting", reason: `${why} — re-checked at ${d.nextStepAt}` } }
      await settle("failed", { status: "failed", reason: `${why} — still unresolved after ${d.attempt - 1} re-checks; held as a visible exception, never re-sent blindly` }, { lastError: why })
      return { verdict: "failed", reason: why }
    }
    if (cErr) return await holdRetry(`the contact could not be read (${cErr.message})`, "evaluations")
    if (!c || (c as { deleted_at: string | null }).deleted_at) { await settle("cancelled", { status: "cancelled", reason: "the contact is no longer in this tenant" }); return { verdict: "cancelled", reason: "contact gone" } }

    // 2. DYNAMIC ELIGIBILITY — the person's newest state outranks the plan.
    const ownership = deps.ownership ?? (async (s: Svc, x: { brokerageId: string; contactId: string; now: Date }) => {
      const o = await fa.loadConversationOwnership(s, { brokerageId: x.brokerageId, contactId: x.contactId, conversationId: null, now: x.now })
      if (!o.ok) return { ok: false as const, reason: o.reason }
      const human = !!o.ownership.humanEngagedAt || (!!o.ownership.humanOwnedUntil && Date.parse(o.ownership.humanOwnedUntil) > x.now.getTime())
      return { ok: true as const, lastInboundAt: o.ownership.lastInboundAt, humanActive: human, why: o.ownership.ownedReason ?? (o.ownership.humanEngagedAt ? `a person on the team wrote at ${o.ownership.humanEngagedAt}` : "") }
    })
    const own = await ownership(svc, { brokerageId: B, contactId, now })
    if (!own.ok) return await holdRetry(`who owns the conversation could not be read (${own.reason})`, "evaluations")
    const routeAgent = deps.routeToAgent ?? (async (s: Svc, x: Parameters<NonNullable<LifetimeTouchDeps["routeToAgent"]>>[1]) => fa.routeToAgent(s, x))
    if (own.lastInboundAt && own.lastInboundAt > p.source_event.at) {
      // THE REPLY IS THE NEXT TRIGGER (a delayed or missed ISA_REPLY_RECEIVED cannot let a stale step through).
      let told = false
      if (p.notify_agent_on_reply) told = await routeAgent(svc, { brokerageId: B, contactId, agentId: p.actor?.agent_id ?? null, now, transactionId: p.origin?.transaction_id ?? null, title: "They replied to your anniversary touch", description: "Your past client wrote back after the anniversary touch. The AI ISA answers routine questions on its own; a personal reply from you is the natural next step. No automated follow-up will compete with it." }).catch(() => false)
      await settle("completed", { status: "completed", trigger: "recipient_replied", reason: `they replied at ${own.lastInboundAt} — the live conversation owns the next step`, agent_notified: told })
      return { verdict: "completed", reason: "recipient replied" }
    }
    if (own.humanActive) {
      await settle("cancelled", { status: "cancelled", reason: `a person on the team is in conversation with them (${own.why}) — no automated touch competes` })
      return { verdict: "cancelled", reason: "agent active" }
    }
    if (p.actor?.agent_id) {
      const { data: ag, error: agErr } = await svc.from("agents").select("user_id").eq("id", p.actor.agent_id).eq("brokerage_id", B).maybeSingle()
      const userId = (ag as { user_id?: string | null } | null)?.user_id ?? null
      let seatOk: boolean | null = agErr ? null : !!userId
      if (userId) {
        const { data: u, error: uErr } = await svc.from("users").select("status, deleted_at, brokerage_id").eq("id", userId).maybeSingle()
        const ur = u as { status?: string | null; deleted_at?: string | null; brokerage_id?: string | null } | null
        seatOk = uErr ? null : !!ur && !ur.deleted_at && ur.brokerage_id === B && (ur.status == null || ur.status === "active")
      }
      if (seatOk === false) {
        const d = decideDeferral(p.evaluations ?? 0, now.getTime())
        if (d.action === "reschedule" && d.nextStepAt) { await settle("pending", { state: "suspended", reason: "the responsible seat was revoked — suspended until a person reassigns the relationship" }, { scheduledFor: d.nextStepAt, payload: { state: "suspended" } }); return { verdict: "suspended", reason: "seat revoked" } }
        await settle("cancelled", { status: "cancelled", reason: "the responsible seat stayed revoked — the follow-on ends; nothing was sent" }); return { verdict: "cancelled", reason: "seat revoked (bounded)" }
      }
      if (seatOk === null) return await holdRetry("the responsible seat could not be read", "evaluations")
    }

    const windowPassed = !!p.window?.end && now.toISOString() >= p.window.end
    const alternate = async (why: string): Promise<{ verdict: FollowOnVerdict; reason: string }> => {
      // THE AUTHORIZED ALTERNATE, under the SAME attribution: the greeting on a lawful email (the one gate; its ledger cycle is one
      // per milestone year, so a re-run never sends twice), else the agent task — and an honest trail either way.
      const lawfulRead = await (deps.lawful ?? (async (s: Svc, x: { brokerageId: string; contactId: string }) => fa.lawfulChannelsForContact(s, x)))(svc, { brokerageId: B, contactId })
      const emailLawful = lawfulRead.ok && lawfulRead.lawful.has("email")
      if (emailLawful) {
        const send = deps.sendGreeting ?? defaultSendGreeting
        const s = await send(svc, p).catch((e) => ({ success: false, error: e instanceof Error ? e.message : String(e), messageId: null }))
        if (s.success) {
          await settle("completed", { status: "completed", alternate: "email", reason: why, attribution: { origin: p.origin, source_event: p.source_event }, evidence: "accepted", provider_message_id: s.messageId ?? null })
          const a: LifetimeTouchInput = { brokerageId: B, contactId, agentId: p.actor?.agent_id ?? null, kind: "anniversary", channel: "email", yearsAgo: p.origin?.years_ago ?? null, transactionId: p.origin?.transaction_id ?? null, now }
          const windowEnd = p.window?.end && p.window.end > now.toISOString() ? p.window.end : new Date(now.getTime() + 86_400_000).toISOString()
          const record = { action: { candidate: p.origin?.candidate ?? null, verb: "send" as const, channels: ["email"] as ArbiterChannel[] }, next: { kind: "follow_on" as const, trigger: "timer_due" as const, waitsFor: [], condition: "a reply to the alternate greeting is the next trigger; silence ends the journey deliberately", expectedEvidence: ["accepted", "delivered", "replied"], dependencies: [], windowEnd } } as unknown as NextActionRecord
          await persistLifetimeFollowOn(svc, { ...a, now: new Date(p.source_event.at) }, record, { trigger: "timer_due", artifact: null, windowEnd, scheduledFor: windowEnd, lawful: [...(lawfulRead.ok ? lawfulRead.lawful : [])], ownership: "ai", failedRequest: null, providerMessageId: s.messageId ?? null, originOverride: { candidate: `${p.origin?.candidate ?? "avatar_greeting"}→email_alternate`, channels: ["email"] } })
          return { verdict: "alternate", reason: `${why} — the greeting went by email instead (same milestone, one delivery)` }
        }
        why = `${why}; the email alternate was refused (${s.error ?? "refused"})`
      }
      const routed = await routeAgent(svc, { brokerageId: B, contactId, agentId: p.actor?.agent_id ?? null, now, transactionId: p.origin?.transaction_id ?? null, title: "Anniversary: a personal note from you", description: `The planned anniversary greeting could not go out automatically (${why}). A personal call or note from you is the honest next step.`.slice(0, 900) }).catch(() => false)
      await settle("completed", { status: "completed", alternate: routed ? "agent_task" : "none", reason: why, attribution: { origin: p.origin, source_event: p.source_event }, agent_task: routed })
      return { verdict: "alternate", reason: `${why} — ${routed ? "handed to the agent as a task" : "no lawful channel and no agent to hand to — recorded, nothing sent"}` }
    }

    // 3. THE TRIGGER, on its own evidence.
    if (p.trigger === "video_render_ready") {
      const ref = p.actor?.artifact
      if (!ref || ref.table !== "agent_intro_videos") return await alternate(`the video could not be requested (${String((p.outcome as Record<string, unknown> | undefined)?.reason ?? "no render on record")})`)
      const { data: iv, error: ivErr } = await svc.from("agent_intro_videos").select("id, status, error_message").eq("id", ref.id).eq("brokerage_id", B).maybeSingle()
      if (ivErr) return await holdRetry(`the render could not be read (${ivErr.message})`, "evaluations")
      const st = (iv as { status?: string | null } | null)?.status ?? null
      if (st === "delivered") {
        await settle("completed", { status: "completed", evidence: { video_ready: true, delivered: "portal card (in_app)" }, reason: "the verified render was delivered on their portal by the Campaign rail" })
        // NEXT: the reply watch (a reply is the next trigger; silence ends the journey).
        const windowEnd = p.window?.end && p.window.end > now.toISOString() ? p.window.end : new Date(now.getTime() + 86_400_000).toISOString()
        const a: LifetimeTouchInput = { brokerageId: B, contactId, agentId: p.actor?.agent_id ?? null, kind: "anniversary", channel: "email", yearsAgo: p.origin?.years_ago ?? null, transactionId: p.origin?.transaction_id ?? null, now: new Date(p.source_event.at) }
        const record = { action: { candidate: p.origin?.candidate ?? "avatar_greeting", verb: "create" as const, channels: ["in_app"] as ArbiterChannel[] }, next: { kind: "follow_on" as const, trigger: "timer_due" as const, waitsFor: [], condition: "a reply after the video is the next trigger; silence ends the journey deliberately", expectedEvidence: ["delivered", "replied"], dependencies: [], windowEnd } } as unknown as NextActionRecord
        await persistLifetimeFollowOn(svc, a, record, { trigger: "timer_due", artifact: ref, windowEnd, scheduledFor: windowEnd, lawful: p.eligibility?.lawful ?? [], ownership: "ai", failedRequest: null })
        return { verdict: "completed", reason: "video delivered" }
      }
      if (st === "failed" || st === "suppressed" || !st) return await alternate(`the render ${st ?? "row is missing"}${(iv as { error_message?: string | null } | null)?.error_message ? ` (${(iv as { error_message: string }).error_message.slice(0, 160)})` : ""}`)
      // Still queued / rendering.
      if (!windowPassed) {
        const d = decideDeferral(p.evaluations ?? 0, now.getTime())
        if (d.action === "reschedule" && d.nextStepAt) { const next = d.nextStepAt < (p.window?.end ?? d.nextStepAt) ? d.nextStepAt : p.window.end ?? d.nextStepAt; await settle("pending", { last_check: `render ${st}` }, { scheduledFor: next }); return { verdict: "waiting", reason: `render ${st} — re-checked at ${next}` } }
      }
      // LATE: suppress the still-rendering request FIRST (counted, status-guarded) so the portal sweep can never deliver it after the
      // alternate — exactly one external delivery. A suppression that matched nothing means the render moved under us: re-read.
      const { data: sup, error: supErr } = await svc.from("agent_intro_videos").update({ status: "suppressed", error_message: "superseded: the render was not ready inside the anniversary window — an alternate was chosen" })
        .eq("id", ref.id).eq("brokerage_id", B).in("status", ["queued", "rendering"]).select("id")
      if (supErr) return await holdRetry(`the late render could not be superseded (${supErr.message})`, "evaluations")
      if (!Array.isArray(sup) || sup.length !== 1) {
        const { data: again } = await svc.from("agent_intro_videos").select("status").eq("id", ref.id).eq("brokerage_id", B).maybeSingle()
        if ((again as { status?: string } | null)?.status === "delivered") { await settle("completed", { status: "completed", evidence: { video_ready: true, delivered: "portal card (in_app)" }, reason: "delivered at the last moment — no alternate" }); return { verdict: "completed", reason: "video delivered (race)" } }
      }
      return await alternate(`the render was still ${st} when the window ended`)
    }
    if (p.trigger === "timer_due") {
      const readEvidence = deps.evidence ?? defaultEvidence
      const e = await readEvidence(svc, p).catch((): ProviderEvidence => "unknown")
      const fires = fa.evidenceFires(e)
      if (fires.includes("delivery_failed")) return await alternate(`the greeting's provider evidence is ${e}`)
      if (fires.includes("send_outcome_unknown")) return await holdRetry("the greeting's outcome is unknown — reconciled by send recovery first, never re-sent blindly", "recovery_waits")
      await settle("completed", { status: "completed", evidence: e, next: "no_follow_on", reason: `the greeting is ${e} and no reply came by the window end — silence is not a reason to nag; the journey ends deliberately` })
      return { verdict: "completed", reason: `ended deliberately (${e}, no reply)` }
    }
    await settle("failed", { status: "failed", reason: `no executor for trigger ${String(p.trigger)}` }, { lastError: "unknown trigger" })
    return { verdict: "failed", reason: "unknown trigger" }
  } catch (err) {
    return { verdict: "skipped", reason: `threw before a send: ${(err as Error)?.message ?? String(err)}` }
  }
}

/**
 * A lifetime follow-on CLAIMED but never settled (the drain died mid-evaluation) is RE-QUEUED under its same idempotency key: its
 * only external send (the email alternate) rides dispatchEmail's per-milestone-year ledger cycle, so the re-run replays instead of
 * sending twice. Bounded by the deferral policy's MAX_DEFERS (payload.recovery_waits); past it, closed failed as a visible
 * exception. Called once per queue-drain tick. Never throws.
 */
export async function recoverStaleLifetimeFollowOns(svc: Svc, deps: { now?: () => Date } = {}): Promise<{ recovered: number; errors: string[] }> {
  const now = (deps.now ?? (() => new Date()))()
  const out = { recovered: 0, errors: [] as string[] }
  try {
    const { NEXT_ACTION_FOLLOW_ON_TASK } = await import("@/lib/ai-isa/followup-arbiter")
    const { STALE_IN_FLIGHT_MINUTES } = await import("@/lib/kernel/completion-tracking")
    const { MAX_DEFERS } = await import("@/lib/campaign-sequences/deferral-policy")
    const cutoff = new Date(now.getTime() - STALE_IN_FLIGHT_MINUTES * 60_000).toISOString()
    const { data, error } = await svc.from("orchestrator_tasks").select("id, brokerage_id, payload").eq("task_type", NEXT_ACTION_FOLLOW_ON_TASK).eq("status", "running").lt("updated_at", cutoff).limit(50)
    if (error) { out.errors.push(`stale next-action follow-ons unreadable: ${error.message}`); return out }
    for (const row of (data ?? []) as Array<{ id: string; brokerage_id: string; payload: NextActionFollowOnPayload }>) {
      const waits = row.payload?.recovery_waits ?? 0
      const requeue = waits < MAX_DEFERS
      const note = requeue ? `the drain stopped mid-evaluation — re-queued under the same key (${waits + 1}/${MAX_DEFERS}); the send ledger makes a re-run at-most-once` : `the drain stopped mid-evaluation ${waits + 1} times — not re-queued again (a person can review it)`
      const { data: moved, error: mErr } = await svc.from("orchestrator_tasks").update({
        status: requeue ? "pending" : "failed", last_error: note, scheduled_for: now.toISOString(), updated_at: now.toISOString(), ...(requeue ? {} : { executed_at: now.toISOString() }),
        payload: { ...row.payload, recovery_waits: waits + 1, outcome: { ...(row.payload?.outcome ?? {}), last_recovery: note } },
      }).eq("id", row.id).eq("brokerage_id", row.brokerage_id).eq("status", "running").lt("updated_at", cutoff).select("id")
      if (mErr) { out.errors.push(`${row.id}: ${mErr.message}`); continue }
      if (Array.isArray(moved) && moved.length === 1) out.recovered++
    }
  } catch (e) {
    out.errors.push(e instanceof Error ? e.message : String(e))
  }
  return out
}

/** The milestone's latest touchpoint status → the evidence vocabulary (sent = ACCEPTED, never delivered; nothing = unknown). */
async function defaultEvidence(svc: Svc, p: NextActionFollowOnPayload): Promise<ProviderEvidence> {
  const { normalizeProviderEvidence } = await import("@/lib/ai-isa/followup-arbiter")
  const { data, error } = await svc.from("lifetime_customer_touchpoints").select("status, created_at").eq("brokerage_id", p.brokerage_id).eq("contact_id", p.subject_id).eq("touchpoint_type", "home_anniversary").gte("created_at", p.source_event.at).order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (error || !data) return "unknown"
  return normalizeProviderEvidence((data as { status: string | null }).status)
}

async function defaultSendGreeting(svc: Svc, p: NextActionFollowOnPayload): Promise<{ success: boolean; messageId?: string | null; error?: string }> {
  if (!p.actor?.agent_id || !p.origin?.years_ago) return { success: false, error: "no agent or milestone year on the follow-on — the greeting cannot be composed" }
  const { sendAnniversaryMessage } = await import("@/app/actions/lifetime-customer-touchpoints")
  const r = await sendAnniversaryMessage(p.subject_id, p.origin.years_ago, { agentId: p.actor.agent_id, client: svc as never, video: false })
  return { success: r.success, messageId: (r as { messageId?: string | null }).messageId ?? null, error: (r as { error?: string }).error }
}
