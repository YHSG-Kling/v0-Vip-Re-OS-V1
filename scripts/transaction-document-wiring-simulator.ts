/**
 * scripts/transaction-document-wiring-simulator.ts
 *
 * PROOF FOR THE TRANSACTION & DOCUMENT WIRING PASS.
 *
 *   npx tsx scripts/transaction-document-wiring-simulator.ts
 *   npx tsx scripts/transaction-document-wiring-simulator.ts --negative   (adds the mutation layer)
 *   npx tsx scripts/transaction-document-wiring-simulator.ts --only=C3    (one assertion)
 *
 * WHAT IT PROVES, IN THREE LAYERS
 *
 *   LAYER 1 · STATIC.  Every assertion runs against COMMENT-STRIPPED source, so
 *     no claim can be satisfied by a comment that describes the fix. Assertions
 *     test CONSTRUCTS — "the submit gate offers exactly the vocabulary the
 *     action validates", "the positive verdict is gated on the DB-applied
 *     count", "the users-class read and the agents-class write do not share one
 *     identifier" — never the presence of a particular string.
 *
 *   LAYER 2 · LIVE (creds-gated).  Probes the real database for the two things
 *     static analysis cannot know: that the vocabularies the code declares are
 *     the vocabularies the CHECK constraints accept, and that every column the
 *     wired writes name actually exists. SKIPS LOUDLY when there are no creds —
 *     a network error is never scored as a pass. All probe rows are deleted and
 *     the residue is re-counted to zero.
 *
 *   LAYER 3 · NEGATIVE.  Every assertion is broken in the source on purpose.
 *     The mutation is verified to have ACTUALLY APPLIED (a `replace` that
 *     silently no-ops would make the whole exercise theatre), the specific
 *     assertion is re-run and must FLIP TO FAILURE, the file is restored, and
 *     the restore is verified by sha256 against the pre-mutation digest.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"

const ROOT = process.cwd()
const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}`))
const ONLY = arg("only")?.split("=")[1] ?? null
const RUN_NEGATIVE = !!arg("negative") || !ONLY

// ─────────────────────────────────────────────────────────────────────────────
// FILES UNDER TEST
// ─────────────────────────────────────────────────────────────────────────────

const F = {
  dotloop: "app/actions/dotloop-integration.ts",
  coordinator: "app/actions/ai-transaction-coordinator.ts",
  docIntel: "app/actions/ai-document-intelligence.ts",
  txnPage: "app/dashboard/transactions/[id]/page.tsx",
  coordPanel: "app/dashboard/transactions/[id]/ai-coordinator-panel.tsx",
  docCenter: "app/dashboard/documents/document-center-client.tsx",
  docWorkspace: "app/dashboard/documents/document-workspace-panel.tsx",
  docActions: "app/dashboard/documents/document-actions-dialog.tsx",
  txnDetail: "app/dashboard/transactions/[id]/transaction-detail-client.tsx",
  siblingDocs: "app/actions/ai-transaction-documents.ts",
  closingWorkflow: "app/actions/ai-closing-workflow.ts",
  custody: "lib/kernel/document-custody.ts",
} as const

const SURFACES = [F.txnPage, F.coordPanel, F.docCenter, F.docWorkspace, F.docActions, F.txnDetail]

// ─────────────────────────────────────────────────────────────────────────────
// COMMENT STRIPPER
//
// A hand-rolled scanner rather than a regex, because a regex cannot tell a `//`
// inside a string, a template literal or a regex literal from a real comment —
// and stripping the wrong one would silently corrupt the very source every
// assertion reads. States: code / line-comment / block-comment / '…' / "…" /
// `…` (with ${} nesting) / regex-literal. Whitespace is preserved so that line
// numbers and "is this on its own line" checks stay meaningful.
// ─────────────────────────────────────────────────────────────────────────────

function stripComments(src: string): string {
  const out: string[] = []
  let i = 0
  const n = src.length
  // Tracks the last significant code character, which is how a `/` is
  // disambiguated between "division" and "start of a regex literal".
  let lastSig = ""
  const REGEX_PRECEDERS = new Set([
    "", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "~", "^", "<", ">",
  ])
  const tplStack: number[] = [] // brace depth inside each open template literal

  while (i < n) {
    const c = src[i]
    const c2 = src[i + 1]

    // line comment
    if (c === "/" && c2 === "/") {
      while (i < n && src[i] !== "\n") {
        out.push(" ")
        i++
      }
      continue
    }
    // block comment
    if (c === "/" && c2 === "*") {
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        out.push(src[i] === "\n" ? "\n" : " ")
        i++
      }
      out.push("  ")
      i += 2
      continue
    }
    // string literals
    if (c === "'" || c === '"') {
      const quote = c
      out.push(c)
      i++
      while (i < n) {
        if (src[i] === "\\") {
          out.push(src[i], src[i + 1] ?? "")
          i += 2
          continue
        }
        out.push(src[i])
        if (src[i] === quote) {
          i++
          break
        }
        i++
      }
      lastSig = quote
      continue
    }
    // template literal
    if (c === "`") {
      out.push(c)
      i++
      let depth = 0
      while (i < n) {
        if (src[i] === "\\") {
          out.push(src[i], src[i + 1] ?? "")
          i += 2
          continue
        }
        if (src[i] === "$" && src[i + 1] === "{") {
          depth++
          out.push("${")
          i += 2
          continue
        }
        if (depth > 0 && src[i] === "}") {
          depth--
          out.push("}")
          i++
          continue
        }
        if (depth === 0 && src[i] === "`") {
          out.push("`")
          i++
          break
        }
        out.push(src[i])
        i++
      }
      lastSig = "`"
      continue
    }
    // regex literal
    if (c === "/" && REGEX_PRECEDERS.has(lastSig)) {
      let j = i + 1
      let inClass = false
      let closed = false
      while (j < n) {
        if (src[j] === "\\") {
          j += 2
          continue
        }
        if (src[j] === "[") inClass = true
        else if (src[j] === "]") inClass = false
        else if (src[j] === "/" && !inClass) {
          closed = true
          break
        } else if (src[j] === "\n") break
        j++
      }
      if (closed) {
        out.push(src.slice(i, j + 1))
        i = j + 1
        while (i < n && /[a-z]/.test(src[i])) {
          out.push(src[i])
          i++
        }
        lastSig = "/"
        continue
      }
    }

    out.push(c)
    if (!/\s/.test(c)) lastSig = c
    i++
  }
  void tplStack
  return out.join("")
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE ACCESS
// ─────────────────────────────────────────────────────────────────────────────

const rawCache = new Map<string, string>()
function raw(file: string): string {
  const p = resolve(ROOT, file)
  const v = readFileSync(p, "utf8")
  rawCache.set(file, v)
  return v
}
/** Comment-stripped source. Never cached — the negative layer rewrites files. */
function code(file: string): string {
  return stripComments(raw(file))
}
function sha(file: string): string {
  return createHash("sha256").update(readFileSync(resolve(ROOT, file))).digest("hex")
}

/** Balance `{ … }` from `open`; returns the index of the matching `}` or -1. */
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
 * Naively taking the first `{` after the name is wrong and was wrong here: it
 * lands on the destructured-params object (`params: {`) or on a
 * `Promise<{ … }>` return annotation, so the "body" came back as a type and
 * every assertion that searched it silently found nothing — i.e. an assertion
 * that could never fail for the right reason. These are all module-level
 * declarations, so the body is the `{` whose match is the first `}` sitting at
 * column 0.
 */
function fnBody(src: string, name: string): string {
  const idx = src.search(new RegExp(`function\\s+${name}\\s*\\(`))
  if (idx < 0) return ""
  // The closing brace must be ALONE on its line. `indexOf("\n}")` was not enough:
  // a destructured params object closes as `}) {` and a `Promise<{…}>` return
  // annotation closes as `}> {`, both with `}` at column 0 — so the "body" came
  // back as the params type or the return type, and every assertion that read it
  // found nothing while looking like it had run.
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

/** The name of the top-level function whose body contains `offset`, if any. */
function enclosingFunction(src: string, offset: number): string | null {
  let best: string | null = null
  for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const body = fnBody(src, m[1])
    if (!body) continue
    const start = src.indexOf(body, m.index ?? 0)
    if (start >= 0 && offset >= start && offset <= start + body.length) best = m[1]
  }
  return best
}

/** Balanced body of an arrow-function const, e.g. `const runSmartTasks = () => {`. */
function arrowBody(src: string, name: string): string {
  const idx = src.search(new RegExp(`const\\s+${name}\\s*=`))
  if (idx < 0) return ""
  const open = src.indexOf("{", idx)
  if (open < 0) return ""
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return ""
}

/** The string members of an `as const` array assigned to `name`. */
function constStringArray(src: string, name: string): string[] | null {
  const m = src.match(new RegExp(`(?:const|let)\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as\\s+const`))
  if (!m) return null
  return Array.from(m[1].matchAll(/["']([^"']+)["']/g)).map((x) => x[1])
}

/** The string literals of a TS union declared for `field` inside a params type. */
function unionMembers(src: string, field: string): string[] | null {
  const m = src.match(new RegExp(`${field}\\s*\\??\\s*:\\s*((?:["'][^"']+["']\\s*\\|\\s*)*["'][^"']+["'])`))
  if (!m) return null
  return Array.from(m[1].matchAll(/["']([^"']+)["']/g)).map((x) => x[1])
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")

/**
 * The object-literal payload of a `.insert(` / `.upsert(` call whose text names
 * `table`, inside a given body. Returns the balanced `{ … }` argument.
 */
function writePayload(body: string, table: string, verbs = ["insert", "upsert"]): string | null {
  const tableIdx = body.indexOf(`"${table}"`)
  if (tableIdx < 0) return null
  for (const verb of verbs) {
    const vIdx = body.indexOf(`.${verb}(`, tableIdx)
    if (vIdx < 0) continue
    const open = body.indexOf("{", vIdx)
    if (open < 0) continue
    let depth = 0
    for (let i = open; i < body.length; i++) {
      if (body[i] === "{") depth++
      else if (body[i] === "}") {
        depth--
        if (depth === 0) return body.slice(open, i + 1)
      }
    }
  }
  return null
}

/** The full chained statement that begins at the `.from("<table>")` for `verb`. */
function writeStatement(body: string, table: string, verb: string): string | null {
  const tableIdx = body.indexOf(`"${table}"`)
  if (tableIdx < 0) return null
  const vIdx = body.indexOf(`.${verb}(`, tableIdx)
  if (vIdx < 0) return null
  // Walk forward from the verb, balancing parens, then take the rest of the chain
  // up to the end of the statement (a newline whose next non-space char is not `.`).
  let depth = 0
  let i = body.indexOf("(", vIdx)
  for (; i < body.length; i++) {
    if (body[i] === "(") depth++
    else if (body[i] === ")") {
      depth--
      if (depth === 0) break
    }
  }
  let end = i + 1
  while (end < body.length) {
    const rest = body.slice(end)
    const m = rest.match(/^\s*\.[A-Za-z]+\(/)
    if (!m) break
    let d = 0
    let k = end + rest.indexOf("(")
    for (; k < body.length; k++) {
      if (body[k] === "(") d++
      else if (body[k] === ")") {
        d--
        if (d === 0) break
      }
    }
    end = k + 1
  }
  return body.slice(vIdx, end)
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSERTIONS
// ─────────────────────────────────────────────────────────────────────────────

interface Mutation {
  file: string
  find: string | RegExp
  replace: string
}
interface Assertion {
  id: string
  what: string
  run: () => { ok: boolean; detail?: string }
  /** How to break it. Every assertion must have one, or it is not testing anything. */
  breaks: Mutation[]
}

/** Capabilities wired to a surface by this pass, and where they now live. */
const WIRED: Array<{ fn: string; from: string; surface: string }> = [
  { fn: "generateSmartTasks", from: F.coordinator, surface: F.coordPanel },
  { fn: "predictAndManageDeadlines", from: F.coordinator, surface: F.coordPanel },
  { fn: "draftTransactionCommunication", from: F.coordinator, surface: F.coordPanel },
  { fn: "generatePostClosingPlan", from: F.coordinator, surface: F.coordPanel },
  { fn: "aiGenerateDocumentReminders", from: F.docIntel, surface: F.coordPanel },
  { fn: "getDocumentTemplates", from: F.dotloop, surface: F.docWorkspace },
  { fn: "generateDocumentFromTemplate", from: F.dotloop, surface: F.docWorkspace },
  { fn: "createDocumentFolder", from: F.dotloop, surface: F.docWorkspace },
  { fn: "getDocumentFolders", from: F.dotloop, surface: F.docWorkspace },
  { fn: "aiGenerateDocument", from: F.docIntel, surface: F.docWorkspace },
  { fn: "getDocumentAccessLog", from: F.dotloop, surface: F.docActions },
  { fn: "sendForDotloopSignature", from: F.dotloop, surface: F.docActions },
  { fn: "getDotloopSigningStatus", from: F.dotloop, surface: F.docActions },
  { fn: "getDotloopDocumentStatus", from: F.dotloop, surface: F.docActions },
  { fn: "aiClassifyDocument", from: F.docIntel, surface: F.docActions },
  { fn: "aiVerifySignatures", from: F.docIntel, surface: F.docActions },
  { fn: "aiCompareDocuments", from: F.docIntel, surface: F.docCenter },
]

/** Deliberately NOT wired — each with the named duplicate that justifies it. */
const UNWIRED: Array<{ fn: string; from: string; duplicate: string }> = [
  { fn: "prepareForClosing", from: F.coordinator, duplicate: "ai-closing-workflow.ts:aiGenerateClosingChecklist" },
  { fn: "getClosingPrep", from: F.coordinator, duplicate: "ai-closing-workflow.ts:aiGenerateClosingChecklist" },
  { fn: "aiCheckDisclosures", from: F.docIntel, duplicate: "ai-transaction-documents.ts:checkTransactionDisclosures" },
  { fn: "logDocumentAccess", from: F.dotloop, duplicate: "lib/kernel/document-custody.ts:issueGovernedDocumentUrl" },
]

/** table -> the wired function that writes it, and the write verb. */
const TENANT_WRITES: Array<{ file: string; fn: string; table: string }> = [
  { file: F.coordinator, fn: "predictAndManageDeadlines", table: "transaction_deadlines" },
  { file: F.coordinator, fn: "generateSmartTasks", table: "transaction_tasks" },
  { file: F.coordinator, fn: "draftTransactionCommunication", table: "transaction_communications" },
  { file: F.coordinator, fn: "generatePostClosingPlan", table: "scheduled_touchpoints" },
  { file: F.coordinator, fn: "prepareForClosing", table: "transaction_closing_prep" },
  { file: F.docIntel, fn: "aiCheckDisclosures", table: "compliance_checklists" },
  { file: F.dotloop, fn: "createDocumentFolder", table: "document_folders" },
  { file: F.dotloop, fn: "generateDocumentFromTemplate", table: "client_documents" },
]

const ASSERTIONS: Assertion[] = []

// ── A1 · every wired capability is imported AND invoked by a real surface ────
ASSERTIONS.push({
  id: "A1",
  what: "every capability wired by this pass is imported by a surface AND actually called there",
  run: () => {
    const missing: string[] = []
    for (const w of WIRED) {
      const src = code(w.surface)
      const module = w.from.replace(/^app\//, "@/app/").replace(/\.ts$/, "")
      // The import must name this function AND come from this action module.
      const imports = Array.from(src.matchAll(/import\s+(?:type\s+)?\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g))
      const imported = imports.some(
        (m) => m[2] === module && new RegExp(`\\b${w.fn}\\b`).test(m[1]) && !/^import\s+type/.test(m[0]),
      )
      const invoked = new RegExp(`\\b${w.fn}\\s*\\(`).test(src)
      if (!imported || !invoked) missing.push(`${w.fn} (${imported ? "imported" : "NOT imported"}, ${invoked ? "called" : "NOT called"})`)
    }
    return { ok: missing.length === 0, detail: missing.join("; ") }
  },
  breaks: [
    // Remove the call site but leave the import — proves the assertion tests
    // REACHABILITY, not the presence of an import line.
    { file: F.coordPanel, find: "await generateSmartTasks({", replace: "await (async () => ({ success: false }))({" },
  ],
})

// ── A2 · the surfaces are mounted (rendered), not merely defined ─────────────
ASSERTIONS.push({
  id: "A2",
  what: "each new panel is rendered as JSX by the page/client that owns it",
  run: () => {
    const mounts: Array<[string, string]> = [
      [F.txnPage, "AiCoordinatorPanel"],
      [F.docCenter, "DocumentWorkspacePanel"],
      [F.docCenter, "DocumentActionsDialog"],
      [F.docCenter, "CompareDocumentsCard"],
    ]
    const bad = mounts.filter(([file, comp]) => !new RegExp(`<${comp}[\\s/>]`).test(code(file)))
    return { ok: bad.length === 0, detail: bad.map(([f, c]) => `${c} not rendered in ${f}`).join("; ") }
  },
  breaks: [{ file: F.docCenter, find: "<DocumentWorkspacePanel />", replace: "{null}" }],
})

// ── B1 · the model's task-priority enum is DERIVED from one vocabulary ──────
ASSERTIONS.push({
  id: "B1",
  what: "generateSmartTasks constrains task priority through the shared vocabulary constant, never an inline literal list",
  run: () => {
    const src = code(F.coordinator)
    const vocab = constStringArray(src, "TRANSACTION_TASK_PRIORITIES")
    if (!vocab) return { ok: false, detail: "TRANSACTION_TASK_PRIORITIES not found" }
    const body = fnBody(src, "generateSmartTasks")
    if (!body) return { ok: false, detail: "generateSmartTasks body not found" }
    // The schema field must reference an identifier, not a literal array.
    const m = body.match(/priority\s*:\s*z\.enum\(\s*([^)]*?)\s*\)/)
    if (!m) return { ok: false, detail: "priority schema field not found" }
    const argument = m[1].trim()
    const isIdentifier = /^[A-Za-z_$][\w$]*$/.test(argument)
    if (!isIdentifier) return { ok: false, detail: `priority enum is an inline literal: ${argument}` }
    if (argument !== "TRANSACTION_TASK_PRIORITIES") {
      return { ok: false, detail: `priority enum references ${argument}, not the vocabulary constant` }
    }
    // And the insert must send exactly that field through.
    const payload = writePayload(body, "transaction_tasks")
    if (!payload || !/priority\s*:/.test(payload)) {
      return { ok: false, detail: "transaction_tasks payload does not carry priority" }
    }
    return { ok: true, detail: `vocabulary = [${vocab.join(", ")}]` }
  },
  breaks: [
    {
      file: F.coordinator,
      find: "priority: z.enum(TRANSACTION_TASK_PRIORITIES)",
      replace: 'priority: z.enum(["low", "medium", "high", "urgent"])',
    },
  ],
})

// ── B2 · the folder-type submit gate offers exactly what the action accepts ──
ASSERTIONS.push({
  id: "B2",
  what: "the folder-type picker offers exactly the vocabulary createDocumentFolder validates against — no more, no fewer",
  run: () => {
    const action = constStringArray(code(F.dotloop), "DOCUMENT_FOLDER_TYPES")
    const surface = constStringArray(code(F.docWorkspace), "DOCUMENT_FOLDER_TYPES")
    if (!action) return { ok: false, detail: "action vocabulary not found" }
    if (!surface) return { ok: false, detail: "surface vocabulary not found" }
    // The action must actually USE it as the gate, not merely declare it.
    const body = fnBody(code(F.dotloop), "createDocumentFolder")
    const gated = /DOCUMENT_FOLDER_TYPES\s*\.\s*includes\s*\(/.test(body)
    if (!gated) return { ok: false, detail: "createDocumentFolder does not gate on the vocabulary" }
    return {
      ok: sameSet(action, surface),
      detail: sameSet(action, surface)
        ? `[${action.join(", ")}]`
        : `action=[${action.join(", ")}] surface=[${surface.join(", ")}]`,
    }
  },
  breaks: [
    {
      file: F.docWorkspace,
      find: '"transaction", "client", "template", "marketing", "compliance",',
      replace: '"transaction", "client", "template", "marketing", "compliance", "archive",',
    },
  ],
})

// ── B3 · the draft form offers exactly the roles/types the action accepts ────
ASSERTIONS.push({
  id: "B3",
  what: "the communication draft form's recipient roles and message types equal the unions draftTransactionCommunication declares",
  run: () => {
    const action = code(F.coordinator)
    const panel = code(F.coordPanel)
    const params = fnBody(action, "draftTransactionCommunication")
    // The unions live on the params type, which sits before the body — search the
    // declaration slice instead.
    const declIdx = action.search(/function\s+draftTransactionCommunication\s*\(/)
    const decl = action.slice(declIdx, declIdx + (action.indexOf("{", action.indexOf("try", declIdx)) - declIdx))
    const roles = unionMembers(decl, "recipientRole")
    const types = unionMembers(decl, "communicationType")
    const panelRoles = constStringArray(panel, "RECIPIENT_ROLES")
    const panelTypes = constStringArray(panel, "COMMUNICATION_TYPES")
    if (!roles || !types) return { ok: false, detail: "action unions not found" }
    if (!panelRoles || !panelTypes) return { ok: false, detail: "panel option arrays not found" }
    void params
    const rOk = sameSet(roles, panelRoles)
    const tOk = sameSet(types, panelTypes)
    return {
      ok: rOk && tOk,
      detail: rOk && tOk
        ? `${roles.length} roles / ${types.length} types agree`
        : `roles action=[${roles}] panel=[${panelRoles}] | types action=[${types}] panel=[${panelTypes}]`,
    }
  },
  breaks: [
    { file: F.coordPanel, find: '"lender", "title", "attorney", "other_agent"', replace: '"title", "attorney", "other_agent"' },
  ],
})

// ── C1 · no unchecked mutation in the three action files ────────────────────
ASSERTIONS.push({
  id: "C1",
  what: "no supabase mutation in the three action files is awaited without its error being bound (or ledgered by sentinelWrite)",
  run: () => {
    const offenders: string[] = []
    for (const file of [F.dotloop, F.coordinator, F.docIntel]) {
      const src = code(file)
      const lines = src.split("\n")
      lines.forEach((line, idx) => {
        // A statement that STARTS with `await <client>` has no destructure, so
        // nothing can be holding its error.
        if (!/^\s*await\s+(supabase|svc)\b/.test(line)) return
        // Look ahead for the mutation verb within this chained statement.
        const window = lines.slice(idx, idx + 20).join("\n")
        if (!/\.(insert|update|upsert|delete|rpc)\s*\(/.test(window)) return
        offenders.push(`${file}:${idx + 1} ${line.trim().slice(0, 70)}`)
      })
    }
    return { ok: offenders.length === 0, detail: offenders.join(" | ") }
  },
  breaks: [
    {
      file: F.coordinator,
      find: "const { error: insertError } = await supabase.from(\"transaction_deadlines\").insert({",
      replace: "await supabase.from(\"transaction_deadlines\").insert({",
    },
  ],
})

// ── C2 · every read inside a wired capability binds its error ───────────────
ASSERTIONS.push({
  id: "C2",
  what: "inside every wired capability, a destructure that binds `data` also binds `error` — a refused read can never read as empty",
  run: () => {
    const offenders: string[] = []
    for (const w of [...WIRED, ...UNWIRED]) {
      if (!/\.ts$/.test(w.from)) continue
      const body = fnBody(code(w.from), w.fn)
      if (!body) continue
      for (const m of body.matchAll(/const\s*\{([^}]*)\}\s*=\s*await\s+(supabase|svc|query)\b/g)) {
        const pattern = m[1]
        if (/\bdata\b/.test(pattern) && !/\berror\b/.test(pattern)) {
          offenders.push(`${w.fn}: { ${pattern.trim()} }`)
        }
      }
    }
    return { ok: offenders.length === 0, detail: offenders.join(" | ") }
  },
  breaks: [
    {
      file: F.dotloop,
      find: "const { data: template, error: templateError } = await supabase",
      replace: "const { data: template } = await supabase",
    },
  ],
})

// ── C3 · every tenant-scoped write stamps brokerage_id ──────────────────────
ASSERTIONS.push({
  id: "C3",
  what: "every wired write stamps brokerage_id in its payload (RLS WITH CHECK is false for NULL on all of these tables)",
  run: () => {
    const offenders: string[] = []
    for (const w of TENANT_WRITES) {
      const body = fnBody(code(w.file), w.fn)
      if (!body) {
        offenders.push(`${w.fn} body missing`)
        continue
      }
      const payload = writePayload(body, w.table)
      if (!payload) {
        offenders.push(`${w.fn} -> ${w.table} payload not found`)
        continue
      }
      if (!/\bbrokerage_id\s*:/.test(payload)) offenders.push(`${w.fn} -> ${w.table} unstamped`)
    }
    return { ok: offenders.length === 0, detail: offenders.join(" | ") }
  },
  breaks: [
    { file: F.coordinator, find: "        brokerage_id: scope.brokerageId,\n        title: task.title,", replace: "        title: task.title," },
  ],
})

// ── C4 · every wired capability passes through the session gate ─────────────
ASSERTIONS.push({
  id: "C4",
  what: "every wired capability resolves identity from the session and refuses when unauthenticated",
  run: () => {
    const gateHelpers = ["scopeTransaction", "scopeDocument"]
    const offenders: string[] = []
    for (const w of [...WIRED, ...UNWIRED]) {
      if (!/\.ts$/.test(w.from)) continue
      const src = code(w.from)
      const body = fnBody(src, w.fn)
      if (!body) continue
      const direct = /getAgentContext\s*\(/.test(body) && /isAuthenticated/.test(body)
      const viaHelper = gateHelpers.some((h) => {
        // Count the gate CALLS, then count the refusals that follow them. Calling
        // the helper and ignoring its verdict is not a gate — and a capability
        // that gates two documents (aiCompareDocuments) must refuse on BOTH.
        const calls = Array.from(body.matchAll(new RegExp(`\\b${h}\\s*\\(`, "g"))).length
        if (calls === 0) return false
        const refusals = Array.from(body.matchAll(/if\s*\(\s*!\s*[A-Za-z_$][\w$]*\.ok\s*\)\s*return\b/g)).length
        return refusals >= calls
      })
      // A pure delegating alias inherits its gate from the function it calls.
      const delegates = new RegExp(`return\\s+(${[...WIRED, ...UNWIRED].map((x) => x.fn).join("|")})\\s*\\(`).test(body)
      if (!direct && !viaHelper && !delegates) offenders.push(w.fn)
    }
    // and the helpers themselves must be real gates
    for (const h of gateHelpers) {
      const file = h === "scopeTransaction" ? F.coordinator : F.docIntel
      const body = fnBody(code(file), h)
      if (!/getAgentContext\s*\(/.test(body) || !/isAuthenticated/.test(body) || !/Unauthorized/.test(body)) {
        offenders.push(`${h} is not a real gate`)
      }
    }
    return { ok: offenders.length === 0, detail: offenders.join(", ") }
  },
  breaks: [
    { file: F.coordinator, find: "    const scope = await scopeTransaction(params.transactionId)\n    if (!scope.ok) return { success: false, error: scope.error }\n\n    const supabase = await createClient()\n\n    const { data: transaction, error: txnError } = await supabase\n      .from(\"transactions\")\n      .select(\`\n        *,\n        transaction_deadlines(*),\n        transaction_milestones(*)\n      \`)", replace: "    const scope = { ok: true, brokerageId: \"\", userId: \"\", agentId: \"\" } as any\n\n    const supabase = await createClient()\n\n    const { data: transaction, error: txnError } = await supabase\n      .from(\"transactions\")\n      .select(\`\n        *,\n        transaction_deadlines(*),\n        transaction_milestones(*)\n      \`)" },
  ],
})

// ── C5 · identity classes are resolved, never substituted ──────────────────
ASSERTIONS.push({
  id: "C5",
  what: "the users-class read and the agents-class write in a capability never share one identifier, and no `?? user.id` papering exists",
  run: () => {
    const problems: string[] = []

    // (a) no `x ?? <something>.userId / user.id` class-papering in the action files
    for (const file of [F.dotloop, F.coordinator, F.docIntel]) {
      const src = code(file)
      const m = src.match(/agent_?[Ii]d\s*\)?\s*\?\?\s*[\w.]*\b(user\.id|userId)\b/)
      if (m) problems.push(`${file}: class papering \`${m[0]}\``)
    }

    // (b) draftTransactionCommunication: the `users` lookup key must NOT be the
    //     same expression written into transaction_communications.agent_id.
    const coordBody = fnBody(code(F.coordinator), "draftTransactionCommunication")
    const usersKey = coordBody.match(/\.from\("users"\)[\s\S]{0,220}?\.eq\("id",\s*([^)]+)\)/)?.[1]?.trim()
    const payload = writePayload(coordBody, "transaction_communications")
    const agentValue = payload?.match(/agent_id\s*:\s*([^,\n]+)/)?.[1]?.trim()
    if (!usersKey || !agentValue) {
      problems.push("draftTransactionCommunication: could not read both identity uses")
    } else if (usersKey.replace(/!$/, "") === agentValue.replace(/!$/, "")) {
      problems.push(`draftTransactionCommunication: one value used as BOTH classes (${usersKey})`)
    }

    // (c) aiGenerateDocument: users.id and brand_voice_profile.agent_id must differ.
    const genBody = fnBody(code(F.docIntel), "aiGenerateDocument")
    const uKey = genBody.match(/\.from\("users"\)[\s\S]{0,220}?\.eq\("id",\s*([^)]+)\)/)?.[1]?.trim()
    const bKey = genBody.match(/\.from\("brand_voice_profile"\)[\s\S]{0,260}?\.eq\("agent_id",\s*([^)]+)\)/)?.[1]?.trim()
    if (!uKey || !bKey) problems.push("aiGenerateDocument: could not read both identity uses")
    else if (uKey === bKey) problems.push(`aiGenerateDocument: one value used as BOTH classes (${uKey})`)

    return { ok: problems.length === 0, detail: problems.join(" | ") }
  },
  breaks: [
    { file: F.coordinator, find: "agent_id: scope.agentId,", replace: "agent_id: scope.userId," },
  ],
})

// ── C6 · an AI reading never overwrites the provider-owned signature status ──
ASSERTIONS.push({
  id: "C6",
  what: "aiVerifySignatures may only SEED a null signature_status — the write is qualified so a provider verdict cannot be overwritten",
  run: () => {
    const body = fnBody(code(F.docIntel), "aiVerifySignatures")
    if (!body) return { ok: false, detail: "body not found" }
    const stmt = writeStatement(body, "client_documents", "update")
    // Find the specific update whose payload carries signature_status.
    const updates = Array.from(body.matchAll(/\.update\(\s*\{([\s\S]*?)\}\s*\)([\s\S]{0,260})/g))
    const sigUpdate = updates.find((m) => /signature_status\s*:/.test(m[1]))
    if (!sigUpdate) return { ok: false, detail: "no update writes signature_status (capability lost?)" }
    const chain = sigUpdate[2]
    const guarded = /\.is\(\s*["']signature_status["']\s*,\s*null\s*\)/.test(chain)
    // and it must never be able to write "signed"
    const claimsSigned = /signature_status\s*:\s*[^,\n]*["']signed["']/.test(sigUpdate[1])
    void stmt
    return {
      ok: guarded && !claimsSigned,
      detail: !guarded
        ? "the signature_status update is not qualified by .is('signature_status', null)"
        : claimsSigned
          ? "an AI reading can write 'signed'"
          : "seed-only, guarded at the database",
    }
  },
  breaks: [
    { file: F.docIntel, find: '.is("signature_status", null)\n        .select("id")', replace: '.select("id")' },
  ],
})

// ── C7 · the one-row-per-deal upsert names its real arbiter ─────────────────
ASSERTIONS.push({
  id: "C7",
  what: "prepareForClosing's upsert names transaction_id as the conflict target (the table's real unique key), not the default primary key",
  run: () => {
    const body = fnBody(code(F.coordinator), "prepareForClosing")
    if (!body) return { ok: false, detail: "body not found" }
    const idx = body.indexOf(".upsert(")
    if (idx < 0) return { ok: false, detail: "no upsert found" }
    // Balance the upsert() argument list and inspect the OPTIONS argument.
    let depth = 0
    let end = idx
    for (let i = body.indexOf("(", idx); i < body.length; i++) {
      if (body[i] === "(") depth++
      else if (body[i] === ")") {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const args = body.slice(idx, end)
    const opt = args.match(/onConflict\s*:\s*["']([^"']+)["']/)
    if (!opt) return { ok: false, detail: "upsert has no onConflict — it degrades to a plain insert on the primary key" }
    const cols = opt[1].split(",").map((s) => s.trim())
    return {
      ok: cols.length === 1 && cols[0] === "transaction_id",
      detail: `onConflict = ${opt[1]}`,
    }
  },
  breaks: [
    { file: F.coordinator, find: '{ onConflict: "transaction_id" },\n      )\n\n    if (prepError)', replace: '      )\n\n    if (prepError)' },
  ],
})

// ── D1 · the deliberate non-wirings hold, and nothing was deleted ───────────
ASSERTIONS.push({
  id: "D1",
  what: "each deliberately-unwired capability still EXISTS as an export and is still reached by no surface",
  run: () => {
    const problems: string[] = []
    for (const u of UNWIRED) {
      const src = code(u.from)
      if (!new RegExp(`export\\s+async\\s+function\\s+${u.fn}\\b`).test(src)) {
        problems.push(`${u.fn} was DELETED — an unwired capability is work to finish, never to remove`)
        continue
      }
      for (const s of SURFACES) {
        if (new RegExp(`\\b${u.fn}\\s*\\(`).test(code(s))) problems.push(`${u.fn} is now called from ${s}`)
      }
    }
    return { ok: problems.length === 0, detail: problems.join(" | ") }
  },
  breaks: [
    // Wiring one of them is exactly the mistake this guards against.
    { file: F.coordPanel, find: "const runPostClosing = () => {", replace: "const runNope = () => { void prepareForClosing({ transactionId: \"x\", closingDate: \"y\" }) }\n  const runPostClosing = () => {" },
  ],
})

// ── D2 · every named duplicate really exists and is really wired ────────────
ASSERTIONS.push({
  id: "D2",
  what: "each named duplicate exists at the file:function named, and is itself reachable from a live surface",
  run: () => {
    const problems: string[] = []

    // checkTransactionDisclosures — the duplicate that keeps aiCheckDisclosures unwired
    const sibling = code(F.siblingDocs)
    if (!/export\s+async\s+function\s+checkTransactionDisclosures\b/.test(sibling)) {
      problems.push("ai-transaction-documents.ts:checkTransactionDisclosures missing")
    }
    if (!/checkTransactionDisclosures\s*\(/.test(code(F.txnDetail))) {
      problems.push("checkTransactionDisclosures is not called from the transaction detail surface")
    }
    if (!/compliance_checklists/.test(sibling)) problems.push("the duplicate does not write compliance_checklists")

    // aiGenerateClosingChecklist — the duplicate that keeps prepareForClosing unwired
    const closing = code(F.closingWorkflow)
    if (!/export\s+async\s+function\s+aiGenerateClosingChecklist\b/.test(closing)) {
      problems.push("ai-closing-workflow.ts:aiGenerateClosingChecklist missing")
    }
    if (!/transaction_closing_prep/.test(closing)) problems.push("the duplicate does not write transaction_closing_prep")
    if (!/onConflict:\s*["']transaction_id["']/.test(closing)) {
      problems.push("the duplicate's upsert does not target transaction_id — it may not be the single writer after all")
    }

    // issueGovernedDocumentUrl — the duplicate that keeps logDocumentAccess unwired
    const custody = code(F.custody)
    if (!/export\s+async\s+function\s+issueGovernedDocumentUrl\b/.test(custody)) {
      problems.push("document-custody.ts:issueGovernedDocumentUrl missing")
    }
    if (!/document_access_log/.test(custody)) problems.push("the duplicate does not write document_access_log")

    return { ok: problems.length === 0, detail: problems.join(" | ") }
  },
  breaks: [
    // Break it from a file inside this pass's own set: drop the surface import
    // that makes the disclosure duplicate reachable.
    { file: F.txnDetail, find: "      const result = await checkTransactionDisclosures({", replace: "      const result = await (async (_: any) => ({ success: false }))({" },
  ],
})

// ── E1 · no optimistic success: the positive branch is unreachable on refusal ─
ASSERTIONS.push({
  id: "E1",
  what: "every panel handler that can show a positive verdict returns early on the server's refusal first",
  run: () => {
    const handlers: Array<[string, string]> = [
      [F.coordPanel, "runSmartTasks"],
      [F.coordPanel, "runDeadlines"],
      [F.coordPanel, "runDraft"],
      [F.coordPanel, "runPostClosing"],
      [F.coordPanel, "runReminders"],
      [F.docWorkspace, "submitFolder"],
      [F.docWorkspace, "submitTemplate"],
      [F.docWorkspace, "submitAiDraft"],
      [F.docActions, "runClassify"],
      [F.docActions, "runVerify"],
      [F.docActions, "runLog"],
      [F.docActions, "runSend"],
    ]
    const problems: string[] = []
    for (const [file, name] of handlers) {
      const body = arrowBody(code(file), name)
      if (!body) {
        problems.push(`${name}: handler not found`)
        continue
      }
      // A "positive-capable verdict" is any verdict literal whose `ok:` is not
      // the literal `false`. Looking for the string "ok: true" was the earlier,
      // WEAKER form of this check and it silently skipped every handler whose
      // verdict is gated on a count (`ok: created > 0`) — which is most of them.
      // Its own negative test caught that.
      const verdicts = Array.from(body.matchAll(/ok:\s*([^,\n]+)/g))
      const positive = verdicts.find((m) => m[1].trim() !== "false")
      if (!positive) continue
      const okIdx = positive.index ?? 0
      const before = body.slice(0, okIdx)
      // A refusal guard = a negated success test whose block returns.
      const guard = /if\s*\(\s*!\s*res\??\.?\??\s*\.?\s*(success|ok)\b[\s\S]{0,400}?return\b/.test(before)
      if (!guard) problems.push(`${name}: reports success without first returning on the server's refusal`)
    }
    return { ok: problems.length === 0, detail: problems.join(" | ") }
  },
  breaks: [
    {
      file: F.coordPanel,
      find: "      if (!res?.success) {\n        setTasksVerdict({ ok: false, headline: res?.error ?? \"Task generation failed.\" })\n        return\n      }\n",
      replace: "",
    },
  ],
})

// ── E2 · the verdict reports what the DATABASE accepted, not what AI proposed ─
ASSERTIONS.push({
  id: "E2",
  what: "the write-capability verdicts are gated on the server's APPLIED count, not on the model's proposed count",
  run: () => {
    const cases: Array<[string, string, string]> = [
      [F.coordPanel, "runSmartTasks", "createdCount"],
      [F.coordPanel, "runPostClosing", "scheduledCount"],
    ]
    const problems: string[] = []
    for (const [file, handler, applied] of cases) {
      const body = arrowBody(code(file), handler)
      if (!body) {
        problems.push(`${handler} not found`)
        continue
      }
      if (!new RegExp(`\\b${applied}\\b`).test(body)) {
        problems.push(`${handler} never reads the applied count (${applied})`)
        continue
      }
      // The `ok:` of the positive verdict must be an EXPRESSION over the applied
      // value, not the literal `true` — otherwise a run that wrote nothing still
      // renders as a success.
      const verdict = body.match(/setD?\w*Verdict\(\{\s*\n?\s*ok:\s*([^,\n]+)/g) ?? []
      const positive = verdict.filter((v) => !/ok:\s*false/.test(v))
      const gated = positive.some((v) => />\s*0/.test(v) || /Count/.test(v))
      if (!gated) problems.push(`${handler}: the positive verdict is not gated on the applied count`)
    }
    return { ok: problems.length === 0, detail: problems.join(" | ") }
  },
  breaks: [
    {
      file: F.coordPanel,
      find: "        ok: created > 0,\n        headline:\n          created > 0",
      replace: "        ok: true,\n        headline:\n          created > 0",
    },
  ],
})

// ── E3 · advisory capabilities do not claim to have saved anything ─────────
ASSERTIONS.push({
  id: "E3",
  what: "the capabilities that write nothing (document reminders, AI draft, comparison) say so on screen instead of implying a save",
  run: () => {
    const problems: string[] = []
    // The action bodies must genuinely contain no mutation…
    for (const [file, fn] of [
      [F.docIntel, "aiGenerateDocumentReminders"],
      [F.docIntel, "aiGenerateDocument"],
      [F.docIntel, "aiCompareDocuments"],
    ] as const) {
      const body = fnBody(code(file), fn)
      if (/\.(insert|update|upsert|delete)\s*\(/.test(body)) {
        problems.push(`${fn} does write — this assertion's premise is wrong`)
      }
    }
    // …and each surface must say nothing was stored.
    const claims: Array<[string, RegExp]> = [
      [F.coordPanel, /nothing was saved|advisory only/i],
      [F.docWorkspace, /nothing was saved|not stored/i],
      [F.docCenter, /not stored|advisory only/i],
    ]
    for (const [file, re] of claims) {
      if (!re.test(code(file))) problems.push(`${file} does not disclose that nothing is stored`)
    }
    return { ok: problems.length === 0, detail: problems.join(" | ") }
  },
  breaks: [
    { file: F.docCenter, find: "Advisory only — this comparison is not stored on either document.", replace: "Comparison complete." },
  ],
})

// ── F1 · service-role reads carry an explicit tenant filter ────────────────
ASSERTIONS.push({
  id: "F1",
  what: "every service-role SELECT in the three action files is tenant-anchored — it filters brokerage_id, selects it for the caller to compare, or reads a table that has none from inside a function that has already verified the owning document's tenant",
  run: () => {
    // The one table in this rail with NO brokerage_id column (verified live:
    // information_schema lists document_id / accessed_by_* / access_type /
    // ip_address / user_agent / accessed_at / created_at and nothing else). A
    // service-role read of it therefore CANNOT filter by brokerage and must
    // instead sit behind an explicit document-tenancy check.
    const TENANTLESS = new Set(["document_access_log"])
    const problems: string[] = []
    for (const file of [F.dotloop, F.coordinator, F.docIntel]) {
      const src = code(file)
      for (const m of src.matchAll(/\bsvc\s*\n?\s*\.from\(["'](\w+)["']\)([\s\S]{0,420}?)(?=\n\s*(?:const|let|return|if|await|\}|for)\b)/g)) {
        const table = m[1]
        const chain = m[2]
        // Writes stamp their tenant in the payload; C3 covers those.
        if (!/\.select\(/.test(chain)) continue
        const filtered = /\.eq\(\s*["']brokerage_id["']/.test(chain)
        const selectsStamp = /select\([^)]*brokerage_id/.test(chain)
        if (filtered || selectsStamp) continue
        if (TENANTLESS.has(table)) {
          const fn = enclosingFunction(src, m.index ?? 0)
          const body = fn ? fnBody(src, fn) : ""
          const anchored =
            /client_documents/.test(body) && /brokerage_id\s*!==\s*ctx\.brokerageId/.test(body)
          if (anchored) continue
          problems.push(`${file}: svc.from("${table}") in ${fn ?? "?"} is not anchored to a tenant-checked document`)
          continue
        }
        problems.push(`${file}: svc.from("${table}") has no tenant filter`)
      }
    }
    return { ok: problems.length === 0, detail: problems.join(" | ") }
  },
  breaks: [
    {
      file: F.dotloop,
      find: '.select("id, brokerage_id")\n    .eq("id", documentId)\n    .maybeSingle()\n  if (docError) return { success: false, entries: [], error: `Could not verify the document: ${docError.message}` }',
      replace: '.select("id")\n    .eq("id", documentId)\n    .maybeSingle()\n  if (docError) return { success: false, entries: [], error: `Could not verify the document: ${docError.message}` }',
    },
  ],
})

// ── F2 · the signed-count reads BOTH columns that carry "signed" ───────────
ASSERTIONS.push({
  id: "F2",
  what: "getDotloopSigningStatus counts a document as signed from either of the two columns that carry that fact",
  run: () => {
    const body = fnBody(code(F.dotloop), "getDotloopSigningStatus")
    if (!body) return { ok: false, detail: "body not found" }
    const selected = body.match(/\.select\(\s*["']([^"']+)["']/)?.[1] ?? ""
    const readsBoth = /\bstatus\b/.test(selected) && /signature_status/.test(selected)
    const countsBoth =
      /status\s*===\s*["']signed["']/.test(body) && /signature_status\s*===\s*["']signed["']/.test(body)
    return {
      ok: readsBoth && countsBoth,
      detail: readsBoth && countsBoth ? "both columns read and counted" : `select="${selected}"`,
    }
  },
  breaks: [
    {
      file: F.dotloop,
      find: 'doc.status === "signed" || doc.signature_status === "signed"',
      replace: 'doc.status === "signed"',
    },
  ],
})

// ── F3 · the page's ownership gate compares one id class to itself ─────────
ASSERTIONS.push({
  id: "F3",
  what: "the transaction page's ownership gate compares transactions.agent_id (agents class) to a resolved agents id, never to auth's users id",
  run: () => {
    const src = code(F.txnPage)
    const m = src.match(/const\s+isOwningAgent\s*=\s*([^\n]+)/)
    if (!m) return { ok: false, detail: "isOwningAgent not found" }
    const expr = m[1]
    const comparesToUserId = /\b(user\.id|userId)\b/.test(expr)
    const comparesToAgentId = /\bagentId\b/.test(expr)
    return {
      ok: comparesToAgentId && !comparesToUserId,
      detail: expr.trim(),
    }
  },
  breaks: [
    {
      file: F.txnPage,
      find: "const isOwningAgent = !!identity.agentId && transaction.agent_id === identity.agentId",
      replace: "const isOwningAgent = transaction.agent_id === user.id",
    },
  ],
})

// ─────────────────────────────────────────────────────────────────────────────
// LIVE LAYER — creds-gated, SKIPS LOUDLY
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
  const notes: string[] = []

  if (!url || !key) {
    return { ran: false, passed: 0, failed: 0, notes: ["no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in env"] }
  }

  let createClient: any
  try {
    ;({ createClient } = await import("@supabase/supabase-js"))
  } catch (e: any) {
    return { ran: false, passed: 0, failed: 0, notes: [`@supabase/supabase-js unavailable: ${e?.message}`] }
  }

  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

  // Reachability probe FIRST, so a network error is reported as a SKIP and never
  // scored as a pass or a failure of the code under test.
  const probe = await db.from("transactions").select("id, brokerage_id").limit(1)
  if (probe.error) {
    return { ran: false, passed: 0, failed: 0, notes: [`database unreachable: ${probe.error.message}`] }
  }
  const anchor = probe.data?.[0]
  if (!anchor) {
    return { ran: false, passed: 0, failed: 0, notes: ["no transactions row to anchor probe rows to"] }
  }

  const MARK = `__wiring_probe_${Date.now()}__`
  let passed = 0
  let failed = 0
  const created: Array<{ table: string; column: string; value: string }> = []

  const ok = (label: string, cond: boolean, detail = "") => {
    if (cond) {
      passed++
      console.log(`   ✔ ${label}${detail ? ` — ${detail}` : ""}`)
    } else {
      failed++
      console.log(`   ✘ ${label}${detail ? ` — ${detail}` : ""}`)
    }
  }

  // ── L1 · the task-priority vocabulary the code declares IS the CHECK's ────
  const declaredPriorities = constStringArray(code(F.coordinator), "TRANSACTION_TASK_PRIORITIES") ?? []
  const acceptedPriorities: string[] = []
  for (const p of [...declaredPriorities, "urgent"]) {
    const r = await db.from("transaction_tasks").insert({
      transaction_id: anchor.id,
      brokerage_id: anchor.brokerage_id,
      title: `${MARK}${p}`,
      priority: p,
      status: "pending",
    })
    if (!r.error) {
      acceptedPriorities.push(p)
      created.push({ table: "transaction_tasks", column: "title", value: `${MARK}${p}` })
    }
  }
  ok(
    "L1 transaction_tasks accepts EVERY priority the code declares, and rejects 'urgent'",
    sameSet(acceptedPriorities, declaredPriorities) && !acceptedPriorities.includes("urgent"),
    `declared=[${declaredPriorities}] accepted=[${acceptedPriorities}]`,
  )

  // ── L2 · the folder-type vocabulary the picker offers IS the CHECK's ──────
  const declaredFolders = constStringArray(code(F.docWorkspace), "DOCUMENT_FOLDER_TYPES") ?? []
  const acceptedFolders: string[] = []
  for (const t of [...declaredFolders, "__not_a_folder_type__"]) {
    const name = `${MARK}${t}`
    const r = await db.from("document_folders").insert({
      brokerage_id: anchor.brokerage_id,
      folder_name: name,
      folder_type: t,
    })
    if (!r.error) {
      acceptedFolders.push(t)
      created.push({ table: "document_folders", column: "folder_name", value: name })
    }
  }
  ok(
    "L2 document_folders accepts EVERY folder type the picker offers, and nothing else",
    sameSet(acceptedFolders, declaredFolders),
    `offered=[${declaredFolders}] accepted=[${acceptedFolders}]`,
  )

  // ── L3 · PHANTOM COLUMN SWEEP over every column the wired writes name ─────
  // PostgREST answers an unknown column with PGRST204, which is exactly the
  // defect class ("writing a column that does not exist") this pass hunts.
  const columnSets: Array<{ table: string; fn: string; file: string }> = TENANT_WRITES
  const phantoms: string[] = []
  for (const w of columnSets) {
    const body = fnBody(code(w.file), w.fn)
    const payload = writePayload(body, w.table)
    if (!payload) continue
    const columns = Array.from(payload.matchAll(/^\s*([a-z_][a-z0-9_]*)\s*:/gm)).map((m) => m[1])
    for (const col of columns) {
      const r = await db.from(w.table).select(col).limit(1)
      if (r.error && /PGRST204|does not exist|column/i.test(r.error.message)) {
        phantoms.push(`${w.table}.${col} (${w.fn})`)
      }
    }
  }
  ok("L3 no wired write names a column that does not exist", phantoms.length === 0, phantoms.join(", ") || "all columns real")

  // ── L4 · the closing-prep upsert really is idempotent now ────────────────
  {
    const payload = {
      transaction_id: anchor.id,
      brokerage_id: anchor.brokerage_id,
      readiness_score: 42,
    }
    const first = await db.from("transaction_closing_prep").upsert(payload, { onConflict: "transaction_id" })
    const second = await db.from("transaction_closing_prep").upsert(
      { ...payload, readiness_score: 43 },
      { onConflict: "transaction_id" },
    )
    // And the OLD shape (no onConflict) must still be rejected on the second call,
    // which is the defect this pass fixed.
    const naive1 = await db.from("transaction_closing_prep").insert(payload)
    const naive2 = await db.from("transaction_closing_prep").insert(payload)
    ok(
      "L4 upsert(onConflict transaction_id) is idempotent while a bare repeat insert is refused",
      !first.error && !second.error && !!naive2.error,
      `upsert1=${first.error?.code ?? "ok"} upsert2=${second.error?.code ?? "ok"} naive1=${naive1.error?.code ?? "ok"} naive2=${naive2.error?.code ?? "ok"}`,
    )
    created.push({ table: "transaction_closing_prep", column: "transaction_id", value: anchor.id })
  }

  // ── CLEANUP + RESIDUE RE-COUNT ───────────────────────────────────────────
  for (const c of created) {
    if (c.column === "transaction_id") await db.from(c.table).delete().eq(c.column, c.value)
    else await db.from(c.table).delete().eq(c.column, c.value)
  }
  await db.from("transaction_tasks").delete().like("title", `${MARK}%`)
  await db.from("document_folders").delete().like("folder_name", `${MARK}%`)

  const residue: string[] = []
  const t1 = await db.from("transaction_tasks").select("id", { count: "exact", head: true }).like("title", `${MARK}%`)
  const t2 = await db.from("document_folders").select("id", { count: "exact", head: true }).like("folder_name", `${MARK}%`)
  const t3 = await db
    .from("transaction_closing_prep")
    .select("id", { count: "exact", head: true })
    .eq("transaction_id", anchor.id)
  if ((t1.count ?? -1) !== 0) residue.push(`transaction_tasks=${t1.count}`)
  if ((t2.count ?? -1) !== 0) residue.push(`document_folders=${t2.count}`)
  if ((t3.count ?? -1) !== 0) residue.push(`transaction_closing_prep=${t3.count}`)
  ok("L5 every probe row removed — residue re-counted to zero", residue.length === 0, residue.join(", ") || "0 rows")

  notes.push(`anchored on transaction ${anchor.id}`)
  return { ran: true, passed, failed, notes }
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
  console.log(" TRANSACTION & DOCUMENT WIRING SIMULATOR")
  console.log(" (all static assertions read COMMENT-STRIPPED source)")
  console.log("═══════════════════════════════════════════════════════════════════")

  // Sanity: the stripper must actually strip, or every assertion below is
  // reading prose and proving nothing.
  {
    const sample = raw(F.coordinator)
    const stripped = stripComments(sample)
    const strippedIsShorter = stripped.replace(/\s/g, "").length < sample.replace(/\s/g, "").length
    const proseGone = !/an unwired capability/i.test(stripped)
    const codeKept = /export async function generateSmartTasks/.test(stripped)
    if (!strippedIsShorter || !proseGone || !codeKept) {
      console.log("\n✘ FATAL — the comment stripper is not working; every assertion below would be meaningless.")
      process.exit(1)
    }
    console.log(`\n[stripper]  ok — ${sample.length - stripped.replace(/ /g, " ").length >= 0 ? "" : ""}comments removed, code preserved`)
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
    console.log("    The static layer proved the code's contract with the schema it CLAIMS;")
    console.log("    it did NOT prove the schema agrees. Re-run with service creds to close that.")
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

        const after = typeof b.find === "string" ? before.replace(b.find, b.replace) : before.replace(b.find, b.replace)

        // THEATRE DETECTOR — a `replace` that matched nothing leaves the file
        // untouched and the assertion would "fail to fail" for the wrong reason.
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

        const digestAfterRestore = createHash("sha256").update(readFileSync(path)).digest("hex")
        const restored = digestAfterRestore === digestBefore

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
  console.log(
    ` LIVE     ${live.ran ? `${live.passed} passed, ${live.failed} failed` : `SKIPPED (${live.notes.join("; ")})`}`,
  )
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

  const exitBad = fail > 0 || negFail > 0 || (live.ran && live.failed > 0)
  process.exit(exitBad ? 1 : 0)
}

void main()
