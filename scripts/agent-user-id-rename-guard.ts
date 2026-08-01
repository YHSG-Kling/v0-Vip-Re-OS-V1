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
  "podcast_templates",
  "revenue_protection_snapshots",
  "newsletter_video_renders",
  "income_forecast_snapshots",
] as const

const REMAINING = [
  "agent_intro_videos", "ai_video_projects", "closing_disclosure_agreement",
  "lifetime_customer_npv_scores",
  "listing_health_interventions", "listing_health_scores", "listing_promo_videos",
  "newsletter_scheduled_sends", "podcast_episodes",
  "property_preferences", "review_requests", "transparency_updates",
] as const

/**
 * The query chain that follows each `.from("<table>")`, so a sibling query's
 * agents-class `agent_id` in the same file is never blamed on this table.
 *
 * WRITTEN IN CODE, NOT AS A LOOKAHEAD, BECAUSE THE LOOKAHEAD WAS WRONG.
 * The first version was `([\s\S]{0,600}?)(?=\bfrom\(|$)` — lazy, terminated by
 * the next `from(` or end of input. When the next `.from()` sat MORE than 600
 * characters away, nothing could satisfy the lookahead, so the match failed
 * entirely and that call site produced NO window at all. Silently. A real
 * unconverted site in app/actions/revenue-protection.ts is what exposed it.
 *
 * That is the worst failure mode a guard has: not a false alarm, which someone
 * investigates, but a false ALL-CLEAR on a table it was asked to watch. Take
 * the window greedily and trim it in code, where "no following from()" is just
 * "use what is left" rather than "match nothing".
 */
function queryWindows(src: string, table: string): string[] {
  const out: string[] = []
  const re = new RegExp(`from\\(["']${table}["']\\)`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index + m[0].length, m.index + m[0].length + 600)
    const nextFrom = rest.search(/\bfrom\(/)
    out.push(nextFrom === -1 ? rest : rest.slice(0, nextFrom))
  }
  return out
}

console.log("\n═══ 1. A converted table never sees `agent_id` again ═══")
{
  const files = [...walkDir("app"), ...walkDir("lib")]
  for (const table of CONVERTED) {
    const offenders: string[] = []
    for (const f of files) {
      const src = code(read(f))
      if (!src.includes(`"${table}"`) && !src.includes(`'${table}'`)) continue
      for (const w of queryWindows(src, table)) {
        if (/\bagent_id\b/.test(w)) offenders.push(`${f}: ${w.replace(/\s+/g, " ").slice(0, 80)}`)
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
  const scan = (src: string, table: string) =>
    queryWindows(code(src), table).filter((w) => /\bagent_id\b/.test(w)).length
  ok("a regressed caller IS caught",
    scan(`await svc.from("studio_sessions").insert({ agent_id: x })`, "studio_sessions") === 1)
  ok("...a converted one is NOT",
    scan(`await svc.from("studio_sessions").insert({ agent_user_id: x })`, "studio_sessions") === 0)
  ok("...and an agents-class `agent_id` in a SIBLING query in the same file is\n    not blamed on the converted table — the window stops at the next .from()",
    scan(`await svc.from("studio_sessions").select("id")\nawait svc.from("contacts").select("id").eq("agent_id", a)`,
      "studio_sessions") === 0)
  // THE REGRESSION THAT ALMOST SHIPPED. The first window was a lazy match
  // terminated by a lookahead for the next `from(`. With the next `.from()`
  // beyond the 600-char cap, nothing satisfied the lookahead, the match failed
  // outright, and the site vanished from the report — a false ALL-CLEAR, which
  // is strictly worse than a false alarm because nobody investigates it.
  ok("...and a violation is STILL caught when the next .from() is beyond the\n    600-char window — the old lookahead silently reported nothing here",
    scan(`await svc.from("studio_sessions").select("*").eq("agent_id", x)\n`
      + `// ${"padding ".repeat(120)}\n`
      + `await svc.from("contacts").select("id")`, "studio_sessions") === 1)
  ok("...and when there is no following .from() at all, which is the same bug\n    wearing different clothes",
    scan(`await svc.from("studio_sessions").select("*").eq("agent_id", x)`, "studio_sessions") === 1)
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

  // m351 — two more, both found the same way: the moment the two classes stopped
  // sharing a name, code that had silently disagreed with itself became legible.
  const nv = code(read("app/api/internal/remotion/render-newsletter-video/route.ts"))
  ok("the newsletter render resolves users→agents before reading the voice clone —\n    agent_voice_profiles.agent_id FKs AGENTS and the ledger id is a USERS id, so\n    every render threw \"agent has no elevenlabs_voice_id\", blaming the agent's\n    setup for a lookup that was asking under the wrong key",
    /\.from\("agents"\)\s*\.select\("id"\)\.eq\("user_id", ledger\.agent_user_id\)/.test(nv.replace(/\n\s*/g, "")) &&
    /\.eq\("agent_id", voiceAgentRecordId\)/.test(nv))

  const pa = code(read("lib/analytics/prediction-accuracy.ts"))
  ok("the income-forecast accuracy rail joins like with like — it matched snapshot\n    ids (users) against transaction ids (agents), so `realized` was 0 for every\n    window and every forecast graded as a total miss, in the surface that\n    governs how much autonomy the OS is allowed",
    /const agentToUser = new Map<string, string>\(\)/.test(pa) &&
    /agentId: d\.agent_id \? \(agentToUser\.get\(d\.agent_id\) \?\? null\) : null,/.test(pa) &&
    /agentId: s\.agent_user_id \?\? null,/.test(pa))

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
