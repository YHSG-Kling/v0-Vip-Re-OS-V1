#!/usr/bin/env tsx
/**
 * scripts/fatigue-population-guard.ts   (npm run test:fatigue-population) — pure, no network, no DB.
 *
 * WAVE 87 (lane 87A). Owner, verbatim: "fatigue sweeps run for the platform on tenants and
 * brokerage on leads and contacts which is user run. should be run on how the fatigue calculation
 * is derived."
 *
 * ONE calculator (lib/fatigue/fatigue-calculator.ts calculateFatigue), ONE sweep core
 * (runFatigueSweep), TWO scopes: the platform cron (app/api/fatigue/cron, every tenant) and the
 * brokerage's user-run Recalculate (app/actions/buyer-fatigue.ts recalculateBrokerageFatigue,
 * session tenant). The population is DERIVED FROM THE CALCULATION'S INPUTS, never a stage list.
 *
 *   F1 derivation — the four inputs calculateFatigue reads ARE FATIGUE_INPUT_SOURCES, read through
 *      the one reader fatigueInput; the population loader walks the same list. POSITIVE CONTROL: a
 *      calculator that reads an input table directly (bypassing the reader) is flagged.
 *   F2 the population, against an in-memory double — people named by an input are IN (a
 *      DISENGAGED buyer included); a stage-ladder buyer with NO input is OUT; concluded searches,
 *      soft-deleted and tenantless contacts are OUT; a lead's conversion contact is tagged; the
 *      unconverted leads are counted, never scored; tenant scope pins EVERY read; platform scope
 *      spans tenants; paging past one page; stalest-first order; a refused read THROWS.
 *   F3 wiring + cost — cron → platformScope after verifyCronAuth; door → tenantScope(session)
 *      after the admin gate; per-run cap + bounded concurrency; recovery plan only on a NEW alert;
 *      calculateFatigue pins the contact to the tenant, reads every input error, COUNTS its write;
 *      model calls routed + booked under a routing key that exists.
 *   F4 agents see contacts only — the three brokerage-wide list readers resolve the viewer first;
 *      an agent is narrowed to their own book; the agent name crosses agents.user_id (§3).
 *   F5 registration.
 *
 * Owner: data_steward. Co-owners named in prose: cron_manager (the platform sweep's schedule) and
 * shopping_agent (buyer_fatigue_scores' table owner).
 */
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { stripComments, blankStrings } from "./strip-comments"

// fatigue-calculator imports `server-only`; neutralise it BEFORE the dynamic import
// (the scripts/accounting-scopes-simulator.ts idiom).
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not resolvable — nothing to shim */ }

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(p, "utf8")
const code = (p: string) => blankStrings(stripComments(read(p)))
const stripped = (p: string) => stripComments(read(p))

const fc = await import("../lib/fatigue/fatigue-calculator")
const { tenantScope, platformScope } = await import("../lib/kernel/tenant-scope")
const { BUYER_CONCLUDED_STAGES, BUYER_ACTIVE_STAGES } = await import("../lib/contacts/buyer-stage")

// ── F1 ────────────────────────────────────────────────────────────────────────
console.log("\n[F1 · the population is derived from the calculation's inputs]")
const calcSrc = stripped("lib/fatigue/fatigue-calculator.ts")
const calcFnAt = calcSrc.indexOf("export async function calculateFatigue(")
const calcFn = calcSrc.slice(calcFnAt, calcSrc.indexOf("\n}\n", calcFnAt))
const readerAt = calcSrc.indexOf("function fatigueInput(")
const reader = calcSrc.slice(readerAt, calcSrc.indexOf("\n}\n", readerAt))
const readerTables = [...reader.matchAll(/case "(\w+)":\s*return supabase\.from\("(\w+)"\)/g)].map((m) => [m[1], m[2]] as const)
check("the one reader has ONE case per declared input, each reading the table it names",
  readerTables.length === fc.FATIGUE_INPUT_SOURCES.length && readerTables.every(([c, t]) => c === t)
    && fc.FATIGUE_INPUT_SOURCES.every((s) => readerTables.some(([c]) => c === s)), JSON.stringify(readerTables))
const calcReads = [...calcFn.matchAll(/fatigueInput\(supabase, "(\w+)"/g)].map((m) => m[1])
check("calculateFatigue reads EXACTLY the declared inputs, through the one reader",
  calcReads.length === fc.FATIGUE_INPUT_SOURCES.length && fc.FATIGUE_INPUT_SOURCES.every((s) => calcReads.includes(s)), calcReads.join(","))
const directInputRead = (fn: string) => fc.FATIGUE_INPUT_SOURCES.some((t) => new RegExp(`\\.from\\("${t}"\\)`).test(fn))
check("calculateFatigue never reads an input table DIRECTLY (a bypass would let the formula drift from the population)", !directInputRead(calcFn))
check("POSITIVE CONTROL: a calculator reading `.from(\"tours\")` directly is flagged",
  directInputRead(`const r = await supabase.from("tours").select("tour_date").eq("contact_id", id)`))
const popAt = calcSrc.indexOf("export async function loadFatigueSweepPopulation(")
const popFn = calcSrc.slice(popAt, calcSrc.indexOf("export interface FatigueSweepResult"))
check("the population loader walks FATIGUE_INPUT_SOURCES through the same reader",
  /for \(const source of FATIGUE_INPUT_SOURCES\)/.test(popFn) && /fatigueInput\(supabase, source,/.test(popFn))
check("no stage list decides the population (no .in(\"buyer_stage\", …) in the core)", !/\.in\(\s*"buyer_stage"/.test(calcSrc))
check("POSITIVE CONTROL: the stage-list finder sees 86G2's population shape", /\.in\(\s*"buyer_stage"/.test(`.in("buyer_stage", ACTIVE_BUYER_STAGES)`))

// ── F2 — the in-memory double ────────────────────────────────────────────────
console.log("\n[F2 · the population, against an in-memory double]")
type Row = Record<string, any>
type Call = { table: string; eq: Record<string, unknown>; head: boolean }
function fakeDb(tables: Record<string, Row[]>, refuse: Set<string> = new Set()) {
  const calls: Call[] = []
  return {
    calls,
    from(table: string) {
      const eq: Record<string, unknown> = {}
      const preds: Array<(r: Row) => boolean> = []
      let range: [number, number] | null = null
      let head = false, count = false
      const run = () => {
        calls.push({ table, eq: { ...eq }, head })
        if (refuse.has(table)) return { data: null, error: { message: `permission denied for ${table}` }, count: null }
        let rows = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)))
        const total = rows.length
        rows = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)))
        if (range) rows = rows.slice(range[0], range[1] + 1)
        return { data: head ? null : rows, error: null, count: count ? total : null }
      }
      const q: any = {
        select: (_c: string, o?: { count?: string; head?: boolean }) => { count = !!o?.count; head = !!o?.head; return q },
        eq: (c: string, v: unknown) => { eq[c] = v; preds.push((r) => r[c] === v); return q },
        in: (c: string, vs: unknown[]) => { preds.push((r) => vs.includes(r[c])); return q },
        is: (c: string, v: null) => { preds.push((r) => (r[c] ?? null) === v); return q },
        not: (c: string, op: string, v: null) => { if (op === "is") preds.push((r) => (r[c] ?? null) !== v); return q },
        order: () => q,
        range: (a: number, b: number) => { range = [a, b]; return q },
        limit: () => q,
        then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
      }
      return q
    },
  }
}
const B1 = "b-1", B2 = "b-2"
const contacts: Row[] = [
  { id: "c-show",   brokerage_id: B1, buyer_stage: "BUYER_TOURING",    deleted_at: null },
  { id: "c-diseng", brokerage_id: B1, buyer_stage: "BUYER_DISENGAGED", deleted_at: null },
  { id: "c-lead",   brokerage_id: B1, buyer_stage: null,               deleted_at: null },
  { id: "c-closed", brokerage_id: B1, buyer_stage: "BUYER_CLOSED",     deleted_at: null },
  { id: "c-del",    brokerage_id: B1, buyer_stage: "BUYER_SEARCHING",  deleted_at: "2026-09-01" },
  { id: "c-noinp",  brokerage_id: B1, buyer_stage: "BUYER_SEARCHING",  deleted_at: null }, // on the ladder, NO input
  { id: "c-other",  brokerage_id: B2, buyer_stage: "BUYER_SEARCHING",  deleted_at: null },
  { id: "c-orphan", brokerage_id: null, buyer_stage: "BUYER_SEARCHING", deleted_at: null },
]
const DB = () => ({
  contacts,
  showings: [
    { id: "s1", contact_id: "c-show", brokerage_id: B1, status: "completed" },
    { id: "s2", contact_id: "c-noinp", brokerage_id: B1, status: "scheduled" }, // not an input (formula counts completed)
    { id: "s3", contact_id: "c-closed", brokerage_id: B1, status: "completed" },
    { id: "s4", contact_id: "c-del", brokerage_id: B1, status: "completed" },
    { id: "s5", contact_id: "c-orphan", brokerage_id: B1, status: "completed" },
  ],
  tours: [{ id: "t1", contact_id: null, brokerage_id: B1, status: "completed" }],
  offers: [
    { id: "o1", contact_id: "c-lead", brokerage_id: B1, status: "rejected" },
    { id: "o2", contact_id: "c-other", brokerage_id: B2, status: "rejected" },
  ],
  buyer_behavior_log: [
    { id: "g1", contact_id: "c-diseng", brokerage_id: B1 },
    // 1,200 signals across two B1 contacts → the loader must read a SECOND page
    ...Array.from({ length: 1200 }, (_, i) => ({ id: `g${String(i + 2).padStart(5, "0")}`, contact_id: i % 2 ? "c-show" : "c-diseng", brokerage_id: B1 })),
  ],
  leads: [
    { id: "l-conv", brokerage_id: B1, contact_id: "c-lead" },
    { id: "l-raw1", brokerage_id: B1, contact_id: null },
    { id: "l-raw2", brokerage_id: B1, contact_id: null },
    { id: "l-rawB2", brokerage_id: B2, contact_id: null },
  ],
  buyer_fatigue_scores: [
    { id: "f1", contact_id: "c-show", brokerage_id: B1, last_calculated_at: "2026-09-27T00:00:00Z" },
    { id: "f2", contact_id: "c-diseng", brokerage_id: B1, last_calculated_at: "2026-09-20T00:00:00Z" },
  ],
})
{
  const db = fakeDb(DB())
  const pop = await fc.loadFatigueSweepPopulation(tenantScope(B1, "proof"), db as any)
  const ids = pop.persons.map((p) => p.contactId)
  check("a contact named by an input is IN (completed showing)", ids.includes("c-show"))
  check("a DISENGAGED buyer with engagement inputs is IN (86G2's stage list skipped exactly this person)", ids.includes("c-diseng") && !(BUYER_ACTIVE_STAGES as readonly string[]).includes("BUYER_DISENGAGED"))
  check("a buyer ON the active ladder with NO input is OUT (nothing to derive from)", !ids.includes("c-noinp") && (BUYER_ACTIVE_STAGES as readonly string[]).includes("BUYER_SEARCHING"))
  check("a non-counted input row (a SCHEDULED showing) does not make a person", !ids.includes("c-noinp"))
  check("a concluded search (BUYER_CLOSED) is OUT; soft-deleted and tenantless contacts are OUT",
    !ids.includes("c-closed") && !ids.includes("c-del") && !ids.includes("c-orphan") && (BUYER_CONCLUDED_STAGES as readonly string[]).includes("BUYER_CLOSED"))
  check("a NULL buyer_stage (a lead's conversion contact) stays IN", ids.includes("c-lead"))
  check("the lead's conversion contact is TAGGED fromLead", pop.persons.find((p) => p.contactId === "c-lead")?.fromLead === true
    && pop.persons.filter((p) => p.fromLead).length === 1)
  check("the tenant's UNCONVERTED leads are COUNTED (2), never scored — the other tenant's is not counted", pop.leadsWithoutInputs === 2)
  check("another tenant's person is OUT of a tenant run", !ids.includes("c-other"))
  const tenantTables = ["showings", "tours", "offers", "buyer_behavior_log", "contacts", "leads", "buyer_fatigue_scores"]
  const unpinned = db.calls.filter((c) => tenantTables.includes(c.table) && c.eq.brokerage_id !== B1)
  check("EVERY read of a tenant run is pinned to the session brokerage (§4)", db.calls.length > 0 && unpinned.length === 0, JSON.stringify(unpinned.slice(0, 3)))
  check("paging: the behavior log (1,201 rows) was read in TWO pages", db.calls.filter((c) => c.table === "buyer_behavior_log").length === 2)
  check("stalest first: never-scored (c-lead) → oldest (c-diseng) → newest (c-show)", ids.join(",") === "c-lead,c-diseng,c-show", ids.join(","))
  check("denominators are published: withInputs / excluded", pop.withInputs === 6 && pop.excluded === 3, JSON.stringify({ w: pop.withInputs, x: pop.excluded }))
  check("no source hit the page cap", pop.inputsCapped.length === 0)
}
{
  const db = fakeDb(DB())
  const pop = await fc.loadFatigueSweepPopulation(platformScope("proof — every tenant"), db as any)
  const ids = pop.persons.map((p) => p.contactId)
  check("PLATFORM scope spans tenants (B1 and B2 people both IN)", ids.includes("c-show") && ids.includes("c-other"))
  check("...adds no tenant predicate (it was ASKED for, not a missing value)", db.calls.every((c) => c.eq.brokerage_id === undefined))
  check("...and counts every tenant's unconverted leads (3)", pop.leadsWithoutInputs === 3)
}
for (const table of ["showings", "contacts", "leads", "buyer_fatigue_scores"]) {
  let threw = false
  try { await fc.loadFatigueSweepPopulation(tenantScope(B1, "proof"), fakeDb(DB(), new Set([table])) as any) } catch { threw = true }
  check(`FAIL CLOSED: a refused ${table} read THROWS (never "nobody to score")`, threw)
}
{
  let threw = false
  try { tenantScope(null, "proof") } catch { threw = true }
  check("a missing session tenant cannot decay into every tenant (tenantScope refuses null)", threw)
}

// ── F3 ────────────────────────────────────────────────────────────────────────
console.log("\n[F3 · wiring + cost]")
const core = code("lib/fatigue/fatigue-calculator.ts")
const sweepAt = core.indexOf("export async function runFatigueSweep(")
const sweep = core.slice(sweepAt)
const cron = code("app/api/fatigue/cron/route.ts")
check("PLATFORM scope: the cron verifies the secret, THEN runs the one core with platformScope(reason)",
  /runFatigueSweep\(\s*platformScope\(/.test(cron) && cron.indexOf("verifyCronAuth(") > -1 && cron.indexOf("verifyCronAuth(") < cron.indexOf("runFatigueSweep("))
const act = code("app/actions/buyer-fatigue.ts")
const door = act.slice(act.indexOf("export async function recalculateBrokerageFatigue("))
check("BROKERAGE scope: the user-run door gates the tenant admin FIRST, then runs the SAME core with tenantScope(session)",
  /export async function recalculateBrokerageFatigue\(\s*\)/.test(act) && door.indexOf("requireTenantAdminOrSoloOwner(") > -1
    && door.indexOf("requireTenantAdminOrSoloOwner(") < door.indexOf("runFatigueSweep(") && /runFatigueSweep\(\s*tenantScope\(\s*auth\.brokerageId/.test(door))
check("the retired core name is gone from runtime code (one core, one name)",
  !/calculateAllBuyerFatigue\(/.test(core + cron + act) && !/calculateAllBuyerFatigue/.test(code("lib/fatigue/index.ts")))
check("COST: a per-run cap (stalest first; the rest counted deferred) and bounded concurrency",
  /pop\.persons\.slice\(0, maxPersons\)/.test(sweep) && /deferred: pop\.persons\.length - batch\.length/.test(sweep)
    && /chunk\(batch, concurrency\)/.test(sweep) && /Promise\.allSettled\(/.test(sweep) && fc.FATIGUE_SWEEP_DEFAULT_MAX_PERSONS > 0)
check("COST: the recovery plan is generated only when THIS run raised a NEW alert (never per run)",
  /if \(scored\.alert_raised\)/.test(sweep) && !/risk_level === "\s*" \|\| scored\.risk_level/.test(sweep))
check("...and the on-demand door follows the same rule", /if \(result\.alert_raised\)/.test(act))
const calc = code("lib/fatigue/fatigue-calculator.ts").slice(core.indexOf("export async function calculateFatigue("), core.indexOf("const INPUT_PAGE_SIZE"))
check("calculateFatigue pins the person to the tenant (contacts.id + brokerage_id + live) BEFORE any write, and refuses otherwise",
  /\.from\("\s*"\)\s*\.select\("[^"]*"\)\s*\.eq\("\s*", contactId\)\s*\.eq\("\s*", brokerageId\)\s*\.is\("\s*", null\)/.test(calc)
    && /if \(!contact\) throw/.test(calc) && calc.indexOf("if (!contact) throw") < calc.indexOf(".upsert("))
check("calculateFatigue READS every input refusal (a refused read no longer scores as zero)", /if \(res\.error\) throw/.test(calc))
check("the score write is COUNTED (.select after the upsert; error read; exactly one row)",
  /\.upsert\([\s\S]*?\)\s*\.select\(/.test(calc) && /if \(writeErr\) throw/.test(calc) && /\.length !== 1\) throw/.test(calc))
const RAW_AI = /import\s*\{[^}]*\bgenerateText\b[^}]*\}\s*from\s*["']ai["']/
const recSrc = stripComments(read("lib/fatigue/recovery-generator.ts"))
check("model calls are ROUTED + BOOKED (generateTextRouted, feature + tenant), no raw SDK import",
  !RAW_AI.test(stripComments(read("lib/fatigue/fatigue-calculator.ts"))) && !RAW_AI.test(recSrc)
    && /feature: "buyer_fatigue_coaching",\s*brokerageId,/.test(stripComments(read("lib/fatigue/fatigue-calculator.ts")))
    && /feature: "buyer_fatigue_coaching",\s*brokerageId: score\.brokerage_id/.test(recSrc))
check("POSITIVE CONTROL: the raw-SDK finder sees `import { generateText } from \"ai\"`", RAW_AI.test(`import { generateText } from "ai"`))
const { AI_TASK_ROUTING } = await import("../lib/ai/models")
check("the routing key exists (an unknown key silently falls back to 'unspecified' sonnet)", !!(AI_TASK_ROUTING as Record<string, unknown>).buyer_fatigue_coaching)
check("a fallback plan that was never stored is NOT reported as attached", /return \{ success: false, plan: fallback/.test(recSrc))

// ── F4 ────────────────────────────────────────────────────────────────────────
console.log("\n[F4 · agents see CONTACTS only — their own book]")
const actS = stripped("app/actions/buyer-fatigue.ts")
for (const fn of ["getHighFatigueBuyers", "getBrokerageFatigueAlerts", "getBrokerageFatigueData"]) {
  const at = actS.indexOf(`export async function ${fn}(`)
  const body = actS.slice(at, actS.indexOf("\n}\n", at))
  check(`${fn} resolves the viewer BEFORE its service reads and refuses on !ok`,
    body.indexOf("resolveFatigueViewer(auth)") > -1 && body.indexOf("resolveFatigueViewer(auth)") < body.indexOf("createServiceClient()")
      && /if \(!viewer\.ok\) return/.test(body))
  check(`${fn} narrows an agent to their own book`, /viewer\.bookAgentId === null \? \w+ : \w+\.eq\("(agent_id|agent_user_id)"/.test(body))
}
const viewerAt = actS.indexOf("async function resolveFatigueViewer(")
const viewerFn = actS.slice(viewerAt, actS.indexOf("\n}\n", viewerAt))
check("the brokerage-wide view is the tenant admin ROSTER (TENANT_ADMIN_USER_TYPES), never a copied list",
  /TENANT_ADMIN_USER_TYPES\.has\(auth\.userType\)/.test(viewerFn) && !/\["broker",/.test(viewerFn))
check("an agent is resolved via agents.user_id inside the session brokerage, and a seat with no agent row is REFUSED",
  /\.eq\("user_id", auth\.userId\)\s*\.eq\("brokerage_id", auth\.brokerageId\)/.test(viewerFn) && /if \(!data\) return \{ ok: false/.test(viewerFn))
const dataFn = actS.slice(actS.indexOf("export async function getBrokerageFatigueData("))
check("the agent NAME crosses agents.user_id (§3 — agents.id and users.id are disjoint)",
  /\.from\("agents"\)\s*\.select\("id, user_id"\)/.test(dataFn) && !/\.from\("users"\)[\s\S]{0,80}\.in\("id", agentIds\)/.test(dataFn))
check("POSITIVE CONTROL: the disjoint-id finder sees the old shape",
  /\.from\("users"\)[\s\S]{0,80}\.in\("id", agentIds\)/.test(`.from("users")\n      .select("id, first_name, last_name")\n      .in("id", agentIds)`))
check("no fatigue row can be a lead: scores and alerts key on contacts (the FK the inputs share)",
  /onConflict: "contact_id"/.test(calcSrc) && !/\.from\("leads"\)[\s\S]{0,200}\.(insert|update|upsert)\(/.test(calcSrc))

// ── F5 ────────────────────────────────────────────────────────────────────────
console.log("\n[F5 · registration]")
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
check("package.json registers test:fatigue-population", pkg.scripts["test:fatigue-population"] === "tsx scripts/fatigue-population-guard.ts")
const guard = pkg.scripts.guard ?? ""
check("the guard chain runs it AFTER test:scrapers", guard.indexOf("npm run test:scrapers") >= 0 && guard.indexOf("npm run test:fatigue-population") > guard.indexOf("npm run test:scrapers"))
const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
check("MAINTENANCE_DOMAINS owns it", Object.values(MAINTENANCE_DOMAINS).some((d: any) => d.proof === "test:fatigue-population"))

console.log(`\n  denominators: ${fc.FATIGUE_INPUT_SOURCES.length} inputs · 8 contacts / 4 leads / 2 tenants in the double · 4 refused-read cases · 3 agent-facing list readers`)
console.log("  blind spots: the loader is run against an in-memory double, not live (live had 0 showings / tours / offers / behavior rows / leads on 2026-09-28); calculateFatigue's own reads are proven by source shape, not executed (it builds its own service client); a source row stamped brokerage_id NULL is seen only by the PLATFORM sweep; the population read is linear in input ROWS (PostgREST has no DISTINCT) — capped at 200 pages per source and reported as inputsCapped")
console.log("\n" + "─".repeat(50))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(failed === 0 ? " ✅ FATIGUE_POPULATION_PASS" : " ❌ FATIGUE_POPULATION_FAIL")
if (failed) for (const f of failures) console.log(`   · ${f}`)
process.exit(failed === 0 ? 0 : 1)
