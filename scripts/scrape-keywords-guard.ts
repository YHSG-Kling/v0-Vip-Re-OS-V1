/**
 * scripts/scrape-keywords-guard.ts — `npm run test:scrape-keywords`
 *
 * LANE 83A (wave 83, 2026-09-26). Owner verbatim: "on scrape sources, make sure keywords are setup
 * and correct." · "marketplace and cashbuyer should be turned on."
 *
 * No network. Every set is DERIVED (SourceKeys from SCRAPE_KEYWORD_POLICY, populations from
 * SOURCE_ACQUISITION, keyword types from the generated CHECK cache) — never a hand list.
 *   K1  every SourceKey answers "do you read keywords?"; non-readers say why; every reader is
 *       resolved in the cron (resolveSourceKeywords("<key>")).
 *   K2  SETUP — every reader has a non-empty default set for EVERY population it declares; each of
 *       the five populations is served by ≥2 keyword sources.
 *   K3  CORRECT — every default term classifies back to its own population (classifyIntentText);
 *       the lane-78-era seed rows that filed relocation / realtor-seeking under "buying_intent" are
 *       flagged (positive control).
 *   K4  the source's own NORMALIZER produces each declared population from its default keyword.
 *   K5  resolver: brokerage-scoped rows, keyword_type → population, Craigslist routing, territory
 *       rendering, round-robin keeps every population, Craigslist OR query.
 *   K6  cron wiring: no keywordsBySource gate, no "buying_intent" test, Nextdoor via the normalizer,
 *       keyword read carries brokerage_id and reads its error.
 *   K7  defaults ON: DEFAULT_MARKET_SOURCES ⊇ {batchdata_motivated, facebook_marketplace,
 *       batchdata_cash_buyer}; every fallback/writer uses it; m662's column default equals it.
 *   K8  admin keyword write: CHECK-derived types, session brokerage, default sources.
 * Every absence assertion carries a POSITIVE CONTROL (CLAUDE.md §2).
 */
import { readFileSync, readdirSync } from "fs"
import { stripComments, blankStrings } from "./strip-comments"
import { ALL_SOURCE_KEYS, DEFAULT_MARKET_SOURCES, expandEnabledSources, type SourceKey } from "../lib/lead-pipeline/source-intent-map"
import { SOURCE_ACQUISITION, recordAcquisitionIntents, type AcquisitionIntent } from "../lib/lead-pipeline/acquisition-coverage"
import {
  SCRAPE_KEYWORD_POLICY, KEYWORD_SOURCE_KEYS, DEFAULT_SCRAPE_KEYWORDS, KEYWORD_TYPE_INTENT,
  classifyIntentText, resolveSourceKeywords, renderKeywordQuery, matchResolvedKeyword, type ScrapeKeywordRow,
} from "../lib/lead-pipeline/scrape-keywords"
import {
  normalizeNextdoorPost, normalizeFacebookPost, normalizeFacebookMarketplaceListing, normalizeInstagramPost,
  normalizeRedditPost, normalizeCraigslistItem,
} from "../lib/lead-pipeline/social-sourcer"
import type { NormalizedScrapedRecord } from "../lib/lead-pipeline/raw-record-types"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const stripped = (p: string) => stripComments(read(p))
const code = (p: string) => blankStrings(stripped(p))
const INTENTS: AcquisitionIntent[] = ["sell", "buy", "relocate", "realtor_seeking", "investor"]
const KEYS = ALL_SOURCE_KEYS as SourceKey[]
const MKT = { city: "Austin", state: "TX", brokerage_id: "b1" }
const render = (t: string) => t.replace(/\{city\}/g, MKT.city).replace(/\{state\}/g, MKT.state)
const ROUTE = "app/api/cron/lead-scraping/route.ts"
const route = stripped(ROUTE)

console.log("\n[K0 · scanner — a tombstone is not a call site]")
check("POSITIVE CONTROL: stripComments drops a comment naming keywordsBySource[ and keeps live code",
  !/keywordsBySource\[/.test(stripComments(`// keywordsBySource["x"] gone\nconst a = 1`)) && /const a = 1/.test(stripComments(`// x\nconst a = 1`)))

// ── K1 ──────────────────────────────────────────────────────────────────────
console.log("\n[K1 · every source answers; readers are resolved in the cron]")
check(`SCRAPE_KEYWORD_POLICY covers ALL_SOURCE_KEYS (${KEYS.length})`, KEYS.every((k) => k in SCRAPE_KEYWORD_POLICY) && Object.keys(SCRAPE_KEYWORD_POLICY).length === KEYS.length)
const nonReaders = KEYS.filter((k) => !SCRAPE_KEYWORD_POLICY[k].reads)
check(`every non-reader documents WHY it takes no keywords (${nonReaders.length})`,
  nonReaders.every((k) => { const p = SCRAPE_KEYWORD_POLICY[k]; return !p.reads && p.why.trim().length > 10 }))
const resolvedInRoute = (src: string, k: SourceKey) => new RegExp(`resolveSourceKeywords\\(\\s*"${k}"`).test(src)
const unresolved = KEYWORD_SOURCE_KEYS.filter((k) => !resolvedInRoute(route, k))
check(`every keyword-reading source is resolved per territory in the cron — ${KEYWORD_SOURCE_KEYS.length - unresolved.length}/${KEYWORD_SOURCE_KEYS.length}`, unresolved.length === 0, unresolved.join(", "))
check("POSITIVE CONTROL: a reader the route never resolves is flagged", !resolvedInRoute(route, "osint_signal"))
check("every keyword reader's gate token sits in the cron (enabledSources.has)",
  KEYWORD_SOURCE_KEYS.every((k) => [...expandEnabledSources([k])].some((t) => route.includes(`enabledSources.has("${t}")`))))

// ── K2 ──────────────────────────────────────────────────────────────────────
console.log("\n[K2 · SETUP — a default set per declared population]")
function missingSets(defaults: typeof DEFAULT_SCRAPE_KEYWORDS): string[] {
  const out: string[] = []
  for (const k of KEYWORD_SOURCE_KEYS) for (const i of SOURCE_ACQUISITION[k].intents) if (!(defaults[k]?.[i]?.length)) out.push(`${k}.${i}`)
  return out
}
const miss = missingSets(DEFAULT_SCRAPE_KEYWORDS)
const denom = KEYWORD_SOURCE_KEYS.reduce((n, k) => n + SOURCE_ACQUISITION[k].intents.length, 0)
check(`every keyword source has a non-empty default set for every population it declares — ${denom - miss.length}/${denom}`, miss.length === 0, miss.join(", "))
check("POSITIVE CONTROL: a source with its buyer set removed is flagged",
  missingSets({ ...DEFAULT_SCRAPE_KEYWORDS, facebook_group: { ...DEFAULT_SCRAPE_KEYWORDS.facebook_group, buy: [] } }).includes("facebook_group.buy"))
for (const i of INTENTS) {
  const srcs = KEYWORD_SOURCE_KEYS.filter((k) => SOURCE_ACQUISITION[k].intents.includes(i))
  check(`population "${i}" is searched by ≥2 keyword sources (${srcs.length}: ${srcs.join(", ")})`, srcs.length >= 2)
}
check("no default set exists for a source that does not read keywords (a dead set reads as coverage)",
  Object.keys(DEFAULT_SCRAPE_KEYWORDS).every((k) => SCRAPE_KEYWORD_POLICY[k as SourceKey]?.reads === true))

// ── K3 ──────────────────────────────────────────────────────────────────────
console.log("\n[K3 · CORRECT — every term classifies back to its own population]")
const misfiled: string[] = []
let termCount = 0
for (const k of KEYWORD_SOURCE_KEYS) for (const i of SOURCE_ACQUISITION[k].intents) for (const t of DEFAULT_SCRAPE_KEYWORDS[k]?.[i] ?? []) {
  termCount++
  if (!classifyIntentText(render(t)).includes(i)) misfiled.push(`${k}.${i}: "${t}" → [${classifyIntentText(render(t)).join(",")}]`)
}
check(`every default term reads as its own population — ${termCount - misfiled.length}/${termCount}`, misfiled.length === 0, misfiled.join("; "))
// The original seed (scripts/325-create-lead-scraping-config.sql) filed these under buying_intent /
// selling_intent. The lexicon must say they are something else — or the check cannot see a misfile.
const oldSeed: Array<[string, AcquisitionIntent]> = [["realtor recommendations", "buy"], ["relocating to", "buy"], ["job relocation", "sell"]]
check("POSITIVE CONTROL: the old seed's misfiled rows are caught ('realtor recommendations'/'relocating to' are not BUY, 'job relocation' is not SELL)",
  oldSeed.every(([t, filed]) => !classifyIntentText(t).includes(filed)) && classifyIntentText("realtor recommendations").includes("realtor_seeking") && classifyIntentText("relocating to").includes("relocate"))
check("POSITIVE CONTROL: noise classifies as nothing", classifyIntentText("love this song").length === 0)

// ── K4 ──────────────────────────────────────────────────────────────────────
console.log("\n[K4 · the source's normalizer PRODUCES each declared population]")
const SM = { city: MKT.city, state: MKT.state }
const PRODUCERS: Partial<Record<SourceKey, (text: string) => NormalizedScrapedRecord | null>> = {
  nextdoor_intent: (text) => normalizeNextdoorPost({ post_id: "n1", content: `Hi neighbors, ${text}`, author_name: "Jane Roe" }, SM, resolveSourceKeywords("nextdoor_intent", MKT)),
  facebook_group: (text) => normalizeFacebookPost({ postId: "f1", text: `Anyone? ${text}`, authorName: "Jane Roe" }, SM),
  facebook_marketplace: (text) => normalizeFacebookMarketplaceListing({ id: "m1", marketplace_listing_title: text, marketplace_listing_seller: { name: "Jane Roe" } }, SM),
  instagram_intent: (text) => normalizeInstagramPost({ id: "i1", caption: text, ownerUsername: "janeroe" }, SM),
  reddit_intent: (text) => normalizeRedditPost({ id: "r1", title: text, author: "janeroe" }, SM),
  craigslist_fsbo: (text) => normalizeCraigslistItem({ id: "c1", title: text }, SM),
  craigslist_wanted: (text) => normalizeCraigslistItem({ id: "c2", title: text }, SM),
  // tiktok_intent's producer retired with the lane (lane 84C; owner 2026-09-26 "don't need tiktok.").
}
check("every keyword source has a producer here (derived denominator)", KEYWORD_SOURCE_KEYS.every((k) => !!PRODUCERS[k]), KEYWORD_SOURCE_KEYS.filter((k) => !PRODUCERS[k]).join(", "))
const unproduced: string[] = []
for (const k of KEYWORD_SOURCE_KEYS) for (const i of SOURCE_ACQUISITION[k].intents) {
  const term = DEFAULT_SCRAPE_KEYWORDS[k]?.[i]?.[0]
  const rec = term ? PRODUCERS[k]?.(render(term)) : null
  if (!rec || !recordAcquisitionIntents(rec).includes(i)) unproduced.push(`${k}.${i} → ${rec ? `[${recordAcquisitionIntents(rec).join(",")}]` : "null"}`)
}
check(`each declared population is produced by its normalizer from its own keyword — ${denom - unproduced.length}/${denom}`, unproduced.length === 0, unproduced.join("; "))
check("POSITIVE CONTROL: a seller-only record does not count as buy/relocate/realtor-seeking",
  (() => { const r = recordAcquisitionIntents({ intentType: "seller", intentSignals: ["owner", "fsbo"] }); return r.includes("sell") && !r.includes("buy") && !r.includes("relocate") && !r.includes("realtor_seeking") })())
check("POSITIVE CONTROL: a Nextdoor post with no resolved keyword mints nothing",
  normalizeNextdoorPost({ content: "lost dog near the park" }, SM, resolveSourceKeywords("nextdoor_intent", MKT)) === null)

// ── K5 ──────────────────────────────────────────────────────────────────────
console.log("\n[K5 · resolver]")
const rows: ScrapeKeywordRow[] = [
  { brokerage_id: "b1", keyword: "military relocation to Fort Cavazos", keyword_type: "relocation", sources: ["facebook"], is_active: true },
  { brokerage_id: "b2", keyword: "OTHER TENANT TERM", keyword_type: "buyer", sources: ["facebook"], is_active: true },
  { brokerage_id: "b1", keyword: "inactive term", keyword_type: "buyer", sources: ["facebook"], is_active: false },
  { brokerage_id: "b1", keyword: "ISO duplex", keyword_type: "investor", sources: ["craigslist"], is_active: true },
]
const fb = resolveSourceKeywords("facebook_group", MKT, rows)
check("the market's OWN brokerage row lands on its population (keyword_type relocation → relocate)", (fb.byIntent.relocate ?? []).includes("military relocation to Fort Cavazos") && fb.fromBrokerageRows === 1)
check("POSITIVE CONTROL: another brokerage's row is never read, and an inactive row is ignored", !fb.terms.concat(...Object.values(fb.byIntent).flat()).some((t) => /OTHER TENANT|inactive/.test(t)))
check("a 'craigslist' row routes to the Craigslist lane that declares its population (investor → both)", (resolveSourceKeywords("craigslist_wanted", MKT, rows).byIntent.investor ?? []).includes("ISO duplex"))
check("territory rendering: {city} becomes the market's city", fb.terms.some((t) => t.includes("Austin")) && !fb.terms.some((t) => t.includes("{city}")))
check("POSITIVE CONTROL: a market with no city drops {city} terms instead of searching '{city}'", !resolveSourceKeywords("facebook_group", { city: null, state: "TX", brokerage_id: "b1" }).terms.some((t) => /\{city\}|to $/.test(t)))
check("round-robin: the capped term list still carries every declared population",
  KEYWORD_SOURCE_KEYS.every((k) => { const r = resolveSourceKeywords(k, MKT); return SOURCE_ACQUISITION[k].intents.every((i) => r.terms.some((t) => (r.byIntent[i] ?? []).includes(t))) }))
check("hashtag shape renders a searchable tag (instagram: 'moving to {city}' → 'movingtoaustin')", resolveSourceKeywords("instagram_intent", MKT).terms.includes("movingtoaustin"))
const clq = renderKeywordQuery("craigslist_fsbo", ["by owner", "fsbo"])
check("Craigslist gets an OR query (`\"by owner\" | \"fsbo\"`), never space-joined words Craigslist ANDs", clq === `"by owner" | "fsbo"`)
check("POSITIVE CONTROL: the old space-join shape is recognisably not an OR query", !/\|/.test(["by owner", "fsbo"].join(" ")))
check("matchResolvedKeyword returns the population of the matched term", matchResolvedKeyword("we are relocating to Austin in May", resolveSourceKeywords("nextdoor_intent", MKT))?.intent === "relocate")

// ── K6 ──────────────────────────────────────────────────────────────────────
console.log("\n[K6 · cron wiring]")
check("no keyword lane is gated on a keyword ROW existing (keywordsBySource[…] gone)", !/keywordsBySource\[/.test(route))
check("POSITIVE CONTROL: the old gate shape IS recognised", /keywordsBySource\[/.test(`if (enabledSources.has("facebook") && keywordsBySource["facebook"]) {`))
check("no population is decided by the CHECK-refused string \"buying_intent\"", !/keyword_type === "buying_intent"/.test(route))
check("Nextdoor matches through normalizeNextdoorPost with the resolved set", /normalizeNextdoorPost\([^)]*kw\.nextdoor/.test(route))
check("the keyword read selects brokerage_id and READS its error (a refusal is reported, defaults still run)",
  /from\("lead_scraping_keywords"\)\s*\.select\("brokerage_id, keyword, keyword_type, sources, weight, is_active"\)/.test(route) && /keywordReadError/.test(route))
check("Craigslist lanes send renderKeywordQuery OR queries", /renderKeywordQuery\("craigslist_fsbo"/.test(route) && /renderKeywordQuery\("craigslist_wanted"/.test(route))
check("Marketplace receives its buyer/relocation/realtor-seeking searches", /sourceFacebookMarketplace\(market\.city, socialMarket, kw\.marketplace\.terms\)/.test(route))

// ── K7 ──────────────────────────────────────────────────────────────────────
console.log("\n[K7 · Marketplace + cash buyers ON by default]")
const must: SourceKey[] = ["batchdata_motivated", "facebook_marketplace", "batchdata_cash_buyer"]
check(`DEFAULT_MARKET_SOURCES carries ${must.join(" + ")}`, must.every((k) => DEFAULT_MARKET_SOURCES.includes(k)))
check("every default is a real SourceKey", DEFAULT_MARKET_SOURCES.every((k) => KEYS.includes(k)))
const routeCode = code(ROUTE)
check("the cron has no hand-written fallback list left (both fallbacks read DEFAULT_MARKET_SOURCES)",
  (route.match(/enabled_sources \?\? \[\.\.\.DEFAULT_MARKET_SOURCES\]/g) ?? []).length >= 2 && !/enabled_sources \?\? \[\s*"batchdata_motivated"\s*\]/.test(route))
check("POSITIVE CONTROL: the old fallback shape is recognised", /enabled_sources \?\? \[\s*"batchdata_motivated"\s*\]/.test(`m.enabled_sources ?? ["batchdata_motivated"]`))
void routeCode
check("createScrapingMarket stamps DEFAULT_MARKET_SOURCES on every new market", /enabled_sources: \[\.\.\.DEFAULT_MARKET_SOURCES\]/.test(code("app/actions/lead-scraping-config.ts")))
check("the markets panel shows the same list", /DEFAULT_ENABLED_SOURCES: SourceKey\[\] = \[\.\.\.DEFAULT_MARKET_SOURCES\]/.test(code("app/dashboard/admin/markets/markets-client.tsx")))
function migrationDefault(sql: string): string[] | null {
  const m = /ALTER COLUMN enabled_sources SET DEFAULT '\{([^}]*)\}'::text\[\]/.exec(sql)
  return m ? m[1].split(",").map((s) => s.trim()).filter(Boolean) : null
}
const m662 = readdirSync("supabase/migrations").find((f) => /^m662-/.test(f))
const m662Sql = m662 ? stripComments(read(`supabase/migrations/${m662}`)) : ""
const dbDefault = migrationDefault(m662Sql)
check("m662 sets the column default to EXACTLY DEFAULT_MARKET_SOURCES (code and DB agree)",
  !!dbDefault && dbDefault.length === DEFAULT_MARKET_SOURCES.length && DEFAULT_MARKET_SOURCES.every((k) => dbDefault.includes(k)), JSON.stringify(dbDefault))
check("POSITIVE CONTROL: a migration default that drops a source is flagged",
  (() => { const d = migrationDefault(`ALTER COLUMN enabled_sources SET DEFAULT '{batchdata_motivated}'::text[]`); return !!d && !DEFAULT_MARKET_SOURCES.every((k) => d.includes(k)) })())
check("m662 turns the two sources on for EXISTING markets (additive update, never removes a chosen source)",
  /UPDATE public\.lead_scraping_markets/.test(m662Sql) && /ARRAY\['facebook_marketplace','batchdata_cash_buyer'\]/.test(m662Sql) && !/array_remove/.test(m662Sql))
const liveTypes = CHECK_VOCABULARIES.lead_scraping_keywords?.keyword_type ?? []
const m662Types = (/keyword_type = ANY \(ARRAY\[([^\]]*)\]/.exec(m662Sql)?.[1] ?? "").split(",").map((s) => s.replace(/'|::text/g, "").trim()).filter(Boolean)
check(`m662's keyword_type CHECK keeps every live value (${liveTypes.length}) and admits every KEYWORD_TYPE_INTENT key`,
  liveTypes.every((t) => m662Types.includes(t)) && Object.keys(KEYWORD_TYPE_INTENT).every((t) => m662Types.includes(t)), JSON.stringify(m662Types))

// ── K8 ──────────────────────────────────────────────────────────────────────
console.log("\n[K8 · admin keyword write]")
const panel = code("app/dashboard/admin/markets/markets-client.tsx")
check("the panel's keyword types ARE the CHECK vocabulary (generated cache), not a hand list",
  /CHECK_VOCABULARIES\.lead_scraping_keywords\?\.keyword_type/.test(panel) && !/buying_intent|selling_intent|life_event/.test(stripped("app/dashboard/admin/markets/markets-client.tsx")))
check("POSITIVE CONTROL: the old hand list is not in the CHECK (so it could never have been stored)", !["buying_intent", "selling_intent", "life_event", "distress", "custom"].some((t) => liveTypes.includes(t)))
const cfg = stripped("app/actions/lead-scraping-config.ts")
const kwFn = cfg.slice(cfg.indexOf("export async function createScrapingKeyword"), cfg.indexOf("export async function updateScrapingKeyword"))
check("createScrapingKeyword stamps brokerage_id from the SESSION (auth.getUser → users.brokerage_id) and fails closed without one",
  /auth\.getUser\(\)/.test(kwFn) && /brokerage_id: brokerageId/.test(kwFn) && /if \(profileError \|\| !brokerageId\) return \{ success: false/.test(kwFn) && !/keywordData\.brokerage|brokerageId:\s*keywordData/.test(kwFn))
check("a new row with no sources applies to every keyword-reading source (never the '{}' default)", /\[\.\.\.KEYWORD_SOURCE_KEYS\]/.test(kwFn))

// ── registration ────────────────────────────────────────────────────────────
console.log("\n[registration]")
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
const guard = pkg.scripts.guard ?? ""
check("package.json registers test:scrape-keywords", pkg.scripts["test:scrape-keywords"] === "tsx scripts/scrape-keywords-guard.ts")
check("guard runs it AFTER test:scrapers (ordering only)", guard.indexOf("npm run test:scrapers") >= 0 && guard.indexOf("npm run test:scrape-keywords") > guard.indexOf("npm run test:scrapers"))
check("MAINTENANCE_DOMAINS owns it with coOwners", /scrape_keywords:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:scrape-keywords",\s*coOwners:/.test(read("lib/kernel/manager-registry.ts")))

console.log(`\n  denominators: ${KEYS.length} SourceKeys · ${KEYWORD_SOURCE_KEYS.length} keyword readers · ${nonReaders.length} documented non-readers · ${denom} (source × population) sets · ${termCount} default terms`)
console.log("  blind spots: whether a live platform's search actually returns posts for a term is only measurable with keys (no network here); the lexicon is English-only; hashtag renders are checked for shape, not for hashtag popularity")
console.log(`\n${"─".repeat(50)}\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ SCRAPE_KEYWORDS_FAIL"); process.exit(1) }
console.log(" ✅ SCRAPE_KEYWORDS_PASS")
