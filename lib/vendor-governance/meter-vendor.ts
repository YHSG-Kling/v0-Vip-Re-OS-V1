// lib/vendor-governance/meter-vendor.ts
// Unified vendor-spend gateway. Every outbound DATA-vendor call (scrapers, property
// data, enrichment) records its cost through this single chokepoint into
// vendor_usage_tracking — the platform's single source of truth for vendor spend.
// (AI model calls go through the Vercel AI Gateway separately; this is for the
// non-AI REST vendors: ZenRows, Apify, BatchData, Tavily, Exa, OSINT, RentCast.)
//
// The logger is injectable so the metering decision is unit-testable without a DB.

import { logVendorUsage, type VendorUsageEvent, type UsageLogResult } from "./usage-logger"

export type MeterLogger = (event: VendorUsageEvent) => Promise<UsageLogResult>

export interface MeterVendorInput {
  vendorName: string
  usageType: string
  /** USD cost for this call (skipped when <= 0 — no spend, nothing to record). */
  cost: number
  unitCount?: number
  brokerageId?: string | null
  systemSource?: string
  metadata?: Record<string, any>
}

/**
 * Record a vendor call's spend. No-ops (returns false) when there's no cost or no
 * owning brokerage — platform-anonymous zero-cost calls don't pollute the ledger.
 * Never throws; metering must never break the calling flow.
 */
export async function meterVendorSpend(
  input: MeterVendorInput,
  deps: { logger?: MeterLogger } = {},
): Promise<boolean> {
  if (!input.cost || input.cost <= 0) return false
  if (!input.brokerageId) return false
  const logger = deps.logger ?? logVendorUsage
  try {
    const res = await logger({
      vendorName: input.vendorName,
      usageType: input.usageType,
      unitCount: input.unitCount ?? 1,
      estimatedCost: input.cost,
      systemSource: input.systemSource ?? "lead_scraping",
      brokerageId: input.brokerageId,
      metadata: input.metadata,
    })
    return !!res.success
  } catch {
    return false
  }
}

/** Maps a cron scraper_type to the canonical vendor name recorded in the ledger. */
export function scraperTypeToVendor(scraperType: string): string {
  switch (scraperType) {
    case "zillow_behavior": return "zenrows"
    case "batchdata_motivated": return "batchdata"
    case "social_intent": return "apify_social" // composite: apify + exa + tavily
    case "osint_signal": return "osint"
    default: return scraperType
  }
}
