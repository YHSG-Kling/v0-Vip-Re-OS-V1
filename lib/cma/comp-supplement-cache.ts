/**
 * CMA COMP SUPPLEMENT CACHE — per-subject-address, per-day cache for the
 * sold-comp SUPPLEMENT pull in lib/cma/comp-provider.ts.
 *
 * WAVE 92 (lane 92B) — two changes, the table unchanged (m645, live):
 *   1. The supplement is now RentCast's WIDENED comparable pull (owner: "use rentcast as much
 *      as possible regarding … comparable"; "batchdata is to be used more for scrapping
 *      leads"), so the payload carries RentcastComp rows tagged `via: "rentcast"`. A same-day
 *      row written by the retired BatchData supplement (`via: "mcp" | "rest"`) is NOT a hit.
 *   2. THE PROVIDER-PAYLOAD STORE (getCachedProviderPayload / setCachedProviderPayload) — the
 *      same table, a namespaced `address_key` (e.g. "rentcast:/properties|12 main st austin tx")
 *      and a caller-chosen age window instead of "today only". lib/property/rentcast.ts reads
 *      its property FACTS (record, AVM, market stats) through it ("be careful of the
 *      limitations": a repeat read inside the window costs no RentCast request). One table,
 *      one best-effort contract, no second cache spelling (§6). The table NAME is historical
 *      (it began as the CMA supplement's cache); renaming it is a migration with no payoff.
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
import type { RentcastComp } from "@/lib/property/rentcast-normalize"

// TOMBSTONE (wave 92, lane 92B, §1.3): the payload typed `BatchDataComp[]` with `via: "mcp" |
// "rest"` (the BatchData comps dataset supplement) is retired with that pull — survivor: the
// RentCast widened supplement at lib/cma/comp-provider.ts §3b, cached below as RentcastComp rows.
export interface CachedCompSupplementPayload {
  comps: RentcastComp[]
  via: "rentcast"
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
    // Wave 92: a row from the retired BatchData supplement (via mcp/rest) is not this payload.
    const payload = data.payload as Partial<CachedCompSupplementPayload> | null
    if (!payload || payload.via !== "rentcast" || !Array.isArray(payload.comps)) return { hit: false, payload: null, costCents: 0 }
    return { hit: true, payload: payload as CachedCompSupplementPayload, costCents: Number(data.cost_cents ?? 0) }
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

// ─── THE PROVIDER-PAYLOAD STORE (wave 92, lane 92B) ─────────────────────────

/**
 * The newest cached provider payload for a NAMESPACED key, no older than `maxAgeDays` — null on
 * a miss AND on a refused read (logged): the caller's only correct response to either is to make
 * the request. Day granularity (the table's `fetched_on` is a date), so a 7-day window admits the
 * rows written on the last 7 calendar days plus today.
 */
export async function getCachedProviderPayload<T>(namespacedKey: string, maxAgeDays: number): Promise<T | null> {
  const key = namespacedKey.trim()
  if (!key || !(maxAgeDays > 0)) return null
  try {
    const supabase = createServiceClient()
    const since = new Date(Date.now() - Math.floor(maxAgeDays) * 86_400_000).toISOString().slice(0, 10)
    const { data, error } = await supabase
      .from("cma_comp_supplement_cache")
      .select("payload, fetched_on")
      .eq("address_key", key)
      .gte("fetched_on", since)
      .order("fetched_on", { ascending: false })
      .limit(1)
    if (error) {
      console.error("[provider-payload-cache] read refused:", error.message)
      return null
    }
    const row = (data ?? [])[0] as { payload?: unknown } | undefined
    return row && row.payload != null ? (row.payload as T) : null
  } catch (e) {
    console.error("[provider-payload-cache] read threw:", e instanceof Error ? e.message : String(e))
    return null
  }
}

/** Store today's provider payload under a NAMESPACED key (upsert on key + day). Best-effort: a
 *  refused write is logged and the next read inside the window simply pays again. */
export async function setCachedProviderPayload(namespacedKey: string, payload: unknown, costCents: number): Promise<void> {
  const key = namespacedKey.trim()
  if (!key || payload == null) return
  try {
    const supabase = createServiceClient()
    const { error } = await supabase
      .from("cma_comp_supplement_cache")
      .upsert(
        { address_key: key, fetched_on: todayIsoDate(), payload, cost_cents: Math.round(costCents) },
        { onConflict: "address_key,fetched_on" },
      )
    if (error) console.error("[provider-payload-cache] write refused:", error.message)
  } catch (e) {
    console.error("[provider-payload-cache] write threw:", e instanceof Error ? e.message : String(e))
  }
}
