#!/usr/bin/env tsx
/**
 * scripts/dead-component-guard.ts  (npm run test:no-dead-components) — pure, no DB.
 *
 * DRIFT RATCHET — no orphaned React component may re-accumulate. After a 226-component dead-code
 * sweep, this freezes the win: every .tsx under app/components AND under any co-located
 * "components" directory in app/ (dashboard/x/components, crm/components, portal components …)
 * must be imported by at least ONE other file (any form — @/components, @/lib, @/ alias, relative,
 * dynamic import, or a barrel re-export). Next.js convention files (page/layout/route/…) are exempt.
 * A component imported by NOTHING is dead drift and FAILS CI until it's wired up or deleted.
 *
 * Zero false positives by design: "imported by nothing" is a hard fact (unlike full reachability,
 * which has Next.js-convention edge cases) — so this guard never blocks a legitimate component.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, normalize, relative } from "node:path"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")

// TOMBSTONE (orphan doctrine §1.1) — the private `walk(dir, out)` that stood here
// was one of 82 copies of the same readdirSync walker. Survivor:
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// It enumerated DIRECTORIES, and a root-level FILE is not a directory, so the two
// runtime files at the repository root were outside the corpus in BOTH directions:
// `proxy.ts` was never checked for dead imports, and every module whose ONLY
// importer is `proxy.ts` (`@/app/constants/auth`, `@/lib/platform/site-url`) read
// as dead here. `rootRuntimeFiles()` from the same survivor supplies them.
const all = [
  ...walkTs(join(root, "app")),
  ...walkTs(join(root, "lib")),
  ...rootRuntimeFiles(root),
].map((p) => relative(root, p).replace(/\\/g, "/"))
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

// ACCUSATION SET (§2 blind-spot fix, 2026-09-01): the original predicate accused
// only app/components/** while the corpus walked ALL of app/ + lib/ — so a dead
// component in a CO-LOCATED components dir (app/dashboard/*/components/,
// app/crm/components/, portal components) could never be accused. That is exactly
// how app/dashboard/videos/components/BackgroundPicker.tsx sat dead for its whole
// life. Now: every .tsx under ANY */components/ directory within app/ is in scope.
// Next.js convention files stay exempt (routed by the framework, not by import).
const NEXT_CONVENTION = /\/(page|layout|route|loading|error|not-found|template|default|global-error)\.tsx$/
const accusable = (f: string) =>
  /^app\/(.*\/)?components\//.test(f) && f.endsWith(".tsx") && !NEXT_CONVENTION.test(f)

const orphans = all.filter((f) => accusable(f) && !used.has(f))

console.log("\n[dead-component guard — every component must be imported by something]")
const total = all.filter(accusable).length
if (orphans.length === 0) {
  console.log(`  ✓ all ${total} components are wired (zero orphans)`)
  console.log("\n──────────────────────────────────────────────────")
  console.log(" RESULT: 1 passed, 0 failed")
  console.log(" ✅ NO_DEAD_COMPONENTS_PASS — no orphaned component drift")
} else {
  console.log(`  ✗ ${orphans.length} ORPHAN component(s) imported by nothing — wire them up or delete:`)
  for (const o of orphans) console.log(`     - ${o}`)
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: 0 passed, 1 failed`)
  process.exit(1)
}
