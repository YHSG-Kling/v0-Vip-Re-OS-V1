#!/usr/bin/env tsx
/**
 * scripts/local-intel-guard.ts   (npm run test:local-intel — run with --conditions=react-server:
 *                                 it imports the server-only RSS parser and topic renderer)
 * ─────────────────────────────────────────────────────────────────────────────
 * LOCAL INTELLIGENCE (wave 144, lane 144G — owner ruling 14), proven in memory: the search /
 * news / feed providers are STUBBED (no network, no spend), the database is an in-memory
 * supabase-shaped client that ENFORCES the live constraints this lane found (content_topic_bank
 * source_id NOT NULL; UNIQUE (source_id, source_url)), and the REAL pass
 * (lib/content-intel/local-intel.ts runLocalIntelPass) runs end to end over the REAL pull gate
 * (lib/lead-pipeline/scrape-territories.ts resolveActivePullGate).
 *
 *   A  existing providers only: the web_search capability, NewsAPI.ai, the RSS parser; no new paid
 *      scraper import; no new local-events table in this wave's migrations; one topic pool
 *   B  discovery + screening: a fact must NAME the place, carry a date when it is an event, sit
 *      inside the horizon, not be expired; crime / school-rating / religious / demographic topics
 *      and high fair-housing phrases are dropped WITH their reason counted; low confidence dropped
 *   C  storage: date, location, freshness, source, confidence, attribution on every stored fact;
 *      never a body (excerpt ≤ 280 chars); provenance source_id on every row
 *   D  expired vs upcoming: the ONE classifier; an event expires the day after it ends (the
 *      picker's expires_at filter can never promote it); the stale sweep; recaps readable
 *   E  feeds: ICS + RSS through the existing parser; robots.txt honoured (denied → no fetch;
 *      unreadable → fail closed); a feed outside the active territories is not pulled
 *   F  spend: the REAL webSearch books each served search (platform-covered, systemSource
 *      local_intel, tenant-attributed, idempotent); "none" books nothing; a refused gate / no
 *      territory / ledger replay spends nothing
 *   G  tenant isolation: every tenant-table op of A's pass is pinned to A
 *   H  idempotency: a re-observation updates, never duplicates; a used fact is not resurrected
 *   I  the feed into content: the writer's grounding block (upcoming vs expired, the "name only
 *      what is listed" rule), the newsletter writer wired to it, topic renderer credits the source
 *   J  provenance census: every content_topic_bank insert in lib/ + app/ names source_id (stripped
 *      source, positive control), the known outside-lane writer listed, not hidden
 *   W  integration: the cron route + registry / owner / chain membership the integrator lands
 *
 * Pure: no network, no database. Run: npx tsx --conditions=react-server scripts/local-intel-guard.ts
 */
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import {
  runLocalIntelPass, runLocalIntelSweep, loadLocalFacts, renderLocalFactsForPrompt, parseIcsEvents, extractEventDate,
  classifyLocalTemporal, factFromHit, mergeLocalFacts, localIntelWebSearch, LOCAL_FACT_KINDS, LOCAL_INTEL_USER_AGENT,
  type LocalIntelDeps, type LocalTerritory,
} from "../lib/content-intel/local-intel"
import { parseRssXml } from "../lib/content-intel/rss-scraper"
import { renderTopicsForPrompt } from "../lib/content-intel/topic-bank"
import { resolveActivePullGate } from "../lib/lead-pipeline/scrape-territories"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(read(p))

// ── in-memory supabase-shaped client (enforces the two live constraints this lane relies on) ──
type Row = Record<string, any>
interface Op { table: string; op: string; filters: Array<[string, any]>; rows?: Row[] }
function makeDb(seed: Record<string, Row[]>, opts: { refuse?: Set<string> } = {}) {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }))
  const log: Op[] = []
  let seq = 0
  const containsPred = (cell: any, v: any) => Array.isArray(v)
    ? Array.isArray(cell) && v.every((x) => cell.includes(x))
    : !!cell && typeof cell === "object" && Object.entries(v).every(([k, x]) => cell[k] === x)
  function from(table: string) {
    const filters: Array<[string, any]> = []
    const preds: Array<(r: Row) => boolean> = []
    let op = "select", payload: Row[] = [], patch: Row = {}, wantRows = false, single = false, limitN = Infinity
    let order: { col: string; asc: boolean } | null = null
    const b: any = {
      select() { if (op !== "select") wantRows = true; return b },
      insert(p: Row | Row[]) { op = "insert"; payload = Array.isArray(p) ? p : [p]; return b },
      update(p: Row) { op = "update"; patch = p; return b },
      eq(c: string, v: any) { filters.push([c, v]); preds.push((r) => r[c] === v); return b },
      is(c: string, v: any) { filters.push([c, v]); preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b },
      in(c: string, vs: any[]) { filters.push([c, vs]); preds.push((r) => vs.includes(r[c])); return b },
      gte(c: string, v: any) { filters.push([c, v]); preds.push((r) => r[c] != null && r[c] >= v); return b },
      lt(c: string, v: any) { filters.push([c, v]); preds.push((r) => r[c] != null && r[c] < v); return b },
      contains(c: string, v: any) { filters.push([c, v]); preds.push((r) => containsPred(r[c], v)); return b },
      order(c: string, o?: { ascending?: boolean }) { order = { col: c, asc: o?.ascending !== false }; return b },
      limit(n: number) { limitN = n; return b },
      maybeSingle() { single = true; return b },
      single() { single = true; return b },
      then(resolve: (v: any) => void) {
        log.push({ table, op, filters: [...filters], rows: payload.length ? payload : undefined })
        if (opts.refuse?.has(table)) return resolve({ data: null, error: { message: `relation "${table}" refused (fixture)` } })
        const t = (tables[table] ??= [])
        if (op === "insert") {
          const out: Row[] = []
          for (const p of payload) {
            if (table === "content_topic_bank") {
              // LIVE: source_id uuid NOT NULL (m128) and UNIQUE (source_id, source_url) WHERE source_url IS NOT NULL.
              if (!p.source_id) return resolve({ data: null, error: { code: "23502", message: 'null value in column "source_id" of relation "content_topic_bank" violates not-null constraint' } })
              if (p.source_url && t.some((r) => r.source_id === p.source_id && r.source_url === p.source_url)) return resolve({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint uq_content_topic_bank_source_url" } })
            }
            const row = { id: p.id ?? `row-${table}-${++seq}`, created_at: new Date(1_700_000_000_000 + seq).toISOString(), ...p }
            t.push(row); out.push(row)
          }
          const data = wantRows ? (single ? out[0] ?? null : out) : null
          return resolve({ data, error: null })
        }
        let rows = t.filter((r) => preds.every((p) => p(r)))
        if (op === "update") { for (const r of rows) Object.assign(r, patch); return resolve({ data: wantRows ? rows : null, error: null }) }
        if (order) { const { col, asc } = order; rows = [...rows].sort((x, y) => (x[col] > y[col] ? 1 : x[col] < y[col] ? -1 : 0) * (asc ? 1 : -1)) }
        rows = rows.slice(0, limitN)
        return resolve({ data: single ? rows[0] ?? null : rows, error: null })
      },
    }
    return b
  }
  return { from, tables, log }
}

// ── fixtures (fictional tenants and places; no real territory) ───────────────
const A = "00000000-0000-4000-8000-0000000000a1", B = "00000000-0000-4000-8000-0000000000b2"
const DAY = 86_400_000
// The pass rotates two kinds per territory by day; pin NOW to a day whose rotation starts at
// local_event for territory 0 (dayIndex % 6 === 0) so the fixture is deterministic.
const BASE = Date.UTC(2026, 9, 25, 15, 0, 0)
const NOW = new Date(BASE + ((6 - (Math.floor(BASE / DAY) % 6)) % 6) * DAY)
const plus = (d: number) => new Date(NOW.getTime() + d * DAY)
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]
const longDate = (d: Date) => `${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`
const noYear = (d: Date) => `${MONTH[d.getUTCMonth()]} ${d.getUTCDate()}`
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const icsDate = (d: Date) => ymd(d).replace(/-/g, "")

function seed(): Record<string, Row[]> {
  return {
    subscriptions: [
      { brokerage_id: A, status: "active", trial_end: null },
      { brokerage_id: B, status: "active", trial_end: null },
    ],
    lead_scraping_markets: [
      { id: "m-a1", brokerage_id: A, is_active: true, priority: 2, city: "Alderbrook", state: "QA", zip_codes: ["99501"], counties: [] },
      { id: "m-a2", brokerage_id: A, is_active: true, priority: 1, city: "Cedar Hollow", state: "QA", zip_codes: ["99502"], counties: [] },
      { id: "m-b1", brokerage_id: B, is_active: true, priority: 1, city: "Bexley Falls", state: "QB", zip_codes: ["88801"], counties: [] },
    ],
    content_topic_sources: [
      { id: "src-platform-rss", brokerage_id: null, source_type: "rss", is_active: true, label: "HousingWire RSS", source_config: { feed_url: "https://www.housingwire.example/feed" } },
      { id: "feed-ics", brokerage_id: A, source_type: "rss", is_active: true, label: "City of Alderbrook calendar", source_config: { feed_url: "https://calendar.alderbrook.gov/events.ics", local_intel: { city: "Alderbrook", state: "QA", kind: "local_event", publisher: "City of Alderbrook" } } },
      { id: "feed-rss", brokerage_id: A, source_type: "rss", is_active: true, label: "Cedar Hollow Town News", source_config: { feed_url: "https://www.cedarhollow.example.com/news/rss", local_intel: { city: "Cedar Hollow", state: "QA" } } },
      { id: "feed-denied", brokerage_id: A, source_type: "rss", is_active: true, label: "Blocked feed", source_config: { feed_url: "https://blocked.example.net/feed.xml", local_intel: { city: "Alderbrook", state: "QA" } } },
      { id: "feed-far", brokerage_id: A, source_type: "rss", is_active: true, label: "Far away feed", source_config: { feed_url: "https://faraway.example.org/feed.xml", local_intel: { city: "Far Away", state: "ZZ" } } },
      { id: "feed-down", brokerage_id: A, source_type: "rss", is_active: true, label: "Unreachable feed", source_config: { feed_url: "https://down.example.io/feed.xml", local_intel: { city: "Alderbrook", state: "QA" } } },
      { id: "feed-plain", brokerage_id: A, source_type: "rss", is_active: true, label: "Generic industry feed", source_config: { feed_url: "https://industry.example/feed" } },
    ],
    content_topic_bank: [
      // B's own local fact — A's pass must never touch it.
      { id: "b-fact-1", source_id: "b-sys", brokerage_id: B, topic_title: "Bexley Falls Lantern Walk", source_url: "https://bexleyfalls.gov/lantern", categories: ["neighborhood", "local_intel"], status: "fresh", expires_at: plus(5).toISOString(), scraped_at: NOW.toISOString(), raw_data: { local_fact_key: "bexleyfalls.gov/lantern", local_fact: { kind: "local_event", event_start: ymd(plus(4)), publisher: "City of Bexley Falls" } } },
    ],
  }
}

const filler = "Lorem community details ".repeat(250) // ~6,000 chars — a full page body the store must never keep
const hit = (url: string, title: string, snippet: string, publishedAt: string | null = null, author: string | null = null) => ({ url, title, snippet, publishedAt, author })
const searchCalls: Array<{ query: string; withinDays: number | null; idempotencyKey: string }> = []
const search: NonNullable<LocalIntelDeps["search"]> = async (p) => {
  searchCalls.push({ query: p.query, withinDays: p.withinDays, idempotencyKey: p.idempotencyKey })
  const q = p.query
  if (q.includes("upcoming community events") && q.includes("Alderbrook")) return { provider: "tavily", cost: 0.008, booked: true, hits: [
    hit("https://www.alderbrook.gov/events/fall-festival?utm_source=x", "Alderbrook Fall Festival", `Join us Saturday, ${longDate(plus(14))} at Riverside Park in Alderbrook for music and food trucks. ${filler}`),
    hit("https://alderbrooktimes.example.com/fall-festival", "Fall Festival — Alderbrook", `The festival returns ${longDate(plus(14))} to Riverside Park.`, plus(-2).toISOString(), "Alderbrook Times"),
    hit("https://events.example.com/holiday-market", "Alderbrook Holiday Market", "Dates to be announced for the Alderbrook holiday market."),
    hit("https://events.example.com/harvest-5k", "Alderbrook Harvest 5K", `Ran on ${longDate(plus(-20))} through downtown Alderbrook.`),
    hit("https://events.example.com/pumpkin", "Springfield Pumpkin Patch", `Open ${longDate(plus(6))} — fun for all.`),
    hit("https://news.example.com/arrest", "Police arrest suspect near Alderbrook festival grounds", `Officers responded on ${longDate(plus(3))}.`),
    hit("https://events.example.com/bazaar", "St. Mark's Church fall bazaar in Alderbrook", `Saturday ${longDate(plus(8))} in the parish hall.`),
    hit("https://events.example.com/block-party", "Alderbrook block party", `Perfect for families! ${longDate(plus(9))} on Elm St.`),
    hit("https://events.example.com/spring-fair", "Alderbrook Spring Fair", `Mark your calendar: ${longDate(plus(200))}.`),
    hit("https://events.example.com/tree-lighting", "Alderbrook Tree Lighting", `Downtown, ${noYear(plus(10))} at dusk.`),
    hit("https://www.alderbrook.gov/events/farmers-market", "Alderbrook Saturday Farmers Market", `Every week from ${longDate(plus(3))}, a short walk to great schools and the river.`),
  ] }
  if (q.includes("city council public hearing") && q.includes("Alderbrook")) return { provider: "tavily", cost: 0.008, booked: true, hits: [
    hit("https://alderbrooknews.example.com/main-street-rezoning", "Alderbrook City Council sets public hearing on Main Street rezoning", `The hearing is scheduled for ${longDate(plus(7))} at City Hall.`, plus(-2).toISOString(), "Alderbrook News"),
    hit("https://alderbrooknews.example.com/old-hearing", "Alderbrook council hearing on budget", "Council met to discuss the budget.", plus(-70).toISOString()),
  ] }
  if (q.includes("city council public hearing") && q.includes("Cedar Hollow")) return { provider: "none", cost: 0, hits: [] }
  if (q.includes("grand opening") && q.includes("Cedar Hollow")) return { provider: "exa", cost: 0.007, booked: true, hits: [
    hit("https://cedarhollowpatch.example.com/coffee", "Grand opening: Cedar Hollow Coffee Co.", `Doors open ${longDate(plus(5))} on Mill Road in Cedar Hollow.`, plus(-1).toISOString()),
  ] }
  if (q.includes("Bexley Falls")) return { provider: "tavily", cost: 0.008, booked: true, hits: [
    hit("https://bexleyfalls.gov/events/harvest", "Bexley Falls Harvest Fair", `Join us ${longDate(plus(12))} in Bexley Falls.`),
  ] }
  return { provider: "none", cost: 0, hits: [] }
}
const newsCalls: Array<{ keyword: string; city: string }> = []
const news: NonNullable<LocalIntelDeps["news"]> = async () => async (q) => {
  newsCalls.push({ keyword: q.keyword, city: q.city })
  if (q.city !== "Alderbrook") return []
  return [{ title: "Alderbrook approves new library expansion", body: `The Alderbrook council approved the library expansion. ${filler}`, url: "https://news.example.org/alderbrook-library", dateTimePub: plus(-1).toISOString(), source: "Alderbrook Gazette" }]
}
const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//City of Alderbrook//Calendar//EN",
  "BEGIN:VEVENT", "UID:evt-101@alderbrook.gov", `DTSTART;VALUE=DATE:${icsDate(plus(9))}`, `DTEND;VALUE=DATE:${icsDate(plus(10))}`,
  "SUMMARY:Alderbrook Library Book Fair", "LOCATION:Alderbrook Public Library\\, 12 Oak St", "DESCRIPTION:Used books\\, author talks and a", " children's reading corner.", "END:VEVENT",
  "BEGIN:VEVENT", "UID:evt-102@alderbrook.gov", `DTSTART:${icsDate(plus(20))}T150000Z`, `DTEND:${icsDate(plus(22))}T230000Z`,
  "SUMMARY:Riverside Art Walk", "LOCATION:Riverside Park", "URL:https://www.alderbrook.gov/events/art-walk", "END:VEVENT",
  "BEGIN:VEVENT", "UID:evt-099@alderbrook.gov", `DTSTART;VALUE=DATE:${icsDate(plus(-5))}`, "SUMMARY:Alderbrook Clean-up Day", "END:VEVENT",
  "BEGIN:VEVENT", "UID:evt-103@alderbrook.gov", `DTSTART;VALUE=DATE:${icsDate(plus(11))}`, "SUMMARY:Cancelled Parade", "STATUS:CANCELLED", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n")
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Cedar Hollow Town News</title>
<item><title><![CDATA[Cedar Hollow opens the new Ridge trailhead]]></title><link>https://www.cedarhollow.example.com/news/trailhead</link><description><![CDATA[The town opened the Ridge trailhead parking area. ${filler}]]></description><pubDate>${plus(-1).toUTCString()}</pubDate></item>
<item><title>Cedar Hollow summer recap</title><link>https://www.cedarhollow.example.com/news/summer</link><description>Old news.</description><pubDate>${plus(-40).toUTCString()}</pubDate></item>
</channel></rss>`
const fetchCalls: string[] = []
const fetchText: NonNullable<LocalIntelDeps["fetchText"]> = async (url) => {
  fetchCalls.push(url)
  const docs: Record<string, { ok: boolean; status: number | null; text: string | null }> = {
    "https://calendar.alderbrook.gov/robots.txt": { ok: true, status: 200, text: "User-agent: *\nDisallow: /private/\n" },
    "https://calendar.alderbrook.gov/events.ics": { ok: true, status: 200, text: ICS },
    "https://www.cedarhollow.example.com/robots.txt": { ok: false, status: 404, text: null },
    "https://www.cedarhollow.example.com/news/rss": { ok: true, status: 200, text: RSS },
    "https://blocked.example.net/robots.txt": { ok: true, status: 200, text: "User-agent: VipReOS-LocalIntel\nDisallow: /\n\nUser-agent: *\nAllow: /\n" },
    "https://blocked.example.net/feed.xml": { ok: true, status: 200, text: RSS },
    "https://down.example.io/robots.txt": { ok: false, status: null, text: null },
    "https://down.example.io/feed.xml": { ok: true, status: 200, text: RSS },
  }
  return docs[url] ?? { ok: false, status: 404, text: null }
}
const allow: NonNullable<LocalIntelDeps["gate"]> = async () => ({ allowed: true, reason: "subscription_current" })
const runAlways: NonNullable<LocalIntelDeps["ledger"]> = async (_b, _d, run) => run()
const ledgerSeen = new Set<string>()
const ledgerOnce: NonNullable<LocalIntelDeps["ledger"]> = async (b, d, run) => { const k = `${b}:${d}`; if (ledgerSeen.has(k)) return null; ledgerSeen.add(k); return run() }

async function main() {
  const db = makeDb(seed())
  const pullGate = await resolveActivePullGate(db) as unknown as NonNullable<LocalIntelDeps["pullGate"]>
  const deps = (over: Partial<LocalIntelDeps> = {}): LocalIntelDeps => ({ db, now: NOW, pullGate, search, news, fetchText, parseRss: parseRssXml, gate: allow, ledger: runAlways, ...over })

  console.log("\n[A · existing providers, one topic pool]")
  const li = code("lib/content-intel/local-intel.ts")
  check("A1 discovery rides the registered web_search capability with its spend attribution (webSearch(…spend…), research mode)",
    /await import\("@\/lib\/ai\/web-search"\)/.test(li) && /webSearch\(\{[\s\S]{0,260}spend:\s*\{\s*brokerageId:\s*p\.brokerageId,\s*systemSource:\s*"local_intel"/.test(li) && /mode:\s*"research"/.test(li))
  check("A2 news rides the owner-selected NewsAPI.ai adapter + its key cascade (resolveNewsApiAiKey / searchNewsApiAiArticles)", /resolveNewsApiAiKey\(db, brokerageId\)/.test(li) && /searchNewsApiAiArticles\(/.test(li))
  check("A3 feeds parse with the EXISTING RSS parser (parseRssXml) — and fetchRssFeed now delegates to it (one parser)",
    /parseRssXml/.test(li) && /return parseRssXml\(res\.data/.test(code("lib/content-intel/rss-scraper.ts")))
  const PAID_SCRAPERS = /(zenrows|apify|firecrawl|zyte|scrapingbee|brightdata|serpapi)/i
  check("A4 no new paid scraper: local-intel imports no ZenRows / Apify / Firecrawl / Zyte / SerpAPI client", !PAID_SCRAPERS.test(li.match(/import[^\n]*/g)?.join("\n") ?? ""))
  check("A4c POSITIVE CONTROL: the paid-scraper finder sees a planted import", PAID_SCRAPERS.test(`import { zenrowsFetch } from "@/lib/providers/zenrows"`))
  const migs = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"))
  const SECOND_POOL = /create\s+table[^;(]*\b(local_(events?|facts?|intel\w*|news_items)|community_events?)\b/i
  const newTables = migs.filter((f) => SECOND_POOL.test(stripComments(read(`supabase/migrations/${f}`))))
  check(`A5 no migration creates a second local-events / facts table (${migs.length} migration files scanned; local_news_sources is the pre-existing config table)`, newTables.length === 0, newTables.join(", "))
  check("A5c POSITIVE CONTROL: the finder sees a planted events table, and not the existing local_news_sources", SECOND_POOL.test("create table if not exists public.local_events (id uuid)") && !SECOND_POOL.test("create table public.local_news_sources (id uuid)"))
  check("A6 facts are written to content_topic_bank — the ONE pool pickTopics reads (no other table written by the pass)",
    /from\("content_topic_bank"\)[\s\S]{0,40}\.insert\(row\)/.test(li) && !/from\("(local_|community_)/.test(li))

  console.log("\n[B · discovery and screening — deterministic, every drop counted]")
  const r1 = await runLocalIntelPass(A, deps({ ledger: ledgerOnce }))
  console.log(`    territories: ${r1.territories.join(" | ")} · kinds: ${r1.kindsSearched.join(", ")}`)
  console.log(`    captured ${r1.captured} · merged ${r1.merged} · promoted ${r1.promoted} · dropped ${JSON.stringify(r1.dropped)}`)
  check("B1 the pass ran over the tenant's OWN active territories (lead_scraping_markets via the pull gate)", r1.ran && !r1.skipped && r1.territories.join("|") === "Alderbrook, QA|Cedar Hollow, QA", r1.territories.join("|"))
  check("B2 local_event was searched for the first territory (rotation pinned by the fixture)", r1.kindsSearched.includes("Alderbrook, QA:local_event"))
  check("B3 a page that does not NAME the place is dropped (not_local)", (r1.dropped.not_local ?? 0) >= 1)
  check("B4 an event with no date is dropped (event_undated) — a date is never guessed", (r1.dropped.event_undated ?? 0) === 1)
  check("B5 a past event is dropped at capture (expired_at_capture: 1 web + 1 ICS)", (r1.dropped.expired_at_capture ?? 0) === 2, JSON.stringify(r1.dropped))
  check("B6 crime/safety, religious-congregation topics are excluded with their reason", (r1.dropped["excluded_topic:crime_safety"] ?? 0) === 1 && (r1.dropped["excluded_topic:religious_congregation"] ?? 0) === 1)
  check("B7 a HIGH fair-housing phrase drops the fact (fair_housing_phrase)", (r1.dropped.fair_housing_phrase ?? 0) === 1)
  check("B8 an event beyond the horizon is dropped (beyond_horizon)", (r1.dropped.beyond_horizon ?? 0) === 1)
  check("B9 an inferred-year web event falls under the confidence floor (low_confidence)", (r1.dropped.low_confidence ?? 0) >= 1)
  check("B10 stale news is dropped (stale_news: 70-day-old civic item + 40-day-old feed item)", (r1.dropped.stale_news ?? 0) === 2, JSON.stringify(r1.dropped))
  const tTemple: LocalTerritory = { city: "Temple", state: "QC", zipCodes: [], counties: [] }
  const temple = factFromHit({ url: "https://temple.gov/events/jazz", title: "Temple Jazz Night", snippet: `Downtown Temple, ${longDate(plus(4))}.` }, { kind: "local_event", territory: tTemple, provider: "tavily", sourceClass: "web", sourceId: "s", now: NOW })
  check("B11 the place's own name is not a topic (a city called Temple is not a religious topic)", "fact" in temple)
  const school = factFromHit({ url: "https://x.example/s", title: "Alderbrook top-rated schools list", snippet: "School rankings for Alderbrook." }, { kind: "local_news", territory: { city: "Alderbrook", state: "QA", zipCodes: [], counties: [] }, provider: "tavily", sourceClass: "web", sourceId: "s", now: NOW })
  check("B12 school-rating topics are excluded (school_rating)", "drop" in school && school.drop === "excluded_topic:school_rating")

  console.log("\n[C · what is stored: date, location, freshness, source, confidence — never a body]")
  const bankA = db.tables.content_topic_bank.filter((r) => r.brokerage_id === A)
  const titles = bankA.map((r) => r.topic_title).sort()
  console.log(`    stored for A (${bankA.length}): ${titles.join(" | ")}`)
  const expected = ["Alderbrook City Council sets public hearing on Main Street rezoning", "Alderbrook Fall Festival", "Alderbrook Library Book Fair", "Alderbrook Saturday Farmers Market", "Alderbrook approves new library expansion", "Cedar Hollow opens the new Ridge trailhead", "Grand opening: Cedar Hollow Coffee Co.", "Riverside Art Walk"].sort()
  check("C1 exactly the verified facts were stored (8): official + corroborated event, ICS events, civic hearing, opening, news, feed news", JSON.stringify(titles) === JSON.stringify(expected), titles.join(" | "))
  const everyField = bankA.every((r) => r.source_id && r.source_url && r.scraped_at && r.expires_at && r.geo_relevance?.cities?.length && r.raw_data?.local_fact?.publisher && typeof r.raw_data?.local_fact?.confidence === "number" && r.raw_data?.local_fact?.kind && r.categories.includes("local_intel") && r.status === "fresh")
  check("C2 every stored fact carries source_id, source_url, publisher, confidence, kind, geo, scraped_at, expires_at", everyField)
  const fest = bankA.find((r) => r.topic_title === "Alderbrook Fall Festival")!
  check("C3 the festival: official source kept as primary, the newspaper corroborates (+0.1 → 0.90), date + location stored",
    !!fest && fest.source_url.startsWith("https://www.alderbrook.gov/") && fest.raw_data.local_fact.source_class === "official" && fest.raw_data.local_fact.confidence === 0.9
      && fest.raw_data.local_fact.event_start === ymd(plus(14)) && fest.raw_data.local_fact.corroborating_urls.length === 1 && fest.geo_relevance.cities[0] === "Alderbrook" && fest.geo_relevance.zip_codes[0] === "99501",
    JSON.stringify(fest?.raw_data?.local_fact))
  const longest = Math.max(...bankA.map((r) => (r.raw_data.local_fact.excerpt ?? "").length))
  const rawKeys = new Set(bankA.flatMap((r) => Object.keys(r.raw_data.local_fact)))
  check(`C4 never a body: every excerpt ≤ 280 chars (longest ${longest}) and no body / text / content field is stored`, longest <= 280 && !["body", "text", "content", "summary"].some((k) => rawKeys.has(k)))
  check("C5 attribution + originality ride into every writer's angle (credit by name, link, never copy)", bankA.every((r) => /credit .+ by name and link to the source; never copy its text/.test(r.value_angle) && /ORIGINAL/.test(r.value_angle)))
  const fm = bankA.find((r) => r.topic_title === "Alderbrook Saturday Farmers Market")!
  check("C6 a MEDIUM fair-housing phrase keeps the fact but lowers confidence (0.70) and travels as a compliance note", fm?.raw_data.local_fact.confidence === 0.7 && /great schools/.test(fm.raw_data.local_fact.compliance_note ?? ""))
  const hearing = bankA.find((r) => /Main Street rezoning/.test(r.topic_title))!
  check("C7 the civic hearing date is the HEARING (not the publish dateline), on the confidence floor (0.50)", hearing?.raw_data.local_fact.event_start === ymd(plus(7)) && hearing.raw_data.local_fact.confidence === 0.5)
  const lib = bankA.find((r) => /library expansion/.test(r.topic_title))!
  check("C8 a news-provider fact: publisher is the outlet, published date kept, source_class news", lib?.raw_data.local_fact.publisher === "Alderbrook Gazette" && lib.raw_data.local_fact.source_class === "news" && lib.topic_posted_at === plus(-1).toISOString())
  const sys = db.tables.content_topic_sources.filter((r) => r.brokerage_id === A && r.source_type === "manual")
  check("C9 web / news facts file under ONE system source row for A ('manual', system_writer local_intel); feed facts under their feed row",
    sys.length === 1 && sys[0].source_config.system_writer === "local_intel" && bankA.filter((r) => r.raw_data.local_fact.provider !== "feed").every((r) => r.source_id === sys[0].id)
      && bankA.filter((r) => r.raw_data.local_fact.provider === "feed").every((r) => r.source_id === "feed-ics" || r.source_id === "feed-rss"))
  check("C10 categories reuse the readers' spellings (neighborhood / market_education) + the local_intel marker — no new reader spelling",
    bankA.every((r) => r.categories.every((c: string) => ["neighborhood", "market_education", "local_intel"].includes(c)) && r.categories.some((c: string) => c === "neighborhood" || c === "market_education")))
  check("C11 engagement_score is an integer 0..100 (the live CHECK)", bankA.every((r) => Number.isInteger(r.engagement_score) && r.engagement_score >= 0 && r.engagement_score <= 100))

  console.log("\n[D · expired vs upcoming — the ONE classifier]")
  const festExp = Date.parse(fest.expires_at)
  check("D1 an event expires the day AFTER it ends at 12:00 UTC (the picker's expires_at > now filter drops it then)", fest.expires_at === new Date(Date.parse(`${ymd(plus(14))}T00:00:00.000Z`) + DAY + 12 * 3_600_000).toISOString())
  check("D2 classify: before → upcoming, on the day → ongoing, after expiry → expired, undated fresh → current",
    classifyLocalTemporal({ eventStart: ymd(plus(14)), expiresAt: fest.expires_at }, NOW) === "upcoming"
      && classifyLocalTemporal({ eventStart: ymd(plus(14)), expiresAt: fest.expires_at }, new Date(Date.parse(`${ymd(plus(14))}T18:00:00Z`))) === "ongoing"
      && classifyLocalTemporal({ eventStart: ymd(plus(14)), expiresAt: fest.expires_at }, new Date(festExp + 1)) === "expired"
      && classifyLocalTemporal({ eventStart: null, expiresAt: plus(3).toISOString() }, NOW) === "current")
  const now0 = await loadLocalFacts(db, A, { now: NOW, includeExpired: true, limit: 20 })
  check("D3 the reader returns A's facts with temporal state; events first, soonest first", !now0.error && now0.facts.length === 8 && now0.facts[0].temporal === "upcoming" && now0.facts.filter((f) => f.temporal === "upcoming").every((f, i, xs) => i === 0 || (xs[i - 1].eventStart ?? "") <= (f.eventStart ?? "")))
  const later = new Date(festExp + DAY)
  const rLater = await runLocalIntelPass(A, deps({ now: later, search: async () => ({ provider: "none", cost: 0, hits: [] }), news: async () => null, fetchText: async () => ({ ok: false, status: 404, text: null }) }))
  const festAfter = db.tables.content_topic_bank.find((r) => r.id === fest.id)!
  check("D4 after the festival: the next pass's stale sweep flips it to 'stale' (out of the fresh pool)", festAfter.status === "stale" && rLater.staleMarked >= 1, `status=${festAfter.status} stale=${rLater.staleMarked}`)
  const recap = await loadLocalFacts(db, A, { now: later, includeExpired: true, limit: 20 })
  const festView = recap.facts.find((f) => f.title === "Alderbrook Fall Festival")
  check("D5 an expired event stays readable as a RECAP (temporal expired), never as upcoming", festView?.temporal === "expired")
  const noRecap = await loadLocalFacts(db, A, { now: later, limit: 20 })
  check("D6 without includeExpired the reader never returns it", !noRecap.facts.some((f) => f.title === "Alderbrook Fall Festival"))
  const ed1 = extractEventDate(`Published ${longDate(plus(-3))}. The parade steps off ${longDate(plus(6))}.`, { publishedAt: plus(-3).toISOString(), now: NOW })
  const ed2 = extractEventDate(`Held ${longDate(plus(-30))} and ${longDate(plus(-10))}.`, { now: NOW })
  const ed3 = extractEventDate(`Nov. 8–9, 2026`, { now: new Date("2026-10-01T00:00:00Z") })
  check("D7 date extraction: the dateline is skipped; all-past dates pick the latest (→ expired); ranges keep their end", ed1?.start === ymd(plus(6)) && ed2?.start === ymd(plus(-10)) && ed3?.start === "2026-11-08" && ed3?.end === "2026-11-09" && ed3?.basis === "text_explicit_year")
  const ed4 = extractEventDate("Join us January 10 for the polar plunge", { now: new Date("2026-10-25T00:00:00Z") })
  check("D8 a year-less January date read in October rolls to next year and is marked INFERRED", ed4?.start === "2027-01-10" && ed4?.basis === "text_inferred_year")

  console.log("\n[E · feeds: ICS + RSS, robots honoured, territory-gated]")
  const ics = parseIcsEvents(ICS)
  check("E1 ICS: folded lines unfolded, text unescaped, all-day DTEND exclusive, CANCELLED skipped", ics.length === 3 && ics[0].summary === "Alderbrook Library Book Fair" && ics[0].end === null && ics[0].location === "Alderbrook Public Library, 12 Oak St" && /reading corner/.test(ics[0].description ?? "") && ics[1].start === ymd(plus(20)) && ics[1].end === ymd(plus(22)) && !ics.some((e) => /Cancelled/.test(e.summary)))
  const bookFair = bankA.find((r) => r.topic_title === "Alderbrook Library Book Fair")!
  check("E2 an ICS event without its own URL keeps the feed URL + UID fragment (one row per event), date_basis ics, official host", !!bookFair && bookFair.source_url.startsWith("https://calendar.alderbrook.gov/events.ics#") && bookFair.raw_data.local_fact.date_basis === "ics" && bookFair.raw_data.local_fact.source_class === "official" && bookFair.raw_data.local_fact.venue === "Alderbrook Public Library, 12 Oak St")
  check("E3 robots.txt DISALLOW for our agent → the feed is never fetched (robots read only)", r1.feeds.robotsDenied === 1 && fetchCalls.includes("https://blocked.example.net/robots.txt") && !fetchCalls.includes("https://blocked.example.net/feed.xml"))
  check("E4 robots.txt unreachable → fail closed (not fetched, counted)", r1.feeds.robotsUnreadable === 1 && !fetchCalls.includes("https://down.example.io/feed.xml"))
  check("E5 a feed outside the tenant's active territories is not pulled at all (no robots, no fetch)", r1.feeds.outsideTerritory === 1 && !fetchCalls.some((u) => u.includes("faraway.example.org")))
  check("E6 a source without local_intel config is not a local feed (generic + platform feeds untouched)", !fetchCalls.some((u) => u.includes("industry.example") || u.includes("housingwire")))
  check("E7 robots 404 = no robots file → allowed; fetched feeds counted (ICS + RSS = 2)", r1.feeds.fetched === 2 && fetchCalls.includes("https://www.cedarhollow.example.com/news/rss"))
  check("E8 the honest user agent names itself and its purpose", /^VipReOS-LocalIntel\/1\.0 \(.*honours robots\.txt\)$/.test(LOCAL_INTEL_USER_AGENT))

  console.log("\n[F · spend: platform-covered, booked through the real webSearch, gated]")
  const meterCalls: any[] = []
  const tavilyFake = async () => ({ answer: "x", results: [{ title: "Alderbrook Pumpkin Run", url: "https://alderbrook.gov/run", content: `Alderbrook, ${longDate(plus(5))}`, publishedDate: null, score: 0.8 }], images: [], cost: 0.008 })
  const tavilyNone = async () => ({ answer: null, results: [], images: [], cost: 0 })
  const exaNone = async () => ({ results: [], cost: 0 })
  const meter = async (b: any) => { meterCalls.push(b); return true }
  const real = localIntelWebSearch({ tavily: tavilyFake as never, exa: exaNone as never, meter: meter as never })
  const served = await real({ query: "q Alderbrook", maxResults: 8, withinDays: null, brokerageId: A, idempotencyKey: "local_intel:A:day:alderbrook:local_event" })
  const none = await localIntelWebSearch({ tavily: tavilyNone as never, exa: exaNone as never, meter: meter as never })({ query: "q", maxResults: 8, withinDays: 10, brokerageId: A, idempotencyKey: "k2" })
  check("F1 a served search books ONE platform-covered vendor row: vendor tavily, web_search, systemSource local_intel, tenant-attributed, idempotent",
    served.booked === true && meterCalls.length === 1 && meterCalls[0].vendorName === "tavily" && meterCalls[0].usageType === "web_search" && meterCalls[0].systemSource === "local_intel" && meterCalls[0].brokerageId === A && meterCalls[0].coverage === "platform_covered" && meterCalls[0].idempotencyKey === "local_intel:A:day:alderbrook:local_event")
  check("F2 a search no provider served books nothing", none.provider === "none" && none.booked === false && meterCalls.length === 1)
  check("F3 the pass bounds and totals its spend (≤6 searches; cost summed; booked counted)", r1.searches <= 6 && r1.searches === 4 && r1.searchCostUsd === 0.023 && r1.searchesBooked === 3, `searches=${r1.searches} cost=${r1.searchCostUsd} booked=${r1.searchesBooked}`)
  check("F4 every search carries its own idempotency key (tenant + day + place + kind)", searchCalls.slice(0, 4).every((c) => c.idempotencyKey.startsWith(`local_intel:${A}:${ymd(NOW)}:`)) && new Set(searchCalls.slice(0, 4).map((c) => c.idempotencyKey)).size === 4)
  const dbGate = makeDb(seed()); const nS = searchCalls.length, nF = fetchCalls.length
  const rGate = await runLocalIntelPass(A, { ...deps(), db: dbGate, gate: async () => ({ allowed: false, reason: "subscription_lapsed" }) })
  check("F5 a refused gate (lapsed tenant) spends nothing — no search, no fetch, no write", !!rGate.skipped && searchCalls.length === nS && fetchCalls.length === nF && !dbGate.log.some((o) => o.op !== "select"))
  const dbNoTerr = makeDb({ ...seed(), lead_scraping_markets: seed().lead_scraping_markets.filter((m) => m.brokerage_id !== A) })
  const gateNoTerr = await resolveActivePullGate(dbNoTerr) as unknown as NonNullable<LocalIntelDeps["pullGate"]>
  const rNoTerr = await runLocalIntelPass(A, { ...deps(), db: dbNoTerr, pullGate: gateNoTerr })
  check("F6 no active territory → no pull, stated by the gate's own reason", /no_active_territories/.test(rNoTerr.skipped ?? "") && searchCalls.length === nS)
  const rReplay = await runLocalIntelPass(A, deps({ ledger: ledgerOnce }))
  check("F7 LAW 5: a second tick the same day replays from the ledger — no search, no spend", /already gathered today/.test(rReplay.skipped ?? "") && searchCalls.length === nS)
  const dbRefused = makeDb({ ...seed(), subscriptions: [] }, { refuse: new Set(["subscriptions"]) })
  const sweepRefused = await runLocalIntelSweep(dbRefused, { now: NOW })
  check("F8 the sweep FAILS CLOSED on an unreadable subscription read (nobody searched, reason named)", sweepRefused.reason === "subscription_query_failed" && sweepRefused.ran === 0 && searchCalls.length === nS)
  const dbOff = makeDb({ ...seed(), content_topic_sources: [...seed().content_topic_sources, { id: "sys-off", brokerage_id: A, source_type: "manual", is_active: false, label: "Local intelligence — events & news (system)", source_config: { system_writer: "local_intel" } }] })
  const rOff = await runLocalIntelPass(A, { ...deps(), db: dbOff })
  check("F9 the tenant's off switch: system source switched off → no web / news search (feeds still honour their own rows)", searchCalls.length === nS && rOff.searches === 0 && rOff.blindSpots.some((b) => /switched the local-intelligence topic source off/.test(b)))

  console.log("\n[G · tenant isolation]")
  const fresh = makeDb(seed())
  const gFresh = await resolveActivePullGate(fresh) as unknown as NonNullable<LocalIntelDeps["pullGate"]>
  await runLocalIntelPass(A, { ...deps(), db: fresh, pullGate: gFresh })
  const TENANT_TABLES = new Set(["content_topic_bank", "content_topic_sources"])
  const unpinned = fresh.log.filter((o) => TENANT_TABLES.has(o.table)).filter((o) => o.rows ? !o.rows.every((r) => r.brokerage_id === A) : !o.filters.some(([c, v]) => c === "brokerage_id" && v === A))
  check("G1 every topic-bank / topic-source read and write of A's pass is pinned to A", unpinned.length === 0, unpinned.map((o) => `${o.op} ${o.table}`).join(", "))
  const bFact = fresh.tables.content_topic_bank.find((r) => r.id === "b-fact-1")!
  check("G2 tenant B's fact is untouched by A's pass (status, scraped_at)", bFact.status === "fresh" && bFact.scraped_at === NOW.toISOString())
  check("G3 A's queries name only A's territories", searchCalls.slice(0, 4).every((c) => /Alderbrook|Cedar Hollow/.test(c.query) && !/Bexley/.test(c.query)))
  const bRead = await loadLocalFacts(fresh, B, { now: NOW, includeExpired: true })
  check("G4 B's reader returns only B's fact", bRead.facts.length === 1 && bRead.facts[0].topicId === "b-fact-1")

  console.log("\n[H · idempotency: re-observation updates, never duplicates]")
  const before = db.tables.content_topic_bank.filter((r) => r.brokerage_id === A).length
  const libRow = db.tables.content_topic_bank.find((r) => /library expansion/.test(r.topic_title))!
  libRow.status = "used"
  const rNext = await runLocalIntelPass(A, deps({ now: new Date(NOW.getTime() + 6 * 3_600_000) }))
  const after = db.tables.content_topic_bank.filter((r) => r.brokerage_id === A).length
  check("H1 the same facts seen again: 0 inserted, all 8 updated, row count unchanged", rNext.inserted === 0 && rNext.updated === 8 && after === before, `inserted=${rNext.inserted} updated=${rNext.updated} rows ${before}→${after}`)
  check("H2 observed_count increments on re-observation", (db.tables.content_topic_bank.find((r) => r.topic_title === "Alderbrook Library Book Fair")?.raw_data.local_fact.observed_count ?? 0) >= 2)
  check("H3 a fact a writer already USED is not resurrected to fresh", libRow.status === "used")
  const merged = mergeLocalFacts([
    { ...(factFromHit({ url: "https://a.example/x?utm_medium=s", title: "Alderbrook Food Fest", snippet: `Alderbrook ${longDate(plus(4))}` }, { kind: "local_event", territory: { city: "Alderbrook", state: "QA", zipCodes: [], counties: [] }, provider: "exa", sourceClass: "web", sourceId: "s", now: NOW }) as any).fact },
    { ...(factFromHit({ url: "https://a.example/x", title: "Alderbrook Food Fest", snippet: `Alderbrook ${longDate(plus(4))}` }, { kind: "local_event", territory: { city: "Alderbrook", state: "QA", zipCodes: [], counties: [] }, provider: "tavily", sourceClass: "web", sourceId: "s", now: NOW }) as any).fact },
  ])
  check("H4 utm variants of one URL are ONE fact, and one host is not corroboration", merged.length === 1 && merged[0].corroboratingUrls.length === 0)

  console.log("\n[I · the feed into content: grounding block, newsletter writer, topic renderer]")
  const block = renderLocalFactsForPrompt(now0.facts)
  check("I1 the grounding block lists upcoming events with date + source + link, and states the rule (name only what is listed; original words; credit + link)",
    /UPCOMING \/ HAPPENING NOW:/.test(block) && /Alderbrook Fall Festival — .*source: City of Alderbrook|Alderbrook Fall Festival — .*source: /.test(block) && /<https:\/\/www\.alderbrook\.gov\//.test(block) && /name a local event, date, venue, business or civic decision ONLY if it is listed above/.test(block))
  const recapBlock = renderLocalFactsForPrompt(recap.facts)
  const [beforeExpired, expiredSection = ""] = recapBlock.split("EXPIRED (recap only, never promote):")
  check("I2 after the date the festival appears ONLY under EXPIRED (recap only, never promote)", /Alderbrook Fall Festival/.test(expiredSection) && !/Alderbrook Fall Festival/.test(beforeExpired))
  const emptyBlock = renderLocalFactsForPrompt([])
  check("I3 no verified facts → the writer is told to name NO local event (fail closed)", /none verified/.test(emptyBlock) && /do not name any local event/.test(emptyBlock))
  const cc = code("lib/kernel/content-creators.ts")
  check("I4 the newsletter writer grounds on loadLocalFacts + renderLocalFactsForPrompt and puts the block in the prompt",
    /localIntel\.loadLocalFacts\(supabase, brokerageId/.test(cc) && /localIntel\.renderLocalFactsForPrompt\(/.test(cc) && /\$\{localFactsBlock\}/.test(cc))
  check("I5 an unreadable fact read renders as 'none verified' (the writer names nothing), never as the raw facts", /renderLocalFactsForPrompt\(localRead\.error \? \[\] : localRead\.facts\)/.test(cc))
  check("I6 the Insider events / civic / eats directions carry the grounding override (never invent one)", /GROUNDING OVERRIDE/.test(cc) && /Never invent one/.test(cc))
  const rendered = renderTopicsForPrompt([{ id: "t1", topic_title: "Alderbrook Fall Festival", value_angle: "Upcoming local event", source_url: "https://www.alderbrook.gov/events/fall-festival", categories: ["neighborhood", "local_intel"], engagement_score: 80, topic_posted_at: null, is_brokerage_local: true, geo_match: false }])
  const renderedPlain = renderTopicsForPrompt([{ id: "t2", topic_title: "Rates", value_angle: null, source_url: "https://x.example", categories: ["finance"], engagement_score: 50, topic_posted_at: null, is_brokerage_local: false, geo_match: false }])
  check("I7 every pickTopics consumer's prompt credits a local fact's source (and only a local fact's)", /Source \(credit \+ link, never copy\): https:\/\/www\.alderbrook\.gov/.test(rendered) && !/Source \(credit/.test(renderedPlain))
  check("I8 every kind reaches an existing reader category (newsletter / blog / podcast / video / reels / lead magnets filter on neighborhood or market_education)", LOCAL_FACT_KINDS.every((k) => /neighborhood|market_education/.test(li.slice(li.indexOf("LOCAL_FACT_CATEGORIES"), li.indexOf("KIND_LABEL")).split(`${k}:`)[1]?.split("]")[0] ?? "")))

  console.log("\n[J · provenance census — content_topic_bank.source_id is NOT NULL live]")
  const ROOTS = ["lib", "app"]
  const files: string[] = []
  const walk = (d: string) => { for (const e of readdirSync(join(ROOT, d))) { const p = `${d}/${e}`; const s = statSync(join(ROOT, p)); if (s.isDirectory()) { if (e !== "node_modules") walk(p) } else if (/\.(ts|tsx)$/.test(e)) files.push(p) } }
  for (const r of ROOTS) walk(r)
  const argsOf = (src: string, open: number) => { let d = 0; for (let i = open; i < src.length; i++) { const c = src[i]; if (c === "(" || c === "{" || c === "[") d++; else if (c === ")" || c === "}" || c === "]") { d--; if (d === 0) return src.slice(open + 1, i) } } return src.slice(open + 1) }
  /** Insert sites into content_topic_bank whose payload does not name source_id (object literal, a
   *  const initialised from one, or a same-file function returning one). Strings blanked AFTER the
   *  table name is located (the table name is itself a string). */
  const unsourced = (src: string): number => {
    const s = stripComments(src)
    let n = 0
    for (const m of s.matchAll(/\.from\(\s*["'`]content_topic_bank["'`]\s*\)/g)) {
      const tail = s.slice(m.index! + m[0].length, m.index! + m[0].length + 200)
      const ins = /^\s*\.insert\s*\(/.exec(tail)
      if (!ins) continue
      const open = m.index! + m[0].length + ins[0].length - 1
      const arg = argsOf(blankStrings(s), open).trim()
      let ok = /\bsource_id\b/.test(arg)
      const ident = /^([A-Za-z_$][\w$]*)$/.exec(arg)?.[1]
      if (!ok && ident) {
        const decl = new RegExp(`(?:const|let)\\s+${ident}\\s*=\\s*`).exec(s)
        if (decl) {
          const after = s.slice(decl.index + decl[0].length)
          const call = /^([A-Za-z_$][\w$]*)\s*\(/.exec(after)
          if (after.startsWith("{")) ok = /\bsource_id\b/.test(argsOf(after, 0))
          else if (call) { const fn = new RegExp(`function\\s+${call[1]}\\s*\\(`).exec(s); ok = !!fn && /\bsource_id\b/.test(s.slice(fn.index, fn.index + 1500)) }
        }
      }
      if (!ok) n++
    }
    return n
  }
  const censusFiles = files.filter((f) => /content_topic_bank/.test(read(f)))
  const sites = censusFiles.map((f) => ({ f, n: unsourced(read(f)) })).filter((x) => x.n > 0)
  // wave 144 integration: the ONE known outside-lane writer (lib/kernel/lookalike-audience.ts stageBriefs) now files under
  // resolveSystemTopicSource("lookalike_research") — its entry is removed, as J1r demanded. The list stays (empty) so a
  // future cross-lane hand-off is LISTED here, never hidden.
  const KNOWN_OUTSIDE_LANE = new Set<string>()
  const inserters = censusFiles.filter((f) => /\.from\(\s*["'`]content_topic_bank["'`]\s*\)\s*\.insert\s*\(/.test(stripComments(read(f))))
  console.log(`    insert sites census: ${inserters.length} files insert into content_topic_bank; unsourced: ${sites.map((x) => `${x.f} ×${x.n}`).join(", ") || "none"}`)
  check(`J1 every content_topic_bank insert names source_id (known outside-lane writers listed: ${KNOWN_OUTSIDE_LANE.size})`, sites.every((x) => KNOWN_OUTSIDE_LANE.has(x.f)), sites.map((x) => x.f).join(", "))
  check("J1r ratchet: every known outside-lane entry is still a real offender (remove it from the list once fixed)", [...KNOWN_OUTSIDE_LANE].every((f) => sites.some((x) => x.f === f)))
  check("J2 brand-listening, the competitor promoter, local-intel and the look-alike briefs all insert with source_id now", ["lib/competitive-intel/brand-listening.ts", "lib/competitive-intel/promote-to-topic-bank.ts", "lib/content-intel/local-intel.ts", "lib/kernel/lookalike-audience.ts"].every((f) => inserters.includes(f) && !sites.some((x) => x.f === f)))
  check("J3 POSITIVE CONTROL: a planted insert without source_id is found; one with it (literal, const, builder fn) is not",
    unsourced(`await db.from("content_topic_bank").insert({ brokerage_id: b, topic_title: "t" })`) === 1
      && unsourced(`await db.from("content_topic_bank").insert({ source_id: s, topic_title: "t" })`) === 0
      && unsourced(`const row = { source_id: s, topic_title: "t" }\nawait db.from("content_topic_bank").insert(row)`) === 0
      && unsourced(`function mk() { return { source_id: s } }\nconst row = mk()\nawait db.from("content_topic_bank").insert(row)`) === 0
      && unsourced(`// db.from("content_topic_bank").insert({ topic_title: "t" })`) === 0)
  const nn = makeDb({})
  const refused = await nn.from("content_topic_bank").insert({ brokerage_id: A, topic_title: "x" })
  check("J4 POSITIVE CONTROL: the fixture refuses a source-less topic exactly as the live NOT NULL does (23502)", refused.error?.code === "23502")

  console.log("\n[W · integration — the integrator lands these (lane 144G notes: Outside-lane / Registry / package.json)]")
  const route = existsSync(join(ROOT, "app/api/cron/local-intel/route.ts")) ? code("app/api/cron/local-intel/route.ts") : ""
  check("W1 the cron route authenticates (verifyCronAuth) and runs the sweep", /verifyCronAuth\(req\)/.test(route) && /runLocalIntelSweep\(/.test(route))
  check("W2 a refused pull-gate read is reported as a FAILURE (500), never an idle day", /_query_failed\$\//.test(route) && /status:\s*500/.test(route))
  const { CRON_REGISTRY } = await import("../lib/kernel/cron-dispatch")
  const { CRON_MANAGER, MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
  check("W3 the cron is registered (CRON_REGISTRY /api/cron/local-intel) — integrator: lib/kernel/cron-dispatch.ts", CRON_REGISTRY.some((c: { path: string }) => c.path === "/api/cron/local-intel"))
  check("W4 the cron has its owner (CRON_MANAGER campaign_orchestrator) — integrator: lane 144I", (CRON_MANAGER as Record<string, string>)["/api/cron/local-intel"] === "campaign_orchestrator")
  const md = (MAINTENANCE_DOMAINS as Record<string, { manager: string; proof: string; coOwners?: string[] }>)["local_intel"]
  check("W5 MAINTENANCE_DOMAINS.local_intel names this proof and its owner — integrator: lane 144I", md?.proof === "test:local-intel" && md.manager === "campaign_orchestrator")
  check("W6 test:local-intel is a member of the guard chain — integrator: package.json", new RegExp("npm run test:local-intel(\\s|&|$)").test(JSON.parse(read("package.json")).scripts.guard ?? ""))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" blind spots: providers stubbed (live recall, Tavily/Exa result shapes and NewsAPI.ai coverage unmeasured); date extraction is")
  console.log("              English month/day patterns + ISO + US numeric only (a page whose first future date is not the event's misdates it);")
  console.log("              the excluded-topic lists are conservative word lists (a 'Church Street' market is excluded; a novel steering")
  console.log("              phrasing passes to the writers' own compliance gates); feeds are tenant-configured content_topic_sources")
  console.log("              rss rows with a local_intel config — the generic RSS cron still ingests an RSS-format one too (Outside-lane);")
  console.log("              NewsAPI.ai calls ride the subscription key, logged by the gateway, not booked per call.")
  if (failed > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" LOCAL_INTEL_PASS")
}
main().catch((e) => { console.error(e); process.exit(1) })
