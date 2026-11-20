// lib/gamification/lifecycle-awards.ts
// ─────────────────────────────────────────────────────────────────────────────
// LAYER 6 — LIFECYCLE GAMIFICATION, the database-touching half (wave 103, lane 103C).
//
// The RULES, the once-award and the point values live in award-points.ts (the ONE
// award path, importable from a Client Component). This file is the SERVER half:
// resolving which agents.id an event is about, the reactor hook the event reactor
// calls on every canonical event, and the ONE badge writer (merged here from
// app/actions/gamification.ts's private awardBadge, which now delegates). It
// lazy-imports @/lib/kernel/emit (server-only) and must never be imported from a
// Client Component.

import { KernelEvent } from "@/lib/kernel/events"
import { courseQuizReadiness, qualifyingPassedAttempt, readQuizAttempts, resolveCoursePassingScore } from "@/lib/academy/quiz"
import {
  awardAgentPointsOnce,
  planLifecycleAwards,
  isUuid,
  LIFECYCLE_AWARD_RULES,
  type LedgerCapableClient,
  type PointReason,
} from "./award-points"

// ─── AGENT RESOLUTION — agents.id, never users.id (the two are DISJOINT) ──────

export interface MilestoneEventParams {
  event: string
  brokerageId: string
  entityType: string
  entityId: string
  metadata?: Record<string, unknown> | null
  agentUserId?: string | null
}

/** Which agents.id(s) an event is ABOUT. Each branch names the column it crosses. */
async function resolveMilestoneAgents(
  db: LedgerCapableClient,
  p: MilestoneEventParams,
): Promise<{ acting: string[]; mentorAndMentee: string[] }> {
  const meta = (p.metadata ?? {}) as Record<string, unknown>
  const out = { acting: [] as string[], mentorAndMentee: [] as string[] }

  if (isUuid(meta.mentor_agent_id) && isUuid(meta.mentee_agent_id)) {
    out.mentorAndMentee = [meta.mentor_agent_id, meta.mentee_agent_id]
  }
  // 1. An emitter that names the agents.id outright (showings, anniversaries, CE).
  if (isUuid(meta.agent_id)) { out.acting = [meta.agent_id]; return out }

  const one = async (table: string, col: string, id: string): Promise<string | null> => {
    const { data, error } = await db.from(table).select(col).eq("id", id).eq("brokerage_id", p.brokerageId).maybeSingle()
    if (error) { console.error(`[lifecycle-gamification] ${table}.${col} read refused for ${id}: ${error.message}`); return null }
    const v = (data as Record<string, unknown> | null)?.[col]
    return isUuid(v) ? v : null
  }
  const byUser = async (userId: string): Promise<string | null> => {
    // agents.user_id is the ONE crossing from users.id to agents.id (CLAUDE.md §3).
    const { data, error } = await db.from("agents").select("id").eq("user_id", userId).eq("brokerage_id", p.brokerageId).maybeSingle()
    if (error) { console.error(`[lifecycle-gamification] agents.user_id read refused for ${userId}: ${error.message}`); return null }
    return isUuid(data?.id) ? data.id : null
  }

  // 2. Entity-typed resolution — the column that holds the OWNING agent.
  let acting: string | null = null
  switch (p.entityType) {
    case "agent":               acting = isUuid(p.entityId) ? p.entityId : null; break
    case "user":                acting = await byUser(p.entityId); break
    case "transaction":         acting = await one("transactions", "agent_id", p.entityId); break
    case "showing":             acting = await one("showings", "agent_id", p.entityId); break
    case "agent_certification": acting = await one("agent_certifications", "agent_id", p.entityId); break
    case "agent_onboarding":    acting = await one("agent_onboarding", "agent_id", p.entityId); break
    case "agent_ce_completion": acting = await one("agent_ce_completions", "agent_id", p.entityId); break
    case "referral":            acting = await one("referrals", "agent_id", p.entityId); break
    // WAVE 153 (lane 153I): the two moments the retired client-side awards moved onto.
    // OFFER_SUBMITTED rides the BUYER lifecycle (entity = the buyer contact) — the contact's owning agent (contacts.agent_id).
    case "buyer_lifecycle":     acting = await one("contacts", "agent_id", p.entityId); break
    // SOCIAL_POST_PUBLISHED from the publisher: social_posts.agent_id (FK → agents), else the author's seat via users.id.
    case "social_post": {
      acting = await one("social_posts", "agent_id", p.entityId)
      if (!acting) {
        const author = await one("social_posts", "user_id", p.entityId)
        if (author) acting = await byUser(author)
      }
      break
    }
    // WAVE 154 (154E): a client-authored review — the agent the review is OF (agent_reviews.agent_id, an agents.id).
    case "agent_review":        acting = await one("agent_reviews", "agent_id", p.entityId); break
    // WAVE 155 (155C): the held open house's host (open_house_events.agent_id → agents), the listing's agent for an executed
    // listing agreement (listings.agent_id → agents), the buyer agreement's agent (buyer_broker_agreements.agent_id → agents).
    case "open_house_event":       acting = await one("open_house_events", "agent_id", p.entityId); break
    case "listing_stage_machine":  acting = await one("listings", "agent_id", p.entityId); break
    case "buyer_broker_agreement": acting = await one("buyer_broker_agreements", "agent_id", p.entityId); break
    case "contact":
      // REFERRAL_RECEIVED is emitted on the CONTACT with referral_id in metadata; the
      // earning agent is the referral's agent_id (who received it), not the contact's.
      acting = isUuid(meta.referral_id)
        ? await one("referrals", "agent_id", meta.referral_id)
        : await one("contacts", "agent_id", p.entityId)
      break
    default: break
  }
  // 3. The acting user's seat, when the emitter attributed one.
  if (!acting && p.agentUserId) acting = await byUser(p.agentUserId)
  if (acting) out.acting = [acting]
  return out
}

/** TRANSACTION_CLOSED: has this agent closed with either side's contact before this transaction? */
async function isRepeatClientClose(db: LedgerCapableClient, brokerageId: string, transactionId: string, agentId: string): Promise<boolean> {
  const { data: tx, error } = await db.from("transactions").select("id, buyer_contact_id, seller_contact_id")
    .eq("id", transactionId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error || !tx) return false
  const contactIds = [tx.buyer_contact_id, tx.seller_contact_id].filter(isUuid)
  if (contactIds.length === 0) return false
  const { data: prior, error: priorErr } = await db.from("transactions").select("id")
    .eq("brokerage_id", brokerageId).eq("agent_id", agentId).in("status", ["closed", "funded"]).neq("id", transactionId)
    .or(contactIds.map((c) => `buyer_contact_id.eq.${c},seller_contact_id.eq.${c}`).join(","))
    .limit(1)
  if (priorErr) { console.error(`[lifecycle-gamification] prior-close read refused for ${transactionId}: ${priorErr.message}`); return false }
  return (prior ?? []).length > 0
}

// ─── REFERRAL EVIDENCE (wave 154, lane 154E) ──────────────────────────────────
// A referral record is typed by the seat (createReferral); its "won" status is set by the same seat. Neither is evidence.
// The evidence is a CLOSED / FUNDED transaction in the same tenant that the referral points at (referrals.transaction_id)
// or that the referred contact is a party to. The award's once-key is that transaction, so one closed deal pays one
// referral award per agent however many referral records name it.

const CLOSED_TX_STATUSES = ["closed", "funded"]

/** REFERRAL_CONVERTED: the closed transaction evidencing this WON referral, or null (no evidence → no award). */
async function referralEvidenceTransaction(db: LedgerCapableClient, brokerageId: string, referralId: string): Promise<string | null> {
  const { REFERRAL_TERMINAL_WON } = await import("@/lib/referrals/referral-status")
  const { data: ref, error } = await db.from("referrals").select("id, status, transaction_id, referred_contact_id")
    .eq("id", referralId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) { console.error(`[lifecycle-gamification] referral read refused for ${referralId}: ${error.message}`); return null }
  const r = ref as { status?: string | null; transaction_id?: string | null; referred_contact_id?: string | null } | null
  if (!r || r.status !== REFERRAL_TERMINAL_WON) return null
  const ors: string[] = []
  if (isUuid(r.transaction_id)) ors.push(`id.eq.${r.transaction_id}`)
  if (isUuid(r.referred_contact_id)) ors.push(`buyer_contact_id.eq.${r.referred_contact_id}`, `seller_contact_id.eq.${r.referred_contact_id}`)
  if (ors.length === 0) return null
  const { data: txs, error: txErr } = await db.from("transactions").select("id")
    .eq("brokerage_id", brokerageId).in("status", CLOSED_TX_STATUSES).or(ors.join(","))
    .order("close_date", { ascending: true }).limit(1)
  if (txErr) { console.error(`[lifecycle-gamification] referral evidence read refused for ${referralId}: ${txErr.message}`); return null }
  const id = ((txs ?? []) as Array<{ id?: string }>)[0]?.id
  return isUuid(id) ? id : null
}

/** TRANSACTION_CLOSED: the agents on WON referrals this closed transaction evidences. */
async function wonReferralAgentsForClose(db: LedgerCapableClient, brokerageId: string, transactionId: string): Promise<string[]> {
  const { REFERRAL_TERMINAL_WON } = await import("@/lib/referrals/referral-status")
  const { data: tx, error } = await db.from("transactions").select("id, status, buyer_contact_id, seller_contact_id")
    .eq("id", transactionId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error || !tx) return []
  const t = tx as { status?: string | null; buyer_contact_id?: string | null; seller_contact_id?: string | null }
  if (!CLOSED_TX_STATUSES.includes(String(t.status ?? ""))) return []
  const ors = [`transaction_id.eq.${transactionId}`, ...[t.buyer_contact_id, t.seller_contact_id].filter(isUuid).map((c) => `referred_contact_id.eq.${c}`)]
  const { data: refs, error: refErr } = await db.from("referrals").select("agent_id")
    .eq("brokerage_id", brokerageId).eq("status", REFERRAL_TERMINAL_WON).or(ors.join(","))
  if (refErr) { console.error(`[lifecycle-gamification] won-referral read refused for ${transactionId}: ${refErr.message}`); return [] }
  return [...new Set(((refs ?? []) as Array<{ agent_id?: string | null }>).map((x) => x.agent_id).filter(isUuid))]
}

// ─── WAVE 155 (lane 155C) — THE OWNER'S THREE RULINGS, AS EVIDENCE THE SERVER RE-READS ─────────────────────────────────
// R1 "course needs to complete with quiz with acceptable passing %" · R2 "leave open house count" · R3 "appt with a signed
// agreement". Each award below is planned only when one of these resolvers finds the evidence in the event's OWN tenant
// (every read is `.eq("brokerage_id", …)`), so neither an event payload nor another tenant's row can earn.

/** R1 — the persisted, graded pass behind TRAINING_COURSE_COMPLETED (entity learning_module), or null. */
async function courseEvidence(db: LedgerCapableClient, brokerageId: string, moduleId: string, agentId: string): Promise<string | null> {
  const { data: agent, error: agentErr } = await db.from("agents").select("id, user_id").eq("id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
  if (agentErr) { console.error(`[lifecycle-gamification] course evidence: agent read refused: ${agentErr.message}`); return null }
  const userId = (agent as { user_id?: string | null } | null)?.user_id
  if (!isUuid(userId)) return null
  const { data: mod, error: modErr } = await db.from("learning_modules").select("id, brokerage_id, required, quiz_questions").eq("id", moduleId).maybeSingle()
  if (modErr) { console.error(`[lifecycle-gamification] course evidence: module read refused: ${modErr.message}`); return null }
  const m = mod as { brokerage_id?: string | null; required?: unknown; quiz_questions?: unknown } | null
  if (!m || (m.brokerage_id && m.brokerage_id !== brokerageId)) return null
  if (courseQuizReadiness(m.required, m.quiz_questions) !== "quiz_ready") return null
  const { data: asg, error: asgErr } = await db.from("learning_assignments").select("status, signal_metadata")
    .eq("module_id", moduleId).eq("agent_user_id", userId).eq("brokerage_id", brokerageId).maybeSingle()
  if (asgErr) { console.error(`[lifecycle-gamification] course evidence: assignment read refused: ${asgErr.message}`); return null }
  const a = asg as { status?: string | null; signal_metadata?: unknown } | null
  if (a?.status !== "completed") return null
  return qualifyingPassedAttempt(readQuizAttempts(a.signal_metadata), resolveCoursePassingScore(m as { passing_score?: unknown })) ? moduleId : null
}

/** R2 — the event types that ARE an open house of a listing (open_house_events.event_type CHECK; webinars, client events and
 *  education sessions are other events, never this count). */
export const OPEN_HOUSE_COUNTABLE_TYPES: readonly string[] = ["open_house", "virtual_open_house", "broker_open"]
/** The states an open house can be HELD from. draft (never published) and cancelled never become held. */
const OPEN_HOUSE_HELD_FROM: readonly string[] = ["scheduled", "active", "marketing"]

interface OpenHouseRow { id: string; listing_id: string | null; event_date: string | null; event_type: string | null; status: string | null; cancelled_at: string | null; created_at: string | null; agent_id?: string | null }

/**
 * @proofSeam PURE — the open-house identity rule. Among the HELD rows of one listing on one date, the canonical one (earliest
 * created, then lowest id). A duplicate calendar row of the same open house resolves to the same id, so it counts once.
 */
export function canonicalHeldOpenHouseId(rows: OpenHouseRow[], target: Pick<OpenHouseRow, "listing_id" | "event_date">): string | null {
  const held = rows.filter((ev) => ev.status === "completed" && !ev.cancelled_at && OPEN_HOUSE_COUNTABLE_TYPES.includes(String(ev.event_type ?? "open_house")) &&
    !!ev.listing_id && ev.listing_id === target.listing_id && ev.event_date === target.event_date)
  held.sort((x, y) => String(x.created_at ?? "").localeCompare(String(y.created_at ?? "")) || x.id.localeCompare(y.id))
  return held[0]?.id ?? null
}

/** R2 — the canonical held open house behind LISTING_OPEN_HOUSE_COMPLETED (entity open_house_event) + its host, or null. */
async function openHouseEvidence(db: LedgerCapableClient, brokerageId: string, eventId: string, now: Date): Promise<{ referenceId: string; agentId: string } | null> {
  const cols = "id, listing_id, event_date, event_type, status, cancelled_at, created_at, agent_id"
  const { data: ev, error } = await db.from("open_house_events").select(cols).eq("id", eventId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) { console.error(`[lifecycle-gamification] open-house evidence read refused: ${error.message}`); return null }
  const row = ev as OpenHouseRow | null
  if (!row || row.status !== "completed" || row.cancelled_at || !row.listing_id || !row.event_date) return null
  if (row.event_date > now.toISOString().slice(0, 10)) return null // not held before its date
  const { data: siblings, error: sibErr } = await db.from("open_house_events").select(cols)
    .eq("brokerage_id", brokerageId).eq("listing_id", row.listing_id).eq("event_date", row.event_date)
  if (sibErr) { console.error(`[lifecycle-gamification] open-house identity read refused: ${sibErr.message}`); return null }
  const canonical = canonicalHeldOpenHouseId((siblings ?? []) as OpenHouseRow[], row)
  if (!canonical) return null
  const host = ((siblings ?? []) as OpenHouseRow[]).find((r) => r.id === canonical)?.agent_id ?? row.agent_id
  return isUuid(host) ? { referenceId: canonical, agentId: host } : null
}

export interface RecordOpenHouseHeldInput {
  eventId: string
  /** The tenant the caller already established: the session's, or — for the post-event sweep — the brokerage_id of the event
   *  row the sweep itself read. REQUIRED: a missing tenant refuses, it never widens the read to every tenant (CLAUDE.md §4). */
  brokerageId: string | null
  /** host_ended = the host's End Event action (verified owner); post_event_sweep = the cron after the end time, which needs
   *  attendance evidence (a sign-in, a verified attendance row or an attended RSVP) before the event counts as held. */
  via: "host_ended" | "post_event_sweep"
  actorUserId?: string | null
  now?: Date
  /** Emit seam (default: the kernel emitter — row + reactor fan-out). The proof injects a counting emitter. */
  emit?: (e: { brokerageId: string; eventId: string; metadata: Record<string, unknown>; actorUserId: string | null }) => Promise<{ error: string | null }>
}
export type RecordOpenHouseHeldResult =
  | { ok: true; held: boolean; alreadyCompleted: boolean; emitted: boolean; reason?: string }
  | { ok: false; error: string }

/**
 * R2 — THE ONE OPEN-HOUSE HELD WRITER. Moves an open_house_events row to completed ONLY from scheduled / active / marketing
 * (never from draft or cancelled — the post-event sweep used to flip a cancelled event to completed), and emits
 * LISTING_OPEN_HOUSE_COMPLETED on entity open_house_event ONCE — on the call that made the transition, for a listing open
 * house, on or after its date, with hosting evidence. A replay (already completed) emits nothing. Sign-ins stay a separate
 * analytic: they are evidence the open house happened, never a second count.
 */
export async function recordOpenHouseHeld(db: LedgerCapableClient, input: RecordOpenHouseHeldInput): Promise<RecordOpenHouseHeldResult> {
  const now = input.now ?? new Date()
  if (!input.brokerageId) return { ok: false, error: "Open house not found" }
  const { data: ev, error } = await db.from("open_house_events").select("id, brokerage_id, listing_id, event_date, event_type, status, cancelled_at")
    .eq("id", input.eventId).eq("brokerage_id", input.brokerageId).maybeSingle()
  if (error) return { ok: false, error: `open house read refused: ${error.message}` }
  const row = ev as (OpenHouseRow & { brokerage_id: string | null }) | null
  if (!row || !row.brokerage_id) return { ok: false, error: "Open house not found" }
  if (row.status === "cancelled" || row.cancelled_at) return { ok: false, error: "A cancelled open house is never held" }
  if (row.status === "draft") return { ok: false, error: "A draft open house was never published, so it cannot be held" }
  if (row.status === "completed") return { ok: true, held: false, alreadyCompleted: true, emitted: false, reason: "already recorded as held — a replay adds nothing" }
  if (!row.event_date || row.event_date > now.toISOString().slice(0, 10)) return { ok: false, error: "An open house can only be held on or after its date" }

  const { data: moved, error: moveErr } = await db.from("open_house_events").update({ status: "completed" })
    .eq("id", row.id).eq("brokerage_id", row.brokerage_id).in("status", OPEN_HOUSE_HELD_FROM as string[]).select("id")
  if (moveErr) return { ok: false, error: `open house not marked held: ${moveErr.message}` }
  if ((moved ?? []).length === 0) return { ok: true, held: false, alreadyCompleted: true, emitted: false, reason: "another writer recorded it first" }

  if (!row.listing_id || !OPEN_HOUSE_COUNTABLE_TYPES.includes(String(row.event_type ?? "open_house"))) {
    return { ok: true, held: false, alreadyCompleted: false, emitted: false, reason: `a ${row.event_type ?? "event"} without a listing is not an open-house count` }
  }
  if (input.via === "post_event_sweep") {
    const evidence = await hostingEvidence(db, row.brokerage_id, row.id)
    if (evidence === "refused") return { ok: true, held: false, alreadyCompleted: false, emitted: false, reason: "hosting evidence could not be read — not counted (fail closed)" }
    if (!evidence) return { ok: true, held: false, alreadyCompleted: false, emitted: false, reason: "closed by the sweep with no sign-in or verified attendance — not counted as held" }
  }

  const metadata = { listing_id: row.listing_id, event_date: row.event_date, via: input.via }
  const emit = input.emit ?? (async (e) => {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    const r = await emitKernelEvent({
      brokerageId: e.brokerageId, event: KernelEvent.LISTING_OPEN_HOUSE_COMPLETED, entityType: "open_house_event", entityId: e.eventId,
      actorUserId: e.actorUserId, agentUserId: null, metadata: e.metadata, dedupeKey: `open-house-held-${e.eventId}`, dedupeWindowSec: 7 * 86_400,
    })
    return { error: r.error }
  })
  const emitted = await emit({ brokerageId: row.brokerage_id, eventId: row.id, metadata, actorUserId: input.actorUserId ?? null })
  if (emitted.error) console.error(`[open-house-held] ${row.id} held but LISTING_OPEN_HOUSE_COMPLETED not recorded: ${emitted.error}`)
  return { ok: true, held: true, alreadyCompleted: false, emitted: !emitted.error }
}

/** Was the open house actually hosted? A sign-in, a verified attendance row, or an attended RSVP. "refused" fails closed. */
async function hostingEvidence(db: LedgerCapableClient, brokerageId: string, eventId: string): Promise<boolean | "refused"> {
  const probes: Array<[string, (q: any) => any]> = [
    ["open_house_attendees", (q) => q],
    ["event_attendance_evidence", (q) => q],
    ["open_house_rsvp_tracking", (q) => q.eq("rsvp_status", "attended")],
  ]
  for (const [table, narrow] of probes) {
    const { data, error } = await narrow(db.from(table).select("id").eq("event_id", eventId).eq("brokerage_id", brokerageId)).limit(1)
    if (error) return "refused"
    if ((data ?? []).length > 0) return true
  }
  return false
}

/** R3 — calendar states that are not a genuine appointment (the calendar has no CHECK; these are the spellings in use). */
const NOT_AN_APPOINTMENT = new Set(["cancelled", "canceled", "no_show", "declined"])

export type AppointmentStage = "booked" | "held" | "agreement_executed"
/**
 * @proofSeam PURE — the four words of R3, kept apart. booked: on the calendar, not yet happened (or cancelled / no-show).
 * held: it happened. agreement_executed: it happened, by this agent, before an executed agreement with the same client.
 * Only agreement_executed earns SIGNED_AGREEMENT_APPOINTMENT.
 */
export function appointmentStage(
  appt: { status?: string | null; start_at?: string | null; agent_user_id?: string | null },
  ctx: { now: Date; agentUserId: string | null; executedAt: string | null },
): AppointmentStage {
  const start = appt.start_at ? Date.parse(appt.start_at) : NaN
  if (NOT_AN_APPOINTMENT.has(String(appt.status ?? "").toLowerCase()) || !Number.isFinite(start) || start > ctx.now.getTime()) return "booked"
  if (!ctx.executedAt || !ctx.agentUserId || appt.agent_user_id !== ctx.agentUserId) return "held"
  return start <= Date.parse(ctx.executedAt) ? "agreement_executed" : "held"
}

/** A listing agreement is EXECUTED when both parties signed, compliance passed, and its e-sign state is an executed one. */
const LISTING_EXECUTED_ESIGN = new Set(["fully_signed", "fully_executed", "compliance_approved"])
/** A buyer agreement is EXECUTED when signed through a provider or the buyer's own click-through; a wet signature the agent
 *  RECORDS counts only with the signed document attached (otherwise it is the agent's own assertion). */
const BUYER_EXECUTED_STATUS = new Set(["active", "expired", "superseded"])

async function agentUserIdOf(db: LedgerCapableClient, brokerageId: string, agentId: string): Promise<string | null> {
  const { data, error } = await db.from("agents").select("user_id").eq("id", agentId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) { console.error(`[lifecycle-gamification] agent user read refused: ${error.message}`); return null }
  const u = (data as { user_id?: string | null } | null)?.user_id
  return isUuid(u) ? u : null
}

async function hasGenuineAppointment(db: LedgerCapableClient, brokerageId: string, probes: Array<{ col: string; val: string; entityType?: string }>, agentUserId: string, executedAt: string, now: Date): Promise<boolean> {
  for (const p of probes) {
    let q = db.from("calendar_events").select("id, status, start_at, agent_user_id").eq("brokerage_id", brokerageId).eq(p.col, p.val)
    if (p.entityType) q = q.eq("entity_type", p.entityType)
    const { data, error } = await q
    if (error) { console.error(`[lifecycle-gamification] appointment read refused: ${error.message}`); return false }
    if (((data ?? []) as Array<{ status?: string | null; start_at?: string | null; agent_user_id?: string | null }>)
      .some((a) => appointmentStage(a, { now, agentUserId, executedAt }) === "agreement_executed")) return true
  }
  return false
}

/** R3 — LISTING_AGREEMENT_SIGNED (entity listing_stage_machine = the listing): the canonical executed listing agreement + its
 *  agent, when a genuine appointment by that agent (the listing appointment, or one on the listing / the seller) preceded it. */
async function listingAgreementEvidence(db: LedgerCapableClient, brokerageId: string, listingId: string, now: Date): Promise<{ referenceId: string; agentId: string } | null> {
  const { data: listing, error } = await db.from("listings").select("id, agent_id, appointment_event_id, seller_contact_id").eq("id", listingId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) { console.error(`[lifecycle-gamification] listing read refused: ${error.message}`); return null }
  const l = listing as { agent_id?: string | null; appointment_event_id?: string | null; seller_contact_id?: string | null } | null
  if (!l || !isUuid(l.agent_id)) return null
  const { data: agreements, error: agErr } = await db.from("listing_agreements")
    .select("id, esign_status, seller_signed_at, agent_signed_at, compliance_passed, fully_executed_at, created_at")
    .eq("listing_id", listingId).eq("brokerage_id", brokerageId)
  if (agErr) { console.error(`[lifecycle-gamification] listing agreement read refused: ${agErr.message}`); return null }
  const executed = ((agreements ?? []) as Array<{ id: string; esign_status?: string | null; seller_signed_at?: string | null; agent_signed_at?: string | null; compliance_passed?: boolean | null; fully_executed_at?: string | null; created_at?: string | null }>)
    .filter((a) => LISTING_EXECUTED_ESIGN.has(String(a.esign_status)) && !!a.seller_signed_at && !!a.agent_signed_at && a.compliance_passed === true)
    .sort((x, y) => String(x.created_at ?? "").localeCompare(String(y.created_at ?? "")) || x.id.localeCompare(y.id))
  const root = executed[0]
  if (!root) return null
  const agentUserId = await agentUserIdOf(db, brokerageId, l.agent_id)
  if (!agentUserId) return null
  const executedAt = root.fully_executed_at ?? root.seller_signed_at!
  const probes: Array<{ col: string; val: string; entityType?: string }> = []
  if (isUuid(l.appointment_event_id)) probes.push({ col: "id", val: l.appointment_event_id })
  probes.push({ col: "entity_id", val: listingId, entityType: "listing" })
  if (isUuid(l.seller_contact_id)) probes.push({ col: "entity_id", val: l.seller_contact_id, entityType: "contact" })
  return (await hasGenuineAppointment(db, brokerageId, probes, agentUserId, executedAt, now)) ? { referenceId: root.id, agentId: l.agent_id } : null
}

/** R3 — BUYER_BROKER_AGREEMENT_SIGNED (entity buyer_broker_agreement): the ROOT of the ENGAGEMENT (a re-sign never pays again) +
 *  its agent, when a genuine appointment with the buyer preceded the signature.
 *
 *  THE ROOT IS DERIVED FROM FACTS ON FILE, NOT FROM A LINK NOTHING WRITES (wave 155, integrator). The first version walked
 *  `buyer_broker_agreements.superseded_by` back to the original. That column exists, and NO code, trigger or function writes
 *  it (read from the live database 2026-11-20: 0 triggers that mention it, 0 rows) — so the walk never found a predecessor and
 *  a replacement agreement with the same buyer would have been paid as a new one. The engagement is now read from what the
 *  agreements themselves record: an EARLIER executed agreement between the SAME agent and the SAME buyer that was still in
 *  force when the later one was signed (not cancelled before it, not expired before it) is the same engagement, and the walk
 *  repeats from it. An agreement signed after the earlier one was cancelled or had expired is a new engagement.
 *  @proofSeam scripts/gamification-guard.ts */
async function buyerAgreementEvidence(db: LedgerCapableClient, brokerageId: string, agreementId: string, now: Date): Promise<{ referenceId: string; agentId: string } | null> {
  const cols = "id, agent_id, buyer_contact_id, status, signed_at, signed_method, signed_document_url"
  const { data, error } = await db.from("buyer_broker_agreements").select(cols).eq("id", agreementId).eq("brokerage_id", brokerageId).maybeSingle()
  if (error) { console.error(`[lifecycle-gamification] buyer agreement read refused: ${error.message}`); return null }
  type Bba = { id: string; agent_id?: string | null; buyer_contact_id?: string | null; status?: string | null; signed_at?: string | null; signed_method?: string | null; signed_document_url?: string | null }
  const row = data as Bba | null
  if (!row || !row.signed_at || !BUYER_EXECUTED_STATUS.has(String(row.status)) || !isUuid(row.agent_id) || !isUuid(row.buyer_contact_id)) return null
  if (!row.signed_method || (row.signed_method === "wet_signature" && !row.signed_document_url)) return null
  const { data: pairRows, error: pairErr } = await db.from("buyer_broker_agreements").select("id, status, signed_at, cancelled_at, expiration_date")
    .eq("brokerage_id", brokerageId).eq("agent_id", row.agent_id).eq("buyer_contact_id", row.buyer_contact_id)
  if (pairErr) { console.error(`[lifecycle-gamification] agreement engagement read refused: ${pairErr.message}`); return null }
  const root = buyerEngagementRoot({ id: row.id, signed_at: row.signed_at }, (pairRows ?? []) as BuyerAgreementFact[])
  const agentUserId = await agentUserIdOf(db, brokerageId, row.agent_id)
  if (!agentUserId) return null
  return (await hasGenuineAppointment(db, brokerageId, [{ col: "entity_id", val: row.buyer_contact_id, entityType: "contact" }], agentUserId, row.signed_at, now))
    ? { referenceId: root, agentId: row.agent_id } : null
}

export interface BuyerAgreementFact { id: string; status?: string | null; signed_at?: string | null; cancelled_at?: string | null; expiration_date?: string | null }
/** PURE. The first agreement of the engagement `current` belongs to, among the executed agreements of ONE agent–buyer pair. */
export function buyerEngagementRoot(current: { id: string; signed_at: string }, pair: readonly BuyerAgreementFact[]): string {
  const executed = pair.filter((p) => !!p.signed_at && BUYER_EXECUTED_STATUS.has(String(p.status)) && p.id !== current.id)
    .sort((x, y) => String(x.signed_at).localeCompare(String(y.signed_at)))
  let cur = current
  for (let hop = 0; hop < 10; hop++) {
    const day = cur.signed_at.slice(0, 10)
    const earlier = executed.find((p) => String(p.signed_at) < cur.signed_at
      && (!p.cancelled_at || String(p.cancelled_at) >= cur.signed_at)
      && (!p.expiration_date || String(p.expiration_date).slice(0, 10) >= day))
    if (!earlier) break
    cur = { id: earlier.id, signed_at: String(earlier.signed_at) }
  }
  return cur.id
}

export interface LifecycleAwardOutcome {
  awarded: Array<{ agentId: string; reason: PointReason; points: number; newTotal: number }>
  alreadyAwarded: number
  badgesAwarded: number
  refused: string[]
}

/**
 * THE REACTOR HOOK. Called by lib/kernel/event-reactor.ts for every canonical event
 * with the service client. Best-effort by contract — the event's own business write
 * has already landed; a refused award is returned in `refused` and logged, never
 * thrown into the fan-out.
 */
export async function awardLifecycleMilestones(
  db: LedgerCapableClient,
  p: MilestoneEventParams,
  now: Date = new Date(),
): Promise<LifecycleAwardOutcome> {
  const out: LifecycleAwardOutcome = { awarded: [], alreadyAwarded: 0, badgesAwarded: 0, refused: [] }
  if (!LIFECYCLE_AWARD_RULES.some((r) => r.event === p.event)) return out

  const agents = await resolveMilestoneAgents(db, p)
  const actingId = agents.acting[0] ?? null
  const repeatClient = p.event === KernelEvent.TRANSACTION_CLOSED && actingId
    ? await isRepeatClientClose(db, p.brokerageId, p.entityId, actingId)
    : false

  const referralEvidenceTransactionId = p.event === KernelEvent.REFERRAL_CONVERTED && p.entityType === "referral" && isUuid(p.entityId)
    ? await referralEvidenceTransaction(db, p.brokerageId, p.entityId)
    : null
  if (p.event === KernelEvent.REFERRAL_CONVERTED && !referralEvidenceTransactionId) {
    out.refused.push(`REFERRAL_CONVERTED: no closed transaction evidences referral ${p.entityId} — it earns when that deal closes`)
  }
  const referralAgents = p.event === KernelEvent.TRANSACTION_CLOSED && isUuid(p.entityId)
    ? await wonReferralAgentsForClose(db, p.brokerageId, p.entityId)
    : []

  // WAVE 155 (155C): the evidence behind R1 / R2 / R3. For an open house and an agreement the earning agent is the one the
  // EVIDENCE names (the host, the listing / agreement agent) — a metadata.agent_id on the event never redirects the award.
  const ruleFor = (entityType: string) => LIFECYCLE_AWARD_RULES.some((r) => r.event === p.event && r.entityType === entityType)
  let courseEvidenceModuleId: string | null = null
  let openHouseEvidenceId: string | null = null
  let agreementEvidenceId: string | null = null
  if (ruleFor("learning_module") && p.entityType === "learning_module" && isUuid(p.entityId)) {
    courseEvidenceModuleId = actingId ? await courseEvidence(db, p.brokerageId, p.entityId, actingId) : null
    if (!courseEvidenceModuleId) out.refused.push(`TRAINING_COMPLETED: no persisted passing attempt for course ${p.entityId} — reading a course never completes it`)
  }
  if (ruleFor("open_house_event") && p.entityType === "open_house_event" && isUuid(p.entityId)) {
    const ev = await openHouseEvidence(db, p.brokerageId, p.entityId, now)
    if (ev) { openHouseEvidenceId = ev.referenceId; agents.acting = [ev.agentId] }
    else out.refused.push(`OPEN_HOUSE_HOSTED: open house ${p.entityId} is not a held listing open house in this account`)
  }
  if ((ruleFor("listing_stage_machine") && p.entityType === "listing_stage_machine") || (ruleFor("buyer_broker_agreement") && p.entityType === "buyer_broker_agreement")) {
    const ev = isUuid(p.entityId)
      ? (p.entityType === "listing_stage_machine" ? await listingAgreementEvidence(db, p.brokerageId, p.entityId, now) : await buyerAgreementEvidence(db, p.brokerageId, p.entityId, now))
      : null
    if (ev) { agreementEvidenceId = ev.referenceId; agents.acting = [ev.agentId] }
    else out.refused.push(`SIGNED_AGREEMENT_APPOINTMENT: no executed agreement preceded by a genuine appointment for ${p.entityType} ${p.entityId} — a booking alone earns nothing`)
  }

  const plans = planLifecycleAwards(p.event, { entityId: p.entityId, metadata: p.metadata, now, repeatClient, entityType: p.entityType, referralEvidenceTransactionId, courseEvidenceModuleId, openHouseEvidenceId, agreementEvidenceId })
  for (const plan of plans) {
    const recipients = plan.party === "mentor_and_mentee" ? agents.mentorAndMentee
      : plan.party === "referral_agent" ? referralAgents
      : agents.acting
    // A close with no won referral behind it is the ordinary case — nothing to award, nothing refused.
    if (plan.party === "referral_agent" && recipients.length === 0) continue
    if (recipients.length === 0) {
      out.refused.push(`${plan.reason}: no agents.id resolvable from ${p.entityType} ${p.entityId}`)
      continue
    }
    for (const agentId of recipients) {
      const res = await awardAgentPointsOnce(db, {
        agentId, points: plan.points, reason: plan.reason, referenceType: plan.referenceType,
        referenceId: plan.once.referenceId ?? null, once: plan.once,
      })
      if (!res.ok) { out.refused.push(`${plan.reason} for ${agentId}: ${res.error}`); continue }
      if ("alreadyAwarded" in res) { out.alreadyAwarded++; continue }
      out.awarded.push({ agentId, reason: plan.reason, points: res.pointsAdded, newTotal: res.newTotal })
      // Milestone badges: the catalog rows whose trigger_event names THIS reason (m705
      // seeds them; a tenant may add its own). Threshold badges stay with
      // checkAndAwardBadges — the two awarders never overlap on a trigger_event.
      const badges = await awardEventBadges(db, { agentId, brokerageId: res.brokerageId, triggerEvent: plan.reason })
      out.badgesAwarded += badges.awarded
      out.refused.push(...badges.refused)
      // WAVE 153 (lane 153I): THRESHOLD badges on the total the database now holds. Until now only the retired public
      // addPoints door and a contact reassignment ran the threshold check, so a closing / showing / offer that crossed a
      // tier never earned its points badge.
      const thresholds = await awardThresholdBadges(db, { agentId, brokerageId: res.brokerageId })
      out.badgesAwarded += thresholds.awarded.length
      out.refused.push(...thresholds.refused)
    }
  }
  for (const r of out.refused) console.error(`[lifecycle-gamification] ${p.event}: ${r}`)
  return out
}

// ─── BADGES — the ONE badge awarder (merged here from app/actions/gamification.ts) ─

/**
 * WAVE 153 (lane 153I): every active POINTS-THRESHOLD badge the agent's STORED total has reached (agents.gamification_points —
 * the total award_agent_points() keeps), awarded through awardBadgeToAgent. The total is READ here, never accepted from a
 * caller: app/actions/gamification.ts checkAndAwardBadges (a public "use server" export) used to award against whatever
 * number it was handed. Platform defaults (brokerage_id NULL) plus the agent's own tenant's badges; event-triggered badges
 * (trigger_event = a milestone reason) stay with awardEventBadges — the two never overlap.
 */
export async function awardThresholdBadges(
  db: LedgerCapableClient,
  input: { agentId: string; brokerageId?: string | null },
): Promise<{ awarded: Array<{ id: string; name: string; tier: string | null; requiredPoints: number }>; refused: string[] }> {
  const out = { awarded: [] as Array<{ id: string; name: string; tier: string | null; requiredPoints: number }>, refused: [] as string[] }
  // The agent is read by its own id (one row) and its STORED tenant is the tenant; a caller-supplied brokerage that disagrees
  // is refused below — never a conditional predicate that decays into "any tenant" when the id is missing (CLAUDE.md §4).
  const { data: agent, error: agentErr } = await db.from("agents").select("id, brokerage_id, gamification_points").eq("id", input.agentId).maybeSingle()
  if (agentErr) { out.refused.push(`agents read refused — threshold badges withheld: ${agentErr.message}`); return out }
  const a = agent as { brokerage_id: string | null; gamification_points: number | null } | null
  if (!a?.brokerage_id) return out
  if (input.brokerageId != null && a.brokerage_id !== input.brokerageId) { out.refused.push("the agent does not belong to the named account — threshold badges withheld"); return out }
  const total = Number(a.gamification_points) || 0
  // The catalog is small (platform defaults + one tenant's own): the threshold is applied here, on the stored total.
  const { data: badges, error } = await db.from("gamification_badges").select("id, badge_name, badge_tier, required_points, trigger_event")
    .eq("is_active", true).or(`brokerage_id.is.null,brokerage_id.eq.${a.brokerage_id}`)
  if (error) { out.refused.push(`gamification_badges read refused: ${error.message}`); return out }
  for (const b of ((badges ?? []) as Array<{ id: string; badge_name: string; badge_tier: string | null; required_points: number; trigger_event: string | null }>)
    .filter((x) => (x.trigger_event ?? "points_threshold") === "points_threshold" && (Number(x.required_points) || 0) <= total)
    .sort((x, y) => (Number(x.required_points) || 0) - (Number(y.required_points) || 0))) {
    const res = await awardBadgeToAgent(db, { agentId: input.agentId, badgeId: b.id, reason: `Reached ${Number(b.required_points).toLocaleString()} points` })
    if (!res.ok) out.refused.push(`badge ${b.badge_name}: ${res.error}`)
    else if (!res.alreadyAwarded) out.awarded.push({ id: res.badgeRowId, name: b.badge_name, tier: b.badge_tier, requiredPoints: Number(b.required_points) || 0 })
  }
  return out
}

export interface AwardBadgeInput { agentId: string; badgeId: string; reason: string }
export type AwardBadgeResult =
  | { ok: true; alreadyAwarded: true }
  | { ok: true; alreadyAwarded: false; badgeRowId: string; badgeName: string; badgeTier: string | null }
  | { ok: false; error: string }

/**
 * Award one badge, idempotently. The tenant is derived from the AGENT's row (never
 * from the caller), the award is a lifecycle_events row (GAMIFICATION_BADGE_AWARDED)
 * and the agent is told. agent_badges_unique(agent_id, badge_id) is the hard stop
 * beneath the pre-read: a 23505 from a racing twin reads as alreadyAwarded.
 */
export async function awardBadgeToAgent(db: LedgerCapableClient, input: AwardBadgeInput): Promise<AwardBadgeResult> {
  const { data: existing, error: existErr } = await db.from("agent_badges").select("id")
    .eq("agent_id", input.agentId).eq("badge_id", input.badgeId).maybeSingle()
  if (existErr) return { ok: false, error: `agent_badges read refused: ${existErr.message}` }
  if (existing) return { ok: true, alreadyAwarded: true }

  const { data: agentData, error: agentErr } = await db.from("agents").select("brokerage_id, user_id").eq("id", input.agentId).single()
  if (agentErr) return { ok: false, error: `agents read refused: ${agentErr.message}` }
  if (!agentData?.brokerage_id) return { ok: false, error: `no brokerage resolvable from agent ${input.agentId}` }

  const { data: newBadge, error } = await db.from("agent_badges").insert({
    brokerage_id: agentData.brokerage_id,
    agent_id: input.agentId,
    badge_id: input.badgeId,
    awarded_reason: input.reason,
    awarded_at: new Date().toISOString(),
  }).select("id, gamification_badges:badge_id(badge_name, badge_tier)").single()
  if (error) {
    if (/23505|duplicate key/i.test(error.message)) return { ok: true, alreadyAwarded: true }
    return { ok: false, error: `agent_badges insert refused: ${error.message}` }
  }
  const def = (newBadge as any).gamification_badges
  const badgeName: string = (Array.isArray(def) ? def[0]?.badge_name : def?.badge_name) ?? "a badge"
  const badgeTier: string | null = (Array.isArray(def) ? def[0]?.badge_tier : def?.badge_tier) ?? null

  // Evidence: the audit row + reactor (the Recruiting → Campaign social-proof handoff
  // keys on this event). Lazy import — the reactor imports THIS module.
  try {
    const { emitKernelEvent } = await import("@/lib/kernel/emit")
    await emitKernelEvent({
      brokerageId: agentData.brokerage_id,
      event: KernelEvent.GAMIFICATION_BADGE_AWARDED,
      entityType: "agent_badge",
      entityId: newBadge.id,
      agentId: input.agentId,
      metadata: { agent_id: input.agentId, badge_id: input.badgeId, badge_name: badgeName, badge_tier: badgeTier, reason: input.reason },
    })
  } catch (e) {
    console.error(`[awardBadgeToAgent] badge ${newBadge.id} awarded but GAMIFICATION_BADGE_AWARDED did not emit:`, e)
  }
  if (agentData.user_id) {
    const { error: notifyErr } = await db.from("notifications").insert({
      user_id: agentData.user_id, brokerage_id: agentData.brokerage_id,
      type: "gamification_badge_awarded", title: `Badge earned: ${badgeName}`, body: input.reason,
      entity_type: "agent_badge", entity_id: newBadge.id, priority: "low", is_read: false,
    })
    if (notifyErr) console.error(`[awardBadgeToAgent] badge ${newBadge.id} awarded but the agent was not notified: ${notifyErr.message}`)
  }
  return { ok: true, alreadyAwarded: false, badgeRowId: newBadge.id, badgeName, badgeTier }
}

/**
 * Award every active catalog badge whose trigger_event is this milestone reason.
 * Visible rows are the platform defaults (brokerage_id NULL) plus the agent's own
 * tenant's — a service client sees every tenant, so the filter is explicit here.
 */
async function awardEventBadges(
  db: LedgerCapableClient,
  input: { agentId: string; brokerageId: string; triggerEvent: string },
): Promise<{ awarded: number; refused: string[] }> {
  const out = { awarded: 0, refused: [] as string[] }
  const { data: badges, error } = await db.from("gamification_badges").select("id, badge_name")
    .eq("is_active", true).eq("trigger_event", input.triggerEvent)
    .or(`brokerage_id.is.null,brokerage_id.eq.${input.brokerageId}`)
  if (error) { out.refused.push(`gamification_badges read refused: ${error.message}`); return out }
  for (const b of (badges ?? []) as Array<{ id: string; badge_name: string }>) {
    const res = await awardBadgeToAgent(db, { agentId: input.agentId, badgeId: b.id, reason: `Milestone: ${input.triggerEvent}` })
    if (!res.ok) out.refused.push(`badge ${b.badge_name}: ${res.error}`)
    else if (!res.alreadyAwarded) out.awarded++
  }
  return out
}
