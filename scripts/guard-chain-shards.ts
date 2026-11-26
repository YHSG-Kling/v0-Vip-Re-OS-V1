#!/usr/bin/env tsx
/**
 * scripts/guard-chain-shards.ts   (npm run guard:shard -- <first|second>)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE GUARD CHAIN RUNS IN CI AS TWO HALVES, AND TOGETHER THEY RUN EVERY STEP ONCE.
 *
 * `npm run guard` is ONE chain — `scripts.guard` in package.json, 1,028 steps joined by `&&`. It stays the one chain:
 * a developer and the integrator still run it whole before a push, and hundreds of guards read it to prove their own
 * step is a member. Nothing here copies the list.
 *
 * What changed is how CI runs it. One job ran the whole chain under a 60-minute timeout. MEASURED 2026-11-26 at
 * 224e2bfd, the same commit in two runs of the same job:
 *
 *   run 45727441327   the chain in 35.1 min, then the compliance step — green
 *   run 45727453928   CANCELLED by the timeout 58.5 min into the chain, inside its LAST step, every earlier step green
 *
 * Step by step the second runner was 1.52× slower over the same steps (53.6 against 35.2 minutes); no step hung. A
 * cancelled guards job reads as "nobody checked". The workflow's own note said what to do when a run approaches 60:
 * split the chain into two jobs rather than raise the timeout again. This file is that split.
 *
 *   first    from the type-check up to (not including) the boundary step     52% of the measured time
 *   second   from the boundary step to the end, then `guard:compliance`      48%
 *
 * The boundary is a step NAME, never a position: steps added before it land in the first half, steps added after it in
 * the second. New waves append near the end, so the second half grows first; when either half approaches its timeout,
 * add a third entry to GUARD_SHARDS (and to the workflow's matrix — test:guard-chain-shards holds the two in agreement).
 *
 * A split like this is only safe while it stays a PARTITION, and while a half does not need what the other left behind.
 * test:guard-chain-shards (in the chain) holds the first; the second was measured once, by running the second half
 * alone in a fresh clone, and is the stated blind spot of that guard.
 *
 * The runner starts each step as its own `npm run <key>` — exactly what the `&&` chain does — stops at the first step
 * that fails, and prints how long every step took, so each CI run publishes the numbers the next rebalance needs.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

export interface GuardShard {
  /** The matrix value in .github/workflows/guards.yml. */
  name: string
  /** The chain step this shard starts at; null only for the first shard, which starts at the chain's first step. */
  startsAt: string | null
}

/** THE ONE DEFINITION of how CI divides the chain. The workflow's matrix must list exactly these names. */
export const GUARD_SHARDS: readonly GuardShard[] = Object.freeze([
  { name: "first", startsAt: null },
  { name: "second", startsAt: "test:lead-magnet-creation" },
])

/**
 * PURE — the chain's steps, in order. Every step must be `npm run <key>` and the only joiner `&&`: that is what makes
 * "run the steps one at a time, stop at the first failure" the same thing as running the chain. A `;`, `||`, `|`, a
 * lone `&` or any other command is refused loudly — never skipped, never run as something else.
 */
export function chainSteps(chain: string): string[] {
  const parts = chain.split("&&").map((s) => s.trim())
  const bad = parts.filter((s) => !/^npm run [\w:.-]+$/.test(s))
  if (bad.length) throw new Error(`the guard chain has ${bad.length} part(s) that are not \`npm run <key>\`: ${bad.slice(0, 3).map((s) => JSON.stringify(s.slice(0, 80))).join(", ")}`)
  return parts.map((s) => s.slice("npm run ".length))
}

/**
 * PURE — each shard's steps. Refuses (throws) a boundary that is missing, repeated or out of order, and a shard list
 * that does not start at the first step: a boundary that silently matched nothing would leave one job running the
 * whole chain and the other running none of it, and both would be green.
 */
export function shardPlan(steps: readonly string[], shards: readonly GuardShard[] = GUARD_SHARDS): Array<{ name: string; steps: string[] }> {
  if (!shards.length || shards[0].startsAt !== null) throw new Error("the first shard must start at the chain's first step (startsAt: null)")
  if (new Set(shards.map((s) => s.name)).size !== shards.length) throw new Error("shard names repeat")
  const starts = shards.map((s, i) => {
    if (i === 0) return 0
    if (s.startsAt === null) throw new Error(`shard '${s.name}' has no boundary step`)
    const at = steps.indexOf(s.startsAt)
    if (at < 0) throw new Error(`shard '${s.name}' starts at '${s.startsAt}', which is not a step of the guard chain`)
    if (steps.lastIndexOf(s.startsAt) !== at) throw new Error(`shard '${s.name}' starts at '${s.startsAt}', which the guard chain runs more than once`)
    return at
  })
  for (let i = 1; i < starts.length; i++) if (starts[i] <= starts[i - 1]) throw new Error(`shard '${shards[i].name}' does not start after shard '${shards[i - 1].name}' (an empty or out-of-order shard)`)
  return shards.map((s, i) => ({ name: s.name, steps: steps.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : steps.length) }))
}

function runShard(name: string): number {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { scripts?: Record<string, string> }
  const all = chainSteps(pkg.scripts?.guard ?? "")
  const plan = shardPlan(all)
  const shard = plan.find((p) => p.name === name)
  if (!shard) {
    console.error(`guard:shard — unknown shard '${name}'. Known: ${plan.map((p) => `${p.name} (${p.steps.length} steps)`).join(", ")}`)
    return 2
  }
  console.log(`[guard:shard ${name}] ${shard.steps.length} of the chain's ${all.length} steps: ${shard.steps[0]} … ${shard.steps[shard.steps.length - 1]}`)
  const began = Date.now()
  const took: Array<[string, number]> = []
  const report = (code: number, failedStep?: string): number => {
    const slowest = [...took].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, ms]) => `${k} ${(ms / 1000).toFixed(0)}s`).join(" · ")
    console.log(`\n[guard:shard ${name}] ${took.length} of ${shard.steps.length} steps ran in ${((Date.now() - began) / 60000).toFixed(1)} min. Slowest: ${slowest}`)
    console.log(`GUARD_SHARD_EXIT=${code} shard=${name}${failedStep ? ` failed_step=${failedStep}` : ""}`)
    return code
  }
  for (const key of shard.steps) {
    const t0 = Date.now()
    const r = spawnSync("npm", ["run", key], { stdio: "inherit", shell: process.platform === "win32" })
    took.push([key, Date.now() - t0])
    // A step killed by a signal has no status: that is a failure, never a pass.
    const code = r.error ? 1 : r.status ?? 1
    if (r.error) console.error(`guard:shard — could not start \`npm run ${key}\`: ${r.error.message}`)
    if (code !== 0) return report(code, key)
  }
  return report(0)
}

if (/guard-chain-shards\.ts$/.test(process.argv[1] ?? "")) {
  const [mode, name] = process.argv.slice(2)
  if (mode !== "run" || !name) {
    console.error("usage: npm run guard:shard -- <shard>   (tsx scripts/guard-chain-shards.ts run <shard>)")
    process.exit(2)
  }
  process.exit(runShard(name))
}
