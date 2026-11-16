#!/usr/bin/env tsx
/**
 * scripts/online-hunting-guard.ts (test:online-hunting) — ONLINE HUNTING CORRECTED TO THE OWNER'S WORDS (wave 153, lane 153N;
 * owner rulings B2–B6, directive Part B §4).
 *
 *   A  EXA PERSON INTENT — a grounded public FSBO / selling / military-move statement by its author, with a contact point the
 *      author published → RawData person row (Raw Lead) carrying need_kinds; the military record claims no orders / duty station;
 *      an ungrounded candidate, a stale post and a permit (official-record) page create NO person; a person already held is
 *      HELD before the RawData door (pre-pull dedup), and a refused known-keys read holds everything (fail closed).
 *   B  TRANSPORT SCOPE — the checkpointed Zyte / ZenRows transport accepts ONLY real_estate_need_chatter and fsbo_listing; any
 *      other purpose is refused by name before the checkpoint is read or a request made. Nextdoor runs THROUGH the transport and
 *      is HELD (LICENSE_REQUIRED) without a recorded agreement; with one it is fetched through the transport. Review pages ride
 *      the same checkpoint. No direct Nextdoor transport call remains in the cron or the manual reader.
 *   C  PROVIDER FIRST — a scraped line whose fact a configured data provider supplies is planned as provider_preferred.
 *   D  RECRUIT vs LEAD — a page whose intent winner is "agent" is a recruiting prospect, never a consumer Lead.
 *   E  PERSONA — the PCS journey is a kernel persona tool (military); a prospect (no Contact row) never enters it.
 *   F  NO INVENTED PLAYS — ONLINE_HUNTING_WORKFLOWS replace NEEDLE_PLAYBOOKS; every row carries a real search and evidence fields.
 *
 * Every refusal has a POSITIVE CONTROL (the same input with the one fact changed passes). SIMULATED: no provider call, no key,
 * injected seams (fetcher, robots, store, extractor, known-keys reader). BLIND SPOTS: Exa / Zyte / ZenRows behaviour is the
 * docs' (no live call); the in-memory client models no RLS; Nextdoor page markup is a fixture.
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

const T1 = "11111111-1111-4111-8111-111111111111", MARKET = "33333333-3333-4333-8333-333333333333", AGENT = "44444444-4444-4444-8444-444444444444"
const NOW = new Date("2026-11-16T12:00:00Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()
const market = { id: MARKET, brokerage_id: T1, name: "Pensacola", city: "Pensacola", state: "FL", zip_codes: ["32501", "32502"], counties: ["Escambia"], agent_id: AGENT }
const marketRow = { ...market, is_active: true, enabled_sources: ["exa"], monthly_budget_usd: 100, spend_this_month: 0, max_records_per_run: 100, priority: 1, last_scraped_at: null }
const DB_OPTS = { uuidIds: true, stampCreatedAt: true, unique: { raw_scraped_leads: [["idempotency_key"]] } } as const
const freshDb = (extra: Record<string, unknown[]> = {}) => memSupabase({ raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [], lead_scraping_markets: [marketRow], manager_signals: [], leads: [], contacts: [], ...extra } as never, DB_OPTS as never) as any
const page = (o: Record<string, unknown>) => ({ id: "r-" + String(o.id ?? Math.random()), url: null, title: null, text: null, author: null, publishedDate: null, highlights: null, summary: null, score: 0.8, ...o })
const EMPTY_KNOWN = { sourceRecordIds: new Set<string>(), personKeys: new Set<string>(), propertyKeys: new Set<string>(), priorProviderResults: new Map(), scope: { brokerageId: T1, includesPlatformPool: false } }

async function main() {
  const hunting = await import("../lib/providers/exa/hunting")
  const request = await import("../lib/acquisition-plays/public-request")
  const { ingestRawSourceBatch } = await import("../lib/kernel/scraping")
  const norm = (r: Record<string, unknown>) => hunting.normalizeExaHuntRow(r)
  const run = (db: any, results: unknown[], deps: Record<string, unknown> = {}) =>
    quiet(() => request.runPublicRequestPlay(db, { market, hunt: null, results: results as never, now: NOW }, { ingest: ingestRawSourceBatch as never, loadKnown: async () => EMPTY_KNOWN as never, ...deps } as never))
  const persons = (db: any) => (db.tables.raw_scraped_leads as any[]).filter((x) => x.subject_kind === "person")

  section("A. Exa person intent → grounded Raw Lead (owner rulings B4 / B5)")
  {
    check("the territory's person-intent searches include buying, selling, FSBO and a volunteered military move — each a phrase a person writes", (() => { const k = request.publicRequestSearches(market as never).map((s) => s.key); return ["need:buying", "need:selling", "need:fsbo", "need:military_move", "request:agent_sought"].every((x) => k.includes(x)) })())
    const fsbo = norm(page({ id: "f1", url: "https://www.reddit.com/r/Pensacola/comments/f1/fsbo/", title: "Selling our house", publishedDate: daysAgo(3), text: "We are selling our house by owner in East Hill this spring. Email me at owner.seller@example.com if interested.", highlights: ["We are selling our house by owner in East Hill this spring."] }))
    const db1 = freshDb()
    const r1 = await run(db1, [fsbo])
    const p1 = persons(db1)
    check("a grounded FSBO statement by its author (URL + date + quote + their own published email, a public page) → ONE RawData person row (Raw Lead)", p1.length === 1 && p1[0].email === "owner.seller@example.com" && r1.actions.some((a) => a.kind === "ingest_person"), JSON.stringify({ rows: p1.length, refused: r1.refused }))
    check("…its record carries the need (fsbo_selling), seller intent, the author relationship and the citation", p1[0]?.normalized_preview?.intentType === "seller" && (p1[0]?.evidence?.need_kinds ?? []).includes("fsbo_selling") && /first_person_author/.test(String(p1[0]?.evidence?.author_relationship)) && p1[0]?.evidence?.citation?.url === fsbo.url, JSON.stringify(p1[0]?.evidence))
    check("…and it reaches the EXISTING Raw Lead gate (a person subject may walk to the Lead door)", (await import("../lib/lead-pipeline/canonical-lead-eligibility")).subjectKindLeadProblem("person") === null)

    const mil = norm(page({ id: "m1", url: "https://www.reddit.com/r/navy/comments/m1/pcs/", title: "PCS to Pensacola", publishedDate: daysAgo(2), text: "We PCS to Pensacola in June and are looking to buy a house near the base. Reach me at navy.family@example.com.", highlights: ["We PCS to Pensacola in June and are looking to buy a house near the base."] }))
    const db2 = freshDb()
    await run(db2, [mil])
    const p2 = persons(db2)
    const ev = JSON.stringify(p2[0]?.evidence ?? {})
    check("a volunteered military move on a public page → ONE person row with need military_move (no restriction on who can be found)", p2.length === 1 && (p2[0]?.evidence?.need_kinds ?? []).includes("military_move") && (p2[0]?.normalized_preview?.intentSignals ?? []).includes("military_move"), JSON.stringify(p2.map((p) => p.evidence)))
    const ORDERS_CLAIM = /"(orders|pcs_orders|duty_station|report_date|reporting_date)"\s*:/
    check("…and the record claims NO orders, report date or duty station — only the volunteered words and the boundary note", !ORDERS_CLAIM.test(ev) && /volunteered move only/.test(ev), ev.slice(0, 400))
    check("POSITIVE CONTROL: the orders-claim probe sees a planted claim", ORDERS_CLAIM.test(JSON.stringify({ duty_station: "NAS Pensacola" })))

    const ungrounded = norm(page({ id: "u1", url: null, title: "Selling", publishedDate: daysAgo(2), text: "We are selling our house by owner in Pensacola. Email me at no.url@example.com.", highlights: ["We are selling our house by owner in Pensacola."] }))
    const db3 = freshDb()
    await run(db3, [ungrounded])
    check("ADVERSE · an UNGROUNDED Exa candidate (no openable URL) is refused — NO row at all", (db3.tables.raw_scraped_leads as any[]).length === 0)
    check("POSITIVE CONTROL · the same words on an openable, dated page DID become a person (the FSBO case above)", p1.length === 1)

    const stale = norm(page({ ...fsbo, id: "s1", url: "https://www.reddit.com/r/Pensacola/comments/s1/old/", publishedDate: daysAgo(150) }))
    const db4 = freshDb()
    const r4 = await run(db4, [stale])
    check("ADVERSE · a STALE post (150 days, window 90) is refused — no row, the reason names its age", (db4.tables.raw_scraped_leads as any[]).length === 0 && /days ago/.test(r4.blindSpots.join()), r4.blindSpots.join(" | "))

    const permit = norm(page({ id: "pm1", url: "https://permits.cityofpensacola.gov/permit/2026-1182", title: "Building permit 2026-1182", publishedDate: daysAgo(4), text: "Residential remodel permit issued for 412 E Romana St. Contractor contact: permits.desk@example.com.", highlights: ["Residential remodel permit issued for 412 E Romana St."] }))
    const db5 = freshDb()
    await run(db5, [permit])
    check("ADVERSE · a permit-only (official record) page creates NO person — a permit is a property event", persons(db5).length === 0 && !(db5.tables.raw_scraped_leads as any[]).some((x) => x.email))
    check("POSITIVE CONTROL · an official-record page is classified as such (not a person page) and permits no contact point", hunting.sourceRightsForUrl(permit.url).sourceClass === "official_record" && !hunting.sourceRightsForUrl(permit.url).publishedContactPermitted)

    const known = { ...EMPTY_KNOWN, personKeys: new Set(["email:owner.seller@example.com"]) }
    const db6 = freshDb()
    const r6 = await run(db6, [fsbo], { loadKnown: async () => known })
    check("ADVERSE · a person already held (same published email) is HELD before the RawData door — no second Raw Lead, no paid enrichment downstream", persons(db6).length === 0 && r6.refused.some((x) => /duplicate held before a paid pull \(known_person\)/.test(x.why)), JSON.stringify(r6.refused))
    const db7 = freshDb()
    const r7 = await run(db7, [fsbo], { loadKnown: async () => null })
    check("ADVERSE · a refused known-keys read holds every person this cycle (fail closed), named", persons(db7).length === 0 && r7.refused.some((x) => /could not read what is already held/.test(x.why)))
    check("POSITIVE CONTROL · with nothing held, the same post IS filed (the FSBO case above used an empty known set)", p1.length === 1)

    const nd = norm(page({ id: "n1", url: "https://nextdoor.com/p/n1", title: "Selling", publishedDate: daysAgo(1), text: "We are selling our house by owner in Pensacola. Email me at nd.seller@example.com.", highlights: ["We are selling our house by owner in Pensacola."] }))
    const db8 = freshDb()
    await run(db8, [nd])
    check("ADVERSE · the same statement on Nextdoor is NOT a person (LICENSE_REQUIRED) — kept as an anonymous question, the email never stored", persons(db8).length === 0 && !JSON.stringify(db8.tables.raw_scraped_leads).includes("nd.seller@example.com"))
  }

  section("B. Zyte / ZenRows scope enforced in code (owner rulings B2 / B3)")
  {
    const ck = await import("../lib/providers/scrape-checkpoint")
    const rows = new Map<string, { id: string; state: any }>()
    let loads = 0, fetches = 0
    const store = {
      async load(key: string) { loads++; const r = rows.get(key); return r ? { id: r.id, state: JSON.parse(JSON.stringify(r.state)) } : undefined },
      async save(id: string | null, state: any) { const rid = id ?? `ck-${rows.size + 1}`; rows.set(state.key, { id: rid, state: JSON.parse(JSON.stringify(state)) }); return { ok: true, id: rid, error: null } },
    }
    const html = "<html><body><div class='post'>We are selling our house by owner in Austin</div></body></html>"
    const fetcher = async () => { fetches++; return { ok: true, html, provider: "zenrows" as const, cost: 0.01, costBasis: "estimated" as const, statusCode: 200, vendorStatus: null, headers: {}, notModified: false, error: null } }
    const deps = (extra: Record<string, unknown> = {}) => ({ store, fetcher, robots: async () => ({ status: 200, text: "User-agent: *\nAllow: /" }), spendGate: () => ({ allowed: true, reason: "test" }), configuredProviders: ["zenrows"], now: () => NOW, ...extra }) as any
    const scope = (purpose: string) => ({ brokerageId: T1, marketId: MARKET, purpose: purpose as never, lane: "proof" })

    const bad = await ck.fetchCheckpointedSnapshot({ url: "https://www.example-listings.com/homes-for-sale/austin", scope: scope("property_listing_search") }, deps())
    check("ADVERSE · a non-chatter / non-FSBO purpose (property_listing_search) is REFUSED BY NAME — no checkpoint read, no request", bad.status === "refused_purpose" && /property_listing_search/.test(bad.reason) && /real_estate_need_chatter and fsbo_listing/.test(bad.reason) && loads === 0 && fetches === 0, JSON.stringify({ s: bad.status, loads, fetches }))
    const bad2 = await ck.fetchCheckpointedSnapshot({ url: "https://www.example-listings.com/x", scope: scope("zillow_behavior") }, deps())
    check("ADVERSE · a free-text lane name is not a purpose either (the old 'zillow_behavior' label) — refused", bad2.status === "refused_purpose" && fetches === 0)
    const good = await ck.fetchCheckpointedSnapshot({ url: "https://www.example-fsbo-board.com/austin", scope: scope("fsbo_listing") }, deps())
    const good2 = await ck.fetchCheckpointedSnapshot({ url: "https://www.example-chatter-board.com/austin", scope: scope("real_estate_need_chatter") }, deps())
    check("POSITIVE CONTROL · the SAME call with fsbo_listing / real_estate_need_chatter fetches through the transport", good.status === "fetched_changed" && good2.status === "fetched_changed" && fetches === 2, JSON.stringify({ a: good.status, b: good2.status, fetches }))
    check("the purpose vocabulary is exactly the owner's two", JSON.stringify(ck.SCRAPE_PURPOSES) === JSON.stringify(["real_estate_need_chatter", "fsbo_listing"]) && ck.scrapePurposeProblem("fsbo_listing") === null && !!ck.scrapePurposeProblem("enrichment"))

    // Nextdoor THROUGH the transport, behind its named hold.
    const ss = await import("../lib/lead-pipeline/social-sourcer")
    const ndc = await import("../lib/lead-pipeline/nextdoor-chatter")
    const { resolveSourceKeywords } = await import("../lib/lead-pipeline/scrape-keywords")
    const resolved = resolveSourceKeywords("nextdoor_intent", { city: "Austin", state: "TX", brokerage_id: T1 } as never, [] as never)
    const NDURL = "https://nextdoor.com/search/?query=moving"
    const normalize = (p: Record<string, any>) => ss.normalizeNextdoorPost(p, { city: "Austin", state: "TX" }, resolved, NDURL)
    let extracts = 0
    const extract = (async () => { extracts++; return { posts: [{ post_id: "p1", author_name: "Sam Rivera", content: "We are relocating to Austin and need a realtor" }], extraction: "llm_schema", extractionError: null, error: null } }) as never
    const cpt = { ledgerClient: { from: () => ({}) }, scope: { brokerageId: T1, marketId: MARKET }, spendGate: () => ({ allowed: true, reason: "test" }) }
    const before = fetches
    const held = await ndc.sourceNextdoorChatter(NDURL, cpt, { normalize, extract, snapshotDeps: deps() })
    check("ADVERSE · Nextdoor WITHOUT a recorded agreement is HELD on terms — LICENSE_REQUIRED named, no request, nothing extracted", /held_terms/.test(String(held.held)) && /LICENSE_REQUIRED/.test(String(held.held)) && fetches === before && extracts === 0 && held.records.length === 0, JSON.stringify(held.held))
    const agreed = await ndc.sourceNextdoorChatter(NDURL, cpt, { normalize, extract, snapshotDeps: deps({ agreements: { "nextdoor.com": { reference: "PROOF-ONLY", recordedAt: "2026-11-16", scope: "test" } } }) })
    check("POSITIVE CONTROL · WITH a recorded agreement the same call goes THROUGH the transport (one request, purpose chatter) and yields the matched post as a record", agreed.held === null && fetches === before + 1 && extracts === 1 && agreed.records.length === 1 && agreed.records[0].source === "nextdoor", JSON.stringify({ held: agreed.held, n: agreed.records.length }))
    const ledgerRow = [...rows.values()].find((r) => /nextdoor\.com/.test(String(r.state?.targetUrl)))
    check("…and the checkpoint row is the Nextdoor target's (one checkpoint per target)", !!ledgerRow)

    // Review pages ride the same checkpoint.
    const rv = await import("../lib/lead-pipeline/review-acquisition-sourcer")
    const none = await rv.sourceReviewAcquisitionIntent({ city: "Austin", state: "TX" }, ["https://www.example-reviews.com/agent/1"])
    check("ADVERSE · review pages with NO checkpoint supplied fetch nothing (named)", none.urlsScanned === 0 && (none.held ?? []).length === 1)
    const f0 = fetches
    const zr = await quiet(() => rv.sourceReviewAcquisitionIntent({ city: "Austin", state: "TX" }, ["https://www.zillow.com/profile/agent-1/"], cpt as never, { snapshotDeps: deps() }))
    check("ADVERSE · a terms-restricted review host (zillow) is HELD by the checkpoint — no request", fetches === f0 && (zr.held ?? []).some((h) => /held_terms/.test(h)), JSON.stringify(zr.held))
    const ok = await quiet(() => rv.sourceReviewAcquisitionIntent({ city: "Austin", state: "TX" }, ["https://www.example-reviews.com/agent/1"], cpt as never, { snapshotDeps: deps() }))
    check("POSITIVE CONTROL · an unrestricted review page IS fetched through the checkpoint (one request)", fetches === f0 + 1 && (ok.held ?? []).length === 0)

    // Static: no direct Nextdoor transport call remains.
    const cron = code("app/api/cron/lead-scraping/route.ts"), li = code("app/actions/lead-intelligence.ts"), zen = code("lib/external/zenrows-client.ts")
    const DIRECT = /\bscrapeNextdoor\s*\(|\bscrapePage\s*\(/
    const helper = li.slice(li.indexOf("async function fetchNextdoorPageThroughCheckpoint"), li.indexOf("async function fetchNextdoorPageThroughCheckpoint") + 1400)
    check("the cron and the manual reader call NO direct Nextdoor transport (scrapeNextdoor / scrapePage) — the cron uses sourceNextdoorChatter, the manual reader's two paths the checkpoint (purpose chatter)",
      !DIRECT.test(cron) && !DIRECT.test(li) && /sourceNextdoorChatter\(/.test(cron) && (li.match(/await fetchNextdoorPageThroughCheckpoint\(/g) ?? []).length === 2 && /fetchCheckpointedSnapshot\(/.test(helper) && /purpose: "real_estate_need_chatter"/.test(helper) && !/export\s+async\s+function\s+fetchNextdoorPageThroughCheckpoint/.test(li))
    check("POSITIVE CONTROL · the direct-call probe matches a planted call", DIRECT.test("await zenrows.scrapeNextdoor(url)") && DIRECT.test("await scrapePage(key, url, {})"))
    check("ZenrowsClient.scrapeNextdoor is retired (tombstone names the survivor) and the extractor survives", !/async scrapeNextdoor\(/.test(zen) && /export async function extractNextdoorPostsFromHtml/.test(zen) && /sourceNextdoorChatter/.test(readFileSync(join(ROOT, "lib/external/zenrows-client.ts"), "utf8")))
    check("every checkpointed caller declares one of the two purposes (no free-text purpose left)", !/purpose:\s*`/.test(code("lib/lead-pipeline/social-sourcer.ts")) && /purpose: "fsbo_listing"/.test(cron) && !/purpose: "zillow_behavior"/.test(cron) && /purpose: "real_estate_need_chatter"/.test(code("lib/lead-pipeline/nextdoor-chatter.ts")))
    check("the Nextdoor module stays LIGHT — no static first-party import beyond a type (the manual reader is in page graphs)", code("lib/lead-pipeline/nextdoor-chatter.ts").split("\n").filter((l) => /^\s*import\s/.test(l)).every((l) => /^\s*import\s+type\s/.test(l)))
  }

  section("C. provider first (owner ruling B3: a data provider is the safer bet)")
  {
    const planner = await import("../lib/lead-pipeline/source-discovery-planner")
    const base = { territory: { id: MARKET, brokerageId: T1, label: "Pensacola" }, budgetUsd: 100, enabledSources: ["rental_listing", "craigslist_fsbo"] as never, history: { rental_listing: { rawRows: 40, promoted: 4, duplicates: 0, costUsd: 4 } } as never, previews: {}, quotes: { rental_listing: { unitUsd: 0.1, basis: "history" } } as never, now: NOW }
    const withRc = planner.planSourceDiscovery({ ...base, configuredProviders: ["rentcast"] })
    const line = withRc.lines.find((l) => l.source === "rental_listing")
    check("a scraped rental-listing line is planned as provider_preferred when RentCast holds a key (its /listings/rental/long-term carries the fact)", line?.status === "provider_preferred" && /rentcast/.test(String(line?.why)) && /listings\/rental\/long-term/.test(String(line?.why)), JSON.stringify(line?.status))
    const noRc = planner.planSourceDiscovery({ ...base, configuredProviders: [] })
    check("POSITIVE CONTROL · with no provider configured the same line is NOT superseded", noRc.lines.find((l) => l.source === "rental_listing")?.status !== "provider_preferred")
    check("a line with no provider equivalent (FSBO) is never superseded", withRc.lines.find((l) => l.source === "craigslist_fsbo")?.status !== "provider_preferred" && planner.providerFirstVerdict("craigslist_fsbo" as never, ["rentcast", "batchdata"]) === null)
  }

  section("D. an agent-written page is a RECRUITING prospect, never a consumer Lead (lane 153I request)")
  {
    const cle = await import("../lib/lead-pipeline/canonical-lead-eligibility")
    const who = { first_name: "Jamie", last_name: "Ortega", email: "jamie.ortega@example.com", phone: null, subject_kind: "person" }
    const agent = cle.evaluateCanonicalLeadEligibility({ ...who, intent_winner: "agent" })
    check("ADVERSE · intent winner 'agent' → not eligible (subject), named a recruiting prospect", !agent.eligible && agent.failing === "subject" && /RECRUITING prospect/.test(agent.reason))
    check("POSITIVE CONTROL · the same person with intent winner 'buyer' IS eligible", cle.evaluateCanonicalLeadEligibility({ ...who, intent_winner: "buyer" }).eligible)
    const pp = code("lib/lead-pipeline/pipeline-processor.ts"), ec = code("lib/lead-promotion/eligibility-core.ts")
    check("both promotion doors pass the stamped winner (pipeline-processor + eligibility-core)", /intent_winner:\s*\(rec\.normalized_preview as any\)\?\.intent\?\.winner/.test(pp) && /intent_winner:\s*rawRecord\.normalized_preview\?\.intent\?\.winner/.test(ec))
  }

  section("E. the PCS journey is a kernel persona tool; a prospect never enters a Contact persona flow (owner ruling B6)")
  {
    const kt = await import("../lib/kernel/types")
    const { planPcsMoveForPortalContact } = await import("../lib/relocation/pcs-portal-door")
    check("the kernel persona map carries pcs_move_plan for the stored persona 'military' only", kt.personaJourneyTools("military").includes("pcs_move_plan") && kt.personaJourneyTools("relocated").length === 0 && kt.personaJourneyTools(null).length === 0)
    const RAW = "88888888-8888-4888-8888-888888888888"
    const db = memSupabase({ contacts: [], raw_scraped_leads: [{ id: RAW, brokerage_id: T1, subject_kind: "person", email: "navy.family@example.com" }] } as never)
    const writes: unknown[] = []
    const prospect = await planPcsMoveForPortalContact(db as never, { brokerageId: T1, contactId: RAW, userId: "u", isContactSelf: true }, { consentGiven: true, destinationLabel: "Pensacola", destinationState: "FL", reportDate: "2027-01-10" }, { now: NOW, recordStatedDate: (async (_s: unknown, a: unknown) => { writes.push(a); return { status: "reassessed", reason: "x" } }) as never })
    check("ADVERSE · a NEW PROSPECT (a Raw Lead id, no Contact row) cannot run the PCS persona flow — refused, nothing written", !prospect.ok && prospect.code === "read_refused" && writes.length === 0)
    const C = "55555555-5555-4555-8555-555555555555"
    const db2 = memSupabase({ contacts: [{ id: C, brokerage_id: T1, agent_id: null, contact_persona: "military" }], agent_licenses: [] } as never)
    const contact = await planPcsMoveForPortalContact(db2 as never, { brokerageId: T1, contactId: C, userId: "u", isContactSelf: true }, { consentGiven: true, destinationLabel: "Pensacola", destinationState: "FL", reportDate: "2027-01-10" }, { now: NOW, recordStatedDate: (async (_s: unknown, a: unknown) => { writes.push(a); return { status: "reassessed", reason: "x" } }) as never })
    check("POSITIVE CONTROL · a military Contact IS planned (one stated-date write)", contact.ok && writes.length === 1)
    const pr = code("lib/acquisition-plays/public-request.ts")
    check("the acquisition door never reaches the persona flow (public-request imports no relocation / portal module)", !/relocation\/|portal\//.test(pr.split("\n").filter((l) => /\bimport\b/.test(l)).join("\n")))
  }

  section("F. no invented plays — every online hunting workflow is a real search")
  {
    const cm = await import("../lib/providers/provider-capability-matrix")
    const W = cm.ONLINE_HUNTING_WORKFLOWS as ReadonlyArray<Record<string, any>>
    check("NEEDLE_PLAYBOOKS is retired and ONLINE_HUNTING_WORKFLOWS carries a query, evidence fields, freshness, rights and cost on every row", !("NEEDLE_PLAYBOOKS" in cm) && W.length >= 5 && W.every((w) => ["query", "evidenceFields", "freshness", "rights", "cost", "neverClaims"].every((f) => String(w[f] ?? "").trim().length > 0)))
    check("no workflow claims a PCS-orders data source (the military row says it claims none)", W.every((w) => !/orders (database|data feed|list)/i.test(`${w.query} ${w.output}`)) && /never claims orders/.test(String(W.find((w) => w.key === "exa_volunteered_military_move")?.neverClaims)))
    check("POSITIVE CONTROL · the orders-source probe matches a planted claim", /orders (database|data feed|list)/i.test("a PCS orders database"))
  }

  console.log(`\nONLINE HUNTING — RESULT: ${passed} passed, ${failed} failed ${failed === 0 ? "✅ ONLINE_HUNTING_PASS" : "❌ ONLINE_HUNTING_FAIL"}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
