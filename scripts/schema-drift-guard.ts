#!/usr/bin/env tsx
/**
 * scripts/schema-drift-guard.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Wave 66 — the SCHEMA-DRIFT GUARD. This session repeatedly found the same silent
 * killer: code that .select()/.insert()/.upsert()s a column the live table doesn't
 * have → PostgREST errors the whole query → the feature silently does nothing (the
 * bug that broke buyer matching end-to-end). This guard makes that class impossible
 * to reintroduce: it scans app/ + lib/ for column references on the guarded tables and
 * checks each against the committed live-schema snapshot (scripts/schema-snapshot.ts).
 *
 *   Layer 1 — pure: the column parsers (select lists incl. concatenation/interpolation/
 *     embeds/aliases; object top-level keys) are correct.
 *   Layer 2 — repo scan: every .from(guarded).select("...") column + every .insert/.upsert
 *     object key must exist in the snapshot, else fail (with file + offending column).
 *
 * Run anywhere (no DB/creds). Regenerate the snapshot when a guarded table changes.
 * Run: npx tsx scripts/schema-drift-guard.ts  (npm run test:schema-drift)
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { resolveTableManager } from "../lib/kernel/manager-registry"

const BASELINE_PATH = join(process.cwd(), "scripts/schema-drift-baseline.json")
const vkey = (v: { file: string; table: string; op: string; column: string }) => `${v.file}::${v.table}.${v.column}::${v.op}`

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const GUARDED = new Set(Object.keys(SCHEMA_SNAPSHOT))

// ── Parsers (pure) ───────────────────────────────────────────────────────────

/** Join concatenated string literals (\"a\" + \"b\" + `c`), stripping ${...} interpolations
 *  (those resolve to validated SELECT constants we can't statically expand). */
export function collectSelectArg(src: string, fromIdx: number): string | null {
  // find the `.select(` that chains off this from(), before the NEXT `.from(` (skip the
  // current one at index 0 — otherwise the window collapses / spills into another query).
  const rest = src.slice(fromIdx)
  const nf = rest.slice(1).search(/\.from\(/)
  const window = nf >= 0 ? rest.slice(0, nf + 1) : rest
  const sel = window.search(/\.select\s*\(/)
  if (sel < 0) return null
  // capture from after `(` to the matching `)`
  const open = window.indexOf("(", sel + 1)
  const close = matchParen(window, open)
  if (close < 0) return null
  // only the FIRST argument is the column list — a 2nd arg is the options object
  // (e.g. { count: "exact" }), whose string literals are NOT columns.
  const arg = firstArg(window.slice(open + 1, close))
  // pull out string-literal pieces ("...", '...', `...`), strip ${...}
  let out = ""
  const re = /"([^"]*)"|'([^']*)'|`([^`]*)`/g
  let m: RegExpExecArray | null
  while ((m = re.exec(arg))) out += (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^}]*\}/g, " ") + ","
  return out
}

/** The first top-level argument (up to the first comma not inside a string/brace/bracket/paren). */
function firstArg(s: string): string {
  let depth = 0, q: string | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (q) { if (ch === q && s[i - 1] !== "\\") q = null; continue }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue }
    if (ch === "{" || ch === "(" || ch === "[") depth++
    else if (ch === "}" || ch === ")" || ch === "]") depth--
    else if (ch === "," && depth === 0) return s.slice(0, i)
  }
  return s
}

/** Columns referenced by a PostgREST select() string. Handles: *, embeds (incl. an
 *  `alias:rel(...)` prefix), renames (`alias:real_column` → the REAL column after the
 *  colon), casts (`col::type`), json paths (`col->>x`), and hints (`col!inner`). */
export function parseSelectColumns(literal: string): string[] {
  const cols: string[] = []
  // strip embedded relations, including any `alias:` and `!hint` before the `(...)`.
  const cleaned = literal.replace(/([a-z_][a-z0-9_]*\s*:\s*)?[a-z_][a-z0-9_]*\s*(![a-z_]+)?\s*\([^)]*\)/gi, " ")
  for (let part of cleaned.split(",")) {
    part = part.trim()
    if (!part || part === "*") continue
    part = part.replace(/::[a-z_]+/gi, "")          // ::cast
    part = part.split("->")[0].trim()                // json path col->>'x'
    if (part.includes(":")) part = part.split(":").pop()!.trim()  // alias:real_column → real_column
    part = part.replace(/!.*$/, "").trim()           // col!inner
    const id = part.match(/^[a-z_][a-z0-9_]*$/i)
    if (id) cols.push(id[0])
  }
  return cols
}

/** Top-level keys of an object literal `{ a: 1, b: foo({..}), c }` at brace depth 1.
 *  A key only counts when it directly follows `{` or `,` (depth 1) — so a ternary branch
 *  `cond ? ident : null` is NOT mistaken for an `ident:` key. Skips strings. */
export function parseObjectTopLevelKeys(objText: string): string[] {
  const keys: string[] = []
  const s = objText
  const stack: string[] = []
  let lastSig = ""        // last significant (non-ws) char at the current scope
  let q: string | null = null
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (q) { if (ch === q && s[i - 1] !== "\\") q = null; i++; continue }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; lastSig = ch; i++; continue }
    if (ch === "{" || ch === "(" || ch === "[") { stack.push(ch); lastSig = ch; i++; continue }
    if (ch === "}" || ch === ")" || ch === "]") { stack.pop(); lastSig = ch; i++; continue }
    if (stack.length === 1 && /[a-z_]/i.test(ch) && (lastSig === "{" || lastSig === ",")) {
      const m = s.slice(i).match(/^([a-z_][a-z0-9_]*)\s*:/i)
      if (m) { keys.push(m[1]); lastSig = ":"; i += m[0].length; continue }
    }
    if (!/\s/.test(ch)) lastSig = ch
    i++
  }
  // Conditional/ternary spreads — `...(cond && { col: v })` / `...(c ? {a:1} : {b:2})` — write
  // real columns whose keys live 2+ braces deep, so the depth-1 loop above misses them. This is
  // exactly the blind spot that let a phantom `phone_secondary` write reach contacts. Extract the
  // inner object-literal keys from any `...( … )` spread. Plain nested values (`meta: { z }`) and
  // function-call spreads (`...fn(args)`) are left alone — only `...` IMMEDIATELY before `(` counts.
  for (const k of extractConditionalSpreadKeys(s)) if (!keys.includes(k)) keys.push(k)
  return keys
}

function extractConditionalSpreadKeys(s: string): string[] {
  const keys: string[] = []
  let i = 0
  while (i < s.length) {
    const sp = s.indexOf("...", i)
    if (sp === -1) break
    let j = sp + 3
    while (j < s.length && /\s/.test(s[j])) j++
    if (s[j] !== "(") { i = sp + 3; continue } // not a parenthesised spread (e.g. ...obj, ...fn())
    const close = matchParen(s, j)
    if (close === -1) break
    const inner = s.slice(j + 1, close)
    // Every object literal inside the spread expression contributes column-write keys.
    let k = 0
    while (k < inner.length) {
      if (inner[k] === "{") {
        const bclose = matchBrace(inner, k)
        if (bclose === -1) break
        for (const key of parseObjectTopLevelKeys(inner.slice(k, bclose + 1))) keys.push(key)
        k = bclose + 1
      } else k++
    }
    i = close + 1
  }
  return keys
}

function matchParen(s: string, open: number): number {
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") d++
    else if (s[i] === ")") { d--; if (d === 0) return i }
  }
  return -1
}
function matchBrace(s: string, open: number): number {
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") d++
    else if (s[i] === "}") { d--; if (d === 0) return i }
  }
  return -1
}

// ── Layer 1: parser self-tests ───────────────────────────────────────────────
function testPure() {
  console.log("\n[Layer 1 · parsers]")
  check("parseSelectColumns: plain list", JSON.stringify(parseSelectColumns("a, b, c")) === JSON.stringify(["a", "b", "c"]))
  check("parseSelectColumns: ignores * and embeds", JSON.stringify(parseSelectColumns("*, listings(address, city), id")) === JSON.stringify(["id"]))
  check("parseSelectColumns: embed with alias (seller:seller_contact_id(...)) is skipped", JSON.stringify(parseSelectColumns("id, seller:seller_contact_id(id, first_name), agent:agent_id(id)")) === JSON.stringify(["id"]))
  check("parseSelectColumns: rename alias checks the REAL column (price:list_price → list_price)", JSON.stringify(parseSelectColumns("price:list_price, sqft:sqft")) === JSON.stringify(["list_price", "sqft"]))
  check("parseObjectTopLevelKeys: ternary branch is NOT a key", JSON.stringify(parseObjectTopLevelKeys("{ inferred_beds_min: avgBeds > 0 ? avgBeds : null, x: 1 }")) === JSON.stringify(["inferred_beds_min", "x"]))
  check("parseSelectColumns: strips interpolation residue", parseSelectColumns("  , signals_processed, last_calculated_at").join() === "signals_processed,last_calculated_at")
  check("parseObjectTopLevelKeys: flat", JSON.stringify(parseObjectTopLevelKeys("{ contact_id: x, brokerage_id: y }")) === JSON.stringify(["contact_id", "brokerage_id"]))
  check("parseObjectTopLevelKeys: ignores nested", JSON.stringify(parseObjectTopLevelKeys("{ a: 1, meta: { z: 2 }, b: 3 }")) === JSON.stringify(["a", "meta", "b"]))
  check("parseObjectTopLevelKeys: catches conditional-spread keys (...(cond && {col:v}))",
    JSON.stringify(parseObjectTopLevelKeys("{ email: x, ...(p && { phone_secondary: p }), id: y }")) === JSON.stringify(["email", "id", "phone_secondary"]))
  check("parseObjectTopLevelKeys: catches BOTH ternary-spread branches",
    JSON.stringify(parseObjectTopLevelKeys("{ a: 1, ...(c ? { left_col: 1 } : { right_col: 2 }) }")) === JSON.stringify(["a", "left_col", "right_col"]))
  check("parseObjectTopLevelKeys: function-call spread args are NOT columns (...fn(profile, {opt}))",
    JSON.stringify(parseObjectTopLevelKeys("{ a: 1, ...mapCols(profile, { enrichedAt: t }), b: 2 }")) === JSON.stringify(["a", "b"]))
  check("parseObjectTopLevelKeys: nested value object inside conditional spread value is not double-counted",
    JSON.stringify(parseObjectTopLevelKeys("{ ...(c && { col: { deep: 1 } }) }")) === JSON.stringify(["col"]))
  // The exact bug we fixed must be caught:
  const badSel = parseSelectColumns("preferred_price_max, preferred_features, inferred_max_price")
  check("catches the legacy phantom column (preferred_features ∉ property_preferences)",
    badSel.includes("preferred_features") && !SCHEMA_SNAPSHOT.property_preferences.includes("preferred_features"))
}

// ── Layer 2: repo scan ───────────────────────────────────────────────────────
function walk(dir: string, acc: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
}

interface Violation { file: string; table: string; op: string; column: string }

function scanFile(file: string, src: string): Violation[] {
  const v: Violation[] = []
  const fromRe = /\.from\(\s*["'`]([a-z_]+)["'`]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = fromRe.exec(src))) {
    const table = m[1]
    if (!GUARDED.has(table)) continue
    const cols = SCHEMA_SNAPSHOT[table]
    const set = new Set(cols)
    // SELECT columns
    const sel = collectSelectArg(src, m.index)
    if (sel) for (const c of parseSelectColumns(sel)) if (!set.has(c)) v.push({ file, table, op: "select", column: c })
    // INSERT / UPSERT object keys — only when chained to THIS from() (before the next .from()).
    const after = src.slice(m.index)
    const nextFrom = after.slice(1).search(/\.from\(/)
    const chain = nextFrom >= 0 ? after.slice(0, nextFrom + 1) : after
    const opM = chain.match(/\.(insert|upsert|update)\(\s*\{/)
    if (opM && opM.index != null) {
      const braceOpen = m.index + (opM.index + opM[0].length - 1)
      const braceClose = matchBrace(src, braceOpen)
      if (braceClose > braceOpen) {
        const obj = src.slice(braceOpen, braceClose + 1)
        for (const k of parseObjectTopLevelKeys(obj)) if (!set.has(k)) v.push({ file, table, op: opM[1], column: k })
      }
    }
    // FILTER / order column args (the first string arg is a real column). A filter on a
    // phantom column errors the query the same way a select does. Skip embed paths (col
    // with a `.`) and the .or()/.filter() string DSL (column names live inside a string).
    for (const fm of chain.matchAll(/\.(eq|neq|gt|gte|lt|lte|like|ilike|in|is|contains|containedBy|order|not)\(\s*["'`]([a-zA-Z_][a-zA-Z0-9_.]*)["'`]/g)) {
      const col = fm[2]
      if (col.includes(".")) continue
      if (!set.has(col)) v.push({ file, table, op: fm[1], column: col })
    }
  }
  return v
}

function testScan() {
  console.log("\n[Layer 2 · repo scan against the live-schema snapshot]")
  const root = process.cwd()
  const files: string[] = []
  for (const d of ["app", "lib"]) { try { walk(join(root, d), files) } catch {} }
  const all: Violation[] = []
  for (const f of files) {
    let src = ""
    try { src = readFileSync(f, "utf8") } catch { continue }
    let hit = false
    for (const t of GUARDED) if (src.includes(`from("${t}")`) || src.includes(`from('${t}')`)) { hit = true; break }
    if (!hit) continue
    all.push(...scanFile(f.replace(root + "/", ""), src))
  }

  // Baseline ratchet: known PRE-EXISTING legacy violations are tolerated (burn-down list);
  // any NEW violation fails the guard immediately. Regenerate with GUARD_WRITE_BASELINE=1.
  if (process.env.GUARD_WRITE_BASELINE === "1") {
    writeFileSync(BASELINE_PATH, JSON.stringify(all.map(vkey).sort(), null, 2) + "\n")
    console.log(`  ⚙  wrote baseline: ${all.length} known violations → scripts/schema-drift-baseline.json`)
  }
  const baseline = new Set<string>(existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : [])
  const fresh = all.filter((v) => !baseline.has(vkey(v)))
  const fixed = [...baseline].filter((k) => !all.some((v) => vkey(v) === k))

  check(`scanned ${files.length} files — NO NEW schema drift (baseline: ${baseline.size} legacy, burn-down)`, fresh.length === 0,
    fresh.slice(0, 20).map((x) => `${x.file}: ${x.table}.${x.column} (${x.op}) [owner: ${resolveTableManager(x.table).label}]`).join(" | "))
  if (fixed.length > 0) console.log(`  ↘  ${fixed.length} baseline entries are now fixed — run GUARD_WRITE_BASELINE=1 to tighten the ratchet.`)

  // Burn-down by Claude manager — every remaining baseline entry is on a named
  // manager's list (TABLE_MANAGER), so the cleanup itself is governed on the egress.
  const byManager = new Map<string, number>()
  for (const k of baseline) {
    const table = k.split("::")[1]?.split(".")[0] ?? "unknown"
    const owner = resolveTableManager(table).label
    byManager.set(owner, (byManager.get(owner) ?? 0) + 1)
  }
  if (byManager.size > 0) {
    console.log("  📋 burn-down ownership (every entry has a Claude manager):")
    for (const [owner, n] of [...byManager.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(n).padStart(3)}  ${owner}`)
    }
  }
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Schema-drift guard (no code may reference a column the live table lacks)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  testScan()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ No schema drift — every guarded column reference matches the live schema")
}
main()
