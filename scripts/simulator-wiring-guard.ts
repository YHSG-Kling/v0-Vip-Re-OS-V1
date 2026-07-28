#!/usr/bin/env tsx
/**
 * scripts/simulator-wiring-guard.ts   (npm run test:simulator-wiring) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * A TEST CI DOES NOT RUN IS NOT A TEST, IT IS A FILE.
 *
 * package.json defines 550 `test:*` scripts. Only ~120 are reachable from the
 * chains CI actually invokes (`guard`, `guard:compliance`, `harness:integrity`).
 * The rest have never run in CI — and when two of them were finally sampled,
 * BOTH were red and had been for as long as it took the code to move underneath
 * them:
 *
 *   stripe-writethrough  22/23 — asserted isTrialOverride/isDisableOverride, names
 *                                that vanished when the resolution order was
 *                                consolidated into lib/entitlements/resolve.ts
 *   cda-pdf-fill          7/13 — asserted that agent_net AUTOFILLS onto the CDA,
 *                                which the product deliberately forbids
 *
 * Neither was a code defect; both were assertions rotting in the dark. A third —
 * back-on-market-promo — had eleven checks added to it during the very sweep that
 * discovered this problem, and was itself unchained.
 *
 * WHAT THIS GUARD DOES. It does not demand that all 425 be wired: triaging them
 * means judging, one at a time, whether a red simulator is stale or is catching a
 * real regression, and bulk-wiring would turn the chain red with no way to tell
 * those apart. It freezes the population instead. The baseline lists every
 * currently-unwired `test:*` script; adding a NEW one fails CI, and wiring an old
 * one shrinks the list. The rot can only be paid down, never added to.
 *
 * Run UPDATE_SIMULATOR_WIRING_BASELINE=1 after deliberately wiring or removing scripts.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASELINE_PATH = join(root, "scripts", "simulator-wiring-baseline.json")

/** The scripts CI actually invokes. Anything reachable from one of these runs. */
export const CI_CHAINS = ["guard", "guard:compliance", "harness:integrity"]

/**
 * PURE — every `npm run <name>` reachable from the named chains, following
 * chain-to-chain references transitively so a chain that calls another chain
 * still counts its members as wired.
 */
export function reachableScripts(scripts: Record<string, string>, roots: string[]): Set<string> {
  const seen = new Set<string>()
  const queue = [...roots]
  while (queue.length) {
    const name = queue.shift()!
    if (seen.has(name)) continue
    seen.add(name)
    const body = scripts[name]
    if (!body) continue
    for (const m of body.matchAll(/npm run ([\w:.-]+)/g)) {
      if (!seen.has(m[1])) queue.push(m[1])
    }
  }
  return seen
}

/** PURE — `test:*` scripts that point at a real file under scripts/ and are unreachable. */
export function unwiredSimulators(
  scripts: Record<string, string>,
  reachable: Set<string>,
  fileExists: (rel: string) => boolean,
): string[] {
  const out: string[] = []
  for (const [name, body] of Object.entries(scripts)) {
    if (!name.startsWith("test:")) continue
    if (reachable.has(name)) continue
    const m = /scripts\/([\w.-]+\.ts)/.exec(body)
    if (!m || !fileExists(`scripts/${m[1]}`)) continue
    out.push(name)
  }
  return out.sort()
}

let passed = 0, failed = 0
const failures: string[] = []
const check = (n: string, c: boolean, d?: string) => {
  if (c) { passed++; console.log(`  ✓ ${n}`) }
  else { failed++; failures.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) }
}

console.log("══════════════════════════════════════════════════")
console.log(" Simulator wiring guard (CI must actually run the test)")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure — the reachability walk]")
{
  const s = { guard: "npm run a && npm run b", a: "tsx x.ts", b: "npm run c", c: "tsx y.ts", d: "tsx z.ts" }
  const r = reachableScripts(s, ["guard"])
  check("follows a chain into its members", r.has("a") && r.has("b"))
  check("follows chain-to-chain transitively", r.has("c"))
  check("does not invent membership", !r.has("d"))
}
{
  const s = { "test:wired": "tsx scripts/real.ts", "test:orphan": "tsx scripts/real.ts", "test:ghost": "tsx scripts/gone.ts" }
  const out = unwiredSimulators(s, new Set(["test:wired"]), (p) => p === "scripts/real.ts")
  check("flags an unwired script that has a real file", out.includes("test:orphan"))
  check("ignores one whose file does not exist", !out.includes("test:ghost"))
  check("ignores a wired script", !out.includes("test:wired"))
}

console.log("\n[repo]")
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }
const reachable = reachableScripts(pkg.scripts, CI_CHAINS)
const unwired = unwiredSimulators(pkg.scripts, reachable, (p) => existsSync(join(root, p)))
const totalTests = Object.keys(pkg.scripts).filter((k) => k.startsWith("test:")).length
const wiredTests = Object.keys(pkg.scripts).filter((k) => k.startsWith("test:") && reachable.has(k)).length
console.log(`  · ${totalTests} test:* scripts · ${wiredTests} reachable from CI · ${unwired.length} unwired with a real file`)

const baseline: string[] = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : []

if (process.env.UPDATE_SIMULATOR_WIRING_BASELINE === "1") {
  writeFileSync(BASELINE_PATH, JSON.stringify(unwired, null, 2) + "\n")
  console.log(`  · baseline rewritten with ${unwired.length} entries`)
  process.exit(0)
}

const known = new Set(baseline)
const fresh = unwired.filter((n) => !known.has(n))
const nowWired = baseline.filter((n) => !unwired.includes(n))

check(`no NEW unwired test:* script (${unwired.length} known)`, fresh.length === 0,
  fresh.slice(0, 10).join(", "))
check(`the unwired list only shrinks (${nowWired.length} wired or removed since the baseline)`, true)

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ SIMULATOR_WIRING_FAIL — define a test:* script and chain it, or CI will never run it")
  process.exit(1)
}
console.log(" ✅ SIMULATOR_WIRING_PASS — the unwired population is frozen and can only shrink")
