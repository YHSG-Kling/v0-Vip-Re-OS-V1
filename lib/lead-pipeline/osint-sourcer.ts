// lib/lead-pipeline/osint-sourcer.ts
// OSINT auto-source: turns territory-discovered court/public-records filings
// (divorce / probate / foreclosure / tax-lien / eviction / bankruptcy) into
// motivated-SELLER raw records. OSINT is its own vendor lane (public records),
// distinct from the direct site scrapers. Records are platform-owned at the
// raw stage; the owner (a missing contact + property address) is resolved by
// PeopleData skip-trace enrichment downstream.

import { OSINTClient, recordTypeIntent, ALL_RECORD_TYPES, type CourtFiling } from "@/lib/osint-client"
import { isViableRecord, type NormalizedScrapedRecord } from "./raw-record-types"

export interface OsintMarket {
  city: string | null
  state: string | null
  county?: string | null
}

// Motivation score by record type — distress (seller) signals score highest;
// buyer life-events (marriage/new-mover/relocation) are solid but lower.
const MOTIVATION_BY_TYPE: Record<string, number> = {
  foreclosure: 85,
  pre_foreclosure: 82,
  divorce: 78,
  probate: 80,
  estate: 78,
  tax_lien: 72,
  bankruptcy: 70,
  eviction: 68,
  marriage: 60,
  new_mover: 58,
  relocation: 62,
  building_permit: 64,
  code_violation: 74,
  obituary: 79,
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
    // Distress filings → seller; marriage / new-mover / relocation → buyer.
    intentType: recordTypeIntent(filing.recordType),
    intentSignals: [filing.recordType],
    firstName: filing.firstName,
    lastName: filing.lastName,
    city: market.city,
    state: market.state,
    motivationScore: MOTIVATION_BY_TYPE[filing.recordType] ?? 70,
    rawPayload: { ...filing },
  }
}

// ─── Lane 88G — which filing types a territory pays to search (cost-down) ──────
//
// The lane used to search EVERY record type (14 JS-rendered ZenRows calls per territory per run),
// including three the platform ALREADY BUYS from BatchData's recorder-sourced quickLists
// (foreclosure → notice-of-sale / active-auction, pre_foreclosure → preforeclosure / NOD / lis
// pendens, tax_lien → tax-default) and two a COURT index cannot answer at all (an obituary is not a
// court filing; a building permit is a permit-portal record — lib/external/permit-signals.ts and the
// Exa permit lane own it). The default now searches only what BatchData cannot serve, and a market
// that names court types in lead_scraping_motivated_params.signal_types (the admin "Motivated
// signals" picker) searches exactly those.

/** Court/public-record types BatchData has no quickList for — the OSINT lane's reason to exist. */
export const OSINT_ONLY_RECORD_TYPES = ["divorce", "bankruptcy", "eviction", "probate", "estate", "code_violation", "marriage", "new_mover", "relocation"] as const
/** Types BatchData's recorder quickLists already serve — skipped by default when BatchData runs. */
export const BATCHDATA_SERVED_RECORD_TYPES = ["foreclosure", "pre_foreclosure", "tax_lien"] as const

const OSINT_TYPE_ALIASES: Record<string, string> = {
  pre_probate: "probate", inherited: "probate", tax_delinquent: "tax_lien", preforeclosure: "pre_foreclosure",
  lis_pendens: "pre_foreclosure", notice_of_default: "pre_foreclosure", auction: "foreclosure",
}

/**
 * PURE. The record types one territory's OSINT run searches.
 *  • The market's signal_types that name a court record type (aliases resolved) → exactly those.
 *  • None named → OSINT_ONLY_RECORD_TYPES, plus the BatchData-served three only when BatchData is NOT
 *    running for the market (so a market without BatchData still hears about foreclosures).
 * 'obituary' and 'building_permit' are searchable ONLY when named explicitly.
 */
export function osintRecordTypesFor(
  signalTypes: readonly string[] | null | undefined,
  opts: { batchdataRuns: boolean },
): string[] {
  const valid = new Set<string>(ALL_RECORD_TYPES as readonly string[])
  const named = Array.from(new Set((signalTypes ?? [])
    .map((t) => String(t).trim().toLowerCase().replace(/[\s-]+/g, "_"))
    .map((t) => OSINT_TYPE_ALIASES[t] ?? t)
    .filter((t) => valid.has(t))))
  if (named.length > 0) return named
  return [...OSINT_ONLY_RECORD_TYPES, ...(opts.batchdataRuns ? [] : BATCHDATA_SERVED_RECORD_TYPES)]
}

/** A filing older than this is not "fresh" — the owner has usually been worked by every list buyer
 *  (researched 2026-09-28: pre-foreclosure data 30-60 days old "has already been worked"). */
export const OSINT_FILING_MAX_AGE_DAYS = 60

/** PURE. Keep a filing whose date is unknown (cannot be judged) or within the freshness window. */
export function isFreshFiling(date: string | null | undefined, nowMs: number = Date.now()): boolean {
  if (!date) return true
  const t = Date.parse(date)
  if (!Number.isFinite(t)) return true
  return nowMs - t <= OSINT_FILING_MAX_AGE_DAYS * 86_400_000
}

/** Fetch + normalize distressed-seller filings for a territory (real OSINT scrape). */
export async function sourceOsintRecords(
  market: OsintMarket,
  opts?: { recordTypes?: readonly string[] },
): Promise<{ records: NormalizedScrapedRecord[]; cost: number }> {
  if (!market.state) return { records: [], cost: 0 }
  if (opts?.recordTypes && opts.recordTypes.length === 0) return { records: [], cost: 0 }
  const client = new OSINTClient()
  const { filings, cost } = await client
    .searchCourtRecordsByTerritory({ county: market.county ?? market.city, state: market.state, limitPerType: 25, recordTypes: opts?.recordTypes })
    .catch(() => ({ filings: [] as CourtFiling[], cost: 0 }))

  const records = filings
    .filter((f) => isFreshFiling(f.date))
    .map((f) => normalizeCourtFiling(f, market))
    .filter(isViableRecord)
  return { records, cost }
}
