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
 * WAVE 90 (lane 90A — 89D's P1 plan, owner: "finish the burn down"). Four more
 * populations, all DERIVED from the tree:
 *   P1c SCOPE LITERALS — a scope CHOICE spelled `userType === "broker" ||
 *      userType === "admin"` (no redirect) gave a broker OWNER / broker admin /
 *      compliance officer the AGENT-scoped view of campaigns/roi,
 *      workflow-reports, analytics/source (+ its drill-down), and hid the
 *      brokerage settings links in SettingsSidebar. Measured on base f74cf0bc:
 *      6 sites. Each now asks the ONE resolver (lib/kernel/egress-scope.ts —
 *      team_lead gets TEAM scope, "teams see only their own board") or the
 *      roster predicate. Population: every page/layout AND app/components.
 *      Baseline 0.
 *   P5 SILENT ROLE BOUNCE — `redirect("/dashboard")` in the window of a roster
 *      predicate (isAdminOrBroker / isBrokerageFinanceAdmin / ADMIN_ROLES.has /
 *      an inline ladder …) is "a click that appeared to do nothing". Measured on
 *      base: 76 files carried the literal, 49 sites were role refusals — every
 *      one now renders RoleGateNotice naming the audience. What remains is a
 *      PUBLISHED baseline (SILENT_BOUNCE_BASELINE) with the reason each stays:
 *      resource gates that must not reveal a deal's or a lead's existence, a
 *      malformed platform parameter, and three superadmin capability refusals
 *      lane 90D owns. Ratchets down; a stale baseline entry is itself a failure.
 *   P6 BROKERAGE-LESS LANDS ON ONBOARDING — a brokerage-less account bounced to
 *      `/dashboard` only went `/dashboard` → determineFirstLoginDestination →
 *      `/dashboard/onboarding` → (still brokerage-less) `/dashboard/agent`:
 *      three hops. 21 sites now go straight to `/dashboard/onboarding`, and the
 *      loop-freedom is HELD: the onboarding index never redirects to
 *      `/dashboard` (it self-heals, else `/dashboard/agent`) and the agent
 *      dashboard never redirects at all. Baseline 0.
 *   P7 ALIAS PAGES ARE GATED AT THE EDGE — every thin `redirect()` page under
 *      app/<seg>/ classifies public or protected in classifyProxyPath, never
 *      'open' (89D measured /calendar, /documents, /financials … answering 200
 *      unauthenticated). '/documents/shared' stays PUBLIC by name (token-gated).
 *   P8 A TENANT-ADMIN SEAT WITHOUT AN agents ROW IS NOT BOUNCED — Inbox,
 *      Calendar, AI quality and Podcast channels fall back to BROKERAGE scope
 *      for a roster seat (live 2026-09-29: admin 2, compliance_officer 1,
 *      team_lead 1, tc 1 seats carry no agents row; ruling: do not provision
 *      one). Lexical: no `if (!agentId|agentRow|agent) redirect(` in those
 *      pages, and the roster predicate present where the fallback is decided.
 *
 * BLIND SPOTS (published beside the numbers): P1 is LEXICAL and LOCAL — a
 * literal comparison whose redirect sits more than 6 lines below, or that
 * gates by `return null`, is not seen (over-permissive, never over-accusing);
 * `user_type === 'superadmin'` arms are dead (§4) but harmless and are not
 * counted; layouts that gate client-side through useAuth are read the same
 * way as pages (the finder does not know which side renders). P5 sees only
 * the predicate spellings in BOUNCE_PREDICATE — a bounce after an
 * action-result check (`if (!studio.ok) redirect("/dashboard")` in gifts,
 * sphere, stale, wealth, financials/team) is an ACTION-FAILURE bounce, a
 * different class, counted below as `otherDashboardBounces` and not held.
 * P1c's literal shape is two `=== "<roster>"` joined by `||`; a ladder in a
 * `Set` or a lone comparison is P1b's / P1's. P7 reads only depth ≤ 2 pages
 * whose whole body is one redirect call.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { blankComments, stringLiterals } from "./strip-comments"
// P7 — the edge's own classifier, so the proof and proxy.ts cannot disagree.
import { classifyProxyPath } from "../app/constants/auth"

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
// Lane 90A: the TWO-LINE spelling — `const allowedRoles = [...]` with the
// `.includes(` on the next line — which the adjacency regex above had been
// blind to (admin/tasks carried ['admin','broker','superadmin'] unflagged).
const LADDER_TWO_LINE = /=\s*\[\s*((?:['"][a-z_]+['"]\s*,?\s*)+)\]\s*\n[^\n]*\.includes\(/g
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
  for (const re of [LADDER, LADDER_TWO_LINE]) {
    re.lastIndex = 0
    while ((m = re.exec(src))) {
      const names = [...m[1].matchAll(/['"]([a-z_]+)['"]/g)].map((x) => x[1])
      const rosterNames = names.filter((n) => TENANT_ADMIN_USER_TYPES.has(n))
      if (rosterNames.length === 0) continue // not a tenant-roster ladder at all
      if (names.includes("broker") && !names.includes("broker_owner") && !names.includes("broker_admin")) {
        const line = src.slice(0, m.index).split("\n").length
        out.push({ line, text: src.split("\n")[line - 1].trim() })
      }
    }
  }
  return out
}

// ── P1c / P5 / P6 / P7 / P8 finders (lane 90A; exported to the controls below) ──
const ROSTER_OR_DEAD = `(?:${ROSTER.join("|")}|superadmin)`
const SCOPE_LITERAL = new RegExp(
  `${ROLE_IDENT}\\s*===\\s*['"]${ROSTER_OR_DEAD}['"]\\s*\\|\\|\\s*${ROLE_IDENT}\\s*===\\s*['"]${ROSTER_OR_DEAD}['"]`, "g",
)
/** P1c: a scope CHOICE spelled as two roster literals joined by `||`. */
function findScopeLiterals(source: string): Finding[] {
  const src = blankComments(source)
  const lines = src.split("\n")
  const out: Finding[] = []
  let m: RegExpExecArray | null
  SCOPE_LITERAL.lastIndex = 0
  while ((m = SCOPE_LITERAL.exec(src))) {
    const line = src.slice(0, m.index).split("\n").length
    out.push({ line, text: lines[line - 1].trim() })
  }
  return out
}

const DASHBOARD_BOUNCE = /\bredirect\(\s*["']\/dashboard["']\s*\)/
const BOUNCE_PREDICATE = /isAdminOrBroker\(|isBrokerageFinanceAdmin(?:GrantRole)?\(|isTenantAdminOrPlatformStaff\(|isTenantAdminGrantRole\(|isAgentOrTenantAdmin\(|ADMIN_ROLES\.has\(|PORTAL_ROLES\.has\(|allowed\.has\(|allowedRoles\.includes\(|ALLOWED_TYPES\.includes\(|\]\.includes\((?:role|userRole|callerRole|userType|t)\)|!mayEnter\b|!principal\b|!isAdmin\b|isTenantBillingAdmin|hasAdminAccess|!gate\.ok|!isPlatform\b|!vis\.allowed/
const BOUNCE_WINDOW_LINES = 3
type BounceKind = "role" | "brokerage_less" | "other"
/** P5 / P6: every `redirect("/dashboard")`, classified by the 3-line window above it. */
function findDashboardBounces(source: string): Array<Finding & { kind: BounceKind }> {
  const src = blankComments(source)
  const lines = src.split("\n")
  const out: Array<Finding & { kind: BounceKind }> = []
  for (let i = 0; i < lines.length; i++) {
    if (!DASHBOARD_BOUNCE.test(lines[i])) continue
    const window = lines.slice(Math.max(0, i - (BOUNCE_WINDOW_LINES - 1)), i + 1).join("\n")
    const kind: BounceKind = BOUNCE_PREDICATE.test(window)
      ? "role"
      : /brokerage_id|brokerageId/.test(window) && !/agentId|agentRow/.test(window) ? "brokerage_less" : "other"
    out.push({ line: i + 1, text: lines[i].trim(), kind })
  }
  return out
}

/** P5 baseline — PUBLISHED, with the reason each silent bounce stays. Ratchets down only. */
const SILENT_BOUNCE_BASELINE: Record<string, { count: number; why: string }> = {
  "app/dashboard/transactions/[id]/page.tsx": { count: 1, why: "resource gate: a deal outside the seat's scope is not revealed to exist (89D: the destination is meaningful)" },
  "app/dashboard/transactions/[id]/cda/page.tsx": { count: 1, why: "resource gate, same as the deal detail" },
  "app/leads/[leadId]/page.tsx": { count: 1, why: "lead desk: leads belong to the brokerage (§5); a lead's existence is not revealed to an agent seat" },
  "app/dashboard/brokerage/page.tsx": { count: 1, why: "a malformed or unauthorised ?brokerageId parameter, not a role refusal" },
  "app/dashboard/superadmin/layout.tsx": { count: 1, why: "the ONE platform-staff subtree gate for the god console — 89D P3, lane 90D" },
}

/** P8: the pre-90A shape — bounce the moment the agents row is missing. */
const MISSING_AGENT_ROW_BOUNCE = /if\s*\(\s*!\s*(?:agentId|agentRow(?:\?\.id)?|agent)\s*\)\s*\{?\s*redirect\(/
function bouncesOnMissingAgentRow(source: string): boolean {
  return MISSING_AGENT_ROW_BOUNCE.test(blankComments(source))
}

/** P7: a page whose whole body is one redirect call (a thin alias) — returns its target. */
const THIN_REDIRECT_PAGE = /export default (?:async )?function \w*\s*\([^)]*\)\s*\{\s*(?:return\s+)?(?:permanentRedirect|redirect)\(\s*["']([^"']+)["']\s*\)\s*;?\s*\}/
function thinRedirectTarget(source: string): string | null {
  const src = blankComments(source)
  const m = THIN_REDIRECT_PAGE.exec(src)
  if (!m) return null
  if (/\.from\(|await |<[A-Za-z]/.test(src.replace(/^import .*$/gm, ""))) return null
  return m[1]
}
function isThinRedirectPage(source: string): boolean { return thinRedirectTarget(source) !== null }

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

// ── P1c scope literals over pages + layouts + app/components ────────────────
const componentFiles = walk(join(APP, "components"), (f) => f.endsWith(".tsx") || f.endsWith(".ts"))
const scopeLiterals: Array<{ file: string } & Finding> = []
for (const f of [...pageFiles, ...componentFiles]) {
  for (const x of findScopeLiterals(readFileSync(f, "utf8"))) scopeLiterals.push({ file: relative(ROOT, f), ...x })
}
for (const x of scopeLiterals) console.log(`   · scope literal ${x.file}:${x.line}  ${x.text}`)
ok(`P1c no scope choice is spelled with roster literals (${pageFiles.length + componentFiles.length} files, baseline 0)`, scopeLiterals.length === 0, `${scopeLiterals.length} found`)

// ── P5 / P6 every redirect("/dashboard") on a page, classified ──────────────
const roleBounces: Array<{ file: string } & Finding> = []
const brokerageLessBounces: Array<{ file: string } & Finding> = []
let otherDashboardBounces = 0
for (const f of pageFiles) {
  for (const b of findDashboardBounces(readFileSync(f, "utf8"))) {
    const rel = relative(ROOT, f)
    if (b.kind === "role") roleBounces.push({ file: rel, ...b })
    else if (b.kind === "brokerage_less") brokerageLessBounces.push({ file: rel, ...b })
    else otherDashboardBounces++
  }
}
const roleBounceCounts = new Map<string, number>()
for (const b of roleBounces) roleBounceCounts.set(b.file, (roleBounceCounts.get(b.file) ?? 0) + 1)
const overBaseline = [...roleBounceCounts.entries()].filter(([file, n]) => n > (SILENT_BOUNCE_BASELINE[file]?.count ?? 0))
const staleBaseline = Object.keys(SILENT_BOUNCE_BASELINE).filter((file) => (roleBounceCounts.get(file) ?? 0) < SILENT_BOUNCE_BASELINE[file].count)
for (const [file, n] of overBaseline) console.log(`   · silent role bounce ${file} ×${n} (baseline ${SILENT_BOUNCE_BASELINE[file]?.count ?? 0})`)
for (const file of staleBaseline) console.log(`   · stale baseline entry ${file} — the bounce is gone; remove it (ratchet)`)
console.log(`   redirect("/dashboard") on pages: role ${roleBounces.length} (baseline ${Object.values(SILENT_BOUNCE_BASELINE).reduce((a, b) => a + b.count, 0)}, each published with its reason) · brokerage-less ${brokerageLessBounces.length} · action-failure/other ${otherDashboardBounces} (not held — see BLIND SPOTS)`)
ok("P5 no page bounces a refused ROLE to /dashboard beyond the published baseline (ratchet down)", overBaseline.length === 0, overBaseline.map(([f]) => f).join(","))
ok("P5 the published baseline carries no stale entry", staleBaseline.length === 0, staleBaseline.join(","))
for (const b of brokerageLessBounces) console.log(`   · brokerage-less → /dashboard ${b.file}:${b.line}  ${b.text}`)
ok("P6 a brokerage-less account lands on /dashboard/onboarding, never on /dashboard (baseline 0)", brokerageLessBounces.length === 0, `${brokerageLessBounces.length} found`)
const onboardingIndex = blankComments(readFileSync(join(APP, "dashboard/onboarding/page.tsx"), "utf8"))
const agentDashboard = blankComments(readFileSync(join(APP, "dashboard/agent/page.tsx"), "utf8"))
ok("P6 the onboarding index never redirects to /dashboard (no loop: it self-heals, else /dashboard/agent)", !DASHBOARD_BOUNCE.test(onboardingIndex) && /redirect\(\s*["']\/dashboard\/agent["']\s*\)/.test(onboardingIndex))
ok("P6 the agent dashboard never redirects at all (the chain terminates there)", !/\bredirect\(/.test(agentDashboard))

// ── P7 thin alias pages are gated at the edge ───────────────────────────────
const shallowPages = pageFiles.filter((f) => {
  const rel = relative(APP, f).split("/")
  return rel.length <= 3 && rel[rel.length - 1] === "page.tsx" && !rel[0].startsWith("(")
})
const thinAliases = shallowPages
  .map((f) => ({ path: "/" + relative(APP, f).replace(/(^|\/)page\.tsx$/, ""), target: thinRedirectTarget(readFileSync(f, "utf8")) }))
  .filter((a): a is { path: string; target: string } => a.target !== null)
// An alias is a finding when IT is open at the edge while its TARGET is not
// public — the root `/` → /login alias is open by design (its target is public).
const openAliases = thinAliases.filter((a) => classifyProxyPath(a.path) === "open" && classifyProxyPath(a.target) !== "public")
for (const a of openAliases) console.log(`   · alias page outside the edge gate: ${a.path} → ${a.target}`)
ok(`P7 every thin alias page (${thinAliases.length} found) into a non-public surface is public or protected at the edge, never open`, thinAliases.length >= 10 && openAliases.length === 0, openAliases.map((a) => a.path).join(","))

// ── P8 tenant-admin seats without an agents row are not bounced ─────────────
const AGENT_ROW_FALLBACK_PAGES = [
  "app/dashboard/communications/inbox/page.tsx",
  "app/dashboard/calendar/page.tsx",
  "app/dashboard/ai-quality/page.tsx",
  "app/dashboard/settings/podcast-channels/page.tsx",
]
for (const rel of AGENT_ROW_FALLBACK_PAGES) {
  const src = readFileSync(join(ROOT, rel), "utf8")
  ok(`P8 ${rel} does not bounce on a missing agents row`, !bouncesOnMissingAgentRow(src))
}
for (const rel of AGENT_ROW_FALLBACK_PAGES.slice(0, 2)) {
  const src = blankComments(readFileSync(join(ROOT, rel), "utf8"))
  ok(`P8 ${rel} decides the fallback with the roster predicate`, /isAdminOrBroker\(/.test(src))
}

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
ok("CONTROL the two-line ladder (pre-90A admin/tasks) is flagged",
  findNarrowLadders(`  const allowedRoles = ['admin', 'broker', 'superadmin']\n  if (!allowedRoles.includes(userRole)) redirect('/dashboard')\n`).length === 1)
ok("CONTROL a non-roster ladder is ignored",
  findNarrowLadders(`if (["sale", "rent"].includes(kind)) {}`).length === 0)
ok("CONTROL a boundary without 'use client' fails the P3 shape",
  !boundaryShapeOk(`export default function E({ error, reset }: any) { return null }`))
ok("CONTROL a proper boundary passes the P3 shape",
  boundaryShapeOk(`"use client"\nexport default function E({ error, reset }: any) { return null }`))
// lane 90A controls
const PRE_90A_SOURCE_SCOPE = `  const isBrokerOrAdmin = ctx.userType === "broker" || ctx.userType === "admin" || ctx.userType === "superadmin"\n`
const PRE_90A_ROI_SCOPE = `  if (profile.user_type === "broker" || profile.user_type === "admin") {\n`
const POST_90A_SCOPE = `  const scope = resolveEgressScope({ userType: ctx.userType, userId: ctx.userId, brokerageId: ctx.brokerageId, teamId: ctx.teamId })\n`
ok("CONTROL the pre-90A analytics/source scope literal is flagged by P1c", findScopeLiterals(PRE_90A_SOURCE_SCOPE).length === 1)
ok("CONTROL the pre-90A campaigns/roi scope literal is flagged by P1c", findScopeLiterals(PRE_90A_ROI_SCOPE).length === 1)
ok("CONTROL the resolver call is not flagged by P1c", findScopeLiterals(POST_90A_SCOPE).length === 0)
ok("CONTROL the same literal inside a comment is not flagged by P1c", findScopeLiterals(`// ${PRE_90A_SOURCE_SCOPE}`).length === 0)
const PRE_90A_ROLE_BOUNCE = `  if (!isAdminOrBroker({ user_type: ctx.userType })) redirect("/dashboard")\n`
const PRE_90A_ROLE_BOUNCE_BLOCK = `  if (!isAdminOrBroker({ user_type: t })) {\n    redirect("/dashboard")\n  }\n`
const POST_90A_ROLE_NOTICE = `  if (!isAdminOrBroker({ user_type: t })) return <RoleGateNotice surface="X" audience="y" />\n`
const PRE_90A_BROKERAGE_LESS = `  if (!profile?.brokerage_id) {\n    redirect("/dashboard")\n  }\n`
const POST_90A_BROKERAGE_LESS = `  if (!profile?.brokerage_id) redirect("/dashboard/onboarding")\n`
const ACTION_FAILURE_BOUNCE = `  const studio = await getGiftStudioAction()\n  if (!studio.ok) redirect("/dashboard")\n`
ok("CONTROL a one-line role bounce is classified 'role' by P5", findDashboardBounces(PRE_90A_ROLE_BOUNCE).map((b) => b.kind).join() === "role")
ok("CONTROL a block-form role bounce is classified 'role' by P5", findDashboardBounces(PRE_90A_ROLE_BOUNCE_BLOCK).map((b) => b.kind).join() === "role")
ok("CONTROL the in-place notice is not a bounce", findDashboardBounces(POST_90A_ROLE_NOTICE).length === 0)
ok("CONTROL a brokerage-less bounce to /dashboard is classified 'brokerage_less' by P6", findDashboardBounces(PRE_90A_BROKERAGE_LESS).map((b) => b.kind).join() === "brokerage_less")
ok("CONTROL a brokerage-less bounce to /dashboard/onboarding is not a finding", findDashboardBounces(POST_90A_BROKERAGE_LESS).length === 0)
ok("CONTROL an action-failure bounce is 'other' (counted, not held — stated blind spot)", findDashboardBounces(ACTION_FAILURE_BOUNCE).map((b) => b.kind).join() === "other")
ok("CONTROL the pre-90A inbox shape (bounce on a missing agents row) is flagged by P8",
  bouncesOnMissingAgentRow(`  const agentId = await resolveAgentId(service, user.id)\n  if (!agentId) redirect("/dashboard/onboarding")\n`))
ok("CONTROL the pre-90A calendar shape is flagged by P8", bouncesOnMissingAgentRow(`  if (!agentRow) {\n    redirect("/dashboard/onboarding")\n  }\n`))
ok("CONTROL the post-90A fallback is not flagged by P8",
  !bouncesOnMissingAgentRow(`  if (!agentId && !isAdminOrBroker({ user_type: role })) redirect("/dashboard/onboarding")\n`))
ok("CONTROL a thin alias page is recognised by P7",
  isThinRedirectPage(`import { redirect } from 'next/navigation'\n\nexport default function CalendarPage() {\n  redirect('/dashboard/calendar')\n}\n`))
ok("CONTROL a page that reads data is not a thin alias",
  !isThinRedirectPage(`import { redirect } from 'next/navigation'\nexport default async function P() {\n  const x = await load()\n  redirect('/y')\n}\n`))
ok("CONTROL the edge classifier calls an unlisted path 'open' (so P7 can fail)", classifyProxyPath("/no-such-alias-90a") === "open")
ok("CONTROL /calendar and /documents/shared classify protected and public", classifyProxyPath("/calendar") === "protected" && classifyProxyPath("/documents/shared/abc") === "public")

console.log("──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ PAGE_ROLE_GATE_ROSTER_FAIL"); process.exit(1) }
console.log(" ✅ PAGE_ROLE_GATE_ROSTER_PASS — every page gate reads the one roster, refuses in place, a brokerage-less account lands on onboarding, every alias is gated at the edge, and no segment is left without an error boundary")
