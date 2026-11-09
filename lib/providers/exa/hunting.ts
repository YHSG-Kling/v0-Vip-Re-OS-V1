// lib/providers/exa/hunting.ts
// ─────────────────────────────────────────────────────────────────────────────
// EXA AS A HUNTING AND PERSON-DISCOVERY SURFACE (wave 151, lane 151D).
//
// Owner correction (2026-11-09, verbatim): "exa is to find people when it is a scraper or hunting."
// This REVERSES THE SCOPE (not the mechanics) of wave-150 ruling R9 ("Exa for public-market research,
// never for people"): lib/lead-pipeline/exa-sourcer.ts stays exactly what R9 made it — the cited
// public-MARKET research lane whose rows never walk toward the Lead door. Person and entity DISCOVERY
// now lives here, under rules the research lane never needed:
//
//   · GROUNDED EVIDENCE — every candidate or event carries its source URL, the page's published date,
//     the retrieval time and a short QUOTED basis (≤ 280 chars; Exa returns pages it does not license
//     for reuse — an excerpt is all that is kept).
//   · SOURCE RIGHTS per page class (sourceRightsForUrl) — an official record, an owner-published
//     listing, a classified "wanted" post, a forum, a news page. A forum's AUTHOR may be answered only
//     through a contact point THEY published for that purpose and only where the site's terms allow
//     it; the CHANNEL itself is never messaged merely because the content was public.
//   · FRESHNESS — a request older than its play's window is not current evidence.
//   · IDENTITY — a name alone never joins two records (lib/acquisition-plays/contract.ts
//     personCandidateProblem / nameOnlyJoinProblem); property ↔ owner only through
//     lib/identity/subject-identity.ts verifyOwnership (two authoritative sources or a matching
//     mailing address).
//
// THE PROVIDER KEY IS WAITING_EXTERNAL BY NAME ONLY (EXA_API_KEY): productionExaHuntClient hands
// back null without it, and every hunting function given null says "provider_unconfigured" and
// returns ZERO results — nothing is ever invented in the key's absence. Proofs inject an ExaHuntClient.
//
// ONE ADAPTER (LAW 2): every live call is lib/providers/exa/client.ts (the official exa-js adapter);
// the row normalizer is lib/external/exa-client.ts normalizeExaRow (one Exa row vocabulary).
//
// CHEAPEST ADEQUATE METHOD: a structured `/search` (list price $7 / 1k requests incl. 10 results —
// exa-client.ts) over the open web with a JSON-schema summary; Search Monitors (lib/providers/exa/
// monitors.ts) replace REPEATED searches with pushed deltas. `/research` is not used by any play.

import { normalizeExaRow, type ExaResult } from "@/lib/external/exa-client"

const DAY_MS = 86_400_000

/** One Exa result as the hunting path reads it: the normalized row + the schema-shaped extraction + its publisher. */
export interface ExaHuntResult extends ExaResult {
  /** The JSON the structured summary returned (schema fields), or null when the summary was prose / absent. */
  extracted: Record<string, unknown> | null
  publisher: string | null
}

const hostOf = (url: string | null): string | null => {
  try { return url ? new URL(url).hostname.replace(/^www\./, "").toLowerCase() : null } catch { return null }
}

function parseExtraction(summary: unknown): Record<string, unknown> | null {
  if (summary && typeof summary === "object" && !Array.isArray(summary)) return summary as Record<string, unknown>
  if (typeof summary !== "string") return null
  const s = summary.trim()
  if (!s.startsWith("{")) return null
  try {
    const v = JSON.parse(s) as unknown
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch { return null }
}

/** PURE — a raw Exa row (search result or a monitor run's result) → ExaHuntResult. The ONE row normalizer is reused. */
export function normalizeExaHuntRow(r: Record<string, unknown>): ExaHuntResult {
  const base = normalizeExaRow(r)
  return { ...base, extracted: parseExtraction(r.summary), publisher: hostOf(base.url) }
}

export interface ExaHuntSearch {
  /** A stable key for the search (counts, monitors, ledger detail). */
  key: string
  query: string
  numResults?: number
  /** Only pages published inside this window (Exa `startPublishedDate`) — hunting is time-sensitive. */
  sinceDays?: number
  includeDomains?: string[]
  excludeDomains?: string[]
  category?: string
  schema?: Record<string, unknown> | null
}

export interface ExaHuntResponse {
  ok: boolean
  results: ExaHuntResult[]
  costUsd: number
  costBasis: "final" | "estimated" | "none"
  error: string | null
}

/** The seam every play hunts through. Production: productionExaHuntClient; proofs: a fixture. */
export interface ExaHuntClient {
  search(s: ExaHuntSearch, now: Date): Promise<ExaHuntResponse>
}

/**
 * The live client — null when EXA_API_KEY is absent (WAITING_EXTERNAL by name). The key never leaves this closure.
 * Cost: the provider's own `costDollars.total` when present (final), else the published list price (estimated).
 */
export function productionExaHuntClient(env: Record<string, string | undefined> = process.env): ExaHuntClient | null {
  const apiKey = env.EXA_API_KEY
  if (!apiKey) return null
  return {
    async search(s, now) {
      const { structuredSearch } = await import("@/lib/providers/exa/client")
      const { exaSearchListCost } = await import("@/lib/external/exa-client")
      const since = s.sinceDays && s.sinceDays > 0 ? new Date(now.getTime() - s.sinceDays * DAY_MS).toISOString().slice(0, 10) : undefined
      const res = await structuredSearch(apiKey, {
        query: s.query, numResults: s.numResults ?? 10, startPublishedDate: since,
        includeDomains: s.includeDomains, excludeDomains: s.excludeDomains, category: s.category, schema: s.schema ?? null,
      })
      if (!res.ok || !res.data) return { ok: false, results: [], costUsd: 0, costBasis: "none", error: res.error ?? "Exa search failed" }
      const final = typeof res.data.costDollarsTotal === "number"
      return {
        ok: true,
        results: res.data.results.map(normalizeExaHuntRow),
        costUsd: final ? (res.data.costDollarsTotal as number) : exaSearchListCost(s.numResults ?? 10),
        costBasis: final ? "final" : "estimated",
        error: null,
      }
    },
  }
}

export interface HuntOutcome {
  status: "ok" | "provider_unconfigured"
  results: ExaHuntResult[]
  bySearch: Record<string, number>
  costUsd: number
  errors: string[]
}

/** Run a territory's searches through the client; one result per page (url, else id) across every search; a null client hunts nothing. */
export async function huntTerritory(client: ExaHuntClient | null, searches: readonly ExaHuntSearch[], now: Date = new Date()): Promise<HuntOutcome> {
  if (!client) {
    return { status: "provider_unconfigured", results: [], bySearch: {}, costUsd: 0, errors: ["EXA_API_KEY is not configured — nothing was searched and nothing was invented (WAITING_EXTERNAL by name)"] }
  }
  const seen = new Set<string>()
  const results: ExaHuntResult[] = []
  const bySearch: Record<string, number> = {}
  const errors: string[] = []
  let costUsd = 0
  for (const s of searches) {
    const r = await client.search(s, now)
    costUsd += r.costUsd
    if (!r.ok) { errors.push(`${s.key}: ${r.error ?? "failed"}`); continue }
    let n = 0
    for (const x of r.results) {
      const k = (x.url ?? x.id).toLowerCase()
      if (seen.has(k)) continue
      seen.add(k)
      results.push(x)
      n++
    }
    bySearch[s.key] = n
  }
  return { status: "ok", results, bySearch, costUsd, errors }
}

// ── GROUNDED EVIDENCE ────────────────────────────────────────────────────────

/** What every candidate or event rests on — openable, dated, quoted. Never a paraphrase presented as the page's words. */
export interface GroundedEvidence {
  sourceUrl: string
  title: string | null
  publisher: string | null
  publishedAt: string | null
  retrievedAt: string
  /** ≤ QUOTED_BASIS_CHARS of the page's own words (the top highlight, else the summary, else the text). */
  quotedBasis: string
  resultId: string
}

export const QUOTED_BASIS_CHARS = 280

/** PURE — the evidence a result grounds, or null when it has no openable URL or nothing quotable. */
export function groundedEvidence(r: ExaHuntResult, now: Date): GroundedEvidence | null {
  if (!r.url || !/^https?:\/\//i.test(r.url)) return null
  const raw = r.highlights?.[0] ?? (typeof r.summary === "string" && !r.summary.trim().startsWith("{") ? r.summary : null) ?? r.text ?? ""
  const quotedBasis = raw.replace(/\s+/g, " ").trim().slice(0, QUOTED_BASIS_CHARS)
  if (!quotedBasis) return null
  return { sourceUrl: r.url, title: r.title, publisher: r.publisher, publishedAt: r.publishedDate, retrievedAt: now.toISOString(), quotedBasis, resultId: r.id }
}

/**
 * PURE — why a dated page is not current evidence for a play with this window (null = fresh). An UNDATED page is
 * fresh only when the play allows it (`requireDate: false`); a person's request with no date cannot be shown fresh.
 */
export function freshnessProblem(e: { publishedAt: string | null }, maxAgeDays: number, now: Date, opts: { requireDate?: boolean } = {}): string | null {
  if (!e.publishedAt) return opts.requireDate ? "no published date — cannot be shown to be current" : null
  const t = Date.parse(e.publishedAt)
  if (!Number.isFinite(t)) return opts.requireDate ? `unreadable published date (${e.publishedAt})` : null
  const ageDays = (now.getTime() - t) / DAY_MS
  if (ageDays > maxAgeDays) return `published ${Math.round(ageDays)} days ago — older than this play's ${maxAgeDays}-day window`
  if (ageDays < -1) return `published date is in the future (${e.publishedAt})`
  return null
}

// ── SOURCE RIGHTS PER PAGE CLASS ─────────────────────────────────────────────
//
// The PRODUCER's rights basis is the vendor's (source-intent-map.ts sourceRightsFor: Exa → public_web). What a page
// PERMITS is finer than that and rides the evidence: who published it, for what, and whether its terms let a
// published contact point be used to answer the author. Conservative by default: an unknown host permits nothing
// beyond a cited excerpt.

export type SourceClass = "official_record" | "owner_published_listing" | "classified_wanted" | "public_forum" | "news" | "unknown"

export interface SourceRights {
  sourceClass: SourceClass
  host: string | null
  /** Always: only a cited excerpt is kept (no reuse license is assumed). */
  excerptOnly: true
  /** The AUTHOR's own published contact point may be used to answer a request THEY made on this class of page. */
  publishedContactPermitted: boolean
  /** The channel (thread, group, DM) is never messaged because the content was public — a constant, published so it is read. */
  channelMessagingPermitted: false
  /** A government / court / statutory-notice page: public record (an intimate topic is stored only from such a page). */
  officialRecord: boolean
  termsNote: string
}

interface SourceRule { sourceClass: SourceClass; test: (host: string, url: string) => boolean; publishedContactPermitted: boolean; officialRecord: boolean; termsNote: string }

const FORUM_HOSTS = /(^|\.)(reddit\.com|facebook\.com|nextdoor\.com|twitter\.com|x\.com|linkedin\.com|instagram\.com|tiktok\.com|quora\.com|city-data\.com|biggerpockets\.com|threads\.net)$/
const FSBO_HOSTS = /(^|\.)(forsalebyowner\.com|fsbo\.com|byowner\.com|fizber\.com|homesbyowner\.com)$/
const NEWS_HOSTS = /(news|journal|times|herald|gazette|tribune|press|chronicle|dispatch|observer|ledger|bizjournals|patch\.com|prnewswire|businesswire|globenewswire|wtsp|wear|wkrg|fox|nbc|abc|cbs)/

const SOURCE_RULES: readonly SourceRule[] = [
  { sourceClass: "official_record", test: (h) => /\.gov$|\.gov\.[a-z]{2}$|(^|\.)[a-z]{2}\.us$|courts?\./.test(h) || /publicnotice|legalnotice|legals\.|publicnotices/.test(h), publishedContactPermitted: false, officialRecord: true, termsNote: "a government / court / statutory public-notice page — public record; nothing is sent because of the notice itself" },
  { sourceClass: "owner_published_listing", test: (h) => FSBO_HOSTS.test(h), publishedContactPermitted: true, officialRecord: false, termsNote: "the owner published the listing and a contact point for inquiries about the sale" },
  { sourceClass: "owner_published_listing", test: (h, u) => /(^|\.)craigslist\.org$/.test(h) && /\/reo\//.test(u), publishedContactPermitted: true, officialRecord: false, termsNote: "real estate by owner (Craigslist 'reo'); Craigslist's terms restrict automated collection — the existing craigslist_fsbo lane is the volume survivor; this is cited discovery only" },
  { sourceClass: "classified_wanted", test: (h, u) => /(^|\.)craigslist\.org$/.test(h) && /\/(hsw|rew)\//.test(u), publishedContactPermitted: true, officialRecord: false, termsNote: "a 'housing / real estate wanted' classified — the poster published a contact point asking to be contacted" },
  { sourceClass: "public_forum", test: (h) => FORUM_HOSTS.test(h), publishedContactPermitted: false, officialRecord: false, termsNote: "a forum / social platform: its terms do not permit commercial use of members' content or contact points without the platform's permission (Reddit Data API = contract; Nextdoor has no read API; Meta platform terms) — the author is answered only through our own inbound resources" },
  { sourceClass: "news", test: (h, u) => NEWS_HOSTS.test(h) || /\/(news|story|stories|article|articles)\//.test(u), publishedContactPermitted: false, officialRecord: false, termsNote: "a news page — cited excerpt only; a person named in a story has not asked to be contacted" },
]

/** PURE — the rights a page's class permits (see the block comment). An unknown host permits a cited excerpt and nothing more. */
export function sourceRightsForUrl(url: string | null): SourceRights {
  const host = hostOf(url)
  const u = (url ?? "").toLowerCase()
  const rule = host ? SOURCE_RULES.find((r) => r.test(host, u)) : undefined
  if (!rule) {
    return { sourceClass: "unknown", host, excerptOnly: true, publishedContactPermitted: false, channelMessagingPermitted: false, officialRecord: false, termsNote: "an unclassified host — a cited excerpt only; no contact point is used until the page class is known" }
  }
  return { sourceClass: rule.sourceClass, host, excerptOnly: true, publishedContactPermitted: rule.publishedContactPermitted, channelMessagingPermitted: false, officialRecord: rule.officialRecord, termsNote: rule.termsNote }
}
