#!/usr/bin/env tsx
/**
 * scripts/team-scope-authority-simulator.ts  (npm run test:team-scope-authority)
 * ─────────────────────────────────────────────────────────────────────────────
 * A TEAM IS A MINI BROKERAGE, AND ITS LEAD KEEPS ITS BOOKS (m473).
 *
 * Owner ruling, verbatim:
 *
 *   "a team is a mini version of a brokerage … the team lead needs to see
 *    finaincials pertaining to their contacts and their team and be able to set
 *    the caps and percentages of their agents. now this is too strict."
 *
 * ── THE ANCHOR THIS PROOF PINS ──────────────────────────────────────────────
 *
 * Leading a team is the FACT `teams.team_lead_id = <users.id>` — never a
 * user_type. MEASURED live at authoring: the one real team's lead carries
 * user_type 'agent', so every seat-anchored lane refused the actual lead, and a
 * 'team_lead' seat that leads no team row leads nothing. The three actions this
 * proof covers write through the SERVICE client, where RLS is bypassed — the
 * app gate is the only gate, so it must mirror m473's RLS lanes exactly.
 *
 * SOURCE-ONLY, deliberately lean: the RLS half was proven LIVE at migration
 * time by impersonation (lead 1/1/1, seat-holder 0/0, member-authors-own-terms
 * 0, admin 1/1, residue 0 — recorded in m473 + the registry). This proof keeps
 * the APP half honest: the gates call the ONE shared team-scope helper, the
 * helper asks the DATABASE's own agent_team_id() rather than restating its
 * resolution order, and no action re-anchors team authority on a user_type.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { blankComments, blankStrings } from "./strip-comments"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

/**
 * Occurrences of `needle` as CODE — comments and string literal BODIES masked.
 *
 * The mask is no longer hand-rolled (finding #250). blankStrings() is the one
 * correct scanner: it blanks comment and string CONTENT to spaces while every
 * character offset survives, so an index into the masked text still points at
 * the same character of `src`. A hit counts when its FIRST character survived
 * the blanking — the same rule the hand-rolled mask applied, and the reason a
 * needle like `rpc("agent_team_id"` (code, then a literal) still matches.
 */
function codeHits(src: string, needle: string): number {
  const masked = blankStrings(src)
  let n = 0, from = 0
  for (;;) {
    const at = src.indexOf(needle, from)
    if (at === -1) return n
    from = at + needle.length
    if (masked[at] === src[at]) n++
  }
}

/**
 * Occurrences of a QUOTED literal outside comments. A quoted role name is by
 * definition inside a string literal, so the full mask above would blind any
 * scan for one — the negative control below caught exactly that on this
 * proof's first run. Comments alone are stripped here.
 */
function literalHits(src: string, needle: string): number {
  const stripped = blankComments(src)
  let n = 0, from = 0
  for (;;) {
    const at = stripped.indexOf(needle, from)
    if (at === -1) return n
    from = at + needle.length
    n++
  }
}

const HELPER = read("lib/teams/team-scope.ts")
const PROFILE = read("app/actions/admin/agent-profile.ts")
const AGREEMENT = read("app/actions/admin/commission-agreement.ts")
const MEMBERS = read("app/actions/admin/team-members.ts")
const MIGRATION = read("supabase/migrations/m473-a-team-is-a-mini-brokerage-and-its-lead-keeps-its-books.sql")

console.log("\n[the helper — one vocabulary with the database]")
check("resolveLedTeamId asks teams.team_lead_id — the FACT, one query, same as the SQL",
  /\.from\("teams"\)[\s\S]{0,200}?\.eq\("team_lead_id", userId\)/.test(HELPER))
check("...and destructures the read error (a refusal is not 'you lead nothing')",
  /const \{ data, error \} = await svc/.test(HELPER))
check("membership is answered by the DATABASE's OWN resolver, not a re-implementation",
  codeHits(HELPER, 'rpc("agent_team_id"') === 1)
check("...so the helper contains NO copy of the four-step resolution order",
  codeHits(HELPER, "team_members") === 0 && codeHits(HELPER, "users.team_id") === 0)
check("leadsAgentsTeam returns a RESULT, never a bare boolean over a refused read",
  /Promise<\{ ok: true; leads: boolean/.test(HELPER))

console.log("\n[the three gates — finance admin OR the FK lead, never a seat]")
for (const [name, src] of [["agent-profile", PROFILE], ["commission-agreement", AGREEMENT]] as const) {
  check(`${name}: the gate takes the TARGET and asks leadsAgentsTeam when finance fails`,
    // Pin the CLAIM (first param is the optional target), not the full parameter
    // list — the commission-agreement gate legitimately grew a contractType
    // param (m481 team_agreement lane) and an exact-signature pin went red on
    // that improvement, the recurring probe anti-pattern.
    /requireAdmin\(\s*targetUserId\?: string[,)]/.test(src) && codeHits(src, "leadsAgentsTeam(") >= 1)
  check(`${name}: the helper is IMPORTED, not restated`,
    /import \{[^}]*leadsAgentsTeam[^}]*\} from "@\/lib\/teams\/team-scope"/.test(src))
  check(`${name}: a refused resolution is relayed, not converted into Forbidden`,
    /if \(!lead\.ok\) return \{ ok: false, error: lead\.error \}/.test(src))
  check(`${name}: no user_type spelling of 'team_lead' anchors the gate`,
    literalHits(src, '"team_lead"') === 0)
}
check("team-members: add/update admits the lead of EXACTLY input.teamId",
  /led\.teamId !== input\.teamId/.test(MEMBERS))
check("team-members: remove resolves the member ROW's team before judging",
  /select\("team_id"\)\.eq\("id", memberId\)/.test(MEMBERS) && /led\.teamId !== row\.team_id/.test(MEMBERS))
check("team-members: the old any-team_lead-any-team gate (isAdminOrBroker) is gone",
  codeHits(MEMBERS, "isAdminOrBroker") === 0)

console.log("\n[the migration — the lanes moved onto the FACT and the self-write died]")
check("m473 rewrites can_read_team_books onto current_user_led_team_id",
  /can_read_team_books[\s\S]{0,700}?current_user_led_team_id\(\)/.test(MIGRATION))
check("m473 asserts NO policy still anchors team authority on is_team_lead_role",
  /still anchor team authority on is_team_lead_role/.test(MIGRATION))
check("m473 asserts an agent can no longer author their OWN terms",
  /still lets an agent author their own terms/.test(MIGRATION))
check("m473 asserts every team_members write policy carries a role test",
  /team_members write policy lost its role test/.test(MIGRATION))
check("m473 asserts the governed tables kept exactly four policies (no lane dropped)",
  /no longer has exactly 4 policies/.test(MIGRATION))

console.log("\n[negative controls — each scan must be able to fail]")
check("NEGATIVE — the code-hit scanner sees through neither comments nor strings",
  codeHits('// leadsAgentsTeam(\nconst x = "leadsAgentsTeam("', "leadsAgentsTeam(") === 0 &&
  codeHits("leadsAgentsTeam(x)", "leadsAgentsTeam(") === 1)
check("NEGATIVE — a seat-anchored gate WOULD be caught",
  literalHits('if (userType === "team_lead") allow()', '"team_lead"') === 1)
check("NEGATIVE — ...while the same spelling in a comment is not",
  literalHits('// gate on "team_lead" here', '"team_lead"') === 0)

console.log("\n" + "─".repeat(78))
console.log(`${pass} passed, ${fail} failed`)
if (fail) { for (const f of fails) console.log(`  ✗ ${f}`); process.exit(1) }
