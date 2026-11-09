#!/usr/bin/env tsx
/**
 * scripts/early-opportunity-plays-guard.ts (test:early-opportunity-plays) — EXA HUNTING + THE EARLY-OPPORTUNITY PLAYS
 * (wave 151, lane 151D; directive §151D; owner correction 2026-11-09 "exa is to find people when it is a scraper or hunting").
 *
 *   A  HUNTING SURFACE — one Exa row vocabulary, grounded evidence (URL + date + ≤ 280-char quoted basis), freshness, source
 *      rights per page class, the client by NAME (EXA_API_KEY absent → null → zero results, nothing invented), every PLAY_CARD
 *      names its twelve facets and ends in an export that EXISTS.
 *   B  PLAY moving_corridor_radar — announcements grouped across pages with citations; coverage + stored inventory → a brief
 *      that ends in the bus, the market-report producer and a DRAFT magnet; a market-level event creates NO person row and NO
 *      Lead (negative control); idempotent on replay.
 *   C  PLAY public_request_assist — a first-person request with a PUBLISHED contact point on a permitted page class → a person
 *      row (Raw Lead); handle-only / name-only / third-party / forum posters stay anonymous_question and are never deanonymized;
 *      an EXISTING Contact goes to THE arbiter (no new row); no outbound dispatch exists in the module (positive control).
 *   D  PLAY property_candidate_queue — FSBO → property (the published contact rides the payload, never a person column);
 *      owner ONLY on verified ownership (one public page = name-only join REFUSED); an official probate notice → entity row with
 *      targeting prohibited; a news-page "probate" is dropped; agent listings are contradictions, not candidates.
 *   E  PLAY contact_second_window — a Contact's saved-home SHIFT, valuation request and repeated criteria changes → C9 records →
 *      the manager's decision → the arbiter over the bus; NO raw row, NO lead, NO paid call (module imports no provider).
 *   F  PLAY negative_evidence_saver — newer verified / reported / inferred contrary facts → stop / hold / verify / lower; older
 *      facts are history; a stop closes the theory (recordMovementOutcome), pauses the lead and tells the ISA; `none` writes nothing.
 *   G  WEBHOOK — Exa-Signature verified (t=…,v1=… over `${t}.${body}`), stale / tampered / missing → 401, no secret → 503,
 *      unregistered monitor → 202 no-op, replay → 200 replayed with no second row, tenant from OUR row never the payload; the
 *      route reads the header and the env NAME; the contract row exists; registration seals the secret and never stores plaintext.
 *   H  DISCIPLINE — one exa-js importer; m969's CHECK vocabularies equal the code constants (the RULE, not a waypoint).
 *
 * BLIND SPOTS (published): no live Exa call (the client is fail-closed without EXA_API_KEY and a proof never spends); Exa's
 * monitor.run.completed payload envelope is read defensively (documented event names; the data/output shape is assumed); the
 * signature scheme is from docs.exa.ai (read 2026-11-09), not a captured live delivery; the market twin and the report / magnet
 * producers are injected fixtures here (their own proofs cover them); the movement chain's model is a fixture that picks the
 * first permitted step.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { createRequire } from "node:module"
import { createHmac } from "node:crypto"
import { stripComments, blankStrings } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

const _require = createRequire(import.meta.url)
try { const so = _require.resolve("server-only"); _require.cache[so] = { id: so, filename: so, loaded: true, exports: {} } as any } catch { /* not installed */ }

const ROOT = process.cwd()
const code = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) } }
const section = (t: string) => console.log(`\n[${t}]`)
const quiet = async <T,>(fn: () => Promise<T>): Promise<T> => { const w = console.warn, e = console.error, l = console.log; console.warn = () => {}; console.error = () => {}; console.log = () => {}; try { return await fn() } finally { console.warn = w; console.error = e; console.log = l } }

const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222"
const MARKET = "33333333-3333-4333-8333-333333333333", AGENT = "44444444-4444-4444-8444-444444444444"
const CONTACT = "55555555-5555-4555-8555-555555555555", LEAD = "66666666-6666-4666-8666-666666666666"
const SIG = "77777777-7777-4777-8777-777777777777", RAW = "88888888-8888-4888-8888-888888888888", PM = "99999999-9999-4999-8999-999999999999"
const NOW = new Date("2026-11-09T12:00:00Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const market = { id: MARKET, brokerage_id: T1, name: "Pensacola", city: "Pensacola", state: "FL", zip_codes: ["32501", "32502"], counties: ["Escambia"], agent_id: AGENT }
const marketRow = { ...market, is_active: true, enabled_sources: ["exa"], monthly_budget_usd: 100, spend_this_month: 0, max_records_per_run: 100, priority: 1, last_scraped_at: null }
/** The identity probe — names / handles / contact points planted in fixtures that must NEVER ride an evidence row. */
const PERSON_RE = /Dana Example|pcola_newbie|Taylor Brooks|forum\.person@example\.com|known\.contact@example\.com/

const page = (o: Record<string, unknown>) => ({ id: "r-" + String(o.id ?? Math.random()), url: null, title: null, text: null, author: null, publishedDate: null, highlights: null, summary: null, score: 0.8, ...o })
const DB_OPTS = { uuidIds: true, stampCreatedAt: true, unique: { raw_scraped_leads: [["idempotency_key"]], agent_action_ledger: [["idempotency_key"]], movement_signals: [["brokerage_id", "idempotency_key"]] } } as const
const freshDb = (extra: Record<string, unknown[]> = {}) => memSupabase({ raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [], lead_scraping_markets: [marketRow], manager_signals: [], leads: [], ...extra } as never, DB_OPTS as never) as any
const signalRecorder = (calls: any[]) => async (input: any, client: any) => {
  calls.push(input)
  const { data, error } = await client.from("manager_signals").insert({ brokerage_id: input.brokerageId, from_manager: input.fromManager, to_manager: input.toManager, signal_type: input.signalType, message: input.message, entity_type: input.entityType ?? null, entity_id: input.entityId ?? null, contact_id: input.contactId ?? null, payload: input.payload ?? {}, status: "open" }).select("id").single()
  return error ? { ok: false, reason: error.message } : { ok: true, signalId: data.id }
}
const twinFixture = { brokerageId: T1, asOf: "2026-11-09", zips: [{ zip: "32501", asOf: "2026-11-08", listing: { activeListings: { value: 140 }, medianAskingPrice: { value: 365000 } } }], marketGap: { monthsOfSupply: 2.4, asOf: "2026-11-08", source: "idx_feed", reason: "months of supply from the MLS/IDX feed" }, demandGap: { segments: [], suppressedSegments: 0, consentedBuyers: 0, staleInventoryExcluded: 0, freshInventory: 0 }, notes: [], blindSpots: [] }

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = join(dir, name)
    if (statSync(join(ROOT, rel)).isDirectory()) { if (name !== "node_modules") walk(rel, out) } else if (/\.(ts|tsx)$/.test(name)) out.push(rel)
  }
  return out
}

async function main() {
  const hunting = await import("../lib/providers/exa/hunting")
  const contract = await import("../lib/acquisition-plays/contract")
  const corridor = await import("../lib/acquisition-plays/moving-corridor")
  const request = await import("../lib/acquisition-plays/public-request")
  const property = await import("../lib/acquisition-plays/property-candidates")
  const secondWindow = await import("../lib/acquisition-plays/contact-second-window")
  const negative = await import("../lib/acquisition-plays/negative-evidence")
  const runner = await import("../lib/acquisition-plays/runner")
  const monitors = await import("../lib/providers/exa/monitors")
  const cle = await import("../lib/lead-pipeline/canonical-lead-eligibility")
  const { ingestRawSourceBatch } = await import("../lib/kernel/scraping")
  const { WEBHOOK_CONTRACT } = await import("../lib/providers/webhook-contract")
  const norm = (r: Record<string, unknown>) => hunting.normalizeExaHuntRow(r)

  section("A. hunting surface — one row vocabulary, grounded evidence, rights, the key by name, the play cards")
  {
    const objSummary = norm(page({ id: "a1", url: "https://www.pnj.com/story/x", summary: { employer: "Navy Federal" } }))
    check("a schema-shaped summary object is the extraction", objSummary.extracted?.employer === "Navy Federal" && objSummary.publisher === "pnj.com")
    check("a JSON-string summary is parsed; a prose summary is not an extraction", norm(page({ id: "a2", url: "https://x.com/a", summary: '{"employer":"Acme"}' })).extracted?.employer === "Acme" && norm(page({ id: "a3", url: "https://x.com/b", summary: "A plain summary." })).extracted === null)
    check("no openable URL → no grounded evidence", hunting.groundedEvidence(norm(page({ id: "a4", text: "words" })), NOW) === null)
    const long = hunting.groundedEvidence(norm(page({ id: "a5", url: "https://x.com/c", highlights: ["y".repeat(900)] })), NOW)
    check("the quoted basis is the page's own words, capped at 280 chars", !!long && long.quotedBasis.length === 280 && long.retrievedAt === NOW.toISOString())
    check("freshness: 200 days old is stale for a 90-day play; undated is stale only when a date is required", !!hunting.freshnessProblem({ publishedAt: daysAgo(200) }, 90, NOW) && !!hunting.freshnessProblem({ publishedAt: null }, 90, NOW, { requireDate: true }) && hunting.freshnessProblem({ publishedAt: null }, 90, NOW) === null && hunting.freshnessProblem({ publishedAt: daysAgo(3) }, 90, NOW) === null)
    const r = (u: string) => hunting.sourceRightsForUrl(u)
    check("rights by page class: official record (.gov), owner-published listing, classified 'wanted', forum, news, unknown", r("https://escambiaclerk.gov/notices/1").sourceClass === "official_record" && r("https://escambiaclerk.gov/notices/1").officialRecord && r("https://www.forsalebyowner.com/listing/1").sourceClass === "owner_published_listing" && r("https://pensacola.craigslist.org/hsw/d/x/1.html").sourceClass === "classified_wanted" && r("https://www.reddit.com/r/Pensacola/x").sourceClass === "public_forum" && r("https://www.pnj.com/story/news/x").sourceClass === "news" && r("https://someblog.example.net/post").sourceClass === "unknown")
    check("a published contact point may be used only on an owner-published listing or a classified 'wanted' post; never a forum, news or unknown host", r("https://www.forsalebyowner.com/listing/1").publishedContactPermitted && r("https://pensacola.craigslist.org/hsw/d/x/1.html").publishedContactPermitted && !r("https://www.reddit.com/r/x").publishedContactPermitted && !r("https://www.pnj.com/story/x").publishedContactPermitted && !r("https://someblog.example.net/p").publishedContactPermitted)
    check("the CHANNEL is never messageable, whatever the class (a constant, read not assumed)", ["https://escambiaclerk.gov/a", "https://www.forsalebyowner.com/b", "https://www.reddit.com/c", "https://z.example/d"].every((u) => r(u).channelMessagingPermitted === false && r(u).excerptOnly === true))
    check("WAITING_EXTERNAL by name: no EXA_API_KEY → no client; a key → a client (not called)", hunting.productionExaHuntClient({}) === null && hunting.productionExaHuntClient({ EXA_API_KEY: "k" }) !== null)
    const none = await hunting.huntTerritory(null, [{ key: "s", query: "q" }], NOW)
    check("a null client hunts nothing: provider_unconfigured, zero results, the error names EXA_API_KEY", none.status === "provider_unconfigured" && none.results.length === 0 && /EXA_API_KEY/.test(none.errors.join()))
    const dup = norm(page({ id: "d1", url: "https://x.com/same" }))
    const fx = { search: async (s: any) => ({ ok: true, results: s.key === "s1" ? [dup, norm(page({ id: "d2", url: "https://x.com/other" }))] : [norm(page({ id: "d1b", url: "https://x.com/SAME" }))], costUsd: 0.007, costBasis: "estimated" as const, error: null }) }
    const hunted = await hunting.huntTerritory(fx, [{ key: "s1", query: "a" }, { key: "s2", query: "b" }], NOW)
    check("one page across two searches is ONE result (url, case-insensitive); costs sum", hunted.results.length === 2 && hunted.bySearch.s1 === 2 && hunted.bySearch.s2 === 0 && Math.abs(hunted.costUsd - 0.014) < 1e-9)
    const cards = contract.PLAY_CARDS
    check("every play has a card with all twelve facets, a negative control and existing exports it ends in", contract.PLAY_KEYS.every((k) => { const c = cards[k]; return !!c && contract.PLAY_FACETS.every((f) => (c.facets[f] ?? "").length > 20) && c.negativeControl.length > 20 && c.endsIn.length > 0 }))
    const EXPORT_HOME: Record<string, string> = { ingestRawSourceBatch: "lib/kernel/scraping.ts", publishManagerSignal: "lib/kernel/manager-signals.ts", produceMarketReport: "lib/market-reports/producer.ts", createLeadMagnet: "lib/kernel/lead-magnets.ts", recordMovementSignal: "lib/intent/movement-signals.ts", reassessExistingContact: "lib/intent/movement-signals.ts", recordMovementOutcome: "lib/intent/movement-signals.ts", respondToLifeChangeSignal: "lib/ai-isa/followup-arbiter.ts" }
    const exists = (name: string) => !!EXPORT_HOME[name] && new RegExp(`export (?:async )?function ${name}\\b`).test(code(EXPORT_HOME[name]))
    check("each `endsIn` names an export that EXISTS in its survivor file (stripped source)", contract.PLAY_KEYS.every((k) => cards[k].endsIn.every(exists)), JSON.stringify(contract.PLAY_KEYS.flatMap((k) => cards[k].endsIn.filter((n) => !exists(n)))))
    check("POSITIVE CONTROL: an invented export name does not exist", !exists("ingestRawSourceBatchTwo") && !exists("produceMarketReport2"))
    const ranks = contract.PLAY_KEYS.map((k) => cards[k].earliestAssistanceRank).sort()
    check("plays are ranked by earliest verified assistance (1..5, the Contact radar first)", ranks.join() === "1,2,3,4,5" && cards.contact_second_window.earliestAssistanceRank === 1)
    const nonExa = await quiet(() => monitors.ensureExaMonitors(freshDb({ provider_monitors: [] }), { brokerageId: T1, market, plays: ["contact_second_window", "negative_evidence_saver"], webhookUrl: "https://app.example/api/webhooks/exa" }, { apiKey: "k", seal: (s: string) => s, create: (async () => { throw new Error("never called for a non-Exa play") }) as never }))
    check("the first-party plays (Contact radar, negative evidence) never get a provider monitor — only the Exa-hunted plays do", nonExa.length === 0 && contract.EXA_HUNTED_PLAYS.length === 3)
    check("no city and no state → no search (territory-honest)", corridor.corridorSearches({ ...market, city: null, state: null }).length === 0 && request.publicRequestSearches({ ...market, city: null, state: null }).length === 0 && property.propertyCandidateSearches({ ...market, city: null, state: null }).length === 0)
  }

  section("B. moving-corridor radar — announcement + coverage + inventory → education and opt-in, never a person")
  {
    const p1 = norm(page({ id: "p1", url: "https://www.pnj.com/story/money/2026/11/01/navy-federal-expansion/", title: "Navy Federal to add 1,200 jobs in Pensacola expansion", publishedDate: daysAgo(10), author: "Dana Example", text: "Dana Example, chief executive, said the campus will grow. The credit union announced 1,200 new jobs over three years.", highlights: ["The credit union announced 1,200 new jobs over three years at its Pensacola campus."], summary: { is_announcement: true, employer: "Navy Federal Credit Union", event_type: "expansion", location_city: "Pensacola", location_state: "FL", headcount_announced: 1200, start_date: "2027" } }))
    const p2 = norm(page({ id: "p2", url: "https://weartv.com/news/local/navy-federal-1200-jobs", title: "Navy Federal expansion brings 1,200 jobs", publishedDate: daysAgo(12), highlights: ["Navy Federal Credit Union will add 1,200 positions at its Pensacola campus."], summary: { is_announcement: true, employer: "Navy Federal Credit Union", event_type: "expansion", location_city: "Pensacola", location_state: "FL", headcount_announced: null, start_date: null } }))
    const p3 = norm(page({ id: "p3", url: "https://www.bizjournals.com/x/opinion", title: "Why Gulf Coast employers are optimistic", publishedDate: daysAgo(5), highlights: ["Employers remain optimistic about hiring."], summary: { is_announcement: false, employer: "Acme", event_type: "other" } }))
    const p4 = norm(page({ id: "p4", url: "https://www.pnj.com/story/old", title: "Old Corp relocating to Pensacola", publishedDate: daysAgo(200), highlights: ["Old Corp will relocate its headquarters."], summary: { is_announcement: true, employer: "Old Corp", event_type: "relocation", location_city: "Pensacola", location_state: "FL" } }))
    const p5 = norm(page({ id: "p5", url: "https://www.ajc.com/news/x", title: "Peach Co opens Atlanta office", publishedDate: daysAgo(3), highlights: ["Peach Co opens a new office in Atlanta."], summary: { is_announcement: true, employer: "Peach Co", event_type: "office_opening", location_city: "Atlanta", location_state: "GA" } }))
    const p6 = norm(page({ id: "p6", url: "https://www.pnj.com/story/health/clinic", title: "Ascension Sacred Heart to open new clinic bringing 300 jobs", publishedDate: daysAgo(7), highlights: ["The health system will open a new clinic with about 300 jobs."], summary: "A prose summary with no schema." }))
    const results = [p1, p2, p3, p4, p5, p6]
    const db = freshDb()
    const signals: any[] = [], reports: any[] = [], magnets: any[] = []
    const deps = { ingest: ingestRawSourceBatch as never, twin: async () => twinFixture as never, signal: signalRecorder(signals) as never, report: async (_s: unknown, input: any) => { reports.push(input); return { ok: true, documentId: "doc-1" } }, magnet: async (input: any) => { magnets.push(input); return { success: true, magnetId: "mag-1" } } }
    const r1 = await quiet(() => corridor.runMovingCorridorPlay(db, { market, hunt: null, results, now: NOW, activate: true }, deps))
    const rows = db.tables.raw_scraped_leads as any[]
    check("status acted; three cited pages (two about one announcement, one by title heuristic) → three job_civic_event rows through THE ONE producer", r1.status === "acted" && rows.length === 3 && rows.every((x) => x.subject_kind === "job_civic_event"), JSON.stringify({ status: r1.status, n: rows.length, kinds: rows.map((x) => x.subject_kind) }))
    check("dropped and counted: not an announcement, stale, outside the territory's state", /not_an_announcement":1/.test(r1.blindSpots.join()) && /"stale":1/.test(r1.blindSpots.join()) && /outside_territory_state":1/.test(r1.blindSpots.join()), r1.blindSpots.join(" | "))
    check("NEGATIVE CONTROL: a market-level event creates NO person row and NO Lead — identity columns empty, the executive's name never rides, the Lead door refuses the kind", rows.every((x) => !x.first_name && !x.last_name && !x.email && !x.phone) && !PERSON_RE.test(JSON.stringify(rows)) && cle.subjectKindLeadProblem("job_civic_event") !== null)
    check("POSITIVE CONTROL: the identity probe sees the executive in the raw page", PERSON_RE.test(JSON.stringify(p1)))
    check("every row cites its source (URL, published, publisher) and states the claim boundary", rows.every((x) => Array.isArray(x.proof_urls) && x.proof_urls.length === 1 && x.evidence?.citation?.url && x.evidence?.citation?.published && /no worker is assumed to move/.test(String(x.evidence?.claim_boundary))))
    const briefs = signals.map((s) => s.payload?.brief)
    check("two announcements → two briefs to campaign_orchestrator, each grouped across its pages with the announced headcount AS ANNOUNCED", signals.length === 2 && signals.every((s) => s.toManager === "campaign_orchestrator" && s.fromManager === "data_steward" && s.signalType === "corridor_radar_brief") && briefs.some((b) => b.announcement.employer === "Navy Federal Credit Union" && b.announcement.citations.length === 2 && b.announcement.headcountAnnounced === 1200) && briefs.some((b) => b.announcement.employer === "Ascension Sacred Heart" && b.announcement.extraction === "title_heuristic" && b.announcement.headcountAnnounced === 300), JSON.stringify(briefs.map((b) => [b?.announcement?.employer, b?.announcement?.citations?.length])))
    check("coverage is the territory's zips with commute minutes NOT computed; the stored inventory gives the gap (2.4 months → tight); the boundary is stated", briefs.every((b) => b.coverage.territoryZips.join() === "32501,32502" && b.coverage.commuteMinutes === null && b.inventory.monthsOfSupply === 2.4 && b.gapVerdict === "tight" && /no person is identified/.test(b.claimBoundary)))
    check("activation ends in the market-report producer with an evidence-cited topic for the territory (manager actor, no person)", reports.length === 2 && reports.every((x) => x.brokerageId === T1 && x.actor?.managerKey === "campaign_orchestrator" && x.territory?.label === "Pensacola, FL" && x.purpose === "corridor_radar_local_guide" && !("contactId" in x)) && reports.some((x) => x.topic.evidenceIds.includes("exa:p1") && x.topic.evidenceIds.includes("exa:p2")), JSON.stringify(reports.map((x) => x.topic?.evidenceIds)))
    check("…and in a DRAFT lead magnet (market_report) owned by the territory's agent — a human publishes it", magnets.length === 2 && magnets.every((m) => m.publishState === "draft" && m.magnetType === "market_report" && m.agentId === AGENT && m.brokerageId === T1 && /local buyer guide/i.test(m.title)))
    const r2 = await quiet(() => corridor.runMovingCorridorPlay(db, { market, hunt: null, results, now: NOW, activate: true }, deps))
    const ing2 = r2.actions.find((x) => x.kind === "ingest_evidence")?.detail as any
    check("replay: the same pages are three REPLAYS (C35 key), the briefs are already open, no second report or magnet", ing2?.inserted === 0 && ing2?.replayed === 3 && rows.length === 3 && r2.actions.filter((x) => x.kind === "manager_signal").every((x) => (x.detail as any).already_open === true) && reports.length === 2 && magnets.length === 2, JSON.stringify(ing2))
    const off = await quiet(() => corridor.runMovingCorridorPlay(freshDb(), { market, hunt: null, now: NOW }, deps))
    check("no provider key and no delta → provider_unconfigured, zero rows, nothing invented", off.status === "provider_unconfigured" && off.evidence.length === 0 && off.actions.length === 0)
    const pool = freshDb()
    const r3 = await quiet(() => corridor.runMovingCorridorPlay(pool, { market: { ...market, brokerage_id: null }, hunt: null, results: [p1], now: NOW, activate: true }, deps))
    check("a platform-pool territory (no tenant) ingests the cited evidence but briefs nobody and activates nothing", r3.status === "acted" && (pool.tables.raw_scraped_leads as any[]).length === 1 && r3.actions.every((x) => x.kind === "ingest_evidence") && /platform-pool/.test(r3.blindSpots.join()))
  }

  section("C. public requests — a person only by their own published contact point on a permitted page; nobody is deanonymized")
  {
    const q1 = norm(page({ id: "q1", url: "https://pensacola.craigslist.org/hsw/d/pensacola-looking-for-agent/7701.html", title: "Relocating family seeks agent", publishedDate: daysAgo(5), text: "We're relocating to Pensacola in January and I'm looking for a real estate agent who knows the east side. Email us at jordan.moves@example.com or text 850-555-0199.", highlights: ["We're relocating to Pensacola in January and I'm looking for a real estate agent who knows the east side."] }))
    const q2 = norm(page({ id: "q2", url: "https://www.reddit.com/r/Pensacola/comments/abc/looking_for_realtor/", title: "Looking for a realtor", author: "pcola_newbie", publishedDate: daysAgo(4), text: "I'm looking for a realtor in Pensacola, any recommendations?", highlights: ["I'm looking for a realtor in Pensacola, any recommendations?"] }))
    const q3 = norm(page({ id: "q3", url: "https://nextdoor.com/p/abc", title: "Agent recommendation", publishedDate: daysAgo(2), text: "My sister is looking for a real estate agent in Pensacola, who do you recommend?", highlights: ["My sister is looking for a real estate agent in Pensacola, who do you recommend?"] }))
    const q4 = norm(page({ id: "q4", url: "https://pensacola.craigslist.org/rew/d/agent-wanted/7702.html", title: "Agent wanted", publishedDate: daysAgo(6), text: "Hi, Taylor Brooks here. I'm looking for a real estate agent in Pensacola.", highlights: ["I'm looking for a real estate agent in Pensacola."] }))
    const q5 = norm(page({ id: "q5", url: "https://pensacola.craigslist.org/hsw/d/old/7703.html", title: "Old request", publishedDate: daysAgo(150), text: "I'm looking for a real estate agent in Pensacola. Email old.request@example.com.", highlights: ["I'm looking for a real estate agent in Pensacola."] }))
    const q6 = norm(page({ id: "q6", url: "https://pensacola.craigslist.org/hsw/d/buyers-agent/7704.html", title: "Buyer's agent", publishedDate: daysAgo(3), text: "I'm looking for a buyer's agent in Pensacola. Email me at known.contact@example.com.", highlights: ["I'm looking for a buyer's agent in Pensacola."] }))
    const q7 = norm(page({ id: "q7", url: "https://www.reddit.com/r/Pensacola/comments/def/realtor/", title: "Realtor?", publishedDate: daysAgo(1), text: "I'm looking for a realtor in Pensacola. Email me at forum.person@example.com.", highlights: ["I'm looking for a realtor in Pensacola."] }))
    const db = freshDb({ contacts: [{ id: CONTACT, brokerage_id: T1, email: "known.contact@example.com", phone: null, deleted_at: null }] })
    const responds: any[] = []
    const r = await quiet(() => request.runPublicRequestPlay(db, { market, hunt: null, results: [q1, q2, q3, q4, q5, q6, q7], now: NOW }, { ingest: ingestRawSourceBatch as never, respond: (async (_s: unknown, input: any) => { responds.push(input); return { action: "isa_engagement", subjectClass: "contact", kind: "buying", reason: "fixture" } }) as never }))
    const rows = db.tables.raw_scraped_leads as any[]
    const persons = rows.filter((x) => x.subject_kind === "person"), anon = rows.filter((x) => x.subject_kind === "anonymous_question")
    check("ONE person row: a first-person request with the contact point its author published on a classified 'wanted' page (email + phone, no handle)", persons.length === 1 && persons[0].email === "jordan.moves@example.com" && persons[0].phone === "8505550199" && !persons[0].normalized_preview?.username && persons[0].evidence?.identity_basis === "published_contact" && /published this contact point/.test(String(persons[0].evidence?.consent_basis)), JSON.stringify(persons.map((p) => [p.email, p.phone])))
    check("the person row quotes the request verbatim and states the channel policy (never a reply in the channel)", /I'm looking for a real estate agent/.test(String(persons[0]?.evidence?.quote)) && /never a reply in the channel/.test(String(persons[0]?.evidence?.channel_policy)))
    check("POSITIVE CONTROL: a person kind MAY walk toward the Lead door (the EXISTING promotion gate decides)", cle.subjectKindLeadProblem("person") === null)
    check("four anonymous questions: handle-only (forum), third-party mention, name-only, forum with a published email its terms forbid using", anon.length === 4, JSON.stringify(anon.map((x) => x.raw_data?.url)))
    check("NEGATIVE CONTROL: no handle, name or forbidden contact point rides any evidence row (never deanonymized)", !PERSON_RE.test(JSON.stringify(anon)) && anon.every((x) => !x.first_name && !x.last_name && !x.email && !x.phone && !x.normalized_preview?.username))
    check("POSITIVE CONTROL: the probe sees the handle, the name and the forum email in the raw pages", PERSON_RE.test(JSON.stringify([q2, q4, q7])))
    const why = r.refused.map((x) => x.why).join(" | ")
    check("each refusal of the person path names its rule (handle alone · not first-person · a name alone · the page's terms)", /handle alone/.test(why) && /not a first-person statement/.test(why) && /a name alone never joins/.test(why) && /terms do not permit/.test(why), why)
    check("a stale request is dropped, not stored", /days ago/.test(r.blindSpots.join()) && !rows.some((x) => /7703/.test(String(x.raw_data?.url))))
    check("an EXISTING Contact by their own published email → THE arbiter (respondToLifeChangeSignal), NO new row", responds.length === 1 && responds[0].subject?.id === CONTACT && responds[0].signalType === "buying_intent" && !rows.some((x) => x.email === "known.contact@example.com") && r.actions.some((x) => x.kind === "arbiter"))
    const src = code("lib/acquisition-plays/public-request.ts")
    const OUTBOUND = /\b(dispatch(Email|Sms|DirectMail)?|sendSms|sendEmail|sendMessage|twilio|createDraft|postReply|replyTo)\s*\(/
    check("the module contains NO outbound dispatch (stripped source)", !OUTBOUND.test(src))
    check("POSITIVE CONTROL: the outbound probe matches a planted call", OUTBOUND.test('await dispatchSms({ to })') && OUTBOUND.test("sendEmail(x)"))
  }

  section("D. property candidates — property-level rows with rights recorded; owner only through verified records")
  {
    const f1 = norm(page({ id: "f1", url: "https://www.forsalebyowner.com/listing/412-e-gadsden-st/123", title: "412 E Gadsden St — For Sale By Owner", publishedDate: daysAgo(20), text: "Charming 3/2 near downtown. Call Chris at 850-555-0142.", highlights: ["Charming 3/2 near downtown, offered by owner."], summary: { listing_kind: "fsbo", property_address: "412 E Gadsden St", city: "Pensacola", state: "FL", zip: "32501", asking_price: 389000, owner_published_contact: true, owner_name_as_published: "Chris Alvarez" } }))
    const f2 = norm(page({ id: "f2", url: "https://escambiaclerk.gov/notices/probate/2026-1187", title: "Notice to Creditors — Estate of Maria Lopez", publishedDate: daysAgo(30), highlights: ["The administration of the Estate of Maria Lopez, deceased, is pending; real property at 901 N Palafox St."], summary: { listing_kind: "probate_notice", property_address: "901 N Palafox St", city: "Pensacola", state: "FL", estate_or_entity_name: "Estate of Maria Lopez", notice_or_filing_date: daysAgo(31) } }))
    const f3 = norm(page({ id: "f3", url: "https://www.pnj.com/story/news/estate-sale", title: "Estate home may hit the market", publishedDate: daysAgo(8), highlights: ["The estate of a longtime resident may sell the home."], summary: { listing_kind: "probate_notice", property_address: "10 Bay St", city: "Pensacola", state: "FL", estate_or_entity_name: "Estate of Someone" } }))
    const f4 = norm(page({ id: "f4", url: "https://www.bizjournals.com/pensacola/news/2026/11/02/relocation", title: "Gulf Logistics moving headquarters to Pensacola", publishedDate: daysAgo(7), highlights: ["Gulf Logistics will move its headquarters to downtown Pensacola next spring."], summary: { listing_kind: "business_relocation", city: "Pensacola", state: "FL" } }))
    const f5 = norm(page({ id: "f5", url: "https://www.fsbo.com/listings/999", title: "Lovely home by owner", publishedDate: daysAgo(9), highlights: ["Lovely home by owner, call for details."], summary: { listing_kind: "fsbo", owner_published_contact: true } }))
    const f6 = norm(page({ id: "f6", url: "https://www.zillow.com/homedetails/77-Bayou-Blvd/1", title: "77 Bayou Blvd — listed by Other Realty", publishedDate: daysAgo(2), highlights: ["77 Bayou Blvd is listed by Other Realty."], summary: { listing_kind: "agent_listing", property_address: "77 Bayou Blvd", city: "Pensacola", state: "FL", listing_brokerage: "Other Realty" } }))
    const f7 = norm(page({ id: "f7", url: "https://www.forsalebyowner.com/listing/al/5", title: "By owner in Mobile", publishedDate: daysAgo(4), highlights: ["By owner in Mobile, AL."], summary: { listing_kind: "fsbo", property_address: "5 Dauphin St", city: "Mobile", state: "AL", owner_published_contact: false } }))
    const results = [f1, f2, f3, f4, f5, f6, f7]
    const db = freshDb()
    const r = await quiet(() => property.runPropertyCandidatePlay(db, { market, hunt: null, results, now: NOW }, { ingest: ingestRawSourceBatch as never }))
    const rows = db.tables.raw_scraped_leads as any[]
    const kinds = rows.map((x) => x.subject_kind).sort().join()
    check("three rows: a FSBO as PROPERTY, an official probate notice as ENTITY, a business move as EVIDENCE — never a person", r.status === "acted" && kinds === "entity_trust_estate,job_civic_event,property", `${r.status} ${kinds} ${JSON.stringify(r.blindSpots)}`)
    const fsbo = rows.find((x) => x.subject_kind === "property")
    check("the FSBO's published contact rides the PAYLOAD, never a person column; ownership unverified (the producer's own C36 verdict AND the play's); the name-only join is REFUSED and said", !!fsbo && fsbo.address === "412 E Gadsden St" && !fsbo.first_name && !fsbo.last_name && !fsbo.phone && fsbo.raw_data?.published_contact?.phone === "8505550142" && fsbo.evidence?.ownership?.verdict === "unverified" && fsbo.evidence?.ownership_verification?.verdict === "unverified" && /a name alone never joins/.test(String(fsbo.evidence?.identity_join)) && fsbo.evidence?.source_class === "owner_published_listing")
    const est = rows.find((x) => x.subject_kind === "entity_trust_estate")
    check("the estate row is from an OFFICIAL record, intimate, targeting prohibited, outreach none, and the Lead door refuses the kind", !!est && est.evidence?.source_class === "official_record" && est.evidence?.targeting_prohibited === true && est.evidence?.outreach === "none" && est.evidence?.sensitivity === "intimate_service_topic" && cle.subjectKindLeadProblem("entity_trust_estate") !== null)
    check("dropped and counted: a news-page 'probate' (not an official record), a FSBO without an address, an out-of-state FSBO", /probate_not_official_record":1/.test(r.blindSpots.join()) && /"no_address":1/.test(r.blindSpots.join()) && /outside_territory_state":1/.test(r.blindSpots.join()), r.blindSpots.join(" | "))
    check("a property listed with another brokerage is a CONTRADICTION for the negative-evidence play, never a candidate", r.contradictions.length === 1 && r.contradictions[0].kind === "active_listing_other_agent" && r.contradictions[0].address === "77 Bayou Blvd" && r.contradictions[0].listingBrokerage === "Other Realty" && !rows.some((x) => x.address === "77 Bayou Blvd"))
    const two = [{ source: "escambia_county_assessor", rights: "public_record", ownerName: "Christopher Alvarez", mailingAddress: null }, { source: "batchdata", rights: "licensed_vendor", ownerName: "Chris Alvarez", mailingAddress: null }]
    const db2 = freshDb()
    await quiet(() => property.runPropertyCandidatePlay(db2, { market, hunt: null, results: [f1], now: NOW }, { ingest: ingestRawSourceBatch as never, ownerRecords: async () => two as never }))
    const owner = (db2.tables.raw_scraped_leads as any[])[0]
    check("with TWO authoritative owner records naming the surname, the FSBO becomes an OWNER row carrying the published name and phone; the verification names both sources (the producer's single-page C36 verdict stays unverified beside it — a page cannot corroborate itself)", owner?.subject_kind === "owner" && owner.last_name === "Alvarez" && owner.phone === "8505550142" && owner.evidence?.ownership_verification?.verdict === "verified" && owner.evidence?.ownership_verification?.sources?.length === 2 && owner.evidence?.ownership?.verdict === "unverified" && owner.raw_data?.owner_records?.length === 2, JSON.stringify(owner?.evidence))
    const db3 = freshDb()
    await quiet(() => property.runPropertyCandidatePlay(db3, { market, hunt: null, results: [f1], now: NOW }, { ingest: ingestRawSourceBatch as never, ownerRecords: async () => [two[0]] as never }))
    const one = (db3.tables.raw_scraped_leads as any[])[0]
    check("NEGATIVE CONTROL: ONE record (no second source, no matching mailing address) is not verification — the row stays PROPERTY", one?.subject_kind === "property" && one.evidence?.ownership_verification?.verdict === "unverified" && !one.last_name && !one.phone)
  }

  section("E. existing-Contact second window — C9 records → the manager → the arbiter; NO raw row, NO lead, NO paid call")
  {
    const seed = () => ({
      contacts: [{ id: CONTACT, brokerage_id: T1, contact_type: "buyer", agent_id: null, zip_code: "32501", deleted_at: null, timeline: null, home_owner_status: null, equity_estimate: null, enrichment_profile: null, updated_at: daysAgo(1) }],
      property_preferences: [{ contact_id: CONTACT, brokerage_id: T1, inferred_cities: ["Pensacola"], preferred_price_max: 400000, inferred_max_price: null, inferred_beds_min: 3, criteria_provenance: "said" }],
      saved_properties: [
        { id: "s1", contact_id: CONTACT, brokerage_id: T1, city: "Gulf Breeze", list_price: 560000, bedrooms: 4, saved_at: daysAgo(3), dismissed: false },
        { id: "s2", contact_id: CONTACT, brokerage_id: T1, city: "Gulf Breeze", list_price: 575000, bedrooms: 4, saved_at: daysAgo(4), dismissed: false },
        { id: "s3", contact_id: CONTACT, brokerage_id: T1, city: "Gulf Breeze", list_price: 590000, bedrooms: 3, saved_at: daysAgo(5), dismissed: false },
        { id: "s4", contact_id: CONTACT, brokerage_id: T1, city: "Pensacola", list_price: 380000, bedrooms: 3, saved_at: daysAgo(2), dismissed: true },
      ],
      valuation_requests: [{ id: "v1", contact_id: CONTACT, brokerage_id: T1, property_address: "412 E Gadsden St", submitted_at: daysAgo(2) }],
      buyer_criteria_changes: [{ id: "k1", contact_id: CONTACT, brokerage_id: T1, field: "max_price", provenance: "said", status: "accepted", created_at: daysAgo(4) }, { id: "k2", contact_id: CONTACT, brokerage_id: T1, field: "cities", provenance: "said", status: "accepted", created_at: daysAgo(6) }],
      movement_signals: [{ id: "m0", brokerage_id: T1, subject_type: "contact", contact_id: CONTACT, source_key: "pp_reddit_relocation", source_kind: "public_post", confidence: "reported", identity_match: "verified_match", event_relevance: "relocation", intents: ["home_purchase"], side: "buyer", evidence: { confidence: "reported", reportedBy: "self", summary: "asked about moving", reference: { kind: "public_post", id: "r1", retrievedAt: daysAgo(1) } }, observed_at: daysAgo(1), outreach: "consent_gated", protected_proxy: false, outcome: null, data_rights: { collection: "public_web_search" }, idempotency_key: "seed-m0" }],
      agent_action_ledger: [], ai_predictions: [], listings: [], transactions: [], buyer_financial_profiles: [], brokerage_settings: [], raw_scraped_leads: [], leads: [],
    })
    const db = memSupabase(seed() as never, DB_OPTS as never) as any
    const publishes: any[] = []
    const decide = async (a: { prompt: string }) => { const p = JSON.parse(a.prompt); const allowed: string[] = p.allowed.map((x: any) => x.action); const action = allowed.includes("offer_help") ? "offer_help" : allowed[0]; return { action, rationale: "fixture: the first permitted step for a known contact with fresh first-party evidence", evidence: p.contributions.map((c: any) => c.id), confidence: 0.9 } }
    const deps = { decide, publish: (async (input: any) => { publishes.push(input); return { ok: true, signalId: "sig-x" } }) as never, windowDays: 180, now: NOW }
    const r = await quiet(() => secondWindow.runContactSecondWindow(db, { brokerageId: T1, contactId: CONTACT, now: NOW, windowDays: 30 }, deps))
    const kinds = r.changes.map((c) => c.kind).sort().join()
    check("three changes read from the Contact's own rows: a saved-home SHIFT (3 saves outside the stated city and above the ceiling; the dismissed one ignored), a valuation request, repeated stated criteria changes", kinds === "criteria_change,saved_home_shift,valuation_request", `${kinds} ${JSON.stringify(r.refused)}`)
    check("the shift's evidence is a verified first-party reference with a plain-sentence summary naming the shift", r.changes.some((c) => c.kind === "saved_home_shift" && /outside the cities they told us/.test(c.summary) && /above the stated ceiling/.test(c.summary) && c.rowIds.join() === "s1,s2,s3"))
    const ms = (db.tables.movement_signals as any[]).filter((x) => x.idempotency_key !== "seed-m0")
    check("three C9 records through the EXISTING recorder (fp_saved_homes / fp_valuation_request / fp_criteria_revisions), tenant-pinned to the contact", r.status === "acted" && ms.length === 3 && ms.map((x) => x.source_key).sort().join() === "fp_criteria_revisions,fp_saved_homes,fp_valuation_request" && ms.every((x) => x.contact_id === CONTACT && x.brokerage_id === T1), JSON.stringify({ status: r.status, n: ms.length, decisions: r.decisions }))
    check("the manager decided each (the chain ran) and handed offer_help to THE arbiter over the bus (online_intent_detected → ai_isa for this contact)", r.decisions.every((d) => d.status === "decided") && publishes.some((p) => p.signalType === "online_intent_detected" && p.toManager === "ai_isa" && p.contactId === CONTACT) && r.actions.some((x) => x.kind === "arbiter"), JSON.stringify({ decisions: r.decisions, publishes: publishes.map((p) => [p.signalType, p.toManager]) }))
    check("NEGATIVE CONTROL: NO raw_scraped_leads row and NO leads row were created for a Contact we already hold", (db.tables.raw_scraped_leads as any[]).length === 0 && (db.tables.leads as any[]).length === 0)
    const src = code("lib/acquisition-plays/contact-second-window.ts")
    const PROVIDER = /from\s+["']@\/lib\/(external|providers)\/|enrichWithPeopleData|batchdata|versium|peopledata|exaSearch|structuredSearch|rentcast/i
    check("NO provider bill: the module imports no provider client and names no paid lookup (stripped source)", !PROVIDER.test(src))
    check("POSITIVE CONTROL: the provider probe matches a planted import", PROVIDER.test('import { x } from "@/lib/external/batchdata-client"'))
    const again = await quiet(() => secondWindow.runContactSecondWindow(db, { brokerageId: T1, contactId: CONTACT, now: NOW, windowDays: 30 }, deps))
    check("a second sweep of the same rows is a REPLAY (C9 idempotency) — no second record, nothing re-decided", again.recorded.every((x) => x.status === "replayed") && (db.tables.movement_signals as any[]).length === 4, JSON.stringify(again.recorded.map((x) => x.status)))
    const foreign = await quiet(() => secondWindow.runContactSecondWindow(db, { brokerageId: T2, contactId: CONTACT, now: NOW }, deps))
    check("(tenancy) another tenant's radar on the same contact is refused — contact not in this brokerage", foreign.status === "refused" && /not in this brokerage/.test(foreign.refused[0]?.why ?? ""))
    const sweep = await quiet(() => secondWindow.sweepContactSecondWindows(memSupabase(seed() as never, DB_OPTS as never) as any, { brokerageId: T1, now: NOW, windowDays: 30 }, deps))
    check("the territory sweep finds the Contact from any of the three first-party tables and runs ONE radar for them", sweep.contacts === 1 && sweep.results.length === 1 && sweep.results[0].status === "acted" && sweep.errors.length === 0)
  }

  section("F. negative-evidence cost saver — newer contrary facts stop / hold / verify; older facts are history; none writes nothing")
  {
    const theory = (over: Partial<Parameters<typeof negative.assessNegativeEvidence>[0]> = {}) => ({ subject: { type: "contact" as const, id: CONTACT }, side: "seller" as const, latestPositiveAt: daysAgo(20), propertyAddress: "412 E Gadsden St", movementSignalId: SIG, leadId: LEAD, rawLeadId: RAW, ...over })
    const ev = (kind: any, over: Record<string, unknown> = {}) => ({ kind, at: daysAgo(5), confidence: "verified", source: "fixture", ...over }) as any
    const a1 = negative.assessNegativeEvidence(theory(), [ev("recorded_sale")], NOW)
    check("a VERIFIED recorded sale newer than the theory → STOP on a seller theory; outcome moved; acquisition stops; class stale_contradicted", a1.verdict === "stop" && a1.outcome === "moved" && a1.acquisition === "stop" && a1.evidenceClass === "stale_contradicted")
    const a2 = negative.assessNegativeEvidence(theory(), [ev("recorded_sale", { at: daysAgo(40) })], NOW)
    check("NEGATIVE CONTROL: the same sale OLDER than the newest positive is history — verdict none, acquisition continues, the reason says why", a2.verdict === "none" && a2.acquisition === "continue" && /history/.test(a2.ignored[0]?.why ?? ""))
    const a3 = negative.assessNegativeEvidence(theory(), [ev("explicit_no_interest", { confidence: "reported", detail: "please stop contacting me" })], NOW)
    check("an explicit 'stop' from the person → STOP, outcome opted_out", a3.verdict === "stop" && a3.outcome === "opted_out")
    const a4 = negative.assessNegativeEvidence(theory(), [ev("active_listing_other_agent", { detail: "Other Realty" })], NOW)
    const a4r = negative.assessNegativeEvidence(theory(), [ev("active_listing_other_agent", { confidence: "reported", detail: "Other Realty" })], NOW)
    check("listed with another agent: MLS-verified → STOP (listed); a public page (reported) → HOLD and verify, never stop", a4.verdict === "stop" && a4.outcome === "listed" && a4r.verdict === "hold" && a4r.outcome === null && a4r.acquisition === "hold")
    check("a changed address → VERIFY; a newer contrary statement → HOLD; an inferred-only fact → VERIFY at most", negative.assessNegativeEvidence(theory(), [ev("changed_address", { confidence: "reported" })], NOW).verdict === "verify" && negative.assessNegativeEvidence(theory(), [ev("newer_contrary_statement", { confidence: "reported", detail: "we decided to stay" })], NOW).verdict === "hold" && negative.assessNegativeEvidence(theory(), [ev("recorded_sale", { confidence: "inferred" }), ev("explicit_no_interest", { confidence: "inferred" })], NOW).verdict === "verify")
    check("a recorded sale on a BUYER theory is a next purchase to verify, not a stop", negative.assessNegativeEvidence(theory({ side: "buyer" }), [ev("recorded_sale")], NOW).verdict === "verify")
    check("the strongest verdict wins across mixed evidence (stop > hold > verify)", negative.assessNegativeEvidence(theory(), [ev("changed_address"), ev("recorded_sale")], NOW).verdict === "stop")
    const db = memSupabase({
      movement_signals: [{ id: SIG, brokerage_id: T1, subject_type: "contact", contact_id: CONTACT, outcome: null, property_address: "412 E Gadsden St" }],
      leads: [{ id: LEAD, brokerage_id: T1, ai_outreach_paused: false }],
      raw_scraped_leads: [{ id: RAW, brokerage_id: T1, ttl_expires_at: "2027-06-01T00:00:00Z" }],
      agent_action_ledger: [], ai_predictions: [], manager_signals: [],
    } as never, DB_OPTS as never) as any
    const signals: any[] = []
    const applied = await quiet(() => negative.applyNegativeEvidence(db, { brokerageId: T1, theory: theory(), assessment: a1, now: NOW }, { signal: signalRecorder(signals) as never }))
    const mrow = (db.tables.movement_signals as any[])[0], lrow = (db.tables.leads as any[])[0], rrow = (db.tables.raw_scraped_leads as any[])[0]
    check("STOP ends in recordMovementOutcome (outcome moved, ledgered), pauses the lead's AI outreach (counted), expires the raw observation and tells the ISA on the bus", applied.status === "acted" && mrow.outcome === "moved" && lrow.ai_outreach_paused === true && rrow.ttl_expires_at === NOW.toISOString() && signals.length === 1 && signals[0].toManager === "ai_isa" && signals[0].signalType === "negative_evidence_verdict" && signals[0].payload?.verdict === "stop" && (db.tables.agent_action_ledger as any[]).length >= 1, JSON.stringify({ status: applied.status, actions: applied.actions.map((x) => x.kind), refused: applied.refused }))
    const db2 = memSupabase({ movement_signals: [{ id: SIG, brokerage_id: T1, outcome: null }], leads: [{ id: LEAD, brokerage_id: T1, ai_outreach_paused: false }], raw_scraped_leads: [{ id: RAW, brokerage_id: T1, ttl_expires_at: "2027-06-01T00:00:00Z" }], agent_action_ledger: [], manager_signals: [] } as never, DB_OPTS as never) as any
    const nothing = await quiet(() => negative.applyNegativeEvidence(db2, { brokerageId: T1, theory: theory(), assessment: a2, now: NOW }, { signal: signalRecorder([]) as never }))
    check("NEGATIVE CONTROL: a `none` verdict writes NOTHING — outcome open, lead unpaused, observation current, no signal", nothing.status === "nothing_found" && nothing.actions.length === 0 && (db2.tables.movement_signals as any[])[0].outcome === null && (db2.tables.leads as any[])[0].ai_outreach_paused === false && (db2.tables.agent_action_ledger as any[]).length === 0 && (db2.tables.manager_signals as any[]).length === 0)
    const foreign = await quiet(() => negative.applyNegativeEvidence(db2, { brokerageId: T2, theory: theory(), assessment: a1, now: NOW }, { signal: signalRecorder([]) as never }))
    check("(tenancy) another tenant's stop touches nothing — zero rows matched, said as refusals", (db2.tables.leads as any[])[0].ai_outreach_paused === false && foreign.refused.some((x) => /no lead matched/.test(x.why)))
    const src = code("lib/acquisition-plays/negative-evidence.ts")
    const ADDS = /ingestRawSourceBatch|enrichWithPeopleData|dispatch(Email|Sms)?\(|createLeadMagnet|produceMarketReport/
    check("the module never ingests, enriches, dispatches or produces — it only removes (stripped source)", !ADDS.test(src))
    check("POSITIVE CONTROL: the adds-probe matches the corridor play, which does produce", ADDS.test(code("lib/acquisition-plays/moving-corridor.ts")))
  }

  section("G. webhook — signed, idempotent, replay-safe; the tenant comes from OUR row, never the payload")
  {
    const secret = "whsec_test_fixture"
    const nowSec = Math.floor(NOW.getTime() / 1000)
    const sign = (body: string, t = nowSec, s = secret) => `t=${t},v1=${createHmac("sha256", s).update(`${t}.${body}`, "utf8").digest("hex")}`
    const p1 = { id: "r-w1", url: "https://www.pnj.com/story/money/2026/11/05/st-engineering-expansion/", title: "ST Engineering to add 400 jobs at Pensacola campus", publishedDate: daysAgo(4), highlights: ["ST Engineering will add 400 jobs at its Pensacola campus."], summary: { is_announcement: true, employer: "ST Engineering", event_type: "expansion", location_city: "Pensacola", location_state: "FL", headcount_announced: 400 } }
    const bodyObj = { id: "evt_1", type: "monitor.run.completed", data: { id: "run_1", monitorId: "mon_1", metadata: { market_id: "spoofed", brokerage_id: T2 }, output: { results: [p1] } } }
    const rawBody = JSON.stringify(bodyObj)
    const mkDb = () => freshDb({ provider_monitors: [{ id: PM, brokerage_id: T1, market_id: MARKET, provider: "exa", provider_monitor_id: "mon_1", play_key: "moving_corridor_radar", status: "active", cadence: "1d", webhook_secret_ciphertext: "sealed:mon_1", deliveries: 0 }] })
    const fakeEmit = async (input: any) => {
      const svc = input.client
      const { data: ex } = await svc.from("lifecycle_events").select("id").eq("dedupe_key", input.dedupeKey).limit(1)
      if (ex?.length) return { inserted: false, lifecycleEventId: ex[0].id, fanOutOk: true, error: null }
      const { data, error } = await svc.from("lifecycle_events").insert({ brokerage_id: input.brokerageId, entity_type: input.entityType, entity_id: input.entityId, event_type: input.event, dedupe_key: input.dedupeKey, metadata: input.metadata, source: input.source }).select("id").single()
      return error ? { inserted: false, lifecycleEventId: null, fanOutOk: false, error: error.message } : { inserted: true, lifecycleEventId: data.id, fanOutOk: true, error: null }
    }
    const signals: any[] = []
    const deps = { unseal: (c: string) => (c === "sealed:mon_1" ? secret : null), emit: fakeEmit as never, nowSec, now: NOW, runPlays: ((svc: any, a: any) => runner.runEarlyOpportunityPlays(svc, a, { corridor: { ingest: ingestRawSourceBatch as never, twin: async () => twinFixture as never, signal: signalRecorder(signals) as never } })) as never }
    // The signature rules, each through the ONE handler (the verifier is module-private): a fresh registry per case.
    const sigCase = (body: string, header: string | null) => quiet(() => monitors.handleExaWebhookDelivery(mkDb(), { rawBody: body, signatureHeader: header, envSecret: null }, deps))
    check("the signature verifies: hex HMAC-SHA256 over `${t}.${body}` inside the 5-minute window → the delivery is accepted", (await sigCase(rawBody, sign(rawBody))).status === 200)
    check("refused 401, each naming its reason: wrong secret · tampered body · stale timestamp · malformed header · missing header", /mismatch/.test(String((await sigCase(rawBody, sign(rawBody, nowSec, "other"))).body.error)) && /mismatch/.test(String((await sigCase(rawBody + " ", sign(rawBody))).body.error)) && /replay window/.test(String((await sigCase(rawBody, sign(rawBody, nowSec - 1000))).body.error)) && /malformed/.test(String((await sigCase(rawBody, "v1=abc")).body.error)) && /missing/.test(String((await sigCase(rawBody, null)).body.error)))
    check("several v1 values: one valid among them verifies; a wrong-length one never throws (no 500)", (await sigCase(rawBody, `t=${nowSec},v1=deadbeef,${sign(rawBody).split(",")[1]}`)).status === 200)
    const db = mkDb()
    const bad = await quiet(() => monitors.handleExaWebhookDelivery(db, { rawBody, signatureHeader: sign(rawBody, nowSec, "wrong"), envSecret: null }, deps))
    check("a bad signature is 401 and nothing is written", bad.status === 401 && (db.tables.raw_scraped_leads as any[]).length === 0 && (db.tables.lifecycle_events as any[]).length === 0)
    const stale = await quiet(() => monitors.handleExaWebhookDelivery(db, { rawBody, signatureHeader: sign(rawBody, nowSec - 900), envSecret: null }, deps))
    check("a stale signature (15 min) is 401 — replay window", stale.status === 401 && /replay window/.test(String(stale.body.error)))
    const garbage = await quiet(() => monitors.handleExaWebhookDelivery(db, { rawBody: "{not json", signatureHeader: sign("{not json"), envSecret: null }, deps))
    check("invalid JSON is 400", garbage.status === 400)
    const noSecretDb = freshDb({ provider_monitors: [{ id: PM, brokerage_id: T1, market_id: MARKET, provider: "exa", provider_monitor_id: "mon_1", play_key: "moving_corridor_radar", status: "active", webhook_secret_ciphertext: null, deliveries: 0 }] })
    const noSecret = await quiet(() => monitors.handleExaWebhookDelivery(noSecretDb, { rawBody, signatureHeader: sign(rawBody), envSecret: null }, deps))
    check("no sealed secret and EXA_WEBHOOK_SECRET unset → 503 (fail closed), never accepted", noSecret.status === 503 && /EXA_WEBHOOK_SECRET/.test(String(noSecret.body.error)))
    const unregBody = JSON.stringify({ ...bodyObj, data: { ...bodyObj.data, monitorId: "mon_999" } })
    const unreg = await quiet(() => monitors.handleExaWebhookDelivery(db, { rawBody: unregBody, signatureHeader: sign(unregBody), envSecret: secret }, deps))
    check("an UNREGISTERED monitor (verified with the env fallback) is 202 and nothing is done", unreg.status === 202 && unreg.body.accepted === false && /unregistered/.test(String(unreg.body.reason)) && (db.tables.raw_scraped_leads as any[]).length === 0)
    const briefsBefore = signals.length // the accepted signature cases above each ran the play on their own fresh registry
    const ok1 = await quiet(() => monitors.handleExaWebhookDelivery(db, { rawBody, signatureHeader: sign(rawBody), envSecret: null }, deps))
    const rows = db.tables.raw_scraped_leads as any[]
    check("the registered delivery is 200: the delta walked the registered play into THE ONE producer (one job_civic_event row), audited once, registry stamped", ok1.status === 200 && ok1.body.accepted === true && ok1.body.replayed === false && rows.length === 1 && rows[0].subject_kind === "job_civic_event" && (db.tables.lifecycle_events as any[]).some((e) => e.dedupe_key === "exa_webhook:evt_1") && (db.tables.provider_monitors as any[])[0].deliveries === 1 && (db.tables.provider_monitors as any[])[0].last_delivery_event_id === "evt_1", JSON.stringify(ok1.body))
    check("the TENANT and territory came from OUR row, not the payload's spoofed metadata", rows[0].brokerage_id === T1 && rows[0].market_id === MARKET && signals.length === briefsBefore + 1 && signals.every((s) => s.brokerageId === T1))
    const replay = await quiet(() => monitors.handleExaWebhookDelivery(db, { rawBody, signatureHeader: sign(rawBody), envSecret: null }, deps))
    check("the SAME event redelivered is 200 replayed — no second row, no second brief, registry unchanged", replay.status === 200 && replay.body.replayed === true && rows.length === 1 && signals.length === briefsBefore + 1 && (db.tables.provider_monitors as any[])[0].deliveries === 1)
    const evt2 = JSON.stringify({ ...bodyObj, id: "evt_2", data: { ...bodyObj.data, id: "run_2" } })
    const ok2 = await quiet(() => monitors.handleExaWebhookDelivery(db, { rawBody: evt2, signatureHeader: sign(evt2), envSecret: null }, deps))
    check("a NEW event carrying the SAME page is accepted, and the page is a C35 replay (one observation, two deliveries)", ok2.status === 200 && ok2.body.replayed === false && rows.length === 1 && (db.tables.provider_monitors as any[])[0].deliveries === 2)
    const created = JSON.stringify({ id: "evt_3", type: "monitor.created", data: { id: "mon_1" } })
    const ack = await quiet(() => monitors.handleExaWebhookDelivery(db, { rawBody: created, signatureHeader: sign(created), envSecret: null }, deps))
    check("a non-run event is acknowledged (202) and does nothing", ack.status === 202 && ack.body.action === "acknowledged" && rows.length === 1)
    const route = code("app/api/webhooks/exa/route.ts")
    check("the route reads the exa-signature header, consults EXA_WEBHOOK_SECRET by NAME, and delegates to the one handler", /"exa-signature"/.test(route) && /process\.env\.EXA_WEBHOOK_SECRET/.test(route) && /handleExaWebhookDelivery\(/.test(route) && /createServiceClient\(\)/.test(route))
    const row = WEBHOOK_CONTRACT.find((e) => e.path === "/api/webhooks/exa")
    check("the inbound webhook contract names the door (hmac-sha256, exa-signature, EXA_WEBHOOK_SECRET, implemented in monitors.ts)", !!row && row.scheme === "hmac-sha256" && row.verificationHeaders.includes("exa-signature") && row.secretEnv.includes("EXA_WEBHOOK_SECRET") && (row.implementedIn ?? []).includes("lib/providers/exa/monitors.ts") && row.routeFile === "app/api/webhooks/exa/route.ts")
    const mon = code("lib/providers/exa/monitors.ts")
    check("the verifier is length-guarded before timingSafeEqual (unequal lengths never throw → never a 500)", /given\.length !== expected\.length\) continue/.test(mon) && /timingSafeEqual\(expected, given\)/.test(mon))
    // Registration — the secret is sealed, never stored or logged in plaintext.
    const regDb = freshDb({ provider_monitors: [] })
    const creates: any[] = []
    const createFx = (async (_k: string, i: any) => { creates.push(i); return { ok: true, status: 200, data: { monitorId: "mon_new", webhookSecret: "whsec_new_plain", status: "active", nextRunAt: null }, error: null } }) as never
    const ensure = (d: Record<string, unknown>) => quiet(async () => (await monitors.ensureExaMonitors(regDb, { brokerageId: T1, market, plays: ["moving_corridor_radar"], webhookUrl: "https://app.example/api/webhooks/exa" }, d as never))[0])
    const noKey = await ensure({ apiKey: null, create: createFx, seal: (s: string) => `sealed(${s.length})` })
    check("no EXA_API_KEY → registration refused by NAME; Exa never called", noKey.status === "refused" && /EXA_API_KEY/.test(noKey.reason ?? "") && creates.length === 0)
    const noSeal = await ensure({ apiKey: "k", create: createFx, seal: () => { throw new Error("SECRETS_ENCRYPTION_KEY missing") } })
    check("no sealing key → refused BEFORE anything is created on Exa (a monitor we could not verify is never made)", noSeal.status === "refused" && /sealed/.test(noSeal.reason ?? "") && creates.length === 0)
    const made = await ensure({ apiKey: "k", create: createFx, seal: (s: string) => `sealed(${s.length})`, now: NOW })
    const reg = (regDb.tables.provider_monitors as any[])[0]
    check("registration: the monitor is created with the play's search + our webhook URL, the row is written with the SEALED secret only (no plaintext anywhere), play and territory named", made.status === "created" && creates.length === 1 && creates[0].webhookUrl === "https://app.example/api/webhooks/exa" && /Pensacola, FL/.test(creates[0].query) && reg.webhook_secret_ciphertext === "sealed(15)" && !/whsec_new_plain/.test(JSON.stringify(regDb.tables.provider_monitors)) && reg.play_key === "moving_corridor_radar" && reg.market_id === MARKET && reg.secret_env === "EXA_WEBHOOK_SECRET", JSON.stringify(made))
    const again = await ensure({ apiKey: "k", create: (async () => { creates.push("again"); return { ok: false, status: 500, data: null, error: "should not be called" } }) as never, seal: (s: string) => `sealed(${s.length})` })
    check("registration is idempotent per tenant × territory × play (existing; Exa not called again)", again.status === "existing" && again.monitorId === "mon_new" && creates.length === 1)
  }

  section("H. discipline — one exa-js importer; the runner's provider posture; m969's vocabularies equal the code constants")
  {
    const importers = walk("lib").filter((f) => /from\s+["']exa-js["']/.test(code(f)))
    check("exactly ONE file imports exa-js (the one adapter, lib/providers/exa/client.ts)", importers.length === 1 && importers[0] === "lib/providers/exa/client.ts", importers.join())
    const mine = ["lib/providers/exa/hunting.ts", "lib/providers/exa/monitors.ts", "lib/acquisition-plays/contract.ts", "lib/acquisition-plays/moving-corridor.ts", "lib/acquisition-plays/public-request.ts", "lib/acquisition-plays/property-candidates.ts", "lib/acquisition-plays/contact-second-window.ts", "lib/acquisition-plays/negative-evidence.ts", "lib/acquisition-plays/runner.ts"]
    const codeOnly = (p: string) => blankStrings(readFileSync(join(ROOT, p), "utf8"))
    const keyReaders = mine.filter((f) => /\bEXA_API_KEY\b/.test(codeOnly(f)))
    check("no play module calls fetch(); the provider key is read by NAME only where the client is built (hunting.ts) and where a run / monitor is read back (monitors.ts) — strings blanked, so a message naming the key is not a read", mine.every((f) => !/\bfetch\s*\(/.test(code(f))) && keyReaders.join() === "lib/providers/exa/hunting.ts,lib/providers/exa/monitors.ts", keyReaders.join())
    check("POSITIVE CONTROL: the key-name census sees a read in code and ignores one inside a string", /\bEXA_API_KEY\b/.test(blankStrings("const k = env.EXA_API_KEY")) && !/\bEXA_API_KEY\b/.test(blankStrings('const m = "EXA_API_KEY is not configured"')))
    const run = await quiet(() => runner.runEarlyOpportunityPlays(freshDb(), { market, hunt: null, now: NOW, plays: ["moving_corridor_radar", "public_request_assist", "property_candidate_queue"] }))
    check("the runner with no client: every Exa play reports provider_unconfigured, the run says so by NAME, zero cost", run.status === "provider_unconfigured" && run.results.every((r) => r.status === "provider_unconfigured") && /EXA_API_KEY/.test(run.notes.join()) && run.costUsd === 0)
    const sql = readFileSync(join(ROOT, "supabase/migrations/m969-provider-monitors-signed-delta-webhooks.sql"), "utf8")
    const clause = (name: string) => (sql.match(new RegExp(`${name}\\s*CHECK \\(([^)]*)\\)`)) ?? [])[1] ?? ""
    const vals = (c: string) => [...c.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort().join()
    check("m969 play_key CHECK equals PLAY_KEYS (the RULE: derived from the constant, not a hand list)", vals(clause("provider_monitors_play_key_check")) === [...contract.PLAY_KEYS].sort().join(), vals(clause("provider_monitors_play_key_check")))
    check("m969 status CHECK equals PROVIDER_MONITOR_STATUSES; provider CHECK equals EXA_MONITOR_PROVIDERS", vals(clause("provider_monitors_status_check")) === [...monitors.PROVIDER_MONITOR_STATUSES].sort().join() && vals(clause("provider_monitors_provider_check")) === [...monitors.EXA_MONITOR_PROVIDERS].sort().join())
    check("m969's first line is the lane stamp OR the applied stamp (the RULE: files are not the database; the integrator's apply stamps it)", /^-- WRITTEN, NOT APPLIED \(wave 151, lane 151D\)|^-- ── APPLIED LIVE /.test(sql))
  }

  console.log(`\nEARLY OPPORTUNITY PLAYS — RESULT: ${passed} passed, ${failed} failed ${failed === 0 ? "✅ EARLY_OPPORTUNITY_PLAYS_PASS" : "❌ EARLY_OPPORTUNITY_PLAYS_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
