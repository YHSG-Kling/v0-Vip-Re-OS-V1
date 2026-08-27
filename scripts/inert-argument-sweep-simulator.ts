#!/usr/bin/env tsx
/**
 * scripts/inert-argument-sweep-simulator.ts (npm run test:inert-arguments)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE ARGUMENTS THAT WERE PASSED AND NEVER READ.
 *
 * `npm run test:opposite-missing` category 4 counts them: a function ACCEPTS a
 * value and never looks at it. On paper that is a tidiness complaint. In this
 * repo it was thirteen live defects, because of WHAT was being dropped:
 *
 *   · FOUR tenants, each resolved from the SESSION by a caller and then thrown
 *     away by a function running on `createServiceClient()` — RLS off. That is
 *     not an unused variable, it is the §4 IDOR shape with the fix already in
 *     scope and simply not applied.
 *   · ONE identity pair on a permission gate, which made role and brokerage
 *     caller-ASSERTED rather than session-verified.
 *   · ONE stack trace, whose absence left three live columns NULL on every row
 *     and reduced an error-grouping hash to one value per workflow.
 *   · ONE event object on an idempotency check, one half of a pair whose other
 *     half was a fingerprint written on every insert and read by nobody —
 *     between them, a duplicate-charge guard on a COST LEDGER that could never
 *     fire.
 *   · TWO copies of the same "Them First" pronoun ratio in app/actions, a third
 *     and fourth spelling of the one already consolidated onto
 *     lib/compliance-rules/rule-evaluators.ts.
 *   · ONE state on a lifecycle validator, which let "reactivate" name any
 *     target state including the paused one the buyer was already in.
 *
 * WHAT THIS PROOF IS FOR. Each of those is now READ, and a reader is easy to
 * delete by accident — it looks like a redundant predicate. So the assertions
 * below pin the RULE ("the tenant the caller resolved reaches the query"), not
 * a line number, and every absence claim carries a POSITIVE CONTROL that
 * re-creates the original defect and requires it to go red.
 *
 * ── MEASUREMENT DISCIPLINE (§2) ────────────────────────────────────────────
 *
 * Source is read through `stripComments`/`blankStrings` from
 * scripts/strip-comments.ts, never a hand-rolled stripper. That is load-bearing
 * here rather than ceremonial: every fix in this wave left a TOMBSTONE quoting
 * the code it replaced, so a scanner reading raw source would find the old
 * broken predicate in the comment and report the fix as absent — the exact
 * misread that took five guards red on 2026-08-23.
 *
 * BLIND SPOTS, published beside the numbers:
 *   · STATIC + IN-MEMORY. No database is opened, so this proves each predicate
 *     is ASKED and each comparison DECIDES. It does not prove a row came back.
 *   · The role gate and the financial-verification gate inside
 *     validateReactivation need service-role credentials this sandbox does not
 *     hold; only the branches this wave added, and the fall-through to the
 *     untouched ones, are exercised.
 *   · Column existence is checked against the generated snapshot
 *     (scripts/schema-snapshot.ts), which is a CACHE of the live database, not
 *     a second opinion about it.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments, blankStrings } from "./strip-comments"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { LIVE_TABLES } from "./live-tables"

const root = process.cwd()
let pass = 0
let fail = 0
const failures: string[] = []

function t(name: string, cond: boolean) {
  if (cond) {
    pass++
    console.log(`  ✓ ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ✗ ${name}`)
  }
}

/** Comment-stripped source. A tombstone is not a call site. */
function code(rel: string): string {
  return stripComments(readFileSync(join(root, rel), "utf8"))
}
/** Comment-stripped AND string-masked, for scans a quoted specimen could fool. */
function tokens(rel: string): string {
  return blankStrings(readFileSync(join(root, rel), "utf8"))
}

/**
 * Does `table` really carry `column`, per the generated cache?
 *
 * Derived, never hardcoded: a predicate pinned to a table name outlives the
 * table. Every table this proof names is checked against LIVE_TABLES first, so
 * a retired name cannot sit here reading as enforced.
 */
function liveColumn(table: string, column: string): boolean {
  if (!(LIVE_TABLES as readonly string[]).includes(table)) return false
  return (SCHEMA_SNAPSHOT[table] ?? []).includes(column)
}

/**
 * The body of one function, comment-stripped — so an assertion about "this
 * function's query" cannot be satisfied by a different function in the file.
 * Cut from the declaration to the next top-level `function`/`export` at column 0.
 */
function body(rel: string, declaration: string): string {
  const src = code(rel)
  const start = src.indexOf(declaration)
  if (start === -1) return ""
  const rest = src.slice(start + declaration.length)
  const end = rest.search(/\n(?:export\s|(?:async\s+)?function\s|const\s+[A-Za-z]+\s*=)/)
  return end === -1 ? rest : rest.slice(0, end)
}

console.log("══════════════════════════════════════════════════")
console.log(" INERT-ARGUMENT SWEEP — the values that were passed and never read")
console.log("══════════════════════════════════════════════════")

// ── 1. THE FOUR DROPPED TENANTS ─────────────────────────────────────────────
//
// Each of these functions is handed a brokerage id by a caller that resolved it
// from the session, and each runs on a service client. The rule asserted is
// "the tenant reaches the query", expressed as: the function's own body filters
// on brokerage_id — derived, so it survives the query being reordered or
// reformatted.
console.log("\n[1. THE DROPPED TENANTS — resolved from the session, then not applied]")

const tenantSites: Array<{ file: string; decl: string; table: string; what: string }> = [
  {
    file: "lib/intelligence/conversation-insights.ts",
    decl: "export async function getContactMemory(",
    table: "conversation_insights",
    what: "contact memory (objections, pain points, buying signals)",
  },
  {
    file: "lib/deal-health/health-scorer.ts",
    decl: "async function scoreCompliance(",
    table: "transaction_compliance_log",
    what: "the deal-health compliance score",
  },
  {
    file: "lib/onboarding/certification-engine.ts",
    decl: "export async function getCertificationStatus(",
    table: "agent_certifications",
    what: "an agent's certification status",
  },
]

for (const s of tenantSites) {
  const b = body(s.file, s.decl)
  t(`${s.what}: the function body exists to be judged`, b.length > 0)
  t(`${s.what}: it reads ${s.table} — a LIVE table with a brokerage_id column`,
    liveColumn(s.table, "brokerage_id"))
  t(`${s.what}: the tenant the caller resolved reaches the query`,
    /\.eq\(\s*["']brokerage_id["']\s*,\s*(params\.)?brokerageId\s*\)/.test(b))
}

// The tenant is worth nothing if the caller stopped resolving it.
t("ai-auto-response still resolves the tenant from the SESSION before asking for memory",
  /getAgentContext\(\)/.test(code("app/actions/ai-auto-response.ts")) &&
  /buildContextWindow\(/.test(code("app/actions/ai-auto-response.ts")))
t("calculateDealHealth still HANDS scoreCompliance the tenant (the wire, not just the filter)",
  /scoreCompliance\(supabase,\s*transactionId,\s*brokerageId\)/.test(code("lib/deal-health/health-scorer.ts")))
t("the onboarding surface still hands getCertificationStatus the session tenant",
  /getCertificationStatus\(targetAgentId,\s*targetBrokerageId\)/.test(code("app/actions/onboarding/progress.ts")))

console.log("\n  [CONTROL — the finder still recognises the defect it was written for]")
{
  // The ORIGINAL query text, verbatim. If the detector cannot tell this from a
  // fixed one, its passes above mean nothing.
  const originalDefect = `
  const { data: insights, error } = await supabase
    .from('conversation_insights')
    .select('*')
    .eq('contact_id', contactId)
    .eq('agent_id', agentId)`
  t("CONTROL the pre-fix query is NOT accepted as tenant-scoped",
    !/\.eq\(\s*["']brokerage_id["']\s*,\s*(params\.)?brokerageId\s*\)/.test(originalDefect))
  const fixedSpecimen = `${originalDefect}\n    .eq('brokerage_id', brokerageId)`
  t("CONTROL ...and the fixed shape IS accepted",
    /\.eq\(\s*["']brokerage_id["']\s*,\s*(params\.)?brokerageId\s*\)/.test(fixedSpecimen))
  t("CONTROL a table that is not live fails liveColumn, whatever the snapshot says",
    !liveColumn("open_houses_legacy_that_never_existed", "brokerage_id"))
}

// ── 2. THE PERMISSION GATE THAT BELIEVED ITS CALLER ─────────────────────────
console.log("\n[2. THE PERMISSION GATE — identity was asserted, now it is verified]")
{
  const g = code("lib/security/server-action-guard.ts")
  t("the role/permission matrix is still consulted", /AccessControl\.checkPermission\(/.test(g))
  t("the session is now read", /supabase\.auth\.getUser\(\)/.test(g))
  t("the claimed user id is COMPARED to the session", /user\.id\s*!==\s*userId/.test(g))
  t("the claimed brokerage is COMPARED to the resolved tenant",
    /tenant\.brokerageId\s*!==\s*userBrokerageId/.test(g))
  t("the tenant is resolved through the record, not taken from the claim",
    /resolveUserBrokerageId\(supabase,\s*user\.id\)/.test(g))
  // §4: a gate that cannot run must REFUSE.
  const refusals = (g.match(/return\s*\{\s*allowed:\s*false/g) ?? []).length
  t("FAIL CLOSED — every unverifiable branch refuses (≥5 refusal returns)", refusals >= 5)
  t("...including the branch where the SESSION itself could not be read",
    /sessionError\s*\|\|\s*!user/.test(g))
  t("...and the branch where the tenant lookup was REFUSED (not merely empty)",
    /!tenant\.ok/.test(g))

  console.log("\n  [CONTROL]")
  const preFixBody = `
    const result = AccessControl.checkPermission(userRole, requiredPermission)
    if (!result.allowed) { return { allowed: false } }
    return { allowed: true }`
  t("CONTROL the pre-fix body is NOT accepted as session-verified",
    !/user\.id\s*!==\s*userId/.test(preFixBody))
}

// ── 3. THE STACK TRACE ──────────────────────────────────────────────────────
console.log("\n[3. THE STACK TRACE — three columns that were NULL on every row]")
{
  const collect = code("lib/errors/collect-error.ts")
  const classifier = code("lib/errors/error-classifier.ts")

  for (const col of ["file_path", "line_number", "function_name", "error_hash"]) {
    t(`error_stack_traces.${col} is a live column`, liveColumn("error_stack_traces", col))
  }
  t("the stack is now PARSED into a frame", /function frameFromStack\(/.test(collect))
  t("the frame — not the never-supplied fileInfo — is what the row is written from",
    /file_path:\s*frame\?\.path/.test(collect) &&
    /line_number:\s*frame\?\.line/.test(collect) &&
    /function_name:\s*frame\?\.function/.test(collect))
  t("the grouping hash is keyed on that frame, so it can distinguish two throw sites",
    /\$\{frame\?\.path[^}]*\}\|\$\{frame\?\.line[^}]*\}/.test(collect))
  t("a caller-supplied fileInfo still WINS (the stack is the fallback, not the override)",
    /const frame = fileInfo \?\? frameFromStack\(stack\)/.test(collect))

  // The parameter that was retired, and the output nothing consumed.
  t("classifyError no longer ACCEPTS a stack it never read",
    !/export function classifyError\([\s\S]{0,180}?stack\??:/.test(classifier))
  t("no caller still hands it one",
    !/classifyError\([^)]*,[^)]*,[^)]*\)/.test(code("app/api/errors/collect/route.ts")) &&
    !/classifyError\([^)]*,[^)]*,[^)]*\)/.test(collect))
  t("the unconsumed `groupingKey` output is gone from the classification",
    !/groupingKey/.test(tokens("lib/errors/error-classifier.ts")))

  console.log("\n  [CONTROLS — behaviour, not just shape]")
  const REAL_STACK = [
    "Error: boom",
    "    at frameFromStack (/x/lib/errors/collect-error.ts:70:11)",
    "    at engageContact (/x/app/actions/ai-isa/engage-contact.ts:271:9)",
  ].join("\n")
  // The parser, re-derived here so the control is independent of the module's
  // internals (frameFromStack is deliberately not exported — an export with no
  // importer is the very thing this wave is burning down).
  const parse = (stack: string | undefined) => {
    if (!stack) return null
    for (const raw of stack.split("\n")) {
      const line = raw.trim()
      if (!line.startsWith("at ")) continue
      if (line.includes("/lib/errors/")) continue
      const m = line.match(/^at\s+(.+?)\s+\((.+):(\d+):(\d+)\)$/)
      if (m) return { path: m[2], line: Number(m[3]), function: m[1] }
      const b2 = line.match(/^at\s+(.+):(\d+):(\d+)$/)
      if (b2) return { path: b2[1], line: Number(b2[2]), function: "<anonymous>" }
    }
    return null
  }
  t("CONTROL the collector's OWN frame is skipped — it is never the culprit",
    parse(REAL_STACK)?.path === "/x/app/actions/ai-isa/engage-contact.ts")
  t("CONTROL an unparseable stack yields null, i.e. degrades to the OLD NULLs rather than guessing",
    parse("not a v8 stack") === null)
  t("CONTROL no stack at all yields null", parse(undefined) === null)
}

// ── 4. THE IDEMPOTENCY CHECK THAT COULD NEVER FIRE ──────────────────────────
console.log("\n[4. THE COST LEDGER — a duplicate guard that was unreachable code]")
{
  const u = code("lib/vendor-governance/usage-logger.ts")
  t("vendor_usage_tracking.created_at is live", liveColumn("vendor_usage_tracking", "created_at"))
  t("the fingerprint is still WRITTEN on every insert", /event_fingerprint: eventFingerprint/.test(u))
  t("...and is now READ BACK as the dedupe predicate",
    /request_metadata->>event_fingerprint['"]\s*,\s*eventFingerprint/.test(u))
  t("the SELECT now asks for the column the comparison needs",
    /\.select\(\s*['"]id, created_at['"]\s*\)/.test(u))
  t("zero rows is the ordinary case, so maybeSingle — .single() ERRORS on none",
    /\.maybeSingle\(\)/.test(u))
  t("the dedupe read's own error is destructured and acted on", /dupeReadError/.test(u))
  t("the comparison now reads the EVENT it is comparing against",
    /event\.timestamp/.test(body("lib/vendor-governance/usage-logger.ts", "function isLikelyDuplicate(")))

  console.log("\n  [CONTROLS — the original defect, re-created]")
  // The old body, verbatim, fed the row the old query ACTUALLY returned (id only).
  const oldCheck = (existingLog: any) => {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000)
    const logTime = new Date(existingLog.created_at)
    return (logTime as unknown as number) > (fiveMinutesAgo as unknown as number)
  }
  t("CONTROL the OLD check, given the OLD query's row, says NOT-duplicate — always",
    oldCheck({ id: "1" }) === false)

  const WINDOW = 5 * 60 * 1000
  const newCheck = (log: { created_at?: string | null } | null, ev: { timestamp?: Date }) => {
    const loggedAt = log?.created_at ? new Date(log.created_at).getTime() : NaN
    if (!Number.isFinite(loggedAt)) return false
    const eventAt = ev.timestamp ? ev.timestamp.getTime() : Date.now()
    if (!Number.isFinite(eventAt)) return false
    return Math.abs(eventAt - loggedAt) <= WINDOW
  }
  const now = Date.now()
  t("the NEW check catches a 30-second-old replay",
    newCheck({ created_at: new Date(now - 30_000).toISOString() }, {}) === true)
  t("...and does NOT swallow an hour-old repeat charge",
    newCheck({ created_at: new Date(now - 3_600_000).toISOString() }, {}) === false)
  t("a queued event is judged on ITS OWN timestamp, not on wall-clock",
    newCheck(
      { created_at: new Date(now - 3_600_000).toISOString() },
      { timestamp: new Date(now - 3_600_000 + 10_000) },
    ) === true)
  t("FAILS OPEN — an undecidable comparison LOGS the charge rather than dropping it",
    newCheck({ created_at: null }, {}) === false && newCheck(null, {}) === false)
}

// ── 5. ONE "THEM FIRST" VOCABULARY ──────────────────────────────────────────
console.log("\n[5. THEM FIRST — four readings of one ratio, collapsed onto one]")
{
  const survivor = "lib/compliance-rules/rule-evaluators.ts"
  const s = code(survivor)
  t("the survivor exports the verdict the two deleted copies produced",
    /export function evaluateThemFirstFocus\(/.test(s))
  t("the pre-existing deterministic score now DELEGATES to it (one list, not two)",
    /export function calculateThemFirstScore\(content: string\): number \{\s*return evaluateThemFirstFocus\(content\)\.overall_score/.test(s))
  t("the threshold is not exported — an exported const nobody names is a new orphan",
    !/export const THEM_FIRST_PASS_RATIO/.test(s))

  // The duplicates are gone from BOTH app/actions files. String-masked: each
  // file's tombstone names the deleted function, and a tombstone is not a
  // declaration.
  //
  // 2026-08-27: listing-video.ts no longer CALLS the survivor either — its
  // narration step (the only caller in that file) was merged onto
  // commissionVideo (lib/video/video-director.ts), whose hook copy is gated by
  // runWithComplianceRedraft + evaluateOutbound. The file authors no script,
  // so there is nothing for evaluateThemFirstFocus to judge there; the
  // "calls the survivor" assertion now applies only to the file that still
  // authors content. The no-resurrection check stays on BOTH files.
  for (const f of ["app/actions/ai-content-generation.tsx", "app/actions/listing-video.ts"]) {
    const masked = tokens(f)
    t(`${f}: no local validateThemFirstContent declaration survives`,
      !/(?:export\s+)?async function validateThemFirstContent\(/.test(masked))
  }
  {
    const f = "app/actions/ai-content-generation.tsx"
    const masked = tokens(f)
    t(`${f}: it calls the survivor instead`, /evaluateThemFirstFocus\(/.test(masked))
    // Comment-stripped but NOT string-masked: an import specifier IS a string,
    // so blankStrings would blank the very thing being asserted. Pinned to an
    // `import … from` statement so a path mentioned in a tombstone cannot pass.
    t(`${f}: and imports it from the survivor module`,
      /import\s*\{[^}]*evaluateThemFirstFocus[^}]*\}\s*from\s*['"]@\/lib\/compliance-rules\/rule-evaluators['"]/.test(code(f)))
  }
  {
    // listing-video authors no content any more — it must stage through the
    // Director (whose gate is the kernel rule array), not regrow its own pass.
    const masked = tokens("app/actions/listing-video.ts")
    t("app/actions/listing-video.ts: stages through commissionVideo (the gated rail)",
      /commissionVideo\(/.test(masked))
    t("app/actions/listing-video.ts: authors no script for a private gate to miss",
      !/generateText\(/.test(masked) && !/generateAIResponse\(/.test(masked))
  }
  // The RICHER instrument is a different tool and must NOT have been collapsed in.
  t("lib/them-first/validator.ts::validateThemFirstContent is UNTOUCHED (AI structural analysis is a different tool)",
    /export async function validateThemFirstContent\(/.test(code("lib/them-first/validator.ts")))

  console.log("\n  [CONTROL — the merge changed a verdict, and that was the point]")
  const evalFocus = (content: string) => {
    const buyer = (content.match(/\b(you|your|yours|imagine|feel|enjoy|benefit|discover|experience)\b/gi) || []).length
    const agent = (content.match(/\b(i|me|my|mine|we|us|our|ours)\b/gi) || []).length
    const total = buyer + agent
    const score = total === 0 ? 0.5 : buyer / total
    return { score, passed: score >= 0.7 }
  }
  const fairHousingString = "Perfect for families. Ideal for young professionals. Great for families."
  const deletedCopy = (() => {
    const agentPatterns = [/\b(i|me|my|our team|we offer|my expertise|i specialize|i can help)\b/gi, /\b(contact me|call me|reach out|my services)\b/gi]
    const buyerPatterns = [/\b(you|your|imagine|picture yourself|envision|experience)\b/gi, /\b(perfect for|ideal for|great for families|enjoy)\b/gi]
    let a = 0, b2 = 0
    for (const p of agentPatterns) a += (fairHousingString.match(p) ?? []).length
    for (const p of buyerPatterns) b2 += (fairHousingString.match(p) ?? []).length
    return a + b2 > 0 ? b2 / (a + b2) : 0.5
  })()
  t("CONTROL the DELETED copies scored a fair-housing string 1.0 — a perfect pass", deletedCopy === 1)
  t("the survivor does not reward it (no personal pronoun = no signal, and 0.5 does not pass)",
    evalFocus(fairHousingString).score === 0.5 && !evalFocus(fairHousingString).passed)
  t("CONTROL the survivor still passes genuinely buyer-focused copy",
    evalFocus("You will love your kitchen. Imagine how you feel when you discover the view.").passed)
}

// ── 6. THE UNENROLL DUPLICATE ───────────────────────────────────────────────
console.log("\n[6. UNENROLL — an export with no caller, and a caller with its own copy]")
{
  const engine = code("lib/campaign-sequences/enrollment-engine.ts")
  const adapter = tokens("lib/workflow/adapters/segment-ops.ts")
  t("sequence_enrollments carries the tenant the copy never filtered on",
    liveColumn("sequence_enrollments", "brokerage_id"))
  t("the survivor now REQUIRES a tenant (optional would let the seam reopen by omission)",
    /brokerageId: string\s*\n\}\): Promise<\{ success: boolean; unenrolled: number/.test(engine))
  t("the survivor .select()s its UPDATE — an update matching NOTHING also resolves",
    /\.in\("status", \["active", "paused"\]\)\s*\n\s*\.select\("id"\)/.test(engine))
  t("the adapter now CALLS the survivor", /unenrollContact\(\{/.test(adapter))
  t("...and no longer writes the table itself",
    !/from\("sequence_enrollments"\)/.test(adapter))
  t("ONE terminal spelling: the hand-rolled 'cancelled' is gone from this adapter",
    !/status: ["']cancelled["']/.test(code("lib/workflow/adapters/segment-ops.ts")))
  // Same reason: a status literal is a string. Read comment-stripped source.
  t("the adapter surfaces a refusal instead of reporting success over it",
    /if \(!result\.success\)[\s\S]{0,120}status: ["']failed["']/.test(code("lib/workflow/adapters/segment-ops.ts")))

  console.log("\n  [CONTROL]")
  const preFix = `.update({ status: "cancelled", completed_at: new Date().toISOString() })
        .eq("contact_id", contact.id).eq("sequence_id", targetSequenceId).eq("status", "active")`
  t("CONTROL the pre-fix adapter body is NOT accepted (no tenant, active-only, 'cancelled')",
    /status: ["']cancelled["']/.test(preFix) && !/brokerageId/.test(preFix))
}

// ── 7. THE REACTIVATION VALIDATOR ───────────────────────────────────────────
console.log("\n[7. REACTIVATION — currentState was typed, passed, and ignored]")
{
  const v = code("lib/buyer-lifecycle/transition-validator.ts")
  t("the argument is now read at least twice", (v.match(/currentState/g) ?? []).length >= 6)
  t("reactivating into the state you are already in is refused",
    /targetState === currentState/.test(v))
  t("a further-disengagement target is refused HERE and sent to the ordinary validator",
    /targetState === "BUYER_ON_HOLD" \|\| targetState === "BUYER_DISENGAGED"/.test(v))

  // The rule, DERIVED — not pinned to the graph, because the graph says the
  // opposite and pinning to it would have refused every reactivation.
  const defs = code("lib/buyer-lifecycle/lifecycle-definitions.ts")
  const pausedAppearsAsASource = /allowedFrom:\s*\[[^\]]*"BUYER_ON_HOLD"[^\]]*\]/.test(defs)
  t("WHY not the sibling's allowedFrom test: the graph models almost no edge OUT of a paused state",
    pausedAppearsAsASource === true) // exactly one: BUYER_DISENGAGED <- BUYER_ON_HOLD
  const outEdges = [...defs.matchAll(/state:\s*"(\w+)"([\s\S]*?)allowedFrom:\s*\[([\s\S]*?)\]/g)]
    .filter((m) => /BUYER_ON_HOLD|BUYER_DISENGAGED/.test(m[3]))
    .map((m) => m[1])
  t("...precisely: reactivation targets are absent from the graph, so allowedFrom would refuse them all",
    outEdges.length === 1 && outEdges[0] === "BUYER_DISENGAGED")
}

console.log("\n──────────────────────────────────────────────────")
console.log(" BLIND SPOTS, published beside the number:")
console.log("   · STATIC + IN-MEMORY. No database is opened. Every assertion proves a")
console.log("     predicate is ASKED or a comparison DECIDES, never that a row came back.")
console.log("   · Column existence is checked against scripts/schema-snapshot.ts, a CACHE")
console.log("     of the live database — regenerated, never hand-edited.")
console.log("   · validateReactivation's role gate and financial-verification gate are NOT")
console.log("     exercised: both need service-role credentials this sandbox does not hold.")
console.log("   · Source is read comment-STRIPPED. Every fix here left a tombstone quoting")
console.log("     the code it replaced; raw source would find the defect in the comment and")
console.log("     report the fix as absent.")
console.log("")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ INERT_ARGUMENT_SWEEP_FAIL")
  process.exit(1)
}
console.log(" ✅ INERT_ARGUMENT_SWEEP_PASS — every argument this wave wired is still read,")
console.log("    and every control still recognises the defect it was written for")
