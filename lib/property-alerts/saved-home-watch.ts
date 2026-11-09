/**
 * lib/property-alerts/saved-home-watch.ts — THE SAVED-HOME ALERT COMPLETION PATH (wave 151, lane 151J).
 *
 * Owner: "saved home alerts"; "if the person's preferences are not set, then the arbiter decides"; "no spam".
 * Directive 151J: source snapshot/update → source-specific listing identity and freshness → diff against the last
 * verified state → saved-property subscription → event → the existing arbiter → permission / channel / frequency choice
 * → correct recipient and agent context → delivery acknowledgement → alert history. Source deletion, an expired listing,
 * a re-listing under a new MLS id and a price / status reversal handled WITHOUT duplicate notifications. Preferences
 * unset → the arbiter decides; never a daily blast. No IDX-photo assumption for RentCast or buyer-URL records.
 *
 * SURVIVORS, EXTENDED — nothing here is a second engine:
 *   · saved_properties (lane 150W: THE saved-home table, with its origin — idx_mls | rentcast_listing | buyer_url |
 *     tenant_listing | manual) is the SUBSCRIPTION. m983 gives each row its LAST VERIFIED STATE (last_verified_at /
 *     _status / _price / _mls_number / _source) and an honest `verification_hold`.
 *   · lib/ai-isa/saved-home-nudge.ts is THE planner (classifySavedHomeNudge) and THE arbiter door for a saved-home
 *     change (decideSavedHomeNudge → arbitratePlannedTouch, planner `saved_home_nudge`): reel / written note / the agent /
 *     a bounded HOLD. Wave 151 adds the honest ending `no_longer_available` to its vocabulary.
 *   · lib/kernel/manager-signals.ts routeSavedHomeNudge is THE router; its delivery half (deliverSavedHomeNudgeDecision)
 *     is what this watch hands the decided route to — asset_manager reel / campaign_orchestrator gated note / the agent's
 *     activity. The tenant's OWN listings keep reaching the buyers who saved them in real time through the event reactor
 *     (nudgeSaversOfListing); this watch is the catch-up for them and the ONLY path for homes saved from RentCast or a link.
 *   · lib/property-alerts/alert-engine.ts (the criteria-based alert — a saved SEARCH, the other subscription) carries
 *     this watch on its DAILY tick. That tick is a DETECTION poll: "what does the source say now?" Nothing in this file
 *     decides WHEN a buyer hears of a change — the arbiter does, and a hold leaves the verified state unadvanced so the
 *     change is re-asked next sweep (bounded by the arbiter's own wait counter), never dropped and never defaulted.
 *   · The METERED re-read (OWNER-SQL §L L6.10, lane-150Z row 76): a RentCast listing is re-read by its listing id
 *     (lib/property/rentcast.ts getRentcastSaleListingById) and a pasted-link home by address through the capability rail
 *     (lib/ai-isa/property-lookup-rail.ts lookupPropertyForConversation, customer audience). Both are PLATFORM spend
 *     ($RENTCAST_USD_PER_REQUEST a request) and both pass the EXISTING gates first: paidPullApproval (a tenant-approved
 *     acquisition-plan line naming SAVED_HOME_RECHECK_SOURCE pays — RentCast has no tenant-connectable account and is not
 *     a scrape vendor, so the IF/THEN door table cannot open it; the plan line IS the owner's per-tenant approval) and
 *     decideSpendBackpressure under lane 151F's platform caps (null caps → refused). A re-read that is not approved is
 *     HELD and RECORDED — on every row (verification_hold) and once per tenant per day on the action ledger — never a
 *     silent poll. An IDX saved home has no by-id read in lib/idxbroker-client.ts (featured set + free-text search only),
 *     so it is held by name (EVALUATED — the blocker is a listing-by-id method on the client), never guessed off-board.
 *
 * DEDUP — "without duplicate notifications": one change = one state DIGEST (the new price for a drop; the MLS number +
 * status for a status change) and the alert's ledger key is `saved_home.alert:<savedId>:<digest>`. A price that falls,
 * rises and falls back to the same figure, or a withdrawn → active → withdrawn → active flap under one MLS number, carries
 * the SAME digest and replays instead of announcing twice. A re-listing under a NEW MLS id changes the digest once and is
 * announced once. A first read is a BASELINE and announces nothing (a buyer who saves a home today is not told about it
 * tomorrow). A buyer's `dismissed` home is never re-read and never alerted.
 *
 * PHOTOS: none are read, fetched or stored here (owner R9 — RentCast and a pasted link are never a photo source).
 *
 * Not server-only: pure rules + injected readers, so scripts/saved-home-alerts-guard.ts drives the sweep end to end on
 * scripts/in-memory-supabase.ts with every provider and the arbiter's decision injected (no network, no model).
 */
import { savedHomeOrigin, type SavedHomeOrigin } from "@/lib/buyer-search/search-engine"
import { applyTenantScope, type TenantScope } from "@/lib/kernel/tenant-scope"
import { decideSpendBackpressure } from "@/lib/vendor-governance/budget-eval"
import { normalizeVendorStatus } from "@/lib/property/resolve-property-facts"
import { withActionLedger, recordNonAction } from "@/lib/kernel/action-ledger"
import { emitKernelEvent } from "@/lib/kernel/emit"
import { classifySavedHomeNudge, decideSavedHomeNudge, type SavedHomeNudge, type SavedHomeNudgeKind, type SavedHomeNudgeRoute } from "@/lib/ai-isa/saved-home-nudge"
import type { ArbiterDecide } from "@/lib/ai-isa/followup-arbiter"

type Db = { from: (t: string) => any }

// ─── VOCABULARY (one constant per idea) ───────────────────────────────────────────────────────────────────────────────

/** ONE source constant for saved_properties.last_verified_source (m983 CHECK saved_properties_last_verified_source_check). */
export const SAVED_HOME_VERIFICATION_SOURCES = ["tenant_listing", "idx_mls", "rentcast_listing", "buyer_url"] as const
export type SavedHomeVerificationSource = (typeof SAVED_HOME_VERIFICATION_SOURCES)[number]

/** The acquisition-plan line SOURCE and the vendor-ledger lane (request_metadata.system_source) a saved-home re-read spends under. */
export const SAVED_HOME_RECHECK_SOURCE = "rentcast_saved_home_recheck"

/** The audit event (lifecycle_events, audit-only) and the buyer's portal notification type — the alert HISTORY. */
export const SAVED_HOME_ALERT_EVENT = "saved_home.alert"
/** The ledger action (domain.entity.action — lib/kernel/action-ledger.ts validates the three segments). */
export const SAVED_HOME_ALERT_ACTION = "saved_home.alert.announce"
export const SAVED_HOME_ALERT_NOTIFICATION_TYPE = "saved_home_alert"

/** The matcher's own default floor for a "relevant" price change (lib/property-alerts/alert-cadence.ts
 *  selectNewOrRepricedMatches: `price_reduction_min_percent ?? 2`) — the same number, so a saved home and a saved search
 *  agree on what counts as a price drop. */
export const SAVED_HOME_PRICE_DROP_MIN_PERCENT = 2

/** Rows one sweep reads at most (the next sweep continues). */
export const SAVED_HOME_WATCH_MAX_ROWS = 500

/** Why a sweep could not verify a home — stored on verification_hold as `<reason>: <detail>`. */
export const SAVED_HOME_HOLD_REASONS = ["metered_recheck_unapproved", "metered_recheck_throttled", "idx_by_id_unavailable", "status_unverifiable_by_address", "source_unreadable", "arbiter_wait"] as const
export type SavedHomeHoldReason = (typeof SAVED_HOME_HOLD_REASONS)[number]

/** The change kinds this watch can observe — a subset of the planner's vocabulary (never a second spelling). */
export const SAVED_HOME_CHANGE_KINDS = ["price_drop", "back_on_market", "under_contract", "no_longer_available"] as const satisfies readonly SavedHomeNudgeKind[]
export type SavedHomeChangeKind = (typeof SAVED_HOME_CHANGE_KINDS)[number]

export const SAVED_HOME_WATCH_COLUMNS = "id, brokerage_id, contact_id, listing_id, external_property_id, source, source_url, mls_number, mls_name, property_address, city, state, list_price, dismissed, last_verified_at, last_verified_status, last_verified_price, last_verified_mls_number, last_verified_source, verification_hold"

export interface SavedHomeWatchRow {
  id: string
  brokerage_id: string | null
  contact_id: string | null
  listing_id: string | null
  external_property_id: string | null
  source: string | null
  source_url: string | null
  mls_number: string | null
  mls_name: string | null
  property_address: string | null
  city: string | null
  state: string | null
  list_price: number | string | null
  dismissed: boolean | null
  last_verified_at: string | null
  last_verified_status: string | null
  last_verified_price: number | string | null
  last_verified_mls_number: string | null
  last_verified_source: string | null
  verification_hold: string | null
}

/** What a source said about a saved home at one read, on OUR status vocabulary (normalizeVendorStatus). */
export interface SavedHomeVerifiedState {
  status: string | null
  price: number | null
  mlsNumber: string | null
  source: SavedHomeVerificationSource
  at: string
}

// Module-private (wave 151 integrator): the change shape is produced and consumed inside the watch only.
interface SavedHomeChange {
  kind: SavedHomeChangeKind
  /** The dedup key: the new price for a drop; the MLS number + status for a status change. */
  digest: string
  previous: SavedHomeVerifiedState
  current: SavedHomeVerifiedState
  dropPercent: number | null
  /** A re-listing: the same saved home now carries a different MLS number. */
  relistedUnderNewMls: boolean
  summary: string
}

export type SavedHomeVerification =
  | { kind: "verified"; state: SavedHomeVerifiedState }
  | { kind: "held"; reason: SavedHomeHoldReason; detail: string }

// ─── PURE RULES ───────────────────────────────────────────────────────────────────────────────────────────────────────
//
// Every rule below is MODULE-PRIVATE: the ONE public door is watchSavedHomes (the cron route), and scripts/saved-home-
// alerts-guard.ts drives each rule END TO END through it (one saved row + one source row per case; the change kind, the
// state digest, the drop percent and the re-listing flag are read back from the audit event the sweep leaves). An export
// nothing outside this file imports is an orphan (scripts/orphan-export-guard.ts), and a proof import does not count.

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? n : null
}
const ON_MARKET = new Set(["active", "coming_soon"])
const OFF_MARKET = new Set(["sold", "withdrawn", "expired", "off_market"])

/** PURE. Our status vocabulary from any source spelling (ours use underscores — "coming_soon", "under_contract"). */
function savedHomeStatusFrom(raw: string | null | undefined): string | null {
  const s = String(raw ?? "").trim()
  if (!s) return null
  return normalizeVendorStatus(s.replace(/_/g, " "))
}

// The three pure helpers below are MODULE-PRIVATE on purpose: nothing outside this file reads them (the sweep, the
// alert and the guard all go through diffSavedHomeState / watchSavedHomes / alertSavedHomeChange), and an export nothing
// imports is an orphan (scripts/orphan-export-guard.ts category C).

/** PURE. Which source verifies a saved home of this origin; null = no source to read (a staff-entered row). */
function verificationSourceFor(origin: SavedHomeOrigin): SavedHomeVerificationSource | null {
  switch (origin) {
    case "tenant_listing": return "tenant_listing"
    case "idx_mls": return "idx_mls"
    case "rentcast_listing": return "rentcast_listing"
    case "buyer_url": return "buyer_url"
    default: return null
  }
}

/** PURE. The last verified state a row carries, or null when it was never verified (a first read is a baseline). */
function verifiedStateFromRow(row: Pick<SavedHomeWatchRow, "source" | "listing_id" | "last_verified_at" | "last_verified_status" | "last_verified_price" | "last_verified_mls_number" | "last_verified_source">): SavedHomeVerifiedState | null {
  if (!row.last_verified_at) return null
  const stored = String(row.last_verified_source ?? "")
  const source = (SAVED_HOME_VERIFICATION_SOURCES as readonly string[]).includes(stored) ? (stored as SavedHomeVerificationSource) : (verificationSourceFor(savedHomeOrigin(row)) ?? "tenant_listing")
  return { status: row.last_verified_status ?? null, price: num(row.last_verified_price), mlsNumber: row.last_verified_mls_number ?? null, source, at: row.last_verified_at }
}

/** PURE. The dedup digest of a change: a drop is keyed by the new price; a status change by the MLS number + status.
 *  Module-private — every digest reaches a caller on a SavedHomeChange (diffSavedHomeState). */
function changeDigest(kind: SavedHomeChangeKind, current: SavedHomeVerifiedState): string {
  if (kind === "price_drop") return `price_drop:${Math.round(current.price ?? 0)}`
  return `${kind}:${current.mlsNumber ?? "-"}:${current.status ?? "-"}`
}

/**
 * PURE. The DIFF — what changed between the last verified state and this read, on the planner's vocabulary.
 *   · no previous state → null (a BASELINE, never a notification);
 *   · the current status unknown → null (nothing is claimed from a read that did not say);
 *   · pending / off-market → active or coming soon → back_on_market (a re-listing under a new MLS id is the same home
 *     carrying a new number: announced once, `relistedUnderNewMls`);
 *   · on market → pending → under_contract;
 *   · on market or pending → sold / withdrawn / expired / off_market (the source deleted it) → no_longer_available;
 *   · on market, price lower than the last verified price by ≥ minDropPercent → price_drop; a rise is NOT announced (the
 *     verified price still advances, so a later drop is measured from what the portal now shows);
 *   · anything else → null.
 */
function diffSavedHomeState(prev: SavedHomeVerifiedState | null, next: SavedHomeVerifiedState, opts: { minDropPercent?: number } = {}): SavedHomeChange | null {
  if (!prev) return null
  const p = prev.status, n = next.status
  if (!n) return null
  const relisted = !!prev.mlsNumber && !!next.mlsNumber && prev.mlsNumber !== next.mlsNumber
  const base = { previous: prev, current: next, dropPercent: null as number | null, relistedUnderNewMls: relisted }
  if (p && (p === "pending" || OFF_MARKET.has(p)) && ON_MARKET.has(n)) {
    return { ...base, kind: "back_on_market", digest: changeDigest("back_on_market", next), summary: relisted ? `back on the market under a new listing (MLS ${next.mlsNumber})` : `back on the market (was ${p.replace(/_/g, " ")})` }
  }
  if (p && ON_MARKET.has(p) && n === "pending") {
    return { ...base, kind: "under_contract", digest: changeDigest("under_contract", next), summary: "went under contract" }
  }
  if (p && (ON_MARKET.has(p) || p === "pending") && OFF_MARKET.has(n)) {
    return { ...base, kind: "no_longer_available", digest: changeDigest("no_longer_available", next), summary: `no longer available (the source reports ${n.replace(/_/g, " ")})` }
  }
  if (ON_MARKET.has(n) && (!p || ON_MARKET.has(p)) && prev.price && next.price && next.price < prev.price) {
    const dropPercent = ((prev.price - next.price) / prev.price) * 100
    if (dropPercent >= (opts.minDropPercent ?? SAVED_HOME_PRICE_DROP_MIN_PERCENT)) {
      return { ...base, kind: "price_drop", dropPercent: Math.round(dropPercent * 10) / 10, digest: changeDigest("price_drop", next), summary: `price dropped ${Math.round(dropPercent * 10) / 10}%` }
    }
  }
  return null
}

/** PURE. The saved_properties columns one verified read writes (clears any hold; the asking price shown while on market). */
function verifiedStatePatch(state: SavedHomeVerifiedState): Record<string, unknown> {
  return {
    last_verified_at: state.at, last_verified_status: state.status, last_verified_price: state.price,
    last_verified_mls_number: state.mlsNumber, last_verified_source: state.source, verification_hold: null,
    ...(state.status && ON_MARKET.has(state.status) && state.price ? { list_price: state.price } : {}),
    ...(state.mlsNumber ? { mls_number: state.mlsNumber } : {}),
  }
}

/** PURE. The hold a row records when a sweep could not verify it (last_verified_* untouched — nothing was verified).
 *  Module-private: `<reason>: <detail>`, read back by the buyer only through savedHomeVerificationLine (which never shows it). */
function holdText(reason: SavedHomeHoldReason, detail: string): string {
  return `${reason}: ${detail}`.slice(0, 400)
}

/** PURE. The buyer's portal words for a change — the home, what happened, and the next step. Never an exact figure
 *  (the price is the agent's conversation; the portal card carries the current asking price itself). */
function savedHomeAlertWords(row: Pick<SavedHomeWatchRow, "property_address" | "city">, change: SavedHomeChange): { title: string; body: string } {
  const where = [row.property_address, row.city].filter(Boolean).join(", ") || "A home you saved"
  switch (change.kind) {
    case "price_drop": return { title: "A home you saved dropped in price", body: `${where} is now listed at a lower price than when you last looked. Open your saved homes to see it — your agent can walk you through it.` }
    case "back_on_market": return { title: "A home you saved is available again", body: `${where} is back on the market${change.relistedUnderNewMls ? " under a new listing" : ""}. These move fast — your agent can set up a showing.` }
    case "under_contract": return { title: "A home you saved is under contract", body: `${where} went under contract. Your agent has similar homes ready to look at with you.` }
    case "no_longer_available": return { title: "A home you saved is no longer on the market", body: `${where} is no longer listed (the source reports it as ${(change.current.status ?? "off market").replace(/_/g, " ")}). Your agent can line up similar homes.` }
  }
}

// ─── THE METERED RE-READ — approval and backpressure BEFORE any request (never a silent poll) ─────────────────────────

/** acquisition_plans rows as the plan-line rule reads them (lib/lead-pipeline/source-discovery-planner.ts StoredPlanRow). */
export interface PlanRowLike { id: string; brokerage_id: string; status: string; valid_until: string | null; lines: unknown }

export interface MeteredRecheckPlan {
  /** How many of the wanted re-reads may be made now. */
  allowed: number
  held: number
  /** The hold reason when allowed < want (null when every want proceeds). */
  reason: string | null
  approval: { allowed: boolean; planId: string | null; maxSpendUsd: number | null; approvedAt: string | null; reason: string | null }
  backpressure: { action: "proceed" | "throttle" | "defer" | "refuse"; records: number; usd: number; reason: string } | null
  unitUsd: number
}

/**
 * The gate a tenant's metered saved-home re-reads pass, in order: (1) paidPullApproval on the plan-line rule — a
 * tenant-approved, unexpired acquisition-plan line naming SAVED_HOME_RECHECK_SOURCE (the owner's per-tenant approval,
 * OWNER-SQL §L L6.10); (2) decideSpendBackpressure sized in dollars against that line's ceiling, the spend already booked
 * against it (the vendor ledger since approvedAt) and lane 151F's platform caps (null → refused). No door context is
 * passed on purpose: RentCast is platform-gated with no tenant account and is not a scrape vendor, so the IF/THEN door
 * table (resolveSourceDoor) would always read its rights as unknown and refuse — the plan line is the honest door here.
 */
async function planMeteredRecheck(a: {
  brokerageId: string
  want: number
  plans: PlanRowLike[] | null
  /** Spend booked against the approval since approvedAt (USD); null = unreadable → deferred. */
  spentSinceApproval: (sinceIso: string | null) => Promise<number | null>
  /** Lane 151F's remaining platform acquisition dollars; null = caps not configured → refused. */
  platformCapRemainingUsd: number | null
  now: Date
  unitUsd: number
}): Promise<MeteredRecheckPlan> {
  const { paidPullApproval } = await import("@/lib/lead-pipeline/source-discovery-planner")
  const approvalRaw = paidPullApproval(a.plans as never, { brokerageId: a.brokerageId, source: SAVED_HOME_RECHECK_SOURCE }, a.now)
  const approval = approvalRaw.allowed
    ? { allowed: true, planId: approvalRaw.planId, maxSpendUsd: approvalRaw.maxSpendUsd, approvedAt: approvalRaw.approvedAt, reason: null }
    : { allowed: false, planId: null, maxSpendUsd: null, approvedAt: null, reason: approvalRaw.reason }
  if (!approval.allowed) {
    return { allowed: 0, held: a.want, reason: `metered re-read not approved — ${approval.reason}`, approval, backpressure: null, unitUsd: a.unitUsd }
  }
  const spent = await a.spentSinceApproval(approval.approvedAt)
  const bp = decideSpendBackpressure({
    wantRecords: a.want, unitUsd: a.unitUsd, approvedMaxUsd: approval.maxSpendUsd, approvedSpentUsd: spent,
    platformCapRemainingUsd: a.platformCapRemainingUsd,
  })
  const allowed = bp.action === "proceed" || bp.action === "throttle" ? Math.min(a.want, bp.records) : 0
  return {
    allowed, held: a.want - allowed,
    reason: allowed < a.want ? `metered re-read ${bp.action === "throttle" ? "throttled" : bp.action}: ${bp.reason}` : null,
    approval, backpressure: { action: bp.action, records: bp.records, usd: bp.usd, reason: bp.reason }, unitUsd: a.unitUsd,
  }
}

// ─── READERS (injected; production defaults resolve the survivors lazily) ─────────────────────────────────────────────

export interface SavedHomeWatchDeps {
  now?: Date
  /** The tenant's own listing by id (free). Default: the listings table. */
  readTenantListing?: (db: Db, row: SavedHomeWatchRow, now: Date) => Promise<SavedHomeVerification>
  /** A RentCast listing by its listing id (METERED). Default: lib/property/rentcast.ts getRentcastSaleListingById. */
  readRentcastListing?: (row: SavedHomeWatchRow, now: Date) => Promise<SavedHomeVerification>
  /** A pasted-link home by its address through the capability rail (METERED). Default: lookupPropertyForConversation. */
  readByAddress?: (row: SavedHomeWatchRow, now: Date) => Promise<SavedHomeVerification>
  /** The tenant's approved acquisition plans. Default: acquisition_plans. null = unreadable (refuses everyone). */
  loadPlans?: (db: Db, brokerageId: string) => Promise<PlanRowLike[] | null>
  /** Spend booked under SAVED_HOME_RECHECK_SOURCE since the approval. Default: vendor_usage_tracking. null = unreadable. */
  spentSinceApproval?: (db: Db, brokerageId: string, sinceIso: string | null) => Promise<number | null>
  /** Lane 151F's remaining platform acquisition dollars for this tenant. Default: platformCapRemainingFor. */
  platformCapRemainingUsd?: (db: Db, brokerageId: string, now: Date) => Promise<number | null>
  /** The documented per-request price. Default RENTCAST_USD_PER_REQUEST. */
  unitUsd?: number
  /** The arbiter's decision seam (proofs inject; production = the routed model behind arbitratePlannedTouch). */
  decide?: ArbiterDecide
  /** Record the arbiter's decision on the ledger (default true). */
  record?: boolean
  /** The ONE delegation after the arbiter decided. Default: manager-signals deliverSavedHomeNudgeDecision. */
  deliver?: (db: Db, a: { brokerageId: string; contactId: string; listingId: string | null; propertyAddress: string | null; agentId: string | null }, nudge: SavedHomeNudge, decided: { route: SavedHomeNudgeRoute; rationale: string }) => Promise<boolean>
}

const defaultReadTenantListing: NonNullable<SavedHomeWatchDeps["readTenantListing"]> = async (db, row, now) => {
  if (!row.listing_id) return { kind: "held", reason: "source_unreadable", detail: "a tenant-listing origin with no listing id" }
  const { data, error } = await db.from("listings").select("id, status, lifecycle_stage, list_price, mls_number, deleted_at")
    .eq("id", row.listing_id).eq("brokerage_id", row.brokerage_id).maybeSingle()
  if (error) return { kind: "held", reason: "source_unreadable", detail: `listings read refused: ${error.message}` }
  const l = data as { status?: string | null; lifecycle_stage?: string | null; list_price?: number | string | null; mls_number?: string | null; deleted_at?: string | null } | null
  // SOURCE DELETION: the listing row is gone (or soft-deleted) — the home is off the market as far as this tenant's board knows.
  if (!l || l.deleted_at) return { kind: "verified", state: { status: "off_market", price: null, mlsNumber: row.mls_number ?? null, source: "tenant_listing", at: now.toISOString() } }
  return { kind: "verified", state: { status: savedHomeStatusFrom(l.status), price: num(l.list_price), mlsNumber: l.mls_number ?? row.mls_number ?? null, source: "tenant_listing", at: now.toISOString() } }
}

const defaultReadRentcastListing: NonNullable<SavedHomeWatchDeps["readRentcastListing"]> = async (row, now) => {
  if (!row.external_property_id) return { kind: "held", reason: "source_unreadable", detail: "a RentCast origin with no listing id" }
  const { getRentcastSaleListingById } = await import("@/lib/property/rentcast")
  const r = await getRentcastSaleListingById({ brokerageId: row.brokerage_id as string, contactId: row.contact_id, systemSource: SAVED_HOME_RECHECK_SOURCE, externalId: row.external_property_id })
  if (!r.ok) return { kind: "held", reason: "source_unreadable", detail: `RentCast re-read did not complete: ${r.error}` }
  if (r.offMarket || !r.listing) return { kind: "verified", state: { status: "off_market", price: null, mlsNumber: row.mls_number ?? null, source: "rentcast_listing", at: now.toISOString() } }
  const l = r.listing
  return { kind: "verified", state: { status: savedHomeStatusFrom(l.status) ?? (l.removedDate ? "off_market" : null), price: num(l.price), mlsNumber: l.mlsNumber ?? row.mls_number ?? null, source: "rentcast_listing", at: now.toISOString() } }
}

const defaultReadByAddress: NonNullable<SavedHomeWatchDeps["readByAddress"]> = async (row, now) => {
  const street = (row.property_address ?? "").trim()
  if (!street) return { kind: "held", reason: "status_unverifiable_by_address", detail: "no address on the saved link (saved as a link only)" }
  const { lookupPropertyForConversation } = await import("@/lib/ai-isa/property-lookup-rail")
  const r = await lookupPropertyForConversation({ brokerageId: row.brokerage_id as string, purpose: "conversation", audience: "customer", address: { street, city: row.city, state: row.state }, contactId: row.contact_id })
  if (!r.found || !r.facts || !r.facts.listingStatus) {
    return { kind: "held", reason: "status_unverifiable_by_address", detail: r.found ? "the property record carries no listing status (no active listing found at this address)" : "no property record found at this address" }
  }
  return { kind: "verified", state: { status: savedHomeStatusFrom(r.facts.listingStatus), price: num(r.facts.listPrice), mlsNumber: r.facts.mlsNumber ?? row.mls_number ?? null, source: "buyer_url", at: now.toISOString() } }
}

const defaultLoadPlans: NonNullable<SavedHomeWatchDeps["loadPlans"]> = async (db, brokerageId) => {
  const { data, error } = await db.from("acquisition_plans").select("id, brokerage_id, status, valid_until, lines").eq("brokerage_id", brokerageId).eq("status", "approved")
  if (error) { console.error(`[saved-home-watch] acquisition_plans read refused for ${brokerageId}: ${error.message} — every metered re-read is held this sweep`); return null }
  return (data ?? []) as PlanRowLike[]
}

const defaultSpentSinceApproval: NonNullable<SavedHomeWatchDeps["spentSinceApproval"]> = async (db, brokerageId, sinceIso) => {
  let q = db.from("vendor_usage_tracking").select("total_cost, created_at").eq("brokerage_id", brokerageId).eq("vendor_name", "rentcast").eq("request_metadata->>system_source", SAVED_HOME_RECHECK_SOURCE)
  if (sinceIso) q = q.gte("created_at", sinceIso)
  const { data, error } = await q
  if (error) return null
  return Math.round(((data ?? []) as Array<{ total_cost: number | string | null }>).reduce((s, r) => s + (Number(r.total_cost) || 0), 0) * 100) / 100
}

const defaultPlatformCapRemaining: NonNullable<SavedHomeWatchDeps["platformCapRemainingUsd"]> = async (db, brokerageId, now) => {
  const { platformCapRemainingFor } = await import("@/lib/vendor-governance/platform-acquisition-caps")
  return (await platformCapRemainingFor(db as never, brokerageId, now)).remainingUsd
}

const defaultDeliver: NonNullable<SavedHomeWatchDeps["deliver"]> = async (db, a, nudge, decided) => {
  const { deliverSavedHomeNudgeDecision } = await import("@/lib/kernel/manager-signals")
  return deliverSavedHomeNudgeDecision({ brokerageId: a.brokerageId, supabase: db as never }, { contactId: a.contactId, listingId: a.listingId, propertyAddress: a.propertyAddress, agentId: a.agentId }, nudge, decided)
}

// ─── ONE CHANGE → THE ARBITER → THE DELEGATION → HISTORY ──────────────────────────────────────────────────────────────

// Module-private (wave 151 integrator): the outcome shape is read inside the watch only; nothing cross-file names it.
interface SavedHomeAlertOutcome {
  route: SavedHomeNudgeRoute | "replayed" | "refused"
  rationale: string
  /** The delegation landed (a signal / the agent's activity). */
  delivered: boolean
  /** The buyer's portal notification row landed (their history; read_at is their acknowledgement). */
  notified: boolean
  ledgerKey: string
  error: string | null
}

/**
 * One observed change on one saved home. The ARBITER decides first (decideSavedHomeNudge — reel / note / agent / hold);
 * a HOLD returns without claiming the ledger key, so the next sweep re-asks. Otherwise the delivery runs under ONE
 * ledger claim keyed by the change digest (a reversal or a re-list observed twice replays — never a second notice):
 * the ONE delegation → the audit event → the buyer's portal notification (written only when the buyer is told, i.e. a
 * note or a reel — when the agent reaches out personally, the agent IS the message).
 */
async function alertSavedHomeChange(db: Db, row: SavedHomeWatchRow, change: SavedHomeChange, deps: SavedHomeWatchDeps = {}): Promise<SavedHomeAlertOutcome> {
  const now = deps.now ?? new Date()
  const brokerageId = row.brokerage_id as string
  const contactId = row.contact_id as string
  const ledgerKey = `${SAVED_HOME_ALERT_ACTION}:${row.id}:${change.digest}`
  const nudge = classifySavedHomeNudge(change.kind)
  if (!nudge) return { route: "refused", rationale: `no planner entry for ${change.kind}`, delivered: false, notified: false, ledgerKey, error: "unknown change kind" }

  const { data: who, error: whoErr } = await db.from("contacts").select("agent_id, last_contacted_at").eq("id", contactId).eq("brokerage_id", brokerageId).maybeSingle()
  if (whoErr) console.warn(`[saved-home-watch] contact read refused (${whoErr.message}) — the arbiter decides without it`)
  const person = (who ?? null) as { agent_id?: string | null; last_contacted_at?: string | null } | null
  const lastTouch = person?.last_contacted_at ? Date.parse(person.last_contacted_at) : NaN
  const decided = await decideSavedHomeNudge(db, {
    brokerageId, contactId, nudge, hasAssignedAgent: !!person?.agent_id,
    hoursSinceAnyTouch: Number.isFinite(lastTouch) ? Math.max(0, Math.round((now.getTime() - lastTouch) / 3_600_000)) : null, now,
  }, { decide: deps.decide, record: deps.record })
  if (decided.route === "hold") return { route: "hold", rationale: decided.rationale, delivered: false, notified: false, ledgerKey, error: null }

  const words = savedHomeAlertWords(row, change)
  return withActionLedger<SavedHomeAlertOutcome>(
    {
      brokerageId, action: SAVED_HOME_ALERT_ACTION,
      actor: { type: "manager", managerKey: "shopping_agent" },
      subject: { type: "saved_property", id: row.id, ref: change.digest },
      reasonCode: change.kind === "price_drop" ? "PROPERTY_VALUE_CHANGE" : "SERVICE_NOTICE",
      reasonDetail: `${change.kind} on a saved home (${change.summary}); the arbiter chose ${decided.route} (${decided.source})`,
      idempotencyKey: ledgerKey, riskClass: "COMMUNICATION", channel: "portal", systemSource: "saved_home_watch",
      detail: { contact_id: contactId, change: change.kind, digest: change.digest, previous: change.previous, current: change.current, route: decided.route, rationale: decided.rationale.slice(0, 400), origin: savedHomeOrigin(row) },
    },
    async () => {
      const delivered = await (deps.deliver ?? defaultDeliver)(db, { brokerageId, contactId, listingId: row.listing_id, propertyAddress: row.property_address, agentId: person?.agent_id ?? null }, nudge, decided)
      const ev = await emitKernelEvent({
        event: SAVED_HOME_ALERT_EVENT, brokerageId, entityType: "saved_property", entityId: row.id, contactId, auditOnly: true, client: db as never,
        metadata: { change: change.kind, digest: change.digest, summary: change.summary, drop_percent: change.dropPercent, relisted_under_new_mls: change.relistedUnderNewMls, previous_status: change.previous.status, current_status: change.current.status, previous_price: change.previous.price, current_price: change.current.price, previous_mls_number: change.previous.mlsNumber, current_mls_number: change.current.mlsNumber, route: decided.route, delivered, source: change.current.source },
      })
      let notified = false
      let error: string | null = ev.error ?? null
      if (decided.route === "written_note" || decided.route === "avatar_reel") {
        // The evidence link rides the ledger detail and the audit event (both keyed by the saved home), not a column no
        // portal reader selects (notifications.lifecycle_event_id has no reader — a write nobody reads is a defect, §1).
        const { error: nErr } = await db.from("notifications").insert({
          contact_id: contactId, brokerage_id: brokerageId, type: SAVED_HOME_ALERT_NOTIFICATION_TYPE,
          title: words.title, body: words.body, entity_type: "saved_property", entity_id: row.id,
          priority: nudge.urgency === "high" ? "high" : "medium", channel: "in_app", is_read: false,
        })
        if (nErr) error = [error, `portal notification refused: ${nErr.message}`].filter(Boolean).join("; ")
        else notified = true
      }
      return { route: decided.route, rationale: decided.rationale, delivered, notified, ledgerKey, error }
    },
    {
      settle: (r) => ({ status: r.delivered || r.notified ? "executed" : "failed", outcome: `${r.route}${r.notified ? ":notified" : ""}${r.delivered ? ":delegated" : ""}`, error: r.error }),
      replay: (claim) => ({ route: claim.kind === "refused" ? "refused" : "replayed", rationale: claim.kind === "refused" ? `ledger refused: ${claim.error}` : "this change was already announced for this home (same state digest) — not announced twice", delivered: false, notified: false, ledgerKey, error: claim.kind === "refused" ? claim.error : null }),
    },
    { client: db },
  )
}

// ─── THE SWEEP ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SavedHomeWatchStats {
  scope: string
  scanned: number
  skipped: { manual: number; noContact: number }
  verified: Record<SavedHomeVerificationSource, number>
  verifiedTotal: number
  /** Hold reason → rows held this sweep. */
  holds: Partial<Record<SavedHomeHoldReason, number>>
  changes: Partial<Record<SavedHomeChangeKind, number>>
  changesTotal: number
  /** Changes the arbiter decided to announce (a delegation and/or the buyer's portal note landed). */
  delivered: number
  /** Changes the arbiter HELD — the verified state is not advanced; re-asked next sweep. */
  arbiterHeld: number
  /** Changes already announced under the same digest (the ledger replayed). */
  replayed: number
  meteredRecheck: { brokerages: number; wantedRows: number; allowedRows: number; heldRows: number; usdPlanned: number; reasons: string[] }
  errors: string[]
}

async function stampHold(db: Db, row: SavedHomeWatchRow, reason: SavedHomeHoldReason, detail: string, stats: SavedHomeWatchStats): Promise<void> {
  stats.holds[reason] = (stats.holds[reason] ?? 0) + 1
  const text = holdText(reason, detail)
  if (row.verification_hold === text) return // the same hold already stands — no write per sweep
  const { data, error } = await db.from("saved_properties").update({ verification_hold: text }).eq("id", row.id).eq("brokerage_id", row.brokerage_id).select("id")
  if (error) stats.errors.push(`hold not recorded on ${row.id}: ${error.message}`)
  else if (!Array.isArray(data) || data.length !== 1) stats.errors.push(`hold matched ${Array.isArray(data) ? data.length : 0} row(s) for ${row.id}`)
}

async function stampVerified(db: Db, row: SavedHomeWatchRow, state: SavedHomeVerifiedState, stats: SavedHomeWatchStats): Promise<void> {
  const { data, error } = await db.from("saved_properties").update(verifiedStatePatch(state)).eq("id", row.id).eq("brokerage_id", row.brokerage_id).select("id")
  if (error) stats.errors.push(`verified state not recorded on ${row.id}: ${error.message}`)
  else if (!Array.isArray(data) || data.length !== 1) stats.errors.push(`verified state matched ${Array.isArray(data) ? data.length : 0} row(s) for ${row.id}`)
}

async function settleVerification(db: Db, row: SavedHomeWatchRow, v: SavedHomeVerification, deps: SavedHomeWatchDeps, stats: SavedHomeWatchStats): Promise<void> {
  if (v.kind === "held") { await stampHold(db, row, v.reason, v.detail, stats); return }
  stats.verified[v.state.source] += 1
  stats.verifiedTotal += 1
  const change = diffSavedHomeState(verifiedStateFromRow(row), v.state)
  if (!change) { await stampVerified(db, row, v.state, stats); return }
  stats.changes[change.kind] = (stats.changes[change.kind] ?? 0) + 1
  stats.changesTotal += 1
  const outcome = await alertSavedHomeChange(db, row, change, deps)
  if (outcome.error) stats.errors.push(`${row.id} ${change.kind}: ${outcome.error}`)
  if (outcome.route === "hold") {
    // The arbiter said not now: keep the OLD verified state so the same change is re-asked next sweep; say why on the row.
    stats.arbiterHeld += 1
    await stampHold(db, row, "arbiter_wait", outcome.rationale.slice(0, 300), stats)
    return
  }
  if (outcome.route === "replayed") stats.replayed += 1
  else if (outcome.delivered || outcome.notified) stats.delivered += 1
  await stampVerified(db, row, v.state, stats)
}

/**
 * THE SWEEP. Reads this scope's saved, not-dismissed homes (the tenant pinned by the DECLARED scope — never an optional
 * id), verifies each one against its OWN source, diffs, and hands every real change to the arbiter. Free sources first;
 * metered re-reads only through planMeteredRecheck, held and recorded otherwise. Never throws.
 */
export async function watchSavedHomes(db: Db, scope: TenantScope, deps: SavedHomeWatchDeps = {}): Promise<SavedHomeWatchStats> {
  const now = deps.now ?? new Date()
  const stats: SavedHomeWatchStats = {
    scope: scope.kind === "tenant" ? `tenant ${scope.brokerageId}` : `platform (${scope.reason})`,
    scanned: 0, skipped: { manual: 0, noContact: 0 },
    verified: { tenant_listing: 0, idx_mls: 0, rentcast_listing: 0, buyer_url: 0 }, verifiedTotal: 0,
    holds: {}, changes: {}, changesTotal: 0, delivered: 0, arbiterHeld: 0, replayed: 0,
    meteredRecheck: { brokerages: 0, wantedRows: 0, allowedRows: 0, heldRows: 0, usdPlanned: 0, reasons: [] },
    errors: [],
  }
  const query = db.from("saved_properties").select(SAVED_HOME_WATCH_COLUMNS).eq("dismissed", false).limit(SAVED_HOME_WATCH_MAX_ROWS)
  applyTenantScope(query, scope)
  const { data, error } = await query
  if (error) { stats.errors.push(`saved_properties read refused: ${error.message} — nothing verified`); return stats }
  const rows = ((data ?? []) as SavedHomeWatchRow[]).filter((r) => r.dismissed !== true)
  stats.scanned = rows.length

  const byBrokerage = new Map<string, SavedHomeWatchRow[]>()
  for (const r of rows) {
    if (!r.brokerage_id || !r.contact_id) { stats.skipped.noContact += 1; continue }
    const list = byBrokerage.get(r.brokerage_id) ?? []
    list.push(r)
    byBrokerage.set(r.brokerage_id, list)
  }

  const unitUsd = deps.unitUsd ?? (await import("@/lib/property/rentcast")).RENTCAST_USD_PER_REQUEST
  for (const [brokerageId, list] of byBrokerage) {
    const metered: SavedHomeWatchRow[] = []
    for (const row of list) {
      const origin = savedHomeOrigin(row)
      const source = verificationSourceFor(origin)
      try {
        if (!source) { stats.skipped.manual += 1; continue }
        if (source === "tenant_listing") { await settleVerification(db, row, await (deps.readTenantListing ?? defaultReadTenantListing)(db, row, now), deps, stats); continue }
        if (source === "idx_mls") {
          // EVALUATED — NOT IMPLEMENTED: lib/idxbroker-client.ts offers the FEATURED set (/clients/featured) and a free-text
          // search only; a saved IDX home outside the featured set cannot be read by its id, and "not featured" is not a
          // status. Held by name until the client gains a listing-by-id read. No spend, no guess.
          await stampHold(db, row, "idx_by_id_unavailable", "the IDX client has no listing-by-id read; absence from the featured set is not a status change", stats)
          continue
        }
        metered.push(row)
      } catch (e) {
        stats.errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (metered.length === 0) continue

    stats.meteredRecheck.brokerages += 1
    stats.meteredRecheck.wantedRows += metered.length
    let plan: MeteredRecheckPlan
    try {
      const plans = await (deps.loadPlans ?? defaultLoadPlans)(db, brokerageId)
      const capLeft = await (deps.platformCapRemainingUsd ?? defaultPlatformCapRemaining)(db, brokerageId, now)
      plan = await planMeteredRecheck({ brokerageId, want: metered.length, plans, spentSinceApproval: (since) => (deps.spentSinceApproval ?? defaultSpentSinceApproval)(db, brokerageId, since), platformCapRemainingUsd: capLeft, now, unitUsd })
    } catch (e) {
      plan = { allowed: 0, held: metered.length, reason: `metered re-read gate threw: ${e instanceof Error ? e.message : String(e)}`, approval: { allowed: false, planId: null, maxSpendUsd: null, approvedAt: null, reason: "gate threw" }, backpressure: null, unitUsd }
    }
    stats.meteredRecheck.allowedRows += plan.allowed
    stats.meteredRecheck.heldRows += plan.held
    stats.meteredRecheck.usdPlanned += Math.round(plan.allowed * unitUsd * 100) / 100
    if (plan.reason) stats.meteredRecheck.reasons.push(`${brokerageId}: ${plan.reason}`)

    if (plan.held > 0) {
      // NEVER A SILENT POLL: once per tenant per day the ledger says the re-read was held and why (the cycle key dedupes).
      const r = await recordNonAction({
        brokerageId, domain: "saved_home_recheck", decision: "do_nothing",
        actor: { type: "manager", managerKey: "shopping_agent" }, subject: { type: "brokerage", id: brokerageId },
        reasonCode: "WAIT_COOLDOWN", reasonDetail: (plan.reason ?? "metered re-read held").slice(0, 500),
        cycle: `saved_home_recheck:${brokerageId}:${now.toISOString().slice(0, 10)}`, systemSource: "saved_home_watch", channel: "portal",
        detail: { wanted: metered.length, allowed: plan.allowed, held: plan.held, approval: plan.approval, backpressure: plan.backpressure, unit_usd: unitUsd, source: SAVED_HOME_RECHECK_SOURCE },
      }, { client: db })
      if (!r.recorded && r.error) stats.errors.push(`${brokerageId}: held re-read not ledgered: ${r.error}`)
    }

    const reason: SavedHomeHoldReason = plan.approval.allowed ? "metered_recheck_throttled" : "metered_recheck_unapproved"
    for (let i = 0; i < metered.length; i++) {
      const row = metered[i]
      try {
        if (i >= plan.allowed) { await stampHold(db, row, reason, plan.reason ?? "metered re-read held", stats); continue }
        const origin = savedHomeOrigin(row)
        const v = origin === "rentcast_listing"
          ? await (deps.readRentcastListing ?? defaultReadRentcastListing)(row, now)
          : await (deps.readByAddress ?? defaultReadByAddress)(row, now)
        await settleVerification(db, row, v, deps, stats)
      } catch (e) {
        stats.errors.push(`${row.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
  }
  return stats
}
