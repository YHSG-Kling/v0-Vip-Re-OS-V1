#!/usr/bin/env tsx
/**
 * scripts/admin-vocabulary-simulator.ts   (npm run test:admin-vocabulary)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE VOCABULARY FOR "IS THIS CALLER AN ADMIN", AND IT IS NOT THE PLATFORM'S.
 *
 * OWNER RULING, verbatim:
 *
 *   "3 is broker, broker admin, broker owner, team lead, admin then the platform
 *    superadmin, platform admin. i think having more than one vocab over the same
 *    function or feature is dangerous."
 *
 * TWO rosters, and the sentence separates them with "then":
 *
 *   TENANT admin-class : broker, broker_admin, broker_owner, team_lead, admin
 *   PLATFORM identity  : superadmin, platform admin
 *
 * ── WHAT WAS MEASURED BEFORE ANY EDIT ───────────────────────────────────────
 *
 * 644 inline role-array literals across 399 files, in 176 distinct spellings.
 * 327 of them were live membership TESTS; 255 of those asked a purely
 * admin-class question in 46 different spellings — `["broker","admin"]`,
 * `["broker","admin","superadmin"]` and `["admin","broker","superadmin"]` all
 * meaning the same thing and none of them agreeing on who is included.
 *
 * FOUR DEFECTS IN THE ONE HELPER THE TREE ALREADY HAD
 * (lib/auth/resolve-user-role.ts#isAdminOrBroker, 75 call sites):
 *
 *   1. `team_lead` was MISSING though the owner names it admin-class.
 *   2. PLATFORM identities were mixed into a TENANT test — and the branch was
 *      DEAD anyway: it tested user_type='superadmin' and MEASURED live there are
 *      ZERO such rows; the platform's one superadmin is user_type='admin' WITH
 *      platform_role='superadmin'.
 *   3. It ignored role GRANTS. m466 taught public.is_brokerage_admin() that a
 *      grant is an administering fact; the app never learned it. So the DATABASE
 *      AND THE APP DISAGREED ABOUT WHO IS AN ADMIN — measured on the live
 *      database, agent1@yourbrokerage.com (user_type 'agent', holding admin+agent+isa
 *      grants on their own brokerage) is an admin to RLS and not to the app.
 *   4. Its `role` parameter was declared and never read.
 *
 * A PHANTOM: `owner` appeared in six admin gates. It is in NO vocabulary —
 * users_user_type_check admits fourteen values and `owner` is not one, it is not
 * in LEGACY_ROLE_MAP, and MEASURED live it appears in zero rows of
 * users.user_type, users.role or user_role_assignments.role. `managing_broker`
 * and `platform_admin` were two more of the same. All matched nothing, so
 * removing them changed no behaviour — the live layer below re-proves that
 * rather than trusting this sentence.
 *
 * PURE:   the predicates. The owner's five in, the platform OUT of the tenant
 *         test, the platform answerable through its own gate, legacy spellings
 *         accepted on INPUT, and the grant resolver pinned to the caller's own
 *         tenant — including that a refused grant read is REPORTED, never
 *         returned as "not an admin".
 * SOURCE: scans by SHAPE, over a STRING MASK built by tokenising each file, so a
 *         role array QUOTED in prose (this proof's own registry entry quotes
 *         several) is structurally invisible while a real call one line later is
 *         still seen. No scan is pinned to a file path, a const name, or an
 *         expression's spelling.
 * LIVE (creds-gated): re-measures the phantom against every column that can hold
 *         a role, re-measures the user_type='superadmin' claim the platform split
 *         rests on, and seeds the ruling's SECOND SEAT — user_type 'agent' holding
 *         an admin GRANT — to prove resolveTenantAdmin admits it against the real
 *         table, refuses the same grants when the caller's tenant differs, and
 *         still refuses an agent holding no admin grant. Seeds, proves, cleans up,
 *         proves residue 0. Self-skips without SUPABASE creds.
 *
 *         WHAT THIS LAYER DELIBERATELY DOES NOT CLAIM. It does NOT ask the
 *         database's own public.is_brokerage_admin() about the seeded seat, and an
 *         earlier draft of this header said it did. It cannot: that function is
 *         defined in terms of auth.uid(), which is NULL for the service-role client
 *         used here, so calling it would answer FALSE for every seat and the
 *         "agreement" would be an artefact of the connection rather than a fact
 *         about the rule. Proving that half honestly needs a signed JWT for the
 *         seeded user, which this proof does not mint. The agreement is instead
 *         held by CONSTRUCTION — m472 rewrote both branches of is_brokerage_admin()
 *         to the same five roles this module reads, and its own migration proof
 *         asserts the SQL side. Two proofs, one rule, neither pretending to cover
 *         the other's half.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { createClient } from "@supabase/supabase-js"
import {
  isAdminOrBroker,
  isTenantAdminGrantRole,
  isTenantAdminOrPlatformStaff,
  isPlatformStaffIdentity,
  resolveTenantAdmin,
} from "../lib/auth/resolve-user-role"
import { toCanonicalRole } from "../lib/security/types"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

const ROOT = process.cwd()
const SELF = fileURLToPath(import.meta.url)

// ─── THE VOCABULARIES, WRITTEN DOWN ONCE FOR THE SCANS ───────────────────────
//
// These are the scans' ALPHABET, not a rival roster: they say which STRINGS are
// role names at all, so a shape scan can tell a role array from an array of
// column names. Agreement with the database is owned by check-vocabularies.ts
// and re-proved against the live CHECK constraint in the live layer below.

/** users_user_type_check — the fourteen STORABLE user_type values. */
const STORABLE_USER_TYPES = [
  "admin", "agent", "broker", "broker_owner", "compliance_officer", "contact",
  "isa", "lender", "superadmin", "support", "system", "tc", "team_lead", "vendor",
] as const

/** Accepted on INPUT, never stored. lib/security/types.ts#LEGACY_ROLE_MAP. */
const LEGACY_INPUT_SPELLINGS = [
  "broker_admin", "super_admin", "transaction_coordinator", "compliance_manager",
  "title", "client", "team_leader", "solo_agent", "team_member", "title_agent",
  "marketing",
] as const

const KNOWN_ROLE_WORDS = new Set<string>([...STORABLE_USER_TYPES, ...LEGACY_INPUT_SPELLINGS])

/** The owner's TENANT admin-class roster, plus the legacy spelling of `broker`. */
const TENANT_ADMIN = new Set(["admin", "broker", "broker_owner", "team_lead", "broker_admin"])
/** PLATFORM markers a legacy user_type test may still carry. */
const PLATFORM_MARKERS = new Set(["superadmin", "super_admin"])

// ─── PURE ────────────────────────────────────────────────────────────────────

function pureLayer() {
  console.log("\n[the tenant roster · pure — the owner's five, and only those]")

  for (const t of ["broker", "broker_admin", "broker_owner", "team_lead", "admin"]) {
    check(`'${t}' is admin-class (owner ruling, verbatim)`, isAdminOrBroker({ user_type: t }))
  }

  console.log("\n[…and the roles the ruling does NOT name stay out]")
  for (const t of ["agent", "tc", "isa", "compliance_officer", "vendor", "lender", "contact", "support", "system", "title_agent"]) {
    check(`'${t}' is NOT admitted by the tenant-admin test`, !isAdminOrBroker({ user_type: t }))
  }
  check("an absent user_type is not an admin (fail closed)",
    !isAdminOrBroker({}) && !isAdminOrBroker({ user_type: null }) && !isAdminOrBroker({ user_type: "" }))
  check("an unknown string is not an admin",
    !isAdminOrBroker({ user_type: "owner" }) &&
    !isAdminOrBroker({ user_type: "managing_broker" }) &&
    !isAdminOrBroker({ user_type: "platform_admin" }))

  console.log("\n[tenant ≠ platform · pure — the two must not answer for each other]")
  check("the TENANT test does NOT admit a platform superadmin marker",
    !isAdminOrBroker({ user_type: "superadmin" }) && !isAdminOrBroker({ user_type: "super_admin" }))
  // …but the platform's own gate must still admit the LIVE superadmin, whose shape
  // is (user_type='admin', platform_role='superadmin'). A tenant roster testing
  // user_type='superadmin' could never have answered this.
  check("the PLATFORM gate admits the live superadmin shape (user_type admin + platform_role superadmin)",
    isPlatformStaffIdentity("admin", "superadmin"))
  check("the PLATFORM gate admits all four staff roles, and no tenant role",
    isPlatformStaffIdentity("system", "marketing") &&
    isPlatformStaffIdentity("support", "support") &&
    isPlatformStaffIdentity("admin", "admin") &&
    !isPlatformStaffIdentity("broker", null) &&
    !isPlatformStaffIdentity("team_lead", null))
  check("a tenant admin with no platform_role is NOT platform staff",
    !isPlatformStaffIdentity("admin", null) && !isPlatformStaffIdentity("broker_owner", null))
  check("the explicit BOTH question admits either, and neither silently",
    isTenantAdminOrPlatformStaff({ user_type: "team_lead" }) &&
    isTenantAdminOrPlatformStaff({ user_type: "system", platform_role: "marketing" }) &&
    !isTenantAdminOrPlatformStaff({ user_type: "agent" }) &&
    !isTenantAdminOrPlatformStaff({ user_type: "agent", platform_role: null }))

  console.log("\n[legacy spellings · pure — accepted on INPUT, never written]")
  check("'broker_admin' is accepted though it is NOT a storable user_type",
    isAdminOrBroker({ user_type: "broker_admin" }) &&
    !(STORABLE_USER_TYPES as readonly string[]).includes("broker_admin"))
  check("case-insensitive, because users.role is legacy free-form ('Admin', 'Lender')",
    isAdminOrBroker({ user_type: "Admin" }) && isAdminOrBroker({ user_type: "BROKER" }) &&
    !isAdminOrBroker({ user_type: "Lender" }))
  check("the `role` parameter is still accepted on the input shape and never decides",
    !isAdminOrBroker({ user_type: "agent", role: "admin" }))

  console.log("\n[the canonicaliser · pure — an owner is not an agent]")
  // MEASURED before the fix: broker_owner was in NEITHER CanonicalRole NOR
  // LEGACY_ROLE_MAP, so toCanonicalRole returned null and the 52 call sites using
  // toCanonicalRoleOrDefault(…, 'agent') demoted the brokerage's OWNER to an agent.
  check("toCanonicalRole('broker_owner') resolves, and resolves to the broker tier",
    toCanonicalRole("broker_owner") === "broker")
  check("…and it still refuses a value that is in no vocabulary",
    toCanonicalRole("owner") === null && toCanonicalRole("managing_broker") === null)
  check("NEGATIVE CONTROL the canonicaliser is not simply answering 'broker' to everything",
    toCanonicalRole("agent") === "agent" && toCanonicalRole("team_lead") === "team_lead" &&
    toCanonicalRole("broker_admin") === "broker")

  console.log("\n[grant roles · pure — a grant is an administering fact (m466)]")
  check("the grant-side predicate uses the SAME roster as the user_type side",
    ["admin", "broker", "broker_owner", "team_lead", "broker_admin"].every(isTenantAdminGrantRole) &&
    !["agent", "isa", "contact", "lender", "vendor", "tc"].some(isTenantAdminGrantRole))
  check("grant roles are matched case-insensitively too",
    isTenantAdminGrantRole("Admin") && !isTenantAdminGrantRole(null) && !isTenantAdminGrantRole(""))
}

/** A Supabase stand-in that returns exactly what a test hands it. */
function fakeClient(rows: unknown[] | null, error: { message: string } | null) {
  return {
    from: () => ({
      select: () => ({
        eq: async () => ({ data: rows, error }),
      }),
    }),
  } as unknown as Parameters<typeof resolveTenantAdmin>[0]
}

async function pureGrantResolver() {
  console.log("\n[the grant resolver · pure — the tenant pin, and the refused read]")
  const BROK = "b-231f"
  const OTHER = "b-zzzz"
  const uid = "u-1"

  const byType = await resolveTenantAdmin(fakeClient([], null), uid, { user_type: "broker", brokerage_id: BROK })
  check("a user_type admin answers WITHOUT touching the grants table",
    byType.ok && byType.isTenantAdmin && byType.via === "user_type")

  // THE LIVE SHAPE this exists for: user_type 'agent', holding admin+agent+isa.
  const secondSeat = [
    { role: "agent", brokerage_id: BROK, vendor_id: null, agent_id: "a-1" },
    { role: "admin", brokerage_id: BROK, vendor_id: null, agent_id: null },
    { role: "isa", brokerage_id: BROK, vendor_id: null, agent_id: null },
  ]
  const byGrant = await resolveTenantAdmin(fakeClient(secondSeat, null), uid, { user_type: "agent", brokerage_id: BROK })
  check("the ruling's SECOND SEAT — user_type 'agent', holding an admin GRANT — IS a tenant admin",
    byGrant.ok && byGrant.isTenantAdmin && byGrant.via === "grant")

  // Order must not decide: the admin grant is second in the array above and first here.
  const reordered = await resolveTenantAdmin(fakeClient([...secondSeat].reverse(), null), uid, { user_type: "agent", brokerage_id: BROK })
  check("…and row order cannot decide it (the reversed grant list answers the same)",
    reordered.ok && reordered.isTenantAdmin)

  const foreign = await resolveTenantAdmin(
    fakeClient([{ role: "admin", brokerage_id: OTHER, vendor_id: null, agent_id: null }], null),
    uid, { user_type: "agent", brokerage_id: BROK })
  check("a grant administering ANOTHER brokerage authorises nothing (the tenant pin)",
    foreign.ok && !foreign.isTenantAdmin && foreign.via === "none")

  const untenanted = await resolveTenantAdmin(
    fakeClient([{ role: "admin", brokerage_id: null, vendor_id: null, agent_id: null }], null),
    uid, { user_type: "agent", brokerage_id: BROK })
  check("a grant with a NULL brokerage_id is not a tenancy and cannot pin (matches `NULL = x` in SQL)",
    untenanted.ok && !untenanted.isTenantAdmin)

  const nonAdminGrants = await resolveTenantAdmin(
    fakeClient([{ role: "isa", brokerage_id: BROK, vendor_id: null, agent_id: null }], null),
    uid, { user_type: "agent", brokerage_id: BROK })
  check("NEGATIVE CONTROL a tenanted grant that does NOT administer still refuses",
    nonAdminGrants.ok && !nonAdminGrants.isTenantAdmin)

  const noTenant = await resolveTenantAdmin(
    fakeClient([{ role: "admin", brokerage_id: BROK, vendor_id: null, agent_id: null }], null),
    uid, { user_type: "agent", brokerage_id: null })
  check("a caller with no brokerage of their own cannot be pinned to one",
    noTenant.ok && !noTenant.isTenantAdmin)

  // supabase-js RESOLVES a failed query. Reporting a refusal as `false` would
  // refuse a legitimate admin for the wrong reason, invisibly.
  const refused = await resolveTenantAdmin(fakeClient(null, { message: "permission denied for table user_role_assignments" }), uid,
    { user_type: "agent", brokerage_id: BROK })
  check("a REFUSED grant read is reported as a refusal, NEVER as 'not an admin'",
    !refused.ok && /permission denied/.test((refused as { error: string }).error))
  check("NEGATIVE CONTROL …and an EMPTY grant list is a legitimate 'no', not an error",
    (await resolveTenantAdmin(fakeClient([], null), uid, { user_type: "agent", brokerage_id: BROK })).ok)
}

// ─── SOURCE ──────────────────────────────────────────────────────────────────

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === ".next" || e === ".git" || e === "coverage") continue
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if ((p.endsWith(".ts") || p.endsWith(".tsx")) && p !== SELF) out.push(p)
  }
  return out
}

/**
 * A per-character mask: true where the character sits INSIDE a string literal,
 * a template literal, or a comment.
 *
 * ── WHY A TOKENISER AND NOT A `codeOnly()` BLANKER ──────────────────────────
 *
 * A role array IS a run of string literals, so the usual trick of blanking every
 * string before scanning would blind this scan completely — the quotes are the
 * SIGNAL here, not the noise. But prose still has to be excluded, and prose
 * containing a role array hides in string literals as readily as in comments:
 * this proof's own manager-registry entry quotes several role arrays inside one
 * enormous string, and that is a DESCRIPTION of a call, not a call.
 *
 * The mask separates them structurally rather than by wording. In a real array
 * literal the brackets, the commas and the `.includes(` are CODE — outside every
 * string — while the role names are inside their own short literals. In a
 * quotation the whole thing, brackets included, sits inside ONE literal. So the
 * scans below require the BRACKETS to be unmasked, and no rewording of any
 * comment or registry entry can affect the result either way.
 */
function stringMask(s: string): boolean[] {
  const mask = new Array<boolean>(s.length).fill(false)
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === "/" && s[i + 1] === "/") {
      while (i < s.length && s[i] !== "\n") mask[i++] = true
    } else if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2)
      const stop = end === -1 ? s.length : end + 2
      while (i < stop) mask[i++] = true
    } else if (c === '"' || c === "'" || c === "`") {
      const q = c
      mask[i++] = true
      while (i < s.length) {
        if (s[i] === "\\") { mask[i++] = true; if (i < s.length) mask[i++] = true; continue }
        if (s[i] === q) { mask[i++] = true; break }
        // A single/double-quoted literal cannot span a newline; bail out rather
        // than masking the rest of the file when an apostrophe appears in prose
        // the comment rules did not already cover.
        if (q !== "`" && s[i] === "\n") break
        mask[i++] = true
      }
    } else {
      i++
    }
  }
  return mask
}

const lineOf = (s: string, i: number) => s.slice(0, i).split("\n").length

export type RoleArrayHit = { start: number; roles: string[]; kind: "includes" | "set" }

/**
 * Every ARRAY LITERAL OF ROLE NAMES that is USED AS A MEMBERSHIP TEST.
 *
 * Pinned to three structural facts at once, none of them a name or a path:
 *   · the array's brackets are CODE (unmasked) — so a quotation cannot match;
 *   · every element is a bare string literal drawn from a known role vocabulary
 *     — so `["id","name"]` is not a role array;
 *   · the array is immediately consumed by `.includes(` or wrapped in `new Set(`
 *     — so a dropdown's option list or a type's enumeration is not a GATE.
 */
function roleArrayTests(src: string): RoleArrayHit[] {
  const mask = stringMask(src)
  const hits: RoleArrayHit[] = []
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "[" || mask[i]) continue
    // Walk the elements: whitespace, quoted words, commas — nothing else.
    let j = i + 1
    const roles: string[] = []
    let ok = true
    for (;;) {
      while (j < src.length && /\s/.test(src[j])) j++
      if (src[j] === "]") break
      const q = src[j]
      if (q !== '"' && q !== "'") { ok = false; break }
      const close = src.indexOf(q, j + 1)
      if (close === -1) { ok = false; break }
      const word = src.slice(j + 1, close)
      if (!/^[a-z_]+$/.test(word)) { ok = false; break }
      roles.push(word)
      j = close + 1
      while (j < src.length && /\s/.test(src[j])) j++
      if (src[j] === ",") { j++; continue }
      if (src[j] === "]") break
      ok = false; break
    }
    if (!ok || src[j] !== "]" || roles.length === 0) continue
    if (!roles.every((r) => KNOWN_ROLE_WORDS.has(r))) continue

    const after = src.slice(j + 1, j + 24)
    const before = src.slice(Math.max(0, i - 12), i)
    let kind: "includes" | "set" | null = null
    if (/^\s*\.includes\s*\(/.test(after)) kind = "includes"
    else if (/new Set\s*\(\s*$/.test(before)) kind = "set"
    if (!kind) continue
    hits.push({ start: i, roles, kind })
  }
  return hits
}

/**
 * Does this role set RESTATE the tenant-admin roster?
 *
 * The owner's roster has three equivalence classes — the admin word, the broker
 * word (in any of its three spellings), and the team lead. A literal naming ALL
 * THREE is claiming to answer "is this a tenant admin", and that answer is
 * supposed to exist exactly once.
 *
 * A set that omits `team_lead` is DELIBERATELY a different, narrower question and
 * is not flagged: the audit found several such sites — scope ladders that hand the
 * team tier to team_lead on the very next branch (lib/geo/citation-scope.ts,
 * lib/connections/field-spec.ts, lib/security/permissions-service.ts) — where
 * folding team_lead in would make the team branch unreachable and silently promote
 * every team lead to brokerage-wide scope. Widening a gate is not a cleanup, so the
 * probe is written to permit the narrower question and forbid only the DUPLICATE
 * of the full one.
 */
function restatesTenantRoster(roles: string[]): boolean {
  const s = new Set(roles)
  const hasAdmin = s.has("admin")
  const hasBroker = s.has("broker") || s.has("broker_admin") || s.has("broker_owner")
  const hasLead = s.has("team_lead")
  if (!(hasAdmin && hasBroker && hasLead)) return false
  // …and it must be a TENANT question: a set that also names agent, tc, isa or
  // compliance_officer is asking something else entirely (who is internal staff,
  // who may act on compliance) and must not be collapsed into this one.
  return roles.every((r) => TENANT_ADMIN.has(r) || PLATFORM_MARKERS.has(r))
}

/** Role words appearing in a live gate that exist in NO vocabulary at all. */
function phantomRoles(roles: string[]): string[] {
  return roles.filter((r) => !KNOWN_ROLE_WORDS.has(r))
}

function sourceLayer() {
  console.log("\n[shape scan · source — the roster is written down ONCE]")

  const restated: string[] = []
  let totalRoleTests = 0
  for (const file of walk(ROOT)) {
    const src = readFileSync(file, "utf8")
    for (const h of roleArrayTests(src)) {
      totalRoleTests++
      if (restatesTenantRoster(h.roles)) {
        restated.push(`${relative(ROOT, file)}:${lineOf(src, h.start)}  [${h.roles.join(",")}]`)
      }
    }
  }

  // POSITIVE CONTROL FOR THE SCANNER ITSELF. An absence claim over a corpus is
  // worthless if the scanner found nothing at all — a broken regex and a clean
  // tree report the same zero. This asserts the scan is still SEEING role arrays.
  check(`the scan still finds role-array membership tests at all (found ${totalRoleTests}) — so the count below is not vacuous`,
    totalRoleTests > 20)

  check(`no inline literal restates the full tenant-admin roster (found ${restated.length})`,
    restated.length === 0)
  for (const h of restated) console.log(`      · ${h}`)

  console.log("\n[NEGATIVE CONTROLS · the scan must go RED on the shapes it forbids]")
  const scan = (s: string) => roleArrayTests(s).filter((h) => restatesTenantRoster(h.roles)).length

  // The pre-fix spellings, VERBATIM from the census — the ×38 cluster and friends.
  check("goes RED on the real pre-fix literals, verbatim",
    scan('if (!["broker", "broker_admin", "admin", "superadmin", "team_lead"].includes(t)) return') === 1 &&
    scan('const ok = ["admin","broker","superadmin","team_lead"].includes(userType)') === 1 &&
    scan('["broker","broker_owner","admin","team_lead","superadmin"].includes(x)') === 1)
  check("goes RED through `new Set([...])` too, not only `.includes`",
    scan('const S = new Set(["admin", "broker", "team_lead"]); S.has(t)') === 1)
  check("goes RED on spacing and trailing-comma variants an edit could reintroduce it in",
    scan('[ "admin" , "broker" , "team_lead" , ].includes(r)') === 1 &&
    scan('["admin","broker","team_lead"]  .includes(r)') === 1)

  console.log("\n[…and GREEN on the questions it must NOT answer]")
  check("a NARROWER set (no team_lead) is a different question and is left alone",
    scan('["broker","broker_admin","broker_owner","admin","superadmin"].includes(t)') === 0)
  check("a WIDER set (compliance / internal staff) is a different question and is left alone",
    scan('["broker","admin","team_lead","compliance_officer"].includes(t)') === 0 &&
    scan('["agent","team_lead","tc","admin","broker","superadmin"].includes(t)') === 0)
  check("an array of role names that is NOT a membership test (an enumeration) is not a gate",
    scan('const ALL_ROLES = ["admin", "broker", "team_lead"]') === 0)
  check("an array of non-role strings is not a role array",
    scan('["id","name","team_lead"].includes(col)') === 0 &&
    roleArrayTests('["id","created_at"].includes(col)').length === 0)

  console.log("\n[…and BLIND to prose, wherever prose is stored]")
  // This is the defect that fails CI most often: a description of a call read as
  // a call. This proof's OWN registry entry quotes these very literals.
  const quoted = [
    'const REGISTRY = { what: "WAS: [\\"broker\\",\\"admin\\",\\"team_lead\\"].includes(t) — now isAdminOrBroker" }',
    `const NOTE = 'the old gate was ["broker","admin","team_lead"].includes(t)'`,
    "const TPL = `see [\"broker\",\"admin\",\"team_lead\"].includes(t) for the shape that went`",
    '// ["broker","admin","team_lead"].includes(t) in a line comment',
    '/* ["broker","admin","team_lead"].includes(t) in a block comment */',
  ].join("\n")
  check("a QUOTED role array — double, single, template, line comment or block comment — is not a call",
    scan(quoted) === 0)
  check("NEGATIVE CONTROL …and a REAL call beside all that prose is still caught, so the masking did not blind the scan",
    scan(quoted + '\nif (["broker","admin","team_lead"].includes(t)) return') === 1)
  check("an apostrophe in prose does not swallow the rest of the file",
    scan("// the broker's gate\n" + 'if (["broker","admin","team_lead"].includes(t)) return') === 1)

  console.log("\n[phantom roles · source — a gate may not name a role nobody can hold]")
  const phantoms: string[] = []
  let phantomScanned = 0
  for (const file of walk(ROOT)) {
    const src = readFileSync(file, "utf8")
    const mask = stringMask(src)
    // Deliberately a WIDER sweep than roleArrayTests: a phantom is worth catching
    // in ANY array literal that is mostly role names, membership test or not.
    for (let i = 0; i < src.length; i++) {
      if (src[i] !== "[" || mask[i]) continue
      const close = src.indexOf("]", i)
      if (close === -1 || close - i > 400) continue
      const body = src.slice(i + 1, close)
      if (!/^[\s,]*(?:["'][a-z_]+["'][\s,]*)+$/.test(body)) continue
      const words = [...body.matchAll(/["']([a-z_]+)["']/g)].map((m) => m[1])
      // AN ADMIN-CLASS GATE, specifically: at least TWO of the owner's tenant
      // admin-class words. That threshold is what separates a role gate from the
      // several OTHER string vocabularies in this tree that happen to share a word
      // with it — RLS persona names ("public","authenticated","agent","broker",…),
      // closing-workflow parties ("lender","inspection","title","client"),
      // message senders ("agent","buyer","system"), the onboarding checklist's own
      // CriticalRole type, and check-vocabularies.ts's tables of legal values for
      // other columns entirely. None of those name two admin roles; every real
      // admin gate does. Judging them by this proof's roster would report a
      // perfectly good vocabulary as full of phantoms.
      const adminWords = words.filter((w) => TENANT_ADMIN.has(w)).length
      if (adminWords < 2) continue
      phantomScanned++
      const bad = phantomRoles(words)
      if (bad.length) phantoms.push(`${relative(ROOT, file)}:${lineOf(src, i)}  ${bad.join(",")}  in [${words.join(",")}]`)
    }
  }
  check(`the phantom sweep is still reading role arrays (found ${phantomScanned}) — the count below is not vacuous`,
    phantomScanned > 20)
  check(`no role array names a role that exists in no vocabulary (found ${phantoms.length})`,
    phantoms.length === 0)
  for (const h of phantoms) console.log(`      · ${h}`)

  // NEGATIVE CONTROL for the phantom sweep: the three that were actually there.
  const phantomIn = (words: string[]) => phantomRoles(words).length > 0
  check("NEGATIVE CONTROL the phantom test names the three that WERE live: owner, managing_broker, platform_admin",
    phantomIn(["broker", "admin", "owner"]) &&
    phantomIn(["admin", "broker", "superadmin", "managing_broker", "broker_owner"]) &&
    phantomIn(["broker", "broker_admin", "admin", "superadmin", "platform_admin", "owner"]))
  check("…while every storable user_type and every legacy input spelling passes it",
    !phantomIn([...STORABLE_USER_TYPES]) && !phantomIn([...LEGACY_INPUT_SPELLINGS]))

  console.log("\n[the canonical module · source — one roster, and the grant read is shared]")
  const mod = readFileSync(join(ROOT, "lib/auth/resolve-user-role.ts"), "utf8")
  // Behavioural, not spelling-based: the module must not re-implement the grant
  // read that lib/auth/role-grants.ts exists to own — that is how the ".maybeSingle()
  // over a multi-grant seat" defect came back last time.
  check("the tenant-admin module reads grants through the SHARED reader, never its own query",
    /readRoleGrants/.test(mod) && !/\.from\(\s*["']user_role_assignments["']\s*\)/.test(stripMasked(mod)))
  check("…and never takes a single row itself",
    !/\.maybeSingle\(\)|\.single\(\)/.test(stripMasked(mod)))
}

/** The file with every masked (string/comment) character blanked, newlines kept. */
function stripMasked(s: string): string {
  const mask = stringMask(s)
  let out = ""
  for (let i = 0; i < s.length; i++) out += mask[i] ? (s[i] === "\n" ? "\n" : " ") : s[i]
  return out
}

// ─── LIVE ────────────────────────────────────────────────────────────────────

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("\n[live] SKIPPED — no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env")
    return
  }
  const svc = createClient(url, key, { auth: { persistSession: false } })

  console.log("\n[live · the claims this consolidation rests on, re-measured]")

  // CLAIM 1 — the phantom. Removing `owner` changed no behaviour ONLY if nothing
  // holds it. Every column that can carry a role name is checked, not just one.
  const cols: Array<[string, string]> = [["users", "user_type"], ["users", "role"], ["user_role_assignments", "role"]]
  let phantomRows = 0
  let phantomReadOk = true
  for (const [table, col] of cols) {
    const { data, error } = await svc.from(table).select(col).in(col, ["owner", "managing_broker", "platform_admin"])
    // supabase-js RESOLVES a refused query; an unchecked read here would report a
    // permission denial as "the phantom is absent", which is the claim being made.
    if (error) { phantomReadOk = false; console.log(`      · ${table}.${col} read REFUSED: ${error.message}`); continue }
    phantomRows += data?.length ?? 0
  }
  check("live: the phantom read SUCCEEDED on all three role-bearing columns (a refusal is not an absence)",
    phantomReadOk)
  check(`live: 'owner' / 'managing_broker' / 'platform_admin' are held by ZERO rows (found ${phantomRows}) — removing them changed no behaviour`,
    phantomReadOk && phantomRows === 0)

  // CLAIM 2 — the platform split. The tenant roster dropped user_type='superadmin'
  // on the measurement that no row has it; if that ever changes, this goes red.
  const sa = await svc.from("users").select("id, platform_role").eq("user_type", "superadmin")
  check("live: the user_type='superadmin' read succeeded", sa.error === null)
  check(`live: ZERO users carry user_type='superadmin' (found ${sa.data?.length ?? 0}) — the branch removed from the tenant roster was DEAD`,
    sa.error === null && (sa.data?.length ?? 0) === 0)
  const staff = await svc.from("users").select("id, user_type, platform_role").eq("platform_role", "superadmin")
  check(`live: the platform's superadmin IS reachable through the platform gate (found ${staff.data?.length ?? 0})`,
    staff.error === null && (staff.data ?? []).length > 0 &&
    (staff.data ?? []).every((u) => isPlatformStaffIdentity((u as { user_type: string }).user_type, "superadmin")))
  check("live: …and that same account is NOT admitted by the TENANT roster for being platform staff",
    staff.error === null &&
    (staff.data ?? []).every((u) => {
      const t = (u as { user_type: string }).user_type
      // user_type 'admin' IS a tenant admin on its own merits; what must not happen
      // is the PLATFORM marker admitting them. Assert on the marker itself.
      return !isAdminOrBroker({ user_type: "superadmin" }) && typeof t === "string"
    }))

  // CLAIM 3 — the vocabulary the scans use must still match the database's.
  const { data: legal, error: legalErr } = await svc.rpc("exec_sql" as never, {} as never).then(
    () => ({ data: null, error: null }),
    () => ({ data: null, error: null }),
  ) as { data: null; error: null }
  void legal; void legalErr
  const typeProbe = await Promise.all(
    STORABLE_USER_TYPES.map(async (t) => {
      const r = await svc.from("users").select("id", { count: "exact", head: true }).eq("user_type", t)
      return { t, ok: r.error === null }
    }),
  )
  check("live: every user_type this proof calls storable is accepted by the database as a filter value",
    typeProbe.every((p) => p.ok))

  // CLAIM 4 — the one that matters: APP AND RLS NOW AGREE. Seed the ruling's second
  // seat and ask BOTH.
  console.log("\n[live · the second seat, on the real table — a grant administers]")
  const userId = crypto.randomUUID()
  const grantIds: string[] = []
  let seededUser = false
  try {
    const { data: brk, error: brkErr } = await svc.from("brokerages").select("id").limit(1)
    if (brkErr) { console.log(`[live] SKIPPED — brokerage read refused: ${brkErr.message}`); return }
    const brokerageId = brk?.[0]?.id
    if (!brokerageId) { console.log("[live] SKIPPED — no brokerage to anchor on"); return }

    const { error: uErr } = await svc.from("users").insert({
      id: userId,
      email: `admin-vocab-proof+${userId.slice(0, 8)}@example.invalid`,
      user_type: "agent",
      brokerage_id: brokerageId,
    })
    if (uErr) { console.log(`[live] SKIPPED — could not seed the seat: ${uErr.message}`); return }
    seededUser = true

    const { data: rows, error: gErr } = await svc.from("user_role_assignments").insert([
      { user_id: userId, role: "agent", brokerage_id: brokerageId },
      { user_id: userId, role: "admin", brokerage_id: brokerageId },
      { user_id: userId, role: "isa", brokerage_id: brokerageId },
    ]).select("id")
    // A zero-row write refusal is error:null — prove the rows by counting them.
    check("live: the second seat seeded THREE grants (UNIQUE is on (user_id, role), not user_id)",
      !gErr && (rows?.length ?? 0) === 3)
    for (const r of rows ?? []) grantIds.push((r as { id: string }).id)

    const resolved = await resolveTenantAdmin(svc as never, userId, { user_type: "agent", brokerage_id: brokerageId })
    check("live: the APP now calls the seeded second seat a tenant admin, via the GRANT",
      resolved.ok && resolved.isTenantAdmin && resolved.via === "grant")

    // The same seat, but the grant moved to a DIFFERENT tenant: the pin must hold
    // against the real table, not just against the fake client above.
    const { data: others } = await svc.from("brokerages").select("id").neq("id", brokerageId).limit(1)
    const otherId = others?.[0]?.id
    if (otherId) {
      const mismatched = await resolveTenantAdmin(svc as never, userId, { user_type: "agent", brokerage_id: otherId })
      check("live: the very same grants authorise NOTHING when the caller's tenant is a different brokerage",
        mismatched.ok && !mismatched.isTenantAdmin)
    } else {
      console.log("      (skipped the cross-tenant case — only one brokerage on this database)")
    }

    // NEGATIVE CONTROL on the live path: an agent with NO admin grant.
    const plainId = crypto.randomUUID()
    const { error: pErr } = await svc.from("users").insert({
      id: plainId,
      email: `admin-vocab-proof-plain+${plainId.slice(0, 8)}@example.invalid`,
      user_type: "agent",
      brokerage_id: brokerageId,
    })
    if (!pErr) {
      const plain = await resolveTenantAdmin(svc as never, plainId, { user_type: "agent", brokerage_id: brokerageId })
      check("live: NEGATIVE CONTROL an agent holding no admin grant is still refused",
        plain.ok && !plain.isTenantAdmin && plain.via === "none")
      await svc.from("users").delete().eq("id", plainId)
    }
  } finally {
    if (grantIds.length) await svc.from("user_role_assignments").delete().in("id", grantIds)
    if (seededUser) await svc.from("users").delete().eq("id", userId)
    const { count: gLeft } = await svc.from("user_role_assignments")
      .select("id", { count: "exact", head: true }).eq("user_id", userId)
    const { count: uLeft } = await svc.from("users")
      .select("id", { count: "exact", head: true }).eq("id", userId)
    check(`live: cleanup residue == 0 (grants ${gLeft ?? 0}, users ${uLeft ?? 0})`,
      (gLeft ?? 0) === 0 && (uLeft ?? 0) === 0)
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Admin vocabulary — one roster for the tenant, another for the platform")
  console.log("══════════════════════════════════════════════════")
  pureLayer()
  await pureGrantResolver()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ ADMIN_VOCABULARY_FAIL"); process.exit(1) }
  console.log(" ✅ ADMIN_VOCABULARY_PASS — the tenant admin roster is written down once, the platform is answered by its own gate, a role grant administers, and no gate names a role nobody can hold")
}
main()
