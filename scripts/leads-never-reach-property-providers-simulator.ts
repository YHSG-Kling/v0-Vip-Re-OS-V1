#!/usr/bin/env tsx
/**
 * scripts/leads-never-reach-property-providers-simulator.ts
 *   (npm run test:leads-never-reach-property-providers)
 * ─────────────────────────────────────────────────────────────────────────────
 * OWNER RULING: "leads not for idx or rentcast, only contacts"
 *
 * Property search through IDX Broker and property valuation through RentCast are
 * CONTACTS-ONLY capabilities. `leads` and `contacts` are different tables holding
 * DISJOINT id spaces, and a row from the first one must never reach either
 * provider — not as a subject, not as a parameter, not through a fallback.
 *
 * This proof exists because the wave before it shipped the opposite. Three
 * functions were handed an IDX client whose identity parameter resolved against
 * the pre-conversion table, one passed that table's id into a parameter named
 * `contactId`, and in every case THE CLIENT WAS CONSTRUCTED BEFORE THE LOOKUP —
 * so the decision to spend was made with the resource already in hand. Ordering
 * is not an incidental detail here; it is the shape of the defect, so it is
 * asserted as ORDER, by source position.
 *
 * FIVE PROPERTIES. Every one is a CONSTRUCT, not a spelling: renaming a helper,
 * a local or a surface keeps them green, and reintroducing the defect does not.
 *
 *  1. THE RULING, STATED MECHANICALLY. No function in the three action files
 *     that constructs an IDX client or calls a RentCast export also contains a
 *     read of the pre-conversion table. And the transitive half: a function that
 *     reads that table AND reaches a provider through an in-file call must have
 *     resolved the contacts table FIRST — before both the read and the call.
 *     That second half is what keeps the one legitimate mixed-lane function
 *     (enrichLeadData, which resolves contacts, throws, and only then does
 *     anything else) from being a loophole other functions can copy.
 *
 *  2. NO PRE-CONVERSION id REACHES A `contactId` PARAMETER. Asserted on the CALL
 *     SHAPE: every `contactId:` property in ai-predictions.ts is checked against
 *     the set of locals that derive — transitively, through assignments, filters,
 *     maps and for-of bindings — from a read of the pre-conversion table. A
 *     `<row>.id` from that set reaching `contactId:` is exactly the wave-17
 *     defect and fails. The promotion pointer (`<row>.contact_id`) is a different
 *     column and is allowed, but only where property 2b holds.
 *
 *  2b. AND THE PROMOTION POINTER IS RESOLVED, NOT TRUSTED. In massGenerateCMAs
 *     the value handed to `contactId:` comes from the `contact_id` column, and a
 *     contacts read sits between the pre-conversion read and the call, with a
 *     skip in between — so a dangling or absent promotion is passed over rather
 *     than spent against.
 *
 *  3. ORDER: THE PROVIDER IS REACHED AFTER THE DETERMINATION, NEVER BEFORE. For
 *     each site that carries an identity, the contacts read must appear earlier
 *     in the function body than the provider. The provider position is DERIVED,
 *     not spelled: it is the earlier of a direct client construction and the
 *     first call to an in-file function that itself touches a provider. And
 *     predictWinningOffer — whose identity parameter was provably inert — must
 *     carry no identity parameter at all, because an inert one reads like
 *     authorization.
 *
 *  4. THE MODEL SURVIVES. `enrichLeadData` resolves against contacts and REFUSES
 *     before anything downstream runs. It is the one correctly ordered entry
 *     point this wave copied, and it must not regress into the shape it was
 *     copied out of.
 *
 *  5. NO CONTACTS-PROVEN id IS FILED IN THE OTHER CLASS'S FOREIGN KEY.
 *     lead-intelligence.ts proves its subject is a contact at its entry point,
 *     so it must not insert into lead_idx_property_interactions, whose `lead_id`
 *     is `REFERENCES leads(id)` and which has no contacts-keyed column at all.
 *     There is no correct column to move that write to, so there is no write.
 *
 *  6. THE WITHDRAWN AFFORDANCE STAYS WITHDRAWN. app/leads/page.tsx does not call
 *     the contacts-only action. A button that reliably errors is worse than no
 *     button, and the screen explains the withdrawal instead of performing it.
 *
 * HOW IT IS BUILT
 *   · Every structural assertion reads COMMENT-STRIPPED source. It has to: these
 *     files quote the identifiers being asserted on in their own prose — the
 *     leads page names the action it deliberately no longer calls, and
 *     lead-intelligence.ts names the table it deliberately no longer writes — so
 *     an unstripped scan would be satisfied, or defeated, by comments alone.
 *   · Every assertion carries NEGATIVE CONTROLS. The defect is written back into
 *     the real file, the mutation is VERIFIED TO HAVE APPLIED (a find string
 *     that no longer matches is theatre and is scored as a failure), the
 *     assertion is required to flip RED, and the file is restored and re-verified
 *     by sha256.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { createHash } from "node:crypto"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const F = {
  predictions: "app/actions/ai-predictions.ts",
  cma: "app/actions/ai-cma.ts",
  leadIntel: "app/actions/lead-intelligence.ts",
  leadsPage: "app/leads/page.tsx",
}
const ACTION_FILES = [F.predictions, F.cma, F.leadIntel]

/** The pre-conversion table, named once. Never spelled inside a comment in the
 *  files under test — scripts/tenant-scope-guard.ts scans RAW source. */
const PRE_CONVERSION = "leads"
const CONTACTS = "contacts"
/** The module that IS RentCast, as the action files reach it. */
const RENTCAST_MODULE = "@/lib/property/rentcast"
/** The IDX client class. */
const IDX_KLASS = "IDXBrokerClient"
/** The table whose only key is the other class's foreign key. */
const LEADS_FK_TABLE = "lead_idx_property_interactions"

// ─────────────────────────────────────────────────────────────────────────────
// Source access — read FRESH every time; the negative layer rewrites these files
// ─────────────────────────────────────────────────────────────────────────────
const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")

/**
 * Comment-stripped source. String literals are PRESERVED: a `//` inside a quoted
 * string is not a comment, and collapsing one would delete real code — including
 * the `.from("…")` selectors and module specifiers every assertion here reads.
 */
function strip(src: string): string {
  let out = ""
  let i = 0
  type Mode = "code" | "line" | "block" | "s" | "d" | "t"
  let mode: Mode = "code"
  while (i < src.length) {
    const c = src[i]
    const n = src[i + 1]
    if (mode === "code") {
      if (c === "/" && n === "/") { mode = "line"; i += 2; continue }
      if (c === "/" && n === "*") { mode = "block"; i += 2; continue }
      if (c === "'") mode = "s"
      else if (c === '"') mode = "d"
      else if (c === "`") mode = "t"
      out += c; i++; continue
    }
    if (mode === "line") { if (c === "\n") { mode = "code"; out += c }; i++; continue }
    if (mode === "block") { if (c === "*" && n === "/") { mode = "code"; i += 2 } else { if (c === "\n") out += c; i++ }; continue }
    if (c === "\\") { out += c + (n ?? ""); i += 2; continue }
    if ((mode === "s" && c === "'") || (mode === "d" && c === '"') || (mode === "t" && c === "`")) mode = "code"
    out += c; i++
  }
  return out
}

const code = (p: string) => strip(raw(p))

// ─────────────────────────────────────────────────────────────────────────────
// Structural helpers
// ─────────────────────────────────────────────────────────────────────────────
function matchDelim(src: string, open: number, o: string, c: string): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++
    else if (src[i] === c) { depth--; if (depth === 0) return i }
  }
  return -1
}
const matchBrace = (s: string, i: number) => matchDelim(s, i, "{", "}")
const matchParen = (s: string, i: number) => matchDelim(s, i, "(", ")")

/**
 * The `{` that opens a body, given the index just past the parameter list. A
 * RETURN-TYPE ANNOTATION may itself contain braces — `Promise<{ synced: boolean }>`
 * is exactly the shape syncIDXBrokerActivity carries — so the first `{` is not
 * necessarily the body. Angle depth is tracked and `=>` is not read as a closer.
 */
function bodyBraceAfter(src: string, from: number): number {
  let angle = 0
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (c === "<") { angle++; continue }
    if (c === ">") { if (src[i - 1] !== "=" && angle > 0) angle--; continue }
    if (c === "{" && angle === 0) return i
    if (c === ";" && angle === 0) return -1
  }
  return -1
}

interface Fn { name: string; params: string; body: string; exported: boolean; at: number }

/** Every top-level `function <name>(...) { … }` in a module, with its params. */
function functions(src: string): Fn[] {
  const out: Fn[] = []
  for (const m of src.matchAll(/(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)) {
    const openParen = src.indexOf("(", m.index! + m[0].length - 1)
    const closeParen = matchParen(src, openParen)
    if (closeParen === -1) continue
    const openBrace = bodyBraceAfter(src, closeParen + 1)
    if (openBrace === -1) continue
    const closeBrace = matchBrace(src, openBrace)
    if (closeBrace === -1) continue
    out.push({
      name: m[2],
      params: src.slice(openParen + 1, closeParen),
      body: src.slice(openBrace + 1, closeBrace),
      exported: !!m[1],
      at: m.index!,
    })
  }
  return out
}

function findFn(src: string, name: string): Fn | null {
  return functions(src).find((f) => f.name === name) ?? null
}

/** Split a comma-separated list at depth 0. */
function splitTop(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ""
  for (const ch of text) {
    if ("([{<".includes(ch)) depth++
    else if (")]}>".includes(ch)) depth--
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out
}

/** Identifier roots appearing in an expression, minus keywords and property names. */
const KEYWORDS = new Set([
  "await", "const", "let", "var", "new", "return", "if", "else", "for", "of", "in",
  "async", "function", "true", "false", "null", "undefined", "typeof", "as", "string",
  "number", "boolean", "this", "throw", "try", "catch", "case", "switch", "while",
  "break", "continue", "default", "delete", "instanceof", "void", "yield", "Set", "Map",
])
function idRoots(expr: string): string[] {
  const out: string[] = []
  for (const m of expr.matchAll(/(^|[^\w$.'"`])([A-Za-z_$][\w$]*)/g)) {
    const id = m[2]
    if (KEYWORDS.has(id)) continue
    out.push(id)
  }
  return [...new Set(out)]
}

/**
 * The name a supabase read binds its ROW to — `const { data: routeContact } = …`
 * binds `routeContact`, not `data`. Assertions that want to prove a gate REFUSES
 * need this: "there is a throw somewhere below" is satisfied by the refused-query
 * branch, which is a different fact from "no such row".
 */
function rowBindingOf(body: string, at: number): string | null {
  const lineStart = body.lastIndexOf("\n", at) + 1
  const head = body.slice(Math.max(0, lineStart - 400), at + 200)
  const m = /data\s*:\s*([A-Za-z_$][\w$]*)/g
  let last: string | null = null
  for (const hit of head.matchAll(m)) last = hit[1]
  return last
}

/**
 * Does the window carry a refusal on the ABSENCE of `binding` — `if (!row)` and
 * then a throw or a return? A gate that only refuses when the QUERY was refused
 * is not this: supabase-js resolves a refused query, so the two branches are
 * different facts and only one of them means "not a contact".
 */
function refusesOnAbsence(window: string, binding: string): boolean {
  const re = new RegExp(`if\\s*\\(\\s*!\\s*${binding}\\s*\\)\\s*\\{?[\\s\\S]{0,500}?(throw|return)\\b`)
  return re.test(window)
}

/** `if (<cond>) { … continue }` guards inside a window, with their conditions. */
function continueGuards(window: string): string[] {
  const out: string[] = []
  for (const m of window.matchAll(/if\s*\(/g)) {
    const open = window.indexOf("(", m.index!)
    const close = matchParen(window, open)
    if (close === -1) continue
    const braceAt = window.indexOf("{", close)
    if (braceAt === -1) continue
    // Only treat it as a block guard if the brace follows immediately.
    if (window.slice(close + 1, braceAt).trim() !== "") continue
    const end = matchBrace(window, braceAt)
    if (end === -1) continue
    if (/\bcontinue\b/.test(window.slice(braceAt, end))) out.push(window.slice(open + 1, close))
  }
  return out
}

/** Position of the first occurrence of any needle, or -1. */
function firstIndexOfAny(body: string, needles: string[]): number {
  let best = -1
  for (const n of needles) {
    const i = body.indexOf(n)
    if (i !== -1 && (best === -1 || i < best)) best = i
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider detection — what "touches a provider" means, mechanically
// ─────────────────────────────────────────────────────────────────────────────

/** Names bound at module level from the RentCast module (`import { … } from …`). */
function rentcastStaticNames(src: string): string[] {
  const out: string[] = []
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (m[2] !== RENTCAST_MODULE) continue
    for (const entry of splitTop(m[1])) {
      const parts = entry.trim().split(/\s+as\s+/)
      const bound = (parts[1] ?? parts[0]).trim()
      if (bound) out.push(bound)
    }
  }
  return out
}

/**
 * Does this function body reach RentCast? Either it names the module directly
 * (the dynamic-import shape ai-cma.ts uses) or it CALLS a name the module bound
 * at file level. Both are the module specifier, not a spelling of a function.
 */
function touchesRentcast(body: string, staticNames: string[]): boolean {
  if (body.includes(RENTCAST_MODULE)) return true
  return staticNames.some((n) => new RegExp(`\\b${n}\\s*\\(`).test(body))
}

/** Does this function body obtain an IDX client of its own? */
function touchesIdx(body: string): boolean {
  return new RegExp(`\\b${IDX_KLASS}\\b`).test(body)
}

/** A read of the pre-conversion table. */
const preConversionRead = (body: string) => body.includes(`.from("${PRE_CONVERSION}")`)
const contactsRead = (body: string) => body.includes(`.from("${CONTACTS}")`)

interface FileModel {
  file: string
  src: string
  fns: Fn[]
  /** functions that reach a provider IN THEIR OWN BODY */
  direct: Set<string>
  /** direct ∪ every in-file function that calls one of them (transitively) */
  reaching: Set<string>
}

function model(file: string): FileModel {
  const src = code(file)
  const fns = functions(src)
  const staticNames = rentcastStaticNames(src)
  const direct = new Set<string>()
  for (const f of fns) {
    if (touchesIdx(f.body) || touchesRentcast(f.body, staticNames)) direct.add(f.name)
  }
  const reaching = new Set(direct)
  // In-file transitive closure: who CALLS a provider-touching function.
  for (let pass = 0; pass < fns.length; pass++) {
    let grew = false
    for (const f of fns) {
      if (reaching.has(f.name)) continue
      for (const target of reaching) {
        if (target === f.name) continue
        if (new RegExp(`\\b${target}\\s*\\(`).test(f.body)) { reaching.add(f.name); grew = true; break }
      }
    }
    if (!grew) break
  }
  return { file, src, fns, direct, reaching }
}

/**
 * The position at which a function reaches a provider: the earlier of a direct
 * marker in its own body and the first call to an in-file function that itself
 * touches one. DERIVED, so renaming the helper does not weaken the check.
 */
function providerPosition(m: FileModel, fn: Fn): number {
  const staticNames = rentcastStaticNames(m.src)
  const markers: string[] = []
  if (touchesIdx(fn.body)) markers.push(IDX_KLASS)
  if (fn.body.includes(RENTCAST_MODULE)) markers.push(RENTCAST_MODULE)
  for (const n of staticNames) {
    const at = fn.body.search(new RegExp(`\\b${n}\\s*\\(`))
    if (at !== -1) markers.push(fn.body.slice(at, at + n.length))
  }
  let best = firstIndexOfAny(fn.body, markers)
  for (const target of m.direct) {
    if (target === fn.name) continue
    const at = fn.body.search(new RegExp(`\\b${target}\\s*\\(`))
    if (at !== -1 && (best === -1 || at < best)) best = at
  }
  return best
}

// ─────────────────────────────────────────────────────────────────────────────
// Dataflow: which locals derive from a read of the pre-conversion table
// ─────────────────────────────────────────────────────────────────────────────

/** Names bound by a destructuring pattern (`{ data: x }` binds `x`, not `data`). */
function bindingNames(pattern: string): string[] {
  const inner = pattern.replace(/^[{[]/, "").replace(/[}\]]$/, "")
  const out: string[] = []
  for (const entry of splitTop(inner)) {
    let t = entry.trim()
    if (!t) continue
    t = t.split("=")[0].trim()
    const colon = topLevelColon(t)
    const target = colon === -1 ? t : t.slice(colon + 1).trim()
    if (target.startsWith("{") || target.startsWith("[")) { out.push(...bindingNames(target)); continue }
    const id = /^\.{0,3}\s*([A-Za-z_$][\w$]*)/.exec(target)
    if (id) out.push(id[1])
  }
  return out
}

function topLevelColon(text: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if ("([{<".includes(ch)) depth++
    else if (")]}>".includes(ch)) depth--
    else if (ch === ":" && depth === 0) return i
  }
  return -1
}

/** The rest of a statement from `from` — a supabase chain spans many lines. */
function statementFrom(body: string, from: number): string {
  let depth = 0
  let out = ""
  const lines = body.slice(from).split("\n")
  for (let i = 0; i < lines.length && i < 20; i++) {
    const line = lines[i]
    out += (i === 0 ? "" : "\n") + line
    for (const ch of line) {
      if ("([{".includes(ch)) depth++
      else if (")]}".includes(ch)) depth--
    }
    if (depth > 0) continue
    const next = (lines[i + 1] ?? "").trim()
    if (/^[.?)\]},]/.test(next)) continue
    break
  }
  return out
}

/**
 * Locals in a function body that derive from a read of the pre-conversion table.
 * Seeded by the bindings of any statement containing that read, then grown
 * through plain assignments and for-of bindings until it stops changing. This is
 * what makes assertion 2 a check on the CALL SHAPE rather than on a variable
 * called `lead`.
 */
function preConversionDerived(body: string): Set<string> {
  const derived = new Set<string>()
  const needle = `.from("${PRE_CONVERSION}")`
  let at = body.indexOf(needle)
  while (at !== -1) {
    // Walk back to the start of the statement that contains the read.
    let start = body.lastIndexOf("\n", at)
    for (let guard = 0; guard < 20 && start > 0; guard++) {
      const lineStart = body.lastIndexOf("\n", start - 1) + 1
      const line = body.slice(lineStart, start)
      if (/(^|[^\w$])(const|let|var)\s/.test(line) || /=\s*$/.test(line.trim())) { start = lineStart; break }
      if (line.trim() === "") break
      start = lineStart - 1
      if (start < 0) { start = 0; break }
    }
    const stmt = statementFrom(body, Math.max(0, start))
    const decl = /(?:const|let|var)\s+(\{[\s\S]*?\}|\[[\s\S]*?\]|[A-Za-z_$][\w$]*)\s*=/.exec(stmt)
    if (decl) {
      const target = decl[1].trim()
      if (target.startsWith("{") || target.startsWith("[")) for (const n of bindingNames(target)) derived.add(n)
      else derived.add(target)
    }
    at = body.indexOf(needle, at + 1)
  }

  // Grow: any declaration or for-of whose right-hand side leans on a derived name.
  for (let pass = 0; pass < 8; pass++) {
    let grew = false
    for (const m of body.matchAll(/(?:const|let|var)\s+(\{[\s\S]{0,200}?\}|\[[\s\S]{0,200}?\]|[A-Za-z_$][\w$]*)\s*=\s*([^\n;]{0,400})/g)) {
      const rhsRoots = idRoots(m[2])
      if (!rhsRoots.some((r) => derived.has(r))) continue
      const target = m[1].trim()
      const names = target.startsWith("{") || target.startsWith("[") ? bindingNames(target) : [target]
      for (const n of names) if (!derived.has(n)) { derived.add(n); grew = true }
    }
    for (const m of body.matchAll(/for\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s+of\s+([^)]{0,200})\)/g)) {
      if (!idRoots(m[2]).some((r) => derived.has(r))) continue
      if (!derived.has(m[1])) { derived.add(m[1]); grew = true }
    }
    if (!grew) break
  }
  return derived
}

/** Every `contactId:` object property in a body, with its value expression. */
function contactIdProperties(body: string): Array<{ value: string; at: number }> {
  const out: Array<{ value: string; at: number }> = []
  for (const m of body.matchAll(/(^|[^\w$.])contactId\s*:\s*/g)) {
    const start = m.index! + m[0].length
    let depth = 0
    let value = ""
    for (let i = start; i < body.length; i++) {
      const ch = body[i]
      if ("([{".includes(ch)) depth++
      else if (")]}".includes(ch)) { if (depth === 0) break; depth-- }
      if ((ch === "," || ch === "\n") && depth === 0) break
      value += ch
    }
    out.push({ value: value.trim(), at: start })
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Assertion harness
// ─────────────────────────────────────────────────────────────────────────────
type Outcome = { ok: boolean; detail?: string }
interface Assertion {
  id: string
  what: string
  run: () => Outcome
  breaks: Array<{ file: string; find: string; replace: string }>
}
const A: Assertion[] = []

// ═════════════════════════════════════════════════════════════════════════════
// 1 — THE RULING, STATED MECHANICALLY
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "ruling.no-provider-function-reads-the-pre-conversion-table",
  what:
    "no function in the three action files that constructs an IDX client or calls a RentCast export also reads the pre-conversion table. That single sentence IS the owner ruling — the subject of a property search or a valuation is resolved in ONE table, and it is not that one",
  run: () => {
    const problems: string[] = []
    const trail: string[] = []
    let providerFns = 0
    for (const file of ACTION_FILES) {
      const m = model(file)
      for (const fn of m.fns) {
        if (!m.direct.has(fn.name)) continue
        providerFns++
        if (preConversionRead(fn.body)) {
          problems.push(`${file}:${fn.name} reaches a property provider AND reads the pre-conversion table`)
        } else {
          trail.push(fn.name)
        }
      }
    }
    if (providerFns === 0) return { ok: false, detail: "no provider-touching function found at all — this proof is aimed at the wrong shape" }
    return problems.length === 0
      ? { ok: true, detail: `${providerFns} provider-touching function(s), none of them read it: ${trail.join(", ")}` }
      : { ok: false, detail: problems.join(" | ") }
  },
  breaks: [
    {
      // optimizeShowingRoute builds its own client, so it is in this set: give it
      // back the read of the other table.
      file: F.predictions,
      find: `  const { data: { user: routeCaller } } = await supabase.auth.getUser()`,
      replace:
        `  const { data: legacyRow } = await supabase.from("${PRE_CONVERSION}").select("id").eq("id", data.contactId).maybeSingle()\n` +
        `  void legacyRow\n` +
        `  const { data: { user: routeCaller } } = await supabase.auth.getUser()`,
    },
    {
      // The RentCast side of the ruling, on the function that actually spends.
      file: F.cma,
      find: `  const { getRentcastComps } = await import("@/lib/property/rentcast")`,
      replace:
        `  const probe = await (await createClient()).from("${PRE_CONVERSION}").select("id").limit(1)\n` +
        `  void probe\n` +
        `  const { getRentcastComps } = await import("@/lib/property/rentcast")`,
    },
    {
      // The IDX enrichment path in the third file.
      file: F.leadIntel,
      find: `  const idx = await IDXBrokerClient.forBrokerage(ownerBrokerageId)`,
      replace:
        `  const svc = createServiceClient()\n` +
        `  const { data: legacyRow } = await svc.from("${PRE_CONVERSION}").select("id").eq("id", leadId).maybeSingle()\n` +
        `  void legacyRow\n` +
        `  const idx = await IDXBrokerClient.forBrokerage(ownerBrokerageId)`,
    },
  ],
})

A.push({
  id: "ruling.a-mixed-lane-caller-resolves-contacts-before-anything-else",
  what:
    "the transitive half. A function that reads the pre-conversion table AND reaches a provider through an in-file call must resolve the contacts table BEFORE both — first the contacts read, then the provider, then anything else. Without this the direct check above has an obvious loophole: move the read one function up the call chain and the ruling is silently back to being optional",
  run: () => {
    const problems: string[] = []
    const trail: string[] = []
    let checked = 0
    for (const file of ACTION_FILES) {
      const m = model(file)
      for (const fn of m.fns) {
        if (m.direct.has(fn.name)) continue        // covered by the direct assertion
        if (!m.reaching.has(fn.name)) continue     // never reaches a provider
        if (!preConversionRead(fn.body)) continue  // nothing to order
        checked++
        const cIdx = fn.body.indexOf(`.from("${CONTACTS}")`)
        const lIdx = fn.body.indexOf(`.from("${PRE_CONVERSION}")`)
        const pIdx = providerPosition(m, fn)
        if (cIdx === -1) { problems.push(`${file}:${fn.name} reaches a provider and reads the pre-conversion table, and never resolves contacts at all`); continue }
        if (cIdx > lIdx) { problems.push(`${file}:${fn.name} reads the pre-conversion table at ${lIdx} BEFORE resolving contacts at ${cIdx}`); continue }
        if (pIdx !== -1 && cIdx > pIdx) { problems.push(`${file}:${fn.name} reaches its provider at ${pIdx} BEFORE resolving contacts at ${cIdx}`); continue }
        trail.push(`${fn.name} (contacts@${cIdx} → provider@${pIdx} → other@${lIdx})`)
      }
    }
    if (checked === 0) return { ok: false, detail: "no mixed-lane caller found — the assertion has nothing to stand on, which means the shape it guards has moved" }
    return problems.length === 0
      ? { ok: true, detail: trail.join(" | ") }
      : { ok: false, detail: problems.join(" | ") }
  },
  breaks: [
    {
      // enrichLeadData reads the other table BEFORE it resolves contacts.
      file: F.leadIntel,
      find: `  const { data: lead } = await supabase.from("contacts").select("*").eq("id", leadId).single()`,
      replace:
        `  const { data: preRow } = await supabase.from("${PRE_CONVERSION}").select("id").eq("id", leadId).maybeSingle()\n` +
        `  void preRow\n` +
        `  const { data: lead } = await supabase.from("contacts").select("*").eq("id", leadId).single()`,
    },
    {
      // The wave-17 shape restored at the entry point that reaches IDX through
      // the file-local resolver: the other table answers FIRST, contacts second.
      file: F.predictions,
      find: `export async function aiPropertyMatchGenius(contactId: string) {
  const supabase = await createClient()
`,
      replace: `export async function aiPropertyMatchGenius(contactId: string) {
  const supabase = await createClient()
  const { data: legacyRow } = await supabase.from("${PRE_CONVERSION}").select("*").eq("id", contactId).maybeSingle()
  void legacyRow
`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 — NO PRE-CONVERSION id REACHES A `contactId` PARAMETER
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "idclass.no-pre-conversion-row-id-is-passed-as-contactId",
  what:
    "asserted on the CALL SHAPE, not on a name: locals that derive — through assignments, filters, maps and for-of bindings — from a read of the pre-conversion table are computed per function, and no `<derivedRow>.id` may appear as the value of a `contactId:` property. That exact expression is the wave-17 defect: an id from one space handed to a parameter named for the other, spent against RentCast and then written to a NOT NULL column whose own comment says it must be tied to a contact",
  run: () => {
    const problems: string[] = []
    const trail: string[] = []
    let props = 0
    for (const file of ACTION_FILES) {
      const m = model(file)
      for (const fn of m.fns) {
        const derived = preConversionDerived(fn.body)
        if (derived.size === 0) continue
        for (const p of contactIdProperties(fn.body)) {
          props++
          const member = /^([A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/.exec(p.value)
          const rootIsDerived = idRoots(p.value).some((r) => derived.has(r))
          if (!rootIsDerived) { trail.push(`${fn.name}: contactId: ${p.value} (not derived from the other table)`); continue }
          if (member && member[2] === "id") {
            problems.push(`${file}:${fn.name} passes \`${p.value}\` — a row id from the pre-conversion table — into a parameter named contactId`)
            continue
          }
          if (!member || member[2] !== "contact_id") {
            // Indirect: the value is a local. Trace its declaration.
            const declRe = new RegExp(`(?:const|let|var)\\s+${p.value.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}\\s*=\\s*([^\\n;]{0,200})`)
            const decl = declRe.exec(fn.body)
            const rhs = decl?.[1] ?? ""
            if (/(?:\?\.|\.)\s*id\b/.test(rhs) && idRoots(rhs).some((r) => derived.has(r))) {
              problems.push(`${file}:${fn.name} passes \`${p.value}\`, assigned from \`${rhs.trim()}\` — still a row id from the pre-conversion table`)
              continue
            }
            if (!/contact_id/.test(rhs)) {
              problems.push(`${file}:${fn.name} passes \`${p.value}\` (from \`${rhs.trim() || "an untraceable expression"}\`) which derives from the pre-conversion table but not from its promotion pointer`)
              continue
            }
          }
          trail.push(`${fn.name}: contactId: ${p.value} ← the promotion pointer`)
        }
      }
    }
    if (props === 0) return { ok: false, detail: "no contactId: property sits in a function that reads the pre-conversion table — the shape this guards has moved" }
    return problems.length === 0
      ? { ok: true, detail: trail.join(" | ") }
      : { ok: false, detail: problems.join(" | ") }
  },
  breaks: [
    {
      // The wave-17 defect, restored verbatim.
      file: F.predictions,
      find: `          contactId: promotedContactId,`,
      replace: `          contactId: lead.id,`,
    },
    {
      // The same defect wearing an indirection.
      file: F.predictions,
      find: `    const promotedContactId = typeof lead.contact_id === "string" && lead.contact_id.length > 0 ? lead.contact_id : null`,
      replace: `    const promotedContactId = lead.id`,
    },
  ],
})

A.push({
  id: "idclass.the-promotion-pointer-is-resolved-before-it-is-spent",
  what:
    "the promotion pointer is a column on a row this caller read, not a fact — a stale or dangling one is not a contact. In massGenerateCMAs a contacts read sits BETWEEN the pre-conversion read and the call that spends, and a skip sits between that read and the call, so a record whose promotion does not resolve is passed over rather than valued",
  run: () => {
    const fn = findFn(code(F.predictions), "massGenerateCMAs")
    if (!fn) return { ok: false, detail: "massGenerateCMAs is no longer a function in this file" }
    const lIdx = fn.body.indexOf(`.from("${PRE_CONVERSION}")`)
    const cIdx = fn.body.indexOf(`.from("${CONTACTS}")`)
    const propAt = contactIdProperties(fn.body)[0]?.at ?? -1
    if (lIdx === -1) return { ok: false, detail: "it no longer reads the pre-conversion table — the shape this guards has moved" }
    if (cIdx === -1) return { ok: false, detail: "the promotion pointer is never resolved against contacts" }
    if (propAt === -1) return { ok: false, detail: "no contactId: property found in massGenerateCMAs" }
    if (!(lIdx < cIdx && cIdx < propAt)) {
      return { ok: false, detail: `order is wrong: other@${lIdx}, contacts@${cIdx}, contactId:@${propAt}` }
    }
    // BOTH halves have to be checked, and each with its own skip: that the
    // promotion pointer is PRESENT, and that it RESOLVES. One guard covering only
    // the first would spend the provider on a dangling pointer, and one covering
    // only the second would crash before it got there.
    const value = contactIdProperties(fn.body)[0]?.value ?? ""
    const root = idRoots(value)[0]
    if (!root) return { ok: false, detail: `the contactId: value \`${value}\` has no identifier to check` }
    const between = fn.body.slice(cIdx, propAt)
    const guards = continueGuards(between).filter((c) => new RegExp(`\\b${root}\\b`).test(c))
    if (guards.length < 2) {
      return {
        ok: false,
        detail: `only ${guards.length} skip-guard(s) test \`${root}\` before it is spent — presence and resolution must BOTH be able to skip the record${guards.length ? ` (found: ${guards.map((g) => g.trim()).join(" ; ")})` : ""}`,
      }
    }
    return { ok: true, detail: `other@${lIdx} → contacts@${cIdx} → ${guards.length} skip-guards on \`${root}\` → contactId:@${propAt}` }
  },
  breaks: [
    {
      // The resolve is gone; the pointer is trusted as written.
      file: F.predictions,
      find: `    const { data: contactRows, error: contactsError } = await supabase
      .from("contacts")
      .select("id")
      .in("id", promotionTargets)`,
      replace: `    const contactRows = promotionTargets.map((id) => ({ id }))
    const contactsError = null as { message: string } | null`,
    },
    {
      // The resolve stays, the skip goes — an unconfirmed promotion is spent.
      file: F.predictions,
      find: `        reason: "promotion target does not resolve to a contact this caller can read",
      })
      continue
    }`,
      replace: `        reason: "promotion target does not resolve to a contact this caller can read",
      })
    }`,
    },
    {
      // The other half: an absent pointer is no longer skipped either.
      file: F.predictions,
      find: `        reason: "not promoted to a contact — property valuation runs for contacts only",
      })
      continue
    }`,
      replace: `        reason: "not promoted to a contact — property valuation runs for contacts only",
      })
    }`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 — ORDER: THE PROVIDER IS REACHED AFTER THE DETERMINATION
// ═════════════════════════════════════════════════════════════════════════════

/** Sites that carry an identity and therefore must determine it FIRST. */
const ORDERED_SITES: Array<{ file: string; fn: string }> = [
  { file: F.predictions, fn: "aiPropertyMatchGenius" },
  { file: F.predictions, fn: "optimizeShowingRoute" },
  { file: F.cma, fn: "generateAICMA" },
]

A.push({
  id: "order.every-provider-is-reached-after-the-contacts-determination",
  what:
    "for every site that carries an identity, the contacts read appears EARLIER in the function body than the provider. The pre-wave ordering was exactly the reverse — the client was built at the top of the function and the lookup happened underneath it — so the decision to spend was made with the resource already in hand. The provider position is DERIVED (the earlier of a direct construction and the first call to an in-file function that itself touches one), so renaming the resolver or the comps helper cannot weaken this",
  run: () => {
    const problems: string[] = []
    const trail: string[] = []
    for (const site of ORDERED_SITES) {
      const m = model(site.file)
      const fn = m.fns.find((f) => f.name === site.fn)
      if (!fn) { problems.push(`${site.fn} is no longer a function in ${site.file}`); continue }
      const cIdx = fn.body.indexOf(`.from("${CONTACTS}")`)
      const pIdx = providerPosition(m, fn)
      if (cIdx === -1) { problems.push(`${site.fn} carries an identity and never resolves it against contacts`); continue }
      if (pIdx === -1) { problems.push(`${site.fn} no longer reaches a property provider — this proof is aimed at the wrong shape`); continue }
      if (cIdx > pIdx) { problems.push(`${site.fn} reaches its provider at ${pIdx}, BEFORE the contacts read at ${cIdx}`); continue }
      // …and the determination must REFUSE ON ABSENCE, not merely look. A throw
      // on the query's own error is a DIFFERENT fact: supabase-js resolves a
      // refused query, so "the read failed" and "no such contact" are two
      // branches, and only the second one is this gate.
      const binding = rowBindingOf(fn.body, cIdx)
      if (!binding) { problems.push(`${site.fn}: the contacts read binds no row, so nothing can be checked for absence`); continue }
      const gate = fn.body.slice(cIdx, pIdx)
      if (!refusesOnAbsence(gate, binding)) {
        problems.push(`${site.fn} reads contacts before the provider but never refuses on \`!${binding}\` in between — a lookup that cannot say "no such contact" is not a gate`)
        continue
      }
      trail.push(`${site.fn}: contacts@${cIdx} → refuses on !${binding} → provider@${pIdx}`)
    }
    return problems.length === 0
      ? { ok: true, detail: trail.join(" | ") }
      : { ok: false, detail: problems.join(" | ") }
  },
  breaks: [
    {
      // The pre-wave ordering, restored: client first, lookup afterwards.
      file: F.predictions,
      find: `export async function aiPropertyMatchGenius(contactId: string) {
  const supabase = await createClient()
`,
      replace: `export async function aiPropertyMatchGenius(contactId: string) {
  const supabase = await createClient()
  const { client: idxClientEarly } = await idxForCallerBrokerage("aiPropertyMatchGenius")
  void idxClientEarly
`,
    },
    {
      // The gate loses its teeth: it looks, and proceeds either way.
      file: F.predictions,
      find: `  if (!routeContact) {
    throw new Error(
      "optimizeShowingRoute: no contact carries that id. Showing routes are built for contacts only; an unconverted record has to be promoted first.",
    )
  }`,
      replace: `  void routeContact`,
    },
    {
      // ai-cma.ts checks the contact only AFTER the comps have been bought.
      //
      // ANCHORED ON THE BINDING AND THE TABLE, NOT THE COLUMN LIST. This control
      // used to pin all five lines of the read including `.select("id")`, so when
      // the CMA tenant fix widened it to `.select("id, brokerage_id")` the
      // mutation silently stopped applying — and the harness caught it as
      // "the control is theatre" rather than passing on a control that no longer
      // does anything. That report is the guard working; re-pinning the whole
      // statement would only queue up the same failure for the next edit. The two
      // lines below are what the control actually needs: the binding it swaps and
      // the table it swaps away from.
      file: F.cma,
      find: `const { data: cmaContact, error: cmaContactError } = await supabase
    .from("contacts")`,
      replace: `const { data: cmaContact, error: cmaContactError } = await supabase
    .from("agents")`,
    },
  ],
})

A.push({
  id: "order.the-inert-identity-parameter-is-gone-not-decorative",
  what:
    "predictWinningOffer takes NO identity parameter. It used to take one that appeared exactly once in the whole function — its own declaration — and was never read against any table, so an id of any class reached IDX while the signature implied something had checked it. An inert parameter that gates nothing is worse than no parameter, because it reads like authorization; the fix is removal, not a ceremonial lookup for a value the function never uses",
  run: () => {
    const fn = findFn(code(F.predictions), "predictWinningOffer")
    if (!fn) return { ok: false, detail: "predictWinningOffer is no longer a function in this file" }
    // Every property name in the parameter object, then judged: does it name an
    // IDENTITY? `propertyMlsId` ends in Id and is not one; `leadId`, `contactId`,
    // `buyerId` are. Checked by meaning, not by one hard-coded spelling.
    const names = [...fn.params.matchAll(/([A-Za-z_$][\w$]*)\s*\??\s*:/g)].map((m) => m[1])
    const identity = names.filter(
      (n) => /id$/i.test(n) && /(lead|contact|client|buyer|seller|person|customer|subject)/i.test(n),
    )
    if (identity.length > 0) return { ok: false, detail: `an identity parameter is back: ${identity.map((n) => `\`${n}\``).join(", ")}` }
    // And it must still be the function this is about.
    if (!touchesIdx(fn.body) && !fn.body.includes("idxForCallerBrokerage")) {
      return { ok: false, detail: "it no longer reaches IDX at all — this proof is aimed at the wrong shape" }
    }
    return { ok: true, detail: `params: ${fn.params.replace(/\s+/g, " ").trim()}` }
  },
  breaks: [
    {
      file: F.predictions,
      find: `export async function predictWinningOffer(data: {
  propertyMlsId: string
  listPrice: number
}) {`,
      replace: `export async function predictWinningOffer(data: {
  propertyMlsId: string
  listPrice: number
  leadId?: string
}) {`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 4 — THE MODEL SURVIVES
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "model.enrich-lead-data-still-resolves-contacts-only-and-refuses",
  what:
    "`enrichLeadData` is the one entry point that was already ordered correctly, and it is what this wave copied: it resolves the id against the contacts table with a single-row read, THROWS when nothing answers, and only then does any downstream work — so an id of the other class cannot survive past that line. It must not regress into the shape it was copied out of",
  run: () => {
    const m = model(F.leadIntel)
    const fn = m.fns.find((f) => f.name === "enrichLeadData")
    if (!fn) return { ok: false, detail: "enrichLeadData is no longer a function in this file" }
    const cIdx = fn.body.indexOf(`.from("${CONTACTS}")`)
    if (cIdx === -1) return { ok: false, detail: "it no longer resolves against contacts at all" }
    const binding = rowBindingOf(fn.body, cIdx)
    if (!binding) return { ok: false, detail: "the contacts read binds no row, so nothing can be checked for absence" }
    const after = fn.body.slice(cIdx)
    if (!refusesOnAbsence(after, binding)) {
      return { ok: false, detail: `the contacts lookup no longer refuses on \`!${binding}\` — a lookup that cannot say "no such contact" is not a gate` }
    }
    const throwRel = after.search(new RegExp(`if\\s*\\(\\s*!\\s*${binding}\\s*\\)`))
    const throwIdx = cIdx + throwRel
    const pIdx = providerPosition(m, fn)
    if (pIdx === -1) return { ok: false, detail: "enrichLeadData no longer reaches a property provider — this proof is aimed at the wrong shape" }
    if (!(cIdx < throwIdx && throwIdx < pIdx)) {
      return { ok: false, detail: `order broken: contacts@${cIdx}, refusal@${throwIdx}, provider@${pIdx}` }
    }
    if (!m.reaching.has("enrichLeadData")) return { ok: false, detail: "enrichLeadData no longer reaches the IDX path it gates" }
    return { ok: true, detail: `contacts@${cIdx} → refusal@${throwIdx} → provider@${pIdx}` }
  },
  breaks: [
    {
      // The refusal is removed: the lookup becomes decoration.
      file: F.leadIntel,
      find: `  if (!lead) throw new Error("Lead not found")`,
      replace: `  if (!lead) console.error("[v0] enrichLeadData: nothing came back")`,
    },
    {
      // The gate reads the wrong table — the regression this wave undid.
      file: F.leadIntel,
      find: `  const { data: lead } = await supabase.from("contacts").select("*").eq("id", leadId).single()`,
      replace: `  const { data: lead } = await supabase.from("agents").select("*").eq("id", leadId).single()`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 5 — NO CONTACTS-PROVEN id IS FILED IN THE OTHER CLASS'S FOREIGN KEY
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "idclass.no-write-into-the-table-whose-only-key-is-the-other-class",
  what:
    `lead-intelligence.ts proves its subject is a contact at its entry point, so nothing in it may insert into ${LEADS_FK_TABLE} — that table's \`lead_id\` is REFERENCES leads(id) and it carries no contacts-keyed column at all (scripts/schema-snapshot.ts), so every row the old writer produced put a contacts.id into the other class's foreign key. There is no correct column to move the write to, so there is no write: recording nothing beats recording a row that misattributes one person's activity to another record`,
  run: () => {
    const src = code(F.leadIntel)
    const needle = `.from("${LEADS_FK_TABLE}")`
    const hits: string[] = []
    let at = src.indexOf(needle)
    while (at !== -1) {
      const window = src.slice(at, at + 220)
      if (/\.(insert|upsert|update)\s*\(/.test(window)) hits.push(`position ${at}`)
      at = src.indexOf(needle, at + 1)
    }
    // The read that remains is fine and is not what this guards; only writes are.
    return hits.length === 0
      ? { ok: true, detail: `no insert/upsert/update into ${LEADS_FK_TABLE} anywhere in ${F.leadIntel}` }
      : { ok: false, detail: `a wrong-class write is back at ${hits.join(", ")}` }
  },
  breaks: [
    {
      file: F.leadIntel,
      find: `  return { synced: false, reason: "no_contacts_keyed_idx_interaction_lane" }`,
      replace:
        `  const svc = createServiceClient()\n` +
        `  const { error: interactionError } = await svc.from("${LEADS_FK_TABLE}").insert({ lead_id: leadId })\n` +
        `  if (interactionError) return { synced: false, reason: "interaction_write_refused" }\n` +
        `  return { synced: true }`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 6 — THE WITHDRAWN AFFORDANCE STAYS WITHDRAWN
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "surface.the-pre-conversion-screen-does-not-call-the-contacts-only-action",
  what:
    "app/leads/page.tsx does not reference aiPropertyMatchGenius in executable code. Every row on that screen comes from the pre-conversion lane, so once the action refuses that class the button behind it could only ever produce an error — and a control that reliably fails is worse than one that is absent, because it teaches an agent to ignore failures. The row control is REMOVED rather than disabled — a disabled button with no handler is INERT and this repo holds a zero-inert-controls invariant (test:wired-surface) — and a banner above the table says once where the capability lives and how to reach it",
  run: () => {
    const src = code(F.leadsPage)
    const called = /\baiPropertyMatchGenius\b/.test(src)
    if (called) return { ok: false, detail: "the leads screen references the contacts-only action in executable code again" }
    // The withdrawal must be EXPLAINED, not merely performed: the raw file still
    // has to name it in prose, or nobody reading the screen learns what happened.
    if (!/aiPropertyMatchGenius/.test(raw(F.leadsPage))) {
      return { ok: false, detail: "the withdrawal is not explained anywhere in the file — a capability removed without a reason is indistinguishable from one lost by accident" }
    }
    return { ok: true, detail: "no executable reference; the reason survives in prose" }
  },
  breaks: [
    {
      file: F.leadsPage,
      find: `import { getTopConversionCandidates } from "@/app/actions/ai-predictions"`,
      replace: `import { getTopConversionCandidates, aiPropertyMatchGenius } from "@/app/actions/ai-predictions"`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// RUN
// ═════════════════════════════════════════════════════════════════════════════
function main() {
  console.log("\n─── PRE-FLIGHT — the comment stripper (no assertion may be satisfied by prose) ───")
  let pre = 0, preFail = 0
  const preCheck = (name: string, ok: boolean) => {
    if (ok) { pre++; console.log(`  ✔ ${name}`) } else { preFail++; console.log(`  ✘ ${name}`) }
  }
  preCheck("a line comment is removed", !strip(`const a = 1 // .from("${PRE_CONVERSION}")`).includes(PRE_CONVERSION))
  preCheck("a block comment is removed", !strip(`/* .from("${PRE_CONVERSION}")\n more */ const a = 1`).includes(PRE_CONVERSION))
  preCheck("a // inside a double-quoted string survives", strip(`const u = "https://x/y"`).includes("https://x/y"))
  preCheck("a // inside a template literal survives", strip("const u = `https://x/y`").includes("https://x/y"))
  preCheck(
    "REAL FILE: the leads screen names the withdrawn action ONLY in prose, and the stripper proves it",
    /aiPropertyMatchGenius/.test(raw(F.leadsPage)) && !/aiPropertyMatchGenius/.test(code(F.leadsPage)),
  )
  preCheck(
    `REAL FILE: lead-intelligence.ts names ${LEADS_FK_TABLE} ONLY in prose where the write used to be`,
    new RegExp(LEADS_FK_TABLE).test(raw(F.leadIntel)),
  )

  let pass = 0, fail = 0
  const failures: string[] = []
  console.log("\n─── ASSERTIONS ───────────────────────────────────────────────────")
  for (const a of A) {
    let r: Outcome
    try { r = a.run() } catch (e) { r = { ok: false, detail: `threw: ${(e as Error).message}` } }
    if (r.ok) { pass++; console.log(`  ✔ ${a.id}\n      ${a.what}${r.detail ? `\n      → ${r.detail}` : ""}`) }
    else { fail++; failures.push(`${a.id}: ${r.detail ?? ""}`); console.log(`  ✘ ${a.id}\n      ${a.what}\n      → ${r.detail ?? ""}`) }
  }

  let negPass = 0, negFail = 0
  const negProblems: string[] = []
  if (RUN_NEGATIVE) {
    console.log("\n─── NEGATIVE CONTROLS (the defect is written back on purpose) ────")
    for (const a of A) {
      if (a.breaks.length === 0) {
        negFail++
        negProblems.push(`${a.id}: assertion with NO negative control`)
        console.log(`  ✘ ${a.id}  no negative control defined`)
        continue
      }
      for (let i = 0; i < a.breaks.length; i++) {
        const b = a.breaks[i]
        const path = resolve(ROOT, b.file)
        const before = readFileSync(path, "utf8")
        const digest = createHash("sha256").update(before).digest("hex")
        const after = before.replace(b.find, b.replace)
        if (after === before) {
          negFail++
          negProblems.push(`${a.id}[${i}]: the mutation DID NOT APPLY to ${b.file} — the control is theatre`)
          console.log(`  ✘ ${a.id}[${i}]  mutation did not apply — fix the find string`)
          continue
        }
        writeFileSync(path, after, "utf8")
        const onDisk = readFileSync(path, "utf8")
        const applied = onDisk !== before && onDisk.includes(b.replace.split("\n")[0])
        let broke = false, detail = ""
        try { const r = a.run(); broke = !r.ok; detail = r.detail ?? "" }
        catch (e) { broke = true; detail = `threw: ${(e as Error).message}` }
        finally { writeFileSync(path, before, "utf8") }
        const restored = createHash("sha256").update(readFileSync(path)).digest("hex") === digest
        if (broke && restored && applied) {
          negPass++
          console.log(`  ✔ ${a.id}[${i}]  patch verified on disk (${b.file}), flipped RED as required, file restored (sha256 verified)`)
        } else {
          negFail++
          if (!applied) negProblems.push(`${a.id}[${i}]: the patched text was NOT observed on disk`)
          if (!broke) negProblems.push(`${a.id}[${i}]: still PASSED with the defect reintroduced — the assertion is worthless as written`)
          if (!restored) negProblems.push(`${a.id}[${i}]: FILE NOT RESTORED (${b.file})`)
          console.log(`  ✘ ${a.id}[${i}]  ${!applied ? "patch not observed" : ""}${!broke ? " did NOT flip" : ""}${!restored ? " FILE NOT RESTORED" : ""}${detail ? ` (${detail})` : ""}`)
        }
      }
    }
  }

  console.log("\n" + "═".repeat(72))
  console.log(` PRE-FLIGHT  ${pre} passed, ${preFail} failed`)
  console.log(` ASSERTIONS  ${pass} passed, ${fail} failed`)
  if (RUN_NEGATIVE) console.log(` CONTROLS    ${negPass} flipped RED as required, ${negFail} did not`)
  console.log("═".repeat(72))
  if (failures.length) { console.log("\nFailures:"); failures.forEach((f) => console.log("  · " + f)) }
  if (negProblems.length) { console.log("\nControl problems:"); negProblems.forEach((f) => console.log("  · " + f)) }

  if (fail > 0 || negFail > 0 || preFail > 0) { console.log("\n ❌ LEADS_NEVER_REACH_PROPERTY_PROVIDERS_FAIL"); process.exit(1) }
  console.log(
    "\n ✅ LEADS_NEVER_REACH_PROPERTY_PROVIDERS_PASS — no function that reaches IDX Broker or RentCast reads the pre-conversion table, no id from it is passed under a contacts parameter, every provider client is obtained AFTER the contacts determination and never before, the one already-correct entry point still refuses, and the withdrawn affordance stays withdrawn",
  )
}
main()
