#!/usr/bin/env tsx
/**
 * scripts/orphan-export-guard.ts (npm run test:orphan-exports)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE FUNCTION-LEVEL ORPHAN LEDGER — A WIRE LIST, NOT A DELETE LIST.
 *
 * READ THIS BEFORE ACTING ON THE OUTPUT.
 *
 * Everything this guard reports is a capability that was BUILT and never
 * CONNECTED. The correct response to an entry is to finish wiring it to the
 * surface it was written for. It is NOT permission to delete. Deleting an
 * unwired capability is how a quarter of a working system disappears one
 * "cleanup" at a time, and it has already happened once in this repo.
 *
 * Deletion requires a NAMED DUPLICATE — `file.ts:functionName` that does the same
 * job MORE completely — established by reading both, not by this count.
 *
 * WHY THIS EXISTS ALONGSIDE test:no-orphan-actions.
 *
 * That guard asks "is this FILE imported by anything?" and the answer across
 * app/actions is yes, 545 out of 545 — zero orphans. But a file with fourteen
 * exports is "wired" the moment ONE of them is imported. The other thirteen can
 * be unreachable and the file-level guard reports a clean sheet.
 *
 * At function level the picture is different, and it is the honest one:
 * hundreds of exported server actions and library functions that nothing
 * anywhere calls. Verified by hand on a sample — getPendingFollowups,
 * loadRevenueSummaryAction, markBrokerageSetupCompleteAction,
 * retrySubscriberInvite — each has zero references outside its own file.
 *
 * HOW IT COUNTS. An export is orphaned when its name appears in NO other file in
 * the repo. That deliberately treats a barrel re-export as a reference: if
 * app/actions/index.ts names it, it is reachable, and the wiring question moves
 * to the barrel's consumers. Same-file references (its own logs, its own
 * helpers) do not count — a function that only calls itself is still orphaned.
 *
 * KNOWN BLIND SPOT, stated so nobody trusts this further than it deserves:
 * anything reached ONLY through a string-keyed registry or dynamic dispatch
 * looks orphaned here. Check for that before concluding a capability is unused.
 *
 * The baseline is per-file counts and may only go DOWN. Wiring one export lowers
 * its file's count; adding a new unwired export raises it and fails.
 */
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs"
import { join, relative } from "node:path"

const root = process.cwd()
const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", "public", "scripts", ".claude", "plugins",
  "supabase", "coverage", "dist", "build",
])

/** Directories whose exports are expected to be consumed by name somewhere. */
const SCANNED_ROOTS = ["app", "lib"]

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (SKIP_DIRS.has(e)) continue
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e) && !/\.d\.ts$/.test(e)) out.push(p)
  }
  return out
}

const files = walk(root).map((f) => relative(root, f).replace(/\\/g, "/"))
const corpus = new Map<string, string>()
for (const f of files) {
  try { corpus.set(f, readFileSync(join(root, f), "utf8")) } catch { corpus.set(f, "") }
}

/** Comments stripped so a mention in prose does not count as an export or a use. */
function code(f: string): string {
  return (corpus.get(f) ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "")
}

const codeCache = new Map<string, string>()
for (const f of files) codeCache.set(f, code(f))

interface ExportRef { file: string; name: string }

const exportsFound: ExportRef[] = []
for (const f of files) {
  if (!SCANNED_ROOTS.some((r) => f.startsWith(r + "/"))) continue
  const src = codeCache.get(f)!
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) {
    exportsFound.push({ file: f, name: m[1] })
  }
  for (const m of src.matchAll(/export\s+const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g)) {
    exportsFound.push({ file: f, name: m[1] })
  }
}

const orphans: ExportRef[] = []
for (const e of exportsFound) {
  const re = new RegExp(`\\b${e.name.replace(/\$/g, "\\$")}\\b`)
  let referenced = false
  for (const f of files) {
    if (f === e.file) continue
    if (re.test(codeCache.get(f)!)) { referenced = true; break }
  }
  if (!referenced) orphans.push(e)
}

const counts: Record<string, number> = {}
for (const o of orphans) counts[o.file] = (counts[o.file] ?? 0) + 1

const baselinePath = join(root, "scripts", "orphan-export-baseline.json")

/**
 * THE CENSUS — the half of this guard that protects capabilities.
 *
 * The orphan count alone is a TRAP. It falls when an export is wired up, and it
 * falls exactly as fast when the export is DELETED. A ratchet that only watches
 * that number rewards deletion and calls it progress — which is precisely how a
 * batch of agents once removed 15 working capabilities and left the metric
 * looking better than before.
 *
 * So the census records how many exported functions EXIST. Wiring one keeps the
 * census flat and lowers the orphan count. Deleting one lowers BOTH, and the
 * census floor turns that into a CI failure that names the files.
 *
 * Lowering the census is a real operation — collapsing a genuine duplicate is
 * legitimate — but it must be a deliberate, reviewed act with a named duplicate,
 * not a side effect of a cleanup pass. Re-baselining is how you declare it.
 */
interface Baseline {
  /** Per-file orphan counts. May only go DOWN. */
  files: Record<string, number>
  /** Total exported functions in the scanned roots. May NOT go down silently. */
  census: number
  /** Per-file export census, so a drop can name the file that lost capability. */
  fileCensus: Record<string, number>
}

const fileCensus: Record<string, number> = {}
for (const e of exportsFound) fileCensus[e.file] = (fileCensus[e.file] ?? 0) + 1

if (process.env.ORPHAN_EXPORT_BASELINE === "1") {
  const next: Baseline = { files: counts, census: exportsFound.length, fileCensus }
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`Baseline written: ${orphans.length} orphaned of ${exportsFound.length} exports across ${Object.keys(counts).length} files.`)
  process.exit(0)
}

const raw = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {}
// Tolerate the pre-census baseline shape so this guard can be upgraded in place.
const baselineObj: Baseline = raw.files
  ? raw
  : { files: raw as Record<string, number>, census: 0, fileCensus: {} }

const baseline = baselineObj.files
const baselineTotal = Object.values(baseline).reduce((a, b) => a + b, 0)

console.log("\n[orphan-export guard — exported functions nothing else references]")
console.log(`  ${exportsFound.length} exported functions scanned · ${orphans.length} unreferenced (baseline ${baselineTotal})`)

const regressions: string[] = []
for (const [file, count] of Object.entries(counts)) {
  const allowed = baseline[file] ?? 0
  if (count > allowed) {
    regressions.push(`${file} — ${count} unreferenced export(s) (baseline ${allowed})`)
  }
}

const improved: string[] = []
for (const [file, allowed] of Object.entries(baseline)) {
  const now = counts[file] ?? 0
  if (now < allowed) improved.push(`${file}: ${allowed} → ${now}`)
}

if (improved.length > 0) {
  console.log(`\n  ↓ burned down in ${improved.length} file(s):`)
  for (const i of improved.slice(0, 20)) console.log(`     ${i}`)
  if (improved.length > 20) console.log(`     … and ${improved.length - 20} more`)
  console.log(`\n  Re-baseline with ORPHAN_EXPORT_BASELINE=1 npm run test:orphan-exports`)
}

// ── THE CENSUS CHECK — did a capability disappear? ──────────────────────────
const lostCapability: string[] = []
if (baselineObj.census > 0) {
  for (const [file, had] of Object.entries(baselineObj.fileCensus)) {
    const now = fileCensus[file] ?? 0
    if (now < had) lostCapability.push(`${file} — ${had} → ${now} exported function(s)`)
  }
}

if (lostCapability.length > 0) {
  console.log(`\n  ✗ CAPABILITY REMOVED — ${lostCapability.length} file(s) export FEWER functions than the baseline:`)
  for (const l of lostCapability.slice(0, 25)) console.log(`     - ${l}`)
  if (lostCapability.length > 25) console.log(`     … and ${lostCapability.length - 25} more`)
  console.log("\n  An unwired capability is work to FINISH, never to remove. Deleting one")
  console.log("  lowers the orphan count too, which is exactly why that number alone")
  console.log("  cannot be trusted as progress.")
  console.log("\n  If a deletion is genuinely correct you must be able to NAME THE DUPLICATE")
  console.log("  it collapses into — file.ts:functionName that does the same job more")
  console.log("  completely — and then re-baseline deliberately:")
  console.log("     ORPHAN_EXPORT_BASELINE=1 npm run test:orphan-exports")
  console.log(" ❌ ORPHAN_EXPORT_FAIL — capability removed")
  process.exit(1)
}

console.log(`  census: ${exportsFound.length} exported functions (baseline ${baselineObj.census || "unset"})`)

console.log("\n──────────────────────────────────────────────────")
if (regressions.length > 0) {
  console.log(`  ✗ ${regressions.length} file(s) gained an unreferenced export:`)
  for (const r of regressions.slice(0, 25)) console.log(`     - ${r}`)
  if (regressions.length > 25) console.log(`     … and ${regressions.length - 25} more`)
  console.log("\n  A new export with no caller is an unfinished feature. WIRE it to the")
  console.log("  surface it was written for — do not delete it, and do not raise the")
  console.log("  baseline to make this pass.")
  console.log(" ❌ ORPHAN_EXPORT_FAIL")
  process.exit(1)
}

console.log(` ✅ ORPHAN_EXPORT_PASS — no NEW unwired export (${orphans.length} on the wire-list, burn-down)`)
