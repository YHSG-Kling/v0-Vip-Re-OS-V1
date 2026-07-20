#!/usr/bin/env tsx
/**
 * scripts/dispatcher-load-simulator.ts   (run: npx tsx scripts/dispatcher-load-simulator.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * DISPATCHER LOAD POSTURE — schedule-math load measurement for the per-minute
 * cron dispatcher (lib/kernel/cron-dispatch.ts).
 *
 * WHAT THIS IS: a synthetic, pure measurement of the dispatcher's tick logic —
 * the real CRON_REGISTRY and the real isDue() matcher run over a simulated 24h
 * of minutes (plus a full-year sweep for calendar-stacked worst cases), with a
 * synthetic 100-tenant multiplier applied to the crons that fan out per tenant.
 *
 * WHAT THIS IS NOT: a network load test. No HTTP is fired, no route executes,
 * no DB is touched. Numbers are schedule math over the production registry —
 * honestly labeled as such.
 *
 * Per-tenant classification: each registered path is resolved to its route file
 * and statically scanned for per-brokerage fan-out patterns (a brokerages list
 * read without a single-row narrowing, activeSubscriberBrokerageIds, or an
 * explicit per-brokerage loop). This is a HEURISTIC — the classification list
 * is printed so it can be audited, not trusted blindly.
 *
 * Output: matches/minute distribution, the worst minutes, the per-tenant
 * multiplier crons, and the first shard boundary as a documented threshold
 * (at N tenants the worst minute exceeds M jobs). LOAD-POSTURE.md is written
 * from a run of this simulator.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { CRON_REGISTRY, isDue } from "../lib/kernel/cron-dispatch"

const TENANTS = Number(process.env.LOAD_SIM_TENANTS ?? 100)
const JOB_BUDGET_PER_MINUTE = Number(process.env.LOAD_SIM_JOB_BUDGET ?? 500)

let pass = 0, fail = 0
const check = (n: string, c: boolean, d?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}${d ? ` — ${d}` : ""}`) }
  else { fail++; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) }
}

// ─── per-tenant fan-out classification (static scan, heuristic) ──────────────
interface CronClass {
  path: string
  schedule: string
  file: string | null
  perTenant: boolean
  signal: string | null
}

function routeFileFor(path: string): string | null {
  const clean = path.split("?")[0]
  const file = join(process.cwd(), "app", clean, "route.ts")
  return existsSync(file) ? file : null
}

/** Fan-out signals, checked in order; the matched signal is reported. */
function classifyRoute(src: string): { perTenant: boolean; signal: string | null } {
  if (/activeSubscriberBrokerageIds/.test(src)) return { perTenant: true, signal: "activeSubscriberBrokerageIds" }
  // A brokerages read that is NOT narrowed to one row (.eq("id"…) / .limit(1) /
  // .maybeSingle/.single in the immediate chain) = a tenant list read.
  const re = /from\((["'])brokerages\1\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const windowAfter = src.slice(m.index, m.index + 300)
    const narrowed = /\.eq\((["'])id\1/.test(windowAfter) || /\.limit\(1\)/.test(windowAfter) ||
      /\.maybeSingle\(\)/.test(windowAfter) || /\.single\(\)/.test(windowAfter)
    if (!narrowed) return { perTenant: true, signal: 'brokerages list read (from("brokerages") without single-row narrowing)' }
  }
  if (/for\s*\(const\s+\w*brokerage/i.test(src)) return { perTenant: true, signal: "per-brokerage loop" }
  return { perTenant: false, signal: null }
}

function classifyRegistry(): CronClass[] {
  return CRON_REGISTRY.map((c) => {
    const file = routeFileFor(c.path)
    if (!file) return { path: c.path, schedule: c.schedule, file: null, perTenant: false, signal: "route file not found (counted global)" }
    const { perTenant, signal } = classifyRoute(readFileSync(file, "utf8"))
    return { path: c.path, schedule: c.schedule, file, perTenant, signal }
  })
}

// ─── schedule sweep ──────────────────────────────────────────────────────────
interface MinuteLoad { at: string; routes: number; jobs: number; paths: string[] }

function sweepDay(day: Date, classes: CronClass[], tenants: number): MinuteLoad[] {
  const out: MinuteLoad[] = []
  for (let m = 0; m < 1440; m++) {
    const at = new Date(day.getTime() + m * 60_000)
    let routes = 0, jobs = 0
    const paths: string[] = []
    for (const c of classes) {
      if (!isDue(c.schedule, at)) continue
      routes++
      jobs += c.perTenant ? tenants : 1
      paths.push(c.path)
    }
    out.push({ at: at.toISOString().slice(0, 16) + "Z", routes, jobs, paths })
  }
  return out
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
}

async function main() {
  console.log("══════════════════════════════════════════════════════════")
  console.log(" DISPATCHER LOAD POSTURE — schedule math over the real registry")
  console.log(` registry=${CRON_REGISTRY.length} crons · synthetic tenants=${TENANTS} · NOT a network load test`)
  console.log("══════════════════════════════════════════════════════════")

  // ── classification ────────────────────────────────────────────────────────
  console.log("\n[1 · per-tenant fan-out classification (static scan — heuristic, auditable)]")
  const classes = classifyRegistry()
  const perTenant = classes.filter((c) => c.perTenant)
  const unresolved = classes.filter((c) => !c.file)
  check(`registry size ${CRON_REGISTRY.length} (every entry classified)`, classes.length === CRON_REGISTRY.length)
  check(`route files resolved for ${classes.length - unresolved.length}/${classes.length} entries`, unresolved.length === 0,
    unresolved.length ? unresolved.map((u) => u.path).join(", ") : undefined)
  console.log(`  ℹ per-tenant multiplier crons: ${perTenant.length}/${classes.length}`)
  for (const c of perTenant) console.log(`     · ${c.path}  [${c.schedule}]  ← ${c.signal}`)

  // ── 24h sweep (a Monday — weekday-stacked schedules land on Mondays) ──────
  console.log("\n[2 · 24h minute sweep — Monday 2026-07-20 UTC]")
  const day = new Date(Date.UTC(2026, 6, 20)) // a Monday
  const minutes = sweepDay(day, classes, TENANTS)
  const routesSorted = minutes.map((m) => m.routes).sort((a, b) => a - b)
  const jobsSorted = minutes.map((m) => m.jobs).sort((a, b) => a - b)
  const totalRouteDispatches = minutes.reduce((s, m) => s + m.routes, 0)
  const totalJobs = minutes.reduce((s, m) => s + m.jobs, 0)
  const activeMinutes = minutes.filter((m) => m.routes > 0).length

  const worstByRoutes = [...minutes].sort((a, b) => b.routes - a.routes)[0]
  const worstByJobs = [...minutes].sort((a, b) => b.jobs - a.jobs)[0]

  console.log(`  route dispatches/day: ${totalRouteDispatches} across ${activeMinutes}/1440 active minutes`)
  console.log(`  routes/minute: p50=${percentile(routesSorted, 50)} p90=${percentile(routesSorted, 90)} p99=${percentile(routesSorted, 99)} max=${routesSorted[routesSorted.length - 1]}`)
  console.log(`  jobs/minute (${TENANTS}-tenant multiplier on per-tenant crons): p50=${percentile(jobsSorted, 50)} p90=${percentile(jobsSorted, 90)} p99=${percentile(jobsSorted, 99)} max=${jobsSorted[jobsSorted.length - 1]}`)
  console.log(`  worst minute by routes: ${worstByRoutes.at} → ${worstByRoutes.routes} routes (${worstByRoutes.jobs} jobs)`)
  console.log(`  worst minute by jobs:   ${worstByJobs.at} → ${worstByJobs.jobs} jobs from ${worstByJobs.routes} routes`)
  const topStack = [...minutes].sort((a, b) => b.jobs - a.jobs).slice(0, 5)
  console.log("  top-5 stacked minutes (by jobs):")
  for (const m of topStack) console.log(`     · ${m.at}: ${m.routes} routes, ${m.jobs} jobs`)
  check("dispatcher fires every minute-of-day it should (sweep covered 1440 minutes)", minutes.length === 1440)
  check("worst minute identified with non-zero load", worstByJobs.jobs > 0, `${worstByJobs.at} @ ${worstByJobs.jobs} jobs`)

  // ── full-year sweep for calendar-stacked cases (dom/month schedules) ──────
  console.log("\n[3 · full-year worst-minute sweep (dom/month-stacked schedules)]")
  let yearWorst: MinuteLoad = { at: "", routes: 0, jobs: 0, paths: [] }
  const t0 = Date.now()
  for (let d = 0; d < 365; d++) {
    const dd = new Date(Date.UTC(2026, 0, 1 + d))
    for (const m of sweepDay(dd, classes, TENANTS)) {
      if (m.jobs > yearWorst.jobs) yearWorst = m
    }
  }
  console.log(`  swept 365×1440 minutes in ${Date.now() - t0}ms`)
  console.log(`  year-worst minute: ${yearWorst.at} → ${yearWorst.routes} routes, ${yearWorst.jobs} jobs`)
  check("year-worst minute ≥ Monday worst (calendar stacking accounted for)", yearWorst.jobs >= worstByJobs.jobs)

  // ── shard boundary — documented threshold, schedule math only ─────────────
  console.log("\n[4 · first shard boundary (documented threshold — schedule math, not a benchmark)]")
  // jobs(worst minute, N tenants) = G + P·N, where at the year-worst minute
  // G = due global routes and P = due per-tenant routes.
  const worstAt = new Date(yearWorst.at.replace("Z", ":00Z"))
  let G = 0, P = 0
  for (const c of classes) {
    if (!isDue(c.schedule, worstAt)) continue
    if (c.perTenant) P++
    else G++
  }
  const boundaryTenants = P > 0 ? Math.ceil((JOB_BUDGET_PER_MINUTE - G) / P) : Infinity
  console.log(`  worst minute decomposition: ${G} global routes + ${P} per-tenant routes`)
  console.log(`  jobs(N) = ${G} + ${P}·N  →  at N=${TENANTS}: ${G + P * TENANTS} jobs`)
  console.log(`  documented budget: ${JOB_BUDGET_PER_MINUTE} jobs/minute (LOAD_SIM_JOB_BUDGET to change)`)
  console.log(`  ⇒ FIRST SHARD BOUNDARY: at ${boundaryTenants} tenants the ${yearWorst.at.slice(11)} minute exceeds ${JOB_BUDGET_PER_MINUTE} jobs`)
  check("shard boundary computable from the worst-minute decomposition", Number.isFinite(boundaryTenants) && boundaryTenants > 0)

  // Emit a machine-readable summary line (LOAD-POSTURE.md is written from this).
  console.log("\n[summary-json] " + JSON.stringify({
    registry: CRON_REGISTRY.length,
    tenants: TENANTS,
    perTenantCrons: perTenant.map((c) => ({ path: c.path, schedule: c.schedule })),
    day: { totalRouteDispatches, activeMinutes, routesP50: percentile(routesSorted, 50), routesMax: routesSorted[routesSorted.length - 1], jobsMax: jobsSorted[jobsSorted.length - 1], worstByJobs: { at: worstByJobs.at, routes: worstByJobs.routes, jobs: worstByJobs.jobs } },
    yearWorst: { at: yearWorst.at, routes: yearWorst.routes, jobs: yearWorst.jobs },
    shard: { G, P, budget: JOB_BUDGET_PER_MINUTE, boundaryTenants },
  }))

  console.log("\n──────────────────────────────────────────────────────────")
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ DISPATCHER_LOAD_FAIL"); process.exit(1) }
  console.log(" ✅ DISPATCHER_LOAD_PASS — schedule-math posture measured (see LOAD-POSTURE.md)")
}

main().catch((e) => { console.error("dispatcher-load-simulator crashed:", e); process.exit(1) })
