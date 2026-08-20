#!/usr/bin/env tsx
/**
 * scripts/lead-social-wiring-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SCRAPE-AND-PROFILE RAIL: WHAT GOT FINISHED, AND WHAT MUST STAY DARK.
 *
 * Eleven exports were referenced nowhere — not by the product, not by a proof,
 * not inside their own module. Two of them were the missing halves of screens
 * that were already shipping:
 *
 *   · unified_lead_profile is READ by the CRM contact drawer and by /leads and
 *     had NO WRITER ANYWHERE IN THE PRODUCT. createUnifiedLeadProfile was the
 *     writer, orphaned. The drawer's Lead Profile card could never render, and
 *     its empty state said "Loading intelligence…" forever.
 *   · social_engagement_tracking is READ by every published post card on the
 *     social dashboard and its only writer was the publish cron's all-zero
 *     row. trackPostPerformance was the real writer, orphaned — and its
 *     `.upsert()` had no conflict target on a table whose only unique
 *     constraint is its own primary key, so it inserted a duplicate per call.
 *
 * The other side of the ledger is the part that matters more. This rail
 * SCRAPES AND PROFILES PEOPLE. Four capabilities were deliberately NOT given a
 * surface, and this file asserts they stay unsurfaced:
 *
 *   · scrapeSocialSignalsWithZenRows — its parser returns [] unconditionally,
 *     so it paid ZenRows for a premium-proxy JS-rendered fetch and persisted
 *     nothing, every call. Named wired rival: lib/lead-pipeline/social-sourcer.
 *   · scrapeExternalBehavior — persists owner_name / owner_occupied /
 *     equity_estimate: a financial profile of a named homeowner assembled from
 *     a city typed into a form, with no lawful basis recorded anywhere.
 *   · trackBehavior — a public visitor pixel that stamped brokerage_id NULL
 *     into a table whose RLS policy is `IS NULL OR = current_user_brokerage_id()`,
 *     i.e. every visitor's IP address was readable by every brokerage.
 *   · analyzeGoogleSearchIntent — safe data, but google_search_intelligence has
 *     no reader at all and ZenRows is dark.
 *
 * NOTHING WAS DELETED. Every rival identified writes a DIFFERENT table, so
 * none of these could be proven to be a port rather than an independent twin.
 *
 * ─── HOW THIS PROVES ANYTHING ───────────────────────────────────────────────
 *  · Comments are stripped before every scan, and a self-test proves a comment
 *    cannot satisfy a check.
 *  · Assertions slice the CONSTRUCT — a function body, an insert payload — and
 *    never grep a whole file. A name survives in its own declaration long after
 *    its branch has been gutted, so branches are asserted, not tokens.
 *  · Every assertion family is negative-tested: real source is mutated on disk,
 *    the mutation is proven applied by sha256, the suite re-runs, the SPECIFIC
 *    check id is confirmed to have failed, the file is restored and the restore
 *    is proven by sha256.
 *
 * RUN:  npx tsx scripts/lead-social-wiring-simulator.ts
 */

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { stripComments } from "./strip-comments"

// ─── FILES UNDER PROOF ───────────────────────────────────────────────────────

const SOCIAL = "app/actions/social-media-automation.ts"
const SOCIAL_UI = "app/dashboard/social/social-dashboard-client.tsx"
const LEAD = "app/actions/lead-intelligence.ts"
const CRM_UI = "app/crm/page.tsx"

const ALL_FILES = [SOCIAL, SOCIAL_UI, LEAD, CRM_UI]

// ─── SOURCE ACCESS (cached, clearable for the negative-test re-runs) ─────────

const rawCache = new Map<string, string>()
const codeCache = new Map<string, string>()

function raw(path: string): string {
  const hit = rawCache.get(path)
  if (hit !== undefined) return hit
  const text = readFileSync(join(process.cwd(), path), "utf8")
  rawCache.set(path, text)
  return text
}

/**
 * Strip comments so an assertion can never be satisfied by prose describing
 * the fix. Block comments first, then whole-line and trailing line comments.
 * Trailing comments are removed only when the `//` is not inside a quote on
 * that line, so a URL or a regex containing a slash pair survives.
 */
// Comment removal goes through scripts/strip-comments.ts.
//
// What stood here walked each line tracking quote state to find an unquoted `//`.
// That is the apostrophe variant of the same defect class: a `'` in ordinary prose
// — "the script's agent", "don't" — flipped the scanner into "inside a string",
// after which the `//` that actually started the comment was not recognised and the
// whole comment was returned as code. The canonical scanner knows a single-quoted
// literal cannot span a newline, so an apostrophe in prose is never a string opener.

function code(path: string): string {
  const hit = codeCache.get(path)
  if (hit !== undefined) return hit
  const text = stripComments(raw(path))
  codeCache.set(path, text)
  return text
}

function clearCaches() { rawCache.clear(); codeCache.clear() }

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(join(process.cwd(), path))).digest("hex")
}

// ─── CONSTRUCT SLICING ───────────────────────────────────────────────────────

/** Brace-match forward from `start` (which must index an opening brace). */
function matchBrace(text: string, start: number): number {
  let depth = 0, inS = false, inD = false, inB = false, esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (esc) { esc = false; continue }
    if (c === "\\") { esc = true; continue }
    if (inS) { if (c === "'") inS = false; continue }
    if (inD) { if (c === '"') inD = false; continue }
    if (inB) { if (c === "`") inB = false; continue }
    if (c === "'") { inS = true; continue }
    if (c === '"') { inD = true; continue }
    if (c === "`") { inB = true; continue }
    if (c === "{") depth++
    else if (c === "}") { depth--; if (depth === 0) return i }
  }
  return -1
}

/** Paren-match forward from `start` (which must index an opening paren). */
function matchParen(text: string, start: number): number {
  let depth = 0, inS = false, inD = false, inB = false, esc = false
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (esc) { esc = false; continue }
    if (c === "\\") { esc = true; continue }
    if (inS) { if (c === "'") inS = false; continue }
    if (inD) { if (c === '"') inD = false; continue }
    if (inB) { if (c === "`") inB = false; continue }
    if (c === "'") { inS = true; continue }
    if (c === '"') { inD = true; continue }
    if (c === "`") { inB = true; continue }
    if (c === "(") depth++
    else if (c === ")") { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * Locate a named function's declaration start and the index of its BODY brace.
 *
 * Naively taking the first `{` after the name lands inside the parameter type
 * (`getSocialQueue(filters?: { platform?: string … })`) or inside an inline
 * return type. So: paren-match the parameter list, then walk the return-type
 * annotation tracking angle/brace/bracket depth — the body brace is the first
 * `{` seen at depth zero.
 */
function fnAnchors(path: string, name: string): { start: number; bodyOpen: number; text: string } | null {
  const text = code(path)
  const decl = new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*\\(`)
  const m = decl.exec(text)
  if (!m) return null
  const start = m.index + m[0].search(/\S/)
  const paramOpen = m.index + m[0].length - 1
  const paramClose = matchParen(text, paramOpen)
  if (paramClose < 0) return null

  let angle = 0, brace = 0, bracket = 0
  for (let i = paramClose + 1; i < text.length; i++) {
    const c = text[i]
    if (c === "<") angle++
    else if (c === ">") { if (angle > 0) angle-- }
    else if (c === "[") bracket++
    else if (c === "]") { if (bracket > 0) bracket-- }
    else if (c === "{") {
      if (angle === 0 && bracket === 0 && brace === 0) return { start, bodyOpen: i, text }
      brace++
    } else if (c === "}") { if (brace > 0) brace-- }
  }
  return null
}

/**
 * The body of one named function. Slicing this is the whole point: an
 * assertion about `getSocialQueue` that scans the entire 1200-line module is
 * satisfied by any other function in it.
 */
function fnBody(path: string, name: string): string {
  const a = fnAnchors(path, name)
  if (!a) return ""
  const close = matchBrace(a.text, a.bodyOpen)
  if (close < 0) return ""
  return a.text.slice(a.bodyOpen, close + 1)
}

/** The declaration of a function: everything up to its body brace. */
function fnSignature(path: string, name: string): string {
  const a = fnAnchors(path, name)
  if (!a) return ""
  return a.text.slice(a.start, a.bodyOpen)
}

/**
 * The object literal handed to `.insert(` / `.update(` / `.upsert(` for one
 * table, inside an already-sliced scope. Asserting a payload key against a
 * whole file is how a correctly-stamped write elsewhere satisfies a claim
 * about a broken one.
 */
function writePayloads(scope: string, table: string, verb: "insert" | "update" | "upsert"): string[] {
  const out = new Set<string>()
  const re = new RegExp(`from\\(\\s*["']${table}["']\\s*\\)`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(scope))) {
    const rest = scope.slice(m.index, m.index + 4000)
    const vi = rest.indexOf(`.${verb}(`)
    if (vi < 0) continue
    // The verb must belong to THIS from() — if another .from( intervenes, the
    // match belongs to a different statement and would let a correctly stamped
    // write elsewhere answer for a broken one.
    if (/\.from\(/.test(rest.slice(m[0].length, vi))) continue
    const open = rest.indexOf("{", vi)
    if (open < 0 || open - vi > verb.length + 2) continue
    const close = matchBrace(rest, open)
    if (close < 0) continue
    out.add(rest.slice(open, close + 1))
  }
  return Array.from(out)
}

/** The JSX/attribute region of a named React handler's call sites. */
function callsFn(scope: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(scope)
}

// ─── CHECK HARNESS ───────────────────────────────────────────────────────────

type Result = { id: string; label: string; ok: boolean }
let results: Result[] = []
let quiet = false

function check(id: string, label: string, ok: boolean) {
  results.push({ id, label, ok })
  if (!quiet) console.log(`  ${ok ? "✓" : "✗"} [${id}] ${label}`)
}

function section(title: string) { if (!quiet) console.log(`\n${title}`) }

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 0 — the stripper cannot be fooled by prose
// ═══════════════════════════════════════════════════════════════════════════

function stripperSelfTest() {
  section("[layer 0 · a comment cannot satisfy a check]")

  const blockOpen = "/" + "*"
  const blockClose = "*" + "/"
  const decoy =
    `${blockOpen} brokerage_id: ctx.brokerageId and .upsert( live here ${blockClose}\n` +
    `const real = 1 // brokerage_id: ctx.brokerageId trailing decoy\n` +
    `const url = "https:` + `//example.com/keep"\n`

  const stripped = stripComments(decoy)

  check("SELF-1", "block comments are removed before any scan",
    !/brokerage_id: ctx\.brokerageId and/.test(stripped))
  check("SELF-2", "trailing line comments are removed before any scan",
    !/trailing decoy/.test(stripped))
  check("SELF-3", "...but a slash pair inside a string literal survives",
    /example\.com\/keep/.test(stripped) && /const real = 1/.test(stripped))

  // The slicers must actually slice: a body must not contain the module.
  const queue = fnBody(SOCIAL, "getSocialQueue")
  check("SELF-4", "fnBody returns one function, not the module",
    queue.length > 200 && queue.length < code(SOCIAL).length / 3 &&
    !/export async function trackPostPerformance/.test(queue))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 1 — social queue / delivery reads are tenant-safe and honest
// ═══════════════════════════════════════════════════════════════════════════

// Live CHECK constraints, project hrvaqgvukzxfskkcrwbt, read on 2026-08-05.
const LIVE_POST_STATUSES = ["draft", "scheduled", "publishing", "published", "failed", "cancelled"]
const LIVE_APPROVAL_STATUSES = ["pending", "approved", "rejected"]
const LIVE_PLATFORMS = [
  "facebook", "instagram", "linkedin", "twitter", "tiktok",
  "youtube", "pinterest", "google_business", "all",
]

function socialReadLayer() {
  section("[layer 1 · the social queue answers to the session, not the browser]")

  const sig = fnSignature(SOCIAL, "getSocialQueue")
  const body = fnBody(SOCIAL, "getSocialQueue")

  // The hole: a "use server" action whose first positional argument was the
  // tenant. Assert the SIGNATURE, because a body that also happens to call
  // requireBrokerage does not close it.
  check("S1", "getSocialQueue no longer accepts a caller-supplied brokerageId",
    sig !== "" && !/brokerageId\s*:\s*string/.test(sig))
  check("S2", "...it resolves the tenant from the session inside its own body",
    /const\s+ctx\s*=\s*await\s+requireBrokerage\(\)/.test(body) &&
    /if\s*\(!ctx\.ok\)\s*return/.test(body))
  check("S3", "...and filters brokerage_id on the resolved session tenant",
    /\.eq\(\s*["']brokerage_id["']\s*,\s*ctx\.brokerageId\s*\)/.test(body))

  // supabase-js resolves a refused read. `return []` renders an RLS denial as
  // "you have nothing scheduled". Assert the error BRANCH, not the word error.
  check("S4", "...a refused read returns a verdict, never an empty list",
    /if\s*\(error\)\s*\{[^}]{0,200}?return\s*\{\s*ok:\s*false\s*,\s*error:\s*error\.message/.test(body) &&
    !/if\s*\(error\)\s*\{[^}]{0,120}?return\s*\[\s*\]/.test(body))

  // A filter value the column cannot hold is an empty list that reads as
  // "nothing matched" — SQLSTATE 23514's quieter cousin.
  check("S5", "...an out-of-vocabulary status filter is rejected, not silently empty",
    /SOCIAL_POST_STATUSES[\s\S]{0,120}?includes\(filters\.status\)[^}]{0,200}?return\s*\{\s*ok:\s*false/.test(body))
  check("S6", "...an out-of-vocabulary approval filter is rejected",
    /SOCIAL_APPROVAL_STATUSES[\s\S]{0,160}?includes\(\s*filters\.approvalStatus\s*\)[^}]{0,200}?return\s*\{\s*ok:\s*false/.test(body))
  check("S7", "...an out-of-vocabulary platform filter is rejected",
    /SOCIAL_PLATFORMS[\s\S]{0,120}?includes\(filters\.platform\)[^}]{0,200}?return\s*\{\s*ok:\s*false/.test(body))

  // The vocabularies themselves must equal the live CHECK constraints.
  const vocab = (name: string): string[] => {
    const m = new RegExp(`const\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(code(SOCIAL))
    if (!m) return []
    return Array.from(m[1].matchAll(/["']([^"']+)["']/g)).map((x) => x[1])
  }
  const setEq = (a: string[], b: string[]) =>
    a.length === b.length && a.every((x) => b.includes(x)) && b.every((x) => a.includes(x))

  check("S8", "the status vocabulary equals the live social_posts_status_check",
    setEq(vocab("SOCIAL_POST_STATUSES"), LIVE_POST_STATUSES))
  check("S9", "...and does NOT contain the phantom 'pending_approval' status",
    vocab("SOCIAL_POST_STATUSES").length > 0 &&
    !vocab("SOCIAL_POST_STATUSES").includes("pending_approval"))
  check("S10", "the approval vocabulary equals the live social_posts_approval_status_check",
    setEq(vocab("SOCIAL_APPROVAL_STATUSES"), LIVE_APPROVAL_STATUSES))
  check("S11", "the platform vocabulary equals the live social_posts_platform_check",
    setEq(vocab("SOCIAL_PLATFORMS"), LIVE_PLATFORMS))

  section("[layer 1b · a bare row id is not a passport]")

  const eng = fnBody(SOCIAL, "getSocialEngagement")
  const log = fnBody(SOCIAL, "getPublishLog")

  check("S12", "getSocialEngagement confirms the post belongs to the caller's tenant first",
    /verifySocialPostInBrokerage\(\s*postId\s*,\s*ctx\.brokerageId\s*\)/.test(eng) &&
    /if\s*\(!owned\.ok\)\s*return\s*\{\s*ok:\s*false/.test(eng))
  check("S13", "...and its own read is brokerage-filtered too",
    /from\(\s*["']social_engagement_tracking["']\s*\)[\s\S]{0,400}?\.eq\(\s*["']brokerage_id["']\s*,\s*ctx\.brokerageId\s*\)/.test(eng))
  check("S14", "getPublishLog confirms the post belongs to the caller's tenant first",
    /verifySocialPostInBrokerage\(\s*postId\s*,\s*ctx\.brokerageId\s*\)/.test(log) &&
    /if\s*\(!owned\.ok\)\s*return\s*\{\s*ok:\s*false/.test(log))
  check("S15", "...and its own read is brokerage-filtered too",
    /from\(\s*["']social_publish_log["']\s*\)[\s\S]{0,400}?\.eq\(\s*["']brokerage_id["']\s*,\s*ctx\.brokerageId\s*\)/.test(log))
  check("S16", "both delivery reads surface a refusal instead of an empty array",
    /if\s*\(error\)\s*\{[^}]{0,200}?return\s*\{\s*ok:\s*false/.test(eng) &&
    /if\s*\(error\)\s*\{[^}]{0,200}?return\s*\{\s*ok:\s*false/.test(log))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 2 — the engagement writer stops duplicating and stops lying
// ═══════════════════════════════════════════════════════════════════════════

function engagementWriteLayer() {
  section("[layer 2 · one measurement row per post, and it is real]")

  const sig = fnSignature(SOCIAL, "trackPostPerformance")
  const body = fnBody(SOCIAL, "trackPostPerformance")

  check("S17", "trackPostPerformance no longer takes brokerageId from the caller",
    sig !== "" && !/brokerageId\s*:\s*string/.test(sig))
  check("S18", "...the tenant comes from the session",
    /const\s+ctx\s*=\s*await\s+requireBrokerage\(\)/.test(body))

  // social_engagement_tracking's ONLY unique constraint is its primary key on
  // `id` (verified live). `.upsert()` without an onConflict target therefore
  // inserted a fresh row every call, and the dashboard reads element [0].
  check("S19", "...the conflict-target-less .upsert is gone",
    body !== "" && !/\.upsert\(/.test(body))
  check("S20", "...replaced by an explicit read-then-update-or-insert on (post, platform)",
    /from\(\s*["']social_engagement_tracking["']\s*\)[\s\S]{0,300}?\.eq\(\s*["']social_post_id["']\s*,\s*postId\s*\)[\s\S]{0,300}?\.eq\(\s*["']platform["']\s*,\s*post\.platform\s*\)/.test(body) &&
    /existing\s*\n?\s*\?[\s\S]{0,400}?\.update\(patch\)[\s\S]{0,400}?:\s*await[\s\S]{0,200}?\.insert\(/.test(body))

  // The post read must be tenant-anchored, not merely "a post that exists".
  check("S21", "...the post is resolved inside the caller's brokerage",
    /from\(\s*["']social_posts["']\s*\)[\s\S]{0,300}?\.eq\(\s*["']id["']\s*,\s*postId\s*\)[\s\S]{0,200}?\.eq\(\s*["']brokerage_id["']\s*,\s*ctx\.brokerageId\s*\)/.test(body))

  // The insert payload must stamp the tenant AT THE INSERT.
  const inserts = writePayloads(body, "social_engagement_tracking", "insert")
  check("S22", "...brokerage_id is stamped at the insert, from the session",
    inserts.length === 1 && /brokerage_id:\s*ctx\.brokerageId/.test(inserts[0]))

  // `metrics.saves || 0` asserts a platform reported zero saves when it in
  // fact reported nothing. An unsupplied metric must be left alone.
  check("S23", "...an unsupplied metric is skipped, never written as 0",
    /if\s*\(value === undefined \|\| value === null\)\s*continue/.test(body) &&
    !/impressions_count:\s*metrics\.\w+\s*\|\|\s*0/.test(body))

  // The old body discarded the write result and returned success regardless.
  check("S24", "...the write verdict is read and returned",
    /if\s*\(written\.error\)\s*\{[^}]{0,240}?return\s*\{\s*success:\s*false/.test(body))
  check("S25", "...and an update that matched zero rows is not reported as saved",
    /if\s*\(!written\.data\)\s*return\s*\{\s*success:\s*false/.test(body))

  section("[layer 2b · the numbers come from the real measurement writer]")

  const refresh = fnBody(SOCIAL, "refreshPostEngagementFromSync")

  // The one honest source of platform metrics in this codebase is
  // lib/social/analytics-sync.ts, which writes social_media_analytics from the
  // platforms' own APIs. Anything else would be a parallel provider path.
  check("S26", "the refresh reads social_media_analytics — the real sync's table",
    /from\(\s*["']social_media_analytics["']\s*\)/.test(refresh))
  check("S27", "...brokerage-scoped, and taking the most recent measurement",
    /\.eq\(\s*["']brokerage_id["']\s*,\s*ctx\.brokerageId\s*\)/.test(refresh) &&
    /\.order\(\s*["']measured_at["']\s*,\s*\{\s*ascending:\s*false\s*\}\s*\)/.test(refresh))
  check("S28", "...no measurement means it writes NOTHING and says so",
    /if\s*\(!synced\)\s*\{[^}]{0,400}?reason:\s*["']no_measurement["']/.test(refresh))
  check("S29", "...and it forwards only the metrics the sync actually holds",
    /trackPostPerformance\(\s*postId\s*,\s*\{\s*impressions:\s*synced\.impressions\s*,\s*clicks:\s*synced\.clicks\s*,?\s*\}\s*\)/.test(refresh))
  check("S30", "...engagements is returned for display, not split into fake likes",
    !/likes:\s*synced/.test(refresh) && !/comments:\s*synced/.test(refresh) &&
    !/shares:\s*synced/.test(refresh) && /engagements:/.test(refresh))

  check("S31", "getSocialMediaAnalytics ignores any caller-supplied tenant",
    /_brokerageId\?:\s*string/.test(fnSignature(SOCIAL, "getSocialMediaAnalytics")) &&
    /const\s+brokerageId\s*=\s*ctx\.brokerageId/.test(fnBody(SOCIAL, "getSocialMediaAnalytics")))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 3 — the social dashboard actually calls all four
// ═══════════════════════════════════════════════════════════════════════════

function socialSurfaceLayer() {
  section("[layer 3 · the social dashboard reaches the four orphans]")

  const ui = code(SOCIAL_UI)
  const importBlock = /import\s*\{([\s\S]*?)\}\s*from\s*["']@\/app\/actions\/social-media-automation["']/.exec(ui)?.[1] ?? ""

  for (const [id, fn] of [["S32", "getSocialQueue"], ["S33", "getPublishLog"],
                          ["S34", "getSocialEngagement"], ["S35", "refreshPostEngagementFromSync"]] as const) {
    check(id, `the dashboard imports AND calls ${fn}`,
      new RegExp(`\\b${fn}\\b`).test(importBlock) && callsFn(ui, fn))
  }

  const reload = /const\s+handleReloadQueue\s*=\s*async[\s\S]*?\n  \}/.exec(ui)?.[0] ?? ""
  check("S36", "the Refresh control reads getSocialQueue's verdict, not just its data",
    /if\s*\(result\.ok\)\s*\{[\s\S]{0,120}?setPosts\(result\.posts\)/.test(reload) &&
    /\}\s*else\s*\{[\s\S]{0,200}?setQueueError\(result\.error\)/.test(reload))
  check("S37", "...and a refused reload is shown to the user as a refusal",
    /\{queueError\s*&&\s*\(/.test(ui) && /Could not reload the queue/.test(ui))

  const openLog = /const\s+handleOpenLog\s*=\s*async[\s\S]*?\n  \}/.exec(ui)?.[0] ?? ""
  check("S38", "the delivery-log drawer loads both the attempts and the measurements",
    /getPublishLog\(post\.id\)/.test(openLog) && /getSocialEngagement\(post\.id\)/.test(openLog))
  check("S39", "...and it is reachable from the post menu",
    /onClick=\{\(\)\s*=>\s*handleOpenLog\(post\)\}/.test(ui))

  const pull = /const\s+handlePullMetrics\s*=\s*async[\s\S]*?\n  \}/.exec(ui)?.[0] ?? ""
  check("S40", "the Pull-latest-metrics control calls the sync projection",
    /refreshPostEngagementFromSync\(logPost\.id\)/.test(pull))
  check("S41", "...and reports the server's refusal instead of closing on success",
    /if\s*\(result\.success\)\s*\{[\s\S]{0,600}?\}\s*else\s*\{[\s\S]{0,200}?toast\.error/.test(pull))
  check("S42", "...and it is reachable from the drawer",
    /onClick=\{handlePullMetrics\}/.test(ui))

  section("[layer 3b · the approval queue stops being permanently zero]")

  // social_posts.status cannot hold 'pending_approval'. Every filter on it was
  // a guaranteed zero however many posts were awaiting a broker.
  const counts = /const\s+counts\s*=\s*useMemo\([\s\S]*?\}\),\s*\[posts\]\)/.exec(ui)?.[0] ?? ""
  check("S43", "the Pending Approval count no longer filters a status that cannot exist",
    counts !== "" && !/p\.status\s*===\s*["']pending_approval["']/.test(counts))
  check("S44", "...it counts approval_status === 'pending'",
    /pending_approval:\s*posts\.filter\(p\s*=>\s*p\.approval_status\s*===\s*["']pending["']\)/.test(counts))

  const matches = /const\s+matchesTab\s*=\s*useCallback\([\s\S]*?\},\s*\[\]\)/.exec(ui)?.[0] ?? ""
  check("S45", "...and the tab itself resolves through approval_status",
    /tab === ["']pending_approval["']\)\s*return\s+p\.approval_status\s*===\s*["']pending["']/.test(matches))
  check("S46", "the composer's post-save branch keys on approval_status too",
    /post\?\.approval_status\s*===\s*["']pending["']/.test(ui) &&
    !/post\?\.status\s*===\s*["']pending_approval["']/.test(ui))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 4 — the unified profile finally has a writer, with a lawful basis
// ═══════════════════════════════════════════════════════════════════════════

function profileWriterLayer() {
  section("[layer 4 · the profile the CRM reads finally gets written]")

  const sig = fnSignature(LEAD, "createUnifiedLeadProfile")
  const body = fnBody(LEAD, "createUnifiedLeadProfile")

  // It took raw email/phone from the caller: type any stranger's address and
  // the OS opened a behavioural profile on them. Assert the SIGNATURE.
  check("L1", "createUnifiedLeadProfile takes a contactId, not a raw email/phone",
    sig !== "" && /contactId:\s*string/.test(sig) &&
    !/email\?:\s*string/.test(sig) && !/phone\?:\s*string/.test(sig))
  check("L2", "...the subject is resolved from contacts inside the caller's brokerage",
    /from\(\s*["']contacts["']\s*\)[\s\S]{0,600}?\.eq\(\s*["']id["']\s*,\s*input\.contactId\s*\)[\s\S]{0,200}?\.eq\(\s*["']brokerage_id["']\s*,\s*auth\.brokerageId\s*\)/.test(body))
  check("L3", "...a contact outside the brokerage is refused, not profiled",
    /if\s*\(!contact\)\s*return\s*\{\s*success:\s*false/.test(body))
  check("L4", "...and the email/phone written are the CONTACT's, not the caller's",
    /contact_email:\s*contact\.email/.test(body) && /contact_phone:\s*contact\.phone/.test(body))

  const inserts = writePayloads(body, "unified_lead_profile", "insert")
  check("L5", "the insert stamps brokerage_id AND links contact_id",
    inserts.length === 1 &&
    /brokerage_id:\s*auth\.brokerageId/.test(inserts[0]) &&
    /contact_id:\s*contact\.id/.test(inserts[0]))

  // `const { data } = …` then `profile.id` turned a refusal into a TypeError.
  check("L6", "the insert error is destructured and reported",
    /const\s*\{\s*data:\s*newProfile\s*,\s*error:\s*insertError\s*\}/.test(body) &&
    /if\s*\(insertError\)\s*\{[^}]{0,240}?return\s*\{\s*success:\s*false/.test(body))

  // Both wired readers render `score * 100`. Writing the model's 0–100 raw
  // rendered a 75%-confidence profile as "7500%".
  check("L7", "confidence is normalised to the 0–1 scale both wired readers assume",
    /confidence_score:\s*score100\s*\/\s*100/.test(body))
  check("L8", "...while the temperature thresholds still work off the 0–100 value",
    /temperature:\s*score100\s*>\s*70\s*\?\s*["']hot["']/.test(body))

  // The model returns free text into columns the triage UI must round-trip.
  check("L9", "the model's intent_type is validated against the rail's vocabulary",
    /INTENT_TYPES as readonly string\[\]\)\.includes\(intentType\)[\s\S]{0,120}?patch\.intent_type\s*=\s*intentType/.test(body))
  check("L10", "...as is intent_strength",
    /INTENT_STRENGTHS as readonly string\[\]\)\.includes\(intentStrength\)[\s\S]{0,140}?patch\.intent_strength\s*=\s*intentStrength/.test(body))
  check("L11", "...as is estimated_timeline",
    /TIMELINES as readonly string\[\]\)\.includes\(timeline\)[\s\S]{0,140}?patch\.estimated_timeline\s*=\s*timeline/.test(body))

  section("[layer 4b · consent and provenance travel with the inference]")

  // The profile must never RECOMMEND an outreach the existing consent rail
  // (lib/kernel/compliance.ts:evaluateOutbound) would refuse outright.
  check("L12", "an outreach recommendation is suppressed by the contact's own consent flags",
    /const\s+allChannelsClosed\s*=[\s\S]{0,320}?contact\.dnc_status === true/.test(body) &&
    /ready_for_outreach:\s*allChannelsClosed\s*\?\s*false\s*:/.test(body))

  // Provenance goes to the rail's OWN ledger, not a new parallel one.
  const ledger = writePayloads(body, "intelligence_signals_log", "insert")
  check("L13", "every run writes a provenance row to the rail's existing signal ledger",
    ledger.length === 1 &&
    /brokerage_id:\s*auth\.brokerageId/.test(ledger[0]) &&
    /contact_id:\s*contact\.id/.test(ledger[0]) &&
    /signal_type:\s*["']ai_unified_profile["']/.test(ledger[0]))
  check("L14", "...recording which actor asked and whether consent suppressed outreach",
    ledger.length === 1 &&
    /actor_user_id:\s*auth\.userId/.test(ledger[0]) &&
    /outreach_suppressed_by_consent:\s*allChannelsClosed/.test(ledger[0]))
  check("L15", "...and a failed provenance write fails the whole operation",
    /if\s*\(ledgerError\)\s*\{[^}]{0,400}?return\s*\{\s*success:\s*false/.test(body))

  check("L16", "the profile update reads its verdict and rejects a zero-row match",
    /if\s*\(updateError\)\s*\{[^}]{0,240}?return\s*\{\s*success:\s*false/.test(body) &&
    /if\s*\(!updated\)\s*return\s*\{\s*success:\s*false/.test(body))

  section("[layer 4c · the signals feeding it are read from a column with a writer]")

  const signals = fnBody(LEAD, "getAllSignalsForProfile")
  // behavioral_signals.unified_profile_id and property_intelligence.profile_id
  // have NO WRITER anywhere. Reading only those fed the prompt "[] / []" while
  // looking like it scored on evidence.
  // The `(?:(?!from\()…)` guard stops the wildcard escaping into the SIBLING
  // query. Without it, blanking the behavioural `.or(` was still satisfied by
  // the property `.or(` two statements later — caught by the negative test.
  check("L17", "behavioural signals resolve by contact_id, the column that is written",
    /from\(\s*["']behavioral_signals["']\s*\)(?:(?!from\()[\s\S]){0,300}?\.or\(`contact_id\.eq\.\$\{contactId\}/.test(signals))
  check("L18", "property signals resolve by contact_id too",
    /from\(\s*["']property_intelligence["']\s*\)(?:(?!from\()[\s\S]){0,300}?\.or\(`contact_id\.eq\.\$\{contactId\}/.test(signals))
  check("L19", "...and both are brokerage-scoped, because this is a service client",
    (signals.match(/\.eq\(\s*["']brokerage_id["']\s*,\s*brokerageId\s*\)/g) ?? []).length >= 2 &&
    /createServiceClient\(\)/.test(signals))
  check("L20", "...its read errors are surfaced, not silently coerced to []",
    /error:\s*behavioralError/.test(signals) && /error:\s*propertyError/.test(signals))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 5 — the CRM drawer surfaces it
// ═══════════════════════════════════════════════════════════════════════════

function crmSurfaceLayer() {
  section("[layer 5 · the CRM contact drawer can build a profile]")

  const ui = code(CRM_UI)
  const importBlock = /import\s*\{([\s\S]*?)\}\s*from\s*["']@\/app\/actions\/lead-intelligence["']/.exec(ui)?.[1] ?? ""

  check("L21", "the CRM imports AND calls createUnifiedLeadProfile",
    /\bcreateUnifiedLeadProfile\b/.test(importBlock) && callsFn(ui, "createUnifiedLeadProfile"))

  const handler = /const\s+handleBuildLeadProfile\s*=\s*async[\s\S]*?\n  \}/.exec(ui)?.[0] ?? ""
  check("L22", "...passing the contact id, not an email typed into a box",
    /createUnifiedLeadProfile\(\{\s*contactId:\s*selectedContactId\s*\}\)/.test(handler))
  check("L23", "...and reading the server's verdict before claiming success",
    /if\s*\(result\.success[\s\S]{0,120}?\)\s*\{[\s\S]{0,300}?\}\s*else\s*\{[\s\S]{0,200}?toast\.error/.test(handler))
  check("L24", "...reachable from an actual control",
    /onClick=\{handleBuildLeadProfile\}/.test(ui))

  // unified_lead_profile has no urgency_level column, and the array column is
  // enrichment_sourceS. Both branches read undefined and never rendered.
  check("L25", "the drawer no longer renders the nonexistent urgency_level column",
    !/unifiedLeadProfile\.urgency_level/.test(ui))
  check("L26", "...it renders intent_strength / estimated_timeline instead",
    /unifiedLeadProfile\.intent_strength\s*&&/.test(ui) &&
    /unifiedLeadProfile\.estimated_timeline\s*&&/.test(ui))
  check("L27", "the singular enrichment_source misspelling is gone",
    !/unifiedLeadProfile\.enrichment_source\b(?!s)/.test(ui))
  check("L28", "...replaced by the real text[] column",
    /Array\.isArray\(unifiedLeadProfile\.enrichment_sources\)/.test(ui))

  // "Loading intelligence…" was permanent, because the read always came back
  // empty and nothing could ever fill it.
  check("L29", "the permanent 'Loading intelligence' state is gated on the load actually finishing",
    /!contactIntelligence\s*&&\s*!unifiedLeadProfile\s*&&\s*!unifiedProfileLoaded\s*&&/.test(ui))
  check("L30", "...and an empty result now offers the build action instead of a spinner",
    /unifiedProfileLoaded\s*&&\s*!unifiedLeadProfile\s*&&\s*\(/.test(ui) &&
    /No intelligence profile has been built/.test(ui))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 6 — the hardened-but-dark capabilities stay dark, and stay honest
// ═══════════════════════════════════════════════════════════════════════════

function darkCapabilityLayer() {
  section("[layer 6 · the scrapers are hardened, and NOT surfaced]")

  const zen = fnBody(LEAD, "scrapeSocialSignalsWithZenRows")
  const lead = code(LEAD)

  // The parser returns [] unconditionally, so the paid fetch could never
  // produce a row. Refusing must happen BEFORE the spend.
  check("D1", "the Nextdoor scrape refuses before it can charge for a stub parser",
    /if\s*\(!NEXTDOOR_PARSER_IMPLEMENTED\)\s*\{[^}]{0,600}?return\s*\{[^}]{0,400}?dark:\s*true/.test(zen))
  check("D2", "...the refusal is positioned ahead of the ZenRows call",
    zen.indexOf("NEXTDOOR_PARSER_IMPLEMENTED") > -1 &&
    zen.indexOf("NEXTDOOR_PARSER_IMPLEMENTED") < zen.indexOf("callConnector"))
  check("D3", "...and the gate constant is genuinely false",
    /const\s+NEXTDOOR_PARSER_IMPLEMENTED\s*=\s*false/.test(lead))
  check("D4", "...the parser really is still a stub, so the gate is not theatre",
    /function parseNextdoorPosts[\s\S]{0,1200}?return\s*\[\]\s*\n\}/.test(lead))

  section("[layer 6b · provenance columns state the truth]")

  const ext = fnBody(LEAD, "scrapeExternalBehavior")
  const extInserts = writePayloads(ext, "external_behavior", "insert")
  // This lane calls Apify (scrapeZillow / scrapeRealtorDotCom / scrapeRedfin)
  // and hard-coded detected_via_zenrows: true on every row.
  check("D5", "the Apify lane no longer labels its rows as ZenRows-collected",
    extInserts.length === 1 && /detected_via_zenrows:\s*false/.test(extInserts[0]))
  check("D6", "...and it really is the Apify lane",
    /apify\.scrapeZillow\(/.test(ext) && !/zenrows\./.test(ext))

  const trackExt = fnBody(LEAD, "trackExternalActivity")
  const trackInserts = writePayloads(trackExt, "external_behavior", "insert")
  check("D7", "trackExternalActivity states its collection vendor instead of asserting one",
    trackInserts.length === 1 &&
    /detected_via_zenrows:\s*data\.detectedViaZenrows\s*===\s*true/.test(trackInserts[0]))
  // The parameter existed and was dropped on the floor; the column had no writer.
  check("D8", "...and the searchCriteria argument reaches the column that had no writer",
    trackInserts.length === 1 && /search_criteria_json:\s*data\.searchCriteria/.test(trackInserts[0]))
  check("D9", "...its visitor lookup is tenant-scoped on a service client",
    /from\(\s*["']behavioral_signals["']\s*\)[\s\S]{0,300}?\.eq\(\s*["']visitor_id["']\s*,\s*data\.visitorId\s*\)[\s\S]{0,200}?\.eq\(\s*["']brokerage_id["']\s*,\s*auth\.brokerageId\s*\)/.test(trackExt))
  check("D10", "...and both of its writes report their errors",
    /if\s*\(behaviorError\)\s*\{[^}]{0,240}?return\s*\{\s*success:\s*false/.test(trackExt) &&
    /if\s*\(bumpError\)\s*\{[^}]{0,240}?return\s*\{\s*success:\s*false/.test(trackExt))

  section("[layer 6c · the visitor pixel cannot write an untenanted row]")

  const track = fnBody(LEAD, "trackBehavior")
  // behavioral_signals' RLS policy is `brokerage_id IS NULL OR = current…`,
  // so a NULL-stamped row of IP addresses is readable by EVERY brokerage.
  check("D11", "trackBehavior refuses to write without a brokerage",
    /if\s*\(!isValidUUID\(sessionData\.brokerage_id\)\)\s*\{[^}]{0,600}?return\s*\{\s*success:\s*false/.test(track))
  check("D12", "...and no write in it can stamp a null tenant any more",
    track !== "" && !/brokerage_id:[^,\n]*\?\?\s*null/.test(track))
  check("D13", "...its signal insert stamps the resolved tenant",
    (writePayloads(track, "behavioral_signals", "insert")[0] ?? "").includes("brokerage_id: brokerageId"))
  check("D14", "...the visitor lookup is scoped so ids cannot collide across tenants",
    /from\(\s*["']behavioral_signals["']\s*\)[\s\S]{0,300}?\.eq\(\s*["']visitor_id["']\s*,\s*sessionData\.visitor_id\s*\)[\s\S]{0,200}?\.eq\(\s*["']brokerage_id["']\s*,\s*brokerageId\s*\)/.test(track))
  check("D15", "...and the non-null assertion on a possibly-refused insert is gone",
    track !== "" && !/newSignal!\./.test(track) &&
    /if\s*\(newSignalError\)\s*\{[^}]{0,240}?return\s*\{\s*success:\s*false/.test(track))

  section("[layer 6d · dark providers are shown dark, never faked]")

  const gsi = fnBody(LEAD, "analyzeGoogleSearchIntent")
  check("D16", "the Google sampler refuses when ZenRows is unconfigured",
    /if\s*\(!process\.env\.ZENROWS_API_KEY\)\s*\{[^}]{0,400}?dark:\s*true/.test(gsi))
  check("D17", "...and the refusal precedes the paid loop",
    gsi.indexOf("ZENROWS_API_KEY") < gsi.indexOf("zenrows.googleSearch"))
  check("D18", "...a failed insert no longer lets the whole paid run report success",
    /const\s*\{\s*error:\s*insertError\s*\}\s*=\s*await\s+supabase\.from\(\s*["']google_search_intelligence["']/.test(gsi) &&
    /if\s*\(insertError\)\s*\{[^}]{0,300}?return\s*\{\s*success:\s*false/.test(gsi))

  const enrich = fnBody(LEAD, "enrichPropertyIntelligence")
  check("D19", "property enrichment refuses when BatchData is unconfigured",
    /if\s*\(!process\.env\.BATCHDATA_API_KEY\)\s*\{[^}]{0,400}?dark:\s*true/.test(enrich))
  check("D20", "...it actually calls BatchData now, instead of claiming to in a comment",
    /new BatchDataClient\(\)/.test(enrich) && /batchData\.searchByAddress\(/.test(enrich))
  check("D21", "...no match writes NOTHING rather than a row of nulls",
    /if\s*\(!match\)\s*\{[^}]{0,300}?return\s*\{\s*success:\s*false/.test(enrich))

  const enrichRow = /const\s+row:\s*Record<string,\s*unknown>\s*=\s*\{/.exec(enrich)
  const rowLiteral = enrichRow
    ? enrich.slice(enrichRow.index + enrichRow[0].length - 1,
        matchBrace(enrich, enrichRow.index + enrichRow[0].length - 1) + 1)
    : ""
  check("D22", "...the provenance label is the vendor it came from, not 'manual_entry'",
    /data_sources:\s*\[\s*["']batchdata["']\s*\]/.test(rowLiteral) &&
    !/manual_entry/.test(rowLiteral))
  check("D23", "...and it never persists the owner's identity",
    rowLiteral !== "" && !/owner_name/.test(rowLiteral) && !/owner_occupied/.test(rowLiteral))
  check("D24", "...it stamps the tenant at the insert",
    /brokerage_id:\s*auth\.brokerageId/.test(rowLiteral))
}

// ═══════════════════════════════════════════════════════════════════════════
// LAYER 7 — the not-wired stay not-wired (a regression guard, inverted)
// ═══════════════════════════════════════════════════════════════════════════

function stayDarkLayer() {
  section("[layer 7 · nothing surfaced what must not be surfaced]")

  // These four must have NO caller outside their own module. If a later pass
  // wires one, this fails loudly and the compliance reasoning gets re-read.
  const surfaces = [SOCIAL_UI, CRM_UI].map(code).join("\n")
  const leadImports =
    (/import\s*\{([\s\S]*?)\}\s*from\s*["']@\/app\/actions\/lead-intelligence["']/.exec(code(CRM_UI))?.[1] ?? "")

  for (const [id, fn, why] of [
    ["N1", "scrapeSocialSignalsWithZenRows", "stub parser + named rival social-sourcer"],
    ["N2", "scrapeExternalBehavior", "persists named-homeowner financial data with no lawful basis"],
    ["N3", "trackBehavior", "no consent artifact recorded at collection"],
    ["N4", "analyzeGoogleSearchIntent", "google_search_intelligence has no reader"],
    ["N5", "enrichPropertyIntelligence", "no address-entry surface records why"],
    ["N6", "trackExternalActivity", "its only producer, trackBehavior, is dark"],
  ] as const) {
    check(id, `${fn} is still unsurfaced (${why})`,
      !new RegExp(`\\b${fn}\\b`).test(leadImports) && !callsFn(surfaces, fn))
  }

  // Nothing was deleted. Every one of the eleven is still exported.
  const socialSrc = code(SOCIAL)
  const leadSrc = code(LEAD)
  const stillExported = [
    ...["trackBehavior", "scrapeSocialSignalsWithZenRows", "enrichPropertyIntelligence",
        "analyzeGoogleSearchIntent", "createUnifiedLeadProfile", "scrapeExternalBehavior",
        "trackExternalActivity"].map((n) => [n, leadSrc] as const),
    ...["getSocialQueue", "getSocialEngagement", "getPublishLog", "trackPostPerformance"]
        .map((n) => [n, socialSrc] as const),
  ]
  check("N7", "all eleven capabilities still exist — nothing was deleted",
    stillExported.every(([n, s]) => new RegExp(`export async function ${n}\\s*\\(`).test(s)))

  // A "use server" module may only export async functions.
  const badExports = [socialSrc, leadSrc].flatMap((s) =>
    Array.from(s.matchAll(/^export\s+(const|let|var|class)\s+(\w+)/gm)).map((m) => m[2]))
  check("N8", "no non-function value is exported from a 'use server' module",
    badExports.length === 0)
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNER
// ═══════════════════════════════════════════════════════════════════════════

function runAll() {
  results = []
  clearCaches()
  stripperSelfTest()
  socialReadLayer()
  engagementWriteLayer()
  socialSurfaceLayer()
  profileWriterLayer()
  crmSurfaceLayer()
  darkCapabilityLayer()
  stayDarkLayer()
  return results
}

// ═══════════════════════════════════════════════════════════════════════════
// NEGATIVE TESTS — an assertion that cannot be made to fail is worthless
// ═══════════════════════════════════════════════════════════════════════════

interface Mutation { id: string; file: string; find: string; replace: string; note: string }

const MUTATIONS: Mutation[] = [
  { id: "S3", file: SOCIAL, note: "drop the queue's tenant filter",
    find: `.eq("brokerage_id", ctx.brokerageId)\n    .order("scheduled_for", { ascending: true })`,
    replace: `.order("scheduled_for", { ascending: true })` },

  { id: "S4", file: SOCIAL, note: "render a refused queue read as an empty queue",
    find: `    console.error("[social-media-automation] Get social queue error:", error)\n    return { ok: false, error: error.message }`,
    replace: `    console.error("[social-media-automation] Get social queue error:", error)\n    return { ok: true, posts: [] }` },

  { id: "S9", file: SOCIAL, note: "re-add the phantom status to the vocabulary",
    find: `  "draft", "scheduled", "publishing", "published", "failed", "cancelled",`,
    replace: `  "draft", "scheduled", "publishing", "published", "failed", "cancelled", "pending_approval",` },

  { id: "S14", file: SOCIAL, note: "let a bare postId read another tenant's publish log",
    find: `  const owned = await verifySocialPostInBrokerage(postId, ctx.brokerageId)\n  if (!owned.ok) return { ok: false, error: "Post not found" }\n\n  const supabase = await createClient()\n\n  const { data, error } = await supabase\n    .from("social_publish_log")`,
    replace: `  const supabase = await createClient()\n\n  const { data, error } = await supabase\n    .from("social_publish_log")` },

  { id: "S23", file: SOCIAL, note: "write 0 for a metric the platform never reported",
    find: `    if (value === undefined || value === null) continue`,
    replace: `    if (value === undefined) continue` },

  { id: "S24", file: SOCIAL, note: "discard the engagement write verdict",
    find: `  if (written.error) {\n    console.error("[social-media-automation] Track performance write error:", written.error)\n    return { success: false, error: written.error.message }\n  }`,
    replace: `  if (written.error) {\n    console.error("[social-media-automation] Track performance write error:", written.error)\n  }` },

  { id: "S29", file: SOCIAL, note: "fabricate a likes breakdown from the sync's engagements total",
    find: `  const result = await trackPostPerformance(postId, {\n    impressions: synced.impressions,\n    clicks: synced.clicks,\n  })`,
    replace: `  const result = await trackPostPerformance(postId, {\n    impressions: synced.impressions,\n    clicks: synced.clicks,\n    likes: synced.engagements,\n  })` },

  { id: "S44", file: SOCIAL_UI, note: "return the approval count to the impossible status",
    find: `    pending_approval: posts.filter(p => p.approval_status === "pending").length,`,
    replace: `    pending_approval: posts.filter(p => p.status === "pending_approval").length,` },

  { id: "L2", file: LEAD, note: "profile a contact from any tenant",
    find: `    .eq("id", input.contactId)\n    .eq("brokerage_id", auth.brokerageId)\n    .maybeSingle()\n\n  if (contactError) {`,
    replace: `    .eq("id", input.contactId)\n    .maybeSingle()\n\n  if (contactError) {` },

  { id: "L7", file: LEAD, note: "write the model's 0-100 into a column the UI multiplies by 100",
    find: `      confidence_score: score100 / 100,`,
    replace: `      confidence_score: score100,` },

  { id: "L12", file: LEAD, note: "recommend outreach to a DNC contact",
    find: `      ready_for_outreach: allChannelsClosed ? false : Boolean(intelligenceAny.ready_for_outreach),`,
    replace: `      ready_for_outreach: Boolean(intelligenceAny.ready_for_outreach),` },

  { id: "L15", file: LEAD, note: "keep an AI inference whose provenance failed to record",
    find: `      return { success: false, error: \`Profile saved but provenance failed: \${ledgerError.message}\` }`,
    replace: `      void ledgerError` },

  { id: "L5", file: LEAD, note: "create a profile with no contact link",
    find: `        contact_id: contact.id,\n        lead_source: leadSource,`,
    replace: `        lead_source: leadSource,` },

  { id: "L6", file: LEAD, note: "swallow a refused profile insert",
    find: `    if (insertError) {\n      console.error("[lead-intelligence] Profile insert error:", insertError)\n      return { success: false, error: insertError.message }\n    }`,
    replace: `    if (insertError) {\n      console.error("[lead-intelligence] Profile insert error:", insertError)\n    }` },

  { id: "L9", file: LEAD, note: "let a hallucinated intent_type reach the column",
    find: `    if (typeof intentType === "string" && (INTENT_TYPES as readonly string[]).includes(intentType)) {\n      patch.intent_type = intentType\n    }`,
    replace: `    patch.intent_type = intentType` },

  { id: "L13", file: LEAD, note: "run the inference without writing a provenance row",
    find: `      signal_type: "ai_unified_profile",`,
    replace: `      signal_type: "something_else",` },

  { id: "L17", file: LEAD, note: "go back to reading a column with no writer",
    find: `        .or(\`contact_id.eq.\${contactId},unified_profile_id.eq.\${profileId}\`)`,
    replace: `        .eq("unified_profile_id", profileId)` },

  { id: "L18", file: LEAD, note: "read property signals through a column with no writer",
    find: `        .or(\`contact_id.eq.\${contactId},profile_id.eq.\${profileId}\`)`,
    replace: `        .eq("profile_id", profileId)` },

  { id: "L22", file: CRM_UI, note: "pass something other than the contact id to the profiler",
    find: `    const result = await createUnifiedLeadProfile({ contactId: selectedContactId }).catch(`,
    replace: `    const result = await createUnifiedLeadProfile({ contactId: String(user?.id) }).catch(` },

  { id: "L29", file: CRM_UI, note: "restore the permanent 'Loading intelligence' state",
    find: `                    {!contactIntelligence && !unifiedLeadProfile && !unifiedProfileLoaded && (`,
    replace: `                    {!contactIntelligence && !unifiedLeadProfile && (` },

  { id: "S1", file: SOCIAL, note: "take the queue's tenant from the browser again",
    find: `export async function getSocialQueue(filters?: {`,
    replace: `export async function getSocialQueue(brokerageId: string, filters?: {` },

  { id: "S5", file: SOCIAL, note: "accept a status the column cannot hold",
    find: `  if (filters?.status && !(SOCIAL_POST_STATUSES as readonly string[]).includes(filters.status)) {\n    return { ok: false, error: \`Unsupported status filter: \${filters.status}\` }\n  }`,
    replace: `` },

  { id: "S12", file: SOCIAL, note: "let a bare postId read another tenant's engagement",
    find: `  const owned = await verifySocialPostInBrokerage(postId, ctx.brokerageId)\n  if (!owned.ok) return { ok: false, error: "Post not found" }\n\n  const supabase = await createClient()\n\n  const { data, error } = await supabase\n    .from("social_engagement_tracking")`,
    replace: `  const supabase = await createClient()\n\n  const { data, error } = await supabase\n    .from("social_engagement_tracking")` },

  { id: "S19", file: SOCIAL, note: "bring back the conflict-target-less upsert",
    find: `        .insert({\n          social_post_id: postId,\n          brokerage_id: ctx.brokerageId,`,
    replace: `        .upsert({\n          social_post_id: postId,\n          brokerage_id: ctx.brokerageId,` },

  { id: "S21", file: SOCIAL, note: "resolve the post without a tenant anchor",
    find: `    .eq("id", postId)\n    .eq("brokerage_id", ctx.brokerageId)\n    .maybeSingle()\n\n  if (postError) {`,
    replace: `    .eq("id", postId)\n    .maybeSingle()\n\n  if (postError) {` },

  { id: "S22", file: SOCIAL, note: "drop the tenant stamp from the measurement insert",
    find: `          social_post_id: postId,\n          brokerage_id: ctx.brokerageId,\n          platform: post.platform,`,
    replace: `          social_post_id: postId,\n          platform: post.platform,` },

  { id: "S28", file: SOCIAL, note: "write zeros when the sync has measured nothing",
    find: `      reason: "no_measurement",`,
    replace: `      reason: undefined as never,` },

  { id: "S31", file: SOCIAL, note: "trust the caller's tenant in the analytics read",
    find: `  const ctx = await requireBrokerage()\n  if (!ctx.ok) return null\n  const brokerageId = ctx.brokerageId`,
    replace: `  const brokerageId = _brokerageId as string` },

  { id: "S36", file: SOCIAL_UI, note: "ignore the queue reload's verdict",
    find: `    if (result.ok) {\n      setPosts(result.posts)\n    } else {\n      setQueueError(result.error)\n      toast.error(result.error)\n    }`,
    replace: `    if (result.ok) setPosts(result.posts)` },

  { id: "S39", file: SOCIAL_UI, note: "remove the delivery log's entry point",
    find: `                              <DropdownMenuItem onClick={() => handleOpenLog(post)}>`,
    replace: `                              <DropdownMenuItem>` },

  { id: "S45", file: SOCIAL_UI, note: "route the approval tab back through status",
    find: `    if (tab === "pending_approval") return p.approval_status === "pending"`,
    replace: `    if (tab === "pending_approval") return p.status === "pending_approval"` },

  { id: "D1", file: LEAD, note: "pay ZenRows while the parser still returns []",
    find: `  if (!NEXTDOOR_PARSER_IMPLEMENTED) {`,
    replace: `  if (false) {` },

  { id: "D8", file: LEAD, note: "drop the caller's search criteria on the floor again",
    find: `      search_criteria_json: data.searchCriteria ?? null,`,
    replace: `` },

  { id: "D14", file: LEAD, note: "let a visitor id collide across tenants",
    find: `      .eq("visitor_id", sessionData.visitor_id)\n      .eq("brokerage_id", brokerageId)`,
    replace: `      .eq("visitor_id", sessionData.visitor_id)` },

  { id: "D16", file: LEAD, note: "present an unconfigured ZenRows as live",
    find: `  if (!process.env.ZENROWS_API_KEY) {`,
    replace: `  if (false) {` },

  { id: "D19", file: LEAD, note: "present an unconfigured BatchData as live",
    find: `  if (!process.env.BATCHDATA_API_KEY) {`,
    replace: `  if (false) {` },

  { id: "D22", file: LEAD, note: "mislabel a BatchData pull as manual entry",
    find: `      data_sources: ["batchdata"],`,
    replace: `      data_sources: ["manual_entry"],` },

  { id: "N4", file: CRM_UI, note: "surface the dark Google sampler on a screen",
    find: `import { getUnifiedLeadProfiles, getSocialIntelligence, createUnifiedLeadProfile } from "@/app/actions/lead-intelligence"`,
    replace: `import { getUnifiedLeadProfiles, getSocialIntelligence, createUnifiedLeadProfile, analyzeGoogleSearchIntent } from "@/app/actions/lead-intelligence"` },

  { id: "L19", file: LEAD, note: "let a service client read every tenant's signals",
    find: `  ).eq("brokerage_id", brokerageId)\n\n  const propertyQuery = (`,
    replace: `  )\n\n  const propertyQuery = (` },

  { id: "L25", file: CRM_UI, note: "restore the render branch on a column that does not exist",
    find: `                            {unifiedLeadProfile.intent_strength && (`,
    replace: `                            {unifiedLeadProfile.urgency_level && (` },

  { id: "D3", file: LEAD, note: "open the paid Nextdoor fetch while the parser is still a stub",
    find: `const NEXTDOOR_PARSER_IMPLEMENTED = false`,
    replace: `const NEXTDOOR_PARSER_IMPLEMENTED = true` },

  { id: "D5", file: LEAD, note: "re-label the Apify lane's rows as ZenRows-collected",
    find: `        detected_via_zenrows: false,\n        scraped_at: new Date().toISOString(),\n      })\n\n      // Store enriched property intelligence`,
    replace: `        detected_via_zenrows: true,\n        scraped_at: new Date().toISOString(),\n      })\n\n      // Store enriched property intelligence` },

  { id: "D11", file: LEAD, note: "let the visitor pixel write an untenanted PII row again",
    find: `  if (!isValidUUID(sessionData.brokerage_id)) {`,
    replace: `  if (false && !isValidUUID(sessionData.brokerage_id)) {` },

  { id: "D23", file: LEAD, note: "persist the homeowner's identity from a public-records pull",
    find: `      data_sources: ["batchdata"],`,
    replace: `      owner_name: match.owner?.name ?? null,\n      data_sources: ["batchdata"],` },

  { id: "N1", file: CRM_UI, note: "surface the stub scraper on a screen",
    find: `import { getUnifiedLeadProfiles, getSocialIntelligence, createUnifiedLeadProfile } from "@/app/actions/lead-intelligence"`,
    replace: `import { getUnifiedLeadProfiles, getSocialIntelligence, createUnifiedLeadProfile, scrapeSocialSignalsWithZenRows } from "@/app/actions/lead-intelligence"` },
]

function negativeTests(): { ran: number; proved: number; problems: string[] } {
  const problems: string[] = []
  let proved = 0

  for (const mut of MUTATIONS) {
    const abs = join(process.cwd(), mut.file)
    const original = readFileSync(abs, "utf8")
    const shaBefore = sha(mut.file)

    if (!original.includes(mut.find)) {
      problems.push(`[${mut.id}] mutation anchor not found in ${mut.file} — the negative test did not run`)
      continue
    }

    writeFileSync(abs, original.replace(mut.find, mut.replace), "utf8")
    const shaAfter = sha(mut.file)

    try {
      if (shaAfter === shaBefore) {
        problems.push(`[${mut.id}] mutation did not change the file (sha256 identical) — not a real test`)
        continue
      }

      quiet = true
      const mutated = runAll()
      quiet = false

      const target = mutated.find((r) => r.id === mut.id)
      if (!target) {
        problems.push(`[${mut.id}] check id does not exist`)
      } else if (target.ok) {
        problems.push(`[${mut.id}] SURVIVED "${mut.note}" — the assertion cannot fail, so it proves nothing`)
      } else {
        proved++
        console.log(`  ✓ [${mut.id}] fails when: ${mut.note}`)
      }
    } finally {
      writeFileSync(abs, original, "utf8")
      const shaRestored = sha(mut.file)
      if (shaRestored !== shaBefore) {
        problems.push(`[${mut.id}] RESTORE FAILED for ${mut.file} — sha256 ${shaRestored} != ${shaBefore}`)
      }
    }
  }

  return { ran: MUTATIONS.length, proved, problems }
}

// ═══════════════════════════════════════════════════════════════════════════
// COVERAGE SWEEP — every positive assertion must depend on real source
// ═══════════════════════════════════════════════════════════════════════════
//
// The hand-written mutations above prove an assertion is TIGHT ENOUGH to catch
// a plausible regression. This sweep proves the complementary thing about
// EVERY assertion: that it reads the construct it claims to read. Each file is
// blanked in turn and the checks that own it must all fail.
//
// Checks written as a pure negation ("this misspelling is gone") pass on a
// blank file by construction — that is what vacuous truth looks like — so they
// are listed as VACUOUS_ON_BLANK and each is paired with a positive assertion
// that does fail, which is named here so the pairing cannot rot silently.

const OWNERSHIP: Record<string, string[]> = {
  [SOCIAL]: [
    "SELF-4", "S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S10", "S11",
    "S12", "S13", "S14", "S15", "S16", "S17", "S18", "S20", "S21", "S22",
    "S24", "S25", "S26", "S27", "S28", "S29", "S31", "N7",
  ],
  [SOCIAL_UI]: [
    "S32", "S33", "S34", "S35", "S36", "S37", "S38", "S39", "S40", "S41",
    "S42", "S44", "S45",
  ],
  [LEAD]: [
    "L1", "L2", "L3", "L4", "L5", "L6", "L7", "L8", "L9", "L10", "L11",
    "L12", "L13", "L14", "L15", "L16", "L17", "L18", "L19", "L20",
    "D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D10",
    "D11", "D13", "D14", "D15", "D16", "D17", "D18", "D19", "D20", "D21",
    "D22", "D24", "N7",
  ],
  [CRM_UI]: ["L21", "L22", "L23", "L24", "L26", "L28", "L29", "L30"],
}

/** id -> the positive assertion that carries its weight on a blank file. */
const VACUOUS_ON_BLANK: Record<string, string> = {
  "S9": "S8 (the vocabulary must EQUAL the live CHECK constraint)",
  "S19": "S20 (the read-then-update-or-insert must be present)",
  "S23": "S20 + S22 (the patch loop and the stamped insert must be present)",
  "S30": "S29 (only impressions+clicks may be forwarded)",
  "S43": "S44 (the count must resolve through approval_status)",
  "S46": "S45 (the tab must resolve through approval_status)",
  "L25": "L26 (intent_strength / estimated_timeline must be rendered)",
  "L27": "L28 (the text[] column must be rendered)",
  "D12": "D13 (the signal insert must stamp the resolved tenant)",
  "D23": "D22 + D24 (the row literal must exist and be labelled batchdata)",
  "N1": "N7 (the capability must still exist to be un-surfaced)",
  "N2": "N7", "N3": "N7", "N4": "N7", "N5": "N7", "N6": "N7",
  "N8": "N7 (a blank module exports nothing, so the lint passes trivially)",
  "SELF-1": "SELF-3 (the stripper self-test does not read project source)",
  "SELF-2": "SELF-3",
  "SELF-3": "n/a — operates on an inline fixture, not project source",
}

function coverageSweep(): { checked: number; problems: string[] } {
  const problems: string[] = []
  let checked = 0

  const allIds = runAll().map((r) => r.id)
  const owned = new Set(Object.values(OWNERSHIP).flat())
  for (const id of allIds) {
    if (!owned.has(id) && !(id in VACUOUS_ON_BLANK)) {
      problems.push(`[${id}] is neither owned by a file nor declared vacuous-on-blank`)
    }
  }

  for (const file of ALL_FILES) {
    const abs = join(process.cwd(), file)
    const original = readFileSync(abs, "utf8")
    const shaBefore = sha(file)
    writeFileSync(abs, "export {}\n", "utf8")
    try {
      if (sha(file) === shaBefore) {
        problems.push(`blanking ${file} did not change it — sweep invalid`)
        continue
      }
      quiet = true
      const blanked = runAll()
      quiet = false
      for (const id of OWNERSHIP[file]) {
        checked++
        const r = blanked.find((x) => x.id === id)
        if (!r) problems.push(`[${id}] declared for ${file} but no such check exists`)
        else if (r.ok) problems.push(`[${id}] STILL PASSES with ${file} blanked — it does not read that file`)
      }
    } finally {
      writeFileSync(abs, original, "utf8")
      if (sha(file) !== shaBefore) problems.push(`RESTORE FAILED for ${file}`)
    }
  }

  return { checked, problems }
}

// ═══════════════════════════════════════════════════════════════════════════
// OPTIONAL LIVE LAYER — skips LOUDLY, and a skip is not a pass
// ═══════════════════════════════════════════════════════════════════════════

async function liveLayer(): Promise<"ran" | "skipped"> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!url || !key) {
    console.log("\n" + "!".repeat(74))
    console.log("!! LIVE LAYER SKIPPED — no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.")
    console.log("!! A SKIP IS NOT A PASS. The vocabularies and nullability asserted above were")
    console.log("!! read from project hrvaqgvukzxfskkcrwbt on 2026-08-05 and are hard-coded here;")
    console.log("!! if the schema has moved since, this run cannot tell you.")
    console.log("!".repeat(74))
    return "skipped"
  }

  const { createClient: sb } = await import("@supabase/supabase-js")
  const db = sb(url, key, { auth: { persistSession: false } })

  console.log("\n[live · vocabularies re-read from the database]")

  const { data, error } = await db.rpc("exec_sql" as never, {} as never).then(
    () => ({ data: null, error: null }),
    () => ({ data: null, error: null })
  )
  void data; void error

  // No arbitrary-SQL RPC is guaranteed to exist, so probe the constraint the
  // cheap way: a value the CHECK refuses must be refused.
  const { error: refuseErr } = await db
    .from("social_posts")
    .insert({ platform: "facebook", post_type: "custom", status: "pending_approval" })
    .select()
  const refused = !!refuseErr
  check("LIVE-1", "social_posts.status still refuses 'pending_approval' (23514)", refused)
  if (!refused) {
    console.log("  !! a 'pending_approval' row was ACCEPTED — clean it up and re-read the constraint")
  }

  const { count, error: countErr } = await db
    .from("social_posts")
    .select("*", { count: "exact", head: true })
    .eq("status", "pending_approval")
  check("LIVE-2", "no residue row was left behind by the probe",
    !countErr && (count ?? 0) === 0)

  return "ran"
}

// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log("=".repeat(74))
  console.log("LEAD-INTELLIGENCE / SOCIAL-AUTOMATION WIRING SIMULATOR")
  console.log("=".repeat(74))

  const first = runAll()
  const passed = first.filter((r) => r.ok).length
  const failed = first.filter((r) => !r.ok)

  console.log("\n" + "-".repeat(74))
  console.log(`STATIC ASSERTIONS: ${passed}/${first.length} passed`)
  if (failed.length) {
    console.log("FAILED:")
    for (const f of failed) console.log(`  ✗ [${f.id}] ${f.label}`)
  }

  console.log("\n" + "-".repeat(74))
  console.log("NEGATIVE TESTS — mutating real source, proving each check can fail")
  const neg = negativeTests()
  console.log(`\nNEGATIVE TESTS: ${neg.proved}/${neg.ran} assertions proven falsifiable`)
  if (neg.problems.length) {
    console.log("PROBLEMS:")
    for (const p of neg.problems) console.log(`  ✗ ${p}`)
  }

  console.log("\n" + "-".repeat(74))
  console.log("COVERAGE SWEEP — blanking each file, every assertion that owns it must fail")
  const sweep = coverageSweep()
  console.log(`COVERAGE SWEEP: ${sweep.checked} assertions proven to read real source`)
  console.log(`  (${Object.keys(VACUOUS_ON_BLANK).length} assertions are pure negations and pass on a`)
  console.log(`   blank file by construction — each is paired with a positive assertion above)`)
  if (sweep.problems.length) {
    console.log("PROBLEMS:")
    for (const p of sweep.problems) console.log(`  ✗ ${p}`)
  }

  // Re-run clean to prove the restores put everything back.
  const after = runAll()
  const afterPassed = after.filter((r) => r.ok).length
  const restoredClean = afterPassed === passed && after.length === first.length
  console.log(`\nPOST-RESTORE RE-RUN: ${afterPassed}/${after.length} passed ` +
    `(${restoredClean ? "identical to the first run" : "DIFFERENT — a restore leaked"})`)

  const live = await liveLayer()

  console.log("\n" + "=".repeat(74))
  const ok = failed.length === 0 && neg.problems.length === 0 &&
    sweep.problems.length === 0 && restoredClean
  console.log(ok ? "RESULT: PASS" : "RESULT: FAIL")
  if (live === "skipped") console.log("(live layer skipped — see the banner above; a skip is not a pass)")
  console.log("=".repeat(74))

  process.exit(ok ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
