// lib/intelligence/neighborhood-future-lens.ts
//
// NEIGHBORHOOD FUTURE LENS (shine #7, real forecast — owner correction) —
// projects a ZIP's likely direction from FREE PUBLIC RECORDS the OS already
// reaches: Census ACS multi-vintage median-value appreciation + OSINT
// building-permit density (new construction/major-remodel activity =
// investment flowing in). This is the COLD-START answer too: a brand-new
// solo agent holds NO closed-deal history, so the negotiation band would be
// null — the Future Lens fills that gap with public data, clearly labeled as
// area/market data, never our own sales.
//
// HONEST by construction: every signal cites its source and its year; a
// forecast is labeled a forecast, never a fact; absent data → the signal is
// simply omitted, never invented. Pure composer; the fetch is best-effort.

import type { SupabaseClient } from "@supabase/supabase-js"
import type { CensusAppreciation } from "@/lib/external/census-appreciation"

type Svc = SupabaseClient<any, any, any>

export const PERMIT_WINDOW_DAYS = 365
export const PERMIT_HOT_COUNT = 8   // permits in the ZIP window that read as "active development"

export interface FutureLensSignals {
  zip: string
  appreciation: CensusAppreciation | null
  permitCount: number
}

export interface FutureLensRead {
  zip: string
  /** Human sentences, each self-labeled forecast-vs-fact and source-cited. */
  signals: string[]
  /** True when there is at least one real public signal (drives whether to render). */
  hasSignal: boolean
}

/** PURE: turn public signals into honest, source-cited sentences. */
export function composeFutureLens(s: FutureLensSignals): FutureLensRead {
  const out: string[] = []

  if (s.appreciation) {
    const a = s.appreciation
    const dir = a.totalPct >= 0 ? "up" : "down"
    out.push(
      `Area home values moved ${dir} about ${Math.abs(a.totalPct)}% between ${a.oldYear} and ${a.newYear} (~${a.annualPct}%/yr) — from the U.S. Census, a look back at the trend, not a promise about what's next.`,
    )
  }

  if (s.permitCount >= PERMIT_HOT_COUNT) {
    out.push(
      `${s.permitCount} building permits have been pulled nearby in the last year (public records) — active construction and remodeling usually signals investment flowing into an area.`,
    )
  } else if (s.permitCount > 0) {
    out.push(
      `A few building permits (${s.permitCount}) were pulled nearby this year — modest activity, worth watching.`,
    )
  }

  return { zip: s.zip, signals: out, hasSignal: out.length > 0 }
}

/** Load the public signals for a ZIP (Census appreciation + OSINT permit density). */
export async function loadFutureLensSignals(svc: Svc, zip: string, city: string | null, state: string | null): Promise<FutureLensSignals> {
  const { fetchCensusAppreciation } = await import("@/lib/external/census-appreciation")
  const since = new Date(Date.now() - PERMIT_WINDOW_DAYS * 86_400_000).toISOString()

  const [appreciation, permitRes] = await Promise.all([
    fetchCensusAppreciation(zip).catch(() => null),
    // Building permits flow into raw_scraped_leads via the OSINT sourcer
    // (record_type lives on the raw_data jsonb; address carries the ZIP).
    svc.from("raw_scraped_leads")
      .select("id", { count: "exact", head: true })
      .eq("raw_data->>record_type", "building_permit")
      .ilike("address", `%${zip}%`)
      .gte("created_at", since)
      .then((r: any) => r, () => ({ count: 0 })),
  ])

  return { zip, appreciation, permitCount: (permitRes as any)?.count ?? 0 }
}

/** PURE: the cold-start seller line for a NEW agent with no closed-deal band. */
export function composeColdStartBandLine(appreciation: CensusAppreciation | null): string | null {
  if (!appreciation) return null
  const dir = appreciation.totalPct >= 0 ? "risen" : "softened"
  return `Some area context while your agent builds their local sales record: home values in ${appreciation.zip} have ${dir} about ${Math.abs(appreciation.totalPct)}% since ${appreciation.oldYear} (U.S. Census — area data, not a specific-home valuation). Your agent will walk you through how this offer fits.`
}
