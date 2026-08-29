#!/usr/bin/env tsx
/**
 * scripts/dangling-link-sweep.ts   (npm run test:dangling-links)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OTHER DIRECTION. scripts/orphan-route-sweep.ts asks "which ROUTES does
 * nothing link to" and reports 0. Nothing asked the inverse — "which LINKS
 * point at no route" — for PAGE routes. opposite-missing has it for /api/**
 * only (category 6a: fetch("/api/…") with no route file).
 *
 * WHAT THAT BLIND SPOT COST. `/crm/contacts` had no page.tsx and FOURTEEN
 * in-tree sites addressed it, two of them reachable only when something had
 * already failed: the contact page's error-boundary RECOVERY button, and the
 * redirect for a contact that could not be resolved. So the recovery from one
 * failure was a 404. Both sweeps were green the whole time, because each was
 * asking the question the other answered.
 *
 * ── WHAT IS SCANNED (the denominator, §2) ───────────────────────────────────
 * Runtime roots (scripts/runtime-roots.ts), COMMENT-STRIPPED (§2 — a path in a
 * tombstone is not a link). Reference forms: href="…", router.push/replace(…),
 * redirect(…), revalidatePath(…), and `href: "…"` object keys — LITERALS ONLY.
 *
 * THE DENOMINATOR OF *ROUTES* is every app/**\/page.tsx AND every non-api
 * app/**\/route.ts (see routeFromPage). Route handlers were missing from it
 * until 2026-08-29, so the sweep listed /dashboard/superadmin/usage-reports/
 * export — a CSV download that has always worked — as a dangling link.
 *
 * ── WHAT IS EXCLUDED, AND WHY (published beside the count, §2) ──────────────
 *  · TEMPLATE LITERALS and any path holding `${…}`: not statically resolvable.
 *    Guessing would manufacture false accusations, which is the failure this
 *    guard exists to avoid — its sibling's header records exactly that lesson.
 *  · EXTERNAL and non-path refs: http(s)://, mailto:, tel:, //host, #anchor,
 *    "?query-only", and "" — not routes.
 *  · FILE PATHS: any last segment containing a "." (e.g. /logo.png, /og.jpg) —
 *    these are public/ assets, not routes.
 *  · /api/** — already covered by opposite-missing categories 6a/6b, and
 *    double-reporting one finding in two guards makes both harder to trust.
 *  · NEXT CONFIG REDIRECTS: next.config.ts redirects() sources are real
 *    reachability (e.g. /contacts → /crm), so a link to one is not dangling.
 *  · Paths that match a route with a DYNAMIC or CATCH-ALL segment.
 *
 * Report-only with a committed baseline, like its siblings: NEW dangling links
 * fail; the existing list is a burn-down.
 *
 * Tighten: DANGLING_LINK_BASELINE=1 npx tsx scripts/dangling-link-sweep.ts
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const BASELINE = join(ROOT, "scripts/dangling-link-baseline.json")
const rel = (f: string) => f.slice(ROOT.length + 1)

/**
 * app/(group)/x/[id]/page.tsx → /x/[id]   (route groups vanish; api skipped)
 *
 * ROUTE HANDLERS COUNT TOO. A `route.ts` outside app/api serves a real URL —
 * app/dashboard/superadmin/usage-reports/export/route.ts is the CSV download
 * behind that page's "Download CSV" link. Counting only page.tsx made this
 * guard accuse a LIVE route of not existing (§2: a guard that cannot see the
 * code it judges). Four such handlers exist in the tree today: /auth/callback,
 * /auth/logout, /dashboard/superadmin/usage-reports/export and /llms.txt.
 */
function routeFromPage(r: string): string | null {
  if (!r.startsWith("app/")) return null
  const suffix = r.endsWith("/page.tsx") ? "/page.tsx" : r.endsWith("/route.ts") ? "/route.ts" : null
  if (!suffix) return null
  const inner = r.slice("app/".length, r.length - suffix.length)
  if (inner.startsWith("api/") || inner === "api") return null
  const segs = inner.split("/").filter((s) => s && !(s.startsWith("(") && s.endsWith(")")))
  return "/" + segs.join("/")
}

/** Does a literal reference path reach this route pattern? */
function refMatchesRoute(refSegs: string[], routeSegs: string[]): boolean {
  for (let i = 0; i < routeSegs.length; i++) {
    const rs = routeSegs[i]
    if (/^\[?\[\.\.\..+\]\]?$/.test(rs)) {
      // [...all] needs at least one segment; [[...all]] accepts zero
      return rs.startsWith("[[") ? refSegs.length >= i : refSegs.length > i
    }
    const ref = refSegs[i]
    if (ref === undefined) return false
    if (rs.startsWith("[") && rs.endsWith("]")) continue // dynamic accepts anything
    if (ref !== rs) return false
  }
  return refSegs.length === routeSegs.length
}

const REF_PATTERNS: RegExp[] = [
  /\bhref\s*=\s*"(\/[^"${}]*)"/g,
  /\bhref\s*:\s*"(\/[^"${}]*)"/g,
  /\brouter\s*\.\s*(?:push|replace)\(\s*"(\/[^"${}]*)"/g,
  /\bredirect\(\s*"(\/[^"${}]*)"/g,
  /\brevalidatePath\(\s*"(\/[^"${}]*)"/g,
]

/** Extract literal internal path refs from one already-stripped source. */
export function linkRefsIn(src: string): string[] {
  const out: string[] = []
  for (const re of REF_PATTERNS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) out.push(m[1])
  }
  return out
}

/** The exclusion rules, as one predicate so the guard and its controls agree. */
export function isScannablePath(p: string): boolean {
  if (!p.startsWith("/")) return false
  if (p.startsWith("//")) return false               // protocol-relative host
  if (p.startsWith("/api/")) return false            // opposite-missing owns /api
  const path = p.split("#")[0].split("?")[0]
  if (path === "" || path === "/") return false      // root always exists
  const segs = path.split("/").filter(Boolean)
  if (segs.length === 0) return false
  if (segs[segs.length - 1].includes(".")) return false // /logo.png — an asset
  return true
}

function configRedirectSources(): string[] {
  const f = join(ROOT, "next.config.ts")
  if (!existsSync(f)) return []
  const src = stripComments(readFileSync(f, "utf8"))
  const out: string[] = []
  const re = /source\s*:\s*'([^']+)'|source\s*:\s*"([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) out.push(m[1] ?? m[2])
  return out
}

/** `/contacts/:path*` → matcher over reference segments. */
function redirectMatches(sourcePattern: string, refSegs: string[]): boolean {
  const segs = sourcePattern.split("/").filter(Boolean)
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (s.startsWith(":") && s.endsWith("*")) return refSegs.length >= i
    if (s.startsWith(":")) { if (refSegs[i] === undefined) return false; continue }
    if (refSegs[i] !== s) return false
  }
  return refSegs.length === segs.length
}

function main() {
  const files = [...walkTs(join(ROOT, "app")), ...walkTs(join(ROOT, "lib")), ...rootRuntimeFiles()]
  const uniq = Array.from(new Set(files))

  const routes: string[][] = []
  for (const f of uniq) {
    const route = routeFromPage(rel(f))
    if (route) routes.push(route.split("/").filter(Boolean))
  }
  const redirects = configRedirectSources()

  const dangling = new Map<string, Set<string>>() // path → files that mint it
  let refsSeen = 0
  let excluded = 0
  for (const f of uniq) {
    let src: string
    try { src = stripComments(readFileSync(f, "utf8")) } catch { continue }
    for (const raw of linkRefsIn(src)) {
      refsSeen++
      if (!isScannablePath(raw)) { excluded++; continue }
      const segs = raw.split("#")[0].split("?")[0].split("/").filter(Boolean)
      if (routes.some((r) => refMatchesRoute(segs, r))) continue
      if (redirects.some((s) => redirectMatches(s, segs))) continue
      const key = "/" + segs.join("/")
      const set = dangling.get(key) ?? new Set<string>()
      set.add(rel(f))
      dangling.set(key, set)
    }
  }

  // ── POSITIVE CONTROLS (§2): an absence claim needs proof its finder works ──
  const controls: Array<[string, boolean]> = []
  const specimen = `const a = <Link href="/definitely-not-a-route-xyz">x</Link>`
  const found = linkRefsIn(stripComments(specimen))
  controls.push(["CONTROL the extractor sees a real href literal", found.includes("/definitely-not-a-route-xyz")])
  controls.push(["CONTROL a dangling specimen is judged dangling",
    isScannablePath("/definitely-not-a-route-xyz") &&
    !routes.some((r) => refMatchesRoute(["definitely-not-a-route-xyz"], r))])
  controls.push(["CONTROL a REAL route is not accused",
    routes.length > 0 && routes.some((r) => refMatchesRoute(r.map((s) => (s.startsWith("[") ? "x" : s)), r))])
  controls.push(["CONTROL a path inside a COMMENT is not a link",
    linkRefsIn(stripComments(`// <Link href="/in-a-comment-only">`)).length === 0])
  controls.push(["CONTROL an asset path is excluded", !isScannablePath("/logo.png")])
  controls.push(["CONTROL an /api path is left to opposite-missing", !isScannablePath("/api/contacts/analytics")])
  controls.push(["CONTROL a config-redirect source is not dangling",
    redirects.length === 0 || redirects.some((s) => redirectMatches(s, ["contacts"]))])
  // A ROUTE HANDLER IS A ROUTE. Counting only page.tsx made this guard accuse
  // app/dashboard/superadmin/usage-reports/export/route.ts — the CSV download
  // its own page links — of not existing.
  controls.push(["CONTROL a non-api route.ts handler counts as a route",
    routeFromPage("app/dashboard/superadmin/usage-reports/export/route.ts") === "/dashboard/superadmin/usage-reports/export"])
  controls.push(["CONTROL an /api route.ts is still left to opposite-missing",
    routeFromPage("app/api/contacts/analytics/route.ts") === null])

  const failedControls = controls.filter(([, ok]) => !ok)
  console.log("══════════════════════════════════════════════════")
  console.log(" DANGLING LINK SWEEP — internal links that point at no page route")
  console.log("══════════════════════════════════════════════════")
  console.log(`  ${uniq.length} files · ${routes.length} page routes · ${redirects.length} config redirects`)
  console.log(`  ${refsSeen} literal path references · ${excluded} excluded (assets, /api, external, root)`)
  console.log(`  EXCLUDED BY DESIGN: template literals (unresolvable), /api/** (opposite-missing 6a/6b),`)
  console.log(`  asset paths, external/protocol-relative/anchor-only refs.`)
  for (const [n, ok] of controls) console.log(`  ${ok ? "✓" : "✗"} ${n}`)
  if (failedControls.length) {
    console.log("\n ❌ DANGLING_LINK_FAIL — a positive control failed; the count below is not evidence")
    process.exit(1)
  }

  const found2 = [...dangling.keys()].sort()
  if (process.env.DANGLING_LINK_BASELINE === "1") {
    writeFileSync(BASELINE, JSON.stringify({ generated: new Date().toISOString().slice(0, 10), dangling: found2 }, null, 2) + "\n")
    console.log(`\n⚙ baseline written: ${found2.length} dangling link path(s)`)
    process.exit(0)
  }

  const base: string[] = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, "utf8")).dangling ?? []) : []
  const baseSet = new Set(base)
  const added = found2.filter((p) => !baseSet.has(p))
  const gone = base.filter((p) => !dangling.has(p))

  console.log(`\n  dangling link paths: ${found2.length} (baseline ${base.length}, burn-down)`)
  for (const p of found2.slice(0, 20)) {
    console.log(`     ${p}  ← ${[...(dangling.get(p) ?? [])].slice(0, 3).join(", ")}`)
  }
  if (found2.length > 20) console.log(`     … and ${found2.length - 20} more`)
  if (gone.length) console.log(`\n  ↓ ${gone.length} no longer dangling: ${gone.slice(0, 10).join(", ")}`)

  if (added.length) {
    console.log(`\n  ✗ ${added.length} NEW dangling link(s) — a control that navigates nowhere:`)
    for (const p of added) console.log(`     ${p}  ← ${[...(dangling.get(p) ?? [])].join(", ")}`)
    console.log("\n  Point it at the surviving route, or build the page it means.")
    console.log("  Never delete the link to move this number — the control exists because")
    console.log("  someone needed to get there.")
    console.log(" ❌ DANGLING_LINK_FAIL")
    process.exit(1)
  }
  console.log(" ✅ DANGLING_LINK_PASS — every literal internal link reaches a route")
}

main()
