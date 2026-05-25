// lib/lead-pipeline/osint-sourcer.ts
// OSINT auto-source: turns territory-discovered court/public-records filings
// (divorce / probate / foreclosure / tax-lien / eviction / bankruptcy) into
// motivated-SELLER raw records. OSINT is its own vendor lane (public records),
// distinct from the direct site scrapers. Records are platform-owned at the
// raw stage; the owner (a missing contact + property address) is resolved by
// PeopleData skip-trace enrichment downstream.

import { OSINTClient, type CourtFiling } from "@/lib/osint-client"
import { isViableRecord, type NormalizedScrapedRecord } from "./raw-record-types"

export interface OsintMarket {
  city: string | null
  state: string | null
  county?: string | null
}

// Motivation score by distress type — foreclosure/divorce/probate are the
// strongest sell signals; eviction/tax-lien slightly lower but still motivated.
const MOTIVATION_BY_TYPE: Record<string, number> = {
  foreclosure: 85,
  pre_foreclosure: 82,
  divorce: 78,
  probate: 80,
  estate: 78,
  tax_lien: 72,
  bankruptcy: 70,
  eviction: 68,
}

/** Pure: court filing → canonical seller raw record. */
export function normalizeCourtFiling(filing: CourtFiling, market: OsintMarket): NormalizedScrapedRecord {
  const slug = `${filing.firstName ?? ""}-${filing.lastName ?? ""}-${filing.recordType}-${filing.caseNumber ?? ""}`
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
  return {
    sourceRecordId: `osint-${slug || Date.now()}`,
    source: "osint_signal",
    behaviorType: "osint_signal",
    intentType: "seller", // distress filings are motivated-seller signals
    intentSignals: [filing.recordType],
    firstName: filing.firstName,
    lastName: filing.lastName,
    city: market.city,
    state: market.state,
    motivationScore: MOTIVATION_BY_TYPE[filing.recordType] ?? 70,
    rawPayload: { ...filing },
  }
}

/** Fetch + normalize distressed-seller filings for a territory (real OSINT scrape). */
export async function sourceOsintRecords(
  market: OsintMarket,
): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  if (!market.state) return { records: [], cost: 0 }
  const client = new OSINTClient()
  const { filings, cost } = await client
    .searchCourtRecordsByTerritory({ county: market.county ?? market.city, state: market.state, limitPerType: 25 })
    .catch(() => ({ filings: [] as CourtFiling[], cost: 0 }))

  const records = filings
    .map((f) => normalizeCourtFiling(f, market))
    .filter(isViableRecord)
  return { records, cost }
}
