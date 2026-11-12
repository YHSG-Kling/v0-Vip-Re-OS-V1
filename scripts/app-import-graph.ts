/**
 * scripts/app-import-graph.ts — THE ONE first-party import-graph walker (wave 148, lane 148A).
 *
 * Moved VERBATIM out of scripts/proxy-graph-budget-guard.ts (which now imports it) so a second
 * reader — scripts/release-blockers-guard.ts, measuring the two halves of the lever-(d) compile
 * matrix in .github/workflows/build.yml — judges the graph with the SAME code the proxy/app budget
 * has been calibrated on since wave 100D/105F. CLAUDE.md §1: one survivor, never a second walker.
 *
 * WHAT IT WALKS: every FIRST-PARTY module reachable from an entry through STATIC imports/exports AND
 * dynamic import()/require() (webpack bundles both), read from COMMENT-BLANKED source
 * (scripts/strip-comments.ts blankComments — CLAUDE.md §2: a tombstone naming an import is not an
 * import). `import type` / `export type` and an all-`type` brace list are erased by the compiler and
 * not followed. Resolution: relative paths, `@/components/*` → app/components (then the root), `@/*`
 * → the root, with the .ts/.tsx/.js/.jsx/.mjs/.cjs/.json and index.* candidates. Packages are not
 * counted. BLIND SPOTS: computed specifiers, package `exports` re-exports and tsconfig paths other
 * than `@/*` / `@/components/*` are invisible — a first-party LOWER BOUND, not webpack's module count.
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { blankComments } from "./strip-comments"

const EXT = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]
export function tryFile(p: string): string | null {
  if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  for (const e of EXT) if (fs.existsSync(p + e)) return p + e
  for (const e of EXT) if (fs.existsSync(path.join(p, "index" + e))) return path.join(p, "index" + e)
  return null
}

/** The first-party import graph of one tree. */
export function makeWalker(root: string) {
  function resolve(spec: string, from: string): string | null {
    if (spec.startsWith("./") || spec.startsWith("../")) return tryFile(path.resolve(path.dirname(from), spec))
    if (spec.startsWith("@/components/")) return tryFile(path.join(root, "app/components", spec.slice(13))) ?? tryFile(path.join(root, spec.slice(2)))
    if (spec.startsWith("@/")) return tryFile(path.join(root, spec.slice(2)))
    return null
  }
  const cache = new Map<string, string[]>()
  function edges(file: string): string[] {
    const hit = cache.get(file); if (hit) return hit
    const src = file.endsWith(".json") ? "" : blankComments(fs.readFileSync(file, "utf8"))
    const out: string[] = []
    const reStatic = /(?:^|[;\n}])\s*(import|export)\s+(type\s+)?([^'"`;]*?\bfrom\s*)?["']([^"']+)["']/g
    let m: RegExpExecArray | null
    while ((m = reStatic.exec(src))) {
      if (m[2]) continue
      // Anchored at ^ (wave 105F): `import Default, { type A } from "x"` is a VALUE import and must be
      // followed; unanchored, the brace test alone skipped it and the app union read 6 modules short
      // of the lane100D measurement tool that the proxy numbers were calibrated against.
      if (m[3] && /^\{[^}]*\}\s*from\s*$/.test(m[3].trim())) {
        const inner = m[3].slice(m[3].indexOf("{") + 1, m[3].lastIndexOf("}"))
        const parts = inner.split(",").map((s) => s.trim()).filter(Boolean)
        if (parts.length && parts.every((p) => p.startsWith("type "))) continue
      }
      const r = resolve(m[4], file); if (r) out.push(r)
    }
    const reDyn = /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g
    while ((m = reDyn.exec(src))) { const r = resolve(m[1], file); if (r) out.push(r) }
    cache.set(file, out)
    return out
  }
  function reach(entry: string): { seen: Set<string>; parent: Map<string, string> } {
    const seen = new Set<string>([entry]); const parent = new Map<string, string>(); const q = [entry]
    while (q.length) {
      const f = q.pop()!
      for (const t of edges(f)) if (!seen.has(t)) { seen.add(t); parent.set(t, f); q.push(t) }
    }
    return { seen, parent }
  }
  return { reach, rel: (p: string) => path.relative(root, p) }
}

/** The special file names Next turns into app/ entries or loader-tree segments. */
export const APP_ENTRY_FILE = /^(page|layout|route|template|loading|error|not-found|default|global-error)\.(tsx?|jsx?)$/

/** Every webpack entry under app/ — the file names Next turns into routes. */
export function appEntries(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === "node_modules" || d.name.startsWith(".")) continue
      const p = path.join(dir, d.name)
      if (d.isDirectory()) walk(p)
      else if (APP_ENTRY_FILE.test(d.name)) out.push(p)
    }
  }
  walk(path.join(root, "app"))
  return out
}
