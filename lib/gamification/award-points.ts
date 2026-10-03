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
