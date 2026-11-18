#!/usr/bin/env tsx
/**
 * scripts/google-intelligence-guard.ts (test:google-intelligence) — GOOGLE INTELLIGENCE AS TWO DISTINCT OPERATIONS
 * (wave 154, lane 154B; owner ruling R5, directive B1–B4). ALL SIMULATED: no provider call, no key; every transport and the
 * topic intake are injected fakes that COUNT calls; the database is scripts/in-memory-supabase.ts.
 *
 *   A  OPERATION 2 — an anonymous regional trend yields 0 person records and 1 topic idea (relative, never a count).
 *   B  OPERATION 1 — a current first-person public FSBO with source / rights / identity enters RawData → Raw Lead with the
 *      B1 fields; a rediscovery and an older indexed copy do not duplicate; an article / permit is market intelligence.
 *   C  Search Console rows are never assigned to a named person; anonymized / truncation caveats ride the idea.
 *   D  A tenant portal search after consent updates THAT Contact's criteria, not another tenant's; first-party demand is
 *      tenant-pinned and held below the privacy floor.
 *   E  A stale snippet is dropped; a live rediscovery re-verifies the held row instead of filing a new one.
 *   F  A relative index never renders as a search count (classifier, reader, panel, card).
 *   G  A saved topic reaches the planning reader (pickTopics) — through a RECORDING intake (lane 154C builds the real one).
 *   H  An unavailable API reports an honest status (not connected / owner-held / refused / intake_unwired), zero rows.
 *   I  Wiring on STRIPPED source: the cron, the SEO reader, session tenancy, one intake, the dishonest writers stay dead, no
 *      Google Custom Search endpoint.
 * Every absence claim carries a POSITIVE CONTROL (CLAUDE.md §2). BLIND SPOTS: the in-memory client models no RLS or CHECKs;
 * the real intake (exclusions, rewording, dedup) is lane 154C's and is a fake here; Trends / Search Console response shapes
 * follow the providers' docs, not a live call.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

const _require = createRequire(import.meta.url)
try { const so = _require.resolve("server-only"); _require.cache[so] = { id: so, filename: so, loaded: true, exports: {} } as any } catch { /* not installed */ }

const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) } }
const section = (t: string) => console.log(`\n[${t}]`)
const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error, l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await fn() } finally { console.warn = w; console.error = e; console.log = l } }

const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222", MARKET = "33333333-3333-4333-8333-333333333333", AGENT = "44444444-4444-4444-8444-444444444444"
const NOW = new Date("2026-11-16T12:00:00Z")
const daysAgo = (n: number, from = NOW) => new Date(from.getTime() - n * 86_400_000).toISOString()
const market = { id: MARKET, brokerage_id: T1, name: "Pensacola", city: "Pensacola", state: "FL", zip_codes: ["32501", "32502"], counties: ["Escambia"], agent_id: AGENT }
const marketRow = { ...market, is_active: true, enabled_sources: ["exa"], monthly_budget_usd: 100, spend_this_month: 0, max_records_per_run: 100, priority: 1, last_scraped_at: null }
const DB_OPTS = { uuidIds: true, stampCreatedAt: true, unique: { raw_scraped_leads: [["idempotency_key"]] } } as const
const freshDb = (extra: Record<string, unknown[]> = {}) => memSupabase({ raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [], lead_scraping_markets: [marketRow], manager_signals: [], leads: [], contacts: [], ...extra } as never, DB_OPTS as never) as any
const page = (o: Record<string, unknown>) => ({ id: "r-" + String(o.id ?? Math.random()), url: null, title: null, text: null, author: null, publishedDate: null, highlights: null, summary: null, score: 0.8, ...o })
const EMPTY_KNOWN = { sourceRecordIds: new Set<string>(), personKeys: new Set<string>(), propertyKeys: new Set<string>(), priorProviderResults: new Map(), scope: { brokerageId: T1, includesPlatformPool: false } }

/** Any field that could carry a person into a topic (the PERSON-KEY FINDER). */
const PERSON_KEY = /"(email|phone|contact_?id|contactId|lead_?id|first_?name|last_?name|full_?name|author|handle|user_?id)"\s*:|@[a-z0-9-]+\.[a-z]{2,}/i

/** A RECORDING intake: the contract's shape; counts calls; optionally lands rows in content_topic_bank like a real intake would. */
function recordingIntake(land?: any) {
  const calls: Array<{ brokerageId: string; ideas: any[] }> = []
  const fn = async (_db: unknown, a: { brokerageId: string; ideas: any[]; now?: Date }) => {
    calls.push({ brokerageId: a.brokerageId, ideas: a.ideas })
    if (land) for (const i of a.ideas) land.tables.content_topic_bank.push({ id: `topic-${land.tables.content_topic_bank.length + 1}`, brokerage_id: a.brokerageId, topic_title: i.title, value_angle: i.angle ?? null, source_url: i.sourceUrl ?? null, categories: i.categories ?? [], engagement_score: 0, performance_score: 0, topic_posted_at: i.publishedAt ?? null, scraped_at: i.observedAt, geo_relevance: i.geo ? { cities: i.geo.city ? [i.geo.city] : [], states: i.geo.state ? [i.geo.state] : [] } : null, status: "fresh", expires_at: i.expiresAt, raw_data: { source_kind: i.sourceKind, evidence: i.evidence, rights: i.rights } })
    return { ok: true, inserted: a.ideas.length, merged: 0, excluded: [] }
  }
  return { fn, calls }
}

async function main() {
  const sd = await import("../lib/content-intel/search-demand")
  const vol = await import("../lib/content-intel/search-demand-volume")
  const hunting = await import("../lib/providers/exa/hunting")
  const request = await import("../lib/acquisition-plays/public-request")
  const { ingestRawSourceBatch } = await import("../lib/kernel/scraping")
  const norm = (r: Record<string, unknown>) => hunting.normalizeExaHuntRow(r)
  const persons = (db: any) => (db.tables.raw_scraped_leads as any[]).filter((x) => x.subject_kind === "person")
  const ingests: any[] = []
  const recIngest = async (p: any) => { const r = await ingestRawSourceBatch(p); ingests.push(r); return r }
  const runPlay = (db: any, results: unknown[], now = NOW) =>
    quiet(() => request.runPublicRequestPlay(db, { market, hunt: null, results: results as never, now }, { ingest: recIngest as never, loadKnown: async () => EMPTY_KNOWN as never }))

  check("POSITIVE CONTROL: the person-key finder sees a planted email / contact id", PERSON_KEY.test(JSON.stringify({ contact_id: "c1" })) && PERSON_KEY.test("reach me at jo@example.com"))

  section("A. Operation 2 — an anonymous trend → 0 person records, 1 topic (SIMULATED)")
  {
    let trendCalls = 0
    const trends = { provider: "fake-trends", rights: "licensed" as const, fetchRegional: async () => { trendCalls++; return { ok: true as const, points: [{ term: "homes with acreage", geo: { city: "Pensacola", state: "FL" }, relativeIndex: 64, windowStart: daysAgo(90), windowEnd: daysAgo(1), risingPct: 140 }] } } }
    const db = freshDb({ buyer_criteria_utterances: [], keyword_intelligence: [] })
    const intake = recordingIntake()
    const r = await sd.runSearchDemandScan(db, { brokerageId: T1, now: NOW, geo: { city: "Pensacola", state: "FL" } }, { intake: intake.fn, trends })
    const ideas = intake.calls.flatMap((c) => c.ideas)
    const trendIdeas = ideas.filter((i) => i.sourceKind === sd.SEARCH_DEMAND_SOURCE_KINDS.trends)
    check("one transport call, ONE topic idea reaches the intake, tenant-stamped", trendCalls === 1 && intake.calls.length === 1 && intake.calls[0].brokerageId === T1 && trendIdeas.length === 1, JSON.stringify(ideas.map((i) => i.title)))
    check("…and ZERO person records: personRecords 0, no raw_scraped_leads row, no person key on any idea", r.personRecords === 0 && db.tables.raw_scraped_leads.length === 0 && !PERSON_KEY.test(JSON.stringify(ideas)))
    const ev = trendIdeas[0]?.evidence ?? {}
    check("the trend stays RELATIVE: evidence 'proxy', unit relative_index_0_100, note says it is not a count of searches", ev.kind === "proxy" && ev.unit === "relative_index_0_100" && ev.value === 64 && /not a count of searches/.test(ev.note ?? ""), JSON.stringify(ev))
    check("an unlocated trend or an out-of-range index is NOT a topic (control: the located one above was)", sd.trendIdea({ term: "x", geo: {}, relativeIndex: 50, windowStart: daysAgo(9), windowEnd: daysAgo(1) }, NOW).idea === null && sd.trendIdea({ term: "x", geo: { city: "Pensacola" }, relativeIndex: 250, windowStart: daysAgo(9), windowEnd: daysAgo(1) }, NOW).idea === null)
    const src = code("lib/content-intel/search-demand.ts")
    check("search-demand.ts cannot reach the person door (no ingestRawSourceBatch / raw_scraped_leads / leads / contacts write)", !/ingestRawSourceBatch|raw_scraped_leads|from\("leads"\)|from\("contacts"\)/.test(src))
    check("POSITIVE CONTROL: the same finder sees the person door in public-request.ts", /ingestRawSourceBatch/.test(code("lib/acquisition-plays/public-request.ts")))
  }

  section("B. Operation 1 — a current first-person public FSBO → RawData → Raw Lead; no duplicate on rediscovery (SIMULATED)")
  {
    const words = "We are selling our house by owner in East Hill this spring. Email me at owner.seller@example.com if interested."
    const fsbo = norm(page({ id: "f1", url: "https://www.reddit.com/r/Pensacola/comments/f1/fsbo/", title: "Selling our house", author: "eastHillOwner", publishedDate: daysAgo(3), text: words, highlights: ["We are selling our house by owner in East Hill this spring."] }))
    const db = freshDb()
    await runPlay(db, [fsbo])
    const p = persons(db)
    const ev = p[0]?.evidence ?? p[0]?.normalized_preview?.rawdata?.evidence ?? {}
    check("ONE Raw Lead (person) with the author's published email", p.length === 1 && p[0].email === "owner.seller@example.com", JSON.stringify(p.map((x: any) => x.email)))
    check("B1 fields ride it: source URL, publication time, exact statement, author AS PUBLISHED, identity link, channel AS PUBLISHED, rights, expiry, discovery route",
      ev.citation?.url === fsbo.url && ev.citation?.published === fsbo.publishedDate && /selling our house by owner/i.test(ev.quote ?? "") && ev.author_as_published === "eastHillOwner"
      && ev.identity_link?.basis === "published_contact" && ev.contact_channel_as_published?.email === true && typeof ev.source_terms === "string" && typeof ev.evidence_expires_at === "string" && /Custom Search JSON API is not used/.test(ev.discovery_route ?? ""), JSON.stringify({ cit: ev.citation, pub: fsbo.publishedDate, quote: ev.quote, terms: typeof ev.source_terms, exp: ev.evidence_expires_at, route: ev.discovery_route }))
    check("the RawData TTL ends at the play's window from the PUBLISHED date (history afterwards, not a person asking now)", typeof p[0]?.ttl_expires_at !== "string" || Math.abs(Date.parse(p[0].ttl_expires_at) - (Date.parse(fsbo.publishedDate!) + 90 * 86_400_000)) < 86_400_000, String(p[0]?.ttl_expires_at))
    // Rediscovery: the SAME statement found again under a NEW result id and a mirror URL (an older indexed copy).
    const mirror = norm(page({ id: "f1-mirror", url: "https://old.reddit.com/r/Pensacola/comments/f1/fsbo/", title: "Selling our house", author: "eastHillOwner", publishedDate: daysAgo(3), text: words, highlights: ["We are selling our house by owner in East Hill this spring."] }))
    ingests.length = 0
    await runPlay(db, [mirror])
    check("a rediscovery under a new result id / mirror URL does NOT file a second Raw Lead (replayed on the statement key)", persons(db).length === 1 && ingests.some((r) => r.replayed === 1), JSON.stringify(ingests))
    check("POSITIVE CONTROL: the copy key differs for a different statement or a different author contact", request.statementCopyKey({ email: "owner.seller@example.com", quote: "We are selling our house by owner in East Hill this spring." }) !== request.statementCopyKey({ email: "other@example.com", quote: "We are selling our house by owner in East Hill this spring." }) && request.statementCopyKey({ email: "a@b.co", quote: "x y" }) === request.statementCopyKey({ email: "A@B.co ", quote: "X, y!" }))
    const db2 = freshDb()
    const both = await runPlay(db2, [fsbo, { ...mirror, publishedDate: daysAgo(10) }])
    check("two indexed copies in ONE pass → ONE person; the older copy is named and held", persons(db2).length === 1 && both.refused.some((x) => /older indexed copy/.test(x.why)), JSON.stringify(both.refused))
    const article = norm(page({ id: "n1", url: "https://www.pnj.com/story/news/2026/11/10/selling-by-owner/1/", title: "More owners sell without agents", publishedDate: daysAgo(2), text: "We are selling our house by owner, one resident said. Email me at quoted.person@example.com." }))
    const permit = norm(page({ id: "g1", url: "https://permits.cityofpensacola.gov/p/123", title: "Permit 123", publishedDate: daysAgo(2), text: "We are selling our house by owner after this remodel. Email me at permit.person@example.com." }))
    const db3 = freshDb()
    await runPlay(db3, [article, permit])
    const rows3 = db3.tables.raw_scraped_leads as any[]
    const classes = rows3.map((x: any) => x.normalized_preview?.rawPayload?.extracted?.intelligence_class ?? x.raw_payload?.extracted?.intelligence_class ?? (x.evidence ? null : null))
    check("an article and a permit page create ZERO persons — filed as MARKET intelligence (article / public_record_or_permit)", persons(db3).length === 0 && rows3.length === 2 && rows3.every((x: any) => x.subject_kind === "market"), JSON.stringify(rows3.map((x: any) => [x.subject_kind, x.source_url])))
    check("…classified by name (the non-person vocabulary)", request.nonPersonIntelligenceClass({ sourceClass: "news" }, "published_contact") === "article" && request.nonPersonIntelligenceClass({ sourceClass: "official_record" }, "published_contact") === "public_record_or_permit" && request.nonPersonIntelligenceClass({ sourceClass: "public_forum" }, "name_only") === "partial_profile" && request.nonPersonIntelligenceClass({ sourceClass: "public_forum" }, "handle_only") === "anonymous_forum_post", JSON.stringify(classes))
  }

  section("C. Search Console rows are never assigned to a named person (SIMULATED)")
  {
    let gscCalls = 0
    const rows = [
      { query: "homes for sale with pool pensacola", page: "https://agent.example/pool", country: "usa", clicks: 4, impressions: 900, ctr: 0.004, position: 8.2, email: "searcher@example.com", contactId: "c-123", name: "Pat Doe" },
      { query: null, page: "https://agent.example/", country: "usa", clicks: 9, impressions: 300 },
      { query: "pensacola first time buyer programs", page: "https://agent.example/ftb", country: "usa", clicks: 12, impressions: 400, ctr: 0.03, position: 5 },
    ]
    check("POSITIVE CONTROL: the raw rows DO carry planted identity fields the producer must drop", PERSON_KEY.test(JSON.stringify(rows)))
    const gsc = { provider: "fake-gsc", query: async () => { gscCalls++; return { ok: true as const, report: { siteUrl: "https://agent.example/", startDate: "2026-10-17", endDate: "2026-11-14", rows: rows as never, totals: { clicks: 40, impressions: 2000 }, rowLimit: 3, previousRows: [{ query: "homes for sale with pool pensacola", clicks: 2, impressions: 450 }] as never } } } }
    const r = await sd.searchConsoleProducer(gsc, { site: { url: "https://agent.example/", verifiedOwner: true }, now: NOW })
    check("ideas come from queries only (2 of 3 rows; the anonymized row is not a topic), one transport call", gscCalls === 1 && r.status === "ran" && r.ideas.length === 2, JSON.stringify(r.ideas.map((i) => i.title)))
    check("…and NO idea carries an identity (no email, contact id, name) — the rows are whitelisted field by field", !PERSON_KEY.test(JSON.stringify(r.ideas)) && !/Pat Doe|c-123/.test(JSON.stringify(r.ideas)))
    check("the change, CTR and the caveats ride the evidence: +100% vs previous, anonymized impressions, 3-row truncation", /\+100% vs previous window/.test(r.ideas[0].evidence.note ?? "") && r.caveats.some((c) => /anonymized or suppressed/.test(c)) && r.caveats.some((c) => /row limit/.test(c)) && r.ideas[0].evidence.kind === "measured" && r.ideas[0].rights === "first_party", JSON.stringify(r.caveats))
    check("an UNVERIFIED property is refused before any call", (await sd.searchConsoleProducer(gsc, { site: { url: "https://someone-else.example/", verifiedOwner: false }, now: NOW })).status === "refused" && gscCalls === 1)
  }

  section("D. A consented portal search updates THAT Contact's criteria, not another tenant's (SIMULATED)")
  {
    const C1 = "c1111111-1111-4111-8111-111111111111", C2 = "c2222222-2222-4222-8222-222222222222"
    const db = memSupabase({ contacts: [{ id: C1, brokerage_id: T1, contact_type: "buyer" }, { id: C2, brokerage_id: T2, contact_type: "buyer" }], property_preferences: [], buyer_criteria_changes: [], buyer_criteria_utterances: [], agent_action_ledger: [], property_alerts: [] } as never, { uuidIds: true, stampCreatedAt: true, unique: { agent_action_ledger: [["idempotency_key"]] } } as never) as any
    const { recordStatedCriteriaTurn } = await import("../lib/buyer-search/criteria-turn")
    const { loadBuyerCriteria } = await import("../lib/buyer-search/buyer-criteria")
    const { saidSearchCriteria } = await import("../lib/lead-intelligence/first-party-search")
    const turn = await quiet(() => recordStatedCriteriaTurn(db, { brokerageId: T1, contactId: C1, text: "3 bed under 600k in Pensacola", channel: "portal", actor: { type: "user", userId: "u-buyer-signed-in" }, idempotencyKey: "gi-portal-1", allowModelAssist: false, ledgerClient: db }))
    const c1 = saidSearchCriteria(await loadBuyerCriteria(db, C1, { brokerageId: T1 }))
    const c2 = await loadBuyerCriteria(db, C2, { brokerageId: T2 })
    check("the portal turn lands on C1 in T1: said location + price become the profile's search preferences", !turn.error && c1.locations.includes("Pensacola") && c1.priceRange === "-600000", JSON.stringify({ err: turn.error, c1 }))
    check("…another tenant's Contact is untouched (no criteria, no utterance)", (c2 == null || (c2.cities.length === 0 && c2.maxPrice == null)) && !db.tables.buyer_criteria_utterances.some((u: any) => u.contact_id === C2 || u.brokerage_id === T2))
    check("…and the words were recorded under a stated consent basis (self_service_portal)", db.tables.buyer_criteria_utterances.length === 1 && db.tables.buyer_criteria_utterances[0].consent_basis === "self_service_portal" && db.tables.buyer_criteria_utterances[0].brokerage_id === T1, JSON.stringify(db.tables.buyer_criteria_utterances.map((u: any) => u.consent_basis)))
    const { defaultCriteriaConsent } = await import("../lib/buyer-search/buyer-criteria")
    check("…consent is a FACT of the channel, never assumed: an anonymous portal actor states none (control: the signed-in buyer above did)", defaultCriteriaConsent("portal", NOW.toISOString(), "k", { type: "user", userId: null }) === null)
    check("an INFERRED value is not the person's search (control: the said one is taken)", saidSearchCriteria({ minPrice: null, maxPrice: 500000, cities: ["Navarre"], zipCodes: [], propertyTypes: ["condo"], provenance: { maxPrice: { source: "inferred" }, cities: { source: "said" } } }).priceRange === null && saidSearchCriteria({ minPrice: null, maxPrice: 500000, cities: [], zipCodes: [], propertyTypes: [], provenance: { maxPrice: { source: "said" } } }).priceRange === "-500000")
    // First-party DEMAND: tenant-pinned and held below the privacy floor.
    const u = (b: string, c: string, kind = "outdoor_space", consent: string | null = "self_service_portal") => ({ brokerage_id: b, contact_id: c, consent_basis: consent, created_at: daysAgo(5), interpretation: { criteria: { cities: ["Pensacola"] }, lifestyle: [{ kind, label: "big yard for the dogs near Bayview Park" }] } })
    const ddb = memSupabase({ buyer_criteria_utterances: [u(T1, "a"), u(T1, "b"), u(T1, "c"), u(T1, "c"), u(T2, "x"), u(T2, "y"), u(T1, "z", "natural_light", null)] } as never) as any
    const d1 = await sd.firstPartyDemandProducer(ddb, { brokerageId: T1, now: NOW, state: "FL" })
    const d2 = await sd.firstPartyDemandProducer(ddb, { brokerageId: T2, now: NOW, state: "FL" })
    check("T1: 3 distinct consenting buyers → ONE demand topic counted in distinct contacts; the words / destination never leave", d1.ideas.length === 1 && d1.ideas[0].evidence.value === 3 && d1.ideas[0].evidence.unit === "distinct_contacts" && !/dogs|Bayview/.test(JSON.stringify(d1.ideas)) && !PERSON_KEY.test(JSON.stringify(d1.ideas)), JSON.stringify(d1.ideas.map((i) => [i.title, i.evidence.value])))
    check("T2 (2 buyers) is held below the floor and sees nothing of T1's (control: T1 above produced one)", d2.ideas.length === 0 && d2.caveats.some((c) => /privacy floor/.test(c)))
    check("a statement with NO stated consent is never counted (natural_light from one unconsented row produced no category)", !JSON.stringify(sd.aggregateFirstPartyDemand([u(T1, "z", "natural_light", null)] as never)).includes("natural light"))
  }

  section("E. A stale snippet is dropped; a live rediscovery re-verifies (SIMULATED)")
  {
    const words = "We need to sell our house in Pensacola this winter. Call me at 850-555-0142."
    const stale = norm(page({ id: "s1", url: "https://www.reddit.com/r/Pensacola/comments/s1/", title: "Selling", author: "seller850", publishedDate: daysAgo(200), text: words, highlights: [words] }))
    const db = freshDb()
    const r = await runPlay(db, [stale])
    check("a 200-day-old statement creates NO person (dropped: older than the window)", persons(db).length === 0 && r.blindSpots.some((b) => /older than this play's 90-day window/.test(b)), JSON.stringify(r.blindSpots))
    const fresh = { ...stale, publishedDate: daysAgo(4) }
    await runPlay(db, [fresh])
    check("POSITIVE CONTROL: the same words dated 4 days ago → ONE person", persons(db).length === 1)
    ingests.length = 0
    persons(db)[0].last_verified_at = "2026-01-01T00:00:00.000Z" // an old verification anchor, so the move is observable
    const later = new Date(NOW.getTime() + 3 * 86_400_000)
    await runPlay(db, [{ ...fresh, id: "s1-again" }], later)
    check("a LIVE rediscovery three days later replays and RE-VERIFIES the held row (last_verified_at moved off the old anchor) — no second Raw Lead", persons(db).length === 1 && ingests.some((x) => x.replayed === 1 && x.reverified === 1) && (persons(db)[0].last_verified_at ?? "") > "2026-01-01T00:00:00.000Z", JSON.stringify({ ingests, lv: persons(db)[0]?.last_verified_at }))
  }

  section("F. A relative index never renders as a search count")
  {
    const exa = vol.displaySearchVolume("exa_content_scan", 72), news = vol.displaySearchVolume("newsapi_ai_social", 100), gt = vol.displaySearchVolume("google_trends", 40), unk = vol.displaySearchVolume("mystery_vendor", 2000)
    check("Exa / NewsAPI / Trends numbers are relative indexes — searchCount null", exa.searchCount === null && exa.relativeIndex === 72 && news.searchCount === null && gt.searchCount === null && gt.basis.kind === "relative_index")
    check("an unknown source is UNKNOWN — neither a count nor an index", unk.searchCount === null && unk.relativeIndex === null && unk.basis.kind === "unknown")
    check("no licensed volume source is configured (the list is empty — LICENSE-HELD), so NO source yields a count today", vol.LICENSED_VOLUME_SOURCES.length === 0)
    const panel = code("app/dashboard/marketing/seo/components/market-trends-panel.tsx")
    const OLD = /\{k\.searchVolume != null && <span>\{k\.searchVolume\.toLocaleString\(\)\} searches<\/span>\}/
    check("the panel no longer renders searchVolume as 'N searches' unguarded; 'searches' appears only in the licensed branch", !OLD.test(panel) && /k\.volumeBasis === "licensed_volume" && k\.searchVolume != null/.test(panel) && /interest index \{k\.relativeIndex\}\/100 \(relative\)/.test(panel))
    check("POSITIVE CONTROL: the old-line finder sees the base commit's line", OLD.test(`{k.searchVolume != null && <span>{k.searchVolume.toLocaleString()} searches</span>}`))
    const mi = code("app/actions/marketing-intelligence.ts")
    check("getTrendingKeywords classifies each row by its SOURCE before it is shown (searchVolume = vol.searchCount)", /"intent_category, related_keywords, zip_code, source"/.test(mi) && /displaySearchVolume\(row\.source, row\.search_volume_monthly\)/.test(mi) && /searchVolume: vol\.searchCount/.test(mi) && !/searchVolume: row\.search_volume_monthly/.test(mi))
    const card = code("app/dashboard/marketing/seo/components/search-demand-card.tsx")
    check("the demand card says 'searches' only for a searches_per_month unit; a relative index reads '(relative)'", /e\.unit === "relative_index_0_100"\) return `interest \$\{e\.value\}\/100 \(relative\)`/.test(card) && (card.match(/monthly searches/g) ?? []).length === 1 && /e\.unit === "searches_per_month"\) return `\$\{e\.value\.toLocaleString\(\)\} est\. monthly searches`/.test(card))
  }

  section("G. A saved topic reaches the planning reader (SIMULATED — recording intake; lane 154C builds the real one)")
  {
    const realNow = new Date()
    const db = memSupabase({ content_topic_bank: [], content_topic_uses: [], buyer_criteria_utterances: [], keyword_intelligence: [] } as never, { uuidIds: true } as never) as any
    const intake = recordingIntake(db)
    const trends = { provider: "fake-trends", rights: "licensed" as const, fetchRegional: async () => ({ ok: true as const, points: [{ term: "property taxes", geo: { city: "Pensacola", state: "FL" }, relativeIndex: 80, windowStart: daysAgo(30, realNow), windowEnd: daysAgo(1, realNow) }] }) }
    const r = await sd.runSearchDemandScan(db, { brokerageId: T1, now: realNow, geo: { city: "Pensacola", state: "FL" } }, { intake: intake.fn, trends })
    const { pickTopics } = await import("../lib/content-intel/topic-bank")
    const picked = await quiet(() => pickTopics({ brokerageId: T1, limit: 4, client: db as never }))
    check("the scan stores through the ONE intake (intakeStatus stored) and pickTopics — the content creators' picker — returns the topic", r.intakeStatus === "stored" && picked.some((t: any) => /property taxes/.test(t.topic_title ?? t.title ?? "")), JSON.stringify({ st: r.intakeStatus, picked: picked.map((t: any) => t.topic_title ?? t.title) }))
    const other = await quiet(() => pickTopics({ brokerageId: T2, limit: 4, client: db as never }))
    check("…and another tenant's picker does not see it (control: T1's did)", !other.some((t: any) => /property taxes/.test(t.topic_title ?? t.title ?? "")))
  }

  section("H. An unavailable API reports an honest status, never success or fabricated data")
  {
    const db = memSupabase({ buyer_criteria_utterances: [], keyword_intelligence: [], content_topic_bank: [] } as never) as any
    const r = await sd.runSearchDemandScan(db, { brokerageId: T1, now: NOW, site: { url: "https://agent.example/", verifiedOwner: true } }, { intake: null, trends: sd.productionTrendsTransport(), searchConsole: sd.productionSearchConsoleTransport() })
    const by = Object.fromEntries(r.producers.map((p) => [p.producer, p]))
    check("production Trends and Search Console transports are null → 'not_connected' with zero ideas (no grant on record)", sd.productionTrendsTransport() === null && sd.productionSearchConsoleTransport() === null && by.trends.status === "not_connected" && by.search_console.status === "not_connected" && by.trends.ideas.length === 0 && by.search_console.ideas.length === 0)
    const noSite = await sd.searchConsoleProducer(null, { site: null, now: NOW })
    check("no recorded tenant site → 'owner_held', not success", noSite.status === "owner_held" && noSite.ideas.length === 0)
    const down = await sd.trendsProducer({ provider: "fake", rights: "licensed", fetchRegional: async () => ({ ok: false as const, error: "HTTP 503" }) }, { geo: { city: "Pensacola" }, now: NOW })
    check("a transport that fails → 'refused' with the provider's error, zero ideas", down.status === "refused" && /503/.test(down.reason ?? "") && down.ideas.length === 0)
    const refusedDb = memSupabase({}, { refuse: { buyer_criteria_utterances: "permission denied", keyword_intelligence: "permission denied" } } as never) as any
    const rr = await sd.runSearchDemandScan(refusedDb, { brokerageId: T1, now: NOW }, { intake: null })
    check("a refused read is the producer's status (refused), never an empty success", rr.producers.filter((p) => p.status === "refused").length === 2)
    const withIdeas = memSupabase({ buyer_criteria_utterances: [], keyword_intelligence: [{ id: "k1", brokerage_id: T1, source: "exa_content_scan", intent_category: "finance", related_keywords: ["closing cost help"], search_volume_monthly: 61, trend_direction: "rising", city: "Pensacola", state: "FL", captured_at: daysAgo(1), expires_at: daysAgo(-6) }], content_topic_bank: [] } as never) as any
    const unwired = await sd.runSearchDemandScan(withIdeas, { brokerageId: T1, now: NOW }, { intake: null })
    check("intake not wired → ideas reported, 'intake_unwired', NOTHING stored", unwired.intakeStatus === "intake_unwired" && unwired.producers.some((p) => p.ideas.length === 1) && withIdeas.writes.length === 0)
    const kw = unwired.producers.find((p) => p.producer === "keyword_intel")!.ideas[0]
    check("the keyword idea is REWORDED (not the stored article title) and its number is a relative index", kw.title === "Mortgages and money in Pensacola, FL: closing cost help" && kw.evidence.kind === "proxy" && kw.evidence.unit === "relative_index_0_100")
    check("POSITIVE CONTROL: with a transport, the same producer reports 'ran'", (await sd.trendsProducer({ provider: "f", rights: "licensed", fetchRegional: async () => ({ ok: true as const, points: [{ term: "x homes", geo: { city: "Pensacola" }, relativeIndex: 5, windowStart: daysAgo(9), windowEnd: daysAgo(1) }] }) }, { geo: {}, now: NOW })).status === "ran")
    check("no tenant → refused before any read", (await sd.runSearchDemandScan(db, { brokerageId: null, now: NOW }, { intake: null })).intakeStatus === "refused")
  }

  section("I. Wiring on stripped source")
  {
    const cron = code("app/api/cron/content-intel-scan/route.ts")
    check("the existing content-intel-scan cron runs the demand pass BEFORE the Exa-key skip, with the production intake / transports", /runSearchDemandCron\(svc, \{[\s\S]{0,200}intake: sd\.productionTopicIntake/.test(cron) && cron.indexOf("runSearchDemandCron(") < cron.indexOf("EXA_API_KEY not configured"))
    const seo = code("app/dashboard/marketing/seo/page.tsx")
    check("the SEO Trends tab renders the demand reader", /getSearchDemandIntelligence\(\)/.test(seo) && /<SearchDemandCard data=\{demand\} \/>/.test(seo))
    const mi = code("app/actions/marketing-intelligence.ts")
    const fn = mi.slice(mi.indexOf("export async function getSearchDemandIntelligence"), mi.indexOf("export async function getCompetitorHighPerformers"))
    check("the demand reader's tenant is the SESSION (ctx.brokerageId), it takes no parameters, and it stores nothing (intake: null)", fn.length > 100 && /getSearchDemandIntelligence\(\): Promise/.test(fn) && /brokerageId: ctx\.brokerageId/.test(fn) && /intake: null/.test(fn))
    const sdSrc = code("lib/content-intel/search-demand.ts")
    check("ONE intake: search-demand.ts never writes content_topic_bank itself", !/from\("content_topic_bank"\)/.test(sdSrc))
    check("POSITIVE CONTROL: the finder sees the pool table in topic-bank.ts", /from\("content_topic_bank"\)/.test(code("lib/content-intel/topic-bank.ts")))
    const files = ["app/actions/lead-intelligence.ts", "app/actions/marketing-intelligence.ts", "lib/content-intel/search-demand.ts", "lib/lead-intelligence/behavioral-summary.ts", "lib/lead-intelligence/person-timeline.ts", "lib/lead-intelligence/first-party-search.ts", "lib/acquisition-plays/public-request.ts"]
    const DEAD = /\.from\(\s*["'`](google_search_activity|google_search_intelligence|lead_property_searches)["'`]\s*\)/
    check("the dishonest writers / readers stay dead: no .from(google_search_activity | google_search_intelligence | lead_property_searches) in the owned files", files.every((f) => !DEAD.test(code(f))))
    check("POSITIVE CONTROL: the dead-table finder sees a planted call (and ignores the tombstones, which are comments)", DEAD.test(`svc.from("google_search_activity").insert({})`) && /google_search_activity/.test(readFileSync(join(ROOT, "lib/lead-intelligence/first-party-search.ts"), "utf8")))
    const CSE = /googleapis\.com\/customsearch|customsearch\/v1|www\.google\.com\/search\?/
    check("no Google Custom Search JSON API endpoint and no search-result-page URL in the person-discovery or demand code", ["lib/providers/exa/hunting.ts", "lib/acquisition-plays/public-request.ts", "lib/content-intel/search-demand.ts", "app/actions/lead-intelligence.ts"].every((f) => !CSE.test(code(f))))
    check("POSITIVE CONTROL: the CSE finder sees a planted endpoint", CSE.test("https://www.googleapis.com/customsearch/v1?q=x"))
    const li = code("app/actions/lead-intelligence.ts")
    check("updateIntelligenceProfile fills preferences from the Contact's SAID criteria (one consented writer), and analyzeGoogleSearchIntent stays scopeRefused", /saidSearchCriteria\(await loadBuyerCriteria\(supabase, leadId, \{ brokerageId \}\)\)/.test(li) && /scopeRefused: true as const/.test(li) && !/potential_leads_count:/.test(li))
    const bs = code("lib/lead-intelligence/behavioral-summary.ts")
    check("the behavioral summary reads the Contact's own statements tenant-pinned (buyer_criteria_utterances, contact + brokerage)", /from\("buyer_criteria_utterances"\)[\s\S]{0,200}\.eq\("contact_id", contactId\)[\s\S]{0,120}\.eq\("brokerage_id", brokerageId\)/.test(bs))
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    check("package.json: test:google-intelligence exists and is in the guard chain", pkg.scripts["test:google-intelligence"] === "tsx scripts/google-intelligence-guard.ts" && /npm run test:google-intelligence\b/.test(pkg.scripts.guard))
  }

  console.log(`\nGOOGLE INTELLIGENCE — RESULT: ${passed} passed, ${failed} failed ${failed === 0 ? "✅ GOOGLE_INTELLIGENCE_PASS" : "❌ GOOGLE_INTELLIGENCE_FAIL"}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
