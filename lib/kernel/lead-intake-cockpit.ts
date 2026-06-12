// lib/kernel/lead-intake-cockpit.ts
//
// THE LEAD INTAKE COCKPIT — the Data Steward's command surface that makes the FRONT
// of the lifecycle VISIBLE and governed. It surfaces the live funnel the lead pipeline
// already runs:
//
//   raw_scraped_leads (THE GATE: lib/lead-pipeline processRawRecord — enrich + dedup +
//   territory/identity guards) → a `leads` row (ai_isa_owner=true, NO portal, NOT a
//   contact) → AI ISA qualifies → on conversion → a `contact` (leads.contact_id set,
//   portal-eligible).
//
// WHAT THIS MODULE OWNS (read-only aggregation — NO writes, NO new tables):
//   · computeFunnel — fold real raw_scraped_leads rows into the canonical funnel stages
//     (pending / gated-to-leads / unassigned_no_market / error / promoted) so the front
//     of the lifecycle is one honest count, not a guess.
//   · conversionRate / groupBySource — per-SOURCE conversion truth: raw→lead (what share
//     of a source's scraped rows the GATE promoted) and lead→contact (what share of those
//     leads the AI ISA converted to a portal-eligible contact).
//   · the REJECTION breakdown with WHY — every processing_status that is NOT 'promoted'
//     is a rejection reason (unassigned_no_market = no territory/market match; territory
//     mismatch; insufficient identity; duplicate; error), counted so the Steward sees
//     where the funnel leaks.
//   · the HOT seller-intent list — the top AI-ISA-owned leads (contact_id NULL) the
//     Listing Inventory Radar stamped ([Listing Inventory Radar] note + lead_score),
//     surfacing the score + the WHY so the Steward sees the inventory the bench found.
//
// REUSE, DO NOT REBUILD: the GATE + state machine is lib/lead-pipeline/pipeline-processor.ts
//   (ProcessingStatus). The seller-intent score is lib/kernel/listing-inventory-radar.ts
//   scoreSellerIntent, persisted on leads.notes ([Listing Inventory Radar]) + lead_score.
//   This module only READS those truths; it never re-scrapes, re-scores, or writes.
//
// NOT server-only (the simulator drives it end-to-end); never import from a client
// component. Pure helpers (computeFunnel/conversionRate/groupBySource) are Layer-1
// unit-testable; honest zeros when empty. Zero mocks.

import { createServiceClient } from "@/lib/supabase/service"

type Svc = ReturnType<typeof createServiceClient>

// ── Funnel stage taxonomy (mirrors ProcessingStatus on raw_scraped_leads) ────────
//
// The pipeline-processor state machine writes processing_status on every raw row. We
// fold the granular machine into the FOUR surfaces the Steward governs: still-in-flight
// (pending/processing/enriching/…), GATE-REJECTED (the guards that stopped a row before
// promotion), PROMOTED (became a `leads` row), and ERROR. 'promoted' is the only success.

/** The buckets the cockpit funnel rolls every raw row into. */
export type FunnelStage = "pending" | "promoted" | "rejected" | "error"

/** Every raw processing_status that means "the GATE stopped this row" — each is a
 *  rejection REASON the Steward can act on. Kept verbatim from ProcessingStatus so the
 *  reason text is the pipeline's own truth, not a relabel. */
export const REJECTION_STATUSES = [
  "unassigned_no_market",
  "territory_mismatch",
  "insufficient_contact_data",
  "insufficient_identity",
  "insufficient_identity_for_promotion",
  "duplicate_pre_enrich",
  "duplicate_post_enrich",
] as const

export type RejectionStatus = (typeof REJECTION_STATUSES)[number]

/** The in-flight statuses — the row entered the pipeline but hasn't reached a terminal
 *  (promoted / rejected / error) state yet. */
export const PENDING_STATUSES = [
  "pending",
  "processing",
  "queued_for_enrichment",
  "enriching",
] as const

/** Human-readable WHY for each rejection reason (the Steward's plain-language label). */
export const REJECTION_REASON_LABEL: Record<string, string> = {
  unassigned_no_market: "No territory/market match (no owning brokerage)",
  territory_mismatch: "Outside the scraped market's territory",
  insufficient_contact_data: "Not enough contact data to enrich",
  insufficient_identity: "No usable identity anchor",
  insufficient_identity_for_promotion: "Missing name + email/phone + verified address",
  duplicate_pre_enrich: "Duplicate of an existing lead/contact (pre-enrichment)",
  duplicate_post_enrich: "Duplicate of an existing lead/contact (post-enrichment)",
}

// ── Shapes ───────────────────────────────────────────────────────────────────────

/** One raw_scraped_leads row, narrowed to the fields the funnel reads. */
export interface RawRowLite {
  source: string | null
  processing_status: string | null
  lead_id: string | null
}

/** One `leads` row, narrowed to the fields the cockpit reads. */
export interface LeadRowLite {
  source: string | null
  contact_id: string | null
  ai_isa_owner: boolean | null
  lead_score: number | null
  notes: string | null
}

/** The funnel counts across the four stages plus the rejection breakdown. */
export interface FunnelCounts {
  /** Total raw rows scanned. */
  rawTotal: number
  /** Still in-flight (pending/processing/enriching/queued). */
  pending: number
  /** Promoted into a `leads` row (the GATE's success terminal). */
  promoted: number
  /** GATE-rejected (any REJECTION_STATUS). */
  rejected: number
  /** Hit an error terminal. */
  error: number
  /** Per-reason rejection counts (status → count), zero entries omitted. */
  rejectionsByReason: Record<string, number>
}

/** Per-source conversion truth across the two funnel hops. */
export interface SourceConversion {
  source: string
  /** Raw rows scraped from this source. */
  rawCount: number
  /** Raw rows from this source the GATE promoted (processing_status='promoted'). */
  promotedCount: number
  /** Leads from this source (the promoted population, as `leads` rows). */
  leadCount: number
  /** Leads from this source that converted (contact_id set → portal-eligible). */
  convertedCount: number
  /** raw→lead conversion rate (promoted / raw), 0..1. */
  rawToLeadRate: number
  /** lead→contact conversion rate (converted / leads), 0..1. */
  leadToContactRate: number
}

/** One hot seller-intent lead currently with the AI ISA (contact_id null). */
export interface HotIntentLead {
  leadId: string
  source: string | null
  /** lead_score (the Radar floors this to the intent score ×100). */
  leadScore: number
  /** The "Why now:" reasons parsed from the [Listing Inventory Radar] note. */
  reasons: string[]
  /** The property/context line parsed from the note (best-effort, never fabricated). */
  summary: string | null
}

export interface LeadIntakeCockpitData {
  funnel: FunnelCounts
  /** raw→lead conversion across ALL sources (promoted / rawTotal). */
  overallRawToLead: number
  /** lead→contact conversion across ALL leads (converted / leadTotal). */
  overallLeadToContact: number
  /** Per-source conversion rows, sorted by rawCount desc. */
  bySource: SourceConversion[]
  /** The top hot AI-ISA-owned (non-contact) seller-intent leads. */
  hotIntent: HotIntentLead[]
  leadTotal: number
  convertedTotal: number
}

// ── PURE helpers (Layer-1 testable; no I/O) ──────────────────────────────────────

/** PURE: fold raw_scraped_leads rows into the canonical funnel counts + rejection
 *  breakdown. Every status maps to exactly one stage; unknown statuses count toward
 *  'pending' (in-flight) rather than being silently dropped. Honest zeros on []. */
export function computeFunnel(rows: RawRowLite[]): FunnelCounts {
  const rejectionSet = new Set<string>(REJECTION_STATUSES)
  const pendingSet = new Set<string>(PENDING_STATUSES)
  const counts: FunnelCounts = {
    rawTotal: rows.length,
    pending: 0,
    promoted: 0,
    rejected: 0,
    error: 0,
    rejectionsByReason: {},
  }
  for (const r of rows) {
    const status = r.processing_status ?? "pending"
    if (status === "promoted") {
      counts.promoted += 1
    } else if (status === "error") {
      counts.error += 1
    } else if (rejectionSet.has(status)) {
      counts.rejected += 1
      counts.rejectionsByReason[status] = (counts.rejectionsByReason[status] ?? 0) + 1
    } else {
      // pending/processing/enriching/queued OR any status not yet terminal → in-flight.
      counts.pending += 1
      void pendingSet // documented membership; unknown statuses are honestly "pending"
    }
  }
  return counts
}

/** PURE: a safe conversion rate (numerator / denominator) clamped to [0,1]. Honest 0
 *  when the denominator is 0 (no division by zero, no fabricated rate). */
export function conversionRate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  const rate = numerator / denominator
  if (!Number.isFinite(rate)) return 0
  return Math.max(0, Math.min(1, rate))
}

/** PURE: build per-source conversion rows from raw rows + lead rows. raw→lead is the
 *  share of a source's raw rows the GATE promoted; lead→contact is the share of that
 *  source's `leads` that converted to a contact. Sources present in either set appear;
 *  honest zeros where a hop has no population. Sorted by rawCount desc, then name. */
export function groupBySource(rawRows: RawRowLite[], leadRows: LeadRowLite[]): SourceConversion[] {
  const map = new Map<string, SourceConversion>()
  const ensure = (source: string): SourceConversion => {
    let row = map.get(source)
    if (!row) {
      row = {
        source,
        rawCount: 0,
        promotedCount: 0,
        leadCount: 0,
        convertedCount: 0,
        rawToLeadRate: 0,
        leadToContactRate: 0,
      }
      map.set(source, row)
    }
    return row
  }

  for (const r of rawRows) {
    const row = ensure(r.source ?? "(unknown)")
    row.rawCount += 1
    if (r.processing_status === "promoted") row.promotedCount += 1
  }
  for (const l of leadRows) {
    const row = ensure(l.source ?? "(unknown)")
    row.leadCount += 1
    if (l.contact_id) row.convertedCount += 1
  }

  const out = Array.from(map.values())
  for (const row of out) {
    row.rawToLeadRate = conversionRate(row.promotedCount, row.rawCount)
    row.leadToContactRate = conversionRate(row.convertedCount, row.leadCount)
  }
  out.sort((a, b) => b.rawCount - a.rawCount || a.source.localeCompare(b.source))
  return out
}

/** PURE: parse the Listing Inventory Radar note stamped on a lead into its WHY reasons
 *  + a short summary. The Radar writes a deterministic line of the form:
 *    "[Listing Inventory Radar] Seller-intent N/100 for <addr>. Why now: a; b; c. …"
 *  We read ONLY what is actually present — no fabrication; missing note → empty. */
export function parseRadarNote(notes: string | null | undefined): { reasons: string[]; summary: string | null } {
  if (!notes || !notes.includes("[Listing Inventory Radar]")) return { reasons: [], summary: null }
  // Isolate the radar line (notes can carry prior lines joined by \n).
  const line =
    notes
      .split("\n")
      .find((l) => l.includes("[Listing Inventory Radar]")) ?? notes
  // Summary = the "Seller-intent …" sentence up to "Why now:".
  const summaryMatch = line.match(/Seller-intent[^.]*\.(?:\s)?/i)
  const summary = summaryMatch ? summaryMatch[0].trim() : null
  // Reasons = the "Why now: a; b; c." clause split on ';'.
  const whyMatch = line.match(/Why now:\s*([^.]*)\./i)
  const reasons = whyMatch
    ? whyMatch[1]
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean)
    : []
  return { reasons, summary }
}

/** PURE: from the ISA-owned (non-contact) lead rows, take the top hot seller-intent
 *  leads — those carrying a [Listing Inventory Radar] note — ranked by lead_score desc,
 *  capped at `limit`. Leads without the Radar stamp are excluded (this list is the
 *  inventory the bench found, not every lead). */
export function topHotIntent(leadRows: Array<LeadRowLite & { leadId: string }>, limit = 10): HotIntentLead[] {
  const hot: HotIntentLead[] = []
  for (const l of leadRows) {
    if (l.contact_id) continue // a contact has a portal — no longer ISA-owned intake
    if (!l.notes || !l.notes.includes("[Listing Inventory Radar]")) continue
    const { reasons, summary } = parseRadarNote(l.notes)
    hot.push({
      leadId: l.leadId,
      source: l.source ?? null,
      leadScore: Number(l.lead_score ?? 0),
      reasons,
      summary,
    })
  }
  hot.sort((a, b) => b.leadScore - a.leadScore || a.leadId.localeCompare(b.leadId))
  return hot.slice(0, Math.max(0, limit))
}

// ── LIVE aggregation (read-only, tenant-scoped) ──────────────────────────────────

/**
 * loadLeadIntakeCockpit — aggregate the brokerage's front-of-lifecycle truth into the
 * cockpit shape. Reads two tables, NO writes:
 *   · raw_scraped_leads (the GATE's input + state machine) → the funnel counts +
 *     rejection breakdown + raw→lead per source.
 *   · leads (the GATE's promoted output) → lead→contact conversion per source + the
 *     hot AI-ISA-owned (contact_id null) seller-intent list (Radar note + lead_score).
 *
 * Tenant-scoped on brokerage_id. Honest empty shape when brokerageId is missing.
 */
export async function loadLeadIntakeCockpit(brokerageId: string, client?: Svc): Promise<LeadIntakeCockpitData> {
  const empty: LeadIntakeCockpitData = {
    funnel: { rawTotal: 0, pending: 0, promoted: 0, rejected: 0, error: 0, rejectionsByReason: {} },
    overallRawToLead: 0,
    overallLeadToContact: 0,
    bySource: [],
    hotIntent: [],
    leadTotal: 0,
    convertedTotal: 0,
  }
  if (!brokerageId) return empty
  const supabase = client ?? createServiceClient()

  const [rawRes, leadRes] = await Promise.all([
    supabase
      .from("raw_scraped_leads")
      .select("source, processing_status, lead_id")
      .eq("brokerage_id", brokerageId)
      .limit(5000),
    supabase
      .from("leads")
      .select("id, source, contact_id, ai_isa_owner, lead_score, notes")
      .eq("brokerage_id", brokerageId)
      .limit(5000),
  ])

  const rawRows: RawRowLite[] = ((rawRes.data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    source: (r.source as string | null) ?? null,
    processing_status: (r.processing_status as string | null) ?? null,
    lead_id: (r.lead_id as string | null) ?? null,
  }))
  const leadRows: Array<LeadRowLite & { leadId: string }> = ((leadRes.data ?? []) as Array<Record<string, unknown>>).map(
    (l) => ({
      leadId: l.id as string,
      source: (l.source as string | null) ?? null,
      contact_id: (l.contact_id as string | null) ?? null,
      ai_isa_owner: (l.ai_isa_owner as boolean | null) ?? null,
      lead_score: (l.lead_score as number | null) ?? null,
      notes: (l.notes as string | null) ?? null,
    }),
  )

  const funnel = computeFunnel(rawRows)
  const bySource = groupBySource(rawRows, leadRows)
  const leadTotal = leadRows.length
  const convertedTotal = leadRows.filter((l) => !!l.contact_id).length
  const hotIntent = topHotIntent(leadRows, 10)

  return {
    funnel,
    overallRawToLead: conversionRate(funnel.promoted, funnel.rawTotal),
    overallLeadToContact: conversionRate(convertedTotal, leadTotal),
    bySource,
    hotIntent,
    leadTotal,
    convertedTotal,
  }
}
