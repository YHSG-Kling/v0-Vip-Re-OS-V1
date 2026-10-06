/**
 * scripts/network-intelligence-guard.ts — test:network-intelligence (wave 107, lane 107F).
 *
 * STRATEGY LEARNING + PRIVACY-SAFE NETWORK BENCHMARKS, proven in memory (no network, no database):
 *   1. k-anonymity: a cell below k tenants / n events / with a dominant tenant is suppressed — with a
 *      POSITIVE CONTROL (the same cell at k tenants publishes) and a policy floor a caller cannot lower;
 *   2. no tenant id and no person id in any published cell (scan of every value, positive control: the
 *      scanner finds an id planted in a copy); an id-shaped segment is dropped, never published;
 *   3. an opted-OUT tenant contributes nothing (its provider never appears; the pooled rate equals the
 *      opted-in tenants' rate; opting it in changes the rate — positive control);
 *   4. compareStrategies significance controls (a_better / b_better / no_difference / insufficient_sample);
 *   5. tenant isolation (one tenant's comparison never counts another tenant's rows);
 *   6. strategy attribution (detail.strategy → byStrategy with key@version; malformed keys refused);
 *   7. the finding is an improvement proposal (subject strategy, proposer strategy_learning, authority 6);
 *   8. wiring, read from STRIPPED source with positive controls; vocabulary derived from the latest migration.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { publishBenchmarkCells, runNetworkBenchmarkAggregation, type TenantContribution } from "../lib/intelligence/network-benchmarks"
import { strategySignificance, strategyFinding, compareStrategies, runStrategyLearning } from "../lib/intelligence/strategy-learning"
import { attributeOutcomesToLedger, strategyRefOf } from "../lib/intelligence/roi-ledger"
import { PROPOSAL_SUBJECT_KINDS, PROPOSERS, PROPOSAL_AUTHORITY, OWNER_AUTHORITY_LEVEL } from "../lib/kernel/improvement-proposals"
import { TENANT_POLICY_SETTINGS_KEYS } from "../lib/kernel/tenant-policy"
import { MAINTENANCE_DOMAINS, TABLE_MANAGER } from "../lib/kernel/manager-registry"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"

const root = process.cwd()
let failed = 0, passed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  PASS ${name}`) } else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (rel: string) => stripComments(readFileSync(join(root, rel), "utf8"))

// ── in-memory supabase: eq/in/gte/is/not filters, insert/upsert, order/limit, maybeSingle ─────────
type Row = Record<string, any>
function fakeSvc(tables: Record<string, Row[]>) {
  let seq = 0
  const builder = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let op: "select" | "insert" | "upsert" = "select", payload: Row[] = [], lim = Infinity, single = false, order: { c: string; asc: boolean } | null = null, conflict: string[] = []
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b },
      in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return b },
      gte: (c: string, v: unknown) => { filters.push((r) => r[c] != null && String(r[c]) >= String(v)); return b },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b },
      not: (c: string) => { const [col, key] = c.split("->"); filters.push((r) => (key ? r[col]?.[key] : r[col]) != null); return b },
      or: () => b, ilike: () => b,
      order: (c: string, o?: { ascending?: boolean }) => { order = { c, asc: o?.ascending !== false }; return b },
      limit: (n: number) => { lim = n; return b },
      maybeSingle: () => { single = true; return b },
      insert: (rows: Row | Row[]) => { op = "insert"; payload = Array.isArray(rows) ? rows : [rows]; return b },
      upsert: (rows: Row[], o?: { onConflict?: string }) => { op = "upsert"; payload = rows; conflict = (o?.onConflict ?? "").split(","); return b },
      then: (res: (v: any) => any, rej?: (e: any) => any) => {
        try {
          const t = (tables[table] ??= [])
          if (op !== "select") {
            const out: Row[] = []
            for (const p of payload) {
              const row = { id: `row-${++seq}`, ...p }
              const i = op === "upsert" ? t.findIndex((r) => conflict.every((c) => r[c] === p[c])) : -1
              if (i >= 0) t[i] = { ...t[i], ...p }; else t.push(row)
              out.push(i >= 0 ? t[i] : row)
            }
            return Promise.resolve({ data: out, error: null }).then(res, rej)
          }
          let rows = t.filter((r) => filters.every((f) => f(r)))
          if (order) { const o = order; rows = [...rows].sort((x, y) => (String(x[o.c]) < String(y[o.c]) ? -1 : 1) * (o.asc ? 1 : -1)) }
          rows = rows.slice(0, lim)
          return Promise.resolve({ data: single ? rows[0] ?? null : rows, error: null, count: rows.length }).then(res, rej)
        } catch (e) { return Promise.reject(e).then(res, rej) }
      },
    }
    return b
  }
  return { from: (t: string) => builder(t), tables }
}

const NOW = new Date("2026-10-06T12:00:00Z")
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
const uuid = (p: string, n: number) => `${p}${String(n).padStart(4, "0")}-0000-4000-8000-000000000000`.slice(0, 36)

;(async () => {
  // ── 1. k-anonymity (pure) ─────────────────────────────────────────────────────────────────
  console.log("\n[1 — k-anonymity suppression]")
  const period = { start: "2026-07-08", end: "2026-10-06" }
  const cell = (tenants: number, eventsEach: number, extra: Partial<TenantContribution> = {}): TenantContribution[] =>
    Array.from({ length: tenants }, (_, i) => ({ tenant: uuid("b", i + 1), metric: "channel_response", segment: { channel: "sms" }, numerator: Math.floor(eventsEach / 3), denominator: eventsEach, events: eventsEach, ...extra }))
  const four = publishBenchmarkCells(cell(4, 20), period)
  const five = publishBenchmarkCells(cell(5, 20), period)
  check("a cell with 4 tenants (k = 5) is SUPPRESSED", four.cells.length === 0 && four.suppressed.belowTenants === 1)
  check("POSITIVE CONTROL: the same cell with 5 tenants PUBLISHES with its pooled rate", five.cells.length === 1 && five.cells[0].tenant_count === 5 && five.cells[0].rate === 0.3, JSON.stringify(five.cells[0]))
  check("a cell below n events is suppressed (5 tenants × 2 events < 30)", publishBenchmarkCells(cell(5, 2), period).suppressed.belowEvents === 1)
  const dom = [...cell(4, 2), { tenant: uuid("b", 9), metric: "channel_response" as const, segment: { channel: "sms" }, numerator: 10, denominator: 100, events: 100 }]
  check("a cell where one tenant holds > 60 % of the events is suppressed (dominance)", publishBenchmarkCells(dom, period).suppressed.dominance === 1)
  check("the policy floor holds: k = 1 asked → still clamped to ≥ 3 (a 2-tenant cell stays suppressed)", publishBenchmarkCells(cell(2, 40), period, { minTenants: 1, minEvents: 1 }).cells.length === 0)
  const unsafe = publishBenchmarkCells(cell(5, 20, { segment: { channel: uuid("c", 7) } }), period)
  check("an id-shaped segment value is DROPPED, never published", unsafe.cells.length === 0 && unsafe.suppressed.unsafeSegment === 1)
  check("free text in a segment is dropped (spaces / capitals)", publishBenchmarkCells(cell(5, 20, { segment: { channel: "Jane Doe's list" } }), period).cells.length === 0)

  // ── 2 + 3. aggregation over six tenants: anonymity + opt-out ───────────────────────────────
  console.log("\n[2/3 — published cells carry no ids; an opted-out tenant contributes nothing]")
  const T = Array.from({ length: 6 }, (_, i) => uuid("a", i + 1))
  const personIds: string[] = []
  const build = (optInSix: boolean) => {
    const tables: Record<string, Row[]> = { brokerages: [], brokerage_settings: [], leads: [], agent_action_ledger: [], isa_outreach_log: [], marketing_assets: [], learning_assignments: [], learning_modules: [], network_benchmarks: [] }
    T.forEach((b, i) => {
      tables.brokerages.push({ id: b, state: "TX", deleted_at: null })
      tables.brokerage_settings.push({ brokerage_id: b, settings: { network_benchmarks_opt_in: { opted_in: i < 5 || optInSix } } })
      const convertedOf10 = i === 5 ? 10 : 3
      for (let n = 0; n < 10; n++) {
        const id = uuid(`${i}e`, n); personIds.push(id)
        tables.leads.push({ id, brokerage_id: b, lead_type: "buyer", converted_at: n < convertedOf10 ? daysAgo(5) : null, created_at: daysAgo(20) })
      }
      for (let n = 0; n < 8; n++) tables.agent_action_ledger.push({ id: uuid(`${i}f`, n), brokerage_id: b, provider: i === 5 ? "secret_provider" : "twilio", status: n < 7 ? "executed" : "failed", created_at: daysAgo(10), settled_at: daysAgo(10), detail: {} })
      for (let n = 0; n < 8; n++) tables.isa_outreach_log.push({ id: uuid(`${i}d`, n), brokerage_id: b, channel: "sms", sent_at: daysAgo(9), replied_at: n < 2 ? daysAgo(8) : null })
    })
    return fakeSvc(tables)
  }
  const out = build(false)
  const run = await runNetworkBenchmarkAggregation(out, { now: NOW })
  const pub = out.tables.network_benchmarks
  check(`the aggregation ran over 6 tenants: 5 contributing, 1 opted out (written ${run.written})`, run.brokerages === 6 && run.contributing === 5 && run.optedOut === 1 && run.written === pub.length && pub.length > 0, JSON.stringify(run))
  const blob = JSON.stringify(pub)
  const leaks = [...T, ...personIds].filter((id) => blob.includes(id))
  check(`no tenant id and no person id in any of ${pub.length} published cells`, leaks.length === 0, leaks.slice(0, 3).join(","))
  check("POSITIVE CONTROL: the id scanner finds a tenant id planted in a copy", [...T].some((id) => JSON.stringify([...pub, { x: T[2] }]).includes(id)))
  check("no published cell has a tenant or person column", pub.every((c) => !("brokerage_id" in c) && !("contact_id" in c) && !("lead_id" in c) && !("tenant" in c)))
  check("the opted-out tenant's provider never appears in any cell", !blob.includes("secret_provider"))
  const conv = pub.find((c) => c.metric === "brokerage_conversion")
  check("the brokerage-conversion cell pools ONLY the opted-in tenants (15 of 50 = 0.3, 5 tenants)", !!conv && conv.rate === 0.3 && conv.tenant_count === 5 && conv.market_band === "gulf_coast", JSON.stringify(conv))
  const both = build(true)
  await runNetworkBenchmarkAggregation(both, { now: NOW })
  const conv6 = both.tables.network_benchmarks.find((c) => c.metric === "brokerage_conversion")
  check("POSITIVE CONTROL: opting the sixth tenant IN changes the pooled rate (25 of 60) and the tenant count", !!conv6 && conv6.tenant_count === 6 && Math.abs(conv6.rate - 25 / 60) < 1e-3, JSON.stringify(conv6))
  check("a single-tenant provider stays suppressed even when that tenant opts in (k)", !JSON.stringify(both.tables.network_benchmarks).includes("secret_provider"))

  // ── 4. significance controls ──────────────────────────────────────────────────────────────
  console.log("\n[4 — compareStrategies significance controls]")
  check("A clearly better (15/30 vs 3/30) → a_better", strategySignificance({ exposures: 30, conversions: 15 }, { exposures: 30, conversions: 3 }).verdict === "a_better")
  check("mirror (3/30 vs 15/30) → b_better", strategySignificance({ exposures: 30, conversions: 3 }, { exposures: 30, conversions: 15 }).verdict === "b_better")
  check("close rates (10/100 vs 11/100) → no_difference", strategySignificance({ exposures: 100, conversions: 10 }, { exposures: 100, conversions: 11 }).verdict === "no_difference")
  check("thin data (10/20 vs 1/20) → insufficient_sample, never a verdict", strategySignificance({ exposures: 20, conversions: 10 }, { exposures: 20, conversions: 1 }).verdict === "insufficient_sample")
  const platformB = strategySignificance({ exposures: 400, conversions: 20 }, { exposures: 400, conversions: 60 })
  const tenantA = strategySignificance({ exposures: 40, conversions: 12 }, { exposures: 40, conversions: 2 })
  const f = strategyFinding("seller_equity", "expired_listing", tenantA, platformB)
  check("the owner's finding: 'Strategy B works platform-wide, but A works better for this brokerage'", !!f && f.divergesFromPlatform && /^Strategy expired_listing works platform-wide, but seller_equity works better for this brokerage/.test(f.statement), f?.statement)
  check("POSITIVE CONTROL: no divergence sentence when the platform agrees", !strategyFinding("seller_equity", "expired_listing", tenantA, strategySignificance({ exposures: 400, conversions: 60 }, { exposures: 400, conversions: 20 }))?.divergesFromPlatform)

  // ── 5 + 6. strategy attribution + tenant isolation (behavioural, through the ledger) ──────
  console.log("\n[5/6 — strategy attribution + tenant isolation]")
  check("strategyRefOf: { key, version } → key@vN; 'key@v3' string → key@v3; bare key → key", strategyRefOf({ strategy: { key: "seller_equity", version: 2 } })?.ref === "seller_equity@v2" && strategyRefOf({ strategy: "fsbo@v3" })?.ref === "fsbo@v3" && strategyRefOf({ strategy: "fsbo" })?.ref === "fsbo")
  check("POSITIVE CONTROL: free text / a bad version is NOT a strategy", strategyRefOf({ strategy: { key: "Seller Equity!" } }) === null && strategyRefOf({ strategy: "fsbo@vabc" }) === null && strategyRefOf({}) === null)
  const [B1, B2] = [uuid("c1", 1), uuid("c2", 2)]
  const st: Record<string, Row[]> = { agent_action_ledger: [], transactions: [], showings: [], communications: [], isa_outreach_log: [], leads: [], contact_suppression_list: [], network_benchmarks: [], improvement_proposals: [] }
  const seed = (b: string, key: string, version: number, n: number, converted: number, tag: string) => {
    for (let i = 0; i < n; i++) {
      const contact = uuid(`${tag}`, i)
      st.agent_action_ledger.push({ id: uuid(`${tag}9`, i), brokerage_id: b, action: "campaign.send", status: "executed", reason_code: "CAMPAIGN_STEP_DUE", actor_type: i % 4 === 0 ? "user" : "system", actor_manager_key: "campaign_orchestrator", system_source: "campaign", subject_type: "contact", subject_id: contact, created_at: daysAgo(40), correlation_id: null, cost_usd: 0.5, detail: { strategy: { key, version } } })
      if (i < converted) st.transactions.push({ id: uuid(`${tag}7`, i), brokerage_id: b, status: "closed", buyer_contact_id: contact, seller_contact_id: null, contact_id: null, contract_date: daysAgo(10), close_date: daysAgo(2), commission_amount: 100, estimated_commission: null, deleted_at: null })
    }
  }
  seed(B1, "seller_equity", 2, 40, 12, "aa")
  seed(B1, "expired_listing", 1, 40, 2, "ab")
  seed(B2, "expired_listing", 1, 60, 50, "ba")
  seed(B2, "seller_equity", 2, 60, 1, "bb")
  st.contact_suppression_list.push({ brokerage_id: B1, contact_id: uuid("ab", 5), suppression_reason: "spam complaint", source: "carrier", created_at: daysAgo(5) })
  st.contact_suppression_list.push({ brokerage_id: B1, contact_id: uuid("ab", 6), suppression_reason: "unsubscribe", source: "link", created_at: daysAgo(5) })
  const svc = fakeSvc(st)
  const c1 = await compareStrategies(svc, B1, "seller_equity", "expired_listing", { days: 90, now: NOW })
  const a = c1.ok ? (c1.comparison.a as any) : null, b = c1.ok ? (c1.comparison.b as any) : null
  check("tenant B1: 40 vs 40 exposures, 12 vs 2 conversions → seller_equity better (a_better)", c1.ok && a.exposures === 40 && b.exposures === 40 && a.conversions === 12 && b.conversions === 2 && c1.comparison.significance.verdict === "a_better", JSON.stringify(c1.ok ? c1.comparison.significance : c1))
  check("the comparison carries revenue, cost, complaints, opt-outs, time-to-conversion, workload + an interval", c1.ok && a.revenueCents === 120000 && a.costUsd === 20 && b.complaints === 1 && b.optOuts === 1 && a.medianDaysToConversion === 30 && a.humanTouchesPerSubject === 0.25 && Array.isArray(a.interval), JSON.stringify(a))
  const c2 = await compareStrategies(svc, B2, "seller_equity", "expired_listing", { days: 90, now: NOW })
  check("TENANT ISOLATION: B2's comparison counts only B2's rows (60/60) and reaches the opposite verdict", c2.ok && (c2.comparison.a as any).exposures === 60 && (c2.comparison.b as any).conversions === 50 && c2.comparison.significance.verdict === "b_better")
  const attr = attributeOutcomesToLedger(
    [{ ref: "closed:t1", kind: "closed", brokerageId: B1, subjectIds: ["p1"], at: daysAgo(1), revenueCents: 5000 }],
    [{ id: "x1", brokerage_id: B1, action: "campaign.send", status: "executed", reason_code: "R", actor_type: "system", subject_type: "contact", subject_id: "p1", created_at: daysAgo(3), detail: { strategy: { key: "fsbo", version: 4 } } },
     { id: "x2", brokerage_id: B2, action: "campaign.send", status: "executed", reason_code: "R", actor_type: "system", subject_type: "contact", subject_id: "p1", created_at: daysAgo(2), detail: { strategy: { key: "other", version: 1 } } }],
  )
  check("byStrategy credits the outcome to fsbo@v4 (last touch) and never to the other tenant's row", attr.byStrategy.length === 1 && attr.byStrategy[0].key === "fsbo@v4" && attr.byStrategy[0].lastTouchCents === 5000)

  // ── 7. the finding is a proposal ──────────────────────────────────────────────────────────
  console.log("\n[7 — the finding is an improvement proposal a human approves]")
  st.network_benchmarks.push(
    { period_end: "2026-10-05", metric: "strategy_conversion", strategy_key: "expired_listing@v1", cell_key: "strategy_conversion|*|expired_listing@v1|*|*|*|*", rate: 0.15, sample_size: 400, mean: null, tenant_count: 7 },
    { period_end: "2026-10-05", metric: "strategy_conversion", strategy_key: "seller_equity@v2", cell_key: "strategy_conversion|*|seller_equity@v2|*|*|*|*", rate: 0.05, sample_size: 400, mean: null, tenant_count: 7 },
  )
  const lr = await runStrategyLearning(svc, B1, { now: NOW })
  const props = st.improvement_proposals.filter((p) => p.brokerage_id === B1)
  check(`runStrategyLearning wrote ONE proposal for B1 (pairs ${lr.pairs}, proposed ${lr.proposed})`, lr.proposed === 1 && props.length === 1 && props[0].subject_kind === "strategy" && props[0].proposer === "strategy_learning" && props[0].authority_required === OWNER_AUTHORITY_LEVEL, JSON.stringify(lr))
  check("the proposal carries the divergence statement from the platform cells", /works platform-wide, but seller_equity@v2 works better for this brokerage/.test(String(props[0]?.proposed_change?.statement ?? "")), String(props[0]?.proposed_change?.statement))
  const again = await runStrategyLearning(svc, B1, { now: NOW })
  check("idempotent: a second run reuses the open proposal", again.existing === 1 && again.proposed === 0 && st.improvement_proposals.filter((p) => p.brokerage_id === B1).length === 1)
  check("vocabulary: strategy / strategy_learning are in the code constants; strategy is owner-level", (PROPOSAL_SUBJECT_KINDS as readonly string[]).includes("strategy") && (PROPOSERS as readonly string[]).includes("strategy_learning") && PROPOSAL_AUTHORITY.strategy === OWNER_AUTHORITY_LEVEL)
  const migs = readdirSync(join(root, "supabase/migrations")).filter((n) => n.endsWith(".sql")).sort()
  const latestDefiner = (constraint: string) => [...migs].reverse().find((n) => new RegExp(`${constraint}\\s*CHECK`).test(readFileSync(join(root, "supabase/migrations", n), "utf8")))
  const listOf = (file: string | undefined, constraint: string) => { if (!file) return [] as string[]; const m = new RegExp(`${constraint}\\s*CHECK\\s*\\(\\s*\\w+\\s+IN\\s*\\(([^)]*)\\)`, "s").exec(readFileSync(join(root, "supabase/migrations", file), "utf8")); return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [] }
  const pk = listOf(latestDefiner("improvement_proposals_proposer_check"), "improvement_proposals_proposer_check")
  const sk = listOf(latestDefiner("improvement_proposals_subject_kind_check"), "improvement_proposals_subject_kind_check")
  check("the LATEST defining migration's CHECKs hold every code value (superset rule)", PROPOSERS.every((p) => pk.includes(p)) && PROPOSAL_SUBJECT_KINDS.every((k) => sk.includes(k)), `proposers ${pk.join(",")} kinds ${sk.join(",")}`)

  // ── 8. wiring + schema (stripped source) ─────────────────────────────────────────────────
  console.log("\n[8 — wiring, consent, schema]")
  const nb = src("lib/intelligence/network-benchmarks.ts")
  const writerRe = /\.from\("network_benchmarks"\)\s*\.(insert|upsert|update|delete)\(/
  const writers: string[] = []
  const walk = (d: string): string[] => readdirSync(join(root, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === "node_modules" || e.name.startsWith(".") ? [] : walk(join(d, e.name))) : /\.(ts|tsx)$/.test(e.name) ? [join(d, e.name)] : [])
  for (const f of [...walk("app"), ...walk("lib")]) if (writerRe.test(src(f))) writers.push(f)
  check(`network_benchmarks has exactly ONE writer (${writers.join(", ")})`, writers.length === 1 && writers[0] === join("lib", "intelligence", "network-benchmarks.ts"))
  check("POSITIVE CONTROL: the writer regex sees an upsert", writerRe.test(`svc.from("network_benchmarks").upsert(rows)`))
  check("contribution is gated by the consent reader (readNetworkOptIn before collect) and default is NOT contributing", /if \(!\(await readNetworkOptIn\(svc, b\.id\)\)\) \{ run\.optedOut\+\+; continue \}/.test(nb) && /opted_in === true/.test(nb) && /opted OUT/.test(TENANT_POLICY_SETTINGS_KEYS.network_benchmarks_opt_in?.defaultNote ?? ""))
  const mig = readFileSync(join(root, "supabase/migrations", migs.find((n) => /network-benchmarks/.test(n)) ?? "missing"), "utf8")
  const create = /CREATE TABLE IF NOT EXISTS public\.network_benchmarks \(([\s\S]*?)\n\);/.exec(mig)?.[1] ?? ""
  check("the table has NO tenant / person column and enforces k/n by CHECK", create.length > 0 && !/brokerage_id|contact_id|lead_id|user_id|agent_id/.test(create) && /k_min >= 3 AND n_min >= 10 AND tenant_count >= k_min/.test(create))
  check("POSITIVE CONTROL: the column scan sees brokerage_id in m709's CREATE", /brokerage_id/.test(readFileSync(join(root, "supabase/migrations", migs.find((n) => n.startsWith("m709"))!), "utf8")))
  check("line 1 is the lane stamp or an applied stamp", /^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE )/.test(mig))
  const act = src("app/actions/network-intelligence.ts")
  check("the actions take the tenant from the SESSION (requireCallerTenant) and no export takes a brokerageId", /^"use server"/.test(act.trim()) && /requireCallerTenant\(\)/.test(act) && !/export async function \w+\([^)]*brokerage/i.test(act) && /policy: \{ type: "user"/.test(act))
  check("the Command Center renders the benchmark card", /<NetworkBenchmarksCard \/>/.test(src("app/dashboard/admin/command-center/command-center-client.tsx")) && /getNetworkBenchmarksBeside\(\)/.test(src("app/dashboard/admin/command-center/network-benchmarks-card.tsx")))
  check("the platform cron is registered and runs aggregation then strategy learning", CRON_REGISTRY.some((c) => c.path === "/api/cron/network-intelligence") && /runNetworkBenchmarkAggregation\(svc\)[\s\S]*runStrategyLearning\(svc, b\.id\)/.test(src("app/api/cron/network-intelligence/route.ts")))
  check("improvement-proposals evaluates a strategy proposal by RE-MEASURING (compareStrategies)", /case "strategy": \{[\s\S]*compareStrategies\(svc, row\.brokerage_id/.test(src("lib/kernel/improvement-proposals.ts")))
  check("roi-ledger rolls up byStrategy through strategyRefOf", /strategy: strategyRefOf\(d\)\?\.ref \?\? null/.test(src("lib/intelligence/roi-ledger.ts")) && /byStrategy: roll\("strategy"\)/.test(src("lib/intelligence/roi-ledger.ts")))
  const pkg = readFileSync(join(root, "package.json"), "utf8")
  check("registered as test:network-intelligence and IN the guard chain (membership, not position)", /"test:network-intelligence":/.test(pkg) && new RegExp("npm run test:network-intelligence(\\s|&|$|\")").test(pkg))
  check("MAINTENANCE_DOMAINS owns the proof and TABLE_MANAGER owns the table", (MAINTENANCE_DOMAINS as any).network_intelligence?.proof === "test:network-intelligence" && TABLE_MANAGER.network_benchmarks === "data_steward")
  check("migration file present", existsSync(join(root, "supabase/migrations")) && mig.length > 0)

  console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
