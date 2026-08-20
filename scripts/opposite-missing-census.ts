#!/usr/bin/env tsx
/**
 * scripts/opposite-missing-census.ts  (npm run test:opposite-missing)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE OPPOSITE-HALF CENSUS — six pair classes that this repo already measures at
 * the WRONG GRAIN, or does not measure at all.
 *
 * Owner's ask, verbatim: "we need to include any other hidden issues identifying
 * functions/imports and/or exports and/or writers and/or readers that don't have
 * the opposite in files that can be considered orphaned or missing... any
 * orphaned wire/absent that needs a wire and/or build needs to get it done."
 *
 * WHAT ALREADY EXISTS, AND WHY THIS IS NOT A FOURTH COPY OF IT
 *
 *   scripts/orphan-export-guard.ts  — exported FUNCTIONS with no importer.
 *   scripts/writerless-read-sweep.ts — TABLES read but never written. Reports 0.
 *   scripts/orphan-write-sweep.ts    — TABLES written but never read. Reports 0.
 *   scripts/orphan-route-sweep.ts    — PAGES nothing links to (it explicitly
 *                                      skips every /api/ path — see its line 236).
 *
 * Those four are all correct and all coarse. A table can have a writer and a
 * reader — so both sweeps go green — while a dozen of its COLUMNS are written by
 * nobody or read by nobody. A file can be imported while a symbol imported INTO
 * it is never used. A function can be exported and referenced while one of its
 * PARAMETERS is inert. `orphan-export-guard` counts `export function` and
 * `export const x = (` only, so every exported TYPE, INTERFACE, ENUM, CLASS and
 * VALUE CONST in the tree has never been counted at all. And nothing anywhere
 * checks that an `await import("…")` resolves, or that an `app/api/**` route
 * anyone fetches actually exists.
 *
 * So the six classes below are chosen to sit exactly in the gaps, and each one
 * DEFERS to the coarse sweep that already owns its table/file:
 *
 *   1. COLUMN-level one-sided I/O — only on tables the table-level sweeps have
 *      already cleared (a table with at least one writer AND at least one
 *      reader). A table with no writer at all belongs to writerless-read-sweep;
 *      a table with no reader belongs to orphan-write-sweep. No overlap.
 *   2. DEAD IMPORT — a symbol imported into a file and never used in that file.
 *   3. ORPHANED NON-FUNCTION EXPORT — type / interface / enum / class / value
 *      const with no importer. Disjoint from orphan-export-guard by
 *      construction: anything that guard's two regexes match is excluded here.
 *   4. INERT PARAMETER — accepted and never read in the body.
 *   5. BROKEN DYNAMIC IMPORT — `await import("…")` of a path that does not
 *      exist, or destructuring a named export the target does not have.
 *   6. ROUTE/FETCH PAIRING — a `fetch("/api/…")` whose route file does not
 *      exist (a guaranteed 404), and the mirror: an `app/api/**` route handler
 *      no string in the tree ever addresses.
 *
 * ── SOUNDNESS RULES THIS FILE IS HELD TO ────────────────────────────────────
 *
 * COMMENTS ARE BLANKED FIRST, with scripts/strip-comments.ts, never with a
 * hand-rolled regex pair. Doing it block-comments-first is a recurring defect
 * here that has twice made an analyzer go blind and ACCUSE LIVE CODE — read that
 * file's header. blankComments() is used (not stripComments) because several
 * scans below compute a line number from a match index.
 *
 * EVERY "X IS ABSENT" ASSERTION IS PAIRED WITH A POSITIVE CONTROL. A broken
 * regex and a clean tree both report zero, and the difference is the whole
 * value of the instrument. Each category therefore asserts, on a synthetic
 * fixture, that the scanner still SEES the shape it is counting the absence of —
 * and, where the direction matters, that it does NOT see a correct shape. If a
 * control fails the census exits non-zero and reports NOTHING, because a blind
 * scanner's zero is a lie, not a pass.
 *
 * WHAT CANNOT BE RESOLVED IS COUNTED, NOT DROPPED. Opaque write objects,
 * unresolvable embeds, non-literal import specifiers, destructured parameters,
 * interpolated fetch paths — each has a counter, and the coverage line prints
 * the denominator next to every numerator. A coverage number that hides its own
 * exclusions is a number that rounds up.
 *
 * FALSE NEGATIVE OVER FALSE ACCUSATION, every time. Where a shape cannot be
 * decided the finding is suppressed and counted as unresolved. That is why
 * `select("*")` marks a table fully-read for the write-orphan direction (it
 * really does read every column) but contributes NOTHING to the read-orphan
 * direction (it does not prove any particular column is wanted).
 *
 * ── THIS IS A WIRE LIST, NOT A DELETE LIST ──────────────────────────────────
 * Same standing rule as orphan-export-guard: everything here is a half that was
 * built without its opposite. The correct response is to BUILD THE MISSING HALF.
 * Deletion requires a NAMED DUPLICATE — file.ts:line that does the same job more
 * completely — established by reading both. Never delete to move a number.
 *
 * Run:      npx tsx scripts/opposite-missing-census.ts   (npm run test:opposite-missing)
 * Enumerate: … --list           (prints every finding, asserts nothing, exits 0)
 * Baseline: OPPOSITE_MISSING_BASELINE=1 npx tsx scripts/opposite-missing-census.ts
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs"
import { join, relative, dirname, resolve } from "node:path"
import { blankComments, blankStrings } from "./strip-comments"
import { runtimeFiles, walkTs } from "./runtime-roots"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

// The parsers below are imported, never re-implemented. schema-drift-guard.ts owns
// the only correct reader of a PostgREST call chain in this repo; a second copy
// would be a second opinion, and two parsers that disagree is the defect this
// repo's doctrine exists to prevent. The env flag suppresses that file's main()
// so the import yields the parsers without running the guard — see its footer.
process.env.SCHEMA_DRIFT_AS_LIBRARY = "1"
const sd = await import("./schema-drift-guard")

const root = process.cwd()
const rel = (p: string) => relative(root, p).replace(/\\/g, "/")

const BASELINE_PATH = join(root, "scripts", "opposite-missing-baseline.json")
const LIST = process.argv.includes("--list")

// ── CORPUS ──────────────────────────────────────────────────────────────────
// runtimeRoots() derives the reach from the tree rather than from a typed list —
// four separate guards in this repo were once narrowed to ["app","lib"] and were
// blind to services/, hooks/, remotion/, constants/, contexts/, workflows/ and
// types/ as a result. NON_RUNTIME_ROOTS excludes scripts/ and e2e/, which is
// right for "what ships"; both are read back in below as a REFERENCE corpus,
// because a proof that names a symbol is evidence about that symbol even though
// it is not a product surface.
const productFiles = runtimeFiles(root).map(rel).sort()
const proofFiles = [...walkTs(join(root, "scripts")), ...walkTs(join(root, "e2e"))].map(rel).sort()

/** Stage timings, printed with OPPOSITE_MISSING_VERBOSE=1 — a census nobody can
 *  profile is a census that quietly becomes unrunnable. */
const t0 = Date.now()
const stages: Array<[string, number]> = []
const stage = (name: string) => {
  stages.push([name, Date.now() - t0])
  // Every console.log in this file is in the report at the bottom, so a slow scan
  // is indistinguishable from a hung one unless progress goes out as it happens.
  if (process.env.OPPOSITE_MISSING_VERBOSE === "1") process.stderr.write(`  … ${name} @${Date.now() - t0}ms\n`)
}

const rawOf = new Map<string, string>()
for (const f of [...productFiles, ...proofFiles]) {
  try { rawOf.set(f, readFileSync(join(root, f), "utf8")) } catch { rawOf.set(f, "") }
}

/** Comments blanked to spaces: line numbers AND character offsets both survive. */
const codeOf = new Map<string, string>()
for (const f of rawOf.keys()) codeOf.set(f, blankComments(rawOf.get(f)!))
stage("blankComments")

/**
 * String CONTENTS blanked, quotes kept — so a name inside a string literal is not
 * counted as a reference to the symbol of that name. orphan-export-guard learned
 * this the expensive way: 240 exports were classed "referenced" purely because
 * lib/kernel/manager-registry.ts's narrative `what:` fields mention them, i.e.
 * documentation masquerading as wiring.
 */
// blankStrings() — the SCANNER, not the three-regex idiom every other analyzer
// here grew privately. That idiom mis-pairs on a lone backtick inside a quoted
// string and blanks the code between it and the next backtick; measured on
// lib/agents/generate-client-message.ts it deleted `export async function
// generateClientMessage`, and this census's first run duly reported all twenty
// of that module's `await import(…)` call sites as importing a name it does not
// export. Twenty false accusations against working code. See strip-comments.ts.
const maskStrings = (src: string) => blankStrings(src)
const maskOf = new Map<string, string>()
for (const f of rawOf.keys()) maskOf.set(f, blankStrings(rawOf.get(f)!))
stage("blankStrings")

/**
 * Line number for a character offset — via a per-string index of newline offsets,
 * binary-searched, not by counting from zero on every call.
 *
 * The naive count is O(offset), and this census asks the question once per
 * `.from()` site (13,591 of them) plus once per import, per function and per
 * string literal. Counting from the top of the file each time made the scan
 * quadratic in file size, which on the largest modules in this tree is the
 * difference between a census that runs in CI and one nobody ever runs twice.
 */
const lineIndexCache = new WeakMap<object, number[]>()
const lineIndexByString = new Map<string, number[]>()
function lineStarts(src: string): number[] {
  let idx = lineIndexByString.get(src)
  if (idx) return idx
  idx = [0]
  for (let i = 0; i < src.length; i++) if (src[i] === "\n") idx.push(i + 1)
  // Only the corpus strings are worth remembering; control fixtures are tiny and
  // transient, and caching them would grow this map without bound.
  if (src.length > 4096) lineIndexByString.set(src, idx)
  void lineIndexCache
  return idx
}
function lineOf(src: string, idx: number): number {
  const starts = lineStarts(src)
  let lo = 0, hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= idx) lo = mid
    else hi = mid - 1
  }
  return lo + 1
}

// ── FINDINGS ────────────────────────────────────────────────────────────────
interface Finding { cat: string; key: string; where: string; detail: string }
const findings: Finding[] = []
const add = (cat: string, key: string, where: string, detail: string) =>
  findings.push({ cat, key, where, detail })

// ── POSITIVE CONTROLS ───────────────────────────────────────────────────────
// A scanner that cannot see the shape reports zero of it, and so does a clean
// tree. These make the two distinguishable. Every one runs BEFORE any finding is
// believed; a single failure aborts with no report at all.
const controls: Array<{ name: string; ok: boolean; note?: string }> = []
const control = (name: string, ok: boolean, note?: string) => controls.push({ name, ok, note })

// ── CONTROL ZERO: THE MASKER ITSELF ─────────────────────────────────────────
// Everything downstream reads either codeOf (comments blanked) or maskOf
// (comments AND string contents blanked). If either is wrong the whole census is
// wrong in the confident direction, so both are checked before anything else on
// the exact shape that broke the first run: a lone BACKTICK inside a quoted
// string. The three-regex masking idiom pairs it with the next backtick in the
// file and blanks every line between — which is how twenty correct `await
// import(…)` sites got reported as importing a name their target does not export.
{
  const trap = 'const tick = "a ` backtick in a string"\nexport async function survivesTheMask() {}\nconst t2 = `real template`\n'
  const masked = blankStrings(trap)
  control("C0 a stray backtick inside a string does not blank the code below it",
    masked.includes("export async function survivesTheMask"),
    masked.replace(/\n/g, "⏎").slice(0, 90))
  control("C0 masking preserves character offsets exactly",
    blankStrings(trap).length === trap.length)
  control("C0 string CONTENT really is blanked (a name in a string is not a use)",
    !blankStrings('const s = "mentionsSomeSymbolName"').includes("mentionsSomeSymbolName"))
  control("C0 a ${…} interpolation stays CODE (a name inside one IS a use)",
    blankStrings("const s = `x ${realReference} y`").includes("realReference"))
  control("C0 comment blanking preserves offsets", (() => {
    const withComment = "const a = 1 // note\nconst b = 2\n"
    return blankComments(withComment).length === withComment.length
  })())
}

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 1 — COLUMN-LEVEL ONE-SIDED I/O
// ═══════════════════════════════════════════════════════════════════════════
//
// The two table-level sweeps both report zero, and both are telling the truth at
// their grain. This asks the same question one level down: on a table that IS
// written and IS read, is there a COLUMN that only one side ever touches?
//
// Two directions, and they need opposite treatments of `select("*")`:
//
//   WRITTEN-NEVER-READ — a write whose value nobody consumes. Here `select("*")`
//     really does read every column, so a table selected with `*` anywhere is
//     removed from this direction entirely. Same for any read this scanner could
//     not fully parse.
//   READ-NEVER-WRITTEN — a read that can only ever return NULL/default. Here
//     `select("*")` proves nothing about any particular column, so it contributes
//     nothing. The candidate must be named explicitly in a select/filter.
//
// SUPPRESSIONS, each of which is a real way a column gets written or read outside
// this scanner's sight — counted, never guessed at:
//   · a table whose write object is OPAQUE (a spread `{...base}`, or an
//     `.insert(variable)` whose variable could not be resolved) is dropped from
//     the read-never-written direction: its true key set is unknown.
//   · DB-managed columns (id / created_at / updated_at / …) are written by
//     DEFAULT and by trigger, never by app code, so a "no writer" finding on
//     them would be pure noise.
//   · a table touched by `.rpc(` anywhere loses both directions for that table —
//     a database function reads and writes columns no static scan can attribute.
const readCols = new Map<string, Set<string>>()
const writeCols = new Map<string, Set<string>>()
const starRead = new Set<string>()          // select("*") — reads everything
const opaqueWrite = new Set<string>()       // write key set not statically knowable
const tablesRead = new Set<string>()
const tablesWritten = new Set<string>()
const colSites = new Map<string, string>()  // "table.col" → first file:line that names it
let unresolvedEmbeds = 0
let unresolvedWriteObjects = 0
let unresolvedFilterTerms = 0
let selectSitesParsed = 0

/** Columns the database fills in on its own. A missing app WRITER is expected. */
const DB_MANAGED = new Set([
  "id", "created_at", "updated_at", "inserted_at", "deleted_at", "modified_at",
  "created_by", "search_vector", "tsv", "fts",
])

/**
 * Columns whose READER IS THE DATABASE, not the application — so "written and
 * never read by code" is the correct state for them, not a finding.
 *
 * `brokerage_id` is the load-bearing case and it is not a technicality: every
 * tenant policy in this schema is written against `current_user_brokerage_id()`,
 * so the column is consumed by RLS on every single query. App code that never
 * selects it is behaving correctly, and stamping it is MANDATORY. Reporting 34
 * of those as one-sided writes would have made the honest findings in this
 * category unreadable and taught people to stop reading it — the failure mode
 * that ends with a guard being switched off.
 *
 * The audit stamps are the same shape one level down: `updated_at` is read by
 * ordering and by humans reading a row, `created_by`/`updated_by` are provenance
 * for an audit export. None of them is a wire waiting to be finished.
 */
const POLICY_OR_AUDIT_CONSUMED = new Set([
  "brokerage_id", "tenant_id",
  "created_at", "updated_at", "inserted_at", "modified_at",
  "created_by", "updated_by", "deleted_at", "deleted_by",
])

/**
 * TOP-LEVEL SHORTHAND PROPERTIES — `{ automation_id, user_id, result }`.
 *
 * schema-drift-guard's parseObjectTopLevelKeys only recognises `name:` because it
 * hunts for PHANTOM columns, where missing a key is a harmless false negative.
 * Here a missed key is a FALSE ACCUSATION: the key is a real write, and not
 * seeing it makes the column look read-only. Measured — the first run of the
 * automation-log wiring reported `automation_logs.automation_id`, `.result` and
 * `.trigger_type` as "read by code, written by nobody" while the writer three
 * files away sets all three, in shorthand.
 *
 * This SUPPLEMENTS that parser rather than replacing it: shorthand keys are
 * unioned in, and everything else still comes from the shared implementation, so
 * the two analyzers cannot drift apart on the shapes they both understand.
 */
function shorthandObjectKeys(objText: string): string[] {
  const keys: string[] = []
  const stack: string[] = []
  let lastSig = ""
  let q: string | null = null
  let i = 0
  while (i < objText.length) {
    const ch = objText[i]
    if (q) { if (ch === q && objText[i - 1] !== "\\") q = null; i++; continue }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; lastSig = ch; i++; continue }
    if (ch === "{" || ch === "(" || ch === "[") { stack.push(ch); lastSig = ch; i++; continue }
    if (ch === "}" || ch === ")" || ch === "]") { stack.pop(); lastSig = ch; i++; continue }
    if (stack.length === 1 && /[a-z_]/i.test(ch) && (lastSig === "{" || lastSig === ",")) {
      // A shorthand property is an identifier followed by `,` or the closing `}`
      // — anything else (`:`, `(`, `.`, an operator) means it is a key with a
      // value, or an expression, and the shared parser already owns those.
      const m = objText.slice(i).match(/^([a-z_][a-z0-9_]*)\s*(,|\})/i)
      if (m) { keys.push(m[1]); lastSig = ","; i += m[1].length; continue }
    }
    if (!/\s/.test(ch)) lastSig = ch
    i++
  }
  return keys
}
const writeKeysOf = (objText: string): string[] => [
  ...sd.parseObjectTopLevelKeys(objText),
  ...shorthandObjectKeys(objText),
]

/**
 * COLUMNS THE DATABASE WRITES FOR YOU, read out of the migrations rather than
 * guessed from their names.
 *
 * `automation_logs.brokerage_id` has no app writer and never should have one:
 * migration 052 installs a BEFORE INSERT trigger that denormalises it from
 * `user_id`, and a second app-side write of the same value would be a second
 * opinion about the tenant. A name-based exemption list cannot express that — it
 * would have to exempt `brokerage_id` EVERYWHERE, which would blind this census
 * to the genuinely serious case of a tenant column nothing stamps at all.
 *
 * So the evidence is read from the source: every `NEW.<column> :=` (or
 * `SELECT … INTO NEW.<column>`) inside a trigger function, attributed to the
 * tables that `CREATE TRIGGER … ON <table> … EXECUTE … <function>` attaches it
 * to. Only those pairs are exempt, and only in the read-never-written direction.
 */
function triggerWrittenColumns(): Map<string, Set<string>> {
  const byTable = new Map<string, Set<string>>()
  const dir = join(root, "supabase", "migrations")
  if (!existsSync(dir)) return byTable
  const fnCols = new Map<string, Set<string>>()
  const attach = new Map<string, Set<string>>()   // function name → tables
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".sql")) continue
    let sql = ""
    try { sql = readFileSync(join(dir, name), "utf8") } catch { continue }
    // Trigger function bodies: `CREATE [OR REPLACE] FUNCTION <fn>() RETURNS TRIGGER … $$`
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)\s*\([^)]*\)\s+RETURNS\s+TRIGGER\b([\s\S]*?)(?:\$\$|\$function\$)\s*LANGUAGE/gi)) {
      const fn = m[1].toLowerCase()
      const body = m[2]
      const cols = fnCols.get(fn) ?? new Set<string>()
      for (const a of body.matchAll(/\bNEW\.([a-z0-9_]+)\s*(?::=|=[^=])/gi)) cols.add(a[1].toLowerCase())
      for (const a of body.matchAll(/\bINTO\s+NEW\.([a-z0-9_]+)/gi)) cols.add(a[1].toLowerCase())
      fnCols.set(fn, cols)
    }
    for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER\s+[a-z0-9_]+\s+(?:BEFORE|AFTER|INSTEAD\s+OF)[\s\S]{0,200}?\bON\s+(?:public\.)?([a-z0-9_]+)[\s\S]{0,200}?EXECUTE\s+(?:PROCEDURE|FUNCTION)\s+(?:public\.)?([a-z0-9_]+)/gi)) {
      const table = m[1].toLowerCase()
      const fn = m[2].toLowerCase()
      const set = attach.get(fn) ?? new Set<string>()
      set.add(table)
      attach.set(fn, set)
    }
  }
  for (const [fn, cols] of fnCols) {
    for (const table of attach.get(fn) ?? []) {
      const set = byTable.get(table) ?? new Set<string>()
      for (const c of cols) set.add(c)
      byTable.set(table, set)
    }
  }
  return byTable
}
const TRIGGER_WRITTEN = triggerWrittenColumns()

/** A top-level `...spread` in a write object means the real key set is unknown. */
function hasTopLevelSpread(objText: string): boolean {
  let depth = 0, q: string | null = null
  for (let i = 0; i < objText.length; i++) {
    const ch = objText[i]
    if (q) { if (ch === q && objText[i - 1] !== "\\") q = null; continue }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue }
    if (ch === "{" || ch === "(" || ch === "[") { depth++; continue }
    if (ch === "}" || ch === ")" || ch === "]") { depth--; continue }
    if (depth === 1 && objText.startsWith("...", i)) {
      let j = i + 3
      while (j < objText.length && /\s/.test(objText[j])) j++
      // `...(cond && { col: v })` IS parsed by parseObjectTopLevelKeys; only an
      // opaque spread of an identifier (`...base`, `...fn()`) hides keys.
      if (objText[j] !== "(") return true
    }
  }
  return false
}

const noteCol = (map: Map<string, Set<string>>, table: string, col: string, site: string) => {
  let s = map.get(table)
  if (!s) { s = new Set(); map.set(table, s) }
  s.add(col)
  const k = `${table}.${col}`
  if (!colSites.has(k)) colSites.set(k, site)
}

const rpcTouched = new Set<string>()

function scanColumns(file: string, src: string) {
  if (/\.rpc\s*\(/.test(src)) {
    // The function NAME is often the table name or close to it; rather than guess,
    // every table this FILE touches is exempted from both directions.
    for (const fm of src.matchAll(/\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/g)) rpcTouched.add(fm[1])
  }
  const fromRe = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = fromRe.exec(src))) {
    const table = m[1]
    const known = SCHEMA_SNAPSHOT[table]
    if (!known) continue                       // not a live table — schema-drift-guard's problem
    const cols = new Set(known)
    const site = `${file}:${lineOf(src, m.index)}`
    const chainStart = m.index + m[0].length
    // ── WHY A WINDOW AND NOT THE WHOLE FILE ─────────────────────────────────
    // contiguousChain() and collectSelectArg() both work by slicing the REST OF
    // THE STRING from the current position, once per chained method. Handed the
    // whole file at each of this tree's 13,591 `.from()` sites, that is quadratic
    // in file size and the census does not finish. A PostgREST chain is a local
    // construct — the longest in this repo is a few hundred characters — so the
    // parsers are handed a window instead, and the answer is identical for every
    // chain that fits. A chain that does NOT fit is detected below and counted
    // as unresolved rather than silently truncated, which is the one way this
    // optimisation could have turned into a false accusation.
    const CHAIN_WINDOW = 12000
    const w = src.slice(m.index, Math.min(src.length, m.index + CHAIN_WINDOW))
    const chain = sd.contiguousChain(w, m[0].length)
    const windowTruncated = m[0].length + chain.length >= CHAIN_WINDOW - 1 && m.index + CHAIN_WINDOW < src.length

    // ── READ SIDE ───────────────────────────────────────────────────────────
    const selArg = sd.collectSelectArg(w, 0)
    if (selArg !== null) {
      selectSitesParsed++
      tablesRead.add(table)
      const parts = selArg.split(",").map((s) => s.trim())
      if (selArg.trim() === "" || parts.some((p) => p === "*" || p.endsWith(".*"))) starRead.add(table)
      for (const c of sd.parseSelectColumns(selArg)) if (cols.has(c)) noteCol(readCols, table, c, site)
      const emb = sd.resolveEmbeddedSelects(selArg, table)
      unresolvedEmbeds += emb.unresolved.length
      for (const e of emb.refs) {
        if (!SCHEMA_SNAPSHOT[e.table]) continue
        tablesRead.add(e.table)
        if (e.column === "*") { starRead.add(e.table); continue }
        if (SCHEMA_SNAPSHOT[e.table].includes(e.column)) noteCol(readCols, e.table, e.column, site)
      }
      // An embed whose target could not be named may read ANY column of ANY table;
      // rather than guess, the PARENT keeps its findings and the unresolved count
      // carries the doubt (printed in the coverage block).
    }
    // Filter / order arguments read a column just as a select list does.
    for (const fm of chain.matchAll(/\.(eq|neq|gt|gte|lt|lte|like|ilike|in|is|contains|containedBy|overlaps|order|not|match)\(\s*["'`]([a-zA-Z_][a-zA-Z0-9_.]*)["'`]/g)) {
      const col = fm[2].split("->")[0]
      if (col.includes(".")) continue
      if (cols.has(col)) { tablesRead.add(table); noteCol(readCols, table, col, site) }
    }
    // The `.or()` / `.filter()` DSL names columns inside a string; parsed with the
    // guard's own DSL reader so this scanner and that one agree about what a term is.
    for (const call of sd.topLevelChainCalls(chain)) {
      if (call.name !== "or" && call.name !== "filter") continue
      const lit = sd.staticFilterString(call.args) ?? sd.staticJoinedArray(call.args)
      if (lit === null) { unresolvedFilterTerms++; continue }
      const parsed = sd.parseFilterDsl(lit)
      unresolvedFilterTerms += parsed.skipped.length
      for (const r of parsed.refs) {
        if (r.relation) continue               // embedded relation — resolved elsewhere or not at all
        if (cols.has(r.column)) { tablesRead.add(table); noteCol(readCols, table, r.column, site) }
      }
    }

    // ── WRITE SIDE ──────────────────────────────────────────────────────────
    // Offsets below are WINDOW-relative (`w`), and every brace walk that runs off
    // the end of the window falls back to the full source rather than guessing.
    const opM = chain.match(/\.(insert|upsert|update)\(\s*\{/)
    if (opM && opM.index != null) {
      tablesWritten.add(table)
      const braceOpenW = m[0].length + opM.index + opM[0].length - 1
      let obj: string | null = null
      const closeW = sd.matchBrace(w, braceOpenW)
      if (closeW > braceOpenW) obj = w.slice(braceOpenW, closeW + 1)
      else {
        const abs = m.index + braceOpenW
        const closeAbs = sd.matchBrace(src, abs)
        if (closeAbs > abs) obj = src.slice(abs, closeAbs + 1)
      }
      if (obj === null) { opaqueWrite.add(table); unresolvedWriteObjects++ }
      else {
        if (hasTopLevelSpread(obj)) { opaqueWrite.add(table); unresolvedWriteObjects++ }
        for (const k of writeKeysOf(obj)) if (cols.has(k)) noteCol(writeCols, table, k, site)
      }
    }
    const arrM = chain.match(/\.(insert|upsert)\(\s*\[/)
    if (arrM && arrM.index != null) {
      tablesWritten.add(table)
      const bracketOpen = m.index + m[0].length + arrM.index + arrM[0].length - 1
      let d = 0
      for (let i = bracketOpen; i < src.length; i++) {
        const ch = src[i]
        if (ch === "[") d++
        else if (ch === "]") { d--; if (d === 0) break }
        else if (ch === "{" && d === 1) {
          const bc = sd.matchBrace(src, i)
          if (bc <= i) { opaqueWrite.add(table); unresolvedWriteObjects++; break }
          const obj = src.slice(i, bc + 1)
          if (hasTopLevelSpread(obj)) { opaqueWrite.add(table); unresolvedWriteObjects++ }
          for (const k of writeKeysOf(obj)) if (cols.has(k)) noteCol(writeCols, table, k, site)
          i = bc
        }
      }
    }
    const varM = chain.match(/\.(insert|upsert|update)\(\s*([a-zA-Z_$][\w$]*)\s*\)/)
    if (varM && varM.index != null && !["true", "false", "null"].includes(varM[2])) {
      tablesWritten.add(table)
      const keys = sd.resolveVariableInsertKeys(src, varM[2], chainStart + varM.index)
      // ZERO keys back from a variable means "could not resolve", not "writes
      // nothing" — resolveVariableInsertKeys returns [] for an opaque helper
      // result by design. Treating that as an empty key set would invent a
      // read-never-written finding for every column the helper really writes.
      if (keys.length === 0) { opaqueWrite.add(table); unresolvedWriteObjects++ }
      for (const k of keys) if (cols.has(k)) noteCol(writeCols, table, k, site)
    }
    if (/\.delete\s*\(/.test(chain)) tablesWritten.add(table)
    // A chain that filled the window was READ INCOMPLETELY. Both directions lose
    // this table rather than report a half-read chain as a whole one.
    if (windowTruncated) { opaqueWrite.add(table); starRead.add(table); unresolvedWriteObjects++ }
  }
}

for (const f of productFiles) scanColumns(f, codeOf.get(f)!)
stage("C1 columns")

// POSITIVE CONTROLS — the scanner must SEE a column read and a column write, and
// must NOT see one that only exists in a comment.
{
  const probe = (text: string) => {
    const before = { r: readCols.get("contacts")?.size ?? 0 }
    void before
    const rc = new Map<string, Set<string>>(), wc = new Map<string, Set<string>>()
    const saveR = readCols.get("contacts"), saveW = writeCols.get("contacts")
    readCols.delete("contacts"); writeCols.delete("contacts")
    scanColumns("<control>", blankComments(text))
    const out = {
      read: [...(readCols.get("contacts") ?? [])],
      write: [...(writeCols.get("contacts") ?? [])],
    }
    readCols.delete("contacts"); writeCols.delete("contacts")
    if (saveR) readCols.set("contacts", saveR)
    if (saveW) writeCols.set("contacts", saveW)
    void rc; void wc
    return out
  }
  const seen = probe(`await supabase.from("contacts").select("id, first_name").eq("last_name", x)`)
  control("C1 sees a column READ (select list + filter arg)",
    seen.read.includes("first_name") && seen.read.includes("last_name"), seen.read.join(","))
  const wrote = probe(`await supabase.from("contacts").insert({ first_name: a, phone: b })`)
  control("C1 sees a column WRITE (insert object keys)",
    wrote.write.includes("first_name") && wrote.write.includes("phone"), wrote.write.join(","))
  const commented = probe(`// await supabase.from("contacts").select("id, first_name")\nconst x = 1`)
  control("C1 does NOT read a query that only exists in a comment",
    commented.read.length === 0 && commented.write.length === 0)
  const opaque = probe(`await supabase.from("contacts").update({ ...base, phone: b })`)
  control("C1 marks a spread write object OPAQUE rather than assuming its key set",
    opaque.write.includes("phone"))
  // SHORTHAND KEYS. `{ first_name, phone }` is a write of both columns, and a
  // parser that only knows `name:` reports the columns as read-only — the exact
  // false accusation the automation-log wiring produced on its first run.
  const shorthand = probe(`await supabase.from("contacts").insert({ first_name, phone, email: e })`)
  control("C1 sees SHORTHAND object keys as writes",
    ["first_name", "phone", "email"].every((k) => shorthand.write.includes(k)),
    shorthand.write.join(","))
  control("C1 does not mistake a nested key or a value expression for a shorthand key",
    shorthandObjectKeys(`{ a, meta: { b }, c: fn(d), e }`).sort().join(",") === "a,e",
    shorthandObjectKeys(`{ a, meta: { b }, c: fn(d), e }`).sort().join(","))
  // DB-TRIGGER WRITES, read out of the migrations rather than assumed.
  control("C1 read trigger-written columns out of supabase/migrations at all",
    TRIGGER_WRITTEN.size > 0, `${TRIGGER_WRITTEN.size} tables`)
  control("C1 knows automation_logs.brokerage_id is written by migration 052's trigger",
    TRIGGER_WRITTEN.get("automation_logs")?.has("brokerage_id") === true,
    [...(TRIGGER_WRITTEN.get("automation_logs") ?? [])].join(","))
  control("C1 does NOT blanket-exempt brokerage_id on a table with no such trigger",
    TRIGGER_WRITTEN.get("contacts")?.has("brokerage_id") !== true)
}

/**
 * A table qualifies for the COLUMN question only when the TABLE question is
 * already answered green — at least one runtime writer and at least one runtime
 * reader. That is not a convenience: it is what keeps this census disjoint from
 * writerless-read-sweep (tables with no writer) and orphan-write-sweep (tables
 * with no reader). Those two own their populations; this one owns what is left.
 */
const pairedTables = [...tablesRead].filter((t) => tablesWritten.has(t) && !rpcTouched.has(t)).sort()

const colWrittenNeverRead: string[] = []
const colReadNeverWritten: string[] = []
for (const t of pairedTables) {
  const r = readCols.get(t) ?? new Set<string>()
  const w = writeCols.get(t) ?? new Set<string>()
  if (!starRead.has(t)) {
    for (const c of [...w].sort()) if (!r.has(c) && !POLICY_OR_AUDIT_CONSUMED.has(c)) colWrittenNeverRead.push(`${t}.${c}`)
  }
  if (!opaqueWrite.has(t)) {
    const dbWritten = TRIGGER_WRITTEN.get(t)
    for (const c of [...r].sort()) {
      if (w.has(c) || DB_MANAGED.has(c)) continue
      if (dbWritten?.has(c)) continue          // a trigger fills this in — see triggerWrittenColumns()
      colReadNeverWritten.push(`${t}.${c}`)
    }
  }
}
for (const k of colWrittenNeverRead) add("col-write-no-read", k, colSites.get(k) ?? "?", "column written by code, read by none")
for (const k of colReadNeverWritten) add("col-read-no-write", k, colSites.get(k) ?? "?", "column read by code, written by none")

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 2 — DEAD IMPORT (a symbol imported and never used in that file)
// ═══════════════════════════════════════════════════════════════════════════
//
// The import statements themselves are blanked out before the usage search, so a
// name is never counted as "used" by its own import clause. Strings are NOT
// masked here: `<Foo />` in JSX, `Foo` in a type position and `${Foo}` in a
// template are all real uses, and a name that merely appears inside a quoted
// string produces a FALSE NEGATIVE — the safe direction.
interface ImportBinding { file: string; local: string; from: string; line: number }
const importBindings: ImportBinding[] = []
const deadImports: ImportBinding[] = []
let importStatements = 0
let sideEffectImports = 0

const IMPORT_RE = /^[ \t]*import\s+(?!type\s*\()([\s\S]*?)\bfrom\s*["'`]([^"'`]+)["'`]/gm

function importClauseNames(clause: string): string[] {
  const names: string[] = []
  let c = clause.trim()
  if (c.startsWith("type ")) c = c.slice(5).trim()      // `import type { A } from` — still a binding
  // namespace: * as N
  const ns = c.match(/\*\s*as\s+([A-Za-z_$][\w$]*)/)
  if (ns) names.push(ns[1])
  // named block { a, b as c, type D }
  const braceOpen = c.indexOf("{")
  if (braceOpen >= 0) {
    const braceClose = c.indexOf("}", braceOpen)
    if (braceClose > braceOpen) {
      for (const piece of c.slice(braceOpen + 1, braceClose).split(",")) {
        const p = piece.trim().replace(/^type\s+/, "")
        if (!p) continue
        const asM = p.match(/^[\w$]+\s+as\s+([A-Za-z_$][\w$]*)$/)
        names.push(asM ? asM[1] : (p.match(/^[A-Za-z_$][\w$]*$/) ? p : ""))
      }
    }
  }
  // default binding: the leading bare identifier before `,` or `{` or end
  const head = (braceOpen >= 0 ? c.slice(0, braceOpen) : c).replace(/\*\s*as\s+[\w$]+/, "").trim()
  const defM = head.replace(/,\s*$/, "").trim().match(/^([A-Za-z_$][\w$]*)$/)
  if (defM) names.push(defM[1])
  return names.filter(Boolean)
}

function scanDeadImports(file: string, src: string): ImportBinding[] {
  const out: ImportBinding[] = []
  const spans: Array<[number, number]> = []
  const local: ImportBinding[] = []
  let m: RegExpExecArray | null
  IMPORT_RE.lastIndex = 0
  while ((m = IMPORT_RE.exec(src))) {
    importStatements++
    spans.push([m.index, m.index + m[0].length])
    const line = lineOf(src, m.index)
    for (const name of importClauseNames(m[1])) local.push({ file, local: name, from: m[2], line })
  }
  for (const s of src.matchAll(/^[ \t]*import\s*["'`][^"'`]+["'`]/gm)) { sideEffectImports++; void s }
  // Blank every import statement so a name cannot vouch for itself.
  let body = src
  for (const [a, b] of spans) body = body.slice(0, a) + " ".repeat(b - a) + body.slice(b)
  for (const b of local) {
    importBindings.push(b)
    if (!new RegExp(`\\b${b.local.replace(/\$/g, "\\$")}\\b`).test(body)) out.push(b)
  }
  return out
}

for (const f of productFiles) for (const d of scanDeadImports(f, codeOf.get(f)!)) deadImports.push(d)
stage("C2 imports")

{
  const fixture = `import { used, dead } from "./x"\nimport type { UsedType } from "./y"\nimport Def from "./z"\nconst a: UsedType = used(Def)\n`
  const got = scanDeadImports("<control>", blankComments(fixture)).map((d) => d.local).sort()
  control("C2 sees a DEAD import and only the dead one", got.join(",") === "dead", got.join(","))
  const jsx = `import { Card } from "./ui"\nexport const P = () => <Card />\n`
  control("C2 counts JSX element usage as a use",
    scanDeadImports("<control>", blankComments(jsx)).length === 0)
  const tmpl = `import { NAME } from "./c"\nexport const s = \`hi \${NAME}\`\n`
  control("C2 counts a template interpolation as a use",
    scanDeadImports("<control>", blankComments(tmpl)).length === 0)
  const cmt = `import { onlyInAComment } from "./c"\n// onlyInAComment is nice\n`
  control("C2 does NOT let a COMMENT vouch for an import",
    scanDeadImports("<control>", blankComments(cmt)).length === 1)
  control("C2 saw imports at all across the tree", importStatements > 500, `${importStatements} import statements`)
}
for (const d of deadImports) add("dead-import", `${d.file}::${d.local}`, `${d.file}:${d.line}`, `imported from "${d.from}", never used in this file`)

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 3 — ORPHANED NON-FUNCTION EXPORT (type / interface / enum / class / const)
// ═══════════════════════════════════════════════════════════════════════════
//
// orphan-export-guard matches exactly two shapes — `export function NAME` and
// `export const NAME … = (` — so the entire type surface of this repo has never
// been counted. Anything those two regexes match is EXCLUDED here, so the two
// censuses partition the export space instead of overlapping.
//
// Same three-way classification as that guard, for the same reason: an export
// named only by a proof is a different KIND of work from one named nowhere at
// all, and collapsing them produces a burn-down list that gets people deleting
// proven capability.
interface ExportRef { file: string; name: string; kind: string; line: number }
const typeExports: ExportRef[] = []
const FN_EXPORT_RE = /export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g
const FN_CONST_RE = /export\s+const\s+([A-Za-z0-9_$]+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/g

function scanTypeExports(file: string, src: string): ExportRef[] {
  const out: ExportRef[] = []
  // The two shapes orphan-export-guard ALREADY owns. Collected first and used as
  // an exclusion set so the two censuses partition the export space rather than
  // both counting the same symbol — a double count would make the combined
  // "unwired export" figure wrong in the alarming direction.
  const alreadyCounted = new Set<string>()
  for (const m of src.matchAll(new RegExp(FN_EXPORT_RE.source, "g"))) alreadyCounted.add(m[1])
  for (const m of src.matchAll(new RegExp(FN_CONST_RE.source, "g"))) alreadyCounted.add(m[1])
  const push = (name: string, kind: string, idx: number) => {
    if (alreadyCounted.has(name)) return
    out.push({ file, name, kind, line: lineOf(src, idx) })
  }
  for (const m of src.matchAll(/export\s+(?:declare\s+)?interface\s+([A-Za-z0-9_$]+)/g)) push(m[1], "interface", m.index!)
  for (const m of src.matchAll(/export\s+(?:declare\s+)?type\s+([A-Za-z0-9_$]+)/g)) push(m[1], "type", m.index!)
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z0-9_$]+)/g)) push(m[1], "enum", m.index!)
  for (const m of src.matchAll(/export\s+(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/g)) push(m[1], "class", m.index!)
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*(?::[^=\n]+)?=/g)) push(m[1], "const", m.index!)
  return out
}
for (const f of productFiles) for (const e of scanTypeExports(f, maskOf.get(f)!)) typeExports.push(e)

/**
 * An INVERTED INDEX, not a regex sweep.
 *
 * The naive shape — for each export, test every file — is |exports| × |files|
 * regex runs over multi-megabyte strings, which on this tree is tens of millions
 * of scans and does not finish in a useful time. Every file is tokenised ONCE
 * into the identifiers it names, and the question "does any OTHER file name X"
 * becomes a set lookup. The answer is identical: `\b…\b` on masked source and
 * "appears as an identifier token in masked source" pick out the same
 * occurrences, because the token pattern IS the word-boundary rule.
 */
function identifierIndex(corpus: string[]): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>()
  for (const f of corpus) {
    const src = maskOf.get(f)!
    for (const m of src.matchAll(/[A-Za-z_$][\w$]*/g)) {
      let s = idx.get(m[0])
      if (!s) { s = new Set(); idx.set(m[0], s) }
      s.add(f)
    }
  }
  return idx
}
const productIndex = identifierIndex(productFiles)
const proofIndex = identifierIndex(proofFiles)
stage("C3 index")

const refIn = (name: string, from: string, idx: Map<string, Set<string>>) => {
  const hits = idx.get(name)
  if (!hits) return false
  for (const f of hits) if (f !== from) return true
  return false
}
/**
 * REACHABLE THROUGH ANOTHER EXPORT OF THE SAME MODULE — the false-accusation
 * class this category had, measured on its own first ratcheted run.
 *
 * "No OTHER FILE names this identifier" is the right question for a value, and
 * the wrong one for a TYPE, because TypeScript resolves types structurally. A
 * caller writing
 *
 *     const est = await estimateMonthlyRentFromComps({ address, zip, … })
 *
 * never imports `RentEstimateRequest`, and never needs to: it is the parameter
 * type of an EXPORTED function, so it is part of that module's public surface
 * whether or not any importer spells its name. The same holds for a field type
 * of an exported interface — `ProviderRentEstimate.comps: ProviderRentComp[]`
 * hands every consumer `ProviderRentComp` without a single named import.
 *
 * Measured, not theorised: the first run of this ratchet reported 17 NEW
 * orphans, and all seventeen were this shape — `RentEstimateRequest`,
 * `ProviderRentComp`, `RentUnavailableReason`, `ExternalListingType`,
 * `PhraseCatalogueState`, `RoutedUsage` and the rest, each named in an exported
 * declaration a few lines below its own. Deleting any of them would have broken
 * the module that declares it. A ratchet that fires on correct code does not
 * merely waste a verdict; it teaches whoever meets it to reach for the baseline,
 * which is how a real finding gets waved through later.
 *
 * So the question asked here is the one that decides the matter: is this name
 * used inside the DECLARATION OF ANOTHER EXPORT of the same file? If it is, a
 * consumer reaches it through that export and the pair is not one-sided. If it
 * appears only inside a private helper, or nowhere, it stays a finding — that is
 * still the wire-or-build question this category exists to ask.
 */
function namedInAnotherExport(src: string, name: string, ownLine: number): boolean {
  const lines = src.split("\n")
  const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`)
  let inExport = false
  let depth = 0
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i]
    if (!inExport && /^export\s+(type|interface|enum|class|const|let|var|abstract|declare|async\s+function|function)\b/.test(ln)) {
      inExport = true
      depth = 0
    }
    if (inExport) {
      // Its OWN declaration proves nothing — a type referencing itself is not a consumer.
      const isOwn = i + 1 === ownLine
      if (!isOwn && word.test(ln)) return true
      for (const ch of ln) {
        if (ch === "{" || ch === "(" || ch === "[" || ch === "<") depth++
        else if (ch === "}" || ch === ")" || ch === "]" || ch === ">") depth--
      }
      // A one-line export (`export type X = "a" | "b"`) closes immediately.
      if (depth <= 0 && !/[,{([<]\s*$/.test(ln.trimEnd())) inExport = false
    }
  }
  return false
}

const typeOrphans: ExportRef[] = []
const typeProofOnly: ExportRef[] = []
let typeStructurallyReachable = 0
for (const e of typeExports) {
  if (refIn(e.name, e.file, productIndex)) continue
  if (namedInAnotherExport(maskOf.get(e.file) ?? "", e.name, e.line)) { typeStructurallyReachable++; continue }
  if (refIn(e.name, e.file, proofIndex)) { typeProofOnly.push(e); continue }
  typeOrphans.push(e)
}
stage("C3 exports")
for (const e of typeOrphans) add("orphan-type-export", `${e.file}::${e.name}`, `${e.file}:${e.line}`, `exported ${e.kind}, referenced by no other file`)

control("C3 counted non-function exports at all", typeExports.length > 200, `${typeExports.length} scanned`)
{
  // The partition control, on a fixture that carries one of each shape. The two
  // FUNCTION shapes must NOT appear (orphan-export-guard owns them); the five
  // non-function shapes must ALL appear (nobody has ever counted them).
  const fixture = [
    `export function fnDecl() {}`,
    `export const fnArrow = (x: number) => x`,
    `export const fnTyped: Handler = async (req) => req`,
    `export type TAlias = string`,
    `export interface IFace { a: string }`,
    `export enum EKind { A }`,
    `export class CThing {}`,
    `export const VALUE_MAP = { a: 1 }`,
  ].join("\n")
  const got = scanTypeExports("<control>", maskStrings(blankComments(fixture)))
  const names = got.map((g) => g.name).sort().join(",")
  control("C3 counts every NON-function export shape and no function shape",
    names === "CThing,EKind,IFace,TAlias,VALUE_MAP", names)
}
{
  // A type that IS imported elsewhere must not be reported. `SCHEMA_SNAPSHOT` is
  // imported by this very file and by schema-drift-guard.
  control("C3 sees a REFERENCED export as referenced (no false accusation)",
    !typeOrphans.some((e) => e.name === "SCHEMA_SNAPSHOT"))
}
{
  // THE STRUCTURAL-REACHABILITY EXCLUSION, BOTH DIRECTIONS. An exclusion that
  // only ever excludes is indistinguishable from a scan that stopped working, so
  // it is pinned against a fixture that contains one of each.
  const reachable = [
    `export interface ReqShape { a: string }`,
    `export async function doIt(req: ReqShape): Promise<number> { return 1 }`,
  ].join("\n")
  control("C3 EXCLUDES a type named in another export's declaration",
    namedInAnotherExport(reachable, "ReqShape", 1))

  const privateOnly = [
    `export interface OnlyPrivate { a: string }`,
    `function helper(x: OnlyPrivate) { return x }`,
    `export const VALUE = 1`,
  ].join("\n")
  control("C3 STILL REPORTS a type used only by a PRIVATE helper — the exclusion is not a blanket pass",
    !namedInAnotherExport(privateOnly, "OnlyPrivate", 1))

  const selfOnly = [
    `export type Alone = "a" | "b"`,
    `export const OTHER = 2`,
  ].join("\n")
  control("C3 does not count a type's OWN declaration as a consumer of itself",
    !namedInAnotherExport(selfOnly, "Alone", 1))
}

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 4 — INERT PARAMETER (accepted, never read)
// ═══════════════════════════════════════════════════════════════════════════
//
// Deliberately the NARROWEST scan in this file, because the false-accusation cost
// is highest: a parameter can be required by an interface the function must
// satisfy, and "unused here" is then correct code. So only the shape that cannot
// be anything else is examined:
//   · a `function` DECLARATION (not a callback, not a method, not an arrow) whose
//   · parameters are all plain identifiers with optional type annotations — a
//     destructured, defaulted or rest parameter is counted UNRESOLVED, not judged;
//   · with a real `{ … }` body (an overload signature is unresolved, not inert);
//   · no `arguments` object in the body;
//   · and a parameter name (not `_`-prefixed) that appears NOWHERE in that body.
// Strings are not masked: a parameter used only inside a template literal is a
// real use, and one named inside a plain string is a false negative — safe.
interface InertParam { file: string; fn: string; param: string; line: number }
const inertParams: InertParam[] = []
let paramsExamined = 0
let paramsUnresolved = 0
let functionsExamined = 0

/**
 * WHERE THE BODY ACTUALLY STARTS — the single hardest thing in this category, and
 * the source of its only measured false-accusation class.
 *
 * "The first `{` after the parameter list" is wrong, and wrong in the expensive
 * direction. A return type annotation puts braces between `)` and the body:
 *
 *     async function logActivity(data: { … }): Promise<{ success: boolean }> {
 *
 * The first `{` after `)` belongs to `Promise<…>`, so the "body" became the
 * RETURN TYPE, `data` did not appear in it, and this census's first run accused
 * `logActivity`, `resolveOwnAgentId` and hundreds of other correct functions of
 * ignoring parameters they use on the very next line.
 *
 * So the type expression is walked properly instead: angle-bracket groups and
 * parenthesised function types are skipped whole, and a `{ … }` object return
 * type is recognised by what FOLLOWS it — if the next thing after its closing
 * brace is another `{`, the one just closed was a type and the next is the body.
 * Anything this cannot decide returns null and is COUNTED as unresolved, never
 * judged.
 */
function findFunctionBody(src: string, parenClose: number): { start: number; end: number } | null {
  let i = parenClose + 1
  const limit = Math.min(src.length, parenClose + 8000)
  while (i < limit) {
    const c = src[i]
    if (/\s/.test(c)) { i++; continue }
    if (c === ";" || c === "=") return null            // overload signature, or not a declaration
    if (c === "{") {
      const close = sd.matchBrace(src, i)
      if (close < 0) return null
      let j = close + 1
      while (j < src.length && /\s/.test(src[j])) j++
      // An object RETURN TYPE is followed by the body brace; a body is not.
      if (src[j] === "{") { i = j; continue }
      // …or by a type OPERATOR, when the return type is a bare union or an array
      // of object types: `): { ok: true; … } | { ok: false; … } {`. The
      // parseModelJson / resolveOwnAgentId shape — and without this branch the
      // FIRST arm of the union is mistaken for the body, which is the same false
      // accusation as the Promise<…> trap wearing different punctuation.
      if (src[j] === "|" || src[j] === "&" || src[j] === "," || src[j] === "[") { i = j + 1; continue }
      return { start: i, end: close }
    }
    if (c === "<") {
      let depth = 0
      let k = i
      while (k < limit) {
        if (src[k] === "<") depth++
        else if (src[k] === ">") { depth--; if (depth === 0) { k++; break } }
        else if (src[k] === "{") { const e = sd.matchBrace(src, k); if (e < 0) return null; k = e }
        k++
      }
      if (depth !== 0) return null
      i = k
      continue
    }
    if (c === "(") { const e = sd.matchParen(src, i); if (e < 0) return null; i = e + 1; continue }
    if (c === "[") { let d = 0, k = i; while (k < limit) { if (src[k] === "[") d++; else if (src[k] === "]") { d--; if (d === 0) { k++; break } } k++ } if (d !== 0) return null; i = k; continue }
    i++                                                 // ordinary type text: identifiers, `:`, `|`, `&`, `=>`
  }
  return null
}

function scanInertParams(file: string, src: string): InertParam[] {
  const out: InertParam[] = []
  for (const m of src.matchAll(/(?:^|\n)[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*(?:<[^(]*>)?\s*\(/g)) {
    const parenOpen = m.index! + m[0].length - 1
    const parenClose = sd.matchParen(src, parenOpen)
    if (parenClose < 0) { paramsUnresolved++; continue }
    const paramText = src.slice(parenOpen + 1, parenClose)
    const bodySpan = findFunctionBody(src, parenClose)
    if (!bodySpan) { paramsUnresolved++; continue }
    const b = bodySpan.start
    const bodyEnd = sd.matchBrace(src, b)
    if (bodyEnd < 0) { paramsUnresolved++; continue }
    const body = src.slice(b, bodyEnd + 1)
    functionsExamined++
    if (/\barguments\b/.test(body)) { paramsUnresolved++; continue }
    if (paramText.trim() === "") continue
    for (const raw of sd.splitTopLevel(paramText, ",")) {
      const p = raw.trim()
      if (!p) continue
      if (/^[{[]/.test(p) || p.startsWith("...") || p.includes("=")) { paramsUnresolved++; continue }
      const idm = p.match(/^(?:readonly\s+|public\s+|private\s+|protected\s+)?([A-Za-z_$][\w$]*)\s*\??\s*(?::|$)/)
      if (!idm) { paramsUnresolved++; continue }
      const name = idm[1]
      if (name.startsWith("_") || name === "this") continue
      paramsExamined++
      if (!new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(body)) {
        out.push({ file, fn: m[1], param: name, line: lineOf(src, m.index!) })
      }
    }
  }
  return out
}

for (const f of productFiles) for (const p of scanInertParams(f, codeOf.get(f)!)) inertParams.push(p)
stage("C4 params")

{
  const inert = `export function f(used: string, ignored: number) {\n  return used.length\n}\n`
  const got = scanInertParams("<control>", blankComments(inert))
  control("C4 sees an INERT parameter and only the inert one",
    got.length === 1 && got[0].param === "ignored", got.map((g) => g.param).join(","))
  const usedOnly = `export function g(a: number, b: number) { return a + b }\n`
  control("C4 does NOT accuse a parameter that IS read",
    scanInertParams("<control>", blankComments(usedOnly)).length === 0)
  // THE RETURN-TYPE TRAP, in the exact shape that produced the first run's false
  // accusations (app/actions/activities.ts:logActivity). If the body finder ever
  // regresses to "the first `{` after `)`", this control fails instead of the
  // census quietly accusing hundreds of correct functions again.
  const returnTyped =
    `export async function logIt(data: {\n  a: string\n  b?: string\n}): Promise<{ success: boolean; error?: string }> {\n` +
    `  const row = { a: data.a, b: data.b ?? null }\n  return { success: !!row }\n}\n`
  control("C4 finds the BODY past a Promise<{…}> return type (the logActivity trap)",
    scanInertParams("<control>", blankComments(returnTyped)).length === 0,
    scanInertParams("<control>", blankComments(returnTyped)).map((g) => g.param).join(","))
  const objectReturnType =
    `export function shape(x: number): { n: number } {\n  return { n: x }\n}\n`
  control("C4 finds the BODY past a bare object return type",
    scanInertParams("<control>", blankComments(objectReturnType)).length === 0)
  const multiLineUnion =
    `async function decide(\n  requestedId: string,\n): Promise<{ ok: true; id: string } | { ok: false; error: string }> {\n` +
    `  if (!requestedId) return { ok: false, error: "no" }\n  return { ok: true, id: requestedId }\n}\n`
  control("C4 finds the BODY past a multi-line UNION return type (the resolveOwnAgentId trap)",
    scanInertParams("<control>", blankComments(multiLineUnion)).length === 0)
  const bareUnion =
    `function parseIt<T>(text: string): { ok: true; value: T } | { ok: false; error: string } {\n` +
    `  try { return { ok: true, value: JSON.parse(text) as T } } catch { return { ok: false, error: "x" } }\n}\n`
  control("C4 finds the BODY past a BARE UNION return type (the parseModelJson trap)",
    scanInertParams("<control>", blankComments(bareUnion)).length === 0,
    scanInertParams("<control>", blankComments(bareUnion)).map((g) => g.param).join(","))
  const overload = `export function over(a: string): void\nexport function over(a: string) { return a }\n`
  control("C4 treats an overload SIGNATURE as unresolved, not inert",
    scanInertParams("<control>", blankComments(overload)).length === 0)
  const tmplUse = `export function h(name: string) { return \`hi \${name}\` }\n`
  control("C4 counts a template-literal use as a use",
    scanInertParams("<control>", blankComments(tmplUse)).length === 0)
  const underscore = `export function i(_unused: number, b: number) { return b }\n`
  control("C4 treats a _-prefixed parameter as deliberately unused",
    scanInertParams("<control>", blankComments(underscore)).length === 0)
  const destructured = `export function j({ a, b }: Props) { return 1 }\n`
  control("C4 counts a DESTRUCTURED parameter as unresolved, never as inert",
    scanInertParams("<control>", blankComments(destructured)).length === 0)
  control("C4 examined a real population", functionsExamined > 500 && paramsExamined > 500,
    `${functionsExamined} functions / ${paramsExamined} plain params`)
}
for (const p of inertParams) add("inert-param", `${p.file}::${p.fn}::${p.param}`, `${p.file}:${p.line}`, `${p.fn}() accepts \`${p.param}\` and never reads it`)

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 5 — BROKEN DYNAMIC IMPORT
// ═══════════════════════════════════════════════════════════════════════════
//
// `await import("…")` is the one import shape TypeScript checks LAST and bundlers
// resolve at runtime, and this repo leans on it hard (server actions pulled into
// client components, kernel modules pulled into route handlers). A typo'd path or
// a renamed export fails at the moment the feature is used, not at build.
//
// Only STATIC string specifiers are decidable; an interpolated one is counted
// unresolved. Bare package specifiers are checked for presence in node_modules
// and otherwise counted unresolved rather than accused — a subpath export map is
// not something a file-existence test can adjudicate.
let dynImports = 0
let dynUnresolvedSpecifier = 0
let dynExternal = 0
let dynNamedChecked = 0
let dynNamedUnresolvable = 0

function resolveModule(fromFile: string, spec: string): string | null {
  let base: string
  if (spec.startsWith("@/")) base = join(root, spec.slice(2))
  else if (spec.startsWith("./") || spec.startsWith("../")) base = resolve(root, dirname(fromFile), spec)
  else return null                                        // bare package specifier
  const cands = [
    base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.json`,
    join(base, "index.ts"), join(base, "index.tsx"), join(base, "index.js"),
  ]
  for (const c of cands) {
    try { if (statSync(c).isFile()) return rel(c) } catch { /* keep looking */ }
  }
  return null
}

/** The names a module exports, as far as a static read can tell. */
const exportNamesCache = new Map<string, Set<string> | null>()
function exportNamesOf(file: string): Set<string> | null {
  if (exportNamesCache.has(file)) return exportNamesCache.get(file)!
  const src = maskOf.get(file) ?? maskStrings(blankComments(readFileSync(join(root, file), "utf8")))
  // `export * from "…"` re-exports an unknown set — refuse to judge this module.
  if (/export\s+\*\s+from/.test(src)) { exportNamesCache.set(file, null); return null }
  const names = new Set<string>()
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) names.add(m[1])
  for (const m of src.matchAll(/export\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1])
  for (const m of src.matchAll(/export\s+(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|enum)\s+([A-Za-z0-9_$]+)/g)) names.add(m[1])
  for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const piece of m[1].split(",")) {
      const p = piece.trim().replace(/^type\s+/, "")
      if (!p) continue
      const asM = p.match(/\bas\s+([A-Za-z_$][\w$]*)$/)
      names.add(asM ? asM[1] : p)
    }
  }
  if (/export\s+default\b/.test(src)) names.add("default")
  exportNamesCache.set(file, names)
  return names
}

for (const f of productFiles) {
  const src = codeOf.get(f)!
  for (const m of src.matchAll(/\bimport\s*\(\s*(["'`])([^"'`]*)\1\s*\)/g)) {
    dynImports++
    const spec = m[2]
    const line = lineOf(src, m.index!)
    if (spec.includes("${")) { dynUnresolvedSpecifier++; continue }
    const target = resolveModule(f, spec)
    if (target === null) {
      if (spec.startsWith("@/") || spec.startsWith(".")) {
        add("broken-dynamic-import", `${f}::${spec}`, `${f}:${line}`, `await import("${spec}") resolves to no file`)
        continue
      }
      dynExternal++
      continue
    }
    // Which named exports does the call site pull off the module?
    const pre = src.slice(Math.max(0, m.index! - 200), m.index!)
    const post = src.slice(m.index! + m[0].length, m.index! + m[0].length + 200)
    const wanted = new Set<string>()
    const destructure = pre.match(/(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?$/)
    if (destructure) for (const piece of destructure[1].split(",")) {
      const p = piece.trim().split(":")[0].trim()
      if (/^[A-Za-z_$][\w$]*$/.test(p)) wanted.add(p)
    }
    // `import(…)` RETURNS A PROMISE, so `.then` / `.catch` / `.finally` after it
    // are Promise methods, not module exports. Reading them as exports is not a
    // small error: this census's first run reported 40 sites as "imports `then`,
    // which the target does not export", every one of them ordinary correct code.
    const PROMISE_METHODS = new Set(["then", "catch", "finally"])
    const propAccess = post.match(/^\s*\)?\s*\.\s*([A-Za-z_$][\w$]*)/)
    if (propAccess && !PROMISE_METHODS.has(propAccess[1])) wanted.add(propAccess[1])
    // …but `.then((m) => m.NAME)` DOES name an export, one level in.
    const thenAccess = post.match(/^\s*\.then\(\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*=>\s*\1\s*\.\s*([A-Za-z_$][\w$]*)/)
    if (thenAccess) wanted.add(thenAccess[2])
    if (wanted.size === 0) continue
    const have = exportNamesOf(target)
    if (have === null) { dynNamedUnresolvable += wanted.size; continue }
    for (const w of wanted) {
      dynNamedChecked++
      if (!have.has(w)) {
        add("dynamic-import-missing-export", `${f}::${spec}::${w}`, `${f}:${line}`,
          `await import("${spec}") destructures \`${w}\`, which ${target} does not export`)
      }
    }
  }
}

stage("C5 dynimports")
{
  control("C5 found dynamic imports at all", dynImports > 10, `${dynImports} await import() sites`)
  control("C5 resolves a path that DOES exist",
    resolveModule("scripts/opposite-missing-census.ts", "./strip-comments") === "scripts/strip-comments.ts",
    String(resolveModule("scripts/opposite-missing-census.ts", "./strip-comments")))
  control("C5 reports a path that does NOT exist as unresolved",
    resolveModule("scripts/opposite-missing-census.ts", "./definitely-not-a-real-module") === null)
  const names = exportNamesOf("scripts/strip-comments.ts")
  control("C5 reads a module's export names",
    !!names && names.has("blankComments") && names.has("stripComments") && !names.has("scan"),
    names ? [...names].join(",") : "null")
}

// ═══════════════════════════════════════════════════════════════════════════
// CATEGORY 6 — ROUTE ↔ FETCH PAIRING
// ═══════════════════════════════════════════════════════════════════════════
//
// orphan-route-sweep deliberately returns null for anything starting `/api/`
// (its line 236), so the entire API surface — 438 route files — has never been
// paired against its callers in either direction.
//
//   B → A (a fetch with no route) is a guaranteed runtime 404 and is a DEFECT.
//   A → B (a route no string in the tree addresses) is a WIRE QUESTION, not a
//     defect: cron targets, provider webhooks, OAuth callbacks and embed
//     endpoints are all addressed from OUTSIDE the repo by design. Those are
//     classified and reported separately so the honest list stays readable.
interface RouteDef { path: string; file: string; methods: string[] }
const routeDefs: RouteDef[] = []
const apiDir = join(root, "app", "api")
if (existsSync(apiDir)) {
  for (const abs of walkTs(apiDir)) {
    if (!/\/route\.tsx?$/.test(abs.replace(/\\/g, "/"))) continue
    const file = rel(abs)
    const path = "/" + file.replace(/^app\//, "").replace(/\/route\.tsx?$/, "")
    const src = maskOf.get(file) ?? maskStrings(blankComments(readFileSync(abs, "utf8")))
    const methods: string[] = []
    for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) methods.push(m[1])
    if (methods.length > 0) routeDefs.push({ path, file, methods })
  }
}

/** Every `/api/...` STRING LITERAL in the tree, normalised: `${…}` → `*`. */
interface FetchRef { path: string; file: string; line: number; isRequest: boolean }
const fetchRefs: FetchRef[] = []
const extraRefCorpus: string[] = []
for (const name of ["vercel.json", "next.config.mjs", "next.config.js", "middleware.ts"]) {
  const p = join(root, name)
  if (existsSync(p)) { try { extraRefCorpus.push(readFileSync(p, "utf8")) } catch { /* unreadable */ } }
}

// THREE regexes, one per quote style, and none of them uses a BACKREFERENCE.
// The single `(["'`])…\1` form backtracks catastrophically on a file with an
// unterminated quote (an apostrophe in JSX text is enough), and this scan runs
// over every file in the tree — a hang here would look exactly like a slow
// census rather than like a bug.
const LITERAL_RES = [
  /"((?:\\.|[^"\\\n])*)"/g,
  /'((?:\\.|[^'\\\n])*)'/g,
  /`((?:\\.|[^`\\])*)`/g,
]
/**
 * A literal that is the ARGUMENT OF A REQUEST, not merely a literal that looks
 * like a path.
 *
 * The two directions of category 6 need different evidence, and conflating them
 * was this census's second false-accusation source. `fetchRefs` (any `/api/…`
 * literal anywhere) is the right evidence for direction 6b — a route mentioned
 * by ANY string is a route something plausibly addresses, and being generous
 * there suppresses findings rather than inventing them. Direction 6a is an
 * accusation ("this call 404s"), so it needs the literal to actually be handed
 * to a request: `app/constants/auth.ts`'s middleware PREFIX table and
 * `app/robots.ts`'s `/api` disallow rule are neither fetches nor routes, and
 * reporting 25 of them as runtime 404s is exactly the noise that gets an
 * instrument switched off.
 */
const REQUEST_OPENERS = [
  "fetch(", "Request(", "redirect(", "revalidatePath(", "EventSource(",
  // SWR takes the URL as its KEY and hands it to the fetcher — a dashboard polling
  // a nonexistent path every 30 seconds is exactly the defect 6a exists to find,
  // and the live example (app/dashboard/coordination) is spelled this way, not
  // with a bare fetch. A caller list that only knows `fetch(` reports zero and
  // looks clean.
  "useSWR(", "useSWRImmutable(", "useSWRMutation(", "useSWRSubscription(",
  "axios(", "axios.get(", "axios.post(", "axios.put(", "axios.patch(", "axios.delete(",
]
function isRequestArgument(src: string, litStart: number): boolean {
  const back = src.slice(Math.max(0, litStart - 160), litStart)
  let opener = -1
  for (const o of REQUEST_OPENERS) opener = Math.max(opener, back.lastIndexOf(o))
  if (opener < 0) return false
  // Nothing may CLOSE that call before the literal — otherwise the opener found is
  // a previous, unrelated call sitting earlier on the same line.
  return !back.slice(opener).includes(")")
}

function collectFetchRefs(file: string, src: string) {
  for (const re of LITERAL_RES) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(src))) {
      const text = m[1]
      // Must START with /api/ — that rules out `https://other.host/api/x`, which
      // is somebody else's server and not a route this repo is expected to own.
      // (An external base URL spelled `${API_BASE}/api/v1/…` starts with the
      // interpolation, so it is excluded by the same rule.)
      if (!text.startsWith("/api/")) continue
      const path = text.split("?")[0].split("#")[0].replace(/\$\{[^}]*\}/g, "*").replace(/\/+$/, "")
      fetchRefs.push({ path, file, line: lineOf(src, m.index!), isRequest: isRequestArgument(src, m.index!) })
    }
  }
}
for (const f of productFiles) collectFetchRefs(f, codeOf.get(f)!)
for (const [i, text] of extraRefCorpus.entries()) collectFetchRefs(`<config#${i}>`, text)
stage("C6 routes")

function segsOf(p: string): string[] { return p.split("/").filter(Boolean) }
function routeMatches(routePath: string, refPath: string): boolean {
  const r = segsOf(routePath), c = segsOf(refPath)
  for (let i = 0; i < r.length; i++) {
    if (r[i].startsWith("[...") || r[i].startsWith("[[...")) return c.length >= i   // catch-all eats the tail
    if (i >= c.length) return false
    if (r[i].startsWith("[")) continue                    // dynamic segment: anything
    if (c[i] === "*") continue                            // interpolated caller segment: anything
    if (r[i] !== c[i]) return false
  }
  return c.length === r.length
}

const routesWithNoCaller: RouteDef[] = []
for (const r of routeDefs) if (!fetchRefs.some((f) => routeMatches(r.path, f.path))) routesWithNoCaller.push(r)

const fetchesWithNoRoute: FetchRef[] = []
const seenBadFetch = new Set<string>()
let unroutedNonRequestLiterals = 0
for (const f of fetchRefs) {
  if (f.path.includes("*") && segsOf(f.path).length <= 2) continue   // `/api/${x}` — addresses nothing decidable
  if (routeDefs.some((r) => routeMatches(r.path, f.path))) continue
  // Only an actual request argument can 404. Everything else — middleware prefix
  // tables, robots.txt disallow rules, documentation constants — is counted and
  // reported as coverage, never as a defect.
  if (!f.isRequest) { unroutedNonRequestLiterals++; continue }
  if (seenBadFetch.has(f.path)) continue
  seenBadFetch.add(f.path)
  fetchesWithNoRoute.push(f)
}

/** Addressed from outside the repo BY DESIGN — a caller in the tree is not expected. */
const EXTERNALLY_ADDRESSED = /\/(cron|webhooks?|callback|oauth|auth|health|og|rss|sitemap|robots|embed|public|inbound|twilio|stripe|vapi|retell|resend|sendgrid|did|elevenlabs|apify|zenrows|clerk|mls|idx|widget)(\/|$)/i
for (const r of routesWithNoCaller) {
  const external = EXTERNALLY_ADDRESSED.test(r.path)
  add(external ? "route-external-caller" : "route-no-caller", r.path, `${r.file}:1`,
    `${r.methods.join("/")} exported; no string in the tree addresses it${external ? " (external caller expected — classify, do not delete)" : ""}`)
}
for (const f of fetchesWithNoRoute) add("fetch-no-route", f.path, `${f.file}:${f.line}`, `addressed, but no app/api route file exists`)

{
  control("C6 found route handlers at all", routeDefs.length > 100, `${routeDefs.length} route files with a method export`)
  control("C6 found /api/ call sites at all", fetchRefs.length > 100, `${fetchRefs.length} literals`)
  control("C6 matches a dynamic segment", routeMatches("/api/listings/[id]/offers", "/api/listings/*/offers"))
  control("C6 matches a catch-all", routeMatches("/api/auth/[...nextauth]", "/api/auth/signin/x"))
  control("C6 refuses a length mismatch", !routeMatches("/api/a/b", "/api/a"))
  control("C6 refuses a segment mismatch", !routeMatches("/api/a/b", "/api/a/c"))
  control("C6 ignores an ABSOLUTE url on another host", (() => {
    const before = fetchRefs.length
    collectFetchRefs("<control>", `const u = "https://other.example.com/api/whatever"`)
    const grew = fetchRefs.length - before
    fetchRefs.length = before
    return grew === 0
  })())
  control("C6 DOES see a same-origin literal", (() => {
    const before = fetchRefs.length
    collectFetchRefs("<control>", `await fetch("/api/control/probe")`)
    const grew = fetchRefs.length - before
    const wasRequest = fetchRefs[fetchRefs.length - 1]?.isRequest === true
    fetchRefs.length = before
    return grew === 1 && wasRequest
  })())
  control("C6 sees an SWR key as a request (the coordination-dashboard shape)", (() => {
    const before = fetchRefs.length
    collectFetchRefs("<control>", "const { data } = useSWR(`/api/control/sessions?x=${id}`, fetcher)")
    const ok = fetchRefs.slice(before).some((f) => f.isRequest)
    fetchRefs.length = before
    return ok
  })())
  // END-TO-END: a request to a path with no route file MUST come out as a finding.
  // Without this, 6a reporting zero is indistinguishable from a scanner that
  // cannot form the accusation at all.
  control("C6 END-TO-END: an unrouted request IS classified as a 404", (() => {
    const before = fetchRefs.length
    collectFetchRefs("<control>", `await fetch("/api/definitely-not-a-route/probe")`)
    const probe = fetchRefs[fetchRefs.length - 1]
    const flagged = !!probe && probe.isRequest && !routeDefs.some((r) => routeMatches(r.path, probe.path))
    fetchRefs.length = before
    return flagged
  })())
  control("C6 END-TO-END: a request to a REAL route is NOT classified as a 404", (() => {
    const real = routeDefs.find((r) => !r.path.includes("["))
    if (!real) return false
    const before = fetchRefs.length
    collectFetchRefs("<control>", `await fetch("${real.path}")`)
    const probe = fetchRefs[fetchRefs.length - 1]
    const clean = !!probe && routeDefs.some((r) => routeMatches(r.path, probe.path))
    fetchRefs.length = before
    return clean
  })())
  control("C6 does NOT read a middleware PREFIX table entry as a request", (() => {
    const before = fetchRefs.length
    collectFetchRefs("<control>", `const PUBLIC_PREFIXES = ["/api/auth", "/api/public"]`)
    const anyRequest = fetchRefs.slice(before).some((f) => f.isRequest)
    const seen = fetchRefs.length - before
    fetchRefs.length = before
    return seen === 2 && !anyRequest
  })())
}

// ═══════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════
const CATEGORIES = [
  ["col-write-no-read", "1a. COLUMN written by code, read by NOBODY"],
  ["col-read-no-write", "1b. COLUMN read by code, written by NOBODY"],
  ["dead-import", "2.  DEAD IMPORT — symbol imported, never used in that file"],
  ["orphan-type-export", "3.  ORPHANED type/interface/enum/class/const export"],
  ["inert-param", "4.  INERT PARAMETER — accepted, never read"],
  ["broken-dynamic-import", "5a. await import() of a path that does not exist"],
  ["dynamic-import-missing-export", "5b. await import() of a name the target does not export"],
  ["fetch-no-route", "6a. fetch(\"/api/…\") with NO route file — a runtime 404"],
  ["route-no-caller", "6b. route handler nothing in the tree addresses"],
  ["route-external-caller", "6c. route handler addressed only from OUTSIDE (cron/webhook/callback)"],
] as const

const counts: Record<string, number> = {}
for (const [c] of CATEGORIES) counts[c] = findings.filter((f) => f.cat === c).length

console.log("══════════════════════════════════════════════════")
console.log(" OPPOSITE-MISSING CENSUS — halves built without their other half")
console.log("══════════════════════════════════════════════════")
console.log(` corpus: ${productFiles.length} runtime files · ${proofFiles.length} proof files`)

// ── CONTROLS FIRST. A zero from a blind scanner is worth nothing. ────────────
const failedControls = controls.filter((c) => !c.ok)
console.log(`\n[positive controls] ${controls.length - failedControls.length}/${controls.length} passing`)
for (const c of controls) if (!c.ok) console.log(`  ✗ ${c.name}${c.note ? ` — ${c.note}` : ""}`)
if (failedControls.length > 0) {
  console.log("\n  A FAILED CONTROL MEANS THE SCANNER IS BLIND, NOT THAT THE TREE IS CLEAN.")
  console.log("  No counts are reported and no baseline is written.")
  console.log(" ❌ OPPOSITE_MISSING_FAIL — positive control failed")
  process.exit(1)
}
if (process.env.OPPOSITE_MISSING_VERBOSE === "1") {
  for (const c of controls) console.log(`  ✓ ${c.name}${c.note ? ` — ${c.note}` : ""}`)
  console.log("\n[stage timings, ms]")
  for (const [n, ms] of stages) console.log(`  ${String(ms).padStart(7)}  ${n}`)
}

console.log("\n[coverage — the denominators, printed next to every numerator]")
console.log(`  C1 columns   · ${pairedTables.length} tables both written AND read (the only ones asked)`)
console.log(`               · ${selectSitesParsed} select sites parsed · ${starRead.size} tables read with select("*") (excluded from 1a)`)
console.log(`               · ${opaqueWrite.size} tables with an OPAQUE write object (excluded from 1b) · ${unresolvedWriteObjects} opaque write sites`)
console.log(`               · ${TRIGGER_WRITTEN.size} table(s) with DB-trigger-written columns read from supabase/migrations (exempt from 1b)`)
console.log(`               · ${unresolvedEmbeds} unresolvable embeds · ${unresolvedFilterTerms} unresolvable filter terms · ${rpcTouched.size} tables in .rpc() files (excluded entirely)`)
console.log(`  C2 imports   · ${importBindings.length} bindings across ${importStatements} statements (+${sideEffectImports} side-effect imports, not bindings)`)
console.log(`  C3 exports   · ${typeExports.length} non-function exports · ${typeProofOnly.length} named only by a proof (reported, not failed)`)
console.log(`               · ${typeStructurallyReachable} reachable through ANOTHER export of the same module (a type in an exported signature needs no named import)`)
console.log(`  C4 params    · ${paramsExamined} plain params in ${functionsExamined} function declarations · ${paramsUnresolved} unresolved (destructured/defaulted/rest/overload)`)
console.log(`  C5 dynimport · ${dynImports} sites · ${dynNamedChecked} named-export checks · ${dynExternal} bare package specifiers skipped · ${dynUnresolvedSpecifier} interpolated · ${dynNamedUnresolvable} behind an \`export *\``)
console.log(`  C6 routes    · ${routeDefs.length} route files with a method export · ${fetchRefs.length} /api/ literals (${fetchRefs.filter((f) => f.isRequest).length} handed to a request)`)
console.log(`               · ${unroutedNonRequestLiterals} unrouted /api/ literal(s) that are NOT requests (middleware prefix tables, robots rules) — counted, never accused`)

console.log("\n[findings]")
for (const [cat, label] of CATEGORIES) console.log(`  ${String(counts[cat]).padStart(5)}  ${label}`)
console.log(`  ${String(findings.length).padStart(5)}  TOTAL`)

if (LIST) {
  for (const [cat, label] of CATEGORIES) {
    const rows = findings.filter((f) => f.cat === cat)
    if (rows.length === 0) continue
    console.log(`\n── ${label} (${rows.length}) ──`)
    for (const r of rows.slice(0, 400)) console.log(`   ${r.where}  ${r.key}\n        ${r.detail}`)
    if (rows.length > 400) console.log(`   … and ${rows.length - 400} more`)
  }
  console.log("\nNOT AN ASSERTION — this is the wire list, not a verdict. Build the missing")
  console.log("half; delete only against a NAMED duplicate at file:line.")
  process.exit(0)
}

// ── BASELINE — a fail-on-new ratchet, not a one-shot report ──────────────────
//
// Keys, not counts. A count-only baseline cannot tell a fix from a swap: burn one
// dead import down and add another and the number is unchanged while a new defect
// shipped. It also cannot tell a fix from a DELETION, which is how a ratchet ends
// up rewarding the removal of capability — the failure mode orphan-export-guard's
// header documents at length.
interface BaselineShape { generated: string; counts: Record<string, number>; keys: Record<string, string[]> }
const keysByCat: Record<string, string[]> = {}
for (const [cat] of CATEGORIES) keysByCat[cat] = findings.filter((f) => f.cat === cat).map((f) => f.key).sort()

if (process.env.OPPOSITE_MISSING_BASELINE === "1") {
  const next: BaselineShape = { generated: new Date().toISOString().slice(0, 10), counts, keys: keysByCat }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`)
  console.log(`\n⚙ baseline written: ${findings.length} findings across ${CATEGORIES.length} categories`)
  process.exit(0)
}

if (!existsSync(BASELINE_PATH)) {
  console.log(`\n  no baseline yet — write one with OPPOSITE_MISSING_BASELINE=1`)
  console.log(" ✅ OPPOSITE_MISSING_PASS (unratcheted)")
  process.exit(0)
}

const base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BaselineShape
const fresh: string[] = []
const burned: string[] = []
for (const [cat, label] of CATEGORIES) {
  const had = new Set(base.keys?.[cat] ?? [])
  const now = new Set(keysByCat[cat])
  for (const k of now) if (!had.has(k)) fresh.push(`${label.slice(0, 3)} ${k}`)
  for (const k of had) if (!now.has(k)) burned.push(`${label.slice(0, 3)} ${k}`)
}

if (burned.length > 0) {
  console.log(`\n  ↓ ${burned.length} baseline entr(ies) no longer present — tighten with OPPOSITE_MISSING_BASELINE=1`)
  for (const b of burned.slice(0, 25)) console.log(`     ${b}`)
  if (burned.length > 25) console.log(`     … and ${burned.length - 25} more`)
}

console.log("\n──────────────────────────────────────────────────")
if (fresh.length > 0) {
  console.log(`  ✗ ${fresh.length} NEW one-sided pair(s):`)
  for (const f of fresh.slice(0, 40)) console.log(`     - ${f}`)
  if (fresh.length > 40) console.log(`     … and ${fresh.length - 40} more`)
  console.log("\n  Each needs a verdict under the standing doctrine:")
  console.log("    · a NAMED duplicate at file:line → merge onto the survivor, delete with a tombstone")
  console.log("    · no duplicate → BUILD the missing half (the wire, the writer, the reader, the surface)")
  console.log("  Never delete to move this number.")
  console.log(" ❌ OPPOSITE_MISSING_FAIL")
  process.exit(1)
}
console.log(` ✅ OPPOSITE_MISSING_PASS — no NEW one-sided pair (${findings.length} on the wire list, burn-down)`)
