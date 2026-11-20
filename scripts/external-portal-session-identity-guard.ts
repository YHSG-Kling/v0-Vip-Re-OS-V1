#!/usr/bin/env tsx
/**
 * scripts/external-portal-session-identity-guard.ts
 *   (tsx scripts/external-portal-session-identity-guard.ts)
 * ─────────────────────────────────────────────────────────────────────────────
 * AN AUTHORIZATION CHECK THAT READS ITS SUBJECT FROM THE REQUEST IS NOT AN
 * AUTHORIZATION CHECK.
 *
 * Both routes under `app/api/external-portal/` took `partnerId` (and
 * `partnerType`) from caller input and used them as the authorization SUBJECT.
 * `documents/download` asked `title_company_users.user_id = $partnerId AND
 * transaction_id = …`, and for lenders resolved `lenderVendorForUser(supabase,
 * $partnerId)` before checking `vendor_assignments`. Every one of those reads
 * answers "does the partner NAMED IN THE URL have access". None of them asks
 * "is the caller that partner" — and neither file contained a single
 * `auth.getUser()` call, so the caller's own identity was never consulted.
 *
 * Executed rather than reasoned about — `set local role authenticated` with each
 * caller's real jwt claims, inside a transaction that was rolled back and
 * verified (0 probe rows left):
 *
 *   · an ordinary agent, naming a DIFFERENT user's `title_company_users` row on
 *     his own brokerage, SATISFIED the old membership read (1 row) and could
 *     read the document — the route would have returned `storage_url`;
 *   · under the session-derived subject (`user_id = auth.uid()`) that same
 *     caller gets 0, and the real title partner still gets 1;
 *   · on the lender lane the agent gets 0 (user_role_assignments' self policy),
 *     but a same-brokerage ADMIN naming the lender's user id gets 1, and the
 *     `vendor_assignments` read then passes — the identical bypass, one role up;
 *   · the audit row was invisible to its own writer: the old insert stamped only
 *     `partner_id`, while `dd_select` is `is_platform_admin() OR
 *     has_brokerage_access(brokerage_id) OR (user_id = auth.uid())` → 0 rows
 *     visible. Stamping `user_id` + `brokerage_id` → 1.
 *
 * ── WHAT THIS GUARD STANDS OVER ──────────────────────────────────────────────
 *
 *   G1  ZERO BASELINE ON THE SUBJECT. No route under `app/api/external-portal/`
 *       may read an IDENTITY from request-derived data. Not a spelling check: a
 *       small taint scan starts at `request`, follows `new URL(request.url)`,
 *       `await request.json()` and every destructuring of a tainted value, and
 *       then reports any identity key (`partnerId`, `partnerType`, `userId`,
 *       `vendorId`, `titleUserId`, snake_case variants) read off a tainted
 *       expression — by `.get("…")`, by destructuring, or by member access.
 *       Zero, not a ratchet: one such read IS the defect.
 *
 *   G2  EACH ROUTE CONSULTS THE SESSION. Every route file must reach
 *       `auth.getUser()` — directly, or through one of the session-deriving
 *       gates in `lib/kernel/portal-auth.ts`. And that gate is itself required
 *       to call `auth.getUser()`, so "delegates to a helper that also never
 *       checks" cannot pass.
 *
 *   G3  THE MEMBERSHIP PREDICATE IS KEYED ON THE RESOLVED IDENTITY. Inside
 *       `externalPartnerTransactionLane`, every `.eq()` on an identity column
 *       (`user_id`, `vendor_id`) must take a property of the resolved
 *       `identity`, not a free variable. This is where a "fix" quietly reverts:
 *       the getUser() call stays, and the predicate goes back to a parameter.
 *
 *   G4  THE AUDIT ROW IS READABLE BY THE PEOPLE WHO NEED IT. Every
 *       `document_downloads` insert in the tree stamps `user_id` AND
 *       `brokerage_id` at DEPTH 1 — the two lanes `dd_select` actually reads.
 *       (The policy is NOT changed; the writer is.)
 *
 *   G5  THE ACTION'S AUDIT ROW NAMES A HUMAN. The `audit_log` insert in
 *       `actions/complete` must stamp a `user_id` that is not the literal
 *       `null` it used to stamp — `al_select` is `is_platform_admin() OR
 *       (user_id = auth.uid())`, so a NULL there means the only record of the
 *       action is invisible to the partner who performed it.
 *
 *   G6  EVERY READ ON THIS PATH DESTRUCTURES `error`. supabase-js RESOLVES a
 *       refused query, so `const { data }` alone turns a refused membership read
 *       into a clean 404 — an authorization gate failing OPEN INTO A DENIAL,
 *       which looks exactly like working software.
 *
 *   G7  THE ROUTES STILL EXIST AND STILL GATE. G1 goes green just as happily
 *       against a route with no authorization in it at all, and "we deleted it"
 *       is not the same result as "we fixed it".
 *
 *   G8  THE TITLE GATE IS ON THE VENDOR RAIL (wave 155, lane 155T3). Title is a
 *       vendor category (CLAUDE.md §4). No app/ or lib/ code reads the writer-
 *       less `title_company_users` (0 rows); no caller-supplied `titleUserId`
 *       survives; `resolveTitleVendorActor` reads session → vendor role row →
 *       title category → vendor_assignments (vendor, deal, the vendor's own
 *       brokerage); `requireTitleVendorActor` is its only throwing form.
 *
 *   G9  THE TITLE GATE, DRIVEN (SIMULATED, in-memory): no session, a non-title
 *       vendor, a title vendor of another tenant, one not on the deal and a
 *       refused read are each refused before any deal read; the deal's title
 *       vendor is admitted; the external-portal resolver agrees.
 *
 * ── HOW THIS PROOF IS BUILT ──────────────────────────────────────────────────
 *   · CONSTRUCTS, never spellings. Comments are blanked (offset-preserving)
 *     before every structural assertion — a comment asserting a gate is not
 *     evidence a gate exists, and a commented-out defect is not a defect.
 *   · The brace trap is avoided: a function body is located by skipping the
 *     parameter list as a balanced group first, then disambiguating a return
 *     type (`): Promise<{ … }> {`) from the body by what follows it.
 *   · Every assertion carries a NEGATIVE CONTROL: the defect is written into the
 *     real file, THE PATCH IS VERIFIED TO HAVE APPLIED, the check is required to
 *     flip RED, and the file is restored and re-verified by sha256. Two controls
 *     are inverted — they must stay GREEN — so a guard that flags everything
 *     cannot pass itself off as a proof.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { walkTs } from "./runtime-roots"
import { resolve, join, relative } from "node:path"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { blankComments } from "./strip-comments"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const PORTAL_DIR = "app/api/external-portal"
const DOWNLOAD = "app/api/external-portal/documents/download/route.ts"
const COMPLETE = "app/api/external-portal/actions/complete/route.ts"
const GATES = "lib/kernel/portal-auth.ts"

/** This guard quotes the defect in its own controls; never scan itself. */
const SELF = "scripts/external-portal-session-identity-guard.ts"

/** The two routes that exist today. They may grow; they may not vanish. */
const ROUTE_FLOOR = 2

/**
 * Names that identify a PRINCIPAL. A resource id (`docId`, `actionId`,
 * `transactionId`) is not on this list on purpose: taking a resource id from the
 * caller is normal and is what the membership check exists to adjudicate.
 */
const IDENTITY_KEYS = [
  "partnerId", "partner_id", "partnerType", "partner_type",
  "userId", "user_id", "vendorId", "vendor_id",
  "titleUserId", "title_user_id", "lenderId", "lender_id",
]

/** Session-deriving gates a route may delegate its getUser() to. */
const SESSION_GATES = [
  "resolveExternalPartnerIdentity",
  "requireTitleVendorActor",
  "resolveTitleVendorActor",
  "requireVendorActor",
  "requireLenderVendorActor",
]

const failures: string[] = []
function check(label: string, ok: boolean, detail = ""): boolean {
  if (ok) {
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`)
    failures.push(label)
  }
  return ok
}

const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")
const sha = (p: string) => createHash("sha256").update(raw(p)).digest("hex")

// ─────────────────────────────────────────────────────────────────────────────
// String-aware scanning (the house scanner — these files hold template literals,
// object literals and braces inside strings, so a regex over raw text cannot
// find the end of anything).
// ─────────────────────────────────────────────────────────────────────────────

// blankComments() now comes from scripts/strip-comments.ts — see the import above.
// hand-rolled scanner replaced (finding #250): it could not see nested `${…}` templates, regex literals, or an apostrophe in JSX text, and went blind on the code it judges.

/** Index just past the string/template starting at `start`. Handles `${…}`. */
function skipString(src: string, start: number): number {
  const quote = src[start]
  let i = start + 1
  while (i < src.length) {
    const c = src[i]
    if (c === "\\") { i += 2; continue }
    if (c === quote) return i + 1
    if (quote === "`" && c === "$" && src[i + 1] === "{") { i = skipBalanced(src, i + 1); continue }
    i++
  }
  return i
}

/** Index just past the delimiter pair opening at `open` (`(`, `{` or `[`). */
function skipBalanced(src: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" }
  const stack: string[] = [pairs[src[open]]]
  let i = open + 1
  while (i < src.length && stack.length > 0) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue }
    if (c === "(" || c === "{" || c === "[") { stack.push(pairs[c]); i++; continue }
    if (c === stack[stack.length - 1]) { stack.pop(); i++; continue }
    i++
  }
  return i
}

/** Index just past the `<…>` group opening at `open`. */
function skipBalancedAngle(src: string, open: number): number {
  let depth = 0
  let i = open
  while (i < src.length) {
    const c = src[i]
    if (c === "<") depth++
    else if (c === ">") { depth--; if (depth === 0) return i + 1 }
    else if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue }
    i++
  }
  return i
}

/**
 * The body of `function <name>(…)` as a `[start, end)` span.
 *
 * THE BRACE TRAP: "the first `{` after the name" is wrong twice — a destructured
 * parameter puts a `{` before the parameter list closes, and a return type
 * (`): Promise<{ ok: true }>`) puts one after it. The parameter list is skipped
 * as a balanced group FIRST, then the candidate `{` is disambiguated by what
 * follows: if the next non-space character after the balanced group is another
 * `{`, the group just skipped was the return type.
 */
function functionBody(src: string, name: string): [number, number] | null {
  const decl = new RegExp(`function\\s+${name}\\s*(?=[(<])`).exec(src)
  if (!decl) return null
  let i = decl.index + decl[0].length
  while (i < src.length && /\s/.test(src[i])) i++
  if (src[i] === "<") i = skipBalancedAngle(src, i)
  while (i < src.length && /\s/.test(src[i])) i++
  if (src[i] !== "(") return null
  i = skipBalanced(src, i)
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++
    if (i >= src.length) return null
    if (src[i] === "<") { i = skipBalancedAngle(src, i); continue }
    if (src[i] !== "{") {
      if (src[i] === ";") return null
      i++
      continue
    }
    const close = skipBalanced(src, i)
    let j = close
    while (j < src.length && /\s/.test(src[j])) j++
    if (src[j] === "{") { i = j; continue }
    return [i, close]
  }
}

/** The keys declared at DEPTH 1 of the object literal opening at `open`. */
function topLevelEntries(src: string, open: number): Array<{ key: string; value: string }> {
  const entries: Array<{ key: string; value: string }> = []
  let depth = 0
  let i = open
  let atKeyPosition = false
  while (i < src.length) {
    const c = src[i]
    if (c === '"' || c === "'" || c === "`") { i = skipString(src, i); continue }
    if (c === "{" || c === "(" || c === "[") {
      depth++
      if (c === "{" && depth === 1) atKeyPosition = true
      else if (depth > 1) { i = skipBalanced(src, i); depth--; continue }
      i++
      continue
    }
    if (c === "}" || c === ")" || c === "]") {
      depth--
      if (depth === 0) return entries
      i++
      continue
    }
    if (depth === 1) {
      if (c === ",") { atKeyPosition = true; i++; continue }
      if (atKeyPosition && /[A-Za-z_$]/.test(c)) {
        const m = /^[A-Za-z0-9_$]+/.exec(src.slice(i))
        if (m) {
          const rest = src.slice(i + m[0].length)
          const colon = /^\s*:/.exec(rest)
          if (colon) {
            // The value runs to the next depth-1 comma or the closing brace.
            let k = i + m[0].length + colon[0].length
            const start = k
            while (k < src.length) {
              const cc = src[k]
              if (cc === '"' || cc === "'" || cc === "`") { k = skipString(src, k); continue }
              if (cc === "(" || cc === "{" || cc === "[") { k = skipBalanced(src, k); continue }
              if (cc === "," || cc === "}") break
              k++
            }
            entries.push({ key: m[0], value: src.slice(start, k).trim() })
            i = k
            atKeyPosition = false
            continue
          }
          i += m[0].length
          atKeyPosition = false
          continue
        }
      }
      if (!/\s/.test(c)) atKeyPosition = false
    }
    i++
  }
  return entries
}

// ─────────────────────────────────────────────────────────────────────────────
// Route census
// ─────────────────────────────────────────────────────────────────────────────
function routeFiles(): string[] {
  const dir = resolve(ROOT, PORTAL_DIR)
  if (!existsSync(dir)) return []
  // TOMBSTONE (orphan doctrine §1.1) — the private walker that stood here was one of
  // 82 copies of the same readdirSync walker. The survivor is
  // scripts/runtime-roots.ts:61 (`walkTs`), imported above.
  //
  // Not a blindness fix: this census is deliberately scoped to ONE subtree of
  // route handlers, and the repository root holds no `route.ts`. It is
  // deduplicated only, and the scope is left exactly where it was.
  return walkTs(dir)
    .filter((p) => /(^|\/)route\.tsx?$/.test(p))
    .map((p) => relative(ROOT, p))
    .sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// G1 — the taint scan
// ─────────────────────────────────────────────────────────────────────────────
interface Offence { file: string; line: number; what: string }

/**
 * Identifiers carrying request data, and every identity read off one of them.
 *
 * Seeds on `request` / `req`, then propagates through `const x = <tainted expr>`
 * and `const { a, b } = <tainted expr>` until the set stops growing — which is
 * what catches `const { searchParams } = new URL(request.url)` and
 * `const { actionId, context } = await request.json()` without hard-coding
 * either shape.
 */
function requestIdentityReads(file: string): Offence[] {
  const src = blankComments(raw(file))
  const lineOf = (idx: number) => src.slice(0, idx).split("\n").length
  const tainted = new Set<string>(["request", "req"])
  const offences: Offence[] = []

  const isTaintedExpr = (expr: string) =>
    /request\s*\.\s*(json|url|text|formData|headers|nextUrl)/.test(expr) ||
    [...tainted].some((t) => new RegExp(`\\b${t}\\b`).test(expr))

  for (let pass = 0; pass < 4; pass++) {
    // const { a, b } = <expr>
    const destr = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*((?:await\s+)?[^\n;]+)/g
    let m: RegExpExecArray | null
    while ((m = destr.exec(src)) !== null) {
      if (!isTaintedExpr(m[2])) continue
      for (const part of m[1].split(",")) {
        const nameMatch = /([A-Za-z_$][\w$]*)\s*(?::\s*([A-Za-z_$][\w$]*))?/.exec(part.trim())
        if (!nameMatch) continue
        const declaredKey = nameMatch[1]
        const bound = nameMatch[2] ?? nameMatch[1]
        tainted.add(bound)
        if (IDENTITY_KEYS.includes(declaredKey)) {
          offences.push({
            file,
            line: lineOf(m.index),
            what: `\`${declaredKey}\` destructured from request-derived \`${m[2].trim().slice(0, 48)}\``,
          })
        }
      }
    }
    // const x = <expr>
    const assign = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*((?:await\s+)?[^\n;]+)/g
    while ((m = assign.exec(src)) !== null) {
      if (isTaintedExpr(m[2])) tainted.add(m[1])
    }
  }

  for (const t of tainted) {
    for (const key of IDENTITY_KEYS) {
      const getter = new RegExp(`\\b${t}\\s*\\??\\.\\s*get\\(\\s*["']${key}["']`, "g")
      let g: RegExpExecArray | null
      while ((g = getter.exec(src)) !== null) {
        offences.push({ file, line: lineOf(g.index), what: `\`${t}.get("${key}")\`` })
      }
      const member = new RegExp(`\\b${t}\\s*\\??\\.\\s*${key}\\b`, "g")
      let mm: RegExpExecArray | null
      while ((mm = member.exec(src)) !== null) {
        offences.push({ file, line: lineOf(mm.index), what: `\`${t}.${key}\`` })
      }
    }
  }

  // Deduplicate — the same site can be reached by two tainted aliases.
  const seen = new Set<string>()
  return offences.filter((o) => {
    const k = `${o.file}:${o.line}:${o.what}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

function assertNoIdentityFromRequest(): boolean {
  const files = routeFiles()
  const offences = files.flatMap((f) => requestIdentityReads(f))
  return check(
    `G1  no route under ${PORTAL_DIR}/ reads an identity from request data (${files.length} route file(s) scanned)`,
    offences.length === 0,
    offences.length === 0
      ? ""
      : offences.map((o) => `${o.file}:${o.line} ${o.what}`).join("; "),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// G2 — every route consults the session
// ─────────────────────────────────────────────────────────────────────────────
function callsGetUser(src: string): boolean {
  return /auth\s*\.\s*getUser\s*\(/.test(src) || /auth\s*\.\s*getSession\s*\(/.test(src)
}

function assertEveryRouteConsultsSession(): boolean {
  const files = routeFiles()
  const missing: string[] = []
  for (const f of files) {
    const src = blankComments(raw(f))
    const direct = callsGetUser(src)
    const delegated = SESSION_GATES.some((g) => new RegExp(`\\b${g}\\s*\\(`).test(src))
    if (!direct && !delegated) missing.push(f)
  }
  const routesOk = check(
    `G2a every route under ${PORTAL_DIR}/ calls getUser() or a session-deriving gate`,
    missing.length === 0,
    missing.length === 0 ? "" : `no session check in: ${missing.join(", ")}`,
  )

  // …and the gate they delegate to must itself consult the session, or the
  // delegation is a longer way of not checking.
  const gateSrc = blankComments(raw(GATES))
  const span = functionBody(gateSrc, "resolveExternalPartnerIdentity")
  const gateOk = check(
    "G2b resolveExternalPartnerIdentity itself calls auth.getUser()",
    !!span && callsGetUser(gateSrc.slice(span[0], span[1])),
    span ? "" : `resolveExternalPartnerIdentity not found in ${GATES}`,
  )
  return routesOk && gateOk
}

// ─────────────────────────────────────────────────────────────────────────────
// G3 — the membership predicate is keyed on the RESOLVED identity
// ─────────────────────────────────────────────────────────────────────────────
const IDENTITY_COLUMNS = ["user_id", "vendor_id"]

function assertLanePredicateUsesResolvedIdentity(): boolean {
  const src = blankComments(raw(GATES))
  const span = functionBody(src, "externalPartnerTransactionLane")
  if (!span) {
    return check("G3  the membership predicate is keyed on the resolved identity", false,
      `externalPartnerTransactionLane not found in ${GATES}`)
  }
  const body = src.slice(span[0], span[1])
  const eq = /\.\s*eq\s*\(\s*["']([a-z_]+)["']\s*,\s*([^)]+)\)/g
  let m: RegExpExecArray | null
  const offenders: string[] = []
  let checked = 0
  while ((m = eq.exec(body)) !== null) {
    if (!IDENTITY_COLUMNS.includes(m[1])) continue
    checked++
    if (!/^identity\s*[.?]/.test(m[2].trim())) offenders.push(`.eq("${m[1]}", ${m[2].trim()})`)
  }
  if (checked === 0) {
    return check("G3  the membership predicate is keyed on the resolved identity", false,
      "no identity-column predicate found in externalPartnerTransactionLane — the gate lost its subject")
  }
  return check(
    `G3  all ${checked} identity-column predicate(s) in externalPartnerTransactionLane read the RESOLVED identity`,
    offenders.length === 0,
    offenders.length === 0 ? "" : `keyed on something else: ${offenders.join(", ")}`,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Insert sites (shared by G4 and G5)
// ─────────────────────────────────────────────────────────────────────────────
interface InsertSite { file: string; line: number; entries: Array<{ key: string; value: string }>; hasObjectArg: boolean }

function insertSites(file: string, table: string): InsertSite[] {
  const src = blankComments(raw(file))
  const sites: InsertSite[] = []
  const from = new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)`, "g")
  let m: RegExpExecArray | null
  while ((m = from.exec(src)) !== null) {
    const after = m.index + m[0].length
    const window = src.slice(after, after + 4000)
    const ins = /^[\s\S]{0,400}?\.\s*(?:insert|upsert)\s*\(/.exec(window)
    if (!ins) continue
    const openParen = after + ins[0].length - 1
    let i = openParen + 1
    while (i < src.length && /[\s[]/.test(src[i])) i++
    const line = src.slice(0, m.index).split("\n").length
    if (src[i] !== "{") { sites.push({ file, line, entries: [], hasObjectArg: false }); continue }
    sites.push({ file, line, entries: topLevelEntries(src, i), hasObjectArg: true })
  }
  return sites
}

function filesTouching(table: string): string[] {
  try {
    const out = execFileSync("git", ["grep", "-l", "--", `from("${table}")`, "--", "app", "lib", "scripts"],
      { cwd: ROOT, encoding: "utf8" })
    return out.split("\n").filter((f) => f.endsWith(".ts") || f.endsWith(".tsx")).filter((f) => f !== SELF)
  } catch {
    return [DOWNLOAD]
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// G4 — the download audit row stamps the two lanes dd_select reads
// ─────────────────────────────────────────────────────────────────────────────
const DD_REQUIRED = ["user_id", "brokerage_id"]

function assertDownloadAuditRowIsReadable(): boolean {
  const offenders: string[] = []
  let total = 0
  for (const f of filesTouching("document_downloads")) {
    if (!existsSync(resolve(ROOT, f))) continue
    for (const s of insertSites(f, "document_downloads")) {
      total++
      if (!s.hasObjectArg) {
        offenders.push(`${f}:${s.line} (insert argument is not an object literal — cannot prove the stamp)`)
        continue
      }
      const keys = s.entries.map((e) => e.key)
      const missing = DD_REQUIRED.filter((k) => !keys.includes(k))
      if (missing.length) offenders.push(`${f}:${s.line} missing ${missing.join(" + ")}`)
    }
  }
  if (total === 0) {
    return check("G4  every document_downloads insert stamps user_id + brokerage_id", false,
      "no document_downloads insert found anywhere — the audit trail was deleted, not fixed")
  }
  return check(
    `G4  all ${total} document_downloads insert site(s) stamp ${DD_REQUIRED.join(" + ")} at DEPTH 1 (the lanes dd_select reads)`,
    offenders.length === 0,
    offenders.join("; "),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// G5 — the action's audit row names a human
// ─────────────────────────────────────────────────────────────────────────────
function assertActionAuditRowNamesAHuman(): boolean {
  const sites = insertSites(COMPLETE, "audit_log")
  if (sites.length === 0) {
    return check("G5  the audit_log insert in actions/complete stamps a real user_id", false,
      `no audit_log insert found in ${COMPLETE} — the record of the action was removed, not repaired`)
  }
  const offenders: string[] = []
  for (const s of sites) {
    const entry = s.entries.find((e) => e.key === "user_id")
    if (!entry) { offenders.push(`${s.file}:${s.line} no user_id key`); continue }
    if (/^null$/.test(entry.value) || /^undefined$/.test(entry.value)) {
      offenders.push(`${s.file}:${s.line} user_id: ${entry.value} — al_select cannot show this row to the partner who acted`)
    }
  }
  return check(
    `G5  all ${sites.length} audit_log insert(s) in actions/complete stamp a non-null user_id`,
    offenders.length === 0,
    offenders.join("; "),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// G6 — every supabase read on this path destructures `error`
// ─────────────────────────────────────────────────────────────────────────────
function fromSitesWithoutError(file: string, fnName?: string): string[] {
  const src = blankComments(raw(file))
  let lo = 0, hi = src.length
  if (fnName) {
    const span = functionBody(src, fnName)
    if (!span) return [`${file}: ${fnName} not found`]
    ;[lo, hi] = span
  }
  const out: string[] = []
  const re = /\.from\(\s*["']([a-z_]+)["']\s*\)/g
  re.lastIndex = lo
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (m.index >= hi) break
    const before = src.slice(Math.max(lo, m.index - 400), m.index)
    const assign = /const\s*\{([^}]*)\}\s*=\s*await\s*[^;]*$/.exec(before)
    const bindings = assign ? assign[1] : ""
    if (!/\berror\b/.test(bindings)) {
      out.push(`${file}:${src.slice(0, m.index).split("\n").length} .from("${m[1]}") bound as {${bindings.trim()}}`)
    }
  }
  return out
}

function assertReadsDestructureError(): boolean {
  const offenders = [
    ...fromSitesWithoutError(DOWNLOAD),
    ...fromSitesWithoutError(COMPLETE),
    ...fromSitesWithoutError(GATES, "resolveExternalPartnerIdentity"),
    ...fromSitesWithoutError(GATES, "externalPartnerTransactionLane"),
  ]
  return check(
    "G6  every supabase call on the external-portal path destructures `error` (a refusal is not an absence)",
    offenders.length === 0,
    offenders.join("; "),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// G7 — the routes still exist and still gate
// ─────────────────────────────────────────────────────────────────────────────
function assertRoutesStillGate(): boolean {
  const files = routeFiles()
  const enough = check(
    `G7a ${PORTAL_DIR}/ still holds >= ${ROUTE_FLOOR} route(s) (found ${files.length})`,
    files.length >= ROUTE_FLOOR,
    files.length >= ROUTE_FLOOR ? "" : "routes disappeared rather than being fixed",
  )
  const ungated: string[] = []
  for (const f of files) {
    const src = blankComments(raw(f))
    const resolves = /\bresolveExternalPartnerIdentity\s*\(/.test(src)
    const has401 = /status:\s*401/.test(src)
    if (!resolves || !has401) {
      ungated.push(`${f}${resolves ? "" : " (no identity resolution)"}${has401 ? "" : " (no 401 branch)"}`)
    }
  }
  const gated = check(
    "G7b each route resolves the caller's partner identity AND answers 401 when there is no session",
    ungated.length === 0,
    ungated.join("; "),
  )
  return enough && gated
}

// ─────────────────────────────────────────────────────────────────────────────
// G8 — THE TITLE GATE IS ON THE VENDOR RAIL (wave 155, lane 155T3)
//
// CLAUDE.md §4: "A LENDER IS NOT A USER TYPE — it is a VENDOR CATEGORY, and so is a title agent." The old title
// rail was public.title_company_users: 0 live rows, no writer in app code, triggers or functions — so the old gate
// (requireTitleActor) could never admit anyone, and every title surface hung off it. The rule now held: no app/ or
// lib/ CODE reads that table; the one title gate is resolveTitleVendorActor (session → vendor role row → title
// category → vendor_assignments on the deal, in the vendor's own tenant); no caller-supplied titleUserId survives.
// ─────────────────────────────────────────────────────────────────────────────
const DEAD_TITLE_READ = /\.from\(\s*["']title_company_users["']\s*\)/
const CLAIMED_TITLE_ID = /\btitleUserId\b/

function codeFilesUnder(...dirs: string[]): string[] {
  const out: string[] = []
  for (const d of dirs) for (const p of walkTs(resolve(ROOT, d))) out.push(relative(ROOT, p))
  return out.sort()
}

function assertTitleGateOnVendorRail(): boolean {
  const files = codeFilesUnder("app", "lib")
  const deadReaders = files.filter((f) => DEAD_TITLE_READ.test(blankComments(raw(f))))
  const a = check(`G8a no app/ or lib/ code reads title_company_users (${files.length} files scanned, comments blanked)`, deadReaders.length === 0, deadReaders.join(", "))
  const claimed = files.filter((f) => CLAIMED_TITLE_ID.test(blankComments(raw(f))))
  const b = check("G8b no caller-supplied titleUserId survives in app/ or lib/ code (the actor is the SESSION's title vendor seat)", claimed.length === 0, claimed.join(", "))

  const src = blankComments(raw(GATES))
  const span = functionBody(src, "resolveTitleVendorActor")
  const body = span ? src.slice(span[0], span[1]) : ""
  const at = (re: RegExp) => body.search(re)
  const getUserAt = at(/\.auth\.getUser\(\)/), roleAt = at(/\.from\(\s*["']user_role_assignments["']\s*\)/)
  const catAt = at(/\bisTitleVendorCategory\(/), assignAt = at(/\.from\(\s*["']vendor_assignments["']\s*\)/)
  const c = check("G8c resolveTitleVendorActor reads session → vendor role row → title category → vendor_assignments, in that order",
    !!span && getUserAt >= 0 && getUserAt < roleAt && roleAt < catAt && catAt < assignAt,
    span ? `getUser@${getUserAt} role@${roleAt} category@${catAt} assignment@${assignAt}` : `resolveTitleVendorActor not found in ${GATES}`)
  const assignRead = assignAt >= 0 ? body.slice(assignAt, assignAt + 400) : ""
  const d = check("G8d the assignment read is keyed on the resolved vendor, THIS transaction and the vendor's OWN brokerage",
    /\.eq\(\s*["']vendor_id["']\s*,\s*v\.id\s*\)/.test(assignRead) && /\.eq\(\s*["']transaction_id["']\s*,\s*transactionId\s*\)/.test(assignRead)
      && /\.eq\(\s*["']brokerage_id["']\s*,\s*v\.brokerage_id\s*\)/.test(assignRead), assignRead.slice(0, 200))
  const reqSpan = functionBody(src, "requireTitleVendorActor")
  const e = check("G8e requireTitleVendorActor delegates to resolveTitleVendorActor, and the claimed-id gate requireTitleActor is gone (one gate, not two)",
    !!reqSpan && /\bresolveTitleVendorActor\(/.test(src.slice(reqSpan[0], reqSpan[1])) && !/\bfunction\s+requireTitleActor\b/.test(src))
  const definers = files.filter((f) => /\bfunction\s+isTitleVendorCategory\b/.test(blankComments(raw(f))))
  const f = check("G8f the title category test is stated ONCE, in lib/kernel/lender-linkage.ts", definers.length === 1 && definers[0] === "lib/kernel/lender-linkage.ts", definers.join(", "))
  const pc = check("G8 POSITIVE CONTROL the finders see a live dead-rail read and a claimed id, and ignore both when commented out",
    DEAD_TITLE_READ.test(blankComments('const r = await s.from("title_company_users").select("id")\n'))
      && !DEAD_TITLE_READ.test(blankComments('// const r = await s.from("title_company_users").select("id")\n'))
      && CLAIMED_TITLE_ID.test(blankComments("await updateTitleStatus({ transactionId, titleUserId: row.id })\n"))
      && !CLAIMED_TITLE_ID.test(blankComments("// TOMBSTONE: titleUserId is gone\n")))
  return a && b && c && d && e && f && pc
}

// ─────────────────────────────────────────────────────────────────────────────
// G9 — THE TITLE GATE, DRIVEN (SIMULATED: in-memory client; the session is a seam, nothing else is stubbed)
// The REAL resolveTitleVendorActor and resolveExternalPartnerIdentity / externalPartnerTransactionLane are run against
// an in-memory world. Each refusal must land BEFORE any deal read (transactions / transaction_title_escrow), and the
// two seat refusals before even the assignment read.
// ─────────────────────────────────────────────────────────────────────────────
async function assertTitleGateDriven(): Promise<boolean> {
  const { memSupabase } = await import("./in-memory-supabase")
  const pa = await import("../lib/kernel/portal-auth")
  const B1 = "b1000000-0000-4000-8000-000000000001", B2 = "b2000000-0000-4000-8000-000000000002"
  const TX = "d1000000-0000-4000-8000-000000000001", TX_OTHER = "d2000000-0000-4000-8000-000000000002"
  const V_T1 = "e1000000-0000-4000-8000-000000000001", V_I = "e2000000-0000-4000-8000-000000000002"
  const V_T2 = "e3000000-0000-4000-8000-000000000003", V_T3 = "e4000000-0000-4000-8000-000000000004"
  const U_TITLE = "u-title", U_INSPECTOR = "u-inspector", U_OTHER_TENANT = "u-other-tenant", U_OFF_DEAL = "u-off-deal"
  const world = (opts: { refuse?: Record<string, string> } = {}) => memSupabase({
    user_role_assignments: [
      { id: "r1", user_id: U_TITLE, vendor_id: V_T1, vendors: { id: V_T1, name: "Bay Title", phone: "555-0100", category: "title", brokerage_id: B1 } },
      { id: "r2", user_id: U_INSPECTOR, vendor_id: V_I, vendors: { id: V_I, name: "Shield Inspections", phone: null, category: "inspector", brokerage_id: B1 } },
      { id: "r3", user_id: U_OTHER_TENANT, vendor_id: V_T2, vendors: { id: V_T2, name: "Elsewhere Title", phone: null, category: "title", brokerage_id: B2 } },
      { id: "r4", user_id: U_OFF_DEAL, vendor_id: V_T3, vendors: { id: V_T3, name: "Idle Title", phone: null, category: "title", brokerage_id: B1 } },
    ],
    vendor_assignments: [
      { id: "a1", vendor_id: V_T1, transaction_id: TX, brokerage_id: B1 },
      { id: "a2", vendor_id: V_I, transaction_id: TX, brokerage_id: B1 },       // the inspector IS on the deal: only the category refuses it
      { id: "a3", vendor_id: V_T2, transaction_id: TX, brokerage_id: B1 },      // a row naming B1's deal for B2's title vendor: the tenant predicate refuses it
      { id: "a4", vendor_id: V_T3, transaction_id: TX_OTHER, brokerage_id: B1 },
    ],
    users: [{ id: U_TITLE, brokerage_id: B1, user_type: "vendor" }, { id: U_INSPECTOR, brokerage_id: B1, user_type: "vendor" }],
    transactions: [{ id: TX, brokerage_id: B1 }, { id: TX_OTHER, brokerage_id: B1 }],
    transaction_title_escrow: [{ id: "te1", transaction_id: TX, brokerage_id: B1, title_company_email: "closer@baytitle.example" }],
  }, { refuse: opts.refuse })
  // memSupabase splits a select on commas and cannot project an embed; the seeded row carries the embed's shape and
  // this thin view selects it whole. Every table touched is recorded, so "refused before any deal read" is observed.
  const seam = (uid: string | null, mem = world()) => {
    const reads: string[] = []
    const client = {
      auth: { getUser: async () => ({ data: { user: uid ? { id: uid, email: `${uid}@example.test` } : null }, error: null }) },
      from: (t: string) => { reads.push(t); const q = mem.from(t) as any; const sel = q.select.bind(q); q.select = (c?: string) => sel(c && /!inner\(/.test(c) ? "*" : c); return q },
    }
    return { client, reads }
  }
  const DEAL_TABLES = ["transactions", "transaction_title_escrow"]
  const noDealRead = (reads: string[]) => !reads.some((t) => DEAL_TABLES.includes(t))
  const results: boolean[] = []
  const run = async (uid: string | null, tx: string | null, mem?: ReturnType<typeof world>) => { const s = seam(uid, mem); const r = await pa.resolveTitleVendorActor(s.client, tx); return { r, reads: s.reads } }

  let x = await run(null, TX)
  results.push(check("G9a NEG no session → unauthenticated, and NOTHING is read", !x.r.ok && x.r.reason === "unauthenticated" && x.reads.length === 0, JSON.stringify(x)))
  x = await run(U_INSPECTOR, TX)
  results.push(check("G9b NEG a vendor seat whose vendor is NOT a title category (an inspector assigned to this very deal) → not_title_vendor, before the assignment or any deal read",
    !x.r.ok && x.r.reason === "not_title_vendor" && !x.reads.includes("vendor_assignments") && noDealRead(x.reads), JSON.stringify(x)))
  x = await run(U_OTHER_TENANT, TX)
  results.push(check("G9c NEG a title vendor of ANOTHER tenant (even with an assignment row naming this deal) → not_on_deal, no deal read",
    !x.r.ok && x.r.reason === "not_on_deal" && noDealRead(x.reads), JSON.stringify(x)))
  x = await run(U_OFF_DEAL, TX)
  results.push(check("G9d NEG a title vendor of THIS tenant that is not on the deal → not_on_deal, no deal read", !x.r.ok && x.r.reason === "not_on_deal" && noDealRead(x.reads), JSON.stringify(x)))
  x = await run(U_TITLE, TX, world({ refuse: { user_role_assignments: "permission denied for table user_role_assignments" } }))
  results.push(check("G9e NEG a refused role read is REFUSED (fail closed) — never spoken as 'not a title vendor'", !x.r.ok && x.r.reason === "refused", JSON.stringify(x)))
  x = await run(U_TITLE, "")
  results.push(check("G9f NEG an empty deal id is refused, not read as 'no deal named'", !x.r.ok && x.r.reason === "not_on_deal" && x.reads.length === 0, JSON.stringify(x)))
  x = await run(U_TITLE, TX)
  results.push(check("G9g POS the deal's title vendor is admitted: vendor id, tenant and company name come from the vendor row, the user from the session",
    x.r.ok && x.r.actor.vendorId === V_T1 && x.r.actor.brokerageId === B1 && x.r.actor.companyName === "Bay Title" && x.r.actor.userId === U_TITLE && noDealRead(x.reads), JSON.stringify(x)))
  x = await run(U_TITLE, null)
  results.push(check("G9h POS with no deal named (a dashboard) the title seat resolves to its own vendor and tenant", x.r.ok && x.r.actor.vendorId === V_T1 && x.r.actor.brokerageId === B1, JSON.stringify(x)))

  // The external-portal routes' resolver rides the SAME rail: a title vendor seat is a title partner with a lane on its
  // assigned deal only; an inspector (a plain vendor) gets no title lane.
  const titleId = await pa.resolveExternalPartnerIdentity(seam(U_TITLE).client)
  const ownLane = titleId.ok ? await pa.externalPartnerTransactionLane(seam(U_TITLE).client, titleId.identity, TX) : null
  const otherLane = titleId.ok ? await pa.externalPartnerTransactionLane(seam(U_TITLE).client, titleId.identity, TX_OTHER) : null
  const inspId = await pa.resolveExternalPartnerIdentity(seam(U_INSPECTOR).client)
  const inspLane = inspId.ok ? await pa.externalPartnerTransactionLane(seam(U_INSPECTOR).client, inspId.identity, TX) : null
  results.push(check("G9i the external-portal identity: a title VENDOR seat is a title partner with a lane on its assigned deal only; an inspector seat has no title lane",
    titleId.ok && titleId.identity.isTitlePartner && titleId.identity.titleVendorId === V_T1 && titleId.identity.partnerTypes.includes("title")
      && ownLane?.ok === true && (ownLane as { grantedVia?: string }).grantedVia === "title" && otherLane?.ok === false
      && inspId.ok && !inspId.identity.isTitlePartner && inspLane?.ok === false,
    JSON.stringify({ titleId, ownLane, otherLane, inspId, inspLane })))
  return results.every(Boolean)
}

// ─────────────────────────────────────────────────────────────────────────────
// NEGATIVE CONTROLS
// ─────────────────────────────────────────────────────────────────────────────
interface Control { file: string; find: string; replace: string }

/** Apply, VERIFY IT APPLIED, run, require RED, restore, verify by sha256. */
function controlled(label: string, c: Control, fn: () => boolean): void {
  runControl(label, c, fn, /* expectRed */ true)
}

/** The inverted form: the patch must NOT trip the assertion. */
function controlledStaysGreen(label: string, c: Control, fn: () => boolean): void {
  runControl(label, c, fn, /* expectRed */ false)
}

function runControl(label: string, c: Control, fn: () => boolean, expectRed: boolean): void {
  const before = raw(c.file)
  const beforeSha = sha(c.file)
  const after = before.replace(c.find, c.replace)

  if (after === before) {
    console.log(`  ✗ NEGATIVE CONTROL ${label} — PATCH DID NOT APPLY (find-string not found); control proves nothing`)
    failures.push(`negative control did not apply: ${label}`)
    return
  }

  writeFileSync(resolve(ROOT, c.file), after)
  let ok = false
  try {
    const marker = failures.length
    ok = fn()
    while (failures.length > marker) failures.pop()
  } finally {
    writeFileSync(resolve(ROOT, c.file), before)
    if (sha(c.file) !== beforeSha) {
      failures.push(`FAILED TO RESTORE ${c.file}`)
      console.log(`  ✗ FAILED TO RESTORE ${c.file}`)
      return
    }
  }

  if (expectRed) {
    if (!ok) console.log(`  ✓ NEGATIVE CONTROL ${label} — went RED as required`)
    else {
      console.log(`  ✗ NEGATIVE CONTROL ${label} — STAYED GREEN with the defect present`)
      failures.push(`negative control stayed green: ${label}`)
    }
  } else {
    if (ok) console.log(`  ✓ SPECIFICITY CONTROL ${label} — stayed GREEN as required`)
    else {
      console.log(`  ✗ SPECIFICITY CONTROL ${label} — went RED; the check is a spelling match, not a construct`)
      failures.push(`specificity control went red: ${label}`)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("EXTERNAL-PORTAL SESSION-IDENTITY GUARD — the authorization subject comes from the session\n")

  console.log("ASSERTIONS")
  assertNoIdentityFromRequest()
  assertEveryRouteConsultsSession()
  assertLanePredicateUsesResolvedIdentity()
  assertDownloadAuditRowIsReadable()
  assertActionAuditRowNamesAHuman()
  assertReadsDestructureError()
  assertRoutesStillGate()
  assertTitleGateOnVendorRail()
  await assertTitleGateDriven()

  console.log(`\n  ${PORTAL_DIR}/: ${routeFiles().length} route file(s) — ${routeFiles().join(", ")}`)

  if (RUN_NEGATIVE) {
    console.log("\nNEGATIVE CONTROLS")

    // 1. THE CONTROL THE BRIEF NAMES: `partnerId` comes back from the query
    //    string and becomes the subject again. This is W22-1 exactly.
    controlled(
      "partnerId reintroduced as searchParams.get(\"partnerId\") in the download route",
      {
        file: DOWNLOAD,
        find: '    const docId = searchParams.get("docId")',
        replace: '    const docId = searchParams.get("docId")\n    const partnerId = searchParams.get("partnerId")',
      },
      assertNoIdentityFromRequest,
    )

    // 2. The same defect in its OTHER shape — destructured off the JSON body,
    //    which is how the action route carried it.
    controlled(
      "partnerId/partnerType destructured from the request body in the action route",
      {
        file: COMPLETE,
        find: "    const { actionId, context } = await request.json()",
        replace:
          "    const { actionId, context } = await request.json()\n" +
          "    const { partnerId, partnerType } = context ?? {}",
      },
      assertNoIdentityFromRequest,
    )

    // 3. …and in its member-access shape, which no destructuring scan would see.
    controlled(
      "the action route reads context.partnerId directly",
      {
        file: COMPLETE,
        find: "    const claimedTransactionId: string | null =",
        replace:
          "    const claimedPartner = context?.partnerId\n" +
          "    const claimedTransactionId: string | null =",
      },
      assertNoIdentityFromRequest,
    )

    // 4. The session check removed from the gate the routes delegate to. The
    //    routes still LOOK gated; nothing is checked.
    controlled(
      "resolveExternalPartnerIdentity stops calling auth.getUser()",
      {
        file: GATES,
        find: "  const { data: authData, error: authError } = await supabase.auth.getUser()",
        replace: "  const { data: authData, error: authError } = { data: { user: null }, error: null } as any",
      },
      assertEveryRouteConsultsSession,
    )

    // 5. THE QUIET REVERT: the getUser() call stays, and the membership
    //    predicate goes back to a free variable. This is the one that would slip
    //    through a "does it call getUser" check.
    controlled(
      "the title membership predicate re-keyed off a free variable instead of the resolved identity",
      {
        file: GATES,
        find: '      .eq("vendor_id", identity.titleVendorId) // ← resolved from the session, not the request',
        replace: '      .eq("vendor_id", (identity as any).claimedVendorId)',
      },
      assertLanePredicateUsesResolvedIdentity,
    )

    // 6. The audit row loses the uid lane — invisible to the partner who
    //    downloaded, exactly as measured live (0 rows visible to its writer).
    controlled(
      "the document_downloads insert loses user_id",
      {
        file: DOWNLOAD,
        find: "      user_id: identity.userId,\n      partner_id:",
        replace: "      partner_id:",
      },
      assertDownloadAuditRowIsReadable,
    )

    // 7. …and the brokerage lane, so the brokerage whose document left the
    //    building cannot see that it did.
    controlled(
      "the document_downloads insert loses brokerage_id",
      {
        file: DOWNLOAD,
        find: "      brokerage_id: document.brokerage_id ?? identity.brokerageId,\n",
        replace: "",
      },
      assertDownloadAuditRowIsReadable,
    )

    // 8. THE SPELLING TRAP. `user_id` demoted into the nested `after` payload —
    //    the seven letters are still in the call, at the wrong depth, stamping
    //    nothing that `al_select` can read.
    controlled(
      "audit_log user_id demoted to NULL with the value moved into the nested payload",
      {
        file: COMPLETE,
        find: "        user_id: identity.userId,\n        after: {",
        replace: "        user_id: null,\n        after: {\n          user_id: identity.userId,",
      },
      assertActionAuditRowNamesAHuman,
    )

    // 9. The document read stops destructuring `error` — a refused read becomes
    //    a clean 404 and the outage is invisible forever.
    controlled(
      "the download route's document read stops destructuring `error`",
      {
        file: DOWNLOAD,
        find: "    const { data: document, error: docError } = await supabase",
        replace: "    const { data: document } = await supabase",
      },
      assertReadsDestructureError,
    )

    // 10. The membership read inside the gate stops destructuring `error` — the
    //     gate then fails OPEN INTO A DENIAL.
    controlled(
      "the lane helper's vendor_assignments read stops destructuring `error`",
      {
        file: GATES,
        find: "    const { data: assignment, error: assignmentError } = await supabase",
        replace: "    const { data: assignment } = await supabase",
      },
      assertReadsDestructureError,
    )

    // 11. The route deleted rather than fixed — G1 goes green on a file that
    //     does not gate at all.
    controlled(
      "the action route stops resolving the caller's identity",
      {
        file: COMPLETE,
        find: "    const caller = await resolveExternalPartnerIdentity(supabase)",
        replace: "    const caller = { ok: true, identity: { userId: null } } as any",
      },
      assertRoutesStillGate,
    )

    // 14. THE DEAD TITLE RAIL comes back — a gate that reads title_company_users (0 rows, no writer) admits nobody.
    controlled(
      "a title_company_users read reintroduced into the title gate",
      {
        file: GATES,
        find: '  const { isTitleVendorCategory } = await import("@/lib/kernel/lender-linkage")',
        replace: '  const { data: legacyTitleRows } = await supabase.from("title_company_users").select("id").eq("user_id", user.id)\n  const { isTitleVendorCategory } = await import("@/lib/kernel/lender-linkage")',
      },
      assertTitleGateOnVendorRail,
    )

    // 15. THE TENANT PREDICATE dropped from the assignment read — a title vendor of another brokerage named on a row
    //     for this deal would be admitted.
    controlled(
      "the title gate's assignment read loses its brokerage predicate",
      {
        file: GATES,
        find: '      .eq("transaction_id", transactionId)\n      .eq("brokerage_id", v.brokerage_id)\n',
        replace: '      .eq("transaction_id", transactionId)\n',
      },
      assertTitleGateOnVendorRail,
    )

    // 16. A caller-supplied titleUserId comes back as an authority on a title action.
    controlled(
      "titleUserId reintroduced into a title action's input",
      {
        file: "app/actions/title-portal.ts",
        find: "  transactionId: string\n  newStatus: TitleStatus\n",
        replace: "  transactionId: string\n  titleUserId: string\n  newStatus: TitleStatus\n",
      },
      assertTitleGateOnVendorRail,
    )

    // 17. SPECIFICITY: the dead read written only as a COMMENT (a tombstone) must stay green — a tombstone is not a
    //     call site (CLAUDE.md §2).
    controlledStaysGreen(
      "the dead title read present only as a COMMENT",
      {
        file: GATES,
        find: '  const { isTitleVendorCategory } = await import("@/lib/kernel/lender-linkage")',
        replace: '  // was: await supabase.from("title_company_users").select("id")\n  const { isTitleVendorCategory } = await import("@/lib/kernel/lender-linkage")',
      },
      assertTitleGateOnVendorRail,
    )

    // 12. SPECIFICITY: the defect written as a COMMENT. A guard that reads prose
    //     as code would flag this, and the whole point is that a comment is
    //     never evidence — in either direction.
    controlledStaysGreen(
      "the identity read present only as a COMMENT",
      {
        file: DOWNLOAD,
        find: '    const docId = searchParams.get("docId")',
        replace:
          '    const docId = searchParams.get("docId")\n' +
          '    // const partnerId = searchParams.get("partnerId")   // never again',
      },
      assertNoIdentityFromRequest,
    )

    // 13. SPECIFICITY: a RESOURCE id taken from the request is not an identity.
    //     A guard that flags every searchParams.get() would forbid the route
    //     from being told which document to serve.
    controlledStaysGreen(
      "another resource id read from the query string",
      {
        file: DOWNLOAD,
        find: '    const docId = searchParams.get("docId")',
        replace:
          '    const docId = searchParams.get("docId")\n' +
          '    const versionId = searchParams.get("versionId")',
      },
      assertNoIdentityFromRequest,
    )
  }

  console.log("")
  if (failures.length) {
    console.log(`FAILED (${failures.length})`)
    for (const f of failures) console.log(`  · ${f}`)
    process.exit(1)
  }
  console.log("PASSED")
}

main().catch((e) => { console.error(e); process.exit(1) })

