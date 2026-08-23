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
 * The frozen-baseline mechanism is retired — scripts/simulator-sweep.ts runs
 * everything the curated chain does not, so there is no unwired population left
 * to ration. See the [repo] section for what replaced it.
 */
import { readFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

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
const unwiredFromChain = unwiredSimulators(pkg.scripts, reachable, (p) => existsSync(join(root, p)))
const totalTests = Object.keys(pkg.scripts).filter((k) => k.startsWith("test:")).length

// ── THE BASELINE IS RETIRED — THE SWEEP REPLACED IT ────────────────────────
// This guard used to FREEZE the unwired population (411 entries) and allow it
// only to shrink. That was the right instrument while wiring meant appending
// another `&&` to a sequential chain, which is why the population never moved.
//
// scripts/simulator-sweep.ts removed the constraint: it discovers every tsx
// simulator the curated chain does not name and runs them in PARALLEL, which
// measured cheaper than the sequential chain it supplements. So "unwired" is no
// longer a population to ration — it is zero by construction, and a frozen list
// of 411 would now report a shortfall that does not exist. A guard whose number
// is false is the same defect class this repo keeps finding, so the number is
// replaced by the invariant that actually holds.
const sweepSrc = existsSync(join(root, "scripts/simulator-sweep.ts"))
  ? readFileSync(join(root, "scripts/simulator-sweep.ts"), "utf8")
  : ""
const guardChain = pkg.scripts.guard ?? ""

console.log(`  · ${totalTests} test:* scripts · ${reachable.size} named by the chain · ${unwiredFromChain.length} reached by the sweep instead`)

// THE LABEL USED TO SAY "and is the LAST link in the guard chain" while the
// assertion beside it only tested that `test:sweep` appears ANYWHERE in the
// chain — and the sweep is not in fact last, so the check passed while a reader
// scanning the ✓ column would believe position had been verified. Nothing
// requires last position (the sweep computes `reachableFromGuard` from the whole
// chain string, not from where it sits), so the honest repair is to the CLAIM,
// not to the chain. Discovery is what actually matters, and the three checks
// below are what enforce it.
check("the sweep is wired into the guard chain, so unwired simulators still run",
  sweepSrc.length > 0 && /npm run test:sweep/.test(guardChain))
// Position is REPORTED rather than asserted: running the sweep's parallel fan-out
// after the cheap curated links would fail faster, but it is a preference nobody
// has ruled on, and a guard must not smuggle a preference in as a requirement.
{
  const links = guardChain.split("&&").map((s) => s.trim())
  const at = links.findIndex((l) => /npm run test:sweep\b/.test(l))
  console.log(`  · sweep sits at link ${at + 1} of ${links.length}${at === links.length - 1 ? " (last)" : " — not last; ordering is a preference, not an invariant"}`)
}
check("…it DISCOVERS targets from package.json rather than a hand-kept list",
  /Object\.keys\(pkg\.scripts\)/.test(sweepSrc) && /reachableFromGuard/.test(sweepSrc))
check("…it runs them through `npm run`, so per-script env survives",
  /"npm", \["run", "--silent", script\]/.test(sweepSrc))
check("…it fails CI on any failing proof", /process\.exit\(1\)/.test(sweepSrc))
check("…and it excludes the browser suites, which need a running server",
  /tsx\\s\+scripts/.test(sweepSrc))

// The one thing still worth failing on: a test:* script whose FILE is missing.
// The sweep would error on it, but naming it here says why.
const missingFile = Object.keys(pkg.scripts)
  .filter((k) => k.startsWith("test:"))
  .filter((k) => {
    const m = (pkg.scripts[k] ?? "").match(/tsx\s+(scripts\/[\w.-]+\.ts)/)
    return !!m && !existsSync(join(root, m[1]))
  })
check(`every test:* script points at a file that exists (${missingFile.length} missing)`,
  missingFile.length === 0, missingFile.slice(0, 6).join(", "))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ SIMULATOR_WIRING_FAIL — a proof is unreachable or its file is missing")
  process.exit(1)
}
console.log(" ✅ SIMULATOR_WIRING_PASS — every proof is reached, by the chain or by the sweep")
