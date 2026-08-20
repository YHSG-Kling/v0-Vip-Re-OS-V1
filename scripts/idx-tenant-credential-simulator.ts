#!/usr/bin/env tsx
/**
 * scripts/idx-tenant-credential-simulator.ts  (npm run test:idx-tenant-credential)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TENANT'S OWN IDX BROKER ACCOUNT, ON EVERY PATH THAT READS ONE.
 *
 * OWNER RULING: "rentcast is a platform gated credential and tenants can setup
 * and use their idxbroker account if they set it up." IDX Broker is
 * TENANT-SETTABLE — a brokerage that connects its own account connected it to
 * get its own board's data, and must be served from its own account.
 *
 * `lib/connections/scope.ts` had already encoded that rule, in one line, before
 * the ruling was given: `listing: ["idxbroker"]`, under a comment saying IDX
 * Broker is per-tier connectable (agent/team/brokerage/platform) while RentCast
 * is platform-only. `IDXBrokerClient.forBrokerage` implemented it correctly —
 * `resolveScopedConnection` walks agent → team → brokerage → platform, and only
 * then the platform env key.
 *
 * AND NINE CALL SITES NEVER REACHED IT. Every one of them was
 * `new IDXBrokerClient()` with no argument, and the constructor's
 * `?? process.env.IDXBROKER_API_KEY` turned that omission into a working call.
 * So on all nine paths a brokerage with its own IDX Broker account was served
 * the PLATFORM'S feed, and nothing anywhere failed:
 *
 *   app/actions/ai-predictions.ts    aiPropertyMatchGenius, predictWinningOffer,
 *                                    predictMarketShift, findMarketArbitrage,
 *                                    optimizeShowingRoute, competitiveIntelligence
 *   app/actions/calculators.ts       compareNeighborhoods, calculateHomeValue
 *   app/actions/lead-intelligence.ts syncIDXBrokerActivity
 *
 * This proof stands over five properties. Each is a CONSTRUCT, not a spelling:
 * renaming the factory, the helper or any local keeps every one of them green,
 * and reintroducing the defect does not.
 *
 *  1. THE DEFECT, STATED EXACTLY. No zero-argument `new IDXBrokerClient()`
 *     exists anywhere in the tree outside lib/idxbroker-client.ts itself. That
 *     one construction — inside `forBrokerage`, after the cascade has answered —
 *     is the only legitimate one.
 *
 *  2. EVERY IDX CONSTRUCTION IN THE THREE ACTION FILES IS A RESOLVE. Each of the
 *     nine functions binds its client from `forBrokerage` (directly, or through
 *     the file-local resolver that calls it), and every brokerage id handed to
 *     `forBrokerage` traces — transitively, through the assignments in its own
 *     function — to a SESSION or a RECORD READ. An id that traces to a parameter
 *     of an exported "use server" function is a caller-asserted tenant and fails:
 *     that is the shape wave 15 removed from the public home-value calculator.
 *     A module-private helper may take the tenant as a parameter only when every
 *     call site inside its own file passes a resolved one (syncIDXBrokerActivity
 *     is handed the contact row its caller has already read).
 *
 *  3. THE ORDER INSIDE `forBrokerage` IS THE RULING. `resolveScopedConnection`
 *     for "idxbroker" is consulted BEFORE `process.env.IDXBROKER_API_KEY`, and
 *     the key expression prefers the resolved connection over the env. Swapping
 *     those two silently restores the platform-feed bug with every call site
 *     still looking correct.
 *
 *  4. THE CONSTRUCTOR NO LONGER LAUNDERS A MISSING ARGUMENT. Its key parameter
 *     is REQUIRED (no `?`, no default) and its body reads no `process.env` at
 *     all, so the nine-site omission is now a compile error rather than a quiet
 *     cross-tenant read. The whole file mentions IDXBROKER_API_KEY exactly once,
 *     inside `forBrokerage` — one place decides when the platform key applies.
 *
 *  5. THE ARBITER HASN'T MOVED. `lib/connections/scope.ts` still lists
 *     `idxbroker` under the per-tier-connectable `listing` domain. If that line
 *     is edited the ruling itself has changed, and this must fail loudly rather
 *     than keep enforcing a rule the source of truth no longer states.
 *
 * HOW IT IS BUILT
 *   · Every structural assertion reads COMMENT-STRIPPED source. It has to: the
 *     files under test quote `new IDXBrokerClient()` in their own prose,
 *     explaining the defect, and assertion 1 would fail on those comments alone
 *     while assertion 2 could be satisfied by one.
 *   · Every assertion carries NEGATIVE CONTROLS. The defect is written back into
 *     the real file, the mutation is VERIFIED TO HAVE APPLIED (a find string
 *     that no longer matches is theatre), the assertion is required to flip RED,
 *     and the file is restored and re-verified by sha256.
 *   · ASSERTION 5 CARRIES A SYNTHETIC CONTROL INSTEAD, and says so in its
 *     output. lib/connections/scope.ts is the arbiter and is outside this
 *     slice's write scope; a proof does not get to edit files its author may
 *     not. The control runs the assertion's own pure logic over the REAL file's
 *     text with the defect applied in memory — weaker than a tree mutation, and
 *     labelled as such.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { resolve, join, relative } from "node:path"
import { createHash } from "node:crypto"
import { stripComments } from "./strip-comments"

const ROOT = process.cwd()
const RUN_NEGATIVE = !process.argv.includes("--no-negative")

const F = {
  client: "lib/idxbroker-client.ts",
  scope: "lib/connections/scope.ts",
  predictions: "app/actions/ai-predictions.ts",
  calculators: "app/actions/calculators.ts",
  leadIntel: "app/actions/lead-intelligence.ts",
  self: "scripts/idx-tenant-credential-simulator.ts",
}

const ACTION_FILES = [F.predictions, F.calculators, F.leadIntel]

/** The nine sites, by the function each one lives in. */
const NINE: Array<{ file: string; fn: string }> = [
  { file: F.predictions, fn: "aiPropertyMatchGenius" },
  { file: F.predictions, fn: "predictWinningOffer" },
  { file: F.predictions, fn: "predictMarketShift" },
  { file: F.predictions, fn: "findMarketArbitrage" },
  { file: F.predictions, fn: "optimizeShowingRoute" },
  { file: F.predictions, fn: "competitiveIntelligence" },
  { file: F.calculators, fn: "compareNeighborhoods" },
  { file: F.calculators, fn: "calculateHomeValue" },
  { file: F.leadIntel, fn: "syncIDXBrokerActivity" },
]

/** The class under test, spelled once. */
const KLASS = "IDXBrokerClient"
/** The factory that IS the ruling. */
const FACTORY = "forBrokerage"

// ─────────────────────────────────────────────────────────────────────────────
// Source access — read FRESH every time, the negative layer rewrites these files
// ─────────────────────────────────────────────────────────────────────────────
const raw = (p: string) => readFileSync(resolve(ROOT, p), "utf8")

// hand-rolled scanner replaced (finding #250): it could not see nested `${…}` templates, regex literals, or an apostrophe in JSX text, and went blind on the code it judges.
const strip = stripComments

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

interface Fn { name: string; params: string; body: string; exported: boolean; at: number }

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
    if (c === ";" && angle === 0) return -1 // a declaration with no body
  }
  return -1
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

/** Every top-level `function <name>(...) { ... }` in a module, with its params. */
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

/**
 * A named function OR a class METHOD. `forBrokerage` is a `static async` member,
 * not a declaration — a finder that only knows `function foo(` would report the
 * factory missing and, worse, would report it missing identically whether it had
 * been renamed or deleted.
 */
function findFn(src: string, name: string): Fn | null {
  const declared = functions(src).find((f) => f.name === name)
  if (declared) return declared
  const m = new RegExp(`(?:^|\\n)\\s*(?:public\\s+|private\\s+|protected\\s+)?(?:static\\s+)?(?:async\\s+)?${name}\\s*\\(`).exec(src)
  if (!m) return null
  const openParen = src.indexOf("(", m.index + m[0].length - 1)
  const closeParen = matchParen(src, openParen)
  if (closeParen === -1) return null
  const openBrace = bodyBraceAfter(src, closeParen + 1)
  if (openBrace === -1) return null
  const closeBrace = matchBrace(src, openBrace)
  if (closeBrace === -1) return null
  return {
    name,
    params: src.slice(openParen + 1, closeParen),
    body: src.slice(openBrace + 1, closeBrace),
    exported: false,
    at: m.index,
  }
}

/**
 * Top-level identifier roots of a PARAMETER list. `x: string` is a type
 * annotation, so the binding is what precedes the colon.
 */
function paramRoots(params: string): string[] {
  const roots: string[] = []
  for (const entry of splitTop(params)) {
    const t = entry.trim()
    if (!t) continue
    const binding = t.split(/[:=]/)[0].trim()
    if (binding.startsWith("{") || binding.startsWith("[")) {
      roots.push(...bindingNames(binding))
    } else {
      const id = /^\.{0,3}\s*([A-Za-z_$][\w$]*)/.exec(binding)
      if (id) roots.push(id[1])
    }
  }
  return [...new Set(roots)]
}

/**
 * Names BOUND by a destructuring pattern. The opposite convention to a parameter
 * list: in `{ data: lead }` the colon RENAMES, so the bound name is what FOLLOWS
 * it. Reading these two the same way is how `const { data: routeCallerRow } = …`
 * gets mistaken for a binding called `data`.
 */
function bindingNames(pattern: string): string[] {
  const inner = pattern.replace(/^[{[]/, "").replace(/[}\]]$/, "")
  const out: string[] = []
  for (const entry of splitTop(inner)) {
    let t = entry.trim()
    if (!t) continue
    t = t.split("=")[0].trim() // drop a default value
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

/**
 * The rest of a STATEMENT starting at `from` — not merely the rest of the line.
 * `const brokerageId =` puts its value on the next line and a supabase read puts
 * `.from("users")` two lines below its `=`; a line-scoped reader would see an
 * empty right-hand side and call it "reaches no resolve", which is a false RED
 * and, in the other direction, would miss a defect that hides one line down.
 */
function statementFrom(body: string, from: number): string {
  let depth = 0
  let out = ""
  const CONTINUERS = /^[.?)\]},:]|^(?:&&|\|\||\?\?|\+|-|\*|\/|=>|as\b|:)/
  const OPEN_ENDED = /(?:[=+\-*/%<>!&|?:,({[]|\?\?|&&|\|\||=>|\bas\b)\s*$/
  const lines = body.slice(from).split("\n")
  for (let i = 0; i < lines.length && i < 24; i++) {
    const line = lines[i]
    out += (i === 0 ? "" : "\n") + line
    for (const ch of line) {
      if ("([{".includes(ch)) depth++
      else if (")]}".includes(ch)) depth--
    }
    const trimmed = out.trim()
    if (depth > 0) continue
    if (trimmed === "" || OPEN_ENDED.test(trimmed)) continue
    let j = i + 1
    while (j < lines.length && lines[j].trim() === "") j++
    const next = j < lines.length ? lines[j].trim() : ""
    if (next && CONTINUERS.test(next)) continue
    break
  }
  return out
}

/** Identifier roots referenced in an expression, minus keywords/literals. */
const KEYWORDS = new Set([
  "await", "null", "undefined", "true", "false", "string", "number", "as", "new",
  "typeof", "return", "const", "let", "var", "if", "else", "this",
])
function idRoots(expr: string): string[] {
  const out: string[] = []
  // Only the ROOT of each member chain: `session.brokerageId` → `session`.
  for (const m of expr.matchAll(/(^|[^\w$.])([A-Za-z_$][\w$]*)/g)) {
    if (!KEYWORDS.has(m[2])) out.push(m[2])
  }
  return [...new Set(out)]
}

/**
 * Every assignment to a name inside a body: `const x = …`, `let x = …`,
 * `const { a: x } = …`, and bare re-assignments `x = …`. Returns the RHS texts.
 * A name with SEVERAL assignments must have every one of them defensible.
 */
function assignmentsTo(body: string, name: string): string[] {
  const out: string[] = []
  const seenAt = new Set<number>()
  const take = (at: number) => {
    if (seenAt.has(at)) return
    seenAt.add(at)
    out.push(statementFrom(body, at))
  }
  // const/let x = …   (a type annotation may sit between the name and the `=`)
  for (const m of body.matchAll(new RegExp(`(?:const|let|var)\\s+${name}\\s*(?::[^=\\n]*)?=(?!=)`, "g"))) {
    take(m.index! + m[0].length)
  }
  // const { … x … } = …   /   const { data: x } = …
  for (const m of body.matchAll(/(?:const|let|var)\s*\{/g)) {
    const open = body.indexOf("{", m.index!)
    const close = matchBrace(body, open)
    if (close === -1) continue
    if (!bindingNames(body.slice(open, close + 1)).includes(name)) continue
    const eq = body.indexOf("=", close)
    if (eq === -1) continue
    take(eq + 1)
  }
  // bare re-assignment
  for (const m of body.matchAll(new RegExp(`(^|[^\\w$.])${name}\\s*=(?!=)`, "gm"))) {
    take(m.index! + m[0].length)
  }
  return out
}

/**
 * Markers that make an expression a genuine RESOLVE — a session read or a record
 * read — rather than an assertion by whoever called the function.
 */
const RESOLVE_MARKERS = [
  "getAgentContext(",
  "auth.getUser(",
  ".from(",
  "getAgentBySlug(",
  "requireCaller(",
  "requirePermission(",
]

/**
 * Does `name` trace, through the assignments in `body`, to a session or record
 * resolve? Returns the trail, or the reason it does not.
 */
interface Trace { ok: boolean; detail: string; param?: string }

function tracesToResolve(
  body: string,
  name: string,
  params: string[],
  depth = 0,
  seen = new Set<string>(),
): Trace {
  if (depth > 5) return { ok: false, detail: `${name}: assignment chain deeper than 5 — refusing to guess` }
  if (seen.has(name)) return { ok: false, detail: `${name}: circular assignment` }
  seen.add(name)
  if (params.includes(name)) return { ok: false, detail: `${name} is a PARAMETER of this function`, param: name }
  const rhs = assignmentsTo(body, name)
  if (rhs.length === 0) return { ok: false, detail: `${name} is never assigned in this function body` }
  const trail: string[] = []
  for (const r of rhs) {
    if (RESOLVE_MARKERS.some((mk) => r.includes(mk))) { trail.push(`${name} ← ${flat(r)}`); continue }
    // Not a direct resolve — every identifier it leans on must itself resolve.
    const roots = idRoots(r).filter((x) => x !== name)
    if (roots.length === 0) return { ok: false, detail: `${name} ← ${flat(r)} — reaches no resolve` }
    let hit: Trace | null = null
    let viaParam: string | undefined
    for (const rt of roots) {
      const sub = tracesToResolve(body, rt, params, depth + 1, new Set(seen))
      if (sub.ok) { hit = sub; trail.push(`${name} ← ${rt}: ${sub.detail}`); break }
      if (sub.param && !viaParam) viaParam = sub.param
    }
    if (!hit) {
      return {
        ok: false,
        detail: `${name} ← ${flat(r)} — no root resolves (roots: ${roots.join(", ")})`,
        param: viaParam,
      }
    }
  }
  return { ok: true, detail: trail.join(" ; ") }
}

const flat = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 70)

/** First argument expression of each `X.forBrokerage(` call in a body. */
function factoryCalls(body: string): Array<{ arg: string; at: number }> {
  const out: Array<{ arg: string; at: number }> = []
  for (const m of body.matchAll(new RegExp(`${KLASS}\\s*\\.\\s*${FACTORY}\\s*\\(`, "g"))) {
    const open = body.indexOf("(", m.index! + m[0].length - 1)
    const close = matchParen(body, open)
    if (close === -1) continue
    const args = body.slice(open + 1, close)
    let depth = 0
    let first = ""
    for (const ch of args) {
      if ("([{".includes(ch)) depth++
      else if (")]}".includes(ch)) depth--
      if (ch === "," && depth === 0) break
      first += ch
    }
    out.push({ arg: first.trim(), at: m.index! })
  }
  return out
}

/** Walk the tree for .ts/.tsx sources. */
function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(entry)) yield p
  }
}

/** PURE — does this source text list `idxbroker` under the `listing` domain? */
export function listingDomainCarriesIdx(scopeSrc: string): { ok: boolean; detail: string } {
  const src = strip(scopeSrc)
  const table = /CONNECTOR_PROVIDERS\s*:\s*Record<[^>]*>\s*=\s*\{/.exec(src)
  if (!table) return { ok: false, detail: "CONNECTOR_PROVIDERS is not declared as a domain→providers record any more" }
  const open = src.indexOf("{", table.index!)
  const close = matchBrace(src, open)
  if (close === -1) return { ok: false, detail: "the CONNECTOR_PROVIDERS literal could not be parsed" }
  const bodyText = src.slice(open + 1, close)
  const listing = /(^|[^\w$])listing\s*:\s*\[([^\]]*)\]/m.exec(bodyText)
  if (!listing) return { ok: false, detail: "there is no `listing` domain in CONNECTOR_PROVIDERS" }
  const providers = [...listing[2].matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2])
  return providers.includes("idxbroker")
    ? { ok: true, detail: `listing: [${providers.join(", ")}]` }
    : { ok: false, detail: `listing: [${providers.join(", ") || "(empty)"}] — idxbroker is NOT per-tier connectable any more` }
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
  synthetic?: { why: string; run: () => Outcome }
}
const A: Assertion[] = []

// ═════════════════════════════════════════════════════════════════════════════
// 1 — THE DEFECT, STATED EXACTLY
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "defect.no-zero-argument-idx-client-anywhere-outside-the-client-module",
  what:
    "no `new IDXBrokerClient()` with an EMPTY argument list exists in app/, lib/ or scripts/ outside lib/idxbroker-client.ts — that construction is the whole defect: it took no owner, so the constructor's env fallback served the PLATFORM'S feed to a brokerage that had connected its own IDX Broker account. Renaming the factory keeps this green; reintroducing a bare construction does not",
  run: () => {
    const empty = new RegExp(`new\\s+${KLASS}\\s*\\(\\s*\\)`)
    const hits: string[] = []
    for (const dir of ["app", "lib", "scripts"]) {
      const abs = join(ROOT, dir)
      if (!existsSync(abs)) continue
      for (const file of walk(abs)) {
        const rel = relative(ROOT, file).replace(/\\/g, "/")
        if (rel === F.client || rel === F.self) continue
        const src = strip(readFileSync(file, "utf8"))
        if (empty.test(src)) hits.push(rel)
      }
    }
    return hits.length === 0
      ? { ok: true, detail: "zero bare constructions in the tree" }
      : { ok: false, detail: `bare construction in: ${hits.join(", ")}` }
  },
  breaks: [
    {
      file: F.predictions,
      find: `  const { client: idxClient } = await idxForCallerBrokerage("aiPropertyMatchGenius")`,
      replace: `  const { ${KLASS} } = await import("@/lib/idxbroker-client")\n  const idxClient = new ${KLASS}()`,
    },
    {
      file: F.leadIntel,
      find: `  const idx = await ${KLASS}.${FACTORY}(ownerBrokerageId)`,
      replace: `  const idx = new ${KLASS}()`,
    },
    {
      file: F.calculators,
      find: `  const idxClient = await ${KLASS}.${FACTORY}(brokerageId, {`,
      replace: `  const idxClient = new ${KLASS}()\n  const unusedIdxOptions = ({`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 2 — EVERY IDX CONSTRUCTION IN THE THREE ACTION FILES IS A RESOLVE
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "wiring.each-of-the-nine-sites-binds-its-client-from-the-factory",
  what:
    "each of the nine functions that reads IDX obtains its client from `forBrokerage` — directly, or through a file-local resolver whose own body calls it — and constructs none itself. Named one by one, because 'nine call sites never use the factory' is the finding, and a proof that only counts calls would go green if eight were repointed",
  run: () => {
    const problems: string[] = []
    const trail: string[] = []
    for (const site of NINE) {
      const fn = findFn(code(site.file), site.fn)
      if (!fn) { problems.push(`${site.fn} is not a function in ${site.file}`); continue }
      if (new RegExp(`new\\s+${KLASS}\\b`).test(fn.body)) { problems.push(`${site.fn} constructs the client directly`); continue }
      const direct = new RegExp(`await\\s+${KLASS}\\s*\\.\\s*${FACTORY}\\s*\\(`).test(fn.body)
      let via: string | null = null
      if (!direct) {
        // A file-local resolver is acceptable only if it itself calls the factory.
        for (const helper of functions(code(site.file))) {
          if (helper.name === site.fn) continue
          if (!new RegExp(`await\\s+${helper.name}\\s*\\(`).test(fn.body)) continue
          if (new RegExp(`await\\s+${KLASS}\\s*\\.\\s*${FACTORY}\\s*\\(`).test(helper.body)) { via = helper.name; break }
        }
      }
      if (!direct && !via) { problems.push(`${site.fn} reaches ${FACTORY} neither directly nor through a local resolver`); continue }
      trail.push(`${site.fn}${direct ? "" : ` via ${via}`}`)
    }
    return problems.length === 0
      ? { ok: true, detail: trail.join(", ") }
      : { ok: false, detail: problems.join(" | ") }
  },
  breaks: [
    {
      file: F.predictions,
      find: `  const { client: idxClient } = await idxForCallerBrokerage("competitiveIntelligence")`,
      replace: `  const { ${KLASS} } = await import("@/lib/idxbroker-client")\n  const idxClient = new ${KLASS}(process.env.IDXBROKER_API_KEY ?? "")`,
    },
    {
      // The resolver stops resolving: it becomes the env-key laundry it replaced,
      // and every site that goes "through" it is back on the platform feed.
      file: F.predictions,
      find: `  const client = await ${KLASS}.${FACTORY}(ctx.brokerageId, {`,
      replace: `  const client = new ${KLASS}(process.env.IDXBROKER_API_KEY ?? "")\n  const unusedActor = ({`,
    },
    {
      file: F.calculators,
      find: `      ? await ${KLASS}.${FACTORY}(idxSession.brokerageId, {`,
      replace: `      ? new ${KLASS}(process.env.IDXBROKER_API_KEY ?? "") && new ${KLASS}("") && (null as any) || ({`,
    },
  ],
})

A.push({
  id: "wiring.every-brokerage-id-handed-to-the-factory-traces-to-a-session-or-a-record",
  what:
    "for every `forBrokerage(...)` call in the three action files, the first argument traces — through the assignments in its own function — to `getAgentContext()`, `auth.getUser()`, a `.from(...)` read or the public-slug lookup. An id that traces to a PARAMETER of an exported \"use server\" function is a tenant the caller asserted rather than one the server resolved, and fails; a module-private helper may take it only when every call site in its own file passes a resolved one",
  run: () => {
    const problems: string[] = []
    const trail: string[] = []
    let seenCalls = 0
    for (const file of ACTION_FILES) {
      const src = code(file)
      const fns = functions(src)
      for (const fn of fns) {
        for (const call of factoryCalls(fn.body)) {
          seenCalls++
          const params = paramRoots(fn.params)
          const root = idRoots(call.arg)[0]
          if (!root) { problems.push(`${fn.name}: ${FACTORY}(${call.arg}) has no identifier to trace`); continue }
          const direct = tracesToResolve(fn.body, root, params)
          if (direct.ok) { trail.push(`${fn.name}(${call.arg}) ✓ ${direct.detail.slice(0, 70)}`); continue }
          // Parameter-borne tenant: only defensible for a module-private helper
          // whose every in-file call site passes something itself resolved.
          if (!direct.param) { problems.push(`${fn.name}: ${direct.detail}`); continue }
          if (fn.exported) {
            problems.push(`${fn.name} is EXPORTED and takes its tenant from parameter \`${direct.param}\` — caller-asserted, not resolved`)
            continue
          }
          const index = params.indexOf(direct.param)
          const callers = fns.filter((c) => c.name !== fn.name && new RegExp(`\\b${fn.name}\\s*\\(`).test(c.body))
          if (callers.length === 0) { problems.push(`${fn.name} takes its tenant as a parameter and has no in-file caller to vouch for it`); continue }
          let allGood = true
          for (const c of callers) {
            const m = new RegExp(`\\b${fn.name}\\s*\\(`).exec(c.body)!
            const open = c.body.indexOf("(", m.index + m[0].length - 1)
            const close = matchParen(c.body, open)
            const argList = c.body.slice(open + 1, close === -1 ? open + 200 : close)
            const passed = argList.split(",")[index]?.trim() ?? ""
            const proot = idRoots(passed)[0]
            const sub = proot ? tracesToResolve(c.body, proot, paramRoots(c.params)) : { ok: false, detail: "no identifier passed" }
            if (!sub.ok) { allGood = false; problems.push(`${c.name} passes \`${passed}\` into ${fn.name}: ${sub.detail}`) }
            else trail.push(`${fn.name}(${call.arg}) ✓ via ${c.name}: ${sub.detail.slice(0, 60)}`)
          }
          if (!allGood) continue
        }
      }
    }
    if (seenCalls === 0) return { ok: false, detail: `no ${FACTORY} call found in the action files at all` }
    return problems.length === 0
      ? { ok: true, detail: `${seenCalls} factory call(s), all tenant-resolved — ${trail.join(" | ").slice(0, 260)}` }
      : { ok: false, detail: problems.join(" | ") }
  },
  breaks: [
    {
      // The wave-15 shape: a public "use server" endpoint taking the tenant as a
      // uuid parameter and spending against it.
      file: F.calculators,
      find: `  const idxClient = await ${KLASS}.${FACTORY}(brokerageId, {`,
      replace: `  const idxClient = await ${KLASS}.${FACTORY}((opts as any).brokerageId, {`,
    },
    {
      // The tenant no longer resolved at all — a literal from nowhere.
      file: F.predictions,
      find: `  const client = await ${KLASS}.${FACTORY}(ctx.brokerageId, {`,
      replace: `  const client = await ${KLASS}.${FACTORY}("00000000-0000-0000-0000-000000000000", {`,
    },
    {
      // The record-driven helper handed a caller parameter instead of the row its
      // caller already read.
      file: F.leadIntel,
      find: `  const ownerBrokerageId = (lead?.brokerage_id as string | null | undefined) ?? null`,
      replace: `  const ownerBrokerageId = leadId`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 3 — THE ORDER INSIDE forBrokerage IS THE RULING
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "cascade.the-owner-lookup-is-consulted-before-the-platform-env-key",
  what:
    "inside `forBrokerage`, `resolveScopedConnection` for the idxbroker provider is reached BEFORE `process.env.IDXBROKER_API_KEY`, and the key expression prefers the resolved connection over the env. That order IS the ruling — agent → team → brokerage → platform, THEN the platform env — and reversing the two lines restores the platform-feed bug with every call site still looking correct",
  run: () => {
    const src = code(F.client)
    const fn = findFn(src, FACTORY)
    if (!fn) return { ok: false, detail: `${FACTORY} is no longer a function in ${F.client}` }
    const resolveAt = fn.body.search(/resolveScopedConnection\s*\(/)
    if (resolveAt === -1) return { ok: false, detail: "the factory no longer consults the scoped-connection resolver at all" }
    const provider = /resolveScopedConnection\s*\(\s*["']([^"']+)["']/.exec(fn.body)
    if (!provider || provider[1] !== "idxbroker") {
      return { ok: false, detail: `the resolver is asked for "${provider?.[1] ?? "(nothing)"}", not "idxbroker"` }
    }
    const envAt = fn.body.indexOf("process.env")
    if (envAt === -1) return { ok: false, detail: "the platform env key is not reachable from the factory — a tenant with no connection now has no platform tier at all" }
    if (envAt < resolveAt) return { ok: false, detail: "the env key is read BEFORE the owner cascade — the platform feed wins again" }
    // The key expression itself must prefer the connection.
    const keyLine = /const\s+\w+\s*=\s*([^\n]*process\.env[^\n]*)/.exec(fn.body)
    if (!keyLine) return { ok: false, detail: "the key expression could not be read" }
    const connAt = keyLine[1].search(/\bconn\b|\?\.\s*apiKey/)
    const penvAt = keyLine[1].indexOf("process.env")
    if (connAt === -1) return { ok: false, detail: `the key expression ignores the resolved connection: ${keyLine[1].trim()}` }
    if (connAt > penvAt) return { ok: false, detail: `the env key is preferred over the resolved connection: ${keyLine[1].trim()}` }
    return { ok: true, detail: `resolver@${resolveAt} → env@${envAt}; key = ${keyLine[1].trim().slice(0, 70)}` }
  },
  breaks: [
    {
      file: F.client,
      find: `    const apiKey = conn?.apiKey || process.env.IDXBROKER_API_KEY || ""`,
      replace: `    const apiKey = process.env.IDXBROKER_API_KEY || conn?.apiKey || ""`,
    },
    {
      file: F.client,
      find: `    const conn = await resolveScopedConnection("idxbroker", {`,
      replace: `    const conn = await resolveScopedConnection("rentcast", {`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 4 — THE CONSTRUCTOR NO LONGER LAUNDERS A MISSING ARGUMENT
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "constructor.the-key-is-required-and-the-env-fallback-is-gone",
  what:
    "the constructor's key parameter is REQUIRED — no `?`, no default — and its body reads no `process.env`, so a construction with no owner is a COMPILE error instead of a silent platform-feed read. The env key is named exactly once in the whole module, inside `forBrokerage`: one place decides when the platform tier applies",
  run: () => {
    const src = code(F.client)
    const m = /constructor\s*\(/.exec(src)
    if (!m) return { ok: false, detail: "the client has no constructor" }
    const openParen = src.indexOf("(", m.index!)
    const closeParen = matchParen(src, openParen)
    const params = src.slice(openParen + 1, closeParen)
    if (params.trim() === "") return { ok: false, detail: "the constructor takes nothing — an owner cannot be supplied at all" }
    if (/\?\s*:/.test(params)) return { ok: false, detail: `the key parameter is OPTIONAL again: ${params.trim()}` }
    if (/=\s*[^,)]+/.test(params)) return { ok: false, detail: `the key parameter has a default: ${params.trim()}` }
    const openBrace = src.indexOf("{", closeParen)
    const closeBrace = matchBrace(src, openBrace)
    const body = src.slice(openBrace + 1, closeBrace)
    if (body.includes("process.env")) return { ok: false, detail: "the constructor reads process.env again — a missing argument is laundered back into the platform key" }
    const envHits = [...src.matchAll(/process\.env\.IDXBROKER_API_KEY/g)]
    if (envHits.length === 0) return { ok: false, detail: "the platform env key is gone entirely — the platform tier of the cascade no longer exists" }
    if (envHits.length > 1) return { ok: false, detail: `${envHits.length} readers of the env key — the platform tier is decided in more than one place` }
    const fn = findFn(src, FACTORY)
    if (!fn || !fn.body.includes("process.env.IDXBROKER_API_KEY")) {
      return { ok: false, detail: `the single env read is not inside ${FACTORY}` }
    }
    return { ok: true, detail: `constructor(${params.trim()}), no env; one env read, inside ${FACTORY}` }
  },
  breaks: [
    {
      file: F.client,
      find: `  constructor(apiKey: string) {
    this.apiKey = apiKey`,
      replace: `  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.IDXBROKER_API_KEY ?? ""`,
    },
    {
      // The parameter stays required but the env creeps back in — the same
      // laundering wearing a different shape.
      file: F.client,
      find: `    this.apiKey = apiKey
    if (!this.apiKey) {`,
      replace: `    this.apiKey = apiKey || process.env.IDXBROKER_API_KEY || ""
    if (!this.apiKey) {`,
    },
  ],
})

// ═════════════════════════════════════════════════════════════════════════════
// 5 — THE ARBITER HASN'T MOVED  (synthetic control: scope.ts is not ours to edit)
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "arbiter.scope-ts-still-lists-idxbroker-as-per-tier-connectable",
  what:
    "`lib/connections/scope.ts` still carries `idxbroker` in CONNECTOR_PROVIDERS.listing — the per-tier-connectable domain, agent/team/brokerage/platform. That file is the arbiter this whole wave defers to: it stated the ruling before the ruling was given, and RentCast is deliberately absent from it. If that line is edited the ruling itself has moved, and this proof must fail loudly rather than go on enforcing a rule the source of truth no longer states",
  run: () => listingDomainCarriesIdx(raw(F.scope)),
  breaks: [],
  synthetic: {
    why: `${F.scope} is the arbiter and is outside this slice's write scope — a proof does not get to edit files its author may not edit, so the defect is applied to the REAL file's text in memory instead of on disk`,
    run: () => {
      const real = raw(F.scope)
      // Sanity first: the healthy text must pass, or a RED verdict means nothing.
      const healthy = listingDomainCarriesIdx(real)
      if (!healthy.ok) return { ok: false, detail: `the logic rejects the REAL file: ${healthy.detail}` }
      const defects: Array<[string, string]> = [
        ["idxbroker demoted out of the listing domain", real.replace(/listing:\s*\["idxbroker"\]/, `listing:     []`)],
        ["the listing domain deleted outright", real.replace(/listing:\s*\["idxbroker"\],/, ``)],
        [
          "idxbroker moved into a COMMENT — the exact way a rule stops being enforced while still appearing to be stated",
          real.replace(/listing:\s*\["idxbroker"\]/, `listing:     [] // "idxbroker" lives here`),
        ],
      ]
      const stillGreen: string[] = []
      const reds: string[] = []
      for (const [label, text] of defects) {
        if (text === real) { stillGreen.push(`${label} (MUTATION DID NOT APPLY)`); continue }
        const out = listingDomainCarriesIdx(text)
        if (out.ok) stillGreen.push(label)
        else reds.push(`${label} → ${out.detail}`)
      }
      return stillGreen.length === 0
        ? { ok: true, detail: reds.join(" | ") }
        : { ok: false, detail: `stayed green on: ${stillGreen.join(", ")}` }
    },
  },
})

// ═════════════════════════════════════════════════════════════════════════════
// 6 — THE THREE ACTION FILES STAY BUILDABLE
// ═════════════════════════════════════════════════════════════════════════════

A.push({
  id: "module.the-use-server-files-still-export-only-async-functions",
  what:
    "all three files carry the \"use server\" directive, so Next.js fails page-data collection on ANY value export from them (\"a use server file can only export async functions\") — and the compile step does not surface it. Repointing nine sites added a file-local resolver to ai-predictions.ts; it stays unexported, and every export in all three files stays an async function",
  run: () => {
    const problems: string[] = []
    const trail: string[] = []
    for (const file of ACTION_FILES) {
      const src = code(file)
      if (!/^\s*["']use server["']/m.test(src.split("\n").slice(0, 6).join("\n"))) {
        problems.push(`${file} no longer carries the "use server" directive — this proof is aimed at the wrong shape`)
        continue
      }
      const bad: string[] = []
      for (const line of src.split("\n")) {
        const m = /^export\s+(const|class|let|var|enum|function)\s+([A-Za-z0-9_$]+)/.exec(line)
        if (!m) continue
        if (m[1] === "function") { bad.push(`export function ${m[2]} — not async`); continue }
        if (!/=\s*async\b/.test(line)) bad.push(`export ${m[1]} ${m[2]}`)
      }
      const asyncFns = [...src.matchAll(/^export\s+async\s+function\s+([A-Za-z0-9_$]+)/gm)].length
      if (bad.length) problems.push(`${file}: ${bad.join(", ")}`)
      else trail.push(`${file} (${asyncFns} async exports)`)
    }
    return problems.length === 0
      ? { ok: true, detail: trail.join(", ") }
      : { ok: false, detail: problems.join(" | ") }
  },
  breaks: [
    {
      file: F.predictions,
      find: `async function idxForCallerBrokerage(surface: string) {`,
      replace: `export const IDX_RESOLVER_SURFACES = 6\nasync function idxForCallerBrokerage(surface: string) {`,
    },
    {
      file: F.calculators,
      find: `export async function compareNeighborhoods(`,
      replace: `export function compareNeighborhoods(`,
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
  preCheck("a line comment is removed", !strip(`const a = 1 // new ${KLASS}()`).includes(KLASS))
  preCheck("a block comment is removed", !strip(`/* new ${KLASS}()\n more */ const a = 1`).includes(KLASS))
  preCheck("a // inside a double-quoted string survives", strip(`const u = "https://x/y"`).includes("https://x/y"))
  preCheck("a // inside a template literal survives", strip("const u = `https://x/y`").includes("https://x/y"))
  preCheck(
    "the files under test really do quote the defect in prose (so stripping is load-bearing, not decorative)",
    new RegExp(`new\\s+${KLASS}\\s*\\(\\s*\\)`).test(raw(F.predictions)) &&
      !new RegExp(`new\\s+${KLASS}\\s*\\(\\s*\\)`).test(code(F.predictions)),
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
      if (a.breaks.length === 0 && !a.synthetic) {
        negFail++
        negProblems.push(`${a.id}: assertion with NO negative control`)
        console.log(`  ✘ ${a.id}  no negative control defined`)
        continue
      }
      if (a.synthetic) {
        let r: Outcome
        try { r = a.synthetic.run() } catch (e) { r = { ok: false, detail: `threw: ${(e as Error).message}` } }
        if (r.ok) {
          negPass++
          console.log(`  ✔ ${a.id}[synthetic]  the logic goes RED on every defective input — SYNTHETIC CONTROL, weaker than a tree mutation\n      why: ${a.synthetic.why}\n      → ${r.detail ?? ""}`)
        } else {
          negFail++
          negProblems.push(`${a.id}[synthetic]: ${r.detail ?? "did not go red"}`)
          console.log(`  ✘ ${a.id}[synthetic]  ${r.detail ?? "did not go red"}`)
        }
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
        const applied = onDisk !== before && (b.replace === "" || onDisk.includes(b.replace.split("\n")[0]))
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

  if (fail > 0 || negFail > 0 || preFail > 0) { console.log("\n ❌ IDX_TENANT_CREDENTIAL_FAIL"); process.exit(1) }
  console.log(
    "\n ✅ IDX_TENANT_CREDENTIAL_PASS — every IDX Broker read in the tree goes through the owner cascade, all nine repointed sites resolve their tenant from a session or a record rather than from a caller, the platform env key is consulted last and in exactly one place, and the arbiter still says idxbroker is the tenant's to connect",
  )
}
main()
