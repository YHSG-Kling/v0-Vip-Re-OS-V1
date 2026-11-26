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
  /**
   * The place the ZIP sits in, when the caller knows it. BUILT (orphan doctrine
   * §1.2) — `loadFutureLensSignals` accepted `city` and `state` from the offers
   * page and read NEITHER, so `listing.city` / `listing.state` were threaded
   * through the whole call and dropped on the floor. They had no reader; this is
   * it. Optional because the ZIP alone is still a complete signal — an absent
   * place name narrows the sentence, it never removes it.
   */
  city?: string | null
  state?: string | null
}

export interface FutureLensRead {
  zip: string
  /** Human sentences, each self-labeled forecast-vs-fact and source-cited. */
  signals: string[]
  /** True when there is at least one real public signal (drives whether to render). */
  hasSignal: boolean
}

/**
 * PURE: how the composed sentences name the place the permits were pulled in.
 * City + state when the caller knew them, city alone when the state is missing,
 * and the ZIP-neutral "nearby" when neither is known — the sentence that shipped
 * before these two values had any reader at all.
 */
function placeName(s: Pick<FutureLensSignals, "city" | "state">): string {
  const city = (s.city ?? "").trim()
  const state = (s.state ?? "").trim()
  if (city && state) return `in ${city}, ${state}`
  if (city) return `in ${city}`
  if (state) return `in ${state}`
  return "nearby"
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

  // "nearby" is what this said when the composer had no place name to use. It has
  // one now — see the city/state note on FutureLensSignals.
  const place = placeName(s)
  if (s.permitCount >= PERMIT_HOT_COUNT) {
    out.push(
      `${s.permitCount} building permits have been pulled ${place} in the last year (public records) — active construction and remodeling usually signals investment flowing into an area.`,
    )
  } else if (s.permitCount > 0) {
    out.push(
      `A few building permits (${s.permitCount}) were pulled ${place} this year — modest activity, worth watching.`,
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

  return { zip, appreciation, permitCount: (permitRes as any)?.count ?? 0, city, state }
}

/** PURE: the cold-start seller line for a NEW agent with no closed-deal band. */
export function composeColdStartBandLine(appreciation: CensusAppreciation | null): string | null {
  if (!appreciation) return null
  const dir = appreciation.totalPct >= 0 ? "risen" : "softened"
  return `Some area context while your agent builds their local sales record: home values in ${appreciation.zip} have ${dir} about ${Math.abs(appreciation.totalPct)}% since ${appreciation.oldYear} (U.S. Census — area data, not a specific-home valuation). Your agent will walk you through how this offer fits.`
}
