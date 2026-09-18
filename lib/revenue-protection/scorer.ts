/**
 * Revenue Protection Scorer
 *
 * Computes a snapshot per agent (or per brokerage) of:
 *   - Protected GCI       — pipeline dollars the AI radars are watching
 *   - Saved GCI           — dollars whose at-risk interventions were resolved
 *   - AI lift %           — counterfactual rough estimate (25 % failure baseline)
 *
 * Reads from the canonical infrastructure built in Sprints 0–1:
 *   - transactions.estimated_commission / commission_amount
 *   - deal_health_scores (latest per transaction, risk_level)
 *   - listing_health_scores (latest per listing, risk_level)
 *   - listings.list_price                      (× est listing-side rate)
 *   - proactive_interventions                  (deal saves)
 *   - listing_health_interventions             (listing saves)
 *
 * Persists to revenue_protection_snapshots (migration 1034). Designed to
 * run from the daily revenue-protection-rollup cron and produce one row
 * per (agent, snapshot_type, period_end). The latest 'quarterly' row is
 * what the dashboard hero card reads.
 *
 * Failure-baseline heuristic: every dollar of at-risk pipeline carries a
 * ~25 % implicit-failure rate without AI intervention (industry-typical
 * deal-fall-through rate for at-risk classification). This is the
 * baseline against which AI lift is measured. Tunable per brokerage in
 * a future iteration.
 */

import "server-only"
import { resolveUserIdToAgentRecord } from "@/lib/kernel/agent-identity-resolver"
import { createServiceClient } from "@/lib/supabase/service"
import { logTenantFinding } from "@/lib/kernel/tenant-guard"

// ─── Tunables ────────────────────────────────────────────────────────────────

/** No-AI baseline failure rate for at-risk deals/listings. */
const FAILURE_BASELINE = 0.25

/** Industry-default listing-side commission rate (as a percent — e.g. 2.5
 *  for 2.5 %). Only used when a listing has no paired listing_agreement
 *  row. In the canonical flow this should never happen because listings
 *  are auto-created only after the agreement passes compliance — so any
 *  use of this fallback indicates a data-integrity issue and is logged
 *  to tenant_safety_findings as a 'listing_missing_agreement' finding. */
const FALLBACK_LISTING_RATE_PCT = 2.5

// ─── Types ───────────────────────────────────────────────────────────────────

export type SnapshotType = "daily" | "weekly" | "monthly" | "quarterly" | "ytd" | "lifetime"

export interface RevenueProtectionResult {
  agentId:            string | null
  brokerageId:        string
  periodStart:        string  // YYYY-MM-DD
  periodEnd:          string

  protectedGci:       number
  atRiskDealCount:    number
  atRiskListingCount: number
  criticalGci:        number
  atRiskBySeverity:   { critical: number; at_risk: number; watch: number }

  savedGci:           number
  savesCount:         number
  avgSaveValue:       number

  noAiBaselineGci:    number
  aiLiftPct:          number

  perCategory:        Array<{ category: string; gci: number; count: number }>

  protectedGciDelta:  number | null
  savesGciDelta:      number | null
}

// ─── Date helpers ────────────────────────────────────────────────────────────

function periodRange(type: SnapshotType, ref: Date = new Date()): { start: string; end: string } {
  const y = ref.getUTCFullYear()
  const m = ref.getUTCMonth()
  const d = ref.getUTCDate()
  const iso = (date: Date): string => date.toISOString().slice(0, 10)

  switch (type) {
    case "daily": {
      const start = new Date(Date.UTC(y, m, d))
      return { start: iso(start), end: iso(start) }
    }
    case "weekly": {
      const dow = ref.getUTCDay()           // 0 = Sun
      const monday = new Date(Date.UTC(y, m, d - ((dow + 6) % 7)))
      const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6))
      return { start: iso(monday), end: iso(sunday) }
    }
    case "monthly":
      return { start: iso(new Date(Date.UTC(y, m, 1))), end: iso(new Date(Date.UTC(y, m + 1, 0))) }
    case "quarterly": {
      const qStart = m - (m % 3)
      return { start: iso(new Date(Date.UTC(y, qStart, 1))), end: iso(new Date(Date.UTC(y, qStart + 3, 0))) }
    }
    case "ytd":
      return { start: iso(new Date(Date.UTC(y, 0, 1))), end: iso(ref) }
    case "lifetime":
      return { start: "2000-01-01", end: iso(ref) }
  }
}

// ─── Main entry: compute one snapshot ─────────────────────────────────────

export async function calculateRevenueProtection(input: {
  /** If null, computes a brokerage-wide rollup; if a UUID, scoped to that agent. */
  agentId:     string | null
  brokerageId: string
  snapshotType?: SnapshotType
  referenceDate?: Date
  /** When true, write the snapshot row + return it; when false, return only. */
  persist?:    boolean
}): Promise<RevenueProtectionResult> {
  const supabase = createServiceClient()
  const snapshotType: SnapshotType = input.snapshotType ?? "quarterly"
  const { start, end } = periodRange(snapshotType, input.referenceDate ?? new Date())
  // One scan-run id ties together any tenant_safety_findings logged during
  // this rollup (e.g. listings without agreements). Lets admins trace
  // findings back to a specific scoring pass.
  const scanRunId = crypto.randomUUID()

  // ─── Protected GCI: at-risk DEALS ───────────────────────────────────────
  // Pull the most-recent deal_health_scores row per transaction in the
  // brokerage. We use a window approach via select + dedupe in JS to keep
  // this query portable (no DISTINCT ON syntax via the JS client).
  const dealHealthQuery = supabase
    .from("deal_health_scores")
    .select("transaction_id, risk_level, scored_at")
    .eq("brokerage_id", input.brokerageId)
    .in("risk_level", ["watch", "at_risk", "critical"])
    .order("scored_at", { ascending: false })
    .limit(1000)

  const { data: dealHealthRows } = await dealHealthQuery
  const latestByTransaction = new Map<string, { risk_level: string }>()
  for (const r of (dealHealthRows ?? []) as Array<{ transaction_id: string; risk_level: string }>) {
    if (!latestByTransaction.has(r.transaction_id)) {
      latestByTransaction.set(r.transaction_id, { risk_level: r.risk_level })
    }
  }
  // IDENTITY CLASS. input.agentId is a USERS id — the rollup cron reads it
  // straight out of `users` (app/api/cron/revenue-protection-rollup/route.ts)
  // and the agent dashboard passes the session's user.id. EVERY agent_id this
  // function touches FKs agents(id): transactions, listings,
  // listing_health_interventions AND revenue_protection_snapshots
  // (scripts/schema-fk-map.ts — m366 re-pointed the last two). So the users id
  // is resolved ONCE here and never used as an identity again below.
  //
  // What the previous comment at this spot got wrong, and what it cost: it
  // asserted the two snapshot tables were "users-class and correctly filtered"
  // by the users id, and scripts/identity-class-guard.ts pinned that belief as
  // an assertion. The insert at the bottom of this function therefore wrote the
  // users id into an agents(id) FK with no error read — a 23503 that supabase-js
  // RESOLVES rather than throws — so the daily cron reported snapshots_written
  // while revenue_protection_snapshots held 0 rows, and the previous-period
  // lookup filtered by the same wrong class and never found a delta.
  const agentRecordId = input.agentId
    ? await resolveUserIdToAgentRecord(input.agentId, input.brokerageId)
    : null
  // REFUSE rather than write a broken row. A per-agent call whose user has no
  // agents row in this brokerage cannot be scored: writing `agent_id: null`
  // would make the row indistinguishable from the BROKERAGE-WIDE snapshot
  // (getBrokerageRevenueProtection reads `.is("agent_id", null)`), and writing
  // the users id is the FK refusal this comment exists to remember. The cron's
  // per-agent try/catch counts this as an error instead of a snapshot.
  if (input.agentId && !agentRecordId) {
    throw new Error(
      `[revenue-protection] users id ${input.agentId} has no agents row in brokerage ${input.brokerageId}; refusing to score`,
    )
  }

  const atRiskTransactionIds = Array.from(latestByTransaction.keys())

  let atRiskDealRows: Array<{ id: string; agent_id: string | null; estimated_commission: number | null; commission_amount: number | null }> = []
  if (atRiskTransactionIds.length > 0) {
    let q = supabase
      .from("transactions")
      .select("id, agent_id, estimated_commission, commission_amount")
      .in("id", atRiskTransactionIds)
      .eq("brokerage_id", input.brokerageId)
      .not("status", "in", "(closed,cancelled,withdrawn)")
    if (agentRecordId) q = q.eq("agent_id", agentRecordId)
    const { data } = await q
    atRiskDealRows = (data ?? []) as typeof atRiskDealRows
  }

  // ─── Protected GCI: at-risk LISTINGS ────────────────────────────────────
  const listingHealthQuery = supabase
    .from("listing_health_scores")
    .select("listing_id, risk_level, scored_at")
    .eq("brokerage_id", input.brokerageId)
    .in("risk_level", ["watch", "at_risk", "critical"])
    .order("scored_at", { ascending: false })
    .limit(1000)

  const { data: listingHealthRows } = await listingHealthQuery
  const latestByListing = new Map<string, { risk_level: string }>()
  for (const r of (listingHealthRows ?? []) as Array<{ listing_id: string; risk_level: string }>) {
    if (!latestByListing.has(r.listing_id)) {
      latestByListing.set(r.listing_id, { risk_level: r.risk_level })
    }
  }
  const atRiskListingIds = Array.from(latestByListing.keys())

  let atRiskListingRows: Array<{ id: string; agent_id: string | null; list_price: number | null }> = []
  if (atRiskListingIds.length > 0) {
    let q = supabase
      .from("listings")
      .select("id, agent_id, list_price")
      .in("id", atRiskListingIds)
      .eq("brokerage_id", input.brokerageId)
      .in("status", ["active", "coming_soon"])
    if (agentRecordId) q = q.eq("agent_id", agentRecordId)
    const { data } = await q
    atRiskListingRows = (data ?? []) as typeof atRiskListingRows
  }

  // ─── Saved GCI: resolved interventions in period ────────────────────────
  let dealSavesQuery = supabase
    .from("proactive_interventions")
    .select("transaction_id, severity, resolved_at, issue_detected")
    .eq("brokerage_id", input.brokerageId)
    .eq("resolved", true)
    .gte("resolved_at", `${start}T00:00:00Z`)
    .lte("resolved_at", `${end}T23:59:59Z`)
  const { data: dealSaves } = await dealSavesQuery

  let listingSavesQuery = supabase
    .from("listing_health_interventions")
    .select("listing_id, severity, resolved_at, category")
    .eq("brokerage_id", input.brokerageId)
    .eq("resolved", true)
    .gte("resolved_at", `${start}T00:00:00Z`)
    .lte("resolved_at", `${end}T23:59:59Z`)
  // listing_health_interventions.agent_id FKs agents(id) — the resolved id, not the users id.
  if (agentRecordId) listingSavesQuery = listingSavesQuery.eq("agent_id", agentRecordId)
  const { data: listingSaves } = await listingSavesQuery

  // Hydrate saved-deal GCI by transaction lookup (need estimated_commission)
  const savedDealIds = Array.from(new Set(((dealSaves ?? []) as Array<{ transaction_id: string }>)
    .map((r) => r.transaction_id)
    .filter(Boolean)))
  const savedDealGci = new Map<string, { gci: number; agent_id: string | null }>()
  if (savedDealIds.length > 0) {
    let q = supabase
      .from("transactions")
      .select("id, agent_id, estimated_commission, commission_amount")
      .in("id", savedDealIds)
      .eq("brokerage_id", input.brokerageId)
    if (agentRecordId) q = q.eq("agent_id", agentRecordId)
    const { data: rows } = await q
    for (const r of (rows ?? []) as Array<{ id: string; agent_id: string | null; estimated_commission: number | null; commission_amount: number | null }>) {
      const gci = Number(r.commission_amount ?? r.estimated_commission ?? 0)
      savedDealGci.set(r.id, { gci, agent_id: r.agent_id ?? null })
    }
  }
  // Hydrate saved-listing GCI via the same contracted-rate resolver.
  const savedListingIds = Array.from(new Set(((listingSaves ?? []) as Array<{ listing_id: string }>)
    .map((r) => r.listing_id)
    .filter(Boolean)))
  const savedListingGci = new Map<string, { gci: number; agent_id: string | null }>()
  if (savedListingIds.length > 0) {
    let q = supabase
      .from("listings")
      .select("id, agent_id, list_price")
      .in("id", savedListingIds)
      .eq("brokerage_id", input.brokerageId)
    if (agentRecordId) q = q.eq("agent_id", agentRecordId)
    const { data: rows } = await q
    const savedListings = (rows ?? []) as Array<{ id: string; agent_id: string | null; list_price: number | null }>
    const resolved = await resolveListingGci(
      supabase,
      savedListings.map((r) => ({ id: r.id, list_price: r.list_price })),
      input.brokerageId,
      scanRunId,
    )
    for (const r of savedListings) {
      savedListingGci.set(r.id, {
        gci:      resolved.get(r.id) ?? 0,
        agent_id: r.agent_id ?? null,
      })
    }
  }

  // ─── Rollups ────────────────────────────────────────────────────────────
  const bySeverity = { critical: 0, at_risk: 0, watch: 0 }
  const categoryMap = new Map<string, { gci: number; count: number }>()
  let protectedGci = 0
  let criticalGci = 0

  for (const d of atRiskDealRows) {
    const tier = latestByTransaction.get(d.id)?.risk_level ?? "watch"
    const gci = Number(d.commission_amount ?? d.estimated_commission ?? 0)
    protectedGci += gci
    if (tier === "critical") criticalGci += gci
    if (tier === "critical" || tier === "at_risk" || tier === "watch") {
      bySeverity[tier as keyof typeof bySeverity] += gci
    }
    addCategory(categoryMap, "deal", gci)
  }

  // Resolve listing-side GCI per at-risk listing from listing_agreements
  // (the contracted rate signed by agent + seller). Logs a finding for any
  // listing without a matching agreement.
  const atRiskListingGci = await resolveListingGci(
    supabase,
    atRiskListingRows.map((l) => ({ id: l.id, list_price: l.list_price })),
    input.brokerageId,
    scanRunId,
  )

  for (const l of atRiskListingRows) {
    const tier = latestByListing.get(l.id)?.risk_level ?? "watch"
    const gci = atRiskListingGci.get(l.id) ?? 0
    protectedGci += gci
    if (tier === "critical") criticalGci += gci
    if (tier === "critical" || tier === "at_risk" || tier === "watch") {
      bySeverity[tier as keyof typeof bySeverity] += gci
    }
    addCategory(categoryMap, "listing", gci)
  }

  // Saves: count + total saved GCI; AVG = savedGci / savesCount
  let savedGci = 0
  let savesCount = 0

  // `info.agent_id` is transactions.agent_id / listings.agent_id — an agents(id).
  // These two comparisons used to test it against input.agentId (the users id),
  // which is NEVER equal, so the per-agent arm counted ZERO saves even when the
  // queries above had already been correctly narrowed to agentRecordId.
  for (const s of (dealSaves ?? []) as Array<{ transaction_id: string; severity?: string }>) {
    const info = savedDealGci.get(s.transaction_id)
    if (!info) continue
    if (agentRecordId && info.agent_id !== agentRecordId) continue
    savedGci += info.gci
    savesCount += 1
    addCategory(categoryMap, "saved_deal", info.gci)
  }
  for (const s of (listingSaves ?? []) as Array<{ listing_id: string; severity?: string; category?: string | null }>) {
    const info = savedListingGci.get(s.listing_id)
    if (!info) continue
    if (agentRecordId && info.agent_id !== agentRecordId) continue
    savedGci += info.gci
    savesCount += 1
    addCategory(categoryMap, s.category ?? "saved_listing", info.gci)
  }

  const noAiBaselineGci = protectedGci * (1 - FAILURE_BASELINE) + savedGci * (1 - FAILURE_BASELINE)
  const aiLiftPct = noAiBaselineGci > 0 ? ((protectedGci + savedGci - noAiBaselineGci) / noAiBaselineGci) * 100 : 0

  // Find previous-period snapshot (if any) to compute deltas
  let previousSnapshotId: string | null = null
  let protectedGciDelta: number | null = null
  let savesGciDelta: number | null = null
  if (agentRecordId) {
    const { data: prev, error: prevError } = await supabase
      .from("revenue_protection_snapshots")
      .select("id, protected_gci, saved_gci")
      .eq("agent_id", agentRecordId)
      .eq("snapshot_type", snapshotType)
      .lt("period_end", end)
      .order("period_end", { ascending: false })
      .limit(1)
      .maybeSingle()
    // A refused read is not "no previous period". Say so; the deltas stay null.
    if (prevError) {
      console.error(`[revenue-protection] previous-snapshot lookup refused for agent ${agentRecordId}:`, prevError.message)
    }
    if (prev) {
      previousSnapshotId = (prev.id as string | null) ?? null
      protectedGciDelta = Math.round(protectedGci - Number(prev.protected_gci ?? 0))
      savesGciDelta     = Math.round(savedGci     - Number(prev.saved_gci ?? 0))
    }
  }

  const result: RevenueProtectionResult = {
    agentId:            input.agentId,
    brokerageId:        input.brokerageId,
    periodStart:        start,
    periodEnd:          end,
    protectedGci:       Math.round(protectedGci),
    atRiskDealCount:    atRiskDealRows.length,
    atRiskListingCount: atRiskListingRows.length,
    criticalGci:        Math.round(criticalGci),
    atRiskBySeverity:   {
      critical: Math.round(bySeverity.critical),
      at_risk:  Math.round(bySeverity.at_risk),
      watch:    Math.round(bySeverity.watch),
    },
    savedGci:           Math.round(savedGci),
    savesCount,
    avgSaveValue:       savesCount > 0 ? Math.round(savedGci / savesCount) : 0,
    noAiBaselineGci:    Math.round(noAiBaselineGci),
    aiLiftPct:          Math.round(aiLiftPct * 10) / 10,
    perCategory:        Array.from(categoryMap.entries()).map(([category, v]) => ({
      category, gci: Math.round(v.gci), count: v.count,
    })),
    protectedGciDelta,
    savesGciDelta,
  }

  if (input.persist !== false) {
    // revenue_protection_snapshots.agent_id FKs agents(id). NULL is the
    // brokerage-wide row; a per-agent call has already refused above if it
    // could not resolve, so `agentRecordId` is exactly `input.agentId`'s class-
    // correct twin here. The error is READ: a swallowed 23503 is how this table
    // stayed empty for weeks while the cron counted snapshots.
    const { error: insertError } = await supabase.from("revenue_protection_snapshots").insert({
      agent_id:              agentRecordId,
      brokerage_id:          input.brokerageId,
      snapshot_type:         snapshotType,
      period_start:          start,
      period_end:            end,
      protected_gci:         result.protectedGci,
      at_risk_deal_count:    result.atRiskDealCount,
      at_risk_listing_count: result.atRiskListingCount,
      critical_gci:          result.criticalGci,
      at_risk_by_severity:   result.atRiskBySeverity,
      saved_gci:             result.savedGci,
      saves_count:           result.savesCount,
      avg_save_value:        result.avgSaveValue,
      no_ai_baseline_gci:    result.noAiBaselineGci,
      ai_lift_pct:           result.aiLiftPct,
      per_category:          result.perCategory,
      previous_snapshot_id:  previousSnapshotId,
      protected_gci_delta:   result.protectedGciDelta,
      saves_gci_delta:       result.savesGciDelta,
    })
    if (insertError) {
      throw new Error(
        `[revenue-protection] snapshot insert refused for brokerage ${input.brokerageId}, agent ${agentRecordId ?? "brokerage-wide"}: ${insertError.message}`,
      )
    }
  }

  return result
}

function addCategory(map: Map<string, { gci: number; count: number }>, key: string, gci: number) {
  const existing = map.get(key) ?? { gci: 0, count: 0 }
  existing.gci += gci
  existing.count += 1
  map.set(key, existing)
}

// ─── Listing GCI resolver ───────────────────────────────────────────────────
//
// The canonical flow: a listing is created only after the listing_agreement
// passes compliance, which means every listing_id has a paired
// listing_agreements row carrying the seller-contracted rate.
//
// resolveListingGci returns the listing-side GCI per listing_id by:
//   1. preferring listing_agreements.commission_flat_amount when set
//      (flat-fee listings — the dollar amount IS the GCI)
//   2. else listing_agreements.listing_commission_rate × list_price / 100
//      (rates are stored as percent values, e.g. 3 for 3 %, per the
//      seller-cma.ts default of `?? 3`)
//   3. fallback: list_price × FALLBACK_LISTING_RATE_PCT / 100 AND log a
//      tenant_safety_findings row with finding_type='listing_missing_
//      agreement' so the admin panel surfaces the data-integrity issue

interface ListingForGci { id: string; list_price: number | null }

async function resolveListingGci(
  supabase: ReturnType<typeof createServiceClient>,
  listings: ListingForGci[],
  brokerageId: string,
  scanRunId: string,
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (listings.length === 0) return out

  const listingIds = listings.map((l) => l.id)
  const { data: agreements } = await supabase
    .from("listing_agreements")
    .select("listing_id, listing_commission_rate, commission_flat_amount, total_commission_rate")
    .in("listing_id", listingIds)
    .eq("brokerage_id", brokerageId)

  const byListingId = new Map<string, { rate: number | null; flat: number | null; totalRate: number | null }>()
  for (const a of (agreements ?? []) as Array<{
    listing_id: string
    listing_commission_rate: number | null
    commission_flat_amount: number | null
    total_commission_rate: number | null
  }>) {
    byListingId.set(a.listing_id, {
      rate: a.listing_commission_rate,
      flat: a.commission_flat_amount,
      totalRate: a.total_commission_rate,
    })
  }

  for (const l of listings) {
    const agreement = byListingId.get(l.id)
    const listPrice = Number(l.list_price ?? 0)

    if (!agreement) {
      // Data-integrity violation: a listing exists with no agreement, but
      // compliance is supposed to gate listing creation on the agreement
      // being fully executed. Log + fall back.
      await logTenantFinding({
        scanRunId,
        findingType: "listing_missing_agreement",
        tableName:   "listings",
        severity:    "critical",
        details:     { listing_id: l.id, brokerage_id: brokerageId, list_price: listPrice, source: "revenue_protection_scorer" },
      })
      out.set(l.id, listPrice * (FALLBACK_LISTING_RATE_PCT / 100))
      continue
    }

    // Flat-fee listing — the dollar amount is the listing-side GCI directly.
    if (agreement.flat != null && agreement.flat > 0) {
      out.set(l.id, Number(agreement.flat))
      continue
    }

    // Standard percent commission. Rates stored as percent values (3 = 3 %).
    const rate =
      agreement.rate != null && agreement.rate > 0
        ? Number(agreement.rate)
        // Fall through to industry default rather than total_commission_rate;
        // total includes the buyer side which isn't the listing agent's GCI.
        : FALLBACK_LISTING_RATE_PCT

    out.set(l.id, listPrice * (rate / 100))
  }

  return out
}
