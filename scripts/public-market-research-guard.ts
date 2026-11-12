#!/usr/bin/env tsx
/**
 * scripts/public-market-research-guard.ts (test:public-market-research) — EXA PUBLIC-MARKET RESEARCH, NEVER PEOPLE (wave 150,
 * lane 150KLMO; directive 150L, owner ruling R9, contract C35, canary 8).
 *
 * SCOPE NOTE (wave 151, lane 151D — owner correction 2026-11-09, verbatim: "exa is to find people when it is a scraper or
 * hunting"): R9 is reversed in SCOPE, not here. lib/lead-pipeline/exa-sourcer.ts STAYS the cited public-MARKET research lane
 * these checks hold (no first-person query, no author on a row). Person / entity DISCOVERY lives in lib/providers/exa/hunting.ts
 * and lib/acquisition-plays/** under their own gates (first-person request + a contact point the author published + a page class
 * whose terms permit it + freshness; property ↔ owner only through verifyOwnership) — test:early-opportunity-plays.
 *
 *   A  QUERIES: every population the acquisition registry declares for the Exa lane asks a MARKET question (inventory, prices,
 *      rents, costs, employer / WARN / base / campus / infrastructure / zoning events, the questions people ask) — never a
 *      first-person "I am looking to buy / sell" hunt; each query states its C35 evidence subject.
 *   B  NORMALIZER: an Exa page → a CITED evidence record; the author, a name, an email or a phone on the page never ride it;
 *      only a short excerpt is kept (no reuse license assumed); rights + TTL come from the C35 producer.
 *   C  ONE PRODUCER (C35): the real lib/kernel/scraping.ts ingestRawSourceBatch writes the record as subject_kind
 *      market / job_civic_event / anonymous_question with source_rights public_web, its proof URL and its TTL — and the
 *      Lead door refuses every such kind (canary 8: an anonymous question never creates a person).
 *   D  CONSUMER: the topic pass reads those rows (tenant territories, inside their TTL) as CITED themes; expired, uncited,
 *      steering and non-evidence rows are dropped and counted; no theme carries an author.
 *
 * BLIND SPOTS (published): no live Exa call (the client is fail-closed without EXA_API_KEY and a proof never spends); a page's
 * claim is the page's, not verified market data (the theme says so); title text is kept verbatim as the citation and is not
 * scanned for personal names; the cron's per-territory Exa spend is not behind the acquisition-plan approval gate (lane 150EFG
 * Still open).
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

const T1 = "11111111-1111-4111-8111-111111111111", T2 = "22222222-2222-4222-8222-222222222222"
const MARKET = "33333333-3333-4333-8333-333333333333", MARKET2 = "44444444-4444-4444-8444-444444444444"
const EVIDENCE = new Set(["market", "job_civic_event", "anonymous_question"])
/** The identity probe — the planted author / name / email / phone. */
const PERSON_RE = /Jane Q\. Doe|jane\.doe@example\.org|850-555-0142|janeq_pcola/

async function main() {
  const exa = await import("../lib/lead-pipeline/exa-sourcer")
  const rt = await import("../lib/lead-pipeline/raw-record-types")
  const cle = await import("../lib/lead-pipeline/canonical-lead-eligibility")
  const sim = await import("../lib/lead-pipeline/source-intent-map")
  const { SOURCE_ACQUISITION } = await import("../lib/lead-pipeline/acquisition-coverage")
  const market = { id: MARKET, city: "Pensacola", state: "FL" } as never

  section("A. queries — market questions, never a person hunt")
  const qs = exa.buildExaIntentQueries(market)
  const pops = new Set(qs.map((q) => q.population))
  check("every population the registry declares for the Exa lane has its queries", SOURCE_ACQUISITION.exa_buyer_intent.intents.every((p: string) => pops.has(p as never)), JSON.stringify([...pops]))
  check("every query states a C35 EVIDENCE subject (market / job_civic_event / anonymous_question)", qs.length > 0 && qs.every((q) => EVIDENCE.has(q.subject)), JSON.stringify(qs.map((q) => q.subject)))
  check("the territory is rendered into every query", qs.every((q) => q.query.includes("Pensacola, FL")))
  const FIRST_PERSON = /\b(I|I'm|my|me)\b|looking for a realtor|looking to buy a house|selling my (home|house)/i
  check("no query is a first-person person-hunt", !qs.some((q) => FIRST_PERSON.test(q.query)), JSON.stringify(qs.filter((q) => FIRST_PERSON.test(q.query))))
  check("POSITIVE CONTROL: the person-hunt probe flags the pre-150 template", FIRST_PERSON.test("thinking of selling my house in Pensacola, FL, what is my home worth"))
  const themesCovered = ["employer", "WARN", "base", "campus", "infrastructure", "rezoning", "inventory", "rents", "tax", "insurance", "questions"]
  check("the directive's research subjects are asked (employer, WARN, base/campus/infrastructure, zoning, inventory, rents, cost shifts, questions)", themesCovered.every((w) => qs.some((q) => q.query.toLowerCase().includes(w.toLowerCase()))), themesCovered.filter((w) => !qs.some((q) => q.query.toLowerCase().includes(w.toLowerCase()))).join(","))

  section("B. normalizer — a cited evidence record, no identity")
  const page = {
    id: "exa-abc123", url: "https://www.pnj.com/story/money/2026/10/30/navy-expansion-pensacola/", title: "Navy base expansion brings 1,200 jobs to Pensacola",
    author: "Jane Q. Doe", publishedDate: "2026-10-30T00:00:00Z",
    text: "Posted by janeq_pcola. Contact jane.doe@example.org or 850-555-0142. The Navy announced an expansion that brings 1,200 jobs to the area. " + "x".repeat(2000),
    highlights: ["The Navy announced an expansion that brings 1,200 jobs to the area; housing demand near the base is expected to rise. " + "y".repeat(600)],
  }
  check("POSITIVE CONTROL: the identity probe sees the planted author / email / phone in the raw page", PERSON_RE.test(JSON.stringify(page)))
  const rec = exa.normalizeExaResult(page as never, market, "job_civic_event")
  const recJson = JSON.stringify(rec)
  check("no author, name, handle, email or phone rides the record", !PERSON_RE.test(recJson) && !rec.username && !rec.email && !rec.phone && !rec.firstName && !rec.lastName && !rec.fullName, recJson.slice(0, 300))
  check("the subject kind is stated on the envelope (job_civic_event) with the vendor's event id and the proof URL", rec.envelope?.subjectKind === "job_civic_event" && rec.envelope?.externalEventId === "exa:exa-abc123" && (rec.envelope?.proofUrls ?? []).includes(page.url))
  const cit = (rec.envelope?.evidence as any)?.citation
  check("the citation carries url, title, publisher, published and retrieved_at", cit?.url === page.url && cit?.title === page.title && cit?.publisher === "pnj.com" && cit?.published === page.publishedDate && typeof cit?.retrieved_at === "string", JSON.stringify(cit))
  check("only a short excerpt is kept (≤ 280 chars; the page itself is not)", typeof (rec.rawPayload as any)?.excerpt === "string" && (rec.rawPayload as any).excerpt.length <= 280 && !("text" in (rec.rawPayload as any)))
  check("the record is a market-research observation, never a search-signal person row", rec.behaviorType === "market_research" && rec.intentSignals?.includes("job_civic_event") && rec.intentSignals?.includes("public_market_research"))
  check("the normalizer never reads result.author (stripped source)", !/result\.author/.test(code("lib/lead-pipeline/exa-sourcer.ts")))
  check("viable: an evidence kind with an openable URL enters the producer", rt.isViableRecord(rec))
  check("not viable: the same evidence record with no URL", !rt.isViableRecord({ ...rec, sourceUrl: null, envelope: { ...rec.envelope, proofUrls: [] } } as never))
  check("POSITIVE CONTROL: a stated PERSON kind with no identity is still refused (the evidence branch never widens person viability)", !rt.isViableRecord({ ...rec, envelope: { ...rec.envelope, subjectKind: "person" } } as never))
  check("rights come from the vendor contract (Exa → public_web)", sim.sourceRightsFor("exa_buyer_intent").rights === "public_web")

  section("C. one producer — evidence subject kinds, rights, TTL; the Lead door refuses them (canary 8)")
  const { ingestRawSourceBatch } = await import("../lib/kernel/scraping")
  const db = memSupabase({ raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [], lead_scraping_markets: [] }, { unique: { raw_scraped_leads: [["idempotency_key"]] } })
  const question = exa.normalizeExaResult({ ...page, id: "exa-q1", url: "https://www.reddit.com/r/Pensacola/comments/q1/", title: "What are closing costs like in Pensacola?", author: "janeq_pcola" } as never, market, "anonymous_question")
  const mkt = exa.normalizeExaResult({ ...page, id: "exa-m1", url: "https://example-news.com/pensacola-rents-2026", title: "Pensacola rents rise 4% as inventory tightens" } as never, market, "market")
  const r = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "exa_buyer_intent", sourceFamily: "social_intent", sourceChannel: "exa", records: [rec, question, mkt], executionId: "exec-1", marketGeo: { city: "Pensacola", state: "FL", zip_codes: [] }, client: db as never })
  const rows = (db as any).tables.raw_scraped_leads as any[]
  check("three cited pages → three raw observations through THE ONE producer", r.inserted === 3 && rows.length === 3, JSON.stringify({ r, n: rows.length }))
  check("each row's subject_kind is an EVIDENCE kind — never person / owner / household", rows.every((x) => EVIDENCE.has(x.subject_kind)), JSON.stringify(rows.map((x) => x.subject_kind)))
  check("the anonymous question is written as anonymous_question", rows.some((x) => x.subject_kind === "anonymous_question" && /reddit\.com/.test(String(x.proof_urls))))
  check("source_rights public_web, a proof URL and a TTL by kind (market 30 / question 90 / civic 180 days)", rows.every((x) => x.source_rights === "public_web" && Array.isArray(x.proof_urls) && x.proof_urls.length > 0 && !!x.ttl_expires_at) && (() => {
    const days = (k: string) => { const x = rows.find((y) => y.subject_kind === k); return x ? Math.round((Date.parse(x.ttl_expires_at) - Date.parse(x.signal_at ?? x.observed_at)) / 86_400_000) : -1 }
    return days("market") === 30 && days("anonymous_question") === 90 && days("job_civic_event") === 180
  })(), JSON.stringify(rows.map((x) => [x.subject_kind, x.signal_at, x.ttl_expires_at])))
  check("no row carries a name, email, phone or handle", !PERSON_RE.test(JSON.stringify(rows)) && rows.every((x) => !x.first_name && !x.last_name && !x.email && !x.phone))
  const replay = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "exa_buyer_intent", sourceFamily: "social_intent", sourceChannel: "exa", records: [question], executionId: "exec-2", marketGeo: { city: "Pensacola", state: "FL", zip_codes: [] }, client: db as never })
  check("a replayed page is ONE observation (the vendor event id anchors the key)", replay.inserted === 0 && replay.replayed === 1 && rows.length === 3, JSON.stringify(replay))
  check("the Lead door refuses every evidence kind (canary 8: an anonymous question never creates a person)", [...EVIDENCE].every((k) => cle.subjectKindLeadProblem(k) !== null))
  check("POSITIVE CONTROL: the Lead door admits a person kind", cle.subjectKindLeadProblem("person") === null)
  check("processRawRecord applies the subject gate BEFORE any paid lookup (stripped source)", (() => {
    const p = code("lib/lead-pipeline/pipeline-processor.ts")
    const fn = p.indexOf("export async function processRawRecord"), gate = p.indexOf("subjectKindLeadProblem(subjectKind)", fn), paid = p.indexOf("await enrichWithPeopleData(", fn)
    return fn >= 0 && gate > fn && paid > gate && /if \(subjectProblem\)[\s\S]{0,900}return \{ success: false/.test(p.slice(gate, paid))
  })())

  section("D. consumer — cited themes for the topic pass (C35: writer + consumer)")
  const { publicResearchThemes } = await import("../lib/content-intel/topic-themes")
  const NOW = new Date("2026-11-06T12:00:00Z")
  const row = (o: Record<string, unknown>) => ({ subject_kind: "market", source_record_id: "exa-x", proof_urls: ["https://example-news.com/a"], ttl_expires_at: "2026-12-01T00:00:00Z", observed_at: "2026-11-01T00:00:00Z", city: "Pensacola", state: "FL", raw_data: { title: "Pensacola housing inventory climbs", excerpt: "inventory rose", publisher: "example-news.com", published: "2026-10-31", url: "https://example-news.com/a", author: "Jane Q. Doe" }, ...o })
  const out = publicResearchThemes([
    row({}),
    row({ subject_kind: "job_civic_event", proof_urls: ["https://www.pnj.com/navy"], raw_data: { title: "Navy announces 1,200 new jobs", publisher: "pnj.com", url: "https://www.pnj.com/navy" } }),
    row({ subject_kind: "person" }),
    row({ ttl_expires_at: "2026-10-01T00:00:00Z" }),
    row({ proof_urls: [], raw_data: { title: "Pensacola housing inventory climbs" } }),
    row({ raw_data: { title: "Pensacola crime rates and the safest neighborhoods", url: "https://example.com/c" }, proof_urls: ["https://example.com/c"] }),
  ] as never, NOW)
  check("a market page and a civic event become cited themes (the civic event under the local-economy label)", out.themes.length === 2 && out.themes.some((t) => /what the local market is doing/i.test(t.title)) && out.themes.some((t) => /Local jobs and projects/.test(t.title)), JSON.stringify(out.themes.map((t) => t.title)))
  check("every theme cites its source URL and says a page's claim is the page's", out.themes.every((t) => /^https:\/\//.test(t.sourceUrl ?? "") && /not verified market data/.test(t.evidence.confidence_basis) && t.evidence.source_class === "public_market_research"))
  check("dropped and counted: a person row, an expired observation, an uncited page, a steering topic", out.dropped.not_an_evidence_subject === 1 && out.dropped.expired_observation === 1 && out.dropped.no_citation === 1 && out.dropped.steering_topic === 1, JSON.stringify(out.dropped))
  check("no theme carries the page author", !PERSON_RE.test(JSON.stringify(out.themes)))
  const ti = code("lib/content-intel/topic-intelligence.ts")
  check("the topic pass reads raw_scraped_leads by the tenant's OWN territories, evidence kinds only, inside their TTL (stripped source)", /from\("lead_scraping_markets"\)\.select\("id"\)\.eq\("brokerage_id", brokerageId\)/.test(ti) && /\.in\("subject_kind", \["market", "job_civic_event", "anonymous_question"\]\)/.test(ti) && /\.gte\("ttl_expires_at"/.test(ti) && /publicResearchThemes\(/.test(ti))
  check("POSITIVE CONTROL: the territory pin regex fails on a mutant without the tenant filter", !/from\("lead_scraping_markets"\)\.select\("id"\)\.eq\("brokerage_id", brokerageId\)/.test(ti.replace('.eq("brokerage_id", brokerageId).limit(200)', ".limit(200)")))
  void T2; void MARKET2

  console.log(`\nPUBLIC MARKET RESEARCH — ${passed} passed, ${failed} failed ${failed === 0 ? "✅ PUBLIC_MARKET_RESEARCH_PASS" : "❌ PUBLIC_MARKET_RESEARCH_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
