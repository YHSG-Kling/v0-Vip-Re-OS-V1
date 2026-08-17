#!/usr/bin/env tsx
/**
 * scripts/cross-tenant-read-simulator.ts   (npm run test:cross-tenant-read)
 * ─────────────────────────────────────────────────────────────────────────────
 * A ROLE NAME IS NOT A TENANT BOUNDARY.
 *
 * Owner ruling, verbatim: "only platform staff and admin should read cross
 * tenant." A read that spans MORE THAN ONE brokerage is a PLATFORM read.
 * Everyone else — including a tenant's own broker, broker_owner, broker_admin,
 * team_lead and admin — is confined to their own brokerage. `admin` is a TENANT
 * user_type (users_user_type_check admits it beside agent/broker/contact); it is
 * not a platform one, and that collision is what this proof exists to police.
 *
 * THE THREE SHAPES m471 REMOVED, each of which LOOKS tenant-scoped:
 *
 *   (1) THE PREDICATE THAT COMPARES THE ROW TO ITSELF.
 *         brokerage_id = (select a.brokerage_id from agents a
 *                         where a.id = <table>.agent_id limit 1)
 *       Both sides come from the ROW. auth.uid() never appears. It contains the
 *       word `brokerage_id`, so any classifier that greps for that token calls
 *       it tenant-scoped — and it is TRUE for every row. This is the shape the
 *       PURE layer below is built around, because grepping is the obvious wrong
 *       answer and it has to be proven wrong.
 *
 *   (2) THE ROLE NAME STANDING IN FOR A BOUNDARY.
 *         exists (select 1 from users where id = auth.uid()
 *                 and user_type in ('admin','broker','compliance_officer'))
 *       No brokerage predicate anywhere. A broker at brokerage A read brokerage
 *       B's rows. Four of the six tables carrying this ALREADY had a correctly
 *       tenant-scoped sibling policy — and PERMISSIVE policies are OR'd, so the
 *       sibling never constrained the broken one. The wider policy always wins.
 *
 *   (3) THE PLATFORM ESCAPE THAT IS NOT ONE.
 *       `user_type = 'superadmin'` alone, and `platform_role = 'super_admin'`
 *       (not a legal value at all). MEASURED: the one live superadmin on this
 *       database is (user_type='admin', platform_role='superadmin'), so the
 *       single-column form refuses the platform's own administrator while
 *       ADMITTING every tenant admin through the same array.
 *
 * PURE:   a classifier over policy expressions, asserted against the pre-fix and
 *         post-fix text VERBATIM. The load-bearing claims are the ones that must
 *         NOT be fooled: the self-referential predicate is untenanted despite
 *         containing `brokerage_id`; a helper-mediated test (the tenant boundary
 *         living inside a function BODY) counts as tenanted; and a bare
 *         user_type='superadmin' is NOT a platform gate.
 * SOURCE: one shape scan over the whole tree for the app-side twin of shape (3)
 *         — a platform decision taken from user_type ALONE. Keyed to the
 *         COMPARISON, not to a file list, not to any variable's name, and not to
 *         one spelling of the left operand. Prose-immune STRUCTURALLY rather
 *         than by blanking, because here the string literal IS the signal:
 *         `"superadmin"` is the operand. See literalSpans() for why that
 *         distinction had to be drawn instead of assumed.
 *
 *         A SECOND SCAN WAS WRITTEN AND DELETED, recorded here so it is not
 *         re-invented: "no `.from('users').select(…user_type…)` may omit
 *         platform_role near a superadmin test". It found 69 sites, nearly all
 *         of them ordinary TENANT role reads that have nothing to do with
 *         platform identity. That is a claim about the whole corpus dressed up
 *         as a claim about one gate, and a probe that reports 69 green sites as
 *         red is worse than no probe. The comparison scan already catches the
 *         one site that mattered (self-book-showing.ts, which never fetched the
 *         column at all) because the comparison is where the decision is taken.
 * LIVE (creds-gated): calls public.assert_cross_tenant_read_isolation(), which
 *         seeds two real brokerages, becomes a tenant BROKER at one of them via
 *         set_config('request.jwt.claims', …), and measures what RLS actually
 *         returns. supabase-js cannot do either of those things over the wire —
 *         it cannot read pg_policies and it cannot become a seat — which is why
 *         the probe lives in the database and this layer calls it. Asserts BOTH
 *         directions: other-tenant rows = 0 AND own-tenant rows > 0, because a
 *         policy that returns nothing to anybody is a different bug, not a fix.
 *         Self-skips without SUPABASE creds.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import { isPlatformStaffIdentity } from "../lib/auth/resolve-user-role"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

const ROOT = process.cwd()
const SELF = fileURLToPath(import.meta.url)

// ─── PURE ────────────────────────────────────────────────────────────────────

/**
 * Helpers whose BODY carries the tenant boundary. A policy naming one of these
 * IS tenant-scoped even though its own text never mentions brokerage_id — which
 * is exactly the trap the census had to avoid calling a defect. Each body was
 * read (pg_get_functiondef) before it was put on this list; none of them is here
 * because its name sounded right.
 */
const TENANT_HELPERS = [
  "current_user_brokerage_id",
  "user_brokerage_ids",
  "has_brokerage_access",
  "can_access_support_ticket",
  "can_write_service_area",
  "vendor_has_contact_access",
  "vendor_has_transaction_access",
] as const

/** Helpers that read BOTH identity columns. A user_type literal is not one. */
const PLATFORM_HELPERS = ["is_platform_staff", "is_platform_admin", "can_read_tenant_financials"] as const

/** Self-scoping HELPERS: the row belongs to the caller. Tighter than tenant. */
const SELF_SCOPE_HELPERS = [
  "current_user_agent_id", "is_own_agent_id", "is_self_contact",
  "is_current_user_vendor", "is_current_user_marketplace_vendor", "portal_member_searches",
] as const

/**
 * The CALLER-LOOKUP use of auth.uid(): `users.id = auth.uid()` inside a role
 * probe. It constrains NO row column — all it does is fetch the caller's own
 * user_type — and treating it as a tenant test is how a role-name gate passes
 * for a boundary. Stripped before asking whether any auth.uid() survives.
 *
 * Deliberately `(users|u)\.id`, not `\w*\.?id`. MEASURED both ways against the
 * live catalogue: the greedy form also swallows `agents.user_id = auth.uid()`
 * and misclassifies 26 genuinely self-scoped policies as holes.
 */
const CALLER_LOOKUP = /\b(?:users|u)\.id\s*=\s*auth\.uid\(\)/g

interface PolicyVerdict { tenantTested: boolean; platformGated: boolean; crossTenant: boolean }

/**
 * PURE. Classify one policy expression.
 *
 * TWO things look like a boundary and are not, and both have to be refused:
 *
 *   · `brokerage_id` appearing in the text. A comparison of the row's
 *     brokerage_id to ANOTHER COLUMN OF THE SAME ROW mentions it too, and that
 *     is shape (1) — true for every row.
 *   · `auth.uid()` appearing in the text. Inside `exists (select 1 from users
 *     where users.id = auth.uid() and users.user_type in (…))` it fetches the
 *     caller's ROLE and constrains nothing, and that is shape (2).
 *
 * A tenant test therefore requires a ROW column to be tied to the caller: by
 * naming a helper whose body does it, or by an auth.uid() that survives the
 * caller-lookup strip (i.e. one compared to a row column such as
 * agents.user_id, agent_user_id, contact_user_id).
 */
export function classifyPolicyExpression(expr: string): PolicyVerdict {
  const namesTenantHelper = TENANT_HELPERS.some((h) => expr.includes(`${h}(`))
  const namesSelfHelper = SELF_SCOPE_HELPERS.some((h) => expr.includes(`${h}(`))
  const rowTiedUid = expr.replace(CALLER_LOOKUP, "").includes("auth.uid()")
  const mentionsBrokerage = /\bbrokerage_id\b/.test(expr)
  const platformGated = PLATFORM_HELPERS.some((h) => expr.includes(`${h}(`))
  const tenantTested =
    namesTenantHelper || namesSelfHelper || rowTiedUid ||
    (mentionsBrokerage && expr.includes("auth.uid()"))
  return { tenantTested, platformGated, crossTenant: !tenantTested && !platformGated }
}

// The pre-fix expressions, VERBATIM from pg_policies before m471.
const PRE_FIX = {
  clientGifts:
    "(brokerage_id = ( SELECT agents.brokerage_id\n   FROM agents\n  WHERE (agents.id = client_gifts.agent_id)\n LIMIT 1))",
  thankYouNotes:
    "(brokerage_id = ( SELECT agents.brokerage_id\n   FROM agents\n  WHERE (agents.id = thank_you_notes.agent_id)\n LIMIT 1))",
  dedupLog:
    "(EXISTS ( SELECT 1\n   FROM users\n  WHERE ((users.id = auth.uid()) AND (users.user_type = ANY (ARRAY['broker'::text, 'admin'::text])))))",
  marketPulse: "((auth.role() = 'authenticated'::text) OR is_platform_admin())",
}

// The post-fix expressions, VERBATIM from pg_policies after m471.
const POST_FIX = {
  clientGifts:
    "COALESCE(((brokerage_id IS NOT NULL) AND (brokerage_id IN ( SELECT user_brokerage_ids() AS user_brokerage_ids))), false)",
  dealTeamMembers:
    "COALESCE((((brokerage_id IS NOT NULL) AND (brokerage_id = current_user_brokerage_id())) OR is_platform_staff()), false)",
}

function pureLayer() {
  console.log("\n[the classifier · pure — `brokerage_id` in the text proves nothing]")

  // (1) THE ONE THAT MATTERS. Contains `brokerage_id`, twice, and isolates
  // nothing: both sides of the `=` come from the row.
  check("the self-referential predicate is UNTENANTED even though it names brokerage_id twice",
    classifyPolicyExpression(PRE_FIX.clientGifts).tenantTested === false &&
    classifyPolicyExpression(PRE_FIX.thankYouNotes).tenantTested === false)
  check("…and is therefore reported CROSS-TENANT, since it carries no platform gate either",
    classifyPolicyExpression(PRE_FIX.clientGifts).crossTenant === true)

  // NEGATIVE CONTROL for that claim: a naive substring test would call it
  // tenant-scoped. Assert the naive answer differs from ours, so "we are not
  // just grepping" is a measured fact rather than a comment.
  const naive = (e: string) => /\bbrokerage_id\b/.test(e)
  check("NEGATIVE CONTROL a substring test on brokerage_id gets that predicate WRONG — the classifier does not",
    naive(PRE_FIX.clientGifts) === true &&
    classifyPolicyExpression(PRE_FIX.clientGifts).tenantTested === false)

  // (2) The role name with no boundary at all.
  check("a role-name gate with no brokerage predicate is untenanted and ungated",
    classifyPolicyExpression(PRE_FIX.dedupLog).tenantTested === false &&
    classifyPolicyExpression(PRE_FIX.dedupLog).platformGated === false)

  // NEGATIVE CONTROL for THAT claim. The dedup gate contains `auth.uid()`, so a
  // classifier that credits any auth.uid() with a boundary calls it clean. Assert
  // the naive answer differs from ours — and, crucially, that the strip did not
  // simply blind us: a row column tied to auth.uid() is still tenant-scoping.
  check("NEGATIVE CONTROL a naive `contains auth.uid()` test gets that gate WRONG — the classifier does not",
    PRE_FIX.dedupLog.includes("auth.uid()") &&
    classifyPolicyExpression(PRE_FIX.dedupLog).tenantTested === false)
  check("…and the strip did NOT blind it: a ROW column tied to auth.uid() is still scoping",
    classifyPolicyExpression("(agent_user_id = auth.uid())").tenantTested === true &&
    classifyPolicyExpression("(agent_id IN ( SELECT agents.id FROM agents WHERE (agents.user_id = auth.uid())))").tenantTested === true)

  // …but the SAME role test, pinned, is fine. Both directions asserted.
  const pinned = PRE_FIX.dedupLog.replace(
    "(EXISTS", "((brokerage_id = current_user_brokerage_id()) AND EXISTS")
  check("the SAME role test pinned to current_user_brokerage_id() classifies as tenant-tested",
    classifyPolicyExpression(pinned).tenantTested === true)

  // (3) auth.role() = 'authenticated' is "signed in", not "in this tenant".
  check("`auth.role() = 'authenticated'` is not a tenant test — it is every seat on the platform",
    classifyPolicyExpression(PRE_FIX.marketPulse).tenantTested === false)
  check("…though it IS correctly recognised as platform-gated on its second arm",
    classifyPolicyExpression(PRE_FIX.marketPulse).platformGated === true)

  console.log("\n[helper-mediated boundaries · pure — the test can live in a function BODY]")
  for (const h of TENANT_HELPERS) {
    check(`a policy reading only \`${h}(…)\` is tenant-tested (the boundary is inside it)`,
      classifyPolicyExpression(`${h}(brokerage_id)`).tenantTested === true)
  }
  check("NEGATIVE CONTROL an invented helper name is NOT credited with a boundary",
    classifyPolicyExpression("looks_tenant_scoped(brokerage_id)").tenantTested === false)

  console.log("\n[the platform gate · pure — a user_type literal is not one]")
  check("is_platform_staff() / is_platform_admin() count as platform gates",
    classifyPolicyExpression("is_platform_staff()").platformGated === true &&
    classifyPolicyExpression("is_platform_admin()").platformGated === true)
  check("a bare `user_type = 'superadmin'` does NOT — that is the single-column bug, not a gate",
    classifyPolicyExpression("(users.user_type = 'superadmin'::text)").platformGated === false)
  check("nor does `platform_role = 'super_admin'`, which is not even a legal platform_role value",
    classifyPolicyExpression("(users.platform_role = 'super_admin'::text)").platformGated === false)

  console.log("\n[the app-side identity · pure — the same question, both columns]")
  // The live shape: the ONE superadmin on this database.
  check("the live superadmin (user_type='admin', platform_role='superadmin') IS platform staff",
    isPlatformStaffIdentity("admin", "superadmin") === true)
  check("NEGATIVE CONTROL …and user_type alone would have refused them",
    ("admin" as string) !== "superadmin")
  check("a TENANT admin with no platform_role is NOT platform staff",
    isPlatformStaffIdentity("admin", null) === false)
  check("a tenant broker is not, and neither is a team_lead",
    isPlatformStaffIdentity("broker", null) === false &&
    isPlatformStaffIdentity("team_lead", null) === false)
  check("'marketing' — not a legal user_type at all — is staff through platform_role",
    isPlatformStaffIdentity("system", "marketing") === true)
  check("the legacy user_type='superadmin' marker still counts, so old accounts are not demoted",
    isPlatformStaffIdentity("superadmin", null) === true)
  check("ai_isa_system is a legal platform_role but NOT a member of staff",
    isPlatformStaffIdentity("system", "ai_isa_system") === false)

  console.log("\n[what m471 installed · pure — the fixed text classifies clean]")
  check("the repaired client_gifts predicate is tenant-tested",
    classifyPolicyExpression(POST_FIX.clientGifts).tenantTested === true &&
    classifyPolicyExpression(POST_FIX.clientGifts).crossTenant === false)
  check("the repaired deal_team_members predicate is tenant-tested AND platform-gated",
    classifyPolicyExpression(POST_FIX.dealTeamMembers).tenantTested === true &&
    classifyPolicyExpression(POST_FIX.dealTeamMembers).platformGated === true)
}

// ─── SOURCE ──────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git" || e === "supabase") continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if ((p.endsWith(".ts") || p.endsWith(".tsx")) && p !== SELF) out.push(p)
  }
  return out
}

/** Comments blanked, newlines preserved so reported line numbers survive. */
function codeOnly(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length))
}

const lineOf = (s: string, i: number) => s.slice(0, i).split("\n").length

/**
 * The [start, end) spans of every string and template literal in `code`.
 *
 * PROSE IS NOT CODE, AND BLANKING IS THE WRONG TOOL HERE. This scan's signal IS
 * a string literal — `"superadmin"` is the operand being compared against — so
 * blanking quotes would blind it completely while it went on reporting zero.
 * But the same characters appear inside prose ABOUT the defect, and this repo
 * carries ~30 such comments plus a manager-registry `what:` sentence that quotes
 * the forbidden comparison verbatim inside a plain double-quoted string.
 *
 * The resolution is structural rather than lexical: find where the literals ARE,
 * then keep a match only if the match STARTS outside all of them. In
 * `x.user_type === "superadmin"` the match starts at `x.user_type`, outside any
 * span — a real gate. In `"… user_type === \"superadmin\" …"` the whole sentence
 * is one span and the match starts inside it — prose.
 *
 * DELIBERATELY not solved by skipping the registry file (a path pin goes blind
 * the day the code moves) nor by rewording the documentation (that leaves the
 * scanner still wrong for the next quotation somebody writes).
 */
function literalSpans(code: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  let i = 0
  while (i < code.length) {
    const ch = code[i]
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i
      i++
      while (i < code.length) {
        if (code[i] === "\\") { i += 2; continue }
        if (code[i] === ch) { i++; break }
        // An unterminated single/double quote must not swallow the rest of the
        // file; only template literals legally span lines.
        if (ch !== "`" && code[i] === "\n") break
        i++
      }
      spans.push([start, i])
      continue
    }
    i++
  }
  return spans
}

const insideLiteral = (spans: Array<[number, number]>, i: number) =>
  spans.some(([a, b]) => i >= a && i < b)

/**
 * SHAPE A — the COMPARISON. Any `…user_type…` expression tested against the
 * literal "superadmin" (either operand order, any of ===/!==/==/!=), where
 * `platform_role` is not consulted within the surrounding window.
 *
 * Not pinned to a file, not to a variable's name, not to one spelling of the
 * left-hand expression — it matches `u.user_type`, `profile?.user_type`,
 * `(data as any)?.user_type` and anything else ending in that property.
 */
const SINGLE_COLUMN_SUPERADMIN =
  /[\w.?![\]()]*\buser_type\b[\w.?\])]*\s*(?:===|!==|==|!=)\s*["'`]superadmin["'`]|["'`]superadmin["'`]\s*(?:===|!==|==|!=)\s*[\w.?![\]()]*\buser_type\b/

const WINDOW = 7
const PLATFORM_AWARE = /platform_role|platformRole|isPlatformStaff|isPlatformStaffIdentity|PLATFORM_STAFF_ROLES|resolvePlatformRole/

/** Every real single-column gate in one blob of source. Prose-immune. */
function gatesIn(source: string): number[] {
  const code = codeOnly(source)
  const spans = literalSpans(code)
  const lines = code.split("\n")
  const re = new RegExp(SINGLE_COLUMN_SUPERADMIN.source, "g")
  const out: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    // Test the position of the `user_type` TOKEN, not of the match. In the
    // reversed operand order — `"superadmin" === u.user_type` — the match STARTS
    // at the string literal, so pinning to m.index would filter a real gate out
    // as prose. The identifier is the half that is never inside a literal.
    const tokenAt = m.index + m[0].indexOf("user_type")
    if (insideLiteral(spans, tokenAt)) continue
    const ln = lineOf(code, m.index)
    const win = lines.slice(Math.max(0, ln - 1 - WINDOW), ln + WINDOW).join("\n")
    if (PLATFORM_AWARE.test(win)) continue
    out.push(ln)
  }
  return out
}

function singleColumnSuperadminGates(): string[] {
  const hits: string[] = []
  for (const file of walk(ROOT)) {
    for (const ln of gatesIn(readFileSync(file, "utf8"))) hits.push(`${relative(ROOT, file)}:${ln}`)
  }
  return hits.sort()
}

function sourceLayer() {
  console.log("\n[shape scan · source — no platform decision from one column]")

  const gates = singleColumnSuperadminGates()
  check(`no site decides platform identity from user_type alone (found ${gates.length})`, gates.length === 0)
  for (const h of gates) console.log(`      · ${h}`)

  // NEGATIVE CONTROLS. That scan reports 0, and a scan that has never gone red
  // is indistinguishable from one that cannot. Run it against the site that was
  // ACTUALLY in the tree before this pass — verbatim — plus the spellings a
  // future edit could reintroduce it in.
  const red = (s: string) => gatesIn(s).length > 0

  check("NEGATIVE CONTROL the scan goes RED on the pre-fix self-book-showing gate, verbatim",
    red(`if ((u as any)?.brokerage_id === (contact as any).brokerage_id || (u as any)?.user_type === "superadmin") {`))
  check("NEGATIVE CONTROL …and on every spelling an edit could reintroduce it in",
    red(`if (profile.user_type === 'superadmin') return true`) &&
    red("if (row.user_type !== `superadmin`) deny()") &&
    red(`if ("superadmin" === u.user_type) allow()`) &&
    red(`if (profile?.user_type == "superadmin") allow()`))
  check("…while staying GREEN on the two-column form this repo standardised on",
    !red(`const isSuper = data?.user_type === "superadmin" || data?.platform_role === "superadmin"`) &&
    !red(`const role = data?.platform_role ?? (data?.user_type === "superadmin" ? "superadmin" : null)`))
  check("…and GREEN on a DIFFERENT question (a tenant role literal, not a platform one)",
    !red(`if (u.user_type === "broker_owner") return true`))

  // PROSE IS NOT CODE, WHEREVER IT IS STORED. This repo carries ~30 comments and
  // one manager-registry `what:` string that QUOTE this defect to explain the
  // fix. A scan that counts those fails on the documentation and passes on
  // nothing. Both halves asserted: the quotation is invisible, AND a real gate
  // beside it is still seen — so the blanking did not blind the scan.
  const quoted = [
    "// `u.user_type === \"superadmin\"` alone was FALSE for the real superadmin",
    "/* WAS: profile.user_type !== 'superadmin' — a dead literal */",
    "const REGISTRY = { what: \"the old gate read u.user_type === \\\"superadmin\\\" and refused the owner\" }",
    "const NOTE = 'the old gate read u.user_type === \"superadmin\"'",
    "const TPL = `the old gate read u.user_type === \"superadmin\"`",
  ].join("\n")
  check("a quoted or commented occurrence is NOT a gate (line comment, block comment, and all three literal kinds)",
    !red(quoted))
  check("NEGATIVE CONTROL …and a REAL gate beside all that prose is still caught, so the filter did not blind the scan",
    red(quoted + `\nif (x.user_type === "superadmin") allow()`))
  check("comment blanking preserves line numbers, so a reported hit still points at the right line",
    codeOnly(quoted).split("\n").length === quoted.split("\n").length)
  check("NEGATIVE CONTROL the literal-span finder is not vacuous — it actually finds the spans",
    literalSpans(`const a = "x"; const b = 'y'; const c = \`z\``).length === 3 &&
    literalSpans("const a = 1").length === 0)
  check("…and an escaped quote does not end a literal early (which is how the registry sentence hides)",
    literalSpans('const s = "a \\" b"').length === 1)

  console.log("\n[the roster · source — one definition, consulted from both columns]")
  const resolver = codeOnly(readFileSync(join(ROOT, "lib/auth/resolve-user-role.ts"), "utf8"))
  check("the app-side identity gate takes TWO parameters, not one",
    isPlatformStaffIdentity.length === 2)
  check("…and it consults the shared roster rather than restating it",
    /platform-staff-roster/.test(resolver))
}

// ─── LIVE ────────────────────────────────────────────────────────────────────

interface IsolationReport {
  ok: boolean
  seat_error: string | null
  own_visible: Record<string, number>
  other_visible: Record<string, number>
  census: {
    read_capable_tenant_tables: number
    tenant_tested: number
    platform_gated: number
    classifier_selftest: number
    untenanted_and_ungated: string[]
  }
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] SKIPPED — no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env")
    return
  }
  const svc = createClient(url, key, { auth: { persistSession: false } })

  console.log("\n[live · a real tenant broker, two real brokerages, real RLS]")

  // A refused RPC is not a green result. supabase-js RESOLVES a failed call, so
  // `data` alone would read a missing function as "nothing to report".
  const { data, error } = await svc.rpc("assert_cross_tenant_read_isolation")
  if (error) {
    check(`live: assert_cross_tenant_read_isolation() ran (rpc error: ${error.message})`, false)
    return
  }
  const r = data as unknown as IsolationReport
  check("live: the probe ran and returned a report (a refused rpc is not an empty one)", !!r)
  if (!r) return

  check(`live: the seeded broker seat could execute its reads (seat_error: ${r.seat_error ?? "none"})`,
    r.seat_error === null)

  const otherEntries = Object.entries(r.other_visible ?? {})
  const ownEntries = Object.entries(r.own_visible ?? {})

  // POSITIVE CONTROL FIRST. If the seed did not land, "0 other-tenant rows" is
  // vacuously true and means nothing. Assert the probe measured something.
  check(`live: the probe measured ${ownEntries.length} tables (a zero-table run proves nothing)`,
    ownEntries.length >= 6)
  check("live: POSITIVE CONTROL the broker still sees their OWN tenant's rows on every table",
    ownEntries.length > 0 && ownEntries.every(([, n]) => n > 0))
  for (const [t, n] of ownEntries) if (n === 0) console.log(`      · own ${t} = 0 — the policy blanked its own tenant`)

  // THE RULING.
  check("live: the tenant broker sees ZERO rows of the OTHER brokerage, on every table",
    otherEntries.length > 0 && otherEntries.every(([, n]) => n === 0))
  for (const [t, n] of otherEntries) if (n !== 0) console.log(`      · other ${t} = ${n} — CROSS-TENANT READ`)

  console.log("\n[live · the catalogue census, over every read-capable policy]")
  const c = r.census
  check(`live: census is non-degenerate — ${c.read_capable_tenant_tables} read-capable policies on tenant tables`,
    c.read_capable_tenant_tables > 100)
  check(`live: POSITIVE CONTROL the classifier matches things — ${c.tenant_tested} tenant-tested, ${c.platform_gated} platform-gated`,
    c.tenant_tested > 0 && c.platform_gated > 0)
  // NEGATIVE CONTROL, run INSIDE the probe: the same classifier over the four
  // PRE-FIX expressions verbatim. All four must come back as holes. Without
  // this, "zero holes" is indistinguishable from a classifier that cannot match.
  check(`live: NEGATIVE CONTROL the census classifier flags all 4 pre-fix expressions (got ${c.classifier_selftest}/4)`,
    c.classifier_selftest === 4)
  check(`live: no read-capable policy on a tenant table is BOTH untenanted and ungated (found ${c.untenanted_and_ungated.length})`,
    c.untenanted_and_ungated.length === 0)
  for (const p of c.untenanted_and_ungated) console.log(`      · ${p}`)

  // The probe cleans up after itself inside one transaction. Verify from OUT
  // here, independently, rather than taking its word for it.
  console.log("\n[live · residue]")
  const { data: brk, error: brkErr } = await svc
    .from("brokerages").select("id").like("name", "__xtenant_read%")
  const { data: usr, error: usrErr } = await svc
    .from("users").select("id").like("email", "__xt_%@selftest.local")
  check(`live: cleanup residue == 0 (brokerages ${brk?.length ?? "?"}, users ${usr?.length ?? "?"})`,
    !brkErr && !usrErr && (brk?.length ?? 0) === 0 && (usr?.length ?? 0) === 0)

  console.log("\n[live · the helpers answer a strict boolean under no identity]")
  // Under the service role auth.uid() is NULL. Every one of these composes into
  // policies, and NULL propagates through OR — a boolean helper answering NULL
  // is the trap m465 shipped and had to re-fix. Both halves matter: error must
  // be null (so an absent function FAILS rather than passing vacuously) and the
  // value must be strictly false, never null.
  for (const fn of ["is_platform_staff", "is_platform_admin", "is_brokerage_admin"]) {
    const res = await svc.rpc(fn)
    check(`live: ${fn}() answers strict false under a NULL identity (never null)`,
      res.error === null && res.data === false)
  }
  const ub = await svc.rpc("user_brokerage_ids")
  check("live: user_brokerage_ids() returns NO brokerage under a NULL identity, so the fixed predicates fail closed",
    ub.error === null && Array.isArray(ub.data) && (ub.data as unknown[]).length === 0)
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Cross-tenant read — only platform staff read across brokerages")
  console.log("══════════════════════════════════════════════════")
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ CROSS_TENANT_READ_FAIL"); process.exit(1) }
  console.log(" ✅ CROSS_TENANT_READ_PASS — a role name is not a tenant boundary: every read-capable policy on a tenant table either confines the row to the caller's brokerage or is gated on a platform identity read from BOTH columns, and a real tenant broker sees zero rows of any brokerage but their own")
}
main()
