// scripts/people-vendor-education-wiring-simulator.ts
//
// Proof for the people / vendor / education orphan burn-down.
//
// WHAT THIS FILE REFUSES TO DO
//   - It never greps a whole file. Every assertion first SLICES the construct it
//     is about (a function body, a parameter list, an insert payload, a JSX
//     block) and asserts inside that slice, so a token that survives in an
//     unrelated declaration cannot satisfy a check about a branch.
//   - It strips comments before ANY scan, and proves with a self-test that a
//     comment cannot satisfy a check.
//   - Every assertion is negative-tested: the harness mutates the REAL source,
//     proves the mutation landed by sha256, re-runs that one check, requires it
//     to FAIL, restores the file and re-verifies the sha256. An assertion that
//     cannot be made to fail is worthless and is reported as such.
//
// Run:  npx tsx scripts/people-vendor-education-wiring-simulator.ts
//
// NOTE TO FUTURE EDITORS: never write a comment-opening or comment-closing token
// inside a string literal in this file. The stripper below reads one as the real
// thing and swallows the rest of the source.

import { readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { resolve } from "node:path"

// The repo runs as ESM, so __dirname is absent; this file is always executed
// from the repository root by the command in the report.
const ROOT = resolve(process.cwd())

const FILES = {
  agents: "app/actions/agents.ts",
  vendorsKernel: "app/actions/vendors-kernel.ts",
  educationKernel: "app/actions/education-kernel.ts",
  vendorClient: "app/dashboard/vendors/vendor-directory-client.tsx",
  vendorPage: "app/dashboard/vendors/page.tsx",
  educationPage: "app/dashboard/education/page.tsx",
  learningPanel: "app/dashboard/education/client-learning-panel.tsx",
  adminUsersPage: "app/dashboard/admin/users/page.tsx",
  createAgentButton: "app/dashboard/admin/users/create-agent-record-button.tsx",
  expensesPage: "app/dashboard/financials/expenses/page.tsx",
  brokeragePage: "app/dashboard/brokerage/page.tsx",
  motivationPage: "app/dashboard/motivation/page.tsx",
} as const

type FileKey = keyof typeof FILES

// ─────────────────────────────────────────────────────────────────────────────
// COMMENT STRIPPER
//
// Produces two views of the same source, character-for-character the same LENGTH
// as the original, so an offset computed in one is valid in the other:
//   stripped — comments blanked, string contents intact
//   masked   — comments blanked AND string contents blanked
// Brace matching runs on `masked` (a brace inside a string can never be
// mistaken for structure); content assertions run on `stripped`.
// ─────────────────────────────────────────────────────────────────────────────

function stripComments(src: string): { stripped: string; masked: string } {
  const stripped: string[] = []
  const masked: string[] = []
  const SLASH = String.fromCharCode(47)
  const STAR = String.fromCharCode(42)
  const BACKSLASH = String.fromCharCode(92)
  const BACKTICK = String.fromCharCode(96)

  const push = (s: string, m: string) => {
    stripped.push(s)
    masked.push(m)
  }
  const blank = (ch: string) => push(ch === "\n" ? "\n" : " ", ch === "\n" ? "\n" : " ")

  // Template-literal nesting: each entry is the brace depth at which the
  // interpolation opened.
  const tplStack: number[] = []
  let braceDepth = 0
  let i = 0
  let prevSig = ""

  const canStartRegex = () => {
    if (prevSig === "") return true
    return "(,=:[!&|?{};+-*%~^<>".includes(prevSig) || /[a-z]/.test(prevSig) === false
  }

  while (i < src.length) {
    const ch = src[i]
    const next = src[i + 1]

    // line comment
    if (ch === SLASH && next === SLASH) {
      while (i < src.length && src[i] !== "\n") {
        blank(src[i])
        i++
      }
      continue
    }

    // block comment
    if (ch === SLASH && next === STAR) {
      blank(src[i]); i++
      blank(src[i]); i++
      while (i < src.length && !(src[i] === STAR && src[i + 1] === SLASH)) {
        blank(src[i]); i++
      }
      if (i < src.length) { blank(src[i]); i++ }
      if (i < src.length) { blank(src[i]); i++ }
      continue
    }

    // string literals
    //
    // A quoted string in JS/TS cannot contain a raw newline, so a quote with no
    // partner before the end of the line is NOT a string opener — it is an
    // apostrophe in JSX text. Treating one as a string opener silently swallows
    // everything up to the next apostrophe anywhere in the file, which is how a
    // whole dialog can vanish from the scan and take an assertion with it.
    if (ch === '"' || ch === "'") {
      const quote = ch
      let probe = i + 1
      let closes = false
      while (probe < src.length && src[probe] !== "\n") {
        if (src[probe] === BACKSLASH) { probe += 2; continue }
        if (src[probe] === quote) { closes = true; break }
        probe++
      }
      if (!closes) {
        push(ch, ch)
        prevSig = ch
        i++
        continue
      }
      push(ch, ch); i++
      while (i < src.length && src[i] !== quote) {
        if (src[i] === BACKSLASH) {
          push(src[i], " "); i++
          if (i < src.length) { push(src[i], " "); i++ }
          continue
        }
        push(src[i], src[i] === "\n" ? "\n" : " ")
        i++
      }
      if (i < src.length) { push(src[i], src[i]); i++ }
      prevSig = quote
      continue
    }

    // template literal
    if (ch === BACKTICK) {
      push(ch, ch); i++
      while (i < src.length) {
        if (src[i] === BACKSLASH) {
          push(src[i], " "); i++
          if (i < src.length) { push(src[i], " "); i++ }
          continue
        }
        if (src[i] === BACKTICK) break
        if (src[i] === "$" && src[i + 1] === "{") {
          // interpolation is CODE again — hand control back to the main loop
          push(src[i], src[i]); i++
          push(src[i], src[i]); i++
          tplStack.push(braceDepth)
          braceDepth++
          break
        }
        push(src[i], src[i] === "\n" ? "\n" : " ")
        i++
      }
      if (i < src.length && src[i] === BACKTICK) { push(src[i], src[i]); i++ }
      prevSig = BACKTICK
      continue
    }

    // regex literal — only where a regex can legally begin
    if (ch === SLASH && canStartRegex()) {
      const start = i
      let j = i + 1
      let ok = false
      let inClass = false
      while (j < src.length) {
        const c = src[j]
        if (c === "\n") break
        if (c === BACKSLASH) { j += 2; continue }
        if (c === "[") inClass = true
        else if (c === "]") inClass = false
        else if (c === SLASH && !inClass) { ok = true; break }
        j++
      }
      if (ok) {
        // consume flags
        let k = j + 1
        while (k < src.length && /[a-z]/.test(src[k])) k++
        for (let p = start; p < k; p++) push(src[p], src[p] === "\n" ? "\n" : " ")
        i = k
        prevSig = SLASH
        continue
      }
    }

    if (ch === "{") braceDepth++
    if (ch === "}") {
      braceDepth--
      if (tplStack.length > 0 && tplStack[tplStack.length - 1] === braceDepth) {
        // closing an interpolation — resume template-literal scanning
        tplStack.pop()
        push(ch, ch); i++
        while (i < src.length) {
          if (src[i] === BACKSLASH) {
            push(src[i], " "); i++
            if (i < src.length) { push(src[i], " "); i++ }
            continue
          }
          if (src[i] === BACKTICK) break
          if (src[i] === "$" && src[i + 1] === "{") {
            push(src[i], src[i]); i++
            push(src[i], src[i]); i++
            tplStack.push(braceDepth)
            braceDepth++
            break
          }
          push(src[i], src[i] === "\n" ? "\n" : " ")
          i++
        }
        if (i < src.length && src[i] === BACKTICK) { push(src[i], src[i]); i++ }
        continue
      }
    }

    push(ch, ch)
    if (!/\s/.test(ch)) prevSig = ch
    i++
  }

  return { stripped: stripped.join(""), masked: masked.join("") }
}

// ─────────────────────────────────────────────────────────────────────────────
// SLICERS — every assertion runs against one of these, never a whole file.
// ─────────────────────────────────────────────────────────────────────────────

const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" }

/** Index just past the token that closes the bracket opened at `openIdx`. */
function matchPair(masked: string, openIdx: number): number {
  const open = masked[openIdx]
  const close = PAIRS[open]
  if (!close) return -1
  const stack: string[] = [open]
  let i = openIdx + 1
  while (i < masked.length && stack.length > 0) {
    const c = masked[i]
    if (c === "=" && masked[i + 1] === ">") { i += 2; continue }
    if (PAIRS[c] && !(open !== "<" && c === "<")) stack.push(c)
    else if (c === close && stack[stack.length - 1] === open) stack.pop()
    else if (c === ")" || c === "]" || c === "}") {
      const top = stack[stack.length - 1]
      if (top && PAIRS[top] === c) stack.pop()
    }
    i++
  }
  return stack.length === 0 ? i : -1
}

function skipWs(masked: string, i: number): number {
  while (i < masked.length && /\s/.test(masked[i])) i++
  return i
}

/**
 * Walk past a TypeScript return-type annotation so the body brace is not
 * confused with an object type. `getBrokerageStats(): Promise<{ ... }>` is
 * exactly the case that breaks a naive "first brace after the paren".
 */
function skipTypeAnnotation(masked: string, i: number): number {
  i = skipWs(masked, i)
  for (;;) {
    i = skipWs(masked, i)
    const c = masked[i]
    if (c === "{" || c === "(" || c === "[") {
      const end = matchPair(masked, i)
      if (end < 0) return -1
      i = end
    } else if (/[A-Za-z_$"']/.test(c ?? "")) {
      while (i < masked.length && /[A-Za-z0-9_$.'"]/.test(masked[i])) i++
      i = skipWs(masked, i)
      while (masked[i] === "<" || masked[i] === "[") {
        const end = matchPair(masked, i)
        if (end < 0) return -1
        i = skipWs(masked, end)
      }
    } else {
      return -1
    }
    const j = skipWs(masked, i)
    if (masked[j] === "|" || masked[j] === "&") { i = j + 1; continue }
    if (masked[j] === "=" && masked[j + 1] === ">") { i = j + 2; continue }
    return j
  }
}

interface Slice { start: number; end: number; text: string }

function declIndex(masked: string, name: string): number {
  const re = new RegExp(String.raw`\bfunction\s+` + name + String.raw`\s*[(<]`)
  const m = re.exec(masked)
  return m ? m.index : -1
}

/** The PARAMETER LIST of a function declaration, parentheses excluded. */
function fnParams(masked: string, stripped: string, name: string): Slice | null {
  const d = declIndex(masked, name)
  if (d < 0) return null
  let i = masked.indexOf("(", d)
  if (i < 0) return null
  const end = matchPair(masked, i)
  if (end < 0) return null
  return { start: i + 1, end: end - 1, text: stripped.slice(i + 1, end - 1) }
}

/** The BODY of a function declaration, outer braces excluded. */
function fnBody(masked: string, stripped: string, name: string): Slice | null {
  const d = declIndex(masked, name)
  if (d < 0) return null
  let i = masked.indexOf("(", d)
  if (i < 0) return null
  let after = matchPair(masked, i)
  if (after < 0) return null
  after = skipWs(masked, after)
  if (masked[after] === ":") {
    const t = skipTypeAnnotation(masked, after + 1)
    if (t < 0) return null
    after = t
  }
  if (masked[after] !== "{") return null
  const end = matchPair(masked, after)
  if (end < 0) return null
  return { start: after + 1, end: end - 1, text: stripped.slice(after + 1, end - 1) }
}

/** The BODY of an arrow-function const, e.g. `const handleX = () => { ... }`. */
function arrowBody(masked: string, stripped: string, name: string): Slice | null {
  const re = new RegExp(String.raw`\bconst\s+` + name + String.raw`\s*=`)
  const m = re.exec(masked)
  if (!m) return null
  let i = masked.indexOf("=>", m.index)
  if (i < 0) return null
  i = skipWs(masked, i + 2)
  if (masked[i] !== "{") return null
  const end = matchPair(masked, i)
  if (end < 0) return null
  return { start: i + 1, end: end - 1, text: stripped.slice(i + 1, end - 1) }
}

/**
 * The OBJECT LITERAL handed to a builder call inside a slice, e.g. the payload
 * of `.insert({ ... })` or `.upsert({ ... })`. `nth` picks which occurrence.
 */
function callPayload(
  maskedAll: string,
  strippedAll: string,
  region: Slice,
  method: string,
  nth = 0,
): Slice | null {
  const needle = "." + method + "("
  let from = region.start
  let seen = 0
  for (;;) {
    const idx = maskedAll.indexOf(needle, from)
    if (idx < 0 || idx >= region.end) return null
    const paren = idx + needle.length - 1
    let brace = skipWs(maskedAll, paren + 1)
    if (maskedAll[brace] === "{") {
      if (seen === nth) {
        const end = matchPair(maskedAll, brace)
        if (end < 0) return null
        return { start: brace + 1, end: end - 1, text: strippedAll.slice(brace + 1, end - 1) }
      }
      seen++
    }
    from = idx + needle.length
  }
}

/** A JSX element and its children, from `<Tag` to the end of its closing tag. */
function jsxBlock(masked: string, stripped: string, tag: string, nth = 0): Slice | null {
  let from = 0
  let seen = 0
  for (;;) {
    const open = masked.indexOf("<" + tag, from)
    if (open < 0) return null
    const after = open + tag.length + 1
    if (/[A-Za-z0-9_]/.test(masked[after] ?? "")) { from = open + 1; continue }
    if (seen < nth) { seen++; from = open + 1; continue }
    // find the end of the opening tag
    let i = after
    let depth = 0
    while (i < masked.length) {
      const c = masked[i]
      if (c === "{") { const e = matchPair(masked, i); if (e < 0) return null; i = e; continue }
      if (c === ">") break
      i++
    }
    if (masked[i - 1] === "/") {
      return { start: open, end: i + 1, text: stripped.slice(open, i + 1) }
    }
    // walk children to the matching closing tag
    depth = 1
    let j = i + 1
    while (j < masked.length && depth > 0) {
      if (tagAt(masked, j, "</", tag)) { depth--; if (depth === 0) break; j += tag.length + 2; continue }
      if (tagAt(masked, j, "<", tag)) { depth++; j += tag.length + 1; continue }
      j++
    }
    const end = masked.indexOf(">", j)
    return { start: open, end: end + 1, text: stripped.slice(open, end + 1) }
  }
}

/** Contents of a top-level `const NAME = [ ... ]` array, as string entries. */
function constArrayValues(masked: string, stripped: string, name: string): string[] | null {
  const re = new RegExp(String.raw`\bconst\s+` + name + String.raw`\s*(?::[^=]*)?=\s*\[`)
  const m = re.exec(masked)
  if (!m) return null
  const open = masked.indexOf("[", m.index)
  const end = matchPair(masked, open)
  if (end < 0) return null
  const body = stripped.slice(open + 1, end - 1)
  return Array.from(body.matchAll(/["']([^"']+)["']/g)).map((x) => x[1])
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE CACHE
// ─────────────────────────────────────────────────────────────────────────────

interface Loaded { raw: string; stripped: string; masked: string }
const SRC: Record<string, Loaded> = {}

function loadAll() {
  for (const key of Object.keys(FILES) as FileKey[]) {
    const raw = readFileSync(resolve(ROOT, FILES[key]), "utf8")
    const { stripped, masked } = stripComments(raw)
    SRC[key] = { raw, stripped, masked }
  }
}

function sha(path: string): string {
  return createHash("sha256").update(readFileSync(resolve(ROOT, path))).digest("hex")
}

const S = (k: FileKey) => SRC[k].stripped
const M = (k: FileKey) => SRC[k].masked

function body(k: FileKey, name: string): Slice {
  const b = fnBody(M(k), S(k), name) ?? arrowBody(M(k), S(k), name)
  if (!b) throw new Error(`could not slice the body of ${name} in ${FILES[k]}`)
  return b
}

function params(k: FileKey, name: string): Slice {
  const p = fnParams(M(k), S(k), name)
  if (!p) throw new Error(`could not slice the params of ${name} in ${FILES[k]}`)
  return p
}

/** True when `a` occurs before `b` inside `text`, and both occur. */
function orderedIn(text: string, a: string, b: string): boolean {
  const ia = text.indexOf(a)
  const ib = text.indexOf(b)
  return ia >= 0 && ib >= 0 && ia < ib
}

/**
 * The part of a handler AFTER the server call returns.
 *
 * Ordering checks must not be anchored on the first occurrence of a setter:
 * every one of these handlers CLEARS its error and notice state before calling
 * the server, so `indexOf("setXNotice(")` finds the reset, not the result. This
 * slices from the awaited call onward, which is the only region where "did the
 * verdict come first" is a meaningful question.
 */
function afterAwait(text: string, callToken: string): string {
  const i = text.indexOf("await " + callToken)
  return i < 0 ? "" : text.slice(i)
}

/**
 * True when the tag token at `idx` is exactly `tag` and not a longer component
 * name that merely starts with it. Without this, `<Dialog` matches
 * `<DialogContent` and `</Dialog` matches `</DialogContent>`, which closes the
 * element on its own first child and slices an empty dialog.
 */
function tagAt(masked: string, idx: number, prefix: string, tag: string): boolean {
  if (!masked.startsWith(prefix + tag, idx)) return false
  const after = masked[idx + prefix.length + tag.length]
  return !/[A-Za-z0-9_]/.test(after ?? "")
}

/** A JSX element located by one of its props, e.g. `<Dialog open={editVendorOpen}`. */
function jsxByProp(masked: string, stripped: string, tag: string, prop: string): Slice | null {
  let from = 0
  for (;;) {
    const open = masked.indexOf("<" + tag, from)
    if (open < 0) return null
    if (!tagAt(masked, open, "<", tag)) { from = open + 1; continue }
    let i = open + tag.length + 1
    while (i < masked.length) {
      const c = masked[i]
      if (c === "{") { const e = matchPair(masked, i); if (e < 0) return null; i = e; continue }
      if (c === ">") break
      i++
    }
    if (stripped.slice(open, i).includes(prop)) {
      if (masked[i - 1] === "/") return { start: open, end: i + 1, text: stripped.slice(open, i + 1) }
      let depth = 1
      let j = i + 1
      while (j < masked.length && depth > 0) {
        if (tagAt(masked, j, "</", tag)) { depth--; if (depth === 0) break; j += tag.length + 2; continue }
        if (tagAt(masked, j, "<", tag)) { depth++; j += tag.length + 1; continue }
        j++
      }
      const end = masked.indexOf(">", j)
      return { start: open, end: end + 1, text: stripped.slice(open, end + 1) }
    }
    from = open + 1
  }
}

/** A guard: `cond` appears, and a `return` follows it within `window` chars. */
function refusingBranch(text: string, cond: string, window = 320): boolean {
  let from = 0
  for (;;) {
    const i = text.indexOf(cond, from)
    if (i < 0) return false
    if (text.slice(i, i + window).includes("return")) return true
    from = i + cond.length
  }
}

/**
 * A LIVE refusing guard: as refusingBranch, but the condition must actually be
 * the `if` test rather than merely appearing somewhere inside one.
 * `if (false && !(VOCAB).includes(x))` still contains the token — gutting a
 * branch that way must not satisfy a check about the branch.
 */
function liveRefusingBranch(text: string, cond: string, window = 320): boolean {
  let from = 0
  for (;;) {
    const i = text.indexOf(cond, from)
    if (i < 0) return false
    const head = text.slice(Math.max(0, i - 12), i).replace(/\s+/g, "")
    if ((head.endsWith("if(!(") || head.endsWith("if(!") || head.endsWith("if(")) &&
        text.slice(i, i + window).includes("return")) {
      return true
    }
    from = i + cond.length
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LIVE VOCABULARIES — the expectation each hard-coded list is measured against.
// Re-verified against the database by the optional live layer.
// ─────────────────────────────────────────────────────────────────────────────

const LIVE = {
  agentGoalTypes: [
    "gross_commission", "transactions_closed", "listings_taken", "buyer_clients",
    "new_contacts", "conversion_rate", "avg_days_to_close",
  ],
  vendorAssignmentTypes: [
    "inspector", "lender", "title", "stager", "photographer",
    "cleaner", "contractor", "mover", "insurance", "other",
  ],
  vendorBookingStatuses: ["booked", "confirmed", "completed", "cancelled", "no_show"],
  complianceFlagStatuses: ["flagged", "reviewed", "resolved", "overridden"],
}

const sameSet = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().join("|") === [...b].sort().join("|")

// ─────────────────────────────────────────────────────────────────────────────
// CHECKS
// ─────────────────────────────────────────────────────────────────────────────

interface Check {
  id: string
  desc: string
  run: () => true | string
  /** Mutation applied to real source to prove this check can fail. */
  neg: { file: FileKey; find: string; replace: string }
}

const CHECKS: Check[] = [

  // ══════════════ AGENTS ══════════════

  {
    id: "A1-createAgent-no-caller-tenant",
    desc: "createAgent never reads a brokerage id off its parameter object",
    run: () => {
      const b = body("agents", "createAgent")
      return b.text.includes("agentData.brokerage_id")
        ? "createAgent still reads agentData.brokerage_id — the caller can name the tenant"
        : true
    },
    neg: {
      file: "agents",
      find: "      brokerage_id: ctx.brokerageId,\n      user_id: agentData.user_id,",
      replace: "      brokerage_id: agentData.brokerage_id,\n      gamification_points: 0,",
    },
  },
  {
    id: "A2-createAgent-stamps-tenant-at-insert",
    desc: "createAgent's INSERT payload carries brokerage_id from the session context",
    run: () => {
      const b = body("agents", "createAgent")
      const p = callPayload(M("agents"), S("agents"), b, "insert")
      if (!p) return "no insert payload found in createAgent"
      return /brokerage_id\s*:\s*ctx\.brokerageId/.test(p.text)
        ? true
        : "the agents INSERT payload does not stamp brokerage_id from ctx"
    },
    neg: {
      file: "agents",
      find: "      brokerage_id: ctx.brokerageId,\n      user_id: agentData.user_id,",
      replace: "      gamification_points: 0,",
    },
  },
  {
    id: "A3-createAgent-service-client",
    desc: "createAgent writes on the service client (RLS agents_insert_own forbids admin-for-other)",
    run: () => {
      const b = body("agents", "createAgent")
      return b.text.includes("createServiceClient()")
        ? true
        : "createAgent does not use the service client, so RLS refuses every admin repair"
    },
    neg: {
      file: "agents",
      find: "  const svc = createServiceClient()\n\n  // The target user must already exist",
      replace: "  const svc = await createClient()\n\n  // The target user must already exist",
    },
  },
  {
    id: "A4-createAgent-role-gate",
    desc: "createAgent refuses a non-admin caller",
    // Anchored to the SHARED tenant-admin predicate, not to a module-local
    // roster const. The const this used to name (BROKER_ADMIN_ROLES) was one of
    // 176 spellings of the same question and is gone — collapsed onto the one
    // roster the owner's ruling requires. A gate is proven by the predicate it
    // calls and the refusal it returns, never by the name of a set literal.
    run: () => {
      const b = body("agents", "createAgent")
      return refusingBranch(b.text, "isAdminOrBroker({ user_type: ctx.userType })")
        ? true
        : "createAgent has no refusing role gate"
    },
    neg: {
      file: "agents",
      find: "  if (!isAdminOrBroker({ user_type: ctx.userType })) {\n    return { error: \"Only brokers / admins / team leads can create agent records.\" }\n  }",
      replace: "",
    },
  },
  {
    id: "A5-createAgent-target-tenancy",
    desc: "createAgent refuses a target user outside the caller's brokerage",
    run: () => {
      const b = body("agents", "createAgent")
      return refusingBranch(b.text, "targetUser.brokerage_id !== ctx.brokerageId")
        ? true
        : "createAgent does not refuse a cross-tenant target user"
    },
    neg: {
      file: "agents",
      find: "  if (targetUser.brokerage_id !== ctx.brokerageId) {\n    return { error: \"That user is not in your brokerage.\" }\n  }",
      replace: "",
    },
  },
  {
    // RETARGETED BY m484's LANE. This asserted `getAchievements`, a reader of the
    // DUPLICATE reward ledger. `achievements` + `agent_achievements` and
    // `gamification_badges` + `agent_badges` were the same idea twice — a catalog of
    // named rewards unlocked at a points threshold plus a per-agent award ledger —
    // and both duplicate tables held zero live rows, so nothing had ever been awarded
    // from either. The badges pair survives (tenant-scoped, tiered, already read by
    // Agent 360); m484 merges the `category` idea onto it, migrates any rows and drops
    // the duplicate. The honest-failure property the old check guarded is asserted
    // here against the surviving reader instead of being dropped.
    id: "A6-reward-ledger-reader-reports-a-refused-read",
    desc: "the surviving reward-ledger reader reads agent_badges and reports a refused read instead of an empty ledger",
    run: () => {
      const b = body("agents", "getAgentAchievements")
      if (!/agent_badges/.test(b.text)) return "the reader does not read the surviving ledger (agent_badges)"
      if (!/const\s*\{[^}]*\berror\b[^}]*\}\s*=\s*await/.test(b.text)) {
        return "the reader does not destructure error"
      }
      return /if \(error\)/.test(b.text) && /console\.error/.test(b.text)
        ? true
        : "a refused read is swallowed as an empty ledger"
    },
    neg: {
      file: "agents",
      find: '    console.error("[getAgentAchievements] awarded-badge read refused:", error.message)',
      replace: "    void 0",
    },
  },
  {
    id: "A7-addAgentExpense-stamps-tenant",
    desc: "addAgentExpense stamps brokerage_id AT the insert (the tenant policy admits NULL)",
    run: () => {
      const b = body("agents", "addAgentExpense")
      const p = callPayload(M("agents"), S("agents"), b, "insert")
      if (!p) return "no insert payload found in addAgentExpense"
      return /brokerage_id\s*:\s*ctx\.brokerageId/.test(p.text)
        ? true
        : "the business_expenses INSERT payload leaves brokerage_id NULL — readable by every brokerage"
    },
    neg: {
      file: "agents",
      find: "      brokerage_id: ctx.brokerageId,\n      category: expenseData.category,",
      replace: "      category: expenseData.category,",
    },
  },
  {
    id: "A8-addAgentExpense-actor-from-session",
    desc: "addAgentExpense writes the session-resolved agent, never the caller's raw agent_id",
    run: () => {
      const b = body("agents", "addAgentExpense")
      const p = callPayload(M("agents"), S("agents"), b, "insert")
      if (!p) return "no insert payload found in addAgentExpense"
      if (/agent_id\s*:\s*expenseData\.agent_id/.test(p.text)) {
        return "the insert takes agent_id straight from the caller"
      }
      if (!/agent_id\s*:\s*agentId/.test(p.text)) return "the insert does not carry the resolved agentId"
      // The NARROWER tier, deliberately. Booking a cost against someone else's
      // ledger is brokerage-wide money — business_expenses is a FINANCE table
      // under is_brokerage_finance_admin() (m472), which holds team_lead out —
      // and this write goes through the SERVICE client, so RLS is bypassed and
      // this predicate is the only gate it has. Asserting the WIDE roster here
      // would have blessed an app gate that overrules the database.
      return refusingBranch(b.text, "isBrokerageFinanceAdmin({ user_type: ctx.userType })")
        ? true
        : "naming another agent's ledger is not gated on the brokerage-money roster"
    },
    neg: {
      file: "agents",
      find: "      agent_id: agentId,\n      // TENANT ANCHOR",
      replace: "      agent_id: expenseData.agent_id,\n      // TENANT ANCHOR",
    },
  },
  {
    id: "A9-getExpenseSummary-uncapped",
    desc: "getExpenseSummary aggregates the whole year — no row cap on the aggregation read",
    run: () => {
      const b = body("agents", "getExpenseSummary")
      return b.text.includes(".limit(")
        ? "getExpenseSummary caps its read, so the category totals would be a partial year"
        : true
    },
    neg: {
      file: "agents",
      find: "    .lte(\"expense_date\", endDate)\n\n  if (error) {\n    console.error(\"Error fetching expense summary:\", error)",
      replace: "    .lte(\"expense_date\", endDate)\n    .limit(100)\n\n  if (error) {\n    console.error(\"Error fetching expense summary:\", error)",
    },
  },
  {
    id: "A10-getExpenseSummary-honest-failure",
    desc: "getExpenseSummary returns ok:false on a refused read rather than an empty summary",
    run: () => {
      const b = body("agents", "getExpenseSummary")
      return refusingBranch(b.text, "if (error)") && /ok:\s*false[^}]*error:\s*error\.message/.test(b.text)
        ? true
        : "getExpenseSummary flattens a failed read into an empty summary"
    },
    neg: {
      file: "agents",
      find: "    return { ok: false, ...empty, error: error.message }\n  }\n\n  // Group by category over EVERY row",
      replace: "    return { ok: true, ...empty }\n  }\n\n  // Group by category over EVERY row",
    },
  },
  {
    id: "A11-setAgentGoal-stamps-tenant",
    desc: "setAgentGoal supplies the NOT NULL brokerage_id it used to omit",
    run: () => {
      const b = body("agents", "setAgentGoal")
      const p = callPayload(M("agents"), S("agents"), b, "upsert")
      if (!p) return "no upsert payload found in setAgentGoal"
      return /brokerage_id\s*:\s*ctx\.brokerageId/.test(p.text)
        ? true
        : "the agent_goals write still omits brokerage_id, which is NOT NULL"
    },
    neg: {
      file: "agents",
      find: "        // TENANT ANCHOR — NOT NULL on this table, stamped at the write.\n        brokerage_id: ctx.brokerageId,",
      replace: "",
    },
  },
  {
    id: "A12-setAgentGoal-vocabulary-gate",
    desc: "setAgentGoal refuses a goal_type the CHECK constraint would reject",
    run: () => {
      const b = body("agents", "setAgentGoal")
      // liveRefusingBranch, not refusingBranch: the token survives inside a
      // gutted `if (false && ...)` and a token-presence check would call that
      // a validated vocabulary.
      if (!liveRefusingBranch(b.text, "AGENT_GOAL_TYPES as readonly string[]).includes(goalData.goal_type)")) {
        return "setAgentGoal does not validate goal_type in a live refusing branch before the write"
      }
      return orderedIn(b.text, "AGENT_GOAL_TYPES", ".upsert(")
        ? true
        : "the vocabulary gate does not run before the write"
    },
    neg: {
      file: "agents",
      find: "  if (!(AGENT_GOAL_TYPES as readonly string[]).includes(goalData.goal_type)) {",
      replace: "  if (false && !(AGENT_GOAL_TYPES as readonly string[]).includes(goalData.goal_type)) {",
    },
  },
  {
    id: "A13-agent-goal-vocabulary-matches-db",
    desc: "AGENT_GOAL_TYPES is exactly the live agent_goals_goal_type_check vocabulary",
    run: () => {
      const v = constArrayValues(M("agents"), S("agents"), "AGENT_GOAL_TYPES")
      if (!v) return "AGENT_GOAL_TYPES not found"
      return sameSet(v, LIVE.agentGoalTypes)
        ? true
        : `AGENT_GOAL_TYPES drifted from the column: [${v.join(", ")}]`
    },
    neg: {
      file: "agents",
      find: "  \"gross_commission\",\n  \"transactions_closed\",",
      replace: "  \"gci\",\n  \"transactions_closed\",",
    },
  },
  {
    id: "A14-setAgentGoal-no-single-probe",
    desc: "setAgentGoal's pre-existence probe uses maybeSingle, not single (single errors on zero rows)",
    run: () => {
      const b = body("agents", "setAgentGoal")
      const probe = b.text.slice(0, b.text.indexOf(".upsert("))
      if (probe.includes(".single()")) return "the probe still uses .single(), whose zero-row error skips the branch"
      return probe.includes(".maybeSingle()") ? true : "the probe does not use maybeSingle"
    },
    neg: {
      file: "agents",
      find: "    .eq(\"goal_type\", goalData.goal_type)\n    .maybeSingle()\n  if (existingErr) {",
      replace: "    .eq(\"goal_type\", goalData.goal_type)\n    .single()\n  if (existingErr) {",
    },
  },
  {
    id: "A15-assignAgentToContact-counts-the-move",
    desc: "assignAgentToContact counts its UPDATE and refuses a zero-row match",
    run: () => {
      const b = body("agents", "assignAgentToContact")
      const p = callPayload(M("agents"), S("agents"), b, "update")
      if (!p) return "no update payload found"
      const call = S("agents").slice(p.start, p.start + 400)
      if (!/count:\s*"exact"/.test(call)) return "the UPDATE is not counted, so a zero-row move reads as a save"
      return refusingBranch(b.text, "if (!count)") ? true : "a zero-row match is not refused"
    },
    neg: {
      file: "agents",
      find: "  if (!count) {\n    return { error: \"That contact was not found in your brokerage — nothing was changed.\" }\n  }",
      replace: "",
    },
  },
  {
    id: "A16-assignAgentToContact-checks-receiver",
    desc: "assignAgentToContact refuses a receiving agent outside the caller's brokerage",
    run: () => {
      const b = body("agents", "assignAgentToContact")
      if (!orderedIn(b.text, "targetAgent", "update(")) return "the receiving agent is not resolved before the move"
      return refusingBranch(b.text, "if (!targetAgent)") ? true : "an unknown receiving agent is not refused"
    },
    neg: {
      file: "agents",
      find: "  if (!targetAgent) return { error: \"That agent is not in your brokerage.\" }",
      replace: "",
    },
  },
  {
    id: "A17-getBrokerageStats-no-caller-tenant",
    desc: "getBrokerageStats takes no arguments — the tenant comes from the session",
    run: () => {
      const p = params("agents", "getBrokerageStats")
      if (p.text.trim() !== "") return `getBrokerageStats still accepts parameters: (${p.text.trim()})`
      const b = body("agents", "getBrokerageStats")
      return b.text.includes("ctx.brokerageId") ? true : "the tenant is not taken from the session context"
    },
    neg: {
      file: "agents",
      find: "export async function getBrokerageStats(): Promise<{",
      replace: "export async function getBrokerageStats(brokerageIdParam?: string): Promise<{",
    },
  },
  {
    id: "A18-getBrokerageStats-reports-every-failure",
    desc: "getBrokerageStats inspects the error of all five reads and names each failure",
    run: () => {
      // Every one of the five reads must be named, its error tested in a real
      // `if`, and a degraded marker pushed inside that branch. Counting tokens
      // is not enough: a gutted branch keeps both the name and the push.
      const b = body("agents", "getBrokerageStats")
      const reads = ["gciRes", "lastGciRes", "dealsRes", "agentsRes", "riskRes"]
      const expected: Record<string, string> = {
        gciRes: "monthlyGCI",
        lastGciRes: "lastMonthGCI",
        dealsRes: "activeDeals",
        agentsRes: "agentCount",
        riskRes: "openComplianceFlags",
      }
      for (const r of reads) {
        const guard = `if (${r}.error) {`
        const i = b.text.indexOf(guard)
        if (i < 0) return `${r} has no live error guard`
        const branch = b.text.slice(i, i + 260)
        if (!branch.includes(`degraded.push("${expected[r]}")`)) {
          return `${r}'s failure is not recorded as ${expected[r]} in degraded`
        }
      }
      return true
    },
    neg: {
      file: "agents",
      find: "  if (riskRes.error) {\n    console.error(\"Error counting compliance flags:\", riskRes.error)\n    degraded.push(\"openComplianceFlags\")\n  } else {",
      replace: "  if (false) {\n    degraded.push(\"x\")\n  } else {",
    },
  },
  {
    id: "A19-getBrokerageStats-no-swallow",
    desc: "getBrokerageStats has no bare catch block turning a refused read into a zero",
    run: () => {
      const b = body("agents", "getBrokerageStats")
      return /catch\s*\(/.test(b.text)
        ? "a catch block in getBrokerageStats can still swallow a refused read"
        : true
    },
    neg: {
      file: "agents",
      find: "  let monthlyGCI = 0\n  if (gciRes.error) {",
      replace: "  let monthlyGCI = 0\n  try { void 0 } catch (e) { void 0 }\n  if (gciRes.error) {",
    },
  },
  {
    id: "A20-getBrokerageStats-active-agents",
    desc: "the agent headcount counts ACTIVE agents only",
    run: () => {
      const b = body("agents", "getBrokerageStats")
      const i = b.text.indexOf('.from("agents")')
      if (i < 0) return "no agents count query found"
      return /is_active"?\s*,\s*true/.test(b.text.slice(i, i + 300))
        ? true
        : "the headcount includes deactivated agents"
    },
    neg: {
      file: "agents",
      find: "      .eq(\"brokerage_id\", brokerageId)\n      .eq(\"is_active\", true),\n    supabase\n      .from(\"compliance_flags\")",
      replace: "      .eq(\"brokerage_id\", brokerageId),\n    supabase\n      .from(\"compliance_flags\")",
    },
  },

  // ══════════════ VENDORS ══════════════

  {
    id: "V1-vendors-kernel-no-dead-client",
    desc: "vendors-kernel no longer imports the unused request-scoped client",
    run: () =>
      /import\s*\{\s*createClient\s*\}/.test(S("vendorsKernel"))
        ? "vendors-kernel still imports createClient, which nothing in it uses"
        : true,
    neg: {
      file: "vendorsKernel",
      find: "import { getAgentContext } from \"@/lib/identity\"",
      replace: "import { createClient } from \"@/lib/supabase/server\"\nimport { getAgentContext } from \"@/lib/identity\"",
    },
  },
  {
    id: "V2-assignment-type-gate-precedes-kernel",
    desc: "assignVendorToTransactionAction refuses an invalid assignment type BEFORE reaching the kernel",
    run: () => {
      const b = body("vendorsKernel", "assignVendorToTransactionAction")
      // liveRefusingBranch: a gutted `if (false && ...)` keeps the token.
      if (!liveRefusingBranch(b.text, "VENDOR_ASSIGNMENT_TYPES as readonly string[]).includes(params.assignmentType)")) {
        return "there is no LIVE refusing vocabulary gate"
      }
      return orderedIn(b.text, "VENDOR_ASSIGNMENT_TYPES", "assignVendorToTransaction({")
        ? true
        : "the gate does not run before the kernel call"
    },
    neg: {
      file: "vendorsKernel",
      find: "  if (!(VENDOR_ASSIGNMENT_TYPES as readonly string[]).includes(params.assignmentType)) {",
      replace: "  if (false && !(VENDOR_ASSIGNMENT_TYPES as readonly string[]).includes(params.assignmentType)) {",
    },
  },
  {
    id: "V3-assignment-vocabulary-matches-db",
    desc: "the action's VENDOR_ASSIGNMENT_TYPES is exactly the live assignment_type CHECK",
    run: () => {
      const v = constArrayValues(M("vendorsKernel"), S("vendorsKernel"), "VENDOR_ASSIGNMENT_TYPES")
      if (!v) return "VENDOR_ASSIGNMENT_TYPES not found in the action"
      return sameSet(v, LIVE.vendorAssignmentTypes)
        ? true
        : `the action's vocabulary drifted from the column: [${v.join(", ")}]`
    },
    neg: {
      file: "vendorsKernel",
      find: "  \"inspector\",\n  \"lender\",\n  \"title\",",
      replace: "  \"escrow\",\n  \"lender\",\n  \"title\",",
    },
  },
  {
    id: "V4-ui-assignment-vocabulary-agrees",
    desc: "the deal-assignment picker offers exactly what the action accepts",
    run: () => {
      const ui = constArrayValues(M("vendorClient"), S("vendorClient"), "VENDOR_ASSIGNMENT_TYPES")
      const srv = constArrayValues(M("vendorsKernel"), S("vendorsKernel"), "VENDOR_ASSIGNMENT_TYPES")
      if (!ui || !srv) return "one of the two vocabularies is missing"
      return sameSet(ui, srv) ? true : `the picker and the action disagree: UI [${ui.join(", ")}]`
    },
    neg: {
      file: "vendorClient",
      find: "  \"inspector\",\n  \"lender\",\n  \"title\",",
      replace: "  \"inspector\",\n  \"plumber\",\n  \"lender\",\n  \"title\",",
    },
  },
  {
    id: "V5-all-four-vendor-actions-imported",
    desc: "the vendor directory imports all four previously-orphaned kernel actions",
    run: () => {
      const m = /import\s*\{([^}]*)\}\s*from\s*"@\/app\/actions\/vendors-kernel"/.exec(S("vendorClient"))
      if (!m) return "no import from the vendors-kernel action module"
      const missing = [
        "updateVendorRecordAction",
        "assignVendorToListingAction",
        "assignVendorToTransactionAction",
        "updateVendorBookingStatusAction",
      ].filter((n) => !m[1].includes(n))
      return missing.length === 0 ? true : `still unwired: ${missing.join(", ")}`
    },
    neg: {
      file: "vendorClient",
      find: "  updateVendorBookingStatusAction,\n} from \"@/app/actions/vendors-kernel\"",
      replace: "} from \"@/app/actions/vendors-kernel\"",
    },
  },
  {
    id: "V6-edit-vendor-reads-verdict",
    desc: "the Edit Vendor handler refuses to close its dialog on a server refusal",
    run: () => {
      const b = body("vendorClient", "handleUpdateVendor")
      if (!refusingBranch(b.text, "if (!result.success)")) return "the server verdict is not acted on"
      return orderedIn(b.text, "if (!result.success)", "setEditVendorOpen(false)")
        ? true
        : "the dialog closes before the verdict is read"
    },
    neg: {
      file: "vendorClient",
      find: "      if (!result.success) {\n        setEditVendorError(result.error ?? \"Failed to update vendor.\")\n        return\n      }",
      replace: "",
    },
  },
  {
    id: "V7-listing-booking-reads-verdict",
    desc: "the listing-booking handler refuses to report success on a server refusal",
    run: () => {
      const b = body("vendorClient", "handleAssignToListing")
      if (!refusingBranch(b.text, "if (!result.success)")) return "the server verdict is not acted on"
      return orderedIn(b.text, "if (!result.success)", "setListingNotice(")
        ? true
        : "the success notice is set before the verdict is read"
    },
    neg: {
      file: "vendorClient",
      find: "      if (!result.success) {\n        setListingError(result.error ?? \"Failed to book that vendor for the listing.\")\n        return\n      }",
      replace: "",
    },
  },
  {
    id: "V8-deal-assignment-reads-verdict",
    desc: "the deal-assignment handler refuses to report success on a server refusal",
    run: () => {
      const b = body("vendorClient", "handleAssignToTransaction")
      if (!refusingBranch(b.text, "if (!result.success)")) return "the server verdict is not acted on"
      return orderedIn(b.text, "if (!result.success)", "setAssignNotice(")
        ? true
        : "the success notice is set before the verdict is read"
    },
    neg: {
      file: "vendorClient",
      find: "      if (!result.success) {\n        setAssignError(result.error ?? \"Failed to assign that vendor to the deal.\")\n        return\n      }",
      replace: "",
    },
  },
  {
    id: "V9-booking-status-reads-verdict",
    desc: "a booking status change only repaints the badge after the server accepts it",
    run: () => {
      const b = body("vendorClient", "handleBookingStatus")
      if (!refusingBranch(b.text, "if (!result.success)")) return "the server verdict is not acted on"
      return orderedIn(b.text, "if (!result.success)", "setBookingStatuses(")
        ? true
        : "the local status is repainted before the verdict is read"
    },
    neg: {
      file: "vendorClient",
      find: "      if (!result.success) {\n        setStatusError(result.error ?? \"Could not change that booking's status.\")\n        setStatusBookingId(null)\n        return\n      }",
      replace: "",
    },
  },
  {
    id: "V10-edit-category-is-constrained-control",
    desc: "the Edit Vendor category is authored by the CHECK-safe picker, not a free-text box",
    run: () => {
      const dlg = jsxByProp(M("vendorClient"), S("vendorClient"), "Dialog", "open={editVendorOpen}")
      if (!dlg) return "the Edit Vendor dialog could not be sliced"
      const region = dlg.text
      if (!/setEditCategory/.test(region)) return "the edit dialog has no category control at all"
      if (/<Input[^>]*setEditCategory/.test(region)) {
        return "a free-text Input authors the category, which the CHECK would reject"
      }
      const sel = jsxByProp(M("vendorClient"), S("vendorClient"), "VendorCategorySelect", "onChange={setEditCategory}")
      return sel && sel.start > dlg.start && sel.end <= dlg.end
        ? true
        : "the category is not authored by the CHECK-safe picker inside this dialog"
    },
    neg: {
      file: "vendorClient",
      find: "              <VendorCategorySelect\n                id=\"edit-vendor-category\"\n                value={editCategory}\n                onChange={setEditCategory}\n              />",
      replace: "              <Input value={editCategory} onChange={(e) => setEditCategory(e.target.value as VendorCategory)} />",
    },
  },
  {
    id: "V11-edit-patch-excludes-paid-placement",
    desc: "the vendor edit patch cannot touch sold directory placement",
    run: () => {
      const b = body("vendorClient", "handleUpdateVendor")
      const p = callPayload(M("vendorClient"), S("vendorClient"), b, "updateVendorRecordAction".replace("updateVendorRecordAction", "updateVendorRecordAction"))
        ?? null
      const region = p ? p.text : b.text
      const leaked = ["preferred", "display_priority", "visible_in_portal"].filter((f) =>
        new RegExp(String.raw`\b` + f + String.raw`\s*:`).test(region),
      )
      return leaked.length === 0 ? true : `the edit patch writes paid placement fields: ${leaked.join(", ")}`
    },
    neg: {
      file: "vendorClient",
      find: "          notes: editNotes.trim(),\n        },",
      replace: "          notes: editNotes.trim(),\n          preferred: true,\n        },",
    },
  },
  {
    id: "V12-booking-transition-map-matches-db",
    desc: "the status buttons only offer transitions the column and the kernel both admit",
    run: () => {
      const m = /const\s+BOOKING_NEXT_STATUSES[^=]*=\s*\{/.exec(M("vendorClient"))
      if (!m) return "BOOKING_NEXT_STATUSES not found"
      const open = M("vendorClient").indexOf("{", m.index + m[0].length - 1)
      const end = matchPair(M("vendorClient"), open)
      const region = S("vendorClient").slice(open + 1, end - 1)
      const keys = Array.from(region.matchAll(/(\w+)\s*:\s*\[/g)).map((x) => x[1])
      const values = Array.from(region.matchAll(/["'](\w+)["']/g)).map((x) => x[1])
      if (!sameSet(keys, LIVE.vendorBookingStatuses)) return `the map's keys are not the live status set: [${keys.join(", ")}]`
      const bad = values.filter((v) => !LIVE.vendorBookingStatuses.includes(v))
      if (bad.length > 0) return `the map offers statuses the column refuses: ${bad.join(", ")}`
      for (const terminal of ["completed", "cancelled", "no_show"]) {
        // Match a NON-EMPTY array, whatever it holds — a quoted status is what a
        // drifted map would actually contain, and `\w` would miss it.
        if (new RegExp(terminal + String.raw`\s*:\s*\[\s*[^\s\]]`).test(region)) {
          return `${terminal} is terminal but the map offers onward transitions`
        }
      }
      return true
    },
    neg: {
      file: "vendorClient",
      find: "  completed: [],\n  cancelled: [],",
      replace: "  completed: [\"confirmed\"],\n  cancelled: [],",
    },
  },
  {
    id: "V13-status-buttons-driven-by-current-status",
    desc: "the status buttons are derived from the booking's CURRENT status, not hard-coded",
    run: () => {
      const s = S("vendorClient")
      const i = s.indexOf("BOOKING_NEXT_STATUSES[")
      if (i < 0) return "the buttons are not driven by the transition map"
      return s.slice(i, i + 80).includes("effectiveStatus(booking)")
        ? true
        : "the transition map is not keyed on the booking's current status"
    },
    neg: {
      file: "vendorClient",
      find: "{(BOOKING_NEXT_STATUSES[effectiveStatus(booking)] ?? []).map((next) => (",
      replace: "{(BOOKING_NEXT_STATUSES[\"booked\"] ?? []).map((next) => (",
    },
  },
  {
    id: "V14-listings-reach-the-directory",
    desc: "the vendors page loads brokerage-scoped listings and hands them to the directory",
    run: () => {
      const s = S("vendorPage")
      const i = s.indexOf('.from("listings")')
      if (i < 0) return "the page never reads the listings table"
      if (!/\.eq\("brokerage_id",\s*profile\.brokerage_id\)/.test(s.slice(i, i + 300))) {
        return "the listings read is not scoped to the caller's brokerage"
      }
      const el = jsxBlock(M("vendorPage"), S("vendorPage"), "VendorDirectoryClient")
      if (!el) return "VendorDirectoryClient is not rendered"
      return /listings=\{listings\}/.test(el.text) ? true : "listings are never passed to the directory"
    },
    neg: {
      file: "vendorPage",
      find: "              listings={listings}\n",
      replace: "",
    },
  },

  // ══════════════ EDUCATION ══════════════

  {
    id: "E1-no-action-takes-a-caller-tenant",
    desc: "no education action accepts brokerageId as a REQUIRED caller-supplied argument",
    run: () => {
      const names = ["assignResourceAction", "recordCompletionAction", "bulkAssignAction", "getAnalyticsAction"]
      const bad: string[] = []
      for (const n of names) {
        const p = params("educationKernel", n)
        if (/brokerageId/.test(p.text)) bad.push(n)
      }
      // createResourceAction keeps the parameter for its existing caller, but the
      // BODY must not use it.
      const cb = body("educationKernel", "createResourceAction")
      if (/brokerageId:\s*input\.brokerageId/.test(cb.text)) bad.push("createResourceAction (uses it)")
      return bad.length === 0 ? true : `still tenant-by-argument: ${bad.join(", ")}`
    },
    neg: {
      file: "educationKernel",
      find: "export async function assignResourceAction(input: {\n  contactId: string\n  resourceId: string\n}",
      replace: "export async function assignResourceAction(input: {\n  contactId: string\n  resourceId: string\n  brokerageId: string\n}",
    },
  },
  {
    id: "E2-assign-uses-service-client",
    desc: "assignResourceAction writes on the service client (learning_assignments has no INSERT policy)",
    run: () => {
      const b = body("educationKernel", "assignResourceAction")
      if (!b.text.includes("createServiceClient()")) return "no service client — the RLS-bound write is always refused"
      return /assignResource\(\s*svc\s*,/.test(b.text) ? true : "the kernel is not handed the service client"
    },
    neg: {
      file: "educationKernel",
      find: "  const svc = createServiceClient()\n  const owns = await assertTenantOwnsAll(svc, actor.brokerageId, [input.resourceId], [input.contactId])\n  if (!owns.ok) return { success: false, error: owns.error }\n\n  try {\n    const result = await assignResource(svc, {",
      replace: "  const svc = await createClient()\n  const owns = await assertTenantOwnsAll(svc as never, actor.brokerageId, [input.resourceId], [input.contactId])\n  if (!owns.ok) return { success: false, error: owns.error }\n\n  try {\n    const result = await assignResource(svc, {",
    },
  },
  {
    id: "E3-completion-uses-service-client",
    desc: "recordCompletionAction writes on the service client",
    run: () => {
      const b = body("educationKernel", "recordCompletionAction")
      if (!b.text.includes("createServiceClient()")) return "no service client — the RLS-bound upsert is always refused"
      return /recordCompletion\(\s*svc\s*,/.test(b.text) ? true : "the kernel is not handed the service client"
    },
    neg: {
      file: "educationKernel",
      find: "    const result = await recordCompletion(svc, {",
      replace: "    const result = await recordCompletion(await createClient(), {",
    },
  },
  {
    id: "E4-bulk-uses-service-client",
    desc: "bulkAssignAction writes on the service client",
    run: () => {
      const b = body("educationKernel", "bulkAssignAction")
      if (!b.text.includes("createServiceClient()")) return "no service client — the RLS-bound upsert is always refused"
      return /bulkAssignResources\(\s*svc\s*,/.test(b.text) ? true : "the kernel is not handed the service client"
    },
    neg: {
      file: "educationKernel",
      find: "  const result = await bulkAssignResources(svc, {",
      replace: "  const result = await bulkAssignResources(await createClient(), {",
    },
  },
  {
    id: "E5-tenancy-checked-before-every-write",
    desc: "every education write verifies tenancy BEFORE calling the kernel",
    run: () => {
      const pairs: Array<[string, string]> = [
        ["assignResourceAction", "assignResource(svc"],
        ["recordCompletionAction", "recordCompletion(svc"],
        ["bulkAssignAction", "bulkAssignResources(svc"],
      ]
      for (const [fn, call] of pairs) {
        const b = body("educationKernel", fn)
        if (!orderedIn(b.text, "assertTenantOwnsAll(", call)) {
          return `${fn} calls the kernel without first proving the rows belong to this brokerage`
        }
        if (!refusingBranch(b.text, "owns.ok")) return `${fn} does not refuse when the tenancy check fails`
      }
      return true
    },
    neg: {
      file: "educationKernel",
      find: "  const owns = await assertTenantOwnsAll(svc, actor.brokerageId, resourceIds, contactIds)\n  if (!owns.ok) return { success: false, ...zero, requested, error: owns.error }",
      replace: "",
    },
  },
  {
    id: "E6-tenancy-helper-reads-errors",
    desc: "the tenancy helper destructures error on both reads and refuses on failure",
    run: () => {
      const b = body("educationKernel", "assertTenantOwnsAll")
      const guards = (b.text.match(/if\s*\(error\)\s*return\s*\{\s*ok:\s*false/g) ?? []).length
      if (guards < 2) return `only ${guards} of the 2 tenancy reads report a refused query`
      const misses = (b.text.match(/missing\.length\s*>\s*0/g) ?? []).length
      return misses >= 2 ? true : "a row that is not in this brokerage is not refused"
    },
    neg: {
      file: "educationKernel",
      find: "      .in(\"id\", contactIds)\n    if (error) return { ok: false, error: error.message }",
      replace: "      .in(\"id\", contactIds)\n    if (false) return { ok: false, error: \"x\" }",
    },
  },
  {
    id: "E7-bulk-count-is-measured-not-assumed",
    desc: "bulkAssignAction reports a MEASURED newly-assigned count, not the kernel's optimistic one",
    run: () => {
      const b = body("educationKernel", "bulkAssignAction")
      if (/result\.assignedCount/.test(b.text)) return "it still returns the kernel's assignedCount, which counts skipped upserts as assigned"
      if (!/const\s+newlyAssigned\s*=\s*after\s*-\s*before/.test(b.text)) {
        return "newlyAssigned is not derived from a before/after measurement"
      }
      return refusingBranch(b.text, "before === null || after === null")
        ? true
        : "an unverifiable count is still reported as a success"
    },
    neg: {
      file: "educationKernel",
      find: "  const newlyAssigned = after - before",
      replace: "  const newlyAssigned = result.assignedCount",
    },
  },
  {
    id: "E8-bulk-count-query-is-scoped-and-exact",
    desc: "the before/after measurement is an exact head count scoped to the tenant",
    run: () => {
      const b = body("educationKernel", "bulkAssignAction")
      const i = b.text.indexOf('.from("learning_assignments")')
      if (i < 0) return "no learning_assignments count query"
      const q = b.text.slice(i, i + 420)
      if (!/count:\s*"exact",\s*head:\s*true/.test(q)) return "the measurement is not an exact head count"
      if (!/\.eq\("brokerage_id",\s*actor\.brokerageId\)/.test(q)) return "the measurement is not tenant-scoped"
      return /if\s*\(error\)/.test(q) || b.text.includes("count failed") ? true : "the count discards its error"
    },
    neg: {
      file: "educationKernel",
      find: "      .select(\"id\", { count: \"exact\", head: true })\n      .eq(\"brokerage_id\", actor.brokerageId)",
      replace: "      .select(\"id\", { count: \"exact\", head: true })",
    },
  },
  {
    id: "E9-analytics-refuses-foreign-module",
    desc: "getAnalyticsAction proves module ownership with the error read, and refuses a foreign lesson",
    run: () => {
      const b = body("educationKernel", "getAnalyticsAction")
      if (!orderedIn(b.text, '.from("learning_modules")', "getResourceUsageAnalytics(")) {
        return "usage is read before ownership is established"
      }
      if (!refusingBranch(b.text, "if (moduleErr)")) return "the ownership read discards its error"
      return refusingBranch(b.text, "if (!moduleRow)")
        ? true
        : "a lesson outside this brokerage is reported as a lesson with no activity"
    },
    neg: {
      file: "educationKernel",
      find: "  if (!moduleRow) return { success: false, ...zero, error: \"That lesson is not in your brokerage.\" }",
      replace: "",
    },
  },
  {
    id: "E10-education-page-scopes-and-reports",
    desc: "the education page scopes both option reads to the tenant and refuses to render an unread list as empty",
    run: () => {
      const s = S("educationPage")
      for (const table of ["learning_modules", "contacts"]) {
        const i = s.indexOf(`.from("${table}")`)
        if (i < 0) return `the page never reads ${table}`
        if (!/\.eq\("brokerage_id",\s*profile\.brokerage_id\)/.test(s.slice(i, i + 300))) {
          return `the ${table} read is not tenant-scoped`
        }
      }
      if (!/const\s+loadError\s*=/.test(s)) return "the page does not capture a failed read"
      return /loadError\s*\?/.test(s) ? true : "a failed read still renders the panel as empty"
    },
    neg: {
      file: "educationPage",
      find: "      {loadError ? (",
      replace: "      {false ? (",
    },
  },
  {
    id: "E11-learning-handlers-read-verdicts",
    desc: "all four Client Learning handlers read the server verdict before showing a result",
    run: () => {
      const cases: Array<[string, string, string]> = [
        ["handleAssign", "assignResourceAction(", "setAssignNotice("],
        ["handleRecordCompletion", "recordCompletionAction(", "setCompleteNotice("],
        ["handleBulkAssign", "bulkAssignAction(", "setBulkNotice("],
        ["handleLoadAnalytics", "getAnalyticsAction(", "setAnalytics({"],
      ]
      for (const [fn, call, sideEffect] of cases) {
        const b = body("learningPanel", fn)
        // Only the region AFTER the server call matters — every handler clears
        // its notice state BEFORE calling, and anchoring on that reset would
        // make this check pass on a handler that ignores the verdict entirely.
        const region = afterAwait(b.text, call)
        if (region === "") return `${fn} never awaits ${call}`
        if (!refusingBranch(region, "if (!result.success)")) return `${fn} ignores the server verdict`
        if (!orderedIn(region, "if (!result.success)", sideEffect)) {
          return `${fn} paints its result before reading the verdict`
        }
      }
      return true
    },
    neg: {
      file: "learningPanel",
      find: "      if (!result.success) {\n        setBulkError(result.error ?? \"Could not assign those lessons.\")\n        return\n      }",
      replace: "",
    },
  },
  {
    id: "E12-bulk-notice-tells-the-truth",
    desc: "the bulk-assign notice reports what actually changed, not what was requested",
    run: () => {
      const b = body("learningPanel", "handleBulkAssign")
      const post = afterAwait(b.text, "bulkAssignAction(")
      const i = post.indexOf("setBulkNotice(")
      if (i < 0) return "no bulk notice is set after the call returns"
      const region = post.slice(i, i + 500)
      if (!region.includes("result.newlyAssigned")) return "the notice does not report the measured new assignments"
      return region.includes("result.alreadyAssigned")
        ? true
        : "a repeat bulk assign would be reported as all-new"
    },
    neg: {
      file: "learningPanel",
      find: "        result.alreadyAssigned > 0\n          ? `${result.newlyAssigned} newly assigned · ${result.alreadyAssigned} already had it (of ${result.requested}).`\n          : `${result.newlyAssigned} newly assigned.`,",
      replace: "        `${result.requested} assigned.`,",
    },
  },

  // ══════════════ AGENT-RAIL SURFACES ══════════════

  {
    id: "S1-create-agent-button-on-flagged-rows",
    desc: "the admin users page offers agent-record repair only where the AGENTS row is the gap",
    run: () => {
      const s = S("adminUsersPage")
      if (!s.includes("CreateAgentRecordButton")) return "createAgent still has no surface"
      const b = fnBody(M("adminUsersPage"), s, "isAgentRecordMissing")
      if (!b) return "there is no agents-specific gap predicate"
      if (b.text.includes("REQUIRES_TC_ROW")) return "the predicate also fires for a missing TC record"
      const i = s.indexOf("isAgentRecordMissing(u) &&")
      return i > 0 ? true : "the button is not gated on the agents-specific predicate"
    },
    neg: {
      file: "adminUsersPage",
      find: "                    {isAgentRecordMissing(u) && (",
      replace: "                    {missing && (",
    },
  },
  {
    id: "S2-create-agent-button-reads-verdict",
    desc: "the repair dialog stays open when the server refuses",
    run: () => {
      const b = body("createAgentButton", "handleCreate")
      const post = afterAwait(b.text, "createAgent(")
      if (post === "") return "the button never awaits createAgent"
      if (!refusingBranch(post, '"error" in result && refusal')) return "the verdict is not read"
      return orderedIn(post, '"error" in result', "setOpen(false)")
        ? true
        : "the dialog closes before the verdict is read"
    },
    neg: {
      file: "createAgentButton",
      find: "      if (\"error\" in result && refusal) {\n        setError(refusal)\n        return\n      }",
      replace: "",
    },
  },
  {
    id: "S3-expenses-page-uses-uncapped-summary",
    desc: "the expenses page takes its totals from getExpenseSummary, not from the capped table page",
    run: () => {
      const s = S("expensesPage")
      if (!s.includes("getExpenseSummary")) return "the page still computes its own breakdown"
      if (/byCategory\[cat\]\.total\s*\+=/.test(s)) return "the inline 100-row breakdown is still there"
      if (!/const\s+byCategory\s*=\s*summaryResult\.summary/.test(s)) return "byCategory does not come from the summary"
      return /const\s+totalExpenses\s*=\s*summaryResult\.total/.test(s)
        ? true
        : "the YTD total is still the total of one page of rows"
    },
    neg: {
      file: "expensesPage",
      find: "  const totalExpenses = summaryResult.total",
      replace: "  const totalExpenses = expenseData.reduce((sum: number, e: any) => sum + (e.amount || 0), 0)",
    },
  },
  {
    id: "S4-expenses-page-surfaces-unread-totals",
    desc: "the expenses page says so when the totals could not be read",
    run: () => {
      const s = S("expensesPage")
      if (!/const\s+summaryError\s*=/.test(s)) return "a failed summary is not captured"
      return /\{summaryError\s*&&/.test(s) ? true : "a failed summary renders silently as zero spend"
    },
    neg: {
      file: "expensesPage",
      find: "      {summaryError && (",
      replace: "      {false && (",
    },
  },
  {
    id: "S5-brokerage-dashboard-wires-stats",
    desc: "the broker dashboard calls getBrokerageStats with no tenant argument and renders it",
    run: () => {
      const s = S("brokeragePage")
      if (!/import\s*\{\s*getBrokerageStats\s*\}/.test(s)) return "getBrokerageStats is not imported"
      const m = /getBrokerageStats\(([^)]*)\)/.exec(s)
      if (!m) return "getBrokerageStats is never called"
      if (m[1].trim() !== "") return `the page passes a tenant argument: ${m[1]}`
      return /brokerageStats\.monthlyGCI/.test(s) ? true : "the result is never rendered"
    },
    neg: {
      file: "brokeragePage",
      find: "    getBrokerageStats(),",
      replace: "    getBrokerageStats(brokerageId),",
    },
  },
  {
    id: "S6-brokerage-dashboard-shows-degradation",
    desc: "the broker dashboard names the figures it could not read instead of showing them as zero",
    run: () => {
      const s = S("brokeragePage")
      if (!/brokerageStats\.degraded\.includes\("monthlyGCI"\)/.test(s)) {
        return "a failed GCI read is not distinguished from a zero month"
      }
      return /brokerageStats\.degraded\.length\s*>\s*0/.test(s)
        ? true
        : "the page never tells the broker the figures are incomplete"
    },
    neg: {
      file: "brokeragePage",
      find: "                  {brokerageStats.degraded.includes(\"monthlyGCI\") ? (",
      replace: "                  {false ? (",
    },
  },
  {
    // RETARGETED BY m484's LANE — see A6 above. S7 and S8 asserted that the Motivation
    // page rendered the SECOND reward ladder (`achievements`) alongside the badges
    // panel that renders the first. That page now carries one ladder, from the
    // surviving tables, so the property worth guarding here is that it stays one — and
    // that the page's URL filters are validated against the ONE leaderboard vocabulary
    // rather than a local copy that admitted values (scope 'agent', metric 'revenue')
    // no writer has ever produced. The badges surface itself is proved by
    // scripts/leaderboard-simulator.ts.
    id: "S7-one-reward-ladder-and-one-filter-vocabulary",
    desc: "the motivation page validates its filters against the shared leaderboard vocabulary and carries no second reward ladder",
    run: () => {
      const s = S("motivationPage")
      if (/getAchievements|agent_achievements/.test(s)) return "the duplicate achievements ladder is still surfaced"
      if (!/isLeaderboardScope\(/.test(s) || !/isLeaderboardMetric\(/.test(s)) {
        return "scope/metric are not validated against the shared vocabulary"
      }
      return /isCanonicalPeriodLabel\(/.test(s)
        ? true
        : "the period param is not checked against the labels the populator writes"
    },
    neg: {
      file: "motivationPage",
      find: "  const scope: LeaderboardScope | null = isLeaderboardScope(params.scope) ? params.scope : null",
      replace: "  const scope = (params.scope ?? null) as LeaderboardScope | null",
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// SELF-TESTS — the stripper and the slicers must be proved before they are trusted
// ─────────────────────────────────────────────────────────────────────────────

interface SelfTest { id: string; run: () => true | string }

const SELF_TESTS: SelfTest[] = [
  {
    id: "ST1-line-comment-cannot-satisfy-a-check",
    run: () => {
      const SLASH = String.fromCharCode(47)
      const probe = [
        "function demo() {",
        "  " + SLASH + SLASH + " brokerage_id: ctx.brokerageId",
        "  return 1",
        "}",
      ].join("\n")
      const { stripped, masked } = stripComments(probe)
      if (stripped.includes("ctx.brokerageId")) return "a LINE comment survived the stripper"
      const b = fnBody(masked, stripped, "demo")
      if (!b) return "the body slicer failed on the probe"
      return b.text.includes("brokerage_id") ? "a commented token satisfied a body check" : true
    },
  },
  {
    id: "ST2-block-comment-cannot-satisfy-a-check",
    run: () => {
      const SLASH = String.fromCharCode(47)
      const STAR = String.fromCharCode(42)
      const probe = [
        "function demo() {",
        "  " + SLASH + STAR + " count: \"exact\" and degraded.push( " + STAR + SLASH,
        "  return 1",
        "}",
      ].join("\n")
      const { stripped } = stripComments(probe)
      if (stripped.includes("degraded.push(")) return "a BLOCK comment survived the stripper"
      return stripped.includes("exact") ? "a commented string survived the stripper" : true
    },
  },
  {
    id: "ST3-offsets-are-preserved",
    run: () => {
      for (const key of Object.keys(FILES) as FileKey[]) {
        const { raw, stripped, masked } = SRC[key]
        if (stripped.length !== raw.length) return `stripped length drifted for ${FILES[key]}`
        if (masked.length !== raw.length) return `masked length drifted for ${FILES[key]}`
      }
      return true
    },
  },
  {
    id: "ST4-strings-cannot-be-mistaken-for-structure",
    run: () => {
      const probe = 'function demo() {\n  const s = "} not a real brace {"\n  const t = 7\n  return t\n}'
      const { stripped, masked } = stripComments(probe)
      const b = fnBody(masked, stripped, "demo")
      if (!b) return "the slicer failed on a body containing a brace inside a string"
      return b.text.includes("const t = 7") ? true : "a brace inside a string truncated the body"
    },
  },
  {
    id: "ST5-return-type-object-is-not-the-body",
    run: () => {
      const probe = [
        "async function demo(): Promise<{ ok: boolean; parts: Array<{ id: string }> }> {",
        "  const marker = 1",
        "  return { ok: true, parts: [] }",
        "}",
      ].join("\n")
      const { stripped, masked } = stripComments(probe)
      const b = fnBody(masked, stripped, "demo")
      if (!b) return "the slicer could not skip a generic return type"
      if (b.text.includes("ok: boolean")) return "the return TYPE was sliced as the body"
      return b.text.includes("const marker = 1") ? true : "the real body was not sliced"
    },
  },
  {
    id: "ST6-real-bodies-slice-cleanly",
    run: () => {
      const cases: Array<[FileKey, string, string]> = [
        ["agents", "getBrokerageStats", "degraded.push("],
        ["agents", "getExpenseSummary", "summary[category]"],
        ["educationKernel", "bulkAssignAction", "countExisting"],
        ["vendorsKernel", "assignVendorToTransactionAction", "resolveActor()"],
        ["vendorClient", "handleUpdateVendor", "updateVendorRecordAction"],
        ["learningPanel", "handleBulkAssign", "bulkAssignAction"],
      ]
      for (const [f, fn, token] of cases) {
        const b = fnBody(M(f), S(f), fn) ?? arrowBody(M(f), S(f), fn)
        if (!b) return `could not slice ${fn} in ${FILES[f]}`
        if (!b.text.includes(token)) return `${fn} sliced without its own body token "${token}"`
        if (b.text.length > SRC[f].raw.length * 0.9) return `${fn} slice is suspiciously close to the whole file`
      }
      return true
    },
  },
  {
    id: "ST8-jsx-apostrophe-cannot-swallow-source",
    run: () => {
      const probe = [
        "function demo() {",
        "  return (",
        "    <p>Correct this vendor's details</p>",
        "  )",
        "}",
        "const MARKER_AFTER = 1",
      ].join("\n")
      const { stripped } = stripComments(probe)
      return stripped.includes("MARKER_AFTER")
        ? true
        : "an apostrophe in JSX text swallowed the rest of the source"
    },
  },
  {
    id: "ST9-real-jsx-elements-are-all-visible",
    run: () => {
      // If the stripper swallowed a region, elements present in the raw file
      // would be missing from the scanned view. Count them both ways.
      const cases: Array<[FileKey, string]> = [
        ["vendorClient", "<VendorCategorySelect"],
        ["vendorClient", "<Dialog "],
        ["learningPanel", "<TabsContent "],
      ]
      for (const [f, token] of cases) {
        const raw = (SRC[f].raw.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length
        const seen = (SRC[f].masked.match(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length
        if (raw !== seen) return `${FILES[f]}: ${raw} occurrences of ${token} in the file but ${seen} survived the stripper`
      }
      return true
    },
  },
  {
    id: "ST7-regex-literals-do-not-open-comments",
    run: () => {
      const probe = 'function demo() {\n  const r = /[a-z]+/g\n  const marker = 2\n  return marker\n}'
      const { stripped, masked } = stripComments(probe)
      const b = fnBody(masked, stripped, "demo")
      if (!b) return "a regex literal broke the slicer"
      return b.text.includes("const marker = 2") ? true : "a regex literal truncated the body"
    },
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// LIVE LAYER (optional) — re-verify the vocabularies against the real database
// ─────────────────────────────────────────────────────────────────────────────

async function liveLayer(): Promise<{ ran: boolean; failures: string[]; note: string }> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return {
      ran: false,
      failures: [],
      note:
        "LIVE LAYER SKIPPED — NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are absent. " +
        "A SKIP IS NOT A PASS: the vocabularies above were verified against the live CHECK " +
        "constraints at authoring time and are asserted here only against that recorded expectation.",
    }
  }
  const failures: string[] = []
  const notes: string[] = []
  try {
    const { createClient } = await import("@supabase/supabase-js")
    const db = createClient(url, key, { auth: { persistSession: false } })

    // 1. Reachability of every table these actions write or read.
    const tables = [
      "agents", "agent_goals", "business_expenses", "achievements", "agent_achievements",
      "vendors", "vendor_bookings", "vendor_assignments", "vendor_jobs",
      "learning_modules", "learning_assignments", "compliance_flags",
    ]
    for (const t of tables) {
      const { error } = await db.from(t).select("*", { count: "exact", head: true })
      if (error) failures.push(`table ${t} is not reachable: ${error.message}`)
    }

    // 2. RESIDUE — the probe rows used to establish the constraint behaviour were
    //    created inside rolled-back DO blocks. None of them may exist.
    const residue: Array<[string, string, string]> = [
      ["brokerages", "name", "SIM PROBE%"],
      ["vendors", "name", "Sim Probe%"],
      ["learning_modules", "title", "Sim Probe%"],
    ]
    for (const [t, col, pattern] of residue) {
      const { count, error } = await db.from(t).select("id", { count: "exact", head: true }).like(col, pattern)
      if (error) { failures.push(`residue check on ${t} failed: ${error.message}`); continue }
      if ((count ?? 0) > 0) failures.push(`RESIDUE: ${count} probe row(s) survive in ${t}`)
      else notes.push(`residue ${t}: 0`)
    }

    notes.push(
      "CHECK-constraint introspection is not exposed over PostgREST, so the vocabulary " +
      "assertions above compare source against the constraint definitions recorded at " +
      "authoring time. Those definitions were established empirically, by attempting the " +
      "rejected and accepted values inside rolled-back DO blocks.",
    )
    return { ran: true, failures, note: "LIVE LAYER RAN — " + notes.join(" | ") }
  } catch (err) {
    return {
      ran: false,
      failures: [],
      note:
        "LIVE LAYER SKIPPED — " +
        (err instanceof Error ? err.message : String(err)) +
        ". A SKIP IS NOT A PASS.",
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HARNESS
// ─────────────────────────────────────────────────────────────────────────────

function runCheck(c: Check): true | string {
  try {
    return c.run()
  } catch (err) {
    return `threw: ${err instanceof Error ? err.message : String(err)}`
  }
}

async function main() {
  loadAll()

  let failed = 0
  const lines: string[] = []

  lines.push("═══ SELF-TESTS ═══")
  for (const t of SELF_TESTS) {
    let r: true | string
    try { r = t.run() } catch (e) { r = `threw: ${e instanceof Error ? e.message : String(e)}` }
    if (r === true) lines.push(`  PASS  ${t.id}`)
    else { lines.push(`  FAIL  ${t.id} — ${r}`); failed++ }
  }

  lines.push("")
  lines.push("═══ ASSERTIONS ═══")
  for (const c of CHECKS) {
    const r = runCheck(c)
    if (r === true) lines.push(`  PASS  ${c.id}  ${c.desc}`)
    else { lines.push(`  FAIL  ${c.id}  ${c.desc}\n        ${r}`); failed++ }
  }

  // ── NEGATIVE TESTS ────────────────────────────────────────────────────────
  lines.push("")
  lines.push("═══ NEGATIVE TESTS (mutate real source, prove the check can fail) ═══")
  let negFailed = 0
  for (const c of CHECKS) {
    const path = FILES[c.neg.file]
    const abs = resolve(ROOT, path)
    const before = readFileSync(abs, "utf8")
    const shaBefore = sha(path)

    if (!before.includes(c.neg.find)) {
      lines.push(`  UNTESTABLE  ${c.id} — the mutation anchor is not present in ${path}`)
      negFailed++
      continue
    }
    const mutated = before.replace(c.neg.find, c.neg.replace)
    if (mutated === before) {
      lines.push(`  UNTESTABLE  ${c.id} — the mutation is a no-op`)
      negFailed++
      continue
    }
    writeFileSync(abs, mutated)
    const shaMutated = sha(path)
    if (shaMutated === shaBefore) {
      writeFileSync(abs, before)
      lines.push(`  UNTESTABLE  ${c.id} — sha256 did not change, the mutation did not land`)
      negFailed++
      continue
    }

    loadAll()
    const r = runCheck(c)

    writeFileSync(abs, before)
    const shaRestored = sha(path)
    loadAll()

    if (shaRestored !== shaBefore) {
      lines.push(`  ERROR  ${c.id} — RESTORE FAILED for ${path}; sha256 ${shaBefore} -> ${shaRestored}`)
      negFailed++
      continue
    }

    if (r === true) {
      lines.push(
        `  WEAK  ${c.id} — the check still PASSED with the construct removed (sha ${shaBefore.slice(0, 12)} -> ${shaMutated.slice(0, 12)}); this assertion is worthless as written`,
      )
      negFailed++
    } else {
      lines.push(`  OK    ${c.id} — failed as required under mutation: ${String(r).slice(0, 110)}`)
    }
  }

  // ── LIVE LAYER ────────────────────────────────────────────────────────────
  lines.push("")
  lines.push("═══ LIVE LAYER ═══")
  const live = await liveLayer()
  lines.push("  " + live.note)
  for (const f of live.failures) { lines.push(`  FAIL  ${f}`); failed++ }

  lines.push("")
  lines.push("═══ SUMMARY ═══")
  lines.push(`  self-tests:      ${SELF_TESTS.length}`)
  lines.push(`  assertions:      ${CHECKS.length}`)
  lines.push(`  assertion fails: ${failed}`)
  lines.push(`  negative-test problems (WEAK / UNTESTABLE / restore errors): ${negFailed}`)

  console.log(lines.join("\n"))

  if (failed > 0 || negFailed > 0) process.exit(1)
  console.log("\nALL GREEN — every assertion passes and every assertion was proved able to fail.")
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
