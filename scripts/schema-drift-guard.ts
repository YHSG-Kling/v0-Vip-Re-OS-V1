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
import { runtimeRoots } from "./runtime-roots"
import { join } from "node:path"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { resolveTableManager } from "../lib/kernel/manager-registry"

const BASELINE_PATH = join(process.cwd(), "scripts/schema-drift-baseline.json")
const UNGUARDED_BASELINE_PATH = join(process.cwd(), "scripts/schema-drift-unguarded-baseline.json")
const EMBED_BASELINE_PATH = join(process.cwd(), "scripts/schema-drift-embed-baseline.json")
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
  // strip embedded relations — `[alias:]name[!hint]( … )` — with proper paren matching
  // so NESTED embeds (agent:agent_id(id, brokerage:brokerage_id(license_number))) are
  // fully removed (a `[^)]*` regex stops at the first ')' and leaks inner columns).
  let cleaned = ""
  for (let i = 0; i < literal.length; ) {
    const mm = literal.slice(i).match(/^([a-z_][a-z0-9_]*\s*:\s*)?[a-z_][a-z0-9_]*\s*(![a-z_]+)?\s*\(/i)
    if (mm) {
      const parenOpen = i + mm[0].length - 1
      const close = matchParen(literal, parenOpen)
      if (close !== -1) { cleaned += " "; i = close + 1; continue }
    }
    cleaned += literal[i]; i++
  }
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
  let depth = 0
  let q: string | null = null
  while (i < s.length) {
    const ch = s[i]
    if (q) { if (ch === q && s[i - 1] !== "\\") q = null; i++; continue }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; i++; continue }
    if (ch === "{") { depth++; i++; continue }
    if (ch === "}") { depth--; i++; continue }
    // Only a spread at the insert object's TOP level (depth 1) writes real columns.
    // A `...(cond && {k})` nested inside a jsonb VALUE object (depth >= 2) is jsonb
    // content, not a column — skip it (that was the input_props/sourceUrl FP source).
    if (!(depth === 1 && ch === "." && s.slice(i, i + 3) === "...")) { i++; continue }
    let j = i + 3
    while (j < s.length && /\s/.test(s[j])) j++
    if (s[j] !== "(") { i += 3; continue } // not a parenthesised spread (e.g. ...obj, ...fn())
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

/** The contiguous fluent method chain starting at `startIdx` (the char just after a
 *  `.from("x")`). Consumes directly-chained `.method( … )` calls across whitespace and
 *  stops at the first token that is NOT `.method(` — i.e. a statement boundary. This is
 *  how we keep a later `query = query.eq("col", …)` reassignment from being attributed to
 *  the wrong (most-recent) from(). */
export function contiguousChain(src: string, startIdx: number): string {
  let i = startIdx
  while (i < src.length) {
    while (i < src.length && /\s/.test(src[i])) i++
    if (src[i] !== ".") break
    const mm = src.slice(i).match(/^\.\s*[a-zA-Z_$][\w$]*\s*\(/)
    if (!mm) break
    const parenOpen = i + mm[0].length - 1
    const close = matchParen(src, parenOpen)
    if (close === -1) break
    const args = src.slice(parenOpen + 1, close)
    // A callback / nested-query argument (`.then(r => …)`, `.map(…)`) opens a DIFFERENT
    // table scope — stop before it so its inner filters/orders aren't attributed to THIS
    // from() (that re-attributed home_value_estimates.order("generated_at") to cma_reports).
    if (args.includes("=>") || args.includes("function") || args.includes(".from(")) break
    i = close + 1
  }
  return src.slice(startIdx, i)
}

/** PASS 14 — resolve `.insert(VAR)` to column keys by finding VAR's definition in
 *  the same file. Handles: `const VAR = {…}`, `const VAR = […]` (each object),
 *  `const VAR = xs.map(x => ({…}))` (the mapped object), and `VAR.push({…})`.
 *  Only shapes we can statically prove contribute keys — anything else is skipped
 *  (never a false positive on spread-through helpers). */
export function resolveVariableInsertKeys(src: string, varName: string, beforeIdx: number = src.length): string[] {
  const keys: string[] = []
  const addObj = (openIdx: number) => {
    const close = matchBrace(src, openIdx)
    if (close > openIdx) for (const k of parseObjectTopLevelKeys(src.slice(openIdx, close + 1))) if (!keys.includes(k)) keys.push(k)
  }
  // A file may declare the SAME variable name in several functions — only the
  // NEAREST definition before the .insert() call is the one being inserted
  // (a whole-file scan false-positived lifetime_customer_touchpoints with keys
  // from an unrelated `rows` two functions away).
  const nearest = (re: RegExp): RegExpMatchArray | null => {
    let best: RegExpMatchArray | null = null
    for (const m of src.matchAll(re)) {
      if (m.index! >= beforeIdx) break
      best = m
    }
    return best
  }
  // const VAR = {…}   |   const VAR: T = {…}
  const objDef = nearest(new RegExp(`(?:const|let|var)\\s+${varName}\\s*(?::[^=]+)?=\\s*\\{`, "g"))
  // const VAR = […]
  const arrDef = nearest(new RegExp(`(?:const|let|var)\\s+${varName}\\s*(?::[^=]+)?=\\s*\\[`, "g"))
  // const VAR = xs.map(x => ({…}))  — flatMap too (the touchpoints shape)
  const mapDef = nearest(new RegExp(`(?:const|let|var)\\s+${varName}\\s*(?::[^=]+)?=\\s*[\\w.?!()\\[\\]]+\\.(?:map|flatMap)\\(`, "g"))
  const candidates = [objDef, arrDef, mapDef].filter((m): m is RegExpMatchArray => !!m)
  if (candidates.length === 0) return keys
  const def = candidates.sort((a, b) => b.index! - a.index!)[0]
  if (def === objDef) {
    addObj(def.index! + def[0].length - 1)
  } else if (def === arrDef) {
    let d = 0
    for (let i = def.index! + def[0].length - 1; i < src.length; i++) {
      const ch = src[i]
      if (ch === "[") d++
      else if (ch === "]") { d--; if (d === 0) break }
      else if (ch === "{" && d === 1) { const bc = matchBrace(src, i); if (bc > i) { addObj(i); i = bc } }
    }
  } else {
    const parenOpen = def.index! + def[0].length - 1
    const close = matchParen(src, parenOpen)
    if (close >= 0) {
      const body = src.slice(parenOpen, close + 1)
      // arrow returning an object literal: `=> ({` — or an explicit `return {`
      const arrow = body.search(/=>\s*\(\s*\{/)
      const ret = body.search(/return\s*\{/)
      const at = arrow >= 0 ? body.indexOf("{", arrow) : ret >= 0 ? body.indexOf("{", ret) : -1
      if (at >= 0) addObj(parenOpen + at)
    }
  }
  // VAR.push({…}) — only pushes between the chosen definition and the insert
  for (const m of src.matchAll(new RegExp(`${varName}\\.push\\(\\s*\\{`, "g"))) {
    if (m.index! > def.index! && m.index! < beforeIdx) addObj(m.index! + m[0].length - 1)
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

/**
 * Columns requested INSIDE an embedded relation: `embedded_table (a, b, c)`.
 *
 * parseSelectColumns deliberately strips embeds, because their columns belong to a
 * different table than the .from(). Stripping is right — but nothing then checked
 * them, and PostgREST rejects the ENTIRE query when an embed names a column its table
 * lacks. That is how `lead_scraping_property_params (id, is_active, target_sites, …)`
 * shipped against a table with neither column: the scrape-territory resolver's select
 * could not succeed, the error was discarded, and every run reported "no active
 * territories" — an outage that reads like an idle pipeline.
 *
 * Returns [embeddedTable, column] pairs for embeds whose target we can name. An embed
 * written `alias:fk_column(...)` is skipped: the alias is not the table name, and
 * guessing would produce false positives.
 */
export function parseEmbeddedSelects(literal: string): Array<{ table: string; column: string }> {
  const out: Array<{ table: string; column: string }> = []
  const re = /([A-Za-z_][\w]*)\s*(?:!\w+)?\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(literal))) {
    const name = m[1]
    // `alias:table(...)` — the captured word is the alias only when a ':' precedes it.
    const before = literal.slice(0, m.index).trimEnd()
    if (before.endsWith(":")) continue
    const open = m.index + m[0].length - 1
    const close = matchParen(literal, open)
    if (close <= open) continue
    const inner = literal.slice(open + 1, close)
    for (const col of parseSelectColumns(inner)) out.push({ table: name, column: col })
    re.lastIndex = close
  }
  return out
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
  check("parseObjectTopLevelKeys: conditional spread INSIDE a jsonb value is NOT a column (input_props/sourceUrl FP)",
    JSON.stringify(parseObjectTopLevelKeys("{ provider_metadata: { ...(c && { voiceover_url: u, input_props: p }) }, status: 'x' }")) === JSON.stringify(["provider_metadata", "status"]))
  check("parseSelectColumns: NESTED embeds are fully stripped (no leaked inner columns)",
    JSON.stringify(parseSelectColumns("id, agent:agent_id(id, license_number, brokerage:brokerage_id(license_number, license_state)), status")) === JSON.stringify(["id", "status"]))
  // Filter attribution stops at the from()'s contiguous chain — a reassigned-variable
  // filter on a different table is NOT pulled in (agent_id/transaction_id/user_id FP).
  {
    const snippet = `.from("agents").select("id").eq("user_id", uid).maybeSingle()\n  if (!row) return\n  query = query.eq("agent_id", row.id)`
    const ch = contiguousChain(snippet, snippet.indexOf(".from(") + `.from("agents")`.length)
    check("contiguousChain: excludes reassigned-variable filter (query = query.eq(...))",
      ch.includes('eq("user_id"') && !ch.includes('eq("agent_id"'))
  }
  // PASS 14 — variable-shaped insert resolution (the closing-checklist escape route):
  {
    const snippet = `const rows = checklist.items.map((item) => ({ transaction_id: t, item_label: item.name, phase: item.cat }))\n  await supabase.from("closing_checklist_items").insert(rows)`
    const keys = resolveVariableInsertKeys(snippet, "rows")
    check("resolveVariableInsertKeys: catches keys inside a .map(() => ({…})) variable (the closing-checklist shape)",
      keys.includes("item_label") && keys.includes("phase") && keys.includes("transaction_id"))
  }
  check("resolveVariableInsertKeys: const object literal",
    JSON.stringify(resolveVariableInsertKeys(`const row = { a_col: 1, b_col: 2 }`, "row")) === JSON.stringify(["a_col", "b_col"]))
  check("resolveVariableInsertKeys: array literal parses every object",
    resolveVariableInsertKeys(`const rows = [{ x_col: 1 }, { y_col: 2 }]`, "rows").join() === "x_col,y_col")
  check("resolveVariableInsertKeys: .push({…}) contributes keys",
    resolveVariableInsertKeys(`const rows: any[] = []\nrows.push({ pushed_col: 1 })`, "rows").includes("pushed_col"))
  check("resolveVariableInsertKeys: opaque helper result contributes NOTHING (no false positives)",
    resolveVariableInsertKeys(`const rows = buildRows(payload)`, "rows").length === 0)
  {
    // Two same-named variables in one file: only the NEAREST definition before
    // the insert counts (the lifetime_customer_touchpoints false-positive shape).
    const twoScopes = `function a(){ const rows = xs.map(x => ({ wrong_col: 1 })) }\nfunction b(){ const rows = ys.map(y => ({ right_col: 2 }))\n  supabase.from("t").insert(rows) }`
    const at = twoScopes.indexOf(".insert(rows)")
    const near = resolveVariableInsertKeys(twoScopes, "rows", at)
    check("resolveVariableInsertKeys: NEAREST same-named definition wins (no cross-function bleed)",
      near.includes("right_col") && !near.includes("wrong_col"))
  }

  // Embedded-select columns must be checked against the EMBEDDED table, not skipped.
  {
    const emb = parseEmbeddedSelects("id, name, lead_scraping_property_params (id, is_active, min_price)")
    check("parseEmbeddedSelects: finds embedded table + its columns",
      emb.some((e) => e.table === "lead_scraping_property_params" && e.column === "is_active"))
    check("parseEmbeddedSelects: aliased embeds (alias:fk(...)) are skipped — alias is not a table",
      parseEmbeddedSelects("agent:agent_id(id, license_number)").length === 0)
    check("parseEmbeddedSelects: the scrape-territory outage shape is caught",
      parseEmbeddedSelects("lead_scraping_property_params (id, is_active, target_sites, min_price)")
        .filter((e) => !SCHEMA_SNAPSHOT.lead_scraping_property_params?.includes(e.column)).length === 2)
  }

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
    if (sel) {
      for (const c of parseSelectColumns(sel)) if (!set.has(c)) v.push({ file, table, op: "select", column: c })
      // Embedded relations are a DIFFERENT table's columns — checked against that
      // table's snapshot, because a bad embed column fails the whole query.
      for (const e of parseEmbeddedSelects(sel)) {
        if (!GUARDED.has(e.table)) continue
        // `related_table(count)` is PostgREST's related-row aggregate, not a column.
        if (e.column === "count") continue
        if (!new Set(SCHEMA_SNAPSHOT[e.table]).has(e.column)) {
          v.push({ file, table: e.table, op: "select(embed)", column: e.column })
        }
      }
    }
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
    // PASS 14 — the closing-checklist blind spot: `.insert(rows)` where `rows` is a
    // VARIABLE built earlier (`const rows = items.map(item => ({...}))` or a plain
    // `const rows = {...}` / `[{...}]`), and `.insert([{...}, {...}])` array literals.
    // Both shapes wrote five phantom columns for months without tripping the guard.
    const arrM = chain.match(/\.(insert|upsert)\(\s*\[/)
    if (arrM && arrM.index != null) {
      const bracketOpen = m.index + (arrM.index + arrM[0].length - 1)
      // walk the array literal, parsing each top-level object
      let d = 0
      for (let i = bracketOpen; i < src.length; i++) {
        const ch = src[i]
        if (ch === "[") d++
        else if (ch === "]") { d--; if (d === 0) break }
        else if (ch === "{" && d === 1) {
          const bc = matchBrace(src, i)
          if (bc > i) {
            for (const k of parseObjectTopLevelKeys(src.slice(i, bc + 1))) if (!set.has(k)) v.push({ file, table, op: arrM[1], column: k })
            i = bc
          }
        }
      }
    }
    const varM = chain.match(/\.(insert|upsert)\(\s*([a-zA-Z_$][\w$]*)\s*\)/)
    if (varM && varM.index != null && !["true", "false", "null"].includes(varM[2])) {
      for (const k of resolveVariableInsertKeys(src, varM[2], m.index + varM.index)) if (!set.has(k)) v.push({ file, table, op: `${varM[1]}(var)`, column: k })
    }
    // FILTER / order column args (the first string arg is a real column). A filter on a
    // phantom column errors the query the same way a select does. Scope to the CONTIGUOUS
    // method chain hanging directly off this .from() — a `query = query.eq("col", …)`
    // reassignment is a separate statement (not directly chained) and must NOT be
    // attributed to the most-recent from() (that mis-attributed agent_id/transaction_id/
    // user_id to the wrong table). Skip embed paths (col with a `.`) and the .or()/.filter()
    // string DSL (column names live inside a string).
    const filterChain = contiguousChain(src, m.index + m[0].length)
    for (const fm of filterChain.matchAll(/\.(eq|neq|gt|gte|lt|lte|like|ilike|in|is|contains|containedBy|order|not)\(\s*["'`]([a-zA-Z_][a-zA-Z0-9_.]*)["'`]/g)) {
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
  for (const d of runtimeRoots(root)) { try { walk(join(root, d), files) } catch {} }
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
    writeFileSync(BASELINE_PATH, JSON.stringify(all.filter((v) => v.op !== "select(embed)").map(vkey).sort(), null, 2) + "\n")
    console.log(`  ⚙  wrote baseline: ${all.filter((v) => v.op !== "select(embed)").length} known direct-column violations → scripts/schema-drift-baseline.json`)
  }
  // Embedded-relation columns are a NEWLY added check (see parseEmbeddedSelects). They
  // get their OWN ratchet: the direct-column baseline is held at zero-zero on purpose,
  // and folding a new check's pre-existing findings into it would erase that standard.
  // New check, own burn-down, same rule — nothing new may be added.
  const embedAll = all.filter((v) => v.op === "select(embed)")
  const directAll = all.filter((v) => v.op !== "select(embed)")

  if (process.env.GUARD_WRITE_BASELINE === "1") {
    writeFileSync(EMBED_BASELINE_PATH, JSON.stringify(embedAll.map(vkey).sort(), null, 2) + "\n")
    console.log(`  ⚙  wrote embed baseline: ${embedAll.length} known embedded-column violations`)
  }
  const embedBaseline = new Set<string>(existsSync(EMBED_BASELINE_PATH) ? JSON.parse(readFileSync(EMBED_BASELINE_PATH, "utf8")) : [])
  const embedFresh = embedAll.filter((v) => !embedBaseline.has(vkey(v)))
  check(`no NEW embedded-relation column drift (burn-down: ${embedBaseline.size} pre-existing — each one fails its ENTIRE query)`,
    embedFresh.length === 0,
    embedFresh.slice(0, 20).map((x) => `${x.file}: ${x.table}.${x.column}`).join(" | "))
  if (embedBaseline.size > 0) {
    console.log(`  ⚠  ${embedBaseline.size} embedded-column violations remain. PostgREST rejects the WHOLE`)
    console.log("     query when an embed names a missing column, so each is a silent dead surface:")
    for (const k of [...embedBaseline].sort()) console.log(`       ${k.replace("::select(embed)", "")}`)
  }

  const all2 = directAll
  const baseline = new Set<string>(existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : [])
  const fresh = all2.filter((v) => !baseline.has(vkey(v)))
  const fixed = [...baseline].filter((k) => !all2.some((v) => vkey(v) === k))

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

// ── Layer 3: coverage ratchet — every table the code touches must be ACCOUNTED FOR ───────────
// The original guard only column-checks GUARDED tables; a `.from("unguarded_table")` was skipped
// entirely. That's exactly how lead_capture_forms.metadata + property_interests phantom columns shipped
// (both unguarded). This ratchet collects every referenced table and fails when a NEW one is neither
// guarded (column-checked) nor on the acknowledged-unguarded burn-down list — so you can't introduce a
// `.from("new_table")` without consciously guarding it or acknowledging it. Regenerate with
// GUARD_WRITE_BASELINE=1.
function testCoverage() {
  console.log("\n[Layer 3 · table coverage ratchet]")
  const root = process.cwd()
  const files: string[] = []
  for (const d of runtimeRoots(root)) { try { walk(join(root, d), files) } catch {} }
  const referenced = new Set<string>()
  const fromRe = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/g
  // Only a SUPABASE query counts — `.from("x")` immediately chained to a PostgREST verb. This excludes
  // Buffer.from("base64") / Array.from("...") / other library .from() calls whose arg isn't a table.
  const PG_VERB = /^\s*(?:\.\s*)?(select|insert|upsert|update|delete|eq|neq|gt|gte|lt|lte|like|ilike|in|is|or|order|limit|range|match|single|maybeSingle|rpc|contains|filter|not|count)\b/
  for (const f of files) {
    let src = ""
    try { src = readFileSync(f, "utf8") } catch { continue }
    if (!src.includes(".from(")) continue
    let m: RegExpExecArray | null
    while ((m = fromRe.exec(src))) {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 40)
      if (PG_VERB.test(after)) referenced.add(m[1])
    }
  }
  const unguarded = [...referenced].filter((t) => !GUARDED.has(t)).sort()

  if (process.env.GUARD_WRITE_BASELINE === "1") {
    writeFileSync(UNGUARDED_BASELINE_PATH, JSON.stringify(unguarded, null, 2) + "\n")
    console.log(`  ⚙  wrote unguarded baseline: ${unguarded.length} acknowledged tables`)
  }
  const acknowledged = new Set<string>(existsSync(UNGUARDED_BASELINE_PATH) ? JSON.parse(readFileSync(UNGUARDED_BASELINE_PATH, "utf8")) : [])
  const fresh = unguarded.filter((t) => !acknowledged.has(t))
  const nowGuarded = [...acknowledged].filter((t) => GUARDED.has(t) || !referenced.has(t))

  console.log(`  · ${referenced.size} tables referenced — ${GUARDED.size} column-guarded, ${acknowledged.size} acknowledged-unguarded (burn-down)`)
  check("no NEW unguarded table — add it to schema-snapshot (column-check) or acknowledge it (GUARD_WRITE_BASELINE=1)",
    fresh.length === 0, fresh.join(", "))
  if (nowGuarded.length > 0) console.log(`  ↘  ${nowGuarded.length} acknowledged tables are now guarded/unused — run GUARD_WRITE_BASELINE=1 to tighten.`)
}

// ── Layer 4: migration numbering ─────────────────────────────────────────────────────────
// A migration number is the only thing that orders the SQL we ship, and nothing enforced that
// it was unique. Two parallel threads of work in one branch both reached for the next free
// number and BOTH landed: m283 and m284 each named two unrelated migrations (the commission
// keep-one pair and the transaction-fee pair). It caused no outage — the four touch different
// tables and were applied by hand — but "which m284?" is not a question a migration number
// should be able to raise, and the next collision may not be on disjoint tables.
//
// Uniqueness only. Gaps are fine (a number can be abandoned), and the numeric sequence needn't
// start at 1 — the invariant is that a number names exactly one migration.
//
// Two prefix eras ship here: the early files are bare `NNN-` and the later ones `mNNN-`. Both
// are read as the same number space, so `063-x.sql` and `m63-y.sql` would collide — an `m` is
// decoration, not a namespace, and reading them separately would leave the older era unchecked.
// Leading zeros are insignificant: 023 and 23 are one number.
export function duplicateMigrationNumbers(filenames: string[]): { num: string; files: string[] }[] {
  const byNum = new Map<string, string[]>()
  for (const f of filenames) {
    const m = /^m?(\d+)[-._]/.exec(f)
    if (!m) continue
    const key = String(Number(m[1]))
    if (!byNum.has(key)) byNum.set(key, [])
    byNum.get(key)!.push(f)
  }
  return [...byNum.entries()]
    .filter(([, fs]) => fs.length > 1)
    .map(([num, files]) => ({ num, files: files.sort() }))
    .sort((a, b) => Number(a.num) - Number(b.num))
}

function testMigrationNumbers() {
  console.log("\n[Layer 4 · migration numbering]")
  // pure
  check("duplicate detector: unique numbers are clean",
    duplicateMigrationNumbers(["m1-a.sql", "m2-b.sql", "m10-c.sql"]).length === 0)
  check("duplicate detector: a reused number is reported with both files",
    JSON.stringify(duplicateMigrationNumbers(["m3-a.sql", "m3-b.sql", "m4-c.sql"])) ===
      JSON.stringify([{ num: "3", files: ["m3-a.sql", "m3-b.sql"] }]))
  check("duplicate detector: gaps are allowed",
    duplicateMigrationNumbers(["m1-a.sql", "m9-b.sql"]).length === 0)
  check("duplicate detector: the bare-NNN era shares the mNNN number space",
    duplicateMigrationNumbers(["023-a.sql", "m23-b.sql"]).length === 1)

  // repo
  const dir = join(process.cwd(), "supabase/migrations")
  if (!existsSync(dir)) { check("supabase/migrations exists", false); return }
  const sql = readdirSync(dir).filter((f) => f.endsWith(".sql"))
  const unnumbered = sql.filter((f) => !/^m?\d+[-._]/.test(f)).sort()
  const dupes = duplicateMigrationNumbers(sql)
  console.log(`  · ${sql.length} migrations on disk`)
  check("every migration number names exactly one migration",
    dupes.length === 0,
    dupes.map((d) => `${d.num}: ${d.files.join(" + ")}`).join("; "))
  check("every migration filename opens with its number (mNNN- or the older bare NNN-)",
    unnumbered.length === 0, unnumbered.join(", "))
}

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Schema-drift guard (no code may reference a column the live table lacks)")
  console.log("══════════════════════════════════════════════════")
  testPure()
  testScan()
  testCoverage()
  testMigrationNumbers()
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ No schema drift — every guarded column reference matches the live schema")
}
main()
