#!/usr/bin/env tsx
/**
 * scripts/orphan-action-guard.ts  (npm run test:no-orphan-actions) — pure, no DB.
 *
 * DRIFT RATCHET for server actions. After deleting orphaned, ungoverned action files
 * (offer-management.ts, marketing-campaigns.ts) that shadowed the governed paths, this
 * freezes the win: every file under app/actions must be imported by at least ONE other
 * file (any form — @/app/actions, @/ alias, relative, dynamic import, or a barrel
 * re-export from app/actions/index.ts). An action imported by NOTHING is dead drift —
 * exactly the class that re-accumulates and reintroduces ungoverned duplicate paths —
 * and FAILS CI until it is wired up or deleted.
 *
 * Zero false positives by design: "imported by nothing" is a hard fact. The walk
 * includes app/ + lib/ + scripts/ so an action used only by a simulator still counts as
 * wired. The barrel (app/actions/index.ts) and any *known entry-point* actions are
 * exempt explicitly.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, normalize, relative } from "node:path"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASELINE_PATH = join(root, "scripts", "orphan-action-baseline.json")

function walk(dir: string, out: string[]) {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const n of entries) {
    if (n === "node_modules" || n.startsWith(".")) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n)) out.push(relative(root, p).replace(/\\/g, "/"))
  }
}

const all: string[] = []
walk(join(root, "app"), all)
walk(join(root, "lib"), all)
walk(join(root, "scripts"), all)
const set = new Set(all)

/** Resolve an import specifier to a repo-relative file (mirrors tsconfig paths + relative + index). */
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string | null = null
  if (spec.startsWith("@/components/")) base = "app/components/" + spec.slice("@/components/".length)
  else if (spec.startsWith("@/lib/")) base = "lib/" + spec.slice("@/lib/".length)
  else if (spec.startsWith("@/")) base = spec.slice(2)
  else if (spec.startsWith(".")) base = normalize(join(dirname(fromFile), spec)).replace(/\\/g, "/")
  else return null
  base = base.replace(/\.tsx?$/, "")
  for (const c of [base + ".tsx", base + ".ts", base + "/index.tsx", base + "/index.ts"]) if (set.has(c)) return c
  return null
}

const importRe = /(?:from\s*|import\(\s*|require\(\s*)["']([^"']+)["']/g
const used = new Set<string>()
for (const f of all) {
  const src = readFileSync(join(root, f), "utf8")
  let m: RegExpExecArray | null
  while ((m = importRe.exec(src))) {
    const r = resolveSpec(m[1], f)
    if (r && r !== f) used.add(r)
  }
}

// Entry-point actions reachable via Next.js convention rather than an import (none today;
// add here with a justification if a genuine convention-only action ever exists).
const EXEMPT = new Set<string>([
  "app/actions/index.ts", // the barrel itself, imported as @/app/actions
])

const actionFiles = all.filter((f) => f.startsWith("app/actions/") && f.endsWith(".ts") && !f.endsWith(".test.ts"))
const orphans = actionFiles.filter((f) => !EXEMPT.has(f) && !used.has(f)).sort()

// Baseline ratchet: the known orphan-debt set. The guard FAILS on any NEW orphan beyond
// the baseline (stops drift), and nudges to shrink the baseline as debt is burned down.
let baseline: string[] = []
try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as string[] } catch { /* no baseline yet */ }
const baseSet = new Set(baseline)
const orphanSet = new Set(orphans)

const newOrphans = orphans.filter((o) => !baseSet.has(o))
const burnedDown = baseline.filter((b) => !orphanSet.has(b)) // baseline entries now wired or deleted

console.log("\n[orphan-action guard — every server action must be imported by something]")
console.log(`  total action files: ${actionFiles.length} · current orphans: ${orphans.length} · baseline debt: ${baseline.length}`)

if (burnedDown.length > 0) {
  console.log(`  ↓ ${burnedDown.length} baseline orphan(s) resolved — run with UPDATE_ORPHAN_BASELINE=1 to shrink the baseline:`)
  for (const b of burnedDown) console.log(`     · ${b}`)
}

// Allow an explicit baseline (re)write before gating — used to seed/shrink the debt list.
if (process.env.UPDATE_ORPHAN_BASELINE === "1") {
  writeFileSync(BASELINE_PATH, JSON.stringify(orphans, null, 2) + "\n")
  console.log(`  ✎ baseline rewritten to ${orphans.length} entr${orphans.length === 1 ? "y" : "ies"}.`)
  console.log("\n RESULT: 1 passed, 0 failed")
  process.exit(0)
}

if (newOrphans.length > 0) {
  console.log(`  ✗ ${newOrphans.length} NEW ORPHAN action file(s) imported by nothing — wire them up or delete:`)
  for (const o of newOrphans) console.log(`     - ${o}`)
  console.log("\n──────────────────────────────────────────────────")
  console.log(" RESULT: 0 passed, 1 failed")
  process.exit(1)
}

console.log("\n──────────────────────────────────────────────────")
console.log(" RESULT: 1 passed, 0 failed")
console.log(orphans.length === 0
  ? " ✅ NO_ORPHAN_ACTIONS_PASS — zero orphaned server actions"
  : ` ✅ NO_NEW_ORPHAN_ACTIONS — no new drift (${orphans.length} known debt to burn down)`)
