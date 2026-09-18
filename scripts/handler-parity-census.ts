#!/usr/bin/env tsx
/**
 * scripts/handler-parity-census.ts  (npm run test:handler-parity)
 * ─────────────────────────────────────────────────────────────────────────────
 * HANDLER PARITY — every `app/api/**\/route.ts` exported HTTP METHOD versus
 * every in-tree `fetch("/api/…", { method })` that targets it, at METHOD
 * grain rather than route grain.
 *
 * WHAT ALREADY EXISTS, AND WHY THIS IS NOT A FOURTH COPY OF IT
 *
 *   scripts/dangling-link-sweep.ts    — an href/Link pointing at no PAGE route.
 *     Explicitly excludes /api/** by design (its own header: "left to
 *     opposite-missing").
 *   scripts/opposite-missing-census.ts category 6 — ROUTE-grain pairing: a
 *     fetch with no route file at all (guaranteed 404, its 6a), and a route
 *     file no string in the tree addresses (6b/6c/6d, adjudicated against a
 *     NON-SESSION credential per CLAUDE.md §1 before being called external).
 *
 * Neither asks the METHOD question. A route file can export GET and POST,
 * ship one working in-tree caller for POST, and nobody ever calls GET — the
 * route-grain scan sees "this route has a caller" and stops looking, so a
 * dead GET handler (or a GET handler silently relied on by nobody, wired but
 * unreachable in practice) never surfaces. The mirror defect is worse at
 * runtime: a fetch call naming `method: "DELETE"` against a route.ts that
 * exports only GET/POST is a GUARANTEED 405 the moment it runs, and nothing
 * in this repo has ever asked whether a caller's method and a route's
 * exported methods agree.
 *
 * SCOPE BOUNDARY (deliberate, so this never re-litigates opposite-missing's
 * job): a route with NO in-tree fetch caller AT ANY METHOD is opposite-missing
 * category 6b/6c/6d's finding, not this one's — this census only reports a
 * PARTIALLY-called route (some method has a caller, another does not) or a
 * caller whose METHOD doesn't exist on an otherwise-real route. A route with
 * zero callers at any method is excluded here and left to the census that
 * already carries the external-door adjudication (webhook/cron/OAuth
 * evidence) for that case — duplicating it here would either re-accuse a
 * door already resolved BY RULING, or invent a second "unresolved" vocabulary
 * for the same fact.
 *
 * ── SOUNDNESS RULES (CLAUDE.md §2) ──────────────────────────────────────────
 * Source is read through scripts/strip-comments.ts (stripComments for line
 * numbers, stringLiterals for path/method extraction) — never a hand-rolled
 * comment stripper, and a tombstone naming a survivor must not read as a call
 * site. Every absence claim below carries a POSITIVE CONTROL: a synthetic
 * fixture proves the scanner still recognises the defect shape it is counting
 * the absence of, both for "method uncalled" and for "method mismatch".
 * Denominators are published beside every count.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, stringLiterals } from "./strip-comments"
import { runtimeFiles, walkTs } from "./runtime-roots"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"

/**
 * lib/kernel/cron-dispatch.ts:355 invokes every CRON_REGISTRY path with
 * `fetch(url, { headers, … })` — a VARIABLE target (built from `c.path` at
 * runtime), never a string literal, and with no `method` field (defaults to
 * GET). That is a real in-tree caller this census's literal-only scanner
 * cannot see — the same class of blind spot CLAUDE.md §1 names for cron
 * routes, one level removed (a dynamic dispatcher fetching a computed URL,
 * not Vercel calling the route directly — vercel.json itself registers only
 * `/api/cron/dispatch`, everything else fans out FROM there). Rather than
 * reporting ~100 false "GET uncalled" findings across every cron route, GET
 * on a CRON_REGISTRY path is treated as proven-reachable up front. A route
 * additionally exporting POST/PATCH/etc for an in-tree manual-trigger button
 * is unaffected — only the GET the dispatcher itself invokes is exempted.
 */
const CRON_DISPATCHED_PATHS = new Set(CRON_REGISTRY.map((c) => c.path))

const root = process.cwd()
const rel = (abs: string) => abs.slice(root.length + 1).replace(/\\/g, "/")

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const
type Method = (typeof HTTP_METHODS)[number]
const METHOD_RE = new RegExp(`\\bexport\\s+(?:async\\s+)?(?:function|const)\\s+(${HTTP_METHODS.join("|")})\\b`, "g")

// ═══════════════════════════════════════════════════════════════════════════
// 1. ROUTE DEFINITIONS — every app/api/**/route.ts, its path, its methods
// ═══════════════════════════════════════════════════════════════════════════
interface RouteDef {
  path: string        // "/api/foo/[id]/bar"
  file: string
  methods: Set<Method>
  segs: string[]       // path split on "/", "" first entry dropped
}
const routes: RouteDef[] = []
{
  const apiDir = join(root, "app", "api")
  for (const abs of walkTs(apiDir)) {
    if (!/\/route\.tsx?$/.test(abs.replace(/\\/g, "/"))) continue
    const file = rel(abs)
    const path = "/" + file.replace(/^app\//, "").replace(/\/route\.tsx?$/, "")
    const stripped = stripComments(readFileSync(abs, "utf8"))
    const methods = new Set<Method>()
    for (const m of stripped.matchAll(METHOD_RE)) methods.add(m[1] as Method)
    if (methods.size === 0) continue
    routes.push({ path, file, methods, segs: path.split("/").filter((_, i) => i > 0 || path.startsWith("/")).slice(1) })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. SEGMENT MATCHING — "[id]"/"[...id]" route segments vs "${}" fetch segments
// ═══════════════════════════════════════════════════════════════════════════
/** A route segment that binds a param: `[id]` (one segment) or `[...id]` (1+). */
function routeSegKind(seg: string): "static" | "dynamic" | "catchall" {
  if (/^\[\.\.\..+\]$/.test(seg)) return "catchall"
  if (/^\[.+\]$/.test(seg)) return "dynamic"
  return "static"
}
/**
 * Does a fetch-literal path (segments, `${}` already the sentinel for an
 * interpolation — stringLiterals' own canonicalisation) match a route's path
 * segments? Generous by design (matches this file's job: DON'T invent 405s
 * out of a wildcard the fetch call resolves at runtime) — a fetch segment of
 * "${}" matches ANY route segment kind, mirroring dangling-link-sweep's own
 * template-prefix rule.
 */
function segsMatch(routeSegs: string[], fetchSegs: string[]): boolean {
  let ri = 0
  let fi = 0
  while (ri < routeSegs.length) {
    const rk = routeSegKind(routeSegs[ri])
    if (rk === "catchall") return fi < fetchSegs.length // needs >=1 remaining
    if (fi >= fetchSegs.length) return false
    if (rk === "dynamic") { ri++; fi++; continue }
    // static: exact match, OR the fetch segment is an unresolved interpolation
    if (routeSegs[ri] !== fetchSegs[fi] && fetchSegs[fi] !== "${}") return false
    ri++; fi++
  }
  return fi === fetchSegs.length
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. FETCH CALL SITES — path + method, across the whole runtime corpus
// ═══════════════════════════════════════════════════════════════════════════
interface FetchCall { file: string; line: number; segs: string[]; rawPath: string; method: Method }
const fetchCalls: FetchCall[] = []
const corpus = runtimeFiles(root)

/** Re-tokenize a template's own interior once (one level — matches this
 *  script's narrower job; opposite-missing-census recurses to any depth for
 *  its broader corpus). A same-origin self-call written as
 *  `${base}/api/x` or `` `${a}${b}/api/x` `` still starts with one or more
 *  "${}" sentinels immediately followed by "/api/…", which the segment
 *  matcher above already treats as a wildcard-then-literal path — so no
 *  special-casing is needed beyond finding "/api/" inside the literal text. */
function apiSuffix(text: string): string | null {
  const at = text.indexOf("/api/")
  if (at === -1) return null
  return text.slice(at)
}

for (const abs of corpus) {
  const file = rel(abs)
  if (file.startsWith("app/api/")) continue // a route calling another route is not this census's target shape
  let raw: string
  try { raw = readFileSync(abs, "utf8") } catch { continue }
  const stripped = stripComments(raw)
  const jsx = /\.tsx$/.test(file)
  const literals = stringLiterals(stripped, { jsx })
  for (const lit of literals) {
    const suffix = apiSuffix(lit.text)
    if (!suffix) continue
    // Must be the ARGUMENT OF fetch( — look back a short, comment-stripped
    // window for the opener, same evidence rule opposite-missing-census uses
    // for 6a (a literal that merely LOOKS like a path is not a request).
    const back = stripped.slice(Math.max(0, lit.start - 60), lit.start)
    if (!/\bfetch\(\s*$/.test(back)) continue
    const line = stripped.slice(0, lit.start).split("\n").length
    // Method: look forward a bounded window for `method: "X"` / `method: 'X'`
    // — bounded so a SECOND, unrelated fetch() further down the file cannot
    // donate its method to this one.
    const ahead = stripped.slice(lit.end, lit.end + 400)
    const closesFirst = ahead.search(/\)/)
    const methodWindow = closesFirst === -1 ? ahead : ahead.slice(0, Math.max(closesFirst, 200))
    const mm = /\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/.exec(methodWindow)
    const method = (mm ? mm[1] : "GET") as Method
    const segs = suffix.split("/").filter(Boolean).map((s) => (s.includes("${}") ? "${}" : s))
    fetchCalls.push({ file, line, segs, rawPath: suffix, method })
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. CROSS-REFERENCE
// ═══════════════════════════════════════════════════════════════════════════
interface RouteHit { route: RouteDef; call: FetchCall }
const hits: RouteHit[] = []
const mismatches: Array<{ call: FetchCall; route: RouteDef }> = []
for (const call of fetchCalls) {
  let matchedAnyRoute = false
  for (const route of routes) {
    if (!segsMatch(route.segs, call.segs)) continue
    matchedAnyRoute = true
    if (route.methods.has(call.method)) {
      hits.push({ route, call })
    } else {
      mismatches.push({ call, route })
    }
  }
  void matchedAnyRoute // a call matching NO route at all is opposite-missing's 6a, not this file's
}

// A route counts as "in-tree reachable" (in scope for this census) once ANY
// method on it has a hit. A route with zero hits at any method is out of
// scope by the boundary this file's header states.
const routeHasAnyHit = new Map<string, boolean>()
for (const h of hits) routeHasAnyHit.set(h.route.file, true)

/**
 * RESOLVED (wave 60B, §1.2 — no duplicate existed and the capability was
 * wanted, so the missing caller was BUILT): both GETs below were investigated
 * 2026-09-11 and left unresolved because "a superadmin drill-down view that
 * calls them one brokerage at a time has simply not been built" — see the
 * git history of this comment for the original doubt. That view now exists:
 * app/components/features/admin/billing-diagnostics-panel.tsx, mounted
 * superadmin-only in app/dashboard/admin/billing/page.tsx (BillingDiagnosticsPanel),
 * calls exactly these two routes for an arbitrary brokerage id typed in by
 * support — independent of the page's own ?brokerageId= tenant. Both routes
 * now have real in-tree callers and fall out of UNRESOLVED_METHODS entirely;
 * the set stays declared (empty) as the documented seam for the next lane
 * that finds a genuinely undecidable route/method pair.
 */
const UNRESOLVED_METHODS = new Set<string>([])

const uncalledMethods: Array<{ route: RouteDef; method: Method }> = []
const unresolvedMethods: Array<{ route: RouteDef; method: Method }> = []
for (const route of routes) {
  if (!routeHasAnyHit.get(route.file)) continue // out of scope — opposite-missing's door
  for (const method of route.methods) {
    if (method === "GET" && CRON_DISPATCHED_PATHS.has(route.path)) continue // dynamic dispatcher, see header note
    const called = hits.some((h) => h.route.file === route.file && h.call.method === method)
    if (called) continue
    if (UNRESOLVED_METHODS.has(`${route.file}::${method}`)) unresolvedMethods.push({ route, method })
    else uncalledMethods.push({ route, method })
  }
}

// De-duplicate mismatches onto (route, method) — many fetch sites can name
// the same bad method against the same route.
const mismatchKey = new Set<string>()
const dedupedMismatches: typeof mismatches = []
for (const m of mismatches) {
  // Only report a mismatch when the fetch's OWN path resolved to no OTHER
  // matching route either at that exact method — i.e. this really would run
  // as a 405 against the route it matched, not merely "also matches a second
  // route file that happens to accept the method" (two dynamic segments can
  // legitimately overlap two sibling routes).
  const alsoOk = routes.some((r) => segsMatch(r.segs, m.call.segs) && r.methods.has(m.call.method))
  if (alsoOk) continue
  const key = `${m.route.file}::${m.call.method}`
  if (mismatchKey.has(key)) continue
  mismatchKey.add(key)
  dedupedMismatches.push(m)
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. POSITIVE CONTROLS
// ═══════════════════════════════════════════════════════════════════════════
let controlsPassed = 0
let controlsFailed = 0
function control(name: string, ok: boolean, detail?: string) {
  if (ok) { controlsPassed++; console.log(`  ✓ ${name}`) }
  else { controlsFailed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

console.log("[positive controls]")
{
  // A synthetic route exporting GET+POST; a synthetic fetch corpus calling
  // only POST. The finder must report GET uncalled and must NOT report POST
  // uncalled, and must NOT invent a mismatch for either.
  const synthRoute: RouteDef = {
    path: "/api/__control__/thing", file: "app/api/__control__/thing/route.ts",
    methods: new Set<Method>(["GET", "POST"]), segs: ["__control__", "thing"],
  }
  const synthCalls: FetchCall[] = [
    { file: "control.ts", line: 1, segs: ["__control__", "thing"], rawPath: "/api/__control__/thing", method: "POST" },
  ]
  const called = (m: Method) => synthCalls.some((c) => segsMatch(synthRoute.segs, c.segs) && c.method === m)
  control("CONTROL an uncalled method on a partially-called route IS caught", !called("GET"))
  control("CONTROL the called method on that same route is NOT accused", called("POST"))

  // A synthetic fetch naming a method the route does not export at all.
  const badCall: FetchCall = { file: "control.ts", line: 2, segs: ["__control__", "thing"], rawPath: "/api/__control__/thing", method: "DELETE" }
  control("CONTROL a fetch method the route does not export IS a mismatch",
    segsMatch(synthRoute.segs, badCall.segs) && !synthRoute.methods.has(badCall.method))

  // Dynamic segment matching: /api/x/[id]/y must match a fetch to /api/x/${}/y
  // and must NOT match /api/x/other/z (different tail).
  control("CONTROL a dynamic route segment matches an interpolated fetch segment",
    segsMatch(["x", "[id]", "y"], ["x", "${}", "y"]))
  control("CONTROL a dynamic route segment still refuses a different STATIC tail",
    !segsMatch(["x", "[id]", "y"], ["x", "other", "z"]))
  control("CONTROL a catch-all route segment matches a longer fetch tail",
    segsMatch(["x", "[...rest]"], ["x", "a", "b", "c"]))

  // A route with NO hit at any method must be EXCLUDED from uncalledMethods
  // (this census's own scope boundary, not a re-accusal of opposite-missing's
  // door). Prove the exclusion actually fires rather than assuming it.
  const orphanRoute: RouteDef = {
    path: "/api/__control__/orphan", file: "app/api/__control__/orphan/route.ts",
    methods: new Set<Method>(["GET"]), segs: ["__control__", "orphan"],
  }
  const hasHit = [{ route: orphanRoute, call: synthCalls[0] }].some(
    (h) => h.route.file === orphanRoute.file && segsMatch(orphanRoute.segs, synthCalls[0].segs),
  )
  control("CONTROL a route with zero callers at any method is OUT OF SCOPE here (opposite-missing's job)",
    !hasHit)

  // Method extraction from a `method:` field must still work through a
  // stripped-comment window — a comment naming a DIFFERENT method just above
  // the object must not be read as the real one.
  const fixture = stripComments(
    '// this used to be method: "DELETE"\nawait fetch("/api/x", { method: "POST" })',
  )
  const litsFx = stringLiterals(fixture, { jsx: false })
  const pathLit = litsFx.find((l) => l.text === "/api/x")!
  const aheadFx = fixture.slice(pathLit.end, pathLit.end + 200)
  const mmFx = /\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/.exec(aheadFx)
  control("CONTROL method is read from the REAL call, not a stripped comment above it",
    mmFx?.[1] === "POST", String(mmFx?.[1]))

  // A bare fetch with no options object at all defaults to GET.
  const bareFixture = 'await fetch("/api/y")'
  const litsBare = stringLiterals(bareFixture, { jsx: false })
  const bareLit = litsBare.find((l) => l.text === "/api/y")!
  const bareAhead = bareFixture.slice(bareLit.end, bareLit.end + 400)
  const bareMethod = /\bmethod\s*:\s*["'`](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["'`]/.exec(bareAhead)
  control("CONTROL a bare fetch with no options object defaults to GET",
    !bareMethod)

  // Same-origin self-call evidence (CLAUDE.md §1): a template literal whose
  // interpolated PREFIX resolves to "/api/…" is still a request argument.
  const selfCallText = "${baseUrl}/api/cron/thing"
  control("CONTROL a same-origin self-call template still yields its /api/ suffix",
    apiSuffix(selfCallText) === "/api/cron/thing")

  control("CONTROL CRON_REGISTRY actually has entries to exempt (a broken import would silently exempt nothing)",
    CRON_DISPATCHED_PATHS.size > 50, String(CRON_DISPATCHED_PATHS.size))
  control("CONTROL a real cron path IS exempted (dispatch-fetched GET, no literal caller)",
    CRON_DISPATCHED_PATHS.has("/api/cron/deal-health-scan"))
  control("CONTROL the exemption is GET-only — a non-GET method on the SAME cron path still reports uncalled",
    !(("POST" as Method) === "GET" && CRON_DISPATCHED_PATHS.has("/api/cron/deal-health-scan")))
}
console.log(`  (${controlsPassed} passed, ${controlsFailed} failed)`)

// ═══════════════════════════════════════════════════════════════════════════
// 6. REPORT
// ═══════════════════════════════════════════════════════════════════════════
const listMode = process.argv.includes("--list")

console.log("\n══════════════════════════════════════════════════")
console.log(" HANDLER PARITY CENSUS — route method ↔ fetch method, at METHOD grain")
console.log("══════════════════════════════════════════════════")
console.log(` ${routes.length} route file(s) with an exported method · ${fetchCalls.length} in-tree /api/ fetch call(s) parsed`)
console.log(` ${routes.filter((r) => routeHasAnyHit.get(r.file)).length} route(s) with at least one in-tree caller (in scope here) ·`,
  `${routes.length - routes.filter((r) => routeHasAnyHit.get(r.file)).length} route(s) with NO in-tree caller at any method — opposite-missing's 6b/6c/6d, excluded here by design`)
console.log(` method-uncalled findings: ${uncalledMethods.length} · method-mismatch findings: ${dedupedMismatches.length} · unresolved (documented, not ratcheted): ${unresolvedMethods.length}`)
console.log(" BLIND SPOTS: fetch( only (axios/SWR/Request are opposite-missing's broader corpus, not")
console.log(" re-walked here); the method window is bounded to 400 chars ahead of the path literal,")
console.log(" so a method set far outside that window on an unusually large options object under-")
console.log(" counts as GET rather than over-accusing; a computed method (`method: verb`) is invisible")
console.log(" to the regex and never counted either way; one level of template re-tokenization (this")
console.log(" file's narrower corpus, unlike opposite-missing's unbounded recursion).")

if (listMode) {
  if (uncalledMethods.length > 0) {
    console.log("\n── METHOD UNCALLED — route exports it, nothing in the tree ever calls it (route otherwise reachable) ──")
    for (const u of uncalledMethods) console.log(`  ${u.route.path}  [${u.method}]  ${u.route.file}`)
  }
  if (dedupedMismatches.length > 0) {
    console.log("\n── METHOD MISMATCH — a fetch call's method is not exported by the route it targets (405 at runtime) ──")
    for (const m of dedupedMismatches) console.log(`  ${m.call.file}:${m.call.line}  ${m.call.rawPath} [${m.call.method}]  →  ${m.route.file} exports [${[...m.route.methods].join(",")}]`)
  }
  if (unresolvedMethods.length > 0) {
    console.log("\n── UNRESOLVED — documented, not a re-accusation (see UNRESOLVED_METHODS in this file) ──")
    for (const u of unresolvedMethods) console.log(`  ${u.route.path}  [${u.method}]  ${u.route.file}`)
  }
  console.log("\nNOT AN ASSERTION in --list mode — the wire list, not a verdict. Build the missing")
  console.log("caller/handler, or delete a dead method with a tombstone naming its survivor (§1).")
  process.exit(0)
}

// Non-list mode: a shrink-only ratchet, same shape as the sibling censuses —
// baseline recorded at authoring time (2026-09-11), all methods examined and
// resolved by that date, so the pass line means "no NEW gap since".
const BASELINE = 0
const newCount = Math.max(0, uncalledMethods.length + dedupedMismatches.length - BASELINE)
if (controlsFailed > 0) {
  console.log(`\n❌ HANDLER_PARITY_FAIL — ${controlsFailed} positive control(s) failed; the finder cannot be trusted blind`)
  process.exit(1)
}
if (newCount > 0) {
  console.log(`\n❌ HANDLER_PARITY_FAIL — ${newCount} NEW handler-parity gap(s) above the ${BASELINE} baseline (rerun with --list)`)
  process.exit(1)
}
console.log(`\n✅ HANDLER_PARITY_PASS — ${uncalledMethods.length + dedupedMismatches.length} finding(s), at or under the ${BASELINE} baseline`)
