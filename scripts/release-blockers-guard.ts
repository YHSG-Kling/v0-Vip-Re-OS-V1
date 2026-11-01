#!/usr/bin/env tsx
/**
 * scripts/release-blockers-guard.ts   (npm run test:release-blockers)   — wave 148, lane 148A
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RELEASE PATH, read from the repository and the pinned toolchain — never from a claim. Five layers:
 *
 *   A  THE BUILD GATE (.github/workflows/build.yml + .github/actions/next-build-phases). The owner's 2026-10-03 "Both"
 *      ruling (repo variables BUILD_RUNNER / BUILD_HEAP_MB) is honoured END TO END: the full single pass runs only on the
 *      configured runner and its compile heap reaches the build worker; a preflight refuses the heap that aborted three
 *      times (14336). LEVER (d) — the two-half compile matrix — is implemented as a CI-only gate: its flag is VERIFIED
 *      against the installed, lockfile-pinned next (the CLI option and the resolver module), the halves PARTITION every
 *      app/ page and route as next's OWN resolver (dist/lib/resolve-build-paths.js) sees them, compile and generate get
 *      the SAME globs, and each half's entries / first-party modules / bytes are measured with the ONE walker
 *      (scripts/app-import-graph.ts). The verdict job is fail-closed: its own shell is EXECUTED for every result pair.
 *   B  O1 — the storage.objects policies (m855 §F, m875 §G) stay RELEASE-BLOCKING while either file lacks the applied
 *      stamp (the ONE classifier, scripts/migration-status.ts claimOf), and OWNER-SQL carries the post-application
 *      verification the owner runs (§F/§G "Verify afterwards" + the §J close-out, in order, with expected values).
 *   C  O2 — the four unlinked portal seed accounts: OWNER-SQL §I carries the inventory (ids, tenant, pairing) and a
 *      SCOPED, GUARDED, REVERSIBLE remediation (link, or archive) with NO deletion; blocking until the status line is
 *      RESOLVED with a date and the zero census (the same rule scripts/production-readiness-guard.ts O2 reads).
 *   D  CONFIGURATION BY VARIABLE NAME ONLY (never a value): the public origin (NEXT_PUBLIC_APP_URL → VERCEL_URL through
 *      lib/platform/site-url.ts), Vercel Workflow execution (withWorkflow + the "use workflow" files + the VERCEL presence
 *      gate with the cron net), the cron door (vercel.json → /api/cron/dispatch, CRON_SECRET read), and every contracted
 *      webhook door's secret names (lib/providers/webhook-contract.ts WEBHOOK_CONTRACT) — each name must be one the
 *      runtime actually reads.
 *   E  THE DEPLOYMENT BUILD: vercel.json's single pass runs below the CI compile cap the bracket recorded aborting, so a
 *      Vercel deployment is an OWNER item (build machine + heap) regardless of the CI gate. Printed, never hidden.
 *
 * Every absence/refusal assertion carries a POSITIVE CONTROL (CLAUDE.md §2). Source scans read STRIPPED source.
 * BLIND SPOTS (published): the CI result of the matrix itself is GitHub's, not this repo's (the first run is the heap
 * measurement); the walker counts first-party modules only (a lower bound, not webpack's count); live database state
 * (storage verdict, seed census) is read by the owner's SQL, this guard reads the stamps and status lines that record it;
 * presence of a variable in the Vercel project is not readable here (names only — ACTIVATION-CHECKLIST §1).
 *
 * Run: npx tsx scripts/release-blockers-guard.ts
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import { join, dirname } from "node:path"
import { spawnSync } from "node:child_process"
import { parse as parseYaml } from "yaml"
import { stripComments } from "./strip-comments"
import { stripSqlComments } from "./strip-sql-comments"
import { claimOf } from "./migration-status"
import { walkTs } from "./runtime-roots"
import { makeWalker } from "./app-import-graph"
import { WEBHOOK_CONTRACT } from "../lib/providers/webhook-contract"

const ROOT = process.cwd()
const read = (p: string) => readFileSync(join(ROOT, p), "utf8")
const has = (p: string) => existsSync(join(ROOT, p))
let pass = 0, fail = 0
const fails: string[] = []
function check(name: string, ok: boolean, detail = "") {
  if (ok) { pass++; console.log(`  ✓ ${name}`) }
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
interface Obligation { id: string; what: string; open: boolean; where: string; kind: "owner-sql" | "owner-config" | "owner-decision" }
const obligations: Obligation[] = []

// ═════════════════════════════════════════════════════════════════════════════
// A · THE BUILD GATE
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[A · the build gate — the runner variables end to end, and lever (d) against the pinned next]")
const req = createRequire(join(ROOT, "package.json"))
const pkgJson = JSON.parse(read("package.json")) as { dependencies?: Record<string, string> }
const lock = JSON.parse(read("package-lock.json")) as { packages?: Record<string, { version?: string }> }
const lockedNext = lock.packages?.["node_modules/next"]?.version ?? null
const installedNext = (req("next/package.json") as { version: string }).version
check(`A1 next is pinned and installed at ONE version (package.json ${pkgJson.dependencies?.next}, lockfile ${lockedNext}, installed ${installedNext})`,
  !!lockedNext && lockedNext === installedNext && /^\^?16\./.test(pkgJson.dependencies?.next ?? ""))
const cliText = readFileSync(join(dirname(req.resolve("next/package.json")), "dist/bin/next"), "utf8")
check("A2 the installed next CLI registers `--debug-build-paths <patterns>` and `--experimental-build-mode` with compile + generate",
  /\.option\('--debug-build-paths <patterns>'/.test(cliText) && /--experimental-build-mode \[mode\][\s\S]{0,200}'compile'[\s\S]{0,60}'generate'/.test(cliText))
const { resolveBuildPaths, parseBuildPathsInput } = req("next/dist/lib/resolve-build-paths") as {
  resolveBuildPaths: (patterns: string[], dir: string) => Promise<{ appPaths: string[]; pagePaths: string[] }>
  parseBuildPathsInput: (s: string) => string[]
}
check("A3 next's own resolver module exports resolveBuildPaths + parseBuildPathsInput (the code the flag runs)", typeof resolveBuildPaths === "function" && typeof parseBuildPathsInput === "function")

const wf = parseYaml(read(".github/workflows/build.yml")) as { jobs: Record<string, any> }
const phases = parseYaml(read(".github/actions/next-build-phases/action.yml")) as { inputs: Record<string, any>; runs: { steps: Array<{ name: string; run?: string; env?: Record<string, string> }> } }
const full = wf.jobs["next-build-full"], half = wf.jobs["next-build-half"], gate = wf.jobs["next-build"]
check("A4 three jobs: next-build-full (the larger runner), next-build-half (lever d), next-build (the one verdict)", !!full && !!half && !!gate)
check("A5 BUILD_RUNNER: the full pass runs ONLY when it is set and runs ON it; the halves run only when it is empty, on ubuntu-latest",
  full?.if === "${{ vars.BUILD_RUNNER != '' }}" && String(full?.["runs-on"]).includes("vars.BUILD_RUNNER") && half?.if === "${{ vars.BUILD_RUNNER == '' }}" && half?.["runs-on"] === "ubuntu-latest")
check("A6 BUILD_HEAP_MB reaches the compile (job NODE_OPTIONS, inherited by the webpack build worker); the generate phase gets its OWN heap (BUILD_GENERATE_HEAP_MB through the phases action input)",
  /--max-old-space-size=\$\{\{ vars\.BUILD_HEAP_MB \|\| '14336' \}\}/.test(full?.env?.NODE_OPTIONS ?? "")
  && phases.runs.steps.some((s) => /generate/.test(s.name) && /inputs\.generate-heap-mb/.test(s.env?.NODE_OPTIONS ?? ""))
  && JSON.stringify(full?.steps ?? []).includes("BUILD_GENERATE_HEAP_MB") && JSON.stringify(half?.steps ?? []).includes("BUILD_GENERATE_HEAP_MB"))
const usesPhases = (job: any) => (job?.steps ?? []).some((s: any) => s.uses === "./.github/actions/next-build-phases")
check("A7 both build jobs run the ONE phases action (swap → compile → bridge → generate); the halves pass their matrix globs", usesPhases(full) && usesPhases(half)
  && (half?.steps ?? []).some((s: any) => s.uses === "./.github/actions/next-build-phases" && s.with?.["debug-build-paths"] === "${{ matrix.paths }}"))
const compileStep = phases.runs.steps.find((s) => /— compile/.test(s.name))?.run ?? ""
const generateStep = phases.runs.steps.find((s) => /— generate/.test(s.name))?.run ?? ""
check("A8 compile and generate receive the SAME globs (next re-runs route discovery in generate mode) — one input, both commands",
  /--experimental-build-mode compile --debug-build-paths "\$BUILD_PATHS"/.test(compileStep) && /--experimental-build-mode generate --debug-build-paths "\$BUILD_PATHS"/.test(generateStep)
  && phases.runs.steps.filter((s) => s.env?.BUILD_PATHS === "${{ inputs.debug-build-paths }}").length === 2)

// ── the workflow's own shell, EXECUTED (the verdict and both preflights) ──────────────────────────────────────────
function shellOf(job: any, nameRe: RegExp): string { return (job?.steps ?? []).find((s: any) => nameRe.test(s.name ?? ""))?.run ?? "" }
function runShell(script: string, values: Record<string, string>): { code: number; out: string } {
  let unknown = ""
  const body = script.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_m, expr: string) => { if (!(expr in values)) unknown = expr; return values[expr] ?? "" })
  if (unknown) return { code: 99, out: `unmapped expression: ${unknown}` }
  const r = spawnSync("bash", ["-e", "-c", body], { encoding: "utf8" })
  return { code: r.status ?? 98, out: `${r.stdout}${r.stderr}` }
}
const verdictSh = shellOf(gate, /Verdict/)
const verdict = (fullR: string, halfR: string) => runShell(verdictSh, { "needs.next-build-full.result": fullR, "needs.next-build-half.result": halfR, "vars.BUILD_RUNNER": fullR === "skipped" ? "" : "linux-8-core" }).code
const RESULTS = ["success", "failure", "cancelled", "skipped"]
const greenPairs = RESULTS.flatMap((f) => RESULTS.map((h) => [f, h] as const)).filter(([f, h]) => verdict(f, h) === 0).map(([f, h]) => `${f}/${h}`)
check("A9 THE VERDICT IS FAIL-CLOSED (its own shell executed for all 16 result pairs): green only for full=success, or full=skipped with every half success",
  gate?.if === "${{ always() }}" && JSON.stringify(gate?.needs) === JSON.stringify(["next-build-full", "next-build-half"])
  && greenPairs.join(",") === ["success/success", "success/failure", "success/cancelled", "success/skipped", "skipped/success"].join(","), `green for: ${greenPairs.join(", ")}`)
check("A9 POSITIVE CONTROL — both skipped, and a cancelled half, are RED (a build nobody ran never reads as certified)", verdict("skipped", "skipped") !== 0 && verdict("skipped", "cancelled") !== 0 && verdict("failure", "success") !== 0)
const fullPre = shellOf(full, /Preflight/)
const runFullPre = (heap: string) => runShell(fullPre, { "vars.BUILD_HEAP_MB || '14336'": heap, "vars.BUILD_RUNNER": "linux-8-core", "vars.BUILD_GENERATE_HEAP_MB || '10240'": "10240" })
const halfPre = shellOf(half, /Preflight/)
const runHalfPre = (heap: string) => runShell(halfPre, { "vars.BUILD_HALF_HEAP_MB || '14336'": heap, "matrix.half": "dashboard", "matrix.paths": "app/dashboard/**", "vars.BUILD_GENERATE_HEAP_MB || '10240'": "10240" })
const pre14336 = runFullPre("14336"), pre16384 = runFullPre("16384")
check("A10 the full-pass preflight REFUSES a larger runner left on the cap that aborted three times (14336) and names BUILD_HEAP_MB; 16384 is not refused on that ground",
  pre14336.code !== 0 && /BUILD_HEAP_MB/.test(pre14336.out) && !/compile heap is 16384 MB — 14336 aborted/.test(pre16384.out))
check("A11 the half preflight refuses a heap above 14336 on the 16 GB runner and admits 14336 (positive + negative control)", runHalfPre("16384").code !== 0 && runHalfPre("14336").code === 0)

// ── THE PARTITION, with next's OWN resolver ───────────────────────────────────────────────────────────────────────
interface Part { half: string; paths: string }
const matrix: Part[] = (half?.strategy?.matrix?.include ?? []).map((m: any) => ({ half: String(m.half), paths: String(m.paths) }))
async function partition(parts: Part[]) {
  const sets = await Promise.all(parts.map(async (p) => new Set((await resolveBuildPaths(parseBuildPathsInput(p.paths), ROOT)).appPaths)))
  const all = new Set((await resolveBuildPaths(["app/**"], ROOT)).appPaths)
  const seen = new Map<string, number>()
  for (const s of sets) for (const r of s) seen.set(r, (seen.get(r) ?? 0) + 1)
  const overlap = [...seen].filter(([, n]) => n > 1).map(([r]) => r)
  const hole = [...all].filter((r) => !seen.has(r))
  const stray = [...seen.keys()].filter((r) => !all.has(r))
  return { sets, all, overlap, hole, stray, ok: overlap.length === 0 && hole.length === 0 && stray.length === 0 && parts.length >= 2 }
}
/** Filesystem census of route-defining files (the resolver's own rule: app/**\/page.* and app/**\/route.*). */
function fsRoutes(): number {
  let n = 0
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { if (e.name.startsWith(".") || e.name === "node_modules") continue; const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/^(page|route)\.(tsx?|jsx?)$/.test(e.name)) n++ } }
  walk(join(ROOT, "app")); return n
}
const SEG = /^(layout|template|loading|error|not-found|default)\.(tsx?|jsx?)$/
function measure(routes: Set<string>) {
  const w = makeWalker(ROOT)
  const entries = new Set<string>()
  for (const r of routes) {
    const abs = join(ROOT, "app", r); entries.add(abs)
    if (/\/page\.[^/]+$/.test(r)) { let d = dirname(abs); while (d.startsWith(join(ROOT, "app"))) { for (const f of readdirSync(d)) if (SEG.test(f)) entries.add(join(d, f)); d = dirname(d) } }
  }
  for (const f of ["global-error.tsx", "not-found.tsx"]) if (has(`app/${f}`)) entries.add(join(ROOT, "app", f))
  const mods = new Set<string>(); for (const e of entries) for (const m of w.reach(e).seen) mods.add(m)
  let bytes = 0; for (const m of mods) bytes += statSync(m).size
  return { routes: routes.size, entries: entries.size, modules: mods.size, mb: bytes / 1048576 }
}
const MAX_HALF_SHARE = 0.8
const p = await partition(matrix)
check(`A12 the matrix names ≥2 halves, each with globs (${matrix.map((m) => `${m.half}: ${m.paths}`).join(" · ")})`, matrix.length >= 2 && matrix.every((m) => m.half && m.paths))
check(`A13 THE HALVES PARTITION EVERY app/ PAGE AND ROUTE (next's resolver): ${p.sets.map((s) => s.size).join(" + ")} = ${p.all.size}, overlap ${p.overlap.length}, hole ${p.hole.length}`,
  p.ok, [p.overlap.length ? `in two halves: ${p.overlap.slice(0, 5).join(", ")}` : "", p.hole.length ? `in no half: ${p.hole.slice(0, 5).join(", ")}` : ""].filter(Boolean).join("; "))
const fsN = fsRoutes()
check(`A14 next's resolver sees every route file on disk (resolver ${p.all.size} = filesystem census ${fsN}) — a resolver blind spot would leave routes out of BOTH halves`, p.all.size === fsN && fsN > 0)
const overlapCtl = await partition([{ half: "x", paths: "app/dashboard/**" }, { half: "y", paths: "app/**" }])
const holeCtl = await partition([{ half: "x", paths: "app/dashboard/**" }, { half: "y", paths: "app/api/**" }])
check("A13 POSITIVE CONTROL — an overlapping matrix and a holey matrix are both caught", !overlapCtl.ok && overlapCtl.overlap.length > 0 && !holeCtl.ok && holeCtl.hole.length > 0)
const whole = measure(p.all)
const halves = matrix.map((m, i) => ({ ...m, ...measure(p.sets[i]) }))
console.log(`    MEASURED (first-party, the ONE walker; entries = kept page/route files + their loader-tree segment files + root error pages):`)
console.log(`      whole tree   routes ${String(whole.routes).padStart(4)}  entries ${String(whole.entries).padStart(4)}  modules ${String(whole.modules).padStart(5)}  ${whole.mb.toFixed(2)} MB`)
for (const h of halves) console.log(`      ${h.half.padEnd(12)} routes ${String(h.routes).padStart(4)}  entries ${String(h.entries).padStart(4)}  modules ${String(h.modules).padStart(5)}  ${h.mb.toFixed(2)} MB  (${((100 * h.modules) / whole.modules).toFixed(1)}% of the union's modules, ${((100 * h.mb) / whole.mb).toFixed(1)}% of its bytes)`)
const largest = halves.reduce((a, b) => (b.modules > a.modules ? b : a), halves[0])
check(`A15 RULE: the largest half compiles ≤ ${MAX_HALF_SHARE * 100}% of the whole graph's first-party modules (derived every run: ${largest.half} ${largest.modules}/${whole.modules})`, largest.modules <= MAX_HALF_SHARE * whole.modules)
const oneHalf = measure(new Set((await resolveBuildPaths(["app/**"], ROOT)).appPaths))
check("A15 POSITIVE CONTROL — a one-part \"matrix\" (app/**) is the whole graph and fails the share rule", oneHalf.modules > MAX_HALF_SHARE * whole.modules)
// The bracket is YAML-comment prose (the workflow's documentation), so it is read raw — not TS, nothing to strip.
const bracket = read(".github/workflows/build.yml").replace(/\n\s*#\s?/g, " ")
check("A16 the bracket records lever (d) as implemented, says the unchanged full pass is NOT re-run, and states what a partial generate cannot prove",
  /2026-11-01, wave 148 lane 148A: LEVER \(d\) IMPLEMENTED/.test(bracket) && /NOT re-run on ubuntu-latest/.test(bracket) && /CANNOT — produce a deployable \.next/.test(bracket))

// ═════════════════════════════════════════════════════════════════════════════
// B · O1 — THE STORAGE POLICIES
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[B · O1 — storage.objects policies m855 (§F) and m875 (§G) stay release-blocking until applied and verified]")
const MIG = "supabase/migrations"
const migNamed = (n: number) => readdirSync(join(ROOT, MIG)).find((f) => f.startsWith(`m${n}-`) && f.endsWith(".sql")) ?? null
const storageFiles = [855, 875].map(migNamed)
check("B1 both storage-policy migrations exist and touch storage.objects", storageFiles.every((f) => !!f && /storage\.objects/i.test(read(`${MIG}/${f}`))), storageFiles.join(", "))
const storageStamps = storageFiles.map((f) => (f ? claimOf(read(`${MIG}/${f}`)) : "absent"))
const o1Open = storageStamps.some((s) => s !== "applied")
obligations.push({ id: "O1", kind: "owner-sql", open: o1Open, what: "storage.objects policies on the five document buckets (m855 brokerage-forms · m875 client/transaction/agent/offer documents)", where: `docs/operations/OWNER-SQL.md §F, §G then §J — stamps: ${storageFiles.map((f, i) => `${f} (${storageStamps[i]})`).join(", ")}` })
check(`B2 O1 is RELEASE-BLOCKING exactly while a policy migration lacks the applied stamp (now: ${o1Open ? "OPEN" : "discharged"})`, o1Open === storageStamps.some((s) => s !== "applied"))
check("B2 POSITIVE CONTROL — the ONE classifier reads the lane stamp as not applied and the APPLIED LIVE stamp as applied",
  claimOf("-- WRITTEN, NOT APPLIED (wave 146, lane 146A) — x\n") !== "applied" && claimOf("-- ── APPLIED LIVE 2026-11-02 via the owner SQL editor\n") === "applied")
const ownerSql = has("docs/operations/OWNER-SQL.md") ? read("docs/operations/OWNER-SQL.md") : ""
const section = (letter: string) => ownerSql.split(/^## /m).find((s) => new RegExp(`^${letter}\\.\\s`).test(s)) ?? ""
const secF = section("F"), secG = section("G"), secI = section("I"), secJ = section("J")
check("B3 §F and §G each carry a 'Verify afterwards' block with expected values (policy census, no bucket-wide rule, impersonation checks)",
  /### Verify afterwards/.test(secF) && /expect/.test(secF) && /### Verify afterwards/.test(secG) && /storage_bucket_policy_readiness\(\)/.test(secG) && /set_config\('request\.jwt\.claims'/.test(secG))
const J_STEPS = [
  ["the live verdict per bucket", /storage_bucket_policy_readiness\(\)/],
  ["all six expected verdicts", /agent-documents owner_scoped[\s\S]*brokerage-forms owner_scoped[\s\S]*client-documents owner_scoped[\s\S]*documents service_only[\s\S]*offer-documents service_only[\s\S]*transaction-documents owner_scoped/],
  ["no bucket-wide rule (0 rows)", /expect 0 rows/],
  ["exactly eleven owner policies", /expect 11/],
  ["the §F/§G impersonation checks", /impersonation checks/],
  ["the seed census (expect 0)", /unlinked_contact_users[\s\S]*expect 0|expect 0[\s\S]*unlinked_contact_users/],
  ["the repo flips (stamps + NOT_APPLIED_BASELINE + §I status)", /APPLIED LIVE[\s\S]*NOT_APPLIED_BASELINE[\s\S]*RESOLVED/],
  ["the proofs re-run", /test:release-blockers[\s\S]*test:production-readiness/],
] as const
const missingJ = J_STEPS.filter(([, re]) => !re.test(secJ)).map(([n]) => n)
check(`B4 OWNER-SQL §J — the post-application close-out the owner runs, in order (${J_STEPS.length} items)`, secJ.length > 0 && missingJ.length === 0, missingJ.join(", "))

// ═════════════════════════════════════════════════════════════════════════════
// C · O2 — THE FOUR PORTAL SEED ACCOUNTS
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[C · O2 — the four unlinked portal seed accounts: inventory + scoped, reversible remediation, no deletion]")
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g
const invRows = [...secI.matchAll(/^\| `([0-9a-f-]{36})` \| [^|]+ \| `([0-9a-f-]{36})` \|/gm)].map((m) => ({ user: m[1], contact: m[2] }))
check(`C1 §I carries the inventory: four seed accounts, each paired with one contact (${invRows.length} rows)`, invRows.length === 4 && new Set(invRows.map((r) => r.user)).size === 4 && new Set(invRows.map((r) => r.contact)).size === 4)
const sqlBlocks = [...secI.matchAll(/```sql\n([\s\S]*?)```/g)].map((m) => m[1])
const blockTagged = (tag: string) => sqlBlocks.find((b) => b.trimStart().startsWith(`-- ${tag}`)) ?? ""
interface ScriptVerdict { ok: boolean; reasons: string[] }
/** PURE — the remediation rule: no DELETE / DROP / TRUNCATE; every UPDATE carries a WHERE; the script names every
 *  inventory id; A is one transaction with a drift guard (RAISE EXCEPTION) and RETURNING; a rollback restores only
 *  where the link is still the seed account. Read from SQL with comments stripped (scripts/strip-sql-comments.ts). */
function judgeRemediation(a: string, rollback: string, b: string, inv: Array<{ user: string; contact: string }>): ScriptVerdict {
  const reasons: string[] = []
  const code = [a, rollback, b].map(stripSqlComments)
  for (const [i, c] of code.entries()) {
    if (/\b(DELETE\s+FROM|DROP\s+(TABLE|POLICY|FUNCTION|INDEX|COLUMN)|TRUNCATE)\b/i.test(c.replace(/ON COMMIT DROP/gi, ""))) reasons.push(`block ${i} deletes or drops`)
    for (const stmt of c.split(";")) if (/\bUPDATE\s+public\./i.test(stmt) && !/\bWHERE\b/i.test(stmt)) reasons.push(`block ${i} has an UPDATE with no WHERE`)
  }
  const [ca, cr, cb] = code
  if (!/\bBEGIN\b[\s\S]*\bCOMMIT\b/i.test(ca)) reasons.push("A is not one transaction")
  if (!/RAISE EXCEPTION/i.test(ca)) reasons.push("A has no drift guard")
  if (!/RETURNING/i.test(ca)) reasons.push("A does not return what it changed")
  if (!cr || !/SET\s+contact_user_id\s*=\s*NULL/i.test(cr) || !/\(id,\s*contact_user_id\)\s+IN/i.test(cr)) reasons.push("no rollback scoped to the seed link")
  if (!/status\s*=\s*'inactive'/i.test(cb) || !/status\s*=\s*'active'/i.test(cb)) reasons.push("archive B is missing or not reversible")
  for (const r of inv) for (const [label, c] of [["A", ca], ["rollback", cr]] as const) if (!c.includes(r.user) || !c.includes(r.contact)) reasons.push(`${label} does not name ${r.user} → ${r.contact}`)
  for (const r of inv) if (!cb.includes(r.user)) reasons.push(`B does not name ${r.user}`)
  const allIds = new Set([...(ca.match(UUID) ?? []), ...(cr.match(UUID) ?? []), ...(cb.match(UUID) ?? [])])
  const invIds = new Set(inv.flatMap((r) => [r.user, r.contact]))
  const stray = [...allIds].filter((id) => !invIds.has(id))
  if (stray.length) reasons.push(`names ids outside the inventory: ${stray.join(", ")}`)
  return { ok: reasons.length === 0, reasons }
}
const remA = blockTagged("§I REMEDIATION A"), rbA = blockTagged("§I ROLLBACK A"), remB = blockTagged("§I REMEDIATION B")
const rem = judgeRemediation(remA, rbA, remB, invRows)
check("C2 the remediation is SCOPED (only inventory ids), GUARDED (drift → RAISE EXCEPTION, one transaction), REVERSIBLE (rollback A, reversible archive B) and deletes NOTHING", rem.ok, rem.reasons.join("; "))
const ctlDelete = judgeRemediation(remA + "\nDELETE FROM public.users WHERE id = 'a0000000-0000-0000-0000-000000000013';", rbA, remB, invRows)
const ctlUnscoped = judgeRemediation(remA.replace(/WHERE c\.id = l\.contact_id AND c\.contact_user_id IS NULL/, ""), rbA, remB, invRows)
const ctlNoRollback = judgeRemediation(remA, "", remB, invRows)
check("C2 POSITIVE CONTROL — a DELETE, an UPDATE with no WHERE, and a missing rollback are each refused",
  !ctlDelete.ok && ctlDelete.reasons.some((r) => /deletes/.test(r)) && !ctlUnscoped.ok && ctlUnscoped.reasons.some((r) => /no WHERE/.test(r)) && !ctlNoRollback.ok)
const seedResolved = (doc: string): boolean => /^- Status:\s*RESOLVED\b.*\d{4}-\d{2}-\d{2}.*\b0\b/m.test(doc)
const o2Open = !seedResolved(secI)
obligations.push({ id: "O2", kind: "owner-decision", open: o2Open, what: "four unlinked portal-contact seed accounts (VIP Premier Realty) — run §I remediation A (link) or B (archive)", where: "docs/operations/OWNER-SQL.md §I (inventory + scripts + status line)" })
check(`C3 O2 is RELEASE-BLOCKING until §I's status line reads RESOLVED with a date and the zero census (now: ${o2Open ? "OPEN" : "discharged"}; same rule as production-readiness O2)`, /^- Status:/m.test(secI) && o2Open === !seedResolved(secI))
check("C3 POSITIVE CONTROL — OPEN blocks, RESOLVED with date + 0 lifts, RESOLVED without a date does not", !seedResolved("- Status: OPEN — 4 unlinked (2026-11-01)") && seedResolved("- Status: RESOLVED 2026-11-02 — census 0") && !seedResolved("- Status: RESOLVED — census 0"))

// ═════════════════════════════════════════════════════════════════════════════
// D · CONFIGURATION BY VARIABLE NAME ONLY
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[D · configuration by variable NAME only — origin, Vercel Workflow, cron, webhook doors]")
const runtimeEnv = new Set<string>()
for (const r of ["app", "lib", "workflows"]) for (const f of walkTs(join(ROOT, r))) {
  const src = stripComments(readFileSync(f, "utf8"))
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[\s*["']([A-Z][A-Z0-9_]+)["']\s*\]/g)) runtimeEnv.add(m[1] ?? m[2])
  // A module that reads process.env[<computed>] (lib/billing/stripe-account-scope.ts maps endpoint → "STRIPE_WEBHOOK_SECRET")
  // reads the ALL_CAPS names it spells as literals — counted from that module only (a published heuristic, see blind spots).
  if (/process\.env\[(?!\s*["'])/.test(src)) for (const m of src.matchAll(/["']([A-Z][A-Z0-9]*_[A-Z0-9_]+)["']/g)) runtimeEnv.add(m[1])
}
for (const f of ["proxy.ts", "next.config.ts"]) if (has(f)) for (const m of stripComments(read(f)).matchAll(/process\.env\.([A-Z][A-Z0-9_]+)/g)) runtimeEnv.add(m[1])
const siteSrc = stripComments(read("lib/platform/site-url.ts"))
check("D1 the public origin resolves through ONE function: NEXT_PUBLIC_APP_URL, else VERCEL_URL, else \"\" (never an invented host)",
  /export function siteUrl\(\)/.test(siteSrc) && /process\.env\.NEXT_PUBLIC_APP_URL/.test(siteSrc) && /process\.env\.VERCEL_URL/.test(siteSrc) && !/localhost|https:\/\/[a-z0-9-]+\.(com|io|app)/i.test(siteSrc))
const nextCfg = stripComments(read("next.config.ts"))
const wfFiles = readdirSync(join(ROOT, "workflows")).filter((f) => f.endsWith(".ts"))
const ctSrc = stripComments(read("lib/kernel/completion-tracking.ts"))
check(`D2 Vercel Workflow: next.config exports withWorkflow(…); every workflows/*.ts (${wfFiles.length}) declares "use workflow"; the durable timer starts only where the VERCEL runtime is present and otherwise leaves the row to the cron net`,
  /export default withWorkflow\(/.test(nextCfg) && wfFiles.length > 0 && wfFiles.every((f) => /["']use workflow["']/.test(read(`workflows/${f}`)))
  && /if \(!process\.env\.VERCEL\) return \{ scheduled: false/.test(ctSrc) && runtimeEnv.has("VERCEL"))
const vercel = JSON.parse(read("vercel.json")) as { buildCommand?: string; crons?: Array<{ path: string }> }
const cronRoutes = (vercel.crons ?? []).map((c) => `app${c.path}/route.ts`)
check(`D3 the cron door: vercel.json schedules ${(vercel.crons ?? []).map((c) => c.path).join(", ")}; each route exists and the dispatcher reads CRON_SECRET (fail-closed census: test:cron-auth-fail-closed)`,
  cronRoutes.length > 0 && cronRoutes.every(has) && runtimeEnv.has("CRON_SECRET"))
const secretNames = [...new Set(WEBHOOK_CONTRACT.flatMap((w) => w.secretEnv))]
const unread = secretNames.filter((n) => !runtimeEnv.has(n))
const secretless = WEBHOOK_CONTRACT.filter((w) => w.secretEnv.length === 0)
check(`D4 every contracted webhook door's secret is a variable the runtime reads (${WEBHOOK_CONTRACT.length} doors, ${secretNames.length} names; ${secretless.length} verify per-tenant / by provider signature: ${secretless.map((w) => w.path).join(", ")})`, unread.length === 0, unread.join(", "))
check("D4 POSITIVE CONTROL — a name nobody reads is caught", !runtimeEnv.has("VIPRE_GHOST_WEBHOOK_SECRET_148A"))
// `via` = the name is read through a computed process.env[...] lookup: the reader module and the module spelling the literal.
const CONFIG_BY_NAME: ReadonlyArray<{ env: string; why: string; via?: { reader: string; literalIn: string } }> = [
  { env: "NEXT_PUBLIC_APP_URL", why: "canonical origin — webhook registration, magic links, checkout return URLs (inlined at BUILD time: redeploy after setting)" },
  { env: "NEXT_PUBLIC_SUPABASE_URL", why: "database + auth" }, { env: "NEXT_PUBLIC_SUPABASE_ANON_KEY", why: "browser auth client" },
  { env: "SUPABASE_SERVICE_ROLE_KEY", why: "server writes (service client)" }, { env: "CRON_SECRET", why: "the per-minute dispatcher's bearer" },
  { env: "SECRETS_ENCRYPTION_KEY", why: "every stored provider credential (keep an offline copy)" }, { env: "AI_GATEWAY_API_KEY", why: "the AI route (managers, copy, triage)" },
  { env: "STRIPE_SECRET_KEY", why: "billing (owner ruling: no live billing yet)" }, { env: "STRIPE_WEBHOOK_SECRET", why: "the platform billing webhook", via: { reader: "lib/billing/resolve-stripe-account.ts", literalIn: "lib/billing/stripe-account-scope.ts" } },
  { env: "SENDGRID_API_KEY", why: "email delivery" }, { env: "TWILIO_ACCOUNT_SID", why: "SMS / voice" },
]
const readVia = (c: { env: string; via?: { reader: string; literalIn: string } }) => !!c.via && /process\.env\[/.test(stripComments(read(c.via.reader))) && stripComments(read(c.via.literalIn)).includes(`"${c.env}"`)
const cfgUnread = CONFIG_BY_NAME.filter((c) => !runtimeEnv.has(c.env) && !readVia(c))
for (const c of CONFIG_BY_NAME) console.log(`    NAME ${c.env.padEnd(32)} ${c.why}`)
check(`D5 every launch configuration name above is read by the runtime (${CONFIG_BY_NAME.length}; names only, never a value)`, cfgUnread.length === 0, cfgUnread.map((c) => c.env).join(", "))

// ═════════════════════════════════════════════════════════════════════════════
// E · THE DEPLOYMENT BUILD (Vercel)
// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[E · the deployment build — what Vercel runs is the single pass]")
const vercelHeap = Number((vercel.buildCommand ?? "").match(/max-old-space-size=(\d+)/)?.[1] ?? 0)
const ciCap = Number(read(".github/workflows/build.yml").match(/BUILD_HEAP_MB \|\| '(\d+)'/)?.[1] ?? 0)
/** PURE — the rule: Vercel's single pass must run with at least the compile heap CI's full pass needs; the CI default
 *  (the cap the bracket recorded aborting at the ~90% give-up line) is the floor, so at or below it the deploy is OPEN. */
const deployBuildOpen = (vh: number, cap: number) => !(vh > cap)
const singlePass = /next build --webpack/.test(vercel.buildCommand ?? "") && !/experimental-build-mode/.test(vercel.buildCommand ?? "")
obligations.push({ id: "O3", kind: "owner-config", open: deployBuildOpen(vercelHeap, ciCap), what: `the Vercel deployment build — vercel.json runs the ${singlePass ? "single" : "split"} pass at ${vercelHeap} MB, at or below the CI compile cap that aborts (${ciCap} MB, ~12.9 GB committed demand measured 2026-10-31)`, where: "Vercel → Project → Settings → Build & Development → Build Machine (a larger machine), then raise vercel.json's heap to match (a code change after the owner picks the machine) — ACTIVATION-CHECKLIST §1.9" })
check(`E1 the deployment-build obligation is derived, not pinned (vercel ${vercelHeap} MB vs CI cap ${ciCap} MB → ${deployBuildOpen(vercelHeap, ciCap) ? "OPEN" : "clear"})`, vercelHeap > 0 && ciCap > 0)
check("E1 POSITIVE CONTROL — 10240 vs 14336 is OPEN; 16384 vs 14336 clears", deployBuildOpen(10240, 14336) && !deployBuildOpen(16384, 14336))

// ═════════════════════════════════════════════════════════════════════════════
console.log("\n[release blockers]")
for (const o of obligations) console.log(`    ${o.open ? "RELEASE-BLOCKING" : "discharged      "} ${o.id} [${o.kind}] ${o.what} — ${o.where}`)
const open = obligations.filter((o) => o.open)
console.log("\n[blind spots]")
console.log("  · the matrix's CI result is GitHub's: the first run of next-build-half IS the per-half heap measurement (append its GC lines to build.yml)")
console.log("  · module counts are first-party only (packages, runtime chunks and the double rsc/ssr layer are not counted) — a lower bound, not webpack's count")
console.log("  · live state (storage verdict, seed census) is the owner's SQL to read; this guard reads the stamps / status lines that record it")
console.log("  · a name read through process.env[<computed>] is credited from the literals of the module that computes it — a heuristic, not a data-flow proof")
console.log("  · presence of a name in the Vercel project is not readable from the repository (ACTIVATION-CHECKLIST §1 — names only)")
console.log(`\nRELEASE BLOCKERS: ${open.length} owner obligation(s) open${open.length ? ` — ${open.map((o) => o.id).join(", ")}` : ""}`)
console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
if (fail) { console.log("FAILURES:\n  - " + fails.join("\n  - ")); process.exit(1) }
