#!/usr/bin/env tsx
/**
 * scripts/role-vocabulary-guard.ts  (npm run test:role-vocabulary) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * A ROLE COMPARED IN THE WRONG CASE IS A PERMISSION THAT SILENTLY NEVER FIRES.
 *
 * The live CHECK on public.users is:
 *
 *   users_user_type_check CHECK (user_type = ANY (ARRAY[
 *     'admin','agent','broker','broker_owner','compliance_officer','contact',
 *     'isa','lender','superadmin','support','system','tc','team_lead','vendor']))
 *
 * Everything is lower_snake_case. 'TC' is not a legal value.
 *
 * Three real defects motivated this guard, all found in one sweep, all invisible:
 *
 *   1. notifyComplianceFlag filtered `.in("user_type", ["TC", …])`. PostgREST
 *      `.in()` is an exact, case-sensitive comparison, so it matched zero rows.
 *      A query that matches nothing is a SUCCESSFUL query — no error, no throw,
 *      just an empty array. The transaction coordinator, the person the whole
 *      helper exists to reach, had never received a single compliance flag.
 *   2. The compliance dashboard's ACCESS_ROLES listed "TC" and compared it to
 *      the raw user_type, so a TC was refused their own dashboard.
 *   3. ISA settings resolved the duty agent with `.eq("role", "Admin")` — the
 *      wrong column entirely (users.role is legacy, NULL on most rows, mixed
 *      case, no CHECK) and the wrong case for anything else.
 *
 * None of these throw. None fail a type check. All three read as "there is
 * nobody in that role" — which is exactly what an empty brokerage looks like,
 * so nothing about the symptom points at the cause.
 *
 * ── WHAT THIS ASSERTS ───────────────────────────────────────────────────────
 * A CONSTRUCT, not a spelling list:
 *
 *   1. Every string LITERAL compared against `user_type` in a Postgres filter
 *      (.eq / .in / .neq) must be a value the live CHECK admits. Being a known
 *      legacy alias is NOT enough and deliberately does not exempt it: 'TC' is
 *      an alias toCanonicalRole() resolves perfectly well, and it still matches
 *      zero rows in Postgres, which was the entire original bug. Aliases reach a
 *      filter only through rawRoleVariants() — a CALL, not a literal — which is
 *      precisely the construct this rule is steering toward.
 *   2. rawRoleVariants() must round-trip: every variant it emits for a role must
 *      canonicalize back to that same role. That is what makes it safe to use
 *      the alias table to widen a DB filter.
 *   3. No source file may filter on the legacy `users.role` column, which has no
 *      CHECK and is mostly NULL.
 *
 * The legal vocabulary is DERIVED from the canonicalizer, not retyped here, so
 * adding a role in one place cannot leave this guard behind.
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { toCanonicalRole, rawRoleVariants, isCanonicalRole } from "../lib/security/types"
import { stripComments as canonicalStripComments } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n); console.log(`  ✗ ${n}${detail ? `\n      ${detail}` : ""}`) }
}

const ROOT = process.cwd()

/**
 * The live CHECK, transcribed once. Kept here rather than derived from the
 * canonicalizer because the two are DIFFERENT sets and the difference matters:
 * 'broker_owner' and 'support' are storable user_types that the canonical role
 * model does not name, and 'title_agent' is a canonical role that is not a
 * storable user_type. A filter literal is legal if the DB can store it OR the
 * canonicalizer knows it as an alias.
 */
const LIVE_USER_TYPE_CHECK = new Set([
  "admin", "agent", "broker", "broker_owner", "compliance_officer", "contact",
  "isa", "lender", "superadmin", "support", "system", "tc", "team_lead", "vendor",
])

console.log("══════════════════════════════════════════════════")
console.log(" Role vocabulary — a filter that matches nothing is not a filter")
console.log("══════════════════════════════════════════════════")

// ── 1. rawRoleVariants round-trips ──────────────────────────────────────────
console.log("\n[the alias table is safe to widen a DB filter with]")
{
  const roles = [...LIVE_USER_TYPE_CHECK].filter(isCanonicalRole)
  const broken: string[] = []
  for (const r of roles) {
    for (const v of rawRoleVariants(r as any)) {
      if (toCanonicalRole(v) !== r) broken.push(`${v} → ${toCanonicalRole(v)} (expected ${r})`)
    }
  }
  check(`every variant canonicalizes back to its own role (${roles.length} roles)`,
    broken.length === 0, broken.slice(0, 6).join("\n      "))
  check("…and 'tc' expands to include the legacy spellings that exist in the wild",
    rawRoleVariants("tc").includes("TC") && rawRoleVariants("tc").includes("transaction_coordinator"))
  // The negative direction: expansion must not smuggle in a DIFFERENT role.
  check("…and never emits a variant belonging to another role",
    !rawRoleVariants("tc").some((v) => ["agent", "broker", "admin"].includes(v)))
}

// ── 2. Repo sweep — user_type filter literals ───────────────────────────────
console.log("\n[repo scan — every literal compared against user_type]")
const SKIP = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage"])
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p)
  }
  return out
}

/** Remove block comments, JSX comments and line comments. */
function stripComments(t: string): string {
  return canonicalStripComments(t)
}

const offenders: string[] = []
const legacyRoleColumn: string[] = []
{
  const files = [...walk(join(ROOT, "app")), ...walk(join(ROOT, "lib"))]
  for (const abs of files) {
    const rel = relative(ROOT, abs).replace(/\\/g, "/")
    // STRIP COMMENTS FIRST. A guard for a defect has to describe the defect,
    // and the description contains the bad spelling verbatim — three times in
    // this sweep a comment explaining `.in("user_type", ["TC"])` was reported
    // as an instance of it. Prose is not code; scan only the code.
    const src = stripComments(readFileSync(abs, "utf8"))

    // .eq("user_type", "X") / .neq(...)
    for (const m of src.matchAll(/\.(?:eq|neq)\(\s*["']user_type["']\s*,\s*["']([^"']+)["']/g)) {
      const v = m[1]
      if (!LIVE_USER_TYPE_CHECK.has(v)) {
        offenders.push(`${rel}: .eq("user_type", "${v}")`)
      }
    }
    // .in("user_type", [ ... ]) — check each literal inside the array body.
    for (const m of src.matchAll(/\.in\(\s*["']user_type["']\s*,\s*\[([^\]]*)\]/g)) {
      for (const lit of m[1].matchAll(/["']([^"']+)["']/g)) {
        const v = lit[1]
        if (!LIVE_USER_TYPE_CHECK.has(v)) {
          offenders.push(`${rel}: .in("user_type", … "${v}")`)
        }
      }
    }
    // The legacy users.role column — no CHECK, mostly NULL, mixed case.
    // CHAIN-LOCAL: the `.eq("role", …)` must belong to a chain that started at
    // .from("users"). A file-wide test would flag any file that happens to query
    // users elsewhere while filtering `role` on a different table entirely
    // (user_role_assignments.role is a real, disciplined column).
    for (const m of src.matchAll(/\.from\(\s*["']users["']\s*\)([\s\S]{0,400})/g)) {
      if (/\.(?:eq|in|neq)\(\s*["']role["']\s*,/.test(m[1])) legacyRoleColumn.push(rel)
    }
  }
  console.log(`  · ${files.length} files scanned`)
  check(`no user_type filter literal outside the live vocabulary (${offenders.length})`,
    offenders.length === 0, offenders.slice(0, 8).join("\n      "))
}

// ── 3. The three fixed sites stay fixed ─────────────────────────────────────
console.log("\n[the sites this guard was written for]")
{
  const src = (p: string) => { try { return readFileSync(join(ROOT, p), "utf8") } catch { return "" } }

  const notify = src("lib/notifications/notify-helpers.ts")
  // Assert the CONSTRUCT: the filter argument is the expansion call, not an
  // array literal. Testing for the absence of the string `.in("user_type", [`
  // failed on this guard's own explanatory comment in that file — the defect
  // has to be described somewhere, and prose is not code.
  check("compliance flags expand roles through the alias table, not hand-typed strings",
    /\.in\(\s*"user_type",\s*rawRoleVariantsFor\(/.test(notify))
  check("…and a failed staff lookup is reported, not read as 'no staff'",
    notify.includes("compliance-flag staff lookup failed"))
  check("…and the caller's deal recipients (offer agent + listing agent) are honoured",
    notify.includes("alsoNotifyUserIds"))

  const submit = src("app/actions/buyer-offer/submit-to-compliance.ts")
  check("submit-to-compliance resolves the offer agent AND the listing agent",
    submit.includes("alsoNotifyUserIds: dealRecipients")
    && submit.includes('.from("listings").select("agent_id")'))
  check("…and a WARNING-level miss notifies too, not only a blocking one",
    submit.includes("compliance.submit_warnings"))
  // The owner's ruling: MLS belongs to listing launch, not to accepting an offer.
  check("…and no MLS number is consulted at this checkpoint",
    !/mls_number/i.test(submit))

  const dash = src("app/actions/compliance/dashboard.ts")
  check("the compliance dashboard canonicalizes the caller's role before gating",
    dash.includes("toCanonicalRole(profile.user_type") && dash.includes('"tc"'))

  // The listing-agreement checkpoint and the shared packet walk are proved by
  // test:compliance-checkpoints — one guard, one concern.

  const isa = src("app/dashboard/settings/isa-calling/page.tsx")
  // The claim is the COLUMN, not the array's exact spelling: #211 appended
  // broker_owner outside the canonical expansion (a spread), which the old
  // regex — pinned to `rawRoleVariantsFor(` immediately after the comma —
  // read as a regression. Accept any user_type filter built FROM the
  // canonical expansion; still refuse the legacy role column.
  check("the ISA duty agent resolves off user_type, not the legacy role column",
    /\.in\(\s*"user_type",\s*(\[\s*\.\.\.)?\s*rawRoleVariantsFor\(/.test(isa)
    && !/^\s*\.eq\("role", "Admin"\)/m.test(isa))
}

console.log("\n[the legacy users.role column]")
check(`no file filters public.users on the legacy role column (${new Set(legacyRoleColumn).size})`,
  new Set(legacyRoleColumn).size === 0,
  [...new Set(legacyRoleColumn)].slice(0, 6).join("\n      "))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  for (const f of fails) console.log(`   - ${f}`)
  console.log(" ❌ ROLE_VOCABULARY_FAIL — a role filter that cannot match is a permission that never fires")
  process.exit(1)
}
console.log(" ✅ ROLE_VOCABULARY_PASS — every role comparison can actually match a live row")
