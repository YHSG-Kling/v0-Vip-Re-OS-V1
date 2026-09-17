/**
 * CMA COMP SUPPLEMENT CACHE — per-subject-address, per-day cache for the
 * BatchData sold-comp SUPPLEMENT pull in lib/cma/comp-provider.ts.
 *
 * Owner ruling (wave 70, verbatim): "…need to best output for property
 * appraisal adjusted comps without high costs." The BatchData comps dataset
 * pull only runs when RentCast's sold set is short of the required mix (see
 * comp-provider.ts §3b), which already bounds it to the minority case — this
 * cache bounds it further: the SAME subject address run twice in one day (a
 * re-generated CMA, a second agent pulling the same listing, a retry after a
 * transient failure) hits the SAME BatchData row instead of paying for it
 * twice. `cma_` table check (CLAUDE.md §1, orphan doctrine — no duplicate found
 * first): scripts/schema-snapshot.ts's `cma_*` tables are cma_comparables,
 * cma_packages, cma_price_adjustments, cma_reports — none of them cache a raw
 * provider payload keyed by address+day, so this is a BUILD, not a merge.
 *
 * `supabase/migrations/m645-cma-comp-supplement-cache.sql` — WRITTEN, awaiting
 * the integrator's apply.
 *
 * Best-effort by construction: a cache read or write failure degrades to "run
 * the real pull" / "the write is lost, the next same-day call pays again" —
 * NEVER to a blocked CMA. This is telemetry/cost-control, not a source of truth.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import type { BatchDataComp } from "@/lib/external/batchdata-client"

export interface CachedCompSupplementPayload {
  comps: BatchDataComp[]
  via: "mcp" | "rest"
}

/** Same normalization convention as comp-provider.ts's own `normalizeAddress` —
 *  loose, deliberately not a parser (a missed match costs a duplicate paid
 *  pull, which is the safe direction to fail in). */
function addressKeyOf(address: string): string {
  return address
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Look up today's cached BatchData comp supplement for this address.
 * `hit: false` covers BOTH "nothing cached" and "the read was refused" — the
 * caller's only correct response to either is to fall through to the real
 * pull, so the two are not distinguished here (the read error IS logged).
 */
export async function getCachedCompSupplement(
  subjectAddress: string,
): Promise<{ hit: boolean; payload: CachedCompSupplementPayload | null; costCents: number }> {
  const key = addressKeyOf(subjectAddress)
  if (!key) return { hit: false, payload: null, costCents: 0 }
  try {
    const supabase = createServiceClient()
    const { data, error } = await supabase
      .from("cma_comp_supplement_cache")
      .select("payload, cost_cents")
      .eq("address_key", key)
      .eq("fetched_on", todayIsoDate())
      .maybeSingle()
    if (error) {
      console.error("[cma-comp-supplement-cache] read refused:", error.message)
      return { hit: false, payload: null, costCents: 0 }
    }
    if (!data) return { hit: false, payload: null, costCents: 0 }
    // cost_cents is what the ORIGINAL pull this row represents cost — surfaced so a
    // cache hit can report the platform spend it AVOIDED (the reader of that column).
    return { hit: true, payload: data.payload as CachedCompSupplementPayload, costCents: Number(data.cost_cents ?? 0) }
  } catch (e) {
    console.error("[cma-comp-supplement-cache] read threw:", e instanceof Error ? e.message : String(e))
    return { hit: false, payload: null, costCents: 0 }
  }
}

/**
 * Record today's BatchData comp supplement pull for this address so a repeat
 * call THE SAME DAY skips the billed pull. Cached even when the pull returned
 * zero rows — a confirmed-empty result is exactly as expensive to re-fetch as
 * a populated one, and re-billing to re-learn "still nothing" is the failure
 * this cache exists to prevent.
 *
 * `cost_cents` is the cost of the pull THIS ROW REPRESENTS (for audit — what
 * was actually paid to populate this day's cache), never re-charged on a hit.
 */
export async function setCachedCompSupplement(
  subjectAddress: string,
  payload: CachedCompSupplementPayload,
  costCents: number,
): Promise<void> {
  const key = addressKeyOf(subjectAddress)
  if (!key) return
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from("cma_comp_supplement_cache")
      .upsert(
        { address_key: key, fetched_on: todayIsoDate(), payload, cost_cents: Math.round(costCents) },
        { onConflict: "address_key,fetched_on" },
      )
    if (error) console.error("[cma-comp-supplement-cache] write refused:", error.message)
  } catch (e) {
    console.error("[cma-comp-supplement-cache] write threw:", e instanceof Error ? e.message : String(e))
  }
}
