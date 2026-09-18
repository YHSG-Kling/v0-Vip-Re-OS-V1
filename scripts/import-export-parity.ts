#!/usr/bin/env tsx
/**
 * scripts/import-export-parity.ts   (npm run test:import-export-parity —
 * NOT YET REGISTERED, see the wave-56 report that shipped this file for the
 * exact package.json / guard-chain / MAINTENANCE_DOMAINS lines an integrator
 * must add)
 * ─────────────────────────────────────────────────────────────────────────────
 * A NAMED IMPORT WHOSE TARGET MODULE DOES NOT EXPORT THAT NAME.
 *
 * `tsc` would catch this (TS2305/TS2724) but a full `tsc --noEmit` OOMs this
 * repo (CLAUDE.md §7) and is forbidden inside a lane anyway. Two drift shapes
 * get through review without it, both compile-safe TODAY for reasons that
 * stop being true the moment someone refactors the target file:
 *
 *   1. A named import (`import { X } from "./y"`) where `./y` no longer
 *      exports `X` — the rename/removal happened in the target file and the
 *      importer was never updated. This is compile-safe RIGHT NOW only if the
 *      importer's own file also never TYPE-CHECKS that binding strictly (a
 *      `.js`-shaped consumer, a build config that skips the file, or the
 *      import sits unused per dead-import-census and the compiler never
 *      forces resolution) — in every other case `tsc` already refuses this
 *      build, which is exactly why running one on every changed file matters
 *      more than trusting this census alone (LANE_RULES verify step).
 *   2. A barrel's own EXPLICIT re-export (`export { X } from "./y"`) naming
 *      an `X` that `./y` no longer exports. `export * from` wildcards are
 *      NOT this shape — a wildcard names no individual identifier, so there
 *      is nothing for THIS check to accuse; a wildcard's OWN correctness is
 *      "does the target module exist" (mechanically true if module resolution
 *      succeeded at all) and is out of scope here.
 *
 * ── SCOPE (§2) ───────────────────────────────────────────────────────────
 * app/ and lib/ .ts/.tsx files, comment-stripped (`stripComments`) so a
 * tombstone naming an old export is never mistaken for a live one. LOCAL
 * specifiers only (`./…`, `../…`, `@/…`) — node_modules packages are not
 * resolved (their own .d.ts is the authority and tsc already owns that
 * surface; a blind spot, published, not silently assumed clean).
 *
 * EXPORT-SET RESOLUTION per file: `export const/function/async function/
 * class/interface/type/enum X`, bare `export { A, B as C }` OR
 * `export type { A, B as C }` (of a LOCALLY declared name — the `type`
 * keyword between `export` and `{` is optional and matched either way;
 * missing this was this file's own first-cut bug, see below), `export { A
 * as B } from "./z"` / `export type { A as B } from "./z"` (re-export — B is
 * exported here IF A resolves in z, checked transitively), `export * from
 * "./z"` (wildcard — every name z exports is exported here too, followed
 * transitively, depth-capped at 8 with cycle guard), `export default …`
 * (folded into the resolved set under the literal name `"default"` so
 * `export { default } from "./z"` can resolve it — a bare `export default
 * Foo` names no declaration keyword, so only the separate `hasDefault` scan
 * sees it at all).
 *
 * TWO DEFECTS THIS FILE FOUND IN ITSELF BEFORE SHIPPING, RECORDED SO THEY ARE
 * NOT RE-INTRODUCED:
 *   1. The cycle-guard (`path`) was originally one mutable Set threaded
 *      through every recursive call, including SIBLING name lookups inside
 *      the same `export { a, b, c } from "./z"` clause. Resolving `a`
 *      against `./z` marked `./z` "seen"; resolving `b` right after, against
 *      the SAME target, then hit the cycle guard and got an artificially
 *      EMPTY set — so only the first name in any multi-name re-export clause
 *      ever resolved, and everything after it in that clause read as
 *      missing. First full run: 114 false "missing import" findings, every
 *      one a real, live export. Fixed by memoizing per-file (compute once,
 *      cache forever) and using a fresh `[...path, f]` array per branch
 *      instead of one shared mutated object — a positive control below
 *      (`siblingNamesAllResolve`) pins this so it cannot silently return.
 *   2. `export type { … }` / `export type { … } from "…"` were invisible —
 *      the brace-matching regexes required `export` to be followed
 *      immediately by `{` (only whitespace between), and `type` is not
 *      whitespace. Every TYPE-ONLY barrel re-export in the repo (roles,
 *      compliance verdicts, buyer-lifecycle state, …) was reading as "not
 *      exported" downstream. Fixed by making the `type` keyword optional in
 *      the brace-clause regexes.
 * Both defects are why a report claiming a huge number found by a brand-new
 * scanner deserves a second look BEFORE it is handed to anyone as real
 * findings (CLAUDE.md §2: a broken regex and a clean tree both look alike
 * until proven otherwise) — the corrected, self-tested result is 0/0.
 *
 * BLIND SPOTS, published beside the count:
 *   · node_modules / non-local specifiers: NOT resolved (tsc's job).
 *   · `export * as ns from "./z"` (namespace re-export): the namespace
 *     itself is recorded as available; individual names inside it are not
 *     traced further (a `{ ns }` import is fine, `{ someNameInsideZ }`
 *     resolved only through a PLAIN `export *`, not a namespaced one).
 *   · Declaration merging / ambient global augmentation (`declare global`,
 *     module augmentation) is not modeled — a name that exists only via
 *     augmentation reads as missing. Under-accusing is not the risk here
 *     (an OVER-accusation would be the wrong-direction failure), so this is
 *     published rather than guessed around; any hit here should be hand-
 *     verified before treated as a real defect (§1 — build/fix, don't delete
 *     blind).
 *   · A specifier whose extension-probe finds BOTH `x.ts` and `x/index.ts`
 *     picks the first candidate in the probe order below — matches how
 *     bundler moduleResolution actually behaves for this repo's tsconfig.
 *   · Interface MERGING (the same interface name declared twice, exports
 *     accumulating) is not modeled — each `export interface X` overwrites
 *     the prior sighting in this census's map, which is always at least as
 *     permissive as reality (the name still resolves either way).
 *
 * Report-only, no baseline: `--list` prints every finding and exits 0.
 */
import { readFileSync, existsSync, statSync } from "node:fs"
import { join, dirname, relative, resolve as pathResolve, sep } from "node:path"
import { walkTs } from "./runtime-roots"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const rel = (f: string) => relative(ROOT, f).split(sep).join("/")

function resolveSpecifier(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".") && !spec.startsWith("@/")) return null
  const base = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : pathResolve(dirname(fromFile), spec)
  const candidates = [base, base + ".ts", base + ".tsx", join(base, "index.ts"), join(base, "index.tsx")]
  for (const c of candidates) {
    try { if (existsSync(c) && statSync(c).isFile()) return c } catch { /* ignore */ }
  }
  return null
}

type ExportInfo = {
  named: Set<string>            // locally-resolved named exports (final names)
  hasDefault: boolean
  wildcardFrom: string[]        // unresolved specifiers of `export * from` for transitive follow
  reExportFrom: { name: string; from: string }[] // `export { A as name } from spec` pending resolution
}

const fileCache = new Map<string, string>()
function readStripped(f: string): string {
  let c = fileCache.get(f)
  if (c !== undefined) return c
  try { c = stripComments(readFileSync(f, "utf8")) } catch { c = "" }
  fileCache.set(f, c)
  return c
}

function parseExports(f: string): ExportInfo {
  const src = readStripped(f)
  const info: ExportInfo = { named: new Set(), hasDefault: false, wildcardFrom: [], reExportFrom: [] }

  // export const/function/async function/class/interface/type/enum X
  const declRe = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g
  let m: RegExpExecArray | null
  while ((m = declRe.exec(src))) info.named.add(m[1])

  // export default (function/class/expr) — flag only
  if (/\bexport\s+default\b/.test(src)) info.hasDefault = true

  // export { A, B as C }  (bare, no `from`)  vs  export { A as B } from "./z"
  const braceRe = /\bexport\s*(?:type\s+)?\{([^}]*)\}\s*(?:from\s*["']([^"']+)["'])?/g
  while ((m = braceRe.exec(src))) {
    const clause = m[1]
    const from = m[2]
    const parts = clause.split(",").map((s) => s.trim()).filter(Boolean)
    for (const p of parts) {
      const pm = /^(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:as\s+([A-Za-z_$][\w$]*))?$/.exec(p)
      if (!pm) continue
      const local = pm[1]
      const exported = pm[2] ?? pm[1]
      if (from) info.reExportFrom.push({ name: exported === local ? local : local, from })
      else info.named.add(exported)
    }
  }
  // record the exported alias for re-exports (need both local-in-source-module name and exported name)
  // redo re-export parsing to keep BOTH names distinctly (local name to look up in `from`, exported name to expose here)
  info.reExportFrom = []
  const braceFromRe = /\bexport\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
  while ((m = braceFromRe.exec(src))) {
    const clause = m[1]
    const from = m[2]
    for (const p of clause.split(",").map((s) => s.trim()).filter(Boolean)) {
      const pm = /^(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:as\s+([A-Za-z_$][\w$]*))?$/.exec(p)
      if (!pm) continue
      info.reExportFrom.push({ name: pm[1], from }) // pm[1] is the name to look up IN the target
      // the EXPORTED alias here is pm[2] ?? pm[1] — resolved into info.named once we know pm[1] exists (see resolver)
    }
  }

  // export * from "./z"
  const starRe = /\bexport\s*\*\s*from\s*["']([^"']+)["']/g
  while ((m = starRe.exec(src))) info.wildcardFrom.push(m[1])

  return info
}

const resolvedExportsCache = new Map<string, Set<string>>()
/**
 * Full resolved export-name set for a file, following `export *` and
 * `export {x as y} from` transitively. Memoized PER FILE (not per depth) —
 * an earlier bug shared one mutable `seen` Set across every SIBLING name
 * lookup within the same `export { a, b, c } from` clause: the guard meant
 * to stop actual import CYCLES instead marked a target file "seen" after
 * resolving its FIRST name, so every subsequent name in the same clause hit
 * the cycle guard and resolved against an artificially empty set — silently
 * turning `toCanonicalRoleOrDefault`, `toCanonicalRoles`, `isCanonicalRole`
 * and 90+ other real, live exports into false "not exported" accusations
 * before this file shipped. `resolvedExportsCache` now memoizes the real
 * result for every file exactly once, and `path` (a fresh array per
 * recursive branch, not a shared mutated object) detects only genuine
 * A→B→A cycles, never a legitimate repeat visit from a sibling name.
 */
function resolvedExportSet(f: string, path: string[] = []): Set<string> {
  const cached = resolvedExportsCache.get(f)
  if (cached) return cached
  if (path.length > 8 || path.includes(f)) return new Set() // genuine cycle/depth guard

  const info = parseExports(f)
  const out = new Set(info.named)
  if (info.hasDefault) out.add("default") // `export default <expr>` (no decl keyword, e.g. `export default Foo`) sets the flag but named nothing — fold it in so `export { default } from "./x"` can resolve
  const nextPath = [...path, f]

  for (const spec of info.wildcardFrom) {
    const target = resolveSpecifier(f, spec)
    if (!target) continue // external/unresolvable — blind spot, published
    const sub = resolvedExportSet(target, nextPath)
    for (const n of sub) out.add(n)
  }
  // re-parse braceFromRe originals to recover BOTH local+exported names (parseExports only kept lookup name)
  const src = readStripped(f)
  const braceFromRe = /\bexport\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = braceFromRe.exec(src))) {
    const clause = m[1]
    const from = m[2]
    const target = resolveSpecifier(f, from)
    for (const p of clause.split(",").map((s) => s.trim()).filter(Boolean)) {
      const pm = /^(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:as\s+([A-Za-z_$][\w$]*))?$/.exec(p)
      if (!pm) continue
      const lookupName = pm[1]
      const exposedName = pm[2] ?? pm[1]
      if (!target) { out.add(exposedName); continue } // unresolved target — cannot disprove, don't accuse
      const sub = resolvedExportSet(target, nextPath)
      if (sub.has(lookupName)) out.add(exposedName)
      // else: genuinely a barrel re-exporting a name that no longer exists — NOT added, becomes a finding via the barrel scan below
    }
  }

  resolvedExportsCache.set(f, out)
  return out
}

function lineOf(src: string, idx: number): number {
  let n = 1
  for (let i = 0; i < idx; i++) if (src[i] === "\n") n++
  return n
}

function main() {
  const files = [...walkTs(join(ROOT, "app")), ...walkTs(join(ROOT, "lib"))]
  let importSitesChecked = 0
  let externalSkipped = 0
  const missingImportFindings: string[] = []
  const missingReExportFindings: string[] = []

  for (const f of files) {
    const src = readStripped(f)
    // import { A, B as C } from "spec"   (type-only clauses included)
    const importRe = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
    let m: RegExpExecArray | null
    while ((m = importRe.exec(src))) {
      const clause = m[1]
      const spec = m[2]
      if (!spec.startsWith(".") && !spec.startsWith("@/")) { externalSkipped++; continue }
      const target = resolveSpecifier(f, spec)
      if (!target) continue // unresolved local path — orphan-export-guard's C5 owns that, not this census
      const exportSet = resolvedExportSet(target)
      for (const p of clause.split(",").map((s) => s.trim()).filter(Boolean)) {
        importSitesChecked++
        const pm = /^type\s+([A-Za-z_$][\w$]*)|^([A-Za-z_$][\w$]*)/.exec(p)
        if (!pm) continue
        const importedName = pm[1] ?? pm[2]
        if (importedName === "default") continue
        if (!exportSet.has(importedName)) {
          missingImportFindings.push(`${rel(f)}:${lineOf(src, m.index)}  import { ${importedName} } from "${spec}" — ${rel(target)} does not export ${importedName}`)
        }
      }
    }
  }

  // Barrel drift: `export { A } from "./z"` where z no longer has A.
  for (const f of files) {
    const src = readStripped(f)
    const braceFromRe = /\bexport\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
    let m: RegExpExecArray | null
    while ((m = braceFromRe.exec(src))) {
      const clause = m[1]
      const from = m[2]
      const target = resolveSpecifier(f, from)
      if (!target) continue
      const targetExports = resolvedExportSet(target)
      for (const p of clause.split(",").map((s) => s.trim()).filter(Boolean)) {
        const pm = /^(?:type\s+)?([A-Za-z_$][\w$]*)/.exec(p)
        if (!pm) continue
        const lookupName = pm[1]
        if (!targetExports.has(lookupName)) {
          missingReExportFindings.push(`${rel(f)}:${lineOf(src, m.index)}  export { ${lookupName} } from "${from}" — ${rel(target)} does not export ${lookupName}`)
        }
      }
    }
  }

  // ── positive controls (§2): a synthetic drifted import/re-export must be
  //    caught, AND every name in a multi-name `export {a,b,c} from` clause
  //    must resolve independently — the exact regression this file's own
  //    header records (a shared mutable cycle-guard previously made every
  //    name AFTER THE FIRST in such a clause resolve as missing) ──
  {
    const scratchTarget = join(ROOT, "scripts", "__ieparity_selftest_target__.ts")
    fileCache.set(scratchTarget, stripComments('export const Real = 1\n'))
    const exportSet = resolvedExportSet(scratchTarget)
    const caughtDrift = !exportSet.has("NotReal") && exportSet.has("Real")

    const scratchBase = join(ROOT, "scripts", "__ieparity_selftest_base__.ts")
    const scratchBarrel = join(ROOT, "scripts", "__ieparity_selftest_barrel__.ts")
    fileCache.set(scratchBase, stripComments("export const A = 1\nexport const B = 2\nexport const C = 3\n"))
    fileCache.set(scratchBarrel, stripComments('export { A, B, C } from "./__ieparity_selftest_base__"\n'))
    const barrelSet = resolvedExportSet(scratchBarrel)
    const siblingNamesAllResolve = barrelSet.has("A") && barrelSet.has("B") && barrelSet.has("C")

    if (!caughtDrift || !siblingNamesAllResolve) {
      console.log(`❌ IMPORT_EXPORT_PARITY_SELFTEST_FAIL — caughtDrift=${caughtDrift} siblingNamesAllResolve=${siblingNamesAllResolve} (barrelSet=${[...barrelSet].join(",")}); do not trust the count below`)
      process.exit(1)
    }
  }

  console.log("══════════════════════════════════════════════════")
  console.log(" IMPORT/EXPORT PARITY CENSUS — named import or re-export naming something its target does not export")
  console.log("══════════════════════════════════════════════════")
  console.log(` ${files.length} files scanned · ${importSitesChecked} local named-import bindings checked · ${externalSkipped} external-package import clauses skipped (tsc's job, not resolved here)`)
  console.log(` missing import bindings: ${missingImportFindings.length}`)
  for (const f2 of missingImportFindings) console.log("  ✗ " + f2)
  console.log(` missing barrel re-exports: ${missingReExportFindings.length}`)
  for (const f2 of missingReExportFindings) console.log("  ✗ " + f2)

  const total = missingImportFindings.length + missingReExportFindings.length
  if (process.argv.includes("--list")) {
    console.log("\n(--list mode: exit 0)")
    process.exit(0)
  }
  if (total > 0) {
    console.log("\n❌ IMPORT_EXPORT_PARITY_FAIL")
    process.exit(1)
  }
  console.log("\n✅ IMPORT_EXPORT_PARITY_PASS")
}

main()
