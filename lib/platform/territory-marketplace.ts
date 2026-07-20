// lib/platform/territory-marketplace.ts
// ─── THE TERRITORY MARKETPLACE (owner round 40, rec 4) ───────────────────────
//
// The ANONYMIZED public read behind the /pricing "Territory availability"
// section: prospects see REAL unclaimed-territory lead volume ("37 leads
// surfaced in 78704 in the last 30 days — unclaimed") with zero tenant data.
//
// KEEP-ONE: all counting is the round-39 coverage board
// (lib/analytics/territory-coverage.ts → loadCoverageBoard / composeCoverageBoard
// — the same bounded window reads and the same active-tenant claim predicate the
// scrape resolver enforces). This module NEVER queries leads / raw_scraped_leads /
// subscriber_service_areas itself; it only projects the board down to a public,
// anonymized shape.
//
// ANONYMIZATION CONTRACT (the simulator locks every clause):
//   • The public shape is EXACTLY { zip, city, state, leadCount, periodLabel } —
//     never tenant ids, never tenant names, never lead PII.
//   • Only UNCLAIMED zips (no active-subscription claim) ever carry a number.
//     A claimed zip answers "this territory is served" with NO volume — a
//     claimed zip's volume is the subscriber's business, full stop.
//   • leadCount is PLATFORM-ORIGIN lead volume (ZipCoverageRow.platformLeadCount)
//     — leads the platform itself surfaced, i.e. exactly what a new subscriber
//     could claim. Tenant-sourced volume in an unclaimed zip is never shown
//     either (it belongs to whoever imported it).
//   • FLOOR RULE: a zip appears only with ≥ MARKETPLACE_MIN_LEADS leads in the
//     window; when the coverage board hit a read cap, counts are floors and
//     countsAreFloors says so ("at least N" copy — never a fabricated total).
//
// THREE HONEST PUBLIC STATES for a searched zip:
//   1. "available" — unclaimed, ≥ threshold platform leads → show the number.
//   2. "served"    — an active subscriber claims it → NO numbers, no names.
//   3. "no_volume" — unclaimed but below threshold / nothing recorded → say so.
// (Plus an "invalid" input guard for non-5-digit input — a form state, not a
// data state.)
//
// CACHE POSTURE: /pricing is force-dynamic (the ?ref bounce + ?zip search need
// per-request rendering), so page-level ISR is off the table. unstable_cache
// was considered and rejected: this module is also driven by a tsx simulator
// outside the Next runtime. Instead the loader memoizes the composed snapshot
// in-module for MARKETPLACE_CACHE_SECONDS per server instance — the page stays
// honestly dynamic while the four bounded coverage reads run at most once per
// TTL per instance. Errors are never memoized.

import {
  loadCoverageBoard,
  type CoverageBoard,
  type ZipCoverageRow,
} from "@/lib/analytics/territory-coverage"

// ─── Declared constants (named in the labels — never implied) ────────────────

/** A zip must have at least this many platform leads in the window to be shown. */
export const MARKETPLACE_MIN_LEADS = 5
/** Top-N unclaimed zips shown as the /pricing teaser rows. */
export const MARKETPLACE_TEASER_LIMIT = 6
/** Per-instance memo TTL for the public snapshot (seconds). */
export const MARKETPLACE_CACHE_SECONDS = 300

const FIVE_DIGIT_ZIP = /^\d{5}$/
const UNKNOWN_STATE = "—" // the coverage board's "state unknown" sentinel

/** Normalize a carried/searched zip: exactly 5 digits or null. Shared by the
 *  /pricing search, the /signup?zip= carry and the onboarding prefill. */
export function cleanCarriedZip(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim()
  return FIVE_DIGIT_ZIP.test(t) ? t : null
}

// ─── The public shape — the ENTIRE anonymization surface ─────────────────────
// Nothing else about a territory ever crosses to a public page.

export interface MarketplaceZip {
  zip: string
  city: string | null
  state: string | null
  /** Platform-origin leads in this UNCLAIMED zip inside the window. */
  leadCount: number
  /** e.g. "the last 30 days" — window named, never implied. */
  periodLabel: string
}

export type ZipAvailability =
  | { state: "available"; zip: MarketplaceZip; countsAreFloors: boolean }
  | { state: "served"; zip: string }
  | { state: "no_volume"; zip: string; periodLabel: string }
  | { state: "invalid"; input: string }

export interface MarketplaceSnapshot {
  /** All unclaimed ≥-threshold zips, sorted by volume desc (already anonymized). */
  available: MarketplaceZip[]
  /** Top MARKETPLACE_TEASER_LIMIT of `available` — the /pricing teaser rows. */
  teaser: MarketplaceZip[]
  /** Zip strings (ONLY) of actively-claimed territories — powers the "served"
   *  answer server-side. Never who claims them, never their volume. */
  servedZips: string[]
  windowDays: number
  periodLabel: string
  /** True when a coverage read cap was hit — every count is then a floor. */
  countsAreFloors: boolean
  generatedAt: string
}

// ─── PURE: project the coverage board down to the anonymized snapshot ────────

export function composeMarketplaceSnapshot(board: CoverageBoard): MarketplaceSnapshot {
  const periodLabel = `the last ${board.windowDays} days`

  const toPublic = (z: ZipCoverageRow): MarketplaceZip => ({
    zip: z.zip,
    city: z.city ?? null,
    state: z.state === UNKNOWN_STATE ? null : z.state,
    leadCount: z.platformLeadCount,
    periodLabel,
  })

  const available = board.zips
    .filter(
      (z) =>
        FIVE_DIGIT_ZIP.test(z.zip) &&           // never the "(zip unknown)" bucket
        z.claimedBy.length === 0 &&              // UNCLAIMED only — the active-tenant predicate already ran in the board
        z.platformLeadCount >= MARKETPLACE_MIN_LEADS, // the floor rule
    )
    .map(toPublic)
    // Sort on the PUBLIC count (platform-origin volume) — highest first.
    .sort((a, b) => b.leadCount - a.leadCount || a.zip.localeCompare(b.zip))

  const servedZips = board.zips
    .filter((z) => FIVE_DIGIT_ZIP.test(z.zip) && z.claimedBy.length > 0)
    .map((z) => z.zip)
    .sort()

  return {
    available,
    teaser: available.slice(0, MARKETPLACE_TEASER_LIMIT),
    servedZips,
    windowDays: board.windowDays,
    periodLabel,
    countsAreFloors: board.capped === true,
    generatedAt: board.generatedAt,
  }
}

// ─── PURE: the three honest states for one searched zip ──────────────────────

export function lookupZipAvailability(snapshot: MarketplaceSnapshot, rawZip: string): ZipAvailability {
  const zip = cleanCarriedZip(rawZip)
  if (!zip) return { state: "invalid", input: (rawZip ?? "").trim().slice(0, 20) }
  if (snapshot.servedZips.includes(zip)) return { state: "served", zip }
  const hit = snapshot.available.find((z) => z.zip === zip)
  if (hit) return { state: "available", zip: hit, countsAreFloors: snapshot.countsAreFloors }
  // Unclaimed but below threshold OR simply never seen — both are honestly
  // "no recorded volume yet" (sub-threshold counts are never leaked).
  return { state: "no_volume", zip, periodLabel: snapshot.periodLabel }
}

// ─── IO: the cached public loader (keep-one with the coverage board) ─────────

type AnyClient = { from: (table: string) => any }

let memo: { at: number; snapshot: MarketplaceSnapshot } | null = null

/** The public marketplace snapshot. Failures degrade to an honest null + why —
 *  the pricing section then renders nothing rather than fabricated volume. */
export async function loadTerritoryMarketplace(
  supabase: AnyClient,
  opts?: { skipMemo?: boolean },
): Promise<{ snapshot: MarketplaceSnapshot | null; error: string | null }> {
  if (!opts?.skipMemo && memo && Date.now() - memo.at < MARKETPLACE_CACHE_SECONDS * 1000) {
    return { snapshot: memo.snapshot, error: null }
  }
  const { board, error } = await loadCoverageBoard(supabase)
  if (!board) return { snapshot: null, error: error ?? "coverage board unavailable" }
  const snapshot = composeMarketplaceSnapshot(board)
  memo = { at: Date.now(), snapshot }
  return { snapshot, error: null }
}

// ─── ONBOARDING PREFILL: read the zip carried from /pricing → /signup ────────
// signupBrokerageAction stores the searched zip (best-effort) under
// brokerages.billing_metadata.signup_intent.territory_zip — the same jsonb
// carry-bag the funnel coupon uses (merge-never-replace). The market-setup UI
// reads it back as a SUGGESTION only; a market is never auto-created.

export async function loadCarriedTerritoryZip(
  supabase: AnyClient,
  brokerageId: string,
): Promise<string | null> {
  try {
    const { data } = await supabase
      .from("brokerages")
      .select("billing_metadata")
      .eq("id", brokerageId)
      .maybeSingle()
    const intent = (data as any)?.billing_metadata?.signup_intent
    return cleanCarriedZip(intent?.territory_zip)
  } catch {
    return null
  }
}
