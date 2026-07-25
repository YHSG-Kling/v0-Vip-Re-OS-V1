#!/usr/bin/env tsx
/**
 * scripts/orphan-route-sweep.ts  (PASS 18)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE "ORPHAN ROUTE" SWEEP — the generalized fix for "work got lost". The
 * tenant website system was fully built and fully invisible: no dashboard
 * surface linked it, so nobody found it. A page.tsx nothing links to is
 * either a missing nav entry (link it), a public entry point (exempt it,
 * naming the external reachability source), or dead weight (delete it).
 *
 * ROUTE INVENTORY: every app/** page.tsx → URL path (route groups "(x)"
 * vanish, [param] / [...catchall] kept as patterns; app/api skipped).
 * REFERENCE INVENTORY: app/** lib/** components/** scanned for href=,
 * router.push/replace, redirect(), Link to=, revalidatePath, window.open /
 * location assigns, new URL(), plus WHOLE-FILE path-string extraction from
 * the route-config maps (navigation-config, routes-compatibility,
 * role-routes, helpers ROUTE_*). Dynamic routes match by pattern:
 * /listing/[slug] is referenced by "/listing/abc" or `/listing/${id}`.
 * app/sitemap.ts is deliberately EXCLUDED from the reference scan so every
 * public route must be consciously exempted below with a named source.
 *
 * Report-only with a committed baseline: NEW orphan routes fail CI; the
 * existing list is a burn-down (each entry needs a verdict — add the nav
 * link, exempt with a named reachability source, or delete the dead page).
 *
 * Run: npx tsx scripts/orphan-route-sweep.ts  (npm run test:orphan-routes)
 * Tighten: GUARD_ROUTE_BASELINE=1 npx tsx scripts/orphan-route-sweep.ts
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const BASELINE = join(process.cwd(), "scripts/orphan-route-baseline.json")

/** Legitimately-unlinked routes — every entry names its external
 *  reachability source (verified in code, not assumed). Entries whose routes
 *  are ALSO linked in-app were deliberately dropped (audited by running with
 *  the map disabled: /login, /signup, /get-started, /unsubscribe, the token
 *  invite/intake routes were all already referenced — exempting them would
 *  only blunt the guard).
 *
 *  ── Sitemap-listed public slug surfaces ──
 *  app/sitemap.ts builds each of these URLs (verified: siteEntries,
 *  teamEntries, agentEntries, listingEntries, magnetEntries, blogEntries,
 *  videoEntries) and is deliberately EXCLUDED from the reference scan, so
 *  these stay legitimate even if every in-app link to them disappears. */
const EXEMPT: Record<string, string> = {
  "/site/[slug]": "app/sitemap.ts siteEntries — tenant public websites (the system this sweep exists to never lose again)",
  "/team/[slug]": "app/sitemap.ts teamEntries — team public sites",
  "/p/[agentSlug]": "app/sitemap.ts agentEntries — public agent profiles",
  "/listing/[slug]": "app/sitemap.ts listingEntries — public listing pages",
  "/lm/[slug]": "app/sitemap.ts magnetEntries — lead-magnet landing pages",
  "/blog/[slug]": "app/sitemap.ts blogEntries — public blog posts",
  "/v/[slug]": "app/sitemap.ts videoEntries — public video landing pages",
  // ── Reachable through code shapes the scanner can't see ──
  "/embed/[publicId]": "iframe src minted by the embed loader script (app/api/embed/script/route.ts, string concat) — embedded on EXTERNAL sites",
  // ── Intentionally nav-less internal tooling ──
  "/seed": "developer seed utility — typed URL, auth-gated; unlinked by design",
  // ── Legacy redirect stubs (bookmark compatibility) ──
  // Each page is a pure redirect() to its canonical successor. They are kept
  // (not deleted) because NOTHING routes old URLs at runtime: ROUTE_ALIASES
  // in app/routes-compatibility.ts is imported by no middleware or catch-all
  // (verified — no middleware.ts exists, resolveRoute has zero consumers), so
  // the stub page IS the only thing keeping old bookmarks/external links from
  // 404ing. In-app links to them are zero BY DESIGN — that is the exemption.
  "/admin/audit-trail": "legacy redirect stub (bookmark compatibility) → /dashboard/superadmin/audit-trail",
  "/admin/billing": "legacy redirect stub (bookmark compatibility) → /dashboard/superadmin/subscriptions",
  "/admin/brokerages": "legacy redirect stub (bookmark compatibility) → /dashboard/superadmin/brokerages",
  "/admin/integrations": "legacy redirect stub (bookmark compatibility) → /dashboard/superadmin/connectors",
  "/admin/platform": "legacy redirect stub (bookmark compatibility) → /dashboard/superadmin/platform",
  "/admin/providers": "legacy redirect stub (bookmark compatibility) → /dashboard/superadmin/connectors",
  "/admin/system-health": "legacy redirect stub (bookmark compatibility) → /dashboard/superadmin/observability",
  "/admin/system/providers": "legacy redirect stub (bookmark compatibility) → /dashboard/superadmin/env-providers",
  "/admin/users/[userId]": "legacy redirect stub (bookmark compatibility) → /dashboard/admin/users/[userId]",
  "/transaction/dashboard": "legacy redirect stub (bookmark compatibility) → /dashboard/coordinator",
  "/onboarding": "legacy redirect stub (bookmark compatibility) → /dashboard/onboarding",
  "/past-clients": "legacy redirect stub (bookmark compatibility) → /lifetime-customers (Past Clients renamed Lifetime Customers)",
  "/referral-partners": "legacy redirect stub (bookmark compatibility) → /dashboard/agent/referrals",
  "/dashboard/marketing": "legacy redirect stub (bookmark compatibility) → /dashboard/marketing/studio",
  "/dashboard/marketing/competitors": "legacy redirect stub (bookmark compatibility) → /dashboard/marketing/seo?tab=competitors (Competitors folded into the SEO / GEO section — seo_geo_consolidation)",
  "/dashboard/marketing/intelligence": "legacy redirect stub (bookmark compatibility) → /dashboard/marketing/seo?tab=trends (Market Intelligence folded into the SEO / GEO section — seo_geo_consolidation)",
  "/portal/[contactId]/dashboard/[persona]": "legacy redirect stub (bookmark compatibility) → /portal/[contactId] — persona routing is now kernel-decided; portal links were sent to clients externally, so old deep links must not 404",
  "/auth/error": "legacy redirect stub (bookmark compatibility) → /login?message=… — possible OAuth error-redirect target in hosted Supabase auth config (not verifiable in-repo)",
}

/** Files whose ENTIRE content is route configuration — every "/..." string
 *  literal inside counts as a reference (the generic patterns below would
 *  miss bare map keys/values). */
const ROUTE_CONFIG_FILES = [
  "app/config/navigation-config.ts",
  "app/routes-compatibility.ts",
  "lib/kernel/role-routes.ts",
  "lib/kernel/helpers.ts",
]

/** app/sitemap.ts is the EXTERNAL reachability source — excluded from the
 *  reference scan so sitemap-only routes surface here and get a named
 *  exemption above instead of silently passing. */
const REFERENCE_SCAN_EXCLUDE = new Set(["app/sitemap.ts"])

// ─── route inventory ─────────────────────────────────────────────────────────

function walk(dir: string, acc: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
}

/** app/(group)/x/[id]/page.tsx → /x/[id]  (route groups vanish; api skipped) */
function routeFromPage(rel: string): string | null {
  const inner = rel.slice("app/".length, rel.length - "page.tsx".length)
  const segs = inner.split("/").filter(Boolean).filter((s) => !(s.startsWith("(") && s.endsWith(")")))
  if (segs[0] === "api") return null
  return "/" + segs.join("/")
}

// ─── reference inventory ─────────────────────────────────────────────────────

/** `${expr}` → "\0" placeholder (a wildcard URL chunk). */
function collapseTemplate(s: string): string {
  let out = s.replace(/\$\{[^}]*\}/g, "\0")
  // `${base}/listing/${slug}` — a leading host/base placeholder is not part
  // of the path; strip it so the path portion still matches.
  if (out.startsWith("\0/")) out = out.slice(1)
  return out
}

const REF_PATTERNS: RegExp[] = [
  /href\s*[=:]\s*\{?\s*["']([^"']+)["']/g,            // href="/x", href={'/x'}, href: '/x'
  /href\s*[=:]\s*\{?\s*`([^`]+)`/g,                   // href={`/x/${y}`}
  /\brouter\.(?:push|replace)\(\s*["']([^"']+)["']/g, // router.push("/x")
  /\brouter\.(?:push|replace)\(\s*`([^`]+)`/g,
  /\b(?:permanentR|r)edirect\(\s*["']([^"']+)["']/g,  // redirect("/x")
  /\b(?:permanentR|r)edirect\(\s*`([^`]+)`/g,
  /\bto\s*=\s*\{?\s*["'`]([^"'`]+)["'`]/g,            // <Link to="/x">
  /\brevalidatePath\(\s*["']([^"']+)["']/g,           // a revalidate IS a reference
  /\brevalidatePath\(\s*`([^`]+)`/g,
  /(?:window\.location(?:\.href)?\s*=|location\.assign\(|window\.open\()\s*["']([^"']+)["']/g,
  /(?:window\.location(?:\.href)?\s*=|location\.assign\(|window\.open\()\s*`([^`]+)`/g,
  /\bnew URL\(\s*["']([^"']+)["']/g,                  // NextResponse.redirect(new URL("/x", ...))
  /\bnew URL\(\s*`([^`]+)`/g,
  // Minted absolute app URLs — `${appUrl}/showings/feedback/${token}` in an
  // email/SMS body IS reachability (the link is sent out): capture the path
  // after a leading base-URL placeholder.
  /`\$\{[^}]*\}(\/[^`\s]+)`/g,
  // url-named assignments/properties: const signInUrl = `/x`, hostedUrl: "/x"
  /\b\w*(?:url|Url|href|Href|link|Link)\w*\s*[:=]\s*["']([^"'\s]+)["']/g,
  /\b\w*(?:url|Url|href|Href|link|Link)\w*\s*[:=]\s*`([^`\s]+)`/g,
]

/** Bare "/..." string extraction for route-config map files. */
const CONFIG_PATH_STRING = /["'`](\/[A-Za-z0-9_\-/[\]$.{}]*)["'`]/g

function normalizeRef(raw: string): string | null {
  let r = collapseTemplate(raw).split(/[?#]/)[0]
  if (!r.startsWith("/") || r.startsWith("//")) return null
  if (r.length > 1 && r.endsWith("/")) r = r.slice(0, -1)
  if (r === "/" || r.startsWith("/api/") || r === "/api") return null
  const segs = r.split("/").filter(Boolean)
  // An unanchored reference (`/${folder}/${file}` storage paths etc.) carries
  // no routing information — require a literal first segment.
  if (segs.length === 0 || segs[0].includes("\0")) return null
  const last = segs[segs.length - 1]
  if (last.includes(".") && !last.includes("\0")) return null // asset/file refs (/og.png, /llms.txt)
  return r
}

// ─── matching ────────────────────────────────────────────────────────────────

function segsOf(p: string): string[] {
  return p.split("/").filter(Boolean)
}

/** Does a (possibly wildcarded) reference hit this route pattern?
 *  Route segs: literal | [param] | [...catch] | [[...catch]]
 *  Ref segs: literal | contains "\0" (template wildcard) */
function refMatchesRoute(refSegs: string[], routeSegs: string[]): boolean {
  for (let i = 0; i < routeSegs.length; i++) {
    const rs = routeSegs[i]
    const catchAll = /^\[?\[\.\.\..+\]\]?$/.test(rs)
    if (catchAll) return rs.startsWith("[[") ? refSegs.length >= i : refSegs.length > i
    const ref = refSegs[i]
    if (ref === undefined) return false
    const dynamic = rs.startsWith("[") && rs.endsWith("]")
    if (dynamic || ref.includes("\0") || ref === rs) continue
    return false
  }
  return refSegs.length === routeSegs.length
}

// ─── main ────────────────────────────────────────────────────────────────────

function main() {
  const cwd = process.cwd()
  const files: string[] = []
  for (const d of ["app", "lib", "components"]) { try { walk(join(cwd, d), files) } catch {} }
  const rel = (f: string) => f.replace(cwd + "/", "")

  // 1. Route inventory
  const routes = new Map<string, string>() // route → page file
  for (const f of files) {
    const r = rel(f)
    if (!r.startsWith("app/") || !r.endsWith("/page.tsx")) continue
    const route = routeFromPage(r)
    if (route) routes.set(route, r)
  }

  // 2. Reference inventory (ref → files that mint it, for WHY= debugging)
  const refs = new Map<string, Set<string>>()
  const addRef = (raw: string, file: string) => {
    const n = normalizeRef(raw)
    if (!n) return
    const set = refs.get(n) ?? new Set<string>()
    set.add(file)
    refs.set(n, set)
  }
  for (const f of files) {
    const r = rel(f)
    if (REFERENCE_SCAN_EXCLUDE.has(r)) continue
    const s = readFileSync(f, "utf8")
    for (const pat of REF_PATTERNS) {
      pat.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = pat.exec(s))) addRef(m[1], r)
    }
    if (ROUTE_CONFIG_FILES.includes(r)) {
      CONFIG_PATH_STRING.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = CONFIG_PATH_STRING.exec(s))) addRef(m[1], r)
    }
  }
  const refSegList = [...refs.keys()].map((r) => ({ ref: r, segs: segsOf(r) }))

  // WHY=/some/route — print every reference that hits the route, with sources.
  const why = process.env.WHY
  if (why) {
    const routeSegs = segsOf(why)
    for (const { ref, segs } of refSegList) {
      if (refMatchesRoute(segs, routeSegs)) {
        console.log(`  ${ref.replaceAll("\0", "${…}")}  ← ${[...(refs.get(ref) ?? [])].slice(0, 3).join(", ")}`)
      }
    }
    return
  }

  // 3. Orphans: routes with zero inbound references
  const orphans: string[] = []
  for (const [route] of routes) {
    if (route === "/") continue // root is definitionally an entry point
    const routeSegs = segsOf(route)
    const referenced = refSegList.some((rf) => refMatchesRoute(rf.segs, routeSegs))
    if (!referenced && !(route in EXEMPT)) orphans.push(route)
  }
  orphans.sort()

  // Stale-exemption check: an EXEMPT entry whose page is gone is noise.
  const staleExempt = Object.keys(EXEMPT).filter((r) => r !== "/" && !routes.has(r))

  if (process.env.GUARD_ROUTE_BASELINE === "1") {
    writeFileSync(BASELINE, JSON.stringify(orphans, null, 2) + "\n")
    console.log(`⚙ wrote baseline: ${orphans.length} orphan routes (burn-down list)`)
  }
  const baseline = new Set<string>(existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : [])
  const fresh = orphans.filter((r) => !baseline.has(r))
  const fixed = [...baseline].filter((r) => !orphans.includes(r))

  console.log("══════════════════════════════════════════════════")
  console.log(" PASS 18 — orphan route sweep (pages nothing links to)")
  console.log("══════════════════════════════════════════════════")
  console.log(` ${routes.size} routes · ${refs.size} distinct route references · ${Object.keys(EXEMPT).length} exempt`)
  console.log(` orphan routes: ${orphans.length} (baseline ${baseline.size}, burn-down)`)
  for (const r of orphans.slice(0, 200)) {
    const mark = baseline.has(r) ? "·" : "✗ NEW"
    console.log(`  ${mark} ${r}  (${routes.get(r)})`)
  }
  if (staleExempt.length > 0) console.log(` ⚠ stale EXEMPT entries (page gone): ${staleExempt.join(", ")}`)
  if (fixed.length > 0) console.log(` ↘ ${fixed.length} baseline entries now linked — tighten with GUARD_ROUTE_BASELINE=1`)
  if (fresh.length > 0) {
    console.log(` ✗ ${fresh.length} NEW orphan route(s): ${fresh.join(", ")}`)
    console.log("   Give each a verdict: add the nav link, EXEMPT with a named reachability source, or delete the dead page.")
    process.exit(1)
  }
  console.log(" ✅ no NEW orphan routes")
}

main()
