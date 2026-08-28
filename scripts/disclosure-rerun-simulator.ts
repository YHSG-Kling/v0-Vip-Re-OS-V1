/**
 * scripts/disclosure-rerun-simulator.ts
 *
 * PROOF THAT THE DISCLOSURE COMPLIANCE CHECK CAN RUN MORE THAN ONCE PER DEAL.
 *
 *   npx tsx scripts/disclosure-rerun-simulator.ts
 *   npx tsx scripts/disclosure-rerun-simulator.ts --negative   (mutation layer only)
 *   npx tsx scripts/disclosure-rerun-simulator.ts --only=S3    (one assertion)
 *
 * THE DEFECT
 * ──────────
 * compliance_checklists is UNIQUE on (transaction_id, checklist_type).
 * checkTransactionDisclosures did a plain `.insert()` and did not destructure the
 * result, so the second run for a deal raised 23505, supabase-js RESOLVED the
 * refusal, and the action returned success having written nothing. The check
 * could only ever land once per deal.
 *
 * THE SHAPE OF THE FIX, AND WHY UPSERT RATHER THAN HISTORY
 * ────────────────────────────────────────────────────────
 * No reader of this table orders by created_at or takes a latest row —
 * lib/deal-health/health-scorer.ts, lib/application/compliance-monitoring.ts and
 * app/actions/workflows.ts each read every row for a transaction and treat it as
 * CURRENT STATE. Keeping a row per run would mix stale snapshots into the live
 * deal-health score. So: one authoritative row per checklist_type, and a re-run
 * UPDATES it.
 *
 * THREE LAYERS
 * ────────────
 *   LAYER 1 · STATIC.  Every assertion reads COMMENT-STRIPPED source, so no claim
 *     can be satisfied by prose that merely describes the fix. Assertions test
 *     CONSTRUCTS — "the write names a conflict arbiter", "the error is
 *     destructured and turned into a returned failure", "every writer of the
 *     table agrees on the same arbiter", "the offered priority vocabulary is
 *     interpolated from a constant" — never the presence of a chosen string.
 *     One assertion (S6) deliberately reads the COMMENTS instead, to prove the
 *     false claim is gone and was not replaced by a new one.
 *
 *   LAYER 2 · LIVE (creds-gated).  Runs the disclosure write TWICE against the
 *     real database and proves the first call INSERTs, the second UPDATEs the same
 *     row, and exactly one row survives. SKIPS LOUDLY without creds — a network
 *     error is never scored as a pass. Every probe row is deleted and the residue
 *     is re-counted to zero.
 *
 *   LAYER 3 · NEGATIVE.  Every assertion is broken in the source on purpose. The
 *     mutation is verified to have ACTUALLY APPLIED (a `replace` that silently
 *     no-ops would make the exercise theatre), the assertion is re-run and must
 *     FLIP TO FAILURE, the file is restored, and the restore is verified by
 *     sha256 against the pre-mutation digest.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { blankComments } from "./strip-comments"

const ROOT = process.cwd()
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}`))
const ONLY = arg("only")?.split("=")[1] ?? null
const RUN_NEGATIVE = !!arg("negative") || !ONLY

const TABLE = "compliance_checklists"
const ARBITER = "transaction_id,checklist_type"

const F = {
  txnDocs: "app/actions/ai-transaction-documents.ts",
  docIntel: "app/actions/ai-document-intelligence.ts",
  workflows: "app/actions/workflows.ts",
  vocab: "lib/transactions/task-vocabulary.ts",
  coordinator: "app/actions/ai-transaction-coordinator.ts",
  migration: "supabase/migrations/m370-drop-redundant-compliance-checklist-unique.sql",
} as const

/** Every module that writes compliance_checklists. They must not disagree. */
// THE ROSTER SHRANK BY OWNER RULING (2026-08-28, lane E2, deletion approved in
// the wave-14 ledger review): workflows.ts:triggerComplianceChecklist — the
// empty-shell third writer of the same ensure-exists upsert row — was deleted
// with checkTransactionDisclosures named as survivor. Two writers remain, and
// every assertion below now holds those two to the shared arbiter.
const WRITERS = [F.txnDocs, F.docIntel] as const

// ─────────────────────────────────────────────────────────────────────────────
// COMMENT STRIPPER
//
// Hand-rolled rather than a regex, because a regex cannot tell a `//` inside a
// string, a template literal or a regex literal from a real comment — and
// stripping the wrong one would corrupt the very source every assertion reads.
// Whitespace is preserved so offsets and line structure stay meaningful.
// ─────────────────────────────────────────────────────────────────────────────

// hand-rolled scanner replaced (finding #250): it could not see nested `${…}` templates, regex literals, or an apostrophe in JSX text, and went blind on the code it judges.
const stripComments = blankComments

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE ACCESS
// ─────────────────────────────────────────────────────────────────────────────

function raw(file: string): string {
  return readFileSync(resolve(ROOT, file), "utf8")
}
/** Comment-stripped source. Never cached — the negative layer rewrites files. */
function code(file: string): string {
  return stripComments(raw(file))
}
/** ONLY the comment text: the characters the stripper blanked out. */
function commentsOf(file: string): string {
  const r = raw(file)
  const s = stripComments(r)
  let out = ""
  for (let i = 0; i < r.length; i++) {
    if (s[i] === " " && r[i] !== " ") out += r[i]
    else if (r[i] === "\n") out += "\n"
  }
  return out
}

/** Balance `{` … `}` from `open`; returns index of the matching `}` or -1. */
function matchBrace(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The BODY of a top-level `function <name>(…)`.
 *
 * Naively taking the first `{` after the name lands on the destructured params
 * object (`params: {`) or on a `Promise<{ … }>` return annotation, so the "body"
 * comes back as a type and every assertion reading it silently finds nothing.
 * These are module-level declarations, so the body is the `{` whose match is the
 * first `}` alone on its line at column 0.
 */
function fnBody(src: string, name: string): string {
  const idx = src.search(new RegExp(`function\\s+${name}\\s*\\(`))
  if (idx < 0) return ""
  let finalBrace = -1
  for (let i = idx; i < src.length - 1; i++) {
    if (src[i] !== "\n" || src[i + 1] !== "}") continue
    let j = i + 2
    while (j < src.length && src[j] !== "\n" && /\s/.test(src[j])) j++
    if (j >= src.length || src[j] === "\n") {
      finalBrace = i + 1
      break
    }
  }
  if (finalBrace < 0) return ""
  let cursor = idx
  while (cursor < finalBrace) {
    const open = src.indexOf("{", cursor)
    if (open < 0 || open > finalBrace) return ""
    if (matchBrace(src, open) === finalBrace) return src.slice(open, finalBrace + 1)
    cursor = open + 1
  }
  return ""
}

/** Balance `(` … `)` from `open`; returns index of the matching `)` or -1. */
function matchParen(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++
    else if (src[i] === ")") {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/**
 * The full argument list of the `.upsert(` / `.insert(` call that belongs to the
 * `.from("<table>")` call — i.e. the write statement's arguments, balanced.
 *
 * Guards against straying into a LATER query: if another `.from("` appears
 * between the table token and the verb, this `.from()` had no write attached and
 * we must report that rather than silently borrowing someone else's arguments.
 */
function writeCall(
  src: string,
  table: string,
  fromIndex = 0,
): { verb: "insert" | "upsert"; args: string; at: number } | null {
  const tableIdx = src.indexOf(`"${table}"`, fromIndex)
  if (tableIdx < 0) return null

  let best: { verb: "insert" | "upsert"; args: string; at: number } | null = null
  for (const verb of ["upsert", "insert"] as const) {
    const vIdx = src.indexOf(`.${verb}(`, tableIdx)
    if (vIdx < 0) continue
    if (src.slice(tableIdx + table.length, vIdx).includes('.from("')) continue
    if (best === null || vIdx < best.at) {
      const open = src.indexOf("(", vIdx)
      const close = matchParen(src, open)
      if (close < 0) continue
      best = { verb, args: src.slice(open + 1, close), at: vIdx }
    }
  }
  return best
}

/** Every write of `table` in `src`, in source order. */
function allWriteCalls(src: string, table: string) {
  const found: Array<{ verb: "insert" | "upsert"; args: string; at: number }> = []
  let cursor = 0
  for (;;) {
    const tableIdx = src.indexOf(`"${table}"`, cursor)
    if (tableIdx < 0) break
    const w = writeCall(src, table, tableIdx)
    if (w) found.push(w)
    cursor = tableIdx + table.length
  }
  return found
}

/** The onConflict arbiter named by a write call's argument list, if any. */
function arbiterOf(args: string): string | null {
  const m = args.match(/onConflict\s*:\s*["'`]([^"'`]+)["'`]/)
  return m ? m[1].replace(/\s+/g, "") : null
}

/** The string members of an `as const` array assigned to `name`. */
function constStringArray(src: string, name: string): string[] | null {
  const m = src.match(new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`))
  if (!m) return null
  return Array.from(m[1].matchAll(/["']([^"']+)["']/g)).map((x) => x[1])
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")

/**
 * Is `errVar` destructured from the write and turned into a RETURNED FAILURE?
 * Requires all three: the binding, a branch on it, and a `success: false` inside
 * that branch. `const { error }` alone proves nothing if nobody reads it.
 */
function errorIsHandled(src: string, writeAt: number): { ok: boolean; detail: string } {
  // The binding sits on the statement that contains the write. Search backwards
  // for the nearest `const {` that opens this statement.
  const head = src.lastIndexOf("const {", writeAt)
  if (head < 0) return { ok: false, detail: "write result is not destructured at all" }
  const headEnd = src.indexOf("}", head)
  if (headEnd < 0 || headEnd > writeAt) return { ok: false, detail: "write result is not destructured at all" }
  const binding = src.slice(head, headEnd + 1)
  const m = binding.match(/error\s*:\s*([A-Za-z_$][\w$]*)|(\berror\b)\s*[,}]/)
  if (!m) return { ok: false, detail: `destructuring does not bind error: ${binding.replace(/\s+/g, " ")}` }
  const errVar = m[1] ?? "error"

  const after = src.slice(writeAt, writeAt + 1400)
  const branch = new RegExp(`if\\s*\\(\\s*${errVar}\\b`)
  if (!branch.test(after)) return { ok: false, detail: `${errVar} is bound but never branched on` }
  const branchAt = after.search(branch)
  const branchBody = after.slice(branchAt, branchAt + 500)
  if (!/success\s*:\s*false/.test(branchBody)) {
    return { ok: false, detail: `if (${errVar}) does not return a failure` }
  }
  return { ok: true, detail: `error bound as \`${errVar}\`, branched, returns success:false` }
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSERTIONS
// ─────────────────────────────────────────────────────────────────────────────

interface Break {
  file: string
  find: string
  replace: string
}
interface Assertion {
  id: string
  what: string
  run: () => { ok: boolean; detail?: string }
  breaks: Break[]
}

const ASSERTIONS: Assertion[] = []
const assert = (a: Assertion) => ASSERTIONS.push(a)

// ── S1 · the disclosure write NAMES a conflict arbiter ───────────────────────
assert({
  id: "S1",
  what: "checkTransactionDisclosures upserts compliance_checklists and NAMES its conflict arbiter",
  run() {
    const src = code(F.txnDocs)
    const w = writeCall(src, TABLE)
    if (!w) return { ok: false, detail: `no write of ${TABLE} found` }
    if (w.verb !== "upsert") {
      return { ok: false, detail: `the write is .${w.verb}() — a re-run cannot land on a UNIQUE (${ARBITER}) table` }
    }
    const a = arbiterOf(w.args)
    if (!a) {
      return {
        ok: false,
        detail: "upsert names NO onConflict — the arbiter falls back to the primary key, which never collides, so the unique index re-raises duplicate-key",
      }
    }
    if (a !== ARBITER) return { ok: false, detail: `arbiter is "${a}", not the unique index's columns "${ARBITER}"` }
    return { ok: true, detail: `upsert onConflict "${a}"` }
  },
  breaks: [
    // The whole point of the fix: drop the arbiter and the upsert is no better
    // than the insert it replaced.
    { file: F.txnDocs, find: `      { onConflict: "transaction_id,checklist_type" },\n`, replace: "" },
    // Revert to the original verb.
    {
      file: F.txnDocs,
      find: `await supabase.from("compliance_checklists").upsert(`,
      replace: `await supabase.from("compliance_checklists").insert(`,
    },
    // Name an arbiter that is not backed by a unique index.
    {
      file: F.txnDocs,
      find: `      { onConflict: "transaction_id,checklist_type" },`,
      replace: `      { onConflict: "transaction_id" },`,
    },
  ],
})

// ── S2 · the write's error is destructured AND returned as a failure ─────────
assert({
  id: "S2",
  what: "the disclosure write destructures error and returns a real failure when the write does not land",
  run() {
    const src = code(F.txnDocs)
    const w = writeCall(src, TABLE)
    if (!w) return { ok: false, detail: `no write of ${TABLE} found` }
    return errorIsHandled(src, w.at)
  },
  breaks: [
    // The exact original defect: a bare await, result discarded.
    {
      file: F.txnDocs,
      find: `const { error: checklistError } = await supabase.from("compliance_checklists").upsert(`,
      replace: `await supabase.from("compliance_checklists").upsert(`,
    },
    // Bound but never read — the subtler version of the same bug.
    {
      file: F.txnDocs,
      find: `    if (checklistError) {\n      return { success: false, error: \`Disclosure check could not be recorded: \${checklistError.message}\` }\n    }\n`,
      replace: "",
    },
    // Branched on, but the branch does not fail the action.
    {
      file: F.txnDocs,
      find: `      return { success: false, error: \`Disclosure check could not be recorded: \${checklistError.message}\` }`,
      replace: `      console.warn(checklistError.message)`,
    },
  ],
})

// ── S3 · EVERY writer of the table agrees on the arbiter ─────────────────────
assert({
  id: "S3",
  what: "every writer of compliance_checklists upserts on the SAME named arbiter — none can disagree about what a re-run means",
  run() {
    const seen: string[] = []
    const problems: string[] = []
    for (const f of WRITERS) {
      const src = code(f)
      const writes = allWriteCalls(src, TABLE)
      if (writes.length === 0) {
        problems.push(`${f}: writes ${TABLE} nowhere`)
        continue
      }
      for (const w of writes) {
        if (w.verb !== "upsert") {
          problems.push(`${f}: uses .${w.verb}() — the second run for a deal is refused`)
          continue
        }
        const a = arbiterOf(w.args)
        if (!a) problems.push(`${f}: upsert names no onConflict`)
        else seen.push(a)
      }
    }
    if (problems.length) return { ok: false, detail: problems.join("; ") }
    const distinct = [...new Set(seen)]
    if (distinct.length !== 1) return { ok: false, detail: `writers disagree: ${distinct.join(" vs ")}` }
    if (distinct[0] !== ARBITER) return { ok: false, detail: `agreed arbiter is "${distinct[0]}", not "${ARBITER}"` }
    return { ok: true, detail: `${seen.length} writes across ${WRITERS.length} files, all on "${ARBITER}"` }
  },
  breaks: [
    // Make the sibling disagree.
    {
      file: F.docIntel,
      find: `}, { onConflict: "transaction_id,checklist_type" })`,
      replace: `}, { onConflict: "transaction_id" })`,
    },
    // (The third writer's regression mutation left with the writer itself —
    // lane E2's approved deletion; a mutation on a file outside the roster
    // proves nothing.)
  ],
})

// ── S4 · the upsert moves updated_at, so a re-run is visible ─────────────────
assert({
  id: "S4",
  what: "every compliance_checklists upsert sets updated_at, so a re-run is observable on the surviving row",
  run() {
    const missing: string[] = []
    for (const f of WRITERS) {
      for (const w of allWriteCalls(code(f), TABLE)) {
        if (!/updated_at\s*:/.test(w.args)) missing.push(f)
      }
    }
    if (missing.length) {
      return { ok: false, detail: `no updated_at on the write in: ${[...new Set(missing)].join(", ")} — an UPDATE would be indistinguishable from no write at all` }
    }
    return { ok: true, detail: `updated_at set by all ${WRITERS.length} writers` }
  },
  breaks: [
    { file: F.txnDocs, find: `        updated_at: new Date().toISOString(),\n      },\n      { onConflict:`, replace: `      },\n      { onConflict:` },
  ],
})

// ── S5 · tenant scope travels with every write ───────────────────────────────
assert({
  id: "S5",
  what: "every compliance_checklists write stamps brokerage_id (the RLS WITH CHECK is false for NULL)",
  run() {
    const missing: string[] = []
    for (const f of WRITERS) {
      for (const w of allWriteCalls(code(f), TABLE)) {
        if (!/brokerage_id\s*:/.test(w.args)) missing.push(f)
      }
    }
    if (missing.length) return { ok: false, detail: `unstamped write in: ${[...new Set(missing)].join(", ")}` }
    return { ok: true, detail: "brokerage_id stamped by all writers" }
  },
  breaks: [
    // Anchored to the compliance_checklists payload specifically: the bare
    // `brokerage_id: …` line also appears in this file's transaction_tasks
    // payload, and mutating THAT would leave the code under test untouched
    // while still changing the file.
    //
    // The stamped VALUE changed on 2026-08-26 (`params.brokerageId` →
    // `wc.brokerageId`) when every export in that file moved onto the act-as
    // write seam and the caller's brokerageId became a verified claim rather
    // than an input — see the header of app/actions/ai-transaction-documents.ts.
    // S5's RULE is untouched: every write still has to stamp a tenant. Only this
    // mutation ANCHOR follows the source, and it must, or the negative layer
    // stops firing and this assertion silently becomes unprovable.
    {
      file: F.txnDocs,
      find: `        brokerage_id: wc.brokerageId,\n        checklist_type: "disclosures",`,
      replace: `        checklist_type: "disclosures",`,
    },
  ],
})

// ── S6 · the false comment is gone, and no NEW false claim replaced it ───────
//
// This is the one assertion that reads COMMENTS rather than code — that is the
// point of it. The original defect was protected for as long as it was by a
// comment asserting the constraint did not exist.
const FALSE_CLAIMS: Array<{ re: RegExp; why: string }> = [
  { re: /no unique constraint/i, why: "denies the UNIQUE (transaction_id, checklist_type) index that demonstrably exists" },
  { re: /point[-\s]in[-\s]time/i, why: "describes the row as a per-run snapshot; there is exactly one row per checklist_type" },
  { re: /append[-\s]only/i, why: "no reader of this table takes a latest row, so appending would corrupt the deal-health score" },
  { re: /without a unique/i, why: "denies the unique index" },
  { re: /not unique on/i, why: "denies the unique index" },
]
assert({
  id: "S6",
  what: "no comment in any writer denies the unique index or claims the table is append-only history",
  run() {
    const hits: string[] = []
    for (const f of WRITERS) {
      const text = commentsOf(f)
      for (const { re, why } of FALSE_CLAIMS) {
        const m = text.match(re)
        if (m) hits.push(`${f}: "${m[0]}" — ${why}`)
      }
    }
    if (hits.length) return { ok: false, detail: hits.join("; ") }
    return { ok: true, detail: `${WRITERS.length} writers carry no false claim about this table` }
  },
  breaks: [
    // Put the original lie back, verbatim.
    {
      file: F.txnDocs,
      find: `    // ── THE DISCLOSURE CHECK MUST BE RE-RUNNABLE ─────────────────────────────`,
      replace: `    // Insert a fresh compliance_checklists snapshot (point-in-time — no unique constraint on txn+type)`,
    },
    // A DIFFERENT false claim on the OTHER surviving writer, to prove S6 is
    // not just string-matching one sentence in one file.
    {
      file: F.docIntel,
      find: `}, { onConflict: "transaction_id,checklist_type" })`,
      replace: `}, { onConflict: "transaction_id,checklist_type" }) // append-only history table`,
    },
  ],
})

// ── S7 · the priority vocabulary is DERIVED, not hand-typed ──────────────────
assert({
  id: "S7",
  what: "the task-priority vocabulary offered to the model and written to the column both come from the shared constant",
  run() {
    const src = code(F.txnDocs)
    const vocab = constStringArray(code(F.vocab), "TRANSACTION_TASK_PRIORITIES")
    if (!vocab) return { ok: false, detail: `TRANSACTION_TASK_PRIORITIES not declared in ${F.vocab}` }

    // (a) the PROMPT must interpolate an identifier, never a literal list.
    const promptLine = src.match(/"priority"\s*:\s*([^,\n]+),/)
    if (!promptLine) return { ok: false, detail: "the prompt does not describe a priority field" }
    const offered = promptLine[1].trim()
    if (!/^\$\{[A-Za-z_$][\w$.]*\}$/.test(offered)) {
      return { ok: false, detail: `the prompt offers a hand-typed vocabulary: ${offered}` }
    }

    // (b) the WRITE must narrow through a call, not `?? "default"` — `??` only
    // fires on null/undefined and lets a present-but-invalid value straight to
    // the column.
    const written = src.match(/priority\s*:\s*([^,\n]+),/g) ?? []
    const payload = written.find((w) => !w.includes('"priority"'))
    if (!payload) return { ok: false, detail: "no priority written to transaction_tasks" }
    if (/\?\?/.test(payload)) {
      return { ok: false, detail: `the write uses a ?? fallback, which cannot catch a present-but-invalid value: ${payload.trim()}` }
    }
    if (!/[A-Za-z_$][\w$]*\s*\(/.test(payload)) {
      return { ok: false, detail: `the write does not narrow through the vocabulary: ${payload.trim()}` }
    }

    // (c) no value outside the constant may appear anywhere in this file's code.
    const strays = ["urgent", "normal", "blocker"].filter((v) => !vocab.includes(v) && src.includes(`"${v}"`))
    if (strays.length) return { ok: false, detail: `value(s) the column refuses still present in code: ${strays.join(", ")}` }

    return { ok: true, detail: `offered ${offered}, written through a narrowing call, vocabulary = [${vocab.join(", ")}]` }
  },
  breaks: [
    {
      file: F.txnDocs,
      find: `  "priority": \${TRANSACTION_TASK_PRIORITY_PROMPT_UNION},`,
      replace: `  "priority": "urgent"|"high"|"medium"|"low",`,
    },
    {
      file: F.txnDocs,
      find: `        priority: coerceTaskPriority(r.priority),`,
      replace: `        priority: r.priority ?? "medium",`,
    },
  ],
})

// ── S8 · the shared constant has not drifted from the coordinator's copy ─────
assert({
  id: "S8",
  what: "the shared priority vocabulary equals the copy ai-transaction-coordinator.ts declares — the two cannot drift",
  run() {
    const shared = constStringArray(code(F.vocab), "TRANSACTION_TASK_PRIORITIES")
    const local = constStringArray(code(F.coordinator), "TRANSACTION_TASK_PRIORITIES")
    if (!shared) return { ok: false, detail: `no vocabulary in ${F.vocab}` }
    if (!local) return { ok: false, detail: `no vocabulary in ${F.coordinator}` }
    if (!sameSet(shared, local)) {
      return { ok: false, detail: `shared [${shared.join(",")}] vs coordinator [${local.join(",")}]` }
    }
    return { ok: true, detail: `[${shared.join(", ")}]` }
  },
  breaks: [
    {
      file: F.vocab,
      find: `export const TRANSACTION_TASK_PRIORITIES = ["critical", "high", "medium", "low"] as const`,
      replace: `export const TRANSACTION_TASK_PRIORITIES = ["critical", "high", "medium", "low", "urgent"] as const`,
    },
  ],
})

// ── S9 · the read feeding the model is error-checked ─────────────────────────
assert({
  id: "S9",
  what: "the transaction_documents read that feeds the compliance model destructures its error",
  run() {
    // MUST be scoped to the function under test. `indexOf` over the whole file
    // finds the FIRST transaction_documents query in the module — a different
    // function entirely — so an unscoped version of this assertion would grade
    // code that is not the code being fixed.
    const body = fnBody(code(F.txnDocs), "checkTransactionDisclosures")
    if (!body) return { ok: false, detail: "checkTransactionDisclosures not found" }
    const idx = body.indexOf(`"transaction_documents"`)
    if (idx < 0) return { ok: false, detail: "no transaction_documents read in checkTransactionDisclosures" }
    const head = body.lastIndexOf("const {", idx)
    if (head < 0) return { ok: false, detail: "read result is not destructured" }
    const binding = body.slice(head, body.indexOf("}", head) + 1)
    const m = binding.match(/error\s*:\s*([A-Za-z_$][\w$]*)|(\berror\b)\s*[,}]/)
    if (!m) {
      return {
        ok: false,
        detail: `read binds ${binding.replace(/\s+/g, " ")} — a refused read RESOLVES, so docs would be null and the model would grade a deal it was told has no documents`,
      }
    }
    const errVar = m[1] ?? "error"
    const after = body.slice(idx)
    const re = new RegExp(`if\\s*\\(\\s*${errVar}\\b[\\s\\S]{0,300}?success\\s*:\\s*false`)
    if (!re.test(after)) {
      return { ok: false, detail: `${errVar} is bound but does not produce a returned failure` }
    }
    return { ok: true, detail: `${errVar} bound, branched, returns success:false` }
  },
  breaks: [
    {
      file: F.txnDocs,
      find: `    const { data: docs, error: docsError } = await supabase`,
      replace: `    const { data: docs } = await supabase`,
    },
  ],
})

// ── S10 · the migration keeps exactly one arbiter, and says why ──────────────
assert({
  id: "S10",
  what: "m370 drops exactly ONE of the duplicate unique constraints, keeps the other, and guards that exactly one survives",
  run() {
    const sql = raw(F.migration)
    const drops = Array.from(sql.matchAll(/DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w]*)/gi)).map((m) => m[1])
    const distinct = [...new Set(drops)]
    if (distinct.length !== 1) {
      return { ok: false, detail: `drops ${distinct.length} constraints (${distinct.join(", ")}) — dropping both would break every upsert's arbiter` }
    }
    if (distinct[0] !== "compliance_checklists_txn_type_unique") {
      return { ok: false, detail: `drops ${distinct[0]}; the later duplicate is the one that should go` }
    }
    // The survivor must be named, and the reason stated.
    if (!/compliance_checklists_transaction_id_checklist_type_key/.test(sql)) {
      return { ok: false, detail: "the surviving constraint is never named, so the choice is unexplained" }
    }
    // The guard must exist, or a future edit could quietly leave zero.
    if (!/RAISE\s+EXCEPTION/i.test(sql) || !/count\(\*\)/i.test(sql)) {
      return { ok: false, detail: "no post-drop guard asserting exactly one unique constraint survives" }
    }
    return { ok: true, detail: `drops ${distinct[0]}, names the survivor, guards the count` }
  },
  breaks: [
    {
      file: F.migration,
      find: `ALTER TABLE public.compliance_checklists\n  DROP CONSTRAINT IF EXISTS compliance_checklists_txn_type_unique;`,
      replace: `ALTER TABLE public.compliance_checklists\n  DROP CONSTRAINT IF EXISTS compliance_checklists_txn_type_unique;\nALTER TABLE public.compliance_checklists\n  DROP CONSTRAINT IF EXISTS compliance_checklists_transaction_id_checklist_type_key;`,
    },
    { file: F.migration, find: `    RAISE EXCEPTION`, replace: `    RAISE NOTICE` },
  ],
})

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 · LIVE — creds-gated, SKIPS LOUDLY
// ─────────────────────────────────────────────────────────────────────────────

interface LiveResult {
  ran: boolean
  passed: number
  failed: number
  notes: string[]
}

async function liveLayer(): Promise<LiveResult> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  const skip = (why: string): LiveResult => ({ ran: false, passed: 0, failed: 0, notes: [why] })

  if (!url || !key) return skip("no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env")

  let createClient: any
  try {
    ;({ createClient } = await import("@supabase/supabase-js"))
  } catch (e: any) {
    return skip(`@supabase/supabase-js unavailable: ${e?.message}`)
  }

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

  // Reachability FIRST. A network error must be a SKIP, never a pass and never a
  // failure attributed to the code under test.
  const probe = await db.from("transactions").select("id, brokerage_id").not("brokerage_id", "is", null).limit(1)
  if (probe.error) return skip(`database unreachable: ${probe.error.message}`)
  const anchor = probe.data?.[0]
  if (!anchor) return skip("no transactions row with a brokerage_id to anchor the probe to")

  // Service-role reads bypass RLS, so tenant scope must be filtered EXPLICITLY.
  const scoped = () =>
    db.from(TABLE).select("*").eq("transaction_id", anchor.id).eq("brokerage_id", anchor.brokerage_id)

  let passed = 0
  let failed = 0
  const ok = (label: string, cond: boolean, detail = "") => {
    if (cond) {
      passed++
      console.log(`   ✔ ${label}${detail ? ` — ${detail}` : ""}`)
    } else {
      failed++
      console.log(`   ✘ ${label}${detail ? ` — ${detail}` : ""}`)
    }
  }

  const PROBE_TYPE = `__rerun_probe_${Date.now()}__`

  // NOTE ON THE CONSTRAINT ITSELF: PostgREST exposes no catalog access, so the
  // surviving unique index is proved BEHAVIOURALLY by L3 (the upsert's named
  // arbiter resolves at all) and L4 (a plain repeat insert is still refused).
  // Together those are stronger than reading pg_constraint: they prove the
  // constraint is not merely present but enforcing.

  // ── L2 · every column the writers name actually exists ───────────────────
  const namedColumns = new Set<string>()
  for (const f of WRITERS) {
    for (const w of allWriteCalls(code(f), TABLE)) {
      for (const m of w.args.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:/gim)) namedColumns.add(m[1])
    }
  }
  namedColumns.delete("onConflict")
  const colProbe = await db.from(TABLE).select([...namedColumns].join(", ")).limit(1)
  ok(
    `L2 every column the writers name exists on ${TABLE}`,
    !colProbe.error,
    colProbe.error ? colProbe.error.message : [...namedColumns].join(", "),
  )

  // ── L3 · THE OWNER'S REQUIREMENT: run it TWICE ───────────────────────────
  // First call INSERTs. Second call must SUCCEED and UPDATE — not fail, not
  // duplicate. Exactly one row survives.
  const payload = (score: number, tag: string) => ({
    transaction_id: anchor.id,
    brokerage_id: anchor.brokerage_id,
    checklist_type: PROBE_TYPE,
    items: [{ name: "Lead-Based Paint", present: score > 50, status: score > 50 ? "complete" : "missing" }],
    compliance_score: score,
    ai_recommendations: [tag],
    updated_at: new Date(Date.now() + (score > 50 ? 60_000 : 0)).toISOString(),
  })

  const run1 = await db.from(TABLE).upsert(payload(41, "run1"), { onConflict: ARBITER }).select().single()
  ok("L3a first disclosure write lands", !run1.error && !!run1.data?.id, run1.error?.message ?? `id ${run1.data?.id}`)

  const run2 = await db.from(TABLE).upsert(payload(88, "run2"), { onConflict: ARBITER }).select().single()
  ok(
    "L3b SECOND write for the same deal SUCCEEDS (this is the defect that was fixed)",
    !run2.error,
    run2.error ? `${run2.error.code}: ${run2.error.message}` : "no error",
  )
  ok(
    "L3c the second write UPDATED the first row rather than creating a second",
    !!run1.data?.id && run2.data?.id === run1.data?.id,
    `run1=${run1.data?.id} run2=${run2.data?.id}`,
  )
  ok(
    "L3d the re-run's values actually replaced the first run's",
    run2.data?.compliance_score === 88 && run2.data?.updated_at !== run1.data?.updated_at,
    `score ${run1.data?.compliance_score} → ${run2.data?.compliance_score}, updated_at moved: ${run2.data?.updated_at !== run1.data?.updated_at}`,
  )

  const after = await scoped().eq("checklist_type", PROBE_TYPE)
  ok("L3e exactly ONE row remains for (transaction, checklist_type)", (after.data?.length ?? -1) === 1, `${after.data?.length} row(s)`)

  // ── L4 · the arbiter is real: the OLD code path must still be refused ─────
  // If the surviving unique constraint had been dropped, this insert would
  // succeed and L3 would be proving nothing.
  const naive = await db.from(TABLE).insert(payload(50, "naive"))
  ok(
    "L4 a plain repeat .insert() is still REFUSED — the unique arbiter is genuinely enforced",
    !!naive.error && naive.error.code === "23505",
    naive.error ? `${naive.error.code}` : "the insert SUCCEEDED — the unique constraint is gone",
  )

  // ── L5 · the declared priority vocabulary is what the column accepts ──────
  const declared = constStringArray(code(F.vocab), "TRANSACTION_TASK_PRIORITIES") ?? []
  const accepted: string[] = []
  const refused: string[] = []
  const TASK_MARK = `__rerun_probe_task_${Date.now()}__`
  for (const p of [...declared, "urgent"]) {
    const t = await db
      .from("transaction_tasks")
      .insert({
        transaction_id: anchor.id,
        brokerage_id: anchor.brokerage_id,
        title: `${TASK_MARK}${p}`,
        priority: p,
        status: "pending",
      })
      .select("id")
    if (t.error) refused.push(p)
    else accepted.push(p)
  }
  ok(
    "L5 the column accepts EVERY declared priority and refuses 'urgent'",
    sameSet(accepted, declared) && refused.includes("urgent"),
    `accepted [${accepted.join(",")}] refused [${refused.join(",")}]`,
  )

  // ── CLEANUP + RESIDUE RE-COUNT ───────────────────────────────────────────
  await db.from(TABLE).delete().eq("transaction_id", anchor.id).eq("checklist_type", PROBE_TYPE)
  await db.from("transaction_tasks").delete().like("title", `${TASK_MARK}%`)

  const r1 = await db
    .from(TABLE)
    .select("id", { count: "exact", head: true })
    .eq("transaction_id", anchor.id)
    .eq("checklist_type", PROBE_TYPE)
  const r2 = await db
    .from("transaction_tasks")
    .select("id", { count: "exact", head: true })
    .like("title", `${TASK_MARK}%`)
  const residue: string[] = []
  if ((r1.count ?? -1) !== 0) residue.push(`${TABLE}=${r1.count}`)
  if ((r2.count ?? -1) !== 0) residue.push(`transaction_tasks=${r2.count}`)
  ok("L6 every seeded row removed — residue re-counted to zero", residue.length === 0, residue.join(", ") || "0 rows")

  return { ran: true, passed, failed, notes: [`anchored on transaction ${anchor.id}`] }
}

// ─────────────────────────────────────────────────────────────────────────────
// RUNNER
// ─────────────────────────────────────────────────────────────────────────────

function runOne(a: Assertion) {
  try {
    return a.run()
  } catch (e: any) {
    return { ok: false, detail: `threw: ${e?.message}` }
  }
}

async function main() {
  console.log("═══════════════════════════════════════════════════════════════════")
  console.log(" DISCLOSURE RE-RUN SIMULATOR")
  console.log(" (static assertions read COMMENT-STRIPPED source; S6 reads comments)")
  console.log("═══════════════════════════════════════════════════════════════════")

  // The stripper must actually strip, or every assertion below reads prose and
  // proves nothing.
  {
    const sample = raw(F.txnDocs)
    const stripped = stripComments(sample)
    const shorter = stripped.replace(/\s/g, "").length < sample.replace(/\s/g, "").length
    const proseGone = !/THE DISCLOSURE CHECK MUST BE RE-RUNNABLE/.test(stripped)
    const codeKept = /export async function checkTransactionDisclosures/.test(stripped)
    const commentsFound = commentsOf(F.txnDocs).length > 200
    if (!shorter || !proseGone || !codeKept || !commentsFound) {
      console.log("\n✘ FATAL — the comment stripper is not working; every assertion below would be meaningless.")
      console.log(`   shorter=${shorter} proseGone=${proseGone} codeKept=${codeKept} commentsFound=${commentsFound}`)
      process.exit(1)
    }
    console.log("\n[stripper]  ok — comments removed, code preserved, comment text recoverable")
  }

  const selected = ONLY ? ASSERTIONS.filter((a) => a.id === ONLY) : ASSERTIONS

  console.log("\n─── LAYER 1 · STATIC ──────────────────────────────────────────────")
  let pass = 0
  let fail = 0
  const failures: string[] = []
  for (const a of selected) {
    const r = runOne(a)
    if (r.ok) {
      pass++
      console.log(`  ✔ ${a.id}  ${a.what}${r.detail ? `\n        ${r.detail}` : ""}`)
    } else {
      fail++
      failures.push(`${a.id}: ${r.detail ?? ""}`)
      console.log(`  ✘ ${a.id}  ${a.what}\n        ${r.detail ?? ""}`)
    }
  }

  console.log("\n─── LAYER 2 · LIVE (creds-gated) ──────────────────────────────────")
  const live = await liveLayer()
  if (!live.ran) {
    console.log(`  ⊘ SKIPPED LOUDLY — ${live.notes.join("; ")}`)
    console.log("    The static layer proved the code's contract with the schema it CLAIMS.")
    console.log("    It did NOT prove the database agrees, and it did NOT run the write twice.")
    console.log("    Re-run with service creds to close that gap.")
  } else {
    console.log(`  (${live.notes.join("; ")})`)
    console.log(`  live: ${live.passed} passed, ${live.failed} failed`)
  }

  let negPass = 0
  let negFail = 0
  const negProblems: string[] = []

  if (RUN_NEGATIVE) {
    console.log("\n─── LAYER 3 · NEGATIVE (every assertion is broken on purpose) ─────")
    for (const a of selected) {
      for (let bi = 0; bi < a.breaks.length; bi++) {
        const b = a.breaks[bi]
        const path = resolve(ROOT, b.file)
        const before = readFileSync(path, "utf8")
        const digestBefore = createHash("sha256").update(before).digest("hex")

        // PRECONDITION — an assertion that is ALREADY failing will "flip to
        // failure" no matter what the mutation does, scoring a pass for nothing.
        // The negative test is only meaningful against a green assertion.
        const pre = runOne(a)
        if (!pre.ok) {
          negFail++
          negProblems.push(`${a.id}[${bi}]: assertion was ALREADY FAILING before the mutation — its "flip" proves nothing`)
          console.log(`  ✘ ${a.id}[${bi}]  already failing pre-mutation — negative result is meaningless`)
          continue
        }

        // AMBIGUOUS-SITE DETECTOR — `String.replace` rewrites the FIRST match.
        // If the find string occurs more than once, the mutation may land on a
        // site the assertion does not examine: the file changes (so the no-op
        // detector below stays quiet) while the code under test is untouched.
        // That is the subtlest form of test theatre, so a break must name
        // exactly one site.
        const occurrences = before.split(b.find).length - 1
        if (occurrences !== 1) {
          negFail++
          negProblems.push(
            `${a.id}[${bi}]: find string matches ${occurrences} sites in ${b.file} — the mutation is ambiguous and may not touch the code under test`,
          )
          console.log(`  ✘ ${a.id}[${bi}]  find string is not unique (${occurrences} matches) — anchor it to one site`)
          continue
        }

        const after = before.replace(b.find, b.replace)

        // NO-OP DETECTOR — a `replace` that matched nothing leaves the file
        // untouched, and the assertion would "fail to fail" for the wrong reason.
        if (after === before) {
          negFail++
          negProblems.push(`${a.id}[${bi}]: the mutation DID NOT APPLY (find string no longer matches ${b.file})`)
          console.log(`  ✘ ${a.id}[${bi}]  mutation did not apply — the negative test is theatre, fix the find string`)
          continue
        }

        writeFileSync(path, after, "utf8")
        let broke = false
        let detail = ""
        try {
          const r = runOne(a)
          broke = !r.ok
          detail = r.detail ?? ""
        } finally {
          writeFileSync(path, before, "utf8")
        }

        const restored = createHash("sha256").update(readFileSync(path)).digest("hex") === digestBefore

        if (broke && restored) {
          negPass++
          console.log(`  ✔ ${a.id}[${bi}]  broke as expected, file restored (sha256 verified)`)
        } else {
          negFail++
          if (!broke) negProblems.push(`${a.id}[${bi}]: assertion still PASSED with the defect reintroduced — it is not testing anything`)
          if (!restored) negProblems.push(`${a.id}[${bi}]: FILE NOT RESTORED (${b.file})`)
          console.log(
            `  ✘ ${a.id}[${bi}]  ${!broke ? "did NOT flip to failure" : ""}${!restored ? " FILE NOT RESTORED" : ""}${detail ? ` (${detail})` : ""}`,
          )
        }
      }
      if (a.breaks.length === 0) {
        negFail++
        negProblems.push(`${a.id}: has NO negative test — an assertion that cannot be made to fail is not testing anything`)
        console.log(`  ✘ ${a.id}  no negative test defined`)
      }
    }
  }

  console.log("\n═══════════════════════════════════════════════════════════════════")
  console.log(` STATIC   ${pass} passed, ${fail} failed`)
  console.log(` LIVE     ${live.ran ? `${live.passed} passed, ${live.failed} failed` : `SKIPPED (${live.notes.join("; ")})`}`)
  if (RUN_NEGATIVE) console.log(` NEGATIVE ${negPass} flipped to failure as required, ${negFail} did not`)
  console.log("═══════════════════════════════════════════════════════════════════")

  if (failures.length) {
    console.log("\nStatic failures:")
    for (const f of failures) console.log(`  · ${f}`)
  }
  if (negProblems.length) {
    console.log("\nNegative-layer problems:")
    for (const f of negProblems) console.log(`  · ${f}`)
  }

  process.exit(fail > 0 || negFail > 0 || (live.ran && live.failed > 0) ? 1 : 0)
}

void main()
