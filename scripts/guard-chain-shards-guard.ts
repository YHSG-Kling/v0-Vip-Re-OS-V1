#!/usr/bin/env tsx
/**
 * scripts/guard-chain-shards-guard.ts   (npm run test:guard-chain-shards)
 * ─────────────────────────────────────────────────────────────────────────────
 * CI RUNS THE GUARD CHAIN AS TWO HALVES — THIS HOLDS THEM TO BEING THE WHOLE CHAIN, ONCE.
 *
 * The split is defined in scripts/guard-chain-shards.ts (read its header for the measurement that forced it). It is
 * only safe while four things stay true, and each is derived here from package.json, that module and the workflow
 * file — nothing is retyped:
 *
 *   1. GRAMMAR    every part of `scripts.guard` is `npm run <key>` and the only joiner is `&&`. That is what makes
 *                 "run the steps one at a time and stop at the first failure" the same thing as running the chain.
 *   2. PARTITION  the halves, laid end to end, ARE the chain: every step in exactly one half, in the chain's order.
 *   3. WORKFLOW   the matrix in .github/workflows/guards.yml lists exactly the halves the module defines, each runs
 *                 through the one runner, the compliance guards run once (after the last half), and nothing in that
 *                 workflow still runs the whole chain in one job.
 *   4. VERDICT    the job named `egress-guards` is green only when every half succeeded. Its own shell script is
 *                 executed here with each result GitHub can hand it: only `success` exits 0.
 *
 * The runner is also DRIVEN: a throwaway package with a four-step chain is run through the real CLI, half by half,
 * and with a failing step.
 *
 * BLIND SPOTS, stated:
 *  · This cannot prove from text that a step in the second half needs nothing a step in the first half left on disk.
 *    That was MEASURED instead (2026-11-26): the second half was run alone in a fresh depth-1 clone that had never run
 *    the first, and exited 0. A step that starts depending on an earlier one will show as a red second half in CI.
 *  · Balance is by measured TIME, which no file records. Step counts are printed below; the durations are printed by
 *    every CI run (`[guard:shard <name>] … steps ran in … min`). The boundary is a step name, so steps appended at
 *    the end grow the second half.
 *  · .github/workflows/e2e.yml (nightly, on main) still runs `npm run guard` whole in one job. It is not divided here.
 */
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { GUARD_SHARDS, chainSteps, shardPlan, type GuardShard } from "./guard-chain-shards"

const ROOT = process.cwd()
let passed = 0
let failed = 0
const check = (label: string, ok: boolean, detail?: unknown): void => {
  if (ok) { passed++; console.log(`  ✓ ${label}`) } else { failed++; console.log(`  ✗ ${label}${detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`) }
}
const throws = (fn: () => unknown): string | null => { try { fn(); return null } catch (e) { return e instanceof Error ? e.message : String(e) } }
const same = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every((x, i) => x === b[i])

const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }
const chain = pkg.scripts.guard ?? ""

console.log("\n[1 · the chain's grammar: every part is `npm run <key>`, joined only by &&]")
const grammarError = throws(() => chainSteps(chain))
const steps = grammarError ? [] : chainSteps(chain)
check(`the chain parses: ${steps.length} steps, each \`npm run <key>\``, grammarError === null && steps.length > 500, grammarError ?? steps.length)
check("no step is in the chain twice (a repeated step would make 'exactly once' unprovable)", new Set(steps).size === steps.length, steps.filter((s, i) => steps.indexOf(s) !== i).slice(0, 5))
check("every step is a script package.json defines", steps.every((s) => typeof pkg.scripts[s] === "string"), steps.filter((s) => typeof pkg.scripts[s] !== "string").slice(0, 5))
check("the chain still starts with the type-check", steps[0] === "type-check", steps[0])
check("POSITIVE CONTROL: `&&` written without spaces is still one joiner (the real chain has such joins)", same(chainSteps("npm run a &&npm run b&& npm run c"), ["a", "b", "c"]))
for (const [what, bad] of [
  ["a `;` (runs the next step even when one failed)", "npm run a; npm run b"],
  ["a `||`", "npm run a || npm run b"],
  ["a lone `&` (runs steps side by side)", "npm run a & npm run b"],
  ["a pipe", "npm run a | npm run b"],
  ["a command that is not `npm run <key>`", "npm run a && tsc --noEmit && npm run b"],
  ["an environment prefix", "npm run a && FOO=1 npm run b"],
  ["an empty part", "npm run a && && npm run b"],
] as const) check(`NEGATIVE CONTROL: a chain with ${what} is refused, not run as something else`, throws(() => chainSteps(bad)) !== null)

console.log("\n[2 · the halves are a partition of the chain]")
const planError = throws(() => shardPlan(steps))
const plan = planError ? [] : shardPlan(steps)
check(`the plan resolves: ${plan.map((p) => `${p.name} ${p.steps.length} steps`).join(" + ")} = ${steps.length}`, planError === null && plan.length === GUARD_SHARDS.length, planError ?? plan.length)
check("laid end to end, the halves ARE the chain (every step in exactly one half, in the chain's order)", same(plan.flatMap((p) => p.steps), steps))
check("no half is empty", plan.length > 0 && plan.every((p) => p.steps.length > 0))
check("the first half starts at the type-check, and every later half at the step its definition names",
  plan.length > 0 && plan.every((p, i) => p.steps[0] === (i === 0 ? steps[0] : GUARD_SHARDS[i].startsAt)), plan.map((p) => p.steps[0]))
check("there are at least two halves (one shard is the single job this split replaced)", GUARD_SHARDS.length >= 2)
{
  const lost = plan.map((p, i) => (i === plan.length - 1 ? p.steps.slice(0, -1) : p.steps)).flat()
  const twice = [...plan.flatMap((p) => p.steps), steps[steps.length - 1]]
  check("NEGATIVE CONTROL: a plan that loses one step, or runs one twice, is not the chain", plan.length > 0 && !same(lost, steps) && !same(twice, steps))
  const mid = steps[Math.floor(steps.length / 3)]
  const three: GuardShard[] = [{ name: "a", startsAt: null }, { name: "b", startsAt: mid }, { name: "c", startsAt: GUARD_SHARDS[GUARD_SHARDS.length - 1].startsAt }]
  const threeOk = throws(() => shardPlan(steps, three)) === null && same(shardPlan(steps, three).flatMap((p) => p.steps), steps)
  check("POSITIVE CONTROL: a third shard — the next lever when a half grows — still partitions the chain", steps.length > 0 && threeOk)
  check("NEGATIVE CONTROL: a boundary that is not a step of the chain is refused (never 'one job runs everything, the other nothing')",
    throws(() => shardPlan(steps, [{ name: "a", startsAt: null }, { name: "b", startsAt: "test:no-such-step" }])) !== null)
  check("NEGATIVE CONTROL: a boundary the chain runs twice is refused", throws(() => shardPlan(["x", "y", "x"], [{ name: "a", startsAt: null }, { name: "b", startsAt: "x" }])) !== null)
  check("NEGATIVE CONTROL: boundaries out of chain order (an empty or overlapping half) are refused",
    throws(() => shardPlan(["x", "y", "z"], [{ name: "a", startsAt: null }, { name: "b", startsAt: "z" }, { name: "c", startsAt: "y" }])) !== null
    && throws(() => shardPlan(["x", "y", "z"], [{ name: "a", startsAt: null }, { name: "b", startsAt: "x" }])) !== null)
  check("NEGATIVE CONTROL: a first half that does not start at the chain's first step is refused", throws(() => shardPlan(["x", "y"], [{ name: "a", startsAt: "y" }])) !== null)
  check("NEGATIVE CONTROL: two halves with one name are refused", throws(() => shardPlan(["x", "y"], [{ name: "a", startsAt: null }, { name: "a", startsAt: "y" }])) !== null)
}

console.log("\n[3 · package.json: the one runner, and this proof is in the chain it proves]")
check("`guard:shard` is the one runner (tsx scripts/guard-chain-shards.ts run)", pkg.scripts["guard:shard"] === "tsx scripts/guard-chain-shards.ts run", pkg.scripts["guard:shard"])
check("`test:guard-chain-shards` runs this file and is a member of the chain (membership, never a position)",
  pkg.scripts["test:guard-chain-shards"] === "tsx scripts/guard-chain-shards-guard.ts" && steps.includes("test:guard-chain-shards"))
check("`guard` is still ONE chain in package.json (no second list of steps: no other script is a copy of a half)",
  Object.entries(pkg.scripts).filter(([k, v]) => k !== "guard" && (v.match(/npm run test:/g) ?? []).length > 100).length === 0,
  Object.entries(pkg.scripts).filter(([k, v]) => k !== "guard" && (v.match(/npm run test:/g) ?? []).length > 100).map(([k]) => k))

console.log("\n[4 · the workflow runs exactly these halves]")
interface Step { name?: string; run?: string; if?: string; uses?: string }
interface Job { needs?: string[] | string; if?: string; name?: string; "timeout-minutes"?: number; strategy?: { "fail-fast"?: boolean; matrix?: { shard?: string[] } }; steps?: Step[] }
const WORKFLOW = ".github/workflows/guards.yml"
const workflowText = existsSync(join(ROOT, WORKFLOW)) ? readFileSync(join(ROOT, WORKFLOW), "utf8") : ""
// The YAML parser reads the file: comments (which quote the old single-job command in prose) are not steps.
const jobs = ((workflowText ? parseYaml(workflowText) : {}) as { jobs?: Record<string, Job> }).jobs ?? {}
const names = GUARD_SHARDS.map((s) => s.name)
const lastName = names[names.length - 1]
const RUN_HALF = "npm run guard:shard -- ${{ matrix.shard }}"
const runsOf = (j: Job | undefined): Step[] => (j?.steps ?? []).filter((s) => typeof s.run === "string")
const halfJobs = Object.entries(jobs).filter(([, j]) => runsOf(j).some((s) => (s.run ?? "").trim() === RUN_HALF))
const half = halfJobs[0]?.[1]
const halfJobId = halfJobs[0]?.[0] ?? ""
const matrixMatches = (j: Job | undefined): boolean => same(j?.strategy?.matrix?.shard ?? [], names)
check("exactly one job runs the halves through the one runner", halfJobs.length === 1, halfJobs.map(([k]) => k))
check(`its matrix lists exactly the halves the module defines, in order (${names.join(", ")})`, matrixMatches(half), half?.strategy?.matrix?.shard)
check("one half failing does not cancel the other (fail-fast: false) — the verdict reads both", half?.strategy?.["fail-fast"] === false)
check("a half's timeout is a number and was not raised past 60 (the lever is another shard, never a longer timeout)", typeof half?.["timeout-minutes"] === "number" && (half?.["timeout-minutes"] ?? 999) <= 60, half?.["timeout-minutes"])
const allRuns = Object.values(jobs).flatMap((j) => runsOf(j))
check("no job in this workflow still runs the whole chain in one step", !allRuns.some((s) => /^\s*npm run guard\s*$/m.test(s.run ?? "")), allRuns.filter((s) => /^\s*npm run guard\s*$/m.test(s.run ?? "")).map((s) => s.name))
const compliance = allRuns.filter((s) => /\bnpm run guard:compliance\b/.test(s.run ?? ""))
check(`the compliance guards run exactly once, after the LAST half ('${lastName}')`,
  compliance.length === 1 && runsOf(half).includes(compliance[0]) && (compliance[0].if ?? "").replace(/\s+/g, "") === `\${{matrix.shard=='${lastName}'}}`
  && runsOf(half).findIndex((s) => s === compliance[0]) > runsOf(half).findIndex((s) => (s.run ?? "").trim() === RUN_HALF), compliance.map((s) => s.if))
check("NEGATIVE CONTROL: a matrix that drops a half, adds one the module does not define, or reorders them is seen",
  !matrixMatches({ strategy: { matrix: { shard: names.slice(0, -1) } } }) && !matrixMatches({ strategy: { matrix: { shard: [...names, "third"] } } }) && !matrixMatches({ strategy: { matrix: { shard: [...names].reverse() } } }) && matrixMatches({ strategy: { matrix: { shard: [...names] } } }))

console.log("\n[5 · the verdict fails closed — its own script, executed]")
const needsOf = (j: Job | undefined): string[] => (Array.isArray(j?.needs) ? j.needs : j?.needs ? [j.needs] : [])
const verdictEntry = Object.entries(jobs).find(([k]) => k === "egress-guards")
const verdict = verdictEntry?.[1]
const verdictScript = runsOf(verdict)[0]?.run ?? ""
const RESULT_EXPR = `\${{ needs.${halfJobId}.result }}`
check("the job named `egress-guards` (the name the single job had) waits for every half", !!verdict && halfJobId !== "" && needsOf(verdict).includes(halfJobId), needsOf(verdict))
check("it runs even when a half failed or was cancelled (if: always()) — otherwise GitHub would SKIP it, and a skipped check is not a red one", /\balways\(\)/.test(verdict?.if ?? ""), verdict?.if)
check("it is not itself the job that runs the halves, and it has a timeout", verdictEntry?.[0] !== halfJobId && typeof verdict?.["timeout-minutes"] === "number")
check("its script reads the halves' combined result", verdictScript.includes(RESULT_EXPR), verdictScript.slice(0, 120))
/** Run a verdict script the way the runner would, with GitHub's expression already substituted. */
const verdictExit = (script: string, result: string): number | null => spawnSync("bash", ["-e", "-c", script.split(RESULT_EXPR).join(result)], { encoding: "utf8" }).status
const outcomes = ["success", "failure", "cancelled", "skipped", ""] as const
const exits = Object.fromEntries(outcomes.map((r) => [r || "(empty)", verdictScript ? verdictExit(verdictScript, r) : null]))
check("EXECUTED: the script exits 0 for `success` and non-zero for failure, cancelled, skipped and an empty result",
  exits.success === 0 && outcomes.filter((r) => r !== "success").every((r) => typeof exits[r || "(empty)"] === "number" && exits[r || "(empty)"] !== 0), exits)
check("NEGATIVE CONTROL: a verdict that always exits 0, and one that treats `cancelled` as fine, are both seen by the same execution",
  verdictExit(`HALF="${RESULT_EXPR}"\necho "$HALF"\nexit 0`, "cancelled") === 0
  && verdictExit(`HALF="${RESULT_EXPR}"\nif [ "$HALF" = "failure" ]; then exit 1; fi\nexit 0`, "cancelled") === 0
  && verdictExit(`HALF="${RESULT_EXPR}"\nif [ "$HALF" = "success" ]; then exit 0; fi\nexit 1`, "cancelled") === 1)

console.log("\n[6 · the runner, driven: a throwaway four-step chain through the real CLI]")
{
  const boundary = GUARD_SHARDS[1]?.startsAt ?? ""
  const dir = mkdtempSync(join(tmpdir(), "guard-chain-shards-"))
  const mark = (k: string, code = 0) => `node -e "require('fs').appendFileSync('ran.log','${k}\\n');process.exit(${code})"`
  const writePkg = (codes: Record<string, number>) => writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "guard-chain-shards-fixture", version: "0.0.0", private: true,
    scripts: { guard: `npm run type-check && npm run test:a &&npm run ${boundary} && npm run test:b`, "type-check": mark("type-check", codes["type-check"] ?? 0), "test:a": mark("test:a", codes["test:a"] ?? 0), [boundary]: mark(boundary, codes[boundary] ?? 0), "test:b": mark("test:b", codes["test:b"] ?? 0) },
  }))
  const ran = (): string[] => (existsSync(join(dir, "ran.log")) ? readFileSync(join(dir, "ran.log"), "utf8").split("\n").filter(Boolean) : [])
  const drive = (shard: string) => { rmSync(join(dir, "ran.log"), { force: true }); const r = spawnSync(join(ROOT, "node_modules/.bin/tsx"), [join(ROOT, "scripts/guard-chain-shards.ts"), "run", shard], { cwd: dir, encoding: "utf8" }); return { status: r.status, out: `${r.stdout}${r.stderr}`, ran: ran() } }
  try {
    writePkg({})
    const first = drive(names[0]), second = drive(names[1])
    check("the first half runs its steps and ONLY its steps, in order, and exits 0", first.status === 0 && same(first.ran, ["type-check", "test:a"]) && /^GUARD_SHARD_EXIT=0 shard=first$/m.test(first.out), { status: first.status, ran: first.ran, tail: first.out.slice(-160) })
    check("the second half starts at the boundary step, runs to the end, and exits 0", second.status === 0 && same(second.ran, [boundary, "test:b"]) && /^GUARD_SHARD_EXIT=0 shard=second$/m.test(second.out), { status: second.status, ran: second.ran })
    check("together the two runs ran every step of the chain exactly once", same([...first.ran, ...second.ran], chainSteps(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts.guard)))
    check("each run prints how long its steps took (the numbers the next rebalance needs)", /steps ran in [\d.]+ min\. Slowest: /.test(first.out) && /steps ran in [\d.]+ min\. Slowest: /.test(second.out))
    writePkg({ "test:a": 3 })
    const red = drive(names[0])
    check("a failing step stops the half there with the step's own exit code — the next step does not run, and the last line names the step", red.status === 3 && same(red.ran, ["type-check", "test:a"]) && /^GUARD_SHARD_EXIT=3 shard=first failed_step=test:a$/m.test(red.out), { status: red.status, ran: red.ran })
    writePkg({ [boundary]: 1 })
    const red2 = drive(names[1])
    check("…and the same in the second half (its first step failing runs nothing after it)", red2.status === 1 && same(red2.ran, [boundary]), { status: red2.status, ran: red2.ran })
    writePkg({})
    const unknown = drive("third")
    check("an unknown half is refused with exit 2 and runs nothing (a typo in the matrix is a red job, not an empty green one)", unknown.status === 2 && unknown.ran.length === 0, { status: unknown.status, ran: unknown.ran })
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", version: "0.0.0", scripts: { guard: `npm run type-check; npm run ${boundary}`, "type-check": mark("type-check"), [boundary]: mark(boundary) } }))
    const badGrammar = drive(names[0])
    check("a chain the grammar refuses runs nothing and exits non-zero", badGrammar.status !== 0 && badGrammar.ran.length === 0, { status: badGrammar.status, ran: badGrammar.ran })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`\n  halves today: ${plan.map((p) => `${p.name} = ${p.steps.length} steps (${p.steps[0]} … ${p.steps[p.steps.length - 1]})`).join(" · ")}`)
console.log("  not checked here (blind spots): that the second half needs nothing the first left on disk (measured once, in a fresh clone); the time balance (printed by every CI run); the nightly e2e workflow, which still runs the chain whole.")
console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log("❌ GUARD_CHAIN_SHARDS_FAIL"); process.exit(1) }
console.log("✅ GUARD_CHAIN_SHARDS_PASS — the halves CI runs are the whole guard chain, each step once, and the verdict is green only when every half succeeded")
