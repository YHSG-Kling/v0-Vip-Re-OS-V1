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
// Pure data (type-only import back into this module — no runtime cycle).
import { AWARD_CENSUS } from "./award-census"

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
  /** Wave 106 (106D): a competency score ROSE on evidence (the adaptive development loop's update
   *  step). The improvement earns it — a completed module earns nothing here by design. */
  COMPETENCY_IMPROVED: 50,
  /** WAVE 154 (154E): a CLIENT-authored review / testimonial (REVIEW_RECEIVED). 25 is not new: it is what the retired
   *  `review_received` action key paid (it mapped onto VENDOR_REVIEW_WRITTEN, 25). That key fired when an AI review-REQUEST
   *  draft was generated, not when a client reviewed — the value moves onto the real moment. Owner may re-price. */
  CLIENT_REVIEW_RECEIVED: 25,
} as const

export type PointReason = keyof typeof POINT_VALUES

/**
 * Every earning action a surface could name, with its label. The list a surface may ADVERTISE is POINT_EARNING_ACTIONS
 * below — derived from this by "a live award rule exists" — because advertising points nothing awards is the same lie as
 * advertising the wrong number (see POINT_VALUES).
 */
const EARNING_ACTION_LABELS: ReadonlyArray<{ reason: PointReason; label: string }> = [
  { reason: "LISTING_CLOSED", label: "Close a deal" },
  { reason: "FIRST_CLOSE", label: "Your first closing (one time)" },
  { reason: "REPEAT_CLIENT_CLOSED", label: "Close again with a past client" },
  // WAVE 154 (154E): "Send a referral" is no longer offered — entering a referral is self-attested (any number of
  // records). The referral now earns when it CLOSES, evidenced by the closed transaction.
  { reason: "REFERRAL_CONVERTED", label: "A referral closes" },
  { reason: "SHOWING_COMPLETED", label: "Complete a showing" },
  { reason: "OFFER_SUBMITTED", label: "Submit an offer" },
  { reason: "SOCIAL_POST_PUBLISHED", label: "Publish an approved social post" },
  { reason: "CLIENT_REVIEW_RECEIVED", label: "A client leaves you a review" },
  { reason: "CERTIFICATION_EARNED", label: "Earn a certification" },
  { reason: "CE_COMPLETED", label: "Complete accredited CE" },
  { reason: "COMPETENCY_IMPROVED", label: "Improve a measured skill" },
  { reason: "MENTOR_SESSION_HELD", label: "Hold a mentor session (weekly)" },
  { reason: "LIFETIME_TOUCHPOINT_KEPT", label: "Keep a past-client touch" },
  { reason: "OPEN_HOUSE_HOSTED", label: "Host an open house" },
  { reason: "TRAINING_COMPLETED", label: "Complete a training" },
  { reason: "VENDOR_REVIEW_WRITTEN", label: "Review a vendor" },
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
// WAVE 154 (154E): the once-check now runs INSIDE the database under an advisory lock
// (public.award_agent_points_once, m968) — concurrent twins serialize. The text below is the
// pre-m968 fallback's blind spot, kept because the fallback still runs until m968 is applied:
// the once-check is read-then-write, not a constraint. Two
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

/** PostgREST's "no such function" (the RPC is not on this database yet). @proofSeam */
export function isMissingFunction(err: { message: string; code?: string } | null | undefined): boolean {
  if (!err) return false
  return (err as { code?: string }).code === "PGRST202" || /could not find the function|function .* does not exist/i.test(err.message)
}

const UUID_RE =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
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

  // WAVE 154 (154E) — THE RACE CLOSED AT THE DATABASE. public.award_agent_points_once() (m968) takes a transaction-scoped
  // advisory lock on (agent, reason, reference), re-reads the ledger under it and only then calls award_agent_points():
  // two concurrent workers / a repeated webhook serialize on the lock and the second sees the first's row. Until m968 is
  // applied the function is absent (PGRST202) and the read-then-write below remains the fallback — said aloud, not silent.
  const points = Math.trunc(Number(input.points))
  if (!Number.isFinite(points) || points === 0) {
    return { ok: false, error: `awardAgentPointsOnce: ${String(input.points)} is not a whole number of points` }
  }
  const { data: onceData, error: onceErr } = await db.rpc("award_agent_points_once", {
    p_agent_id: input.agentId,
    p_points: points,
    p_reason: input.reason,
    p_reference_type: input.referenceType ?? null,
    p_reference_id: ref,
    p_since: input.once.since ? input.once.since.toISOString() : null,
  })
  if (!onceErr) {
    const row = onceData as { already_awarded?: boolean; brokerage_id?: string; points_added?: number; new_total?: number; log_id?: string } | null
    if (row?.already_awarded) return { ok: true, alreadyAwarded: true }
    if (!row?.brokerage_id || row.new_total == null) return { ok: false, error: "award_agent_points_once returned no row — the award did not land" }
    return { ok: true, brokerageId: row.brokerage_id, pointsAdded: Number(row.points_added ?? points), newTotal: Number(row.new_total), logId: String(row.log_id ?? "") }
  }
  if (!isMissingFunction(onceErr)) return { ok: false, error: `award_agent_points_once refused, award withheld (fail closed): ${onceErr.message}` }
  console.warn("[awardAgentPointsOnce] award_agent_points_once is not on this database yet (m968 unapplied) — read-then-write fallback, concurrent twins may both land")

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
  | "per_reference_per_week" // once per entity per ISO week, Monday 00:00 UTC (a mentor pairing's session)

export interface LifecycleAwardRule {
  event: KernelEvent
  reason: PointReason
  scope: MilestoneScope
  /** Who earns it. `acting` = the agent the event resolves to; `mentor_and_mentee` = both parties on a session;
   *  `referral_agent` = the agent on each WON referral the closed transaction evidences (wave 154). */
  party: "acting" | "mentor_and_mentee" | "referral_agent"
  /** Extra predicate on the resolved context (e.g. the contact was closed with before). */
  when?: "repeat_client" | "seller_side" | "positive_review" | "referral_closed_deal"
  /** Where the idempotency reference comes from; default = the event's entityId. `evidence.transaction` = the closed
   *  transaction the server found evidencing a referral (never a client-supplied id). */
  referenceFrom?: "entity" | "metadata.stepId" | "metadata.referral_id" | "metadata.contact_id" | "metadata.relationship_id" | "evidence.transaction"
  referenceType: string
  /** WAVE 153 (lane 153I): the emitter's entity the rule is keyed on. Another emitter of the SAME event with a different
   *  entity never earns (app/actions/ai-content-generation.tsx emits SOCIAL_POST_PUBLISHED for a generated DRAFT,
   *  entityType 'ai_generated_content' — only the publisher's 'social_post' is a published post). */
  entityType?: string
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
  // WAVE 154 (154E): keyed on the PAIRING per ISO week, not per session row. logMentorSession inserted a new row per call,
  // so "once per session" was once per click — 75 to each party, unbounded. The pairing is the system-matched
  // agent_mentor_relationships row the emitter now requires (metadata.relationship_id, server-derived).
  { event: KernelEvent.MENTOR_SESSION_HELD, reason: "MENTOR_SESSION_HELD", scope: "per_reference_per_week", party: "mentor_and_mentee", referenceFrom: "metadata.relationship_id", referenceType: "mentor_relationship" },
  { event: KernelEvent.AGENT_WORK_ANNIVERSARY, reason: "WORK_ANNIVERSARY", scope: "per_year", party: "acting", referenceType: "agent" },
  // Wave 106 (106D): the development loop's competency update — once per competency node per year
  // (the entity is the deterministic competency uuid; metadata.agent_id names the earner), so a
  // score that oscillates across the bar cannot farm the award.
  { event: KernelEvent.COMPETENCY_IMPROVED, reason: "COMPETENCY_IMPROVED", scope: "per_reference_per_year", party: "acting", referenceType: "competency" },
  // ── customer lifecycle — "knows the client for life" earns the agent recognition ──
  // Wave 104 (lane 104E): the kept touch rides the TOUCH itself — LIFETIME_CUSTOMER_TOUCHPOINT_SENT, emitted
  // ONCE by lib/sphere/lifetime-touchpoint-ledger.ts (metadata.agent_id = the agent who kept it) — no longer
  // ANNIVERSARY_TRIGGERED, a calendar date the system fired whether or not anyone touched the client.
  { event: KernelEvent.LIFETIME_CUSTOMER_TOUCHPOINT_SENT, reason: "LIFETIME_TOUCHPOINT_KEPT", scope: "per_reference_per_year", party: "acting", referenceType: "contact" },
  // Wave 104 (lane 104E): the seller's lifetime transition now EMITS LIFETIME_CUSTOMER (metadata.side 'seller')
  // from lib/application/listing-lifecycle.ts handleSellerToLifetimeTransition, and the award moves here from
  // the call site. `when: "seller_side"` keeps the buyer-side LIFETIME_CUSTOMER (lifecycle-logger) out of it.
  { event: KernelEvent.LIFETIME_CUSTOMER, reason: "SELLER_LIFETIME_TRANSITION", scope: "per_reference", party: "acting", when: "seller_side", referenceType: "contact" },
  // TOMBSTONE (wave 154, lane 154E — CLAUDE.md §1): `{ event: REFERRAL_RECEIVED, reason: "REFERRAL_CREATED", per referral }`
  // stood here. REFERRAL_RECEIVED is emitted by createReferral (app/actions/referrals/referral-actions.ts), a public
  // "use server" door where the seat TYPES its own referral record — each new record paid 75, unbounded: the fabricated
  // achievement the retired addPoints was closed for. SURVIVOR: the two REFERRAL_CONVERTED rows below, which pay only
  // when a closed/funded transaction evidences the referral, once per transaction.
  { event: KernelEvent.REFERRAL_CONVERTED, reason: "REFERRAL_CONVERTED", scope: "per_reference", party: "acting", when: "referral_closed_deal", referenceFrom: "evidence.transaction", referenceType: "transaction" },
  // The deal closing AFTER the referral was marked won — the same award, the same once-key (the transaction id).
  { event: KernelEvent.TRANSACTION_CLOSED, reason: "REFERRAL_CONVERTED", scope: "per_reference", party: "referral_agent", referenceType: "transaction" },
  // WAVE 154 (154E): a review the CLIENT wrote (both emitters require isContactSelf). Keyed on the client per year, so a
  // client resubmitting a testimonial cannot farm it; a low rating earns nothing.
  { event: KernelEvent.REVIEW_RECEIVED, reason: "CLIENT_REVIEW_RECEIVED", scope: "per_reference_per_year", party: "acting", when: "positive_review", entityType: "agent_review", referenceFrom: "metadata.contact_id", referenceType: "contact" },
  { event: KernelEvent.TRANSACTION_CLOSED, reason: "REPEAT_CLIENT_CLOSED", scope: "per_reference", party: "acting", when: "repeat_client", referenceType: "transaction" },
  // ── WAVE 153 (lane 153I — owner ruling 17: "check that the gamification system works properly") ──
  // The last two client-fired awards (app/lib/gamification/award-on-action.ts, a PUBLIC "use server" door any signed-in
  // seat could call in a loop) move onto the moments that PROVE the outcome:
  //   · an offer: the buyer's lifecycle crossing into BUYER_OFFER_SUBMITTED (app/actions/buyer-offers.ts → lifecycle-logger
  //     → OFFER_SUBMITTED on entity buyer_lifecycle = the buyer contact). transitionLifecycle forwards no metadata, so the
  //     reference is the buyer contact: once per buyer, however often the stage is re-entered — never per click.
  //   · a social post: the publisher's SOCIAL_POST_PUBLISHED (app/api/cron/publish-social-posts, entity social_post), after
  //     approval and a real external post id — no longer the moment a post was merely SCHEDULED. Once per post.
  { event: KernelEvent.OFFER_SUBMITTED, reason: "OFFER_SUBMITTED", scope: "per_reference", party: "acting", entityType: "buyer_lifecycle", referenceType: "contact" },
  { event: KernelEvent.SOCIAL_POST_PUBLISHED, reason: "SOCIAL_POST_PUBLISHED", scope: "per_reference", party: "acting", entityType: "social_post", referenceType: "social_post" },
]

/**
 * The earning actions a surface may advertise, and the ONE place their point value comes from: only reasons a LIVE award
 * rule grants (LIFECYCLE_AWARD_RULES). Training, vendor reviews, open houses and follow-ups have no verified-outcome awarder
 * (wave 153, lane 153I census — a completed module earns nothing by design, wave 106; a vendor review has no emitter; an
 * open house is self-attested), so /dashboard/motivation no longer promises points for them.
 */
export const POINT_EARNING_ACTIONS: ReadonlyArray<{ reason: PointReason; label: string }> =
  // WAVE 154 (154E): a live rule is necessary but not sufficient — the census (lib/gamification/award-census.ts) must also
  // call the triggering moment a VERIFIED outcome. A booking (FIRST_APPOINTMENT) or a seat's own assertion is never offered.
  EARNING_ACTION_LABELS.filter((a) =>
    LIFECYCLE_AWARD_RULES.some((r) => r.reason === a.reason) &&
    AWARD_CENSUS.some((c) => c.reason === a.reason && c.path === "reactor" && c.trust === "verified_outcome"))

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
  /** The event's entity type — a rule keyed on one (LifecycleAwardRule.entityType) skips every other emitter. */
  entityType?: string | null
  /** REFERRAL_CONVERTED only (wave 154): the closed/funded transaction the SERVER found evidencing the referral. Absent =
   *  no evidence = no award. Never taken from the event payload. */
  referralEvidenceTransactionId?: string | null
}

function referenceFor(rule: LifecycleAwardRule, ctx: MilestoneContext): string | null {
  const meta = ctx.metadata ?? {}
  const raw =
    rule.referenceFrom === "metadata.stepId" ? meta.stepId :
    rule.referenceFrom === "metadata.referral_id" ? meta.referral_id :
    rule.referenceFrom === "metadata.contact_id" ? meta.contact_id :
    rule.referenceFrom === "metadata.relationship_id" ? meta.relationship_id :
    rule.referenceFrom === "evidence.transaction" ? ctx.referralEvidenceTransactionId :
    ctx.entityId
  return isUuid(raw) ? raw : null
}

/** Monday 00:00 UTC of the ISO week holding `now`. @proofSeam */
export function isoWeekStartUtc(now: Date): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
  return d
}

/** A review earns only when it is positive: a testimonial (no rating) or 4–5 stars. */
function isPositiveReview(meta: Record<string, unknown> | null | undefined): boolean {
  const r = (meta ?? {}).rating
  if (r === null || r === undefined) return true
  const n = Number(r)
  return Number.isFinite(n) && n >= 4
}

/** @proofSeam PURE — the proof asserts the rule table resolves to the right once-keys without a database. */
export function planLifecycleAwards(event: string, ctx: MilestoneContext): MilestonePlan[] {
  const yearStart = new Date(Date.UTC(ctx.now.getUTCFullYear(), 0, 1))
  const weekStart = isoWeekStartUtc(ctx.now)
  const plans: MilestonePlan[] = []
  for (const rule of LIFECYCLE_AWARD_RULES) {
    if (rule.event !== event) continue
    if (rule.entityType && ctx.entityType !== rule.entityType) continue
    if (rule.when === "repeat_client" && !ctx.repeatClient) continue
    if (rule.when === "seller_side" && (ctx.metadata as { side?: unknown } | null | undefined)?.side !== "seller") continue
    if (rule.when === "positive_review" && !isPositiveReview(ctx.metadata)) continue
    if (rule.when === "referral_closed_deal" && !isUuid(ctx.referralEvidenceTransactionId)) continue
    const ref = referenceFor(rule, ctx)
    let once: OnceKey
    switch (rule.scope) {
      case "first_ever":             once = {}; break
      case "per_year":               once = { since: yearStart }; break
      case "per_reference":          if (!ref) continue; once = { referenceId: ref }; break
      case "per_reference_per_year": if (!ref) continue; once = { referenceId: ref, since: yearStart }; break
      case "per_reference_per_week": if (!ref) continue; once = { referenceId: ref, since: weekStart }; break
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
