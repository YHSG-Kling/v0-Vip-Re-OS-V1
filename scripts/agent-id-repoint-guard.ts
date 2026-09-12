/**
 * scripts/agent-id-repoint-guard.ts
 *
 * test:agent-id-repoint — DRIVING agent_id TO ONE MEANING.
 *
 * THE TARGET. 195 columns in this schema are named `agent_id` and they mean two
 * different things: 175 FK agents(id) and 20 FK users(id). That split is upstream
 * of roughly fifty defects found by audit in this sweep — a filter that silently
 * matched nothing, or a foreign key that rejected a write whose error was then
 * discarded. Re-pointing the 20 makes the name mean one thing, which turns the
 * whole class from detectable-but-constructible into unconstructible: after it,
 * passing a users id fails loudly at the constraint instead of silently.
 *
 * WHY THE RE-POINT AND NOT A RENAME. An earlier pass proposed renaming those 20
 * columns to agent_user_id instead, on the theory that 36 tables already used
 * that name so it was a convention. That was wrong, and the owner corrected it:
 * the project deliberately moved AWAY from agent_user_id, and that decision is
 * why the resolver exists at all. lib/kernel/agent-identity.ts says it outright —
 *
 *     NEVER do:  agentId = agentRow?.id ?? user.id
 *     ALWAYS do: agentId = await resolveAgentId(supabase, user.id)
 *
 * — so crossing between a users id and an agents id is a RESOLVE, never a third
 * column name that means a bit of both. The 36 agent_user_id tables are a legacy
 * tail to migrate, not a pattern to extend. Frequency was evidence of age, not
 * of endorsement, and counting was the wrong test to apply.
 *
 * STATUS: THE RE-POINT HAS NOT LANDED, ON PURPOSE. It was applied once and
 * REVERTED within the same session, and the reason is the whole point of this
 * file. The DDL is one command. The callers are not: 45 sites pass a users id
 * into these columns and were CORRECT doing so, because the constraint really
 * did point at users. Moving the constraint without them does not fix 45 sites —
 * it regresses 45 working paths into silent-wrong-id paths, which is precisely
 * the failure this sweep exists to prevent. So the schema still reads 175/20 and
 * the callers still agree with it.
 *
 * WHAT THIS GUARD DOES UNTIL THEN. It enumerates every site that must convert,
 * as a RATCHET: the list may shrink, never grow. Converting a site early is safe
 * and welcome — resolveAgentId() returns the agents id for a user who has one —
 * so the count can be driven down before the DDL lands, and SHOULD be. When it
 * reaches zero, apply the re-point migration and flip section 1 to assert
 * agents-class.
 *
 * THE ORDER MATTERS AND IS THE LESSON: convert the callers first, move the
 * constraint last. A migration that outruns its callers is indistinguishable, at
 * runtime, from the defect it was meant to cure.
 */
import { readFileSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { stripComments } from "./strip-comments"

const REPOINTED = new Set([
  "agent_intro_videos", "ai_video_projects", "closing_disclosure_agreement", "conversation_logs",
  "income_forecast_snapshots", "lifetime_customer_npv_scores", "listing_health_interventions",
  "listing_health_scores", "listing_promo_videos", "newsletter_scheduled_sends",
  "newsletter_video_renders", "pattern_adoptions", "podcast_auto_runs", "podcast_episodes",
  "podcast_templates", "property_preferences", "revenue_protection_snapshots", "review_requests",
  "studio_sessions", "transparency_updates",
])

/**
 * An expression that names a USERS id. Deliberately conservative: it matches the
 * shapes this codebase actually uses for an auth/user id, so a hit is evidence
 * and not a guess. `agentUserId` counts — that is precisely the legacy name for
 * "a users id belonging to an agent", and it is the value that must now resolve.
 */
const USERS_CLASS = /(?:^|\.)(?:userId|user_id|hostUserId|ownerUserId|targetUserId|signerUserId|agentUserId|healthAgentUserId)$|(?:^|\.)user\.id$|^user\.id$/

const read = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }
// TOMBSTONE (orphan doctrine §1.1) — the private `walk(dir, out)` that stood here
// was one of 82 byte-identical copies of the same readdirSync walker. Survivor:
// scripts/runtime-roots.ts:61 (`walkTs`), imported above. It enumerated
// DIRECTORIES, and a root-level FILE is not a directory, so `proxy.ts` — the edge
// middleware that queries users with a SERVICE client on every request — was
// outside this guard's corpus. `rootRuntimeFiles()` supplies the root files.
/** Strip comments so the guard measures CODE, never its own prose. */
const code = (s: string) =>
  stripComments(s)

interface Site { file: string; line: number; table: string; expr: string; kind: "write" | "filter" }

function findUnconverted(): Site[] {
  const out: Site[] = []
  for (const file of [...walkTs("app"), ...walkTs("lib"), ...walkTs("components"), ...walkTs("hooks"), ...rootRuntimeFiles(".")]) {
    const s = code(read(file))
    for (const m of s.matchAll(/\.from\(\s*[`"']([a-z_]+)[`"']\s*\)/g)) {
      const table = m[1]
      if (!REPOINTED.has(table)) continue
      const start = m.index! + m[0].length
      let win = s.slice(start, start + 700)
      const nxt = win.indexOf(".from(")
      if (nxt !== -1) win = win.slice(0, nxt)
      const base = s.slice(0, m.index!).split("\n").length
      for (const w of win.matchAll(/\bagent_id\s*:\s*([A-Za-z_$][\w.$]*)/g)) {
        if (USERS_CLASS.test(w[1])) {
          out.push({ file, line: base + win.slice(0, w.index!).split("\n").length - 1, table, expr: w[1], kind: "write" })
        }
      }
      for (const e of win.matchAll(/\.eq\(\s*[`"']agent_id[`"']\s*,\s*([A-Za-z_$][\w.$]*)/g)) {
        if (USERS_CLASS.test(e[1])) {
          out.push({ file, line: base + win.slice(0, e.index!).split("\n").length - 1, table, expr: e[1], kind: "filter" })
        }
      }
    }
  }
  return out
}

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}

console.log("\n═══ 1. The catalogue matches the live schema ═══")
{
  // FLIPPED WITH m366. This assertion used to require the sibling guard to list
  // all 20, because it was describing the schema as it actually was. The
  // re-point has landed: every one of the 20 now FKs agents(id), verified live
  // against pg_constraint, so the users-class catalogue must be EMPTY. A name
  // reappearing there means either a new users-class column was introduced or
  // the re-point was partially reverted — both worth failing over.
  const cls = read("scripts/identity-class-guard.ts")
  const listed = (cls.match(/USERS_CLASS_TABLES = new Set<string>\(\[([\s\S]*?)\]\)/)?.[1] ?? "")
    .split(",").map((x) => x.trim().replace(/^"|"$/g, "")).filter(Boolean)
  ok("identity-class-guard catalogues ZERO users-class tables,\n    because m366 re-pointed the last 20 to agents(id)",
    listed.length === 0,
    `catalogue still has ${listed.length}: ${listed.join(", ")}`)
}

console.log("\n═══ 2. The conversion backlog, as a ratchet ═══")
// ZERO, AND IT STAYS ZERO. This was 45 when the backlog was enumerated. All 45
// were converted to resolve through the identity component, then m366 moved the
// constraints, and now the ratchet is an invariant rather than a countdown: any
// new site passing a users id into one of these columns would be REFUSED by the
// foreign key at runtime, so this guard's job has changed from "drive it down"
// to "it must never come back".
const BACKLOG = 0
const sites = findUnconverted()
{
  for (const s of sites) console.log(`     ${s.file}:${s.line}  ${s.table}.agent_id ${s.kind === "write" ? "<-" : "=?"} ${s.expr}`)
  ok(`callers still passing a users id at or below the backlog of ${BACKLOG} (found ${sites.length})`,
    sites.length <= BACKLOG,
    `${sites.length} > ${BACKLOG} — a NEW users-class write was added to a table that is mid-migration`)
  if (sites.length < BACKLOG) {
    console.log(`     ↓ ${BACKLOG - sites.length} below backlog — lower BACKLOG to ${sites.length} to lock the gain in.`)
  }
}

console.log(`\n${"═".repeat(70)}`)
console.log(`AGENT_ID RE-POINT — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nALWAYS do: agentId = await resolveAgentId(supabase, <the users id>)")
  console.log("and when it resolves to null, refuse — do not substitute.")
  process.exit(1)
}
console.log(`${sites.length} callers left to convert before the re-point can land (backlog ${BACKLOG}).`)
console.log("Convert the callers FIRST. A migration that outruns its callers is")
console.log("indistinguishable, at runtime, from the defect it was meant to cure.")
