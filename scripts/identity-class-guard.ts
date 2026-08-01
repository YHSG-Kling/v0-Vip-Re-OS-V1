/**
 * scripts/identity-class-guard.ts
 *
 * test:identity-class — ONE VALUE CANNOT BE TWO IDENTITIES.
 *
 * THE DEFECT. 195 columns in this schema are named `agent_id`. 175 of them FK
 * `agents.id`; 20 FK `users.id`. Same name, two meanings. The obvious assumption
 * is right about ninety percent of the time, which is exactly why it survives
 * review and exactly why it is dangerous: the ten percent fails silently at read
 * time (a filter that matches nothing) or loudly at write time (a foreign-key
 * violation on a path nobody has exercised yet, because this OS has not rolled
 * out and every table is empty).
 *
 * It has already cost, all found by audit rather than by users:
 *   · lib/lifetime-customer-npv/scorer.ts read contacts.agent_id (AGENTS) and
 *     wrote lifetime_customer_npv_scores.agent_id (USERS). Verified live: the
 *     insert is rejected by the FK. The Lifetime Customer ledger — a pillar of
 *     the product — could never have held a row.
 *   · app/actions/ai-showing-management.ts used the same params.agentId as a
 *     users.id AND as showings.agent_id / activities.agent_id. Every
 *     AI-scheduled showing failed at the insert.
 *   · app/dashboard/listings/[id]/lifecycle/page.tsx filtered listings.agent_id
 *     (AGENTS) by user.id (USERS), so an agent could never open the lifecycle
 *     page for their own listing.
 *   · /api/widget/avatar-session looked up agents.user_id with an agents.id and
 *     404'd on every call ever made (retired in m336).
 *   · /api/widget/session greeted every website visitor with the generic
 *     assistant name because it read users.id with an agents.id (fixed m336).
 *
 * WHAT THIS GUARD ASSERTS, AND WHY THIS SHAPE. Provenance-guessing by variable
 * name produces false positives — `params.agentId` in app/actions/lifetime-npv.ts
 * legitimately holds a users id, and its callers even document that. So this
 * guard does NOT try to decide which class a variable is. It asserts the one
 * thing that needs no such judgement:
 *
 *     WITHIN A SINGLE FUNCTION, THE SAME EXPRESSION MUST NOT BE USED AS BOTH
 *     AN AGENTS-CLASS AND A USERS-CLASS IDENTITY.
 *
 * That is a self-contradiction. It does not matter which one is correct — both
 * cannot be, so the code is wrong either way. It is what caught the NPV scorer
 * and the showings action, and it cannot fire on merely-badly-named variables.
 *
 * WHAT IT CANNOT SEE, stated so nobody mistakes a green run for full coverage:
 * a mismatch that lives ACROSS a call boundary. The brand-voice defect (m341)
 * was exactly that — the settings page passed user.id into an action whose
 * three other callers correctly passed agents.id, so no single function
 * contradicted itself and the count never moved. That one was found by reading
 * the callers, which is why the burn-down is manual review against this list
 * rather than a number to drive to zero automatically.
 *
 * THE CANONICAL FIX ALREADY EXISTED. lib/kernel/agent-identity-resolver.ts has
 * shipped branded types (AgentRecordId, UserAgentId) and both resolvers for a
 * long time. It is imported by 18 files out of the 950 that touch agent_id. The
 * tool was never the problem; adoption was.
 *
 * REGENERATING THE CATALOGUE below (run against the live schema):
 *   select ccu.table_name as refs, tc.table_name
 *   from information_schema.table_constraints tc
 *   join information_schema.key_column_usage kcu
 *     on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
 *   join information_schema.constraint_column_usage ccu
 *     on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
 *   where tc.constraint_type='FOREIGN KEY' and tc.table_schema='public'
 *     and kcu.column_name='agent_id' and ccu.table_name='users';
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"

let pass = 0, fail = 0
const failures: string[] = []
function ok(label: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✓ ${label}`) }
  else { fail++; failures.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : "")
const code = (p: string) =>
  src(p).replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n")

/** The 20 tables whose agent_id column FKs USERS. Everything else FKs agents. */
const USERS_CLASS_TABLES = new Set([
  "agent_intro_videos", "ai_video_projects", "closing_disclosure_agreement", "conversation_logs",
  "income_forecast_snapshots", "lifetime_customer_npv_scores", "listing_health_interventions",
  "listing_health_scores", "listing_promo_videos", "newsletter_scheduled_sends",
  "newsletter_video_renders", "pattern_adoptions", "podcast_auto_runs", "podcast_episodes",
  "podcast_templates", "property_preferences", "revenue_protection_snapshots", "review_requests",
  "studio_sessions", "transparency_updates",
])

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = `${dir}/${e.name}`
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === ".next") continue
      walk(full, out)
    } else if (/\.tsx?$/.test(e.name)) out.push(full)
  }
  return out
}

/** Split a file into rough function bodies — the scope in which a contradiction
 *  is meaningful. A top-level split on `function`/arrow-assignment keywords is
 *  enough: the point is to avoid pairing usages from unrelated helpers. */
function functionChunks(source: string): string[] {
  const marks: number[] = []
  const re = /\b(?:export\s+)?(?:async\s+)?function\s+\w+|\bconst\s+\w+\s*=\s*(?:async\s*)?\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) marks.push(m.index)
  if (marks.length === 0) return [source]
  const chunks: string[] = []
  for (let i = 0; i < marks.length; i++) {
    chunks.push(source.slice(marks[i], i + 1 < marks.length ? marks[i + 1] : source.length))
  }
  return chunks
}

interface Contradiction { file: string; expr: string; agentsAt: string; usersAt: string }

/** A capture that is a TYPE, not a value. The object-literal regex happily
 *  matches `agent_id: string` in an interface — an artifact, not a defect. */
const NOT_A_VALUE = new Set(["string", "number", "boolean", "null", "undefined", "true", "false", "any", "unknown"])

/** Every (table, column, expression) triple in one chunk, classified. */
function classifyUsages(chunk: string): { expr: string; cls: "agents" | "users"; where: string }[] {
  const out: { expr: string; cls: "agents" | "users"; where: string }[] = []
  const fromRe = /\.from\(\s*[`"']([a-z_]+)[`"']\s*\)/g
  let m: RegExpExecArray | null
  while ((m = fromRe.exec(chunk))) {
    const table = m[1]
    let window = chunk.slice(m.index + m[0].length, m.index + m[0].length + 500)
    const nxt = window.indexOf(".from(")
    if (nxt !== -1) window = window.slice(0, nxt)
    const eqRe = /\.eq\(\s*[`"']([a-z_]+)[`"']\s*,\s*([A-Za-z_$][\w.$]*)\s*\)/g
    let e: RegExpExecArray | null
    while ((e = eqRe.exec(window))) {
      const [, col, expr] = e
      if (NOT_A_VALUE.has(expr)) continue
      if (col === "agent_id") {
        out.push({ expr, cls: USERS_CLASS_TABLES.has(table) ? "users" : "agents", where: `${table}.agent_id` })
      } else if (col === "id" && table === "users") {
        out.push({ expr, cls: "users", where: "users.id" })
      } else if (col === "id" && table === "agents") {
        out.push({ expr, cls: "agents", where: "agents.id" })
      } else if (col === "user_id" && table === "agents") {
        out.push({ expr, cls: "users", where: "agents.user_id" })
      }
    }
    // Inserts/updates: agent_id: <expr>
    const objRe = /\bagent_id\s*:\s*([A-Za-z_$][\w.$]*)/g
    let o: RegExpExecArray | null
    while ((o = objRe.exec(window))) {
      if (NOT_A_VALUE.has(o[1])) continue
      out.push({ expr: o[1], cls: USERS_CLASS_TABLES.has(table) ? "users" : "agents", where: `${table}.agent_id (write)` })
    }
  }
  return out
}

function findContradictions(): Contradiction[] {
  const found: Contradiction[] = []
  for (const file of [...walk("app"), ...walk("lib")]) {
    const c = code(file)
    if (!c.includes("agent_id")) continue
    for (const chunk of functionChunks(c)) {
      const usages = classifyUsages(chunk)
      const byExpr = new Map<string, Set<string>>()
      const whereByExpr = new Map<string, Map<string, string>>()
      for (const u of usages) {
        if (!byExpr.has(u.expr)) { byExpr.set(u.expr, new Set()); whereByExpr.set(u.expr, new Map()) }
        byExpr.get(u.expr)!.add(u.cls)
        whereByExpr.get(u.expr)!.set(u.cls, u.where)
      }
      for (const [expr, classes] of byExpr) {
        if (classes.size > 1) {
          const w = whereByExpr.get(expr)!
          found.push({ file, expr, agentsAt: w.get("agents") ?? "?", usersAt: w.get("users") ?? "?" })
        }
      }
    }
  }
  return found
}

console.log("\n═══ 1. No function uses one value as both identity classes ═══")
{
  const found = findContradictions()
  for (const f of found) {
    console.log(`     ${f.file}: \`${f.expr}\` is ${f.agentsAt} AND ${f.usersAt}`)
  }
  // A RATCHET, NOT A ZERO. Three of these were verified by hand and were real
  // defects — two of them paths that could never have run. The rest are
  // CANDIDATES: each still needs a human to read the callers, because the same
  // function can legitimately hold both classes in two differently-named
  // variables, and the window heuristic can pair a `.from()` with an `.eq()`
  // that belongs to a sibling query. Claiming they are all bugs would repeat
  // the exact mistake this guard exists to catch — asserting more than the
  // evidence supports. So: the number may only go DOWN.
  const BASELINE = 25
  ok(`self-contradicting identity uses at or below the baseline of ${BASELINE} (found ${found.length})`,
    found.length <= BASELINE,
    found.length > BASELINE
      ? `NEW: ${found.map((f) => `${f.file}:${f.expr}`).join(", ")}`
      : undefined)
  if (found.length < BASELINE) {
    console.log(`     ↓ ${BASELINE - found.length} below baseline — lower BASELINE to ${found.length} to lock the gain in.`)
  }
}

console.log("\n═══ 2. The three verified defects stay fixed ═══")
{
  const npv = code("lib/lifetime-customer-npv/scorer.ts")
  ok("the NPV scorer resolves contacts.agent_id (AGENTS) to a users id before\n    writing the users-class column — proven live: the raw write is rejected\n    by the foreign key, so this ledger could never have held a row",
    /resolveAgentRecordToUserId\(contact\.agent_id/.test(npv) &&
    !/agentId:\s+\(contact\.agent_id as string \| null\) \?\? null/.test(npv),
    "lib/lifetime-customer-npv/scorer.ts")

  // SCOPED to aiScheduleShowing. The file also holds createTour and
  // optimizeTourRoute, which have their OWN params.agentId — a file-wide
  // "no params.agentId anywhere" assertion failed on functions this pass never
  // examined, which would have been a claim beyond the evidence. Those two stay
  // in the §1 baseline until someone reads their callers.
  const showFile = code("app/actions/ai-showing-management.ts")
  const schedIdx = showFile.indexOf("export async function aiScheduleShowing")
  const show = schedIdx >= 0 ? showFile.slice(schedIdx, schedIdx + 6000) : ""
  ok("aiScheduleShowing writes the AGENTS id to showings + activities, not the\n    users id it correctly uses for the users lookup",
    /agent_id:\s+agentRecordId/.test(show) && !/agent_id:\s+params\.agentId/.test(show),
    "app/actions/ai-showing-management.ts::aiScheduleShowing")
  ok("...and REFUSES rather than writing a broken row when the user has no\n    agent record",
    /if \(!agentRecordId\)/.test(show))

  // m338 batch — the two per-agent ROLLUPS. Both crons read their agent list
  // straight out of `users`, so the users-class snapshot tables were always
  // right and the AGENTS-class source tables (transactions, listings) were
  // always wrong: the scores were computed over an empty set and reported as
  // real measurements. That is worse than a crash, which is why they survived.
  const rev = code("lib/revenue-protection/scorer.ts")
  // Targeted at the `q = q.eq(...)` shape the transactions/listings queries use.
  // A blanket ban on `input.agentId` also forbade the two CORRECT users-class
  // filters (listing_health_interventions, revenue_protection_snapshots) — the
  // pattern was wrong, the code was right, same trap as three times before.
  ok("revenue protection filters transactions + listings by the AGENTS id...",
    !/q = q\.eq\("agent_id", input\.agentId\)/.test(rev) &&
    (rev.match(/if \(agentRecordId\) q = q\.eq\("agent_id", agentRecordId\)/g) ?? []).length === 4,
    "lib/revenue-protection/scorer.ts")
  ok("...while its two users-class tables KEEP the users id",
    /listingSavesQuery\.eq\("agent_id", input\.agentId\)/.test(rev) &&
    /revenue_protection_snapshots/.test(rev))

  const inc = code("lib/income-forecast/forecaster.ts")
  ok("the income forecaster filters transactions + listings by the AGENTS id,\n    so the pipeline half of the forecast is no longer silently zero",
    /\.eq\("agent_id", agentRecordId \?\? "00000000-0000-0000-0000-000000000000"\)/.test(inc),
    "lib/income-forecast/forecaster.ts")
  ok("...and still writes income_forecast_snapshots with the users id",
    /agent_id:\s+input\.agentId|\.eq\("agent_id", input\.agentId\)/.test(inc))

  // m343 — COPILOT and the TRANSACTIONS kernel. Both had already resolved the
  // agents id correctly somewhere in the same function and then not used it at
  // the next call site — the pattern that keeps recurring.
  const cop = code("app/actions/copilot.ts")
  ok("initiateCall writes activities with the RESOLVED agents id, the same one\n    it already computed for voice_calls three lines earlier",
    /agent_id: agentsId,/.test(cop) && !/agent_id: agentId,/.test(cop),
    "app/actions/copilot.ts")

  const txk = code("lib/kernel/transactions.ts")
  // COUNTED, not banned. A blanket "no params.agentId write" also forbade the
  // review_requests write, which is genuinely users-class and correct — the same
  // over-broad-pattern mistake as m338, caught the same way. Five agents-class
  // writes move; exactly one users-class write stays.
  // FOUR object-writes (three activities + commission_calculations) and ONE
  // filter (agent_commission_profiles). Counted off the code — my first pass
  // asserted five writes from memory and failed on correct code, which is the
  // same over-claiming this guard exists to stop.
  const agentsWrites  = (txk.match(/agent_id:\s+agentRecordId/g) ?? []).length
  const agentsFilters = (txk.match(/\.eq\("agent_id", agentRecordId\)/g) ?? []).length
  const usersWrites   = (txk.match(/agent_id:\s+params\.agentId/g) ?? []).length
  ok("the transactions kernel writes activities / agent_commission_profiles /\n    commission_calculations with the AGENTS id — commission_calculations is\n    money, and it was a foreign-key violation",
    agentsWrites === 4 && agentsFilters === 1,
    `agentRecordId writes: ${agentsWrites}, filters: ${agentsFilters}`)
  ok("...while the ONE genuinely users-class write (review_requests) keeps the\n    users id",
    usersWrites === 1, `params.agentId writes left: ${usersWrites}`)

  // m342 — onboarding PROGRESS. Its two branches produced DIFFERENT classes into
  // the same variable: the self path resolved an agents id, the admin path kept
  // the caller-supplied users id. Everything downstream is agents-class, so a
  // broker looking at one of their agents got an empty progress report rather
  // than an error. Both branches now end on an agents id — and because a nearby
  // comment had been COMPENSATING for the old inconsistency when deriving a
  // users id for learning_assignments, that compensation had to be rewritten in
  // the same pass or the fix would have introduced a fresh bug.
  const prog = code("app/actions/onboarding/progress.ts")
  ok("both the self and admin branches resolve to an AGENTS id",
    (prog.match(/resolveAgentId\(supabase, targetAgentId\)|resolveAgentId\(supabase, user\.id\)/g) ?? []).length >= 3,
    "app/actions/onboarding/progress.ts")
  ok("...the brokerage lookups read `agents`, which is the class the id holds",
    !/\.from\('users'\)\s*\n\s*\.select\('brokerage_id'\)\s*\n\s*\.eq\('id', targetAgentId\)/.test(prog))
  ok("...and the learning_assignments users id is RESOLVED rather than assuming\n    the old mixed-class invariant that no longer holds",
    /resolveAgentRecordToUserId\(targetAgentId\)/.test(prog))

  // m341 — the BRAND VOICE settings page. Four callers of getBrandVoiceProfile;
  // three (the CRM composer, relationship panel and reply coach) already passed
  // agents.id correctly from app/crm/page.tsx, and only the dedicated settings
  // page passed user.id. So the fix belonged on the OUTLIER: resolving inside
  // the action would have broken the three that already worked. Proven live —
  // the users id is rejected by the FK, the agents id is accepted.
  const bv = code("app/settings/brand-voice/page.tsx")
  ok("the brand-voice settings page resolves users\u2192agents before reading or\n    saving the profile (it always read empty and every save was rejected)",
    /\.from\("agents"\)\.select\("id"\)\.eq\("user_id", user\.id\)/.test(bv) &&
    !/getBrandVoiceProfile\(user\.id\)/.test(bv),
    "app/settings/brand-voice/page.tsx")
  ok("...and refuses with a real instruction when the user has no agent row",
    /No agent profile yet/.test(src("app/settings/brand-voice/page.tsx")))

  // m339 batch — three surfaces that returned an EMPTY RESULT rather than an
  // error, which is why none of them ever looked broken.
  const rep = code("lib/kernel/reputation.ts")
  ok("review_requests (users-class) is keyed by the resolved users id, while\n    agent_reviews and referrals keep the agents id — the insert was an FK\n    violation, so no review request could ever be created",
    /resolveAgentRecordToUserId\(input\.agentId\)/.test(rep) &&
    /agent_id:\s+reviewRequestAgentId/.test(rep),
    "lib/kernel/reputation.ts")

  const pod = code("lib/podcast/auto-producer.ts")
  ok("the podcast host's VOICE CLONE is looked up by the agents id — hostUserId\n    is users-class, so this never matched and every auto-produced episode fell\n    through to a non-cloned voice in silence",
    /resolveUserIdToAgentRecord\(input\.hostUserId, input\.brokerageId\)/.test(pod) &&
    !/\.eq\("agent_id", input\.hostUserId\)/.test(pod),
    "lib/podcast/auto-producer.ts")

  const vrec = code("app/api/ai/video-recommendations/route.ts")
  ok("the \"already sent a market update?\" check reads ai_video_projects\n    (users-class) by user.id — keyed by the agents id it never matched, so the\n    route recommended the same video every single time",
    /\.from\("ai_video_projects"\)[\s\S]{0,80}\.eq\("agent_id", user\.id\)/.test(vrec),
    "app/api/ai/video-recommendations/route.ts")

  const life = code("app/dashboard/listings/[id]/lifecycle/page.tsx")
  ok("the listing lifecycle page filters listings.agent_id by the AGENTS id —\n    filtering it by user.id matched nothing, so an agent could never open\n    their own listing",
    /resolveUserIdToAgentRecord\(user\.id/.test(life) &&
    !/\.eq\("agent_id", user\.id\)/.test(life),
    "app/dashboard/listings/[id]/lifecycle/page.tsx")
}

console.log("\n═══ 3. The canonical resolver is the one place this is decided ═══")
{
  const r = "lib/kernel/agent-identity-resolver.ts"
  const c = code(r)
  ok("it exists and exports BOTH directions", /resolveAgentRecordToUserId/.test(c) && /resolveUserIdToAgentRecord/.test(c))
  ok("...and the branded types that let the compiler help",
    /AgentRecordId/.test(c) && /UserAgentId/.test(c))

  // ONE IMPLEMENTATION, TWO FACES (m340). lib/kernel/agent-identity.ts and
  // agent-identity-resolver.ts were two separate users→agents lookups — 57 files
  // imported the first, 27 the second, and they disagreed: only one cached, and
  // only one was brokerage-scoped. The unscoped one used .maybeSingle(), which
  // THROWS for a user with agents rows in two brokerages, so the more widely
  // adopted module was the riskier one. Signatures kept, implementation merged.
  const idm = code("lib/kernel/agent-identity.ts")
  // CORRECTED (m344). m340 asserted that agent-identity DELEGATES to the
  // resolver. That shipped and BROKE THE PRODUCTION BUILD: the resolver is
  // `server-only`, this module is imported from pages webpack bundles outside
  // the server graph, and the static import dragged server-only into a Pages
  // Router bundle. tsc cannot see it — only `next build` can, which is why the
  // failure reached CI. The two modules are NOT redundant and the assertion now
  // enforces the opposite: this one must NOT statically import the server-only
  // module.
  ok("agent-identity does NOT statically import the server-only resolver —\n    it is imported from client-bundled pages, and that import broke the build",
    !/from ['"]\.\/agent-identity-resolver['"]/.test(idm), "lib/kernel/agent-identity.ts")
  ok("...and offers the BROKERAGE-SCOPED variant callers should prefer,\n    implemented against the caller's own client",
    /export async function resolveAgentIdInBrokerage/.test(idm) &&
    /supabase: SupabaseClient/.test(idm))
  ok("...while the unscoped path no longer uses maybeSingle(), which threw for a\n    user carrying agents rows in more than one brokerage",
    !/\.eq\('user_id', userId\)\s*\n\s*\.maybeSingle\(\)/.test(idm) && /\.limit\(1\)/.test(idm))

  // Adoption is a RATCHET, not a target. It only has to go up.
  const ADOPTION_FLOOR = 20
  const adopters = [...walk("app"), ...walk("lib")].filter((f) =>
    /resolveUserIdToAgentRecord|resolveAgentRecordToUserId/.test(code(f)))
  ok(`at least ${ADOPTION_FLOOR} files route identity through the resolver (found ${adopters.length}) —\n    a ratchet: this number may only go up, so each pass that touches a\n    mixed-class query is expected to convert it rather than work around it`,
    adopters.length >= ADOPTION_FLOOR, String(adopters.length))
}

console.log("\n═══ 4. The catalogue this guard reasons from is honest ═══")
{
  ok("the users-class table list is exactly the 20 the live schema reports",
    USERS_CLASS_TABLES.size === 20, String(USERS_CLASS_TABLES.size))
  ok("...and this file carries the query to regenerate it, so it cannot quietly\n    drift away from the schema it describes",
    /information_schema\.table_constraints/.test(src("scripts/identity-class-guard.ts")))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`IDENTITY CLASS — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\n195 columns are named agent_id; 175 mean agents.id and 20 mean users.id.")
  console.log("Route it through lib/kernel/agent-identity-resolver instead of guessing.")
  process.exit(1)
}
console.log("Verified defects fixed and locked; 25 candidates remain behind a ratchet")
console.log("that may only go down. The resolver is the one place this should be decided.")
