/**
 * lib/content-intel/rss-scraper.ts
 *
 * RSS feed parser for industry news sources (HousingWire, Inman, NAR
 * announcements, etc.). No third-party dep — pure regex extraction over
 * the `<item>` blocks every standards-conformant RSS 2.0 / Atom feed uses.
 *
 * Robust to:
 *   - RSS 2.0 (<item>...</item>) and Atom (<entry>...</entry>) shapes
 *   - CDATA-wrapped titles + descriptions
 *   - Missing pubDate (falls back to "scraped now")
 *
 * Routes through callConnector for the canonical single egress.
 */
import "server-only"
import { callConnector } from "@/lib/agentic-os/connector-gateway"

export interface RssItem {
  item_id:          string
  title:            string
  link:             string
  summary:          string
  published_date:   string | null
  /** Our normalized 0-100 score. RSS feeds don't carry engagement signal
   *  so this is "freshness × source-trust" — recent items from configured
   *  feeds score 60-90; older items decay. */
  engagement_score: number
  categories:       string[]
}

export async function fetchRssFeed(args: {
  feedUrl:    string
  /** Score floor for "premium" feeds (HousingWire/Inman) vs general (60). */
  sourceTrust?: number
}): Promise<RssItem[]> {
  const trust = Math.min(90, Math.max(40, args.sourceTrust ?? 60))
  const res = await callConnector<string>({
    connector: "rss",
    baseUrl:   "",
    path:      "",
    url:       args.feedUrl,
    method:    "GET",
    auth:      { style: "none" },
    headers:   { "User-Agent": "VipReOS-ContentIntel/1.0 (real-estate topic intelligence)" },
    responseType: "text",
    timeoutMs: 20_000,
  })
  if (!res.ok || !res.data) return []
  const xml = res.data

  const itemBlocks = extractBlocks(xml, "item")
  const entryBlocks = extractBlocks(xml, "entry")
  const blocks = itemBlocks.length > 0 ? itemBlocks : entryBlocks

  const now = Date.now()
  const out: RssItem[] = []
  for (const block of blocks.slice(0, 30)) {
    const title       = decodeText(extractField(block, "title") ?? "")
    const link        = (extractField(block, "link") ?? extractAtomLink(block) ?? "").trim()
    const description = decodeText(extractField(block, "description") ?? extractField(block, "summary") ?? "")
    const pubDate     = extractField(block, "pubDate") ?? extractField(block, "published") ?? null
    const guid        = (extractField(block, "guid") ?? link).trim()
    if (!title || !link) continue

    const publishedISO = pubDate ? safeIso(pubDate) : null
    const ageDays      = publishedISO ? Math.max(0, (now - Date.parse(publishedISO)) / 86_400_000) : 7
    const freshnessAdj = ageDays <= 3 ? +15 : ageDays <= 7 ? +5 : ageDays <= 21 ? 0 : -10
    const score        = Math.max(0, Math.min(100, trust + freshnessAdj))

    out.push({
      item_id:          guid || link,
      title:            title.slice(0, 240),
      link,
      summary:          stripHtml(description).slice(0, 4000),
      published_date:   publishedISO,
      engagement_score: score,
      categories:       inferCategoriesFromText(`${title} ${description}`),
    })
  }
  return out
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractBlocks(xml: string, tag: string): string[] {
  // Greedy block grab — handles namespaces by stripping prefix.
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}[\\s>][\\s\\S]*?<\\/(?:[\\w-]+:)?${tag}>`, "gi")
  return xml.match(re) ?? []
}

function extractField(block: string, field: string): string | null {
  // Try CDATA-wrapped first, then plain.
  const cdataRe = new RegExp(`<(?:[\\w-]+:)?${field}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/(?:[\\w-]+:)?${field}>`, "i")
  const cdata = block.match(cdataRe)
  if (cdata) return cdata[1].trim()
  const plainRe = new RegExp(`<(?:[\\w-]+:)?${field}[^>]*>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${field}>`, "i")
  const plain = block.match(plainRe)
  return plain ? plain[1].trim() : null
}

function extractAtomLink(block: string): string | null {
  // Atom: <link href="https://..." rel="alternate" />
  const m = block.match(/<link\s+[^>]*href="([^"]+)"[^>]*\/?>/i)
  return m ? m[1] : null
}

function decodeText(s: string): string {
  return s
    .replace(/&amp;/g,  "&")
    .replace(/&lt;/g,   "<")
    .replace(/&gt;/g,   ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'")
}

function stripHtml(s: string): string {
  return s.replace(/<\/?[^>]+>/g, "").replace(/\s+/g, " ").trim()
}

function safeIso(d: string): string | null {
  const t = Date.parse(d)
  return isNaN(t) ? null : new Date(t).toISOString()
}

function inferCategoriesFromText(text: string): string[] {
  const t = text.toLowerCase()
  const cats: string[] = []
  const add = (c: string) => { if (!cats.includes(c)) cats.push(c) }
  if (/\b(rate|mortgage|interest|refi|refinance|fha|va loan|conforming|jumbo)\b/.test(t)) add("finance")
  if (/\b(first time|first-time|down payment|closing cost|escrow|pre[- ]approval)\b/.test(t)) add("buyer_advice")
  if (/\b(sell|seller|listing agreement|cma|comp|appraisal)\b/.test(t)) add("seller_advice")
  if (/\b(market|inventory|home prices|housing market|forecast|trend|appreciation)\b/.test(t)) add("market_education")
  if (/\b(nar|tcpa|fair housing|disclosure|article 16|regulation|lawsuit|settlement|compliance)\b/.test(t)) add("regulation")
  if (/\b(neighborhood|school district|hoa|walkable|downtown)\b/.test(t)) add("neighborhood")
  if (/\b(renovation|remodel|home improvement|inspection|repair)\b/.test(t)) add("home_improvement")
  if (cats.length === 0) add("market_education")
  return cats
}
