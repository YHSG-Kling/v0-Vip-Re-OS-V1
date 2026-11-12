/**
 * lib/marketing/listing-promo-catchup.ts
 *
 * THE CATCH-UP SWEEP for listing lifecycle promos.
 *
 * WHAT THIS REPLACES. lib/marketing/gbp-auto-posts.ts ran an hourly sweep that
 * found listings whose lifecycle_stage flipped to 'active' or status flipped to
 * 'closed' in the last 24h and posted a hand-written template to Google Business
 * Profile — one platform, its own copy, its own idempotency (a count query on
 * social_posts), outside the lifecycle-promo policy and outside the compliance
 * gate. Its own header flagged the overlap and deferred the collapse:
 *
 *     "FOLLOW-UP, deliberately NOT done here: gbpAutoPostsCronTick below
 *      overlaps that same lifecycle-promo path."
 *
 * That follow-up is this file. The canonical path — dispatchListingPromoVideo →
 * lifecycle_promo_policy (auto-spawn + cooldown) → compliance gate →
 * listing_promo_videos → /api/cron/listing-promo-social-publish — already
 * publishes `google_business` alongside seven other platforms. Keeping a second,
 * narrower poster meant a listing could be announced by bespoke copy that never
 * passed the compliance gate.
 *
 * WHY A SWEEP STILL EXISTS. The canonical path is EVENT-driven: thirteen call
 * sites dispatch at the moment a listing changes. A sweep catches what an event
 * misses — a bulk import, an MLS sync that writes the row without raising the
 * lifecycle event, a dispatch that failed at the time. That is the one genuinely
 * additional thing the GBP tick did, and it is what survives.
 *
 * Re-firing is safe by construction: listing_promo_videos carries
 * UNIQUE (listing_id, event_type), so a listing the event path already handled
 * comes back as `already_queued` rather than a second promo.
 *
 * THE PREDICATES ARE NOT THE ONES IT INHERITED. The GBP tick swept
 * `lifecycle_stage = 'active'` and `status = 'closed'`. Neither string exists in
 * this schema: listings.lifecycle_stage is an UPPER_SNAKE vocabulary
 * (…MLS_ACTIVE, UNDER_CONTRACT, CLOSED…) and listings.status admits
 * draft|coming_soon|active|pending|sold|expired|withdrawn — no 'closed'. Both
 * halves of that hourly sweep matched ZERO rows every run since it shipped,
 * checked live against production. The values below come from the live CHECK
 * constraints, and each event accepts either column so a bulk import that writes
 * only one of them is still caught.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { dispatchListingPromoVideo } from "@/lib/video/listing-promo-reactor"

const LOOKBACK_MS = 24 * 60 * 60 * 1000

export interface CatchupOutcome {
  listingId: string
  eventType: "just_listed" | "just_sold"
  status: string
  reason?: string
}

export interface CatchupResult {
  scanned: number
  dispatched: number
  alreadyHandled: number
  skipped: number
  failed: number
  results: CatchupOutcome[]
}

/**
 * PLATFORM-WIDE sweep — every brokerage, service client, no session. Reachable
 * only from the verifyCronAuth-gated cron route.
 *
 * Each listing carries its own brokerage_id and the promo is attributed to that
 * listing's own agent, so the fan-out stays inside the row's tenant even though
 * the SELECT deliberately spans tenants.
 */
export async function listingPromoCatchupCronTick(): Promise<CatchupResult> {
  const supabase = createServiceClient()
  const since = new Date(Date.now() - LOOKBACK_MS).toISOString()

  const [{ data: justListed }, { data: justSold }] = await Promise.all([
    supabase
      .from("listings")
      .select("id, brokerage_id, agent_id")
      .or("lifecycle_stage.eq.MLS_ACTIVE,status.eq.active")
      .gte("updated_at", since),
    supabase
      .from("listings")
      .select("id, brokerage_id, agent_id")
      .or("lifecycle_stage.eq.CLOSED,status.eq.sold")
      .gte("updated_at", since),
  ])

  // A listing that satisfies BOTH columns of an event appears once — the .or()
  // already de-duplicates within a query, but a row that somehow lands in both
  // event sets must still only be dispatched once per event type.
  const seen = new Set<string>()
  const work: Array<{ row: { id: string; brokerage_id: string | null; agent_id: string | null }; eventType: "just_listed" | "just_sold" }> = []
  for (const [rows, eventType] of [
    [justListed ?? [], "just_listed" as const],
    [justSold ?? [], "just_sold" as const],
  ] as const) {
    for (const row of rows as any[]) {
      const key = `${row.id}:${eventType}`
      if (seen.has(key)) continue
      seen.add(key)
      work.push({ row, eventType })
    }
  }

  const result: CatchupResult = {
    scanned: work.length,
    dispatched: 0,
    alreadyHandled: 0,
    skipped: 0,
    failed: 0,
    results: [],
  }

  for (const { row, eventType } of work) {
    if (!row.brokerage_id || !row.agent_id) {
      result.skipped++
      result.results.push({ listingId: row.id, eventType, status: "skipped", reason: "no brokerage or agent on the listing" })
      continue
    }

    // listings.agent_id is an agents.id; dispatchListingPromoVideo normalises the
    // id class itself (resolve-or-keep), so it is passed through as-is.
    const out = await dispatchListingPromoVideo({
      brokerageId: row.brokerage_id,
      listingId: row.id,
      agentUserId: row.agent_id,
      eventType,
    })

    if (out.status === "already_queued") result.alreadyHandled++
    else if (out.status === "skipped") result.skipped++
    else if (out.status === "failed") result.failed++
    else result.dispatched++

    result.results.push({ listingId: row.id, eventType, status: out.status, reason: out.reason })
  }

  return result
}
