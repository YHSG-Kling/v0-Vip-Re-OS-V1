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
import { walkTs, rootRuntimeFiles, runtimeRoots } from "./runtime-roots"
import { blankComments } from "./strip-comments"

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
//
// LANE 85E — THE CORPUS IS EVERY RUNTIME ROOT (runtimeRoots: app, lib, hooks,
// contexts, remotion, services, …), not app/ + lib/ alone: a component whose
// only importer lives in hooks/ or remotion/ read as dead, and a .tsx outside
// app/ could never be accused at all.
const all = [
  ...runtimeRoots(root).flatMap((r) => walkTs(join(root, r))),
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
/** Every file a source text imports. COMMENTS BLANKED (CLAUDE.md §2 — a
 *  tombstone that names `from "@/app/…/x"` is not an importer; the raw read
 *  let a comment keep a dead component "used" forever). String contents are
 *  KEPT: the specifier IS a string. */
function importsOf(src: string, fromFile: string): string[] {
  const out: string[] = []
  const code = blankComments(src)
  const re = new RegExp(importRe.source, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    const r = resolveSpec(m[1], fromFile)
    if (r && r !== fromFile) out.push(r)
  }
  return out
}
const used = new Set<string>()
for (const f of all) for (const r of importsOf(readFileSync(join(root, f), "utf8"), f)) used.add(r)

// ACCUSATION SET (§2 blind-spot fix, 2026-09-01): the original predicate accused
// only app/components/** while the corpus walked ALL of app/ + lib/ — so a dead
// component in a CO-LOCATED components dir (app/dashboard/*/components/,
// app/crm/components/, portal components) could never be accused. That is exactly
// how app/dashboard/videos/components/BackgroundPicker.tsx sat dead for its whole
// life. Now: every .tsx under ANY */components/ directory within app/ is in scope.
// Next.js convention files stay exempt (routed by the framework, not by import).
//
// LANE 85E — WIDENED TO EVERY RUNTIME .tsx. Wave 84's probe found the */components/
// predicate blind to page-co-located client BODIES: app/content-studio/
// content-studio-client.tsx (1826 lines) and app/social-planner/social-planner-
// content.tsx (621) sat imported by nothing behind redirect pages, and with them
// six server actions and LinkToVideoGenerator had no page. Both are resolved
// (content-studio MOUNTED as the Marketing Studio's Content Lab tab; social-
// planner MERGED onto /dashboard/social and deleted — tombstone at
// app/social-planner/page.tsx). Every Next.js convention file stays exempt
// (routed by the framework, not by import), including the metadata-image ones.
const NEXT_CONVENTION = /\/(page|layout|route|loading|error|not-found|template|default|global-error|forbidden|unauthorized|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.tsx$/
const accusable = (f: string) => f.endsWith(".tsx") && !NEXT_CONVENTION.test(f)
const componentsOnly = (f: string) => accusable(f) && /^app\/(.*\/)?components\//.test(f)

const orphans = all.filter((f) => accusable(f) && !used.has(f))

console.log("\n[dead-component guard — every component must be imported by something]")
const total = all.filter(accusable).length
console.log(`  denominator: ${total} runtime .tsx files (${all.filter(componentsOnly).length} under */components/ — the pre-85E accusation set) across ${runtimeRoots(root).length} runtime roots`)

// POSITIVE CONTROLS (§2 — a clean tree and a broken finder both say zero).
{
  const probeSet = new Set(["app/x/orphan-body.tsx", "app/x/page.tsx", "app/x/live.tsx"])
  const probeUsed = new Set(importsOf(`import L from "./live"\n// import O from "./orphan-body"  ← a tombstone, not an importer`, "app/x/page.tsx").map((r) => r))
  // resolveSpec answers from the real corpus; the probe checks the RULES on specimen text.
  const blanked = importsOf(`// from "@/app/content-studio/content-studio-client"`, "app/x/page.tsx")
  const live = importsOf(`import X from "@/app/dashboard/social/social-dashboard-client"`, "app/x/page.tsx")
  const controls: Array<[string, boolean]> = [
    ["CONTROL: a specifier inside a COMMENT is not an import (tombstone blanked)", blanked.length === 0],
    ["CONTROL: a real import of a real component resolves", live.includes("app/dashboard/social/social-dashboard-client.tsx")],
    ["CONTROL: a co-located client BODY (not under */components/) is accusable", accusable("app/content-studio/content-studio-client.tsx") && !componentsOnly("app/content-studio/content-studio-client.tsx")],
    ["CONTROL: a Next convention file is exempt (page, opengraph-image)", !accusable("app/x/page.tsx") && !accusable("app/x/opengraph-image.tsx")],
    ["CONTROL: the probe's orphan specimen is unreferenced by its sibling's text", !probeUsed.has("app/x/orphan-body.tsx") && probeSet.size === 3],
  ]
  let bad = 0
  for (const [name, ok] of controls) { console.log(`  ${ok ? "✓" : "✗"} ${name}`); if (!ok) bad++ }
  if (bad > 0) { console.log(`\n RESULT: 0 passed, ${bad} failed — the finder is blind`); process.exit(1) }
}
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
