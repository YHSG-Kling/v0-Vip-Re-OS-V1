#!/usr/bin/env tsx
/**
 * scripts/persona-journey-wiring-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the MULTI-PERSONA / JOURNEY / PREDICTIONS wiring pass.
 *
 * WHAT IT IS FOR. Three action files held capabilities that were complete and had
 * no callers; a portal page held a journey the client could read but never act on;
 * and a coordinator dashboard could not see deals assigned through the only
 * assignment UI an agent reaches. This asserts the wires that now exist, the
 * defects that were fixed, and — just as importantly — the three capabilities that
 * were deliberately NOT wired, so nobody quietly wires them later without reading
 * why.
 *
 * FOUR LAYERS
 *   1. PURE      — the comment stripper itself, on adversarial input. If prose can
 *                  satisfy an assertion, every other layer is theatre.
 *   2. STATIC    — constructs in comment-stripped source. Never spellings: the
 *                  destructure-`error` check parses every `await x.from(` statement
 *                  in a file and demands the binding pattern that owns it.
 *   3. LIVE      — creds-gated schema truth (information_schema / pg_constraint /
 *                  pg_policies) plus a real round-trip insert→read→delete with a
 *                  residue re-count. SKIPS LOUDLY if the DB is unreachable.
 *   4. NEGATIVE  — every static assertion is broken IN THE SOURCE FILE, the
 *                  mutation is proved to have actually applied (a no-op `replace`
 *                  is a hard failure, not a pass), the specific check is confirmed
 *                  to flip to failure, the file is restored, and the restore is
 *                  verified by sha256.
 *
 * RUN IT:   npx tsx scripts/persona-journey-wiring-simulator.ts
 * (do not register it in package.json — the owner does that)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { stripComments } from "./strip-comments"

const HERE = typeof __dirname !== "undefined" ? __dirname : dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, "..")

// ─────────────────────────────────────────────────────────────────────────────
// COMMENT STRIPPER — the foundation. A scanner, not a regex: a regex cannot tell
// `"// not a comment"` inside a string from an actual comment, and this whole
// suite is worthless if a descriptive comment can satisfy an assertion.
// ─────────────────────────────────────────────────────────────────────────────
// stripComments() now comes from scripts/strip-comments.ts — see the import above.
// hand-rolled scanner replaced (finding #250): it could not see nested `${…}` templates, regex literals, or an apostrophe in JSX text, and went blind on the code it judges.
export { stripComments }

/** Whitespace-normalized stripped source — lets a construct match across newlines. */
function flat(src: string): string {
  return stripComments(src).replace(/\s+/g, " ")
}

const fileCache = new Map<string, string>()
function raw(rel: string): string {
  const hit = fileCache.get(rel)
  if (hit !== undefined) return hit
  const txt = readFileSync(join(ROOT, rel), "utf8")
  fileCache.set(rel, txt)
  return txt
}
function src(rel: string): string {
  return stripComments(raw(rel))
}
function src1(rel: string): string {
  return flat(raw(rel))
}
function clearCache() {
  fileCache.clear()
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTRUCT EXTRACTORS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Body of `export async function <name>(…)`, by real brace matching.
 *
 * Naively taking the first `{` after the name is wrong and quietly returns a
 * PARAMETER TYPE instead of a body — `completeTask(data: { contactId: string })`
 * and `predictLeadConversion(id): Promise<X | { error: string }>` both have a
 * brace before the body opens. So: match the parameter parens by paren depth,
 * then skip a return-type annotation by angle-bracket depth, and only then take
 * the body's opening brace.
 */
export function functionBody(source: string, name: string): string {
  const decl = new RegExp(`(?:export\\s+)?(?:async\\s+)?function\\s+${name}\\s*[(<]`)
  const m = decl.exec(source)
  if (!m) return ""

  // 1. the parameter list
  let i = source.indexOf("(", m.index)
  if (i < 0) return ""
  let paren = 0
  for (; i < source.length; i++) {
    if (source[i] === "(") paren++
    else if (source[i] === ")") {
      paren--
      if (paren === 0) {
        i++
        break
      }
    }
  }

  // 2. skip a return-type annotation; the body brace is the first `{` at angle depth 0
  let angle = 0
  for (; i < source.length; i++) {
    const ch = source[i]
    if (ch === "<") angle++
    else if (ch === ">") angle = Math.max(0, angle - 1)
    else if (ch === "{") {
      if (angle === 0) break
      // a brace inside a generic type — skip it wholesale
      let d = 0
      for (; i < source.length; i++) {
        if (source[i] === "{") d++
        else if (source[i] === "}") {
          d--
          if (d === 0) break
        }
      }
    }
  }
  if (i >= source.length || source[i] !== "{") return ""

  // 3. the body
  const start = i
  let depth = 0
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++
    else if (source[i] === "}") {
      depth--
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return source.slice(start)
}

/**
 * Every `await <client>.from("<table>")…` statement in a chunk of stripped,
 * whitespace-flattened source, paired with the destructuring pattern that owns it
 * (or null when the call's result is thrown away) and the chain that follows.
 */
export interface SupabaseStatement {
  binding: string | null
  table: string
  chain: string
}
export function supabaseStatements(flatSource: string): SupabaseStatement[] {
  const out: SupabaseStatement[] = []
  const re = /(?:(?:const|let|var)\s*(\{[^}]*\})\s*=\s*)?await\s+[\w.]+\s*\.from\(\s*["'`]([\w]+)["'`]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(flatSource)) !== null) {
    // The chain runs to the start of the next statement — the next `await`, the
    // next `const/let/return`, or 900 chars, whichever comes first.
    const after = flatSource.slice(m.index + m[0].length)
    const stop = after.search(/\bawait\s|\bconst\s|\blet\s|\breturn\s/)
    out.push({
      binding: m[1] ?? null,
      table: m[2],
      chain: stop >= 0 ? after.slice(0, stop) : after.slice(0, 900),
    })
  }
  return out
}

/** Does a repo file (other than the definition file) import this symbol? */
function importersOf(symbol: string, definitionFile: string): string[] {
  let raw = ""
  try {
    raw = execFileSync(
      "grep",
      ["-rl", "--include=*.ts", "--include=*.tsx", `\\b${symbol}\\b`, "app", "lib", "services", "workflows"],
      { cwd: ROOT, encoding: "utf8" },
    )
  } catch {
    return []
  }
  return raw
    .split("\n")
    .filter(Boolean)
    .filter((f) => f !== definitionFile)
    .filter((f) => {
      const body = readFileSync(join(ROOT, f), "utf8")
      const stripped = stripComments(body)
      // an IMPORT of the symbol, not a mention of its name in prose
      return new RegExp(`import[\\s\\S]{0,400}?\\b${symbol}\\b[\\s\\S]{0,200}?from\\s*["'\`]`).test(stripped)
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// FILES UNDER TEST
// ─────────────────────────────────────────────────────────────────────────────
const F = {
  journeyTasks: "app/actions/journey-tasks.ts",
  multiPersona: "app/actions/multi-persona.ts",
  aiPredictions: "app/actions/ai-predictions.ts",
  journeyPage: "app/portal/[contactId]/journey/page.tsx",
  journeyChecklist: "app/portal/[contactId]/journey/journey-checklist.tsx",
  teamPage: "app/portal/[contactId]/team/page.tsx",
  coordinatorPage: "app/dashboard/coordinator/page.tsx",
} as const

// ─────────────────────────────────────────────────────────────────────────────
// THE STATIC CHECK REGISTRY. Each entry carries its own NEGATIVE mutation, so an
// assertion and the proof it can fail live in one place and cannot drift apart.
// ─────────────────────────────────────────────────────────────────────────────
interface Check {
  id: string
  name: string
  run: () => boolean
  /** Mutation that MUST make `run()` return false. */
  breaks: { file: string; find: string; replace: string }
}

const CHECKS: Check[] = [
  // ── journey-tasks: the client checklist rail ────────────────────────────────
  {
    id: "jt-no-milestone-write",
    name: "journey-tasks NEVER writes transaction_milestones (agent-owned; 8+ existing writers)",
    run: () => !/transaction_milestones/.test(src(F.journeyTasks)),
    breaks: {
      file: F.journeyTasks,
      find: `.from("client_portal_activity")\n    .insert({`,
      replace: `.from("transaction_milestones")\n    .insert({`,
    },
  },
  {
    id: "jt-completions-source",
    name: "getTaskCompletions reads the ledger completeTask writes (client_portal_activity), not a phantom join",
    run: () => {
      const body = functionBody(src1(F.journeyTasks), "getTaskCompletions")
      const stmts = supabaseStatements(body)
      return stmts.length > 0 && stmts.every((s) => s.table === "client_portal_activity")
    },
    breaks: {
      file: F.journeyTasks,
      find: `.from("client_portal_activity")
    .select("id, contact_id, activity_type, metadata, created_at")`,
      replace: `.from("transaction_milestones")
    .select("id, contact_id, activity_type, metadata, created_at")`,
    },
  },
  {
    id: "jt-error-destructured",
    name: "EVERY supabase statement in journey-tasks binds `error` (supabase-js resolves refusals)",
    run: () => {
      const stmts = supabaseStatements(src1(F.journeyTasks))
      return stmts.length >= 8 && stmts.every((s) => s.binding !== null && /\berror\b/.test(s.binding))
    },
    breaks: {
      file: F.journeyTasks,
      find: `const { data, error } = await svc
    .from("client_portal_activity")`,
      replace: `const { data } = await svc
    .from("client_portal_activity")`,
    },
  },
  {
    id: "jt-service-client-scoped",
    name: "EVERY service-client statement in journey-tasks carries an explicit brokerage anchor (RLS is bypassed)",
    run: () => {
      const stmts = supabaseStatements(src1(F.journeyTasks)).filter((s) =>
        ["client_portal_activity", "client_documents", "journey_stage_progress", "contacts"].includes(s.table),
      )
      return stmts.length >= 7 && stmts.every((s) => /brokerage_id/.test(s.chain))
    },
    breaks: {
      file: F.journeyTasks,
      find: `      contact_id: data.contactId,
      brokerage_id: anchor.brokerageId,
      agent_id: anchor.agentId,`,
      replace: `      contact_id: data.contactId,
      agent_id: anchor.agentId,`,
    },
  },
  {
    id: "jt-activity-agent-stamp",
    name: "the task ledger row is stamped with the owning agent, so the agent side can actually read it back",
    run: () => {
      const body = functionBody(src1(F.journeyTasks), "completeTask")
      const activity = supabaseStatements(body).find((s) => s.table === "client_portal_activity")
      return !!activity && /agent_id\s*:/.test(activity.chain)
    },
    breaks: {
      file: F.journeyTasks,
      find: `      agent_id: anchor.agentId,
      activity_type: "task_completed",`,
      replace: `      activity_type: "task_completed",`,
    },
  },
  {
    id: "jt-single-writer-per-task",
    name: "ONE ledger row per completed task — the dead `consolidated` sentinel double-write is gone",
    run: () => {
      const stmts = supabaseStatements(src1(F.journeyTasks))
      const inserts = stmts.filter((s) => s.table === "client_portal_activity" && /\.insert\(/.test(s.chain))
      return inserts.length === 1
    },
    breaks: {
      file: F.journeyTasks,
      find: `  return { success: true, recorded: "client_portal_activity", stageRecorded }`,
      replace: `  const { error: dupErr } = await svc.from("client_portal_activity").insert({ contact_id: data.contactId })
  if (dupErr) console.error(dupErr.message)
  return { success: true, recorded: "client_portal_activity", stageRecorded }`,
    },
  },
  {
    id: "jt-doc-url-guard",
    name: "the client_documents write is guarded on a real document_url (the column is NOT NULL)",
    run: () => {
      const body = functionBody(src1(F.journeyTasks), "completeTask")
      const doc = supabaseStatements(body).find((s) => s.table === "client_documents")
      if (!doc) return false
      const before = body.slice(0, body.indexOf(doc.chain))
      // a conditional on the resolved url must gate the insert, and the insert must supply the column
      return /documentUrl/.test(before) && /if\s*\([^)]*documentUrl[^)]*\)/.test(before) && /document_url\s*:/.test(doc.chain)
    },
    breaks: {
      file: F.journeyTasks,
      find: `if (data.formData?.document_type && documentUrl) {`,
      replace: `if (data.formData?.document_type) {`,
    },
  },
  {
    id: "jt-stage-progress-live",
    name: "getStageProgress/updateStageProgress actually touch journey_stage_progress (not neutered stubs)",
    run: () => {
      const get = functionBody(src1(F.journeyTasks), "getStageProgress")
      const upd = functionBody(src1(F.journeyTasks), "updateStageProgress")
      const getStmts = supabaseStatements(get)
      const updStmts = supabaseStatements(upd)
      return (
        getStmts.some((s) => s.table === "journey_stage_progress" && /\.select\(/.test(s.chain)) &&
        updStmts.some((s) => s.table === "journey_stage_progress" && /\.insert\(/.test(s.chain)) &&
        updStmts.some((s) => s.table === "journey_stage_progress" && /\.update\(/.test(s.chain))
      )
    },
    breaks: {
      file: F.journeyTasks,
      find: `    const { error: insErr } = await svc.from("journey_stage_progress").insert({`,
      replace: `    const { error: insErr } = await svc.from("client_portal_activity").insert({`,
    },
  },
  {
    id: "jt-authorization-gate",
    name: "every contact-scoped journey action proves the caller may act for that contact",
    run: () => {
      const s = src1(F.journeyTasks)
      const gated = ["completeTask", "getTaskCompletions", "getStageProgress", "updateStageProgress"]
      return gated.every((fn) => {
        const body = functionBody(s, fn)
        return body.length > 0 && /(requireContactAccess|resolveContactAnchor)\s*\(/.test(body)
      })
    },
    breaks: {
      file: F.journeyTasks,
      find: `  const access = await requireContactAccess(contactId)
  if (!access.ok) return []`,
      replace: `  const access = { ok: true, brokerageId: "" } as any
  if (!access.ok) return []`,
    },
  },
  {
    id: "jt-no-literal-default-brokerage",
    name: 'the journey event fan-out carries a REAL brokerage, not the literal "default"',
    run: () => {
      const body = functionBody(src1(F.journeyTasks), "completeTask")
      return /brokerage_id\s*:\s*anchor\.brokerageId/.test(body) && !/brokerage_id\s*:\s*["'`]default["'`]/.test(body)
    },
    breaks: {
      file: F.journeyTasks,
      find: `      brokerage_id: anchor.brokerageId,
      event_type: "journey.task_completed",`,
      replace: `      brokerage_id: "default",
      event_type: "journey.task_completed",`,
    },
  },

  // ── the portal journey surface ──────────────────────────────────────────────
  {
    id: "portal-checklist-mounted",
    name: "the portal journey page RENDERS the checklist and feeds it from the journey actions",
    run: () => {
      const s = src1(F.journeyPage)
      return (
        /<JourneyChecklist\b/.test(s) &&
        /await[\s\S]{0,80}getTaskCompletions\s*\(/.test(s) &&
        /getStageProgress\s*\(/.test(s) &&
        /calculateJourneyProgress\s*\(/.test(s) &&
        /getPersonaJourneyStages\s*\(/.test(s)
      )
    },
    breaks: {
      file: F.journeyPage,
      find: `      <JourneyChecklist`,
      replace: `      <NoChecklistHere`,
    },
  },
  {
    id: "portal-checklist-writes",
    name: "the checklist control actually calls the server write (not a control that renders and does nothing)",
    run: () => {
      const s = src1(F.journeyChecklist)
      return /await\s+submitTaskForm\s*\(/.test(s) && /await\s+getTaskFormFields\s*\(/.test(s)
    },
    breaks: {
      file: F.journeyChecklist,
      find: `      const result = await submitTaskForm({`,
      replace: `      const result = { success: true } as any; void ({`,
    },
  },
  {
    id: "portal-server-verdict",
    name: "the checklist reports the SERVER's verdict — the refusal branch precedes every success signal",
    run: () => {
      const s = src1(F.journeyChecklist)
      const guard = s.search(/if\s*\(\s*!\s*result\.success\s*\)/)
      const setSaved = s.indexOf("setSaved(task.title)")
      const refresh = s.indexOf("router.refresh()")
      return guard >= 0 && setSaved > guard && refresh > guard && /setError\(result\.error\)/.test(s)
    },
    breaks: {
      file: F.journeyChecklist,
      find: `      if (!result.success) {
        setError(result.error)
        return
      }
      setSaved(task.title)`,
      replace: `      setSaved(task.title)
      if (!result.success) {
        setError(result.error)
        return
      }`,
    },
  },

  // ── multi-persona: coordinator split-brain ──────────────────────────────────
  {
    id: "mp-assign-writes-both",
    name: "assignTransactionCoordinator writes BOTH assignment models (column AND the junction the TC dashboard reads)",
    run: () => {
      const body = functionBody(src1(F.multiPersona), "assignTransactionCoordinator")
      const stmts = supabaseStatements(body)
      return (
        stmts.some((s) => s.table === "transactions" && /\.update\([^)]*coordinator_id/.test(s.chain)) &&
        stmts.some((s) => s.table === "transaction_assignments" && /\.upsert\(/.test(s.chain))
      )
    },
    breaks: {
      file: F.multiPersona,
      find: `    .from("transaction_assignments")
    .upsert(`,
      replace: `    .from("transaction_assignments_disabled")
    .upsert(`,
    },
  },
  {
    id: "mp-assign-still-throws",
    name: "assignTransactionCoordinator still reports failure by THROWING (its caller discards the return value)",
    run: () => {
      const body = functionBody(src1(F.multiPersona), "assignTransactionCoordinator")
      return /throw\s/.test(body) && !/return\s*\{\s*success\s*:\s*false/.test(body)
    },
    breaks: {
      file: F.multiPersona,
      find: `  if (junctionError) throw junctionError`,
      replace: `  if (junctionError) return { success: false, error: junctionError.message }`,
    },
  },
  {
    id: "mp-coordinator-union",
    name: "getCoordinatorDashboard reads BOTH assignment sources and unions them",
    run: () => {
      const body = functionBody(src1(F.multiPersona), "getCoordinatorDashboard")
      const stmts = supabaseStatements(body)
      return (
        stmts.some((s) => s.table === "transaction_assignments") &&
        stmts.some((s) => s.table === "transactions" && /coordinator_id/.test(s.chain)) &&
        /new Set\(\s*\[/.test(body)
      )
    },
    breaks: {
      file: F.multiPersona,
      find: `  const { data: directTxns, error: directError } = await supabase
    .from("transactions")
    .select("id")
    .eq("coordinator_id", coordinatorId)`,
      replace: `  const { data: directTxns, error: directError } = await supabase
    .from("transactions")
    .select("id")
    .eq("id", coordinatorId)`,
    },
  },
  {
    id: "mp-coordinator-tenant-scoped",
    name: "every coordinator-dashboard read is brokerage-scoped (no cross-tenant pipeline enumeration)",
    run: () => {
      const body = functionBody(src1(F.multiPersona), "getCoordinatorDashboard")
      const stmts = supabaseStatements(body).filter((s) =>
        ["transaction_coordinators", "transaction_assignments", "transactions"].includes(s.table),
      )
      return stmts.length >= 4 && stmts.every((s) => /brokerage_id/.test(s.chain))
    },
    breaks: {
      file: F.multiPersona,
      find: `    .select("id, is_primary, assigned_at, transaction_id")
    .eq("coordinator_id", coordinatorId)
    .eq("brokerage_id", auth.brokerageId)`,
      replace: `    .select("id, is_primary, assigned_at, transaction_id")
    .eq("coordinator_id", coordinatorId)`,
    },
  },
  {
    id: "coord-page-uses-action",
    name: "the coordinator page consumes getCoordinatorDashboard instead of its own single-source read",
    run: () => {
      const s = src1(F.coordinatorPage)
      return /getCoordinatorDashboard\s*\(/.test(s) && !/\.from\(\s*["'`]transaction_assignments["'`]\s*\)/.test(s)
    },
    breaks: {
      file: F.coordinatorPage,
      find: `  const coordinatorWorkload = await getCoordinatorDashboard(coordinatorId, { deadlineWindowDays: 14 })`,
      replace: `  const coordinatorWorkload = await supabase.from("transaction_assignments").select("*") as any`,
    },
  },
  {
    id: "coord-page-shows-failure",
    name: "a failed workload read is rendered as a failure, never as an empty pipeline",
    run: () => {
      const s = src1(F.coordinatorPage)
      return /workloadError\s*=\s*coordinatorWorkload\.error/.test(s) && /\{\s*workloadError\s*&&/.test(s)
    },
    breaks: {
      file: F.coordinatorPage,
      find: `      {workloadError && (`,
      replace: `      {false && workloadError && (`,
    },
  },

  // ── multi-persona: reviews & preferences ────────────────────────────────────
  {
    id: "mp-reviews-wired",
    name: "getAgentReviews is wired on the portal team page (published reviews reach the client)",
    run: () => {
      const s = src1(F.teamPage)
      return /import[\s\S]{0,200}getAgentReviews[\s\S]{0,120}from/.test(s) && /await\s+getAgentReviews\s*\(/.test(s)
    },
    breaks: {
      file: F.teamPage,
      find: `    ? await getAgentReviews(contact.agent_id)`,
      replace: `    ? ({ reviews: [], metrics: { totalReviews: 0, averageRating: 0, recommendationRate: 0 }, error: null } as any)`,
    },
  },
  {
    id: "mp-reviews-published-and-scoped",
    name: "getAgentReviews is PUBLISHED-only, brokerage-scoped, and returns rather than throws on a page read",
    run: () => {
      const body = functionBody(src1(F.multiPersona), "getAgentReviews")
      const stmt = supabaseStatements(body).find((s) => s.table === "agent_reviews")
      return (
        !!stmt &&
        /is_published["'`]\s*,\s*true/.test(stmt.chain) &&
        /brokerage_id/.test(stmt.chain) &&
        !/throw\s/.test(body)
      )
    },
    breaks: {
      file: F.multiPersona,
      find: `    .eq("brokerage_id", auth.brokerageId)
    .eq("is_published", true)`,
      replace: `    .eq("is_published", true)`,
    },
  },
  {
    // Wave 26 (lane L4): the duplicate was merged onto the survivor and DELETED
    // (§1 tombstone in multi-persona.ts). What the survivor lacked — the gate —
    // was ported first: submitClientFeedback used to take brokerage_id AND
    // agent_id from the request body with no session check. It now gates on the
    // contact's OWN portal session (requireContactAccess + isContactSelf), takes
    // the tenant from the contact row and the agent from the verified transaction.
    id: "mp-review-writer-gated",
    name: "submitClientReview is deleted; submitClientFeedback (the one writer) gates on the contact's own portal session, tenant + agent from the record",
    run: () => {
      const flatSrc = src1(F.multiPersona)
      const body = functionBody(flatSrc, "submitClientFeedback")
      return (
        importersOf("submitClientReview", F.multiPersona).length === 0 &&
        !/function\s+submitClientReview\s*\(/.test(flatSrc) &&
        body.length > 0 &&
        /requireContactAccess\s*\(/.test(body) &&
        /isContactSelf/.test(body) &&
        /brokerage_id:\s*access\.brokerageId/.test(body) &&
        /agent_id:\s*t\.agent_id/.test(body)
      )
    },
    breaks: {
      file: F.multiPersona,
      find: `      brokerage_id: access.brokerageId,
      agent_id: t.agent_id,`,
      replace: `      brokerage_id: data.brokerageId,
      agent_id: t.agent_id,`,
    },
  },
  {
    // Wave 26 (lane L4): WIRED, NARROWED. property_interests is one row per
    // contact and the agent's handleSaveCriteria writes price/beds/areas onto
    // it; the client's writer may touch ONLY must_have_features + keywords
    // (never preferred_locations, never a JSON blob into notes), through a
    // partial upsert, and only from the portal journey editor.
    id: "mp-prefs-writer-narrow",
    name: "saveClientJourneyPreferences is wired ONLY from the portal journey editor and writes ONLY must_have_features + keywords (never the agent's preferred_locations / notes)",
    run: () => {
      const importers = importersOf("saveClientJourneyPreferences", F.multiPersona)
      const body = functionBody(src1(F.multiPersona), "saveClientJourneyPreferences")
      return (
        importers.length === 1 &&
        importers[0].endsWith("journey/journey-preferences-editor.tsx") &&
        body.length > 0 &&
        /requireContactAccess\s*\(/.test(body) &&
        /must_have_features:/.test(body) &&
        /onConflict:\s*"contact_id"/.test(body) &&
        !/preferred_locations/.test(body) &&
        !/notes:/.test(body)
      )
    },
    breaks: {
      file: F.multiPersona,
      find: `        keywords: keywords.join(", "),
        updated_at: new Date().toISOString(),`,
      replace: `        keywords: keywords.join(", "),
        preferred_locations: [] as string[],
        updated_at: new Date().toISOString(),`,
    },
  },
  {
    id: "mp-prefs-read-gated",
    name: "getClientJourneyPreferences is wired as a READ and gated (RLS alone lets one contact read another's)",
    run: () => {
      const body = functionBody(src1(F.multiPersona), "getClientJourneyPreferences")
      const wired = /getClientJourneyPreferences\s*\(/.test(src1(F.journeyPage))
      return wired && /requireContactAccess\s*\(/.test(body) && /brokerage_id/.test(body) && !/\.single\(\)/.test(body)
    },
    breaks: {
      file: F.multiPersona,
      find: `  const access = await requireContactAccess(contactId)
  if (!access.ok) return null`,
      replace: `  const access = { ok: true, brokerageId: "" } as any
  if (!access.ok) return null`,
    },
  },

  // ── ai-predictions: the deliberate non-wiring, and the defects fixed anyway ──
  {
    id: "pred-scorer-not-wired",
    name: "predictLeadConversion stays UNWIRED (it would be the third lead scorer; RLS excludes agents)",
    run: () =>
      importersOf("predictLeadConversion", F.aiPredictions).length === 0 &&
      importersOf("getPredictiveLeadScore", F.aiPredictions).length === 0 &&
      importersOf("batchPredictLeadConversions", F.aiPredictions).length === 0,
    breaks: {
      file: F.coordinatorPage,
      find: `import { predictDeadlineRisks, getCoordinatorDashboard } from "@/app/actions/multi-persona"`,
      replace: `import { predictDeadlineRisks, getCoordinatorDashboard } from "@/app/actions/multi-persona"
import { predictLeadConversion } from "@/app/actions/ai-predictions"`,
    },
  },
  {
    id: "pred-score-tenant-anchored",
    name: "the predictive_lead_scores write supplies the NOT NULL brokerage anchor and surfaces its refusal",
    run: () => {
      const body = functionBody(src1(F.aiPredictions), "predictLeadConversion")
      const stmt = supabaseStatements(body).find((s) => s.table === "predictive_lead_scores")
      return (
        !!stmt &&
        stmt.binding !== null &&
        /\berror\b/.test(stmt.binding) &&
        /brokerage_id\s*:/.test(stmt.chain) &&
        /onConflict/.test(stmt.chain)
      )
    },
    breaks: {
      file: F.aiPredictions,
      find: `          lead_id: leadId,
          brokerage_id: callerBrokerageId,`,
      replace: `          lead_id: leadId,`,
    },
  },
  {
    id: "pred-identity-class",
    name: "a contacts-class id is REFUSED at predictive_lead_scores (lead_id FKs leads(id))",
    run: () => {
      const body = functionBody(src1(F.aiPredictions), "predictLeadConversion")
      const guardIdx = body.search(/if\s*\(\s*!\s*isLeadsClassId\s*\)/)
      const writeIdx = body.indexOf('"predictive_lead_scores"')
      return /const isLeadsClassId\s*=/.test(body) && guardIdx >= 0 && writeIdx > guardIdx
    },
    breaks: {
      file: F.aiPredictions,
      find: `    if (!isLeadsClassId) {`,
      replace: `    if (false && !isLeadsClassId) {`,
    },
  },
  {
    id: "pred-showing-route-readable",
    name: "optimizeShowingRoute anchors smart_showing_recommendations so its reader can actually see the row",
    run: () => {
      const body = functionBody(src1(F.aiPredictions), "optimizeShowingRoute")
      const stmt = supabaseStatements(body).find((s) => s.table === "smart_showing_recommendations")
      return !!stmt && stmt.binding !== null && /\berror\b/.test(stmt.binding) && /brokerage_id\s*:/.test(stmt.chain)
    },
    breaks: {
      file: F.aiPredictions,
      // WAVE 18 moved this row off the pre-conversion key: optimizeShowingRoute
      // now proves its subject is contacts-class and files on `contact_id`, the
      // column its reader matches first. The control follows the write — the
      // PROPERTY under test is unchanged (strip the tenant anchor and the row
      // becomes unreadable by everyone), only the line it is stripped from moved.
      find: `      contact_id: data.contactId,
      brokerage_id: routeBrokerageId, // without this the row is unreadable by everyone`,
      replace: `      contact_id: data.contactId,`,
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────────────────────────────────────
let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, ok: boolean) {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ✗ ${name}`)
  }
}

function sha(rel: string): string {
  return createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex")
}

// ── LAYER 1: the stripper itself ─────────────────────────────────────────────
function layerPure() {
  console.log("\nLAYER 1 — comment stripper (no assertion may be satisfied by prose)")

  check(
    "line comments are removed",
    !stripComments(`const a = 1 // transaction_milestones`).includes("transaction_milestones"),
  )
  check(
    "block comments are removed",
    !stripComments(`/* we now write\n  transaction_milestones\n*/ const a = 1`).includes("transaction_milestones"),
  )
  check(
    'a "//" INSIDE a double-quoted string survives',
    stripComments(`const u = "https://x.test/a"`).includes("https://x.test/a"),
  )
  check(
    "a comment marker inside a single-quoted string survives",
    stripComments(`const s = 'a // b'`).includes("a // b"),
  )
  check(
    "a comment marker inside a template literal survives",
    stripComments("const s = `a // b ${x} c`").includes("a // b"),
  )
  check(
    "a '//' inside a REGEX literal does not eat the rest of the line",
    stripComments(`const r = /https:\\/\\//; const keep = 1`).includes("const keep = 1"),
  )
  check(
    "division is not mistaken for a regex literal",
    stripComments(`const q = a / b; const keep = 2`).includes("const keep = 2"),
  )
  check(
    "code after a block comment survives",
    stripComments(`/* x */ const keep = 3`).includes("const keep = 3"),
  )
  // The load-bearing one: a real file's prose must not satisfy a table assertion.
  check(
    "REAL FILE: journey-tasks names transaction_milestones ONLY in prose, and the stripper proves it",
    /transaction_milestones/.test(raw(F.journeyTasks)) && !/transaction_milestones/.test(src(F.journeyTasks)),
  )
}

// ── LAYER 2: statics ─────────────────────────────────────────────────────────
function layerStatic() {
  console.log("\nLAYER 2 — static constructs")
  for (const c of CHECKS) {
    let ok = false
    try {
      ok = c.run()
    } catch (e) {
      ok = false
      console.log(`      (threw: ${e instanceof Error ? e.message : String(e)})`)
    }
    check(c.name, ok)
  }
}

// ── LAYER 3: live ────────────────────────────────────────────────────────────
async function layerLive() {
  console.log("\nLAYER 3 — live schema truth + round trip (creds-gated)")

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log("  ⏭  SKIPPED LOUDLY — SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set.")
    console.log("     Layers 1, 2 and 4 ran. NOTHING in this layer was scored as a pass.")
    return
  }

  let createClient: any
  try {
    ;({ createClient } = await import("@supabase/supabase-js"))
  } catch {
    console.log("  ⏭  SKIPPED LOUDLY — @supabase/supabase-js not resolvable. Nothing scored.")
    return
  }

  const db = createClient(url, key, { auth: { persistSession: false } })

  // Reachability first, so a network error is a SKIP and never a pass.
  const probe = await db.from("contacts").select("id").limit(1)
  if (probe.error) {
    console.log(`  ⏭  SKIPPED LOUDLY — database unreachable / refused: ${probe.error.message}`)
    console.log("     NOTHING in this layer was scored as a pass.")
    return
  }

  // journey_stage_progress must really exist with the shape the action writes.
  const jsp = await db.from("journey_stage_progress").select("id, brokerage_id, contact_id, stage_name, progress_pct, current_task, started_at, completed_at").limit(1)
  check("live: journey_stage_progress exists with the columns updateStageProgress writes", !jsp.error)

  const cpa = await db.from("client_portal_activity").select("id, brokerage_id, agent_id, contact_id, activity_type, metadata").limit(1)
  check("live: client_portal_activity carries brokerage_id AND agent_id (the stamps the agent read needs)", !cpa.error)

  const ta = await db.from("transaction_assignments").select("id, transaction_id, coordinator_id, brokerage_id, is_primary").limit(1)
  check("live: transaction_assignments exists with the junction columns the fix upserts", !ta.error)

  const txn = await db.from("transactions").select("id, coordinator_id, brokerage_id").limit(1)
  check("live: transactions.coordinator_id exists (the OTHER half of the split-brain)", !txn.error)

  const ar = await db.from("agent_reviews").select("id, brokerage_id, agent_id, contact_id, is_published, rating").limit(1)
  check("live: agent_reviews carries contact_id + is_published (submitClientFeedback's superset)", !ar.error)

  // The NOT NULL that made two writers fail silently. Proven by attempting the
  // exact bad row and requiring the database to refuse it.
  const badScore = await db.from("predictive_lead_scores").insert({ lead_id: "00000000-0000-0000-0000-000000000000" })
  check(
    "live: predictive_lead_scores REFUSES a row without brokerage_id (the silent-failure this pass fixed)",
    !!badScore.error,
  )
  const badDoc = await db.from("client_documents").insert({ document_name: "sim", contact_id: null })
  check("live: client_documents REFUSES a row without document_url (the NOT NULL the old code ignored)", !!badDoc.error)

  // ── ROUND TRIP with cleanup + residue re-count ──────────────────────────────
  const anchor = await db.from("contacts").select("id, brokerage_id").not("brokerage_id", "is", null).limit(1)
  if (anchor.error || !anchor.data?.length) {
    console.log("  ⏭  round trip skipped — no anchor contact with a brokerage on this database.")
  } else {
    const contactId = anchor.data[0].id as string
    const brokerageId = anchor.data[0].brokerage_id as string
    const marker = `SIMULATOR_PROBE_${Date.now()}`

    const ins = await db
      .from("journey_stage_progress")
      .insert({
        brokerage_id: brokerageId,
        contact_id: contactId,
        stage_name: marker,
        progress_pct: 42,
        current_task: marker,
      })
      .select("id")
      .single()
    check("live round trip: journey_stage_progress accepts the exact row updateStageProgress writes", !ins.error)

    if (!ins.error) {
      const readBack = await db
        .from("journey_stage_progress")
        .select("id, progress_pct, stage_name")
        .eq("contact_id", contactId)
        .eq("brokerage_id", brokerageId)
        .eq("stage_name", marker)
      check(
        "live round trip: the row is readable by the (contact_id + brokerage_id) filter getStageProgress uses",
        !readBack.error && readBack.data?.length === 1 && readBack.data[0].progress_pct === 42,
      )

      const del = await db.from("journey_stage_progress").delete().eq("id", ins.data.id)
      const residue = await db
        .from("journey_stage_progress")
        .select("id", { count: "exact", head: true })
        .eq("stage_name", marker)
      check(
        "live round trip: test data cleaned up — residue re-counted at 0",
        !del.error && !residue.error && (residue.count ?? -1) === 0,
      )
    }
  }
}

// ── LAYER 4: negative tests ──────────────────────────────────────────────────
function layerNegative() {
  console.log("\nLAYER 4 — negative tests (break it, prove the break landed, prove the check flips, restore, verify)")

  for (const c of CHECKS) {
    const rel = c.breaks.file
    const before = readFileSync(join(ROOT, rel), "utf8")
    const beforeSha = createHash("sha256").update(before).digest("hex")

    // 0. sanity: it must pass BEFORE the mutation, or the negative test proves nothing
    clearCache()
    let passesClean = false
    try {
      passesClean = c.run()
    } catch {
      passesClean = false
    }
    if (!passesClean) {
      check(`NEGATIVE[${c.id}]: baseline must pass before mutation`, false)
      continue
    }

    // 1. THE MUTATION MUST ACTUALLY APPLY. A `replace` that silently no-ops turns
    //    this whole layer into theatre, so a no-op is a hard failure.
    const mutated = before.replace(c.breaks.find, c.breaks.replace)
    if (mutated === before) {
      check(`NEGATIVE[${c.id}]: mutation applied to ${rel} (find-string still present?)`, false)
      continue
    }
    writeFileSync(join(ROOT, rel), mutated, "utf8")
    const appliedSha = createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex")
    const applied = appliedSha !== beforeSha
    if (!applied) {
      writeFileSync(join(ROOT, rel), before, "utf8")
      check(`NEGATIVE[${c.id}]: mutation reached disk`, false)
      continue
    }

    // 2. the specific check must now FAIL
    clearCache()
    let stillPasses: boolean
    try {
      stillPasses = c.run()
    } catch {
      stillPasses = false // a throw is a failure, which is what we want
    }

    // 3. restore, unconditionally
    writeFileSync(join(ROOT, rel), before, "utf8")
    clearCache()
    const restoredSha = sha(rel)

    check(`NEGATIVE[${c.id}]: breaking it flips the check to FAIL`, stillPasses === false)
    check(`NEGATIVE[${c.id}]: ${rel} restored byte-for-byte (sha256)`, restoredSha === beforeSha)
  }
}

async function main() {
  console.log("═".repeat(78))
  console.log("PERSONA / JOURNEY / PREDICTIONS WIRING SIMULATOR")
  console.log("═".repeat(78))

  layerPure()
  layerStatic()
  await layerLive()
  layerNegative()

  console.log("\n" + "═".repeat(78))
  console.log(`PASSED: ${passed}   FAILED: ${failed}`)
  if (failed > 0) {
    console.log("\nFAILURES:")
    for (const f of failures) console.log(`  ✗ ${f}`)
  }
  console.log("═".repeat(78))
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error("SIMULATOR CRASHED:", e)
  process.exit(1)
})
