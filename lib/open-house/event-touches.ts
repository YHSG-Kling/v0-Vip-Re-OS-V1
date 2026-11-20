// lib/open-house/event-touches.ts
// ─────────────────────────────────────────────────────────────────────────────
// C29 + C32 — EVENT REMINDERS AND NO-SHOW FOLLOW-UP, DECIDED BY THE ARBITER (wave 149, lane 149F; owner ruling 7, "Nothing fixed
// in communications … especially that is not an agentic autonomous AI"; lane 148H Still open 1 + 2).
//
// There is NO timetable here: no T-7d / T-1d / T-1h table, no "+48h no-show nudge". Each sweep (the recovery-net cron,
// app/api/cron/open-house-followup) asks THE arbiter (lib/ai-isa/followup-arbiter.ts arbitrateFollowUp — lane 149C owns its
// timing branch; this module only hands it a CLOSED menu and the evidence) one question per registration:
//   · BEFORE the event — "remind now" or "wait": the evidence is how far away the event is, how long since they registered or
//     were last reminded, how many reminders they have had, their stated timeline, and whether it is online (the personal link
//     matters). The tenant's own follow-up policy (fatigue floor, arbiter on/off) is the only fixed thing, and it is the tenant's.
//   · AFTER a VERIFIABLE event, for a registrant marked no_show — "tell the host" or "let it rest": the promised replay already
//     went (deliverEventReplay — an obligation, not a decision); whether a person should reach out beyond it is the arbiter's
//     call from their situation (a request they made, a near timeline). A client gathering's no-show is never chased (registry).
// The obligations stay obligations, elsewhere: the confirmation (registerForEvent), the replay and the handout (deliverables).
//
// Words: the APPROVED reminder copy only (event-marketing.ts reminder_subject / reminder_body); no approved copy → nothing sent,
// said. Sends: the governed dispatcher (consent / suppression / ledger). Evidence: one ledger row per reminder and per no-show
// decision (withActionLedger); a model WAIT is recorded (recordArbitration) so the deferral stays bounded.
//
// Before m947 is applied (open_house_rsvp_tracking.last_reminded_at / reminder_count) the reminder memory is unreadable and NO
// reminder is sent for that event — fail closed, said in the result; the no-show half does not need the columns.

import { EVENT_PRODUCER_REGISTRY, isEventKind, isOnlineEvent } from "./event-registry"
import { absoluteUrl, eventWindow, loadEventRegistrations, renderEventCopy, sendEventServiceEmail, type RegisterDeps } from "./event-attendance"

type Db = { from: (table: string) => any }
type ArbiterMod = typeof import("@/lib/ai-isa/followup-arbiter")

interface EventTouchDeps {
  decide?: import("@/lib/ai-isa/followup-arbiter").ArbiterDecide
  policy?: import("@/lib/ai-isa/followup-policy").FollowupPolicy
  sendEmail?: RegisterDeps["sendEmail"]
  ledger?: RegisterDeps["ledger"]
  routeToAgent?: ArbiterMod["routeToAgent"]
  /** Evidence of a model WAIT (recordArbitration) — a seam only for the proof. */
  recordWait?: (svc: Db, a: { brokerageId: string; contactId: string; decision: import("@/lib/ai-isa/followup-arbiter").ArbiterDecision; now: Date }) => Promise<unknown>
  now?: () => Date
  /** Decisions this sweep may ask the model for (the arbiter's own budget object). */
  budget?: { remaining: number }
}

interface EventTouchResult {
  phase: "upcoming" | "after" | "none"
  asked: number
  reminded: number
  waited: number
  handedToHost: number
  skipped: Array<{ contactId: string; reason: string }>
  reason: string
}

const HOUR = 3_600_000

/**
 * The arbiter's touches for ONE event. Never throws; every skip carries its reason.
 * @proofSeam scripts/event-branding-guard.ts drives both phases on memSupabase with a scripted arbiter
 */
export async function arbitrateEventTouches(svc: Db, eventId: string, deps: EventTouchDeps = {}): Promise<EventTouchResult> {
  const now = (deps.now ?? (() => new Date()))()
  const out: EventTouchResult = { phase: "none", asked: 0, reminded: 0, waited: 0, handedToHost: 0, skipped: [], reason: "" }
  try {
    const loaded = await loadEventRegistrations(svc, eventId)
    const ev = loaded.event
    if (loaded.error || !ev || !ev.brokerage_id) return { ...out, reason: loaded.error ?? "event not found" }
    if (!isEventKind(ev.event_type)) return { ...out, reason: "unknown event kind" }
    const spec = EVENT_PRODUCER_REGISTRY[ev.event_type]
    if (!spec.registration.required || !ev.is_published) return { ...out, reason: "not a published registration event — nobody registered to remind" }
    if (ev.status === "cancelled") return { ...out, reason: "cancelled — no reminders" }
    const { start, end } = eventWindow(ev)
    if (!start) return { ...out, reason: "the event has no start the arbiter can reason about" }
    const A: ArbiterMod = await import("@/lib/ai-isa/followup-arbiter")
    const policy = deps.policy ?? (await (await import("@/lib/ai-isa/followup-policy")).loadFollowupPolicy(svc as never, ev.brokerage_id)).policy
    const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
    const online = isOnlineEvent(ev.event_type, ev.virtual_provider)
    const brokerageId = ev.brokerage_id

    // ── BEFORE: remind now, or wait ──────────────────────────────────────────
    if (now < start) {
      out.phase = "upcoming"
      const ids = loaded.rows.map((r) => r.rsvp.id as string)
      const { data: mem, error: memErr } = ids.length
        ? await svc.from("open_house_rsvp_tracking").select("id, last_reminded_at, reminder_count").in("id", ids).eq("brokerage_id", brokerageId)
        : { data: [], error: null }
      if (memErr) return { ...out, reason: `reminder memory unreadable (${memErr.message}) — m947 may not be applied; no reminder is sent without it` }
      const memory = new Map(((mem ?? []) as Array<{ id: string; last_reminded_at?: string | null; reminder_count?: number | null }>).map((m) => [m.id, m]))
      const hoursUntilStart = Math.round((start.getTime() - now.getTime()) / HOUR)
      for (const r of loaded.rows) {
        const rsvpId = r.rsvp.id as string
        if (!["yes", "maybe"].includes(String(r.rsvp.rsvp_status)) || !r.rsvp.registered_at) { out.skipped.push({ contactId: r.contactId, reason: `rsvp ${r.rsvp.rsvp_status}` }); continue }
        if (!r.email) { out.skipped.push({ contactId: r.contactId, reason: "no e-mail on the contact" }); continue }
        const m = memory.get(rsvpId)
        const count = Math.max(0, Number(m?.reminder_count ?? 0))
        const lastTouch = m?.last_reminded_at ?? r.rsvp.registered_at
        const hoursSinceTouch = lastTouch ? Math.round((now.getTime() - Date.parse(lastTouch)) / HOUR) : null
        // The TENANT's fatigue floor (their policy, not a timetable): inside it the arbiter is not asked.
        if (hoursSinceTouch !== null && hoursSinceTouch < policy.guardrails.minHoursBetweenTouches) { out.skipped.push({ contactId: r.contactId, reason: `inside the tenant's ${policy.guardrails.minHoursBetweenTouches}h fatigue floor` }); continue }
        const situation = (r.rsvp.situation ?? {}) as Record<string, unknown>
        const remind = { id: "remind", kind: "communication" as const, channels: ["email" as const], why: [`registered for "${ev.title ?? spec.label}"`, `the event starts in about ${hoursUntilStart}h`, online ? "their personal join link is in the reminder" : "an in-person event"] }
        const wait = { id: "wait", kind: "wait" as const, channels: [] as never[], why: ["a reminder now would be too early or too many — hold it"] }
        const facts = {
          subject: "contact" as const,
          relationship: { type: "event_registrant", persona: null, hasAssignedAgent: !!ev.agent_id },
          intent: null,
          history: { hoursSinceAnyTouch: hoursSinceTouch, hoursSinceAgentTouch: null, campaignTouches7d: count, lastChannel: "email", portalEducationViews: null },
          journey: { transactionStage: typeof situation.timeline === "string" ? situation.timeline : null, nextMilestone: `${spec.label} starts in ${hoursUntilStart}h${online ? " (online — the reminder carries their personal link)" : ""}`, openLessons: null, nextLesson: null },
          preferences: [],
          fatigueRisk: count >= 2 ? `already reminded ${count} times` : null,
          localHour: null,
          moment: { key: "event_registrant_upcoming", intent: `A person registered for this ${spec.label.toLowerCase()} and it has not started. Decide whether a friendly reminder helps them now (they asked to come), or whether it is too early / they have been reminded enough. Reminders to registered people are service, not marketing — but never nag.`, daysSinceOpen: Math.max(0, Math.round((now.getTime() - Date.parse(String(r.rsvp.registered_at))) / (24 * HOUR))) },
          blindSpots: ["the registrant's calendar and inbox are not visible — whether they already saved the date is unknown"],
        }
        out.asked++
        const decision = await A.arbitrateFollowUp({ brokerageId, facts, menu: { menu: [remind, wait], locked: null }, planned: wait, policy, budget: deps.budget }, { decide: deps.decide })
        if (decision.optionId !== "remind") {
          out.waited++
          if (decision.source === "ai") await (deps.recordWait ?? (async (s, a) => A.recordArbitration(s, { brokerageId: a.brokerageId, subject: { type: "contact", id: a.contactId }, decision: a.decision, now: a.now, policyRef: null, systemSource: "event_reminder" })))(svc, { brokerageId, contactId: r.contactId, decision, now })
          continue
        }
        const joinLink = online ? absoluteUrl(`/open-house/${ev.id}/join?r=${rsvpId}`) : null
        const copy = renderEventCopy(ev, "reminder", { firstName: r.firstName, joinLink })
        if (!copy) { out.skipped.push({ contactId: r.contactId, reason: "no approved reminder copy (or no public origin for the personal link) — nothing static stands in" }); continue }
        const send = deps.sendEmail ?? sendEventServiceEmail
        const sent = await ledger(
          {
            brokerageId, action: "open_house.reminder.send", actor: { type: "manager", managerKey: "ai_isa" },
            subject: { type: "open_house_rsvp", id: rsvpId }, cycle: `reminder:${count + 1}`, channel: "email",
            reasonCode: "SERVICE_NOTICE", reasonDetail: decision.rationale.slice(0, 500), systemSource: "event_reminder", policyKey: "followup_policy",
            detail: { event_id: ev.id, contact_id: r.contactId, hours_until_start: hoursUntilStart, arbitration: A.arbitrationLedgerDetail(decision, null) },
          },
          () => send({ brokerageId, to: r.email as string, contactId: r.contactId, subject: copy.subject, html: copy.html, text: copy.text, metadata: { event_id: ev.id, rsvp_id: rsvpId, kind: `event_reminder_${count + 1}` } }),
          {
            settle: (s: { success: boolean; error?: string }) => (s.success ? { status: "executed", outcome: "reminder_sent", provider: "email" } : { status: "failed", outcome: "reminder_not_sent", error: s.error ?? null }),
            replay: (claim: { kind: string; error?: string }) => (claim.kind === "refused" ? { success: false, error: `the action ledger refused: ${claim.error}` } : { success: false, error: "already sent" }),
          },
        ) as { success: boolean; error?: string }
        if (!sent.success) { out.skipped.push({ contactId: r.contactId, reason: sent.error ?? "not sent" }); continue }
        out.reminded++
        const { data: upd, error: uErr } = await svc.from("open_house_rsvp_tracking").update({ last_reminded_at: now.toISOString(), reminder_count: count + 1 }).eq("id", rsvpId).eq("brokerage_id", brokerageId).select("id")
        if (uErr || !Array.isArray(upd) || upd.length !== 1) console.warn(`[event-touches] reminder sent but its memory not stored for ${rsvpId}: ${uErr?.message ?? "matched no row"}`)
      }
      return { ...out, reason: "the arbiter decided each registration's reminder" }
    }

    // ── AFTER: a verified no-show — tell the host, or let it rest ────────────
    if (end && now >= end) {
      out.phase = "after"
      if (spec.followUp.noShow === "none") return { ...out, reason: `a ${spec.label.toLowerCase()} no-show is never chased` }
      if (!ev.agent_id) return { ...out, reason: "no host agent on the event — the AI ISA's normal engagement of the consented contact stands" }
      const route = deps.routeToAgent ?? A.routeToAgent
      for (const r of loaded.rows) {
        if (r.rsvp.rsvp_status !== "no_show") continue
        const situation = (r.rsvp.situation ?? {}) as Record<string, unknown>
        const requests = Array.isArray(situation.requests) ? (situation.requests as string[]) : []
        const host = { id: "notify_human", kind: "agent_intervention" as const, channels: ["human_task" as const], why: [`registered but did not attend (verified host)`, requests.length ? `asked the host to: ${requests.join(", ").replace(/_/g, " ")}` : "made no request on the form", typeof situation.timeline === "string" ? `stated timeline ${situation.timeline}` : "no timeline stated"] }
        const rest = { id: "wait", kind: "wait" as const, channels: [] as never[], why: ["the recording already went to them; the AI ISA's normal, consented engagement continues — a person need not step in"] }
        const facts = {
          subject: "contact" as const,
          relationship: { type: "event_registrant", persona: null, hasAssignedAgent: true },
          intent: null,
          history: { hoursSinceAnyTouch: null, hoursSinceAgentTouch: null, campaignTouches7d: null, lastChannel: "email", portalEducationViews: null },
          journey: { transactionStage: typeof situation.timeline === "string" ? situation.timeline : null, nextMilestone: null, openLessons: null, nextLesson: null },
          preferences: [],
          fatigueRisk: null,
          localHour: null,
          moment: { key: "event_registrant_no_show", intent: `A registrant missed this ${spec.label.toLowerCase()}. Their replay is handled already. Decide whether the host should personally reach out (they asked for something, or their timeline is near) — kindly, never "we noticed you didn't come" — or let it rest.`, daysSinceOpen: Math.max(0, Math.round((now.getTime() - end.getTime()) / (24 * HOUR))) },
          blindSpots: ["why they missed it is unknown and is never assumed"],
        }
        out.asked++
        const decision = await A.arbitrateFollowUp({ brokerageId, facts, menu: { menu: [host, rest], locked: null }, planned: rest, policy, budget: deps.budget }, { decide: deps.decide })
        if (decision.optionId !== "notify_human") { out.waited++; continue }
        // ONCE per registration: the ledger's cycle is the no-show itself.
        const told = await ledger(
          {
            brokerageId, action: "open_house.no_show.hand_to_host", actor: { type: "manager", managerKey: "ai_isa" },
            subject: { type: "open_house_rsvp", id: r.rsvp.id }, cycle: "no_show", channel: "human_task",
            reasonCode: "NURTURE_TOUCH", reasonDetail: decision.rationale.slice(0, 500), systemSource: "event_no_show", policyKey: "followup_policy",
            detail: { event_id: ev.id, contact_id: r.contactId, arbitration: A.arbitrationLedgerDetail(decision, null) },
          },
          async () => ({ told: await route(svc as never, { brokerageId, contactId: r.contactId, agentId: ev.agent_id, now, title: `Reach out: registered for "${ev.title ?? spec.label}" and missed it`, description: `${decision.rationale} — the recording was sent (if one exists). Never mention that they did not attend; offer what they asked for.` }) }),
          {
            settle: (x: { told: boolean }) => (x.told ? { status: "executed", outcome: "handed_to_host" } : { status: "failed", outcome: "host_not_told", error: "no task could be written" }),
            // A REFUSED claim handed nothing over — said as a refusal, never as "already handed over".
            replay: (claim: { kind: string; error?: string }) => (claim.kind === "refused" ? { told: false, refused: `the action ledger refused: ${claim.error}` } : { told: false }),
          },
        ) as { told: boolean; refused?: string }
        if (told.told) out.handedToHost++
        else out.skipped.push({ contactId: r.contactId, reason: told.refused ?? "already handed over to the host (ledger replay), or the task could not be written" })
      }
      return { ...out, reason: "the arbiter decided each no-show" }
    }
    return { ...out, reason: "the event is in progress" }
  } catch (e) {
    return { ...out, reason: `threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}
