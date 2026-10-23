// lib/listings/mls-live-verification.ts
// ─────────────────────────────────────────────────────────────────────────────────────────────────
// IS THE LISTING ACTUALLY LIVE ON THE MLS — ASKED, RECORDED, AND ASKED AGAIN WITHOUT A HUMAN (wave 143, lane 143A).
//
// Owner ruling (wave 17, kept verbatim in lib/listings/mls-verification.ts): "the admin needs to add the actual
// listing that is in house manually to the mls or state mls but verification that it is actually live on the mls
// can be checked in rentcast or the tenants(subscriber) idxbroker." The PURE verdict exists
// (verifyMlsSyndication: confirmed | contradicted | pending | unverifiable). What was missing, found at the
// wave-143 audit:
//   · the verdict was computed on demand by ONE button (verifyMlsSyndicationAction) and then DISCARDED — nothing
//     persisted the confirmation, so `listings.go_live_confirmed_at` (a live column) had no writer, and no surface
//     could say "verified" without asking again;
//   · nothing asked unprompted, so a listing nobody opened the launch dialog for was never checked.
// This module is the shared core both doors call: the session action (app/actions/listings-kernel.ts) and the
// autonomous sweep (the proactive-intelligence cron, step 8b). On `confirmed` it records the ACTUAL live date
// through the ONE verified writer (lib/listings/mls-live-date.ts recordVerifiedMlsLive); on `contradicted` or an
// overdue `pending` it bells the listing agent; `unverifiable` (no feed connected) is recorded as such and never
// rendered as "not on the MLS" (the whole discipline of mls-verification.ts).
//
// COST: a RentCast for-sale search is a metered read. The sweep checks a listing at most once per
// SWEEP_RECHECK_HOURS (the last verdict rides `listings.metadata.mls_live_check`) and at most `limit` per run.
//
// NOT `server-only` (a guard drives it with injected feeds); the two vendor modules are imported inside.

import type { SupabaseClient } from "@supabase/supabase-js"
import {
  verifyMlsSyndication,
  type MlsFeedObservation,
  type MlsFeedSource,
  type MlsVerification,
} from "./mls-verification"
import { recordVerifiedMlsLive, bellListingAgent, type VerifiedLiveResult } from "./mls-live-date"

type Svc = SupabaseClient<any, any, any>

/** A listing is re-checked at most this often by the sweep (the metered feed read is the cost). */
const SWEEP_RECHECK_HOURS = 24

/** Street-line comparison key. Deliberately CONSERVATIVE: strips pure formatting and normalises the suffixes every
 *  feed spells differently; it does NOT guess at unit numbers or directionals — a near-match called "different" costs
 *  a `pending` verdict, a near-match called "same" could compare us against SOMEONE ELSE'S MLS number.
 *  (Moved here from app/actions/listings-kernel.ts so the action and the sweep share ONE matcher.) */
function normalizeStreet(raw: string | null | undefined): string | null {
  if (!raw) return null
  const first = raw.split(",")[0] ?? raw
  const s = first.toLowerCase().replace(/[.,#]/g, " ").replace(/\s+/g, " ").trim()
  if (!s) return null
  const SUFFIX: Record<string, string> = {
    street: "st", avenue: "ave", av: "ave", boulevard: "blvd", drive: "dr",
    road: "rd", lane: "ln", court: "ct", circle: "cir", place: "pl",
    terrace: "ter", parkway: "pkwy", highway: "hwy", trail: "trl", way: "way",
    north: "n", south: "s", east: "e", west: "w",
    northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
  }
  return s.split(" ").map((w) => SUFFIX[w] ?? w).join(" ")
}

export type MlsFeedsFn = (listing: { address: string | null; city: string | null; state: string | null; zip: string | null }) => Promise<FeedConsultation>

export interface FeedConsultation {
  observations: MlsFeedObservation[]
  /** Only feeds actually REACHED — a failed search is not an empty one. */
  consulted: MlsFeedSource[]
}

export interface VerifyListingContext {
  brokerageId: string
  /** users.id — the personal rung of the IDX connection cascade; null for the sweep (brokerage-level). */
  userId?: string | null
  /** teams.id — the TEAM rung. */
  teamId?: string | null
}

/** Ask the two feeds the brokerage already pays for. Never throws: an unreachable feed stays out of `consulted`. */
async function consultMlsFeeds(
  ctx: VerifyListingContext,
  listing: { address: string | null; city: string | null; state: string | null; zip: string | null },
): Promise<FeedConsultation> {
  const target = normalizeStreet(listing.address)
  const out: FeedConsultation = { observations: [], consulted: [] }
  if (!target) return out

  try {
    const { searchRentcastSaleListings } = await import("@/lib/property/rentcast")
    const rc = await searchRentcastSaleListings({
      brokerageId: ctx.brokerageId,
      filters: {
        zipCode: listing.zip ?? undefined,
        city: (listing.zip ? undefined : listing.city) ?? undefined,
        state: listing.state ?? undefined,
        limit: 50,
      },
    })
    // A FAILED search is NOT an empty search (a 401 must never become "your listing is not on the MLS").
    if (rc.success) {
      out.consulted.push("rentcast")
      for (const l of rc.listings) {
        if (normalizeStreet(l.address) !== target) continue
        out.observations.push({ source: "rentcast", mlsNumber: l.mlsNumber, mlsName: l.mlsName, address: l.address, status: l.status, listedDate: l.listedDate ?? null })
      }
    }
  } catch (err) {
    console.error("[mls-live-verification] RentCast consult failed (stays unconsulted):", (err as Error)?.message ?? err)
  }

  try {
    const { IDXBrokerClient } = await import("@/lib/idxbroker-client")
    const idx = await IDXBrokerClient.forBrokerage(ctx.brokerageId, { agentUserId: ctx.userId ?? undefined, teamId: ctx.teamId ?? undefined })
    if (idx.isConfigured()) {
      out.consulted.push("idx")
      const rows = await idx.searchActiveListings({ city: listing.city ?? undefined, state: listing.state ?? undefined, zipCode: listing.zip ?? undefined })
      for (const l of rows) {
        if (normalizeStreet(l.address) !== target) continue
        // searchActiveListings only returns ACTIVE rows (its contract), so say so rather than leave status null,
        // which isActiveOnFeed would — correctly — refuse to treat as live. IDX's featured feed carries no list date.
        out.observations.push({ source: "idx", mlsNumber: l.mlsNumber, mlsName: null, address: l.address, status: "active", listedDate: null })
      }
    }
  } catch {
    /* an unreachable IDX is not a finding about the listing; it stays out of `consulted` */
  }
  return out
}

export type VerifyAndRecordResult =
  | { ok: true; verification: MlsVerification; recorded: VerifiedLiveResult | null }
  | { ok: false; error: string }

/**
 * The ONE verification: read the listing (tenant-pinned), consult the feeds, reconcile, and on `confirmed` record
 * the actual live date. `feeds` is the seam a guard injects; production leaves it to consultMlsFeeds.
 */
export async function verifyAndRecordMlsLive(
  svc: Svc,
  ctx: VerifyListingContext & { actorUserId?: string | null },
  listingId: string,
  opts: { feeds?: MlsFeedsFn; now?: Date } = {},
): Promise<VerifyAndRecordResult> {
  const { data: listing, error } = await svc
    .from("listings")
    .select("id, address, city, state, zip, brokerage_id, mls_number, listing_date, updated_at, agent_id, metadata, go_live_confirmed_at")
    .eq("id", listingId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }
  if (!listing) return { ok: false, error: "Listing not found in your brokerage" }
  const row = listing as Record<string, any>
  if (!normalizeStreet(row.address)) return { ok: false, error: "This listing has no street address to match on" }

  const consult = opts.feeds ? await opts.feeds(row as any) : await consultMlsFeeds(ctx, row as any)
  const verification = verifyMlsSyndication(
    { storedMlsNumber: (row.mls_number as string | null) ?? null, liveSince: ((row.listing_date as string | null) ?? (row.updated_at as string | null)) ?? null },
    consult.observations,
    consult.consulted,
    opts.now,
  )

  let recorded: VerifiedLiveResult | null = null
  if (verification.verdict === "confirmed" && verification.evidence) {
    const source = verification.evidence.source
    recorded = await recordVerifiedMlsLive(svc, {
      brokerageId: ctx.brokerageId, listingId, source, feedListDate: verification.evidence.listedDate ?? null,
      actorUserId: ctx.actorUserId ?? null, now: opts.now,
    })
    if (!recorded.ok) console.error(`[mls-live-verification] listing ${listingId} confirmed by ${source} but the date was NOT recorded: ${recorded.reason}`)
  } else if (verification.needsAttention) {
    await bellListingAgent(svc, {
      brokerageId: ctx.brokerageId, listingId, agentId: (row.agent_id as string | null) ?? null,
      type: verification.verdict === "contradicted" ? "listing.mls_contradicted" : "listing.mls_not_syndicated",
      title: verification.verdict === "contradicted" ? "MLS number disagrees with the feed" : "Listing not showing on the MLS feed yet",
      body: verification.explanation,
    })
  }

  // The last check rides the listing (merged, never assigned — metadata carries other keys) so the sweep does not
  // pay for the same metered read twice a day, and a surface can say when we last looked.
  const meta = (row.metadata ?? {}) as Record<string, unknown>
  const { error: metaErr } = await svc
    .from("listings")
    .update({ metadata: { ...meta, mls_live_check: { checked_at: (opts.now ?? new Date()).toISOString(), verdict: verification.verdict, consulted: verification.consulted } } })
    .eq("id", listingId)
    .eq("brokerage_id", ctx.brokerageId)
    .select("id")
  if (metaErr) console.error(`[mls-live-verification] last-check stamp refused for listing ${listingId}: ${metaErr.message}`)
  return { ok: true, verification, recorded }
}

export interface MlsLiveSweepResult {
  scanned: number
  skippedRecent: number
  confirmed: number
  contradicted: number
  pending: number
  unverifiable: number
  errors: number
}

/** PURE: should the sweep spend a feed read on this listing now? */
function dueForMlsLiveCheck(metadata: unknown, now: Date = new Date(), hours: number = SWEEP_RECHECK_HOURS): boolean {
  const last = (metadata as { mls_live_check?: { checked_at?: string } } | null)?.mls_live_check?.checked_at
  if (!last) return true
  const t = Date.parse(last)
  return !Number.isFinite(t) || now.getTime() - t >= hours * 3_600_000
}

/**
 * THE AUTONOMOUS SWEEP — live listings with an MLS number that no feed has confirmed yet. Per brokerage, bounded.
 * "Live" is the status the OS asserts (`active`): the claim the feeds are asked to prove.
 */
export async function runMlsLiveVerificationSweep(
  svc: Svc,
  brokerageId: string,
  opts: { limit?: number; now?: Date; feeds?: MlsFeedsFn } = {},
): Promise<MlsLiveSweepResult> {
  const out: MlsLiveSweepResult = { scanned: 0, skippedRecent: 0, confirmed: 0, contradicted: 0, pending: 0, unverifiable: 0, errors: 0 }
  if (!brokerageId) return out
  const { data, error } = await svc
    .from("listings")
    .select("id, metadata")
    .eq("brokerage_id", brokerageId)
    .eq("status", "active")
    .not("mls_number", "is", null)
    .is("go_live_confirmed_at", null)
    .is("deleted_at", null)
    .order("updated_at", { ascending: true })
    .limit(opts.limit ?? 25)
  if (error) {
    console.error(`[mls-live-verification] sweep read refused (is m796 applied?): ${error.message}`)
    out.errors++
    return out
  }
  for (const l of (data ?? []) as Array<{ id: string; metadata: unknown }>) {
    if (!dueForMlsLiveCheck(l.metadata, opts.now)) { out.skippedRecent++; continue }
    out.scanned++
    const r = await verifyAndRecordMlsLive(svc, { brokerageId, userId: null, teamId: null, actorUserId: null }, l.id, { feeds: opts.feeds, now: opts.now })
    if (!r.ok) { out.errors++; continue }
    out[r.verification.verdict]++
  }
  return out
}
