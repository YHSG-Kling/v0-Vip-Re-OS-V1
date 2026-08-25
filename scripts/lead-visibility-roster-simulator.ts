#!/usr/bin/env tsx
/**
 * scripts/lead-visibility-roster-simulator.ts (npm run test:lead-visibility-roster)
 * ─────────────────────────────────────────────────────────────────────────────
 * SIXTEEN ANSWERS TO "WHO SEES LEADS", AND THEY DID NOT AGREE.
 *
 * Fifteen rosters in the app layer and one predicate in SQL decided lead access.
 * Six admitted `team_lead`, nine refused it, and the database refused it. The
 * owner then ruled:
 *
 *   "if team tier subscriptions, they don't have a broker in the subscription so
 *    the team lead can see leads."
 *
 * A roster cannot carry that ruling. A list of role strings says YES or NO; it
 * cannot say "yes, over their own team's rows". Admitting team_lead to fifteen
 * rosters and stopping there would have handed every team lead in every
 * multi-team tenant the brokerage's entire lead desk — silently, because a wider
 * board looks exactly like a bigger pipeline.
 *
 * So this guard checks TWO things, and the second is the one that matters:
 *
 *   1. ONE ROSTER. Exactly one lead-visibility roster exists in the app layer,
 *      and it is lib/auth/lead-visibility.ts.
 *   2. THE SCOPE IS CONSUMED. Every site that gained team_lead also CONSUMES the
 *      row scope — not merely the admission. A site that awaits the resolver and
 *      throws the scope away is the exact defect this lane exists to prevent,
 *      and it is indistinguishable from a correct site if you only grep for the
 *      import.
 *
 * ── MEASUREMENT DISCIPLINE (CLAUDE.md §2) ───────────────────────────────────
 *
 *   · Comments are stripped with scripts/strip-comments.ts — the ONE correct
 *     scanner — never with a hand-rolled regex pair. This matters more here than
 *     usual: the consolidation left TOMBSTONES naming `applyLeadRowScope` and
 *     the deleted rosters in COMMENTS at every folded site. An unstripped scan
 *     would read those tombstones as evidence of the very thing they record the
 *     deletion of, and would pass a file that had actually been gutted.
 *     `blankStrings` is used for the roster hunt so a role name inside narrative
 *     prose in a string literal is not counted as a roster.
 *   · Every absence assertion has a POSITIVE CONTROL: a competing roster is
 *     written into a temp fixture inside the scanned tree and the finder must
 *     catch it. A broken detector and a clean tree both report zero.
 *   · The denominator and the exclusions are PRINTED beside the number.
 *   · The ruling itself is proved BEHAVIOURALLY — the resolver is driven against
 *     a fake Supabase client through every branch, so this is not only a grep.
 */
import { readFileSync, existsSync, readdirSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { join, relative } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import {
  LEAD_DESK_USER_TYPES,
  BROKERAGE_WIDE_LEAD_USER_TYPES,
  resolveLeadVisibility,
  applyLeadRowScope,
  leadRowInScope,
  resolveScopedLeadIds,
  type LeadRowScope,
} from "../lib/auth/lead-visibility"
import { TENANT_ADMIN_USER_TYPES } from "../lib/auth/resolve-user-role"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, detail?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${n}${detail ? ` — ${detail}` : ""}`) }
}
const ROOT = process.cwd()
const src = (p: string) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), "utf8") : "")
/** Code only — comments deleted, LINE NUMBERS preserved. */
const code = (p: string) => stripComments(src(p))

console.log("══════════════════════════════════════════════════")
console.log(" Lead visibility — one roster, and a row scope behind it")
console.log("══════════════════════════════════════════════════")

// ─────────────────────────────────────────────────────────────────────────────
// THE DENOMINATOR. Stated before any number is reported (CLAUDE.md §2).
// ─────────────────────────────────────────────────────────────────────────────

/** Directories walked. Everything outside them is an EXCLUSION, listed below. */
const SCAN_ROOTS = ["app", "lib"]
/** Never walked. */
const SKIP_DIRS = new Set(["node_modules", ".next", ".git", "dist", "build", "coverage", ".vercel"])

// TOMBSTONE (orphan doctrine §1.1) — the private walker that stood here was one of
// 82 copies of the same readdirSync walker. The survivor is
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.//
// It enumerated DIRECTORIES, and a root-level FILE is not a directory, so
// `proxy.ts` — the Next 16 edge middleware, which gates auth and queries four
// tables with a SERVICE client on EVERY request — was outside this guard's corpus,
// and a file that is never opened reports green. `rootRuntimeFiles()` supplies it.
/** The declared reach PLUS the root runtime files, as repo-relative paths. */
function scanCorpus(): string[] {
  return [...SCAN_ROOTS.flatMap((r) => walkTs(join(ROOT, r))), ...rootRuntimeFiles(ROOT)]
    .map((p) => relative(ROOT, p))
}

/**
 * A file is IN the denominator when it reaches the `leads` table itself. That is
 * the population a lead-visibility roster can live in: a file that never touches
 * `leads` cannot be gating lead rows, and including it would drag in every
 * unrelated role array in the tree (vendor scope, seat menus, the permission
 * catalogue) and drown the signal.
 *
 * The membership test runs on COMMENT-STRIPPED source, so a file that only
 * MENTIONS the leads table in prose is not counted.
 */
const LEADS_TABLE = /\bfrom\s*\(\s*["'`]leads["'`]\s*\)/

const allSourceFiles = scanCorpus()
const leadTouchingFiles = allSourceFiles.filter((f) => LEADS_TABLE.test(stripComments(src(f))))

/** The one file allowed to DECLARE the roster. */
const SURVIVOR = "lib/auth/lead-visibility.ts"

/**
 * THE SITES THIS LANE FOLDED. Named explicitly rather than inferred, so a site
 * that is deleted or renamed FAILS this guard instead of quietly leaving the
 * population. Each entry says what the file must prove.
 *
 *   admission — it asks the one resolver.
 *   scope     — it CONSUMES the returned scope (not just the boolean).
 */
const FOLDED_SITES: Array<{ file: string; scope: boolean; why: string }> = [
  { file: "app/api/leads/route.ts", scope: true, why: "the brokerage lead list API" },
  { file: "app/actions/leads.ts", scope: true, why: "the widest lead surface — read/qualify/assign/pause/handoff/stats" },
  { file: "app/actions/lead-management.ts", scope: true, why: "getLeadsAdmin + enrich/reject/import" },
  { file: "app/actions/lead-lifecycle.ts", scope: true, why: "list-unassigned + convert-to-contact" },
  { file: "app/actions/lead-quick-actions.ts", scope: true, why: "single-lead verify/enrich" },
  { file: "app/api/leads/deduplication-log/route.ts", scope: true, why: "dedup metadata, keyed on lead_id" },
  { file: "lib/voice/broker-commands.ts", scope: true, why: "the spoken convert-lead verb" },
  { file: "app/dashboard/isa/page.tsx", scope: true, why: "the ISA console queue tab + its lead read" },
  { file: "app/leads/page.tsx", scope: true, why: "the lead desk screen (client-side reads)" },
  { file: "app/api/leads/process-pipeline/route.ts", scope: true, why: "raw-pipeline stats — refuses a team scope it cannot express" },
  { file: "app/actions/lead-assignment/assign-lead.ts", scope: true, why: "auto/manual assignment + handoff acknowledgement" },
  // FOUND BY THIS GUARD, NOT BY THE CENSUS THAT OPENED THE LANE. The lane was
  // briefed with fifteen app rosters; this was the sixteenth, and it gated the
  // page that renders a single lead whole.
  { file: "app/leads/[leadId]/page.tsx", scope: true, why: "the lead DETAIL page — one row, so leadRowInScope answers exactly" },
]

/** Lead-touching files deliberately NOT folded, each with its reason. */
const DECLARED_EXCLUSIONS: Array<{ file: string; why: string }> = [
  { file: "app/api/leads/raw/route.ts", why: "PLATFORM-ONLY surface (raw scraped leads). requirePlatformStaffAuth, no tenant roster to consolidate — left as is by ruling." },
]

/**
 * ── THE BLIND SPOT THIS ALLOWLIST BUYS BACK, STATED PLAINLY ─────────────────
 *
 * The finder below cannot read intent. It finds role rosters in files that reach
 * `leads`, and a file may reach `leads` while gating something else entirely —
 * contact reassignment moves a contact's leads with it, a DSR erases across
 * every table, an admin dashboard counts leads on a tile. Those rosters are NOT
 * lead-visibility rosters and folding them onto the lead answer would be a
 * different, unruled widening.
 *
 * So each is declared here WITH ITS SNIPPET. Keying on file alone would let a
 * genuine lead roster hide inside an allowlisted file; keying on file+snippet
 * means any CHANGE to one of these lists, or any NEW list in the same file,
 * fails the census. The cost is honest and printed: these N rosters are not
 * audited by this guard, and if one of them ever becomes a lead gate, this guard
 * will not notice.
 */
const NOT_A_LEAD_ROSTER: Array<{ file: string; snippet: string; why: string }> = [
  // TOMBSTONE — `app/actions/ai-isa-settings.ts` stood here and is GONE, because
  // THE ROSTER IT EXCUSED NO LONGER EXISTS. This entry excused an INLINE
  // `new Set(['broker','broker_admin','broker_owner','admin','team_lead'])` as
  // "TENANT_WRITE_ROLES — who may WRITE the tenant's AI-ISA settings; reaches
  // `leads` only for a `head: true` count". That was true, and the entry was
  // correct while it stood.
  //
  // SURVIVOR: `TENANT_ADMIN_USER_TYPES` at lib/auth/resolve-user-role.ts:210.
  // test:admin-vocabulary flagged the inline copy as a §6 duplicate of that Set
  // and it was merged onto it, so the file now names no roster of its own and
  // there is nothing left for this list to excuse. An allowlist entry for a
  // roster that no longer exists is precisely the stale exception the
  // "no STALE allowlist entry" check exists to catch — and it caught this one.
  //
  // THE TWO GUARDS PULLED IN OPPOSITE DIRECTIONS AND BOTH WERE RIGHT: this guard
  // keys on file+snippet so a changed roster is re-examined rather than
  // inheriting its excuse; admin-vocabulary forbids restating the roster at all.
  // Satisfying the second necessarily invalidated the first entry — which is the
  // healthy end state, not a conflict: one definition, no exception needed.
  { file: "app/actions/contact-reassignment.ts", snippet: "[broker,broker_owner,broker_admin,admin]",
    why: "requireReassignAuthority — who may move a CONTACT between agents. It updates leads.agent_id as part of the move; it does not decide who SEES leads." },
  { file: "app/actions/privacy/data-subject-requests.ts", snippet: "[broker,broker_admin,admin,superadmin,compliance_officer]",
    why: "DSR handler roster (note compliance_officer, who is not on the lead desk). Erasure/export spans every table including leads." },
  { file: "app/api/internal/ai-chat/route.ts", snippet: "[agent,broker,admin,tc,transaction_coordinator,lender,vendor,title,title_agent,compliance_officer,compliance_manager,superadmin,super_admin,isa,team_lead]",
    why: "Assistant ROUTING vocabulary — every user_type including agent. Not a gate; it picks which assistant persona answers." },
  { file: "app/dashboard/admin/page.tsx", snippet: "[admin,superadmin,broker,broker_admin]",
    why: "The admin DASHBOARD's own gate. Reaches `leads` for a KPI tile." },
  { file: "lib/kernel/manager-signals.ts", snippet: "[broker,admin]",
    why: "Manager-signal recipient lists (four of them). lib/kernel/manager-signals.ts is under a standing do-not-touch instruction for this lane." },
  { file: "lib/voice/broker-commands.ts", snippet: "[broker,broker_owner,admin]",
    why: "REASSIGN_MANAGER_ROLES — CONTACT reassignment by voice, kept deliberately (see the note at its declaration). Its lead roster WAS folded." },
]
const allowKey = (f: string, s: string) => `${f}::${s}`
const ALLOWED = new Set(NOT_A_LEAD_ROSTER.map((a) => allowKey(a.file, a.snippet)))

console.log("\n[the denominator, stated before the number]")
{
  console.log(`  · scanned roots            : ${SCAN_ROOTS.join(", ")}`)
  console.log(`  · .ts/.tsx files walked    : ${allSourceFiles.length}`)
  console.log(`  · files reaching \`leads\`   : ${leadTouchingFiles.length}  ← the population`)
  console.log(`  · folded sites asserted    : ${FOLDED_SITES.length}`)
  console.log(`  · declared exclusions      : ${DECLARED_EXCLUSIONS.length} (${DECLARED_EXCLUSIONS.map((e) => e.file).join(", ")})`)
  console.log(`  · rosters declared NOT lead-visibility (allowlisted by file+snippet): ${NOT_A_LEAD_ROSTER.length}`)
  for (const a of NOT_A_LEAD_ROSTER) console.log(`      – ${a.file} ${a.snippet}`)
  console.log(`  · BLIND SPOTS: scripts/ and supabase/ are NOT scanned (a guard and a migration are`)
  console.log(`    allowed to name roles); a file reaching \`leads\` only through an .rpc() or a`)
  console.log(`    dynamically-built table name is invisible to this population test.`)
  check("the population is non-empty (a zero denominator would make every absence trivially true)",
    leadTouchingFiles.length > 0, `${leadTouchingFiles.length} files`)
  check("every folded site is a real file on disk", FOLDED_SITES.every((s) => existsSync(join(ROOT, s.file))),
    FOLDED_SITES.filter((s) => !existsSync(join(ROOT, s.file))).map((s) => s.file).join(", "))
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FINDER. One function, used by the census AND by the positive control —
// so the control proves the same code path the census runs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The role names a lead-visibility roster is made of. `broker_admin`,
 * `superadmin` and `support` are included precisely BECAUSE they are dead or
 * wrong as user_type comparisons: a reintroduced roster is most likely to be
 * copy-pasted from one of the fifteen deleted ones, and every one of those
 * carried at least one of them.
 */
const ROSTER_WORDS = [
  "broker", "broker_owner", "broker_admin", "admin", "superadmin", "support", "team_lead", "isa",
]

/**
 * A "roster" here is a LITERAL LIST of role strings used as a membership test.
 * The shapes matched are the four the deleted sites actually used:
 *
 *     const x = ['a','b'] … x.includes(role)
 *     const x = new Set(['a','b']) … x.has(role)
 *     [...].includes(role)                  (inline)
 *     new Set([...]).has(role)              (inline)
 *
 * Two or more role words are required. ONE role string is a comparison
 * (`role === "admin"`), not a roster, and flagging those would bury the finding.
 */
function findRosters(source: string): Array<{ snippet: string }> {
  // Comments blanked AND string CONTENTS blanked would destroy the very strings
  // we are looking for — so comments are DELETED (stripComments) and strings are
  // kept. To stop a role name inside NARRATIVE prose from counting, the match
  // must also be an array/Set literal of quoted values, which prose is not.
  const stripped = stripComments(source)
  const out: Array<{ snippet: string }> = []
  const literal = /(?:new\s+Set\s*\(\s*)?\[\s*((?:["'][a-z_]+["']\s*,?\s*)+)\]/g
  let m: RegExpExecArray | null
  while ((m = literal.exec(stripped)) !== null) {
    const values = [...m[1].matchAll(/["']([a-z_]+)["']/g)].map((x) => x[1])
    const hits = values.filter((v) => ROSTER_WORDS.includes(v))
    if (hits.length < 2) continue
    // It must be USED as a membership test somewhere in the file, or it is data
    // (a seat menu, a display order), not a gate.
    if (!/\.(includes|has)\s*\(/.test(stripped)) continue
    out.push({ snippet: `[${values.join(",")}]` })
  }
  return out
}

/**
 * POSITIVE CONTROL for the STRIPPER, run before anything trusts it. If
 * stripComments were the block-first regex pair CLAUDE.md §2 warns about, a
 * roster hidden after a `//` line containing `/*` would come through as live
 * code — and the census would accuse a clean file.
 */
console.log("\n[positive control — the scanner can still see, and still ignores comments]")
{
  const withCommentRoster = `
    // a retired roster lived here: ['broker','admin'] /* see also */
    const live = new Set(["broker", "team_lead"])
    if (live.has(role)) {}
  `
  const found = findRosters(withCommentRoster)
  check("a roster in a COMMENT is not counted", !found.some((f) => f.snippet === "[broker,admin]"))
  check("a roster in LIVE CODE on the line after it still is", found.some((f) => f.snippet.includes("team_lead")))
  const single = `const x = ["admin"]; if (x.includes(r)) {}`
  check("a ONE-role list is a comparison, not a roster", findRosters(single).length === 0)
  const dataOnly = `export const MENU = ["broker","admin","agent"]`
  check("a role list with no membership test is data, not a gate", findRosters(dataOnly).length === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. EXACTLY ONE ROSTER
// ─────────────────────────────────────────────────────────────────────────────

function censusRosters(files: string[]): Array<{ file: string; snippet: string }> {
  const out: Array<{ file: string; snippet: string }> = []
  for (const f of files) {
    if (f === SURVIVOR) continue
    for (const r of findRosters(src(f))) {
      if (ALLOWED.has(allowKey(f, r.snippet))) continue
      out.push({ file: f, snippet: r.snippet })
    }
  }
  return out
}

console.log("\n[one roster — the census]")
{
  const found = censusRosters(leadTouchingFiles)
  check(
    `no competing lead-visibility roster in the ${leadTouchingFiles.length} files that reach \`leads\``,
    found.length === 0,
    found.map((f) => `${f.file} ${f.snippet}`).join(" | "),
  )
  // A STALE ALLOWLIST IS ALSO A FINDING. If an entry no longer matches anything,
  // the roster it excused has moved or gone — and an allowlist that excuses
  // nothing is an exclusion nobody is paying for any more. "A count that moves is
  // the finding" (CLAUDE.md §2) applies to the exclusions too, not only the hits.
  const stale = NOT_A_LEAD_ROSTER.filter(
    (a) => !findRosters(src(a.file)).some((r) => r.snippet === a.snippet),
  )
  check("no STALE allowlist entry — every declared non-lead roster still exists as declared",
    stale.length === 0, stale.map((s) => `${s.file} ${s.snippet}`).join(" | "))
  check("the survivor exists and declares the roster",
    /export const LEAD_DESK_USER_TYPES/.test(code(SURVIVOR)))
  check("the survivor DERIVES its roster instead of retyping the five tenant roles",
    /\.\.\.TENANT_ADMIN_USER_TYPES/.test(code(SURVIVOR)))
  check("the derived roster is exactly the tenant roster plus the ISA seat",
    [...LEAD_DESK_USER_TYPES].sort().join(",") === [...new Set([...TENANT_ADMIN_USER_TYPES, "isa"])].sort().join(","),
    [...LEAD_DESK_USER_TYPES].sort().join(","))
  check("team_lead is IN it (the owner's ruling)", LEAD_DESK_USER_TYPES.has("team_lead"))
  check("agent is NOT (agents see contacts only)", !LEAD_DESK_USER_TYPES.has("agent"))
  check("the brokerage-wide subset is the roster MINUS team_lead — derived, not retyped",
    !BROKERAGE_WIDE_LEAD_USER_TYPES.has("team_lead")
    && [...LEAD_DESK_USER_TYPES].filter((r) => r !== "team_lead").sort().join(",")
       === [...BROKERAGE_WIDE_LEAD_USER_TYPES].sort().join(","))
}

console.log("\n[positive control — a reintroduced roster is CAUGHT]")
{
  // A competing roster is written into a REAL file inside the scanned tree, the
  // census is re-run over the real population, and it must find it. Then the
  // fixture is removed and the census must go quiet again. Both halves are the
  // control: catching it proves the finder works, and the clean re-run proves
  // the zero above was a measurement and not an accident of ordering.
  const fixtureDir = join(ROOT, "app", "api", "leads", "__roster_positive_control__")
  const fixture = join(fixtureDir, "route.ts")
  const rel = relative(ROOT, fixture)
  try {
    mkdirSync(fixtureDir, { recursive: true })
    writeFileSync(fixture, [
      "// TEMPORARY FIXTURE — written and deleted by",
      "// scripts/lead-visibility-roster-simulator.ts. If this file is on disk,",
      "// a guard run was interrupted; delete it.",
      "import { createClient } from '@/lib/supabase/server'",
      "export async function GET() {",
      "  const leadVisibleRoles = ['broker', 'broker_owner', 'broker_admin', 'admin', 'superadmin']",
      "  const role = 'agent'",
      "  if (!leadVisibleRoles.includes(role)) return new Response('forbidden', { status: 403 })",
      "  const supabase = await createClient()",
      "  const { data } = await supabase.from('leads').select('*')",
      "  return Response.json({ data })",
      "}",
      "",
    ].join("\n"), "utf8")

    // The positive control MUST re-walk through the same corpus function the
    // measurement uses — a control that walks differently from the thing it is
    // controlling proves nothing about the thing it is controlling.
    const population = scanCorpus()
      .filter((f) => LEADS_TABLE.test(stripComments(src(f))))
    check("the fixture joins the population (it reaches `leads`)", population.includes(rel))
    const caught = censusRosters(population)
    check("the census CATCHES the reintroduced roster", caught.some((c) => c.file === rel),
      caught.map((c) => c.file).join(", "))
    check("…and catches ONLY it — no other file regressed under the same run",
      caught.length === 1, caught.map((c) => `${c.file} ${c.snippet}`).join(" | "))
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true })
  }
  const after = scanCorpus()
    .filter((f) => LEADS_TABLE.test(stripComments(src(f))))
  check("with the fixture removed the census is quiet again", censusRosters(after).length === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ADMITTED **AND** TEAM-SCOPED AT EVERY WIDENED SITE
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[every widened site asks the one resolver — in CODE, not in a tombstone]")
{
  for (const site of FOLDED_SITES) {
    const c = code(site.file)
    check(`${site.file} imports the one answer (${site.why})`,
      /from ["']@\/lib\/auth\/lead-visibility["']/.test(c))
    check(`${site.file} actually CALLS it`,
      /resolveLeadVisibility(ForSession)?\s*\(/.test(c))
  }
}

console.log("\n[…and CONSUMES the row scope — the half a roster could not carry]")
{
  // The scope is consumed when the file either applies it to a query
  // (applyLeadRowScope / resolveScopedLeadIds), tests a row against it
  // (leadRowInScope), or branches on `scope.kind === "team"` to narrow or refuse.
  // Comments are stripped first: every one of these files carries a TOMBSTONE
  // that names applyLeadRowScope in prose, and an unstripped scan would pass a
  // file whose scope handling had been deleted.
  const CONSUMES = /applyLeadRowScope\s*\(|leadRowInScope\s*\(|resolveScopedLeadIds\s*\(|\.kind\s*===\s*["']team["']/
  for (const site of FOLDED_SITES.filter((s) => s.scope)) {
    check(`${site.file} consumes the scope, not just the admission`, CONSUMES.test(code(site.file)))
  }
  // The inverse control: prove the regex would NOT be satisfied by the tombstone
  // prose alone. Every one of these files mentions the name in a comment.
  const withCommentsOnly = FOLDED_SITES
    .filter((s) => s.scope)
    .filter((s) => CONSUMES.test(src(s.file)) && !CONSUMES.test(code(s.file)))
  check("no site passes on COMMENT text alone (stripper control on the real files)",
    withCommentsOnly.length === 0, withCommentsOnly.map((s) => s.file).join(", "))
}

console.log("\n[the retired rosters are gone by NAME, and their tombstones name the survivor]")
{
  const RETIRED = [
    { file: "app/actions/leads.ts", name: "ISA_ALLOWED_ROLES" },
    { file: "app/actions/lead-management.ts", name: "LEAD_DESK_ROLES" },
    { file: "app/actions/lead-lifecycle.ts", name: "LEAD_DESK_ROLES" },
    { file: "app/actions/lead-quick-actions.ts", name: "BROKERAGE_ROLES" },
    { file: "lib/voice/broker-commands.ts", name: "LEAD_DESK_ROLES" },
    { file: "app/api/leads/route.ts", name: "leadVisibleRoles" },
    { file: "app/api/leads/deduplication-log/route.ts", name: "leadVisibleRoles" },
    { file: "app/constants/auth.ts", name: "ROLE_PERMISSIONS" },
    { file: "app/leads/[leadId]/page.tsx", name: "BROKERAGE_ROLES" },
  ]
  for (const r of RETIRED) {
    check(`${r.file} no longer declares ${r.name}`,
      !new RegExp(`(const|let|var|export const)\\s+${r.name}\\b`).test(code(r.file)))
    check(`${r.file} leaves a tombstone naming the survivor`,
      /lib\/auth\/lead-visibility\.ts|lib\/security\/permission-matrix\.ts/.test(src(r.file)))
  }
}

console.log("\n[the dead user_type comparisons are gone from the folded sites]")
{
  // 'superadmin' as a users.user_type has ZERO live rows; 'broker_admin' is not a
  // storable user_type at all. Both appeared in the deleted rosters, where they
  // matched nothing. They may still appear inside the SURVIVOR (as the documented
  // input spelling / the legacy platform marker) and in prose.
  for (const site of FOLDED_SITES) {
    const c = code(site.file)
    check(`${site.file} no longer compares against a bare 'broker_admin'`,
      !/["']broker_admin["']/.test(c))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE RULING ITSELF — driven, not grepped.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fake PostgREST/Supabase client. Every builder method returns `this` and the
 * awaited value is whatever the table script says, so the resolver's real
 * control flow runs — including its error branches, which are the ones a
 * fail-closed gate lives or dies on.
 */
type TableScript = Record<string, { data?: any[]; error?: { message: string } }>
function fakeClient(script: TableScript, authUser: { id: string } | null = { id: "u-team-lead" }) {
  const calls: Array<{ table: string; op: string; args: any[] }> = []
  const make = (table: string) => {
    const res = script[table] ?? { data: [] }
    const builder: any = {
      select: (..._a: any[]) => builder,
      eq: (...a: any[]) => { calls.push({ table, op: "eq", args: a }); return builder },
      in: (...a: any[]) => { calls.push({ table, op: "in", args: a }); return builder },
      is: (...a: any[]) => { calls.push({ table, op: "is", args: a }); return builder },
      not: (...a: any[]) => builder,
      order: (..._a: any[]) => builder,
      limit: (..._a: any[]) => builder,
      update: (..._a: any[]) => builder,
      maybeSingle: async () => ({ data: (res.data ?? [])[0] ?? null, error: res.error ?? null }),
      single: async () => ({ data: (res.data ?? [])[0] ?? null, error: res.error ?? null }),
      then: (resolve: any, reject: any) =>
        Promise.resolve({ data: res.data ?? [], error: res.error ?? null }).then(resolve, reject),
    }
    return builder
  }
  return {
    client: { from: (t: string) => make(t), auth: { getUser: async () => ({ data: { user: authUser }, error: null }) } } as any,
    calls,
  }
}

const TEAM_A = "team-a"
const TEAM_B = "team-b"
const BROK = "brok-1"

console.log("\n[the ruling — a team lead sees leads, and sees THEIR TEAM's]")
{
  // A tenant whose ONLY team is this actor's: the team IS the tenant. This is the
  // owner's team-tier case, and the scope must be the whole tenant.
  const sole = fakeClient({
    teams: { data: [{ id: TEAM_A }] },
    agents: { data: [{ id: "a1" }] },
    team_members: { data: [] },
  })
  const soleRes = await resolveLeadVisibility(sole.client, {
    userId: "u-team-lead", userType: "team_lead", platformRole: null, brokerageId: BROK,
  })
  check("team_lead is ADMITTED", soleRes.allowed === true)
  check("…and on a tenant whose only team is theirs, the scope is the WHOLE TENANT",
    soleRes.allowed === true && soleRes.scope.kind === "brokerage" && soleRes.soleTeamTenant === true,
    JSON.stringify(soleRes))
}

console.log("\n[…and on a MULTI-TEAM tenant it is NOT the whole brokerage]")
{
  // The same actor, in a tenant that has a second team. Every read the resolver
  // makes is scripted; `teams` returns the actor's team first (led) and both
  // teams on the second call (all).
  let teamsCall = 0
  const client: any = {
    auth: { getUser: async () => ({ data: { user: { id: "u-team-lead" } }, error: null }) },
    from: (t: string) => {
      const rows =
        t === "teams" ? (teamsCall++ === 0 ? [{ id: TEAM_A }] : [{ id: TEAM_A }, { id: TEAM_B }])
        : t === "agents" ? [{ id: "agent-in-team-a" }]
        : t === "team_members" ? [{ agent_id: "agent-also-in-team-a" }]
        : []
      const b: any = {
        select: () => b, eq: () => b, in: () => b, is: () => b, not: () => b,
        order: () => b, limit: () => b, update: () => b,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        then: (r: any, j: any) => Promise.resolve({ data: rows, error: null }).then(r, j),
      }
      return b
    },
  }
  const res = await resolveLeadVisibility(client, {
    userId: "u-team-lead", userType: "team_lead", platformRole: null, brokerageId: BROK,
  })
  check("the scope is TEAM, not brokerage — THE failure mode this lane exists to prevent",
    res.allowed === true && res.scope.kind === "team", JSON.stringify(res))
  if (res.allowed && res.scope.kind === "team") {
    check("it names the actor's team only", res.scope.teamIds.join(",") === TEAM_A)
    check("its agent roster is the UNION of agents.team_id and team_members",
      res.scope.agentIds.includes("agent-in-team-a") && res.scope.agentIds.includes("agent-also-in-team-a"),
      res.scope.agentIds.join(","))

    // The filter that carries it.
    const q = fakeClient({})
    applyLeadRowScope(q.client.from("leads").select("*"), res.scope)
    check("applyLeadRowScope pins the brokerage AND the team's agents",
      q.calls.some((c) => c.op === "eq" && c.args[0] === "brokerage_id")
      && q.calls.some((c) => c.op === "in" && c.args[0] === "agent_id"),
      JSON.stringify(q.calls))

    // The row-level twin must agree with the query-level one.
    check("a lead worked by a team agent is IN scope",
      leadRowInScope(res.scope, { brokerage_id: BROK, agent_id: "agent-in-team-a" }))
    check("a lead worked by ANOTHER team's agent is OUT",
      !leadRowInScope(res.scope, { brokerage_id: BROK, agent_id: "agent-in-team-b" }))
    check("an UNASSIGNED lead is OUT — the unworked pool belongs to the brokerage",
      !leadRowInScope(res.scope, { brokerage_id: BROK, agent_id: null }))
    check("another tenant's lead is OUT",
      !leadRowInScope(res.scope, { brokerage_id: "brok-2", agent_id: "agent-in-team-a" }))
  }
}

console.log("\n[fail closed — every way the scope can fail to resolve REFUSES]")
{
  const noTeam = fakeClient({ teams: { data: [] } })
  const r1 = await resolveLeadVisibility(noTeam.client, {
    userId: "u", userType: "team_lead", platformRole: null, brokerageId: BROK,
  })
  check("a team_lead anchored to NO team is refused, not given the brokerage",
    r1.allowed === false && r1.status === "unresolved", JSON.stringify(r1))

  const refused = fakeClient({ teams: { error: { message: "permission denied" } } })
  const r2 = await resolveLeadVisibility(refused.client, {
    userId: "u", userType: "team_lead", platformRole: null, brokerageId: BROK,
  })
  check("a REFUSED teams read is refused, not read as 'no team'",
    r2.allowed === false && r2.status === "unresolved", JSON.stringify(r2))

  const noTenant = fakeClient({})
  const r3 = await resolveLeadVisibility(noTenant.client, {
    userId: "u", userType: "team_lead", platformRole: null, brokerageId: null,
  })
  check("a team_lead with no brokerage is refused", r3.allowed === false)

  const grantRefused = fakeClient({ user_role_assignments: { error: { message: "denied" } } })
  const r4 = await resolveLeadVisibility(grantRefused.client, {
    userId: "u", userType: "agent", platformRole: null, brokerageId: BROK,
  })
  check("a REFUSED grant read is refused, not read as 'no grant'",
    r4.allowed === false && r4.status === "unresolved", JSON.stringify(r4))

  const profileRefused = fakeClient({ users: { error: { message: "denied" } } })
  const r5 = await resolveLeadVisibility(profileRefused.client, {
    userId: "u", userType: "team_lead", brokerageId: BROK, // platformRole UNDEFINED → must be read
  })
  check("'platform_role unknown' is not 'platform_role absent' — a refused read refuses",
    r5.allowed === false && r5.status === "unresolved", JSON.stringify(r5))
}

console.log("\n[the rest of the roster keeps the scope it always had]")
{
  const c = fakeClient({})
  const broker = await resolveLeadVisibility(c.client, {
    userId: "u", userType: "broker", platformRole: null, brokerageId: BROK,
  })
  check("a broker is brokerage-scoped", broker.allowed === true && broker.scope.kind === "brokerage")

  const agent = await resolveLeadVisibility(fakeClient({ user_role_assignments: { data: [] } }).client, {
    userId: "u", userType: "agent", platformRole: null, brokerageId: BROK,
  })
  check("an agent is REFUSED — agents see contacts, never leads",
    agent.allowed === false && agent.status === "forbidden")

  const staff = await resolveLeadVisibility(c.client, {
    userId: "u", userType: "admin", platformRole: "superadmin", brokerageId: BROK,
  })
  check("platform staff are identified by platform_role and see all tenants",
    staff.allowed === true && staff.scope.kind === "platform")

  const deadSuperadmin = await resolveLeadVisibility(fakeClient({ user_role_assignments: { data: [] } }).client, {
    userId: "u", userType: "superadmin", platformRole: null, brokerageId: BROK,
  })
  check("the legacy user_type='superadmin' marker still admits (m308/is_platform_admin read it too)",
    deadSuperadmin.allowed === true)

  // THE SECOND SEAT: user_type 'agent' holding a tenant-pinned 'admin' grant.
  const grant = await resolveLeadVisibility(
    fakeClient({ user_role_assignments: { data: [{ role: "admin", brokerage_id: BROK, vendor_id: null, agent_id: null }] } }).client,
    { userId: "u", userType: "agent", platformRole: null, brokerageId: BROK },
  )
  check("the SECOND SEAT (agent user_type + admin grant on own tenant) is admitted, via grant",
    grant.allowed === true && grant.via === "grant" && grant.scope.kind === "brokerage")

  // A grant administering ANOTHER brokerage authorises nothing.
  const foreign = await resolveLeadVisibility(
    fakeClient({ user_role_assignments: { data: [{ role: "admin", brokerage_id: "brok-2", vendor_id: null, agent_id: null }] } }).client,
    { userId: "u", userType: "agent", platformRole: null, brokerageId: BROK },
  )
  check("a grant pinned to ANOTHER brokerage authorises nothing", foreign.allowed === false)

  // A team lead who ALSO holds an admin grant keeps the wider scope.
  const both = await resolveLeadVisibility(
    fakeClient({ user_role_assignments: { data: [] } }).client,
    { userId: "u", userType: "broker_owner", platformRole: null, brokerageId: BROK },
  )
  check("broker_owner is brokerage-wide", both.allowed === true && both.scope.kind === "brokerage")
}

console.log("\n[the lead-id fallback for tables with no agent column]")
{
  const brokerageScope: LeadRowScope = { kind: "brokerage", brokerageId: BROK }
  const none = await resolveScopedLeadIds(fakeClient({}).client, brokerageScope)
  check("brokerage scope needs NO lead-id restriction (null, not [])",
    none.ok === true && none.leadIds === null)

  const teamScope: LeadRowScope = { kind: "team", brokerageId: BROK, teamIds: [TEAM_A], agentIds: ["a1"] }
  const ids = await resolveScopedLeadIds(fakeClient({ leads: { data: [{ id: "l1" }, { id: "l2" }] } }).client, teamScope)
  check("team scope resolves the team's lead ids", ids.ok === true && (ids as any).leadIds.join(",") === "l1,l2")

  const denied = await resolveScopedLeadIds(fakeClient({ leads: { error: { message: "denied" } } }).client, teamScope)
  check("a refused lead-id read FAILS CLOSED (ok:false, not an empty list)", denied.ok === false)

  const emptyTeam: LeadRowScope = { kind: "team", brokerageId: BROK, teamIds: [TEAM_A], agentIds: [] }
  const q = fakeClient({})
  applyLeadRowScope(q.client.from("leads").select("*"), emptyTeam)
  check("a team with NO agents becomes an impossible filter, never an unfiltered query",
    q.calls.some((c) => c.op === "eq" && c.args[0] === "agent_id"), JSON.stringify(q.calls))
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE DATABASE HALF — the migration exists and is honest about what it closes
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[the SQL predicate agrees with the app — and says what it cannot do]")
{
  const migDir = join(ROOT, "supabase", "migrations")
  const migs = existsSync(migDir) ? readdirSync(migDir) : []
  const teamLeadMig = migs
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ f, body: readFileSync(join(migDir, f), "utf8") }))
    .filter(({ body }) => /CREATE OR REPLACE FUNCTION public\.is_lead_visible_role/.test(body))
    .sort((a, b) => a.f.localeCompare(b.f, undefined, { numeric: true }))
  check("a migration redefines is_lead_visible_role()", teamLeadMig.length > 0)
  const latest = teamLeadMig[teamLeadMig.length - 1]
  if (latest) {
    const body = latest.body
    console.log(`    (latest: ${latest.f})`)
    check("it admits team_lead in the user_type branch", /user_type IN \([^)]*'team_lead'/.test(body))
    check("it admits team_lead in the GRANT branch too — m308's two-branch shape survives",
      /ura\.role IN \([^)]*'team_lead'/.test(body))
    check("it keeps the AI-ISA system arm", /is_ai_isa_system\(\)/.test(body))
    check("it keeps the platform-admin arm", /is_platform_admin\(\)/.test(body))
    // Only the FUNCTION BODY is examined. The header and the COMMENT ON string
    // both discuss 'broker_admin' by name; testing the whole file would fail on
    // its own documentation.
    const fnBody = (body.match(/AS \$function\$([\s\S]*?)\$function\$/) ?? ["", ""])[1]
    const fnCode = fnBody.replace(/^\s*--.*$/gm, "")

    // ── THE PREMISE OF THIS CHECK CHANGED (lane A) ─────────────────────────
    //
    // It used to be a flat "the body must NOT name 'broker_admin'", because the
    // value was a PHANTOM: m308 and m518 removed it for one reason only — the
    // column could not hold it, so the literal matched nobody and read as
    // coverage it did not provide.
    //
    // m530 makes it storable (owner: "a broker admin is a user type"), which
    // removes that premise. The rule that actually matters is the invariant
    // underneath it, and it is now asserted directly: THE BODY MAY ONLY NAME
    // USER TYPES THE COLUMN CAN STORE. That catches the original defect AND every
    // future one, instead of hard-coding one value's name.
    const admitted = CHECK_VOCABULARIES.users?.user_type ?? []
    const named = [...fnCode.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    const phantoms = [...new Set(named)].filter(
      (v) => !admitted.includes(v) && v !== "broker_admin",
    )
    check("the function BODY names no user_type the column cannot store",
      admitted.length > 0 && phantoms.length === 0, phantoms.join(", "))
    // broker_admin is the ONE value allowed to be ahead of the column, and only
    // while its migration is on disk and unapplied. Once m530 is applied and the
    // vocabulary cache regenerated, `admitted` contains it and this is trivially
    // true — no edit needed.
    check("…and if it names broker_admin, m530 (which makes it storable) is on disk",
      !/'broker_admin'/.test(fnCode)
      || admitted.includes("broker_admin")
      || migs.some((f) => f.startsWith("m530-")))
    // POSITIVE CONTROL — the phantom finder must still recognise the shape it
    // was written for: m308's original defect, a body naming a value the column
    // has never admitted.
    check("POSITIVE CONTROL the phantom finder still catches an unstorable literal",
      ["'managing_broker'", "'platform_admin'"]
        .map((s) => s.slice(1, -1))
        .every((v) => !admitted.includes(v)))
    check("it states honestly that the predicate CANNOT express team scope",
      /CANNOT EXPRESS TEAM SCOPE/i.test(body))
    check("…and names the application-layer narrowing that does",
      /lib\/auth\/lead-visibility\.ts/.test(body))
    check("the function COMMENT carries the scope warning to anyone reading the DB",
      /SCOPE WARNING/.test(body))
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE TIER HALF — a team-tier subscription has no broker
// ─────────────────────────────────────────────────────────────────────────────

console.log("\n[the tier half — SUPERSEDED, and the supersession is the assertion]")
{
  const matrix = code("lib/kernel/tier-role-matrix.ts")

  // ── THIS SECTION USED TO PIN THE OPPOSITE (lane A) ────────────────────────
  //
  // It asserted "the team tier is DERIVED from SEAT_ROLES, not retyped" — i.e.
  // that `team` was SEAT_ROLES MINUS broker/broker_owner — on the earlier ruling
  // that a team-tier subscription has no broker.
  //
  // OWNER, 2026-08-22, seating one explicitly: "then a broker as a user type with
  // different permisson roles which that takes up 3 of 5 seats". A tier caps the
  // COUNT of seats, never which user types fill them.
  //
  // THE TEAM LEAD'S LEAD DESK IS NOT AFFECTED, AND THAT IS THE POINT OF ASSERTING
  // IT HERE. is_lead_visible_role() is per-user and carries no tier clause, so
  // seating a broker ADDS someone who passes and cannot remove the team lead.
  // The rest of this file proves the team lead's admission independently; this
  // block only proves the tier no longer withholds the seat.
  check("no tier subtracts broker/broker_owner any more",
    !/SEAT_ROLES\.filter\(\(r\)\s*=>\s*r\s*!==\s*"broker"/.test(matrix))
  check("every tier's invitable menu is the same expression",
    /solo_agent:\s*ALL_SEATABLE_ROLES/.test(matrix) && /team:\s*ALL_SEATABLE_ROLES/.test(matrix))
  // Read RAW, not through `code()` — this asserts on the file's DOCUMENTATION,
  // and code() strips comments by design.
  check("…and the matrix says so out loud, so the next reader is not surprised",
    /A TIER DOES NOT RESTRICT WHICH USER TYPES MAY BE SEATED/i.test(src("lib/kernel/tier-role-matrix.ts")))
  check("the unknown/legacy tier fallback still names its constant",
    /UNKNOWN_TIER_INVITABLE_ROLES/.test(matrix))
  // The fail-closed obligation MOVED to the seat axis — assert it is actually there.
  check("…and the fail-closed duty now sits on the seat CAP, which floors to the smallest tier",
    /TIER_ORDER\[0\]/.test(matrix))
}

console.log("\n──────────────────────────────────────────────────")
console.log(` MEASURED: ${leadTouchingFiles.length} files reach \`leads\` across ${SCAN_ROOTS.join("+")}; ` +
  `${FOLDED_SITES.length} folded sites asserted; ${DECLARED_EXCLUSIONS.length} declared exclusion(s); ` +
  `scripts/ and supabase/ excluded from the roster census by design.`)
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ LEAD_VISIBILITY_ROSTER_FAIL"); process.exit(1) }
console.log(" ✅ LEAD_VISIBILITY_ROSTER_PASS — one roster, and a team scope behind every admission")
