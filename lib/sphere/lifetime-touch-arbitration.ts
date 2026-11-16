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
 * ARBITER_PLANNER_ENTRY_POINTS) with a CLOSED menu — send now on the touch's channel, or the agent reaches out personally
 * (a ready task), or the arbiter's bounded wait — and the planner's verdict (send now) as the fallback. The door itself:
 *   · HALTS when no lawful channel is left (requiredChannels → evaluateChannelReadiness: opt-out / no consent / DNC / no address);
 *   · HOLDS, with no model call, while a person on the team owns the conversation;
 *   · tells a RECENT INBOUND from an old quiet relationship (they wrote after our last touch → answer now, never deferred);
 *   · ledgers every decision (followup.decision.*, LAW 5).
 * A routine lawful lifetime touch needs NO human approval (owner B7) — the arbiter's choice is executed by the cron.
 * The model is asked only inside the application server (NEXT_RUNTIME — the review-ask precedent); elsewhere the planner's
 * verdict stands, still ledgered.
 */
import type { ArbiterDecide } from "@/lib/ai-isa/followup-arbiter"

type Svc = { from: (t: string) => any }

export type LifetimeTouchKind = "anniversary" | "birthday"
export type LifetimeTouchVerdict = "send" | "agent" | "wait" | "halt"

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
  /** The agent task was written (verdict agent). */
  routed: boolean
  source: string
}

type PlannedTouch = (svc: Svc, input: Record<string, unknown>, deps?: { decide?: ArbiterDecide }) => Promise<{ choice: string; decision: { waitHours: number | null; rationale: string; source: string }; halt?: { reason: string; refusals: Record<string, string[]> } | null }>

export interface LifetimeTouchDeps {
  /** @proofSeam scripts/marketing-loops-guard.ts — production uses arbitratePlannedTouch. */
  arbitrate?: PlannedTouch
  /** @proofSeam — production uses routeToAgent (lib/ai-isa/followup-arbiter.ts). */
  routeToAgent?: (svc: Svc, a: { brokerageId: string; contactId: string; agentId: string | null; title: string; description: string; now: Date; transactionId?: string | null }) => Promise<boolean>
  decide?: ArbiterDecide
}

const LABEL: Record<LifetimeTouchKind, string> = { anniversary: "home anniversary", birthday: "birthday" }

export async function arbitrateLifetimeTouch(svc: Svc, a: LifetimeTouchInput, deps: LifetimeTouchDeps = {}): Promise<LifetimeTouchDecision> {
  const arbitrate: PlannedTouch = deps.arbitrate ?? (async (s, input, d) => (await import("@/lib/ai-isa/followup-arbiter")).arbitratePlannedTouch(s, input as never, d) as never)
  const outsideApp = !process.env.NEXT_RUNTIME
  const decideDeps = deps.decide ? { decide: deps.decide } : outsideApp ? { decide: (async () => { throw new Error("no model call outside the application server") }) as ArbiterDecide } : {}
  const what = a.kind === "anniversary" && a.yearsAgo ? `${a.yearsAgo}-year ${LABEL[a.kind]}` : LABEL[a.kind]
  let r: Awaited<ReturnType<PlannedTouch>>
  try {
    r = await arbitrate(svc, {
      brokerageId: a.brokerageId, planner: "lifetime_touch", subject: { type: "contact", id: a.contactId }, now: a.now,
      options: [
        { id: "send_now", kind: "communication", channels: [a.channel], why: [`today is the past client's ${what}`, `the touch rides ${a.channel}, the channel this calendar touch has always used`] },
        { id: "agent_personally", kind: "agent_intervention", channels: ["human_task"], why: ["a past client often answers the person, not the system — the agent may reach out personally"] },
      ],
      planned: "send_now",
      requiredChannels: [a.channel],
      moment: { key: `lifetime_${a.kind}`, intent: `A past client's ${what} is today — send the ${LABEL[a.kind]} note now, have the agent reach out personally, or hold briefly if the evidence says now is the wrong moment.` },
      relationship: { type: "contact", persona: "past_client", hasAssignedAgent: !!a.agentId },
    }, decideDeps)
  } catch (e) {
    // Fail closed: an arbitration that could not run is a WAIT (said), never a send nobody decided.
    return { verdict: "wait", reason: `arbiter unavailable: ${e instanceof Error ? e.message : String(e)}`, waitHours: null, routed: false, source: "error" }
  }
  if (r.halt) {
    const why = Object.entries(r.halt.refusals ?? {}).map(([c, rs]) => `${c}: ${rs.join("; ")}`).join(" | ")
    return { verdict: "halt", reason: `no lawful channel: ${why || r.halt.reason}`, waitHours: null, routed: false, source: r.decision.source }
  }
  if (r.choice === "send_now") return { verdict: "send", reason: r.decision.rationale, waitHours: null, routed: false, source: r.decision.source }
  if (r.choice === "agent_personally") {
    const route = deps.routeToAgent ?? (async (s, x) => (await import("@/lib/ai-isa/followup-arbiter")).routeToAgent(s, x))
    const routed = await route(svc, {
      brokerageId: a.brokerageId, contactId: a.contactId, agentId: a.agentId, now: a.now, transactionId: a.transactionId ?? null,
      title: `Reach out personally: ${what}`, description: `The follow-up arbiter chose a personal touch for this past client's ${what}: ${r.decision.rationale}`.slice(0, 900),
    }).catch(() => false)
    return { verdict: "agent", reason: r.decision.rationale, waitHours: null, routed, source: r.decision.source }
  }
  // A WAIT IS PERSISTED, NEVER DROPPED: the cron matches the calendar date only on the day, so an unrecorded wait would lose
  // the touch. The deferral becomes a scheduled lifetime_customer_touchpoints row (tagged deferred_by: lifetime_touch) that the
  // SAME cron's moments pass (lib/sphere/followup-moments.ts) conducts through its own arbiter on the due date; the
  // lifetime-touchpoint reaper reports it if it ever slips.
  const deferred = await deferLifetimeTouch(svc, a, r.decision.waitHours, r.decision.rationale)
  return { verdict: "wait", reason: deferred.ok ? `${r.decision.rationale} — deferred to ${deferred.dueDate}` : `${r.decision.rationale} — DEFERRAL NOT RECORDED: ${deferred.reason}`, waitHours: r.decision.waitHours, routed: false, source: r.decision.source }
}

/** The touchpoint_type each calendar touch is stored under (live CHECK: lifetime_customer_touchpoints.touchpoint_type). */
export const LIFETIME_TOUCHPOINT_TYPE: Readonly<Record<LifetimeTouchKind, string>> = Object.freeze({ anniversary: "home_anniversary", birthday: "birthday" })
export const LIFETIME_DEFERRED_BY = "lifetime_touch"

/** Persist an arbiter wait as a due touchpoint (idempotent per contact · type · due date). Never throws. */
export async function deferLifetimeTouch(svc: Svc, a: LifetimeTouchInput, waitHours: number | null, rationale: string): Promise<{ ok: true; dueDate: string } | { ok: false; reason: string }> {
  try {
    const days = Math.max(1, Math.ceil((waitHours ?? 24) / 24))
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
