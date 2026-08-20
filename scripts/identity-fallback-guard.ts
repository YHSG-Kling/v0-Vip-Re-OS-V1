/**
 * scripts/identity-fallback-guard.ts
 *
 * test:identity-fallback — DO NOT MANUFACTURE AN ID OF UNKNOWN CLASS.
 *
 * lib/kernel/agent-identity.ts opens with a rule stated in capitals:
 *
 *     NEVER do: agentId = agentRow?.id ?? user.id
 *
 * The codebase does it in more than twenty places. That single expression is
 * upstream of most of the identity-class defects the sibling guard tracks — not
 * because the fallback is itself a wrong value, but because it produces a value
 * whose CLASS depends on whether a row happened to exist. Everything downstream
 * then has to cope with "either an agents id or a users id", and coping looks
 * like `.or(id.eq.X,user_id.eq.X)` — a workaround that spreads the ambiguity
 * instead of ending it.
 *
 * WHY IT IS NEVER A SAFE DEFAULT. The two classes are not interchangeable and
 * never overlap: no agents row's id is also a users id (verified live — all 5 of
 * 5). So substituting one for the other does not degrade, it breaks, in one of
 * two silent ways:
 *   · READ  — the filter matches nothing, and the caller reports the empty
 *             result as a real answer ("0 reviews requested").
 *   · WRITE — the foreign key rejects the row, and a discarded error turns that
 *             into "saved!" with nothing saved.
 *
 * WHAT TO DO INSTEAD. Resolve, or refuse:
 *   · resolveAgentId / resolveAgentIdInBrokerage  — users → agents
 *   · resolveUserIdForAgentRecord                 — agents → users
 * and when it resolves to nothing, return null and let the caller say so. An
 * honest refusal is worth more than a plausible wrong id.
 *
 * THIS GUARD ONCE REPORTED ZERO. THE ZERO WAS FALSE — READ THIS BEFORE
 * TRUSTING ANY NUMBER IT PRINTS.
 *
 * m353 converted all 20 sites the detector could see and declared the class
 * closed as a build-failing invariant. It was wrong, and wrong in the most
 * expensive way a guard can be: the pattern has TWO SPELLINGS and the regex
 * only knew one.
 *
 *     agentId ?? user.id        ← matched (the object is named "user")
 *     agentId ?? ctx.userId     ← NOT matched (the PROPERTY is named userId)
 *
 * The second form is the more common one in this codebase, because that is the
 * shape AgentContext and requireAuth return. Twenty-one further sites were
 * sitting in plain view the whole time. The guard was not measuring the
 * codebase; it was measuring its own vocabulary, and a green run was read as
 * "the class is gone" when it meant "I found nothing I know how to look for".
 *
 * THE GENERAL LESSON, which cost nothing here and could cost a lot elsewhere:
 * a detector that has only ever been tested against examples IT was written
 * from will always pass. §3 now includes the spelling that was missed, and any
 * new spelling found in the wild belongs there before the baseline moves.
 *
 * So this is a RATCHET, not an invariant. Each remaining site needs a human to
 * read what consumes the value — the right answer differs per site, and m341
 * showed the fix sometimes belongs on one outlier caller rather than the shared
 * code. The number may only go DOWN.
 *
 * THE SHAPE THE LAST EIGHT SHARED IS WORTH REMEMBERING. Each one carried a
 * comment, written by someone who had correctly diagnosed the bug, saying in
 * effect "the raw user.id filter returned ZERO for every agent" — and then the
 * very next line put `?? user.id` back. The diagnosis and the defect were the
 * same expression. Writing the reason down is not the same as fixing it, and a
 * fallback is where a fix goes to be quietly undone.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { stripComments as canonicalStripComments } from "./strip-comments"

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

/**
 * Strip comments before matching. Every guard in this repo that skipped this
 * step ended up asserting against its own prose — including the sentence in
 * agent-identity.ts that spells the anti-pattern out in order to forbid it.
 */
function code(src: string): string {
  return canonicalStripComments(src)
}

/**
 * An agents-class expression falling back to a users-class one.
 *
 * LEFT  — something that reads as an agents ROW id: `agentRow?.id`, `agent?.id`,
 *         `agentRecord?.id`, `roleRow?.agent_id`, or a resolveAgentId(...) call.
 * RIGHT — a raw auth/user id: `user.id`, `authUser.id`, `userData?.id`.
 *
 * Deliberately NOT matched: `agentId ?? ""` / `?? null` (refusing is the fix),
 * and `x ?? someOtherAgentsId` (still one class).
 *
 * THE TRAILING `[\s)]*`. The first version of this pattern missed
 * `(await resolveAgentId(...)) ?? user.id` because the call is wrapped in its
 * own parens, and missed `roleRow?.agent_id` because it required the OBJECT
 * name to contain "agent" rather than the PROPERTY. §3 caught both — and the
 * consequence was not just two unproven cases: the guard was under-reporting
 * the real tree by a third, which would have made the baseline look better than
 * the codebase was.
 */
const FALLBACK_RE =
  /(?:\w*[Aa]gent\w*\s*\??\.\s*id|\w+\s*\??\.\s*agent_id|resolveAgent(?:Id|RecordId)\s*\([^;]*?\)|\w*[Aa]gentId)[\s)]*(?:\?\?|\|\|)\s*(?:await\s+)?(?:\w*(?:[Uu]ser|USER)\w*\s*\??\.\s*id\b|\w+\s*\??\.\s*(?:userId|user_id)\b)/g

interface Hit { file: string; line: number; text: string }

/**
 * SAME-CLASS FALLBACKS THAT ONLY LOOK WRONG.
 *
 * `(await resolveAgentRecordToUserId(targetAgentId)) ?? user.id` reads like the
 * anti-pattern — an "agentId" token, then `?? user.id` — but the value being
 * defaulted is a RESOLVED USERS id, so both sides are users-class and nothing
 * ambiguous is produced. Whether defaulting to the caller's own user id is the
 * right business answer is a separate question, and one m342 already settled.
 *
 * Excluded on purpose: a guard that flags correct code is worse than no guard,
 * because the first thing it teaches is that its output can be ignored.
 */
const RESOLVES_TO_A_USER_ID = /(?:ToUserId|resolveUserIdFor|UserIdFor)\w*\s*\(/

function findFallbacks(): Hit[] {
  const hits: Hit[] = []
  // m369: `hooks`, `services` and `contexts` were NOT scanned, so a site in
  // hooks/usePermissions.ts sat outside the count the whole time. This is the
  // second way this guard has reported a false zero — the first was a missing
  // spelling (m358), this one is missing COVERAGE. When it says zero, check
  // what it walks before believing it.
  for (const file of [
    ...walkDir("app"), ...walkDir("lib"), ...walkDir("components"),
    ...walkDir("hooks"), ...walkDir("services"), ...walkDir("contexts"),
  ]) {
    const lines = code(read(file)).split("\n")
    lines.forEach((raw, i) => {
      FALLBACK_RE.lastIndex = 0
      if (FALLBACK_RE.test(raw) && !RESOLVES_TO_A_USER_ID.test(raw)) {
        hits.push({ file, line: i + 1, text: raw.trim().slice(0, 110) })
      }
    })
  }
  return hits
}

// ── A RATCHET AGAIN, AT THE HONEST NUMBER. See the header for why the zero
// this briefly reported was false. Lower it as sites are audited; never raise.
//
// m369: the three app/lib sites are audited and fixed, and the roots widened
// to hooks/services/contexts — which immediately surfaced a fourth, in
// hooks/usePermissions.ts.
//
// m370: that hook is gone, along with the rest of the dead client-side
// permission stack it belonged to, so this is a real zero on real coverage —
// not the coverage artifact m369 caught. It is still a RATCHET and not an
// invariant: this guard has now reported a false zero twice, once for a
// missing spelling and once for missing roots. Zero means "nothing matches
// what we currently know to look for", which is not the same as "clean".
const BASELINE = 0

console.log("\n═══ 1. No NEW site manufactures an id of unknown class ═══")
const hits = findFallbacks()
{
  for (const h of hits) console.log(`     ${h.file}:${h.line}  ${h.text}`)
  ok(`\`agentsId ?? user.id\` fallbacks at or below the baseline of ${BASELINE} (found ${hits.length})`,
    hits.length <= BASELINE,
    `${hits.length} > ${BASELINE} — a new one was added; resolve or refuse instead`)
}

console.log("\n═══ 2. The rule this guard enforces is actually written down ═══")
{
  const idm = read("lib/kernel/agent-identity.ts")
  ok("lib/kernel/agent-identity states the rule verbatim, so the guard and the\n    documentation cannot drift apart",
    /NEVER do: agentId = agentRow\?\.id \?\? user\.id/.test(idm))
  ok("...and offers BOTH resolution directions, so 'resolve instead' is advice a\n    caller can actually follow (users→agents and agents→users)",
    /export async function resolveAgentId\b/.test(code(idm)) &&
    /export async function resolveUserIdForAgentRecord\b/.test(code(idm)))
}

console.log("\n═══ 3. The detector detects, and does not cry wolf ═══")
{
  // A guard nobody has watched fail proves nothing; one that fires on the safe
  // form trains everyone to ignore it. Both directions are checked here.
  const shouldCatch = [
    `const agentId = agentRow?.id ?? user.id`,
    `setCurrentAgentId(agentRow?.id ?? authUser.id)`,
    `const agentId = (await resolveAgentId(supabase, user.id)) ?? user.id`,
    `const agentId = roleRow?.agent_id ?? user.id`,
    `agentId: agentId ?? user.id,`,
    `const x = agent?.id || user.id`,
    // THE SPELLING THAT WAS MISSED (m358). The property, not the object, is
    // what says "user" — and this is the form AgentContext/requireAuth produce,
    // so it is the COMMONER of the two in this codebase.
    `const agentId = ctx.agentId ?? ctx.userId`,
    `const agentId = auth.agentId ?? auth.userId`,
    `agentId: contact.agent_id ?? session.user_id,`,
  ]
  const shouldNotCatch = [
    `setCurrentAgentId(agentRow?.id ?? "")`,              // refusing — the fix
    `const agentId = agentRow?.id ?? null`,               // refusing — the fix
    `const userId = agentRow?.user_id ?? user.id`,        // both sides users-class
    `const brokerageId = userRow?.brokerage_id ?? ""`,    // unrelated column
    `const agentId = ctx.agentId ?? fallbackAgentRecordId`, // both sides agents-class
    `: (await resolveAgentRecordToUserId(targetAgentId)) ?? user.id`, // resolved USERS id
    `const aid = row.agent_id ?? agent?.id ?? "unknown"`,  // both sides agents-class
    `if (!callerAgent?.id || callerAgent.id !== agentId) {`, // a comparison, not a fallback
  ]
  const hit = (s: string) => {
    FALLBACK_RE.lastIndex = 0
    return FALLBACK_RE.test(s) && !RESOLVES_TO_A_USER_ID.test(s)
  }
  const missed = shouldCatch.filter((s) => !hit(s))
  const wrong  = shouldNotCatch.filter((s) => hit(s))
  ok(`every known form of the anti-pattern is caught (${shouldCatch.length}/${shouldCatch.length})`,
    missed.length === 0, missed.join(" | "))
  ok(`and the SAFE forms — refusing with "" or null, and same-class fallbacks —\n    are not flagged (${shouldNotCatch.length}/${shouldNotCatch.length})`,
    wrong.length === 0, wrong.join(" | "))
}

console.log("\n═══ 4. The sites fixed in this pass stay fixed ═══")
{
  const ltc = code(read("app/lifetime-customers/page.tsx"))
  ok("lifetime-customers no longer substitutes the auth user id for the agents id —\n    it fed six agents-class consumers, none of which tolerate a users id",
    /setCurrentAgentId\(agentRow\?\.id \?\? ""\)/.test(ltc) &&
    !/setCurrentAgentId\(agentRow\?\.id \?\? authUser\.id\)/.test(ltc))
  ok("...while still passing the USERS id to the NPV ledger, which is users-class —\n    the page keeps both ids rather than collapsing them",
    /getAgentLifetimeNpvRanked\(\{\s*agentId:\s*authUser\.id/.test(ltc))

  const rev = code(read("app/actions/ai-review-automation.ts"))
  // INVERTED BY m366. review_requests.agent_id used to FK users(id), so writing
  // the agents id was rejected 100% of the time and the fix was to resolve
  // agents->users. That column now FKs agents(id) — verified live — so the
  // declared agents id goes in directly and the resolve here would REINTRODUCE
  // the rejection it was added to cure.
  ok("review automation writes the declared agents id to review_requests, which\n    is what that column means since m366",
    /agent_id:\s*params\.agentId,/.test(rev) && !/agent_id:\s*agentUserId/.test(rev))
  ok("...and its brokerage lookup no longer tries BOTH id columns — the `.or()`\n    workaround existed only because the caller's class was unknown",
    !/user_id\.eq\./.test(rev) && /\.eq\("id", agentRecordId\)/.test(rev))
  ok("...and the review_requests insert error is SURFACED, not discarded — the\n    discarded error is why an FK rejection read as \"review request drafted\"",
    /const \{ data: rrInsert, error: rrError \}/.test(rev) &&
    /if \(rrError \|\| !rrInsert\?\.id\)/.test(rev))
  ok("...and lifecycle_events.actor_user_id (a users FK) gets the resolved id",
    /actor_user_id: agentUserId/.test(rev))

  const stage = code(read("lib/transactions/stage-progression.ts"))
  ok("stage-progression passes the AGENTS id to aiGenerateReviewRequest — it\n    passed params.userId, so the action threw and the post-close review draft\n    was never generated for any closing",
    /aiGenerateReviewRequest\(\{[^}]*agentId: agentRecordId/.test(stage) &&
    !/aiGenerateReviewRequest\(\{[^}]*agentId: params\.userId/.test(stage))

  const mail = code(read("app/actions/ai-marketing-automation.ts"))
  // ASSERT THE CONSTRUCT, NOT THE SPELLING. This used to require the select
  // list to be EXACTLY `"users(first_name, last_name, phone, email)"`, so when
  // the W33 tenant fix widened it to
  // `"brokerage_id, users(first_name, last_name, phone, email)"` — carrying the
  // brokerage onto the direct_mail_campaigns insert, which is strictly better
  // code — this went red on an improvement. Same failure mode as the
  // onboarding-steps simulator in wave 30.
  //
  // What actually matters is unchanged and is what is checked now: the identity
  // fields are reached THROUGH the agents row via an embedded `users(...)`,
  // keyed on the AGENTS id, rather than by querying `users` with an agents id
  // (which matched nothing and rendered "AGENT: undefined undefined" onto every
  // piece). Extra columns on that select are free.
  ok("generateAIDirectMail reads the agent's name/phone/email THROUGH the agents\n    row — it read `users` by the agents id, matched nothing, and every piece\n    was generated from a prompt that said \"AGENT: undefined undefined\"",
    /\.from\("agents"\)\s*\.select\("[^"]*users\(first_name, last_name, phone, email\)"\)\s*\.eq\("id", params\.agentId\)/.test(mail))
  ok("...while direct_mail_campaigns.agent_id keeps the agents id, which is the\n    class that column's foreign key actually points at",
    /\.from\("direct_mail_campaigns"\)[\s\S]{0,120}agent_id: params\.agentId/.test(mail))

  const cr = code(read("app/dashboard/documents/contract-review/page.tsx"))
  ok("the contract-review page hands down an agents id or nothing, never the\n    auth user id wearing an agents id's name",
    /agentId=\{agentRow\?\.id \?\? ""\}/.test(cr))

  // ── The five dashboard pages (m348) ──────────────────────────────────────
  // Each filtered an agents-class table by the auth user id, so each rendered a
  // convincingly empty page: no transactions, no listings, no calls, a full set
  // of zeroed reports. Nothing errored, which is exactly why nobody found them.
  for (const [file, table] of [
    ["app/dashboard/transactions/page.tsx", "transactions"],
    ["app/dashboard/listings/page.tsx", "listings"],
    ["app/dashboard/voice-intelligence/page.tsx", "voice_calls"],
    ["app/dashboard/acquisition/page.tsx", "business_card_scans / qr_codes"],
    ["app/dashboard/reports/page.tsx", "every prefetched report"],
  ] as const) {
    const s = code(read(file))
    ok(`${file.replace("app/dashboard/", "")}\n    no longer substitutes the user id for the agents id ${table} is keyed on`,
      !/\?\?\s*user\??\.id/.test(s))
  }
  // Three of them REFUSE rather than render an empty page as if it were real.
  // acquisition deliberately does not: a broker with no agents row is a normal
  // user of that page, served by its brokerage branch.
  for (const file of [
    "app/dashboard/transactions/page.tsx",
    "app/dashboard/listings/page.tsx",
    "app/dashboard/voice-intelligence/page.tsx",
  ]) {
    ok(`${file.replace("app/dashboard/", "")} says "finishing your account setup"\n    instead of showing an empty page as a real answer`,
      /Finishing your account setup/.test(code(read(file))))
  }

  // ── The "middle" layer (m349) ────────────────────────────────────────────
  // The clearest statement of the whole defect class: app/crm/page.tsx resolves
  // its agent id under a comment that says, in capitals, "contacts.agent_id =
  // agents.id (FK) — NEVER users.id" — and then broke that rule at three call
  // sites 600 lines below. The UI knew. The schema knew. The middle guessed.
  const crm = code(read("app/crm/page.tsx"))
  ok("crm no longer passes a users id to the three actions whose every write —\n    call_analyses, tasks.assigned_to_agent_id, activities, contacts — FKs agents",
    !/agentId \?\? user\.id/.test(crm))
  ok("...and the rule it violated is still written at its resolution site, so the\n    guard is anchored to the file's own stated invariant",
    /contacts\.agent_id = agents\.id \(FK\) — NEVER users\.id/.test(read("app/crm/page.tsx")))

  const rk = code(read("app/actions/reporting-kernel.ts"))
  ok("the reporting ctx every report action reads through no longer substitutes —\n    it produced a complete, internally consistent set of zeros: a quiet month",
    /agentId:\s*agent\?\.id \?\? "",/.test(rk))

  const vm = code(read("app/actions/vendor-marketplace.ts"))
  ok("vendor assignment uses NULL for an absent agent, which is what the nullable\n    assigned_by_agent_id column was designed for — the users id was FK-rejected,\n    so the assignment threw for exactly the user the fallback meant to help",
    /const agentRowId = agent\?\.id \?\? null/.test(vm))
  ok("...and the lifecycle_events metadata reports the SAME id as the row it\n    describes, rather than disagreeing with it",
    /assigned_by_agent_id: agentRowId,/.test(vm))

  const goals = code(read("app/actions/ai-agent-goals.ts"))
  // INVERTED BY m366, same reason: the count is keyed on the agents id now,
  // which is what review_requests.agent_id holds. Counting by the users id
  // would return the 0 this assertion was originally written to prevent.
  ok("the goals sync counts review_requests by the agents id that column now\n    holds, so the number it writes is the agent's real progress",
    /\.from\("review_requests"\)[\s\S]{0,160}\.eq\("agent_id",\s+params\.agentId\)/.test(goals))
  ok("...and the count is still tenant-scoped, so it cannot borrow another\n    brokerage's review requests",
    /\.from\("review_requests"\)[\s\S]{0,240}\.eq\("brokerage_id", params\.brokerageId\)/.test(goals))
}

console.log("\n═══ 5. The last eight — where the fix and the bug were one line apart ═══")
{
  // Every one of these sat directly under a comment diagnosing the exact defect
  // the fallback then reinstated.
  const cases: Array<[string, string, RegExp]> = [
    ["dashboard/analytics", "a page of confident zeros", /const agentId = await resolveAgentId\(supabase as any, user\.id\)/],
    ["dashboard/financials/expenses", "an empty expense ledger", /const expenseAgentId = await resolveAgentId\(supabase as any, user\.id\)/],
    ["api/onboarding/performance-report", "a performance report of zeros", /const agentId = await resolveAgentId\(supabase as any, user\.id\)/],
    ["api/internal/voice-command", "a spoken \"you have nothing today\"", /const voiceAgentId = await resolveAgentId\(service as any, user\.id\)/],
  ]
  const paths: Record<string, string> = {
    "dashboard/analytics": "app/dashboard/analytics/page.tsx",
    "dashboard/financials/expenses": "app/dashboard/financials/expenses/page.tsx",
    "api/onboarding/performance-report": "app/api/onboarding/performance-report/route.ts",
    "api/internal/voice-command": "app/api/internal/voice-command/route.ts",
  }
  for (const [name, cost, re] of cases) {
    const c = code(read(paths[name]))
    ok(`${name} resolves without substituting — the fallback bought ${cost}`,
      re.test(c) && !/\?\?\s*user\.id/.test(c))
  }

  const ai = code(read("app/api/internal/ai-chat/route.ts"))
  ok("the ai-chat schedule tool refuses instead of reading with a users id, and\n    the listing stage advance — a real business event — no longer accepts an id\n    that could never match an agents row",
    !/\?\?\s*user\.id/.test(ai) && /if \(!listing\.agent_id\)/.test(ai) && /if \(!toolAgentId\)/.test(ai))

  const oh = code(read("app/dashboard/listings/[id]/open-house/page.tsx"))
  ok("the open-house page uses listings.agent_id directly — it IS the agents id,\n    and the page was looking the agents row up BY user_id with it, so the record\n    was always null and the old `?? user?.id` silently supplied a users id",
    /const listingAgentId = \(data\.listing\.agent_id as string \| null\) \?\? ""/.test(oh) &&
    !/\.eq\("user_id", data\.listing\.agent_id\)/.test(oh))

  const onb = code(read("app/dashboard/onboarding/page.tsx"))
  ok("onboarding passes the agents id or refuses — the old fallback fired ONLY\n    for the non-agent roles that have no agent curriculum, so it substituted a\n    users id precisely when there was nothing to show",
    /agentId,\n/.test(onb) && !/agentId: agentId \?\? user\.id/.test(onb) &&
    /does not have an agent curriculum/.test(onb))
}

console.log("\n═══ 6. The site that exposed the false zero ═══")
{
  // m358. app/api/voice/initiate-call is where the missed spelling was found —
  // `auth.agentId ?? auth.userId`. The route then used that one value as BOTH
  // an agents id (the voice_calls.agent_id write) and a users id (an
  // agents.user_id lookup), so the lookup matched nothing and buildCallContext
  // received a null agent: every outbound AI call spoke with the brokerage or
  // team identity profile instead of the agent's own.
  const ic = code(read("app/api/voice/initiate-call/route.ts"))
  ok("initiate-call takes auth.agentId with no fallback and REFUSES without it —\n    an outbound AI call is agent-scoped, so a users id there is wrong, not\n    degraded",
    /const agentId = auth\.agentId\b/.test(ic) && !/auth\.agentId \?\? auth\.userId/.test(ic) &&
    /an outbound AI call is agent-scoped/.test(read("app/api/voice/initiate-call/route.ts")))
  ok("...and the redundant agents.user_id lookup is gone — auth.agentId already IS\n    the agents id, so that query asked the wrong column with the right value",
    !/\.eq\("user_id", agentId\)/.test(ic) && /agentId: agentId,|agentId,\n/.test(ic))
}

console.log("\n═══ 7. The cluster m358 made visible ═══")
{
  // The `ctx.agentId ?? ctx.userId` spelling. ai-listing-intake had four, and
  // every consumer downstream is agents-class: ai_usage_log, brand_voice_profile,
  // guardContent, the dotloop loop, aiGenerateListingDescription. The
  // substitution fired only when the caller had no agents row — exactly when
  // those queries had nothing to match anyway — so it bought a wrong-class id
  // in place of an honest refusal.
  const li = code(read("app/actions/ai-listing-intake.ts"))
  ok("ai-listing-intake no longer substitutes ctx.userId at any of its four sites",
    !/\?\?\s*(?:ctx|agentCtx)\.userId/.test(li))
  // FOUR became TWO, and not by weakening the rule. `createListing` and
  // `runCompleteListingIntake` in this file were DELETED as duplicates (their
  // survivor is app/actions/listings-kernel.ts createListingWithSellerContact),
  // and each carried one of the four refusal sites. The remaining two are
  // asserted here; the survivor is asserted below, so no site went unwatched.
  ok("...and each of the remaining two refuses instead, so a user without an agents\n    row is told to finish setup rather than handed a silently empty listing intake",
    (li.match(/No agent profile for this user yet — finish account setup\./g) ?? []).length === 2)
  // THE SURVIVOR MUST REFUSE TOO — otherwise the merge would have moved the
  // defect instead of the capability. resolveCallerContext returns agentId
  // NULLABLE (broker/admin with no agents row), and lib/kernel/listings.ts
  // createListingRecord is the insert it feeds.
  ok("...and the survivor refuses a null agents id rather than inserting one —\n    createListingRecord validates input.agentId as a uuid before the insert",
    /if \(!isValidUUID\(input\.agentId\)\)\s*return \{ success: false, error: "Invalid agent ID" \}/.test(
      code(read("lib/kernel/listings.ts")),
    ))
}

console.log("\n═══ 8. The compliance + approval log kept the wrong rows ═══")
{
  // m360. content-compliance and content-approval-workflow each had ONE auth
  // helper that manufactured agentId for every write in the file — four each,
  // all attributing to agents-class columns. The substitution meant the record
  // of what the OS decided and why silently lost exactly the rows belonging to
  // users who had not finished setup. Fixing the helper fixed eight writes.
  for (const f of ["app/actions/content-compliance.ts", "app/actions/content-approval-workflow.ts"]) {
    const c = code(read(f))
    ok(`${f.replace("app/actions/", "")} refuses at the ONE place agentId is\n    manufactured, rather than patching each of its four writes`,
      !/ctx\.agentId \?\? ctx\.userId/.test(c) && /if \(!ctx\.agentId\)/.test(c) && /agentId: ctx\.agentId,/.test(c))
  }
  const hub = code(read("app/actions/ai-communication-hub.ts"))
  ok("ai-communication-hub takes auth.agentId — brand_voice_profile and messages\n    are both agents-class, so the substitution read an empty voice profile and\n    an empty message history and presented both as the agent's real state",
    !/auth\.agentId \?\? auth\.userId/.test(hub))
  for (const f of ["app/actions/ai-offer-creation.ts", "app/actions/ai-contract-review.ts"]) {
    ok(`${f.replace("app/actions/", "")} no longer substitutes ctx.userId`,
      !/ctx\.agentId \?\? ctx\.userId/.test(code(read(f))))
  }
}

console.log("\n═══ 9. Five more, including two that wrote the rule then broke it ═══")
{
  const pairs: Array<[string, string]> = [
    ["app/actions/seller-open-house.ts", "open_house_events.agent_id FKs agents, so the open house was never created"],
    ["app/actions/buyer-financial.ts", "referral_partners.agent_id FKs agents — the comment above it says so"],
    ["app/actions/business-card/business-card-actions.ts", "business_card_scans.agent_id FKs agents"],
    ["app/api/onboarding/assistant/route.ts", "every agent_id and entity_id below is agents-class"],
  ]
  for (const [f, why] of pairs) {
    ok(`${f.replace(/^app\//, "")} — ${why}`,
      !/\?\?\s*(?:auth|ctx)\.userId/.test(code(read(f))))
  }
  const dc = code(read("app/actions/document-center.ts"))
  ok("document-center's governed-document request carries an id whose CLASS\n    matches the `type: \"agent\"` label it travels under",
    /id: ctx\.agentId \?\? null,/.test(dc))
  // The two that stated the rule and broke it in the same breath.
  ok("buyer-financial's comment no longer diagnoses the bug it then reinstates",
    /m361 removes the\n  \/\/ fallback/.test(read("app/actions/buyer-financial.ts")))
  ok("...and onboarding/assistant no longer says \"we need the agents.id; fall\n    back to users.id\" — a requirement and its violation in one sentence",
    !/fall back to users\.id if no agent row/.test(read("app/api/onboarding/assistant/route.ts")))
}

console.log("\n═══ 10. The INVERTED resolve — where the fallback was the correct value ═══")
{
  // m363. lib/wizard-staging/content-staging resolved users→AGENTS and passed
  // that to two consumers whose column is one of the twenty that FK USERS.
  //   · stageVideoProject → createVideoProject → ai_video_projects.agent_id.
  //     It had `?? ctx.userId`, so the CORRECT value was reachable only through
  //     the fallback: the feature worked ONLY for users with no agents row and
  //     was FK-rejected for everyone else. Exactly backwards.
  //   · stagePodcastEpisode → podcast_episodes.agent_id, with no fallback at
  //     all, so that insert was simply rejected every time.
  // The resolve is deleted in both, not reordered — nothing there needed it.
  const cs = code(read("lib/wizard-staging/content-staging.ts"))
  ok("stageVideoProject passes ctx.userId to createVideoProject, whose column and\n    actor context are both users-class",
    /agentId: ctx\.userId,/.test(cs) && !/agentId: agentId \?\? ctx\.userId/.test(cs))
  // INVERTED BY m366. podcast_episodes.agent_id used to FK users(id), so
  // ctx.userId was the value that fit. It FKs agents(id) now, so the staging
  // path RESOLVES users->agents first — the resolve this guard once said was
  // unnecessary is exactly what the column requires today.
  ok("...while the podcast_episodes insert RESOLVES an agents id, because that\n    column FKs agents(id) since m366",
    /\.from\("podcast_episodes"\)[\s\S]{0,160}agent_id: episodeAgentId,/.test(cs) &&
    !/\.from\("podcast_episodes"\)[\s\S]{0,160}agent_id: ctx\.userId,/.test(cs))
  ok("...while the email campaign KEEPS its agents-id resolve, because\n    email_campaigns.agent_id genuinely FKs agents — this was not a blanket sweep",
    /agentId: agentId \?\? undefined,/.test(cs) && /const agentId = await resolveAgentRowId\(svc, ctx\.userId\)/.test(cs))
}

console.log("\n═══ 11. The decorative fields are GONE, not merely tolerated ═══")
{
  // m368 fixed the e-sign call site while noting CreateTransactionRequest.agentId
  // was decorative. m374 audited it properly and removed it.
  //
  // Seven callers computed a value for that field. FOUR passed a users id
  // (input.targetUserId, user.id, userId, args.signerUserId) and THREE passed an
  // agents id (contact.agent_id, bba.agent_id, session.agent_id). Two classes in
  // one required field, and nobody was wrong, because none of the six providers
  // ever read it — each scopes the transaction by the account in its own
  // credentials. The day someone wired it, half the callers would have broken.
  // Four of those seven were invisible to grep and only surfaced when the
  // compiler was allowed to find them: the strongest argument for deleting a
  // field rather than documenting it.
  const iface = read("lib/integrations/providers/transaction-provider.interface.ts")
  ok("CreateTransactionRequest no longer declares an agentId nobody reads",
    !/^\s*agentId: string/m.test(code(iface)) && /THE ABSENT agentId/.test(iface))
  // SCOPED TO THE createTransaction CALL WINDOW ON PURPOSE. The first version of
  // this assertion banned `agentId:` anywhere in these files and immediately
  // failed on requireActiveBBA({ agentId: contact.agent_id }) — a DIFFERENT
  // function that correctly takes an agents id. An assertion that forbids a
  // token rather than a construct is the m343/m364 mistake; it would have
  // pressured a correct call site into changing.
  ok("...and no createTransaction call still computes one for it",
    ["lib/workflow/adapters/send-for-esign.ts", "app/actions/buyer-broker-agreements.ts",
     "app/api/agent-assistant/tool-call/route.ts", "app/actions/admin/commission-agreement.ts",
     "app/actions/buyer-offer/acknowledge-commission.ts", "app/actions/buyer-offer/submit-for-signature.ts",
     "lib/transactions/cda-esign.ts"]
      .every((f) => {
        const src2 = code(read(f))
        return [...src2.matchAll(/createTransaction\s*\(\s*\{/g)]
          .every((m) => !/\bagentId\s*:/.test(src2.slice(m.index ?? 0, (m.index ?? 0) + 600)))
      }))
  ok("...and all six providers still ignore an agent id, which is why the field\n    had no meaning to carry in the first place",
    ["dotloop", "skyslope", "formsimplicity", "brokermint", "docusign", "authentisign"]
      .every((n) => !/request\.agentId/.test(code(read(`lib/integrations/providers/${n}-provider.ts`)))))

  // AGENT_REGISTRY.lib — the other field that read as wiring and was not.
  const reg = read("lib/intelligence/agent-registry.ts")
  ok("AGENT_REGISTRY no longer declares a module path per agent — it made an\n    unwired action look reachable during the m373 audit",
    !/\n\s*lib: '/.test(reg) && /THE ABSENT `lib` FIELD/.test(reg))
}

console.log("\n═══ 12. The last three sites — and the surface behind one of them ═══")
{
  // m369. All four live constraints were proven against the real database
  // before and after each fix (qr_codes/notifications FK-reject the wrong
  // class; brand_voice_profile and the signature waterfall silently return 0
  // rows for it), then the test data was removed — residue 0.

  // (a) The email signature waterfall. assembleEmail looks up `users` by this
  // id for tiers 1 (agent) and 2 (team). It was handed an AGENTS id first, so
  // both tiers were skipped and every such send silently used the BROKERAGE
  // signature — the fallback-to-brokerage the owner ruled out. The third
  // branch passed a BROKERAGES id as a users id.
  const d = code(read("lib/providers/dispatch.ts"))
  ok("dispatch resolves agents→users for the signature waterfall instead of\n    passing an agents id, a brokerage id, and then an empty string",
    /const signatureUserId =\s*\n\s*params\.userId \?\?/.test(d) &&
    /resolveUserIdForAgentRecord\(createServiceClient\(\), params\.agentId\)/.test(d) &&
    /userId:\s+signatureUserId \?\? "",/.test(d))
  ok("...and no branch of it can reach for a brokerage id — assembleEmail\n    already reaches the brokerage tier from its own brokerageId argument",
    !/userId:\s+params\.\w+ \?\? params\.\w+ \?\? params\.brokerageId/.test(d))

  // (b) The inverse direction, same file: params.agentId is ALREADY an agents
  // id. Feeding it to a users→agents resolver matched nothing and returned
  // "Voice clone not set up" for an agent whose clone existed.
  ok("the video path treats params.agentId as the agents id it is, and resolves\n    ONLY params.userId",
    /let agentRecordId: string \| null = params\.agentId \?\? null/.test(d) &&
    /resolveUserIdToAgentRecord\(params\.userId, params\.brokerageId\)/.test(d))

  // (c) referral_partners carries BOTH columns, in DIFFERENT classes:
  // agent_id FKs agents(id), user_id FKs auth.users(id). The destination,
  // notifications.user_id, FKs public.users — whose id is set to the auth uid
  // on insert. So user_id is the usable one and the order was backwards.
  const r = code(read("lib/referrals/referral-reciprocity-runner.ts"))
  ok("the reciprocity nudge prefers referral_partners.user_id and resolves\n    agent_id through agents when it is absent — the order was reversed, so the\n    insert was rejected on exactly the partners that HAVE an assigned agent",
    /notifyUserId: string \| null = \(p\.user_id as string \| null\) \?\? null/.test(r) &&
    /resolveUserIdForAgentRecord\(svc as any, p\.agent_id as string\)/.test(r))
  ok("...and the insert error is SURFACED, not swallowed by `.then(() => {}, () => {})`",
    !/\}\)\.then\(\(\) => \{\}, \(\) => \{\}\)/.test(r) && /if \(nudgeErr\) console\.error/.test(r))
  ok("...and `escalated` reflects whether the nudge actually landed, not merely\n    whether an id existed to address it to",
    /escalated = sig\.ok \|\| nudged/.test(r) && !/escalated = sig\.ok \|\| !!args\./.test(r))

  // (d) The flagged QR line was one symptom. The state it read was seeded from
  // the users id at BOTH seed points, and seven agents-class consumers read it.
  const p2 = code(read("app/dashboard/marketing/studio/page.tsx"))
  const c2 = code(read("app/dashboard/marketing/studio/marketing-studio-client.tsx"))
  ok("the studio PAGE resolves the agents id — it never passed one at all, which\n    is why the client had nothing better than the users id to seed from",
    /\.from\("agents"\)/.test(p2) && /agentId=\{agentRow\?\.id \?\? ""\}/.test(p2))
  ok("...and the client seeds `agentId` from that prop, not from userIdProp",
    /useState<string>\(agentIdProp \?\? ""\)/.test(c2) &&
    !/const \[agentId, setAgentId\] = useState<string>\(userIdProp/.test(c2))
  ok("...and loadAdOsData no longer overwrites it with a users id on every load",
    !/setAgentId\(resolvedUserId\)/.test(c2))
  ok("...and email_campaigns.created_by (a users FK) gets the users id, not the\n    same value as agentId",
    /createdBy: userIdProp \?\? "",/.test(c2))

  // (e) Following the flag one hop further: the repurpose scheduler passed an
  // empty socialAccountId, which scheduleSocialPost rejects before anything
  // else — so that button returned "Invalid social account ID" on every click.
  const a2 = code(read("app/dashboard/marketing/studio/components/ad-os/ad-os-actions.ts"))
  ok("scheduleRepurposedPost resolves a CONNECTED account for the target platform\n    instead of sending socialAccountId: \"\"",
    !/socialAccountId: "",/.test(a2) && /\.from\("social_media_accounts"\)/.test(a2) &&
    /socialAccountId: account\.id,/.test(a2))
  ok("...and it omits agentId so the action uses auth.agentId — it used to pass\n    userCtx.userId, which failed verifyAgentInBrokerage and returned \"Forbidden\"",
    !/agentId: userCtx\.userId,/.test(a2))
}

console.log("\n═══ 13. The dead permission stack that hid the last site ═══")
{
  // m370. The site m369 surfaced was `agentId: user?.agentId || user?.id` in
  // hooks/usePermissions.ts — a hook with ZERO importers. Investigating it
  // found a whole parallel client-side permission stack, closed over itself:
  //
  //   hooks/usePermissions.ts      -> services/permissionsService (a shim)
  //   hooks/useDataAccess.ts       -> services/dataAccessService (458 real lines)
  //   lib/hooks/usePermissions.ts  -> lib/security RoleManager  (a DIFFERENT engine)
  //   lib/hooks/useCanAccess.ts    -> lib/security RoleManager
  //   lib/hooks/index.ts           -> re-exported the two lib/hooks ones
  //
  // Two hooks exporting the SAME NAME over two different permission engines,
  // and a client-side data-access service that filtered rows by role. Nothing
  // imported any of it. Kept, it was a standing invitation to import the wrong
  // `usePermissions` — and worse, to enforce access in a hook when this OS
  // enforces it in RLS and the server guards under lib/auth. Removed.
  const gone = [
    "hooks/usePermissions.ts", "hooks/useDataAccess.ts",
    "services/permissionsService.ts", "services/dataAccessService.ts",
    "lib/hooks/usePermissions.ts", "lib/hooks/useCanAccess.ts", "lib/hooks/index.ts",
  ]
  ok("the parallel client-side permission stack is gone — all seven files",
    gone.every((f) => !existsSync(f)))

  // The survivor is canonical and says so.
  const sec = read("lib/security/permissions-service.ts")
  ok("lib/security/permissions-service is the only permissionsService, and its\n    header no longer claims consumers that no longer exist",
    /This is the ONLY permissionsService/.test(sec) &&
    !/used by Sidebar, hooks, and\n \* dataAccessService/.test(sec))
}

console.log(`\n${"═".repeat(70)}`)
console.log(`IDENTITY FALLBACK — ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log("\nFailures:")
  for (const f of failures) console.log(`  · ${f}`)
  console.log("\n`agentRow?.id ?? user.id` produces a value whose CLASS depends on whether a")
  console.log("row existed. Resolve it, or return null and say so. Never substitute.")
  process.exit(1)
}
console.log(`${hits.length} sites manufacture an id of unknown class (baseline ${BASELINE}).`)
console.log("A ratchet, not an invariant: this guard has reported a false zero twice —")
console.log("once for a missing spelling (m358), once for missing roots (m369). Zero means")
console.log("nothing matches what we currently know to look for. That is not 'clean'.")
