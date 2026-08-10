/**
 * lib/buyer-offer/expire-offers.ts
 *
 * The session-free core of offer expiry, plus the sweep an unattended caller
 * (cron) uses.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * `app/actions/buyer-offer/track-offer-lifecycle.ts:markOfferExpired` is the only
 * thing in the tree that can move an offer PENDING → EXPIRED, and it is a
 * `"use server"` export that requires a browser session (deliberately — a prior
 * wave closed the hole where anyone could kill any live offer by posting a uuid).
 * Its own docblock records the consequence:
 *
 *   "a scheduled job that needs to run this without a session should call it
 *    through a route handler holding a service credential, not by naming a user
 *    id over HTTP."
 *
 * Nothing ever did. So in practice **no offer on the platform has ever expired
 * on its own**: `offers.response_deadline` passes, the offer stays PENDING, and
 * every surface that gates on lifecycle state (`submitOffer`, `withdrawOffer`,
 * `recordSellerResponse`, `canBuyerSubmitOffer`, the buyer multi-offer banner)
 * keeps treating a dead offer as live. This module is that missing door: it takes
 * a service client and does the work, so the session-gated action and the cron
 * each get their own entrance to the SAME logic — no fake identity, and the
 * session gate is not weakened.
 *
 * NOT a `"use server"` file. Nothing here is an HTTP endpoint.
 */

import type { SupabaseClient } from "@supabase/supabase-js"

/**
 * The lifecycle activity vocabulary this machine derives state from — the same
 * `entity_type='offer'` + `entity_id=<offer id>` key that
 * `lib/buyer-offer/status-sync.ts` reads.
 */
const LIFECYCLE_ACTIVITY_TYPES = [
  "buyer.offer.draft.created",
  "buyer.offer.submitted",
  "buyer.offer.accepted",
  "buyer.offer.rejected",
  "buyer.offer.countered",
  "buyer.offer.expired",
  "buyer.offer.withdrawn",
] as const

const ACTIVITY_TO_STATE: Record<string, string> = {
  "buyer.offer.draft.created": "DRAFT",
  "buyer.offer.submitted": "PENDING",
  "buyer.offer.accepted": "ACCEPTED",
  "buyer.offer.rejected": "REJECTED",
  "buyer.offer.countered": "COUNTERED",
  "buyer.offer.expired": "EXPIRED",
  "buyer.offer.withdrawn": "WITHDRAWN",
}

export interface ExpireOfferInput {
  offerId: string
  /** MUST come from `offers.brokerage_id` — never from a caller. */
  brokerageId: string
  /** MUST come from `offers.response_deadline` — the reason recorded has to be the reason that happened. */
  responseDeadline: string | null
  /**
   * `activities.agent_id` FKs `agents(id)`. A session gives a `users.id` and the
   * two id spaces are disjoint, so the caller RESOLVES it and passes the result
   * (or null when there is no agent — an unattended sweep has no human actor).
   */
  actorAgentId: string | null
  /** Injectable for determinism in the sweep; defaults to now. */
  now?: Date
}

export type ExpireOfferResult =
  | { expired: true }
  | { expired: false; reason: string }

/**
 * Read the derived lifecycle state for one offer.
 *
 * Both the read and every downstream write destructure `error`: supabase-js
 * RESOLVES a refused query, so `const { data }` alone renders "refused" and
 * "no rows" identically — and here that would turn a refusal into
 * "offer not found", which the sweep would then skip silently forever.
 */
async function readCurrentState(
  svc: SupabaseClient,
  offerId: string,
): Promise<{ ok: true; state: string } | { ok: false; reason: string }> {
  const { data, error } = await svc
    .from("activities")
    .select("activity_type, created_at")
    .eq("entity_type", "offer")
    .eq("entity_id", offerId)
    .in("activity_type", LIFECYCLE_ACTIVITY_TYPES as unknown as string[])
    .order("created_at", { ascending: false })
    .limit(1)

  if (error) return { ok: false, reason: `Could not read offer lifecycle: ${error.message}` }
  const latest = (data ?? [])[0] as { activity_type: string } | undefined
  if (!latest) return { ok: false, reason: "Offer has no lifecycle events" }

  const state = ACTIVITY_TO_STATE[latest.activity_type]
  if (!state) return { ok: false, reason: `Unknown lifecycle event ${latest.activity_type}` }
  return { ok: true, state }
}

/**
 * Expire ONE offer. Refuses unless the deadline genuinely passed and the offer
 * is genuinely PENDING — both proven from stored data, never asserted.
 *
 * Writes the `buyer.offer.expired` activity AND syncs `offers.status`. The status
 * column is the operational index every UI actually reads
 * (`app/portal/[contactId]/offers`, `offers-manager-client`,
 * `approval-queue-aggregator`, `portal-seller`), and the activity alone is
 * invisible to all of them — an expiry that only wrote the activity would report
 * success while every screen still showed the offer as live.
 */
export async function expireOffer(
  svc: SupabaseClient,
  input: ExpireOfferInput,
): Promise<ExpireOfferResult> {
  const nowMs = (input.now ?? new Date()).getTime()

  if (!input.brokerageId) {
    // activities.brokerage_id is NOT NULL with no default — an omitted tenant
    // silently kills the write while the caller reports success.
    return { expired: false, reason: "Offer has no brokerage — cannot file the expiry event" }
  }
  if (!input.responseDeadline) {
    return { expired: false, reason: "This offer has no response deadline, so it cannot expire on one" }
  }
  const deadlineMs = new Date(input.responseDeadline).getTime()
  if (!Number.isFinite(deadlineMs)) {
    return { expired: false, reason: "This offer's response deadline is not a readable date" }
  }
  if (deadlineMs > nowMs) {
    return { expired: false, reason: "The response deadline has not passed yet" }
  }

  const state = await readCurrentState(svc, input.offerId)
  if (!state.ok) return { expired: false, reason: state.reason }
  if (state.state !== "PENDING") {
    return { expired: false, reason: `Only PENDING offers can expire (currently ${state.state})` }
  }

  const { error: activityError } = await svc.from("activities").insert({
    brokerage_id: input.brokerageId,
    agent_id: input.actorAgentId,
    activity_type: "buyer.offer.expired",
    title: "Offer expired",
    description: "Offer expired: deadline passed",
    notes: JSON.stringify({
      offer_id: input.offerId,
      previous_state: "PENDING",
      new_state: "EXPIRED",
      expiration_reason: "deadline_passed",
      response_deadline: input.responseDeadline,
    }),
    status: "completed",
    entity_type: "offer",
    entity_id: input.offerId,
  })

  if (activityError) {
    return { expired: false, reason: `Could not record the expiry event: ${activityError.message}` }
  }

  // `.select()` so the count is PROVEN, not intended. Live schema: offers.status
  // is free text (verified — no CHECK on `offers.status` in pg_constraint), and
  // 'expired' is the literal `lib/buyer-offer/status-sync.ts` maps this event to.
  const { data: updated, error: statusError } = await svc
    .from("offers")
    .update({ status: "expired" })
    .eq("id", input.offerId)
    .eq("brokerage_id", input.brokerageId)
    .select("id")

  if (statusError || !updated || updated.length === 0) {
    // The lifecycle event is filed but the operational index did not move. Say
    // so — reporting a clean expiry here is exactly the defect class where the
    // audit trail and the screens disagree.
    return {
      expired: false,
      reason: `Expiry event recorded but offers.status did not update: ${statusError?.message ?? "no row matched"}`,
    }
  }

  return { expired: true }
}

export interface SweepResult {
  scanned: number
  expired: number
  skipped: Array<{ offerId: string; reason: string }>
}

/**
 * Find every offer whose `response_deadline` has passed and expire it.
 *
 * Deliberately does NOT pre-filter on `offers.status` — the lifecycle authority
 * in this machine is the activities trail, and `offers.status` is an index that
 * can lag it. `expireOffer` re-derives PENDING from the trail and refuses
 * anything else, so a stale index cannot cause a wrong expiry in either
 * direction. Terminal statuses ARE excluded up front purely to keep the scan
 * small; they would be refused anyway.
 */
export async function sweepDueOfferExpirations(
  svc: SupabaseClient,
  opts: { now?: Date; limit?: number } = {},
): Promise<SweepResult> {
  const now = opts.now ?? new Date()
  const limit = opts.limit ?? 500

  const { data, error } = await svc
    .from("offers")
    .select("id, brokerage_id, response_deadline, agent_id, status")
    .not("response_deadline", "is", null)
    .lte("response_deadline", now.toISOString())
    // `.not("status","in",…)` alone would DROP rows with a NULL status, because
    // `NULL NOT IN (…)` is NULL, not true — and `offers.status` is nullable on
    // the live schema. A submitted offer whose index column was never stamped
    // would then never be swept. The explicit null branch keeps it in scope.
    .or("status.is.null,status.not.in.(expired,accepted,rejected,withdrawn,voided,closed)")
    .order("response_deadline", { ascending: true })
    .limit(limit)

  // Fail loud rather than reporting "0 due" on a refused read — pre-rollout an
  // empty table is expected, so "nothing came back" is not evidence of health.
  if (error) throw new Error(`Could not scan offers for expiry: ${error.message}`)

  const rows = (data ?? []) as Array<{
    id: string
    brokerage_id: string | null
    response_deadline: string | null
    agent_id: string | null
  }>

  const result: SweepResult = { scanned: rows.length, expired: 0, skipped: [] }

  for (const row of rows) {
    const outcome = await expireOffer(svc, {
      offerId: row.id,
      brokerageId: row.brokerage_id ?? "",
      responseDeadline: row.response_deadline,
      // `offers.agent_id` is already an agents.id, so it is carried through as
      // the actor rather than resolved from a user — the sweep has no human.
      actorAgentId: row.agent_id ?? null,
      now,
    })
    if (outcome.expired) result.expired += 1
    else result.skipped.push({ offerId: row.id, reason: outcome.reason })
  }

  return result
}
