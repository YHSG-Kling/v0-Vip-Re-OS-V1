#!/usr/bin/env tsx
/**
 * scripts/route-response-field-census.ts  (npm run test:route-response-fields)
 * ─────────────────────────────────────────────────────────────────────────────
 * ROUTE-RESPONSE-FIELD PARITY, at the busiest doors first.
 *
 * WHAT ALREADY EXISTS, AND WHY THIS IS NOT A FOURTH COPY OF IT
 *
 *   scripts/opposite-missing-census.ts category 6 pairs a fetch("/api/…") against
 *   a route FILE. scripts/handler-parity-census.ts pairs a fetch's METHOD against
 *   the route's exported METHODs. Neither ever opens the response BODY — a route
 *   that exists and answers the right method can still hand back an envelope its
 *   only caller half-reads, or a caller can destructure a key the route stopped
 *   sending months ago and nothing ever throws (an undefined property access is
 *   silent in JS). This census is the first to compare the SHAPE of the JSON on
 *   both ends of the wire.
 *
 * SCOPE (deliberate, not laziness): the 15 API routes with the most in-tree
 * `fetch("/api/…")` call sites — the doors most code depends on, where a phantom
 * field costs the most surfaces if it's wrong. A repo-wide version would multiply
 * this file's blind spots (below) across ~540 routes for diminishing signal;
 * ranking by call-site count concentrates the audit where readers already prove
 * the route matters.
 *
 * ── SOUNDNESS RULES (CLAUDE.md §2) ──────────────────────────────────────────
 * Brace/paren matching and field extraction run over `blankStrings(raw)` — the
 * ONE correct scanner, never a hand-rolled comment/string stripper — which blanks
 * comments AND quoted contents to spaces while preserving every byte offset, so a
 * tombstone naming a field in prose, or a `{` inside a string value, cannot be
 * misread as code. Actual key/field TEXT is then read out of `raw` at those same
 * offsets (masking and source share identical length and offsets by construction
 * — see strip-comments.ts's own header). Every absence claim below carries a
 * POSITIVE CONTROL: a synthetic route + caller pair proving the census still
 * catches a phantom-read and a phantom-return of the shape it counts the absence
 * of. A baseline file records the first-run counts (2026-09-12) as a shrink-only
 * ratchet, same convention as the sibling censuses.
 *
 * BLIND SPOTS, published beside the count (§2):
 *   · only literal `fetch("/api/…")` / fetch(`…`) call sites are walked — axios,
 *     SWR, and `Request` objects are opposite-missing's broader corpus, not
 *     re-walked here.
 *   · a returned field wrapped in a runtime-built object (`NextResponse.json(payload)`
 *     where `payload` is a variable, not an object literal) cannot be enumerated —
 *     that route is marked "opaque" and excluded from the returned-field diff
 *     entirely (never falsely accused, never falsely cleared).
 *   · a spread (`...rest`) inside the returned object literal can inject fields
 *     this scan cannot name — a route with a spread is flagged and its
 *     "returned but never read" list is suppressed (spread can only ADD fields,
 *     so "read but never returned" stays sound; "returned but unread" would not).
 *   · reads are windowed (bounded chars of source after the matching `.json()`
 *     call) — a destructure or member access far outside that window, or one
 *     performed after passing the parsed body through another function, is
 *     invisible and under-counts as "never read" rather than over-accusing.
 *   · a dynamically computed member access (`data[key]`) is invisible to both
 *     the destructure and member-access regexes.
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { blankStrings, blankComments } from "./strip-comments"
import { runtimeFiles, walkTs } from "./runtime-roots"

const root = process.cwd()
const rel = (abs: string) => abs.slice(root.length + 1).replace(/\\/g, "/")
const lineOf = (masked: string, idx: number) => masked.slice(0, idx).split("\n").length

// ═══════════════════════════════════════════════════════════════════════════
// 0. SHARED PARSERS
// ═══════════════════════════════════════════════════════════════════════════

/** Balanced-brace scan starting at `open` (index of the `{`), using a mask
 *  that has already blanked strings/comments to spaces so a brace inside a
 *  quoted value or a tombstone comment can never desync the count. Returns
 *  the index one past the matching `}`, or -1 if unterminated. */
function matchBrace(masked: string, open: number): number {
  let depth = 0
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "{") depth++
    else if (masked[i] === "}") { depth--; if (depth === 0) return i + 1 }
  }
  return -1
}

/** Split the INTERIOR of an object literal (no outer braces) into top-level
 *  comma-separated segments, respecting nested {}/[]/() depth so a nested
 *  object's own commas don't fracture a segment. */
function topLevelSegments(interior: string): string[] {
  const segs: string[] = []
  let depth = 0, start = 0
  for (let i = 0; i < interior.length; i++) {
    const c = interior[i]
    if (c === "{" || c === "[" || c === "(") depth++
    else if (c === "}" || c === "]" || c === ")") depth--
    else if (c === "," && depth === 0) { segs.push(interior.slice(start, i)); start = i + 1 }
  }
  segs.push(interior.slice(start))
  return segs.map((s) => s.trim()).filter(Boolean)
}

interface ObjectFields { keys: Set<string>; hasSpread: boolean }

/** Parse an object literal's TOP-LEVEL keys from its already-brace-matched
 *  span. `text` is the REAL source (raw), `maskedInterior` the same span from
 *  the blanked mask — segmenting on the mask, reading key names from `text`. */
function parseObjectKeys(text: string, maskedInterior: string): ObjectFields {
  const keys = new Set<string>()
  let hasSpread = false
  const segs = topLevelSegments(maskedInterior)
  let cursor = 0
  for (const maskedSeg of segs) {
    // Re-locate this segment's span in the ORIGINAL interior so we read real text.
    const segStart = maskedInterior.indexOf(maskedSeg, cursor)
    const realSeg = segStart === -1 ? maskedSeg : text.slice(segStart, segStart + maskedSeg.length)
    cursor = segStart === -1 ? cursor : segStart + maskedSeg.length
    const t = realSeg.trim()
    if (!t) continue
    if (t.startsWith("...")) { hasSpread = true; continue }
    const keyed = /^(?:"([^"]+)"|'([^']+)'|`([^`]+)`|([A-Za-z_$][\w$]*))\s*:/.exec(t)
    if (keyed) { keys.add(keyed[1] ?? keyed[2] ?? keyed[3] ?? keyed[4]); continue }
    const shorthand = /^([A-Za-z_$][\w$]*)$/.exec(t)
    if (shorthand) { keys.add(shorthand[1]); continue }
    // computed key `[expr]: val` or something this scanner can't name — skip,
    // never guessed at (§1: "unresolved" beats a guess).
  }
  return { keys, hasSpread }
}

/** Parse the identifier list inside a destructuring pattern's braces:
 *  `{ a, b: renamed, c = 1, ...rest }` → the SOURCE field names are a, b, c
 *  (the pre-colon / bare name — what the route actually sent), never the
 *  rename target. */
function parseDestructureFields(interior: string): Set<string> {
  const keys = new Set<string>()
  for (const raw of topLevelSegments(interior)) {
    const t = raw.trim()
    if (!t || t.startsWith("...")) continue
    const renamed = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z_$][\w$]*))\s*:/.exec(t)
    if (renamed) { keys.add(renamed[1] ?? renamed[2] ?? renamed[3]); continue }
    const bare = /^([A-Za-z_$][\w$]*)/.exec(t)
    if (bare) keys.add(bare[1])
  }
  return keys
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. RANK ROUTES BY CALL-SITE COUNT
// ═══════════════════════════════════════════════════════════════════════════
interface RouteDef { path: string; file: string; segs: string[] }
const routes: RouteDef[] = []
{
  const apiDir = join(root, "app", "api")
  for (const abs of walkTs(apiDir)) {
    if (!/\/route\.tsx?$/.test(abs.replace(/\\/g, "/"))) continue
    const file = rel(abs)
    const path = "/" + file.replace(/^app\//, "").replace(/\/route\.tsx?$/, "")
    routes.push({ path, file, segs: path.split("/").filter(Boolean) })
  }
}

function routeSegKind(seg: string): "static" | "dynamic" | "catchall" {
  if (/^\[\.\.\..+\]$/.test(seg)) return "catchall"
  if (/^\[.+\]$/.test(seg)) return "dynamic"
  return "static"
}
function segsMatch(routeSegs: string[], callSegs: string[]): boolean {
  let ri = 0, fi = 0
  while (ri < routeSegs.length) {
    const rk = routeSegKind(routeSegs[ri])
    if (rk === "catchall") return fi < callSegs.length
    if (fi >= callSegs.length) return false
    if (rk === "dynamic") { ri++; fi++; continue }
    if (routeSegs[ri] !== callSegs[fi] && callSegs[fi] !== "${}") return false
    ri++; fi++
  }
  return fi === callSegs.length
}

interface FetchSite { file: string; line: number; idx: number; masked: string; raw: string; segs: string[] }
const fetchSites: FetchSite[] = []
const corpus = runtimeFiles(root)
const FETCH_LITERAL_RE = /fetch\(\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g

for (const abs of corpus) {
  const file = rel(abs)
  if (file.startsWith("app/api/")) continue // a route calling a route is not this census's shape
  let raw: string
  try { raw = readFileSync(abs, "utf8") } catch { continue }
  // Literal fetch() paths must be read from a mask that keeps STRING CONTENT
  // intact (comments blanked only) — blankStrings() would blank the very URL
  // text this regex needs to capture. Depth-safe parsing later in
  // readFieldsAt() uses blankStrings() on this same file, which shares
  // identical offsets/length with this mask by construction (strip-comments.ts).
  const textMask = blankComments(raw)
  const depthMask = blankStrings(raw)
  FETCH_LITERAL_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FETCH_LITERAL_RE.exec(textMask))) {
    const lit = m[1] ?? m[2] ?? m[3] ?? ""
    const at = lit.indexOf("/api/")
    if (at === -1) continue
    const suffix = lit.slice(at)
    // A query string is not a path segment — `?id=${id}` must not become a
    // wildcard-matching final segment (it did: "/api/x?id=${id}" was
    // segmenting to ["x?id=${}"], read as "${}" and matching ANY route,
    // cross-contaminating unrelated routes' read sets with each other's
    // fields). Strip everything from the first "?" before segmenting.
    const pathOnly = suffix.split("?")[0]
    const segs = pathOnly.split("/").filter(Boolean).map((s) => (s.includes("${") ? "${}" : s))
    fetchSites.push({ file, line: lineOf(textMask, m.index), idx: m.index, masked: depthMask, raw, segs })
  }
}

const callCounts = new Map<string, number>() // route.file -> count
const routeForSegs = (segs: string[]): RouteDef | undefined => routes.find((r) => segsMatch(r.segs, segs))
for (const site of fetchSites) {
  const route = routeForSegs(site.segs)
  if (!route) continue
  callCounts.set(route.file, (callCounts.get(route.file) ?? 0) + 1)
}
const ranked = [...callCounts.entries()].sort((a, b) => b[1] - a[1])
const TOP_N = 15
const topRoutes = ranked.slice(0, TOP_N).map(([file, count]) => ({ route: routes.find((r) => r.file === file)!, count }))

// ═══════════════════════════════════════════════════════════════════════════
// 2. RETURNED FIELDS — every NextResponse.json({...}) in each top route
// ═══════════════════════════════════════════════════════════════════════════
interface RouteShape { keys: Set<string>; hasSpread: boolean; opaqueCalls: number; jsonCalls: number }
function returnedFieldsFor(routeFile: string): RouteShape {
  const abs = join(root, routeFile)
  const raw = readFileSync(abs, "utf8")
  const masked = blankStrings(raw)
  const keys = new Set<string>()
  let hasSpread = false, opaqueCalls = 0, jsonCalls = 0
  const RE = /NextResponse\.json\(/g
  let m: RegExpExecArray | null
  while ((m = RE.exec(masked))) {
    jsonCalls++
    let i = m.index + m[0].length
    while (i < masked.length && /\s/.test(masked[i])) i++
    if (masked[i] !== "{") { opaqueCalls++; continue }
    const close = matchBrace(masked, i)
    if (close === -1) { opaqueCalls++; continue }
    const interiorMasked = masked.slice(i + 1, close - 1)
    const interiorRaw = raw.slice(i + 1, close - 1)
    const parsed = parseObjectKeys(interiorRaw, interiorMasked)
    for (const k of parsed.keys) keys.add(k)
    if (parsed.hasSpread) hasSpread = true
  }
  return { keys, hasSpread, opaqueCalls, jsonCalls }
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. READ FIELDS — what each call site destructures/accesses off res.json()
// ═══════════════════════════════════════════════════════════════════════════
const READ_WINDOW = 6000

function readFieldsAt(site: FetchSite): Set<string> {
  const fields = new Set<string>()
  const { masked, raw } = site
  const windowEnd = Math.min(masked.length, site.idx + READ_WINDOW)
  // Don't bleed into the NEXT fetch call in the same file.
  const nextFetch = masked.indexOf("fetch(", site.idx + 6)
  const end = nextFetch !== -1 && nextFetch < windowEnd ? nextFetch : windowEnd
  const windowMasked = masked.slice(site.idx, end)
  const windowRaw = raw.slice(site.idx, end)

  // Pattern A: direct destructure off *.json() — `const { a, b } = await X.json()`
  const DESTRUCT_RE = /(?:const|let)\s*\{/g
  let dm: RegExpExecArray | null
  while ((dm = DESTRUCT_RE.exec(windowMasked))) {
    const openBrace = dm.index + dm[0].length - 1
    const close = matchBrace(windowMasked, openBrace)
    if (close === -1) continue
    const after = windowMasked.slice(close, close + 60)
    if (!/^\s*=\s*await\s+[\w.]*\.json\(\)/.test(after)) continue
    const interiorRaw = windowRaw.slice(openBrace + 1, close - 1)
    for (const k of parseDestructureFields(interiorRaw)) fields.add(k)
  }

  // Pattern B: `const X = await ….json()` then member access `X.field` /
  // `X?.field`, or a LATER destructure `const { a } = X`.
  const ASSIGN_RE = /(?:const|let)\s+(\w+)\s*=\s*await\s+[\w.]*\.json\(\)/g
  let am: RegExpExecArray | null
  while ((am = ASSIGN_RE.exec(windowMasked))) {
    const varName = am[1]
    const restMasked = windowMasked.slice(am.index + am[0].length)
    const restRaw = windowRaw.slice(am.index + am[0].length)
    const MEMBER_RE = new RegExp(`\\b${varName}\\?\\.(\\w+)|\\b${varName}\\.(\\w+)`, "g")
    let mm: RegExpExecArray | null
    while ((mm = MEMBER_RE.exec(restMasked))) fields.add(mm[1] ?? mm[2])
    const LATER_DESTRUCT_RE = new RegExp(`(?:const|let)\\s*\\{`, "g")
    let ldm: RegExpExecArray | null
    while ((ldm = LATER_DESTRUCT_RE.exec(restMasked))) {
      const openBrace = ldm.index + ldm[0].length - 1
      const close = matchBrace(restMasked, openBrace)
      if (close === -1) continue
      const after = restMasked.slice(close, close + 30)
      if (!new RegExp(`^\\s*=\\s*${varName}\\b`).test(after)) continue
      const interiorRaw = restRaw.slice(openBrace + 1, close - 1)
      for (const k of parseDestructureFields(interiorRaw)) fields.add(k)
    }
  }
  return fields
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. DIFF, PER TOP ROUTE
// ═══════════════════════════════════════════════════════════════════════════
interface RouteVerdict {
  route: RouteDef; count: number; shape: RouteShape
  readFields: Set<string>
  returnedUnread: string[]
  readUnreturned: string[]
}
const verdicts: RouteVerdict[] = []
for (const { route, count } of topRoutes) {
  const shape = returnedFieldsFor(route.file)
  const readFields = new Set<string>()
  for (const site of fetchSites) {
    if (!segsMatch(route.segs, site.segs)) continue
    for (const f of readFieldsAt(site)) readFields.add(f)
  }
  const returnedUnread = shape.hasSpread ? [] : [...shape.keys].filter((k) => !readFields.has(k)).sort()
  // An OPAQUE call (`NextResponse.json(variable)`) means the known-keys set is
  // a LOWER BOUND, not the whole shape — a field read at the caller may well
  // be inside the variable this scan cannot open. Flagging it as "never
  // returned" would be exactly the false accusation CLAUDE.md §2 warns against
  // (a scan that cannot see the code it judges), so read-unreturned is
  // suppressed wherever the route has any opaque call, same posture as the
  // spread suppression above.
  const readUnreturned = shape.opaqueCalls > 0 ? [] : [...readFields].filter((k) => !shape.keys.has(k)).sort()
  verdicts.push({ route, count, shape, readFields, returnedUnread, readUnreturned })
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. POSITIVE CONTROLS
// ═══════════════════════════════════════════════════════════════════════════
let controlsPassed = 0, controlsFailed = 0
function control(name: string, ok: boolean, detail?: string) {
  if (ok) { controlsPassed++; console.log(`  ✓ ${name}`) }
  else { controlsFailed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
console.log("[positive controls]")
{
  // Specimen route: returns { alpha, beta, gamma }.
  const specimenRouteSrc = `
    export async function GET() {
      return NextResponse.json({ alpha: 1, beta: "x", gamma: computeGamma() })
    }
  `
  const rMasked = blankStrings(specimenRouteSrc)
  const jm = /NextResponse\.json\(/.exec(rMasked)!
  let oi = jm.index + jm[0].length
  while (/\s/.test(rMasked[oi])) oi++
  const closeIdx = matchBrace(rMasked, oi)
  const shape = parseObjectKeys(specimenRouteSrc.slice(oi + 1, closeIdx - 1), rMasked.slice(oi + 1, closeIdx - 1))
  control("CONTROL specimen route's returned keys are read (alpha,beta,gamma)",
    shape.keys.has("alpha") && shape.keys.has("beta") && shape.keys.has("gamma") && shape.keys.size === 3,
    [...shape.keys].join(","))

  // Specimen caller: destructures {alpha, delta} — delta is a PHANTOM READ
  // (never returned); gamma is RETURNED-BUT-NEVER-READ.
  const specimenCallerSrc = `
    async function load() {
      const res = await fetch("/api/__control__/specimen")
      const { alpha, delta } = await res.json()
      return alpha + delta
    }
  `
  const cMasked = blankStrings(specimenCallerSrc)
  const fm = /fetch\(/.exec(cMasked)!
  const fakeSite: FetchSite = { file: "control.ts", line: 1, idx: fm.index, masked: cMasked, raw: specimenCallerSrc, segs: ["__control__", "specimen"] }
  const reads = readFieldsAt(fakeSite)
  control("CONTROL a phantom read (delta, never returned) IS caught",
    reads.has("delta"), [...reads].join(","))
  control("CONTROL a real destructured read (alpha) is recognised, not just delta",
    reads.has("alpha"))
  const returnedUnread = [...shape.keys].filter((k) => !reads.has(k))
  control("CONTROL a returned-but-never-read field (gamma, beta) IS caught",
    returnedUnread.includes("gamma") && returnedUnread.includes("beta"), returnedUnread.join(","))

  // Member-access variant: `const data = await res.json(); … data.zeta …`
  const memberCallerSrc = `
    async function load2() {
      const res = await fetch("/api/__control__/specimen")
      const data = await res.json()
      console.log(data.alpha, data?.zeta)
    }
  `
  const mMasked = blankStrings(memberCallerSrc)
  const fm2 = /fetch\(/.exec(mMasked)!
  const fakeSite2: FetchSite = { file: "control.ts", line: 1, idx: fm2.index, masked: mMasked, raw: memberCallerSrc, segs: ["__control__", "specimen"] }
  const reads2 = readFieldsAt(fakeSite2)
  control("CONTROL member-access reads (data.alpha, data?.zeta) are both recognised",
    reads2.has("alpha") && reads2.has("zeta"), [...reads2].join(","))

  // Spread route: a returned field cannot be enumerated past a `...rest`, so
  // the returned-unread list must be SUPPRESSED for that route (never guess).
  const spreadRouteSrc = `
    export async function GET() {
      return NextResponse.json({ known: 1, ...extra() })
    }
  `
  const sMasked = blankStrings(spreadRouteSrc)
  const sjm = /NextResponse\.json\(/.exec(sMasked)!
  let soi = sjm.index + sjm[0].length
  while (/\s/.test(sMasked[soi])) soi++
  const sClose = matchBrace(sMasked, soi)
  const sShape = parseObjectKeys(spreadRouteSrc.slice(soi + 1, sClose - 1), sMasked.slice(soi + 1, sClose - 1))
  control("CONTROL a spread in the returned object is detected (hasSpread)", sShape.hasSpread)

  // Opaque route: `NextResponse.json(payload)` — a variable, not a literal —
  // must be marked opaque and excluded, never guessed at as "returns nothing".
  const opaqueRouteSrc = `
    export async function GET() {
      const payload = buildPayload()
      return NextResponse.json(payload)
    }
  `
  const oMasked = blankStrings(opaqueRouteSrc)
  const ojm = /NextResponse\.json\(/.exec(oMasked)!
  let ooi = ojm.index + ojm[0].length
  while (/\s/.test(oMasked[ooi])) ooi++
  control("CONTROL a variable payload (not an object literal) is recognised as OPAQUE",
    oMasked[ooi] !== "{")
}
console.log(`  (${controlsPassed} passed, ${controlsFailed} failed)`)

// ═══════════════════════════════════════════════════════════════════════════
// 6. BASELINE
// ═══════════════════════════════════════════════════════════════════════════
const BASELINE_PATH = join(root, "scripts", "route-response-field-baseline.json")
interface Baseline { returnedUnread: number; readUnreturned: number }
let baseline: Baseline = { returnedUnread: 0, readUnreturned: 0 }
if (existsSync(BASELINE_PATH)) {
  try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) } catch { /* fall back to zero */ }
}
const totalReturnedUnread = verdicts.reduce((s, v) => s + v.returnedUnread.length, 0)
const totalReadUnreturned = verdicts.reduce((s, v) => s + v.readUnreturned.length, 0)
if (process.argv.includes("--write-baseline")) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ returnedUnread: totalReturnedUnread, readUnreturned: totalReadUnreturned }, null, 2) + "\n")
  console.log(`baseline written: ${BASELINE_PATH}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. REPORT
// ═══════════════════════════════════════════════════════════════════════════
const listMode = process.argv.includes("--list")
console.log("\n══════════════════════════════════════════════════")
console.log(" ROUTE-RESPONSE-FIELD CENSUS — top-15-called routes: returned JSON keys vs. caller reads")
console.log("══════════════════════════════════════════════════")
console.log(` ${routes.length} route file(s) · ${fetchSites.length} in-tree /api/ fetch call site(s) parsed · ${ranked.length} route(s) with ≥1 caller`)
console.log(" TOP 15 BY CALL-SITE COUNT:")
for (const v of verdicts) {
  const flags = [v.shape.hasSpread ? "spread(suppressed-unread)" : null, v.shape.opaqueCalls > 0 ? `opaque×${v.shape.opaqueCalls}` : null].filter(Boolean).join(" ")
  console.log(`  ${String(v.count).padStart(3)}×  ${v.route.path}  [returned ${v.shape.keys.size} keys / read ${v.readFields.size}]${flags ? "  " + flags : ""}`)
}
console.log(` returned-but-never-read: ${totalReturnedUnread} (baseline ${baseline.returnedUnread})`)
console.log(` read-but-never-returned: ${totalReadUnreturned} (baseline ${baseline.readUnreturned})`)
console.log(" BLIND SPOTS: literal fetch() only; opaque (variable) response bodies excluded from the")
console.log(" returned-field diff; spread routes suppress their returned-unread list only; reads are")
console.log(" windowed (6000 chars, bounded by the next fetch()); computed member access is invisible.")

if (listMode) {
  for (const v of verdicts) {
    if (v.returnedUnread.length) console.log(`\n── ${v.route.path} — RETURNED, NEVER READ (any caller) ──\n  ${v.returnedUnread.join(", ")}`)
    if (v.readUnreturned.length) console.log(`\n── ${v.route.path} — READ, NEVER RETURNED (live bug candidate) ──\n  ${v.readUnreturned.join(", ")}`)
  }
  process.exit(0)
}

if (controlsFailed > 0) {
  console.log(`\n❌ ROUTE_RESPONSE_FIELD_FAIL — ${controlsFailed} positive control(s) failed; the finder cannot be trusted blind`)
  process.exit(1)
}
const newReturnedUnread = Math.max(0, totalReturnedUnread - baseline.returnedUnread)
const newReadUnreturned = Math.max(0, totalReadUnreturned - baseline.readUnreturned)
if (newReturnedUnread > 0 || newReadUnreturned > 0) {
  console.log(`\n❌ ROUTE_RESPONSE_FIELD_FAIL — ${newReturnedUnread} new returned-unread + ${newReadUnreturned} new read-unreturned above baseline (rerun with --list)`)
  process.exit(1)
}
console.log(`\n✅ ROUTE_RESPONSE_FIELD_PASS — ${totalReturnedUnread} returned-unread / ${totalReadUnreturned} read-unreturned, at or under baseline`)
