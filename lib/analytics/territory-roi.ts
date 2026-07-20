// lib/analytics/territory-roi.ts
// ─── SCRAPE ROI PER TERRITORY (owner round 39, rec 3) ────────────────────────
//
// Per scraping market (lead_scraping_markets): the honest acquisition funnel
//
//   raw pulled → promoted leads → converted contacts → first appointments
//
//   • raw pulled       — raw_scraped_leads rows carrying this market_id, window
//   • promoted         — those raw rows whose lead_id landed (the pipeline-
//                        processor promotion stamp; nothing reconstructed)
//   • converted        — promoted leads whose leads.contact_id is set (the real
//                        conversion write, same join source-conversion uses)
//   • first appts      — the round-38 assignment-outcomes JOIN IDIOM, mirrored:
//                        appointment-typed calendar_events on the contact/lead
//                        entity + showings.contact_id, dead statuses excluded,
//                        and only appointments strictly AFTER the lead's
//                        creation count (a pre-existing appointment was never
//                        the scrape's doing)
//
// COST — recorded, never estimated: the scraping cron meters real provider
// spend through meterVendorSpend into vendor_usage_tracking with
// request_metadata.market_id (ZenRows/Apify/Exa/Tavily/OSINT sourcers return
// per-call cost; BatchData meters through its own vendor lane without a
// market_id). A market with no metered rows shows "cost not recorded" — the
// funnel never invents a dollar figure.
//
// Funnel rates carry HONEST DENOMINATORS: each rate is null (not 0, not 100%)
// when its denominator is zero, and the label names the denominator.
//
// THE DELIBERATION FEED: when one market's recorded cost-per-promoted-lead
// diverges materially from the tenant's OTHER markets pooled (both sides at or
// above the observation floor, both with recorded cost), the AI ISA raises the
// budget argument INTO the Ads Manager's domain on the EXISTING deliberative
// 'lead_quality_spend' edge (MANAGER_COLLABORATIONS — "the CPL number and the
// qualification evidence describe the SAME dollars from two seats"; scrape
// spend per market is exactly that dispute, so the edge is REUSED, no new edge
// minted). Recency-deduped over the bus ledger per market, registered in
// REFERRAL_EMITTERS (lib/managers/cross-referral.ts).

import { activeSubscriberBrokerageIds } from "@/lib/lead-pipeline/subscription-gate"
import { raiseReferralDeduped, type SlaReferralSweepResult } from "@/lib/managers/cross-referral"

// ─── Declared constants (named in labels — never implied) ────────────────────

/** Days of scrape activity the ROI funnel grades. */
export const TERRITORY_ROI_WINDOW_DAYS = 30
/** Row cap per bounded read — a hit cap is reported, never silently truncated. */
export const TERRITORY_ROI_ROW_CAP = 5000
/** Both sides (the outlier market AND the pooled rest) need at least this many
 *  promoted leads before the cost divergence is worth arguing. */
export const TERRITORY_ROI_MIN_PROMOTED = 5
/** Material divergence: the market's cost-per-promoted-lead at/above this
 *  multiple of the tenant's other markets pooled. */
export const TERRITORY_ROI_DIVERGENCE_RATIO = 2

// ─── Shapes (fixture-friendly — the simulator drives these directly) ─────────

export interface RoiMarketInfo {
  id: string
  brokerage_id: string | null
  name: string | null
  city: string | null
  state: string | null
  is_active: boolean
}

export interface RoiRawRow {
  market_id: string | null
  /** Set when the raw record promoted (pipeline-processor writes lead_id back). */
  lead_id: string | null
}

export interface RoiLeadRow {
  id: string
  contact_id: string | null
  created_at: string | null
}

/** One appointment-outcome event — the assignment-outcomes join shape, mirrored. */
export interface RoiAppointmentEvent {
  contactId: string | null
  leadId: string | null
  at: string | null
}

export interface MarketRoiRow {
  marketId: string
  brokerageId: string | null
  label: string
  isActive: boolean
  rawPulled: number
  promoted: number
  convertedContacts: number
  firstAppointments: number
  /** promoted / rawPulled — null when nothing was pulled (denominator 0). */
  promotionRate: number | null
  /** convertedContacts / promoted — null when nothing promoted. */
  contactRate: number | null
  /** firstAppointments / convertedContacts — null when nothing converted. */
  appointmentRate: number | null
  /** Recorded provider spend (vendor_usage_tracking) — null = cost not recorded. */
  costUsd: number | null
  /** costUsd / promoted — null when cost is unrecorded or nothing promoted. */
  costPerPromotedUsd: number | null
  /** The honest cost caption ("cost not recorded" when no metered rows exist). */
  costNote: string
}

export interface TerritoryRoiReport {
  markets: MarketRoiRow[]
  totals: {
    rawPulled: number
    promoted: number
    convertedContacts: number
    firstAppointments: number
    /** Sum of RECORDED cost only; null when no market has metered spend. */
    recordedCostUsd: number | null
    marketsWithCost: number
  }
  windowDays: number
  capped: boolean
  honestNotes: string[]
  generatedAt: string
}

const round2 = (n: number) => Math.round(n * 100) / 100
const rate = (num: number, den: number): number | null => (den > 0 ? round2(num / den) : null)

export function marketLabel(m: RoiMarketInfo): string {
  const name = m.name?.trim()
  const geo = [m.city?.trim(), m.state?.trim()].filter(Boolean).join(", ")
  return name || geo || `market ${m.id.slice(0, 8)}`
}

// ─── PURE: the per-market funnel ─────────────────────────────────────────────

export function computeTerritoryRoi(
  markets: RoiMarketInfo[],
  rawRows: RoiRawRow[],
  leadRows: RoiLeadRow[],
  events: RoiAppointmentEvent[],
  costByMarket: Map<string, number>,
  opts?: { windowDays?: number; capped?: boolean },
): TerritoryRoiReport {
  const windowDays = opts?.windowDays ?? TERRITORY_ROI_WINDOW_DAYS
  const leadById = new Map(leadRows.map((l) => [l.id, l]))

  // Appointment times indexed by contact and by lead (assignment-outcomes idiom).
  const byContact = new Map<string, number[]>()
  const byLead = new Map<string, number[]>()
  for (const e of events) {
    if (!e.at) continue
    const t = new Date(e.at).getTime()
    if (!Number.isFinite(t)) continue
    if (e.contactId) byContact.set(e.contactId, [...(byContact.get(e.contactId) ?? []), t])
    if (e.leadId) byLead.set(e.leadId, [...(byLead.get(e.leadId) ?? []), t])
  }

  const rows: MarketRoiRow[] = markets.map((m) => {
    const marketRaw = rawRows.filter((r) => r.market_id === m.id)
    const promotedLeadIds = [...new Set(marketRaw.map((r) => r.lead_id).filter(Boolean))] as string[]
    let converted = 0
    let firstAppointments = 0
    for (const leadId of promotedLeadIds) {
      const lead = leadById.get(leadId)
      if (!lead?.contact_id) continue
      converted += 1
      // First appointment: any live appointment event on the contact/lead
      // strictly AFTER the lead's creation — a pre-existing appointment was
      // never the scrape's doing (the round-38 refusal, mirrored).
      const t0 = lead.created_at ? new Date(lead.created_at).getTime() : Number.NEGATIVE_INFINITY
      const ts = [
        ...(byContact.get(lead.contact_id) ?? []),
        ...(byLead.get(leadId) ?? []),
      ]
      if (ts.some((t) => t > t0)) firstAppointments += 1
    }

    const cost = costByMarket.has(m.id) ? round2(costByMarket.get(m.id) as number) : null
    const promoted = promotedLeadIds.length
    return {
      marketId: m.id,
      brokerageId: m.brokerage_id,
      label: marketLabel(m),
      isActive: m.is_active,
      rawPulled: marketRaw.length,
      promoted,
      convertedContacts: converted,
      firstAppointments,
      promotionRate: rate(promoted, marketRaw.length),
      contactRate: rate(converted, promoted),
      appointmentRate: rate(firstAppointments, converted),
      costUsd: cost,
      costPerPromotedUsd: cost != null && promoted > 0 ? round2(cost / promoted) : null,
      costNote: cost == null
        ? "cost not recorded — no metered provider spend carries this market_id"
        : promoted === 0
          ? `$${cost.toFixed(2)} recorded, nothing promoted yet`
          : `$${cost.toFixed(2)} recorded across the window`,
    }
  }).sort((a, b) => b.rawPulled - a.rawPulled || a.label.localeCompare(b.label))

  const withCost = rows.filter((r) => r.costUsd != null)
  return {
    markets: rows,
    totals: {
      rawPulled: rows.reduce((s, r) => s + r.rawPulled, 0),
      promoted: rows.reduce((s, r) => s + r.promoted, 0),
      convertedContacts: rows.reduce((s, r) => s + r.convertedContacts, 0),
      firstAppointments: rows.reduce((s, r) => s + r.firstAppointments, 0),
      recordedCostUsd: withCost.length > 0 ? round2(withCost.reduce((s, r) => s + (r.costUsd as number), 0)) : null,
      marketsWithCost: withCost.length,
    },
    windowDays,
    capped: opts?.capped === true,
    honestNotes: [
      `Funnel is the last ${windowDays} days of raw_scraped_leads per market_id; "promoted" is the raw row's own lead_id stamp — nothing is reconstructed in hindsight.`,
      "Converted = promoted leads whose contact_id landed; first appointments join ONLY where appointment data genuinely joins (appointment-typed calendar events on the contact/lead + showings, dead statuses excluded, pre-existing appointments refused) — the round-38 assignment-outcomes idiom.",
      "Cost is RECORDED provider spend (vendor_usage_tracking metered by the scraping cron with the market_id); a market without metered rows says 'cost not recorded' — no dollar figure is ever estimated.",
      "Every rate carries its honest denominator and is null (not 0%) when that denominator is zero.",
      ...(opts?.capped ? ["A read cap was hit while tallying the window — counts are floors, not totals."] : []),
    ],
    generatedAt: new Date().toISOString(),
  }
}

// ─── PURE: the cost-divergence detector (the deliberation trigger) ───────────

export interface CostDivergence {
  market: MarketRoiRow
  marketCostPerPromoted: number
  /** The tenant's OTHER markets pooled: recorded cost / promoted. */
  restCostPerPromoted: number
  restPromoted: number
  ratio: number
}

/**
 * One tenant's markets: find the market whose recorded cost-per-promoted-lead is
 * materially above the rest of the tenant's markets POOLED (recorded-cost markets
 * only, both sides at/above the promoted-lead floor). Null = no dispute — the
 * sweep never manufactures an argument (unrecorded cost can never diverge).
 */
export function findCostDivergentMarket(
  rows: MarketRoiRow[],
  opts?: { minPromoted?: number; minRatio?: number },
): CostDivergence | null {
  const minPromoted = opts?.minPromoted ?? TERRITORY_ROI_MIN_PROMOTED
  const minRatio = opts?.minRatio ?? TERRITORY_ROI_DIVERGENCE_RATIO
  const costed = rows.filter((r) => r.costUsd != null && r.promoted > 0)
  let best: CostDivergence | null = null
  for (const r of costed) {
    if (r.promoted < minPromoted || r.costPerPromotedUsd == null) continue
    const rest = costed.filter((x) => x.marketId !== r.marketId)
    const restPromoted = rest.reduce((s, x) => s + x.promoted, 0)
    const restCost = rest.reduce((s, x) => s + (x.costUsd as number), 0)
    if (restPromoted < minPromoted || restCost <= 0) continue
    const restCpp = restCost / restPromoted
    if (restCpp <= 0) continue
    const ratio = round2(r.costPerPromotedUsd / restCpp)
    if (ratio >= minRatio && (best == null || ratio > best.ratio)) {
      best = {
        market: r,
        marketCostPerPromoted: r.costPerPromotedUsd,
        restCostPerPromoted: round2(restCpp),
        restPromoted,
        ratio,
      }
    }
  }
  return best
}

// ─── IO: bounded loader (read-only; any supabase client) ─────────────────────

type AnyClient = { from: (table: string) => any }

const IN_CHUNK = 200
// The round-38 assignment-outcomes join vocabulary, mirrored (module-private there).
const APPOINTMENT_EVENT_TYPES = ["isa_appointment", "listing_appointment"]
const DEAD_APPOINTMENT_STATUSES = new Set(["cancelled", "canceled", "declined"])

async function chunkedIn<T>(
  ids: string[],
  fetchChunk: (chunk: string[]) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[] | { error: string }> {
  const out: T[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const { data, error } = await fetchChunk(ids.slice(i, i + IN_CHUNK))
    if (error) return { error: error.message }
    out.push(...(data ?? []))
  }
  return out
}

/**
 * Load + compute the ROI funnel. brokerageId scopes to one tenant (the tenant
 * card + the sweep); omitted = every market (the superadmin board). Failures
 * return an honest error, never a fabricated funnel.
 */
export async function loadTerritoryRoi(
  supabase: AnyClient,
  opts?: { brokerageId?: string; windowDays?: number },
): Promise<{ report: TerritoryRoiReport | null; error: string | null }> {
  try {
    const windowDays = opts?.windowDays ?? TERRITORY_ROI_WINDOW_DAYS
    const sinceIso = new Date(Date.now() - windowDays * 86_400_000).toISOString()
    let capped = false

    let mq = supabase.from("lead_scraping_markets")
      .select("id, brokerage_id, name, city, state, is_active")
      .limit(500)
    if (opts?.brokerageId) mq = mq.eq("brokerage_id", opts.brokerageId)
    const { data: marketRows, error: mErr } = await mq
    if (mErr) return { report: null, error: `lead_scraping_markets: ${mErr.message}` }
    const markets: RoiMarketInfo[] = ((marketRows ?? []) as any[]).map((m) => ({
      id: m.id, brokerage_id: m.brokerage_id ?? null, name: m.name ?? null,
      city: m.city ?? null, state: m.state ?? null, is_active: m.is_active === true,
    }))
    if (markets.length === 0) {
      return { report: computeTerritoryRoi([], [], [], [], new Map(), { windowDays }), error: null }
    }
    const marketIds = markets.map((m) => m.id)

    // Raw pulled + promotion stamps, per market, window-bounded.
    const rawRows = await chunkedIn<RoiRawRow>(marketIds, (chunk) =>
      supabase.from("raw_scraped_leads").select("market_id, lead_id")
        .in("market_id", chunk).gte("created_at", sinceIso).limit(TERRITORY_ROI_ROW_CAP) as any)
    if (!Array.isArray(rawRows)) return { report: null, error: `raw_scraped_leads: ${rawRows.error}` }
    if (rawRows.length >= TERRITORY_ROI_ROW_CAP) capped = true

    // Promoted leads → contact conversion.
    const promotedIds = [...new Set(rawRows.map((r) => r.lead_id).filter(Boolean))] as string[]
    const leadRows = await chunkedIn<RoiLeadRow>(promotedIds, (chunk) =>
      supabase.from("leads").select("id, contact_id, created_at").in("id", chunk).limit(IN_CHUNK) as any)
    if (!Array.isArray(leadRows)) return { report: null, error: `leads: ${leadRows.error}` }

    // Appointment events — the assignment-outcomes join idiom, mirrored:
    // appointment-typed calendar events on the contact/lead entity + showings.
    const contactIds = [...new Set(leadRows.map((l) => l.contact_id).filter(Boolean))] as string[]
    const events: RoiAppointmentEvent[] = []

    const contactCal = await chunkedIn<{ entity_id: string; start_at: string | null; status: string | null }>(contactIds, (chunk) =>
      supabase.from("calendar_events").select("entity_id, start_at, status")
        .eq("entity_type", "contact").in("event_type", APPOINTMENT_EVENT_TYPES)
        .in("entity_id", chunk).limit(IN_CHUNK * 4) as any)
    if (!Array.isArray(contactCal)) return { report: null, error: `calendar_events: ${contactCal.error}` }
    for (const e of contactCal) {
      if (DEAD_APPOINTMENT_STATUSES.has(String(e.status ?? "").toLowerCase())) continue
      events.push({ contactId: e.entity_id, leadId: null, at: e.start_at })
    }

    const leadCal = await chunkedIn<{ entity_id: string; start_at: string | null; status: string | null }>(promotedIds, (chunk) =>
      supabase.from("calendar_events").select("entity_id, start_at, status")
        .eq("entity_type", "lead").in("event_type", APPOINTMENT_EVENT_TYPES)
        .in("entity_id", chunk).limit(IN_CHUNK * 4) as any)
    if (!Array.isArray(leadCal)) return { report: null, error: `calendar_events: ${leadCal.error}` }
    for (const e of leadCal) {
      if (DEAD_APPOINTMENT_STATUSES.has(String(e.status ?? "").toLowerCase())) continue
      events.push({ contactId: null, leadId: e.entity_id, at: e.start_at })
    }

    const showingRows = await chunkedIn<{ contact_id: string; scheduled_at: string | null; scheduled_date: string | null; status: string | null }>(contactIds, (chunk) =>
      supabase.from("showings").select("contact_id, scheduled_at, scheduled_date, status")
        .in("contact_id", chunk).limit(IN_CHUNK * 4) as any)
    if (!Array.isArray(showingRows)) return { report: null, error: `showings: ${showingRows.error}` }
    for (const s of showingRows) {
      if (DEAD_APPOINTMENT_STATUSES.has(String(s.status ?? "").toLowerCase())) continue
      events.push({ contactId: s.contact_id, leadId: null, at: s.scheduled_at ?? s.scheduled_date })
    }

    // Recorded cost per market — vendor_usage_tracking rows the scraping cron
    // metered with request_metadata.market_id. Absent rows = cost not recorded.
    let cq = supabase.from("vendor_usage_tracking")
      .select("total_cost, market_id:request_metadata->>market_id")
      .not("request_metadata->>market_id", "is", null)
      .gte("created_at", sinceIso)
      .limit(TERRITORY_ROI_ROW_CAP)
    if (opts?.brokerageId) cq = cq.eq("brokerage_id", opts.brokerageId)
    const { data: costRows, error: cErr } = await cq
    if (cErr) return { report: null, error: `vendor_usage_tracking: ${cErr.message}` }
    if ((costRows ?? []).length >= TERRITORY_ROI_ROW_CAP) capped = true
    const marketIdSet = new Set(marketIds)
    const costByMarket = new Map<string, number>()
    for (const row of (costRows ?? []) as Array<{ total_cost: number | null; market_id: string | null }>) {
      if (!row.market_id || !marketIdSet.has(row.market_id)) continue
      costByMarket.set(row.market_id, (costByMarket.get(row.market_id) ?? 0) + (Number(row.total_cost) || 0))
    }

    return { report: computeTerritoryRoi(markets, rawRows, leadRows, events, costByMarket, { windowDays, capped }), error: null }
  } catch (e) {
    return { report: null, error: e instanceof Error ? e.message : "territory ROI load failed" }
  }
}

// ─── THE DELIBERATION FEED — the live raiser on 'lead_quality_spend' ─────────

/** Bound per sweep — mirrors the cross-referral sweep idiom. */
const MAX_BROKERAGES_PER_SWEEP = 25

/**
 * THE TERRITORY-ROI SWEEP (lead_quality_spend, deliberative — EDGE REUSED, not
 * minted): for every ACTIVE-subscription tenant running at least two active
 * scraping markets, compute the per-market funnel; when one market's RECORDED
 * cost-per-promoted-lead runs at/above ${TERRITORY_ROI_DIVERGENCE_RATIO}× the
 * tenant's other markets pooled (both sides ≥ the promoted-lead floor), the AI
 * ISA (conversion-evidence seat) raises the budget argument INTO the Ads
 * Manager's domain — the same "same dollars, two seats" dispute the edge
 * declares. Deduped per market over the bus ledger. Unrecorded cost never
 * argues; no divergence → no referral. Registered in REFERRAL_EMITTERS and run
 * from the manager-signals cron via runReferralSweeps.
 */
export async function publishTerritoryRoiReferrals(client?: any): Promise<SlaReferralSweepResult> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = client ?? createServiceClient()
  const result: SlaReferralSweepResult = { candidates: 0, published: 0, skippedRecent: 0, errors: [] }
  const usd = (n: number) => `$${n.toFixed(2)}`
  try {
    // Candidate tenants: active subscription (the resolver predicate, reused)
    // AND at least two active markets (one market has nothing to diverge from).
    const { data: subs, error: sErr } = await svc.from("subscriptions").select("brokerage_id, status")
    if (sErr) { result.errors.push(`subscriptions: ${sErr.message}`); return result }
    const activeIds = activeSubscriberBrokerageIds((subs ?? []) as Array<{ brokerage_id: string | null; status: string | null }>)

    const { data: marketRows, error: mErr } = await svc.from("lead_scraping_markets")
      .select("brokerage_id")
      .eq("is_active", true)
      .limit(2000)
    if (mErr) { result.errors.push(`lead_scraping_markets: ${mErr.message}`); return result }
    const activeMarketCount = new Map<string, number>()
    for (const r of (marketRows ?? []) as Array<{ brokerage_id: string | null }>) {
      if (!r.brokerage_id || !activeIds.has(r.brokerage_id)) continue
      activeMarketCount.set(r.brokerage_id, (activeMarketCount.get(r.brokerage_id) ?? 0) + 1)
    }
    const candidates = [...activeMarketCount.entries()].filter(([, n]) => n >= 2).map(([b]) => b).slice(0, MAX_BROKERAGES_PER_SWEEP)
    result.candidates = candidates.length

    for (const brokerageId of candidates) {
      try {
        const { report, error } = await loadTerritoryRoi(svc, { brokerageId })
        if (error || !report) { if (error) result.errors.push(`${brokerageId}: ${error}`); continue }
        const div = findCostDivergentMarket(report.markets)
        if (!div) continue // no material divergence (or cost unrecorded) — nothing to argue
        const res = await raiseReferralDeduped({
          brokerageId,
          fromManager: "ai_isa",
          toManager: "ads_manager",
          collabDomain: "lead_quality_spend",
          entityType: "lead_scraping_market",
          entityId: div.market.marketId,
          ask:
            `Scrape spend is diverging across territories: "${div.market.label}" cost ${usd(div.marketCostPerPromoted)} per promoted lead ` +
            `(${usd(div.market.costUsd as number)} recorded for ${div.market.promoted} promoted in ${report.windowDays}d), while your other markets pooled ` +
            `ran ${usd(div.restCostPerPromoted)} per promoted lead across ${div.restPromoted} promoted — ${div.ratio}× the rest. ` +
            `Argue the budget: shift scrape spend toward the territories that promote cheaper, or defend this market's premium with its downstream conversion evidence.`,
          payload: {
            window_days: report.windowDays,
            market_id: div.market.marketId,
            market_label: div.market.label,
            market_cost_usd: div.market.costUsd,
            market_promoted: div.market.promoted,
            market_cost_per_promoted_usd: div.marketCostPerPromoted,
            rest_cost_per_promoted_usd: div.restCostPerPromoted,
            rest_promoted: div.restPromoted,
            ratio: div.ratio,
          },
          dedupe: { sweep: "territory_roi", market_id: div.market.marketId },
        }, svc)
        if (res.skippedRecent) result.skippedRecent += 1
        else if (res.ok) result.published += 1
        else if (res.reason) result.errors.push(`${brokerageId}: ${res.reason}`)
      } catch (e) {
        result.errors.push(`${brokerageId}: ${e instanceof Error ? e.message : "sweep failed"}`)
      }
    }
  } catch (e) {
    result.errors.push(`territory-roi: ${e instanceof Error ? e.message : "sweep failed"}`)
  }
  return result
}
