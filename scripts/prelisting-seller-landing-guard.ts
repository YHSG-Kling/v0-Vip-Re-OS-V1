#!/usr/bin/env tsx
/**
 * scripts/prelisting-seller-landing-guard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Guards the SELLER-FACING pre-listing landing page (app/portal/listing-plan/[id])
 * that the pre-listing drip mails out.
 *
 * Every assertion here is a RULE, never a waypoint (CLAUDE.md §2):
 *
 *   1. ROUTE REACHABILITY — the route path is DERIVED from the call sites that
 *      build the URL, never hardcoded a second time. If a call site moves to a
 *      different path, this guard follows it and fails on the missing route.
 *   2. SELLER FINANCIAL EXCLUSION — the forbidden column set is DERIVED as
 *      (live listing_presentations columns) MINUS (an explicit seller-safe
 *      allowlist), so a financial column added to the table tomorrow is
 *      forbidden here without editing this file.
 *   3. FAIL CLOSED — every gate the page reads must be followed by a refusal.
 *   4. §3 — every supabase result in the route must destructure `error`.
 *   5. §6 — the section status/channel literals the page filters on must be a
 *      subset of the live CHECK vocabulary, and the "which render may be shown"
 *      rule must be the SHARED evaluator, not a second copy.
 *   6. §1 — presentation_sections.viewed_at / status='viewed' must have a writer.
 *
 * Every absence assertion carries a POSITIVE CONTROL that proves the finder
 * still recognises the defect it was written for.
 *
 * Run: npx tsx scripts/prelisting-seller-landing-guard.ts   (npm run test:prelisting-landing)
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { PUBLIC_ROUTES, PROTECTED_ROUTES } from "../app/constants/auth"
import { stripComments } from "./strip-comments"

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")

let passed = 0, failed = 0
const failures: string[] = []
const blindSpots: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
// ── The one correct scanner (§2, §6) ────────────────────────────────────────
// TOMBSTONE (orphan doctrine §1.1) — an 80-line single-pass comment stripper
// stood here. SURVIVOR: scripts/strip-comments.ts#stripComments, imported below.
//
// It was written in good faith: this lane's worktree was cut from a stale base
// where scripts/strip-comments.ts genuinely did not exist, so the lane wrote a
// correct scanner rather than copy the forbidden regex-pair shape from
// scripts/vocabulary-drift-guard.ts:30 (which strips /* */ blocks BEFORE // lines,
// so one // containing a /*, a URL or an apostrophe swallows real code). On the
// real tree the canonical module IS present and is what CLAUDE.md §2 names, so
// keeping a second implementation would be two spellings of one idea (§6) — and
// the more dangerous kind, because the two could drift and no guard would notice
// which one a given scan had used.
//
// The canonical module also carries blankComments / blankStrings / stringLiterals
// and a scannerSelfTest(), which the local copy did not. Section 0 below still
// runs its positive controls against the SURVIVOR, so the integrity checks that
// justified writing a scanner at all are kept, not dropped with the code.

// ── file walking ────────────────────────────────────────────────────────────
function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git") continue
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}
const read = (p: string) => readFileSync(p, "utf8")
const rel = (p: string) => relative(ROOT, p)

// ═══════════════════════════════════════════════════════════════════════════
// 0 · scanner integrity — the guard must be able to SEE the code it judges
// ═══════════════════════════════════════════════════════════════════════════
function testScanner() {
  console.log("\n[0 · scanner integrity — positive controls on the stripper]")

  // The exact §2 defect: a // line containing /* , an apostrophe and a URL.
  const trap = [
    `// don't /* use https://example.com net_sheet here`,
    `const real = { net_sheet: 1 }`,
  ].join("\n")
  const stripped = stripComments(trap)
  check("line comment containing /* , an apostrophe and a URL does not swallow the next line",
    !/don't/.test(stripped) && /const real/.test(stripped) && (stripped.match(/net_sheet/g) ?? []).length === 1,
    `stripped=${JSON.stringify(stripped)}`)

  // A block comment must not hide real code after it, and must keep line count.
  const blk = "/*\n net_sheet\n*/\nconst x = 1"
  const sblk = stripComments(blk)
  check("block comment removed, line numbers preserved",
    !/net_sheet/.test(sblk) && /const x = 1/.test(sblk) && sblk.split("\n").length === blk.split("\n").length)

  // The real-world construct from prelisting-delivery.ts: a template literal
  // wrapping a ${} that contains a string with // and a regex with an escaped /.
  const tmpl = 'const u = `${(process.env.A ?? "https://app.example.com").replace(/\\/$/, "")}/portal/listing-plan/${id}`\nconst after = "SENTINEL"'
  const st = stripComments(tmpl)
  check("template literal + ${} + inner string with // + regex survives intact",
    st.includes("/portal/listing-plan/${id}") && st.includes("SENTINEL") && st.includes("https://app.example.com"),
    `stripped=${JSON.stringify(st)}`)

  // A real repo file must not be truncated by the stripper (tail integrity).
  for (const f of ["app/portal/listing-plan/[id]/page.tsx", "lib/listing-presentation/prelisting-delivery.ts"]) {
    const p = join(ROOT, f)
    if (!existsSync(p)) { check(`tail integrity: ${f} exists`, false); continue }
    const s = stripComments(read(p))
    check(`stripper does not truncate ${f}`, s.trimEnd().endsWith("}"), `tail=${JSON.stringify(s.trimEnd().slice(-40))}`)
  }
  blindSpots.push("stripper: this guard does not own its scanner — it uses the canonical scripts/strip-comments.ts, so it inherits that module's limits rather than restating them. The tail-integrity checks above are kept as the local evidence that no file this guard actually scans comes back truncated.")
}

// ═══════════════════════════════════════════════════════════════════════════
// 1 · ROUTE REACHABILITY — derived from the call sites, never hardcoded twice
// ═══════════════════════════════════════════════════════════════════════════
interface CallSite { file: string; line: number; path: string }

/** Find every `/<segments>/${...}` URL built in code that lands under /portal/. */
function findListingPlanCallSites(files: string[]): CallSite[] {
  const out: CallSite[] = []
  // The literal path prefix immediately preceding a `${` interpolation, inside a
  // template literal. Derived, not asserted: whatever prefix the code writes is
  // the prefix this guard then demands a route for.
  const RE = /(\/portal\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)\/\$\{/g
  for (const f of files) {
    const src = stripComments(read(f))
    let m: RegExpExecArray | null
    RE.lastIndex = 0
    while ((m = RE.exec(src))) {
      if (!m[1].includes("listing-plan")) continue
      out.push({ file: rel(f), line: src.slice(0, m.index).split("\n").length, path: m[1] })
    }
  }
  return out
}

function testRoute(appFiles: string[], libFiles: string[]): string | null {
  console.log("\n[1 · route reachability — path derived FROM the call sites]")

  // Exclude the route itself so the route can never satisfy its own reachability test.
  const routeDirFragment = join("app", "portal", "listing-plan")
  const callSiteFiles = [...libFiles, ...appFiles.filter((f) => !f.includes(routeDirFragment))]
  const sites = findListingPlanCallSites(callSiteFiles)

  // POSITIVE CONTROL for the finder itself.
  const controlHit = findListingPlanCallSitesInSource(
    'const u = `${base}/portal/listing-plan/${presentationId}`',
  )
  check("POSITIVE CONTROL: the call-site finder recognises a built /portal/listing-plan/ URL",
    controlHit.length === 1 && controlHit[0] === "/portal/listing-plan")
  const controlMiss = findListingPlanCallSitesInSource('const u = `${base}/portal/other/${x}`')
  check("POSITIVE CONTROL: the finder does not fire on an unrelated portal URL", controlMiss.length === 0)

  check("at least one call site builds the listing-plan URL (the wire exists)", sites.length > 0,
    `found ${sites.length}`)
  for (const s of sites) console.log(`      · ${s.file}:${s.line} → ${s.path}`)

  const paths = Array.from(new Set(sites.map((s) => s.path)))
  check("§6 — every call site agrees on ONE path", paths.length <= 1, `paths=${JSON.stringify(paths)}`)

  const derived = paths[0]
  if (!derived) { check("route serves the derived path", false, "no path to derive from"); return null }

  // The URL's next segment is dynamic (${...}) → Next.js needs exactly one
  // dynamic child directory with a page under the derived prefix.
  const baseDir = join(ROOT, "app", derived.replace(/^\//, ""))
  check(`route directory exists for ${derived}`, existsSync(baseDir), baseDir)
  if (!existsSync(baseDir)) return derived

  const dynamicChildren = readdirSync(baseDir).filter(
    (e) => /^\[.+\]$/.test(e) && statSync(join(baseDir, e)).isDirectory(),
  )
  check("exactly one dynamic segment serves the interpolated id",
    dynamicChildren.length === 1, `found ${JSON.stringify(dynamicChildren)}`)

  for (const child of dynamicChildren) {
    const pageFile = ["page.tsx", "page.ts", "page.jsx", "page.js"]
      .map((f) => join(baseDir, child, f)).find(existsSync)
    check(`${derived}/${child} has a page file`, !!pageFile, pageFile ?? "none")
    if (pageFile) {
      const s = stripComments(read(pageFile))
      check(`${derived}/${child} page exports a default component`, /export\s+default\s+(async\s+)?function/.test(s))
    }
  }
  return derived
}

// ── 1b · the seller must actually REACH the route ───────────────────────────
/**
 * Mirrors proxy.ts's decision order: PUBLIC_ROUTES (startsWith) is matched at
 * step 2 and short-circuits; PROTECTED_ROUTES (startsWith) is the auth gate at
 * step 4. A page can be perfectly built and still 302 an unauthenticated seller
 * to /login if the middleware never lets the request through.
 */
function middlewareVerdict(pathname: string, pub: readonly string[], prot: readonly string[]): "public" | "protected" | "open" {
  if (pub.some((r) => pathname.startsWith(r))) return "public"
  if (prot.some((r) => pathname.startsWith(r))) return "protected"
  return "open"
}

function testMiddlewareReachability(derived: string) {
  console.log("\n[1b · an unauthenticated seller can actually REACH the derived path]")

  // POSITIVE CONTROLS on the verdict function, against the real live lists.
  check("POSITIVE CONTROL: a normal /portal child reads as PROTECTED",
    middlewareVerdict("/portal/some-contact-id/journey", PUBLIC_ROUTES, PROTECTED_ROUTES) === "protected")
  check("POSITIVE CONTROL: an allowlisted /portal child reads as PUBLIC",
    middlewareVerdict("/portal/login", PUBLIC_ROUTES, PROTECTED_ROUTES) === "public")

  const sample = `${derived}/00000000-0000-0000-0000-000000000000`
  const verdict = middlewareVerdict(sample, PUBLIC_ROUTES, PROTECTED_ROUTES)
  console.log(`      ${sample} → ${verdict}`)
  check("the dripped seller URL is not auth-gated by the middleware", verdict !== "protected",
    `verdict=${verdict}; add "${derived}" to PUBLIC_ROUTES in app/constants/auth.ts`)

  // The exemption must be NARROW — it may not open the rest of the portal.
  check("the exemption does not open the rest of /portal",
    middlewareVerdict("/portal/some-contact-id", PUBLIC_ROUTES, PROTECTED_ROUTES) === "protected")

  blindSpots.push("reachability: this models proxy.ts steps 2 and 4 only. Step 3 (`pathname.includes(\".\")` → pass through) is not modelled; a presentation id never contains a dot, so it cannot apply here.")
}

function findListingPlanCallSitesInSource(src: string): string[] {
  const RE = /(\/portal\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)\/\$\{/g
  const stripped = stripComments(src)
  const out: string[] = []
  let m: RegExpExecArray | null
  while ((m = RE.exec(stripped))) if (m[1].includes("listing-plan")) out.push(m[1])
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// 2 · SELLER FINANCIAL EXCLUSION — forbidden set derived from the live schema
// ═══════════════════════════════════════════════════════════════════════════

/**
 * The ONLY listing_presentations columns a seller prospect may see. Everything
 * else on the table is forbidden BY DERIVATION — a column added to the table
 * later is excluded without touching this list.
 *
 *   id                    the row being viewed (from the URL)
 *   brokerage_id          used only to resolve the brokerage NAME
 *   contact_id            used only to identify the recipient
 *   agent_user_id         used only to resolve the agent NAME
 *   property_address      the seller's own address
 *   state                 the seller's own state
 *   appointment_at        the seller's own appointment
 *   presentation_type     read only to REFUSE the buyer branch
 *   status                read only to REFUSE an abandoned deck
 *   delivery_approved_at  read only as the release gate
 */
const SELLER_SAFE_PRESENTATION_COLUMNS = new Set([
  "id", "brokerage_id", "contact_id", "agent_user_id", "property_address",
  "state", "appointment_at", "presentation_type", "status", "delivery_approved_at",
])

function forbiddenPresentationColumns(): string[] {
  const cols = SCHEMA_SNAPSHOT["listing_presentations"] ?? []
  return cols
    .filter((c) => !SELLER_SAFE_PRESENTATION_COLUMNS.has(c))
    // Single-word columns (id/state/status/presentation) collide with ordinary
    // English and identifiers everywhere; a snake_case name is unambiguous.
    // Published as a blind spot below rather than silently dropped.
    .filter((c) => c.includes("_"))
}

function findColumns(src: string, cols: string[]): Array<{ col: string; line: number }> {
  const stripped = stripComments(src)
  const hits: Array<{ col: string; line: number }> = []
  for (const col of cols) {
    const re = new RegExp(`\\b${col}\\b`, "g")
    let m: RegExpExecArray | null
    while ((m = re.exec(stripped))) hits.push({ col, line: stripped.slice(0, m.index).split("\n").length })
  }
  return hits
}

function testFinancialExclusion(routeFiles: string[]) {
  console.log("\n[2 · seller financial exclusion — forbidden set DERIVED from the live schema]")

  const cols = SCHEMA_SNAPSHOT["listing_presentations"] ?? []
  check("listing_presentations is present in the live schema snapshot (guard is not blind)", cols.length > 0,
    `${cols.length} columns`)

  const forbidden = forbiddenPresentationColumns()
  console.log(`      denominator: ${cols.length} live columns · ${SELLER_SAFE_PRESENTATION_COLUMNS.size} allowlisted · ${forbidden.length} forbidden & scannable`)
  console.log(`      forbidden: ${forbidden.join(", ")}`)

  // POSITIVE CONTROL A (live code): the AGENT viewer genuinely renders the
  // net sheet and the CMA range. The scanner must find them there.
  const agentViewer = join(ROOT, "app", "dashboard", "listings", "presentations", "[id]", "page.tsx")
  if (existsSync(agentViewer)) {
    const agentHits = findColumns(read(agentViewer), forbidden)
    const names = new Set(agentHits.map((h) => h.col))
    check("POSITIVE CONTROL: scanner finds net_sheet in the agent viewer", names.has("net_sheet"))
    check("POSITIVE CONTROL: scanner finds the CMA valuation columns in the agent viewer",
      ["cma_low_value", "cma_mid_value", "cma_high_value"].every((c) => names.has(c)),
      `found ${JSON.stringify([...names])}`)
  } else {
    check("POSITIVE CONTROL: agent viewer available for the control", false, agentViewer)
  }

  // POSITIVE CONTROL B: comment blindness — the same token in a comment vs in code.
  const inComment = `// tombstone: net_sheet moved; don't /* https://x */ read it\nconst ok = 1`
  const inCode = `const row = { net_sheet: 1 }`
  check("POSITIVE CONTROL: a forbidden column inside a comment is NOT counted",
    findColumns(inComment, forbidden).length === 0)
  check("POSITIVE CONTROL: the same forbidden column in code IS counted",
    findColumns(inCode, forbidden).some((h) => h.col === "net_sheet"))

  // THE ASSERTION.
  let total = 0
  for (const f of routeFiles) {
    const hits = findColumns(read(f), forbidden)
    total += hits.length
    for (const h of hits) console.log(`      ✗ ${rel(f)}:${h.line} names forbidden column ${h.col}`)
  }
  check(`no seller-facing render path names a forbidden listing_presentations column (${routeFiles.length} files scanned)`,
    total === 0, `${total} hits`)

  blindSpots.push("financial exclusion: single-word columns (id, state, status, presentation) are excluded from the token scan — they collide with ordinary identifiers. `presentation` (the legacy text column) is therefore NOT scanned for.")
  blindSpots.push("financial exclusion: the scan is by column NAME. A financial value reached through a renamed alias, a `select(\"*\")`, or a joined embed would not be seen. The route uses neither `*` nor an embed — verified by the explicit-select check below.")
}

function testNoStarSelect(routeFiles: string[]) {
  console.log("\n[2b · no select(\"*\") — the allowlist can only hold if every select is explicit]")
  const RE = /\.select\(\s*["'`]\s*\*/g
  let hits = 0
  for (const f of routeFiles) {
    const s = stripComments(read(f))
    const m = s.match(RE)
    if (m) { hits += m.length; console.log(`      ✗ ${rel(f)} uses select("*")`) }
  }
  check("POSITIVE CONTROL: the star-select finder recognises select(\"*\")",
    (stripComments('const q = a.select("*")').match(RE) ?? []).length === 1)
  check("route uses no select(\"*\")", hits === 0, `${hits} hits`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 3 · FAIL CLOSED — every gate is followed by a refusal
// ═══════════════════════════════════════════════════════════════════════════

/** Gates the seller page MUST hold, expressed as the token it must test. */
const REQUIRED_GATES = [
  "delivery_approved_at",   // GATE 2 — the human release stamp
  "presError",              // an unreadable presentation
  "sectionsError",          // an unreadable section list
  "presentation_type",      // the buyer branch has its own home
]
const REFUSAL = /return\s+<Unavailable/

function gatesWithoutRefusal(src: string, gates: string[]): string[] {
  const s = stripComments(src)
  const missing: string[] = []
  for (const g of gates) {
    // Every place the gate token is TESTED inside an `if (...)` must be followed
    // by a refusal within the next statement window.
    const re = new RegExp(`if\\s*\\([^)]*\\b${g}\\b[^)]*\\)`, "g")
    let m: RegExpExecArray | null
    let tested = 0, refused = 0
    while ((m = re.exec(s))) {
      tested++
      if (REFUSAL.test(s.slice(m.index, m.index + 320))) refused++
    }
    if (tested === 0 || refused < tested) missing.push(`${g} (tested ${tested}, refused ${refused})`)
  }
  return missing
}

function testFailClosed(pageFile: string) {
  console.log("\n[3 · fail closed — every gate refuses]")
  const src = read(pageFile)
  const s = stripComments(src)

  // POSITIVE CONTROL: a gate that tests but renders anyway must be flagged.
  const bad = `if (!pres.delivery_approved_at) { console.log("held") }\nreturn <Deck />`
  check("POSITIVE CONTROL: a gate that tests without refusing is flagged",
    gatesWithoutRefusal(bad, ["delivery_approved_at"]).length === 1)
  const good = `if (!pres.delivery_approved_at) return <Unavailable note={HOLD} />`
  check("POSITIVE CONTROL: a gate that refuses is accepted",
    gatesWithoutRefusal(good, ["delivery_approved_at"]).length === 0)
  check("POSITIVE CONTROL: a gate that is never tested at all is flagged",
    gatesWithoutRefusal("const x = 1", ["delivery_approved_at"]).length === 1)

  const missing = gatesWithoutRefusal(src, REQUIRED_GATES)
  for (const m of missing) console.log(`      ✗ gate without refusal: ${m}`)
  check(`all ${REQUIRED_GATES.length} required gates test AND refuse`, missing.length === 0, missing.join("; "))

  // ORDERING RULE: the release gate must be read before any seller content is
  // handed to the renderer. Positions are computed on stripped source, so the
  // file's own header prose cannot satisfy this.
  const gateAt = s.indexOf("delivery_approved_at")
  const renderAt = s.indexOf("<ListingPlanSegments")
  check("the release gate is read BEFORE the seller renderer is reached",
    gateAt >= 0 && renderAt >= 0 && gateAt < renderAt, `gate@${gateAt} render@${renderAt}`)

  // The untrusted id is shape-checked before it reaches Postgres.
  check("the visitor-supplied id is shape-validated before the first query",
    /UUID_RE\.test\(id\)/.test(s) && s.indexOf("UUID_RE.test(id)") < s.indexOf('.from("listing_presentations")'))
}

// ═══════════════════════════════════════════════════════════════════════════
// 4 · §3 — every supabase result destructures `error`
// ═══════════════════════════════════════════════════════════════════════════
function supabaseResultsWithoutError(src: string): string[] {
  const s = stripComments(src)
  const out: string[] = []
  const RE = /const\s*\{([^}]*)\}\s*=\s*await\s+supabase\b/g
  let m: RegExpExecArray | null
  while ((m = RE.exec(s))) {
    if (!/\berror\b/.test(m[1])) out.push(`line ${s.slice(0, m.index).split("\n").length}: { ${m[1].trim()} }`)
  }
  return out
}

function testErrorDestructure(routeFiles: string[]) {
  console.log("\n[4 · §3 — supabase-js RESOLVES refusals, so every result reads its error]")

  check("POSITIVE CONTROL: a result that drops `error` is flagged",
    supabaseResultsWithoutError('const { data } = await supabase.from("x").select("y")').length === 1)
  check("POSITIVE CONTROL: a result that reads `error` is accepted",
    supabaseResultsWithoutError('const { data, error } = await supabase.from("x").select("y")').length === 0)
  check("POSITIVE CONTROL: an aliased error is accepted",
    supabaseResultsWithoutError('const { data: r, error: presError } = await supabase.from("x").select("y")').length === 0)

  let bad = 0
  for (const f of routeFiles) {
    for (const b of supabaseResultsWithoutError(read(f))) { bad++; console.log(`      ✗ ${rel(f)} ${b}`) }
  }
  check("every supabase result in the route destructures `error`", bad === 0, `${bad} offenders`)

  // The UPDATE that stamps the read receipt must .select() its rows back — a
  // matching-nothing UPDATE also resolves with error === null (§3).
  const page = stripComments(read(routeFiles.find((f) => f.endsWith("page.tsx"))!))
  const updIdx = page.indexOf(".update({ status: \"viewed\"")
  check("the read-receipt UPDATE selects its rows back and counts them",
    updIdx >= 0 && /\.select\("id"\)/.test(page.slice(updIdx, updIdx + 400)) && /length === 0/.test(page.slice(updIdx, updIdx + 700)),
    `updIdx=${updIdx}`)
}

// ═══════════════════════════════════════════════════════════════════════════
// 5 · §6 — one vocabulary
// ═══════════════════════════════════════════════════════════════════════════
// Live CHECK constraints on project hrvaqgvukzxfskkcrwbt, supplied to this lane
// by the integrator (verified live 2026-09-05). This lane may not query the DB;
// the RULE asserted below is "the page filters on a SUBSET of the live
// vocabulary", so if a value is retired from the CHECK this list is what must be
// refreshed — never the page's own copy, which is derived from source.
const LIVE_SECTION_STATUS = ["pending", "scheduled", "delivered", "viewed", "failed"]
const LIVE_SECTION_CHANNEL = ["email", "portal", "both"]

function arrayLiterals(src: string, constName: string): string[] {
  const s = stripComments(src)
  const m = new RegExp(`${constName}\\s*=\\s*\\[([^\\]]*)\\]`).exec(s)
  if (!m) return []
  return Array.from(m[1].matchAll(/"([^"]+)"/g)).map((x) => x[1])
}

function testVocabulary(pageFile: string) {
  console.log("\n[5 · §6 — one vocabulary for section status, channel and render visibility]")
  const src = read(pageFile)

  const statuses = arrayLiterals(src, "VISIBLE_SECTION_STATUS")
  const channels = arrayLiterals(src, "PORTAL_CHANNELS")
  check("the page declares which section statuses are visible", statuses.length > 0, JSON.stringify(statuses))
  check("the page declares which channels are portal channels", channels.length > 0, JSON.stringify(channels))
  console.log(`      visible statuses: ${JSON.stringify(statuses)} · portal channels: ${JSON.stringify(channels)}`)

  const badStatus = statuses.filter((v) => !LIVE_SECTION_STATUS.includes(v))
  const badChannel = channels.filter((v) => !LIVE_SECTION_CHANNEL.includes(v))
  check("visible statuses ⊆ the live presentation_sections.status CHECK", badStatus.length === 0, JSON.stringify(badStatus))
  check("portal channels ⊆ the live presentation_sections.channel CHECK", badChannel.length === 0, JSON.stringify(badChannel))

  // POSITIVE CONTROL: an invented spelling must be caught.
  const invented = arrayLiterals('const VISIBLE_SECTION_STATUS = ["delivered", "sent"] as const', "VISIBLE_SECTION_STATUS")
  check("POSITIVE CONTROL: an invented status spelling is caught",
    invented.filter((v) => !LIVE_SECTION_STATUS.includes(v)).length === 1)

  // A section that has not dripped yet must not be visible.
  check("'scheduled' (not yet dripped) is NOT visible to the seller", !statuses.includes("scheduled"))
  // An email-only section is not a portal section.
  check("'email' (email-only) is NOT treated as a portal channel", !channels.includes("email"))

  // Render visibility uses the SHARED evaluator, not a second copy of the rule.
  const s = stripComments(src)
  check("render visibility reuses evaluateRenderReadiness from prelisting-delivery",
    /import\s*\{[^}]*evaluateRenderReadiness[^}]*\}\s*from\s*"@\/lib\/listing-presentation\/prelisting-delivery"/.test(s))
  check("the page does not re-implement the 'succeeded' rule locally",
    !/render_status\s*===\s*"succeeded"/.test(s))
  check("the page applies the canonical customer-facing price guard",
    /findSuggestedPriceLeaks/.test(s) && /@\/lib\/cma\/customer-facing-guard/.test(s))
}

// ═══════════════════════════════════════════════════════════════════════════
// 6 · §1 — the viewed/viewed_at orphan is closed
// ═══════════════════════════════════════════════════════════════════════════
function viewedWriters(files: string[]): string[] {
  const out: string[] = []
  for (const f of files) {
    const s = stripComments(read(f))
    if (!/presentation_sections/.test(s)) continue
    const RE = /\.update\(\s*\{[^}]*viewed_at[^}]*\}/g
    if (RE.test(s)) out.push(rel(f))
  }
  return out
}

function testViewedWriter(allFiles: string[]) {
  console.log("\n[6 · §1 — presentation_sections.viewed_at / status='viewed' has a writer]")

  const liveCols = SCHEMA_SNAPSHOT["presentation_sections"] ?? []
  check("presentation_sections.viewed_at is a live column (so a writer is wanted)",
    liveCols.includes("viewed_at"), JSON.stringify(liveCols.slice(0, 4)))
  check("'viewed' is in the live presentation_sections.status vocabulary",
    LIVE_SECTION_STATUS.includes("viewed"))

  const writers = viewedWriters(allFiles)
  for (const w of writers) console.log(`      · writer: ${w}`)
  check("at least one writer stamps viewed_at on presentation_sections", writers.length > 0,
    `${writers.length} writers`)

  blindSpots.push("viewed writer: the scan looks for a literal `.update({ ... viewed_at ... })` on a file that also names presentation_sections. A writer via .rpc(), a DB trigger, or a migration backfill would not be seen (§3).")
}

// ═══════════════════════════════════════════════════════════════════════════
function main() {
  console.log("══════════════════════════════════════════════════════════════")
  console.log(" Pre-listing SELLER landing guard  (app/portal/listing-plan/[id])")
  console.log("══════════════════════════════════════════════════════════════")

  const appFiles = walk(join(ROOT, "app"))
  const libFiles = walk(join(ROOT, "lib"))
  const routeDir = join(ROOT, "app", "portal", "listing-plan")
  const routeFiles = walk(routeDir)

  testScanner()
  const derived = testRoute(appFiles, libFiles)
  if (derived) testMiddlewareReachability(derived)

  if (routeFiles.length === 0) {
    check("the seller landing route has source files to judge", false, routeDir)
  } else {
    console.log(`\n      route files under ${rel(routeDir)}: ${routeFiles.map(rel).join(", ")}`)
    testFinancialExclusion(routeFiles)
    testNoStarSelect(routeFiles)
    const pageFile = routeFiles.find((f) => f.endsWith("page.tsx"))
    if (!pageFile) check("the route has a page.tsx", false)
    else {
      testFailClosed(pageFile)
      testErrorDestructure(routeFiles)
      testVocabulary(pageFile)
    }
    testViewedWriter([...appFiles, ...libFiles])
  }

  console.log("\n── BLIND SPOTS (published beside the number, §2) ──────────────")
  for (const b of blindSpots) console.log(`  · ${b}`)

  console.log("\n──────────────────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    console.log(" ✗ Failures:")
    for (const f of failures) console.log(`   - ${f}`)
    process.exit(1)
  }
  console.log(" ✅ The dripped listing-plan link resolves, refuses until released, and shows the seller no financials")
}
main()
