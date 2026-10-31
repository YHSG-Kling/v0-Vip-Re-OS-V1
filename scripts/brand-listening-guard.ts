#!/usr/bin/env tsx
/**
 * scripts/brand-listening-guard.ts   (npm run test:brand-listening)
 * ─────────────────────────────────────────────────────────────────────────────
 * BRAND LISTENING (wave 139H) — the Brand24 concepts on the competitive-intel survivors,
 * proven in memory: the search provider and the model are STUBBED (no network, no spend),
 * the database is an in-memory supabase-shaped client, the REAL pass
 * (lib/competitive-intel/brand-listening.ts runBrandListeningPass) runs end to end, and the
 * REAL watched-competitor roster (loadCompetitorTargets) reads the fixture.
 *
 *   A  subjects are DERIVED from tenant data — never a literal (tenant A vs B, a renamed
 *      brokerage, inactive / single-token / draft rows excluded; a stripped-source scan finds
 *      no territory literal, with a planted positive control)
 *   B  mention capture dedups (in-pass across subjects + utm variants; across passes by the
 *      (brokerage_id, url_key) key) and drops a hit that does not literally NAME its subject
 *   C  sentiment is a STRUCTURED, bounded call; an invented id is never written; an invalid
 *      output degrades honestly (rows stay unscored, retried next pass)
 *   D  spikes / compliance → manager signals to the RIGHT owner, idempotent per subject per day,
 *      catalogued in SIGNAL_REGISTRY with the matching kind; below-threshold → no signal
 *   E  PLATFORM-COVERED: each executed search books one platform vendor booking; a provider
 *      "none" books nothing; the model call carries NO brokerageId + platformPaid (the cost
 *      ledger's platform lane, read from source); no tenant meter table is written; a refused
 *      gate spends nothing
 *   F  tenant isolation: every tenant-table op of A's pass is pinned to A; B untouched
 *   G  discussion topics feed content_topic_bank (idempotent; a flagged theme is never fed)
 *   H  LAW 5: one ledgered pass per tenant per UTC day (replay spends nothing)
 *   W  wiring: cron registry + owner, TABLE_MANAGER, MAINTENANCE_DOMAINS, surface reader,
 *      one URL→platform spelling, m755 header, chain membership
 *
 * Pure: no network, no database. Run: npx tsx scripts/brand-listening-guard.ts
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings, stringLiterals } from "./strip-comments"
import { runBrandListeningPass, loadBrandListeningReading, sourceFromUrl, type BrandListeningDeps } from "../lib/competitive-intel/brand-listening"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { classifyCoordination } from "../lib/kernel/coordination-kind"
import { MANAGERS, MAINTENANCE_DOMAINS, TABLE_MANAGER, CRON_MANAGER } from "../lib/kernel/manager-registry"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name); console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")

// ── in-memory supabase-shaped client ─────────────────────────────────────────
type Row = Record<string, any>
interface Op { table: string; op: string; filters: Array<[string, any]>; rows?: Row[] }
function makeDb(seed: Record<string, Row[]>, opts: { refuse?: Set<string> } = {}) {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }))
  const log: Op[] = []
  let seq = 0
  function from(table: string) {
    const filters: Array<[string, any]> = []
    const preds: Array<(r: Row) => boolean> = []
    let op = "select", payload: Row[] = [], patch: Row = {}, wantRows = false, single = false, limitN = Infinity
    let order: { col: string; asc: boolean } | null = null
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {}
    const b: any = {
      select() { if (op !== "select") wantRows = true; return b },
      insert(p: Row | Row[]) { op = "insert"; payload = Array.isArray(p) ? p : [p]; return b },
      upsert(p: Row | Row[], o: any) { op = "upsert"; payload = Array.isArray(p) ? p : [p]; upsertOpts = o ?? {}; return b },
      update(p: Row) { op = "update"; patch = p; return b },
      eq(c: string, v: any) { filters.push([c, v]); preds.push((r) => r[c] === v); return b },
      is(c: string, v: any) { filters.push([c, v]); preds.push((r) => (v === null ? r[c] == null : r[c] === v)); return b },
      in(c: string, vs: any[]) { filters.push([c, vs]); preds.push((r) => vs.includes(r[c])); return b },
      gte(c: string, v: any) { filters.push([c, v]); preds.push((r) => r[c] != null && r[c] >= v); return b },
      contains(c: string, v: Row) { filters.push([c, v]); preds.push((r) => !!r[c] && Object.entries(v).every(([k, x]) => r[c][k] === x)); return b },
      order(c: string, o?: { ascending?: boolean }) { order = { col: c, asc: o?.ascending !== false }; return b },
      limit(n: number) { limitN = n; return b },
      maybeSingle() { single = true; return b },
      single() { single = true; return b },
      then(resolve: (v: any) => void) {
        log.push({ table, op, filters: [...filters], rows: payload.length ? payload : undefined })
        if (opts.refuse?.has(table)) return resolve({ data: null, error: { message: `relation "${table}" refused (fixture)` } })
        const t = (tables[table] ??= [])
        if (op === "insert" || op === "upsert") {
          const out: Row[] = []
          for (const p of payload) {
            if (op === "upsert" && upsertOpts.onConflict) {
              const cols = upsertOpts.onConflict.split(",")
              const hit = t.find((r) => cols.every((c) => r[c] === p[c]))
              if (hit) { if (!upsertOpts.ignoreDuplicates) Object.assign(hit, p); continue }
            }
            const row = { id: p.id ?? `row-${table}-${++seq}`, sentiment: null, topics: [], scored_at: null, ...p }
            t.push(row); out.push(row)
          }
          return resolve({ data: wantRows ? out : null, error: null })
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

// ── fixtures (fictional tenants; no real territory) ──────────────────────────
const A = "00000000-0000-4000-8000-00000000000a", B = "00000000-0000-4000-8000-00000000000b"
const NOW = new Date("2026-10-08T12:00:00.000Z")
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()
const H = 3_600_000
function seed(): Record<string, Row[]> {
  return {
    brokerages: [
      { id: A, name: "Harbor Light Realty", dba: null, city: "Alderbrook", state: "QA", archived_at: null, deleted_at: null },
      { id: B, name: "Northgate Property Group", dba: null, city: "Bexley Falls", state: "QB", archived_at: null, deleted_at: null },
    ],
    agents: [
      { id: "ag-1", brokerage_id: A, is_active: true, users: { first_name: "Mara", last_name: "Quillfeather" } },
      { id: "ag-2", brokerage_id: A, is_active: false, users: { first_name: "Inactive", last_name: "Person" } },
      { id: "ag-3", brokerage_id: A, is_active: true, users: { first_name: "Cher", last_name: null } },
      { id: "bg-1", brokerage_id: B, is_active: true, users: { first_name: "Odell", last_name: "Brannigan" } },
    ],
    teams: [{ id: "tm-1", brokerage_id: A, name: "Quill Collective", deleted_at: null }],
    listings: [
      { id: "ls-1", brokerage_id: A, address: "41 Larkspur Lane", city: "Alderbrook", status: "active", deleted_at: null },
      { id: "ls-2", brokerage_id: A, address: "9 Draft Row Court", city: "Alderbrook", status: "draft", deleted_at: null },
    ],
    competitors: [
      { brokerage_id: A, competitor_name: "Summit Peak Homes", competitor_url: "summitpeak.example" },
      { brokerage_id: B, competitor_name: "Riverstone Realty Partners", competitor_url: null },
    ],
    competitor_profiles: [],
    hashtag_performance: [{ brokerage_id: A, hashtag: "#alderbrookliving", posts_count: 9 }],
    seo_keywords: [],
    brand_mentions: [
      // B's own mention — A's pass must never touch it.
      { id: "b-m-1", brokerage_id: B, subject_kind: "brokerage", subject_id: B, subject_label: "Northgate Property Group", url: "https://b.example/1", url_key: "b.example/1", source: "web", provider: "exa", author: null, title: "Northgate Property Group", excerpt: null, published_at: iso(2 * H), captured_at: iso(H), reach_estimate: 10, names_us: true, competitors_named: [], sentiment: "positive", sentiment_score: 0.5, topics: [], compliance_flag: false, compliance_reason: null, scored_at: iso(H) },
    ],
    manager_signals: [],
    content_topic_bank: [],
    ad_insights: [],
  }
}

const hit = (url: string, title: string, snippet: string, hoursAgo: number, score = 0.4, author: string | null = "Pat Reader") =>
  ({ url, title, snippet, author, publishedAt: iso(hoursAgo * H), score })
const searchCalls: string[] = []
const search: NonNullable<BrandListeningDeps["search"]> = async ({ query }) => {
  searchCalls.push(query)
  if (query.includes("Quill Collective")) return { provider: "none", cost: 0, hits: [] } // the rail had nothing → no booking
  if (query.includes("Harbor Light Realty")) return { provider: "exa", cost: 0.007, hits: [
    hit("https://www.facebook.com/post/111?utm_source=feed", "Harbor Light Realty open house recap", "Great turnout with Harbor Light Realty, Summit Peak Homes was down the street", 2),
    hit("https://news.example/story", "Housing market update", "Rates moved this week", 3), // does not NAME the subject → dropped
  ] }
  if (query.includes("Mara Quillfeather")) return { provider: "exa", cost: 0.007, hits: [
    hit("https://facebook.com/post/111/?utm_medium=share", "Mara Quillfeather at the Harbor Light Realty open house", "Mara Quillfeather hosted", 2), // SAME post, utm variant → dedup
    hit("https://reddit.com/r/homes/a1", "Mara Quillfeather never called back", "Disappointed with Mara Quillfeather", 1),
    hit("https://reddit.com/r/homes/a2", "Avoid Mara Quillfeather", "Mara Quillfeather missed our closing", 1),
    hit("https://x.com/u/status/a3", "Mara Quillfeather ghosted us", "Mara Quillfeather slow replies", 1),
  ] }
  if (query.includes("41 Larkspur Lane")) return { provider: "exa", cost: 0.007, hits: [
    hit("https://www.instagram.com/p/ll1", "41 Larkspur Lane just listed", "41 Larkspur Lane is perfect for families", 3),
  ] }
  if (query.includes("Summit Peak Homes")) return { provider: "tavily", cost: 0.005, hits: [
    hit("https://summitpeak.example/blog/1", "Summit Peak Homes spring push", "Summit Peak Homes launches", 2),
    hit("https://summitpeak.example/blog/2", "Summit Peak Homes ads everywhere", "Summit Peak Homes billboard", 2),
    hit("https://linkedin.com/posts/sp3", "Summit Peak Homes hiring", "Summit Peak Homes grows team", 4),
  ] }
  if (query.includes("alderbrookliving")) return { provider: "exa", cost: 0.007, hits: [
    hit("https://www.tiktok.com/@a/video/k1", "#alderbrookliving school run", "alderbrookliving traffic again", 5),
    hit("https://www.youtube.com/watch?v=k2", "alderbrookliving tour", "alderbrookliving neighborhood", 6),
  ] }
  return { provider: "none", cost: 0, hits: [] }
}
const scoreCalls: Array<{ req: any; ids: string[] }> = []
let scoreMode: "ok" | "invalid" = "ok"
const score: NonNullable<BrandListeningDeps["score"]> = async (req) => {
  const batch = JSON.parse(req.prompt).mentions as Array<{ id: string; subject_kind: string }>
  scoreCalls.push({ req, ids: batch.map((m) => m.id) })
  if (scoreMode === "invalid") return { mentions: batch.map((m) => ({ id: m.id, sentiment: "furious", score: 0, topics: [], complianceConcern: false, complianceReason: null })), insights: [] } as any
  const topicFor = (k: string) => (k === "agent" ? "agent responsiveness" : k === "keyword" ? "school district traffic" : k === "listing" ? "listing launch" : "spring market prices")
  return {
    mentions: [
      ...batch.map((m) => ({ id: m.id, sentiment: m.subject_kind === "agent" ? "negative" as const : "positive" as const, score: m.subject_kind === "agent" ? -0.8 : 0.6, topics: [topicFor(m.subject_kind)], complianceConcern: false, complianceReason: null })),
      { id: "injected-id-not-in-batch", sentiment: "negative" as const, score: -1, topics: ["injected"], complianceConcern: true, complianceReason: "injected" },
    ],
    insights: ["Summit Peak Homes is taking a large share of the conversation this week."],
  }
}
const bookings: any[] = []
const bookVendor: NonNullable<BrandListeningDeps["bookVendor"]> = async (b) => { bookings.push(b); return true }
const published: any[] = []
function makePublish(db: ReturnType<typeof makeDb>): NonNullable<BrandListeningDeps["publish"]> {
  return async (s) => { published.push(s); db.tables.manager_signals.push({ id: `sig-${published.length}`, brokerage_id: s.brokerageId, signal_type: s.signalType, to_manager: s.toManager, from_manager: s.fromManager, payload: s.payload, status: "open" }); return { ok: true, signalId: `sig-${published.length}` } }
}
const runAlways: NonNullable<BrandListeningDeps["ledger"]> = async (_b, _d, run) => run()
const ledgerSeen = new Set<string>()
const ledgerOnce: NonNullable<BrandListeningDeps["ledger"]> = async (b, d, run) => { const k = `${b}:${d}`; if (ledgerSeen.has(k)) return null; ledgerSeen.add(k); return run() }
const allow: NonNullable<BrandListeningDeps["gate"]> = async () => ({ allowed: true, reason: "subscription_current" })

async function main() {
  const db = makeDb(seed())
  const deps = (over: Partial<BrandListeningDeps> = {}): BrandListeningDeps => ({ db, now: NOW, search, score, bookVendor, publish: makePublish(db), gate: allow, ledger: runAlways, ...over })

  console.log("\n[A · subjects derived from tenant data — never a literal]")
  const r1 = await runBrandListeningPass(A, deps({ ledger: ledgerOnce }))
  const callsInR1 = scoreCalls.length
  const labels = r1.subjects.map((s) => `${s.kind}:${s.label}`)
  check("A1 tenant A's subjects are its own rows (brokerage, team, active full-name agent, active listing, watched rival, hashtag)",
    ["brokerage:Harbor Light Realty", "team:Quill Collective", "agent:Mara Quillfeather", "listing:41 Larkspur Lane", "competitor:Summit Peak Homes", "keyword:alderbrookliving"].every((l) => labels.includes(l)) && labels.length === 6, labels.join(" | "))
  check("A2 inactive agent, single-token name and draft listing are NOT subjects", !labels.some((l) => /Inactive Person|Cher|Draft Row/.test(l)))
  check("A3 queries carry the tenant's OWN place (brokerages.city/state), never another tenant's", searchCalls.some((q) => q.includes("Alderbrook QA")) && !searchCalls.some((q) => /Bexley|Northgate|Riverstone|Odell/.test(q)))
  const dbRenamed = makeDb({ ...seed(), brokerages: seed().brokerages.map((b) => (b.id === A ? { ...b, name: "Lantern Cove Estates" } : b)) })
  const rRen = await runBrandListeningPass(A, { ...deps(), db: dbRenamed, publish: makePublish(dbRenamed) })
  check("A4 rename the brokerage → the brokerage subject follows the data", rRen.subjects.some((s) => s.kind === "brokerage" && s.label === "Lantern Cove Estates") && !rRen.subjects.some((s) => s.label === "Harbor Light Realty"))
  const src = read("lib/competitive-intel/brand-listening.ts")
  const TERRITORY = /^(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)$|\b(?:Texas|California|Florida|Arizona|Austin|Phoenix|Dallas|Houston|Miami|Denver|Atlanta|Seattle)\b|,\s*[A-Z]{2}\b/
  const territoryLits = (s: string) => stringLiterals(stripComments(s)).map((l: any) => String(l.value ?? l.text ?? l)).filter((v) => TERRITORY.test(v))
  check("A5 no territory literal in the listening module's code (comments stripped)", territoryLits(src).length === 0, territoryLits(src).join(", "))
  check("A5·PC the territory finder catches a planted literal", territoryLits(`const x = "Austin, TX"\nconst y = "TX"`).length >= 1)

  console.log("\n[B · capture + dedup]")
  const aRows = () => db.tables.brand_mentions.filter((r) => r.brokerage_id === A)
  check("B1 utm variants of one post found by TWO subjects land as ONE row", aRows().filter((r) => r.url_key === "facebook.com/post/111").length === 1 && r1.droppedDuplicate >= 1, `dup=${r1.droppedDuplicate}`)
  check("B2 a hit that does not literally NAME its subject is dropped", r1.droppedUnmatched === 1 && !aRows().some((r) => r.url_key === "news.example/story"))
  check("B3 positive control — distinct URLs are distinct mentions (10 captured)", r1.captured === 10 && r1.inserted === 10 && aRows().length === 10, `captured=${r1.captured} inserted=${r1.inserted}`)
  const m1 = aRows().find((r) => r.url_key === "reddit.com/r/homes/a1")!
  check("B4 a mention carries source, url, author, published_at and a reach index", m1?.source === "reddit" && m1.url.startsWith("https://") && m1.author === "Pat Reader" && !!m1.published_at && m1.reach_estimate === 40)

  console.log("\n[C · sentiment is structured and bounded]")
  const call = scoreCalls[0]
  check("C1 ONE model call for the batch, bounded (≤20 mentions, maxTokens ≤ 2000, temperature 0)", callsInR1 === 1 && call.ids.length === 10 && call.req.maxTokens <= 2000 && call.req.temperature === 0)
  check("C2 every scored row carries sentiment + score + topics + scored_at", aRows().every((r) => ["positive", "negative", "neutral", "mixed"].includes(r.sentiment) && typeof r.sentiment_score === "number" && r.topics.length > 0 && !!r.scored_at) && r1.scored === 10)
  check("C3 an id the model invented is never written", !db.tables.brand_mentions.some((r) => r.id === "injected-id-not-in-batch") && !aRows().some((r) => (r.topics ?? []).includes("injected")))
  const dbBad = makeDb(seed()); scoreMode = "invalid"
  const rBad = await runBrandListeningPass(A, { ...deps(), db: dbBad, publish: makePublish(dbBad) }); scoreMode = "ok"
  check("C4 an output that fails the schema degrades honestly — rows stay unscored, the reason is reported", !!rBad.sentimentUnavailable && rBad.scored === 0 && dbBad.tables.brand_mentions.filter((r) => r.brokerage_id === A).every((r) => r.scored_at === null), rBad.sentimentUnavailable ?? "")
  const rRetry = await runBrandListeningPass(A, { ...deps(), db: dbBad, publish: makePublish(dbBad) })
  check("C5 the next pass scores what the failed pass left (no double capture)", rRetry.inserted === 0 && rRetry.scored === 10)

  console.log("\n[D · spikes + compliance → the right manager]")
  const sig = (t: string) => published.filter((p) => p.signalType === t && p.brokerageId === A)
  const rep = sig("brand_reputation_escalated")
  check("D1 negative agent spike → brand_reputation_escalated → sphere_of_influence (from campaign_orchestrator)", rep.length >= 1 && rep.every((s) => s.toManager === "sphere_of_influence" && s.fromManager === "campaign_orchestrator" && s.entityType === "agent" && s.entityId === "ag-1"))
  const comp = sig("competitor_mention_surge")
  check("D2 competitor surge → competitor_mention_surge → ads_manager", comp.length >= 1 && comp.every((s) => s.toManager === "ads_manager"))
  const fh = sig("mention_compliance_finding")
  check("D3 fair-housing phrase in a mention → mention_compliance_finding → compliance_officer", fh.length >= 1 && fh.every((s) => s.toManager === "compliance_officer" && /perfect for families/.test(s.message)))
  check("D4 below threshold (brokerage: 1 mention in 24h) → no signal for that subject", !published.some((p) => p.brokerageId === A && String(p.payload?.subject_key ?? "").startsWith("brokerage:")))
  const before = published.length
  const rSame = await runBrandListeningPass(A, deps())
  check("D5 a second pass the same day publishes NO duplicate signal", published.length === before && rSame.signals.length === 0, `+${published.length - before}`)
  const routes = [...new Set(published.map((p) => `${p.signalType}>${p.toManager}`))]
  check("D6 every listening signal is catalogued (consumer = recipient, kind = classifier) and both ends are real managers",
    routes.length >= 3 && routes.every((r) => { const [t, to] = r.split(">"); const spec = SIGNAL_REGISTRY[t]; return !!spec && spec.consumers.includes(to) && spec.kind === classifyCoordination(t) && to in MANAGERS }), routes.join(", "))

  console.log("\n[E · platform-covered — booked on the platform ledger, never billed to the tenant]")
  const aBookings = bookings.filter((b) => b.brokerageId === A)
  check("E1 each executed search books ONE platform vendor booking (payer platform, platform_covered, system_source brand_listening, real provider cost)",
    r1.bookingsBooked === 5 && aBookings.slice(0, 5).every((b) => b.metadata?.payer === "platform" && b.metadata?.platform_covered === true && b.systemSource === "brand_listening" && b.cost > 0 && b.unitCount === 1) && Math.abs(r1.platformCostUsd - 0.033) < 1e-9, `booked=${r1.bookingsBooked} cost=${r1.platformCostUsd}`)
  check("E2 a provider 'none' search (nothing executed) books nothing", r1.providersNone === 1 && r1.searches === 6)
  check("E3 the model request carries NO brokerageId and platformPaid=true (tenant attributed in contextExtra only)",
    call.req.brokerageId === null && call.req.platformPaid === true && call.req.feature === "sentiment_analysis" && call.req.contextExtra?.covered_brokerage_id === A && call.req.contextExtra?.payer === "platform")
  const ct = blankStrings(stripComments(read("lib/ai/cost-tracking.ts")))
  const models = blankStrings(stripComments(read("lib/ai/models.ts")))
  check("E4 the cost ledger's platform lane exists: platform_paid only when no tenant is passed, and the routed lane books it", /const platformPaid = !params\.brokerageId && params\.platformPaid === true/.test(ct) && /if \(request\.brokerageId \|\| request\.platformPaid\)/.test(models))
  const meterTables = new Set(["ai_tool_usage", "usage_events", "usage_logs", "meter_readings", "vendor_usage_tracking", "billing_invoices"])
  check("E5 the pass writes NOTHING to a tenant meter / invoice table", !db.log.some((o) => meterTables.has(o.table)))
  const dbGate = makeDb(seed()); const n0 = searchCalls.length, b0 = bookings.length
  const rGate = await runBrandListeningPass(A, { ...deps(), db: dbGate, gate: async () => ({ allowed: false, reason: "subscription_lapsed" }) })
  check("E6 a refused gate (lapsed tenant) spends nothing — no search, no booking, no write", !!rGate.skipped && searchCalls.length === n0 && bookings.length === b0 && !dbGate.log.some((o) => o.op !== "select"))

  console.log("\n[F · tenant isolation]")
  const fresh = makeDb(seed())
  await runBrandListeningPass(A, { ...deps(), db: fresh, publish: makePublish(fresh) })
  const TENANT_TABLES = new Set(["agents", "teams", "listings", "competitors", "competitor_profiles", "hashtag_performance", "seo_keywords", "brand_mentions", "manager_signals", "content_topic_bank", "ad_insights"])
  const unpinned = fresh.log.filter((o) => TENANT_TABLES.has(o.table)).filter((o) => o.rows ? !o.rows.every((r) => r.brokerage_id === A) : !o.filters.some(([c, v]) => c === "brokerage_id" && v === A))
  check("F1 every tenant-table read and write of A's pass is pinned to A", unpinned.length === 0, unpinned.map((o) => `${o.op} ${o.table}`).join(", "))
  check("F2 brokerages read only A's row", fresh.log.filter((o) => o.table === "brokerages").every((o) => o.filters.some(([c, v]) => c === "id" && v === A)))
  const bRow = fresh.tables.brand_mentions.find((r) => r.id === "b-m-1")
  check("F3 tenant B's mention is untouched (same sentiment, same scored_at)", bRow?.sentiment === "positive" && bRow?.scored_at === iso(H) && fresh.tables.brand_mentions.filter((r) => r.brokerage_id === B).length === 1)
  const readingB = await loadBrandListeningReading(fresh, B, NOW)
  check("F4 tenant B's reading holds only B's mention", readingB.mentions === 1 && readingB.recent.every((r) => r.id === "b-m-1"))
  const readingA = await loadBrandListeningReading(fresh, A, NOW)
  check("F5 tenant A's reading: share of voice is citationShare over mentions (5 us / 4 rival → 55.6%)", readingA.shareOfVoice.shareOfVoicePct === 55.6 && readingA.shareOfVoice.topCompetitors[0]?.name === "Summit Peak Homes", `sov=${readingA.shareOfVoice.shareOfVoicePct}`)
  const readingRefused = await loadBrandListeningReading(makeDb(seed(), { refuse: new Set(["brand_mentions"]) }), A, NOW)
  check("F6 a refused read renders as a refusal, never as 'no mentions'", !!readingRefused.refused && readingRefused.mentions === 0)

  console.log("\n[G · discussion topics feed the topic bank]")
  const bank = db.tables.content_topic_bank.filter((r) => r.brokerage_id === A)
  check("G1 topics with ≥2 mentions enter content_topic_bank (fresh, brand_listening, sentinel key, tenant geo from its own row)",
    bank.length === 3 && bank.every((t) => t.status === "fresh" && t.categories.includes("brand_listening") && !!t.raw_data?.listening_topic_key && t.geo_relevance?.cities?.[0] === "Alderbrook"), bank.map((b) => b.topic_title).join(", "))
  check("G2 a rerun feeds no duplicate topic", db.tables.content_topic_bank.filter((r) => r.brokerage_id === A).length === 3)
  check("G3 a compliance-flagged mention's theme is never fed", !bank.some((t) => t.topic_title === "listing launch"))
  check("G4 the AI insight lands on the competitive surface's ad_insights rail", db.tables.ad_insights.some((r) => r.brokerage_id === A && r.insight_type === "brand_listening" && r.source_type === "competitor_analysis"))

  console.log("\n[H · LAW 5 — one ledgered pass per tenant per day]")
  const n1 = searchCalls.length
  const rReplay = await runBrandListeningPass(A, deps({ ledger: ledgerOnce }))
  check("H1 a second tick the same day replays from the ledger — no search, no spend", /already listened/.test(rReplay.skipped ?? "") && searchCalls.length === n1)
  const rNext = await runBrandListeningPass(A, deps({ ledger: ledgerOnce, now: new Date(NOW.getTime() + 24 * H) }))
  check("H2 the next day runs again and dedups everything it already holds", rNext.ran && rNext.inserted === 0 && rNext.captured === 10)

  console.log("\n[W · wiring]")
  check("W1 sourceFromUrl is host-based (x.com → x, fox.com → web, ad library → facebook)", sourceFromUrl("https://x.com/a") === "x" && sourceFromUrl("https://fox.com/a") === "web" && sourceFromUrl("https://www.facebook.com/ads/library/?id=1") === "facebook")
  const cis = stripComments(read("lib/competitive-intel/content-intel-scan.ts"))
  check("W2 ONE URL→platform spelling: content-intel-scan imports sourceFromUrl and keeps no private copy", /sourceFromUrl as platformFromUrl/.test(cis) && !/function\s+platformFromUrl/.test(cis))
  check("W3 the cron is registered and owned (CRON_REGISTRY + CRON_MANAGER campaign_orchestrator)", CRON_REGISTRY.some((c) => c.path === "/api/cron/brand-listening") && CRON_MANAGER["/api/cron/brand-listening"] === "campaign_orchestrator")
  const route = stripComments(read("app/api/cron/brand-listening/route.ts"))
  check("W4 the route authenticates the cron and runs the sweep", /verifyCronAuth\(req\)/.test(route) && /runBrandListeningSweep\(/.test(route))
  check("W5 brand_mentions is stewarded (TABLE_MANAGER campaign_orchestrator)", TABLE_MANAGER["brand_mentions"] === "campaign_orchestrator")
  const md = MAINTENANCE_DOMAINS["brand_listening"]
  check("W6 MAINTENANCE_DOMAINS names this proof, its owner and co-owners", md?.proof === "test:brand-listening" && md.manager === "campaign_orchestrator" && (md.coOwners ?? []).includes("ads_manager") && (md.coOwners ?? []).includes("compliance_officer"))
  const page = stripComments(read("app/dashboard/campaigns/competitive/page.tsx"))
  check("W7 the Competitive Monitor reads the listening reading with its SESSION client and renders the card", /loadBrandListeningReading\(supabase, brokerageId\)/.test(page) && /<BrandListeningCard reading=\{listening\}/.test(page))
  const mig = read("supabase/migrations/m755-brand-mentions-listening.sql")
  check("W8 m755 carries the lane stamp or the applied stamp, the unique dedup key and tenant RLS", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE)/.test(mig) && /UNIQUE INDEX[^;]*\(brokerage_id, url_key\)/.test(mig) && /current_user_brokerage_id\(\)/.test(mig) && /ENABLE ROW LEVEL SECURITY/.test(mig))
  check("W9 test:brand-listening is a member of the guard chain", new RegExp("npm run test:brand-listening(\\s|&|$)").test(JSON.parse(read("package.json")).scripts.guard ?? ""))

  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  console.log(" blind spots: provider + model stubbed (live recall / sentiment quality unmeasured); reach is a relative engine-score index, not audience size;")
  console.log("              share of voice samples the rotated subjects of each pass (not a census of the web); m755 not applied → live writes refused until the integrator applies it.")
  if (failed > 0) { for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" BRAND_LISTENING_PASS")
}
main().catch((e) => { console.error(e); process.exit(1) })
