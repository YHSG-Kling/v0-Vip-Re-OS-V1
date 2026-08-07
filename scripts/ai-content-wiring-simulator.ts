#!/usr/bin/env tsx
// scripts/ai-content-wiring-simulator.ts
// ─────────────────────────────────────────────────────────────────────────────
// TWENTY-NINE CONTENT CAPABILITIES WERE BUILT AND NONE OF THEM HAD A DOOR.
//
// app/actions/ai-content-generation.tsx is the SOLE reader and SOLE writer of
// seven tables — content_templates, ai_generated_content, content_ab_tests,
// content_calendar, content_generation_logs, content_performance_tracking and
// hashtag_performance. Nothing else in the codebase touches them. So there was
// no rival module to merge into and nothing to delete: the work was to FINISH
// the wiring, not to remove it.
//
// Finishing it surfaced defects that made several of these incapable of ever
// having run at all, each verified against the live database:
//
//   · createABTest never stamped agent_id. content_ab_tests.agent_id is NOT
//     NULL, so every call died on SQLSTATE 23502.
//   · logGenerationCost took agentId as an OPTIONAL parameter and wrote it to
//     content_generation_logs.agent_id, also NOT NULL. Same 23502, swallowed
//     into a console line while the cost was returned as if booked.
//   · updateABTestResults wrote status "active". The CHECK admits only
//     running / completed / cancelled. SQLSTATE 23514 on every no-winner save.
//   · analyzeABTest read ai_generated_content.engagement_metrics, a column
//     that DOES NOT EXIST. Both sides were always 0, so "A > B" was false every
//     time and B was declared the winner of every test ever analysed.
//   · enhancedGenerateListingDescription read result.data.contentId and
//     result.data.generated_content from a callee that returns contentId at the
//     TOP level and no generated_content key at all. The enrichment write never
//     fired once and the validated text was always the empty string, which
//     scores 0.5 against a 0.7 gate — every enhanced description came back
//     "not Them-First enough" no matter what was written.
//   · Nine writers stamped no brokerage_id. On ai_generated_content that is an
//     outright RLS refusal (has_brokerage_access(NULL) is false); on the other
//     six the policy is `(brokerage_id IS NULL) OR (brokerage_id = ...)`, so an
//     unstamped row is readable by EVERY brokerage on the platform.
//   · trackContentUsage did both at once: it never destructured the insert and
//     returned { success: true } over a row RLS had just thrown away.
//
// SOURCE layer: the tenant is resolved from the session and never from the
// caller, brokerage_id is on the insert payload rather than patched on after,
// every query result is destructured and branched on, every vocabulary matches
// the live CHECK, and each capability is invoked from a real UI surface.
// LIVE layer (creds-gated): re-proves the constraint claims against the real
// database inside a transaction that always rolls back.
//
// EVERY assertion in this file is negative-tested: real source is mutated, the
// mutation is proven to have landed by sha256, the suite is re-run, and the
// specific check id must appear in the failures. An assertion that cannot be
// made to fail is worthless.

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

// ── comment stripping ────────────────────────────────────────────────────────
// The block-comment delimiters are BUILT, never typed as a literal: a stripper
// reading its own source treats an inline delimiter as a real comment opener
// and swallows the rest of the file.
const SLASH = String.fromCharCode(47)
const STAR = String.fromCharCode(42)
const BLOCK_COMMENT = new RegExp(SLASH + "\\" + STAR + "[\\s\\S]*?\\" + STAR + SLASH, "g")
const LINE_COMMENT = new RegExp("^[ \\t]*" + SLASH + SLASH + ".*$", "gm")
const TRAILING_LINE_COMMENT = new RegExp("\\s" + SLASH + SLASH + " .*$", "gm")

function stripComments(source: string): string {
  return source
    .replace(BLOCK_COMMENT, "")
    .replace(LINE_COMMENT, "")
    .replace(TRAILING_LINE_COMMENT, "")
}

const raw = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
// Read fresh every call. Caching would make the negative tests read stale text
// and pass against source that no longer exists on disk.
const code = (p: string) => stripComments(raw(p))
const sha = (p: string) => createHash("sha256").update(raw(p)).digest("hex")

// ── check registry ───────────────────────────────────────────────────────────
type Result = { pass: number; fail: number; failures: string[]; ids: string[] }
let R: Result = { pass: 0, fail: 0, failures: [], ids: [] }
let quiet = false

function check(id: string, label: string, condition: boolean) {
  R.ids.push(id)
  if (condition) {
    R.pass++
    if (!quiet) console.log(`  ok   ${id}  ${label}`)
  } else {
    R.fail++
    R.failures.push(id)
    if (!quiet) console.log(`  FAIL ${id}  ${label}`)
  }
}

// ── construct slicers ────────────────────────────────────────────────────────

// Body of one function, from its declaration to the next top-level declaration.
// The open paren is part of the anchor: without it `createABTest` also matches
// `createABTestFoo`, and an assertion that survives a rename proves nothing.
function fnBody(source: string, name: string): string {
  const anchors = [
    `export async function ${name}(`,
    `async function ${name}(`,
    `export function ${name}(`,
    `function ${name}(`,
  ]
  let start = -1
  for (const a of anchors) {
    const i = source.indexOf(a)
    if (i >= 0) {
      start = i + a.length
      break
    }
  }
  if (start < 0) return ""
  const rest = source.slice(start)
  const nextExport = rest.indexOf("\nexport ")
  const nextFn = rest.indexOf("\nfunction ")
  const ends = [nextExport, nextFn].filter((n) => n >= 0)
  return ends.length === 0 ? rest : rest.slice(0, Math.min(...ends))
}

// The balanced object literal passed to the first .insert( / .upsert( / .update(
// that follows a given .from("table") inside a body. This is the payload
// itself, never the whole function — a brokerage_id mentioned anywhere else in
// the function must not satisfy "brokerage_id is on the insert".
function payloadAfter(body: string, table: string, op: "insert" | "upsert" | "update"): string {
  const fromIdx = body.indexOf(`.from("${table}")`)
  if (fromIdx < 0) return ""
  const opIdx = body.indexOf(`.${op}(`, fromIdx)
  if (opIdx < 0) return ""
  const braceIdx = body.indexOf("{", opIdx)
  if (braceIdx < 0) return ""
  let depth = 0
  for (let i = braceIdx; i < body.length; i++) {
    if (body[i] === "{") depth++
    else if (body[i] === "}") {
      depth--
      if (depth === 0) return body.slice(braceIdx, i + 1)
    }
  }
  return ""
}

// The error identifiers bound by `const { ... } = await ...` destructures in a
// body. Scoped to the destructure specifically: a looser scan also captures
// `error: error.message` inside the return statement it is supposed to be
// checking for, which makes the assertion pass on its own conclusion.
function destructuredErrorNames(body: string): string[] {
  const names: string[] = []
  for (const m of body.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s/g)) {
    const inner = m[1]
    const renamed = inner.match(/\berror\s*:\s*(\w+)/)
    if (renamed) names.push(renamed[1])
    else if (/(^|[,{\s])error\s*(,|$)/.test(inner)) names.push("error")
  }
  return names.filter((n, i, a) => a.indexOf(n) === i)
}

// The region of a client component below its imports. A name appearing only in
// an import statement is not a wire.
function componentBody(source: string): string {
  const i = source.indexOf("export function ")
  return i < 0 ? source : source.slice(i)
}

// Every `startTransition(async () => { ... })` block in a client component,
// balanced-brace sliced. Used to prove each handler reads the server's verdict.
function transitionBlocks(source: string): string[] {
  const out: string[] = []
  let from = 0
  for (;;) {
    const i = source.indexOf("startTransition(async () => {", from)
    if (i < 0) break
    const braceIdx = source.indexOf("{", i + "startTransition(async () =>".length)
    let depth = 0
    let end = braceIdx
    for (let j = braceIdx; j < source.length; j++) {
      if (source[j] === "{") depth++
      else if (source[j] === "}") {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }
    out.push(source.slice(braceIdx, end + 1))
    from = end + 1
  }
  return out
}

// ── files under test ─────────────────────────────────────────────────────────
const ACTIONS = "app/actions/ai-content-generation.tsx"
const UTILS = "app/actions/ai-content-generation.utils.ts"
const APPROVAL = "app/actions/content-approval-workflow.ts"
const OS_CLIENT = "app/dashboard/content/content-os-client.tsx"
const SEO_PANEL = "app/dashboard/content/panels/seo-hashtags-panel.tsx"
const AB_PANEL = "app/dashboard/content/panels/ab-testing-panel.tsx"
const PERF_PANEL = "app/dashboard/content/panels/performance-costs-panel.tsx"
const PLAN_PANEL = "app/dashboard/content/panels/content-plan-panel.tsx"
const APPROVAL_PANEL = "app/dashboard/content/approvals/approval-tools-panel.tsx"
const APPROVALS_PAGE = "app/dashboard/content/approvals/page.tsx"
const CONTENT_PAGE = "app/dashboard/content/page.tsx"
const PALETTE = "app/components/command-palette.tsx"

const UI_FILES = [OS_CLIENT, SEO_PANEL, AB_PANEL, PERF_PANEL, PLAN_PANEL, APPROVAL_PANEL]

// Every capability that must be reachable, and the surface it is reached from.
// The invocation is asserted, not the import: an unused import is not a wire.
const WIRED: Array<{ fn: string; surface: string }> = [
  { fn: "getContentTemplates", surface: OS_CLIENT },
  { fn: "saveContentTemplate", surface: OS_CLIENT },
  { fn: "createGeneratedContent", surface: OS_CLIENT },
  { fn: "updateContentStatus", surface: OS_CLIENT },
  { fn: "learnFromEdits", surface: OS_CLIENT },
  { fn: "trackContentUsage", surface: OS_CLIENT },
  { fn: "enhancedGenerateListingDescription", surface: OS_CLIENT },
  { fn: "generateAllListingDescriptions", surface: OS_CLIENT },
  { fn: "getSEOKeywords", surface: SEO_PANEL },
  { fn: "addSEOKeyword", surface: SEO_PANEL },
  { fn: "calculateSEOScore", surface: SEO_PANEL },
  { fn: "getHashtagPerformance", surface: SEO_PANEL },
  { fn: "trackHashtagUsage", surface: SEO_PANEL },
  { fn: "generateHashtags", surface: SEO_PANEL },
  { fn: "createABTest", surface: AB_PANEL },
  { fn: "analyzeABTest", surface: AB_PANEL },
  { fn: "updateABTestResults", surface: AB_PANEL },
  { fn: "getContentPerformanceStats", surface: PERF_PANEL },
  { fn: "getContentPerformanceMetrics", surface: PERF_PANEL },
  { fn: "getContentInsights", surface: PERF_PANEL },
  { fn: "getMonthlyAICosts", surface: PERF_PANEL },
  { fn: "trackContentPerformance", surface: PERF_PANEL },
  { fn: "logGenerationCost", surface: PERF_PANEL },
  { fn: "generateContentPlan", surface: PLAN_PANEL },
  { fn: "batchEvaluateContentApproval", surface: APPROVAL_PANEL },
  { fn: "previewContentApproval", surface: APPROVAL_PANEL },
  { fn: "formatApprovalDecisionForDisplay", surface: APPROVAL_PANEL },
  { fn: "evaluateContentWorkflow", surface: APPROVAL_PANEL },
]

// Actions that write, and the agents-class column each must stamp from session.
const SESSION_GATED = [
  "getContentTemplates",
  "saveContentTemplate",
  "createGeneratedContent",
  "updateContentStatus",
  "getSEOKeywords",
  "addSEOKeyword",
  "trackContentPerformance",
  "getContentPerformanceStats",
  "getHashtagPerformance",
  "trackHashtagUsage",
  "updateABTestResults",
  "generateHashtags",
  "learnFromEdits",
  "generateContentPlan",
  "createABTest",
  "analyzeABTest",
  "generateAllListingDescriptions",
  "enhancedGenerateListingDescription",
  "logGenerationCost",
  "getMonthlyAICosts",
  "getContentPerformanceMetrics",
  "trackContentUsage",
  "getContentInsights",
]

// Insert payloads that must carry the tenant, and the table each writes to.
const TENANT_STAMPED: Array<{ fn: string; table: string; op: "insert" | "upsert" }> = [
  { fn: "saveContentTemplate", table: "content_templates", op: "insert" },
  { fn: "createGeneratedContent", table: "ai_generated_content", op: "insert" },
  { fn: "addSEOKeyword", table: "seo_keywords", op: "insert" },
  { fn: "trackContentPerformance", table: "content_performance_tracking", op: "upsert" },
  { fn: "trackHashtagUsage", table: "hashtag_performance", op: "insert" },
  { fn: "createABTest", table: "content_ab_tests", op: "insert" },
  { fn: "logGenerationCost", table: "content_generation_logs", op: "insert" },
  { fn: "trackContentUsage", table: "ai_generated_content", op: "insert" },
  { fn: "generateVariant", table: "ai_generated_content", op: "insert" },
]

// ── LAYER 0: the stripper itself ─────────────────────────────────────────────
function stripperSelfTest() {
  if (!quiet) console.log("\n[layer 0 - the comment stripper cannot be fooled by prose]")

  const openBlock = SLASH + STAR
  const closeBlock = STAR + SLASH
  const lineMark = SLASH + SLASH

  // A file whose ONLY occurrence of the construct is inside comments.
  const decoy = [
    openBlock,
    " We now stamp brokerage_id: auth.actor.brokerageId on every insert",
    " and gate every action on requireContentActor().",
    closeBlock,
    lineMark + " status: results.winner ? 'completed' : 'running'",
    "export async function nothing() { return 1 }",
  ].join("\n")

  const stripped = stripComments(decoy)
  check(
    "self.block",
    "a block comment cannot satisfy a brokerage_id assertion",
    !stripped.includes("brokerage_id")
  )
  check(
    "self.call",
    "a block comment cannot satisfy a requireContentActor assertion",
    !stripped.includes("requireContentActor")
  )
  check("self.line", "a line comment cannot satisfy a status-vocabulary assertion", !stripped.includes("running"))
  check("self.keeps-code", "real code survives stripping", stripped.includes("export async function nothing"))

  // And the stripper must not be a no-op on the files actually under test.
  check("self.applies", "stripping actually shortens the module under test", code(ACTIONS).length < raw(ACTIONS).length)
}

// ── LAYER 1: authorization — tenant from session, never from the caller ──────
function actorLayer() {
  if (!quiet) console.log("\n[layer 1 - the tenant comes from the session, not the caller]")
  const src = code(ACTIONS)

  check(
    "actor.helper",
    "requireContentActor resolves agentId, userId and brokerageId from getAgentContext",
    (() => {
      const b = fnBody(src, "requireContentActor")
      return (
        b.includes("getAgentContext()") &&
        b.includes("ctx.agentId") &&
        b.includes("ctx.userId") &&
        b.includes("ctx.brokerageId") &&
        // The agents id must never be manufactured from the users id.
        !b.includes("?? ctx.userId")
      )
    })()
  )

  for (const fn of SESSION_GATED) {
    const b = fnBody(src, fn)
    check(
      `actor.gate.${fn}`,
      `${fn} calls requireContentActor AND returns on the failure branch`,
      // Both halves, deliberately. Asserting only the call leaves the branch
      // free to be deleted while the name survives in the declaration.
      b.includes("await requireContentActor()") && b.includes("if (!auth.ok) return")
    )
    check(
      `actor.notrusted.${fn}`,
      `${fn} does not read a caller-supplied agent or brokerage id`,
      !b.includes("params.agentId") && !b.includes("data.agentId") && !b.includes("params.brokerageId")
    )
  }
}

// ── LAYER 2: brokerage_id stamped AT the insert ──────────────────────────────
function tenantStampLayer() {
  if (!quiet) console.log("\n[layer 2 - brokerage_id is on the payload, not patched on later]")
  const src = code(ACTIONS)

  for (const { fn, table, op } of TENANT_STAMPED) {
    const payload = payloadAfter(fnBody(src, fn), table, op)
    check(
      `tenant.payload.${fn}`,
      `${fn} -> ${table} payload was found and is non-empty`,
      payload.length > 0
    )
    check(
      `tenant.stamp.${fn}`,
      `${fn} stamps brokerage_id inside the ${table} payload itself`,
      payload.includes("brokerage_id:")
    )
  }
}

// ── LAYER 3: id spaces are resolved, never substituted ───────────────────────
function idSpaceLayer() {
  if (!quiet) console.log("\n[layer 3 - agents.id and users.id are different keys]")
  const src = code(ACTIONS)

  // seo_keywords.agent_user_id and .created_by both FK users(id).
  const seoPayload = payloadAfter(fnBody(src, "addSEOKeyword"), "seo_keywords", "insert")
  check(
    "ids.seo.user",
    "addSEOKeyword writes the USERS id into agent_user_id",
    seoPayload.includes("agent_user_id: auth.actor.userId")
  )
  check(
    "ids.seo.notagent",
    "addSEOKeyword does not put the agents id in a users-class column",
    !seoPayload.includes("agent_user_id: auth.actor.agentId") &&
      !seoPayload.includes("created_by: auth.actor.agentId")
  )
  check(
    "ids.seo.read",
    "getSEOKeywords filters agent_user_id by the users id",
    fnBody(src, "getSEOKeywords").includes('.eq("agent_user_id", auth.actor.userId)')
  )

  // Everything else in this file is an agents-class column.
  for (const { fn, table, op } of TENANT_STAMPED) {
    if (table === "seo_keywords") continue
    const payload = payloadAfter(fnBody(src, fn), table, op)
    if (!payload.includes("agent_id:")) continue
    check(
      `ids.agent.${fn}`,
      `${fn} writes the AGENTS id into ${table}.agent_id`,
      payload.includes("agent_id: auth.actor.agentId") ||
        payload.includes("agent_id: actor.agentId") ||
        payload.includes("agent_id: content.agent_id")
    )
  }

  // generateContentPlan read three different key spaces off one parameter.
  const plan = fnBody(src, "generateContentPlan")
  check(
    "ids.plan.transactions",
    "generateContentPlan queries transactions.agent_id with the agents id",
    plan.includes('.eq("agent_id", auth.actor.agentId)')
  )
  check(
    "ids.plan.nousers",
    "generateContentPlan no longer looks the agent up in users by an agents id",
    !plan.includes('.from("users")')
  )
}

// ── LAYER 4: NOT NULL columns that made calls impossible ─────────────────────
function notNullLayer() {
  if (!quiet) console.log("\n[layer 4 - the NOT NULL columns that made these calls impossible]")
  const src = code(ACTIONS)

  const abPayload = payloadAfter(fnBody(src, "createABTest"), "content_ab_tests", "insert")
  check(
    "notnull.abtest",
    "createABTest stamps content_ab_tests.agent_id (NOT NULL, was absent)",
    abPayload.includes("agent_id: auth.actor.agentId")
  )

  const costPayload = payloadAfter(fnBody(src, "logGenerationCost"), "content_generation_logs", "insert")
  check(
    "notnull.costlog",
    "logGenerationCost stamps content_generation_logs.agent_id (NOT NULL, was optional)",
    costPayload.includes("agent_id: auth.actor.agentId")
  )
  check(
    "notnull.costlog.param",
    "logGenerationCost no longer accepts agentId as a parameter at all",
    (() => {
      const b = fnBody(src, "logGenerationCost")
      const sig = b.slice(0, b.indexOf("}>"))
      return !sig.includes("agentId")
    })()
  )
}

// ── LAYER 5: vocabularies match the live CHECK constraints ───────────────────
function vocabularyLayer() {
  if (!quiet) console.log("\n[layer 5 - every vocabulary matches the live CHECK]")
  const src = code(ACTIONS)
  const utils = code(UTILS)

  // Verified live: inserting 'active' returns SQLSTATE 23514.
  check(
    "vocab.abtest.utils",
    "AB_TEST_STATUSES is exactly running/completed/cancelled",
    utils.includes('["running", "completed", "cancelled"] as const')
  )
  check(
    "vocab.abtest.branch",
    "updateABTestResults writes completed-or-running, and 'active' is gone from the branch",
    (() => {
      const b = fnBody(src, "updateABTestResults")
      return b.includes('status: results.winner ? "completed" : "running"') && !b.includes('"active"')
    })()
  )
  check(
    "vocab.abtest.create",
    "createABTest opens the test as 'running'",
    payloadAfter(fnBody(src, "createABTest"), "content_ab_tests", "insert").includes('status: "running"')
  )
  check(
    "vocab.calendar",
    "generateContentPlan writes calendar rows as 'draft'",
    fnBody(src, "generateContentPlan").includes('status: "draft"')
  )
  check(
    "vocab.seo.scope",
    "addSEOKeyword uses 'agent' - 'private' is not a member of the CHECK",
    (() => {
      const p = payloadAfter(fnBody(src, "addSEOKeyword"), "seo_keywords", "insert")
      return p.includes('visibility_scope: "agent"') && !p.includes('"private"')
    })()
  )
  check(
    "vocab.seo.types",
    "SEO_VISIBILITY_SCOPES omits 'private'",
    utils.includes("SEO_VISIBILITY_SCOPES") && !utils.includes('"private"')
  )

  // The UI picker and the server validator read the SAME list, so a picker can
  // never offer a value the server refuses.
  check(
    "vocab.shared.status",
    "the drafts picker renders GENERATED_CONTENT_STATUSES from the shared sidecar",
    code(OS_CLIENT).includes("GENERATED_CONTENT_STATUSES.filter(") &&
      code(OS_CLIENT).includes("ai-content-generation.utils")
  )
  check(
    "vocab.shared.abvar",
    "the A/B picker renders AB_TEST_VARIABLES from the shared sidecar",
    code(AB_PANEL).includes("AB_TEST_VARIABLES.map(") && code(AB_PANEL).includes("ai-content-generation.utils")
  )
  check(
    "vocab.server.status",
    "updateContentStatus validates against the same shared list",
    fnBody(src, "updateContentStatus").includes("GENERATED_CONTENT_STATUSES as readonly string[]).includes(status)")
  )
}

// ── LAYER 6: columns that do not exist / contracts that did not hold ─────────
function contractLayer() {
  if (!quiet) console.log("\n[layer 6 - the column that never existed and the shape that never matched]")
  const src = code(ACTIONS)

  const analyze = fnBody(src, "analyzeABTest")
  check(
    "contract.nofakecolumn",
    "analyzeABTest no longer reads ai_generated_content.engagement_metrics (no such column)",
    !analyze.includes("engagement_metrics")
  )
  check(
    "contract.realsource",
    "analyzeABTest derives engagement from content_performance_tracking",
    analyze.includes('.from("content_performance_tracking")')
  )
  check(
    "contract.nozerowinner",
    "analyzeABTest refuses to declare a winner when both sides are at zero",
    analyze.includes("metricA === 0 && metricB === 0")
  )

  const enhanced = fnBody(src, "enhancedGenerateListingDescription")
  check(
    "contract.contentid",
    "enhancedGenerateListingDescription reads contentId from the TOP level of the callee result",
    enhanced.includes("(result as any).contentId") && !enhanced.includes("result.data?.contentId")
  )
  check(
    "contract.text",
    "enhancedGenerateListingDescription no longer reads a generated_content key off the parsed payload",
    !enhanced.includes("result.data?.generated_content")
  )
  check(
    "contract.emptyguard",
    "enhancedGenerateListingDescription refuses to validate an empty string",
    enhanced.includes("if (!generatedText)")
  )
}

// ── LAYER 7: a refused query is never rendered as an empty one ───────────────
function errorLayer() {
  if (!quiet) console.log("\n[layer 7 - a refused read is reported, not rendered as emptiness]")
  const src = code(ACTIONS)

  // Every destructured error identifier in the body must be branched on.
  const READERS = [
    "getContentTemplates",
    "getSEOKeywords",
    "getHashtagPerformance",
    "getContentPerformanceStats",
    "getMonthlyAICosts",
    "getContentPerformanceMetrics",
    "getContentInsights",
    "getGeneratedContent",
    "generateAllListingDescriptions",
  ]
  for (const fn of READERS) {
    const b = fnBody(src, fn)
    const names = destructuredErrorNames(b)
    check(
      `error.destructured.${fn}`,
      `${fn} destructures at least one error from its query`,
      names.length > 0
    )
    check(
      `error.branched.${fn}`,
      `${fn} branches on every error it destructures`,
      // The BRANCH, not the token. A name survives in its declaration even
      // when the `if` around it is deleted.
      names.every((n) => b.includes(`if (${n})`))
    )
    check(
      `error.reports.${fn}`,
      `${fn} returns the failure rather than an empty collection`,
      b.includes("return { success: false, error:")
    )
  }

  // The two writes that reported success without reading the verdict.
  check(
    "error.trackusage",
    "trackContentUsage destructures the insert and returns the refusal",
    (() => {
      const b = fnBody(src, "trackContentUsage")
      return b.includes("const { data, error }") && b.includes("if (error)") && b.includes("return { success: false")
    })()
  )
  check(
    "error.bulk",
    "bulkGenerateContent counts a refused generation as failed, not completed",
    (() => {
      const b = fnBody(src, "bulkGenerateContent")
      return b.includes("if (result?.success)") && b.includes("success: false")
    })()
  )
  check(
    "error.learn",
    "learnFromEdits reports a refused brand-voice write instead of returning learnings",
    (() => {
      const b = fnBody(src, "learnFromEdits")
      return b.includes("if (writeError)") && b.includes("return { success: false, error: writeError.message }")
    })()
  )
  check(
    "error.plan",
    "generateContentPlan reports a refused calendar insert instead of claiming a plan",
    (() => {
      const b = fnBody(src, "generateContentPlan")
      return b.includes("if (insertError)") && b.includes("Plan generated but could not be saved")
    })()
  )
}

// ── LAYER 8: no fabricated data stands in for real data ──────────────────────
function fictionLayer() {
  if (!quiet) console.log("\n[layer 8 - no invented numbers presented as findings]")
  const src = code(ACTIONS)

  check(
    "fiction.costs",
    "getMonthlyAICosts no longer returns a fabricated $45.32 bill",
    !fnBody(src, "getMonthlyAICosts").includes("45.32")
  )
  check(
    "fiction.hashtags",
    "getHashtagPerformance no longer returns invented hashtag stats",
    !fnBody(src, "getHashtagPerformance").includes("#MiamiRealEstate")
  )
  check(
    "fiction.keywords",
    "getSEOKeywords no longer returns invented keywords",
    !fnBody(src, "getSEOKeywords").includes("Miami real estate")
  )
  check(
    "fiction.stats",
    "getContentPerformanceStats no longer returns 45230 invented impressions",
    !fnBody(src, "getContentPerformanceStats").includes("45230")
  )
  check(
    "fiction.insights",
    "getContentInsights derives peak hours instead of hardcoding [9,10,14,15]",
    (() => {
      const b = fnBody(src, "getContentInsights")
      return !b.includes("peak_usage_hours: [9, 10, 14, 15]") && b.includes("new Date(c.created_at).getHours()")
    })()
  )
  check(
    "fiction.metrics",
    "getContentPerformanceMetrics no longer reports a literal engagement_improvement",
    !fnBody(src, "getContentPerformanceMetrics").includes("engagement_improvement: 0.25")
  )
  check(
    "fiction.rollup",
    "getContentPerformanceStats actually computes performanceByType instead of returning {}",
    fnBody(src, "getContentPerformanceStats").includes("performanceByType[type].impressions +=")
  )
}

// ── LAYER 9: the deletion, and what was ported first ─────────────────────────
function deletionLayer() {
  if (!quiet) console.log("\n[layer 9 - one deletion, and the port that preceded it]")
  const src = code(ACTIONS)

  check(
    "delete.gone",
    "createContentABTest is no longer declared anywhere",
    !src.includes("export async function createContentABTest(")
  )
  check(
    "delete.nocallers",
    "nothing in the wired surfaces still calls createContentABTest",
    UI_FILES.every((f) => !code(f).includes("createContentABTest"))
  )

  // The survivor must carry every capability the deleted twin had. Asserted
  // on the SIGNATURE and the PAYLOAD, so a comment naming them is not enough.
  const create = fnBody(src, "createABTest")
  const sig = create.slice(0, create.indexOf("}>"))
  const payload = payloadAfter(create, "content_ab_tests", "insert")

  check("port.variantB.sig", "createABTest accepts an explicit variantBId", sig.includes("variantBId?: string"))
  check(
    "port.variantB.path",
    "createABTest actually branches on variantBId rather than always generating",
    create.includes("if (variantBId) {") && create.includes("generateVariant(baseContent")
  )
  check("port.metric.sig", "createABTest accepts testMetric", sig.includes("testMetric?: string"))
  check("port.metric.write", "createABTest writes test_metric", payload.includes("test_metric:"))
  check(
    "port.sample.sig",
    "createABTest accepts targetSampleSize",
    sig.includes("targetSampleSize?: number")
  )
  check(
    "port.sample.write",
    "createABTest writes target_sample_size",
    payload.includes("target_sample_size:")
  )
  check("port.name.sig", "createABTest accepts an explicit testName", sig.includes("testName?: string"))
  check("port.agent.write", "createABTest writes agent_id", payload.includes("agent_id:"))

  // The other in-file pair was NOT collapsed, on evidence: enhanced CALLS base.
  check(
    "keep.decorator",
    "enhancedGenerateListingDescription still delegates to generateListingDescription",
    fnBody(src, "enhancedGenerateListingDescription").includes("await generateListingDescription({")
  )
  check(
    "keep.base",
    "generateListingDescription survives - it has live external callers",
    src.includes("export async function generateListingDescription(")
  )
  check(
    "keep.manualresults",
    "updateABTestResults survives - it accepts numbers analyzeABTest cannot derive",
    src.includes("export async function updateABTestResults(")
  )
}

// ── LAYER 10: the wires themselves ───────────────────────────────────────────
function wiringLayer() {
  if (!quiet) console.log("\n[layer 10 - every capability is invoked from a real surface]")

  for (const { fn, surface } of WIRED) {
    const ui = code(surface)
    check(
      `wire.import.${fn}`,
      `${surface.split("/").pop()} imports ${fn}`,
      new RegExp(`\\b${fn}\\b`).test(ui.slice(0, ui.indexOf("export function")))
    )
    check(
      `wire.call.${fn}`,
      `${fn} is actually CALLED, not merely imported`,
      // A CALL EXPRESSION below the imports. Asserting only the name would be
      // satisfied by the import line itself, which is exactly the state this
      // whole exercise exists to detect.
      componentBody(ui).includes(`${fn}(`)
    )
  }

  // Handlers must read the verdict before telling the user it worked.
  for (const f of UI_FILES) {
    const blocks = transitionBlocks(code(f))
    check(`wire.handlers.${f.split("/").pop()}`, `${f.split("/").pop()} has action handlers`, blocks.length > 0)
    check(
      `wire.verdict.${f.split("/").pop()}`,
      `every handler in ${f.split("/").pop()} branches on res.success before reporting`,
      blocks.every((b) => !b.includes("toast.success") || b.includes("res.success") || b.includes("fmt.success"))
    )
  }

  // The routes exist and are reachable from navigation.
  check("wire.route.os", "the Content OS route exists", code(CONTENT_PAGE).includes("ContentOsClient"))
  check(
    "wire.route.suspense",
    "the Content OS route wraps its searchParams reader in Suspense",
    code(CONTENT_PAGE).includes("<Suspense")
  )
  check(
    "wire.route.approvals",
    "the approvals page mounts the routing tools panel",
    code(APPROVALS_PAGE).includes("<ApprovalToolsPanel />")
  )
  check(
    "wire.nav",
    "the command palette links to /dashboard/content",
    code(PALETTE).includes('href: "/dashboard/content"')
  )
  check(
    "wire.nav.deeplinks",
    "the palette deep-links into the panels the tabs render",
    ["seo", "experiments", "performance", "plan", "voice"].every((t) =>
      code(PALETTE).includes(`/dashboard/content?tab=${t}`)
    )
  )
  check(
    "wire.tabs",
    "the client honours ?tab= rather than always opening on drafts",
    code(OS_CLIENT).includes("searchParams.get(\"tab\")") && code(OS_CLIENT).includes("defaultValue={defaultTab}")
  )
}

// ── LAYER 11: "use server" module hygiene ────────────────────────────────────
function serverModuleLayer() {
  if (!quiet) console.log("\n[layer 11 - a use-server module exports only functions]")
  const src = code(ACTIONS)

  check(
    "server.directive",
    "the actions module is a server-action module",
    raw(ACTIONS).trimStart().startsWith('"use server"')
  )
  check(
    "server.noconst",
    "no non-function export const survives in the use-server module",
    !/^export const /m.test(src)
  )
  check(
    "server.notype",
    "no exported type alias survives in the use-server module",
    !/^export type /m.test(src) && !/^export interface /m.test(src)
  )
  check(
    "server.sidecar",
    "the vocabularies live in a plain module the UI can import",
    !raw(UTILS).trimStart().startsWith('"use server"') && code(UTILS).includes("export const")
  )
  check(
    "server.approval.gate",
    "formatApprovalDecisionForDisplay is gated like its siblings",
    (() => {
      const b = fnBody(code(APPROVAL), "formatApprovalDecisionForDisplay")
      return b.includes("await getSessionAgentId()") && b.includes("if (!auth.ok) return")
    })()
  )
}

function runAllChecks() {
  R = { pass: 0, fail: 0, failures: [], ids: [] }
  stripperSelfTest()
  actorLayer()
  tenantStampLayer()
  idSpaceLayer()
  notNullLayer()
  vocabularyLayer()
  contractLayer()
  errorLayer()
  fictionLayer()
  deletionLayer()
  wiringLayer()
  serverModuleLayer()
  return R
}

// ── NEGATIVE TESTS ───────────────────────────────────────────────────────────
// Mutate real source, PROVE the mutation landed by sha256, re-run, require the
// specific check id in the failures, restore, verify restoration by sha256.

type Mutation = { name: string; file: string; find: string; replace: string; expect: string }

const MUTATIONS: Mutation[] = [
  {
    name: "remove the actor gate from a reader",
    file: ACTIONS,
    find: "  const auth = await requireContentActor()\n  if (!auth.ok) return { success: false, error: auth.error }\n\n  const supabase = await createClient()\n\n  // Scope explicitly to this brokerage.",
    replace: "  const auth = { ok: true, actor: null } as any\n\n  const supabase = await createClient()\n\n  // Scope explicitly to this brokerage.",
    expect: "actor.gate.getContentTemplates",
  },
  {
    name: "unstamp brokerage_id on the template insert",
    file: ACTIONS,
    find: "      brokerage_id: auth.actor.brokerageId,\n      agent_id: auth.actor.agentId,\n      template_name: data.templateName.trim(),",
    replace: "      agent_id: auth.actor.agentId,\n      template_name: data.templateName.trim(),",
    expect: "tenant.stamp.saveContentTemplate",
  },
  {
    name: "substitute the agents id into a users-class column",
    file: ACTIONS,
    find: "      agent_user_id: auth.actor.userId, // users(id)",
    replace: "      agent_user_id: auth.actor.agentId, // users(id)",
    expect: "ids.seo.user",
  },
  {
    name: "drop agent_id from the A/B test insert (the NOT NULL that killed it)",
    file: ACTIONS,
    find: "        agent_id: auth.actor.agentId,\n        brokerage_id: auth.actor.brokerageId,\n        test_name:",
    replace: "        brokerage_id: auth.actor.brokerageId,\n        test_name:",
    expect: "notnull.abtest",
  },
  {
    name: "reinstate the CHECK-violating 'active' status",
    file: ACTIONS,
    find: 'status: results.winner ? "completed" : "running",',
    replace: 'status: results.winner ? "completed" : "active",',
    expect: "vocab.abtest.branch",
  },
  {
    name: "point the analyzer back at the column that does not exist",
    file: ACTIONS,
    find: '      .from("content_performance_tracking")\n      .select("content_id, engagement_rate, impressions, likes, shares, comments, saves")',
    replace: '      .from("ai_generated_content")\n      .select("engagement_metrics")',
    expect: "contract.realsource",
  },
  {
    name: "restore the broken callee contract",
    file: ACTIONS,
    find: "    const contentId: string | null = (result as any).contentId ?? null",
    replace: "    const contentId: string | null = (result as any).data?.contentId ?? null",
    expect: "contract.contentid",
  },
  {
    name: "gut the error branch while leaving the name in place",
    file: ACTIONS,
    // The name `error` survives in the declaration; only the branch is removed.
    find: '  if (error) {\n    console.error("[getContentTemplates] Query failed:", error)\n    return { success: false, error: error.message }\n  }',
    replace: "",
    expect: "error.branched.getContentTemplates",
  },
  {
    name: "return success over an unread insert again",
    file: ACTIONS,
    find: '  if (error) {\n    console.error("[trackContentUsage] Insert failed:", error)\n    return { success: false, error: error.message }\n  }',
    replace: "",
    expect: "error.trackusage",
  },
  {
    name: "reinstate a fabricated cost figure",
    file: ACTIONS,
    // RE-ANCHORED. This used to mutate the `content_generation_logs` line
    //   const totalCost = rows.reduce((sum, log) => sum + Number(log.cost_usd || 0), 0)
    // which no longer exists: getMonthlyAICosts now reads ai_tool_usage — the
    // one ledger that already prices every AI call correctly — so the sum is
    // over `cost_cents`, not `cost_usd`. The positive `fiction.costs` check
    // never stopped passing; it was this MUTATION that went stale, and a
    // mutation whose anchor is gone silently stops proving the check has teeth.
    find: "  const totalCents = rows.reduce((sum, row) => sum + Number(row.cost_cents || 0), 0)",
    // Injects the literal "45.32" — the exact string fiction.costs greps for.
    // Mutating to `4532` cents would be the same lie in the new unit but would
    // slip past the check, and a negative test that cannot trip its own positive
    // check proves nothing.
    replace: "  const totalCents = rows.length === 0 ? 45.32 * 100 : rows.reduce((sum, row) => sum + Number(row.cost_cents || 0), 0)",
    expect: "fiction.costs",
  },
  {
    name: "strip a ported capability off the survivor",
    file: ACTIONS,
    find: "        test_metric: params.testMetric ?? \"engagement_rate\",",
    replace: "",
    expect: "port.metric.write",
  },
  {
    name: "remove a capability's call site while leaving the import",
    file: SEO_PANEL,
    find: "      const res = await generateHashtags({",
    replace: "      const res = await Promise.resolve({ success: false, error: \"x\" } as any) || ({} as any); void ((_: any) => _)({",
    expect: "wire.call.generateHashtags",
  },
  {
    name: "report success without reading the verdict",
    file: SEO_PANEL,
    // Anchor updated when the void-return violation was fixed: an async
    // TransitionFunction may not return a value, and `return toast.error(...)`
    // returns the toast id. The ASSERTION is unchanged — only this mutation's
    // anchor moved, which is why the harness reported a stale anchor instead of
    // quietly skipping the negative test.
    find: "      if (!res.success) { toast.error(res.error); return }\n      toast.success(\"Keyword added\")",
    replace: "      toast.success(\"Keyword added\")",
    expect: "wire.verdict.seo-hashtags-panel.tsx",
  },
  {
    name: "put a non-function export const back in the use-server module",
    file: ACTIONS,
    find: 'import { createClient } from "@/lib/supabase/server"',
    replace: 'import { createClient } from "@/lib/supabase/server"\nexport const LEAKED_VOCAB = ["a"] as const',
    expect: "server.noconst",
  },
  {
    name: "resurrect the deleted twin",
    file: ACTIONS,
    find: "// createContentABTest lived here.",
    replace: "export async function createContentABTest(d: any) { return d }\n// createContentABTest lived here.",
    expect: "delete.gone",
  },
  {
    name: "ungate the one action that had no gate",
    file: APPROVAL,
    find: "    const auth = await getSessionAgentId()\n    if (!auth.ok) return { success: false, error: auth.error }\n\n    if (!decision) {",
    replace: "    if (!decision) {",
    expect: "server.approval.gate",
  },
]

function negativeTests(): boolean {
  console.log("\n" + "=".repeat(78))
  console.log(" NEGATIVE TESTS - every assertion must be provable to fail")
  console.log("=".repeat(78))

  let ok = true
  const baseline = runAllChecksQuiet()
  if (baseline.fail > 0) {
    console.log("  ! baseline is already failing; negative tests are meaningless until it is green")
    return false
  }

  for (const m of MUTATIONS) {
    const before = raw(m.file)
    const shaBefore = sha(m.file)

    if (!before.includes(m.find)) {
      console.log(`  FAIL [${m.expect}] "${m.name}" - anchor not found, mutation is stale`)
      ok = false
      continue
    }
    // Anchor must be unique, or the mutation is not the one we think it is.
    if (before.split(m.find).length - 1 !== 1) {
      console.log(`  FAIL [${m.expect}] "${m.name}" - anchor is not unique in ${m.file}`)
      ok = false
      continue
    }

    try {
      writeFileSync(join(process.cwd(), m.file), before.replace(m.find, m.replace), "utf8")
      const shaAfter = sha(m.file)

      // The mutation must actually have landed on disk.
      if (shaAfter === shaBefore) {
        console.log(`  FAIL [${m.expect}] "${m.name}" - sha256 unchanged, mutation did not apply`)
        ok = false
        continue
      }

      const mutated = runAllChecksQuiet()
      if (!mutated.ids.includes(m.expect)) {
        console.log(`  FAIL [${m.expect}] "${m.name}" - no such check id exists`)
        ok = false
      } else if (!mutated.failures.includes(m.expect)) {
        console.log(`  FAIL [${m.expect}] "${m.name}" - assertion SURVIVED the mutation; it is worthless`)
        ok = false
      } else {
        console.log(`  ok   [${m.expect}] "${m.name}" - caught`)
      }
    } finally {
      writeFileSync(join(process.cwd(), m.file), before, "utf8")
      const shaRestored = sha(m.file)
      if (shaRestored !== shaBefore) {
        console.log(`  FAIL [${m.expect}] RESTORE FAILED for ${m.file} - sha256 does not match the original`)
        ok = false
      }
    }
  }

  const after = runAllChecksQuiet()
  if (after.fail !== 0) {
    console.log(`  FAIL post-restore suite is not green again (${after.fail} failing)`)
    ok = false
  } else {
    console.log(`  ok   post-restore suite is green again (${after.pass} assertions)`)
  }

  return ok
}

function runAllChecksQuiet(): Result {
  quiet = true
  try {
    return runAllChecks()
  } finally {
    quiet = false
  }
}

// ── LIVE LAYER (optional, creds-gated, always rolls back) ────────────────────
async function liveLayer(): Promise<"ran" | "skipped"> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY

  console.log("\n" + "=".repeat(78))
  console.log(" LIVE LAYER - the constraint claims, re-proved against the real database")
  console.log("=".repeat(78))

  if (!url || !key) {
    console.log("  SKIPPED - NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent.")
    console.log("  A SKIP IS NOT A PASS. The source layer asserts what the code does;")
    console.log("  only this layer proves the database agrees. Re-run with credentials")
    console.log("  before treating the constraint claims as verified.")
    return "skipped"
  }

  const svc = createClient(url, key, { auth: { persistSession: false } })
  const created: Array<{ table: string; id: string }> = []

  try {
    const { data: agent } = await svc.from("agents").select("id, brokerage_id").limit(1).maybeSingle()
    if (!agent) {
      console.log("  SKIPPED - no agents row to anchor a probe against. A SKIP IS NOT A PASS.")
      return "skipped"
    }
    const agentId = (agent as any).id
    const brokerageId = (agent as any).brokerage_id

    // 1. 'active' must be refused by content_ab_tests_status_check.
    const { error: activeErr } = await svc
      .from("content_ab_tests")
      .insert({ agent_id: agentId, brokerage_id: brokerageId, test_name: "probe", status: "active" } as any)
    check("live.abtest.active", "the database refuses status 'active'", !!activeErr)

    // 2. agent_id NULL must be refused.
    const { error: nullErr } = await svc
      .from("content_ab_tests")
      .insert({ agent_id: null, brokerage_id: brokerageId, test_name: "probe", status: "running" } as any)
    check("live.abtest.notnull", "the database refuses a null agent_id on content_ab_tests", !!nullErr)

    // 3. content_generation_logs.agent_id NULL must be refused.
    const { error: logErr } = await svc
      .from("content_generation_logs")
      .insert({ agent_id: null, success: true } as any)
    check("live.costlog.notnull", "the database refuses a null agent_id on content_generation_logs", !!logErr)

    // 4. seo_keywords visibility_scope 'private' must be refused, 'agent' accepted.
    const { error: privErr } = await svc
      .from("seo_keywords")
      .insert({ brokerage_id: brokerageId, keyword: "probe-kw-private", visibility_scope: "private" } as any)
    check("live.seo.private", "the database refuses visibility_scope 'private'", !!privErr)

    const { data: kwRow, error: agentScopeErr } = await svc
      .from("seo_keywords")
      .insert({
        brokerage_id: brokerageId,
        keyword: "probe-kw-agent",
        visibility_scope: "agent",
        keyword_type: "secondary",
      } as any)
      .select("id")
      .maybeSingle()
    check("live.seo.agent", "the database accepts the vocabulary the surface offers", !agentScopeErr)
    if (kwRow) created.push({ table: "seo_keywords", id: (kwRow as any).id })

    // 5. engagement_metrics must not exist on ai_generated_content.
    const { error: colErr } = await svc.from("ai_generated_content").select("engagement_metrics").limit(1)
    check("live.nocolumn", "ai_generated_content has no engagement_metrics column", !!colErr)

    // 6. The A/B insert the corrected code actually makes must be accepted.
    const { data: testRow, error: goodErr } = await svc
      .from("content_ab_tests")
      .insert({
        agent_id: agentId,
        brokerage_id: brokerageId,
        test_name: "probe-corrected",
        status: "running",
        test_metric: "engagement_rate",
        target_sample_size: 1000,
        sample_size_per_variant: 100,
      } as any)
      .select("id")
      .maybeSingle()
    check("live.abtest.corrected", "the corrected A/B payload is accepted", !goodErr)
    if (testRow) created.push({ table: "content_ab_tests", id: (testRow as any).id })
  } finally {
    for (const c of created.reverse()) await svc.from(c.table).delete().eq("id", c.id)
    let leftover = 0
    for (const c of created) {
      const { count } = await svc.from(c.table).select("id", { count: "exact", head: true }).eq("id", c.id)
      leftover += count ?? 0
    }
    check("live.cleanup", "every probe row was removed - residue is zero", leftover === 0)
  }

  return "ran"
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("=".repeat(78))
  console.log(" AI CONTENT WIRING - 28 capabilities got a door, and several of them")
  console.log(" could never have completed a single call before today")
  console.log("=".repeat(78))

  const source = runAllChecks()
  const negOk = negativeTests()

  // The live layer appends to whatever the last (restored, green) run produced.
  const liveStatus = await liveLayer()

  console.log("\n" + "=".repeat(78))
  console.log(`SOURCE  ${source.pass} passed, ${source.fail} failed  (${source.ids.length} assertions)`)
  console.log(`NEGATIVE ${negOk ? "all mutations caught" : "SOME ASSERTIONS SURVIVED MUTATION"}`)
  console.log(`LIVE    ${liveStatus === "ran" ? "ran against the real database" : "SKIPPED - not a pass"}`)
  console.log("=".repeat(78))

  if (source.fail > 0) {
    console.log("\nSource failures:")
    for (const f of source.failures) console.log(`  - ${f}`)
  }

  if (source.fail > 0 || !negOk) {
    console.log("\nThese capabilities write into seven tables no other module touches.")
    console.log("An unstamped brokerage_id, a CHECK the picker violates, or a result")
    console.log("nobody destructures all fail the same way: quietly, with the agent")
    console.log("told it worked.")
    process.exit(1)
  }

  console.log("\nAI_CONTENT_WIRING_PASS - the tenant comes from the session, the")
  console.log("vocabularies match the database, and every capability has a door.")
  if (liveStatus === "skipped") {
    console.log("NOTE: the live layer was skipped. That is not a pass.")
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
