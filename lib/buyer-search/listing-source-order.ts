/**
 * lib/buyer-search/listing-source-order.ts
 *
 * Wave 69 — THE ONE RESOLVER for a brokerage's active-listing source order (regular-buyer
 * smart search only; the investor off-market rail, lib/buyer-search/investor-offmarket-runner.ts,
 * is untouched by this resolver).
 *
 * OWNER RULING (verbatim, 2026-09-17): "rentcast is platform provided but idx is for tenant
 * connected if the tenant has this connection instead of rentcast option for for sale
 * properties. the setting page should only allow them to setup their idx connection."
 *
 * WAVE 68's DESIGN IS REPLACED HERE. Wave 68 gave the brokerage an ORDERED CHECKLIST that let
 * them re-order or exclude idx/rentcast — a tenant CHOICE persisted through
 * app/actions/settings/active-listing-sources.ts. That is not what the owner asked for:
 * IDX-vs-RentCast is not a preference, it is a FACT about whether the brokerage has connected
 * its own MLS feed. A brokerage cannot opt OUT of its own connected IDX feed (nothing would be
 * gained by paying RentCast to duplicate it), and a brokerage with no IDX feed cannot opt INTO
 * one that does not exist. So idx-vs-rentcast is now DERIVED, every call, from the SAME
 * IDX-credential cascade lib/property/rentcast-eligibility.ts::resolveRentcastEligibility
 * already proves correct (scripts/idx-tenant-credential-simulator.ts, test:idx-tenant-credential)
 * — never a second IDX-presence check, and never a tenant setting for it.
 *
 * TOMBSTONE — app/actions/settings/active-listing-sources.ts (the wave-68 tenant read/write seam
 * for the ordered checklist) is DELETED. Survivor: this resolver (idx/rentcast derivation, below)
 * for the read half, and app/actions/superadmin/active-listing-sources.ts::
 * setBrokerageActiveListingSourcesAction (requireSuperadmin-gated) for the one thing that IS
 * still a stored setting — the billed BatchData on-market opt-in. The tenant settings surface
 * (app/dashboard/settings/integrations/lead-sources) now shows ONLY the IDX connection form
 * (reused from app/dashboard/settings/integrations/idx-broker/page.tsx — never a second form) and
 * a read-only status line; no checklist, no tenant write path for this column at all.
 *
 * brokerage_settings.active_listing_sources (m642, applied live 2026-09-16; m643 narrows its
 * semantics and comment, no schema change) is now read for EXACTLY ONE purpose: has PLATFORM
 * STAFF opted this brokerage into the billed BatchData on-market pull? idx/rentcast values are
 * never read from this column any more — they are DERIVED below. Written ONLY by
 * app/actions/superadmin/active-listing-sources.ts::setBrokerageActiveListingSourcesAction.
 *
 * FAIL CLOSED: an unreadable IDX-credential check returns the safe default (RentCast only, no
 * BatchData) — never a guess that a tenant owns an IDX feed it cannot prove, and a read failure
 * on the platform column never silently opts a brokerage into a billed capability nobody enabled.
 */
import { createServiceClient } from "@/lib/supabase/service"
import { resolveRentcastEligibility } from "@/lib/property/rentcast-eligibility"

export type ActiveListingSource = "idx" | "rentcast" | "batchdata_on_market"

const ALLOWED: ReadonlySet<ActiveListingSource> = new Set(["idx", "rentcast", "batchdata_on_market"])

/**
 * The one safe fallback when the IDX-credential cascade cannot be read: serve RentCast (the
 * platform's own feed — never billed to a brokerage that may in fact own an IDX credential we
 * simply could not prove) and never guess "batchdata_on_market" on.
 */
export const DEFAULT_ACTIVE_LISTING_SOURCES: readonly ActiveListingSource[] = ["rentcast"]

function isActiveListingSource(v: unknown): v is ActiveListingSource {
  return typeof v === "string" && ALLOWED.has(v as ActiveListingSource)
}

/**
 * PURE — normalizes whatever `brokerage_settings.active_listing_sources` actually holds: drops
 * unknown values and dedupes.
 *
 * UNLIKE the wave-68 version, an empty or malformed result no longer falls back to a non-empty
 * default. This column now carries ONLY the platform-staff opt-in flag, and "nothing set" (no
 * "batchdata_on_market" entry) is the perfectly valid, and the DEFAULT (billed pull off), state —
 * there is no longer an "idx"/"rentcast" ranking to protect from going empty.
 */
export function normalizeActiveListingSources(raw: unknown): ActiveListingSource[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<ActiveListingSource>()
  const out: ActiveListingSource[] = []
  for (const v of raw) {
    if (isActiveListingSource(v) && !seen.has(v)) {
      seen.add(v)
      out.push(v)
    }
  }
  return out
}

/**
 * resolveActiveListingSources — a brokerage's active-listing source order for regular-buyer
 * smart search:
 *
 *   1. "idx" when the brokerage has its OWN IDX Broker credential connected — resolved through
 *      resolveRentcastEligibility, the SAME cascade IDXBrokerClient.forBrokerage uses, so this
 *      resolver and the client it gates can never disagree about "does this tenant have IDX".
 *      An UNREADABLE credential check fails closed to the DEFAULT (rentcast) rather than guess.
 *   2. else "rentcast" when RentCast itself is eligible to run (platform key present, brokerage
 *      not over its vendor budget).
 *   3. else nothing for this slot — an honest empty; callers (external-match.ts) refuse rather
 *      than spend a vendor that is not actually available.
 *   4. "batchdata_on_market" is appended ONLY when platform staff opted this brokerage in
 *      (the m642/m643 column) — never a tenant choice, never inferred.
 */
export async function resolveActiveListingSources(brokerageId: string): Promise<ActiveListingSource[]> {
  if (!brokerageId) return [...DEFAULT_ACTIVE_LISTING_SOURCES]

  let sources: ActiveListingSource[]
  try {
    const eligibility = await resolveRentcastEligibility({ brokerageId })
    if (eligibility.idx.status === "connected") {
      sources = ["idx"]
    } else if (eligibility.idx.status === "unreadable") {
      // Cannot prove either way — fail closed to the safe default rather than guess the
      // tenant owns (or lacks) an IDX feed.
      sources = [...DEFAULT_ACTIVE_LISTING_SOURCES]
    } else if (eligibility.eligible) {
      sources = ["rentcast"]
    } else {
      // No IDX, and RentCast is not actually available right now (no platform key, or the
      // brokerage is over its vendor budget) — an honest empty; callers refuse rather than spend.
      sources = []
    }
  } catch {
    sources = [...DEFAULT_ACTIVE_LISTING_SOURCES]
  }

  try {
    const svc = createServiceClient()
    const { data, error } = await svc
      .from("brokerage_settings")
      .select("active_listing_sources")
      .eq("brokerage_id", brokerageId)
      .maybeSingle()
    if (!error && data) {
      const platformSet = normalizeActiveListingSources(
        (data as { active_listing_sources?: unknown }).active_listing_sources,
      )
      if (platformSet.includes("batchdata_on_market")) sources = [...sources, "batchdata_on_market"]
    }
    // A read failure here never adds a billed capability nobody could confirm was opted in —
    // `sources` is left exactly as the idx/rentcast derivation above left it.
  } catch {
    // Same posture as the branch above: silent, and `sources` is unchanged.
  }

  return sources
}
