#!/usr/bin/env tsx
/**
 * scripts/simulator-sweep.ts   (npm run test:sweep)
 * ─────────────────────────────────────────────────────────────────────────────
 * RUN EVERY PROOF THE CURATED CHAIN DOES NOT.
 *
 * `npm run guard` is a hand-ordered chain of ~157 simulators. The other ~411
 * existed, passed, and RAN NOWHERE. A proof nobody runs is not a proof — it is a
 * claim about the system that no one is checking, and this repo has now been
 * bitten by that twice in one session:
 *
 *   · lead-deconflict-simulator asserted leadLogChannel("phone") === "phone",
 *     pinning the exact bug the de-confliction fix removed. Wired, it would have
 *     BLOCKED the fix and defended a cap that could not count.
 *   · deleting app/signup/signup-form.tsx during the funnel merge broke three
 *     unwired simulators (disposition-route, platform-gaps,
 *     territory-marketplace). CI stayed green because none of them run.
 *
 * The reason they were never wired is wall-clock: appending 411 more `&&` links
 * to a sequential chain would have added ~5 minutes. But the chain is slow
 * BECAUSE it is sequential, not because the work is large — measured on this
 * repo, the curated 157 take ~130s in series while all 411 finish in ~110s at
 * concurrency 8. Running more proofs, in parallel, costs less than running fewer
 * in series.
 *
 * So this sweeps everything the chain does not already reach. Each script runs
 * through `npm run` rather than a bare `tsx` call, so per-script environment
 * survives (test:voice-buyer-search needs --conditions=react-server for the
 * `server-only` import barrier — invoking tsx directly would fail it).
 *
 * Scripts that skip a live layer for missing SUPABASE creds still PASS here;
 * they say so in their own output. This sweep asserts the source layer holds,
 * which is what CI can honestly check without production credentials.
 */
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { cpus } from "node:os"

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }

/** Every test:* script the guard chain already runs (transitively). */
function reachableFromGuard(): Set<string> {
  const seen = new Set<string>()
  const walk = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    for (const m of (pkg.scripts[name] ?? "").matchAll(/npm run ([a-zA-Z0-9:_-]+)/g)) walk(m[1])
  }
  walk("guard")
  return seen
}

const wired = reachableFromGuard()

/**
 * Only SIMULATOR proofs — a `tsx scripts/*.ts` command. This deliberately
 * excludes the Playwright suites (test:e2e, test:e2e:ui): they drive a real
 * browser against a running dev server, and test:e2e:ui is interactive by
 * design and never terminates headless. They are a different kind of check with
 * a different prerequisite, and sweeping them here would fail CI for a missing
 * server rather than a broken proof.
 */
const targets = Object.keys(pkg.scripts)
  .filter((s) =>
    s.startsWith("test:") &&
    !wired.has(s) &&
    s !== "test:sweep" &&
    /tsx\s+scripts\/[\w.-]+\.ts/.test(pkg.scripts[s] ?? ""))
  .sort()

const CONCURRENCY = Math.max(2, Math.min(8, cpus().length - 2))
const TIMEOUT_MS = 120_000

interface Outcome { script: string; ok: boolean; detail: string }
const results: Outcome[] = []
let cursor = 0

function runOne(script: string): Promise<Outcome> {
  return new Promise((resolve) => {
    execFile(
      "npm", ["run", "--silent", script],
      { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, env: process.env },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ""}${stderr ?? ""}`
        if (!err) return resolve({ script, ok: true, detail: "" })
        if ((err as { killed?: boolean }).killed) {
          return resolve({ script, ok: false, detail: `TIMEOUT after ${TIMEOUT_MS / 1000}s` })
        }
        // Prefer the script's own failure lines; fall back to its tail.
        const named = [...out.matchAll(/^\s+- (.+)$/gm)].map((m) => m[1]).slice(0, 3)
        const tail = out.split("\n").filter(Boolean).slice(-3).join(" | ")
        resolve({ script, ok: false, detail: named.length ? named.join(" | ") : tail.slice(0, 300) })
      },
    )
  })
}

async function worker(): Promise<void> {
  while (cursor < targets.length) {
    const script = targets[cursor++]
    const r = await runOne(script)
    results.push(r)
    if (!r.ok) console.log(`  ✗ ${r.script} — ${r.detail}`)
    if (results.length % 50 === 0) console.log(`  … ${results.length}/${targets.length}`)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Simulator sweep — every proof the curated chain does not run")
  console.log("══════════════════════════════════════════════════")
  console.log(`  · ${targets.length} scripts · concurrency ${CONCURRENCY}`)

  const started = Date.now()
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  const seconds = Math.round((Date.now() - started) / 1000)

  const failed = results.filter((r) => !r.ok)
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${results.length - failed.length} passed, ${failed.length} failed (${seconds}s)`)
  if (failed.length) {
    console.log(" FAILURES:")
    for (const f of failed) console.log(`   - ${f.script}: ${f.detail}`)
    console.log(" ❌ SIMULATOR_SWEEP_FAIL")
    process.exit(1)
  }
  console.log(" ✅ SIMULATOR_SWEEP_PASS — no proof in this repo goes unrun")
}

void main()
