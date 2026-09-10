#!/usr/bin/env tsx
/**
 * scripts/hidden-wire-census.ts  (npm run test:hidden-wires)
 * ─────────────────────────────────────────────────────────────────────────────
 * HIDDEN WIRES — the ones every other census in scripts/ is structurally blind to.
 *
 * orphan-export-guard.ts asks "is this export referenced ANYWHERE" (a barrel
 * re-export counts, by design, and it says so). readerless-write-census.ts and
 * opposite-missing-census.ts work at the TABLE and CAPABILITY level. None of
 * them asks the smaller, cheaper question this file asks: inside ONE file, did
 * an import actually get used, and does a React component's declared surface
 * match what its callers actually pass and read. Five categories:
 *
 *   (a) IMPORTED-BUT-UNUSED   — an import specifier this file never references
 *       again. The cheapest possible one-sided wire: a read that names a
 *       capability and then never touches it.
 *   (b) IMPORTED-BUT-ONLY-FORWARDED — a LOCAL export this repo defines, pulled
 *       into an importer, that the importer only re-exports (`export { X }`)
 *       without ever calling or reading it. Passes (a)'s bar — the name IS
 *       referenced — and orphan-export-guard's bar — the barrel makes it
 *       "referenced" — while still never touching real code in that importer.
 *   (c) PROPS DRIFT — a component's declared Props naming keys no caller ever
 *       passes, and keys callers DO pass that the component's body never reads
 *       (children/anchors: declared AND passed, rendered nowhere).
 *   (d) RPC WIRING — `.rpc("name")` call sites with no `CREATE [OR REPLACE]
 *       FUNCTION name` anywhere in supabase/migrations, and the reverse: a
 *       migration-defined function nothing calls via `.rpc()`.
 *   (e) DEAD SERVER-ACTION IMPORT — a "use server" export pulled into a
 *       "use client" file that never references it again. A SUBSET of (a),
 *       reported separately because CLAUDE.md §4 makes every "use server"
 *       export a public HTTP endpoint: an unused import here is a client
 *       bundle naming a live network door it never opens, not just dead code.
 *
 * ── MEASUREMENT DISCIPLINE (CLAUDE.md §2) ───────────────────────────────────
 * Every scan reads `blankStrings()` output (scripts/strip-comments.ts): comments
 * gone, string/template CONTENTS blanked (delimiters kept, `${…}` interpolation
 * left as code), offsets and line numbers IDENTICAL to the raw file — so a match
 * index found in the masked text slices the real source correctly (needed to
 * recover an import's actual module specifier, which blankStrings blanks). This
 * is the exact discipline the orphan doctrine's Measurement section names: a
 * tombstone comment naming a survivor must never read as a live call site, and
 * a narrative string must never read as a reference.
 *
 * Positive controls run FIRST, every invocation, and each names the defect it
 * stands over — see runControls() below. If a control fails, the run aborts
 * before printing a number that would read as a clean bill of health.
 *
 * ── STATED BLIND SPOTS (published beside every count, not just here) ────────
 *   · (a)/(b)/(e): dynamic `require()`/`import()` of a name only reachable by
 *     string key, and identifiers shadowed by a same-named local redeclaration,
 *     read as used/unused by textual presence alone — no scope resolution.
 *   · (b): `export * from` wildcard re-exports are NOT modeled as passthrough
 *     zones. That is the safe direction for THIS category — a name that flows
 *     through one and is genuinely used downstream still contains the literal
 *     identifier at its use site, which this scan still finds as a "real use"
 *     wherever that use actually is (namespace member access `NS.X` keeps the
 *     literal token and a boundary match still sees it) — so no false negative
 *     is introduced by leaving wildcards unparsed. Names declared with the same
 *     export identifier in more than one file in the scanned corpus are skipped
 *     entirely (ambiguous attribution), and named in the blind-spot count.
 *   · (c): only the `<Name>Props` naming convention is read for a Props type,
 *     and only `interface NameProps {}` / `type NameProps = {}` shapes (one
 *     level of nested `{}` is balanced, deeper nesting is not). A component
 *     with a rest/spread destructure (`{...rest}` / `{...props}`) is EXCLUDED
 *     from the "declared but never read" half — spread absorbs anything, so
 *     "unread" cannot be proven. JSX call sites are matched textually
 *     (`<Name ...`) with brace-depth-aware attribute scanning, not a real JSX
 *     parser — a spread attribute (`{...x}`) on a caller hides whatever it
 *     carries from the "declared but never passed" half for THAT call site
 *     (other, non-spread call sites still count). `children` and `className`
 *     are excluded from "passed but never read" — both are legitimately
 *     consumed by ancestor wrapper behaviour (layout components, forwardRef
 *     wrappers) this scan cannot see.
 *   · (d): a dynamically-built `.rpc(variable)` name is invisible. A function
 *     created outside supabase/migrations/*.sql (dashboard-authored, or by an
 *     extension) false-positives as "missing a migration". Trigger and
 *     RLS-internal functions are real "never called via .rpc()" but are not a
 *     finding — the DEFINED-BUT-UNCALLED list says so and is not itself scored.
 *   · Roots scanned for (a)/(b)/(c)/(e): app/, lib/, hooks/ — per task scope.
 *     A hidden wire whose only end sits in scripts/, e2e/, remotion/ or
 *     constants/ is outside this census, same boundary orphan-export-guard
 *     documents for NON_RUNTIME_EXPORT_ROOTS.
 *
 * Baseline: HIDDEN_WIRE_BASELINE=1 npx tsx scripts/hidden-wire-census.ts
 * --list-a / --list-b / --list-c-declared / --list-c-unread / --list-d-missing /
 * --list-d-unused / --list-e print the raw finding keys (grep target for the
 * per-lane "is this name gone" verification CLAUDE.md §7 asks for).
 */
import { readFileSync, existsSync, statSync, writeFileSync, readdirSync } from "node:fs"
import { join, relative, dirname, normalize } from "node:path"
import { walkTs } from "./runtime-roots"
import { stripComments, blankComments, blankStrings } from "./strip-comments"

const root = process.cwd()
const BASELINE_PATH = join(root, "scripts", "hidden-wire-baseline.json")
const ARGS = new Set(process.argv.slice(2))

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*"
function isIdent(s: string): boolean { return new RegExp(`^${IDENT}$`).test(s) }
function boundaryRe(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?<![A-Za-z0-9_$])${esc}(?![A-Za-z0-9_$])`, "g")
}
function lineOf(text: string, idx: number): number {
  let n = 1
  for (let i = 0; i < idx && i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}
function blankRange(text: string, start: number, end: number): string {
  return text.slice(0, start) + " ".repeat(end - start) + text.slice(end)
}

// ── CORPUS ───────────────────────────────────────────────────────────────────
function listFiles(...dirs: string[]): string[] {
  const out: string[] = []
  for (const d of dirs) {
    for (const p of walkTs(join(root, d))) {
      if (/\.d\.ts$/.test(p)) continue
      out.push(relative(root, p).replace(/\\/g, "/"))
    }
  }
  return out.sort()
}

const FILES = listFiles("app", "lib", "hooks")
const raw = new Map<string, string>()
const masked = new Map<string, string>() // blankStrings — offsets aligned with raw
// comments blanked to SPACES (offsets aligned with raw), STRING CONTENT INTACT —
// for reading literals a line-number needs to stay accurate about, e.g. .rpc("name")
const commentsBlanked = new Map<string, string>()
for (const f of FILES) {
  const r = readFileSync(join(root, f), "utf8")
  raw.set(f, r)
  masked.set(f, blankStrings(r))
  commentsBlanked.set(f, blankComments(r))
}

function firstStatement(stripped: string): string {
  for (const line of stripped.split("\n")) {
    const t = line.trim()
    if (t.length > 0) return t
  }
  return ""
}
const directiveCache = new Map<string, "server" | "client" | "none">()
function directive(file: string): "server" | "client" | "none" {
  const hit = directiveCache.get(file)
  if (hit) return hit
  const first = firstStatement(stripComments(raw.get(file) ?? ""))
  const v = /^["']use server["'];?$/.test(first) ? "server" : /^["']use client["'];?$/.test(first) ? "client" : "none"
  directiveCache.set(file, v)
  return v
}

// ── IMPORT PARSING (shared by a, b, e) ─────────────────────────────────────
interface ImportSpec { name: string; isType: boolean }
interface ParsedImport { stmtStart: number; stmtEnd: number; specs: ImportSpec[]; modulePath: string }

// The negative lookahead `(?!['"])` is load-bearing, not decorative: without it a
// bare SIDE-EFFECT import (`import "server-only"`, no `from` clause of its own)
// lets the lazy `[\s\S]*?` run straight past it looking for the next " from " in
// the file — which is often an UNRELATED `export { X } from "./y"` several lines
// below, whose brace list then gets parsed as this file's "named imports". Found
// live: lib/communication/call-compliance.ts and lib/kernel/index.ts both open
// with `import "server-only"` immediately followed by an `export {…} from` line,
// and the unguarded regex reported ensureAiDisclosure/withAiCallDisclosures and
// KernelEvent as "imported but unused" at the `import "server-only"` line — full
// CLAUDE.md §2 shape: a masking defect that does not go quiet, it accuses live,
// wired re-exports of being dead imports. The lookahead refuses to start a match
// where the very next non-whitespace character is a quote, so `import "x"` (no
// binding, nothing to check) is correctly seen as importing NOTHING and the
// regex engine moves on to the next real `import` keyword instead of running away.
const IMPORT_STMT_RE = /import\s+(?:type\s+)?(?!['"])([\s\S]*?)\s+from\s*(['"])([^'"]*)\2\s*;?/g

function parseImportClause(clause: string): ImportSpec[] {
  const out: ImportSpec[] = []
  const trimmed = clause.trim()
  const ns = trimmed.match(new RegExp(`^\\*\\s*as\\s+(${IDENT})$`))
  if (ns) { out.push({ name: ns[1], isType: false }); return out }
  const braceIdx = trimmed.indexOf("{")
  const defaultPart = braceIdx === -1 ? trimmed : trimmed.slice(0, braceIdx).replace(/,\s*$/, "").trim()
  const namedPart = braceIdx === -1 ? null : trimmed.slice(braceIdx + 1, trimmed.lastIndexOf("}"))
  if (defaultPart && isIdent(defaultPart)) out.push({ name: defaultPart, isType: false })
  if (namedPart != null) {
    for (const piece of namedPart.split(",")) {
      let spec = piece.trim()
      if (!spec) continue
      let isType = false
      if (/^type\s+/.test(spec)) { isType = true; spec = spec.replace(/^type\s+/, "").trim() }
      const asMatch = spec.match(new RegExp(`^(${IDENT})\\s+as\\s+(${IDENT})$`))
      const name = asMatch ? asMatch[2] : spec
      if (isIdent(name)) out.push({ name, isType })
    }
  }
  return out
}

const importCache = new Map<string, ParsedImport[]>()
function parseImports(file: string): ParsedImport[] {
  const hit = importCache.get(file)
  if (hit) return hit
  const m2 = masked.get(file)!
  const r = raw.get(file)!
  const out: ParsedImport[] = []
  IMPORT_STMT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMPORT_STMT_RE.exec(m2))) {
    const clause = m[1]
    const specs = parseImportClause(clause)
    const stmtStart = m.index
    const stmtEnd = m.index + m[0].length
    const modulePath = r.slice(m.index, stmtEnd) // recover from RAW (masked blanked the path content)
      .match(/from\s*['"]([^'"]*)['"]/)?.[1] ?? ""
    out.push({ stmtStart, stmtEnd, specs, modulePath })
  }
  importCache.set(file, out)
  return out
}

// bodyForRefs: masked text with every import statement's own range blanked out,
// so a name's declaration line in its OWN import never counts as its own use.
const bodyForRefsCache = new Map<string, string>()
function bodyForRefs(file: string): string {
  const hit = bodyForRefsCache.get(file)
  if (hit !== undefined) return hit
  let body = masked.get(file)!
  for (const imp of parseImports(file)) body = blankRange(body, imp.stmtStart, imp.stmtEnd)
  bodyForRefsCache.set(file, body)
  return body
}

// ── CATEGORY (a): IMPORTED BUT UNUSED ───────────────────────────────────────
interface UnusedImport { file: string; name: string; line: number; modulePath: string; isType: boolean }
const categoryA: UnusedImport[] = []
let totalImportBindings = 0
for (const file of FILES) {
  const body = bodyForRefs(file)
  for (const imp of parseImports(file)) {
    for (const spec of imp.specs) {
      totalImportBindings++
      if (!boundaryRe(spec.name).test(body)) {
        categoryA.push({ file, name: spec.name, line: lineOf(raw.get(file)!, imp.stmtStart), modulePath: imp.modulePath, isType: spec.isType })
      }
    }
  }
}

// ── CATEGORY (e): DEAD SERVER-ACTION IMPORT (a filtered VIEW of a) ─────────
function resolveModule(fromFile: string, modulePath: string): string | null {
  if (!modulePath.startsWith(".") && !modulePath.startsWith("@/")) return null // package import, not ours
  const base = modulePath.startsWith("@/")
    ? join(root, modulePath.slice(2))
    : join(root, dirname(fromFile), modulePath)
  const candidates = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]
  for (const c of candidates) {
    const rel = relative(root, normalize(c)).replace(/\\/g, "/")
    if (raw.has(rel)) return rel // in-memory corpus first (also what the (b) rescue control relies on)
    try { if (statSync(c).isFile()) return rel } catch { /* keep looking */ }
  }
  return null
}
function readAnyFile(rel: string): string {
  const cached = raw.get(rel)
  if (cached !== undefined) return cached
  try { return readFileSync(join(root, rel), "utf8") } catch { return "" }
}
function directiveOfPath(rel: string): "server" | "client" | "none" {
  if (raw.has(rel)) return directive(rel)
  const first = firstStatement(stripComments(readAnyFile(rel)))
  return /^["']use server["'];?$/.test(first) ? "server" : /^["']use client["'];?$/.test(first) ? "client" : "none"
}

const categoryE: UnusedImport[] = []
for (const u of categoryA) {
  if (directive(u.file) !== "client") continue
  const target = resolveModule(u.file, u.modulePath)
  if (!target) continue
  if (directiveOfPath(target) === "server") categoryE.push(u)
}

// ── CATEGORY (b): IMPORTED BUT ONLY FORWARDED ───────────────────────────────
const EXPORT_FN = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g
const EXPORT_ARROW = /export\s+const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g
const EXPORT_REEXPORT_RE = /export\s+(?:type\s+)?\{[^}]*\}\s*(?:from\s*['"][^'"]*['"])?;?/g

const exportDeclaringFiles = new Map<string, string[]>() // name -> declaring files
for (const file of FILES) {
  const m2 = masked.get(file)!
  for (const re of [EXPORT_FN, EXPORT_ARROW]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(m2))) {
      const arr = exportDeclaringFiles.get(m[1]) ?? []
      arr.push(file)
      exportDeclaringFiles.set(m[1], arr)
    }
  }
}

function passthroughRangesFromText(m2: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  EXPORT_REEXPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = EXPORT_REEXPORT_RE.exec(m2))) out.push([m.index, m.index + m[0].length])
  return out
}
function passthroughRanges(file: string): Array<[number, number]> {
  return passthroughRangesFromText(masked.get(file)!)
}

interface ForwardedOnly { file: string; name: string; declaredIn: string; line: number }
const categoryBRaw: ForwardedOnly[] = []
let ambiguousExportNames = 0
let candidateFunctionExports = 0
for (const [name, declaringFiles] of exportDeclaringFiles) {
  if (declaringFiles.length > 1) { ambiguousExportNames++; continue } // skip: cannot attribute
  const declaredIn = declaringFiles[0]
  candidateFunctionExports++
  for (const file of FILES) {
    if (file === declaredIn) continue
    const imports = parseImports(file)
    const importsIt = imports.some((imp) => imp.specs.some((s) => s.name === name))
    if (!importsIt) continue
    const body = bodyForRefs(file)
    if (!boundaryRe(name).test(body)) continue // already category (a) — not double-counted here
    const ranges = passthroughRanges(file)
    const re = boundaryRe(name)
    let allInsidePassthrough = true
    let m: RegExpExecArray | null
    let sawOne = false
    while ((m = re.exec(body))) {
      sawOne = true
      const idx = m.index
      if (!ranges.some(([s, e]) => idx >= s && idx < e)) { allInsidePassthrough = false; break }
    }
    if (sawOne && allInsidePassthrough) {
      const impStmt = imports.find((imp) => imp.specs.some((s) => s.name === name))!
      categoryBRaw.push({ file, name, declaredIn, line: lineOf(raw.get(file)!, impStmt.stmtStart) })
    }
  }
}

/**
 * ONE-HOP RESCUE. A raw finding says "F imports X and only re-exports it" — TRUE
 * of the standard `"use server"` action-barrel pattern (lib holds the logic,
 * app/actions/*.ts imports it and `export { X }`s it so a client can call it as
 * a server action) on every ordinary day it is ALSO genuinely wired. Measured
 * live on the first cut of this census: app/actions/marketing-studio.ts forwards
 * six functions this way and every one of them is called for real from
 * app/dashboard/marketing/studio/marketing-studio-client.tsx — which imports
 * them FROM THE ACTION FILE, not from the lib module. A raw finding that did not
 * chase that one hop would have accused six live, wired capabilities of being
 * dead — the exact JSDoc-tombstone failure shape CLAUDE.md §2 names by name,
 * with the accusing code one hop short of the truth instead of a comment.
 *
 * So before a raw finding is reported, this asks: does ANY other file import X
 * with a module specifier that resolves to the forwarder F, and reference X for
 * real (outside ITS OWN passthrough ranges) once it has? If yes, F's forwarding
 * is a working two-hop wire, not a dead one, and the finding is dropped.
 *
 * BLIND SPOT, stated rather than chased further: only ONE hop past the
 * forwarder is followed. A capability forwarded twice (F1 re-exports from
 * declaredIn, F2 re-exports from F1, and only F2's importer calls it for real)
 * still reports F1 as a finding — this under-reports false alarms one link
 * deeper than measured here, never over-reports one that is actually live one
 * hop out, which is the direction this correction was made to fix.
 */
function hasRealUseOutsidePassthrough(file: string, name: string): boolean {
  const body = bodyForRefs(file)
  const ranges = passthroughRanges(file)
  const re = boundaryRe(name)
  let m: RegExpExecArray | null
  while ((m = re.exec(body))) {
    if (!ranges.some(([s, e]) => m!.index >= s && m!.index < e)) return true
  }
  return false
}
function isRescuedByDownstreamConsumer(forwarderFile: string, name: string): boolean {
  for (const g of FILES) {
    if (g === forwarderFile) continue
    const imp = parseImports(g).find((i) => i.specs.some((s) => s.name === name))
    if (!imp) continue
    if (resolveModule(g, imp.modulePath) !== forwarderFile) continue
    if (hasRealUseOutsidePassthrough(g, name)) return true
  }
  return false
}
let rescuedByOneHop = 0
const categoryB: ForwardedOnly[] = []
for (const f of categoryBRaw) {
  if (isRescuedByDownstreamConsumer(f.file, f.name)) { rescuedByOneHop++; continue }
  categoryB.push(f)
}

// ── CATEGORY (c): PROPS DRIFT ───────────────────────────────────────────────
const BUSINESS_CARD_RE = /business[-_]?card/i
const TSX_FILES = FILES.filter((f) => f.endsWith(".tsx") && !BUSINESS_CARD_RE.test(f) && !f.startsWith("remotion/") && !f.startsWith("lib/video/"))

function matchBalanced(text: string, openIdx: number, open: string, close: string): number {
  let depth = 0
  for (let i = openIdx; i < text.length; i++) {
    if (text[i] === open) depth++
    else if (text[i] === close) { depth--; if (depth === 0) return i }
  }
  return -1
}

/**
 * The NAMES a `({ a, b: renamed, c = 1, ...rest })` destructuring parameter
 * pulls off its Props object — as PROP names (the key side of a rename, not
 * the local binding), since that is what "was this prop read" has to compare
 * against `declaredProps`/`passed` by.
 *
 * REPLACES a single consume-as-you-go regex
 * (`/(?:^|[{,])…([A-Za-z_$]+)…(?:,|\})/g`) that measurably DROPPED every prop
 * sitting between two others: matching `partnerType,` consumed that trailing
 * comma as part of the match, so the NEXT search's `(?:^|[{,])` had no comma
 * left immediately before `partnerId` to anchor on — it skipped forward to
 * the comma AFTER `partnerId` and captured `files` instead. `partnerId` was
 * destructured, genuinely read three lines later, and reported "passed but
 * never read" purely because its neighbours' delimiters were eaten first.
 * Measured live: this was the dominant contributor to the 982-entry
 * passed-never-read count (see the census report for the corrected number).
 * Splitting depth-0 on `,` (this function's own technique, shared with
 * propNamesFromTypeBody just above) never has this problem — each comma is
 * read exactly once, as a separator, never as part of either neighbour.
 */
function destructuredPropNames(paramText: string): { names: string[]; hasSpread: boolean } {
  const braceStart = paramText.indexOf("{")
  if (braceStart === -1) return { names: [], hasSpread: false }
  const braceEnd = matchBalanced(paramText, braceStart, "{", "}")
  if (braceEnd === -1) return { names: [], hasSpread: false }
  const inner = paramText.slice(braceStart + 1, braceEnd)
  const names: string[] = []
  let hasSpread = false
  let depth = 0
  let segStart = 0
  const flush = (end: number) => {
    const seg = inner.slice(segStart, end).trim()
    segStart = end + 1
    if (!seg) return
    if (seg.startsWith("...")) { hasSpread = true; return }
    const m = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(seg)
    if (m) names.push(m[1]) // the KEY side — a rename's local binding is irrelevant to "was the PROP read"
  }
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]
    if (ch === "=" && inner[i + 1] === ">") { i++; continue }
    if (ch === "{" || ch === "(" || ch === "<" || ch === "[") depth++
    else if (ch === "}" || ch === ")" || ch === ">" || ch === "]") depth = Math.max(0, depth - 1)
    else if (depth === 0 && ch === ",") flush(i)
  }
  flush(inner.length)
  return { names, hasSpread }
}
/**
 * TOP-LEVEL PROPERTY NAMES ONLY — depth-0, not "any `key:` anywhere in the body".
 *
 * Measured live: ExternalBatchActionsPanelProps declares
 * `onBatchConfirm?: (ids: string[]) => Promise<{ success: boolean; count:
 * number; error?: string }>` — a CALLBACK prop whose RETURN TYPE is an inline
 * object literal. A regex that matches `identifier:` anywhere in the type body
 * cannot tell that return type's `success`/`count`/`error` from a real sibling
 * Prop, and reported all three as "declared props no caller passes" on a
 * component that has exactly one caller and passes everything it declares at
 * the top level. Three such callback props (onBatchConfirm/onBatchUpdate/
 * onBatchSend) sharing one return shape were enough to seed the SAME three
 * phantom names across dozens of unrelated panels once deduped by name — the
 * measurable chunk of the original 898/982 counts this fix corrects. Splitting
 * the body into DEPTH-0 segments (bounded by `;`, `,` or a bare newline while
 * `{`/`(`/`<`/`[` are balanced) and only reading the FIRST identifier of each
 * segment fixes it: a nested return-type's fields live at depth ≥1 and are
 * never a segment's first token.
 */
function propNamesFromTypeBody(body: string): string[] {
  const out: string[] = []
  let depth = 0
  let segStart = 0
  const nameRe = /^\s*(?:readonly\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*:/
  const flush = (end: number) => {
    const m = nameRe.exec(body.slice(segStart, end))
    if (m) out.push(m[1])
    segStart = end + 1
  }
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    // `=>` (arrow-function TYPE, e.g. `onSave?: (x) => Promise<{…}>`) carries a bare
    // `>` that is NOT closing a generic — counting it as one desyncs depth for every
    // callback prop's return type and was caught by this function's own control.
    if (ch === "=" && body[i + 1] === ">") { i++; continue }
    if (ch === "{" || ch === "(" || ch === "<" || ch === "[") depth++
    else if (ch === "}" || ch === ")" || ch === ">" || ch === "]") depth = Math.max(0, depth - 1)
    else if (depth === 0 && (ch === ";" || ch === "," || ch === "\n")) flush(i)
  }
  flush(body.length)
  return [...new Set(out)]
}

interface PropsType { component: string; declaredProps: string[] }
const propsTypes: PropsType[] = []
for (const file of TSX_FILES) {
  const m2 = masked.get(file)!
  const re = /(?:interface|type)\s+([A-Za-z0-9_$]+Props)\b[^{=]*(?:=\s*)?\{/g
  let m: RegExpExecArray | null
  while ((m = re.exec(m2))) {
    const openBraceIdx = m.index + m[0].length - 1
    const closeIdx = matchBalanced(m2, openBraceIdx, "{", "}")
    if (closeIdx === -1) continue
    const body = m2.slice(openBraceIdx + 1, closeIdx)
    const component = m[1].replace(/Props$/, "")
    propsTypes.push({ component, declaredProps: propNamesFromTypeBody(body) })
  }
}

function findFunctionSignature(m2: string, component: string): { paramStart: number; paramEnd: number } | null {
  const patterns = [
    new RegExp(`function\\s+${component}\\s*(?:<[^>]*>)?\\s*\\(`),
    new RegExp(`const\\s+${component}\\s*(?::[^=]+)?=\\s*(?:React\\.)?(?:memo|forwardRef)?\\(?\\s*(?:<[^>]*>)?\\s*\\(`),
  ]
  for (const p of patterns) {
    const m = m2.match(p)
    if (!m || m.index === undefined) continue
    const openIdx = m.index + m[0].length - 1
    const closeIdx = matchBalanced(m2, openIdx, "(", ")")
    if (closeIdx === -1) continue
    return { paramStart: openIdx, paramEnd: closeIdx }
  }
  return null
}

interface CDeclaredNeverPassed { component: string; prop: string; declaredIn: string }
interface CPassedNeverRead { component: string; prop: string; declaredIn: string }
const categoryCDeclared: CDeclaredNeverPassed[] = []
const categoryCUnread: CPassedNeverRead[] = []
const EXEMPT_UNREAD = new Set(["children", "className"])

// Pre-scan all JSX call sites once: component name -> attribute names (unioned) and hasSpread
const callSiteAttrs = new Map<string, Set<string>>()
const callSiteHasSpread = new Map<string, boolean>()
const callSiteCount = new Map<string, number>()
for (const file of TSX_FILES) {
  const m2 = masked.get(file)!
  const tagRe = /<([A-Z][A-Za-z0-9_$]*)[\s/>]/g
  let tm: RegExpExecArray | null
  while ((tm = tagRe.exec(m2))) {
    const name = tm[1]
    const tagStart = tm.index
    // find the end of the opening tag: first '>' at brace-depth 0 from tagStart
    let depth = 0, end = -1
    for (let i = tagStart; i < m2.length; i++) {
      const ch = m2[i]
      if (ch === "{") depth++
      else if (ch === "}") depth--
      else if (ch === ">" && depth === 0) { end = i; break }
    }
    if (end === -1) continue
    const attrText = m2.slice(tagStart + tm[0].length, end)
    callSiteCount.set(name, (callSiteCount.get(name) ?? 0) + 1)
    if (/\.\.\./.test(attrText)) callSiteHasSpread.set(name, true)
    const attrRe = /([A-Za-z_][A-Za-z0-9_-]*)\s*=/g
    let am: RegExpExecArray | null
    const set = callSiteAttrs.get(name) ?? new Set<string>()
    while ((am = attrRe.exec(attrText))) set.add(am[1])
    callSiteAttrs.set(name, set)
  }
}

let componentsWithSignature = 0
let componentsWithSpread = 0
for (const pt of propsTypes) {
  const declFile = TSX_FILES.find((f) => {
    const m2 = masked.get(f)!
    return new RegExp(`function\\s+${pt.component}\\b|const\\s+${pt.component}\\s*(?::|=)`).test(m2)
  })
  if (!declFile) continue
  const m2 = masked.get(declFile)!
  const sig = findFunctionSignature(m2, pt.component)
  if (!sig) continue
  componentsWithSignature++
  const paramText = m2.slice(sig.paramStart, sig.paramEnd + 1)
  const { names: destructuredNames, hasSpread } = destructuredPropNames(paramText)
  const destructured = new Set<string>(destructuredNames)
  // find the function BODY to also catch `props.foo` reads when not destructured
  let bodyText = ""
  const braceIdx = m2.indexOf("{", sig.paramEnd)
  if (braceIdx !== -1) {
    const bodyClose = matchBalanced(m2, braceIdx, "{", "}")
    if (bodyClose !== -1) bodyText = m2.slice(braceIdx, bodyClose)
  }
  const paramNameMatch = paramText.match(/^\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/)
  const bareParamName = paramNameMatch ? paramNameMatch[1] : null

  const readProps = new Set(destructured)
  if (bareParamName) {
    const accessRe = new RegExp(`${bareParamName}\\.([A-Za-z_$][A-Za-z0-9_$]*)`, "g")
    let acc: RegExpExecArray | null
    while ((acc = accessRe.exec(bodyText))) readProps.add(acc[1])
  }

  const called = callSiteCount.get(pt.component) ?? 0
  const passed = callSiteAttrs.get(pt.component) ?? new Set<string>()
  const spreadAtCallSite = callSiteHasSpread.get(pt.component) ?? false
  if (hasSpread) componentsWithSpread++

  if (called > 0 && !spreadAtCallSite) {
    for (const p of pt.declaredProps) {
      if (!passed.has(p)) categoryCDeclared.push({ component: pt.component, prop: p, declaredIn: declFile })
    }
  }
  if (!hasSpread) {
    for (const p of passed) {
      if (EXEMPT_UNREAD.has(p)) continue
      if (pt.declaredProps.includes(p) && !readProps.has(p)) {
        categoryCUnread.push({ component: pt.component, prop: p, declaredIn: declFile })
      }
    }
  }
}

// ── CATEGORY (d): RPC WIRING ─────────────────────────────────────────────────
// TOMBSTONE (orphan doctrine §1.1) — this subsumes scripts/rpc-census-z1.ts
// (unregistered, zero callers anywhere in the tree — verified: no npm script,
// no import, no CI reference). Same question, same `.rpc("name")` vs
// `CREATE [OR REPLACE] FUNCTION name` comparison, now registered as a ratchet
// proof and cross-checked against m612's own caller list. rpc-census-z1.ts is
// deleted with this file as its survivor.
const rpcCalls = new Map<string, string[]>()
for (const file of FILES) {
  if (!file.startsWith("app/") && !file.startsWith("lib/")) continue
  const s2 = commentsBlanked.get(file)! // comments blanked, STRING CONTENT INTACT — the rpc name IS a string literal
  const re = /\.rpc\(\s*["']([a-zA-Z0-9_]+)["']/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s2))) {
    const arr = rpcCalls.get(m[1]) ?? []
    arr.push(`${file}:${lineOf(raw.get(file)!, m.index)}`)
    rpcCalls.set(m[1], arr)
  }
}
function migrationFiles(): string[] {
  try {
    return readdirSync(join(root, "supabase", "migrations"))
      .filter((f: string) => f.endsWith(".sql"))
      .map((f: string) => join("supabase", "migrations", f))
  } catch { return [] }
}
const definedFns = new Set<string>()
for (const rel of migrationFiles()) {
  const sql = readFileSync(join(root, rel), "utf8").replace(/--[^\n]*/g, "")
  const re = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-zA-Z0-9_]+)"?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql))) definedFns.add(m[1])
}
const categoryDMissing: string[] = [] // called, no migration defines it
const categoryDUnused: string[] = []  // defined in migrations, never called
for (const [name] of rpcCalls) if (!definedFns.has(name)) categoryDMissing.push(name)
for (const name of definedFns) if (!rpcCalls.has(name)) categoryDUnused.push(name)

// ── POSITIVE CONTROLS (CLAUDE.md §2) ────────────────────────────────────────
function runControls(): string[] {
  const bad: string[] = []
  const ok = (claim: string, held: boolean) => { if (!held) bad.push(claim) }

  // (a) an unused named import is found; a used one is not; a default+named mix works
  {
    const spec = 'import { usedThing, deadThing } from "./x"\nimport DefaultOne, { alsoUsed } from "./y"\nconsole.log(usedThing, alsoUsed, DefaultOne)\n'
    const m2 = blankStrings(spec)
    let body = m2
    const imps: ParsedImport[] = []
    IMPORT_STMT_RE.lastIndex = 0
    let mm: RegExpExecArray | null
    while ((mm = IMPORT_STMT_RE.exec(m2))) {
      imps.push({ stmtStart: mm.index, stmtEnd: mm.index + mm[0].length, specs: parseImportClause(mm[1]), modulePath: "" })
    }
    for (const imp of imps) body = blankRange(body, imp.stmtStart, imp.stmtEnd)
    const names = imps.flatMap((i) => i.specs.map((s) => s.name))
    ok("(a) control: finds usedThing, deadThing, DefaultOne, alsoUsed as import bindings",
      ["usedThing", "deadThing", "DefaultOne", "alsoUsed"].every((n) => names.includes(n)))
    ok("(a) control: deadThing is flagged unused", !boundaryRe("deadThing").test(body))
    ok("(a) control: usedThing/DefaultOne/alsoUsed are NOT flagged unused",
      boundaryRe("usedThing").test(body) && boundaryRe("DefaultOne").test(body) && boundaryRe("alsoUsed").test(body))
  }

  // (a) a bare side-effect import must NOT let the parser run away to a distant,
  // unrelated `export {…} from` clause and misread its names as this file's own
  // imports. Verbatim shape of the lib/communication/call-compliance.ts and
  // lib/kernel/index.ts false accusation this fix corrects.
  {
    const spec = 'import "server-only"\nexport { realExport } from "./elsewhere"\n'
    const m2 = blankStrings(spec)
    IMPORT_STMT_RE.lastIndex = 0
    const matches: RegExpExecArray[] = []
    let mm: RegExpExecArray | null
    while ((mm = IMPORT_STMT_RE.exec(m2))) matches.push(mm)
    ok("(a) control: a bare `import \"server-only\"` (no `from`) produces ZERO parsed import statements",
      matches.length === 0)
  }

  // comment/string swallow must not hide a real import or invent a false usage
  {
    const spec = '// import { commentGhost } from "./nowhere"\nimport { realOne } from "./x"\nconst label = "mentions realOne in a string, not a use"\n'
    const m2 = blankStrings(spec)
    ok("comment-embedded fake import text does not appear as code after stripping", !m2.includes("commentGhost"))
    IMPORT_STMT_RE.lastIndex = 0
    const mm = IMPORT_STMT_RE.exec(m2)
    ok("real import survives alongside a // line naming a fake one above it", !!mm && parseImportClause(mm[1]).some((s) => s.name === "realOne"))
    let body = m2
    if (mm) body = blankRange(body, mm.index, mm.index + mm[0].length)
    ok("a name mentioned only inside a string literal does NOT count as a use (blankStrings blanks string content)",
      !boundaryRe("realOne").test(body))
  }

  // (b) forwarded-only vs actually-called
  {
    const forwarder = 'import { capabilityAlpha, capabilityBeta } from "./decl"\nexport { capabilityAlpha }\nconsole.log(capabilityBeta(1))\n'
    const m2 = blankStrings(forwarder)
    IMPORT_STMT_RE.lastIndex = 0
    const mm = IMPORT_STMT_RE.exec(m2)!
    const body = blankRange(m2, mm.index, mm.index + mm[0].length)
    const ranges = passthroughRangesFromText(m2)
    const alphaIdxs = [...body.matchAll(boundaryRe("capabilityAlpha"))].map((x) => x.index!)
    const betaIdxs = [...body.matchAll(boundaryRe("capabilityBeta"))].map((x) => x.index!)
    ok("(b) control: capabilityAlpha's only occurrence sits inside the export{} passthrough range",
      alphaIdxs.length > 0 && alphaIdxs.every((i) => ranges.some(([s, e]) => i >= s && i < e)))
    ok("(b) control: capabilityBeta's call site sits OUTSIDE any passthrough range (real use)",
      betaIdxs.length > 0 && betaIdxs.every((i) => !ranges.some(([s, e]) => i >= s && i < e)))
  }

  // (b) ONE-HOP RESCUE — the defect this correction exists for. A forwarder file
  // that only re-exports X must NOT be flagged when a downstream file imports X
  // FROM THE FORWARDER and genuinely calls it — the app/actions/marketing-studio.ts
  // shape measured live above. Exercised against the real maps directly (synthetic
  // files inserted and removed) since hasRealUseOutsidePassthrough/
  // isRescuedByDownstreamConsumer read module-level state, not a passed-in corpus.
  {
    const forwarderFile = "__control__/forwarder.ts"
    const consumerFile = "__control__/consumer.tsx"
    const forwarderSrc = 'import { realCapability } from "@/lib/__control__/decl"\nexport { realCapability }\n'
    const consumerSrc = 'import { realCapability } from "@/__control__/forwarder"\nconsole.log(realCapability())\n'
    raw.set(forwarderFile, forwarderSrc); masked.set(forwarderFile, blankStrings(forwarderSrc))
    raw.set(consumerFile, consumerSrc); masked.set(consumerFile, blankStrings(consumerSrc))
    importCache.delete(forwarderFile); importCache.delete(consumerFile)
    bodyForRefsCache.delete(forwarderFile); bodyForRefsCache.delete(consumerFile)
    const wasInFiles = FILES.includes(consumerFile)
    if (!wasInFiles) FILES.push(consumerFile)
    ok("(b) rescue control: the forwarder alone (no downstream consumer known) reads as forwarding-only",
      !hasRealUseOutsidePassthrough(forwarderFile, "realCapability"))
    ok("(b) rescue control: a real downstream caller importing FROM THE FORWARDER rescues it",
      isRescuedByDownstreamConsumer(forwarderFile, "realCapability"))
    if (!wasInFiles) FILES.pop()
    raw.delete(forwarderFile); masked.delete(forwarderFile); importCache.delete(forwarderFile); bodyForRefsCache.delete(forwarderFile)
    raw.delete(consumerFile); masked.delete(consumerFile); importCache.delete(consumerFile); bodyForRefsCache.delete(consumerFile)
  }

  // (c) props: declared-but-never-passed and passed-but-never-read
  {
    const src = [
      "interface WidgetProps { title: string; subtitle: string; onClose: () => void }",
      "function Widget({ title, onClose }: WidgetProps) { return title + onClose }",
      'const usage = "<Widget title=\\"x\\" onClose={fn} extra={1} />"', // in a string: must NOT count as a call site
    ].join("\n") + "\n<Widget title=\"x\" onClose={fn} extra={1} />\n"
    const m2 = blankStrings(src)
    const re = /(?:interface|type)\s+([A-Za-z0-9_$]+Props)\b[^{=]*(?:=\s*)?\{/g
    const m = re.exec(m2)!
    const openBraceIdx = m.index + m[0].length - 1
    const closeIdx = matchBalanced(m2, openBraceIdx, "{", "}")
    const propNames = propNamesFromTypeBody(m2.slice(openBraceIdx + 1, closeIdx))
    ok("(c) control: Props type parses title, subtitle, onClose",
      ["title", "subtitle", "onClose"].every((n) => propNames.includes(n)))
    const tagRe = /<Widget[\s/>]/g
    const sites = [...m2.matchAll(tagRe)]
    ok("(c) control: exactly one REAL JSX call site is seen (the one inside a string is not code)", sites.length === 1)
  }

  // (c) NESTED RETURN-TYPE FIELDS must not read as sibling Props — the
  // ExternalBatchActionsPanelProps shape this correction exists for.
  {
    const body = "onSave?: (ids: string[]) => Promise<{ success: boolean; count: number; error?: string }>; items: Item[]"
    const names = propNamesFromTypeBody(body)
    ok("(c) nested-return-type control: only the two REAL top-level props are found",
      names.length === 2 && names.includes("onSave") && names.includes("items"))
    ok("(c) nested-return-type control: the callback's OWN return-type fields are NOT read as siblings",
      !names.includes("success") && !names.includes("count") && !names.includes("error"))
  }

  // (c) DESTRUCTURED-MIDDLE-NAME control — the partnerId-shaped defect this
  // correction exists for: a THREE-name destructuring must yield all three,
  // not just the first and last (the consume-the-delimiter bug dropped the
  // middle one every time).
  {
    const paramText = "({\n  partnerType,\n  partnerId,\n  files,\n}: Props)"
    const { names, hasSpread } = destructuredPropNames(paramText)
    ok("(c) destructure control: all three names are found, the middle one included",
      names.length === 3 && names.includes("partnerType") && names.includes("partnerId") && names.includes("files"))
    ok("(c) destructure control: no spread reported when there is none", !hasSpread)
    const { names: renamed } = destructuredPropNames("({ a, b: localB, ...rest }: Props)")
    ok("(c) destructure control: a rename reports the PROP key (a, b), not the local binding",
      renamed.includes("a") && renamed.includes("b") && !renamed.includes("localB"))
    const { hasSpread: spreadFound } = destructuredPropNames("({ a, ...rest }: Props)")
    ok("(c) destructure control: a rest spread is detected", spreadFound)
  }

  // (d) rpc: comment-embedded fake definition/call must not count
  {
    const synthetic = '// create or replace function fakeDefinedInComment() returns void as $$ $$;\nawait supabase.rpc("fakeCalledInCode")\n'
    const blanked = blankComments(synthetic)
    ok("(d) control: commented CREATE FUNCTION text is gone after blanking", !blanked.includes("fakeDefinedInComment"))
    ok("(d) control: real .rpc() call site still detected", /\.rpc\(\s*["']fakeCalledInCode["']/.test(blanked))
  }

  return bad
}

const controlFailures = runControls()
if (controlFailures.length > 0) {
  console.log("❌ HIDDEN_WIRE_CONTROL_FAIL — the scanner cannot see what it claims to, refusing to report a number:")
  for (const f of controlFailures) console.log(`   - ${f}`)
  process.exit(1)
}

// ── --list-* (grep targets for per-lane verification, CLAUDE.md §7) ────────
if (ARGS.has("--list-a")) { for (const u of categoryA) console.log(`${u.file}:${u.line} ${u.name}`); process.exit(0) }
if (ARGS.has("--list-b")) { for (const b of categoryB) console.log(`${b.file}:${b.line} ${b.name} (declared ${b.declaredIn})`); process.exit(0) }
if (ARGS.has("--list-c-declared")) { for (const c of categoryCDeclared) console.log(`${c.declaredIn} ${c.component}.${c.prop}`); process.exit(0) }
if (ARGS.has("--list-c-unread")) { for (const c of categoryCUnread) console.log(`${c.declaredIn} ${c.component}.${c.prop}`); process.exit(0) }
if (ARGS.has("--list-d-missing")) { for (const n of categoryDMissing) console.log(n); process.exit(0) }
if (ARGS.has("--list-d-unused")) { for (const n of categoryDUnused) console.log(n); process.exit(0) }
if (ARGS.has("--list-e")) { for (const u of categoryE) console.log(`${u.file}:${u.line} ${u.name}`); process.exit(0) }

// ── REPORT ───────────────────────────────────────────────────────────────────
console.log("── HIDDEN WIRE CENSUS ──────────────────────────────────────────────")
console.log(`Corpus: ${FILES.length} files under app/, lib/, hooks/ (excludes .d.ts)`)
console.log("")
console.log(`(a) IMPORTED-BUT-UNUSED: ${categoryA.length} / ${totalImportBindings} import bindings scanned`)
console.log(`(b) IMPORTED-BUT-ONLY-FORWARDED: ${categoryB.length} findings (${categoryBRaw.length} raw, ${rescuedByOneHop} rescued by a real one-hop-downstream call) ; ${candidateFunctionExports} candidate function-shaped exports checked, ${ambiguousExportNames} skipped (same name declared in >1 file — ambiguous attribution)`)
console.log(`(c) PROPS DRIFT: ${categoryCDeclared.length} declared-never-passed, ${categoryCUnread.length} passed-never-read ; ${propsTypes.length} <Name>Props types found, ${componentsWithSignature} matched to a component signature, ${componentsWithSpread} excluded from the unread half (rest/spread destructure)`)
console.log(`(d) RPC WIRING: ${categoryDMissing.length} called-with-no-migration ; ${categoryDUnused.length} migration-defined-never-called (of ${definedFns.size} functions across ${migrationFiles().length} migration files; ${rpcCalls.size} distinct .rpc() names called)`)
console.log(`(e) DEAD SERVER-ACTION IMPORT (subset of a): ${categoryE.length}`)
console.log("")
console.log("BLIND SPOTS (see file header for the full statement):")
console.log("  scope = app/ + lib/ + hooks/ only; dynamic/string-keyed dispatch is invisible to (a)/(b)/(e);")
console.log("  (c) only <Name>Props-named types, one balanced brace level, spread components excluded from 'unread';")
console.log("  (d) dynamic .rpc(variable) names invisible; dashboard-authored functions false-positive as missing.")

// ── RATCHET BASELINE ─────────────────────────────────────────────────────────
interface Baseline { a: string[]; b: string[]; e: string[] }
const keyA = (u: UnusedImport) => `${u.file}::${u.name}`
const keyB = (b: ForwardedOnly) => `${b.file}::${b.name}`
const fresh: Baseline = {
  a: categoryA.map(keyA).sort(),
  b: categoryB.map(keyB).sort(),
  e: categoryE.map(keyA).sort(),
}

if (process.env.HIDDEN_WIRE_BASELINE === "1") {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(fresh, null, 2)}\n`)
  console.log(`\n  baseline written: scripts/hidden-wire-baseline.json (a=${fresh.a.length} b=${fresh.b.length} e=${fresh.e.length})`)
  console.log(" ✅ HIDDEN_WIRE_PASS (baseline write)")
  process.exit(0)
}

if (!existsSync(BASELINE_PATH)) {
  console.log("\n  no baseline yet — write one with HIDDEN_WIRE_BASELINE=1 npx tsx scripts/hidden-wire-census.ts")
  console.log(" ❌ HIDDEN_WIRE_FAIL — no baseline")
  process.exit(1)
}
const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as Baseline
function diff(baseArr: string[], freshArr: string[]): { newOnes: string[]; burned: string[] } {
  const b = new Set(baseArr), f = new Set(freshArr)
  return { newOnes: freshArr.filter((k) => !b.has(k)), burned: baseArr.filter((k) => !f.has(k)) }
}
const dA = diff(base.a ?? [], fresh.a)
const dB = diff(base.b ?? [], fresh.b)
const dE = diff(base.e ?? [], fresh.e)
const allNew = [...dA.newOnes.map((k) => `a ${k}`), ...dB.newOnes.map((k) => `b ${k}`), ...dE.newOnes.map((k) => `e ${k}`)]
const allBurned = [...dA.burned.map((k) => `a ${k}`), ...dB.burned.map((k) => `b ${k}`), ...dE.burned.map((k) => `e ${k}`)]

if (allBurned.length > 0) {
  console.log(`\n  ↓ ${allBurned.length} baseline entr(ies) fixed — tighten with HIDDEN_WIRE_BASELINE=1`)
  for (const b of allBurned.slice(0, 25)) console.log(`     ${b}`)
}
if (allNew.length > 0) {
  console.log(`\n  ✗ ${allNew.length} NEW hidden wire(s) since baseline:`)
  for (const n of allNew.slice(0, 40)) console.log(`     - ${n}`)
  console.log("\n  Each needs a verdict under CLAUDE.md §1: duplicate → merge+tombstone; no duplicate → BUILD the missing half; already-elsewhere → delete+tombstone.")
  console.log(" ❌ HIDDEN_WIRE_FAIL")
  process.exit(1)
}
console.log(`\n ✅ HIDDEN_WIRE_PASS — no NEW hidden wire (a=${fresh.a.length} b=${fresh.b.length} e=${fresh.e.length} on the ratchet; c/d reported, not ratcheted — see report)`)
