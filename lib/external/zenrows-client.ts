import type { NextdoorPost } from "./nextdoor-extract"

// ─── CLASS ALIAS (backward compat for callers using `new ZenrowsClient()`) ────
export class ZenrowsClient {
  async scrape(url: string, options: { js_render?: boolean; premium_proxy?: boolean } = {}) {
    try {
      const result = await scrapeWithZenRows(url, {
        jsRender: options.js_render,
        premiumProxy: options.premium_proxy,
      })
      return { success: true, html: result.body, cost: result.cost }
    } catch (err) {
      return { success: false, html: '', cost: 0 }
    }
  }
  async googleSearch(query: string, options: { location?: string; num?: number } = {}) {
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}${options.num ? `&num=${options.num}` : ''}`
    const result = await scrapeWithZenRows(url, { jsRender: true, premiumProxy: true })
    return result.body
  }

  // TOMBSTONE (wave 153, lane 153N — owner ruling B2 "nextdoor goes through zyte or zenrows"; orphan doctrine §1.1):
  // ZenrowsClient.scrapeNextdoor called the ZenRows transport DIRECTLY — no robots, no terms, no spend gate, no checkpoint —
  // and it was Nextdoor's only fetch. Its extraction half moved to extractNextdoorPostsFromHtml (below, this file); its fetch
  // half is lib/lead-pipeline/nextdoor-chatter.ts sourceNextdoorChatter, which rides lib/providers/scrape-checkpoint.ts
  // fetchCheckpointedSnapshot under the purpose real_estate_need_chatter and the named LICENSE_REQUIRED hold. Both callers
  // (app/api/cron/lead-scraping/route.ts, app/actions/lead-intelligence.ts) now call sourceNextdoorChatter.

  /**
   * Scrapes Facebook group posts by delegating to the Apify Facebook scraper,
   * since Facebook requires auth that ZenRows alone cannot provide.
   */
  async scrapeFacebookGroups(params: { groupUrls: string[]; keywords: string[] }): Promise<{ success: boolean; posts: any[]; cost: number }> {
    try {
      const { scrapeFacebookGroupPosts } = await import('./apify-client')
      const result = await scrapeFacebookGroupPosts({ groupUrl: params.groupUrls[0], keywords: params.keywords, limit: 50 })
      return { success: true, posts: result.posts ?? [], cost: result.cost ?? 0 }
    } catch {
      return { success: false, posts: [], cost: 0 }
    }
  }
}

/**
 * Nextdoor posts from ONE fetched page's HTML (the extraction half of the retired ZenrowsClient.scrapeNextdoor — the fetch now
 * rides the snapshot checkpoint: lib/lead-pipeline/nextdoor-chatter.ts sourceNextdoorChatter).
 *
 * Nextdoor has NO structured actor — not in lib/external/apify-actors.ts, not at ZenRows. All either transport can hand back
 * is raw HTML. So this is the lane `lib/external/llm-html-extractor.ts :: extractFromHtml` exists for: a schema-bound
 * HTML→JSON pass that produces the post fields the consumers read (cron: author_name, post_id; lead-intelligence:
 * type, neighborhood, matched_keywords, url, relevance_score written into `nextdoor_activity`).
 *
 * HONESTY. The model extracts only text that is on the page. `type`, `matched_keywords` and `relevance_score` are computed
 * deterministically in lib/external/nextdoor-extract.ts from the extracted text — a generative model is never asked to
 * author a score that then gets stored as an observation. When extraction is unavailable (no gateway key, gateway refusal,
 * unparseable output) the regex path still runs, each record stamped `extraction: "regex_fallback"` with
 * `relevance_score: null` — degraded, and visibly so, never a fabricated score.
 */
export async function extractNextdoorPostsFromHtml(
  html: string,
  options: { keywords?: string[]; sourceUrl?: string; limit?: number } = {},
): Promise<{ posts: NextdoorPost[]; extraction: "llm_schema" | "regex_fallback" | null; extractionError: string | null; error: string | null }> {
  if (!html) return { posts: [], extraction: null, extractionError: null, error: "the page had an empty body" }
  const { extractFromHtml } = await import("./llm-html-extractor")
  const { NEXTDOOR_POST_SCHEMA, NEXTDOOR_EXTRACT_INSTRUCTIONS, normalizeExtractedPosts, regexFallbackPosts } = await import("./nextdoor-extract")
  const extracted = await extractFromHtml({ html, schema: NEXTDOOR_POST_SCHEMA, instructions: NEXTDOOR_EXTRACT_INSTRUCTIONS })
  if (extracted.error) {
    const posts = regexFallbackPosts(html, { keywords: options.keywords, sourceUrl: options.sourceUrl, limit: options.limit })
    return {
      posts, extraction: posts.length > 0 ? "regex_fallback" : null, extractionError: extracted.error,
      error: posts.length > 0 ? null : `html extraction refused (${extracted.error}) and the fallback recovered no posts`,
    }
  }
  // Zero posts from a SUCCESSFUL extraction is a real answer (a search with no results), not a failure.
  const posts = normalizeExtractedPosts(extracted.records, { keywords: options.keywords, sourceUrl: options.sourceUrl, limit: options.limit ?? 30 })
  return { posts, extraction: "llm_schema", extractionError: null, error: null }
}

/** The flat per-call estimate booked when ZenRows does not state the request's cost (X-Request-Cost absent). */
const ZENROWS_ESTIMATED_CALL_USD = 0.01

export interface ZenRowsResponse {
  statusCode: number
  body: string
  cost: number
  /** Wave 153 (lane 153G): `final` = ZenRows' own X-Request-Cost; `estimated` = the flat per-call estimate. */
  costBasis?: "final" | "estimated"
  /** Wave 153: the TARGET's headers (ZenRows' `Zr-` prefix removed, lowercased) — validators for the snapshot checkpoint. */
  headers?: Record<string, string>
  /** Wave 153: the source answered 304 Not Modified to OUR validator (original_status) — nothing new. */
  notModified?: boolean
}

export async function scrapeWithZenRows(
  url: string,
  options: {
    loadingWait?: 'networkidle' | 'domcontentloaded'
    customHeaders?: Record<string, string>
    premiumProxy?: boolean
    jsRender?: boolean
    /** Wave 153: If-None-Match / If-Modified-Since from the snapshot checkpoint — sent with original_status so a 304 reads. */
    conditionalHeaders?: Record<string, string> | null
  } = {}
): Promise<ZenRowsResponse> {
  // Official ZenRows SDK adapter (lib/providers/zenrows/client.ts) — same
  // request shape, same credit-per-request price. The key is read per CALL (not at module load).
  const { scrapePage } = await import("@/lib/providers/zenrows/client")
  const conditional = options.conditionalHeaders && Object.keys(options.conditionalHeaders).length ? options.conditionalHeaders : null
  const headers = conditional || options.customHeaders ? { ...(options.customHeaders ?? {}), ...(conditional ?? {}) } : undefined
  const res = await scrapePage(process.env.ZENROWS_API_KEY ?? "", url, {
    jsRender: options.jsRender,
    waitFor: options.loadingWait,
    premiumProxy: options.premiumProxy,
    customHeaders: headers,
    originalStatus: !!conditional,
  })
  const cost = res.requestCostUsd ?? ZENROWS_ESTIMATED_CALL_USD
  const costBasis: "final" | "estimated" = res.requestCostUsd !== null ? "final" : "estimated"

  if (conditional && res.status === 304) {
    return { statusCode: 304, body: "", cost, costBasis, headers: res.targetHeaders, notModified: true }
  }
  if (!res.ok) {
    // The vendor's HTTP status rides the error so the caller's retry rule (scrape-checkpoint failureDisposition) can read it.
    throw Object.assign(new Error(`ZenRows API error: ${res.status ?? "network"} ${res.error ?? ""}`.trim()), { status: res.status })
  }

  return {
    statusCode: res.status ?? 200,
    body: res.data ?? "",
    cost,
    costBasis,
    headers: res.targetHeaders,
  }
}

export async function retryWithApifyFallback(
  url: string,
  context: 'facebook' | 'reddit' | 'craigslist'
): Promise<{ html: string; source: 'zenrows' | 'apify'; cost: number }> {
  try {
    const result = await scrapeWithZenRows(url, { premiumProxy: true })
    return {
      html: result.body,
      source: 'zenrows',
      cost: result.cost,
    }
  } catch (error) {
    console.warn('[v0] ZenRows failed, falling back to Apify:', error)
    
    const { runApifyActor } = await import('./apify-client')
    
    let actorId = ''
    if (context === 'facebook') actorId = 'apify/facebook-pages-scraper'
    if (context === 'reddit') actorId = 'trudax/reddit-scraper'
    if (context === 'craigslist') actorId = 'lukaskrivka/craigslist-scraper'

    const apifyResult = await runApifyActor(actorId, {
      startUrls: [{ url }],
      maxItems: 100,
    })

    return {
      html: JSON.stringify(apifyResult.data),
      source: 'apify',
      cost: apifyResult.cost,
    }
  }
}

// ─── Provider picker (ZenRows primary, Zyte fallback) ──────────────────────────
// BUILT wave 65 (owner ruling): "zenrows or zyte can help find leads that are on real estate
// sites like zillow/realtor.com/nextdoor/homes.com/reddit". docs/lead-acquisition-coverage-
// 2026-09.md researched both providers' 2026 capability + pricing; the verdict keeps ZenRows
// primary (predictable credit pricing, already wired) with Zyte (lib/external/zyte-client.ts)
// as the fallback the OS reaches for by CONFIGURED KEY — never a hardcoded provider choice —
// when ZenRows is unconfigured or its call fails. Fails CLOSED (no scrape, no cost) when
// neither key is present, matching every other scraper lane's no-keys posture.
export interface SiteHtmlResult {
  ok: boolean
  html: string
  provider: "zenrows" | "zyte" | null
  cost: number
  error: string | null
  // ── wave 153 (lane 153G) — what the snapshot checkpoint (lib/providers/scrape-checkpoint.ts) reads; always present on
  //    every return below, and read by nobody else, so every earlier caller is unchanged ──
  /** `final` = the vendor stated the cost (ZenRows X-Request-Cost); `estimated` = the published-rate estimate. */
  costBasis: "final" | "estimated" | "none"
  /** The TARGET's status where the transport reports it (Zyte statusCode; ZenRows original_status). */
  statusCode: number | null
  /** The transport's own HTTP status on a refusal (429 / 520 / 401 …) — the checkpoint's retry rule reads it. */
  vendorStatus: number | null
  /** The target's response headers (lowercased) when `withHeaders` asked — validators only are read. */
  headers: Record<string, string> | null
  /** The source answered 304 Not Modified to the checkpoint's validator. */
  notModified: boolean
}

// LANE 82B — ORDER BY HOST, CHEAPEST SUCCESSFUL PROVIDER FIRST (research 2026-09-25, Exa):
// the ScrapeOps Zillow benchmark cited by brightdata.com/blog/web-data/best-zillow-scrapers
// (2026-09-24) records Zyte at 100% success on Zillow ($430/M pages; PAYG from $0.13/1k HTTP,
// $1.01/1k browser) and ZenRows at 45% — and scrapeway.com's Aug-2026 run (docs/lead-acquisition-
// coverage-2026-09.md) reported ZenRows 0% on zillow.com AND realtor.com. ZenRows' own June-2026
// benchmarks still lead on everything ELSE (96–99% vs Zyte 65–75%). So the real-estate PORTAL hosts
// try Zyte first; every other host keeps ZenRows first. Either way the other configured provider is
// the fallback, and neither key ⇒ fail closed — the configured-key contract is unchanged.
const ZYTE_FIRST_HOSTS = /(^|\.)(zillow|realtor|homes|redfin|trulia)\.com$/i

/** PURE. The provider order scrapeSiteWithBestProvider walks for this URL. */
export function scrapeProviderOrder(url: string): Array<"zenrows" | "zyte"> {
  let host = ""
  try { host = new URL(url).hostname } catch { host = "" }
  return ZYTE_FIRST_HOSTS.test(host) ? ["zyte", "zenrows"] : ["zenrows", "zyte"]
}

export async function scrapeSiteWithBestProvider(
  url: string,
  options: {
    jsRender?: boolean
    premiumProxy?: boolean
    /** Wave 153: conditional validators from the snapshot checkpoint — each transport sends them only where it documents
     *  request headers in that mode (Zyte: HTTP mode only; ZenRows: custom_headers + original_status). */
    requestHeaders?: Record<string, string> | null
    /** Wave 153: return the target's response headers (Zyte httpResponseHeaders; ZenRows Zr- headers). */
    withHeaders?: boolean
  } = {},
): Promise<SiteHtmlResult> {
  const { scrapeWithZyte, zyteConfigured } = await import("./zyte-client")
  let lastError: string | null = null
  let lastProvider: "zenrows" | "zyte" | null = null
  let lastVendorStatus: number | null = null
  for (const provider of scrapeProviderOrder(url)) {
    if (provider === "zenrows") {
      if (!process.env.ZENROWS_API_KEY) continue
      lastProvider = "zenrows"
      try {
        const r = await scrapeWithZenRows(url, { jsRender: options.jsRender, premiumProxy: options.premiumProxy, conditionalHeaders: options.requestHeaders ?? null })
        const headers = options.withHeaders ? (r.headers ?? null) : null
        if (r.notModified) return { ok: true, html: "", provider: "zenrows", cost: r.cost, error: null, costBasis: r.costBasis ?? "estimated", statusCode: 304, vendorStatus: null, headers, notModified: true }
        if (r.body) return { ok: true, html: r.body, provider: "zenrows", cost: r.cost, error: null, costBasis: r.costBasis ?? "estimated", statusCode: r.statusCode, vendorStatus: null, headers, notModified: false }
        lastError = "ZenRows returned an empty body"
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        const st = (err as { status?: unknown } | null)?.status
        lastVendorStatus = typeof st === "number" ? st : null
        console.warn("[scrapeSiteWithBestProvider] ZenRows failed, trying the next provider:", lastError)
      }
    } else {
      if (!zyteConfigured()) continue
      lastProvider = "zyte"
      const z = await scrapeWithZyte(url, { jsRender: options.jsRender, requestHeaders: options.requestHeaders ?? null, withHeaders: options.withHeaders })
      const headers = options.withHeaders ? (z.headers ?? null) : null
      if (z.ok) return { ok: true, html: z.html, provider: "zyte", cost: z.cost, error: null, costBasis: "estimated", statusCode: z.statusCode, vendorStatus: null, headers, notModified: z.notModified === true }
      lastError = z.error
      lastVendorStatus = z.mode === null ? z.statusCode : null
    }
  }
  if (lastProvider) return { ok: false, html: "", provider: lastProvider, cost: 0, error: lastError, costBasis: "none", statusCode: null, vendorStatus: lastVendorStatus, headers: null, notModified: false }
  return { ok: false, html: "", provider: null, cost: 0, error: "no scrape provider configured (ZENROWS_API_KEY / ZYTE_API_KEY both unset)", costBasis: "none", statusCode: null, vendorStatus: null, headers: null, notModified: false }
}

export async function extractContactsFromHtml(html: string): Promise<{
  emails: string[]
  phones: string[]
}> {
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
  const phoneRegex = /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g

  const emails = html.match(emailRegex) || []
  const phones = html.match(phoneRegex) || []

  return {
    emails: [...new Set(emails)],
    phones: [...new Set(phones)],
  }
}
