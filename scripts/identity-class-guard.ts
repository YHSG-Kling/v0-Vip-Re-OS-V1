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

/**
 * Tables whose `agent_id` column FKs USERS. THERE ARE NONE — m366 re-pointed the
 * last 20 to agents(id), so `agent_id` now means exactly one thing everywhere:
 * an agents(id).
 *
 * This used to list 20 tables. They were the reason the name lied, and the
 * reason a filter could silently match nothing or a write could be rejected by a
 * constraint whose error was then discarded. All 45 callers were converted to
 * resolve through lib/kernel/agent-identity.ts FIRST, and only then did the DDL
 * land — see scripts/agent-id-repoint-guard.ts for why that order is the whole
 * lesson.
 *
 * The set is kept rather than deleted, and the classification below still reads
 * it, so that if a future table is ever created with a users-class agent_id it
 * has an honest place to be declared instead of being silently mis-classified as
 * agents-class. It should stay empty.
 */
const USERS_CLASS_TABLES = new Set<string>([])

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
    //
    // NESTED OBJECTS ARE NOT COLUMNS (m367). An `agent_id:` key inside a JSONB
    // blob — metadata / payload / context / extracted_data — or inside a plain
    // local object is NOT a database column, but it sits in the same .from()
    // window and used to be classified as one. Two of the remaining candidates
    // were exactly this: lib/application/listing-lifecycle stamps
    // `metadata: { ..., agent_id: agentId }` on a calendar_events row whose
    // real column is agent_user_id (calendar_events has no agent_id at all),
    // and app/dashboard/admin/visitor-tracking sets a local object field near a
    // .from("users") window — `users` has no agent_id either.
    //
    // Both were artifacts. One of them (m366) still led to a real bug one hop
    // downstream, so the flag was worth following — but it should not be
    // counted as a class contradiction here. Blank the nested blobs first so
    // the count means what it claims to.
    const window2 = window.replace(
      /\b(?:metadata|payload|context|extracted_data|output_data|input_data|plan|config)\s*:\s*\{[^{}]*\}/g,
      "",
    )
    const objRe = /\bagent_id\s*:\s*([A-Za-z_$][\w.$]*)/g
    let o: RegExpExecArray | null
    while ((o = objRe.exec(window2))) {
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
  //
  // TRIAGE NOTE (m347) — CHECK FOR A CALLER BEFORE SPENDING TIME ON AN ENTRY.
  // A pass through the ai-* cluster found that most of these sit in UNWIRED
  // exports, and editing them would be changing dead code — churn that looks
  // like progress and proves nothing:
  //   · ai-document-intelligence — 7 exports, only aiAnalyzeContract is
  //     imported anywhere, and it never reads agentId. The flagged
  //     contradiction is in aiGenerateDocument, which nothing calls.
  //   · ai-content-generation — the flagged site is generateContentPlan; no
  //     caller. (Its live exports, e.g. generateListingDescription, are
  //     consistently agents-class and correct.)
  //   · ai-marketing-automation — 8 exports, ONE live caller
  //     (generateAIDirectMail, from AgentSuperpowersPanel). That one WAS a real
  //     defect and is fixed; the other seven are unwired.
  // So a high remaining count is not the same as a high remaining risk. Grep
  // for a caller first; if there is none, the entry belongs in the dead-surface
  // triage, not here.
  //
  // TRIAGE COMPLETE (m373). Every one of the remaining 11 has now been read
  // against the live schema, and NONE is a live defect. The list is:
  //
  //   UNWIRED — a real contradiction in code nothing calls (3):
  //     · ai-content-generation    generateContentPlan
  //     · ai-document-intelligence aiGenerateDocument
  //     · ai-transaction-coordinator draftTransactionCommunication
  //       (this one looked wired — AGENT_REGISTRY names it in a `lib` field —
  //        but NOTHING reads that field. See the assertion in section 7.)
  //
  //   LIVE AND ALREADY CORRECT — the detector pairs two uses that the code
  //   resolves BETWEEN, which is the artifact this ratchet exists to tolerate (8):
  //     · ai-showing-management x2   (fixed earlier; see section 2)
  //     · onboarding/license.ts x2 and onboarding/progress.ts (m371)
  //     · api/cron/podcast-weekly-auto   resolves users-first, then agents,
  //       and SKIPS with a stated reason when neither matches
  //     · lib/video/listing-promo-reactor  resolves agents->users, and records
  //       that an older doc comment claimed the opposite
  //     · lib/workflow-orchestrator/chains/listing-appt-prep  resolves
  //       users->agents at all three of its lookups
  //
  // So the number cannot go below 11 by fixing anything — only by WIRING or
  // DELETING the three unwired functions, which is a product decision, not a
  // correctness one. A ratchet that cannot move is still worth keeping: it
  // fails the moment a TWELFTH contradiction appears.
  const BASELINE = 11
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
  // REVERSED BY m366, and this one is worth reading twice. The original defect
  // was real and proven live: contacts.agent_id is AGENTS, the ledger column
  // FK'd USERS, so every NPV persist was foreign-key rejected and the Lifetime
  // Customer ledger could never hold a row. The fix was to resolve agents->users.
  // m366 re-pointed that column to agents(id), which makes the RESOLVE the
  // breakage — it would hand a users id to a column that FKs agents and
  // re-create the identical rejection. Verified live against pg_constraint
  // before flipping. The two id spaces are the same distance apart as they ever
  // were; only the destination moved.
  ok("the NPV scorer writes contacts.agent_id straight through, because the\n    ledger column FKs agents(id) since m366 — the agents->users resolve that\n    once fixed this would now re-break it",
    /const ownerAgentId = \(contact\.agent_id as string \| null\) \?\? null/.test(npv) &&
    !/resolveAgentRecordToUserId\(contact\.agent_id/.test(npv),
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
  // This assertion used to require that initiateCall's activities insert carried
  // `agent_id: agentsId` — correct at the time, but it froze the EXISTENCE of a
  // hand-rolled call record. That record was the real defect: initiateCall wrote
  // voice_calls("initiated") + activities("Outbound call initiated", completed)
  // and returned success WITHOUT EVER DIALLING, so the guard was protecting the
  // identity class of a row that should never have been written. initiateCall now
  // delegates to initiateWhisperBridge, the one lane that actually places the
  // call and only records it after the provider accepts.
  //
  // So assert the two things that are actually true and worth holding: copilot
  // writes no users id into an agent_id anywhere, and it does not re-implement
  // the call record it used to fabricate.
  ok("copilot never stamps a users id into an agents-class agent_id",
    !/agent_id: agentId,/.test(cop),
    "app/actions/copilot.ts")
  ok("...and initiateCall does not hand-roll a call record — it delegates to the\n    lane that dials, so a claim of 'called' requires a provider to have accepted",
    /initiateWhisperBridge/.test(cop) &&
    !/from\("voice_calls"\)[\s\S]{0,200}\.insert/.test(cop) &&
    !/"call_initiated"/.test(cop),
    "app/actions/copilot.ts")

  const txk = code("lib/kernel/transactions.ts")
  // COUNTED, not banned — the count is the point. This used to allow exactly ONE
  // params.agentId write, for review_requests, which was genuinely users-class.
  // m366 re-pointed review_requests at agents(id), so that one permitted exception
  // became the file's only wrong-class write: the post-close review request was
  // FK-rejected and the failure was swallowed twice over (a .then(null, null) and
  // an enclosing catch). The exception is now gone — FIVE agents-class writes, ZERO
  // users-class ones. Counted off the code, never from memory; asserting a count
  // from memory is the over-claiming this guard exists to stop.
  const agentsWrites  = (txk.match(/agent_id:\s+agentRecordId/g) ?? []).length
  const agentsFilters = (txk.match(/\.eq\("agent_id", agentRecordId\)/g) ?? []).length
  const usersWrites   = (txk.match(/agent_id:\s+params\.agentId/g) ?? []).length
  ok("the transactions kernel writes activities / agent_commission_profiles /\n    commission_calculations / review_requests with the AGENTS id —\n    commission_calculations is money, and it was a foreign-key violation",
    agentsWrites === 5 && agentsFilters === 1,
    `agentRecordId writes: ${agentsWrites}, filters: ${agentsFilters}`)
  ok("...and NO users-class agent_id write is left — since m366 there is no\n    column in this file for one to be correct in",
    usersWrites === 0, `params.agentId writes left: ${usersWrites}`)

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
  // FLIPPED BY m366. This used to assert the OPPOSITE — that review_requests was
  // keyed by a resolved USERS id, because the column FK'd users. m366 re-pointed it
  // at agents(id), which turned m339's corrective resolve into the very FK violation
  // it had been written to cure: same table, same symptom, opposite direction. A
  // guard that pins yesterday's schema does not protect the code, it preserves the
  // bug — so this now asserts that all three tables are keyed by the agents id with
  // no hop and no null-sentinel.
  const rep = code("lib/kernel/reputation.ts")
  ok("review_requests, agent_reviews and referrals are ALL agents-class — keyed\n    by input.agentId with no users-ward resolve, which since m366 would be the\n    FK violation that stops any review request being created",
    !/resolveAgentRecordToUserId/.test(rep) &&
    !/reviewRequestAgentId/.test(rep) &&
    /\.from\("review_requests"\)[\s\S]{0,400}?agent_id:\s+input\.agentId/.test(rep),
    "lib/kernel/reputation.ts")

  const pod = code("lib/podcast/auto-producer.ts")
  ok("the podcast host's VOICE CLONE is looked up by the agents id — hostUserId\n    is users-class, so this never matched and every auto-produced episode fell\n    through to a non-cloned voice in silence",
    /resolveUserIdToAgentRecord\(input\.hostUserId, input\.brokerageId\)/.test(pod) &&
    !/\.eq\("agent_id", input\.hostUserId\)/.test(pod),
    "lib/podcast/auto-producer.ts")

  const vrec = code("app/api/ai/video-recommendations/route.ts")
  // FLIPPED BY m366. This used to assert the OPPOSITE — that the check was keyed
  // by user.id, because ai_video_projects.agent_id was users-class. The re-point
  // made agents the one class, so the same query is now correct keyed by the
  // agents id, and the defect it originally caught (the route recommending the
  // same video forever because the filter matched nothing) stays fixed.
  ok("the \"already sent a market update?\" check reads ai_video_projects by the\n    AGENTS id, which is what that column means now",
    /\.from\("ai_video_projects"\)[\s\S]{0,80}\.eq\("agent_id", agentId\)/.test(vrec) &&
    !/\.from\("ai_video_projects"\)[\s\S]{0,80}\.eq\("agent_id", user\.id\)/.test(vrec),
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

console.log("\n═══ 3b. The AI ISA could not launch a campaign ═══")
{
  // m354. loginId is a USERS id — every other lookup in lib/application/ai-isa.ts
  // reads `users` by it and says so. But the contact segment filtered
  // contacts.agent_id, which FKs AGENTS, so it matched nothing for every agent
  // and the function returned "No contacts match the criteria". The engine that
  // turns scraped leads into calls could not launch a single campaign, and the
  // error blamed the agent's segment for a class mismatch.
  const isa = code("lib/application/ai-isa.ts")
  ok("the contact segment is filtered by the RESOLVED agents id, not the users id\n    the rest of the file legitimately uses",
    /\.from\("agents"\)\.select\("id"\)\.eq\("user_id", loginId\)/.test(isa.replace(/\n\s*/g, "")) &&
    /\.eq\("agent_id", isaAgentRecordId\)/.test(isa))
  ok("...and it REFUSES when there is no agents row, instead of reporting an\n    empty segment as though the agent simply had no matching contacts",
    /No agent profile for this user — an AI ISA campaign is agent-scoped/.test(isa))
  ok("...while the users-class lookups in the same file are untouched — loginId\n    still reads `users` for the brokerage and the caller identity",
    /\.from\("users"\)[\s\S]{0,120}\.eq\("id", loginId\)/.test(isa))
}

console.log("\n═══ 3c. The CMA generated, and left no trace ═══")
{
  // m355. cma-generator resolved brokerage_id from `users` by input.agentId —
  // correct, that lookup needs a users id — and then wrote the same value to
  // activities.agent_id, which FKs AGENTS. All three activity writes
  // (started / completed / failed) were FK-rejected. The CMA itself generated
  // and saved, so nothing looked broken: the seller got their CMA and the
  // agent's timeline simply never mentioned it.
  const cma = code("app/actions/cma-presentation/cma-generator.ts")
  ok("the CMA activity writes use the RESOLVED agents id, so the timeline the\n    OS claims to keep actually receives the rows",
    /agent_id: cmaAgentRecordId,/.test(cma) && !/agent_id: input\.agentId,/.test(cma))
  ok("...and the failure event does the same, rather than logging a failure that\n    itself fails to record",
    /const \{ data: failAgentRow \}/.test(cma) && /agent_id: \(failAgentRow as \{ id\?: string \} \| null\)\?\.id \?\? null,/.test(cma))
  ok("...while the brokerage lookups keep the USERS id, which is the class that\n    query needs — the split is deliberate, not a blanket conversion",
    /\.from\("users"\)[\s\S]{0,120}\.eq\("id", input\.agentId\)/.test(cma) &&
    /\.eq\("id", agentId\)/.test(cma))
}

console.log("\n═══ 3d. The CDA: four defects, one class confusion ═══")
{
  // m356. closing_disclosure_agreement.agent_id FKs USERS, while transactions,
  // agent_commission_profiles, agent_cap_tracking, agent_fee_charges and
  // auth.agentId are all AGENTS. One file held both classes under one name and
  // got it wrong four ways — on the commission-approval workflow, which is
  // money and compliance.
  const cda = code("app/actions/cda-portal.ts")
  // FLIPPED BY m366. closing_disclosure_agreement.agent_id was users-class, so
  // the fix at the time was to write agent.user_id. It now FKs agents(id), so the
  // correct value is agent.id — and the original defect (a CDA that could never
  // be created at all, on the commission-approval workflow) stays closed.
  ok("the CDA row is created with the agent's AGENTS id, matching every other\n    agents-class table this workflow touches",
    /agent_id: agent\.id,/.test(cda) && !/agent_id: agent\.user_id,/.test(cda))
  ok("...the commission verdict resolves users→agents before reading split, cap\n    and outstanding fees — all three read EMPTY, so the agent's net was\n    computed from a zero split and an untouched cap",
    /const cdaAgentRecordId = /.test(cda) &&
    (cda.match(/\.eq\("agent_id", cdaAgentRecordId\)/g) ?? []).length === 3)
  // FLIPPED BY m366: both sides are agents-class now, so the comparison the
  // ORIGINAL code made (auth.agentId vs cda.agent_id) is finally the right one.
  ok("...the submit gate compares agents id to agents id, so the assigned agent\n    is the one who can submit",
    /auth\.agentId !== cda\.agent_id/.test(cda) && !/auth\.userId !== cda\.agent_id/.test(cda))
  // FLIPPED BY m366. cda.agent_id used to BE the users id, so notifications used
  // it directly. It is an agents id now, and notifications.user_id needs a users
  // id — so this is a RESOLVE, which is the rule this whole sweep exists to state.
  ok("...and the two agent notifications RESOLVE agents->users before writing\n    notifications.user_id, rather than substituting one id space for the other",
    (cda.match(/const notifyUserId = await resolveUserIdForAgentRecord\(/g) ?? []).length === 2 &&
    !/const notifyUserId = cda\.agent_id/.test(cda))
}

console.log("\n═══ 3e. The certificate was issued to \"Agent\" ═══")
{
  // m357. certification-engine's agentId is an AGENTS id — every other query in
  // the file filters agents-class tables with it, and progress.ts resolves to
  // one in all branches (m342). But the certificate's NAME was looked up in
  // `users` BY that id, matched nothing, and fell through to the literal
  // fallback string. The PDF an agent frames and shows a client said "Agent".
  const ce = code("lib/onboarding/certification-engine.ts")
  ok("the certificate name is read THROUGH the agents row, so the PDF carries the\n    agent's actual name instead of the 'Agent' fallback",
    /\.from\('agents'\)\.select\('users\(first_name, last_name\)'\)\.eq\('id', agentId\)/.test(ce))
  ok("...and NEITHER name lookup is still keyed by the agents id — there were two,\n    and the admin notification told the brokerage that \"Agent\" had finished",
    !/from\('users'\)[\s\S]{0,80}\.eq\('id', agentId\)/.test(ce) &&
    /\.from\('agents'\)\s*\.select\('users\(first_name, last_name\)'\)/.test(ce))
}

console.log("\n═══ 3f. Every write into a users-class agent_id, enumerated ═══")
{
  // m364. m356 fixed ONE of cda-portal's three CDA creation paths — the one the
  // guard pointed at. An exhaustive enumeration of every write into the twenty
  // users-class agent_id columns found the other two, plus three more elsewhere.
  // The lesson is the method: fixing the site a detector names is not the same
  // as fixing the class of write, and only the enumeration closes the gap.
  const cda = code("app/actions/cda-portal.ts")
  // FLIPPED BY m366. The enumeration is what mattered here, not which class was
  // correct: m356 fixed only the ONE path a detector named, and reading every
  // write found the other two. All three now carry an AGENTS id.
  ok("ALL THREE cda-portal creation paths write an AGENTS id — the enumeration is\n    the lesson: fixing the site a detector names is not fixing the class",
    !/agent_id: agent\.user_id,/.test(cda) && !/agent_id: auth\.userId,/.test(cda) &&
    !/cdaCreateUserId3/.test(cda) &&
    // The three creation paths, by the agents-class value each one has in hand:
    // the resolved agent record, and the assigned agent off the transaction.
    // `txn.agent_id` is now the RIGHT answer here — before m366 this clause
    // forbade it, because the column was users-class and that write was
    // FK-rejected.
    /agent_id: agent\.id,/.test(cda) &&
    (cda.match(/agent_id:\s+txn\.agent_id,/g) ?? []).length >= 2)

  const lm = code("app/actions/listing-media.ts")
  // FLIPPED BY m366: the column is agents-class now, so the AGENTS id this file
  // already resolved is finally the value it should be writing.
  ok("listing-media writes the resolved AGENTS id to ai_video_projects",
    /agent_id:            agentRecordId,/.test(lm) && !/agent_id:            user\.id,/.test(lm))

  const mk = code("lib/kernel/marketing.ts")
  // FLIPPED BY m366. Both tables are agents-class now, so ctx.userId is exactly
  // the wrong value — each write resolves through the identity component first.
  ok("kernel/marketing RESOLVES an agents id for the two video/podcast tables it\n    writes, instead of sending ctx.userId",
    /agent_id:\s+videoAgentId,/.test(mk) && /agent_id:\s*episodeAgentId,/.test(mk) &&
    !/agent_id:\s*ctx\.userId,/.test(mk))
  // WAS 3 (newsletter_campaigns, direct_mail_campaigns, qr_codes). The qr_codes
  // writer left this file when the QR minters were collapsed onto one: kernel
  // marketing's createQrAsset was merged into lib/marketing/tracked-qr.ts and
  // deleted. The CLAIM is unchanged — a table that genuinely FKs agents must be
  // written with an agents-class id — so it follows the writer instead of being
  // relaxed to a smaller count here.
  ok("...and KEEPS ctx.agentId for newsletter_campaigns and direct_mail_campaigns,\n    which genuinely FK agents — the same file, both classes, on purpose",
    (mk.match(/agent_id:\s*ctx\.agentId \?\? null,/g) ?? []).length === 2)
  ok("...and the qr_codes writer carries that class with it to the ONE surviving\n    minter, which takes an agents id and never a users id",
    /agent_id: args\.agentId \?\? null,/.test(code("lib/marketing/tracked-qr.ts")) &&
    !/agent_id:\s*(ctx|args)\.userId/.test(code("lib/marketing/tracked-qr.ts")))
}

console.log("\n═══ 3g. The MIRROR sweep — this guard's own documented blind spot ═══")
{
  // m365. m364 enumerated writes into users-class agent_id columns. Run the
  // same enumeration the other way — agents-class columns receiving a users-ish
  // value — and four more appear, NONE of which this guard can see: each is a
  // single-class use inside its function, so nothing contradicts itself. That
  // is the cross-call-boundary blind spot the header names, now measured
  // rather than merely acknowledged.
  const sb = code("app/actions/auth/signup-brokerage.ts")
  ok("the brokerage-signup audit entry writes NULL, not a users id — activities\n    .agent_id FKs agents and no agents row exists at signup, so the insert was\n    rejected inside a non-fatal try/catch and that audit line was never written",
    /agent_id:      null,/.test(sb))

  const ms = code("lib/kernel/manager-signals.ts")
  ok("the AI ISA intro postcard resolves users→agents — the campaign was\n    FK-rejected after the QR mint and AI copy draft had already run",
    /const dmAgentId = /.test(ms) && /agent_id: dmAgentId,/.test(ms))

  const asst = code("app/actions/assistant.ts")
  ok("smart_assistant_suggestions gets a resolved agents id — pass 14 fixed this\n    insert's COLUMN NAMES and left the users id in the renamed agents column,\n    so it still errored, just for a different reason",
    /agent_id: suggestionAgentId,/.test(asst) && /const suggestionAgentId = /.test(asst))

  const aw = code("lib/intelligence/appointment-whisper.ts")
  ok("the assistant voice lookup resolves first — voice_assistant_config.agent_id\n    is a NOT NULL agents FK, so every row holds an agents id and the users-id\n    filter matched nothing: the whisper fell back to text with the agent's\n    cloned voice sitting configured and unused",
    /const whisperAgentId = /.test(aw) && /\.eq\("agent_id", whisperAgentId\)/.test(aw))
}

console.log("\n═══ 3h. The tracking pixel recorded nothing ═══")
{
  // m366. The visitor-tracking admin page embedded the AUTH USER id in the
  // pixel snippet it tells an admin to paste onto their website. The snippet's
  // endpoint upserts website_visitors.agent_id, which FKs AGENTS — proven live:
  // the users id is foreign-key rejected, the resolved agents id is accepted.
  // So every pixel hit was dropped, and the page rendered an empty visitor list
  // that reads as "no traffic yet" rather than a broken pipe.
  //
  // NOTE ON THE FINDING: this guard flagged the file as "users.agent_id (write)"
  // — and users has no agent_id column at all. That flag was a detector
  // artifact (a local object literal near a .from("users") window). The real
  // defect was one hop downstream, in the endpoint the snippet calls. A false
  // flag pointed at a true bug, which is worth remembering before dismissing
  // one as noise.
  const vt = code("app/dashboard/admin/visitor-tracking/page.tsx")
  ok("the pixel snippet is scoped by the RESOLVED agents id, so website_visitors\n    upserts are no longer rejected on every hit",
    /const pixelAgentId = /.test(vt) && /agent_id: pixelAgentId,/.test(vt) &&
    !/agent_id: user\.id,/.test(vt))
  ok("...and the page REFUSES to hand out a snippet it knows cannot record,\n    instead of printing one that silently drops every visitor",
    /cannot be scoped to an agent/.test(src("app/dashboard/admin/visitor-tracking/page.tsx")))
}

console.log("\n═══ 3i. A nested JSONB key is not a column ═══")
{
  // m367. The classifier treated any `agent_id:` inside a .from() window as a
  // column write. Two remaining candidates were JSONB/local-object keys:
  // calendar_events has no agent_id column at all (only agent_user_id) and
  // `users` has none either. Excluding the blobs makes the ratchet mean what it
  // says. The risk of the exclusion is over-reach, so both directions are
  // proven here rather than assumed.
  const win = (src: string) => src.replace(
    /\b(?:metadata|payload|context|extracted_data|output_data|input_data|plan|config)\s*:\s*\{[^{}]*\}/g, "")
  const KEY = /\bagent_id\s*:\s*([A-Za-z_$][\w.$]*)/g
  const count = (src: string) => { KEY.lastIndex = 0; return (win(src).match(KEY) ?? []).length }

  ok("an agent_id inside a metadata blob is NOT counted as a column write",
    count('insert({ agent_user_id: a, metadata: { contact_id: c, agent_id: a } })') === 0)
  ok("...and a REAL top-level agent_id write in the same statement still IS",
    count('insert({ agent_id: a, metadata: { agent_id: a } })') === 1)
  ok("...and a row carrying both a real column and a blob counts exactly once",
    count('insert({ agent_id: x, notes: n, payload: { agent_id: y, k: 1 } })') === 1)
}

console.log("\n═══ 4. The catalogue this guard reasons from is honest ═══")
{
  // FLIPPED BY m366: the live schema now reports ZERO users-class agent_id
  // columns. Re-run the query in this file's header to confirm — it should
  // return no rows.
  ok("the users-class table list is EMPTY, which is what the live schema reports\n    now that all 20 have been re-pointed to agents(id)",
    USERS_CLASS_TABLES.size === 0, String(USERS_CLASS_TABLES.size))
  ok("...and this file carries the query to regenerate it, so it cannot quietly\n    drift away from the schema it describes",
    /information_schema\.table_constraints/.test(src("scripts/identity-class-guard.ts")))
}

console.log("\n═══ 5. The onboarding surface (m371) ═══")
{
  // Five of the sixteen candidates sat on the agent-onboarding surface. Two —
  // license.ts and progress.ts — were already correct: they resolve the id
  // between the two uses the guard's window sees, which is exactly why this
  // list is CANDIDATES and not defects. The other three were real, and all
  // five onboarding tables agree on the class: agent_licenses, agent_onboarding,
  // agent_step_completions, video_completion_tracking and agent_certifications
  // all FK agents(id). Proven live before and after; residue 0.

  // The roster links with agent_onboarding.agent_id — an AGENTS id.
  const roster = code("lib/onboarding/onboarding-roster.ts")
  ok("the onboarding roster still hands out the AGENTS id, which is what makes\n    the class of the admin route param knowable at all",
    /agentId: o\.agent_id/.test(roster))

  // (a) The admin detail page read `users` by that id, found nothing, and hit
  // notFound() — for every agent. The page was unreachable from the only
  // place that links to it.
  const admin = code("app/dashboard/onboarding/admin/agents/[id]/page.tsx")
  ok("the admin agent-detail page resolves agents→users before its two `users`\n    lookups — it 404'd on every agent in the roster",
    /resolveUserIdForAgentRecord\(supabase, agentId\)/.test(admin) &&
    !/\.from\('users'\)[\s\S]{0,120}\.eq\('id', agentId\)/.test(admin))
  ok("...and it still uses the AGENTS id for agent_step_completions, which was\n    always the correct class — only the users reads were wrong",
    /\.from\('agent_step_completions'\)[\s\S]{0,160}\.eq\('agent_id', agentId\)/.test(admin))

  // (b) The certification engine updated agents by user_id using an agents id,
  // so it matched no row: certification completed, status never moved.
  const cert = code("lib/onboarding/certification-engine.ts")
  ok("completing a certification updates agents by id, not by user_id — the\n    update matched zero rows, so onboarding_status never reached 'completed'",
    /\.from\('agents'\)[\s\S]{0,220}onboarding_status: 'completed'[\s\S]{0,160}\.eq\('id', agentId\)/.test(cert))

  // (c) The health cron read the agent's name from `users` by an agents id.
  const health = code("app/api/cron/onboarding-health/route.ts")
  ok("the stalled-agent nudge reads the name THROUGH agents — it read `users`\n    by an agents id, so every \"personalized\" nudge went out with a blank name",
    /\.from\('agents'\)[\s\S]{0,120}users\(first_name, last_name\)[\s\S]{0,120}\.eq\('id', onboarding\.agent_id\)/.test(health))
}

console.log("\n═══ 6. Both activities writers (m372) ═══")
{
  // activities.agent_id FKs agents(id). Two of the thirteen candidates wrote a
  // users id into it. Proven live before and after; residue 0.

  // (a) track-offer-lifecycle has FOUR activities inserts. Three already
  // resolved; the expiry path was missed — the m356 shape exactly, where
  // fixing the site a detector named left siblings broken. So every EXPIRED
  // offer lost its lifecycle event while submitted/withdrawn/response were fine.
  // WAVE 7 MOVED THE FOURTH WRITE, AND THIS ASSERTION HAD TO FOLLOW IT.
  //
  // It used to require exactly four `agent_id: await resolveAgentId(` literals
  // in this file. The expiry path no longer inserts here at all: it delegates to
  // lib/buyer-offer/expire-offers.ts:expireOffer, which is session-free so the
  // cron and the action share one writer. The resolve still happens in this file
  // — it is just handed over as `actorAgentId` instead of being spelled inline.
  //
  // Counting a spelling would have made a correct consolidation look like a
  // regression, which is the m346/m361/m362 mistake this very file keeps
  // re-learning. So assert the CONSTRUCT on both sides of the move: every
  // identity this file produces for an activities write is RESOLVED (four sites,
  // never a raw users id), and the write that moved still lands an agents-class
  // id in the agents-FK column.
  const tol = code("app/actions/buyer-offer/track-offer-lifecycle.ts")
  ok("every activities identity in track-offer-lifecycle is RESOLVED to an agents\n    id — four sites, none writing a users id raw",
    (tol.match(/await resolveAgentId\(/g) ?? []).length === 4 &&
    !/agent_id: systemUserId,/.test(tol) &&
    !/agent_id: gate\.userId/.test(tol))
  const exp = code("lib/buyer-offer/expire-offers.ts")
  ok("...and the expiry write that MOVED out of that file still puts an\n    agents-class id in activities.agent_id (resolved by the caller, never a users id)",
    /actorAgentId: string \| null/.test(exp) &&
    /agent_id: input\.actorAgentId,/.test(exp) &&
    /actorAgentId: await resolveAgentId\(/.test(tol))

  // (b) The superadmin audit line was FK-rejected and the catch discarded it,
  // so provisioning a subscriber never once produced an audit row. A superadmin
  // legitimately has no agents row, and the column is nullable — so null is the
  // honest value, with the actor kept in the notes payload.
  const cs = code("app/actions/admin/create-subscriber.ts")
  ok("the subscriber-provisioning audit line resolves the caller and no longer\n    writes a users id into an agents foreign key",
    /const callerAgentId = await resolveAgentId\(service as any, callerUser\.id\)/.test(cs) &&
    /agent_id: callerAgentId,/.test(cs) && !/agent_id: callerUser\.id,/.test(cs))
  ok("...and it still names its actor, via notes.actor_user_id, for the\n    superadmin case where the resolve correctly yields null",
    /actor_user_id: callerUser\.id,/.test(cs))
  ok("...and an audit insert that fails is now LOGGED rather than silently\n    swallowed — the discarded rejection is why nobody noticed",
    /if \(auditErr\) console\.error/.test(cs))
}

console.log("\n═══ 7. The two fields that looked like wiring are GONE (m373 found, m374 removed) ═══")
{
  // m373 recorded these as documented state: AGENT_REGISTRY.lib gave every agent
  // a module path nothing read, and it cost real time — it made an unwired action
  // look reachable mid-audit. m374 audited and removed it rather than describing
  // it, so this assertion had to INVERT. A guard that asserts the presence of an
  // anti-pattern freezes it; that is the m346/m361/m362 mistake, and this section
  // is where it nearly happened again.
  const reg = src("lib/intelligence/agent-registry.ts")
  ok("AGENT_REGISTRY declares no module path — a registry entry is not evidence\n    that an action is wired",
    !/\n\s*lib: '/.test(reg) && /THE ABSENT `lib` FIELD/.test(reg))

  // THE agent_user_id QUESTION — CORRECTED BY THE OWNER (m375).
  //
  // m373 called it a fourth identity name on the strength of four tables. m374
  // then counted 36 tables / 30 FKs / 671 uses and concluded it was a sanctioned
  // convention worth keeping. BOTH were wrong, and counting was the wrong test.
  //
  // The project deliberately moved AWAY from agent_user_id, and that decision is
  // why the resolver exists at all. lib/kernel/agent-identity.ts states it in its
  // first three lines:
  //
  //     NEVER do:  agentId = agentRow?.id ?? user.id
  //     ALWAYS do: agentId = await resolveAgentId(supabase, user.id)
  //
  // The sanctioned way to cross between a users id and an agents id is to RESOLVE,
  // not to mint a third column name that means "a bit of both". So the 36 tables
  // are a LEGACY TAIL from before that call — a migration backlog, not a pattern
  // to extend. Frequency is evidence of age, not of endorsement.
  //
  // Recorded here because m374 nearly acted on the inverted reading: its plan was
  // to rename agent_id -> agent_user_id on 20 more tables, which would have spread
  // a retired name rather than removed one.
  ok("the resolver still states the rule this convention question turns on",
    /ALWAYS do: agentId = await resolveAgentId/.test(src("lib/kernel/agent-identity.ts")))
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
console.log("Verified defects fixed and locked; 11 candidates remain behind a ratchet")
console.log("that may only go down. The resolver is the one place this should be decided.")
