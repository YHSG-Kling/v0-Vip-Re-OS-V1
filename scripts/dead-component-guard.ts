#!/usr/bin/env tsx
/**
 * scripts/dead-component-guard.ts  (npm run test:no-dead-components) — pure, no DB.
 *
 * DRIFT RATCHET — no orphaned React component may re-accumulate. After a 226-component dead-code
 * sweep, this freezes the win: every file under app/components must be imported by at least ONE other
 * file (any form — @/components, @/lib, @/ alias, relative, dynamic import, or a barrel re-export).
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

const orphans = all.filter((f) => f.startsWith("app/components/") && f.endsWith(".tsx") && !used.has(f))

console.log("\n[dead-component guard — every component must be imported by something]")
const total = all.filter((f) => f.startsWith("app/components/") && f.endsWith(".tsx")).length
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
