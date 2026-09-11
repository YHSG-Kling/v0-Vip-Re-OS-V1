#!/usr/bin/env tsx
/**
 * scripts/anchor-census.ts   (npm run test:anchor-census — NOT YET REGISTERED,
 * see the wave-56 report that shipped this file for the exact package.json /
 * guard-chain / MAINTENANCE_DOMAINS lines an integrator must add)
 * ─────────────────────────────────────────────────────────────────────────────
 * DANGLING IN-PAGE ANCHORS.
 *
 * scripts/dangling-link-sweep.ts explicitly excludes `#anchor` fragments
 * (isScannablePath: "EXTERNAL and non-path refs: … #anchor … — not routes").
 * That sweep is right to skip them — a fragment is not a route — but nothing
 * else ever checked THIS half: does the target page actually carry an element
 * with `id="frag"` for a link written as `href="/path#frag"` or, within one
 * page, `<a href="#frag">`? A stale fragment is invisible to every route-level
 * guard: the route resolves, the page renders, and the browser just fails to
 * scroll — the softest possible 404, wearing no error at all.
 *
 * SCOPE. Two reference shapes, comment-stripped source only (§2):
 *   · `href="/some/path#frag"` (or backtick-template with no `${`) — the
 *     fragment must exist as an `id="frag"` ANYWHERE in the page tree rooted
 *     at that path's page.tsx (its own file plus every component it pulls in
 *     is out of reach for a grep-only census, so the search widens to: any
 *     .tsx file that is itself reachable from that route's page.tsx by a
 *     relative or aliased import, transitively). A same-page `href="#frag"`
 *     checks only the file it appears in and files it imports.
 *   · `id="frag"` / `id={"frag"}` literal declarations across app/ and lib/
 *     components are the target inventory.
 *
 * EXCLUDED, same reasons dangling-link-sweep gives: template interpolations
 * (`${…}` in the fragment position — not statically resolvable), external
 * URLs, and any `href` whose PATH half (before `#`) is itself excluded by
 * dangling-link-sweep's own isScannablePath (that sweep already accuses a
 * dangling path; this one only judges the fragment once the path is real).
 *
 * BLIND SPOTS, published beside the count:
 *   · An `id` assigned via a spread prop, a computed template, or set by a
 *     third-party component (e.g. a UI-kit accordion that stamps its own id)
 *     is invisible — this is a grep census, not a DOM walk. Under-accusing.
 *   · Cross-page anchors are resolved by IMPORT REACHABILITY from the target
 *     page.tsx, not by runtime conditional rendering — an id that exists only
 *     behind a condition the census cannot evaluate still counts as present.
 *     Under-accusing, which is the safe direction for an accusation list.
 *
 * Report-only, no baseline: `--list` prints every finding and exits 0. This is
 * a small, fast corpus (anchors are rare) so no baseline-burn-down machinery.
 */
import { readFileSync } from "node:fs"
import { join, dirname, relative, resolve as pathResolve, sep } from "node:path"
import { walkTs } from "./runtime-roots"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const rel = (f: string) => relative(ROOT, f).split(sep).join("/")

type HrefRef = { file: string; line: number; fragPath: string | null; frag: string }
type IdDecl = { file: string; id: string }

const HREF_RE = [
  /\bhref\s*=\s*"([^"$]*)#([A-Za-z0-9_-]+)"/g,
  /\bhref\s*:\s*"([^"$]*)#([A-Za-z0-9_-]+)"/g,
  /\bhref\s*=\s*\{\s*`([^`$]*)#([A-Za-z0-9_-]+)`\s*\}/g,
  /\bhref\s*:\s*`([^`$]*)#([A-Za-z0-9_-]+)`/g,
]
const ID_RE = [
  /\bid\s*=\s*"([A-Za-z][A-Za-z0-9_-]*)"/g,
  /\bid\s*=\s*\{\s*"([A-Za-z][A-Za-z0-9_-]*)"\s*\}/g,
]

function lineOf(src: string, idx: number): number {
  let n = 1
  for (let i = 0; i < idx; i++) if (src[i] === "\n") n++
  return n
}

function routeFromPage(r: string): string | null {
  if (!r.startsWith("app/") || !r.endsWith("/page.tsx")) return null
  const inner = r.slice("app/".length, r.length - "/page.tsx".length)
  const segs = inner.split("/").filter((s) => s && !(s.startsWith("(") && s.endsWith(")")))
  return "/" + segs.join("/")
}

/** Local import specifiers this file pulls in (relative or @/ aliased), resolved to a real .tsx/.ts file if possible. */
function localImportsOf(file: string, src: string): string[] {
  const out: string[] = []
  const re = /\bfrom\s+["']([^"']+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const spec = m[1]
    if (!spec.startsWith(".") && !spec.startsWith("@/")) continue
    const base = spec.startsWith("@/") ? join(ROOT, spec.slice(2)) : pathResolve(dirname(file), spec)
    for (const cand of [base + ".tsx", base + ".ts", join(base, "index.tsx"), join(base, "index.ts")]) {
      out.push(cand)
    }
  }
  return out
}

function main() {
  const files = [...walkTs(join(ROOT, "app")), ...walkTs(join(ROOT, "lib"))]
  const srcByFile = new Map<string, string>()
  for (const f of files) {
    try { srcByFile.set(f, stripComments(readFileSync(f, "utf8"))) } catch { /* unreadable, skip */ }
  }

  // Inventory: every declared id, keyed by file.
  const idsByFile = new Map<string, Set<string>>()
  let totalIds = 0
  for (const [f, src] of srcByFile) {
    const set = new Set<string>()
    for (const re of ID_RE) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) { set.add(m[1]); totalIds++ }
    }
    if (set.size) idsByFile.set(f, set)
  }

  // Route table: page path -> page.tsx file.
  const routeFiles = new Map<string, string>()
  for (const f of srcByFile.keys()) {
    const route = routeFromPage(rel(f))
    if (route) routeFiles.set(route, f)
  }

  // Reachability memo: for a page.tsx, the transitive set of files reachable by local import (bounded depth).
  const reachMemo = new Map<string, Set<string>>()
  function reachableFrom(entry: string): Set<string> {
    if (reachMemo.has(entry)) return reachMemo.get(entry)!
    const seen = new Set<string>()
    const stack = [entry]
    let guard = 0
    while (stack.length && guard++ < 4000) {
      const f = stack.pop()!
      if (seen.has(f)) continue
      seen.add(f)
      const src = srcByFile.get(f)
      if (!src) continue
      for (const cand of localImportsOf(f, src)) {
        if (srcByFile.has(cand) && !seen.has(cand)) stack.push(cand)
      }
    }
    reachMemo.set(entry, seen)
    return seen
  }

  const refs: HrefRef[] = []
  for (const [f, src] of srcByFile) {
    for (const re of HREF_RE) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        const pathPart = m[1]
        if (pathPart.includes("${")) continue // template interpolation — not statically resolvable
        refs.push({ file: f, line: lineOf(src, m.index), fragPath: pathPart || null, frag: m[2] })
      }
    }
  }

  // Reverse index: which page.tsx entries' closures contain a given file?
  // A same-page `href="#frag"` written inside a CHILD component must be
  // checked against the id inventory of the PAGE(S) that render it — not
  // against that child's own (typically empty) import closure. The first cut
  // of this census got this backwards and produced 7 false positives on
  // app/dashboard/compliance, whose ids live in page.tsx while the links live
  // in child command-strip/panel components page.tsx renders.
  const pagesContaining = new Map<string, Set<string>>()
  for (const pageFile of routeFiles.values()) {
    for (const f of reachableFrom(pageFile)) {
      if (!pagesContaining.has(f)) pagesContaining.set(f, new Set())
      pagesContaining.get(f)!.add(pageFile)
    }
  }

  const findings: string[] = []
  const unverifiable: string[] = []
  for (const r of refs) {
    let idSet: Set<string>
    if (!r.fragPath) {
      // same-page anchor: union of ids across every page whose render tree
      // contains this file (covers both "id is in an ancestor page.tsx" and
      // "id is in a sibling component the same page also renders").
      const owningPages = pagesContaining.get(r.file)
      if (!owningPages || owningPages.size === 0) {
        // Not reachable from any page.tsx by static import (e.g. mounted via
        // a registry/dynamic pattern this census can't see) — cannot verify
        // either way; report separately rather than falsely accuse (§2).
        unverifiable.push(`${rel(r.file)}:${r.line}  href="#${r.frag}" — this file is not statically reachable from any page.tsx, so the target page can't be determined`)
        continue
      }
      idSet = new Set<string>()
      for (const page of owningPages) {
        for (const f of reachableFrom(page)) {
          for (const id of idsByFile.get(f) ?? []) idSet.add(id)
        }
      }
    } else {
      const pageFile = routeFiles.get(r.fragPath)
      if (!pageFile) {
        // target route not found by this census — dangling-link-sweep owns
        // path existence; skip so this census never double-accuses a path.
        continue
      }
      idSet = new Set<string>()
      for (const f of reachableFrom(pageFile)) {
        for (const id of idsByFile.get(f) ?? []) idSet.add(id)
      }
    }
    if (!idSet.has(r.frag)) {
      findings.push(`${rel(r.file)}:${r.line}  href="${r.fragPath ?? ""}#${r.frag}" — no id="${r.frag}" found${r.fragPath ? ` reachable from ${r.fragPath}'s page tree` : " in this page's own tree"}`)
    }
  }

  // ── positive control (§2): a synthetic dangling anchor must be caught ──
  {
    const synthSrc = 'export const X = () => <a href="/dashboard/does-not-exist-anywhere#totally-fake-frag-xyz">go</a>'
    const stripped = stripComments(synthSrc)
    let caught = false
    for (const re of HREF_RE) {
      re.lastIndex = 0
      const m = re.exec(stripped)
      if (m && m[2] === "totally-fake-frag-xyz") caught = true
    }
    if (!caught) {
      console.log("❌ ANCHOR_CENSUS_SELFTEST_FAIL — the regex that is supposed to catch a fragment ref caught nothing; this scanner cannot be trusted")
      process.exit(1)
    }
  }

  console.log("══════════════════════════════════════════════════")
  console.log(" ANCHOR CENSUS — href=\"…#frag\" targets with no matching id")
  console.log("══════════════════════════════════════════════════")
  console.log(` ${srcByFile.size} files scanned · ${totalIds} id declarations · ${refs.length} fragment refs checked`)
  console.log(` dangling anchors: ${findings.length} · unverifiable (not reachable from any page.tsx): ${unverifiable.length}`)
  for (const f of findings) console.log("  ✗ " + f)
  if (unverifiable.length) {
    console.log(" unverifiable:")
    for (const f of unverifiable) console.log("  ? " + f)
  }

  if (process.argv.includes("--list")) {
    console.log("\n(--list mode: exit 0)")
    process.exit(0)
  }
  if (findings.length > 0) {
    console.log("\n❌ ANCHOR_CENSUS_FAIL — dangling anchor(s) found, fix the id or the href")
    process.exit(1)
  }
  console.log("\n✅ ANCHOR_CENSUS_PASS")
}

main()
