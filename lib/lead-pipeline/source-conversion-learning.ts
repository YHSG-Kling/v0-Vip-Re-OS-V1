// lib/lead-pipeline/source-conversion-learning.ts
//
// SOURCE-CONVERSION LEARNER — which scrape/lead SOURCES actually convert (lead → contact → close)
// for THIS brokerage, so spend/effort flows to the winners and the money-pits get flagged. The
// scraping analog of video format_learning: a PURE scorer + a PURE recommender gated on a real
// sample, HONEST on thin data (never advises flipping a source on a handful of leads), and ADVISORY
// only — humans keep lead_scraping_markets.enabled_sources. Composes the existing source field path
// (leads.source → leads.contact_id → transactions) + cost_per_record; no new risk math, no new
// tables, and it does NOT duplicate source-intent-map (semantics) or source-analytics (live UI ROI).

/** Leads needed before a source's conversion rate is trusted (mirrors format_learning's MIN_SAMPLE). */
export const MIN_SOURCE_SAMPLE = 8
/** A source must return more than it costs to be recommended for spend. */
export const ROI_FLOOR = 1.0

export interface SourceConversionRow {
  source: string
  /** Leads from this source in the window (the denominator). */
  leadCount: number
  /** Leads that became contacts (leads.contact_id IS NOT NULL). */
  contactCount: number
  /** Contacts that reached a closed transaction. */
  closedCount: number
  /** GCI/revenue attributed to closes from this source. */
  revenue: number
  /** TENANT-paid spend attributed to this source (sum of acquisition_cost — lane 88B: never the
   *  platform-paid cost_per_record / enrichment; see LEAD_COST_PAYER). */
  spend: number
}

export interface SourceScore {
  source: string
  leadToContactRate: number
  contactToCloseRate: number
  costPerContact: number
  /** revenue / spend (null when no spend recorded). */
  roiMultiple: number | null
  /** = leadCount — the denominator for trust. */
  sampleSize: number
  trusted: boolean
  /** 0..1 blended performance, max-scaled across sources (untrusted → 0). */
  score: number
}

export interface ScoredSources {
  sources: Record<string, SourceScore>
  ranked: SourceScore[]
}

const safeRate = (num: number, den: number) => (den > 0 ? num / den : 0)

/**
 * PURE — the per-lead acquisition-cost formula (owner ruling, wave 65: "...where
 * they came from for lead cost tracking"). Three parts, each honest about
 * absence rather than fabricated as zero — and since lane 88B each has ONE
 * payer (LEAD_COST_PAYER below), so they are summed per payer, never together:
 *
 *   costPerRecord      — the raw scraped/purchased record's own cost
 *                         (raw_scraped_leads.cost_per_record → leads.cost_per_record).
 *   enrichmentSpend     — vendor spend attributed to THIS lead_id
 *                         (sum of vendor_usage_tracking.total_cost, e.g. PeopleData/OSINT).
 *   campaignCostShare   — this lead's slice of a paid campaign's budget
 *                         (ad_campaigns.lifetime_budget ÷ leads sharing campaign_attribution_id).
 *
 * Each payer's sum is null (not 0) when every one of ITS parts is null —
 * "unknown" and "free" are different facts. The old rule ("a null total tells
 * source-conversion-runner to fall back to cost_per_record") is RETIRED by lane
 * 88B: that fallback billed the platform's scrape cost to the tenant. A tenant
 * report now reads tenantPaidLeadSpend (below) and a null tenant figure is $0
 * TENANT spend, which is exactly true for a platform-sourced lead.
 */
export interface LeadAcquisitionCostParts {
  costPerRecord?: number | null
  enrichmentSpend?: number | null
  campaignCostShare?: number | null
  /** This contact's slice of a PURCHASED LIST the tenant bought and imported
   *  (lead_imports.list_cost_usd ÷ total_rows — lane 89E, m678). Tenant-paid: the
   *  list was bought with the brokerage's own money, never the platform's. */
  purchasedListShare?: number | null
}

/**
 * WHO PAYS FOR EACH PART — lane 88B, wave 88 (owner, verbatim): "spend should be what the tenant
 * spent for that lead, not what was included in their subscription like raw lead acquisition,
 * enrichment which are platform paid."
 *
 * THE ONE PAYER VOCABULARY for a lead's cost. Until this lane the three parts above were summed into
 * ONE figure (leads/contacts.acquisition_cost) and shown to the tenant as "their" lead cost — so a
 * scraped + enriched lead the tenant never paid a cent for read as a $0.82 lead on the tenant's own
 * lead page, source report and ROI, and every scraped source looked like a money pit to the tenant
 * (lib/lead-pipeline/source-conversion-runner.ts advised DISABLING it) while the platform carried
 * the cost. Ownership is decided once, in lib/providers/tenancy-matrix.ts: the scraper fleet and
 * every enrichment vendor are `platform_metered` (the platform's keys, the platform's bill).
 *
 *   costPerRecord      → PLATFORM — raw_scraped_leads/leads.cost_per_record: the metered scrape /
 *                         data-vendor pull the raw pipeline stamps (lib/kernel/scraping.ts).
 *   enrichmentSpend    → PLATFORM — vendor_usage_tracking rows booked for the person
 *                         (lib/lead-intelligence/person-spend.ts; PeopleData, BatchData, Versium…).
 *   campaignCostShare  → TENANT   — the tenant's OWN ad budget (ad_campaigns.lifetime_budget).
 *   purchasedListShare → TENANT   — the tenant's OWN purchased list (lead_imports.list_cost_usd
 *                         spread per imported row; lib/lead-import/list-cost-stamp.ts, lane 89E).
 *
 * TENANT-facing surfaces read computeLeadAcquisitionCost (→ acquisition_cost) and nothing else; the
 * PLATFORM view (superadmin — lead page when the viewer's scope is platform) reads
 * computePlatformPaidLeadCost. A new part lands here with its payer or it does not compile.
 */
const LEAD_COST_PAYER: Record<keyof Required<LeadAcquisitionCostParts>, "tenant" | "platform"> = {
  costPerRecord: "platform",
  enrichmentSpend: "platform",
  campaignCostShare: "tenant",
  purchasedListShare: "tenant",
}

function sumParts(parts: LeadAcquisitionCostParts, payer: "tenant" | "platform"): number | null {
  const values = (Object.keys(LEAD_COST_PAYER) as Array<keyof LeadAcquisitionCostParts>)
    .filter((k) => LEAD_COST_PAYER[k] === payer)
    .map((k) => parts[k])
    .filter((v): v is number => typeof v === "number" && Number.isFinite(v))
  if (values.length === 0) return null
  const total = values.reduce((sum, v) => sum + v, 0)
  // Clamp at 0 — a negative input (a data error, never a real cost) must not
  // produce a "this lead paid us" figure.
  return Math.max(0, Math.round(total * 100) / 100)
}

/** PURE — what the TENANT spent to acquire this lead (its own ad spend). The figure carried as
 *  leads/contacts.acquisition_cost and shown on every tenant surface. null = no tenant-paid part known. */
export function computeLeadAcquisitionCost(parts: LeadAcquisitionCostParts): number | null {
  return sumParts(parts, "tenant")
}

/** PURE — what the PLATFORM paid for this lead (raw acquisition + enrichment) — platform view only,
 *  never a tenant's lead cost. */
export function computePlatformPaidLeadCost(parts: LeadAcquisitionCostParts): number | null {
  return sumParts(parts, "platform")
}

/** The tenant-paid spend a TENANT report adds for one lead/contact row: acquisition_cost only — never
 *  cost_per_record (platform-paid; the old `acquisition_cost ?? cost_per_record` fallback put the
 *  platform's scrape cost on the tenant's books whenever acquisition_cost was still null). */
export function tenantPaidLeadSpend(row: { acquisition_cost?: number | null }): number {
  const v = row.acquisition_cost
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0
}

/** Pure: fold per-source outcome rows into scored, trust-gated, max-scaled performance. */
export function scoreSourceConversions(rows: SourceConversionRow[]): ScoredSources {
  const base = rows.map((r) => {
    const leadToContactRate = safeRate(r.contactCount, r.leadCount)
    const contactToCloseRate = safeRate(r.closedCount, r.contactCount)
    const roiMultiple = r.spend > 0 ? r.revenue / r.spend : null
    const trusted = r.leadCount >= MIN_SOURCE_SAMPLE
    return {
      source: r.source, leadToContactRate, contactToCloseRate,
      costPerContact: r.spend / Math.max(r.contactCount, 1),
      roiMultiple, sampleSize: r.leadCount, trusted,
    }
  })
  // Max-scale ROI across TRUSTED sources so a single outlier doesn't dominate; blend with conversion.
  const maxRoi = Math.max(1, ...base.filter((b) => b.trusted && b.roiMultiple != null).map((b) => b.roiMultiple as number))
  const scored: SourceScore[] = base.map((b) => ({
    ...b,
    score: b.trusted
      ? Math.min(1, 0.5 * b.leadToContactRate + 0.5 * ((b.roiMultiple ?? 0) / maxRoi))
      : 0, // untrusted → unknown, not "bad"
  }))
  const sources: Record<string, SourceScore> = {}
  for (const s of scored) sources[s.source] = s
  return { sources, ranked: [...scored].sort((a, b) => b.score - a.score) }
}

export interface SourceAllocation {
  /** Trusted winners worth turning ON (not already enabled). */
  enable: string[]
  /** Trusted money-pits worth turning OFF (currently enabled, ROI below floor). */
  disable: string[]
  /** Thin-sample sources — leave alone, keep gathering data (honest on thin data). */
  hold: string[]
  reasons: Record<string, string>
}

/**
 * Pure: from scored sources + the currently-enabled set, advise enable/disable/hold. The gate is
 * non-negotiable: a source is NEVER advised on/off below MIN_SOURCE_SAMPLE — it's held. Advisory
 * only; the human flips enabled_sources.
 */
export function recommendSourceAllocation(scored: ScoredSources, currentEnabled: string[]): SourceAllocation {
  const enabled = new Set(currentEnabled)
  const out: SourceAllocation = { enable: [], disable: [], hold: [], reasons: {} }
  for (const s of scored.ranked) {
    if (!s.trusted) {
      out.hold.push(s.source)
      out.reasons[s.source] = `holding — only ${s.sampleSize} leads (<${MIN_SOURCE_SAMPLE}); not enough to judge`
      continue
    }
    const roi = s.roiMultiple
    if (!enabled.has(s.source) && (roi == null || roi > ROI_FLOOR) && s.leadToContactRate >= 0.1) {
      out.enable.push(s.source)
      out.reasons[s.source] = `enable — ${Math.round(s.leadToContactRate * 100)}% lead→contact${roi != null ? `, ${roi.toFixed(1)}x ROI` : ""} on ${s.sampleSize} leads`
    } else if (enabled.has(s.source) && roi != null && roi <= ROI_FLOOR) {
      out.disable.push(s.source)
      out.reasons[s.source] = `disable — ${roi.toFixed(1)}x ROI (below ${ROI_FLOOR}x) on ${s.sampleSize} leads; it's costing more than it returns`
    } else {
      out.reasons[s.source] = enabled.has(s.source) ? "keep — performing within range" : "skip — trusted but not a clear win"
    }
  }
  return out
}
