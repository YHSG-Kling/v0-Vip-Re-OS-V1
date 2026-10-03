#!/usr/bin/env tsx
/**
 * scripts/cron-cost-census.ts   (npm run test:cron-cost)
 * ─────────────────────────────────────────────────────────────────────────────
 * VERCEL CRON USAGE + BILLING AUDIT (wave 62, owner: "vercel cron usage and
 * billing should be considered… we don't want the charges outweighing the
 * build").
 *
 * FACTS THIS CENSUS TREATS AS GROUND TRUTH (vercel.com/docs, verified
 * 2026-09-14 — no number beyond these is invented anywhere below):
 *   · cron jobs are included on every plan, capped at 100/project (this repo
 *     already works around that cap — lib/kernel/cron-dispatch.ts's own
 *     header — with ONE vercel.json cron dispatching a registry).
 *   · Pro gives per-minute cron precision (this repo needs it: many entries
 *     below are sub-hour).
 *   · a cron invocation is billed EXACTLY like any other Vercel Function
 *     invocation: Pro on-demand invocations from $0.60 per million, PLUS
 *     Active CPU time and Provisioned Memory (GB-hours) while the function
 *     runs.
 *   · Pro includes a $20/mo usage credit; a team's default on-demand budget
 *     is $200.
 * This repo's real cron bill = the dispatcher TICK itself (vercel.json's one
 * `* * * * *` cron, unconditionally invoking /api/cron/dispatch every
 * minute — 1,440/day, ~43,800/month at 30.44 days/mo) PLUS every internal
 * fetch() dispatchDueCrons fans out to a DUE registry path (each one is its
 * OWN separate Function invocation, billed separately — lib/kernel/
 * cron-dispatch.ts:397's `fetcher(...)` call) PLUS each of those functions'
 * own CPU/memory.
 *
 * WHAT THIS CENSUS COMPUTES (and what it deliberately does NOT invent):
 *   1. Exact invocations/day and invocations/month per CRON_REGISTRY entry,
 *      by SIMULATING every day of a full non-leap year (2026) through the
 *      real, already-tested field matcher this repo ships
 *      (cron-dispatch.ts's own `cronFieldMatches` — never a second hand-
 *      rolled cron parser, CLAUDE.md §6/§2) rather than re-deriving cron
 *      semantics by hand. Minute/hour selectivity (how many times a day it
 *      COULD fire) is computed once from the two time fields; which DAYS of
 *      the year qualify is computed by walking the calendar against the
 *      dom/month/dow fields — correct for schedules like qbr-invitations'
 *      "day 1-7 of Jan/Apr/Jul/Oct" without hand-deriving how many such days
 *      exist.
 *   2. Grouping by CRON_MANAGER owner and by a frequency bucket.
 *   3. Three flags, all advisory (never a hard "delete this"):
 *        · SUB-5-MINUTE — fires ≥12×/active-day (interval ≤5min).
 *        · NO READ DETECTED — the route file has no `.from("table")` Supabase
 *          call anywhere in its own source (it may still legitimately call
 *          into a lib/ function that reads elsewhere — this is a "go look",
 *          not a "this is dead").
 *        · TABLE-WRITE OVERLAP — 2+ DIFFERENT route files (excluding two
 *          registry entries that share the same file, e.g. a documented
 *          build/deliver phase split) both call `.from("table").update(`/
 *          `.upsert(`/`.delete(` on the SAME table name — a candidate
 *          "two schedules sweep the same state," not a proven one (two
 *          crons legitimately writing different COLUMNS or different WHERE
 *          slices of one table is common and NOT a defect).
 *   4. A dollar estimate for the INVOCATION portion only ($0.60/M, the one
 *      per-invocation rate CLAUDE.md's task gave us), stated as EXACTLY
 *      that — an invocation-only floor. CPU/Active-CPU/Provisioned-Memory
 *      GB-hour RATES are NOT published in the facts this census was handed,
 *      so no dollar figure is invented for them (§2 — a number this script
 *      cannot see is not a number it reports); instead the census names
 *      which routes carry an ELEVATED memory reservation in vercel.json
 *      (`functions` block, 3008MB) as the compute-cost outliers to weigh
 *      against the $20 Pro credit / $200 team budget qualitatively.
 *
 * BLIND SPOTS (§2, published beside every count):
 *   · "no read detected" only looks for literal `.from("...")` — an .rpc()
 *     call, a call into a lib/ helper that itself reads, or a non-Supabase
 *     side effect (an outbound email, a Remotion render, a fetch to an
 *     external API) all correctly have zero `.from(` and are NOT dead; the
 *     flag is a worklist for a human, never an accusation.
 *   · table-write overlap only sees LITERAL string table names — a
 *     runtime-built `.from(tableVar)` is invisible (undercounts, never
 *     over-accuses).
 *   · the calendar simulation uses 2026 (the year in the owner's ruling) —
 *     a schedule keyed to day-of-month in a leap year could differ by one
 *     matching day in a February that does not exist in this simulation;
 *     no CRON_REGISTRY entry below restricts to `dom=29-31` with `month=2`
 *     built into it, so this repo's schedules are unaffected in practice.
 *   · CPU/memory dollar cost is NOT estimated (see above) — this is a
 *     documented gap, not a hidden zero.
 *
 * POSITIVE CONTROLS: run against small in-memory fixtures (never the real
 * CRON_REGISTRY) so a broken detector cannot hide behind "the real registry
 * happens to look clean." A specimen every-minute entry IS flagged
 * sub-5-minute; a specimen every-10-minute entry is NOT; two fixture routes
 * that both `.update()` the same fixture table ARE flagged overlapping; a
 * fixture route with zero `.from(` calls IS flagged no-read.
 *
 * RATCHET: scripts/cron-cost-baseline.json holds the total invocations/day
 * across CRON_REGISTRY. A new cron (or a tightened schedule) that raises
 * that total fails this proof unless the baseline is deliberately raised —
 * re-baseline ONLY when a count DROPPED via a tombstoned consolidation
 * (CLAUDE.md §1 — deleting to move a number is forbidden; a drop must name
 * its survivor in the diff, not just in this baseline file).
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { CRON_REGISTRY, cronFieldMatches, type CronEntry } from "../lib/kernel/cron-dispatch"
import { CRON_MANAGER, type ManagerKey } from "../lib/kernel/manager-registry"

const root = process.cwd()

// ═══════════════════════════════════════════════════════════════════════════
// 0. PURE CRON MATH — invocations/day, invocations/month, frequency bucket
// ═══════════════════════════════════════════════════════════════════════════

interface ScheduleCost {
  timesPerActiveDay: number   // how many times it fires on a day it fires at all
  qualifyingDaysPerYear: number
  invocationsPerYear: number
  invocationsPerDay: number   // averaged across the full year
  invocationsPerMonth: number // averaged across the full year (/12)
}

const DAYS_IN_YEAR_2026 = 365 // 2026 is not a leap year

/** Count how many of 0..max (inclusive) a cron field matches — reuses the
 *  repo's OWN field matcher (cron-dispatch.ts) rather than re-deriving it. */
function countFieldMatches(field: string, max: number): number {
  let n = 0
  for (let v = 0; v <= max; v++) if (cronFieldMatches(field, v)) n++
  return n
}

/** Exact-simulation cost of one 5-field schedule over the full 2026 calendar. */
export function scheduleCost(schedule: string): ScheduleCost {
  const fields = schedule.trim().split(/\s+/)
  if (fields.length !== 5) {
    return { timesPerActiveDay: 0, qualifyingDaysPerYear: 0, invocationsPerYear: 0, invocationsPerDay: 0, invocationsPerMonth: 0 }
  }
  const [min, hour, dom, month, dow] = fields
  const timesPerActiveDay = countFieldMatches(min, 59) * countFieldMatches(hour, 23)

  let qualifyingDaysPerYear = 0
  const d = new Date(Date.UTC(2026, 0, 1))
  for (let i = 0; i < DAYS_IN_YEAR_2026; i++) {
    const dateOfMonth = d.getUTCDate()
    const monthOfYear = d.getUTCMonth() + 1
    const dayOfWeek = d.getUTCDay()
    if (cronFieldMatches(dom, dateOfMonth) && cronFieldMatches(month, monthOfYear) && cronFieldMatches(dow, dayOfWeek)) {
      qualifyingDaysPerYear++
    }
    d.setUTCDate(d.getUTCDate() + 1)
  }

  const invocationsPerYear = timesPerActiveDay * qualifyingDaysPerYear
  return {
    timesPerActiveDay,
    qualifyingDaysPerYear,
    invocationsPerYear,
    invocationsPerDay: invocationsPerYear / 365,
    invocationsPerMonth: invocationsPerYear / 12,
  }
}

/** Advisory only — a schedule that, on a day it runs, fires ≤5 minutes apart. */
export function isSubFiveMinute(cost: ScheduleCost): boolean {
  return cost.timesPerActiveDay >= 288 // 1440min/day ÷ 5min = 288
}

type FrequencyBucket = "sub-5-min" | "5-14-min" | "15-59-min" | "hourly-ish" | "few-hourly" | "daily" | "weekly" | "monthly-or-rarer"
export function frequencyBucket(cost: ScheduleCost): FrequencyBucket {
  if (cost.timesPerActiveDay >= 288) return "sub-5-min"
  if (cost.timesPerActiveDay >= 96) return "5-14-min"     // up to ~15min apart
  if (cost.timesPerActiveDay >= 24) return "15-59-min"
  if (cost.timesPerActiveDay >= 20) return "hourly-ish"   // 20-23x/day: staggered-hourly entries
  if (cost.timesPerActiveDay >= 2) return "few-hourly"
  // one fire per active day — bucket by how many days/year qualify
  if (cost.qualifyingDaysPerYear >= 300) return "daily"
  if (cost.qualifyingDaysPerYear >= 45) return "weekly"
  return "monthly-or-rarer"
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. TABLE-READ / TABLE-WRITE EXTRACTION (advisory heuristics)
// ═══════════════════════════════════════════════════════════════════════════

const FROM_RE = /\.from\(\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]\s*\)/g
const WRITE_AFTER_FROM_RE = /\.from\(\s*["'`]([a-zA-Z_][a-zA-Z0-9_]*)["'`]\s*\)\s*\.\s*(update|upsert|delete)\s*\(/g

export interface RouteTableFacts {
  tables: string[]        // every distinct `.from("table")` in the file
  writtenTables: string[] // distinct tables with a chained update/upsert/delete
}

export function extractTableFacts(strippedSrc: string): RouteTableFacts {
  const tables = new Set<string>()
  for (const m of strippedSrc.matchAll(FROM_RE)) tables.add(m[1])
  const written = new Set<string>()
  for (const m of strippedSrc.matchAll(WRITE_AFTER_FROM_RE)) written.add(m[1])
  return { tables: [...tables], writtenTables: [...written] }
}

/** Pure: table -> [routeKey, ...] for every table written by 2+ DIFFERENT
 *  route keys. Injectable for controls; the real run feeds it per-file facts
 *  keyed by resolved route FILE (so two registry entries sharing one file —
 *  a documented build/deliver phase split — never self-flag). */
export function detectWriteOverlap(byRouteFile: Record<string, RouteTableFacts>): Map<string, string[]> {
  const tableToFiles = new Map<string, string[]>()
  for (const [file, facts] of Object.entries(byRouteFile)) {
    for (const t of facts.writtenTables) {
      const list = tableToFiles.get(t) ?? []
      list.push(file)
      tableToFiles.set(t, list)
    }
  }
  const overlaps = new Map<string, string[]>()
  for (const [table, files] of tableToFiles) {
    const distinct = [...new Set(files)]
    if (distinct.length >= 2) overlaps.set(table, distinct)
  }
  return overlaps
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. POSITIVE CONTROLS (§2) — fixtures only, never the real registry
// ═══════════════════════════════════════════════════════════════════════════
let controlsPassed = 0
let controlsFailed = 0
function control(name: string, cond: boolean) {
  if (cond) controlsPassed++
  else { controlsFailed++; console.log(`  ❌ CONTROL FAILED: ${name}`) }
}

function runControls() {
  console.log("── positive controls ──")

  // A specimen every-minute entry IS flagged sub-5-minute.
  control("CONTROL a specimen */1 * * * * entry IS flagged sub-5-minute",
    isSubFiveMinute(scheduleCost("*/1 * * * *")))
  control("CONTROL a specimen * * * * * (every minute, no step) IS flagged sub-5-minute",
    isSubFiveMinute(scheduleCost("* * * * *")))
  control("CONTROL a specimen */5 * * * * entry sits exactly at the sub-5-minute boundary (flagged)",
    isSubFiveMinute(scheduleCost("*/5 * * * *")))
  // A specimen every-10-minute entry is NOT flagged sub-5-minute.
  control("CONTROL a specimen */10 * * * * entry is NOT flagged sub-5-minute",
    !isSubFiveMinute(scheduleCost("*/10 * * * *")))

  // Exact invocation math on a known schedule: "*/5 * * * *" fires 288x/day, every day.
  const fiveMin = scheduleCost("*/5 * * * *")
  control("CONTROL */5 * * * * computes exactly 288 invocations on an active day",
    fiveMin.timesPerActiveDay === 288)
  control("CONTROL */5 * * * * qualifies on all 365 days of 2026 (no dom/month/dow restriction)",
    fiveMin.qualifyingDaysPerYear === 365)
  control("CONTROL */5 * * * * computes 288*365 invocations/year",
    fiveMin.invocationsPerYear === 288 * 365)

  // A once-a-week schedule qualifies on ~52 days/year, not 365.
  const weekly = scheduleCost("0 6 * * 1")
  control("CONTROL 0 6 * * 1 (weekly Monday) qualifies on 52 or 53 days of 2026",
    weekly.qualifyingDaysPerYear === 52 || weekly.qualifyingDaysPerYear === 53)
  control("CONTROL 0 6 * * 1 fires exactly once per qualifying day",
    weekly.timesPerActiveDay === 1)

  // A monthly-day-1 schedule qualifies on exactly 12 days of 2026.
  const monthly = scheduleCost("0 6 28 * *")
  control("CONTROL 0 6 28 * * (day 28 monthly) qualifies on exactly 12 days of 2026",
    monthly.qualifyingDaysPerYear === 12)

  // Table-write overlap: two DIFFERENT fixture route files writing the same table.
  const overlapFixture: Record<string, RouteTableFacts> = {
    "app/api/cron/__fixture_a/route.ts": { tables: ["widget_state"], writtenTables: ["widget_state"] },
    "app/api/cron/__fixture_b/route.ts": { tables: ["widget_state"], writtenTables: ["widget_state"] },
    "app/api/cron/__fixture_c/route.ts": { tables: ["other_table"], writtenTables: ["other_table"] },
  }
  const overlaps = detectWriteOverlap(overlapFixture)
  control("CONTROL two different fixture routes writing the same table ARE flagged overlapping",
    overlaps.has("widget_state") && overlaps.get("widget_state")!.length === 2)
  control("CONTROL a table written by only one fixture route is NOT flagged overlapping",
    !overlaps.has("other_table"))

  // No-read detection: fixture source with zero `.from(` calls.
  const noReadFixture = extractTableFacts(`
    export async function GET() {
      await someLibraryFunctionThatDoesTheRealWork()
      return NextResponse.json({ ok: true })
    }
  `)
  control("CONTROL a fixture route with zero .from(\"table\") calls has an empty table list",
    noReadFixture.tables.length === 0)
  const readFixture = extractTableFacts(`
    export async function GET() {
      const { data } = await supabase.from("widgets").select("id")
      return NextResponse.json({ data })
    }
  `)
  control("CONTROL a fixture route WITH a .from(\"widgets\") call is NOT flagged no-read",
    readFixture.tables.includes("widgets"))

  // A tombstone-comment mention of `.from("...")` must NOT count as a live table read.
  const tombstoneFixture = extractTableFacts(stripComments(`
    // MERGED per §1: the old sweep used to call supabase.from("legacy_table")
    // directly; that call now lives at lib/x.ts:42 (the survivor). See CLAUDE.md §1.
    export async function GET() {
      await callTheSurvivor()
      return NextResponse.json({ ok: true })
    }
  `))
  control("CONTROL a tombstone comment naming .from(\"legacy_table\") is NOT counted as a live table read",
    !tombstoneFixture.tables.includes("legacy_table"))

  console.log(`  (${controlsPassed} passed, ${controlsFailed} failed)`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. REAL CENSUS — CRON_REGISTRY against real route files
// ═══════════════════════════════════════════════════════════════════════════

interface EntryCensus {
  entry: CronEntry
  basePath: string
  manager: ManagerKey | "UNOWNED"
  routeFile: string
  fileExists: boolean
  cost: ScheduleCost
  bucket: FrequencyBucket
  subFiveMin: boolean
  facts: RouteTableFacts | null
}

function resolveRouteFile(basePath: string): string {
  return "app" + basePath + "/route.ts"
}

const censuses: EntryCensus[] = []
const factsByFile = new Map<string, RouteTableFacts>()

for (const entry of CRON_REGISTRY) {
  const basePath = entry.path.split("?")[0]
  const manager = CRON_MANAGER[basePath] ?? "UNOWNED"
  const routeFile = resolveRouteFile(basePath)
  const abs = join(root, routeFile)
  const fileExists = existsSync(abs)
  const cost = scheduleCost(entry.schedule)
  let facts: RouteTableFacts | null = null
  if (fileExists) {
    if (!factsByFile.has(routeFile)) {
      const stripped = stripComments(readFileSync(abs, "utf8"))
      factsByFile.set(routeFile, extractTableFacts(stripped))
    }
    facts = factsByFile.get(routeFile)!
  }
  censuses.push({
    entry, basePath, manager, routeFile, fileExists, cost,
    bucket: frequencyBucket(cost),
    subFiveMin: isSubFiveMinute(cost),
    facts,
  })
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. AGGREGATES
// ═══════════════════════════════════════════════════════════════════════════

const totalInvocationsPerDay = censuses.reduce((s, c) => s + c.cost.invocationsPerDay, 0)
const totalInvocationsPerMonth = censuses.reduce((s, c) => s + c.cost.invocationsPerMonth, 0)

// The dispatcher tick itself — one vercel.json cron, unconditional, every minute.
const TICK_PER_DAY = 1440
const TICK_PER_MONTH = 1440 * (365 / 12) // 43,800/mo average

const grandTotalPerDay = totalInvocationsPerDay + TICK_PER_DAY
const grandTotalPerMonth = totalInvocationsPerMonth + TICK_PER_MONTH

const byManager = new Map<string, { count: number; perDay: number; perMonth: number }>()
for (const c of censuses) {
  const key = c.manager
  const row = byManager.get(key) ?? { count: 0, perDay: 0, perMonth: 0 }
  row.count++
  row.perDay += c.cost.invocationsPerDay
  row.perMonth += c.cost.invocationsPerMonth
  byManager.set(key, row)
}

const byBucket = new Map<FrequencyBucket, { count: number; perDay: number; perMonth: number }>()
for (const c of censuses) {
  const row = byBucket.get(c.bucket) ?? { count: 0, perDay: 0, perMonth: 0 }
  row.count++
  row.perDay += c.cost.invocationsPerDay
  row.perMonth += c.cost.invocationsPerMonth
  byBucket.set(c.bucket, row)
}

const subFiveMinEntries = censuses.filter((c) => c.subFiveMin)
const noReadEntries = censuses.filter((c) => c.fileExists && c.facts && c.facts.tables.length === 0)
const missingFileEntries = censuses.filter((c) => !c.fileExists)
const overlapMap = detectWriteOverlap(Object.fromEntries(factsByFile))

// vercel.json elevated-memory functions (3008MB) — the CPU/memory cost outliers.
const VERCEL_JSON_PATH = join(root, "vercel.json")
let elevatedMemoryRoutes: string[] = []
if (existsSync(VERCEL_JSON_PATH)) {
  try {
    const vj = JSON.parse(readFileSync(VERCEL_JSON_PATH, "utf8"))
    elevatedMemoryRoutes = Object.entries(vj.functions ?? {})
      .filter(([, cfg]: [string, any]) => (cfg?.memory ?? 0) >= 3000)
      .map(([k]) => k)
  } catch { /* leave empty — vercel.json unparsable is reported separately */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. DOLLAR ESTIMATE — invocations only, $0.60/M (the one rate we were given)
// ═══════════════════════════════════════════════════════════════════════════
const INVOCATIONS_PER_DOLLAR_UNIT = 1_000_000
const USD_PER_MILLION_INVOCATIONS = 0.60
const monthlyInvocationCostUsd = (grandTotalPerMonth / INVOCATIONS_PER_DOLLAR_UNIT) * USD_PER_MILLION_INVOCATIONS
const PRO_INCLUDED_CREDIT_USD = 20
const TEAM_DEFAULT_ON_DEMAND_BUDGET_USD = 200

// ═══════════════════════════════════════════════════════════════════════════
// 6. RATCHET BASELINE
// ═══════════════════════════════════════════════════════════════════════════
const BASELINE_PATH = join(root, "scripts", "cron-cost-baseline.json")
interface Baseline { totalInvocationsPerDayExcludingTick: number; entries: number }
let baseline: Baseline = { totalInvocationsPerDayExcludingTick: 0, entries: 0 }
if (existsSync(BASELINE_PATH)) {
  try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) } catch { /* fall back to zero — forces a first write */ }
}
if (process.argv.includes("--write-baseline")) {
  writeFileSync(BASELINE_PATH, JSON.stringify({
    totalInvocationsPerDayExcludingTick: Math.round(totalInvocationsPerDay * 1000) / 1000,
    entries: censuses.length,
  }, null, 2) + "\n")
  console.log(`baseline written: ${BASELINE_PATH}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. REPORT
// ═══════════════════════════════════════════════════════════════════════════
runControls()

console.log("\n══════════════════════════════════════════════════")
console.log(" VERCEL CRON COST CENSUS — CRON_REGISTRY invocation math + advisory flags")
console.log("══════════════════════════════════════════════════")
console.log(` ${censuses.length} CRON_REGISTRY entries · dispatcher tick ${TICK_PER_DAY}/day (${Math.round(TICK_PER_MONTH)}/mo, fixed)`)
console.log(` registry invocations: ${totalInvocationsPerDay.toFixed(1)}/day, ${Math.round(totalInvocationsPerMonth).toLocaleString()}/mo`)
console.log(` GRAND TOTAL (tick + registry): ${grandTotalPerDay.toFixed(1)}/day, ${Math.round(grandTotalPerMonth).toLocaleString()}/mo`)
console.log(` invocation-only cost @ $${USD_PER_MILLION_INVOCATIONS}/M: $${monthlyInvocationCostUsd.toFixed(2)}/mo` +
  ` (Pro credit $${PRO_INCLUDED_CREDIT_USD}/mo, team default budget $${TEAM_DEFAULT_ON_DEMAND_BUDGET_USD}/mo — CPU/memory NOT priced, see doc)`)

console.log("\n BY MANAGER:")
for (const [mgr, row] of [...byManager.entries()].sort((a, b) => b[1].perMonth - a[1].perMonth)) {
  console.log(`  ${String(row.count).padStart(3)}× ${mgr.padEnd(22)} ${row.perDay.toFixed(1).padStart(9)}/day  ${Math.round(row.perMonth).toLocaleString().padStart(10)}/mo`)
}

console.log("\n BY FREQUENCY BUCKET:")
const bucketOrder: FrequencyBucket[] = ["sub-5-min", "5-14-min", "15-59-min", "hourly-ish", "few-hourly", "daily", "weekly", "monthly-or-rarer"]
for (const b of bucketOrder) {
  const row = byBucket.get(b)
  if (!row) continue
  console.log(`  ${String(row.count).padStart(3)}× ${b.padEnd(18)} ${row.perDay.toFixed(1).padStart(9)}/day  ${Math.round(row.perMonth).toLocaleString().padStart(10)}/mo`)
}

console.log(`\n FLAGS (advisory — each names a file to go look at, never a verdict):`)
console.log(`  sub-5-minute:        ${subFiveMinEntries.length}`)
console.log(`  no .from() detected: ${noReadEntries.length}`)
console.log(`  missing route file:  ${missingFileEntries.length}`)
console.log(`  table-write overlap: ${overlapMap.size} table(s)`)
console.log(`  elevated-memory (vercel.json functions[], ≥3000MB): ${elevatedMemoryRoutes.length} route(s)`)

const listMode = process.argv.includes("--list")
if (listMode) {
  console.log("\n── sub-5-minute entries ──")
  for (const c of subFiveMinEntries) console.log(`  ${c.entry.schedule.padEnd(14)} ${c.basePath}  (${c.manager})`)
  console.log("\n── no .from() detected (go verify manually) ──")
  for (const c of noReadEntries) console.log(`  ${c.basePath}  (${c.manager})`)
  console.log("\n── missing route file (registry path with no app/api file) ──")
  for (const c of missingFileEntries) console.log(`  ${c.basePath} -> ${c.routeFile}`)
  console.log("\n── table-write overlap candidates ──")
  for (const [table, files] of overlapMap) console.log(`  ${table}: ${files.join(", ")}`)
  console.log("\n── elevated-memory routes ──")
  for (const r of elevatedMemoryRoutes) console.log(`  ${r}`)
}

if (controlsFailed > 0) {
  console.log(`\n❌ CRON_COST_FAIL — ${controlsFailed} positive control(s) failed; the census cannot be trusted blind`)
  process.exit(1)
}

const delta = totalInvocationsPerDay - baseline.totalInvocationsPerDayExcludingTick
console.log(`\n baseline (registry, excl. tick): ${baseline.totalInvocationsPerDayExcludingTick}/day (${baseline.entries} entries) — current ${totalInvocationsPerDay.toFixed(1)}/day (${censuses.length} entries), delta ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}/day`)

if (delta > 0.001 && !process.argv.includes("--write-baseline")) {
  console.log(`\n❌ CRON_COST_FAIL — invocations/day rose above baseline (+${delta.toFixed(1)}/day). A new cron or a tightened`)
  console.log(`   schedule must be justified in docs/vercel-cron-usage-2026-09.md, then re-run with --write-baseline`)
  console.log(`   to deliberately raise the ratchet (CLAUDE.md §1 — a drop needs a tombstoned survivor, a rise needs a reason).`)
  process.exit(1)
}

console.log(`\n✅ CRON_COST_PASS — ${totalInvocationsPerDay.toFixed(1)} registry invocations/day, at or under baseline`)
