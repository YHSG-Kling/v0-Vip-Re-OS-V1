// lib/competitive-intel/content-intel-scan.ts
// ─────────────────────────────────────────────────────────────────────────────
// CONTENT INTELLIGENCE SCAN (burn-down round 5, owner spec):
//   · competitor_content — "Exa social scan + Facebook ad lookup for a
//     competitor, and what content is getting the most interaction." Walks the
//     competitor_brokerages watchlist (the written table), scans ORGANIC social
//     (facebook.com/instagram.com) AND the Facebook Ad Library, and persists
//     rows the marketing-intelligence briefs read. Exa's citation-weighted
//     ranking is the interaction proxy (same argument the competitor-ads cron
//     shipped with): the top-cited, indexed posts ARE the talked-about ones —
//     is_high_performing marks the top of each scan. Hard like/comment counts
//     aren't available without platform auth → those stay honest-NULL.
//   · competitor_profiles — the reader inner-joins competitor_content →
//     competitor_profiles, but NOTHING wrote profiles (rows would be silently
//     dropped). Each watchlist entry ensures its profile twin here.
//   · keyword_intelligence — "popular content search for a niche": per
//     brokerage niche (the content-pipeline category vocabulary + the
//     brokerage's market), Exa surfaces what's popular NOW; keyphrases land as
//     'rising' keywords with a 7-day TTL (the reader filters trend_direction=
//     'rising' + unexpired). search_volume_monthly has no honest source
//     without an SEO provider → stays NULL, never fabricated.

import "server-only"
import { exaSearch, type ExaSearchResult } from "@/lib/content-intel/exa-scraper"

type Svc = { from: (table: string) => any }

const STOPWORDS = new Set(["the","a","an","and","or","for","to","of","in","on","with","your","how","what","why","this","that","is","are","you","real","estate"])

/** Keyphrases from a title — the detected_keywords/detected_topics heuristic. */
export function extractKeyphrases(title: string, max = 6): string[] {
  return Array.from(new Set(
    title.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/)
      .filter((w) => w.length > 3 && !STOPWORDS.has(w))
  )).slice(0, max)
}

/** Hook classification from the caption/title (the brief surfaces hook_type). */
export function classifyHook(title: string): string {
  const t = title.toLowerCase()
  if (t.includes("?")) return "question"
  if (/^\d|top \d|\d (ways|tips|things|reasons|steps)/.test(t)) return "list"
  if (t.startsWith("how ") || t.includes("how to")) return "how_to"
  if (/just (sold|listed)|sold in|closed/.test(t)) return "social_proof"
  if (/before you|don't|mistake|warning|avoid/.test(t)) return "warning"
  return "statement"
}

function platformFromUrl(url: string): string {
  if (url.includes("facebook.com/ads/library")) return "facebook"
  if (url.includes("facebook.com")) return "facebook"
  if (url.includes("instagram.com")) return "instagram"
  if (url.includes("linkedin.com")) return "linkedin"
  if (url.includes("tiktok.com")) return "tiktok"
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube"
  return "web"
}

/** Ensure the watchlist entry has its competitor_profiles twin (the reader's
 *  inner-join target). No unique index exists → check-then-insert. */
async function ensureCompetitorProfile(
  svc: Svc,
  w: { brokerage_id: string; competitor_name: string; watch_zip_codes: string[] | null },
): Promise<string | null> {
  const { data: existing } = await svc.from("competitor_profiles")
    .select("id").eq("brokerage_id", w.brokerage_id).eq("competitor_name", w.competitor_name).maybeSingle()
  if (existing) return (existing as any).id as string
  const { data, error } = await svc.from("competitor_profiles").insert({
    brokerage_id: w.brokerage_id,
    competitor_name: w.competitor_name,
    competitor_type: "brokerage",
    market_zip_codes: w.watch_zip_codes ?? null,
    is_active: true,
  }).select("id").single()
  return error ? null : ((data as any).id as string)
}

export interface ContentScanResult { competitorsScanned: number; contentRows: number; keywordRows: number }

/** One watchlist competitor → organic social + ad-library content rows. */
async function scanOneCompetitor(
  svc: Svc,
  w: { id: string; brokerage_id: string; competitor_name: string; watch_zip_codes: string[] | null },
  now: Date,
): Promise<number> {
  const profileId = await ensureCompetitorProfile(svc, w)
  const geo = w.watch_zip_codes?.[0]

  const [organic, ads] = await Promise.all([
    exaSearch({
      query: `${w.competitor_name} real estate${geo ? ` ${geo}` : ""}`,
      numResults: 8, type: "auto", withinDays: 30,
      includeDomains: ["facebook.com", "instagram.com"],
    }).catch(() => [] as ExaSearchResult[]),
    // The owner's "Facebook ad lookup": the public Ad Library, content_type 'ad'.
    exaSearch({
      query: `${w.competitor_name} real estate ads`,
      numResults: 5, type: "auto", withinDays: 60,
      includeDomains: ["facebook.com"],
    }).then((rs) => rs.filter((r) => r.url.includes("/ads/"))).catch(() => [] as ExaSearchResult[]),
  ])

  let written = 0
  const writeRows = async (results: ExaSearchResult[], contentType: string) => {
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      // No unique index on competitor_content — dedupe by content_url.
      const { data: dupe } = await svc.from("competitor_content")
        .select("id").eq("brokerage_id", w.brokerage_id).eq("content_url", r.url).maybeSingle()
      if (dupe) continue
      const caption = [r.title, r.summary].filter(Boolean).join(" — ").slice(0, 900)
      const { error } = await svc.from("competitor_content").insert({
        competitor_id: profileId,
        brokerage_id: w.brokerage_id,
        platform: platformFromUrl(r.url),
        content_type: contentType,
        content_url: r.url,
        caption,
        posted_at: r.published_date,
        observed_at: now.toISOString(),
        // Hard engagement counts need platform auth — honest NULL, never invented.
        likes_count: null, comments_count: null, shares_count: null, views_count: null,
        engagement_rate: r.engagement_score, // Exa citation score 0-100 — the interaction PROXY, documented
        is_high_performing: i < 3, // top of the citation-weighted ranking
        detected_topics: extractKeyphrases(r.title, 4),
        detected_keywords: extractKeyphrases(`${r.title} ${r.summary}`, 8),
        hook_type: classifyHook(r.title),
        cta_present: /call|contact|dm|schedule|book|visit/i.test(caption),
        raw_engagement_data: { source: "exa", exa_score: r.engagement_score, rank: i, categories: r.categories },
      })
      if (!error) written++
    }
  }
  await writeRows(organic, "social_post")
  await writeRows(ads, "ad")
  return written
}

/** The content-pipeline niche vocabulary (same categories the blog/newsletter
 *  cadence pickers use) — the "niche" in the owner's spec. */
const NICHES = ["buyer_advice", "seller_advice", "finance", "market_education", "neighborhood", "home_improvement"]

async function scanKeywordsForBrokerage(
  svc: Svc,
  b: { id: string; city: string | null; state: string | null },
  now: Date,
): Promise<number> {
  const market = [b.city, b.state].filter(Boolean).join(", ")
  const expiresAt = new Date(now.getTime() + 7 * 24 * 3600_000).toISOString()

  // Fresh scan replaces this source's prior rows (no unique index — pass-10
  // delete-then-insert; other sources' rows are untouched).
  await svc.from("keyword_intelligence").delete().eq("brokerage_id", b.id).eq("source", "exa_content_scan")

  let written = 0
  for (const niche of NICHES) {
    const results = await exaSearch({
      query: `most popular ${niche.replace(/_/g, " ")} real estate content${market ? ` ${market}` : ""}`,
      numResults: 5, type: "auto", withinDays: 30,
    }).catch(() => [] as ExaSearchResult[])
    if (results.length === 0) continue

    const allPhrases = results.flatMap((r) => extractKeyphrases(r.title, 4))
    const rows = results.slice(0, 3).map((r) => ({
      brokerage_id: b.id,
      city: b.city, state: b.state, zip_code: null,
      keyword: r.title.slice(0, 200),
      // No SEO-provider volume feed — honest NULL, never a fabricated number.
      search_volume_monthly: null,
      competition_score: null,
      // Exa's freshness-weighted top results ARE what's popular right now —
      // that's the 'rising' signal (the reader filters on it); the citation
      // score orders the shelf via trend_change_pct.
      trend_direction: "rising",
      trend_change_pct: r.engagement_score,
      source: "exa_content_scan",
      related_keywords: allPhrases.slice(0, 10),
      intent_category: niche,
      captured_at: now.toISOString(),
      expires_at: expiresAt,
    }))
    const { error } = await svc.from("keyword_intelligence").insert(rows)
    if (!error) written += rows.length
  }
  return written
}

/** The full scan: every active watchlist competitor + every brokerage's niches. */
export async function runContentIntelScan(svc: Svc, now: Date = new Date()): Promise<ContentScanResult> {
  const out: ContentScanResult = { competitorsScanned: 0, contentRows: 0, keywordRows: 0 }

  const { data: watchRows } = await svc.from("competitor_brokerages")
    .select("id, brokerage_id, competitor_name, watch_zip_codes")
    .eq("is_active", true).limit(500)
  for (const w of ((watchRows ?? []) as Array<{ id: string; brokerage_id: string; competitor_name: string; watch_zip_codes: string[] | null }>)) {
    try {
      out.contentRows += await scanOneCompetitor(svc, w, now)
      out.competitorsScanned++
    } catch { /* per-competitor isolation */ }
  }

  // Keywords: only brokerages that USE the content engine (a watchlist entry or
  // an active cadence policy) — no token spend on dormant tenants.
  const active = new Set<string>()
  for (const w of ((watchRows ?? []) as Array<{ brokerage_id: string }>)) active.add(w.brokerage_id)
  const { data: cadence } = await svc.from("blog_cadence_policy").select("scope_id, scope_type").eq("scope_type", "brokerage").limit(500)
  for (const c of ((cadence ?? []) as Array<{ scope_id: string }>)) active.add(c.scope_id)

  if (active.size > 0) {
    const { data: brokerages } = await svc.from("brokerages").select("id, city, state").in("id", [...active]).limit(500)
    for (const b of ((brokerages ?? []) as Array<{ id: string; city: string | null; state: string | null }>)) {
      try { out.keywordRows += await scanKeywordsForBrokerage(svc, b, now) } catch { /* isolation */ }
    }
  }
  return out
}
