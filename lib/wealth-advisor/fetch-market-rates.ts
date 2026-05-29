// lib/wealth-advisor/fetch-market-rates.ts
//
// Real mortgage-rate feed for the Wealth Advisor. Source: Freddie Mac PMMS,
// published weekly via the St. Louis Fed (FRED) public CSV download — no API
// key required. Series:
//   MORTGAGE30US — 30-year fixed
//   MORTGAGE15US — 15-year fixed
// 5/1 ARM and jumbo are not freely published on FRED; left null.
//
// The parser is split out (parseFredLatestPercent) so it can be unit-tested
// without a network call.

import { callConnector } from "@/lib/agentic-os/connector-gateway"

const FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id="

export interface FetchedMarketRate {
  rate30yrFixedBps: number
  rate15yrFixedBps: number | null
  rateDate: string // ISO date (YYYY-MM-DD) of the latest 30yr observation
  source: string
}

/**
 * Parses a FRED single-series CSV and returns the most recent numeric
 * observation as a percent (e.g. 6.66), plus its date. Returns null when no
 * usable row exists (FRED uses "." for missing values). Pure — no I/O.
 */
export function parseFredLatestPercent(
  csv: string,
): { percent: number; date: string } | null {
  const lines = csv.trim().split(/\r?\n/)
  if (lines.length < 2) return null
  // Walk from the bottom: the last row with a real numeric value wins.
  for (let i = lines.length - 1; i >= 1; i--) {
    const cols = lines[i].split(",")
    if (cols.length < 2) continue
    const date = cols[0].trim()
    const raw = cols[1].trim()
    if (!raw || raw === ".") continue
    const percent = Number(raw)
    if (!Number.isFinite(percent) || percent <= 0) continue
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    return { percent, date }
  }
  return null
}

const percentToBps = (p: number): number => Math.round(p * 100)

async function fetchSeries(
  seriesId: string,
): Promise<{ percent: number; date: string } | null> {
  const res = await callConnector<string>({
    connector: "fred", baseUrl: "https://fred.stlouisfed.org", path: "/graph/fredgraph.csv",
    query: { id: seriesId }, method: "GET", auth: { style: "none" },
    headers: { Accept: "text/csv" }, responseType: "text",
  })
  if (!res.ok || res.data == null) {
    throw new Error(`FRED ${seriesId} returned ${res.status}`)
  }
  return parseFredLatestPercent(res.data)
}

/**
 * Fetches today's authoritative 30yr (+ 15yr) fixed rates from Freddie Mac
 * PMMS via FRED. Returns null if the 30yr series cannot be resolved (caller
 * should NOT persist a row in that case).
 */
export async function fetchFreddieMacRates(): Promise<FetchedMarketRate | null> {
  const thirty = await fetchSeries("MORTGAGE30US")
  if (!thirty) return null

  let fifteen: { percent: number; date: string } | null = null
  try {
    fifteen = await fetchSeries("MORTGAGE15US")
  } catch {
    fifteen = null // 15yr is best-effort; 30yr is the required anchor.
  }

  return {
    rate30yrFixedBps: percentToBps(thirty.percent),
    rate15yrFixedBps: fifteen ? percentToBps(fifteen.percent) : null,
    rateDate: thirty.date,
    source: "freddie_mac_pmms",
  }
}
