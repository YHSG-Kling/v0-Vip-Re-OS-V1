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
 *   F6 WAVE 88 (lane 88A) — owner, verbatim: "Need fatigue also for agents. Calculating fatigue
 *      should also take into consideration responses to follow up, Fatigue for sellers that haven't
 *      signed a listing agreement meaning unresponsive to follow up, missed appointments, etc." ·
 *      "I feel like over contacting is already built." The SAME calculator gains follow-up touches
 *      (the over-touch engine's own ledgers — ONE vocabulary with lib/kernel/deconflict), replies,
 *      missed appointments and the unsigned-seller qualifier; the pure terms are driven with
 *      positive + negative controls; the engagement-trend words are CHECK-legal again; the owning
 *      agent is stamped (buyer_fatigue_scores.agent_id).
 *   F7 agents — every per-contact fatigue door narrows an agent to their OWN BOOK; the agent's
 *      Recalculate runs the one core over their book (no lead read or counted); agent coaching
 *      reads the fatigued-book count (the agent-level signal).
 *
 * Owner: data_steward. Co-owners named in prose: cron_manager (the platform sweep's schedule) and
 * shopping_agent (buyer_fatigue_scores' table owner); wave 88 adds campaign_orchestrator (the
 * over-touch engine whose ledgers fatigue now reads) and recruiting_manager (agent coaching).
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
const CASE_RE = /case "(\w+)":\s*\{\s*const q = supabase\.from\("(\w+)"\)[^\n]*?applyTenantScope\(q, scope\); return q \}/g
const readerTables = [...reader.matchAll(CASE_RE)].map((m) => [m[1], m[2]] as const)
check("the one reader has ONE case per declared input, each reading the table it names AND applying the caller's TenantScope itself",
  readerTables.length === fc.FATIGUE_INPUT_SOURCES.length && readerTables.every(([c, t]) => c === t)
    && fc.FATIGUE_INPUT_SOURCES.every((s) => readerTables.some(([c]) => c === s)), JSON.stringify(readerTables))
const { CONTACT_TOUCH_LEDGERS, DEFAULT_DECONFLICT_POLICY, saturatedChannels, touchChannelOf, touchTimestampColumn, DECONFLICT_CHANNELS } = await import("../lib/kernel/deconflict/lead-channel")
const literalReads = [...calcFn.matchAll(/fatigueInput\(supabase, scope, "(\w+)"/g)].map((m) => m[1])
// The follow-up touches are read by walking the over-touch engine's own ledger list through the reader.
const ledgerWalk = /CONTACT_TOUCH_LEDGERS\.map\(\(ledger[^)]*\) => \{[\s\S]*?fatigueInput\(supabase, scope, ledger,/.test(calcFn)
const calcReads = [...literalReads, ...(ledgerWalk ? CONTACT_TOUCH_LEDGERS : [])]
check("calculateFatigue reads EXACTLY the declared inputs, through the one reader (literal reads + the engine's ledger walk)",
  calcReads.length === fc.FATIGUE_INPUT_SOURCES.length && fc.FATIGUE_INPUT_SOURCES.every((s) => calcReads.includes(s)), calcReads.join(","))
const directInputRead = (fn: string) => fc.FATIGUE_INPUT_SOURCES.some((t) => new RegExp(`\\.from\\("${t}"\\)`).test(fn))
check("calculateFatigue never reads an input table DIRECTLY (a bypass would let the formula drift from the population)", !directInputRead(calcFn))
check("POSITIVE CONTROL: a calculator reading `.from(\"tours\")` directly is flagged",
  directInputRead(`const r = await supabase.from("tours").select("tour_date").eq("contact_id", id)`))
const popAt = calcSrc.indexOf("export async function loadFatigueSweepPopulation(")
const popFn = calcSrc.slice(popAt, calcSrc.indexOf("export interface FatigueSweepResult"))
check("the population loader walks FATIGUE_INPUT_SOURCES through the same reader",
  /for \(const source of FATIGUE_INPUT_SOURCES\)/.test(popFn) && /fatigueInput\(supabase, scope, source,/.test(popFn))
check("the calculator's scope is tenantScope(ITS brokerage) — the one it pinned the contact to",
  /const scope = tenantScope\(brokerageId, /.test(calcFn) && calcFn.indexOf("if (!contact) throw") < calcFn.indexOf("const scope = tenantScope("))
check("POSITIVE CONTROL: the case finder refuses an UNSCOPED case (87A's shape)",
  [...`case "tours": return supabase.from("tours").select(columns, opts).eq("status", "completed")`.matchAll(CASE_RE)].length === 0)
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
        gte: (c: string, v: string) => { preds.push((r) => r[c] == null || String(r[c]) >= v); return q },
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
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString()
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
// Wave 88 people — only in the W88 double below, so the 87A denominators above are untouched.
const contacts88: Row[] = [
  ...contacts,
  { id: "c-seller", brokerage_id: B1, buyer_stage: null, deleted_at: null, agent_id: "ag-1" }, // follow-up only
  { id: "c-noshow", brokerage_id: B1, buyer_stage: null, deleted_at: null, agent_id: "ag-2" }, // missed appointment only
  { id: "c-oldtouch", brokerage_id: B1, buyer_stage: null, deleted_at: null, agent_id: "ag-1" }, // touch OUTSIDE the window
  { id: "c-cancel", brokerage_id: B1, buyer_stage: null, deleted_at: null, agent_id: "ag-1" }, // a cancelled (not no-show) event
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
  const tenantTables = [...fc.FATIGUE_INPUT_SOURCES, "contacts", "leads", "buyer_fatigue_scores"] as string[]
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
for (const table of ["showings", "email_sends", "lifetime_customer_touchpoints", "calendar_events", "contacts", "leads", "buyer_fatigue_scores"]) {
  let threw = false
  try { await fc.loadFatigueSweepPopulation(tenantScope(B1, "proof"), fakeDb(DB(), new Set([table])) as any) } catch { threw = true }
  check(`FAIL CLOSED: a refused ${table} read THROWS (never "nobody to score")`, threw)
}

console.log("\n[F2b · wave 88 — the population follows the new inputs]")
const DB88 = () => ({
  ...DB(),
  contacts: contacts88,
  email_sends: [
    { id: "e1", contact_id: "c-seller", brokerage_id: B1, sent_at: daysAgo(3) },
    { id: "e2", contact_id: "c-oldtouch", brokerage_id: B1, sent_at: daysAgo(60) }, // outside the 30-day window
  ],
  isa_outreach_log: [{ id: "i1", contact_id: "c-seller", brokerage_id: B1, sent_at: daysAgo(10), channel: "voice" }],
  calendar_events: [
    { id: "ce1", entity_type: "contact", entity_id: "c-noshow", brokerage_id: B1, status: "no_show", start_at: daysAgo(5) },
    { id: "ce2", entity_type: "contact", entity_id: "c-cancel", brokerage_id: B1, status: "cancelled", start_at: daysAgo(5) },
    { id: "ce3", entity_type: "platform_prospect", entity_id: "pp-1", brokerage_id: B1, status: "no_show", start_at: daysAgo(5) },
  ],
})
{
  const db = fakeDb(DB88())
  const pop = await fc.loadFatigueSweepPopulation(tenantScope(B1, "proof"), db as any)
  const ids = pop.persons.map((p) => p.contactId)
  check("a SELLER being followed up (touches only, no buyer search) is IN", ids.includes("c-seller"))
  check("a contact whose only input is a MISSED APPOINTMENT (calendar_events no_show, keyed entity_id) is IN", ids.includes("c-noshow"))
  check("a touch OUTSIDE the follow-up window does not make a person (the reader carries the window)", !ids.includes("c-oldtouch"))
  check("a CANCELLED event and a no-show on a non-contact entity do not make a person", !ids.includes("c-cancel") && !ids.includes("pp-1"))
  check("the 87A people are still IN (extended, not replaced)", ["c-show", "c-diseng", "c-lead"].every((c) => ids.includes(c)))
  check("calendar_events is read by entity_type 'contact' + status 'no_show', and every new source is tenant-pinned",
    db.calls.some((c) => c.table === "calendar_events" && c.eq.entity_type === "contact" && c.eq.status === "no_show")
      && db.calls.filter((c) => (fc.FATIGUE_INPUT_SOURCES as readonly string[]).includes(c.table)).every((c) => c.eq.brokerage_id === B1))
  check("EVERY follow-up ledger the over-touch engine counts was walked", CONTACT_TOUCH_LEDGERS.every((l) => db.calls.some((c) => c.table === l)))
}
{
  const db = fakeDb(DB88())
  const pop = await fc.loadFatigueSweepPopulation(tenantScope(B1, "proof"), db as any, { bookAgentId: "ag-1" })
  const ids = pop.persons.map((p) => p.contactId)
  check("AN AGENT'S BOOK: only contacts with agent_id = the agent (c-seller IN, ag-2's c-noshow OUT)", ids.includes("c-seller") && !ids.includes("c-noshow"))
  check("...the anchor carries agent_id AND the session tenant", db.calls.some((c) => c.table === "contacts" && c.eq.agent_id === "ag-1" && c.eq.brokerage_id === B1))
  check("...and no LEAD is read or counted on an agent's book (§5 — agents never see leads)",
    pop.leadsWithoutInputs === 0 && !db.calls.some((c) => c.table === "leads" && c.head))
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
for (const fn of ["getBuyerFatigueScore", "getBuyerFatigueAlerts", "triggerFatigueCalculation", "getBuyerFatigueAlert", "getReinvigorationSuggestions", "dismissFatigueAlert"]) {
  const at = actS.indexOf(`export async function ${fn}(`)
  const body = actS.slice(at, actS.indexOf("\n}\n", at))
  check(`${fn} (one contact) passes the book gate — verifyContactAccess(…, auth) — and refuses on !ok`,
    at > -1 && /verifyContactAccess\([\s\S]{1,80}?, auth\)/.test(body) && /if \(!access\.ok\) return/.test(body))
}
const vcaAt = actS.indexOf("async function verifyContactAccess(")
const vca = actS.slice(vcaAt, actS.indexOf("\n}\n", vcaAt))
check("the one-contact gate resolves the SAME viewer, pins the contact to the session tenant (live), READS the error, and narrows an agent to their book",
  /resolveFatigueViewer\(auth\)/.test(vca) && /\.eq\("brokerage_id", auth\.brokerageId\)/.test(vca) && /\.is\("deleted_at", null\)/.test(vca)
    && /if \(error\) return \{ ok: false/.test(vca) && /viewer\.bookAgentId !== null && [^\n]*agent_id !== viewer\.bookAgentId/.test(vca))
check("POSITIVE CONTROL: the 87A brokerage-only gate shape is what the finder rejects",
  !/resolveFatigueViewer\(auth\)/.test(`async function verifyContactAccess(contactId: string, brokerageId: string) { const { data: contact } = await svc.from("contacts").select("brokerage_id").eq("id", contactId).maybeSingle(); return !!contact && contact.brokerage_id === brokerageId }`))
const doorFull = actS.slice(actS.indexOf("export async function recalculateBrokerageFatigue("))
const agentPath = doorFull.slice(doorFull.indexOf("if (!auth.ok) {"), doorFull.indexOf("\n  try {\n    const data = await runFatigueSweep(tenantScope(auth.brokerageId"))
check("the agent's Recalculate: a non-admin seat runs the SAME core over THEIR OWN book (viewer from the session), never the whole tenant",
  /resolveFatigueViewer\(caller\)/.test(agentPath) && /runFatigueSweep\(\s*tenantScope\(caller\.brokerageId/.test(agentPath)
    && /\{ bookAgentId: viewer\.bookAgentId \}/.test(agentPath) && /if \(viewer\.bookAgentId === null\) return \{ success: false/.test(agentPath))
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

// ── F6 ────────────────────────────────────────────────────────────────────────
console.log("\n[F6 · wave 88 — follow-up responsiveness, over-touch, missed appointments, unsigned sellers]")
const { CHECK_VOCABULARIES } = await import("./check-vocabularies")
// ONE VOCABULARY with the over-touch engine
check("every ledger the over-touch engine counts is a fatigue input (fatigue READS the over-contact capability)",
  CONTACT_TOUCH_LEDGERS.every((l) => (fc.FATIGUE_INPUT_SOURCES as readonly string[]).includes(l)))
check("the follow-up window is DERIVED from the engine's longest cap window (not a second number)",
  fc.FOLLOW_UP_WINDOW_DAYS === Math.max(...Object.values(DEFAULT_DECONFLICT_POLICY).map((p) => p.windowDays)))
const dcIndex = code("lib/kernel/deconflict/index.ts")
const HAND_ROLLED_TS = /=== "\s*" \? "\s*" : "\s*"/
check("the engine itself dates touches through the shared descriptor (touchTimestampColumn) and uses the shared policy",
  /touchTimestampColumn\(table\)/.test(dcIndex) && /DEFAULT_POLICY: Record<DeconflictChannel, ChannelPolicy> = DEFAULT_DECONFLICT_POLICY/.test(dcIndex) && !HAND_ROLLED_TS.test(dcIndex))
check("POSITIVE CONTROL: the finder sees 87A's hand-rolled timestamp ternary",
  HAND_ROLLED_TS.test(blankStrings(`const tsCol = table === "lifetime_customer_touchpoints" ? "created_at" : "sent_at"`)))
// The two channel-implicit ledgers are dated by a LITERAL column in the engine (the readerless-writes
// census reads literals — a computed column would blind it to email_sends.sent_at's reader); the
// shared descriptor must name the SAME columns, so fatigue and the cap date a touch identically.
const dcRaw = stripComments(read("lib/kernel/deconflict/index.ts"))
check("the engine's literal dates for the implicit ledgers equal the shared descriptor (email_sends.sent_at, direct_mail_recipients.mailed_at)",
  touchTimestampColumn("email_sends") === "sent_at" && touchTimestampColumn("direct_mail_recipients") === "mailed_at"
    && /from\("email_sends"\)[\s\S]{0,200}\.gte\("sent_at", since\)/.test(dcRaw) && /from\("direct_mail_recipients"\)[\s\S]{0,200}\.gte\("mailed_at", since\)/.test(dcRaw))
check("the engine's allow rule is `touches < policy.maxTouches`, so saturated = touches >= max (the same line)",
  /const allowed = touches < policy\.maxTouches/.test(dcIndex))
const T = (ch: string, d: number) => ({ channel: ch as any, at: daysAgo(d) })
const sat = (xs: any[]) => saturatedChannels(xs).map((s: any) => s.channel).sort().join(",")
check("saturatedChannels: 1 sms in 7d → sms at the cap (policy 1/7d)", sat([T("sms", 2)]) === "sms")
check("...3 emails in 14d → email at the cap; 2 emails → not", sat([T("email", 1), T("email", 5), T("email", 9)]) === "email" && sat([T("email", 1), T("email", 5)]) === "")
check("...an email 20 days ago is outside email's own 14-day window; a mail piece 20 days ago is inside mail's 30", sat([T("email", 20), T("email", 1), T("email", 2)]) === "" && sat([T("mail", 20)]) === "mail")
check("POSITIVE CONTROL: no touches → nothing saturated", sat([]) === "")
check("touchChannelOf inverts the per-table words (voice → phone on the ISA log, call → phone on lifetime, implicit tables)",
  touchChannelOf("isa_outreach_log", "voice") === "phone" && touchChannelOf("lifetime_customer_touchpoints", "call") === "phone"
    && touchChannelOf("email_sends", null) === "email" && touchChannelOf("direct_mail_recipients", null) === "mail"
    && touchChannelOf("isa_outreach_log", "video") === null && DECONFLICT_CHANNELS.length === 4)
// Responsiveness
const R = fc.followUpResponsiveness
const r1 = R([{ at: daysAgo(20) }, { at: daysAgo(15) }, { at: daysAgo(5) }, { at: daysAgo(2) }], [{ at: daysAgo(10) }])
check("followUpResponsiveness: 4 sent, a reply after the 2nd → 2 unanswered SINCE the reply", r1.sent === 4 && r1.replies === 1 && r1.unanswered === 2, JSON.stringify(r1))
const r2 = R([{ at: daysAgo(9) }, { at: daysAgo(3) }, { at: daysAgo(1) }], [])
check("...nobody replied → every follow-up is unanswered", r2.unanswered === 3 && r2.lastReplyAt === null)
const r3 = R([{ at: daysAgo(9) }, { at: daysAgo(3) }], [{ at: daysAgo(1) }])
check("POSITIVE CONTROL: a reply after the last touch → nothing unanswered", r3.unanswered === 0)
// Points
const P = (o: Partial<{ unanswered_follow_ups: number; saturated_channels: string[]; missed_appointments: number; seller_unresponsive: boolean }>) =>
  fc.responsivenessPoints({ unanswered_follow_ups: 0, saturated_channels: [], missed_appointments: 0, seller_unresponsive: false, ...o })
check("POSITIVE CONTROL: no wave-88 signal → 0 points (a buyer's 87A score is unchanged)", P({}) === 0)
check("ONE unanswered follow-up is ordinary (0 points); TWO start to count", P({ unanswered_follow_ups: 1 }) === 0 && P({ unanswered_follow_ups: 2 }) > 0)
check("unanswered follow-ups are CAPPED (20 unanswered = 8 unanswered)", P({ unanswered_follow_ups: 20 }) === P({ unanswered_follow_ups: 8 }))
check("each saturated channel raises the score; missed appointments raise it (capped at 3)",
  P({ saturated_channels: ["email", "sms"] }) === 2 * P({ saturated_channels: ["email"] }) && P({ missed_appointments: 1 }) > 0 && P({ missed_appointments: 9 }) === P({ missed_appointments: 3 }))
check("an unsigned seller going quiet raises the score", P({ seller_unresponsive: true }) > 0)
check("a quiet seller with a missed appointment and 4 unanswered follow-ups reaches HIGH fatigue on responsiveness alone",
  P({ unanswered_follow_ups: 4, missed_appointments: 1, seller_unresponsive: true }) >= 50)
// Calculator source shape for the new reads
check("the seller qualifier: sellers (seller | both) only, listing agreement read tenant-pinned with its error READ, unresponsive = unsigned AND unanswered ≥ the floor",
  /contactType === "seller" \|\| contactType === "both"/.test(calcFn) && /\.from\("listing_agreements"\)[\s\S]{0,200}\.eq\("brokerage_id", brokerageId\)/.test(calcFn)
    && /if \(agreementsErr\) throw/.test(calcFn) && /unsignedSeller && responsiveness\.unanswered >= UNANSWERED_FOLLOW_UP_FLOOR/.test(calcFn))
check("every new read throws on refusal (touch ledgers, replies, no-shows)",
  /if \(res\.error\) throw new Error\(`\[fatigue\] \$\{ledger\} read refused/.test(calcFn) && /reply read refused/.test(calcFn) && /no-show read refused/.test(calcFn))
check("follow-up touches and replies go through the tenant-scoped readers with the calculator's scope",
  /fatigueInput\(supabase, scope, ledger,/.test(calcFn) && /fatigueResponse\(supabase, scope, source\)/.test(calcFn))
const respAt = calcSrc.indexOf("function fatigueResponse(")
const resp = calcSrc.slice(respAt, calcSrc.indexOf("\n}\n", respAt))
const respTables = [...resp.matchAll(CASE_RE)].map((m) => m[2])
check("replies are read through ONE reader, one tenant-scoped case per declared response source", respTables.length === fc.FATIGUE_RESPONSE_SOURCES.length && fc.FATIGUE_RESPONSE_SOURCES.every((t) => respTables.includes(t)))
check("reply direction words are CHECK-legal (client_portal_messages 'client_to_agent', voice_calls 'inbound')",
  CHECK_VOCABULARIES.client_portal_messages.direction.includes("client_to_agent") && CHECK_VOCABULARIES.voice_calls.direction.includes("inbound")
    && /"client_to_agent"/.test(resp) && /\.from\("voice_calls"\)[^\n]*\.eq\("direction", "inbound"\)/.test(resp))
// CHECK-legal words the calculator writes
const trendWords = [...calcFn.matchAll(/engagementTrend = (?:[^\n]*?\? )?"(\w[\w ]*)"(?: : "(\w[\w ]*)")?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean) as string[]
const trendVocab = CHECK_VOCABULARIES.buyer_fatigue_scores.engagement_trend
check("every engagement_trend word the calculator writes is CHECK-legal (the 87A words 'no recent activity' / 'sharp decline' were refused 23514)",
  trendWords.length >= 4 && trendWords.every((w) => trendVocab.includes(w)), trendWords.join(","))
check("POSITIVE CONTROL: the vocabulary refuses the 87A word", !trendVocab.includes("no recent activity") && !trendVocab.includes("sharp decline"))
const alertWords = [...calcFn.matchAll(/\? "(\w+)" : "(\w+)",/g)].flatMap((m) => [m[1], m[2]]).filter((w) => /_/.test(w))
check("the alert type chosen by the dominant driver is CHECK-legal (disengagement_risk | fatigue_threshold_crossed)",
  alertWords.includes("disengagement_risk") && alertWords.every((w) => CHECK_VOCABULARIES.fatigue_alerts.alert_type.includes(w)), alertWords.join(","))
check("the buyer-engagement term applies only to a person WITH a buyer search (no flat +40 for a seller scored on follow-up)",
  /const hasBuyerSearch = /.test(calcFn) && /if \(hasBuyerSearch && \(noSignals7d/.test(calcFn))
check("the OWNING AGENT is stamped on the score (buyer_fatigue_scores.agent_id — the writer that was missing)",
  /agent_id:\s+contact\.agent_id \?\? null,/.test(calcFn))
// Words
const disp = await import("../lib/fatigue/fatigue-display")
const words = disp.describeFatigueFactors({ follow_ups_sent: 5, replies_received: 0, unanswered_follow_ups: 5, missed_appointments: 2, unsigned_seller: true, seller_unresponsive: true, saturated_channels: ["email"] })
check("the ONE factor sentence names unanswered follow-up, the cap, missed appointments and the quiet unsigned seller",
  /no reply to 5 follow-ups/.test(words) && /over-touch cap on email/.test(words) && /2 missed appointments/.test(words) && /not signed a listing agreement and is not answering/.test(words), words)
check("POSITIVE CONTROL: an 87A-only snapshot says nothing about follow-up", !/follow-up|missed|seller/.test(disp.describeFatigueFactors({ total_showings: 3, total_tour_days: 1, days_searching: 20, offers_rejected: 0 })))
const guard88 = disp.buildReachoutGuard({ fatigue_score: 60, risk_level: "high", offers_rejected: 0, engagement_trend: "stable", contributing_factors: { unanswered_follow_ups: 4, missed_appointments: 1, seller_unresponsive: true } }, null)
check("the contact-card guard tells the agent why (unanswered follow-ups, missed appointment, unsigned seller)",
  !guard88.safeToReachOut && /4 follow-ups unanswered/.test(guard88.reason) && /1 missed appointment/.test(guard88.reason) && /Unsigned seller/.test(guard88.reason), guard88.reason)
check("the score and the card share ONE floor (fatigue-display UNANSWERED_FOLLOW_UP_FLOOR imported by the calculator)",
  /import \{[^}]*UNANSWERED_FOLLOW_UP_FLOOR[^}]*\} from "\.\/fatigue-display"/.test(calcSrc) && !/const UNANSWERED_FOLLOW_UP_FLOOR/.test(calcSrc))

// ── F7 ────────────────────────────────────────────────────────────────────────
console.log("\n[F7 · the agent-level signal — agent coaching reads the fatigued book]")
const coach = await import("../lib/kernel/agent-coaching")
const baseStats = { agentId: "ag-1", name: "A", ytdGci: 0, closings: 0, activeDeals: 0, avgHealthScore: null, tours: 0, offers: 0, appointments: 0, noShows: 0, staleContacts: 0, lessonsAssigned: 0, lessonsCompleted: 0, educationCompletionPct: null }
const fb = coach.composeCoachingBrief({ ...baseStats, fatiguedContacts: coach.FATIGUED_LEAK_COUNT })
check("a book with FATIGUED_LEAK_COUNT high-fatigue contacts is a coaching LEAK (and the focus)", fb.leaks.some((l: string) => /high fatigue/.test(l)) && /fatigued contacts/.test(fb.focusThisWeek))
const fb0 = coach.composeCoachingBrief({ ...baseStats, fatiguedContacts: coach.FATIGUED_LEAK_COUNT - 1 })
check("POSITIVE CONTROL: one fewer is not a leak (and an absent metric is never zero-faked into one)",
  !fb0.leaks.some((l: string) => /high fatigue/.test(l)) && !coach.composeCoachingBrief(baseStats as any).leaks.some((l: string) => /high fatigue/.test(l)))
const coachSrc = stripped("lib/kernel/agent-coaching.ts")
check("coaching reads buyer_fatigue_scores by agent_id (agents.id) in the brokerage, high/critical only, and READS the error",
  /\.from\("buyer_fatigue_scores"\)\.select\("agent_id"\)[\s\S]{0,120}\.eq\("brokerage_id", brokerageId\)\.in\("agent_id", agentIds\)[\s\S]{0,60}\.in\("risk_level", \["high", "critical"\]\)/.test(coachSrc)
    && /if \(fatiguedErr\)/.test(coachSrc) && /fatiguedContacts: fatiguedErr \? undefined/.test(coachSrc))

// ── F5 ────────────────────────────────────────────────────────────────────────
console.log("\n[F5 · registration]")
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> }
check("package.json registers test:fatigue-population", pkg.scripts["test:fatigue-population"] === "tsx scripts/fatigue-population-guard.ts")
const guard = pkg.scripts.guard ?? ""
check("the guard chain runs it AFTER test:scrapers", guard.indexOf("npm run test:scrapers") >= 0 && guard.indexOf("npm run test:fatigue-population") > guard.indexOf("npm run test:scrapers"))
const { MAINTENANCE_DOMAINS } = await import("../lib/kernel/manager-registry")
check("MAINTENANCE_DOMAINS owns it", Object.values(MAINTENANCE_DOMAINS).some((d: any) => d.proof === "test:fatigue-population"))

console.log(`\n  denominators: ${fc.FATIGUE_INPUT_SOURCES.length} inputs (4 buyer-search · ${CONTACT_TOUCH_LEDGERS.length} over-touch ledgers · 1 no-show) + ${fc.FATIGUE_RESPONSE_SOURCES.length} reply lanes · 8 (+4 wave-88) contacts / 4 leads / 2 tenants in the double · 7 refused-read cases · 3 list readers + 6 one-contact doors`)
console.log("  blind spots: the loader is run against an in-memory double, not live (live had 0 showings / tours / offers / behavior rows / leads on 2026-09-28); calculateFatigue's own reads are proven by source shape, not executed (it builds its own service client); a source row stamped brokerage_id NULL is seen only by the PLATFORM sweep; the population read is linear in input ROWS (PostgREST has no DISTINCT) — capped at 200 pages per source and reported as inputsCapped; WAVE 88: the new reads inside calculateFatigue are proven by source shape plus the pure terms (followUpResponsiveness / responsivenessPoints / saturatedChannels), not executed against a DB; the over-touch ledgers are counted as the engine counts them — every row regardless of delivery status (a lifetime touchpoint dates by created_at even when only scheduled); a reply is an inbound message / portal message / inbound call / ISA replied_at — an email reply that lands nowhere but a mailbox is not seen; a seller whose agreement lives only outside listing_agreements reads unsigned; the learned (learn:true) cadence is not applied — fatigue reads the default cap; appointments.status 'no_show' is NOT an input — nothing writes that table (test:writerless-reads), calendar_events is the one appointment ledger")
console.log("\n" + "─".repeat(50))
console.log(` RESULT: ${passed} passed, ${failed} failed`)
console.log(failed === 0 ? " ✅ FATIGUE_POPULATION_PASS" : " ❌ FATIGUE_POPULATION_FAIL")
if (failed) for (const f of failures) console.log(`   · ${f}`)
process.exit(failed === 0 ? 0 : 1)
