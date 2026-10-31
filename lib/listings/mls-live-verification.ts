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
import { resolveComingSoonWindow, todayInTimeZone } from "./compute-dom"
import {
  listingLifecycleFindings,
  statusForStage,
  STATUS_AFTER_LISTING_AGREEMENT_GATE,
  STATUS_AT_LISTING_AGREEMENT_SIGNED,
  type ListingLifecycleFinding,
  type ListingLifecycleFindingCode,
} from "./listing-status-sync"

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
  | { ok: true; verification: MlsVerification; recorded: VerifiedLiveResult | null; lifecycle?: ReconcileLifecycleResult }
  | { ok: false; error: string }

// ─── C12 — THE MLS-LIVE EVENT MAKES THE LISTING ACTIVE; DISCREPANCIES REACH THE LISTING CONCIERGE (wave 147, lane 147F) ──
//
// Owner, verbatim (2026-10-31): "coming soon start date is the day the listing agreement was executed and once the listing
// is live on mls, the listing becomes active not coming soon."
//
// BEFORE: the feeds were only ever asked about listings ALREADY claiming `active` (the sweep filtered status = 'active'), so
// a Coming Soon listing that the admin put live on the MLS stayed Coming Soon until somebody pressed a button. NOW the sweep
// also asks about listings still pre-active WITH an MLS number, and a feed CONFIRMATION (an event — never a date arriving)
// moves the listing to MLS_ACTIVE through the SAME activation gate every door runs (lib/listings/listing-activation-gate.ts
// assertListingActivationAllowed) and the kernel transition (status syncs to `active` through the shared map). A refused gate
// changes nothing and is told to the listing concierge with the gate's reason. Each discrepancy is published ONCE per open
// finding (signal `listing_lifecycle_finding`, data_steward → listing_concierge, lib/kernel/signal-registry.ts).

/** Statuses the feeds are asked about: the pre-active ones (did it go live?) and `active` (is the claim true?). */
const MLS_CHECKABLE_STATUSES: readonly string[] = [STATUS_AT_LISTING_AGREEMENT_SIGNED, STATUS_AFTER_LISTING_AGREEMENT_GATE, statusForStage("MLS_ACTIVE") ?? "active"]
const PRE_ACTIVE: readonly string[] = [STATUS_AT_LISTING_AGREEMENT_SIGNED, STATUS_AFTER_LISTING_AGREEMENT_GATE]
export const LISTING_LIFECYCLE_FINDING_SIGNAL = "listing_lifecycle_finding"

export interface ReconcileLifecycleDeps {
  gate?: (svc: Svc, p: { brokerageId: string; listingId: string; door: string }) => Promise<{ allowed: boolean; reason: string }>
  transition?: (p: { brokerageId: string; listingId: string; fromState: string; verifiedLive: string }, svc: Svc) => Promise<{ success: boolean; error?: string }>
  publish?: (p: { brokerageId: string; fromManager: "data_steward"; toManager: "listing_concierge"; signalType: string; message: string; entityType: string; entityId: string; payload: Record<string, unknown>; dedupe: false }, svc: Svc) => Promise<{ ok: boolean; reason?: string }>
  now?: Date
}
export type ReconcileLifecycleResult =
  | { ok: true; activated: boolean; activationRefusal: string | null; findings: ListingLifecycleFinding[]; published: ListingLifecycleFindingCode[] }
  | { ok: false; error: string }

/**
 * ONE listing's C12 reconciliation: Coming Soon window (start = the agreement's execution day), the MLS-live event → Active,
 * and the discrepancies → the listing concierge. Tenant-pinned; every read's error is read; never throws. Module-private:
 * its one door is verifyAndRecordMlsLive below (every feed check — the session button and the sweep); the proof drives it
 * through that door (scripts/listing-lifecycle-guard.ts §C).
 */
async function reconcileListingLifecycle(svc: Svc, input: { brokerageId: string; listingId: string }, deps: ReconcileLifecycleDeps = {}): Promise<ReconcileLifecycleResult> {
  try {
    const now = deps.now ?? new Date()
    const { data, error } = await svc
      .from("listings")
      .select("id, status, lifecycle_stage, deleted_at, go_live_date, mls_live_date_actual, go_live_confirmed_at, go_live_confirmed_source, mls_live_date_basis, mls_live_timezone")
      .eq("id", input.listingId)
      .eq("brokerage_id", input.brokerageId)
      .maybeSingle()
    if (error) return { ok: false, error: `listing could not be read: ${error.message}` }
    if (!data) return { ok: false, error: "listing not found in this brokerage" }
    const row = data as Record<string, any>
    const { governingListingAgreementTerms } = await import("./listing-agreement-terms")
    const terms = await governingListingAgreementTerms(svc, input)
    const window = resolveComingSoonWindow({ agreementExecutedAt: terms.ok ? terms.agreementExecutedAt : null, listing: row }, now)
    let status = (row.status as string | null) ?? null
    let activated = false
    let activationRefusal: string | null = null

    if (!row.deleted_at && window.verifiedLive && PRE_ACTIVE.includes(String(status))) {
      const verdict = await (deps.gate ?? defaultActivationGate)(svc, { ...input, door: "MLS feed verification" })
      if (!verdict.allowed) activationRefusal = verdict.reason
      else {
        const { withActionLedger } = await import("@/lib/kernel/action-ledger")
        const fromState = String(row.lifecycle_stage ?? "")
        const res = await withActionLedger<{ success: boolean; error?: string; replayed?: boolean }>(
          {
            brokerageId: input.brokerageId,
            action: "listing.mls_activation.record",
            actor: { type: "system" },
            subject: { type: "listing", id: input.listingId },
            reasonCode: "TRANSACTION_MILESTONE",
            reasonDetail: `the MLS feed verified the listing live on ${window.verifiedLive} and the activation gate passed`,
            idempotencyKey: `listing_mls_activation:${input.listingId}:${window.verifiedLive}`,
            riskClass: "LOW_RISK_WRITE",
            systemSource: "mls-live-verification",
            detail: { from_status: status, from_stage: fromState, verified_live: window.verifiedLive },
          },
          () => (deps.transition ?? defaultActivationTransition)({ ...input, fromState, verifiedLive: window.verifiedLive as string }, svc),
          {
            settle: (r) => (r.success ? { status: "executed", outcome: "activated" } : { status: "failed", outcome: "transition_refused", error: r.error ?? null }),
            replay: (claim) => (claim.kind === "replay"
              ? { success: true, replayed: true }
              : { success: false, error: claim.kind === "refused" ? `the action ledger refused the activation (${claim.error}) — nothing changed` : `an earlier activation attempt is ${claim.kind === "in_flight" ? "still in flight" : "in an unknown state"}` }),
          },
          { client: svc },
        )
        if (res.success && !res.replayed) { activated = true; status = statusForStage("MLS_ACTIVE") ?? status }
        else if (!res.success) activationRefusal = res.error ?? "the stage transition was refused"
      }
    }

    const findings = listingLifecycleFindings({
      status, deletedAt: row.deleted_at ?? null, window, agreementKnown: terms.ok,
      agreedMlsLiveDate: terms.ok ? terms.sellerRequestedMlsLiveDate : null, today: todayInTimeZone(window.timezone, now),
    }).map((f) => (f.code === "live_on_mls_not_active" && activationRefusal
      ? { ...f, message: `${f.message} The activation gate refused: ${activationRefusal}`, evidence: { ...f.evidence, activation_refusal: activationRefusal } }
      : f))
    const published: ListingLifecycleFindingCode[] = []
    for (const f of findings) if (await publishLifecycleFinding(svc, input, f, deps.publish)) published.push(f.code)
    return { ok: true, activated, activationRefusal, findings, published }
  } catch (e) {
    return { ok: false, error: `reconcile threw: ${e instanceof Error ? e.message : String(e)}` }
  }
}

/** One open finding per (listing, code): an unchanged discrepancy is not re-published on every sweep. */
async function publishLifecycleFinding(svc: Svc, input: { brokerageId: string; listingId: string }, f: ListingLifecycleFinding, publish?: ReconcileLifecycleDeps["publish"]): Promise<boolean> {
  // `status` is read and judged here (absent = the column DEFAULT 'open'): publishManagerSignal inserts no status of its own.
  const { data: same, error } = await svc.from("manager_signals").select("id, status")
    .eq("brokerage_id", input.brokerageId).eq("to_manager", "listing_concierge").eq("signal_type", LISTING_LIFECYCLE_FINDING_SIGNAL)
    .eq("entity_id", input.listingId).eq("payload->>code", f.code).limit(50)
  if (error) { console.error(`[mls-live-verification] finding ${f.code} not published — the open-signal check was refused: ${error.message}`); return false }
  if (((same ?? []) as Array<{ status?: string | null }>).some((s) => (s.status ?? "open") === "open")) return false
  const pub = publish ?? (async (p: Parameters<NonNullable<ReconcileLifecycleDeps["publish"]>>[0], s: Svc) => (await import("@/lib/kernel/manager-signals")).publishManagerSignal(p, s as never))
  const r = await pub({
    brokerageId: input.brokerageId, fromManager: "data_steward", toManager: "listing_concierge", signalType: LISTING_LIFECYCLE_FINDING_SIGNAL,
    message: f.message, entityType: "listing", entityId: input.listingId, payload: { code: f.code, ...f.evidence }, dedupe: false,
  }, svc)
  if (!r.ok) console.error(`[mls-live-verification] finding ${f.code} for listing ${input.listingId} not published: ${r.reason ?? "unknown"}`)
  return r.ok
}

async function defaultActivationGate(svc: Svc, p: { brokerageId: string; listingId: string; door: string }): Promise<{ allowed: boolean; reason: string }> {
  const { assertListingActivationAllowed } = await import("./listing-activation-gate")
  const v = await assertListingActivationAllowed(svc as never, p)
  return { allowed: v.allowed, reason: v.reason }
}

async function defaultActivationTransition(p: { brokerageId: string; listingId: string; fromState: string; verifiedLive: string }, svc: Svc): Promise<{ success: boolean; error?: string }> {
  const [{ transitionLifecycle }, { KernelEvent }] = await Promise.all([import("@/lib/kernel/lifecycle"), import("@/lib/kernel/events")])
  const r = await transitionLifecycle({
    brokerageId: p.brokerageId, entityType: "listing_stage_machine", entityId: p.listingId,
    fromState: p.fromState, toState: "MLS_ACTIVE", actorUserId: null, eventType: KernelEvent.LISTING_PUBLISHED,
    metadata: { activated_by: "mls_feed_verified", verified_live: p.verifiedLive },
  }, svc as never)
  return { success: r.success, error: r.error }
}

/**
 * The ONE verification: read the listing (tenant-pinned), consult the feeds, reconcile, and on `confirmed` record
 * the actual live date. `feeds` is the seam a guard injects; production leaves it to consultMlsFeeds.
 */
export async function verifyAndRecordMlsLive(
  svc: Svc,
  ctx: VerifyListingContext & { actorUserId?: string | null },
  listingId: string,
  opts: { feeds?: MlsFeedsFn; now?: Date; lifecycle?: ReconcileLifecycleDeps } = {},
): Promise<VerifyAndRecordResult> {
  const { data: listing, error } = await svc
    .from("listings")
    .select("id, address, city, state, zip, brokerage_id, mls_number, listing_date, updated_at, agent_id, metadata, go_live_confirmed_at, status")
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
  } else if (verification.needsAttention && (verification.verdict === "contradicted" || !PRE_ACTIVE.includes(String(row.status)))) {
    // A PRE-ACTIVE listing that is not on the feed yet is EXPECTED (it is Coming Soon) — "not showing on the MLS yet" is
    // not a finding for it (wave 147F); only a contradicted MLS number is. An `active` claim keeps the overdue bell.
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
  // C12: after every check, the lifecycle follows the evidence — a confirmed live listing becomes Active (gated, ledgered),
  // and any discrepancy reaches the listing concierge once. Best-effort: the verification above stands either way.
  const lifecycle = await reconcileListingLifecycle(svc, { brokerageId: ctx.brokerageId, listingId }, { now: opts.now, ...(opts.lifecycle ?? {}) })
  if (!lifecycle.ok) console.error(`[mls-live-verification] lifecycle reconcile for listing ${listingId} did not run: ${lifecycle.error}`)
  return { ok: true, verification, recorded, lifecycle }
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
 * THE AUTONOMOUS SWEEP — listings with an MLS number that no feed has confirmed yet. Per brokerage, bounded.
 * WAVE 147 (lane 147F, C12): not only `active` (is the OS's claim true?) but the PRE-ACTIVE statuses too (did the listing
 * the admin put on the MLS actually go live?) — a confirmation is the EVENT that makes it Active (reconcileListingLifecycle).
 * The MLS has no push to us; this poll is the fallback, at most once per listing per SWEEP_RECHECK_HOURS (the freshness it
 * can promise).
 */
export async function runMlsLiveVerificationSweep(
  svc: Svc,
  brokerageId: string,
  opts: { limit?: number; now?: Date; feeds?: MlsFeedsFn; lifecycle?: ReconcileLifecycleDeps } = {},
): Promise<MlsLiveSweepResult> {
  const out: MlsLiveSweepResult = { scanned: 0, skippedRecent: 0, confirmed: 0, contradicted: 0, pending: 0, unverifiable: 0, errors: 0 }
  if (!brokerageId) return out
  const { data, error } = await svc
    .from("listings")
    .select("id, metadata")
    .eq("brokerage_id", brokerageId)
    .in("status", [...MLS_CHECKABLE_STATUSES])
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
    const r = await verifyAndRecordMlsLive(svc, { brokerageId, userId: null, teamId: null, actorUserId: null }, l.id, { feeds: opts.feeds, now: opts.now, lifecycle: opts.lifecycle })
    if (!r.ok) { out.errors++; continue }
    out[r.verification.verdict]++
  }
  return out
}
