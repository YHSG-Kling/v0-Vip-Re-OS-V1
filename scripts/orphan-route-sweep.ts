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
  // (verified — no middleware.ts exists; resolveRoute had zero consumers and
  // was deleted in orphan tranche 3, the literal stub pages being the named
  // survivors), so
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
  "/compliance": "legacy redirect stub (bookmark compatibility) → /dashboard/compliance (the standalone Compliance & TRID dashboard was a duplicate of the Compliance Command Center — compliance_consolidation; the /compliance/* workflow sub-pages live on and are linked from the Command Center's Governance & records section)",
  "/settings/profile": "legacy redirect stub (bookmark compatibility) → /dashboard/profile (Profile consolidation — the lone personal-website editor was folded into the My Profile hub; settings_profile_consolidation)",
  "/portal/[contactId]/dashboard/[persona]": "legacy redirect stub (bookmark compatibility) → /portal/[contactId] — persona routing is now kernel-decided; portal links were sent to clients externally, so old deep links must not 404",
  "/auth/error": "legacy redirect stub (bookmark compatibility) → /login?message=… — possible OAuth error-redirect target in hosted Supabase auth config (not verifiable in-repo)",
  "/dashboard/leaderboard": "legacy redirect stub (bookmark compatibility) → /dashboard/motivation with scope/metric/period carried across — brokers/team leads had this path in nav; its only in-code self-reference left with the deleted LeaderboardClient (orphan tranche 3)",
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

/**
 * INLINE A FILE'S OWN PATH CONSTANTS BEFORE SCANNING IT.
 *
 * `collapseTemplate` above strips a leading `${…}` because it is usually a HOST
 * (`${appUrl}/showings/feedback/${token}`). It is NOT a host when the constant
 * holds a PATH PREFIX, and this codebase does that constantly:
 *
 *   lib/kernel/portal.ts:  const basePath = `/portal/${contactId}`
 *                          …
 *                          { label: "Calendar", href: `${basePath}/calendar` }
 *
 * Stripped, that becomes a reference to "/calendar" and points at nothing — so
 * /portal/[contactId]/calendar reads as an orphan even though it is an item in
 * the portal's buyer AND seller navigation. A guard that accuses a linked page
 * is as wrong as one that clears an unlinked one, and harder to argue with.
 *
 * RESOLVED, NOT GUESSED. A file-local `const NAME = "/literal"` or
 * `const NAME = \`/literal/${x}\`` is substituted back into every `${NAME}` in
 * that file, so the reference reconstitutes as `/portal/${contactId}/calendar`
 * and matches by the ordinary rules. Only PATH-VALUED locals qualify (the value
 * must start with "/"), so `${appUrl}` — which comes from env, not a local — is
 * untouched and still strips as a host.
 *
 * A tail/suffix heuristic was implemented first and REJECTED: a bare "/offers"
 * suffix cannot tell the portal's offers page from the listing's, and it
 * rescued /open-house/[eventId]/rsvp/[invitationId] on the strength of an
 * unrelated `${…}/demo`. That is the same coincidence-matching this pass exists
 * to remove, so it was replaced with this.
 */
function resolveLocalBasePaths(src: string): string {
  const consts = new Map<string, string>()
  const DECL = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:`(\/[^`\n]*)`|["'](\/[^"'\n]*)["'])/g
  DECL.lastIndex = 0
  let d: RegExpExecArray | null
  while ((d = DECL.exec(src))) {
    const value = d[2] ?? d[3]
    // Self-referential or already-expanded values are skipped rather than
    // expanded in a loop.
    if (value && !value.includes(`\${${d[1]}}`)) consts.set(d[1], value)
  }
  if (consts.size === 0) return src
  return src.replace(/\$\{([A-Za-z_$][\w$]*)\}/g, (whole, name: string) => consts.get(name) ?? whole)
}

const REF_PATTERNS: RegExp[] = [
  /href\s*[=:]\s*\{?\s*["']([^"']+)["']/g,            // href="/x", href={'/x'}, href: '/x'
  /href\s*[=:]\s*\{?\s*`([^`]+)`/g,                   // href={`/x/${y}`}
  /\brouter\.(?:push|replace)\(\s*["']([^"']+)["']/g, // router.push("/x")
  /\brouter\.(?:push|replace)\(\s*`([^`]+)`/g,
  /\b(?:permanentR|r)edirect\(\s*["']([^"']+)["']/g,  // redirect("/x")
  /\b(?:permanentR|r)edirect\(\s*`([^`]+)`/g,
  /\bto\s*=\s*\{?\s*["'`]([^"'`]+)["'`]/g,            // <Link to="/x">
  // ── revalidatePath REMOVED — it was a FALSE PASS, not a reference. ─────────
  // This list used to carry `/\brevalidatePath\(…\)/` with the note "a
  // revalidate IS a reference". It is not, and the difference is the whole
  // point of this sweep. `revalidatePath("/x")` says "when this data changes,
  // drop /x from the cache". It is evidence that a page is INTENDED to exist —
  // never evidence that a human can GET to it. This guard's own charter names
  // the only three ways a page is legitimate: something links to it, it is
  // externally reachable and EXEMPTed with a named source, or it is dead weight.
  // A cache invalidation is none of the three.
  //
  // MEASURED, not theorised. Before this line was removed, /mobile/activity
  // passed the sweep on nothing but two `revalidatePath("/mobile/activity")`
  // calls in app/actions/activities.ts (:81, :121) — a page with no nav entry
  // and no link anywhere in the product, reported as reachable. The coaching
  // sessions and transaction milestones routes passed the same way, on
  // app/actions/copilot.ts:134/212/217/426.
  /(?:window\.location(?:\.href)?\s*=|location\.assign\(|window\.open\()\s*["']([^"']+)["']/g,
  /(?:window\.location(?:\.href)?\s*=|location\.assign\(|window\.open\()\s*`([^`]+)`/g,
  /\bnew URL\(\s*["']([^"']+)["']/g,                  // NextResponse.redirect(new URL("/x", ...))
  /\bnew URL\(\s*`([^`]+)`/g,
  // Minted absolute app URLs — `${appUrl}/showings/feedback/${token}` in an
  // email/SMS body IS reachability (the link is sent out): capture the path
  // after a leading base-URL placeholder.
  /`\$\{[^}]*\}(\/[^`\s]+)`/g,
  // url-named assignments/properties: const signInUrl = `/x`, hostedUrl: "/x",
  // and the JSX-prop spelling fixHref={`/x/${id}`}.
  //
  // `\{?\s*` ADDED — a REAL SCANNER GAP, found by tightening refMatchesRoute
  // above and worth naming because it is the opposite error to the three false
  // passes. A custom JSX prop whose name merely ENDS in Href/Url/Link passes its
  // value through an expression container: `fixHref={\`/dashboard/listings/
  // ${id}/cma\`}`. The generic `href` patterns higher up allow `\{?`; these two
  // did not, so every such prop was invisible. It went unnoticed because the
  // over-permissive wildcard rule let some unrelated `/dashboard/listings/${x}`
  // reference cover the route anyway — one defect masking another. Without this
  // fix, tightening the matcher would have turned /dashboard/listings/[id]/cma,
  // /offers, /showings and eight more into FALSE ACCUSATIONS: pages that are
  // genuinely linked, reported as orphans.
  /\b\w*(?:url|Url|href|Href|link|Link)\w*\s*[:=]\s*\{?\s*["']([^"'\s]+)["']/g,
  /\b\w*(?:url|Url|href|Href|link|Link)\w*\s*[:=]\s*\{?\s*`([^`\s]+)`/g,
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

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Does a (possibly wildcarded) reference hit this route pattern?
 *  Route segs: literal | [param] | [...catch] | [[...catch]]
 *  Ref segs: literal | contains "\0" (template wildcard)
 *
 *  ── THE THIRD FALSE PASS. ─────────────────────────────────────────────────
 *  This used to read `if (dynamic || ref.includes("\0") || ref === rs) continue`
 *  — a template wildcard in the REFERENCE was allowed to satisfy a LITERAL
 *  segment of the route. A bare `${…}` carries no routing information at all, so
 *  under that rule every `/portal/${id}` in the tree matched every three-segment
 *  /portal/* route, whatever its literal third segment said.
 *
 *  MEASURED: /portal/[contactId]/assistant was "referenced" by
 *  `/portal/listings/${…}` (app/actions/instant-property-alerts.ts),
 *  `/portal/lender/${…}`, `/portal/title/${…}`, `/portal/equity/${…}` and four
 *  more — none of which is a link to the assistant page. Its only genuinely
 *  matching reference was its own file. Two independent false passes stacked, so
 *  the page read as doubly-reachable while nothing in the product linked to it.
 *
 *  THE RULE NOW: a wildcard may satisfy a DYNAMIC route segment (that is what
 *  dynamic segments are for), and a PARTIALLY-literal wildcard segment may
 *  satisfy a literal it is consistent with (`post-${id}` still matches `[slug]`,
 *  and `chunk-${n}` would still match a literal it prefixes). A PURE `${…}`
 *  against a LITERAL segment is refused: it is a coincidence, not a link. */
function refMatchesRoute(refSegs: string[], routeSegs: string[]): boolean {
  for (let i = 0; i < routeSegs.length; i++) {
    const rs = routeSegs[i]
    const catchAll = /^\[?\[\.\.\..+\]\]?$/.test(rs)
    if (catchAll) return rs.startsWith("[[") ? refSegs.length >= i : refSegs.length > i
    const ref = refSegs[i]
    if (ref === undefined) return false
    const dynamic = rs.startsWith("[") && rs.endsWith("]")
    if (dynamic) continue          // the route accepts anything here
    if (ref === rs) continue       // literal ↔ literal
    if (ref.includes("\0")) {
      if (ref === "\0") return false // pure wildcard vs a literal — no evidence
      const rx = new RegExp("^" + ref.split("\0").map(escapeRe).join(".*") + "$")
      if (rx.test(rs)) continue
    }
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
  // ── LOCAL BASE-PATH CONSTANTS (see resolveLocalBasePaths). ────────────────
  // `collapseTemplate` strips a leading `${…}` on the assumption that it is a
  // HOST (`${appUrl}/showings/feedback/${token}`). That assumption is wrong
  // whenever the placeholder holds a PATH PREFIX, and this codebase does that
  // constantly — lib/kernel/portal.ts sets
  // `const basePath = \`/portal/${contactId}\`` and then emits
  // `href: \`${basePath}/calendar\``, which reduced to the reference
  // "/calendar" and pointed at nothing.
  //
  // WHY THIS SURFACED NOW: tightening refMatchesRoute (a pure `${…}` no longer
  // satisfies a literal) removed the coincidental matches that were covering for
  // it, so /portal/[contactId]/calendar — an item that IS in the portal's buyer
  // AND seller nav — would have been reported as an orphan. That is a FALSE
  // ACCUSATION, the opposite failure to the three false passes and just as
  // damaging: it invites someone to "fix" a page that is already linked, or to
  // delete it.
  //
  // The fix RESOLVES the constant instead of guessing at it — see
  // resolveLocalBasePaths. A tail/suffix heuristic was tried first and rejected:
  // a bare "/offers" tail cannot tell the portal's offers page from the
  // listing's, so it re-introduced exactly the kind of coincidence match this
  // pass exists to remove.
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
    const s = resolveLocalBasePaths(readFileSync(f, "utf8"))
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
    const page = routes.get(why)
    const ownDir = page ? page.slice(0, page.length - "page.tsx".length) : null
    for (const { ref, segs } of refSegList) {
      if (refMatchesRoute(segs, routeSegs)) {
        // SELF is marked, because a self-reference does NOT make a route
        // reachable and reading the old output as if it did is what let three
        // unlinked surfaces pass.
        const sources = [...(refs.get(ref) ?? [])]
          .slice(0, 3)
          .map((s) => (ownDir && s.startsWith(ownDir) ? `${s} [SELF — does not count]` : s))
        console.log(`  ${ref.replaceAll("\0", "${…}")}  ← ${sources.join(", ")}`)
      }
    }
    return
  }

  // 3. Orphans: routes with zero inbound references FROM OUTSIDE THEMSELVES.
  //
  // ── THE SECOND FALSE PASS, and the worse of the two. ──────────────────────
  // The reference inventory scans all of app/, which INCLUDES each route's own
  // page.tsx and the client components sitting beside it. So a page carrying a
  // breadcrumb, a self-referencing tab link, a "reset filters" href, or a
  // `router.replace` back onto its own URL COUNTED AS ITS OWN INBOUND LINK and
  // passed a sweep whose entire question is "does anything else link here".
  // A page that links to itself is exactly the page this guard exists to catch.
  //
  // MEASURED: /portal/[contactId]/assistant had ONE matching reference in the
  // whole tree — `/portal/${…}/assistant` inside
  // app/portal/[contactId]/assistant/page.tsx itself. Zero real links, and a
  // clean pass. /dashboard/coaching/sessions and
  // /dashboard/transactions/[id]/milestones were the same shape.
  //
  // THE RULE: a reference minted from inside the route's OWN DIRECTORY does not
  // make that route reachable. Scoped to the directory, not just the page file,
  // because co-located client components are the same page. A PARENT directory
  // linking DOWN to a child route is still a real reference and still counts —
  // app/portal/[contactId]/page.tsx linking to /portal/[contactId]/assistant is
  // navigation, and is precisely the nav entry a surface like that needs.
  const selfDirOf = (pageFile: string) => pageFile.slice(0, pageFile.length - "page.tsx".length)

  const orphans: string[] = []
  for (const [route, pageFile] of routes) {
    if (route === "/") continue // root is definitionally an entry point
    const routeSegs = segsOf(route)
    const ownDir = selfDirOf(pageFile)
    const outsideOwnDir = (sources: Set<string> | undefined) => {
      if (!sources) return false
      // At least one source must live OUTSIDE the route's own directory.
      for (const src of sources) if (!src.startsWith(ownDir)) return true
      return false
    }
    const referenced = refSegList.some(
      (rf) => refMatchesRoute(rf.segs, routeSegs) && outsideOwnDir(refs.get(rf.ref)),
    )
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
