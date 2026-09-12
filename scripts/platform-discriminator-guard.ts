#!/usr/bin/env tsx
/**
 * scripts/platform-discriminator-guard.ts
 *   (npm run test:platform-discriminator — pure, no DB, in the guard chain)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE PLATFORM/OS DISCRIMINATOR MUST HAVE ONE DEFINITION.
 *
 * OWNER RULING (2026-08-24), verbatim:
 *
 *   "I beilieve when users are created in supabase, they tie directly into
 *    public.users; we used superadmin origninally to discipher for a platform/os
 *    level user but a global/platform/os user has total control over the
 *    complete os system"
 *
 * "Total control over the complete OS" makes "is this caller the platform user?"
 * the highest-consequence predicate in the product. It was spelled per site.
 *
 * ── WHAT THIS GUARD LOOKS FOR ────────────────────────────────────────────────
 * A comparison between a RAW IDENTITY COLUMN — `user_type` / `userType` /
 * `platform_role` / `platformRole`, however it is reached — and the literal
 * "superadmin". That is the discriminator being RE-DERIVED, and it is wrong in
 * two directions that a reviewer cannot tell apart by eye:
 *
 *   userType === "superadmin"        ← DEAD on this database. Measured live
 *                                      2026-08-24: 0 of 23 users rows carry
 *                                      user_type='superadmin'. The branch can
 *                                      never fire for the account it admits.
 *   platformRole === "superadmin"    ← misses the legacy marker that RLS's
 *                                      public.is_platform_admin() still honours.
 *
 * The survivor reads BOTH and additionally refuses `ai_isa_system`:
 *
 *     lib/platform/platform-staff-roster.ts:isPlatformSuperadminIdentity
 *     lib/platform/platform-staff-roster.ts:resolvePlatformRoleIdentity
 *
 * ── WHAT IS DELIBERATELY *NOT* A FINDING ─────────────────────────────────────
 *  · `gate.role === "superadmin"` / `auth.role === …` — reading an ALREADY
 *    RESOLVED answer that a gate produced. That is a consumer, not a second
 *    derivation, and banning it would push call sites into aliasing games.
 *  · A ROSTER ARRAY containing the string (`["admin","broker","superadmin"]`) —
 *    a tenant-role roster that happens to list a legacy value carries no
 *    comparison operator and is a different question (§6 owns that vocabulary).
 *  · The survivor module itself, which is where the rule is allowed to be written.
 *
 * ── BLIND SPOTS, PUBLISHED BESIDE THE NUMBER (CLAUDE.md §2) ──────────────────
 *  1. `scripts/**` is not scanned. This file's own positive controls are string
 *     literals and the literal IS the signal, so a self-scan would count them.
 *  2. `blankComments` is used and `blankStrings` deliberately is NOT: the quoted
 *     "superadmin" is the thing being measured, so blanking strings would blind
 *     the finder completely. Prose therefore cannot hide a finding, and control 5
 *     pins that prose cannot MANUFACTURE one either.
 *  3. Only the four column spellings above anchor a match. A discriminator
 *     reached through a renamed local (`const t = row.user_type; t === "superadmin"`)
 *     is NOT seen. There are no such sites today; if one appears it is invisible
 *     here and visible to review.
 *  4. SQL is out of scope. The RLS half (public.is_platform_admin /
 *     is_platform_staff) is enforced in the database and asserted by
 *     test:cross-tenant-read; this guard is the TypeScript half.
 *  5. It does not decide whether a site is SAFE — a surviving site may be a
 *     correct both-columns test. Every survivor carries a CLASSIFICATION entry
 *     saying which, so the list is the argument rather than a rubber stamp.
 *
 * ── THE COUNT THAT MOVED (CLAUDE.md §2 — "a count that moves is the finding") ──
 * FIRST MEASUREMENT, before any conversion: 65 spellings in 45 files.
 * AFTER the merge: 32 in 28. DOWN 33, and the direction is "the finder was
 * accusing code that is now correct", not "the finder went blind" — every one of
 * the 33 is a specific site that now CALLS the survivor, and the two controls
 * "the FIXED form is NOT flagged" / "the both-columns re-spelling IS flagged"
 * are what make those two readings distinguishable.
 *
 * The 33 that moved, all merged onto lib/platform/platform-staff-roster.ts:
 *   lib/auth/require-brokerage-admin.ts (isPlatformSuperadmin — DELETED, tombstoned)
 *   lib/auth/platform-guard.ts          (requireSuperadmin + requirePlatformStaff)
 *   lib/kernel/api-auth.ts              (requireSuperadminAuth)
 *   lib/kernel/global-settings.ts       (requireBrokerAdmin)
 *   lib/kernel/billing.ts, lib/kernel/financial.ts, lib/kernel/0.1-feature-access.ts
 *   lib/platform/require-capability.ts  (resolvePlatformRole → adapter)
 *   lib/security/authorization.ts       (requireSuperAdmin/isSuperAdmin — DELETED)
 *   app/actions/settings/provider-settings-actions.ts (local copy — DELETED)
 *   app/actions/income-engine.ts, orchestrator.ts, pl-truth-engine.ts
 *   app/actions/superadmin/*.ts         (11 staff gates, role derivation)
 *   app/api/internal/voice-command/route.ts, app/api/recruiting/provision-agent/route.ts
 *   app/api/social/oauth/[platform]/route.ts
 *   app/dashboard/admin/{ai-usage,billing,command-center,compliance-ledger,
 *                        feature-governance,scrape-diagnostics}/page.tsx
 *   app/dashboard/system/page.tsx, app/dashboard/superadmin/{growth,a2p}
 *   app/dashboard/listings/[id]/lifecycle/page.tsx
 *
 * THE POPULATION CAN ONLY SHRINK. A new re-spelling fails the build.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { join, relative } from "node:path"
import { blankComments, stripComments } from "./strip-comments"

const root = process.cwd()
const baselinePath = join(root, "scripts", "platform-discriminator-baseline.json")

const SCAN_DIRS = ["app", "lib", "services", "components", "hooks", "contexts", "workflows", "tools"]

/** Where the rule is ALLOWED to be written out. Everything else must call it. */
const SURVIVOR = "lib/platform/platform-staff-roster.ts"

/**
 * WHY EACH SURVIVING SITE IS STILL HERE. Two verdicts:
 *
 *  · both-columns — the site does read BOTH identity columns, so it is CORRECT
 *                   but re-spelled. It is a §6 duplicate awaiting merge, not a
 *                   security hole. Kept visible rather than blessed.
 *  · half         — the site reads ONE column. On this database that is either
 *                   dead code (user_type) or narrower than RLS (platform_role).
 *                   Each entry says which, and why it has not been converted.
 */
type Verdict = "both-columns" | "half"
export const CLASSIFICATION: Record<string, { verdict: Verdict; why: string }> = {
  "app/actions/ai-buyer-search-push.ts": {
    verdict: "half",
    why: "`ctx.userType !== 'admin' && ctx.userType !== 'superadmin'` is a TENANT-ADMIN roster that happens to list the legacy value, not a platform gate — the surrounding test is about agentId. Converting it would widen an agent-facing gate to the platform user, which is a product decision this lane was not given.",
  },
  "app/actions/notifications.ts": {
    verdict: "both-columns",
    why: "Reads ctx.userType first and, only when that misses, re-reads the row for platform_role — the both-columns rule split across two statements for a lazy second query. Correct; a §6 merge candidate that needs the lazy read preserved.",
  },
  "app/actions/open-house.ts": {
    verdict: "half",
    why: "`ctx.userType === 'broker' || 'admin' || 'superadmin'` — a tenant broker/admin roster, not the platform discriminator. Same shape as ai-buyer-search-push.",
  },
  "app/actions/portal-stream.ts": {
    verdict: "half",
    why: "`!PROJECTION_TRIGGER_ROLES.has(userType) && platformRole !== 'superadmin'` — the platform half is the escape hatch beside a roster test, so it is narrower than RLS but fail-CLOSED (it refuses a legacy superadmin, never admits anyone extra).",
  },
  "app/actions/seed-default-sequences.ts": {
    verdict: "both-columns",
    why: "Same lazy two-statement shape as notifications.ts: user_type first, then a second read for platform_role.",
  },
  "app/actions/support.ts": {
    verdict: "both-columns",
    why: "user_type in (superadmin, support) first, then a lazy platform_role read. The `support` arm makes this the STAFF roster question, not the superadmin one — isPlatformStaffIdentity is its survivor, not isPlatformSuperadminIdentity.",
  },
  "app/actions/vendor-budget.ts": {
    verdict: "both-columns",
    why: "Correct both-columns test, and this file carries the canonical prose explanation (lines 136-147) that a dozen other headers cite by file:line. Converting the code without moving that explanation would orphan every citation.",
  },
  "app/api/admin/audit-events/route.ts": {
    verdict: "half",
    why: "`!ALLOWED_ROLES.includes(user_type) && platform_role !== 'superadmin'` — platform escape beside a tenant roster. Fail-closed for a legacy superadmin.",
  },
  "app/api/errors/escalate/route.ts": {
    verdict: "half",
    why: "Same shape as audit-events: isAdminOrBroker(user_type) OR platform_role==='superadmin'. Fail-closed.",
  },
  "app/api/errors/retry/route.ts": { verdict: "half", why: "Same shape as errors/escalate." },
  "app/dashboard/admin/brand/page.tsx": {
    verdict: "half",
    why: "`context.userType !== 'admin' && !== 'broker' && !== 'superadmin'` — tenant roster, not the platform discriminator.",
  },
  "app/dashboard/admin/lead-intake/page.tsx": { verdict: "half", why: "Tenant roster listing the legacy value beside broker/admin." },
  "app/dashboard/analytics/source/[sourceId]/page.tsx": { verdict: "half", why: "Tenant broker/admin roster." },
  "app/dashboard/analytics/source/[sourceId]/source-detail-client.tsx": { verdict: "half", why: "Tenant broker/admin roster, CLIENT component — it may not import a server module." },
  "app/dashboard/analytics/source/page.tsx": { verdict: "half", why: "Tenant broker/admin roster." },
  "app/dashboard/analytics/source/source-analytics-client.tsx": { verdict: "half", why: "Tenant broker/admin roster, CLIENT component." },
  "app/dashboard/brokerage/deal-health/page.tsx": { verdict: "half", why: "Platform escape beside a tenant roster; fail-closed for a legacy superadmin." },
  "app/dashboard/brokerage/fatigue/page.tsx": { verdict: "half", why: "Platform escape beside a tenant roster; fail-closed." },
  "app/dashboard/brokerage/intelligence/page.tsx": { verdict: "half", why: "Tenant roster listing the legacy value." },
  "app/dashboard/financials/team/page.tsx": { verdict: "half", why: "platform_role escape beside a tenant roster; fail-closed." },
  "app/dashboard/marketing/podcast/podcast-dashboard.tsx": { verdict: "half", why: "Tenant roster, CLIENT component." },
  "lib/auth/contact-access.ts": { verdict: "both-columns", why: "`user_type === 'superadmin' || isPlatformStaffRole(platform_role)` — this is isPlatformStaffIdentity written out, and it is PINNED as a negative control by scripts/act-as-write-seam-simulator.ts:259." },
  "lib/auth/resolve-user-role.ts": { verdict: "both-columns", why: "isPlatformStaffIdentity — the STAFF-roster survivor. It reads user_type for the legacy marker and delegates the roster half to the survivor module. Allowed: it is a definition, not a re-derivation, and its header carries the measured explanation." },
  "lib/buyer-execution/governance-guards.ts": { verdict: "half", why: "Platform escape beside a tenant roster; fail-closed." },
  "lib/kernel/onboarding.ts": { verdict: "half", why: "`platform_role ?? (userType === 'superadmin' ? 'superadmin' : null)` — the role DERIVATION, whose survivor is resolvePlatformRoleIdentity. Not converted here because the surrounding block also writes the value back; a §6 merge candidate." },
  "app/actions/admin/billing.ts": { verdict: "half", why: "`auth.platformRole === 'superadmin'` reads the value an api-auth gate already resolved and attached to `auth`." },
  "app/actions/lead-promotion/promote-lead.ts": { verdict: "both-columns", why: "Correct both-columns test across a multi-line boolean. §6 merge candidate. NOT TOUCHED — lead-promotion is lead-acquisition adjacent and out of this lane's scope." },
  "app/actions/marketing/image-library.ts": { verdict: "half", why: "`p.userType === 'superadmin'` on a caller profile the action already gated." },
}

// ─────────────────────────────────────────────────────────────────────────────

// TOMBSTONE (orphan doctrine §1.1) — the private `walk()` generator that stood
// here was one of 82 copies of the same readdirSync walker. The survivor is
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// It enumerated DIRECTORIES, and a root-level FILE is not a directory, so
// `proxy.ts` — the Next 16 edge middleware, which gates auth and queries four
// tables with a SERVICE client on EVERY request — was outside this guard's corpus.
// A file that is never opened reports green, which is the failure shape §2 of
// CLAUDE.md names. `scanCorpus()` below is the directory reach PLUS the root-level
// runtime files, both from the survivor.
function* scanCorpus(): Generator<string> {
  for (const dir of SCAN_DIRS) yield* walkTs(join(root, dir))
  yield* rootRuntimeFiles(root)
}

const lineOf = (s: string, i: number) => s.slice(0, i).split("\n").length

/**
 * A dotted/optional-chained path whose LEAF is one of the four raw identity column
 * spellings, optionally wrapped in an `as any` cast. Blind spot 3 lives here.
 */
const LEAF = "(?:user_type|userType|platform_role|platformRole)"
const EXPR = `(?:\\([^()]{0,80}\\)\\s*)?(?:[A-Za-z_$][\\w$]*\\s*)?(?:\\??\\.\\s*[\\w$]+\\s*)*\\??\\.?\\s*${LEAF}`
const CMP = "(?:===|!==|==|!=)"
const LIT = `["'\`]superadmin["'\`]`

const FORWARD = new RegExp(`${EXPR}\\s*${CMP}\\s*${LIT}`, "g")
const REVERSE = new RegExp(`${LIT}\\s*${CMP}\\s*${EXPR}`, "g")

export interface Finding {
  line: number
  /** The matched text, trimmed — for the failure message. */
  text: string
}

/**
 * THE ONE PLACE THE VERDICT IS MADE, so the controls below judge the same code
 * that judges the repo.
 *
 * COMMENTS ARE BLANKED, NOT DELETED: every position is computed from a match
 * index (CLAUDE.md §2 and the note atop scripts/strip-comments.ts). STRINGS ARE
 * DELIBERATELY LEFT INTACT — the quoted literal is the signal, so blankStrings
 * would blind this finder entirely. Blind spot 2.
 */
export function discriminatorSpellingsIn(raw: string): Finding[] {
  const out: Finding[] = []
  if (!raw.includes("superadmin")) return out
  const code = blankComments(raw)
  const seen = new Set<number>()
  for (const re of [FORWARD, REVERSE]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(code))) {
      if (seen.has(m.index)) continue
      seen.add(m.index)
      out.push({ line: lineOf(code, m.index), text: m[0].replace(/\s+/g, " ").trim() })
    }
  }
  return out.sort((a, b) => a.line - b.line)
}

// ── POSITIVE CONTROLS ────────────────────────────────────────────────────────
// Two-sided. A finder that has stopped recognising the defect and a clean tree
// both report zero (CLAUDE.md §2); a finder that flags everything makes the
// baseline meaningless. Each control says what a failure would MEAN.
{
  const controls: Array<{ name: string; src: string; expect: number; why: string }> = [
    {
      name: "the DEAD half — userType === \"superadmin\" — IS flagged",
      expect: 1,
      why: "the finder no longer sees the exact spelling that is dead code on this database (0 of 23 rows carry user_type='superadmin')",
      src: 'if (ctx.userType === "superadmin") return true',
    },
    {
      name: "the NARROW half — data.platform_role !== 'superadmin' — IS flagged",
      expect: 1,
      why: "the finder no longer sees the spelling that is tighter than public.is_platform_admin() in RLS",
      src: "if (!data || data.platform_role !== 'superadmin') throw new Error('Forbidden')",
    },
    {
      name: "the both-columns re-spelling IS flagged, ONCE PER COMPARISON (2)",
      expect: 2,
      why: "an inline copy of the survivor is the §6 duplicate this guard exists to freeze; counting it once would understate the population",
      src: 'const isSuper = (d as any)?.user_type === "superadmin" || (d as any)?.platform_role === "superadmin"',
    },
    {
      name: "the REVERSED operand order IS flagged",
      expect: 1,
      why: "a re-spelling can be hidden simply by writing the literal first — a finder that only reads one direction is trivially evaded",
      src: 'if ("superadmin" === profile.user_type) allow()',
    },
    {
      name: "the shape written ONLY IN A COMMENT is NOT flagged",
      expect: 0,
      why: "prose is manufacturing findings — and this repo has already had five guards go red on a TOMBSTONE that was doing exactly what §1 requires",
      src: [
        "// TOMBSTONE: this used to read",
        '//   userType === "superadmin" || platformRole === "superadmin"',
        "// and now delegates to the survivor.",
        "const ok = isPlatformSuperadminIdentity(userType, platformRole)",
      ].join("\n"),
    },
    {
      name: "the FIXED form — isPlatformSuperadminIdentity(...) — is NOT flagged",
      expect: 0,
      why: "the repair does not read as repaired, so a converted site would stay in the population and nobody could tell fixed from unfixed",
      src: "const isSuper = isPlatformSuperadminIdentity(u.user_type, u.platform_role)",
    },
    {
      name: "a resolved-role read — gate.role === \"superadmin\" — is NOT flagged",
      expect: 0,
      why: "the finder is accusing consumers of an already-resolved answer; every gate result read would land in the baseline and the baseline would stop meaning anything",
      src: 'const canMint = gate.role === "superadmin"',
    },
    {
      name: "a ROSTER ARRAY listing the legacy value is NOT flagged",
      expect: 0,
      why: "a tenant-role roster that happens to contain the string is a different question (§6 vocabulary), and flagging it would drown the real signal",
      src: `if (!["admin", "broker", "broker_owner", "superadmin"].includes(user.user_type ?? "")) refuse()`,
    },
  ]

  let bad = false
  console.log("── PLATFORM-DISCRIMINATOR · controls ──")
  for (const c of controls) {
    const got = discriminatorSpellingsIn(c.src).length
    if (got === c.expect) console.log(`  ✓ control · ${c.name}`)
    else {
      bad = true
      console.log(`  ✗ CONTROL FAILED · ${c.name} — expected ${c.expect}, got ${got}`)
      console.log(`      ${c.why}`)
    }
  }
  if (bad) {
    console.log(" ❌ PLATFORM_DISCRIMINATOR_CONTROL_FAIL — the finder cannot prove it still works, so its count means nothing")
    process.exit(1)
  }
}

// ── SURVIVOR INTEGRITY ───────────────────────────────────────────────────────
// The population number is only meaningful if the thing everything was merged ONTO
// still does the job. These are RULE assertions, not literal pins (CLAUDE.md §2).
{
  // STRIPPED. The survivor's own header quotes the both-columns expression in
  // prose — as §1 requires a tombstone to — so a RAW read is satisfied by the
  // comment and would stay green while the function decayed to one column.
  // Proved by mutation on 2026-08-24: four simulators asserting the same rule
  // from raw source all stayed green when the survivor was reduced to
  // `platformRole === "superadmin"`. This block only caught it because the
  // BEHAVIOUR section below EXECUTES the function. Both halves are kept: the
  // regex proves the shape, the call proves the answer.
  const src = existsSync(join(root, SURVIVOR)) ? stripComments(readFileSync(join(root, SURVIVOR), "utf8")) : ""
  const checks: Array<{ name: string; ok: boolean; why: string }> = [
    {
      name: "the survivor exists and exports the one discriminator",
      ok: /export function isPlatformSuperadminIdentity\s*\(/.test(src),
      why: "everything above was merged onto a function that is no longer there",
    },
    {
      name: "…and the one role derivation",
      ok: /export function resolvePlatformRoleIdentity\s*\(/.test(src),
      why: "the eleven converted staff gates call a function that is no longer there",
    },
    {
      name: "it reads BOTH identity columns (neither alone answers the question)",
      ok: /userType === "superadmin" \|\| platformRole === "superadmin"/.test(src),
      why: "the survivor has decayed into one of the two halves it exists to replace",
    },
    {
      name: "ai_isa_system is refused BY NAME, not by string inequality",
      ok: /PLATFORM_NONHUMAN_ROLES\s*=\s*\[\s*"ai_isa_system"/.test(src) &&
          /isNonHumanPlatformRole\(platformRole\)\) return false/.test(src),
      why: "a platform_role that is NOT a human superadmin could inherit total control — the owner named this risk explicitly",
    },
    {
      name: "…and the role derivation refuses it too (fails closed to null)",
      ok: /if \(isNonHumanPlatformRole\(platformRole\)\) return null/.test(src),
      why: "a service account would be handed to a staff capability check as a role string",
    },
  ]
  let bad = false
  console.log("\n── PLATFORM-DISCRIMINATOR · survivor integrity ──")
  for (const c of checks) {
    if (c.ok) console.log(`  ✓ ${c.name}`)
    else { bad = true; console.log(`  ✗ ${c.name}\n      ${c.why}`) }
  }
  if (bad) {
    console.log(" ❌ PLATFORM_DISCRIMINATOR_SURVIVOR_FAIL — the one definition no longer holds the rule")
    process.exit(1)
  }
}

// ── BEHAVIOURAL CONTROLS ON THE SURVIVOR ─────────────────────────────────────
// Source regexes prove the SHAPE; these prove the ANSWER. Both are needed: a
// regex cannot tell a returned `false` from a returned `true`.
{
  const mod = await import("../lib/platform/platform-staff-roster")
  const cases: Array<{ name: string; ok: boolean; why: string }> = [
    {
      name: "the ONE live superadmin (user_type='admin', platform_role='superadmin') is admitted",
      ok: mod.isPlatformSuperadminIdentity("admin", "superadmin") === true,
      why: "MEASURED live 2026-08-24: this is the platform's only superadmin row. Refusing it locks the owner out of his own OS",
    },
    {
      name: "the legacy marker (user_type='superadmin') is still admitted",
      ok: mod.isPlatformSuperadminIdentity("superadmin", null) === true,
      why: "public.is_platform_admin() honours it in RLS; the app gate would then be tighter than the database",
    },
    {
      name: "a tenant admin (user_type='admin', platform_role=null) is REFUSED",
      ok: mod.isPlatformSuperadminIdentity("admin", null) === false,
      why: "'admin' is also a TENANT user_type — 2 live rows hold it. Admitting them hands every tenant admin total control of the OS",
    },
    {
      name: "the ai_isa_system SERVICE ACCOUNT is REFUSED total control",
      ok: mod.isPlatformSuperadminIdentity("system", "ai_isa_system") === false,
      why: "the owner's ruling grants a platform user total control; ai_isa_system is a platform_role and is NOT a human superadmin",
    },
    {
      name: "…and is refused EVEN IF its row also carried the legacy user_type marker",
      ok: mod.isPlatformSuperadminIdentity("superadmin", "ai_isa_system") === false,
      why: "this is the exact hole the old requirePlatformStaff had: rosterRole was null, the legacy arm carried it, and it returned role='superadmin'",
    },
    {
      name: "a staff role that is NOT superadmin does not get total control",
      ok: mod.isPlatformSuperadminIdentity("system", "marketing") === false &&
          mod.isPlatformSuperadminIdentity("support", "support") === false,
      why: "the four-role roster is the STAFF question; only superadmin is the OS user",
    },
    {
      name: "the role derivation returns the roster role, the legacy superadmin, and NULL for everything else",
      ok: mod.resolvePlatformRoleIdentity("system", "marketing") === "marketing" &&
          mod.resolvePlatformRoleIdentity("superadmin", null) === "superadmin" &&
          mod.resolvePlatformRoleIdentity("admin", null) === null &&
          mod.resolvePlatformRoleIdentity("system", "ai_isa_system") === null,
      why: "eleven converted staff gates feed this straight into platformStaffCan; a wrong answer here is a wrong answer at all eleven",
    },
  ]
  let bad = false
  console.log("\n── PLATFORM-DISCRIMINATOR · behaviour ──")
  for (const c of cases) {
    if (c.ok) console.log(`  ✓ ${c.name}`)
    else { bad = true; console.log(`  ✗ ${c.name}\n      ${c.why}`) }
  }
  if (bad) {
    console.log(" ❌ PLATFORM_DISCRIMINATOR_BEHAVIOUR_FAIL — the one definition answers wrongly")
    process.exit(1)
  }
}

// ── THE SCAN ─────────────────────────────────────────────────────────────────
const found = new Map<string, number>()
const locations = new Map<string, string[]>()
let scanned = 0
for (const abs of scanCorpus()) {
  scanned++
  const rel = relative(root, abs).replace(/\\/g, "/")
  if (rel === SURVIVOR) continue // the one place the rule may be written out
  for (const f of discriminatorSpellingsIn(readFileSync(abs, "utf8"))) {
    found.set(rel, (found.get(rel) ?? 0) + 1)
    const list = locations.get(rel) ?? []
    list.push(`${rel}:${f.line}  ${f.text}`)
    locations.set(rel, list)
  }
}

const baseline: Record<string, number> = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, "utf8"))
  : {}

if (process.env.PLATFORM_DISCRIMINATOR_BASELINE === "1") {
  const next: Record<string, number> = {}
  for (const k of [...found.keys()].sort()) next[k] = found.get(k)!
  writeFileSync(baselinePath, JSON.stringify(next, null, 2) + "\n")
  console.log(`\n  ↻ baseline rewritten — ${Object.keys(next).length} file(s), ${[...found.values()].reduce((a, b) => a + b, 0)} spelling(s)`)
  process.exit(0)
}

const total = [...found.values()].reduce((a, b) => a + b, 0)
const baseTotal = Object.values(baseline).reduce((a, b) => a + b, 0)

const failures: string[] = []
let added = 0
for (const [key, count] of found) {
  const allowed = baseline[key] ?? 0
  if (count > allowed) {
    added += count - allowed
    failures.push(`${key} — ${count} spelling(s), baseline ${allowed}\n         ${(locations.get(key) ?? []).join("\n         ")}`)
  }
}
let shrunk = 0
const gone: string[] = []
for (const [key, allowed] of Object.entries(baseline)) {
  const now = found.get(key) ?? 0
  if (now < allowed) { shrunk += allowed - now; gone.push(`${key} (${allowed} → ${now})`) }
}

const unexplained = [...found.keys()].filter((k) => !CLASSIFICATION[k])

console.log(`\n── PLATFORM-DISCRIMINATOR GUARD ──`)
console.log(`  ${scanned} files scanned across ${SCAN_DIRS.join(", ")} (scripts/ excluded — blind spot 1; ${SURVIVOR} exempt — it is the definition)`)
console.log(`  ${total} raw-column spelling(s) in ${found.size} file(s) · baseline ${baseTotal}`)
{
  const counts = { "both-columns": 0, half: 0 } as Record<Verdict, number>
  for (const [k, n] of found) { const c = CLASSIFICATION[k]; if (c) counts[c.verdict] += n }
  console.log(`  classified: ${counts["both-columns"]} correct-but-re-spelled · ${counts.half} single-column (dead, or narrower than RLS)`)
}
if (shrunk > 0) {
  console.log(`  ↓ ${shrunk} spelling(s) merged onto the survivor — run PLATFORM_DISCRIMINATOR_BASELINE=1 to tighten:`)
  for (const g of gone) console.log(`     - ${g}`)
}
if (unexplained.length > 0) {
  console.log(`  ✗ ${unexplained.length} file(s) carry NO entry in CLASSIFICATION — an unexamined re-spelling:`)
  for (const u of unexplained) console.log(`     - ${u}`)
}
if (added > 0) {
  console.log(`  ✗ ${added} NEW re-spelling(s) of the platform discriminator:`)
  for (const f of failures) console.log(`     - ${f}`)
  console.log("     Use lib/platform/platform-staff-roster.ts:")
  console.log("       isPlatformSuperadminIdentity(userType, platformRole)  — 'has total control'")
  console.log("       resolvePlatformRoleIdentity(userType, platformRole)   — 'which staff role'")
}
if (added > 0 || unexplained.length > 0) {
  console.log(" ❌ PLATFORM_DISCRIMINATOR_FAIL — the platform/OS user must have ONE definition")
  process.exit(1)
}
console.log(" ✅ PLATFORM_DISCRIMINATOR_PASS — one definition; the re-spelling surface can only shrink")
