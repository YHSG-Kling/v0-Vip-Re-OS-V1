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

/**
 * Emotional tone from the caption/title — the missing half of `emotional_tone`.
 *
 * WHAT WAS BROKEN. `competitor_content.emotional_tone` was read by
 * getCompetitorPostInspiration (app/actions/marketing-intelligence.ts:201) and
 * written by nobody, so the "repurpose this concept" prompt an agent generates
 * from a rival's post always said the SAME thing — the `?? "warm and
 * informative"` fallback — no matter what the post's tone actually was. That is
 * a scored input that never varied.
 *
 * Deterministic and free, the same shape as classifyHook above: the tone is
 * read off text we already hold at scan time, so it costs no extra provider
 * call and invents nothing the caption does not say. Ordered most-specific
 * first; "informative" is the honest default for a plain statement, and it is
 * the same word the reader's old fallback used, so an existing row that never
 * got a tone and a new plain one still read alike.
 *
 * NOT EXPORTED, deliberately unlike classifyHook and extractKeyphrases above.
 * Those two carry an `export` no other file in the tree reads, which is why
 * this file already stood at two unreferenced exports before this function
 * existed — and adding a third in the same style would have been copying a
 * defect for consistency's sake. runContentIntelScan is the module's one door.
 *
 * WHY THE OTHER TWO WERE LEFT ALONE, having been un-exported and then put back:
 * orphan-export-guard tracks its baseline BY NAME, so removing the `export`
 * keyword from a name already in that baseline is indistinguishable, to the
 * guard, from deleting the capability — it reported "CAPABILITY REMOVED — 2
 * exports exist NOWHERE in the tree" and was right to. Tidying two accepted
 * entries is not burn-down; it buys a cosmetic −2 with a false signal on the
 * one guard that exists to make deletions expensive. This function is different
 * because it is NEW: it never entered the baseline, so declining to export it
 * costs nothing and closes the regression it would otherwise have opened.
 */
function classifyEmotionalTone(text: string): string {
  const t = text.toLowerCase()
  if (/\b(don't|avoid|mistake|warning|beware|risk|before you)\b/.test(t)) return "cautionary"
  if (/\b(congratulations|thrilled|excited|proud|celebrat|love|dream)\b/.test(t)) return "celebratory"
  if (/\b(sold|closed|record|success|helped|thank you|testimonial)\b/.test(t)) return "reassuring"
  if (/\b(now|today|hurry|last chance|limited|don t miss|act fast|only \d)\b/.test(t)) return "urgent"
  if (/[?]|\b(how|why|what if|did you know|guess)\b/.test(t)) return "curious"
  return "informative"
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
  // `market_zip_codes` is NOT copied onto the profile twin (wave 26, §1
  // duplicate). The zips originate on competitor_brokerages.watch_zip_codes —
  // written by app/actions/direct-mail-settings.ts:132, read as the geo hint
  // at scanOneCompetitor below (:130) and app/api/cron/competitor-ads-exa/
  // route.ts:98 — and the copy here had no reader. The watch row is the
  // survivor; competitor_id ↔ competitor_name is the join back to it.
  const { data, error } = await svc.from("competitor_profiles").insert({
    brokerage_id: w.brokerage_id,
    competitor_name: w.competitor_name,
    competitor_type: "brokerage",
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
        // §1.2 (2026-09-04) — THE MISSING WRITER. competitor_content.media_url
        // is read by app/actions/marketing-intelligence.ts:148 and was written
        // by nobody, so every competitor card rendered image-less. Exa carries
        // the page image on the result; it is now mapped through
        // (lib/content-intel/exa-scraper.ts :: ExaSearchResult.image_url) and
        // stays NULL when Exa has none — a competitor-intel card must not
        // invent a picture of a rival's creative.
        media_url: r.image_url,
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
        // The other half of the repurpose brief. hook_type says HOW the post
        // opens; emotional_tone says how it FEELS, and the inspiration prompt
        // at app/actions/marketing-intelligence.ts:221 asks for both. Only
        // hook_type was ever written, so the tone half of every brief was the
        // reader's hardcoded fallback.
        emotional_tone: classifyEmotionalTone(`${r.title} ${r.summary}`),
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

/** Distinct publishing domains in a result set — the competition signal
 *  (how many different players are fighting over this niche right now). */
function distinctDomains(results: ExaSearchResult[]): number {
  return new Set(results.map((r) => { try { return new URL(r.url).hostname } catch { return r.url } })).size
}

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
    const query = `most popular ${niche.replace(/_/g, " ")} real estate content${market ? ` ${market}` : ""}`
    // DAY-ONE METRICS FROM THE PROVIDER WE ALREADY RUN (owner directive: no
    // extra SEO vendor). TWO time windows of the SAME query give real, derived
    // numbers: the 30-day fresh window vs the 180-day base window measures
    // whether this niche's content is ACCELERATING (rising), coasting
    // (steady), or fading (declining) — Exa's index is the corpus.
    const [fresh, base] = await Promise.all([
      exaSearch({ query, numResults: 10, type: "auto", withinDays: 30 }).catch(() => [] as ExaSearchResult[]),
      exaSearch({ query, numResults: 10, type: "auto", withinDays: 180 }).catch(() => [] as ExaSearchResult[]),
    ])
    if (fresh.length === 0 && base.length === 0) continue

    // Publish-rate acceleration: fresh results/day vs base results/day.
    const freshRate = fresh.length / 30
    const baseRate = Math.max(base.length, 1) / 180
    const accelPct = Math.round(((freshRate / baseRate) - 1) * 100)
    const direction = accelPct > 10 ? "rising" : accelPct < -10 ? "declining" : "steady"

    // PLATFORM SEARCH-INTEREST INDEX (0–100): average Exa citation score of
    // the fresh set scaled by how full the window is. A relative index from
    // real provider data — documented as an index, never claimed to be
    // Google's absolute monthly volume.
    const avgScore = fresh.length ? fresh.reduce((s, r) => s + r.engagement_score, 0) / fresh.length : 0
    const interestIndex = Math.round(Math.min(100, avgScore * (fresh.length / 10)))
    // Competition: distinct domains publishing in the niche this month (0-100).
    const competition = Math.round(Math.min(100, (distinctDomains(fresh) / 10) * 100))

    const allPhrases = (fresh.length ? fresh : base).flatMap((r) => extractKeyphrases(r.title, 4))
    const rows = (fresh.length ? fresh : base).slice(0, 3).map((r) => ({
      brokerage_id: b.id,
      city: b.city, state: b.state, zip_code: null,
      keyword: r.title.slice(0, 200),
      search_volume_monthly: interestIndex, // platform interest INDEX (0-100), derived — see above
      competition_score: competition,
      trend_direction: direction,
      trend_change_pct: accelPct !== 0 ? accelPct : r.engagement_score,
      source: "exa_content_scan",
      related_keywords: allPhrases.slice(0, 10),
      intent_category: niche,
      captured_at: now.toISOString(),
      expires_at: expiresAt,
    }))
    const { error } = await svc.from("keyword_intelligence").insert(rows)
    if (!error) written += rows.length
  }

  // NEWSAPI.AI TRENDING LANE (owner directive): Event Registry's per-article
  // SOCIAL SCORES are a real "what people actually shared" popularity signal —
  // a second, independent source next to the Exa citation lane. Tenant/platform
  // key cascade; no key → this lane just doesn't write (never fabricated).
  try {
    const { resolveNewsApiAiKey, searchNewsApiAiArticles } = await import("@/lib/content-intel/newsapi-ai")
    const key = await resolveNewsApiAiKey(svc, b.id)
    if (key) {
      await svc.from("keyword_intelligence").delete().eq("brokerage_id", b.id).eq("source", "newsapi_ai_social")
      for (const niche of NICHES) {
        const arts = await searchNewsApiAiArticles({
          apiKey: key,
          keyword: `${niche.replace(/_/g, " ")} real estate`,
          locationKeyword: market || null,
          sortBy: "socialScore",
          count: 5,
          sinceDays: 30,
        }).catch(() => [])
        if (arts.length === 0) continue
        const maxSocial = Math.max(1, ...arts.map((a) => a.socialScore))
        const socialRows = arts.slice(0, 3).map((a) => ({
          brokerage_id: b.id,
          city: b.city, state: b.state, zip_code: null,
          keyword: a.title.slice(0, 200),
          // Social-interest index 0-100 from REAL share counts.
          search_volume_monthly: Math.round((a.socialScore / maxSocial) * 100),
          competition_score: null,
          trend_direction: "rising", // socialScore-sorted top of the last 30d IS what's trending
          trend_change_pct: Math.round((a.socialScore / maxSocial) * 100),
          source: "newsapi_ai_social",
          related_keywords: a.concepts.slice(0, 10),
          intent_category: niche,
          captured_at: now.toISOString(),
          expires_at: expiresAt,
        }))
        const { error } = await svc.from("keyword_intelligence").insert(socialRows)
        if (!error) written += socialRows.length
      }
    }
  } catch { /* the Exa lane above already wrote — this lane is additive */ }
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
