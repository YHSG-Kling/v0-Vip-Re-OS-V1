#!/usr/bin/env tsx
/**
 * scripts/cron-dispatch-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * CRON DISPATCHER harness — one heartbeat, every schedule (Vercel caps platform
 * crons at 40; 105 entries were failing every deployment at config validation).
 *
 * Layer 1 (pure): the cron matcher across every syntax in the registry (steps,
 *   comma lists, day-of-week); duePaths at characteristic minutes.
 * Layer 2 (drift, both directions): every app/api/cron/*\/route.ts is registered;
 *   every registry path resolves to a real route file (query strings allowed);
 *   vercel.json carries ONLY the dispatcher (within platform limits).
 * Layer 3 (dispatch seam): an injected fetcher proves due paths are called with
 *   the Bearer CRON_SECRET header and failures are reported per-path.
 *
 * Run: npx tsx scripts/cron-dispatch-simulator.ts  (npm run test:cron-dispatch)
 */
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { CRON_REGISTRY, cronFieldMatches, isDue, duePaths, dispatchDueCrons, type CronFetcher } from "../lib/kernel/cron-dispatch"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Cron dispatcher verified — one heartbeat, every schedule")
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Cron dispatcher simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · matcher]")
  check("field: '*' matches anything", cronFieldMatches("*", 59))
  check("field: '*/15' matches 0/15/30/45 only", cronFieldMatches("*/15", 30) && !cronFieldMatches("*/15", 20))
  check("field: '8,17' comma list", cronFieldMatches("8,17", 17) && !cronFieldMatches("8,17", 9))
  const mon0100 = new Date(Date.UTC(2026, 5, 8, 1, 0)) // Monday
  const tue0100 = new Date(Date.UTC(2026, 5, 9, 1, 0))
  check("'0 1 * * 1' fires Monday 01:00 UTC, not Tuesday", isDue("0 1 * * 1", mon0100) && !isDue("0 1 * * 1", tue0100))
  check("'30 6,14 * * *' fires 06:30 + 14:30 only",
    isDue("30 6,14 * * *", new Date(Date.UTC(2026, 5, 9, 14, 30))) && !isDue("30 6,14 * * *", new Date(Date.UTC(2026, 5, 9, 7, 30))))
  check("'0 8,17 * * *' twice-daily property alerts", isDue("0 8,17 * * *", new Date(Date.UTC(2026, 5, 9, 17, 0))))
  const at0600mon = duePaths(new Date(Date.UTC(2026, 5, 8, 6, 0)))
  check("Monday 06:00 UTC: dailies + hourlies + steps all due together (>20 paths)", at0600mon.length > 20, `got ${at0600mon.length}`)
  check("Monday 06:00 includes the 6am dailies", at0600mon.includes("/api/cron/contact-enrichment") && at0600mon.includes("/api/deal-health/cron"))
  const at0137 = duePaths(new Date(Date.UTC(2026, 5, 9, 1, 37)))
  check("a quiet minute (01:37) dispatches nothing", at0137.length === 0, `got ${at0137.join(", ")}`)
  check("every registry schedule is valid 5-field syntax the matcher supports",
    CRON_REGISTRY.every((c) => c.schedule.trim().split(/\s+/).length === 5
      && c.schedule.trim().split(/\s+/).every((f) => /^(\*|\*\/\d+|\d+(,\d+)*)$/.test(f))))

  console.log("\n[Layer 2 · drift — registry ⇄ routes ⇄ vercel.json]")
  const root = process.cwd()
  const cronDirs = readdirSync(join(root, "app/api/cron"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, "app/api/cron", d.name, "route.ts")))
    .map((d) => `/api/cron/${d.name}`)
  const registryPaths = new Set(CRON_REGISTRY.map((c) => c.path.split("?")[0]))
  const unregistered = cronDirs.filter((p) => p !== "/api/cron/dispatch" && !registryPaths.has(p))
  check(`every cron route is registered (${cronDirs.length - 1} routes)`, unregistered.length === 0, unregistered.join(", "))
  const missingRoute = Array.from(registryPaths).filter((p) => {
    const rel = p.replace(/^\//, "").split("/")
    return !existsSync(join(root, "app", ...rel, "route.ts"))
  })
  check("every registry path resolves to a real route file", missingRoute.length === 0, missingRoute.join(", "))
  const vercel = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8"))
  check("vercel.json: exactly ONE platform cron (the dispatcher) — within the 40 cap",
    Array.isArray(vercel.crons) && vercel.crons.length === 1 && vercel.crons[0].path === "/api/cron/dispatch" && vercel.crons[0].schedule === "* * * * *")
  check(`registry preserved every schedule (${CRON_REGISTRY.length} ≥ 105 loops)`, CRON_REGISTRY.length >= 105)

  console.log("\n[Layer 3 · dispatch seam]")
  process.env.CRON_SECRET = process.env.CRON_SECRET || "test-secret-cron-dispatch"
  const calls: Array<{ url: string; auth: string }> = []
  const fetcher: CronFetcher = async (url, headers) => {
    calls.push({ url, auth: headers.authorization })
    return url.includes("appointment-whisper") ? { ok: false, status: 500 } : { ok: true, status: 200 }
  }
  const at = new Date(Date.UTC(2026, 5, 8, 6, 0)) // Monday 06:00
  const r = await dispatchDueCrons({ now: at, fetcher, baseUrl: "https://example.test" })
  check("dispatch: every due path called exactly once", calls.length === r.due && r.due === at0600mon.length)
  check("dispatch: Bearer CRON_SECRET forwarded (targets keep their own auth)",
    calls.every((c) => c.auth === `Bearer ${process.env.CRON_SECRET}`))
  check("dispatch: per-path failures reported, the rest still dispatched",
    r.failures.length === 1 && r.failures[0].path === "/api/cron/appointment-whisper" && r.dispatched === r.due - 1)

  report()
}
main().catch((e) => { console.error(e); process.exit(1) })
