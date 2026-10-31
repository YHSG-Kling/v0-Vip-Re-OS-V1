// lib/sphere/followup-moments.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE POST-CLOSE FOLLOW-UP MOMENTS — the delivery half that was missing (wave 143, lane 143E).
//
// OWNER RULING (wave 143): "Follow-up/touchpoints must NOT be hard-coded: managers check intent and determine the
// proper follow-up, which can include an avatar video generated on the fly … 'AI always listening', so customers feel
// an agent is always helping."
//
// WHAT WAS THERE (measured at 21da8e4e, orphan doctrine §1.2 — a write with no reader):
//   · lib/kernel/lifetime-conversion.ts promoteDealContactsToLifetime wrote a FIXED schedule of lifetime_customer_touchpoints
//     rows at every verified closing — 3-day video, 30-day SMS, 6-month email, 1-year video, 18-month SMS (a hard-coded
//     timetable AND hard-coded channels) — and NOTHING delivered them: lib/sphere/lifetime-touchpoint-reaper-policy.ts says
//     it outright ("the daily lifetime cron delivers by DATE-COMPUTATION … and never reads those scheduled rows … the
//     6-month check-in in particular has no delivery path"). Three days after each date the reaper marked the row `skipped`
//     and told the agent "a past-client touch slipped" — so every closing produced five phantom misses.
//   · The date-computed senders (anniversary / birthday, app/api/cron/lifetime-customer-touchpoints) are real and stay; their
//     scheduled twins were never reconciled, so they too were reaped as "slipped" after they were sent. The same cron ALSO
//     texted a referral ask at exactly day 3 and day 30 after every closing — a second hard-coded timetable.
//
// WHAT THIS DOES. Each due row is a MOMENT — an intent window the tenant's followup_policy opens (afterClosingDays, a
// default channel, WHAT the moment is for) — not an order to send:
//   1. the planner (planNextBestExperience) names what is permitted for THIS person today (hard verdicts stay
//      deterministic and lock the choice — a dead end, an opt-out, DNC, an active appointment, an agent already on it);
//   2. the arbiter (lib/ai-isa/followup-arbiter.ts) picks the best permitted experience: a brand-voiced message, an
//      on-the-fly avatar video (the Asset Manager's existing rail, requested through the Sphere Manager), education,
//      property / market information, a task for the agent — or WAIT, for a bounded time; after policy.arbiter.maxDeferDays
//      the person is never left to silence;
//   3. the choice is recorded (recordAndExecuteExperience: ledger row + NEXT_BEST_EXPERIENCE_CHOSEN + delegation) with the
//      arbiter's rationale and evidence, and the row is settled TRUTHFULLY:
//        sent            a message went out through dispatchEmail / dispatchSms (consent, DNC, suppression, quiet hours,
//                        the autonomy gate and the action ledger's at-most-once cycle all apply)
//        pending_review  handed to a manager / the agent (video, education, a task) — awaiting that work
//        scheduled       deferred (date moved) or retrying tomorrow (gateway down, temporary block)
//        skipped         the person cannot be contacted (dead end / opt-out …) — a decision, not a miss
//   4. anniversary rows are reconciled against the send the date-driven cron already made (a calendar fact stays a calendar
//      job); the referral ask is a moment like the others — the cron's fixed day-3 / day-30 text was retired in its favour.
// Copy is ALWAYS generated (generateClientMessage — brand voice, them-first, fair-housing redraft). If the gateway cannot
// produce it, the moment is retried tomorrow — a canned fallback is never sent unreviewed.
//
// Not server-only: scripts/intent-driven-followup-guard.ts drives it in memory with injected deps; production defaults are
// lazy imports at the call.

import { loadFollowupPolicy, momentForTouchpointType, type FollowupPolicy } from "@/lib/ai-isa/followup-policy"
import { chooseReviewChannel } from "@/lib/reputation/review-ask-policy"
import { KernelEvent } from "@/lib/kernel/events"
import { lifetimeTouchpointEventMetadata } from "./lifetime-touchpoint-ledger"
import type { ArbiterBudget, ArbiterDecide, ArbiterDecision } from "@/lib/ai-isa/followup-arbiter"
import type { NextBestExperienceInput, NextBestExperiencePlan } from "@/lib/ai-isa/lead-action-plan"

type Svc = { from: (table: string) => any }

const DAY_MS = 86_400_000

/**
 * Touchpoint types the date-driven lifetime cron still delivers (by date computation: the anniversary is a calendar fact) —
 * reconciled here, never double-sent. The referral ask is NOT one of them any more: the cron's fixed day-3 / day-30 SMS block was
 * retired (see the tombstone in app/api/cron/lifetime-customer-touchpoints/route.ts) and the `referral_request` moment is
 * conducted like any other.
 */
const CRON_DELIVERED_MOMENTS: readonly string[] = ["home_anniversary"]
/** NBA verdicts that mean "this person cannot be contacted" (a decision), as opposed to "not now" (retry). */
const TERMINAL_BLOCK_CODES: ReadonlySet<string> = new Set(["duplicate", "outreach_paused", "dead_end", "no_permitted_channel", "blocked_lifecycle", "max_touches_reached", "plan_complete"])

interface MomentRow {
  id: string
  brokerage_id: string
  contact_id: string | null
  agent_id: string | null
  touchpoint_type: string
  channel: string | null
  scheduled_date: string | null
  status: string
  related_transaction_id: string | null
  engagement_data: Record<string, unknown> | null
}

export interface ConductResult {
  scanned: number
  sent: number
  delegated: number
  routedToAgent: number
  deferred: number
  retryingTomorrow: number
  blocked: number
  reconciled: number
  arbiterCalls: number
  errors: string[]
}

type DispatchOutcome = { success: boolean; error?: string; messageId?: string; providerKey?: string }

export interface ConductDeps {
  now?: () => Date
  loadInputs?: (svc: Svc, a: { brokerageId: string; contact: Record<string, unknown>; now: Date }) => Promise<{ ok: true; input: NextBestExperienceInput } | { ok: false; error: string }>
  plan?: (input: NextBestExperienceInput) => NextBestExperiencePlan
  decide?: ArbiterDecide
  /** ledger / emit / delegate seams of recordAndExecuteExperience. */
  record?: Record<string, unknown>
  message?: (b: { brokerageId: string; agentUserId: string | null; audience: "buyer" | "seller"; purpose: string; recipientFirstName: string | null; fallback: { subject: string; body: string } }) => Promise<{ subject: string; body: string; generated: boolean }>
  dispatchEmail?: (p: Record<string, unknown>) => Promise<DispatchOutcome>
  dispatchSms?: (p: Record<string, unknown>) => Promise<DispatchOutcome>
  emit?: (input: Record<string, unknown>) => Promise<unknown>
}

const emptyResult = (): ConductResult => ({ scanned: 0, sent: 0, delegated: 0, routedToAgent: 0, deferred: 0, retryingTomorrow: 0, blocked: 0, reconciled: 0, arbiterCalls: 0, errors: [] })
const dateOnly = (d: Date) => d.toISOString().slice(0, 10)

/** Settle ONE row, tenant-pinned and COUNTED (an update that matches nothing also resolves). */
async function settle(svc: Svc, row: MomentRow, patch: Record<string, unknown>, followup: Record<string, unknown>): Promise<boolean> {
  const engagement_data = { ...(row.engagement_data ?? {}), followup }
  const { data, error } = await svc.from("lifetime_customer_touchpoints").update({ ...patch, engagement_data, updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("brokerage_id", row.brokerage_id).eq("status", "scheduled").select("id")
  if (error) { console.error(`[followup-moments] row ${row.id} not settled: ${error.message}`); return false }
  return (data ?? []).length === 1
}

async function createAgentTask(svc: Svc, row: MomentRow, title: string, description: string, now: Date): Promise<boolean> {
  if (!row.contact_id) return false
  const { routeToAgent } = await import("@/lib/ai-isa/followup-arbiter")
  return routeToAgent(svc, { brokerageId: row.brokerage_id, contactId: row.contact_id, agentId: row.agent_id, title, description, now, transactionId: row.related_transaction_id })
}

/**
 * Conduct the due moments of ONE tenant. Idempotent: a settled row is never touched again; a re-run inside the same day
 * replays the ledger cycle instead of sending twice. Never throws.
 */
async function conductDueFollowUpMoments(
  svc: Svc,
  args: { brokerageId: string; limit?: number; policy?: FollowupPolicy },
  depsIn: ConductDeps = {},
): Promise<ConductResult> {
  const out = emptyResult()
  const now = (depsIn.now ?? (() => new Date()))()
  const today = dateOnly(now)
  const policy = args.policy ?? (await loadFollowupPolicy(svc, args.brokerageId)).policy
  const budget: ArbiterBudget = { remaining: policy.arbiter.maxDecisionsPerRun }
  const lap = await import("@/lib/ai-isa/lead-action-plan")
  const arbiter = await import("@/lib/ai-isa/followup-arbiter")
  const loadInputs = depsIn.loadInputs ?? (async (s, a) => lap.loadNextBestExperienceInputs(s, { brokerageId: a.brokerageId, contact: a.contact as never, humanInitiated: false, now: a.now }))
  const planFn = depsIn.plan ?? lap.planNextBestExperience

  const { data: due, error: dueError } = await svc.from("lifetime_customer_touchpoints")
    .select("id, brokerage_id, contact_id, agent_id, touchpoint_type, channel, scheduled_date, status, related_transaction_id, engagement_data")
    .eq("brokerage_id", args.brokerageId).eq("status", "scheduled").lte("scheduled_date", today)
    .order("scheduled_date", { ascending: true }).limit(args.limit ?? 100)
  if (dueError) { out.errors.push(`due moments read refused: ${dueError.message}`); return out }

  for (const row of (due ?? []) as MomentRow[]) {
    out.scanned++
    try {
      if (!row.contact_id) { out.errors.push(`row ${row.id}: no contact`); continue }

      // ── anniversary / referral rows: the date-driven cron sends them; reconcile, never double-send ──
      if (CRON_DELIVERED_MOMENTS.includes(row.touchpoint_type)) {
        const { data: sentRows, error: sentErr } = await svc.from("lifetime_customer_touchpoints").select("id, sent_date")
          .eq("brokerage_id", row.brokerage_id).eq("contact_id", row.contact_id).eq("touchpoint_type", row.touchpoint_type)
          .eq("status", "sent").gte("sent_date", row.scheduled_date ?? today).limit(1)
        if (sentErr) { out.errors.push(`row ${row.id}: reconcile read refused: ${sentErr.message}`); continue }
        const hit = (sentRows ?? [])[0] as { id: string; sent_date: string | null } | undefined
        if (hit && await settle(svc, row, { status: "sent", sent_date: hit.sent_date ?? today }, { reconciled_with: hit.id, by: "followup-moments", note: "delivered by the date-driven lifetime cron" })) out.reconciled++
        continue
      }

      const { data: contact, error: contactError } = await svc.from("contacts")
        .select("id, first_name, last_name, email, phone, preferred_channel, tcpa_consent, email_opt_out, email_unsubscribed, sms_opt_out, sms_unsubscribed, dnc_status, ai_outreach_paused, qualification_summary, last_contacted_at, contact_type, contact_persona, agent_id, buyer_stage, video_opt_out")
        .eq("id", row.contact_id).eq("brokerage_id", row.brokerage_id).maybeSingle()
      if (contactError) { out.errors.push(`row ${row.id}: contact read refused: ${contactError.message}`); continue }
      if (!contact) { out.errors.push(`row ${row.id}: contact not in this brokerage`); continue }

      const loaded = await loadInputs(svc, { brokerageId: row.brokerage_id, contact, now })
      if (!loaded.ok) { out.retryingTomorrow++; out.errors.push(`row ${row.id}: journey inputs unreadable — retrying (${loaded.error})`); continue }

      const moment = momentForTouchpointType(policy, row.touchpoint_type)
      // The moment's age counts from when it OPENED: a deferral moves scheduled_date forward, so the first date is kept in the
      // trail (followup.opened_on) — otherwise every wait would reset the clock and a person could be deferred forever.
      const openedOn = String((row.engagement_data as { followup?: { opened_on?: string } } | null)?.followup?.opened_on ?? row.scheduled_date ?? today)
      const daysSinceOpen = Math.max(0, Math.floor((now.getTime() - new Date(`${openedOn}T00:00:00Z`).getTime()) / DAY_MS))
      const planned = planFn(loaded.input)
      const callsBefore = budget.remaining
      const res = await arbiter.arbitrateAndRecordExperience(svc, {
        brokerageId: row.brokerage_id, contactId: row.contact_id, input: loaded.input, plan: planned, now,
        systemSource: "post_close_moment", moment: { key: moment.key, intent: moment.intent, daysSinceOpen }, budget, policy,
      }, { decide: depsIn.decide, record: depsIn.record })
      if (budget.remaining < callsBefore) out.arbiterCalls++
      const decision = res.decision as ArbiterDecision
      const kind = res.plan.chosen.kind
      const trail = {
        opened_on: openedOn,
        moment: moment.key, intent: moment.intent, chose: kind, source: decision.source, rationale: decision.rationale,
        evidence: decision.evidence, confidence: decision.confidence, fallback_reason: decision.fallbackReason, at: now.toISOString(),
      }

      // ── LOCKED: a hard verdict. Terminal = the person cannot be contacted (a decision, not a miss). ──
      if (res.plan.locked) {
        if (TERMINAL_BLOCK_CODES.has(res.plan.nba.reasonCode) || daysSinceOpen >= policy.arbiter.maxDeferDays) {
          if (await settle(svc, row, { status: "skipped" }, { ...trail, blocked: res.plan.locked.reason })) out.blocked++
        } else out.retryingTomorrow++
        continue
      }

      // ── WAIT (the arbiter's bounded deferral) ──
      if (kind === "wait") {
        const target = res.plan.chosen.dueAt ? dateOnly(res.plan.chosen.dueAt) : today
        if (decision.waitHours !== null && target > today && await settle(svc, row, { scheduled_date: target }, trail)) out.deferred++
        else out.retryingTomorrow++
        continue
      }

      // ── COMMUNICATION: a generated, brand-voiced message through the governed send ──
      if (kind === "communication") {
        const sent = await deliver(svc, depsIn, { row, contact, moment, decision, policy })
        if (sent.state === "sent") {
          if (await settle(svc, row, { status: "sent", sent_date: today, channel: sent.channel }, { ...trail, message_id: sent.messageId ?? null })) {
            out.sent++
            await emitSent(svc, depsIn, row, sent.channel)
          }
        } else if (sent.state === "held") {
          if (await settle(svc, row, { status: "pending_review" }, { ...trail, held: sent.detail })) out.routedToAgent++
        } else if (sent.state === "retry") {
          out.retryingTomorrow++
        } else {
          // No permitted channel / the gate refused for good: a person decides — never silence.
          const ok = await createAgentTask(svc, row, "A past-client follow-up could not go out automatically", `${moment.intent} The automated touch was not possible (${sent.detail}). Reach out personally.`, now)
          if (await settle(svc, row, { status: ok ? "pending_review" : "skipped" }, { ...trail, routed_to_agent: sent.detail })) out.routedToAgent++
        }
        continue
      }

      // ── A HUMAN: the arbiter judged this needs the agent ──
      if (kind === "agent_intervention") {
        const ok = await createAgentTask(svc, row, "Past-client follow-up: your personal touch", `${moment.intent} Why now: ${decision.rationale}`, now)
        if (await settle(svc, row, { status: ok ? "pending_review" : "skipped" }, trail)) out.routedToAgent++
        continue
      }

      // ── A REFERRAL TO A QUALIFIED PROFESSIONAL (wave 144, lane 144Z): recordAndExecuteExperience already wrote the agent's
      //    introduction task on the ISA's rail (lead-action-plan.ts prepareProfessionalIntroduction) — a second "no executor took it"
      //    task would be false. Executed → the moment waits on the person; not executed → the agent still gets the moment. ──
      if (kind === "professional_referral" && res.recorded.execution.mode === "caller") {
        if (await settle(svc, row, { status: "pending_review" }, { ...trail, introduction_task: true })) out.routedToAgent++
        continue
      }

      // ── EVERYTHING ELSE (video, education, properties, market update, portal task …): delegated by recordAndExecuteExperience ──
      const mode = res.recorded.execution.mode
      if (mode === "delegated") {
        if (await settle(svc, row, { status: "pending_review" }, { ...trail, delegated_to: (res.recorded.execution as { manager?: string }).manager ?? null })) out.delegated++
      } else {
        // No executor took it (unexecuted / caller): the moment must not stall silently — the agent gets it.
        const ok = await createAgentTask(svc, row, `Past-client follow-up (${kind})`, `${moment.intent} The best next step was judged to be "${kind}" but no automated executor took it. Why: ${decision.rationale}`, now)
        if (await settle(svc, row, { status: ok ? "pending_review" : "skipped" }, { ...trail, unexecuted: mode })) out.routedToAgent++
      }
    } catch (e) {
      out.errors.push(`row ${row.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return out
}

type DeliverOutcome =
  | { state: "sent"; channel: "email" | "sms"; messageId?: string }
  | { state: "held" | "retry" | "route"; detail: string }

/** One brand-voiced message through the governed send. A generation failure retries tomorrow; a gate refusal routes to a human. */
async function deliver(
  svc: Svc,
  deps: ConductDeps,
  a: { row: MomentRow; contact: Record<string, any>; moment: { key: string; intent: string; defaultChannel: string }; decision: ArbiterDecision; policy: FollowupPolicy },
): Promise<DeliverOutcome> {
  const wanted = a.decision.channel === "sms" || (a.decision.channel === null && a.moment.defaultChannel === "sms") ? "sms" : "email"
  const channel = chooseReviewChannel({ ...a.contact, preferred_channel: wanted })
  if (!channel) return { state: "route", detail: "no usable, permitted channel on file" }

  let agentUserId: string | null = null
  if (a.row.agent_id) {
    const { data: ag } = await svc.from("agents").select("user_id").eq("id", a.row.agent_id).eq("brokerage_id", a.row.brokerage_id).maybeSingle()
    agentUserId = (ag as { user_id?: string | null } | null)?.user_id ?? null
  }
  const message = deps.message ?? (async (b) => (await import("@/lib/agents/generate-client-message")).generateClientMessage(b as never))
  const drafted = await message({
    brokerageId: a.row.brokerage_id, agentUserId, audience: a.contact.contact_type === "seller" ? "seller" : "buyer",
    purpose: a.moment.intent, recipientFirstName: a.contact.first_name ?? null,
    // The generator's neutral fallback is NEVER sent from here: generated === false means "retry tomorrow".
    fallback: { subject: "A note from your agent", body: "Thinking of you — reply any time." },
  })
  if (!drafted.generated || !drafted.body.trim()) return { state: "retry", detail: "the message could not be generated (gateway / compliance redraft failed)" }

  const ledger = {
    reasonCode: "LIFETIME_TOUCH" as const,
    reasonDetail: `post-close moment ${a.moment.key}: ${a.decision.rationale}`.slice(0, 500),
    cycle: `followup_moment:${a.row.id}`,
    subject: { type: "contact" as const, id: a.row.contact_id as string },
    detail: { touchpoint_id: a.row.id, moment: a.moment.key, arbiter_source: a.decision.source, arbiter_confidence: a.decision.confidence },
    policyKey: "followup_policy",
  }
  const common = { brokerageId: a.row.brokerage_id, contactId: a.row.contact_id, agentId: a.row.agent_id ?? undefined, managerKey: "sphere_of_influence", systemSource: "lifetime_touchpoints", ledger }
  const sendEmail = deps.dispatchEmail ?? (async (p) => (await import("@/lib/providers/dispatch")).dispatchEmail(p as never))
  const sendSms = deps.dispatchSms ?? (async (p) => (await import("@/lib/providers/dispatch")).dispatchSms(p as never))
  const r = channel === "email"
    ? await sendEmail({ ...common, to: a.contact.email, subject: drafted.subject, html: drafted.body.replace(/\n/g, "<br>"), text: drafted.body, channelPurpose: "update", metadata: { touchpoint: a.moment.key, touchpointId: a.row.id } })
    : await sendSms({ ...common, to: a.contact.phone, message: drafted.body })
  if (r.success) return { state: "sent", channel, messageId: r.messageId }
  // The autonomy gate HOLDS an unattended send for approval (it is in the approval queue — not a refusal);
  // a de-confliction deferral is "not today"; anything else (consent, DNC, suppression, billing) is a human's call.
  if (r.providerKey === "autonomy_gate") return { state: "held", detail: r.error ?? "held for approval" }
  if (r.providerKey && /deconflict/i.test(r.providerKey)) return { state: "retry", detail: r.error ?? "deferred by de-confliction" }
  return { state: "route", detail: r.error ?? "the send gate refused" }
}

async function emitSent(svc: Svc, deps: ConductDeps, row: MomentRow, channel: string): Promise<void> {
  try {
    const emit = deps.emit ?? (async (i) => (await import("@/lib/kernel/emit")).emitKernelEvent(i as never))
    await emit({
      event: KernelEvent.LIFETIME_CUSTOMER_TOUCHPOINT_SENT, brokerageId: row.brokerage_id, entityType: "contact", entityId: row.contact_id,
      contactId: row.contact_id, agentId: row.agent_id, source: "cron",
      metadata: lifetimeTouchpointEventMetadata({ touchpointId: row.id, agentId: row.agent_id, touchpointType: row.touchpoint_type, channel }), client: svc,
    })
  } catch (e) { console.error("[followup-moments] touchpoint-sent emit failed (the row already stands):", e instanceof Error ? e.message : e) }
}

/** Every tenant with a due moment (the lifetime cron's entry). One tenant's failure never stops the next. */
export async function conductDueFollowUpMomentsAllTenants(svc: Svc, depsIn: ConductDeps = {}, opts: { perTenantLimit?: number; maxTenants?: number } = {}): Promise<{ tenants: number; totals: ConductResult }> {
  const totals = emptyResult()
  const today = dateOnly((depsIn.now ?? (() => new Date()))())
  const { data, error } = await svc.from("lifetime_customer_touchpoints").select("brokerage_id").eq("status", "scheduled").lte("scheduled_date", today).limit(2000)
  if (error) { totals.errors.push(`tenant scan refused: ${error.message}`); return { tenants: 0, totals } }
  const tenants = [...new Set(((data ?? []) as Array<{ brokerage_id: string | null }>).map((r) => r.brokerage_id).filter((b): b is string => !!b))].slice(0, opts.maxTenants ?? 200)
  for (const brokerageId of tenants) {
    const r = await conductDueFollowUpMoments(svc, { brokerageId, limit: opts.perTenantLimit }, depsIn)
    for (const k of Object.keys(totals) as Array<keyof ConductResult>) {
      if (k === "errors") totals.errors.push(...r.errors.map((e) => `[${brokerageId}] ${e}`))
      else (totals[k] as number) += r[k] as number
    }
  }
  return { tenants: tenants.length, totals }
}
