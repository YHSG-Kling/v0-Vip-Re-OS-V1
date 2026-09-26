// lib/lead-pipeline/source-cost-ledger.ts
//
// LEAD COST BY SOURCE — both halves of the platform ledger for scraping acquisition (lane 82B,
// wave 82; owner verbatim: "lead intelligence is information into the interaction and history of
// a person… and where they came from for lead cost tracking… These are platform-paid").
//
// WRITER — bookSourceSpend: every scrape's spend lands on vendor_usage_tracking (the PLATFORM
// ledger, brokerage-attributed for telemetry, never a tenant meter — provider-cost-routing Layer 5)
// through the ONE gateway lib/vendor-governance/meter-vendor.ts::meterVendorSpend, under
//   vendor_name = SOURCE_VENDOR's contract for the source (source-intent-map.ts::vendorForSource),
//                 or the provider that ACTUALLY served the call when the caller knows it
//                 (ZenRows vs Zyte is decided per call by scrapeSiteWithBestProvider),
//   usage_type  = the resolved SourceKey (so the ledger splits per source, not per cron block).
// A channel with no SourceKey books under its own name with `vendor_unresolved: true` in the
// metadata — never under a guessed vendor.
//
// READER — leadCostBySource (pure): folds the per-record cost the raw pipeline stamped
// (raw_scraped_leads/leads/contacts.cost_per_record, acquisition_cost preferred) by SourceKey and
// reconciles it against the ledger rows by vendor, so spend that never reached a per-lead cost
// (a ledger booking whose records were dropped, or a vendor call that returned nothing) shows up as
// `unattributedUsd` instead of silently vanishing from cost-per-lead.

import { meterVendorSpend, type MeterLogger } from "@/lib/vendor-governance/meter-vendor"
import { resolveSourceKey, vendorForSource, type ScrapeVendor } from "./source-intent-map"

export interface BookSourceSpendInput {
  /** Canonical SourceKey, alias, or the cron's sourceChannel ("zillow", "craigslist_wanted", …). */
  source: string
  cost: number
  /** The market's brokerage — attribution only; the platform pays (vendor_usage_tracking). */
  brokerageId: string | null
  marketId?: string | null
  /** The provider that actually served the call, when the caller knows it (ZenRows vs Zyte). */
  providerOverride?: string | null
  unitCount?: number
  /** Lane 83A — the door that spent (default "lead_scraping"; lead intelligence books "lead_intelligence"). */
  systemSource?: string
  /** Lane 83A — extra audit context kept beside the source keys (territory id, query, site). */
  metadata?: Record<string, unknown>
}

/** PURE — the ledger row bookSourceSpend would write (exported for the coverage guard). */
export function planSourceSpendBooking(input: BookSourceSpendInput): {
  vendorName: string
  usageType: string
  vendorUnresolved: boolean
} {
  const key = resolveSourceKey(input.source)
  const contract = vendorForSource(input.source)
  const vendorName = input.providerOverride || contract || input.source
  return { vendorName, usageType: key, vendorUnresolved: !input.providerOverride && contract === null }
}

/** Book one source's scrape spend on the platform ledger. Never throws (meterVendorSpend's contract). */
export async function bookSourceSpend(
  input: BookSourceSpendInput,
  deps: { logger?: MeterLogger } = {},
): Promise<boolean> {
  const plan = planSourceSpendBooking(input)
  return meterVendorSpend(
    {
      vendorName: plan.vendorName,
      usageType: plan.usageType,
      cost: input.cost,
      unitCount: input.unitCount,
      brokerageId: input.brokerageId,
      systemSource: input.systemSource ?? "lead_scraping",
      metadata: {
        ...(input.metadata ?? {}),
        market_id: input.marketId ?? null,
        source: input.source,
        source_key: plan.usageType,
        ...(plan.vendorUnresolved ? { vendor_unresolved: true } : {}),
      },
    },
    deps,
  )
}

// ─── READER ──────────────────────────────────────────────────────────────────

export interface SourceCostRow {
  source: string | null
  source_channel?: string | null
  cost_per_record?: number | null
  acquisition_cost?: number | null
}

export interface VendorLedgerRow {
  vendor_name: string | null
  total_cost: number | null
}

export interface LeadCostBySourceRow {
  sourceKey: string
  vendor: ScrapeVendor | null
  records: number
  /** Sum of the per-record cost the pipeline stamped (acquisition_cost preferred). */
  recordedCostUsd: number
  /** recordedCostUsd / records — 0 when no record carries a cost (never fabricated). */
  costPerRecordUsd: number
}

export interface LeadCostLedger {
  bySource: LeadCostBySourceRow[]
  byVendor: Array<{ vendor: string; ledgerUsd: number; attributedUsd: number; unattributedUsd: number }>
}

const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * PURE. Lead cost by source, reconciled to the vendor ledger. The source is resolved from
 * `source` first and falls back to `source_channel` when `source` has no SourceKey (the same rule
 * pipeline-processor.ts applies with hasScoringEntry).
 */
export function leadCostBySource(rows: readonly SourceCostRow[], ledger: readonly VendorLedgerRow[]): LeadCostLedger {
  const by = new Map<string, LeadCostBySourceRow>()
  for (const r of rows) {
    const primary = r.source ?? ""
    const viaPrimary = vendorForSource(primary)
    const raw = viaPrimary === null && r.source_channel ? r.source_channel : primary
    const key = resolveSourceKey(raw || "unknown")
    const row = by.get(key) ?? { sourceKey: key, vendor: vendorForSource(key), records: 0, recordedCostUsd: 0, costPerRecordUsd: 0 }
    row.records += 1
    row.recordedCostUsd += Number(r.acquisition_cost ?? r.cost_per_record ?? 0) || 0
    by.set(key, row)
  }
  const bySource = [...by.values()].map((r) => ({
    ...r,
    recordedCostUsd: round2(r.recordedCostUsd),
    costPerRecordUsd: r.records > 0 ? round2(r.recordedCostUsd / r.records) : 0,
  }))

  const ledgerByVendor = new Map<string, number>()
  for (const l of ledger) {
    const v = l.vendor_name ?? "unknown"
    ledgerByVendor.set(v, (ledgerByVendor.get(v) ?? 0) + (Number(l.total_cost) || 0))
  }
  const attributedByVendor = new Map<string, number>()
  for (const r of bySource) {
    const v = r.vendor ?? "unknown"
    attributedByVendor.set(v, (attributedByVendor.get(v) ?? 0) + r.recordedCostUsd)
  }
  const vendors = new Set([...ledgerByVendor.keys(), ...attributedByVendor.keys()])
  const byVendor = [...vendors].map((vendor) => {
    const ledgerUsd = round2(ledgerByVendor.get(vendor) ?? 0)
    const attributedUsd = round2(attributedByVendor.get(vendor) ?? 0)
    return { vendor, ledgerUsd, attributedUsd, unattributedUsd: round2(Math.max(0, ledgerUsd - attributedUsd)) }
  })
  return { bySource, byVendor }
}
