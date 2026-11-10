/**
 * scripts/rawdata-ingress-guard.ts — C35 THE ONE RAWDATA PRODUCER CONTRACT (wave 150, lane 150EFG; directive 150F).
 *
 *   A  the envelope: subject kind, scope-qualified idempotency key, rights + license, timestamps, TTL, external ids,
 *      proof URLs, actor/version, cost, evidence — built for every record; refusals for unknown rights and for a
 *      consented first-party submission (that is a Contact, C8 captureContact — never a raw row);
 *   B  canary 3 on the REAL producer (lib/kernel/scraping.ts ingestRawSourceBatch on the in-memory database with the m961
 *      UNIQUE modelled): ten replays of one observation → ONE row (9 counted as replays), even when the sourcer minted a
 *      clock/random source id; ten DISTINCT events stay ten (the key does not over-collapse); a second tenant observing
 *      the same property gets its OWN row (lawful per-tenant research, no shared person row);
 *   C  schema lag: m961 absent → the row is still written, the envelope rides normalized_preview.rawdata, COUNTED;
 *   D  canary 4: an anonymous market observation never reaches the Lead door (the subject rule at every promotion door
 *      and BEFORE the paid enrichment in processRawRecord); a person with a complete identity still does;
 *   E  censuses on STRIPPED source: one raw_scraped_leads writer; no clock/random source ids in the sourcers; the
 *      first-party consented doors still go through captureContact, never the raw producer.
 *
 * Positive controls: each census runs its finder on a planted specimen; the replay canary's negative half (distinct
 * events) proves the key is not a constant; the old global-key behaviour is shown blocking a second tenant.
 *
 * BLIND SPOTS (published): the live UNIQUE (source, source_record_id) is global until the owner drops it (m961 footer) —
 * modelled here; pre-m961 rows carry no subject_kind and are judged on identity alone; the provider-side preview / quote
 * adapters are not exercised; rights are derived from the vendor contract, not from a reviewed license (WAITING_EXTERNAL).
 */
import { readFileSync, readdirSync, statSync, existsSync } from "fs"
import { join } from "path"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"
import { memSupabase } from "./in-memory-supabase"

const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not installed — nothing to stub */ }

const ROOT = process.cwd()
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const stripped = (p: string) => stripComments(read(p))

function walk(dir: string, out: string[] = []): string[] {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return out
  for (const f of readdirSync(abs)) {
    if (f === "node_modules" || f.startsWith(".")) continue
    const rel = join(dir, f)
    const st = statSync(join(ROOT, rel))
    if (st.isDirectory()) walk(rel, out)
    else if (/\.(ts|tsx)$/.test(f)) out.push(rel)
  }
  return out
}

async function main() {
  const rt = await import("../lib/lead-pipeline/raw-record-types")
  const sim = await import("../lib/lead-pipeline/source-intent-map")
  const cle = await import("../lib/lead-pipeline/canonical-lead-eligibility")
  const ident = await import("../lib/identity/subject-identity")
  const { ingestRawSourceBatch } = await import("../lib/kernel/scraping")

  const T1 = "11111111-1111-4111-8111-111111111111"
  const T2 = "22222222-2222-4222-8222-222222222222"
  const MARKET = "33333333-3333-4333-8333-333333333333"
  const geo = { city: "Pensacola", state: "FL", zip_codes: ["32501"] }
  const base = (over: Record<string, unknown> = {}) => ({
    sourceRecordId: `reddit-${Date.now()}-${Math.random()}`, // the pre-150 fallback shape: a replay mints a NEW id
    source: "reddit_relocation", behaviorType: "social_intent", intentType: "buyer" as const, intentSignals: ["moving to"],
    firstName: "Dana", lastName: "Whitfield", email: "dana.whitfield@example.org", city: "Pensacola", state: "FL", zip: "32501",
    sourceUrl: "https://www.reddit.com/r/Pensacola/comments/abc", rawPayload: { title: "Moving to Pensacola", text: "Looking for a neighbourhood near the base", created_utc: Math.floor(Date.now() / 1000) - 3600 },
    ...over,
  }) as any

  console.log("\n[A] the envelope")
  const entityKindOf = (n: string) => ident.ownerNameKind(n)
  const env = rt.buildRawDataEnvelope(base(), { brokerageId: T1, rights: sim.sourceRightsFor("reddit_relocation"), entityKindOf, actorType: "cron", costUsd: 0.004 })
  check("subject kind derived (person)", env.subject_kind === "person", env.subject_kind)
  check("idempotency key is tenant-scoped", env.idempotency_key.startsWith(`t:${T1}|reddit_relocation|`), env.idempotency_key)
  check("a clock/random source id is NOT trusted — the key falls back to a content digest", env.idempotency_basis === "content_digest", env.idempotency_basis)
  check("rights + license derived from the vendor contract", env.source_rights === "public_web" && !!env.source_licence, `${env.source_rights}/${env.source_licence}`)
  check("signal_at read from the payload's own date; observed_at stamped; ttl after both", !!env.signal_at && !!env.observed_at && Date.parse(env.ttl_expires_at) > Date.parse(env.observed_at))
  check("proof URL carried", env.proof_urls.includes("https://www.reddit.com/r/Pensacola/comments/abc"))
  check("actor / version / cost / evidence carried", env.producer_actor_type === "cron" && env.producer_version === "rawdata-c35@1" && env.cost_usd === 0.004 && Array.isArray((env.evidence as any).intent_signals))
  const env2 = rt.buildRawDataEnvelope(base(), { brokerageId: T1, rights: sim.sourceRightsFor("reddit_relocation"), entityKindOf, actorType: "cron", costUsd: null })
  check("a replay (new clock id, same content) → the SAME key", env2.idempotency_key === env.idempotency_key)
  const envT2 = rt.buildRawDataEnvelope(base(), { brokerageId: T2, rights: sim.sourceRightsFor("reddit_relocation"), entityKindOf, actorType: "cron", costUsd: null })
  check("another tenant → a DIFFERENT key (no shared observation row)", envT2.idempotency_key !== env.idempotency_key)
  const evt = rt.buildRawDataEnvelope(base({ envelope: { externalEventId: "evt-42" } }), { brokerageId: null, rights: sim.sourceRightsFor("batchdata_smart_search"), entityKindOf, actorType: "webhook", costUsd: null })
  check("a vendor event id anchors the key (platform scope)", evt.idempotency_key === "p|reddit_relocation|evt:evt-42" && evt.idempotency_basis === "external_event_id", evt.idempotency_key)
  const stable = rt.buildRawDataEnvelope(base({ sourceRecordId: "reddit-t3_abc" }), { brokerageId: T1, rights: sim.sourceRightsFor("reddit"), entityKindOf, actorType: "cron", costUsd: null })
  check("a stable source id anchors the key", stable.idempotency_basis === "source_record_id" && stable.external_ids.source_record_id === "reddit-t3_abc")
  const market = rt.buildRawDataEnvelope(base({ firstName: null, lastName: null, email: null, envelope: { subjectKind: "market" } }), { brokerageId: T1, rights: sim.sourceRightsFor("exa"), entityKindOf, actorType: "research", costUsd: null })
  check("a stated subject kind wins (market) and takes its own TTL", market.subject_kind === "market" && Date.parse(market.ttl_expires_at) - Date.parse(market.signal_at ?? market.observed_at) === 30 * 86_400_000)
  const llc = rt.buildRawDataEnvelope(base({ firstName: "Oak Holdings", lastName: "LLC", email: null, propertyAddress: "12 Palafox St" }), { brokerageId: T1, rights: sim.sourceRightsFor("batchdata"), entityKindOf, actorType: "cron", costUsd: null })
  check("an LLC owner is an entity, not a person", llc.subject_kind === "entity_trust_estate", llc.subject_kind)
  const prop = rt.buildRawDataEnvelope(base({ firstName: null, lastName: null, email: null, propertyAddress: "12 Palafox St" }), { brokerageId: T1, rights: sim.sourceRightsFor("batchdata"), entityKindOf, actorType: "cron", costUsd: null })
  check("an address alone is a PROPERTY (proves nobody's identity)", prop.subject_kind === "property", prop.subject_kind)
  check("unknown rights is refused", rt.rawDataEnvelopeProblem({ ...env, source_rights: "unknown" }) !== null)
  check("a consented first-party submission is refused as a raw row (it is a Contact — C8)", /captureContact/.test(rt.rawDataEnvelopeProblem({ ...env, source_rights: "first_party_consented" }) ?? ""))
  check("a well-formed envelope passes", rt.rawDataEnvelopeProblem(env) === null)
  check("rights vocabulary = the m961 CHECK (minus the two refused-only words)", (() => {
    const sql = read("supabase/migrations/m961-rawdata-producer-contract-c35.sql")
    const m = sql.match(/source_rights IN \(([^)]*)\)/)
    const words = (m?.[1] ?? "").match(/'([a-z_]+)'/g)?.map((w) => w.slice(1, -1)) ?? []
    const want = sim.RAWDATA_SOURCE_RIGHTS.filter((w) => w !== "unknown" && w !== "first_party_consented")
    return words.length === want.length && want.every((w) => words.includes(w))
  })())
  check("subject-kind vocabulary = the m961 CHECK", (() => {
    const sql = read("supabase/migrations/m961-rawdata-producer-contract-c35.sql")
    const m = sql.match(/subject_kind IN \(([\s\S]*?)\)\s*\)/)
    const words = (m?.[1] ?? "").match(/'([a-z_]+)'/g)?.map((w) => w.slice(1, -1)) ?? []
    return words.length === rt.RAWDATA_SUBJECT_KINDS.length && rt.RAWDATA_SUBJECT_KINDS.every((w) => words.includes(w))
  })())
  check("migration line 1 carries the lane stamp (or the APPLIED LIVE stamp)", (() => {
    const l1 = read("supabase/migrations/m961-rawdata-producer-contract-c35.sql").split("\n")[0]
    return l1 === "-- WRITTEN, NOT APPLIED (wave 150, lane 150EFG) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor" || l1.startsWith("-- ── APPLIED LIVE ")
  })())

  console.log("\n[B] canary 3 — the real producer, ten replays")
  const db = () => memSupabase({ raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [], lead_scraping_markets: [] }, { unique: { raw_scraped_leads: [["idempotency_key"]] } })
  const db1 = db()
  let replayed = 0, inserted = 0
  for (let i = 0; i < 10; i++) {
    const r = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: [base()], executionId: "exec-1", marketGeo: geo, client: db1 as any })
    replayed += r.replayed; inserted += r.inserted
  }
  const rows = db1.tables.raw_scraped_leads
  check("ten replayed events → ONE raw observation", rows.length === 1 && inserted === 1, `rows=${rows.length} inserted=${inserted}`)
  check("nine counted as replays (never as refusals)", replayed === 9, `replayed=${replayed}`)
  check("the row carries the envelope columns + the verbatim copy", !!rows[0]?.idempotency_key && rows[0]?.subject_kind === "person" && rows[0]?.source_rights === "public_web" && rows[0]?.producer_version === "rawdata-c35@1" && !!rows[0]?.normalized_preview?.rawdata?.idempotency_key)
  check("…so processRawRecord (the only paid enrichment + Lead promotion caller) can run at most once for it", rows.filter((r: any) => r.processing_status === "pending").length === 1)
  const dbD = db()
  const distinct = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: Array.from({ length: 10 }, (_, i) => base({ envelope: { externalEventId: `evt-${i}` } })), executionId: "exec-1", marketGeo: geo, client: dbD as any })
  check("NEGATIVE HALF: ten DISTINCT events stay ten (the key is not a constant)", distinct.inserted === 10 && dbD.tables.raw_scraped_leads.length === 10, `inserted=${distinct.inserted}`)
  const dbT = db()
  await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: [base({ sourceRecordId: "reddit-t3_same" })], executionId: "e", marketGeo: geo, client: dbT as any })
  await ingestRawSourceBatch({ brokerageId: T2, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: [base({ sourceRecordId: "reddit-t3_same" })], executionId: "e", marketGeo: geo, client: dbT as any })
  check("two tenants researching the same observation → two rows, each its own tenant's", dbT.tables.raw_scraped_leads.length === 2 && new Set(dbT.tables.raw_scraped_leads.map((r: any) => r.brokerage_id)).size === 2)
  const dbG = memSupabase({ raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [] }, { unique: { raw_scraped_leads: [["source", "source_record_id"]] } })
  await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: [base({ sourceRecordId: "reddit-t3_same" })], executionId: "e", marketGeo: geo, client: dbG as any })
  const g2 = await ingestRawSourceBatch({ brokerageId: T2, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: [base({ sourceRecordId: "reddit-t3_same" })], executionId: "e", marketGeo: geo, client: dbG as any })
  check("POSITIVE CONTROL: the LIVE global (source, source_record_id) UNIQUE refuses the second tenant (why m961's footer asks the owner to drop it)", g2.inserted === 0 && g2.skipped_duplicate === 1)

  console.log("\n[C] schema lag (m961 not applied)")
  const dbL = memSupabase({ raw_scraped_leads: [], scraper_executions: [], lifecycle_events: [] }, { missingColumns: { raw_scraped_leads: ["idempotency_key", "subject_kind"] } })
  const lag = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "reddit_relocation", sourceFamily: "social_intent", sourceChannel: "reddit_relocation", records: [base()], executionId: "e", marketGeo: geo, client: dbL as any })
  check("the row is still written (legacy shape) and the lag is COUNTED", lag.inserted === 1 && lag.envelope_columns_absent === 1 && lag.skipped_refused === 0, JSON.stringify(lag))
  check("the envelope rides normalized_preview.rawdata", !!dbL.tables.raw_scraped_leads[0]?.normalized_preview?.rawdata?.idempotency_key && dbL.tables.raw_scraped_leads[0]?.idempotency_key === undefined)
  const dbR = db()
  const unk = await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "mystery_feed", sourceFamily: "x", sourceChannel: "mystery_feed", records: [base({ source: "mystery_feed" })], executionId: "e", marketGeo: geo, client: dbR as any })
  check("a source no vendor contract names is REFUSED (skipped_rights), not guessed", unk.skipped_rights === 1 && unk.inserted === 0 && dbR.tables.raw_scraped_leads.length === 0)
  const dbO = db()
  await ingestRawSourceBatch({ brokerageId: T1, marketId: MARKET, source: "batchdata_motivated", sourceFamily: "motivated_seller", sourceChannel: "batchdata", records: [base({ source: "batchdata_motivated", sourceRecordId: "bd-1", propertyAddress: "12 Palafox St", mailingAddress: "12 Palafox St", rawPayload: { apn: "000-123-456", fips: "12033" } })], executionId: "e", marketGeo: geo, client: dbO as any })
  const ownerRow: any = dbO.tables.raw_scraped_leads[0]
  check("an OWNER observation carries its identity keys (APN first) and an ownership verdict", ownerRow?.subject_kind === "owner" && /^apn:12033:123456/.test(ownerRow?.external_ids?.identity_keys ?? "") && !!ownerRow?.evidence?.ownership?.verdict, `${ownerRow?.subject_kind} ${ownerRow?.external_ids?.identity_keys}`)
  check("…and one licensed source alone does NOT verify the owner (no second source / matching mailing yet)", ownerRow?.evidence?.ownership?.verdict === "unverified", ownerRow?.evidence?.ownership?.verdict)

  console.log("\n[D] canary 4 — the subject rule at the Lead door")
  const full = { first_name: "Dana", last_name: "Whitfield", email: "dana.whitfield@example.org" }
  check("an anonymous market observation with a parsed name is NOT a Lead", (() => { const r = cle.evaluateCanonicalLeadEligibility({ ...full, subject_kind: "market" }); return !r.eligible && r.failing === "subject" })())
  check("an anonymous question / a property / an LLC are NOT Leads", ["anonymous_question", "property", "entity_trust_estate", "listing", "job_civic_event"].every((k) => !cle.evaluateCanonicalLeadEligibility({ ...full, subject_kind: k }).eligible))
  check("a licensed verified owner with complete identity MAY become a Lead", cle.evaluateCanonicalLeadEligibility({ ...full, subject_kind: "owner" }).eligible)
  check("a person with complete identity still may (legacy null too)", cle.evaluateCanonicalLeadEligibility({ ...full, subject_kind: "person" }).eligible && cle.evaluateCanonicalLeadEligibility(full).eligible)
  check("an unknown spelling refuses (fail closed)", cle.subjectKindLeadProblem("persn") !== null)
  const pp = stripped("lib/lead-pipeline/pipeline-processor.ts")
  const gateAt = pp.indexOf("subjectKindLeadProblem(subjectKind)")
  const spendAt = pp.indexOf("await enrichWithPeopleData(")
  check("processRawRecord applies the subject rule BEFORE the paid enrichment", gateAt > 0 && spendAt > 0 && gateAt < spendAt, `gate@${gateAt} spend@${spendAt}`)
  check("…and hands the subject to the canonical promotion gate", /evaluateCanonicalLeadEligibility\(\{[\s\S]{0,400}subject_kind: subjectKind/.test(pp))

  console.log("\n[E] censuses (stripped source)")
  const writerRe = /from\(\s*['"]raw_scraped_leads['"]\s*\)\s*\.(insert|upsert)\(/
  check("POSITIVE CONTROL: the writer finder sees a planted writer", writerRe.test(`await svc.from('raw_scraped_leads').insert({})`))
  const files = [...walk("lib"), ...walk("app"), ...walk("workflows")]
  const writers = files.filter((f) => writerRe.test(stripComments(read(f)).replace(/\s+/g, " ")))
  check("ONE producer: raw_scraped_leads is written only by lib/kernel/scraping.ts (+ the deal-room demo seed)", writers.every((f) => f === "lib/kernel/scraping.ts" || f === "lib/platform/deal-room-demo.ts") && writers.includes("lib/kernel/scraping.ts"), writers.join(", "))
  const volatileRe = /sourceRecordId:[^\n]*\$\{Date\.now\(\)\}-\$\{Math\.random\(\)\}/
  check("POSITIVE CONTROL: the volatile-id finder sees a planted clock/random id", volatileRe.test("    sourceRecordId: `x-${post.id ?? `${Date.now()}-${Math.random()}`}`,"))
  const volatile = walk("lib/lead-pipeline").filter((f) => volatileRe.test(stripComments(read(f))))
  check("no sourcer in lib/lead-pipeline mints a clock/random source id", volatile.length === 0, volatile.join(", "))
  const cap = stripped("lib/contact-pipeline/contact-capture.ts")
  check("first-party exception preserved: captureContact never routes a consented person through the raw producer", !/ingestRawSourceBatch\(/.test(cap) && /export async function captureContact\(/.test(cap))
  const meta = stripped("app/api/webhooks/meta-leadgen/route.ts")
  check("the consented ad-form webhook lands through the ad-lead intake (C8), not the raw producer", /ingestMetaLeadByRef/.test(meta) && !/ingestRawSourceBatch/.test(meta))
  const scr = stripped("lib/kernel/scraping.ts")
  check("the producer builds and enforces the envelope on every record", /buildRawDataEnvelope\(record/.test(scr) && /rawDataEnvelopeProblem\(envelope\)/.test(scr) && /skipped_rights\+\+/.test(scr))

  console.log(`\nRAWDATA INGRESS — ${passed} passed, ${failed} failed ${failed === 0 ? "✅ RAWDATA_INGRESS_PASS" : "❌ RAWDATA_INGRESS_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
