// lib/content-intel/search-demand-volume.ts
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A KEYWORD'S NUMBER IS (wave 154, lane 154B — directive B2 "preserve relative indexed trend values as relative,
// never convert them to literal monthly searches"; "approved keyword research provider, if configured and licensed, for
// volume estimates; otherwise label search volume as UNKNOWN").
//
// keyword_intelligence.search_volume_monthly is written today by ONE writer (lib/competitive-intel/content-intel-scan.ts)
// with two RELATIVE indexes — the Exa publish-rate interest index (source 'exa_content_scan') and the NewsAPI.ai
// social-share index (source 'newsapi_ai_social'), both 0–100 — and app/dashboard/marketing/seo/components/
// market-trends-panel.tsx rendered that number as "N searches". No licensed keyword-volume provider is configured in this
// repository (no DataForSEO / SEMrush / Ahrefs / Google Ads Keyword Planner adapter — LICENSE-HELD), so NO source yields
// a search count today. This is the ONE classifier every reader asks; a source it does not know is UNKNOWN, never a count.
//
// Pure and client-safe (the SEO panel and the server actions both import it).

export type VolumeBasisKind = "licensed_volume" | "relative_index" | "unknown"

export interface VolumeBasis {
  kind: VolumeBasisKind
  /** Plain words for the reader: what the number is (and is not). */
  label: string
}

/** Sources whose number IS an estimated monthly search count under a license on record. EMPTY until the owner licenses
 *  a keyword-volume provider (LICENSE-HELD) — adding a name here is the one switch, and it needs that license. */
export const LICENSED_VOLUME_SOURCES: readonly string[] = []

/** Sources whose number is a RELATIVE index (0–100), with what it is relative to. */
export const RELATIVE_INDEX_SOURCES: Readonly<Record<string, string>> = Object.freeze({
  exa_content_scan: "Exa content-interest index (0–100, relative — how fast this topic is being published, not searches)",
  newsapi_ai_social: "NewsAPI.ai social-share index (0–100, relative to the most-shared article in the set, not searches)",
  google_trends: "Google Trends interest (0–100, relative to the peak for this term, region and window — not a search count)",
})

function keywordVolumeBasis(source: string | null | undefined): VolumeBasis {
  const s = (source ?? "").trim()
  if (s && LICENSED_VOLUME_SOURCES.includes(s)) return { kind: "licensed_volume", label: `estimated monthly searches (${s}, licensed)` }
  const rel = s ? RELATIVE_INDEX_SOURCES[s] : undefined
  if (rel) return { kind: "relative_index", label: rel }
  return { kind: "unknown", label: "search volume unknown — no licensed volume source" }
}

export interface DisplayedVolume {
  /** A search COUNT — non-null ONLY from a licensed volume source. */
  searchCount: number | null
  /** The relative index (0–100) when the source is one; never presented as searches. */
  relativeIndex: number | null
  basis: VolumeBasis
}

/** PURE — split a stored number into what it may be shown as. A relative index never becomes a search count. */
export function displaySearchVolume(source: string | null | undefined, value: number | null | undefined): DisplayedVolume {
  const basis = keywordVolumeBasis(source)
  const v = typeof value === "number" && Number.isFinite(value) ? value : null
  if (v == null) return { searchCount: null, relativeIndex: null, basis }
  if (basis.kind === "licensed_volume") return { searchCount: v, relativeIndex: null, basis }
  if (basis.kind === "relative_index") return { searchCount: null, relativeIndex: Math.max(0, Math.min(100, v)), basis }
  return { searchCount: null, relativeIndex: null, basis }
}
