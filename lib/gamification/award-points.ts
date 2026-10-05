// lib/gamification/award-points.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE POINT-AWARD PATH.
//
// Six writers used to advance an agent's points and no two of them agreed:
//
//   app/actions/gamification.addPoints          read agents.gamification_points,
//                                               added, wrote it back, THEN logged.
//   app/actions/agents.awardPoints              same read-modify-write, and its
//                                               ledger insert supplied NO
//                                               brokerage_id — so every row it
//                                               wrote was invisible to the
//                                               leaderboard populator, which
//                                               filters on that column.
//   app/actions/onboarding/mentor-session       raw ledger insert, no total.
//   lib/recruiting/challenge-runner             raw ledger insert, no total.
//   app/actions/listing-lifecycle-core          +50 straight onto the total, NO
//                                               ledger row at all.
//   app/actions/ai-agent-onboarding             `gamification_points = 100` —
//                                               an absolute OVERWRITE that
//                                               DELETED whatever the agent had
//                                               earned, and no ledger row.
//
// Two consequences, both structural. First, every read-modify-write pair is a
// lost update: two awards landing between the same SELECT and UPDATE keep only
// one. Second, `agents.gamification_points` and `SUM(agent_points_log.points)`
// could never agree, so the tier an agent is shown and the board they are ranked
// on were computed from two different numbers.
//
// public.award_agent_points() (m484) does the increment and the ledger insert in
// ONE statement pair inside ONE transaction, deriving the tenant from the agents
// row so a caller cannot mis-stamp it. This module is the only way the app calls
// it — pass the client you already resolved (RLS client, or the service client for
// cron/kernel lanes); the RPC authorises either.

// The enum only (pure string constants) — this module stays importable without a
// server runtime; the kernel emitter is lazy-imported where a badge is written.
import { KernelEvent } from "@/lib/kernel/events"

/**
 * Canonical point values. Lives here, not in a "use server" module, so it can be a
 * const — and so the SURFACE that advertises "+50 for a showing" and the AWARDER
 * that grants it read the same number. They did not: /dashboard/motivation
 * advertised 500 for a closed deal, 200 for a referral and 50 for a showing, while
 * the awarder granted 100, 75 and 10. Every card on that page overstated the reward
 * by between 2x and 5x.
 */
export const POINT_VALUES = {
  LISTING_CLOSED: 100,
  OFFER_SUBMITTED: 50,
  REFERRAL_CREATED: 75,
  VENDOR_REVIEW_WRITTEN: 25,
  SHOWING_COMPLETED: 50,
  FOLLOWUP_SENT: 10,
  SOCIAL_POST_PUBLISHED: 15,
  TRAINING_COMPLETED: 25,
  OPEN_HOUSE_HOSTED: 25,
  CONTACT_ASSIGNED: 10,
  ONBOARDING_STEP_COMPLETED: 10,
  ONBOARDING_COMPLETED: 100,
  SELLER_LIFETIME_TRANSITION: 50,
  MENTOR_SESSION_HELD: 75,
  CAP_HIT: 200,
  // ── Layer-6 lifecycle milestones (wave 103, lane 103C) — awarded by the EVENT
  //    REACTOR on canonical kernel events (awardLifecycleMilestones below), never by
  //    a call site. "FIRST_*" fire once per agent for life; the rest once per
  //    reference (the certification, the close, the session, the referral).
  CERTIFICATION_EARNED: 150,
  FIRST_CONTACT: 25,
  FIRST_APPOINTMENT: 50,
  FIRST_CLOSE: 250,
  CE_COMPLETED: 25,
  WORK_ANNIVERSARY: 100,
  /** The owner's "knows the client for life" model: a kept anniversary touch on a past client. */
  LIFETIME_TOUCHPOINT_KEPT: 15,
  REFERRAL_CONVERTED: 100,
  /** A close for a contact the agent has ALREADY closed with — the repeat client. */
  REPEAT_CLIENT_CLOSED: 150,
} as const

export type PointReason = keyof typeof POINT_VALUES

/**
 * The earning actions a surface may advertise, and the ONE place their point value
 * comes from. Anything not on this list is awarded by the system rather than chosen
 * by the agent, so it is not something to put a "go do this" card in front of them.
 */
export const POINT_EARNING_ACTIONS: ReadonlyArray<{ reason: PointReason; label: string }> = [
  { reason: "LISTING_CLOSED", label: "Close a deal" },
  { reason: "REFERRAL_CREATED", label: "Send a referral" },
  { reason: "SHOWING_COMPLETED", label: "Complete a showing" },
  { reason: "OFFER_SUBMITTED", label: "Submit an offer" },
  { reason: "OPEN_HOUSE_HOSTED", label: "Host an open house" },
  { reason: "TRAINING_COMPLETED", label: "Complete a training" },
  { reason: "VENDOR_REVIEW_WRITTEN", label: "Review a vendor" },
  { reason: "SOCIAL_POST_PUBLISHED", label: "Post social content" },
  { reason: "FOLLOWUP_SENT", label: "Send a follow-up" },
]

/** Minimal shape of the supabase client this needs — any of the app's clients satisfies it. */
export interface RpcCapableClient {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>
}

export interface AwardPointsInput {
  agentId: string
  points: number
  /** Free text stored on the ledger row — the event that earned them. */
  reason: string
  referenceType?: string | null
  referenceId?: string | null
}

export type AwardPointsResult =
  | { ok: true; brokerageId: string; pointsAdded: number; newTotal: number; logId: string }
  | { ok: false; error: string }

/**
 * Award points atomically. Returns the agent's NEW total so the caller can run the
 * badge check against a number that is actually in the database, rather than
 * against its own stale arithmetic.
 */
export async function awardAgentPoints(
  db: RpcCapableClient,
  input: AwardPointsInput,
): Promise<AwardPointsResult> {
  if (!input.agentId) return { ok: false, error: "awardAgentPoints: no agent id was supplied" }
  const points = Math.trunc(Number(input.points))
  if (!Number.isFinite(points) || points === 0) {
    return { ok: false, error: `awardAgentPoints: ${String(input.points)} is not a whole number of points` }
  }

  const { data, error } = await db.rpc("award_agent_points", {
    p_agent_id: input.agentId,
    p_points: points,
    p_reason: input.reason,
    p_reference_type: input.referenceType ?? null,
    p_reference_id: input.referenceId ?? null,
  })

  // supabase-js RESOLVES a refusal, so the error has to be read, never assumed away.
  if (error) return { ok: false, error: `award_agent_points refused the award: ${error.message}` }

  const row = data as
    | { brokerage_id?: string; points_added?: number; new_total?: number; log_id?: string }
    | null
  if (!row?.brokerage_id || row.new_total == null) {
    return { ok: false, error: "award_agent_points returned no row — the award did not land" }
  }

  return {
    ok: true,
    brokerageId: row.brokerage_id,
    pointsAdded: Number(row.points_added ?? points),
    newTotal: Number(row.new_total),
    logId: String(row.log_id ?? ""),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 6 — LIFECYCLE GAMIFICATION (wave 103, lane 103C)
//
// ONE award path (awardAgentPoints above), ONE trigger: the event reactor
// (lib/kernel/event-reactor.ts) calls awardLifecycleMilestones (lifecycle-awards.ts)
// for every canonical kernel event, and LIFECYCLE_AWARD_RULES says which events earn what. Call sites
// never award for an event they also emit — that was the double-award shape the
// client-side awardPointsForAction hooks had (a showing marked complete awarded
// from the component AND emitted SHOWING_COMPLETED; the moment the reactor
// learned to award, both would have landed).
//
// IDEMPOTENT. public.award_agent_points() ADDS — it is not idempotent on anything,
// and the reactor can see the same event twice (a retried emit, a merged
// audit-row + fan-out pair). awardAgentPointsOnce reads the ledger for the
// (agent, reason, reference | window) it is about to write and declines when a row
// already stands. Badges are idempotent at the database (agent_badges_unique on
// agent_id + badge_id, m484 §"does not add a UNIQUE … already exists").
//
// BLIND SPOT, stated: the once-check is read-then-write, not a constraint. Two
// reactor runs for the same event inside the same few milliseconds can both pass
// the read. A partial UNIQUE on (agent_id, reason, reference_id) was considered
// and REJECTED: CONTACT_ASSIGNED legitimately repeats on the same contact when it
// moves A → B → A, and the ledger already holds such pairs.

/** Minimal shape of a client that can both call the RPC and read/write tables. */
export interface LedgerCapableClient extends RpcCapableClient {
  from: (table: string) => any
}

/** The idempotency key of a once-award: a reference, a time window, or both. Neither = once for life. */
export interface OnceKey {
  referenceId?: string | null
  /** Only rows created on/after this instant count as "already awarded". */
  since?: Date | null
}

export type AwardOnceResult = AwardPointsResult | { ok: true; alreadyAwarded: true }

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** agent_points_log.reference_id is a uuid column (m484's RPC takes `p_reference_id uuid`).
 *  @proofSeam the proof asserts the shapes the ledger admits */
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v)
}

/**
 * Award ONCE per (agent, reason, once-key). Reads the ledger first; a standing row
 * declines the award without error. A refused read fails CLOSED (award withheld) —
 * assuming "not yet awarded" on a flaky read is how a ledger double-awards.
 * @proofSeam the proof drives it against an in-memory client (idempotency, fail-closed)
 */
export async function awardAgentPointsOnce(
  db: LedgerCapableClient,
  input: AwardPointsInput & { once: OnceKey },
): Promise<AwardOnceResult> {
  if (!input.agentId) return { ok: false, error: "awardAgentPointsOnce: no agent id was supplied" }
  const ref = input.once.referenceId ?? null
  if (ref !== null && !isUuid(ref)) {
    return { ok: false, error: `awardAgentPointsOnce: reference ${String(ref)} is not a uuid — agent_points_log.reference_id is uuid` }
  }

  let q = db.from("agent_points_log").select("id").eq("agent_id", input.agentId).eq("reason", input.reason).limit(1)
  if (ref !== null) q = q.eq("reference_id", ref)
  if (input.once.since) q = q.gte("created_at", input.once.since.toISOString())
  const { data: prior, error: readErr } = (await q.maybeSingle()) as { data: { id: string } | null; error: { message: string } | null }
  if (readErr) return { ok: false, error: `awardAgentPointsOnce: ledger read refused, award withheld (fail closed): ${readErr.message}` }
  if (prior?.id) return { ok: true, alreadyAwarded: true }

  return awardAgentPoints(db, {
    agentId: input.agentId,
    points: input.points,
    reason: input.reason,
    referenceType: input.referenceType ?? null,
    referenceId: ref,
  })
}

// ─── THE RULE TABLE ───────────────────────────────────────────────────────────

/** How often one agent may earn the reason. */
export type MilestoneScope =
  | "per_reference"          // once per entity (this close, this session, this certification)
  | "first_ever"             // once per agent, for life
  | "per_year"               // once per agent per calendar year (work anniversary)
  | "per_reference_per_year" // once per entity per calendar year (a kept anniversary touch per client)

export interface LifecycleAwardRule {
  event: KernelEvent
  reason: PointReason
  scope: MilestoneScope
  /** Who earns it. `acting` = the agent the event resolves to; `mentor_and_mentee` = both parties on a session. */
  party: "acting" | "mentor_and_mentee"
  /** Extra predicate on the resolved context (e.g. the contact was closed with before). */
  when?: "repeat_client" | "seller_side"
  /** Where the idempotency reference comes from; default = the event's entityId. */
  referenceFrom?: "entity" | "metadata.stepId" | "metadata.referral_id"
  referenceType: string
}

/**
 * THE AGENT LIFECYCLE and the CUSTOMER LIFECYCLE, as kernel events → awards. Pure
 * data: the proof walks it (every event is a real KernelEvent, every reason has a
 * POINT_VALUE, every scope is one the awarder implements).
 * @proofSeam the proof walks the table against the real KernelEvent enum
 */
export const LIFECYCLE_AWARD_RULES: readonly LifecycleAwardRule[] = [
  // ── agent lifecycle ──
  { event: KernelEvent.USER_ONBOARDING_STEP_COMPLETED, reason: "ONBOARDING_STEP_COMPLETED", scope: "per_reference", party: "acting", referenceFrom: "metadata.stepId", referenceType: "onboarding_step" },
  { event: KernelEvent.USER_ONBOARDING_COMPLETED, reason: "ONBOARDING_COMPLETED", scope: "first_ever", party: "acting", referenceType: "user" },
  { event: KernelEvent.ONBOARDING_COMPLETED, reason: "ONBOARDING_COMPLETED", scope: "first_ever", party: "acting", referenceType: "agent_onboarding" },
  { event: KernelEvent.CERTIFICATION_AWARDED, reason: "CERTIFICATION_EARNED", scope: "per_reference", party: "acting", referenceType: "agent_certification" },
  { event: KernelEvent.CONTACT_CREATED, reason: "FIRST_CONTACT", scope: "first_ever", party: "acting", referenceType: "contact" },
  { event: KernelEvent.ISA_APPOINTMENT_SCHEDULED, reason: "FIRST_APPOINTMENT", scope: "first_ever", party: "acting", referenceType: "calendar_event" },
  { event: KernelEvent.SHOWING_COMPLETED, reason: "SHOWING_COMPLETED", scope: "per_reference", party: "acting", referenceType: "showing" },
  { event: KernelEvent.TRANSACTION_CLOSED, reason: "LISTING_CLOSED", scope: "per_reference", party: "acting", referenceType: "transaction" },
  { event: KernelEvent.TRANSACTION_CLOSED, reason: "FIRST_CLOSE", scope: "first_ever", party: "acting", referenceType: "transaction" },
  { event: KernelEvent.CE_COMPLETED, reason: "CE_COMPLETED", scope: "per_reference", party: "acting", referenceType: "agent_ce_completion" },
  { event: KernelEvent.MENTOR_SESSION_HELD, reason: "MENTOR_SESSION_HELD", scope: "per_reference", party: "mentor_and_mentee", referenceType: "mentor_session" },
  { event: KernelEvent.AGENT_WORK_ANNIVERSARY, reason: "WORK_ANNIVERSARY", scope: "per_year", party: "acting", referenceType: "agent" },
  // ── customer lifecycle — "knows the client for life" earns the agent recognition ──
  // Wave 104 (lane 104E): the kept touch rides the TOUCH itself — LIFETIME_CUSTOMER_TOUCHPOINT_SENT, emitted
  // ONCE by lib/sphere/lifetime-touchpoint-ledger.ts (metadata.agent_id = the agent who kept it) — no longer
  // ANNIVERSARY_TRIGGERED, a calendar date the system fired whether or not anyone touched the client.
  { event: KernelEvent.LIFETIME_CUSTOMER_TOUCHPOINT_SENT, reason: "LIFETIME_TOUCHPOINT_KEPT", scope: "per_reference_per_year", party: "acting", referenceType: "contact" },
  // Wave 104 (lane 104E): the seller's lifetime transition now EMITS LIFETIME_CUSTOMER (metadata.side 'seller')
  // from lib/application/listing-lifecycle.ts handleSellerToLifetimeTransition, and the award moves here from
  // the call site. `when: "seller_side"` keeps the buyer-side LIFETIME_CUSTOMER (lifecycle-logger) out of it.
  { event: KernelEvent.LIFETIME_CUSTOMER, reason: "SELLER_LIFETIME_TRANSITION", scope: "per_reference", party: "acting", when: "seller_side", referenceType: "contact" },
  { event: KernelEvent.REFERRAL_RECEIVED, reason: "REFERRAL_CREATED", scope: "per_reference", party: "acting", referenceFrom: "metadata.referral_id", referenceType: "referral" },
  { event: KernelEvent.REFERRAL_CONVERTED, reason: "REFERRAL_CONVERTED", scope: "per_reference", party: "acting", referenceType: "referral" },
  { event: KernelEvent.TRANSACTION_CLOSED, reason: "REPEAT_CLIENT_CLOSED", scope: "per_reference", party: "acting", when: "repeat_client", referenceType: "transaction" },
]

export interface MilestonePlan {
  reason: PointReason
  points: number
  referenceType: string
  once: OnceKey
  party: LifecycleAwardRule["party"]
}

export interface MilestoneContext {
  entityId: string
  metadata?: Record<string, unknown> | null
  now: Date
  /** TRANSACTION_CLOSED only: the closing contact already closed with this agent before. */
  repeatClient?: boolean
}

function referenceFor(rule: LifecycleAwardRule, ctx: MilestoneContext): string | null {
  const meta = ctx.metadata ?? {}
  const raw =
    rule.referenceFrom === "metadata.stepId" ? meta.stepId :
    rule.referenceFrom === "metadata.referral_id" ? meta.referral_id :
    ctx.entityId
  return isUuid(raw) ? raw : null
}

/** @proofSeam PURE — the proof asserts the rule table resolves to the right once-keys without a database. */
export function planLifecycleAwards(event: string, ctx: MilestoneContext): MilestonePlan[] {
  const yearStart = new Date(Date.UTC(ctx.now.getUTCFullYear(), 0, 1))
  const plans: MilestonePlan[] = []
  for (const rule of LIFECYCLE_AWARD_RULES) {
    if (rule.event !== event) continue
    if (rule.when === "repeat_client" && !ctx.repeatClient) continue
    if (rule.when === "seller_side" && (ctx.metadata as { side?: unknown } | null | undefined)?.side !== "seller") continue
    const ref = referenceFor(rule, ctx)
    let once: OnceKey
    switch (rule.scope) {
      case "first_ever":             once = {}; break
      case "per_year":               once = { since: yearStart }; break
      case "per_reference":          if (!ref) continue; once = { referenceId: ref }; break
      case "per_reference_per_year": if (!ref) continue; once = { referenceId: ref, since: yearStart }; break
    }
    plans.push({ reason: rule.reason, points: POINT_VALUES[rule.reason], referenceType: rule.referenceType, once, party: rule.party })
  }
  return plans
}

// ─── THE DATABASE-TOUCHING HALF lives in lib/gamification/lifecycle-awards.ts ──
// (agent resolution, the reactor hook, the badge writer). It is kept OUT of this file
// on purpose: app/dashboard/motivation/motivation-client.tsx (a Client Component)
// imports POINT_VALUES from here, and the badge writer lazy-imports @/lib/kernel/emit,
// a `server-only` graph — one such edge into a client bundle breaks the build
// (wave 102.1 lesson 4). This file stays importable from either side.
