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
 * Layer 2b (lane 88E): every registry target gates through lib/cron-auth.ts
 *   verifyCronAuth (comment-stripped) and reads no ?secret= query credential;
 *   three re-gated targets are invoked for real.
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

  // ── Layer 2b · ONE cron gate on every target (lane 88E) ─────────────────────
  // The registry header promised "All carry their own verifyCronAuth"; 35 of the
  // 208 targets did not — 32 hand-rolled `if (!expected) return {skipped}` (a 200
  // that the dispatcher books as SUCCESS when CRON_SECRET is unset — "nobody
  // checked" rendering as "checked and fine", CLAUDE.md §4) and accepted the
  // secret as a `?secret=` QUERY credential (lands in access logs), plus three
  // Bearer-only copies. Rule: every registry target (and the dispatcher itself)
  // gates through lib/cron-auth.ts verifyCronAuth, read off COMMENT-STRIPPED
  // source (a tombstone naming the helper is not a call site, §2), and no target
  // reads a query-string secret.
  console.log("\n[Layer 2b · every target gates through verifyCronAuth — no second spelling]")
  const { stripComments } = await import("./strip-comments")
  const gateProblems = (src: string): string[] => {
    const s = stripComments(src)
    const out: string[] = []
    if (!/\bverifyCronAuth\s*\(/.test(s)) out.push("no verifyCronAuth( call")
    if (/searchParams\.get\(\s*["']secret["']\s*\)/.test(s)) out.push("reads a ?secret= query credential")
    return out
  }
  // POSITIVE CONTROLS — the finder still sees each shape it was written for.
  const handRolled = `export async function GET(req) {\n  const auth = req.headers.get("authorization")?.replace("Bearer ", "")\n  const qs = new URL(req.url).searchParams.get("secret")\n  const expected = process.env.CRON_SECRET\n  if (!expected) return NextResponse.json({ skipped: "CRON_SECRET not configured" })\n  if (auth !== expected && qs !== expected) return unauthorized()\n}`
  check("CONTROL the pre-88E hand-rolled gate is flagged (no helper call + query credential)",
    gateProblems(handRolled).includes("no verifyCronAuth( call") && gateProblems(handRolled).includes("reads a ?secret= query credential"))
  check("CONTROL a helper named only in a COMMENT is not a call site",
    gateProblems(`// gated by verifyCronAuth(req) upstream\nexport async function GET() { return new Response("ok") }`).includes("no verifyCronAuth( call"))
  check("CONTROL the fleet idiom passes",
    gateProblems(`import { verifyCronAuth } from "@/lib/cron-auth"\nexport async function GET(req) {\n  const denied = verifyCronAuth(req)\n  if (denied) return denied\n}`).length === 0)
  const targets = Array.from(new Set([...registryPaths, "/api/cron/dispatch"]))
  const ungated: string[] = []
  for (const p of targets) {
    const file = join(root, "app", ...p.replace(/^\//, "").split("/"), "route.ts")
    if (!existsSync(file)) continue // reported by the resolve check above
    const probs = gateProblems(readFileSync(file, "utf8"))
    if (probs.length) ungated.push(`${p} (${probs.join("; ")})`)
  }
  check(`every registry target gates through verifyCronAuth and takes no query credential (${targets.length} targets)`,
    ungated.length === 0, ungated.join(", "))

  // RUNTIME — three of the 35 re-gated targets, invoked for real: an unset
  // secret now REFUSES with 500 (it used to answer 200 {skipped}), a query
  // credential is no longer honoured, and the right Bearer gets PAST the gate.
  {
    const { createRequire } = await import("node:module")
    const _require = createRequire(import.meta.url)
    try {
      const soPath = _require.resolve("server-only")
      _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
    } catch { /* not resolvable — nothing to shim */ }
    const { NextRequest } = await import("next/server")
    const SECRET = "s3cr3t-88e-" + Math.random().toString(36).slice(2)
    const prev = process.env.CRON_SECRET
    for (const rel of ["sphere-weekly", "content-intel-rss", "pattern-scan"]) {
      let mod: { GET: (r: InstanceType<typeof NextRequest>) => Promise<Response> } | null = null
      try { mod = await import(`../app/api/cron/${rel}/route`) } catch (e) {
        check(`runtime ${rel}: route module loads in the harness`, false, String(e).slice(0, 160)); continue
      }
      delete process.env.CRON_SECRET
      const unset = await mod!.GET(new NextRequest(`https://example.test/api/cron/${rel}`))
      process.env.CRON_SECRET = SECRET
      const viaQuery = await mod!.GET(new NextRequest(`https://example.test/api/cron/${rel}?secret=${SECRET}`))
      const wrong = await mod!.GET(new NextRequest(`https://example.test/api/cron/${rel}`, { headers: { authorization: "Bearer nope" } }))
      check(`runtime ${rel}: CRON_SECRET unset → 500 (was 200 {skipped})`, unset.status === 500, `got ${unset.status}`)
      check(`runtime ${rel}: ?secret= query credential → 401 (retired)`, viaQuery.status === 401, `got ${viaQuery.status}`)
      check(`runtime ${rel}: wrong Bearer → 401`, wrong.status === 401, `got ${wrong.status}`)
      let passedGate = false
      try {
        const right = await mod!.GET(new NextRequest(`https://example.test/api/cron/${rel}`, { headers: { authorization: `Bearer ${SECRET}` } }))
        passedGate = right.status !== 401 && !(right.status === 500 && /Cron secret not configured/.test(await right.clone().text()))
      } catch { passedGate = true /* the handler ran past the gate and failed on its own, un-networked */ }
      check(`runtime ${rel}: the right Bearer gets PAST the gate`, passedGate)
    }
    if (prev === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = prev
  }

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
