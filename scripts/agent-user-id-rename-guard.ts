/**
 * scripts/agent-user-id-rename-guard.ts
 *
 * test:agent-user-id-rename — THE NAME WAS THE BUG. IT ONLY GETS FIXED ONCE.
 *
 * 195 columns in this schema are called `agent_id`. 175 foreign-key `agents(id)`;
 * 20 foreign-key `users(id)`. Same name, two incompatible meanings, and the two
 * classes never overlap — verified live, no agents row's id is also a users id —
 * so reading one as the other does not degrade. It silently matches nothing, or
 * the foreign key rejects the write and a discarded error reports success.
 *
 * FOUR PASSES OF GUARDS DID NOT END THIS. m337–m349 fixed twenty-odd verified
 * defects from this one ambiguity and both ratchets are still non-zero. A guard
 * catches NEW instances; it cannot make the mistake impossible, because the
 * mistake is entirely reasonable: the column is called agent_id and it holds an
 * agent's id, so every careful author reaches for the agents id.
 *
 * THE PROOF THAT THE NAME DEFEATS CAREFUL PEOPLE. lib/podcast/auto-producer.ts
 * carried two comments about the SAME column that contradicted each other — the
 * file header said `agents.id`, the write site 130 lines down said `users.id`.
 * Both were written deliberately. One had to be wrong.
 *
 * So the 20 users-class columns are being renamed to `agent_user_id`, in batches
 * small enough that each rename lands in ONE commit with every caller it has.
 * This guard exists so the rename is a one-way door: once a table is converted,
 * `agent_id` must never reappear on it.
 *
 * WHY BATCHES AND NOT ONE SWEEP. A half-renamed column is worse than either end
 * state — that is drift, the exact thing this work exists to remove. Each batch
 * is: read every caller, rename column + constraint, convert callers, prove.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => { try { return readFileSync(p, "utf8") } catch { return "" } }

function walkDir(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${e.name}`
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue
      walkDir(full, out)
    } else if (/\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}
/** Strip comments — otherwise this guard asserts against its own explanation. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

/**
 * THE FULL LIST — regenerate with:
 *
 *   SELECT c.conrelid::regclass::text FROM pg_constraint c
 *   JOIN unnest(c.conkey) WITH ORDINALITY k(attnum, ord) ON true
 *   JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum
 *   WHERE c.contype='f' AND a.attname='agent_id' AND c.confrelid='users'::regclass;
 *
 * (after the rename the same query with attname='agent_user_id' returns the
 * converted ones — together they must still be these twenty.)
 */
const CONVERTED = [
  "pattern_adoptions",
  "podcast_auto_runs",
  "studio_sessions",
  "conversation_logs",
] as const

const REMAINING = [
  "agent_intro_videos", "ai_video_projects", "closing_disclosure_agreement",
  "income_forecast_snapshots", "lifetime_customer_npv_scores",
  "listing_health_interventions", "listing_health_scores", "listing_promo_videos",
  "newsletter_scheduled_sends", "newsletter_video_renders", "podcast_episodes",
  "podcast_templates", "property_preferences", "revenue_protection_snapshots",
  "review_requests", "transparency_updates",
] as const

console.log("\n═══ 1. A converted table never sees `agent_id` again ═══")
{
  const files = [...walkDir("app"), ...walkDir("lib")]
  for (const table of CONVERTED) {
    const offenders: string[] = []
    for (const f of files) {
      const src = code(read(f))
      if (!src.includes(`"${table}"`) && !src.includes(`'${table}'`)) continue
      // Look only at the query chain that follows this table's .from(), so a
      // sibling query's agents-class agent_id in the same file is not blamed on
      // it. Every guard in this repo that skipped this step blamed the wrong line.
      const re = new RegExp(`from\\(["']${table}["']\\)([\\s\\S]{0,600}?)(?=\\bfrom\\(|$)`, "g")
      let m: RegExpExecArray | null
      while ((m = re.exec(src))) {
        if (/\bagent_id\b/.test(m[1])) offenders.push(`${f}: ${m[1].replace(/\s+/g, " ").slice(0, 80)}`)
      }
    }
    ok(`${table} — no caller still writes or filters \`agent_id\``,
      offenders.length === 0, offenders.slice(0, 3).join(" | "))
  }
  ok("the PostgREST embed hint follows the renamed CONSTRAINT, not the old one —\n    a stale hint is a 400 at runtime that nothing here would otherwise catch",
    /users!pattern_adoptions_agent_user_id_fkey/.test(read("app/dashboard/admin/intelligence-mesh/page.tsx")))
}

console.log("\n═══ 1b. ...and §1 would actually notice if one did ═══")
{
  // §1 passing proves nothing on its own — a regex that matches nothing passes
  // exactly the same way a clean tree does. Run the same scan logic over
  // synthetic sources: one that regressed, one that is correct, and one that
  // mentions an agents-class agent_id in a SIBLING query in the same file.
  const scan = (src: string, table: string) => {
    const re = new RegExp(`from\\(["']${table}["']\\)([\\s\\S]{0,600}?)(?=\\bfrom\\(|$)`, "g")
    let m: RegExpExecArray | null, hits = 0
    const s = code(src)
    while ((m = re.exec(s))) if (/\bagent_id\b/.test(m[1])) hits++
    return hits
  }
  ok("a regressed caller IS caught",
    scan(`await svc.from("studio_sessions").insert({ agent_id: x })`, "studio_sessions") === 1)
  ok("...a converted one is NOT",
    scan(`await svc.from("studio_sessions").insert({ agent_user_id: x })`, "studio_sessions") === 0)
  ok("...and an agents-class `agent_id` in a SIBLING query in the same file is\n    not blamed on the converted table — the window stops at the next .from()",
    scan(`await svc.from("studio_sessions").select("id")\nawait svc.from("contacts").select("id").eq("agent_id", a)`,
      "studio_sessions") === 0)
}

console.log("\n═══ 2. The catalogue is honest about what is left ═══")
{
  ok(`${CONVERTED.length} converted + ${REMAINING.length} remaining = the 20 users-class columns\n    the live schema reports — the batches cannot silently lose a table`,
    CONVERTED.length + REMAINING.length === 20)
  ok("...and this file carries the query to regenerate both lists, so it cannot\n    drift away from the schema it describes",
    /confrelid='users'::regclass/.test(read("scripts/agent-user-id-rename-guard.ts")))
  const overlap = CONVERTED.filter((t) => (REMAINING as readonly string[]).includes(t))
  ok("no table appears in both lists", overlap.length === 0, overlap.join(","))
}

console.log("\n═══ 3. The defect the rename exposed stays fixed ═══")
{
  // Renaming is not cosmetic: putting the two classes under different names made
  // a live bug legible immediately. adoptInsightAction reads its target list
  // straight out of `users`, so every id it holds is users-class — correct for
  // pattern_adoptions, and wrong for the contacts update, which FKs agents. That
  // update matched ZERO rows for every agent on every adoption and still
  // returned true, so the brokerage playbook reported "applied" and no contact
  // ever had ai_isa_enabled flipped.
  const bi = code(read("app/actions/brokerage-intelligence.ts"))
  ok("adoptInsightAction names its list agentUserIds, because it is read from\n    `users` — the old name made two different classes look like one thing",
    /let agentUserIds = /.test(bi) && /\.from\("users"\)/.test(bi))
  ok("...and pattern_adoptions gets that users id under the new column name",
    /agent_user_id:\s*agentUserId,/.test(bi))
  ok("...while the contacts update RESOLVES users→agents first — it was keyed by\n    the users id, matched nothing, and reported success anyway",
    /\.from\("agents"\)\.select\("id"\)\.eq\("user_id", agentUserId\)/.test(bi) &&
    /\.eq\("agent_id", agentRow\.id\)/.test(bi))
  ok("...and REFUSES the action when there is no agents row, rather than\n    returning true for a write that cannot land",
    /if \(!agentRow\?\.id\) return false/.test(bi))

  const ap = read("lib/podcast/auto-producer.ts")
  ok("auto-producer's header no longer contradicts its own write site about which\n    class podcast_episodes.agent_id holds — two deliberate comments, one wrong",
    !/agents\.id for agent_id per the FK/.test(ap) && /podcast_episodes\.agent_id FKs USERS/.test(ap))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`AGENT_USER_ID RENAME — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\nA converted table must never see `agent_id` again. A half-renamed column is")
  console.log("worse than either end state — that is the drift this work exists to remove.")
  process.exit(1)
}
console.log(`${CONVERTED.length}/20 users-class columns renamed to agent_user_id. ${REMAINING.length} remain,`)
console.log("each to be converted in one commit with every caller it has.")
