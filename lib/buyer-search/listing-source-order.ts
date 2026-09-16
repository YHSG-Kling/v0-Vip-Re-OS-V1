/**
 * lib/buyer-search/listing-source-order.ts
 *
 * Wave 68 — THE ONE RESOLVER for a brokerage's active-listing source order (regular-buyer
 * smart search only; the investor off-market rail, lib/buyer-search/investor-offmarket-runner.ts,
 * is untouched by this setting).
 *
 * OWNER QUESTION (verbatim, 2026-09-16): "that is a lot of money to spend for leads, is the
 * rentcast with optional idx broker a better implementation for the smart search buyer criteria
 * of on the market active property listings?"
 *
 * RESEARCHED + DECIDED (docs/lead-acquisition-coverage-2026-09.md "Active-listing source ranking
 * for regular buyers"): RentCast bills per REQUEST (a page of listings per call, $8-$74/mo for a
 * 3-market/200-listing/day workload); IDX Broker costs the platform $0 (the brokerage's own MLS
 * credential); BatchData's on-market quicklist bills per RECORD and must re-walk every active
 * listing each cycle to detect status transitions — 20x-100x RentCast's cost for the same
 * workload. So the DEFAULT order is IDX -> RentCast, and the billed BatchData on-market pull is
 * OFF by default, opt-in per brokerage.
 *
 * m642 (WRITTEN, NOT APPLIED — the integrator applies it) adds
 * `brokerage_settings.active_listing_sources jsonb NOT NULL DEFAULT '["idx","rentcast"]'`, an
 * ORDERED list of `idx | rentcast | batchdata_on_market`. This is the ONE place that column is
 * read — every consumer (runMarketWatchForBuyer, runExternalMarketWatchForBuyer,
 * runActiveListingDiscoveryForMarket) calls this resolver rather than reading the column itself,
 * so a column rename or a new source stays a one-file change.
 *
 * FAIL CLOSED, THE RIGHT WAY FOR A COST SETTING: a read failure (network/RLS/missing row) returns
 * the DEFAULT — IDX then RentCast, BatchData on-market excluded — never the empty list and never
 * every source. An unreadable setting must not silently turn OFF a brokerage's smart search
 * (empty list) and must not silently turn ON a billed capability nobody opted into
 * (batchdata_on_market by default). The default is the one array that is safe on both counts.
 */
import { createServiceClient } from "@/lib/supabase/service"

export type ActiveListingSource = "idx" | "rentcast" | "batchdata_on_market"

const ALLOWED: ReadonlySet<ActiveListingSource> = new Set(["idx", "rentcast", "batchdata_on_market"])

/** The column's own DB default (m642) — kept as a literal here too so a read failure or a
 *  malformed/empty stored value degrades to EXACTLY what a fresh brokerage row already has,
 *  never a second, drifting "default". */
export const DEFAULT_ACTIVE_LISTING_SOURCES: readonly ActiveListingSource[] = ["idx", "rentcast"]

function isActiveListingSource(v: unknown): v is ActiveListingSource {
  return typeof v === "string" && ALLOWED.has(v as ActiveListingSource)
}

/**
 * PURE — normalizes whatever `brokerage_settings.active_listing_sources` actually holds: drops
 * unknown values, dedupes (first occurrence wins — order is the ranking), and falls back to the
 * default array whenever the result would otherwise be empty (a brokerage that malformed its own
 * setting into nothing still gets served, never silently cut off from smart search).
 */
export function normalizeActiveListingSources(raw: unknown): ActiveListingSource[] {
  if (!Array.isArray(raw)) return [...DEFAULT_ACTIVE_LISTING_SOURCES]
  const seen = new Set<ActiveListingSource>()
  const out: ActiveListingSource[] = []
  for (const v of raw) {
    if (isActiveListingSource(v) && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out.length > 0 ? out : [...DEFAULT_ACTIVE_LISTING_SOURCES]
}

/**
 * resolveActiveListingSources — read + normalize a brokerage's active-listing source order.
 * Service client (system-context callers: the market-watch cron, the BatchData discovery feed);
 * tenant comes from the CALLER-RESOLVED brokerageId (already session-derived by every caller in
 * this codebase's convention — this function does not itself sit behind a session, the same shape
 * as loadBuyerCriteria/resolveRentcastEligibility beside it).
 */
export async function resolveActiveListingSources(brokerageId: string): Promise<ActiveListingSource[]> {
  if (!brokerageId) return [...DEFAULT_ACTIVE_LISTING_SOURCES]
  try {
    const svc = createServiceClient()
    const { data, error } = await svc
      .from("brokerage_settings")
      .select("active_listing_sources")
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (error || !data) return [...DEFAULT_ACTIVE_LISTING_SOURCES]
    return normalizeActiveListingSources((data as { active_listing_sources: unknown }).active_listing_sources)
  } catch {
    return [...DEFAULT_ACTIVE_LISTING_SOURCES]
  }
}
