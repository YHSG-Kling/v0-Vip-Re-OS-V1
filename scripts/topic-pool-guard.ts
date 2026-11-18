/**
 * scripts/topic-pool-guard.ts — `npm run test:topic-pool` (wave 154, lane 154G1; directive G1–G6). ALL SIMULATED.
 *
 * ONE topic pool with verified source-to-creative actions:
 *   A  ONE PRODUCER — exactly one module inserts into content_topic_bank (THE ONE intake), with a positive control.
 *   B  FIVE+ SIGNAL TYPES reach that producer through the REAL producers' code, each keeping its own meaning
 *      (kind · evidence class + unit · rights · dates · geography · per-source provenance); a repeated article counts once.
 *   C  A tenant marketer sees their own LOCALIZED topic (geo_match — cross-lane D1, positive control on the base shape)
 *      and it reaches the draft prompt the writers use.
 *   D  A second tenant sees neither that topic nor its evidence, and cannot pass its approval.
 *   E  A support-FAQ source leaks no private ticket text (themes + counts only, threshold control).
 *   F  Market-report figures come from market facts, never keyword / topic proxies.
 *   G  A staged asset keeps its topic lineage + creator; the published read-back is lane H's (PARTIAL, said).
 *   H  The readers that mislabeled numbers now say "unknown" (content studio, lead magnets, competitor content).
 *   I  The scheduled Nextdoor topic caller, the pure statement reader as default, the Meta Ad Library mirror row,
 *      and the published topic-source → Refurbish-trigger mapping (cross-lane D2).
 * Run with --conditions=react-server (topic-bank.ts is server-only). No provider is called: every transport is a recording fake.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { intakeTopicIdeas, classifyTopicExclusion, refurbishTriggerKindForTopicSource, type TopicIdea } from "../lib/content-intel/topic-intake"
import { pickTopics, renderTopicsForPrompt } from "../lib/content-intel/topic-bank"
import { trendsProducer, type TrendsTransport } from "../lib/content-intel/search-demand"
import { normalizeFacebookGroupItems, normalizeMetaAdItems, saveManualTopicObservation, routeChatter, fenceUntrusted } from "../lib/content-intel/public-chatter-topics"
import { runTopicIntelligencePass, readTopicApproval } from "../lib/content-intel/topic-intelligence"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const code = (p: string) => stripComments(read(p))
let passed = 0, failed = 0
const fails: string[] = []
function check(label: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${label}`) } else { failed++; fails.push(label); console.log(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`) }
}

// ── an in-memory PostgREST-shaped client (the live constraints the pool relies on are enforced) ─────────────────────
type Row = Record<string, any>
function makeDb(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = {}
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }))
  let seq = 0
  const cell = (r: Row, c: string): any => { const m = /^(\w+)->>(\w+)$/.exec(c); if (!m) return r[c]; const v = r[m[1]]?.[m[2]]; return v == null ? null : String(v) }
  const deepContains = (have: any, want: any): boolean => {
    if (Array.isArray(want)) return Array.isArray(have) && want.every((w) => have.some((h) => deepContains(h, w)))
    if (want && typeof want === "object") return !!have && typeof have === "object" && Object.entries(want).every(([k, v]) => deepContains(have[k], v))
    return have === want
  }
  const orPred = (expr: string) => {
    const parts = expr.split(",").map((p) => p.trim())
    return (r: Row) => parts.some((p) => { const [col, op, ...rest] = p.split("."); const v = rest.join("."); return op === "is" ? (v === "null" ? r[col] == null : String(r[col]) === v) : op === "eq" ? String(r[col]) === v : false })
  }
  function from(table: string) {
    const preds: Array<(r: Row) => boolean> = []
    let op = "select", payload: Row[] = [], patch: Row = {}, wantRows = false, single = false, limitN = Infinity
    let order: { col: string; asc: boolean } | null = null
    const b: any = {
      select() { if (op !== "select") wantRows = true; return b },
      insert(p: Row | Row[]) { op = "insert"; payload = Array.isArray(p) ? p : [p]; return b },
      update(p: Row) { op = "update"; patch = p; return b },
      eq(c: string, v: any) { preds.push((r) => cell(r, c) === v); return b },
      neq(c: string, v: any) { preds.push((r) => cell(r, c) !== v); return b },
      is(c: string, v: any) { preds.push((r) => (v === null ? cell(r, c) == null : cell(r, c) === v)); return b },
      in(c: string, vs: any[]) { preds.push((r) => vs.includes(cell(r, c))); return b },
      gte(c: string, v: any) { preds.push((r) => r[c] != null && r[c] >= v); return b },
      gt(c: string, v: any) { preds.push((r) => r[c] != null && r[c] > v); return b },
      lt(c: string, v: any) { preds.push((r) => r[c] != null && r[c] < v); return b },
      lte(c: string, v: any) { preds.push((r) => r[c] != null && r[c] <= v); return b },
      or(expr: string) { preds.push(orPred(expr)); return b },
      contains(c: string, v: any) { preds.push((r) => deepContains(r[c], v)); return b },
      overlaps(c: string, vs: any[]) { preds.push((r) => Array.isArray(r[c]) && r[c].some((x: any) => vs.includes(x))); return b },
      order(c: string, o?: { ascending?: boolean }) { order = { col: c, asc: o?.ascending !== false }; return b },
      limit(n: number) { limitN = n; return b },
      maybeSingle() { single = true; return b },
      single() { single = true; return b },
      then(resolve: (v: any) => void, reject?: (e: any) => void) {
        try {
          const t = (tables[table] ??= [])
          if (op === "insert") {
            const out: Row[] = []
            for (const p of payload) {
              if (table === "content_topic_bank") {
                if (!p.source_id) return resolve({ data: null, error: { code: "23502", message: "source_id NOT NULL" } })
                if (p.source_url && t.some((r) => r.source_id === p.source_id && r.source_url === p.source_url)) return resolve({ data: null, error: { code: "23505", message: "uq_content_topic_bank_source_url" } })
              }
              const row = { id: p.id ?? `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, engagement_score: table === "content_topic_bank" ? 0 : undefined, performance_score: table === "content_topic_bank" ? 0 : undefined, ...p }
              t.push(row); out.push(row)
            }
            return resolve({ data: wantRows ? (single ? out[0] ?? null : out) : null, error: null })
          }
          let rows = t.filter((r) => preds.every((p) => p(r)))
          if (op === "update") { for (const r of rows) Object.assign(r, patch); return resolve({ data: wantRows ? rows : null, error: null }) }
          if (order) { const { col, asc } = order; rows = [...rows].sort((x, y) => (x[col] > y[col] ? 1 : x[col] < y[col] ? -1 : 0) * (asc ? 1 : -1)) }
          rows = rows.slice(0, limitN)
          return resolve({ data: single ? rows[0] ?? null : rows, error: null })
        } catch (e) { reject?.(e) }
      },
    }
    return b
  }
  return { from, tables }
}

const A = "00000000-0000-4000-8000-0000000000a1", B = "00000000-0000-4000-8000-0000000000b2"
const NOW = new Date()
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString()
const DAY = 86_400_000
const GEO = { city: "Pensacola", state: "FL" }

async function main() {
  // ═══ A — ONE PRODUCER ═════════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[A · one producer into content_topic_bank]")
  const files: string[] = []
  const walk = (d: string) => { for (const e of readdirSync(join(ROOT, d))) { const p = `${d}/${e}`; if (statSync(join(ROOT, p)).isDirectory()) { if (e !== "node_modules") walk(p) } else if (/\.(ts|tsx)$/.test(e)) files.push(p) } }
  walk("lib"); walk("app")
  // Strings are kept until the table name is located (the name IS a string), then the call is read on stripped source.
  const INSERT = /\.from\(\s*["'`]content_topic_bank["'`]\s*\)\s*\.(?:insert|upsert)\s*\(/
  const inserters = (srcs: Array<[string, string]>) => srcs.filter(([, s]) => INSERT.test(stripComments(s))).map(([f]) => f)
  const census = inserters(files.filter((f) => read(f).includes("content_topic_bank")).map((f) => [f, read(f)]))
  console.log(`    inserting modules: ${census.join(", ") || "none"} (denominator: ${files.length} lib/app files; exclusions: none)`)
  check("A1 exactly ONE module inserts into content_topic_bank, and it is THE ONE intake", census.length === 1 && census[0] === "lib/content-intel/topic-intake.ts", census.join(", "))
  check("A2 POSITIVE CONTROL: a planted direct insert (and an upsert) is found; a tombstone COMMENT naming one is not",
    inserters([["x.ts", `await db.from("content_topic_bank").insert({ source_id: s })`], ["y.ts", `await svc.from('content_topic_bank')\n  .upsert(row)`], ["z.ts", `// was: db.from("content_topic_bank").insert(row)\nconst a = 1`]]).join() === "x.ts,y.ts")
  const routed = ["lib/content-intel/topic-intelligence.ts", "lib/content-intel/local-intel.ts", "lib/competitive-intel/brand-listening.ts", "lib/kernel/lookalike-audience.ts", "app/api/cron/content-intel-exa/route.ts", "app/api/cron/content-intel-rss/route.ts"]
  check("A3 the six producers that inserted directly at the batch-2 base now call intakeTopicIdeas", routed.every((f) => /\bintakeTopicIdeas\s*\(/.test(code(f))), routed.filter((f) => !/\bintakeTopicIdeas\s*\(/.test(code(f))).join(", "))

  // ═══ B — FIVE SIGNAL TYPES, ONE PRODUCER, TRUE MEANINGS ═════════════════════════════════════════════════════════
  console.log("\n[B · signal types reach the one producer with their own meanings]")
  const db = makeDb()
  let transportCalls = 0
  const trends: TrendsTransport = { provider: "recording-trends", rights: "licensed", async fetchRegional() { transportCalls++; return { ok: true, points: [{ term: "flood insurance before closing", geo: { city: "Pensacola", state: "FL" }, relativeIndex: 64, windowStart: iso(30 * DAY), windowEnd: iso(DAY), risingPct: 120 }] } } }
  const tr = await trendsProducer(trends, { geo: GEO, now: NOW })
  const fb = await normalizeFacebookGroupItems([{ text: "Is flood insurance required before closing on a house in Pensacola? We are buying our first home this spring.", likesCount: 12, commentsCount: 30, url: "https://www.facebook.com/groups/pcola/posts/111", time: iso(2 * DAY), user: { id: "u1", name: "Jane Neighbor" }, topComments: [{ text: "x" }] }], { geo: GEO, now: NOW })
  const meta = await normalizeMetaAdItems([{ adArchiveID: "998877", pageID: "pg-rival", pageName: "Rival Realty", collationId: "c1", snapshot: { title: "Is it worth renovating before you sell?", body: { text: "Most sellers over-renovate. Book a free consult with our team." }, displayFormat: "VIDEO" }, startDateFormatted: iso(40 * DAY) }], { geo: GEO, now: NOW })
  const refurbishIdea: TopicIdea = { sourceKind: "refurbish_competitor_post", title: "Should you renovate before selling in Pensacola?", angle: "A checklist of what pays back, from verified local comps", sourceUrl: "https://example.org/rival/post/1", observedAt: NOW.toISOString(), evidence: { kind: "proxy", metric: "exa_citation_rank_score_0_100", value: 71 }, rights: "public_read_reworded" }
  const ideas = [...tr.ideas, ...fb.ideas, ...meta.ideas, refurbishIdea]
  console.log(`    producers: trends ${tr.status} (${tr.ideas.length} idea, ${transportCalls} recorded transport call) · facebook group ${fb.ideas.length} (${fb.droppedPersonFields} person fields dropped) · meta ad ${meta.ideas.length} · refurbish 1`)
  const r1 = await intakeTopicIdeas(db, { brokerageId: A, ideas })
  const manual = await saveManualTopicObservation(db, { brokerageId: A, note: "Buyers keep asking how insurance quotes change their closing timeline" })
  // Support FAQ source (themes only) through the topic-intelligence pass — the real producer, the real intake.
  const tickets = (n: number, lane: string) => Array.from({ length: n }, (_, i) => ({ id: `t-${lane}-${i}`, brokerage_id: A, lane, submitted_by_user_id: `user-${lane}-${i}`, contact_id: null, subject: "Question about closing costs", description: `PRIVATE: my divorce settlement covers this, call 850-555-01${i}9 about my closing costs`, created_at: iso(3 * DAY) }))
  db.tables.support_tickets = [...tickets(3, "user_to_brokerage"), ...tickets(4, "tenant_to_platform").map((t) => ({ ...t, subject: "Closing costs report bug" }))]
  const ti = await runTopicIntelligencePass(db, A, { now: NOW, maxIdeas: 0 })
  const rowsA = db.tables.content_topic_bank.filter((r) => r.brokerage_id === A)
  const byKind = new Map<string, Row>(rowsA.map((r) => [r.raw_data?.intake?.source_kind, r]))
  console.log(`    intake: inserted ${r1.inserted}, excluded ${r1.excluded.length}; manual ${manual.inserted}; topic-intelligence inserted ${ti.inserted} (errors: ${ti.errors.length ? ti.errors.join(" | ") : "none"})`)
  console.log(`    distinct source kinds on stored rows: ${[...byKind.keys()].join(", ")}`)
  const g = byKind.get("google_trends"), f = byKind.get("facebook_group_question"), m = byKind.get("meta_ad_creative"), o = byKind.get("own_observation"), t = rowsA.find((r) => r.raw_data?.intake?.source_kind === "topic_intelligence" && (r.categories ?? []).includes("customer_question")), rf = byKind.get("refurbish_competitor_post")
  check("B1 six distinct signal types landed through the ONE producer (≥ 5 required)", byKind.size >= 6 && [g, f, m, o, t, rf].every(Boolean), [...byKind.keys()].join(","))
  check("B2 Google demand keeps its meaning: PROXY, unit relative_index_0_100 (never searches), rights licensed, geography Pensacola", !!g && g.raw_data.evidence.kind === "proxy" && g.raw_data.evidence.unit === "relative_index_0_100" && g.raw_data.intake.rights === "licensed" && (g.geo_relevance?.cities ?? []).includes("Pensacola"), JSON.stringify(g?.raw_data?.evidence))
  check("B3 public chatter keeps its meaning: MEASURED public counts in unit 'count', rights public_read_reworded, the post's wording and the author NOT stored", !!f && f.raw_data.evidence.kind === "measured" && f.raw_data.evidence.unit === "count" && f.raw_data.evidence.value === 42 && f.raw_data.intake.rights === "public_read_reworded" && !JSON.stringify(f).includes("Jane Neighbor") && !JSON.stringify(f).includes("We are buying our first home"))
  check("B4 a competitor ad keeps its meaning: evidence UNKNOWN (value null, column 0), ad wording not stored", !!m && m.raw_data.evidence.kind === "unknown" && m.raw_data.evidence.value === null && m.engagement_score === 0 && !JSON.stringify(m).includes("over-renovate"))
  check("B5 the subscriber's own note is own_content with unknown evidence; the support / customer-question theme is first_party PROXY (a priority heuristic, not engagement)", !!o && o.raw_data.intake.rights === "own_content" && o.raw_data.evidence.kind === "unknown" && !!t && t.raw_data.intake.rights === "first_party" && t.raw_data.evidence.kind === "proxy" && /^priority_from_/.test(t.raw_data.evidence.metric))
  check("B6 observed / published dates and expiry are kept per source (provenance entry) and every row expires", rowsA.every((r) => typeof r.expires_at === "string" && Array.isArray(r.raw_data?.provenance) && r.raw_data.provenance.every((p: Row) => typeof p.observed_at === "string" && "published_at" in p)))
  // the same public post seen again by another transport is ONE observation
  const again = await normalizeFacebookGroupItems([{ text: "Is flood insurance required before closing on a house in Pensacola? We are buying our first home this spring.", likesCount: 15, commentsCount: 31, url: "https://www.facebook.com/groups/pcola/posts/111?utm_source=x", time: iso(2 * DAY) }], { geo: GEO, now: NOW })
  const r2 = await intakeTopicIdeas(db, { brokerageId: A, ideas: again.ideas.map((i) => ({ ...i, brief: { ...(i.brief ?? {}), transport: "zyte" } })) })
  const f2 = db.tables.content_topic_bank.find((r) => r.id === f?.id)
  check("B7 a repeated article counts ONCE: merged, sameObservation 1, independent_observations stays 1, both transports linked", r2.merged === 1 && r2.sameObservation === 1 && f2?.raw_data.independent_observations === 1 && (f2?.raw_data.provenance[0].transports ?? []).includes("zyte"), JSON.stringify({ merged: r2.merged, same: r2.sameObservation, obs: f2?.raw_data.independent_observations }))
  const joining = await intakeTopicIdeas(db, { brokerageId: A, ideas: [{ sourceKind: "competitor_post", title: "Please welcome our newest agent to the team!", observedAt: NOW.toISOString(), evidence: { kind: "unknown" }, rights: "public_read_reworded" }] })
  check("B8 NEGATIVE: an agent-joining announcement never enters the pool (R9)", joining.inserted === 0 && joining.excluded[0]?.reason === "competitor_agent_joining")
  check("B9 a civic local fact ('grand opening of the new library') is NOT removed by the competitor brand rule; a competitor's is", !classifyTopicExclusion({ title: "Grand opening of the new Pensacola library branch", sourceKind: "local_fact" }).excluded && classifyTopicExclusion({ title: "Grand opening of our new office", sourceKind: "competitor_post" }).excluded)

  // ═══ C — THE TENANT MARKETER SEES THEIR LOCALIZED TOPIC AND IT REACHES THE DRAFT ═════════════════════════════════
  console.log("\n[C · own localized topic → the draft prompt (cross-lane D1)]")
  // The BASE intake stored geo_relevance as the idea's { city, state } — plant one such row as the control.
  db.tables.content_topic_bank.push({ id: "base-shape-geo", source_id: g?.source_id, brokerage_id: A, topic_title: "Base-shape geo control topic", categories: [], engagement_score: g?.engagement_score ?? 64, performance_score: 0, status: "fresh", expires_at: new Date(NOW.getTime() + 10 * DAY).toISOString(), scraped_at: NOW.toISOString(), topic_posted_at: null, geo_relevance: { city: "Pensacola", state: "FL" }, raw_data: {} })
  const picked = await pickTopics({ brokerageId: A, limit: 25, recipientLocation: { city: "Pensacola", state: "FL" }, client: db as any })
  const pg = picked.find((p) => p.id === g?.id), ctl = picked.find((p) => p.id === "base-shape-geo")
  check("C1 the topic filed through the intake carries the reader's geo shape and earns the picker's geo match", !!pg && pg.geo_match === true && Array.isArray(g?.geo_relevance?.cities), JSON.stringify(g?.geo_relevance))
  check("C2 POSITIVE CONTROL: a row in the base intake's { city, state } shape gets NO geo match (the defect the fix removes)", !!ctl && ctl.geo_match === false)
  check("C3 the candidate carries its own evidence (proxy, relative index metric, licensed) and the Refurbish trigger it can offer", !!pg && pg.evidence_kind === "proxy" && pg.rights === "licensed" && pg.refurbish_trigger_kind === "google_trend")
  const prompt = renderTopicsForPrompt(picked.filter((p) => p.id === g?.id))
  check("C4 the topic reaches the writers' draft prompt (renderTopicsForPrompt — the lead content of podcast / newsletter / blog drafts)", prompt.includes(g?.topic_title ?? "@@") && /LOCAL TO THIS BROKERAGE/.test(prompt))

  // ═══ D — A SECOND TENANT ════════════════════════════════════════════════════════════════════════════════════════
  console.log("\n[D · a second tenant]")
  const pickedB = await pickTopics({ brokerageId: B, limit: 25, client: db as any })
  check("D1 tenant B's pool contains none of tenant A's topics (nor their evidence)", pickedB.every((p) => !rowsA.some((r) => r.id === p.id)) && !JSON.stringify(pickedB).includes("Pensacola"), `${pickedB.length} rows`)
  db.tables.approval_items = [{ id: "ap1", brokerage_id: A, item_type: "topic_campaign_idea", item_id: g?.id, status: "approved", reviewed_by: "user-a", reviewed_at: NOW.toISOString() }]
  const apA = await readTopicApproval(db, A, g!.id, { now: NOW }), apB = await readTopicApproval(db, B, g!.id, { now: NOW })
  check("D2 tenant B cannot pass tenant A's topic approval; tenant A can (positive control)", apA.approved === true && apB.approved === false, `${apA.reason} / ${apB.reason}`)
  const cv = code("app/actions/custom-video.ts"), cs = code("app/actions/content-studio.ts")
  check("D3 the creative doors take the tenant from the SESSION, never the body (createDescribedVideoAction, generateContentIdeas) and read a picked topic only inside the tenant's pool",
    /const \{ userId, brokerageId \} = auth\.caller/.test(cv) && !/input\.brokerageId/.test(cv) && /\.or\(`brokerage_id\.is\.null,brokerage_id\.eq\.\$\{brokerageId\}`\)/.test(cv) && /brokerage_id\.eq\.\$\{auth\.brokerageId\}/.test(cs))

  // ═══ E — SUPPORT FAQ LEAKS NO PRIVATE TICKET TEXT ═════════════════════════════════════════════════════════════
  console.log("\n[E · support FAQ source]")
  const bankJson = JSON.stringify(db.tables.content_topic_bank)
  check("E1 three distinct user_to_brokerage askers produced a customer-question theme sourced from support tickets (label + count)", !!t && /support_tickets/.test(t.raw_data.topic_evidence?.source ?? "") && t.raw_data.topic_evidence?.engagement?.metrics?.distinct_askers === 3, JSON.stringify(t?.raw_data?.topic_evidence?.engagement))
  check("E2 NO private ticket text anywhere in the pool (no 'divorce', no phone number, no ticket subject wording)", !/divorce|555-01|PRIVATE/.test(bankJson))
  check("E3 tenant_to_platform (software-support) tickets are not read as consumer questions (4 such tickets did not raise the count)", t?.raw_data.topic_evidence?.engagement?.metrics?.distinct_askers === 3)
  const db2 = makeDb({ support_tickets: tickets(2, "user_to_brokerage") })
  await runTopicIntelligencePass(db2, A, { now: NOW, maxIdeas: 0 })
  check("E4 THRESHOLD CONTROL: two askers raise NO theme (one person's question never becomes public content)", !(db2.tables.content_topic_bank ?? []).some((r) => (r.categories ?? []).includes("customer_question")))

  // ═══ F — MARKET-REPORT FIGURES FROM MARKET FACTS ════════════════════════════════════════════════════════════════
  console.log("\n[F · market report figures]")
  const mr = readdirSync(join(ROOT, "lib/market-reports")).filter((x) => x.endsWith(".ts")).map((x) => `lib/market-reports/${x}`)
  const PROXY = /\.from\(\s*["'`](?:content_topic_bank|keyword_intelligence|competitor_content)["'`]\s*\)|search_volume_monthly|engagement_score/
  const offenders = mr.filter((p) => PROXY.test(blankStrings(code(p)).replace(/\s+/g, " ")) || /\.from\(\s*["'`](?:content_topic_bank|keyword_intelligence|competitor_content)["'`]/.test(code(p)))
  check(`F1 no market-report module (${mr.length} files) reads the topic pool, keyword proxies or competitor engagement`, offenders.length === 0, offenders.join(", "))
  check("F2 the report's figures read market facts (market_data / market_trends / sold listings)", /\.from\("market_data"\)/.test(code("lib/market-reports/research.ts")) && /\.from\("market_trends"\)/.test(code("lib/market-reports/research.ts")))
  check("F3 POSITIVE CONTROL: the finder sees a planted keyword-proxy read", /\.from\(\s*["'`](?:content_topic_bank|keyword_intelligence|competitor_content)["'`]/.test(`const k = await svc.from("keyword_intelligence").select("search_volume_monthly")`))

  // ═══ G — LINEAGE OF THE CREATIVE ═══════════════════════════════════════════════════════════════════════════════
  console.log("\n[G · topic → staged asset lineage]")
  const pa = code("lib/content-intel/performance-aggregator.ts")
  check("G1 a staged video from a picked topic records the claim AFTER the asset exists: topic → asset id → claiming agent (content_topic_uses)",
    /if \(topic && r\.status === "staged" && r\.videoProjectId\)/.test(cv) && /logTopicUses\(\{ topicIds: \[topic\.id\], brokerageId, assetType: "situational_reel", assetId: r\.videoProjectId, agentId \}\)/.test(cv) && /asset_id/.test(pa) && /agent_id/.test(pa))
  check("G2 the asset is commissioned AS the session's user (the creator's voice / seat) — agentUserId: userId", /commissionCustomVideo\(b\.brief, \{ brokerageId, agentUserId: userId/.test(cv))
  console.log("    PARTIAL (said, not proved here): approved publish → delivery / read-back of that asset is lane 154H's (publish-social-posts / queue-drain); the measured channel status is the aggregator's content_topic_uses × engagement read.")

  // ═══ H — READERS SAY "UNKNOWN" ════════════════════════════════════════════════════════════════════════════════
  console.log("\n[H · readers that mislabeled]")
  check("H1 content studio keyword research: no invented searchVolume / difficulty — null plus a labeled relativeIndex", /searchVolume: null as number \| null/.test(cs) && /difficulty: null as number \| null/.test(cs) && /relativeIndex:/.test(cs) && !/difficulty: 50/.test(cs) && !/popularity_pct \* 100/.test(cs))
  check("H2 competitor content is READ from competitor_content, not generated with 'realistic metrics'", /\.from\("competitor_content"\)/.test(cs) && !/realistic metrics/i.test(cs) && /openRate: null as number \| null/.test(cs))
  check("H3 POSITIVE CONTROL: the H1 finder recognises the base shape", /difficulty: 50/.test(`difficulty: 50, // AI doesn't provide difficulty`) && /popularity_pct \* 100/.test(`searchVolume: Math.round(k.popularity_pct * 100)`))
  const ui = code("app/content-studio/content-studio-client.tsx")
  check("H4 the studio UI renders 'unknown' for null and no invented fallbacks ('High', 'Medium', '2.4K', 'LinkedIn')", /: "unknown"/.test(ui) && !/\|\| "High"/.test(ui) && !/\|\| "2\.4K"/.test(ui) && !/\|\| "LinkedIn"/.test(ui) && !/\|\| "Medium"/.test(ui))
  const sg = code("lib/lead-magnets/suggestions.ts")
  check("H5 lead-magnet keyword evidence says relative_index (ranking unchanged), never search_volume_monthly as an evidence key", /relative_index: vol\.relativeIndex/.test(sg) && !/evidence: \{ search_volume_monthly/.test(sg) && /score: Number\(k\.trend_change_pct \?\? 0\) \+ Number\(k\.search_volume_monthly \?\? 0\) \/ 100/.test(sg))

  // ═══ I — SCHEDULED CALLER · STATEMENT READER · META MIRROR · REFURBISH MAPPING ═════════════════════════════════
  console.log("\n[I · finishing 154C's partials + cross-lane D2 / D3]")
  const reg = code("lib/kernel/cron-dispatch.ts"), comm = "app/api/cron/content-intel-community/route.ts"
  check("I1 the Nextdoor public-post topic research has a scheduled caller: a real route registered in the ONE cron registry", existsSync(join(ROOT, comm)) && /"\/api\/cron\/content-intel-community"/.test(reg) && /researchCommunityPostTopics\(svc,/.test(code(comm)) && /verifyCronAuth\(req\)/.test(code(comm)))
  check("I2 the route makes no paid request without a recorded per-run budget, and never runs a platform-wide source", /held_budget/.test(code(comm)) && /a platform-wide source is not run/.test(read(comm)))
  const firstPerson = fenceUntrusted("We are selling our house in Pensacola this summer and need a realtor.")
  check("I3 D3: the default classifier is the pure readPublicStatement — a first-person post routes first_person_topic_only; an explicit null stays unclassified (control)", routeChatter(firstPerson, "community_post", undefined).route === "first_person_topic_only" && routeChatter(firstPerson, "community_post", null).route === "unclassified_topic")
  const stmt = code("lib/acquisition-plays/public-statement.ts")
  check("I4 the statement reader's module is PURE (no runtime import; the kind type is type-only)", !/^import (?!type )/m.test(stmt) && /export function readPublicStatement/.test(stmt))
  const mirror = meta.competitorAds[0]
  check("I5 a Meta Ad Library item yields its competitor_ads row — ideas only: no ad wording, engagement NULL, archive link + reworded theme kept", !!mirror && mirror.ad_copy === "" && mirror.ad_headline === "" && mirror.engagement_score === null && mirror.provider_ad_id === "998877" && typeof mirror.raw_payload.archive_url === "string" && !JSON.stringify(mirror).includes("over-renovate"))
  const ap = code("app/api/cron/content-intel-apify/route.ts")
  check("I6 the cron writes that row tenant-scoped without an upsert on the GLOBAL partial key, and drops page_id (not a live column)", /\.from\("competitor_ads"\)\.insert\(rowOut\)/.test(ap) && !/\.from\("competitor_ads"\)\.upsert\(/.test(ap) && /\{ page_id, \.\.\.m \}/.test(ap) && /held by another tenant's row/.test(read("app/api/cron/content-intel-apify/route.ts")))
  check("I7 D2: one published mapping from pool source kinds to Refurbish trigger kinds, stamped on every stored row",
    refurbishTriggerKindForTopicSource("google_trends") === "google_trend" && refurbishTriggerKindForTopicSource("community_post") === "public_chatter" && refurbishTriggerKindForTopicSource("meta_ad_creative") === "competitor_watch" && refurbishTriggerKindForTopicSource("local_fact") === null
      && g?.raw_data.intake.refurbish_trigger_kind === "google_trend" && f?.raw_data.intake.refurbish_trigger_kind === "public_chatter" && o?.raw_data.intake.refurbish_trigger_kind === null)

  // I8 — the OTHER competitor_ads writer. MEASURED LIVE 2026-11-18: 0 rows, because its upsert named a GLOBAL PARTIAL unique index
  // PostgREST cannot infer (42P10 — the whole upsert refused). The RULE: an upsert's conflict target leads with the tenant, and a
  // migration creates a unique index on exactly those columns with no WHERE (a partial index is not inferable from a column list).
  const exaAds = code("app/api/cron/competitor-ads-exa/route.ts")
  const conflictTargetOf = (src: string) => /\.from\("competitor_ads"\)\.upsert\([\s\S]*?onConflict:\s*"([^"]+)"/.exec(src)?.[1] ?? null
  const adTarget = conflictTargetOf(exaAds)
  const inferableIndex = (sql: string, cols: string) => new RegExp(`CREATE UNIQUE INDEX[^;]*ON public\\.competitor_ads\\s*\\(\\s*${cols.split(",").map((c) => c.trim()).join("\\s*,\\s*")}\\s*\\)\\s*;`, "i").test(sql)
  const m987 = read("supabase/migrations/m987-competitor-ads-are-unique-per-tenant.sql")
  check("I8 the competitor-ads-exa upsert's conflict target LEADS WITH THE TENANT and a migration creates a NON-PARTIAL unique index on exactly it", !!adTarget && adTarget.split(",")[0].trim() === "brokerage_id" && inferableIndex(m987, adTarget), String(adTarget))
  check("I8-control the finder reads the old global target, and refuses a PARTIAL index as inferable",
    conflictTargetOf('svc.from("competitor_ads").upsert({ a: 1 }, { onConflict: "source_platform,provider_ad_id" })') === "source_platform,provider_ad_id"
      && !inferableIndex("CREATE UNIQUE INDEX x ON public.competitor_ads (source_platform, provider_ad_id) WHERE provider_ad_id IS NOT NULL;", "source_platform,provider_ad_id")
      && inferableIndex("CREATE UNIQUE INDEX x ON public.competitor_ads (brokerage_id, source_platform, provider_ad_id);", "brokerage_id,source_platform,provider_ad_id"))

  // J — A CIRCLE ADAPTATION BELONGS TO ITS MEMBER (wave 154, lane 154H2 — lane 154G3's request). lib/marketing/circle-tactics.ts
  // files a member's adaptation as a topic whose raw_data.circle_adaptation names that member; another agent's picks skip it.
  console.log("\n[J · a circle adaptation belongs to the member who adapted it]")
  {
    const AG1 = "00000000-0000-4000-8000-0000000000c1", AG2 = "00000000-0000-4000-8000-0000000000c2"
    const exp = new Date(NOW.getTime() + 10 * DAY).toISOString()
    const circleRow = (id: string, forAgent: string) => ({ id, source_id: g?.source_id, brokerage_id: A, topic_title: `Circle adaptation ${id}`, categories: [], engagement_score: 99, performance_score: 0, status: "fresh", expires_at: exp, scraped_at: NOW.toISOString(), topic_posted_at: null, geo_relevance: null, raw_data: { brand_owner_user_id: `user-${forAgent}`, circle_adaptation: { for_agent_id: forAgent, for_agent_user_id: `user-${forAgent}` } } })
    db.tables.content_topic_bank.push(circleRow("circle-ag1", AG1), { ...circleRow("plain-control", AG1), raw_data: {} })
    const p1 = await pickTopics({ brokerageId: A, limit: 25, agentId: AG1, client: db as any })
    const p2 = await pickTopics({ brokerageId: A, limit: 25, agentId: AG2, client: db as any })
    const pNone = await pickTopics({ brokerageId: A, limit: 25, client: db as any })
    check("J1 the member who adapted the tactic picks their own adaptation", p1.some((p) => p.id === "circle-ag1"), `${p1.length} picks`)
    check("J2 ANOTHER agent's picks skip it; an asker with no agents.id cannot take it (fail closed)", !p2.some((p) => p.id === "circle-ag1") && !pNone.some((p) => p.id === "circle-ag1"))
    check("J3 POSITIVE CONTROL: a plain topic with the same score is offered to the other agent (the skip is the adaptation, not the fixture)", p2.some((p) => p.id === "plain-control") && pNone.some((p) => p.id === "plain-control"))
  }

  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  console.log(" blind spots: SIMULATED throughout (in-memory client, recording Trends transport, no actor / transport call); the community route")
  console.log("   and the apify mirror are checked on stripped source, not executed (next/server); publish → read-back of a topic-born asset is")
  console.log("   lane 154H's; brand-asset isolation is held by the session-tenant doors (D3), not by a brand-kit fixture.")
  if (failed) { console.log(`FAILURES:\n${fails.map((x) => ` - ${x}`).join("\n")}\n ❌ TOPIC_POOL_FAIL`); process.exit(1) }
  console.log(" ✅ TOPIC_POOL_PASS")
}
main().catch((e) => { console.error(e); process.exit(1) })
