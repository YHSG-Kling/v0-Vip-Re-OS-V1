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
 * THIS IS A RATCHET, NOT A ZERO. The remaining sites each need a human to read
 * what consumes the value before the fallback can be removed — the answer
 * differs per site, and m341 already showed that the fix sometimes belongs on
 * one outlier caller rather than in the shared code. The number may only go
 * DOWN. Adding a new one fails the build.
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

/**
 * Strip comments before matching. Every guard in this repo that skipped this
 * step ended up asserting against its own prose — including the sentence in
 * agent-identity.ts that spells the anti-pattern out in order to forbid it.
 */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
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
  /(?:\w*[Aa]gent\w*\s*\??\.\s*id|\w+\s*\??\.\s*agent_id|resolveAgent(?:Id|RecordId)\s*\([^;]*?\)|\w*[Aa]gentId)[\s)]*(?:\?\?|\|\|)\s*(?:await\s+)?\w*(?:[Uu]ser|USER)\w*\s*\??\.\s*id/g

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
  for (const file of [...walkDir("app"), ...walkDir("lib"), ...walkDir("components")]) {
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

// ── The ratchet. Lower it as sites are audited; never raise it. ──────────────
const BASELINE = 14

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
  ]
  const shouldNotCatch = [
    `setCurrentAgentId(agentRow?.id ?? "")`,              // refusing — the fix
    `const agentId = agentRow?.id ?? null`,               // refusing — the fix
    `const userId = agentRow?.user_id ?? user.id`,        // both sides users-class
    `const brokerageId = userRow?.brokerage_id ?? ""`,    // unrelated column
    `const agentId = ctx.agentId ?? fallbackAgentRecordId`, // both sides agents-class
    `: (await resolveAgentRecordToUserId(targetAgentId)) ?? user.id`, // resolved USERS id
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
  ok("review automation resolves agents→users for review_requests instead of\n    writing the agents id, which the foreign key rejected 100% of the time",
    /const agentUserId = await resolveUserIdForAgentRecord\(supabase, params\.agentId\)/.test(rev) &&
    /agent_id:\s*agentUserId/.test(rev))
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
  ok("generateAIDirectMail reads the agent's name/phone/email THROUGH the agents\n    row — it read `users` by the agents id, matched nothing, and every piece\n    was generated from a prompt that said \"AGENT: undefined undefined\"",
    /\.from\("agents"\)\.select\("users\(first_name, last_name, phone, email\)"\)\.eq\("id", params\.agentId\)/.test(mail))
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

  const goals = code(read("app/actions/ai-agent-goals.ts"))
  ok("the goals sync counts review_requests by the RESOLVED users id — by the\n    agents id it counted 0 and then WROTE that 0 over the agent's real progress",
    /\.from\("review_requests"\)[\s\S]{0,160}agentUserId/.test(goals))
  ok("...and omits the counter entirely when the users id cannot be resolved,\n    rather than clobbering a real value with a meaningless zero",
    /agentUserId \? \{ reviews_requested/.test(goals))
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
console.log(`${hits.length} fallback sites remain (baseline ${BASELINE}) — a review queue, not a number`)
console.log("to drive to zero automatically. Each needs its consumers read first.")
