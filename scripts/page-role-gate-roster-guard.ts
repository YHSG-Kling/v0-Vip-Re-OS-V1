#!/usr/bin/env tsx
/**
 * scripts/page-role-gate-roster-guard.ts   (npm run test:page-role-gate-roster)
 * ─────────────────────────────────────────────────────────────────────────────
 * A PAGE GATE SPELLS THE ROSTER ONCE — AND A BLANK SCREEN IS NEVER THE ANSWER.
 *
 * Lane 89D (wave 89 production walkthrough; owner: "walk through every section
 * of the platform … note any areas of improvement, areas that need fixing").
 * Walking every role's sidebar against the page it lands on found a class of
 * defect the link sweeps cannot see, because the link resolves: the page then
 * gates on a HAND-SPELLED role literal — `role !== 'broker' && role !== 'admin'`,
 * `user_type !== "admin"`, `["broker", "admin"].includes(userRole)` — and
 * `redirect("/dashboard")`s everyone else. The tenant roster is SIX types
 * (CLAUDE.md §4: admin, broker, broker_owner, broker_admin, team_lead,
 * compliance_officer, the code being TENANT_ADMIN_USER_TYPES), so a broker
 * OWNER clicking "Intelligence Center", "AI Coordination", "Brand & Compliance"
 * or "Education Library" in the sidebar that links them was bounced to the
 * dashboard with no explanation — "a click that appeared to do nothing", the
 * exact symptom the walkthrough already ruled on for /dashboard/settings/usage.
 * Measured on base 1e4fac17: 6 literal gates across 6 pages (coordination,
 * brokerage/intelligence, admin/brand, education, financials/team ×2,
 * financials/commissions) — and P1b's FIRST run found 4 more in allow-list
 * clothing that the lane's hand grep had been blind to (admin/forms, the QR
 * board's notFound(), the transaction detail and its CDA): 10 pages in all.
 *
 * WHAT IS HELD (populations DERIVED from the tree, never listed):
 *   P1 LITERAL-GATE CENSUS — in every app/**\/page.tsx and layout.tsx, a
 *      `=== / !==` comparison of a role-shaped identifier against a tenant-
 *      roster literal that sits within a redirect gate (a `redirect(` in the
 *      next lines) is a finding. Roster membership is READ from
 *      lib/auth/resolve-user-role.ts's TENANT_ADMIN_USER_TYPES, not retyped.
 *      Baseline 0 (burn-down: this number may only fall).
 *   P1b ALLOW-LIST LADDERS — an inline `[...].includes(role)` that names
 *      `broker` but neither `broker_owner` nor `broker_admin` is the same
 *      defect in array clothing (financials/team, admin/forms, agent/qr-codes,
 *      transactions/[id] and its cda were five). Baseline 0. A ladder that
 *      names an owner spelling (deal-health's, fatigue's) is a deliberate
 *      inline roster and passes.
 *   P2 THE FIXED GATES CALL THE ONE PREDICATE — each page named above imports
 *      a roster predicate from lib/auth/resolve-user-role.ts and no longer
 *      carries a literal gate. (The rule, not the spelling: any predicate
 *      exported by that module satisfies it.)
 *   P3 ERROR-STATE COVERAGE — app/error.tsx and app/not-found.tsx exist (the
 *      root boundaries; measured absent on base: 4 error.tsx files covered
 *      /dashboard/**, /settings/** and one contact route, and NOTHING covered
 *      /crm, /leads, /portal/**, /vendor/**, /lender/**, /title/**,
 *      /transaction/**, /compliance/** or any public page — a throw there was
 *      a blank screen); every error.tsx in the tree is a client component that
 *      accepts `reset`. Derived over the tree.
 *   P4 RoleGateNotice is server-safe: no "use client", no hook call, exported.
 *
 * POSITIVE CONTROLS (§2): the pre-89D coordination gate, replayed as a
 * specimen, is flagged; the same text inside a block comment is not; the
 * post-89D gate is not; an `["broker","admin"].includes` ladder is flagged
 * while `["broker","broker_owner","broker_admin","admin","tc"]` (deal-health's
 * deliberate ladder, which also admits tc) is not; a boundary specimen without
 * "use client" fails the P3 checker.
 *
 * BLIND SPOTS (published beside the numbers): P1 is LEXICAL and LOCAL — a
 * literal comparison whose redirect sits more than 6 lines below, or that
 * gates by `return null`, is not seen (over-permissive, never over-accusing);
 * a scope CHOICE (`isBrokerOrAdmin ? brokerage : own`, e.g.
 * app/dashboard/analytics/source) is not a gate and is deliberately out of
 * scope — those are listed in the lane notes as findings, not held here;
 * `user_type === 'superadmin'` arms are dead (§4) but harmless and are not
 * counted; layouts that gate client-side through useAuth are read the same
 * way as pages (the finder does not know which side renders).
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { blankComments, stringLiterals } from "./strip-comments"

// ESM scope (package.json "type": "module"): no __dirname.
const ROOT = fileURLToPath(new URL("..", import.meta.url))
const APP = join(ROOT, "app")

// The roster is READ from the source of lib/auth/resolve-user-role.ts rather
// than imported: importing the module drags the auth/supabase graph into a
// proof that only needs six strings, and a proof that hangs on an open client
// handle is a proof nobody runs. The literals come from the comment-stripped
// `TENANT_ADMIN_USER_TYPES = new Set([...])` initializer, so a tombstone that
// quotes a retired spelling can never leak into the roster (§2).
const ROSTER_SOURCE = join(ROOT, "lib/auth/resolve-user-role.ts")
function readTenantAdminRoster(): Set<string> {
  const src = blankComments(readFileSync(ROSTER_SOURCE, "utf8"))
  const start = src.indexOf("export const TENANT_ADMIN_USER_TYPES = new Set([")
  if (start < 0) throw new Error("TENANT_ADMIN_USER_TYPES initializer not found in lib/auth/resolve-user-role.ts")
  const end = src.indexOf("])", start)
  const init = src.slice(start, end)
  const names = stringLiterals(init).map((l) => l.text).filter((v) => /^[a-z_]+$/.test(v))
  if (names.length < 4) throw new Error(`roster read failed (${names.length} names)`)
  return new Set(names)
}
const TENANT_ADMIN_USER_TYPES = readTenantAdminRoster()

let passed = 0
let failed = 0
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { passed++; console.log(` ✓ ${name}`) }
  else { failed++; console.log(` ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

function walk(dir: string, pick: (f: string) => boolean, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, pick, out)
    else if (pick(e)) out.push(p)
  }
  return out
}

// ── P1 / P1b finders (exported for the positive controls below) ──────────────
const ROSTER = [...TENANT_ADMIN_USER_TYPES]
const ROLE_IDENT = "(?:user_type|userType|role|userRole|callerType|callerRole|profile\\.user_type|context\\.userType|ctx\\.userType)"
const LITERAL_CMP = new RegExp(
  `${ROLE_IDENT}\\s*(?:!==|===)\\s*['"](${ROSTER.join("|")})['"]`, "g",
)
const LADDER = /\[\s*((?:['"][a-z_]+['"]\s*,?\s*)+)\]\s*\.includes\(/g
const GATE_WINDOW_LINES = 6

type Finding = { line: number; text: string }

/** P1: literal role comparisons that sit in a redirect gate. */
function findLiteralGates(source: string): Finding[] {
  const src = blankComments(source)
  const lines = src.split("\n")
  const out: Finding[] = []
  const seen = new Set<number>()
  let m: RegExpExecArray | null
  LITERAL_CMP.lastIndex = 0
  while ((m = LITERAL_CMP.exec(src))) {
    const line = src.slice(0, m.index).split("\n").length
    if (seen.has(line)) continue
    const window = lines.slice(line - 1, line - 1 + GATE_WINDOW_LINES).join("\n")
    if (/\bredirect\(/.test(window)) {
      seen.add(line)
      out.push({ line, text: lines[line - 1].trim() })
    }
  }
  return out
}

/** P1b: inline allow-lists that name broker but neither owner spelling. */
function findNarrowLadders(source: string): Finding[] {
  const src = blankComments(source)
  const out: Finding[] = []
  let m: RegExpExecArray | null
  LADDER.lastIndex = 0
  while ((m = LADDER.exec(src))) {
    const names = [...m[1].matchAll(/['"]([a-z_]+)['"]/g)].map((x) => x[1])
    const rosterNames = names.filter((n) => TENANT_ADMIN_USER_TYPES.has(n))
    if (rosterNames.length === 0) continue // not a tenant-roster ladder at all
    if (names.includes("broker") && !names.includes("broker_owner") && !names.includes("broker_admin")) {
      const line = src.slice(0, m.index).split("\n").length
      out.push({ line, text: src.split("\n")[line - 1].trim() })
    }
  }
  return out
}

console.log("── page-role-gate-roster: a page gate spells the roster once ──")
console.log(`   roster (read from TENANT_ADMIN_USER_TYPES): ${ROSTER.join(", ")}`)

// ── P1 + P1b over the tree ───────────────────────────────────────────────────
const pageFiles = walk(APP, (f) => f === "page.tsx" || f === "layout.tsx")
const literal: Array<{ file: string } & Finding> = []
const ladders: Array<{ file: string } & Finding> = []
for (const f of pageFiles) {
  const src = readFileSync(f, "utf8")
  for (const x of findLiteralGates(src)) literal.push({ file: relative(ROOT, f), ...x })
  for (const x of findNarrowLadders(src)) ladders.push({ file: relative(ROOT, f), ...x })
}
console.log(`   scanned ${pageFiles.length} page/layout files`)
for (const x of literal) console.log(`   · literal gate  ${x.file}:${x.line}  ${x.text}`)
for (const x of ladders) console.log(`   · narrow ladder ${x.file}:${x.line}  ${x.text}`)
ok("P1 no page gate compares a role literal and redirects (baseline 0, burn-down)", literal.length === 0, `${literal.length} found`)
ok("P1b no inline allow-list names broker without an owner spelling (baseline 0)", ladders.length === 0, `${ladders.length} found`)

// ── P2 the fixed gates call the one predicate ────────────────────────────────
const FIXED = [
  // literal `=== / !==` gates (6)
  "app/dashboard/coordination/page.tsx",
  "app/dashboard/brokerage/intelligence/page.tsx",
  "app/dashboard/admin/brand/page.tsx",
  "app/dashboard/education/page.tsx",
  "app/dashboard/financials/team/page.tsx",
  "app/dashboard/financials/commissions/page.tsx",
  // narrow allow-list ladders (4) — found by P1b's first run, which the
  // two-element grep that preceded it had been blind to (§2: a count that
  // moves is the finding)
  "app/dashboard/admin/forms/page.tsx",
  "app/dashboard/agent/qr-codes/page.tsx",
  "app/dashboard/transactions/[id]/page.tsx",
  "app/dashboard/transactions/[id]/cda/page.tsx",
]
const rosterModule = blankComments(readFileSync(join(ROOT, "lib/auth/resolve-user-role.ts"), "utf8"))
const predicateNames = [...rosterModule.matchAll(/export function (is\w+)\(/g)].map((m) => m[1])
ok("P2 lib/auth/resolve-user-role.ts exports roster predicates", predicateNames.length >= 3, predicateNames.join(","))
for (const rel of FIXED) {
  const src = blankComments(readFileSync(join(ROOT, rel), "utf8"))
  const importsPredicate = /from ["']@\/lib\/auth\/resolve-user-role["']/.test(src)
    && predicateNames.some((p) => new RegExp(`\\b${p}\\(`).test(src))
  ok(`P2 ${rel} gates through a roster predicate`, importsPredicate)
}

// ── P3 error-state coverage ──────────────────────────────────────────────────
function boundaryShapeOk(source: string): boolean {
  const src = blankComments(source)
  return /^\s*["']use client["']/m.test(src) && /\breset\b/.test(src) && /export default function/.test(src)
}
ok("P3 app/error.tsx exists (root boundary)", existsSync(join(APP, "error.tsx")))
ok("P3 app/not-found.tsx exists (root not-found)", existsSync(join(APP, "not-found.tsx")))
const boundaries = walk(APP, (f) => f === "error.tsx" || f === "global-error.tsx")
const badBoundaries = boundaries.filter((f) => !boundaryShapeOk(readFileSync(f, "utf8")))
ok(`P3 every error boundary is a client component taking reset (${boundaries.length} found)`, badBoundaries.length === 0, badBoundaries.map((f) => relative(ROOT, f)).join(","))
const notFoundSrc = blankComments(readFileSync(join(APP, "not-found.tsx"), "utf8"))
ok("P3 not-found never redirects and reads no data", !/\bredirect\(|\.from\(|createClient|createServiceClient/.test(notFoundSrc))

// ── P4 RoleGateNotice is server-safe ─────────────────────────────────────────
const noticeSrc = blankComments(readFileSync(join(APP, "components/shared/role-gate-notice.tsx"), "utf8"))
ok("P4 RoleGateNotice is exported, server-safe (no 'use client', no hooks)",
  /export function RoleGateNotice\(/.test(noticeSrc) && !/["']use client["']/.test(noticeSrc) && !/\buse[A-Z]\w*\(/.test(noticeSrc))
const noticeUsers = FIXED.filter((rel) => /RoleGateNotice/.test(blankComments(readFileSync(join(ROOT, rel), "utf8"))))
ok("P4 the roster-gated pages that refuse in place render RoleGateNotice (≥4)", noticeUsers.length >= 4, noticeUsers.join(","))

// ── POSITIVE CONTROLS (§2) ───────────────────────────────────────────────────
const PRE_89D_COORDINATION = `
  const { brokerageId, role } = await getAgentContext()
  if (role !== 'broker' && role !== 'admin') {
    redirect("/dashboard")
  }
`
const POST_89D_COORDINATION = `
  const { brokerageId, role } = await getAgentContext()
  if (!isAdminOrBroker({ user_type: role })) {
    return (<RoleGateNotice surface="AI Coordination" audience="x" />)
  }
`
const IN_COMMENT = `/* if (role !== 'broker' && role !== 'admin') { redirect("/dashboard") } */\nconst x = 1\n`
const PRE_89D_EDUCATION = `  if (!profile?.brokerage_id || profile.user_type !== "admin") {\n    redirect("/dashboard")\n  }\n`
const SCOPE_CHOICE = `  const isBrokerOrAdmin = ctx.userType === "broker" || ctx.userType === "admin"\n  const agentId = isBrokerOrAdmin ? undefined : ctx.userId\n`
ok("CONTROL the pre-89D coordination gate is flagged", findLiteralGates(PRE_89D_COORDINATION).length === 1)
ok("CONTROL the pre-89D education gate is flagged", findLiteralGates(PRE_89D_EDUCATION).length === 1)
ok("CONTROL the post-89D gate is not flagged", findLiteralGates(POST_89D_COORDINATION).length === 0)
ok("CONTROL a gate inside a comment is not a gate", findLiteralGates(IN_COMMENT).length === 0)
ok("CONTROL a scope choice without a redirect is not a gate (blind spot, stated)", findLiteralGates(SCOPE_CHOICE).length === 0)
ok("CONTROL ['broker','admin'].includes ladder is flagged",
  findNarrowLadders(`if (!["broker", "admin"].includes(userRole)) redirect("/x")`).length === 1)
ok("CONTROL deal-health's deliberate ladder (owner + admin + tc) is not flagged",
  findNarrowLadders(`const allowedRoles = ["broker", "broker_owner", "broker_admin", "admin", "tc"]\nif (!allowedRoles.includes(t)) redirect("/x")`).length === 0)
ok("CONTROL a non-roster ladder is ignored",
  findNarrowLadders(`if (["sale", "rent"].includes(kind)) {}`).length === 0)
ok("CONTROL a boundary without 'use client' fails the P3 shape",
  !boundaryShapeOk(`export default function E({ error, reset }: any) { return null }`))
ok("CONTROL a proper boundary passes the P3 shape",
  boundaryShapeOk(`"use client"\nexport default function E({ error, reset }: any) { return null }`))

console.log("──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ PAGE_ROLE_GATE_ROSTER_FAIL"); process.exit(1) }
console.log(" ✅ PAGE_ROLE_GATE_ROSTER_PASS — every page gate reads the one roster, refuses in place, and no segment is left without an error boundary")
