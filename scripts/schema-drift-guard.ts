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
 *     embeds/aliases; object top-level keys; the .or()/.filter() filter DSL) are correct.
 *   Layer 2 — repo scan: every .from(guarded).select("...") column + every .insert/.upsert
 *     object key + every column named inside a .or()/.filter() filter string must exist in
 *     the snapshot, else fail (with file + offending column).
 *
 * Every check publishes what it could NOT resolve (unresolved embeds, unreadable filter
 * strings, unattributable call sites) alongside what it checked — a coverage number that
 * hides its own exclusions is a number that rounds up. GUARD_EMBED_REPORT=1 and
 * GUARD_DSL_REPORT=1 itemise those two blind spots.
 *
 * Run anywhere (no DB/creds). Regenerate the snapshot when a guarded table changes.
 * Run: npx tsx scripts/schema-drift-guard.ts  (npm run test:schema-drift)
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from "node:fs"
import { runtimeRoots } from "./runtime-roots"
import { join } from "node:path"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { SCHEMA_FK_MAP, SCHEMA_FK_PAIR_CARDINALITY, fkPairCount } from "./schema-fk-map"
import { resolveTableManager } from "../lib/kernel/manager-registry"
import { blankComments } from "./strip-comments"

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
/**
 * MODULE-LEVEL `const NAME = "literal"` BINDINGS, so a COMPUTED key can be resolved.
 *
 * Deliberately narrow. It reads only a top-of-line `const` (no leading indent, so a
 * binding inside a function body is not picked up) assigned a single-quoted, double-
 * quoted or backtick-with-no-interpolation string, optionally `as const`. Anything
 * else — a template with `${…}`, a value computed from another value, a re-assignment
 * — is NOT resolved and must fall through to the unresolved report rather than be
 * guessed at. A wrong resolution here would accuse a real column, which is worse than
 * declining to judge.
 */
export function moduleStringConsts(src: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /^export\s+const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*("[^"\n]*"|'[^'\n]*'|`[^`$\n]*`)\s*(?:as\s+const)?\s*$/gm
  const re2 = /^const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]+)?=\s*("[^"\n]*"|'[^'\n]*'|`[^`$\n]*`)\s*(?:as\s+const)?\s*$/gm
  for (const r of [re, re2]) {
    let m: RegExpExecArray | null
    while ((m = r.exec(src))) out.set(m[1], m[2].slice(1, -1))
  }
  return out
}

/**
 * `for (const NAME of ["a", "b", "c"])` — THE LOOP-OVER-COLUMNS IDIOM.
 *
 * This is the OTHER shape a computed write key comes in, and it is the more common
 * one: `for (const roleCol of ["agent_id","buyer_agent_id","seller_agent_id"])` then
 * `.update({ [roleCol]: successor })`. THREE columns on `transactions` were being
 * written through a key the parser could not see, in two separate files.
 *
 * Resolved to ALL candidates, so every one of them is checked — a set where one member
 * has drifted is exactly as broken as a single wrong key, and it fails on only some
 * iterations, which is worse to diagnose.
 *
 * A loop binding is FUNCTION-scoped while this map is FILE-wide, so a name bound more
 * than once in a file is deliberately dropped rather than resolved against a set that
 * may belong to the other binding. Resolving to the wrong set would accuse a real
 * column, and a false accusation costs more than a declined check.
 */
export function loopStringSets(src: string): Map<string, string[]> {
  const seen = new Map<string, string[][]>()
  const re = /for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s*\[([^\]]*)\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const items = m[2].split(",").map((t) => t.trim()).filter(Boolean)
    // Every member must be a plain string literal. One computed member and the set is
    // no longer knowable, so the whole binding is skipped.
    if (!items.length || !items.every((t) => /^("[^"\n]*"|'[^'\n]*'|`[^`$\n]*`)$/.test(t))) continue
    const vals = items.map((t) => t.slice(1, -1))
    if (!seen.has(m[1])) seen.set(m[1], [])
    seen.get(m[1])!.push(vals)
  }
  const out = new Map<string, string[]>()
  for (const [name, sets] of seen) if (sets.length === 1) out.set(name, sets[0])
  return out
}

/**
 * NOT RESOLVED, DELIBERATELY — `const col = cond ? "a" : "b"`, THE TERNARY COLUMN PICK.
 *
 * Three of the remaining unresolvable keys are this shape, and it looks trivially
 * resolvable: lib/campaign-sequences/enrollment-engine.ts:43 picks `lead_id` vs
 * `contact_id` for sequence_enrollments, and app/crm/page.tsx:1171 picks one of four
 * opt-out columns on contacts. Both candidate sets are right there in the source.
 *
 * A resolver for it was written and REVERTED, because the obvious implementation is
 * wrong in the expensive direction. "Collect the string literals from the right-hand
 * side" collects the CONDITION's literals too — `channel === "email" ? "email_opt_out"`
 * yields "email" as readily as "email_opt_out". Run against the tree it accused
 * `contacts.sms` of drifting, a column that does not exist and was never referenced:
 * a FALSE ACCUSATION AGAINST WORKING CODE, produced by the very check meant to protect
 * it. Only the BRANCH positions of the ternary may contribute candidates, and telling a
 * branch from a condition needs the `?`/`:` structure parsed rather than the literals
 * swept up — including nested chains, where each `:` may open another ternary.
 *
 * Left on the unresolvable list until that is done properly. A named skipped check is
 * honest; a check that invents columns is worse than no check, which is the whole
 * argument the block above makes about silent skips, pointing the other way.
 */
/** What a computed key `[X]` may be resolved to: one column, or a set of them. */
export type ComputedKeyResolver = Map<string, string | string[]>

export interface ObjectKeyParse {
  keys: string[]
  /** Computed keys — `[expr]: v` — that WERE resolved to a column name and are in `keys`. */
  resolvedComputed: string[]
  /** Computed keys that could NOT be resolved, and were therefore never checked. */
  unresolvedComputed: string[]
}

/**
 * A COMPUTED PROPERTY KEY IS A COLUMN NAME THE OLD PARSER COULD NOT SEE AT ALL.
 *
 * `{ [ADDRESS_SUPPRESSION_COLUMN]: key }` names a real column, and the depth-1 loop
 * below skipped it in silence: it only starts a key at `/[a-z_]/i`, and a computed key
 * starts at `[`, which the very next branch pushes onto the bracket stack. No key was
 * recorded, nothing was checked, and the guard reported PASS.
 *
 * MEASURED, NOT THEORISED: `contact_suppression_list.mailing_address_key` is added by
 * m503 and written through exactly this shape in lib/direct-mail/address-suppression.ts.
 * The column was absent from schema-snapshot.ts and the guard was green anyway — and
 * the code carries a hand-written comment asserting that every column it names is
 * present, which is what people write when the machine cannot check it for them.
 * `lib/kernel/billing.ts` and `lib/kernel/lifecycle.ts` write through the same shape.
 *
 * TWO OUTCOMES, and the second matters as much as the first:
 *   · RESOLVED — the key is `[IDENT]` and IDENT is a module-level string const in the
 *     same file. The column is checked exactly like a literal key.
 *   · UNRESOLVED — anything else (`[col]` from a parameter, `[entityDef.stateColumn]`,
 *     `[template.id]` writing jsonb content). These are COUNTED AND REPORTED, never
 *     silently dropped, because a skipped check that prints nothing is indistinguishable
 *     from a check that passed. This is the same discipline the filter-DSL and embed
 *     coverage lines already follow.
 */
export function parseObjectTopLevelKeysDetailed(objText: string, consts?: ComputedKeyResolver): ObjectKeyParse {
  const keys: string[] = []
  const resolvedComputed: string[] = []
  const unresolvedComputed: string[] = []
  const s = objText
  const stack: string[] = []
  let lastSig = ""        // last significant (non-ws) char at the current scope
  let q: string | null = null
  let i = 0
  while (i < s.length) {
    const ch = s[i]
    if (q) { if (ch === q && s[i - 1] !== "\\") q = null; i++; continue }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; lastSig = ch; i++; continue }
    // ── COMPUTED KEY at the object's TOP level: `{ [X]: v }` / `, [X]: v` ──────
    // Must be tested BEFORE the bracket is pushed onto the stack, which is precisely
    // where the original parser lost it. A `[` in any other position (an array value,
    // an index expression) does not match `]\s*:` and falls through unchanged.
    if (stack.length === 1 && ch === "[" && (lastSig === "{" || lastSig === ",")) {
      const cm = s.slice(i).match(/^\[\s*("([^"\n]*)"|'([^'\n]*)'|([A-Za-z_$][\w$.]*))\s*\]\s*:/)
      if (cm) {
        const literal = cm[2] ?? cm[3]
        const ident = cm[4]
        // A quoted computed key IS a literal — `{ ["brokerage_id"]: v }` names a column
        // as plainly as `{ brokerage_id: v }` does.
        if (literal != null) { keys.push(literal); resolvedComputed.push(literal) }
        else if (ident && consts?.has(ident)) {
          const r = consts.get(ident)!
          for (const col of Array.isArray(r) ? r : [r]) { keys.push(col); resolvedComputed.push(col) }
        }
        else unresolvedComputed.push(ident ?? cm[1])
        lastSig = ":"
        i += cm[0].length
        continue
      }
    }
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
  return { keys, resolvedComputed, unresolvedComputed }
}

/** Back-compatible wrapper — the shape every existing caller (and
 *  scripts/opposite-missing-census.ts, which imports this) already expects. */
export function parseObjectTopLevelKeys(objText: string, consts?: ComputedKeyResolver): string[] {
  return parseObjectTopLevelKeysDetailed(objText, consts).keys
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

export function matchParen(s: string, open: number): number {
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === "(") d++
    else if (s[i] === ")") { d--; if (d === 0) return i }
  }
  return -1
}

/**
 * ── EMBEDDED SELECTS ────────────────────────────────────────────────────────────────
 *
 * Columns requested INSIDE an embedded relation: `[alias:]relation[!hint](a, b, c)`.
 *
 * parseSelectColumns deliberately strips embeds, because their columns belong to a
 * DIFFERENT table than the .from(). Stripping is right — the bug was that nothing then
 * checked them against any table at all, and PostgREST rejects the ENTIRE query when an
 * embed names a column its table lacks. Two outages came out of that hole:
 *
 *   • `lead_scraping_property_params (id, is_active, target_sites, …)` against a table
 *     with neither column — the scrape-territory resolver's select could not succeed,
 *     the error was discarded, and every run reported "no active territories".
 *   • `brokerage:brokerage_id(name, address, …)` in lib/kernel/listings.ts against a
 *     `brokerages` that had no `address` — every listing-form prefill returned
 *     `{ success: false }` and the licence block went out empty.
 *
 * The second one is the reason this is not a regex over table-shaped names. That embed
 * names its target by FK COLUMN behind an alias; the old check saw `brokerage` (an alias,
 * not a table), gave up, and reported nothing. PostgREST admits three spellings:
 *
 *     brokerages(name)              — by TABLE name    → SCHEMA_SNAPSHOT
 *     brokerage_id(name)            — by FK COLUMN     → SCHEMA_FK_MAP[parent]
 *     brokerage:brokerage_id(name)  — aliased FK col   → SCHEMA_FK_MAP[parent]
 *
 * plus a `!hint` (`agents!inner(…)`, `agents!listings_agent_id_fkey(…)`) that narrows
 * WHICH relationship is used but never changes the target TABLE, so it is ignored here.
 *
 * A FALSE POSITIVE IS WORSE THAN THE GAP — a guard that cries wolf gets silenced. So an
 * embed whose target cannot be named with certainty is SKIPPED and COUNTED (reported on
 * the "unresolved embeds" line), never failed. Skipping is also why an unresolved embed
 * is not descended into: without a parent table, its own nested embeds resolve against
 * nothing, and guessing there is how you invent violations.
 */

/** Split a select list on TOP-LEVEL commas — commas inside an embed's parens, inside
 *  brackets, or inside a string belong to the inner list, not to this one. */
export function splitSelectParts(literal: string): string[] {
  const parts: string[] = []
  let depth = 0, q: string | null = null, start = 0
  for (let i = 0; i < literal.length; i++) {
    const ch = literal[i]
    if (q) { if (ch === q && literal[i - 1] !== "\\") q = null; continue }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue }
    if (ch === "(" || ch === "[" || ch === "{") depth++
    else if (ch === ")" || ch === "]" || ch === "}") depth--
    else if (ch === "," && depth === 0) { parts.push(literal.slice(start, i)); start = i + 1 }
  }
  parts.push(literal.slice(start))
  return parts
}

export interface EmbedNode {
  /** the relation token as written — a table name OR an FK column name */
  relation: string
  /** the `alias:` prefix, when present (never a table name) */
  alias: string | null
  /** the `!hint` token as written, WITHOUT the `!`; null when the embed carries none.
   *  This used to be MATCHED AND THROWN AWAY, on the reasoning that a hint never changes
   *  which TABLE an embed targets — true, and precisely why discarding it was safe for the
   *  column check and fatal for the ambiguity check below. A hint is the ONLY thing that
   *  distinguishes a working `transactions!transactions_contact_id_fkey(…)` from a
   *  PGRST201-dead bare `transactions(…)`; a census that cannot see it counts every
   *  already-fixed embed as broken (it did: 61 reported, 32 real). */
  hint: string | null
  /** the select list inside the parens */
  inner: string
}

/** Top-level embeds of a select list, in source order. A part is an embed only when it
 *  is `[…:]name[!hint]( … )` — a plain column, a rename, a cast or a json path is not. */
export function parseEmbedNodes(literal: string): EmbedNode[] {
  const out: EmbedNode[] = []
  for (const raw of splitSelectParts(literal)) {
    const part = raw.trim()
    if (!part) continue
    // `...relation(…)` is PostgREST's spread embed — same target resolution.
    const body = part.startsWith("...") ? part.slice(3).trim() : part
    const m = body.match(/^(?:([A-Za-z_]\w*)\s*:\s*)?([A-Za-z_]\w*)\s*(?:!\s*([A-Za-z_]\w*))?\s*\(([\s\S]*)\)$/)
    if (!m) continue
    out.push({ alias: m[1] ?? null, relation: m[2], hint: m[3] ?? null, inner: m[4] })
  }
  return out
}

/** PostgREST's JOIN-TYPE modifiers. They are spelled exactly like a disambiguation hint and
 *  are not one: they choose INNER vs LEFT and say nothing about WHICH relationship to use.
 *  `contacts.select("transactions!inner(id)")` is every bit as PGRST201-dead as the bare form.
 *  Any OTHER `!token` — an FK constraint name, an FK column name, the target table name —
 *  does pick a relationship, and is what PostgREST's own error message tells you to add. */
export const EMBED_JOIN_MODIFIERS = new Set(["inner", "left"])

/** Does this embed's `!hint` actually name a relationship (vs. only a join type)? */
export function embedHintDisambiguates(hint: string | null): boolean {
  return hint !== null && !EMBED_JOIN_MODIFIERS.has(hint.toLowerCase())
}

/** The table an embed points at, or null when it cannot be named with certainty.
 *  FK-column resolution needs the PARENT table; table-name resolution does not. The two
 *  paths cannot disagree — no FK column name in this schema collides with a table name
 *  (measured when scripts/schema-fk-map.ts was generated). */
export function resolveEmbedTable(parent: string | null, relation: string): string | null {
  return classifyEmbedRelation(parent, relation).table
}

/** HOW an embed named its target. `resolveEmbedTable` answers "which table"; the ambiguity
 *  check below also needs "by which spelling", because the two spellings have opposite
 *  PGRST201 fates:
 *
 *    "fk-column"  — `contacts:contact_id(…)` / `contact_id(…)`: the FK COLUMN *is* the choice
 *                   of relationship. Such an embed can never be ambiguous, no matter how many
 *                   other FKs join the pair, and must never be flagged.
 *    "table-name" — `contacts(…)`: names the pair and nothing more. Ambiguous exactly when
 *                   the pair carries more than one FK and no `!hint` narrows it.
 *
 *  Order matches resolveEmbedTable's original body, which this is the single source of truth
 *  for: FK column first, table name second. They cannot disagree anyway — no FK column name in
 *  this schema collides with a table name (measured when scripts/schema-fk-map.ts was generated). */
export function classifyEmbedRelation(parent: string | null, relation: string): { table: string | null; route: "fk-column" | "table-name" | null } {
  if (parent) {
    const viaFk = SCHEMA_FK_MAP[parent]?.[relation]
    if (viaFk) return { table: viaFk, route: "fk-column" }
  }
  if (Object.prototype.hasOwnProperty.call(SCHEMA_SNAPSHOT, relation)) return { table: relation, route: "table-name" }
  return { table: null, route: null }
}

/**
 * ── PGRST201: THE THIRD WAY AN EMBED DIES ───────────────────────────────────────────
 *
 * The two checks above ask "does this relation exist?" and "does this column exist?". Both
 * can answer YES and the request still fail in full:
 *
 *   PGRST201 — "Could not embed because more than one relationship was found for
 *               'contacts' and 'transactions'"
 *
 * PostgREST refuses an embed when the parent and the target are joined by MORE THAN ONE
 * foreign key and the query does not say which one. `transactions` holds THREE FKs to
 * `contacts` (contact_id, buyer_contact_id, seller_contact_id) and three to `agents`. The
 * relation is real, every column is real, the schema is entirely valid — and the read is as
 * dead as if the table were a phantom. Same outcome as the two outages above, different cause.
 *
 * AN EMBED IS AMBIGUOUS WHEN ALL THREE HOLD:
 *   1. it names its target by TABLE NAME. An embed naming an FK COLUMN (`contacts:contact_id(…)`,
 *      `contact_id(…)`) has ALREADY chosen the relationship — never flagged, at any FK count.
 *   2. it carries no disambiguating `!hint`. `!inner`/`!left` are join types, not hints
 *      (see EMBED_JOIN_MODIFIERS); any other token names a relationship and settles it.
 *   3. fkPairCount(parent, target) > 1.
 *
 * DIRECTION DOES NOT MATTER. PostgREST gathers relationships from BOTH sides of the pair, so
 * `contacts.select("transactions(…)")` and `transactions.select("contacts(…)")` fail alike —
 * which is exactly why the cardinality is keyed by an UNORDERED pair in schema-fk-map.ts.
 *
 * SKIPPED AND COUNTED, never guessed (the rule the whole file follows): an embed whose target
 * cannot be named is already skipped above and never reaches here; an embed whose PARENT is
 * unknown (a resolver call with no root table) is counted in `ambiguityUnknownParent` and left
 * alone, because ambiguity is a property of a pair and half a pair proves nothing.
 */

export interface AmbiguousEmbed {
  /** the table the query runs .from() */
  parent: string
  /** the table the embed resolves to */
  target: string
  /** the relation token as written */
  relation: string
  /** dotted path to the embed inside the select list */
  path: string
  /** how many FKs join parent↔target, in either direction */
  fkCount: number
}

export interface EmbedResolution {
  /** every embedded column, bound to the table it must exist on */
  refs: Array<{ table: string; column: string; path: string }>
  /** embeds whose target could not be named — skipped, never failed */
  unresolved: Array<{ relation: string; parent: string | null; path: string }>
  /** embeds whose target WAS named (at any depth) */
  resolvedCount: number
  /** resolved embeds that name their target by TABLE NAME and carry no disambiguating hint —
   *  the exact population the FK-pair cardinality was consulted for. The denominator of the
   *  ambiguity check, published so the coverage number cannot round itself up. */
  bareTableEmbeds: number
  /** the sorted "a|b" pair key looked up for each of those, dupes included (the caller dedupes) */
  pairsConsulted: string[]
  /** bare table-name embeds whose PARENT was unknown — no pair, so no check. Skipped, counted. */
  ambiguityUnknownParent: number
  /** of the bare table-name embeds, those whose pair carries more than one FK → PGRST201 */
  ambiguous: AmbiguousEmbed[]
}

/** Walk a select list to arbitrary depth, binding each embed's columns to ITS OWN table.
 *  A nested embed resolves against its immediate parent, never against the root. */
export function resolveEmbeddedSelects(literal: string, rootTable: string | null = null): EmbedResolution {
  const res: EmbedResolution = {
    refs: [], unresolved: [], resolvedCount: 0,
    bareTableEmbeds: 0, pairsConsulted: [], ambiguityUnknownParent: 0, ambiguous: [],
  }
  const walk = (list: string, parent: string | null, path: string) => {
    for (const node of parseEmbedNodes(list)) {
      const label = node.alias ? `${node.alias}:${node.relation}` : node.relation
      const here = `${path}.${label}`
      const { table: target, route } = classifyEmbedRelation(parent, node.relation)
      if (!target) { res.unresolved.push({ relation: node.relation, parent, path: here }); continue }
      res.resolvedCount++
      // ── PGRST201 ambiguity (see the block above). Only a TABLE-NAME embed with no
      // disambiguating hint is even a candidate; an FK-column embed has already picked its
      // relationship and a hint has already named one.
      if (route === "table-name" && !embedHintDisambiguates(node.hint)) {
        if (!parent) res.ambiguityUnknownParent++
        else {
          res.bareTableEmbeds++
          res.pairsConsulted.push(parent <= target ? `${parent}|${target}` : `${target}|${parent}`)
          const fkCount = fkPairCount(parent, target)
          if (fkCount > 1) res.ambiguous.push({ parent, target, relation: node.relation, path: here, fkCount })
        }
      }
      // The embed's OWN columns — parseSelectColumns strips its nested embeds, which is
      // exactly right here: those belong to the next table down and are walked below.
      for (const col of parseSelectColumns(node.inner)) res.refs.push({ table: target, column: col, path: here })
      walk(node.inner, target, here)
    }
  }
  walk(literal, rootTable, rootTable ?? "")
  return res
}

/** Back-compatible view of the resolver: [embeddedTable, column] pairs only. */
export function parseEmbeddedSelects(literal: string, rootTable: string | null = null): Array<{ table: string; column: string }> {
  return resolveEmbeddedSelects(literal, rootTable).refs.map(({ table, column }) => ({ table, column }))
}
export function matchBrace(s: string, open: number): number {
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === "{") d++
    else if (s[i] === "}") { d--; if (d === 0) return i }
  }
  return -1
}

/**
 * ── THE .or() / .filter() FILTER DSL ────────────────────────────────────────────────
 *
 * The filter-column block below checks the first string argument of `.eq/.gt/.in/.order/…`.
 * It deliberately skipped `.or()` and `.filter()` because in those two the column names live
 * INSIDE a string. PostgREST does not skip them: an unknown column inside an `.or()` string
 * errors the entire request exactly like a phantom column in a `.select()` does, and the read
 * returns nothing, forever.
 *
 *   CONFIRMED LIVE MISS — app/actions/ai-calendar-management.ts filters
 *     .from("contacts").or(`last_interaction_date.is.null,last_interaction_date.lt.${…}`)
 *   against a `contacts` that has no `last_interaction_date` (the real column is
 *   `last_contacted_at`). Every "stale contact" sweep it drives has been dead.
 *
 * THE GRAMMAR IMPLEMENTED (PostgREST's horizontal-filter string):
 *
 *     filters   := term ("," term)*                  — commas at PAREN DEPTH 0 only
 *     term      := group | condition
 *     group     := ["not" "."] ("and" | "or") "(" filters ")"        — recursed into
 *     condition := path "." ["not" "."] operator "." value
 *     path      := column | relation "." column      — the 2-segment form is an EMBED ref
 *     column    := name | name ("->" | "->>") jsonKey
 *
 * The column path is every dot-segment BEFORE the first segment that is a known operator, so a
 * value is never mistaken for a column no matter what it looks like: in `status.eq.contact_id`
 * the operator `eq` closes the path at `status`, and `contact_id` is data. Splits on commas and
 * dots are both TOP-LEVEL only, so `status.in.(a,b,c)` stays one term and its list members are
 * never read as terms (a regex that splits on every comma mangles exactly this).
 *
 * DELIBERATELY NOT RESOLVED — each of these is SKIPPED AND COUNTED, never guessed at and never
 * silently passed (see the GUARD_DSL_REPORT listing):
 *   • any column path containing an interpolation — `` `${col}.eq.1` `` names a column only at
 *     runtime. Only the STATIC segments of a template literal are checked; a `${…}` becomes an
 *     opaque marker that poisons the term it lands in if it lands in the column path (it is
 *     harmless in the value position, which is where nearly all of them are).
 *   • an argument that is not a string literal at all (`.or(someVar)`), or a `.or(str, {…})`
 *     second argument (`referencedTable` re-points the whole string at another table).
 *   • an embed path `relation.column` whose relation the FK map cannot name — same rule the
 *     embedded-select walker follows: an unnameable target is skipped, because a false positive
 *     gets a guard silenced and a skipped-and-counted gap does not.
 */

/** Stands in for a `${…}` interpolation (and any other non-literal expression fragment) inside
 *  a recovered string. NUL is deliberate: it is not whitespace (so a `.trim()` downstream cannot
 *  quietly erase it), it is not an identifier character, and it is not DSL punctuation. A marker
 *  that survives every later step is the only way an interpolated column name reliably gets
 *  SKIPPED rather than accidentally parsing as whatever name sits beside it. */
export const INTERP = "\u0000"

/** End index of the `}` closing the `${` whose `$` is at `dollar`. Respects nested braces and
 *  quoted/backticked text inside the expression (`${xs.join(",")}` is one interpolation). */
function matchInterpolation(s: string, dollar: number): number {
  let d = 0
  let q: string | null = null
  for (let i = dollar + 1; i < s.length; i++) {
    const ch = s[i]
    if (q) { if (ch === "\\") { i++; continue } if (ch === q) q = null; continue }
    if (ch === '"' || ch === "'" || ch === "`") { q = ch; continue }
    if (ch === "{") d++
    else if (ch === "}") { d--; if (d === 0) return i }
  }
  return -1
}

/** Read the JS string literal that starts at `start`, returning its STATIC text with every
 *  `${…}` replaced by INTERP. Backticks are first-class here — the live miss above is a
 *  template literal, and a `["']`-only reader misses it entirely. */
export function readJsStringLiteral(s: string, start: number): { text: string; end: number } | null {
  const q = s[start]
  if (q !== '"' && q !== "'" && q !== "`") return null
  let out = ""
  let i = start + 1
  while (i < s.length) {
    const ch = s[i]
    if (ch === "\\") { out += s[i + 1] ?? ""; i += 2; continue }
    if (ch === q) return { text: out, end: i + 1 }
    if (q === "`" && ch === "$" && s[i + 1] === "{") {
      const close = matchInterpolation(s, i)
      if (close === -1) return null
      out += INTERP
      i = close + 1
      continue
    }
    out += ch
    i++
  }
  return null
}

/** The statically-known text of an argument expression: string literals contribute their own
 *  text, and EVERY other fragment (a variable, a ternary's `?`/`:`, a call) contributes INTERP
 *  so it can only ever poison a term, never invent one. null when there is no literal at all. */
export function staticFilterString(argText: string): string | null {
  let out = ""
  let sawLiteral = false
  let i = 0
  while (i < argText.length) {
    const ch = argText[i]
    if (ch === '"' || ch === "'" || ch === "`") {
      const lit = readJsStringLiteral(argText, i)
      if (!lit) return null
      out += lit.text
      sawLiteral = true
      i = lit.end
      continue
    }
    if (/\s/.test(ch) || ch === "+") { i++; continue }
    out += INTERP
    while (i < argText.length && !/["'`\s+]/.test(argText[i])) i++
  }
  return sawLiteral ? out : null
}

/** Split on a separator that is at paren depth 0 and outside PostgREST's `"…"` value quoting.
 *  This is what keeps `status.in.(expired,accepted)` a single term and `col.eq."a.b"` a single
 *  path segment. */
export function splitTopLevel(s: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let quoted = false
  let start = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (quoted) { if (ch === '"' && s[i - 1] !== "\\") quoted = false; continue }
    if (ch === '"') { quoted = true; continue }
    if (ch === "(") depth++
    else if (ch === ")") depth--
    else if (ch === sep && depth === 0) { parts.push(s.slice(start, i)); start = i + 1 }
  }
  parts.push(s.slice(start))
  return parts
}

/** PostgREST horizontal-filter operators. `not` is here because it is the negation PREFIX that
 *  sits between the column path and the real operator (`bio_text.not.is.null`) — finding it
 *  closes the path just as the operator itself would. `and`/`or` are NOT here: they are group
 *  keywords, matched as `and( … )` before a term is ever read as a condition. */
export const PGRST_OPERATORS = new Set([
  "eq", "gt", "gte", "lt", "lte", "neq", "like", "ilike", "match", "imatch",
  "in", "is", "isdistinct", "fts", "plfts", "phfts", "wfts",
  "cs", "cd", "ov", "sl", "sr", "nxr", "nxl", "adj", "not",
])

export type DslPathResult =
  | { ok: true; relation: string | null; column: string }
  | { ok: false; reason: "interpolated" | "unparseable" }

/** Read one column PATH — the text before the operator in a DSL term, or the whole first
 *  argument of `.filter(column, op, value)`. Strips a json path (`metadata->>k`, whose real
 *  column is `metadata`) and a `::cast`; reports a 2-segment `relation.column` embed path via
 *  `relation`; refuses anything deeper or anything interpolated. */
export function parseDslColumnPath(path: string): DslPathResult {
  const segs = splitTopLevel(path, ".").map((s) => s.trim()).filter((s) => s.length > 0)
  if (segs.length === 0) return { ok: false, reason: path.includes(INTERP) ? "interpolated" : "unparseable" }
  if (segs.some((s) => s.includes(INTERP))) {
    // The json KEY may be interpolated while the COLUMN is static — `metadata->>${KEY}` still
    // proves `metadata` exists, so only an interpolation in the column NAME disqualifies it.
    const bases = segs.map((s) => s.split("->")[0])
    if (bases.some((b) => b.includes(INTERP))) return { ok: false, reason: "interpolated" }
  }
  if (segs.length > 2) return { ok: false, reason: "unparseable" }
  const relation = segs.length === 2 ? segs[0] : null
  const column = segs[segs.length - 1].split("->")[0].replace(/::[a-z_]+$/i, "").trim()
  const ident = /^[a-z_][a-z0-9_]*$/i
  if (!ident.test(column)) return { ok: false, reason: "unparseable" }
  if (relation !== null && !ident.test(relation)) return { ok: false, reason: "unparseable" }
  return { ok: true, relation, column }
}

export interface DslRef { relation: string | null; column: string; term: string }
export interface DslParse {
  /** column references recovered from the string, each bound to its relation (null = the parent) */
  refs: DslRef[]
  /** terms that could NOT be resolved to a column — skipped, never failed */
  skipped: Array<{ term: string; reason: "interpolated" | "unparseable" }>
  /** condition terms seen (refs.length + skipped.length); group keywords are not terms */
  terms: number
}

/** Parse a PostgREST `.or()` filter string (already reduced to static text with INTERP markers)
 *  into the columns it names. `and(…)`/`or(…)`/`not.and(…)` groups are recursed into, so a
 *  phantom column nested three groups deep is found at the same confidence as a top-level one. */
export function parseFilterDsl(dsl: string): DslParse {
  const res: DslParse = { refs: [], skipped: [], terms: 0 }
  const walk = (list: string, depth: number) => {
    if (depth > 12) return
    for (const raw of splitTopLevel(list, ",")) {
      const term = raw.trim()
      if (!term) continue
      const grp = term.match(/^(?:not\s*\.\s*)?(?:and|or)\s*\(([\s\S]*)\)$/i)
      if (grp) { walk(grp[1], depth + 1); continue }
      res.terms++
      const segs = splitTopLevel(term, ".")
      let opAt = -1
      for (let i = 1; i < segs.length; i++) {
        // `eq(any)` / `like(all)` are modifier spellings of the same operator.
        const seg = segs[i].trim().replace(/\([\s\S]*\)$/, "").toLowerCase()
        if (PGRST_OPERATORS.has(seg)) { opAt = i; break }
      }
      if (opAt < 1) { res.skipped.push({ term, reason: term.includes(INTERP) ? "interpolated" : "unparseable" }); continue }
      const parsed = parseDslColumnPath(segs.slice(0, opAt).join("."))
      if (!parsed.ok) { res.skipped.push({ term, reason: parsed.reason }); continue }
      res.refs.push({ relation: parsed.relation, column: parsed.column, term })
    }
  }
  walk(dsl, 0)
  return res
}

function matchBracket(s: string, open: number): number {
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === "[") d++
    else if (s[i] === "]") { d--; if (d === 0) return i }
  }
  return -1
}

/** `[ "a.eq.1", "b.is.null" ].join(",")` is a comma-separated filter string spelled as an array,
 *  and it reconstructs EXACTLY — so it is read rather than thrown away. Only a literal array of
 *  string literals joined on a literal comma qualifies; one non-literal element and the whole
 *  thing falls back to the generic reader (which will mark it interpolated). */
export function staticJoinedArray(argText: string): string | null {
  const t = argText.trim()
  if (!t.startsWith("[")) return null
  const close = matchBracket(t, 0)
  if (close === -1) return null
  if (!/^\s*\.\s*join\s*\(\s*(["'`]),\1\s*\)\s*$/.test(t.slice(close + 1))) return null
  const parts: string[] = []
  let i = 1
  while (i < close) {
    if (/[\s,]/.test(t[i])) { i++; continue }
    const lit = readJsStringLiteral(t, i)
    if (!lit || lit.end > close) return null
    parts.push(lit.text)
    i = lit.end
  }
  return parts.join(",")
}

/** Recover the DSL columns from a `.or( … )` call's RAW argument text (source, not a value).
 *  Returns null — skip and count, never guess — when the call cannot be read statically:
 *    • a real second argument is present: `.or(str, { referencedTable: "x" })` re-points the
 *      ENTIRE string at an embedded table, so every column in it belongs to a table we were
 *      not told. A TRAILING comma is not a second argument and must not be read as one.
 *    • the first argument contains no string literal at all (`.or(builtFilter)`). */
export function parseOrCallArgs(argsText: string): DslParse | null {
  const first = firstArg(argsText)
  const rest = argsText.slice(first.length).replace(/^\s*,\s*/, "")
  if (rest.trim().length > 0) return null
  const lit = staticJoinedArray(first) ?? staticFilterString(first)
  if (lit === null) return null
  return parseFilterDsl(lit)
}

/** The `.method( … )` calls chained at the TOP LEVEL of a fluent chain, in source order.
 *  A `.filter(` or `.or(` sitting INSIDE another call's arguments — `.in("id", xs.filter(Boolean))`
 *  is the common one — belongs to that expression, not to the query, and reading it as a query
 *  filter is how a checker starts reporting Array.prototype against a database schema. Walks
 *  exactly as contiguousChain does, so the two agree on what "chained" means. */
export function topLevelChainCalls(chain: string): Array<{ name: string; args: string; index: number }> {
  const out: Array<{ name: string; args: string; index: number }> = []
  let i = 0
  while (i < chain.length) {
    while (i < chain.length && /\s/.test(chain[i])) i++
    if (chain[i] !== ".") break
    const mm = chain.slice(i).match(/^\.\s*([a-zA-Z_$][\w$]*)\s*\(/)
    if (!mm) break
    const open = i + mm[0].length - 1
    const close = matchParen(chain, open)
    if (close === -1) break
    out.push({ name: mm[1], args: chain.slice(open + 1, close), index: i })
    i = close + 1
  }
  return out
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
  // ── COMPUTED KEYS. Each of these was invisible to the parser before, in silence. ────
  check("computed key: resolved from a module string const",
    JSON.stringify(parseObjectTopLevelKeys("{ a: 1, [COL]: v, b: 2 }", new Map<string, string | string[]>([["COL", "mailing_address_key"]])))
      === JSON.stringify(["a", "mailing_address_key", "b"]))
  check("computed key: a QUOTED computed key is a literal and needs no const",
    JSON.stringify(parseObjectTopLevelKeys('{ ["brokerage_id"]: v }')) === JSON.stringify(["brokerage_id"]))
  check("computed key: UNRESOLVABLE is reported, not silently dropped",
    JSON.stringify(parseObjectTopLevelKeysDetailed("{ a: 1, [roleCol]: v }").unresolvedComputed) === JSON.stringify(["roleCol"]))
  check("computed key: an unresolvable one contributes NO key (never a guess)",
    JSON.stringify(parseObjectTopLevelKeysDetailed("{ a: 1, [roleCol]: v }").keys) === JSON.stringify(["a"]))
  check("computed key: a dotted expression is unresolvable, not mistaken for a column",
    JSON.stringify(parseObjectTopLevelKeysDetailed("{ [entityDef.stateColumn]: v }").unresolvedComputed) === JSON.stringify(["entityDef.stateColumn"]))
  // NEGATIVE CONTROL for the resolution itself: WITHOUT the const map the same object must
  // go unresolved. If this ever passes both ways the map is not what is doing the work.
  check("computed key: NEGATIVE CONTROL — no const map means unresolved, not resolved",
    parseObjectTopLevelKeysDetailed("{ [COL]: v }").keys.length === 0 &&
    parseObjectTopLevelKeysDetailed("{ [COL]: v }", new Map<string, string | string[]>([["COL", "x"]])).keys.length === 1)
  // A `[` that is NOT a key must still behave exactly as it did: array values and index
  // expressions are values, and reading one as a column would invent a phantom.
  check("computed key: an ARRAY VALUE is not a key",
    JSON.stringify(parseObjectTopLevelKeys("{ tags: [a, b], id: 1 }")) === JSON.stringify(["tags", "id"]))
  check("computed key: an INDEX EXPRESSION in a value is not a key",
    JSON.stringify(parseObjectTopLevelKeys("{ name: parts[0], id: 1 }")) === JSON.stringify(["name", "id"]))
  check("computed key: a LOOP set resolves to EVERY candidate column",
    JSON.stringify(parseObjectTopLevelKeys("{ [roleCol]: v, updated_at: t }",
      new Map<string, string | string[]>([["roleCol", ["agent_id", "buyer_agent_id", "seller_agent_id"]]])))
      === JSON.stringify(["agent_id", "buyer_agent_id", "seller_agent_id", "updated_at"]))
  check("loopStringSets: reads the for-of literal array",
    JSON.stringify(loopStringSets('for (const roleCol of ["agent_id", "buyer_agent_id"] as const) {')
      .get("roleCol")) === JSON.stringify(["agent_id", "buyer_agent_id"]))
  check("loopStringSets: a name bound TWICE is dropped, never resolved against the wrong set",
    !loopStringSets('for (const c of ["a"]) {}\nfor (const c of ["b"]) {}\n').has("c"))
  check("loopStringSets: a non-literal member makes the whole set unknowable",
    !loopStringSets('for (const c of ["a", someVar]) {}\n').has("c"))
  check("moduleStringConsts: reads a module-level const, ignores an indented one",
    (() => {
      const m = moduleStringConsts('const TOP = "col_a"\nfunction f() {\n  const INNER = "col_b"\n}\nexport const EXPORTED = "col_c" as const\n')
      return m.get("TOP") === "col_a" && m.get("EXPORTED") === "col_c" && !m.has("INNER")
    })())
  check("moduleStringConsts: an INTERPOLATED template is NOT resolved (a guess would accuse a real column)",
    !moduleStringConsts("const K = `col_${suffix}`\n").has("K"))
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
  check("resolveVariableInsertKeys: typed const annotation does not hide the object (the .update(var) shape)",
    resolveVariableInsertKeys(`const updates: Record<string, unknown> = { engagement_score: 1, intent_score: 2 }`, "updates")
      .join() === "engagement_score,intent_score")
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
    check("parseEmbeddedSelects: an embed named by FK column is UNRESOLVABLE without a parent table",
      parseEmbeddedSelects("agent:agent_id(id, license_number)").length === 0)
    check("parseEmbeddedSelects: the scrape-territory outage shape is caught",
      parseEmbeddedSelects("lead_scraping_property_params (id, is_active, target_sites, min_price)")
        .filter((e) => !SCHEMA_SNAPSHOT.lead_scraping_property_params?.includes(e.column)).length === 2)
  }

  // ── embed TARGET RESOLUTION — the blind spot that hid brokerages.address ────────────
  {
    check("splitSelectParts: an embed's inner commas do not split the outer list",
      JSON.stringify(splitSelectParts("id, agent:agent_id(a, b, x:y(c, d)), status").map((s) => s.trim())) ===
        JSON.stringify(["id", "agent:agent_id(a, b, x:y(c, d))", "status"]))
    check("parseEmbedNodes: a plain column / rename / cast / json path is NOT an embed",
      parseEmbedNodes("id, price:list_price, created_at::date, meta->>'k'").length === 0)
    // (projected onto the three original fields, so this assertion still says exactly what it
    // said before EmbedNode grew a `hint` — the hint has its own checks further down.)
    check("parseEmbedNodes: reads alias, relation and inner list",
      JSON.stringify(parseEmbedNodes("brokerage:brokerage_id!inner(name, city)").map(({ alias, relation, inner }) => ({ alias, relation, inner }))) ===
        JSON.stringify([{ alias: "brokerage", relation: "brokerage_id", inner: "name, city" }]))
    check("parseEmbedNodes: a spread embed (...rel(cols)) is still an embed",
      parseEmbedNodes("...brokerages(name)")[0]?.relation === "brokerages")

    check("resolveEmbedTable: by TABLE name, no parent needed", resolveEmbedTable(null, "brokerages") === "brokerages")
    check("resolveEmbedTable: by FK COLUMN, via the parent's foreign key (listings.agent_id → agents)",
      resolveEmbedTable("listings", "agent_id") === "agents")
    check("resolveEmbedTable: two FK columns to the SAME table stay distinct (listings.seller_contact_id → contacts)",
      resolveEmbedTable("listings", "seller_contact_id") === "contacts" && resolveEmbedTable("listings", "contact_id") === "contacts")
    check("resolveEmbedTable: an unknown relation resolves to NOTHING (skip, never guess)",
      resolveEmbedTable("listings", "not_a_column_or_table") === null)
    check("resolveEmbedTable: an FK column of ANOTHER table is not resolvable from this parent",
      resolveEmbedTable("brokerages", "agent_id") === null)

    // The exact listings.ts prefill select, three levels deep. Every level must bind to
    // its OWN table: listings → agents → users AND agents → brokerages.
    const prefill = `
      id, address, city,
      seller:seller_contact_id(id, first_name, last_name),
      agent:agent_id(
        id, brokerage_id,
        users:user_id(first_name, last_name, email),
        license_number,
        brokerage:brokerage_id(name, address, city)
      )`
    const r = resolveEmbeddedSelects(prefill, "listings")
    check("resolveEmbeddedSelects: aliased FK-column embed binds to the FK's TARGET table (brokerage:brokerage_id → brokerages)",
      r.refs.some((e) => e.table === "brokerages" && e.column === "address"))
    check("resolveEmbeddedSelects: a NESTED embed resolves against its OWN parent, not the root",
      r.refs.some((e) => e.table === "users" && e.column === "first_name") &&
      !r.refs.some((e) => e.table === "listings" && e.column === "first_name"))
    check("resolveEmbeddedSelects: the seller embed lands on contacts, not on listings",
      r.refs.some((e) => e.table === "contacts" && e.column === "last_name"))
    check("resolveEmbeddedSelects: the listings prefill select resolves EVERY embed (0 unresolved)",
      r.unresolved.length === 0 && r.resolvedCount === 4, `resolved=${r.resolvedCount} unresolved=${r.unresolved.map((u) => u.relation).join(",")}`)
    check("resolveEmbeddedSelects: the historical outage column is now CAUGHT (brokerages had no `address`)",
      r.refs.filter((e) => e.table === "brokerages").length === 3)
    check("resolveEmbeddedSelects: an embed's own non-embed columns are NOT attributed to the parent",
      !r.refs.some((e) => e.table === "agents" && e.column === "first_name") &&
      r.refs.some((e) => e.table === "agents" && e.column === "license_number"))

    // A false positive here would get the guard silenced, so an unnameable target is
    // SKIPPED and COUNTED — never failed.
    const un = resolveEmbeddedSelects("id, mystery:whatever_id(a, b, deeper:other_id(c))", "listings")
    check("resolveEmbeddedSelects: an unresolvable embed yields NO column refs (skipped, not failed)",
      un.refs.length === 0 && un.unresolved.length === 1 && un.unresolved[0].relation === "whatever_id")
    check("resolveEmbeddedSelects: an unresolvable embed is NOT descended into (its parent is unknown)",
      un.resolvedCount === 0 && !un.unresolved.some((u) => u.relation === "other_id"))
  }

  // ── PGRST201 — the AMBIGUOUS EMBED ──────────────────────────────────────────────────
  // The third way an embed dies, and the only one where the schema is entirely valid: two
  // tables joined by more than one FK, an embed that names the target by table name, and no
  // hint to choose between them. Both halves must hold or this check is worthless — the
  // NEGATIVE CONTROLS prove the dead shapes are caught in every spelling and both directions,
  // the SPECIFICITY CONTROLS prove the already-correct shapes are left alone. The second half
  // matters more here than anywhere else in this file: 529 bare embeds is a big enough blast
  // radius that one false positive class would get the whole guard switched off.
  {
    // ── the hint, CAPTURED rather than discarded ─────────────────────────────────────
    check("parseEmbedNodes: an FK-constraint !hint is CAPTURED, not thrown away (the census bug: 61 reported vs 32 real)",
      parseEmbedNodes("transactions!transactions_contact_id_fkey(id, status)")[0]?.hint === "transactions_contact_id_fkey")
    check("parseEmbedNodes: an embed with no hint reports hint === null",
      parseEmbedNodes("transactions(id)")[0]?.hint === null)
    check("parseEmbedNodes: the hint never leaks into the relation or the inner list",
      JSON.stringify(parseEmbedNodes("c:transactions!transactions_contact_id_fkey(id, status)")) ===
        JSON.stringify([{ alias: "c", relation: "transactions", hint: "transactions_contact_id_fkey", inner: "id, status" }]))
    check("embedHintDisambiguates: !inner and !left are JOIN TYPES, not disambiguation hints",
      !embedHintDisambiguates("inner") && !embedHintDisambiguates("left") && !embedHintDisambiguates(null))
    check("embedHintDisambiguates: an FK constraint name / FK column name DOES disambiguate",
      embedHintDisambiguates("transactions_contact_id_fkey") && embedHintDisambiguates("buyer_contact_id"))

    // ── the pair cardinality itself ──────────────────────────────────────────────────
    check("fkPairCount: the live 3-FK pair is counted, and counted the SAME in both directions",
      fkPairCount("contacts", "transactions") === 3 && fkPairCount("transactions", "contacts") === 3)
    check("fkPairCount: a single-FK pair is 1 (absent from the table = one FK or none, never ambiguous)",
      fkPairCount("listings", "brokerages") === 1 && fkPairCount("listings", "agents") === 1)
    check("fkPairCount: a table with ONE self-FK is 1; the one table with TWO is 2 (document_folders vs remotion_composition_renders)",
      fkPairCount("document_folders", "document_folders") === 1 &&
      fkPairCount("remotion_composition_renders", "remotion_composition_renders") === 2)
    check("classifyEmbedRelation: reports the ROUTE — FK column vs table name — without changing resolveEmbedTable",
      classifyEmbedRelation("transactions", "contact_id").route === "fk-column" &&
      classifyEmbedRelation("transactions", "contacts").route === "table-name" &&
      classifyEmbedRelation("transactions", "nonsense_xyz").route === null &&
      resolveEmbedTable("transactions", "contact_id") === "contacts")

    const ambig = (literal: string, root: string) => resolveEmbeddedSelects(literal, root).ambiguous

    // ── NEGATIVE CONTROLS — every one of these MUST be flagged ───────────────────────
    check("NEGATIVE CONTROL: the live shape — bare transactions(…) off contacts (3 FKs: contact_id, buyer_contact_id, seller_contact_id)",
      ambig("id, first_name, transactions(id, status)", "contacts").length === 1 &&
      ambig("id, transactions(id)", "contacts")[0].fkCount === 3)
    check("NEGATIVE CONTROL: DIRECTION DOES NOT MATTER — bare contacts(…) off transactions is the same 3-FK pair",
      ambig("id, contacts(id, first_name)", "transactions").length === 1 &&
      ambig("id, contacts(id)", "transactions")[0].fkCount === 3)
    check("NEGATIVE CONTROL: !inner does NOT disambiguate — transactions!inner(…) off contacts still 400s",
      ambig("id, transactions!inner(id)", "contacts").length === 1)
    check("NEGATIVE CONTROL: an ALIAS does not disambiguate either — deals:transactions(…) off contacts",
      ambig("id, deals:transactions(id)", "contacts").length === 1)
    check("NEGATIVE CONTROL: a spread embed is checked too — ...transactions(…) off contacts",
      ambig("id, ...transactions(status)", "contacts").length === 1)
    check("NEGATIVE CONTROL: a NESTED bare embed is checked against ITS OWN parent (agents → transactions → contacts)",
      ambig("id, transactions!transactions_agent_id_fkey(id, contacts(first_name))", "agents")
        .map((a) => `${a.parent}->${a.target}:${a.fkCount}`).join() === "transactions->contacts:3")
    check("NEGATIVE CONTROL: the OTHER live 3-FK pair — bare agents(…) off transactions",
      ambig("id, agents(id)", "transactions")[0]?.fkCount === 3)
    check("NEGATIVE CONTROL: a 2-FK pair is ambiguous too — bare contacts(…) off listings, and off referrals",
      ambig("id, contacts(id)", "listings")[0]?.fkCount === 2 && ambig("id, contacts(id)", "referrals")[0]?.fkCount === 2)
    check("NEGATIVE CONTROL: TWO self-FKs are ambiguous like any other pair (remotion_composition_renders)",
      ambig("id, remotion_composition_renders(id)", "remotion_composition_renders").length === 1)

    // ── SPECIFICITY CONTROLS — every one of these MUST stay green ────────────────────
    check("SPECIFICITY: the DISAMBIGUATED form the repo already uses is left alone (transactions!transactions_contact_id_fkey(…) off contacts)",
      ambig("id, transactions!transactions_contact_id_fkey(id, status)", "contacts").length === 0)
    check("SPECIFICITY: an embed named by FK COLUMN has already chosen its relationship — never flagged",
      ambig("id, contact_id(id, first_name)", "transactions").length === 0 &&
      ambig("id, buyer_contact_id(id)", "transactions").length === 0)
    check("SPECIFICITY: an ALIASED FK-column embed is not flagged either (buyer:buyer_contact_id(…))",
      ambig("id, buyer:buyer_contact_id(id), seller:seller_contact_id(id)", "transactions").length === 0)
    check("SPECIFICITY: a pair with exactly ONE FK is never flagged, however it is spelled",
      ambig("id, brokerages(name), agents(id)", "listings").length === 0)
    check("SPECIFICITY: a table with ONE self-FK embedding itself is fine (document_folders)",
      ambig("id, document_folders(id, name)", "document_folders").length === 0)
    check("SPECIFICITY: an UNRESOLVABLE embed is skipped here too — never flagged on a guessed pair",
      ambig("id, mystery:whatever_id(a)", "contacts").length === 0)
    check("SPECIFICITY: with NO parent table there is no pair — skipped and COUNTED, never flagged",
      resolveEmbeddedSelects("transactions(id)").ambiguous.length === 0 &&
      resolveEmbeddedSelects("transactions(id)").ambiguityUnknownParent === 1)
    check("SPECIFICITY: the denominator counts only BARE TABLE-NAME embeds (hinted and FK-column embeds are not in it)",
      resolveEmbeddedSelects("brokerages(name), agent_id(id), transactions!transactions_contact_id_fkey(id), listings(id)", "contacts").bareTableEmbeds === 2)
    check("SPECIFICITY: the pair keys consulted are SORTED, so both directions consult ONE key",
      resolveEmbeddedSelects("transactions(id)", "contacts").pairsConsulted[0] === "contacts|transactions" &&
      resolveEmbeddedSelects("contacts(id)", "transactions").pairsConsulted[0] === "contacts|transactions")
    check("SPECIFICITY: the ambiguity check adds NO column refs and changes NO existing resolution field",
      JSON.stringify(resolveEmbeddedSelects("id, transactions(id, status)", "contacts").refs.map((x) => `${x.table}.${x.column}`)) ===
        JSON.stringify(["transactions.id", "transactions.status"]))

    // ── END-TO-END, through the real scanner ─────────────────────────────────────────
    // A correct rule is not a correct CHECK: attribution to the .from() and the select-arg
    // recovery both live in scanFile, and neither is exercised by the fixtures above.
    const ambigScan = (src: string) => { const s = newStats(); scanFile("test.ts", src, s); return s }
    const deadScan = ambigScan('await supabase.from("contacts").select("id, first_name, transactions(id, status)")')
    check("SCAN: the bare-embed PGRST201 shape is reported against the right pair, with its FK count",
      deadScan.embedAmbiguous.length === 1 && deadScan.embedAmbiguous[0].parent === "contacts" &&
      deadScan.embedAmbiguous[0].target === "transactions" && deadScan.embedAmbiguous[0].fkCount === 3,
      JSON.stringify(deadScan.embedAmbiguous))
    check("SCAN: the disambiguated form (the shape app/actions/ai-sphere-management.ts already uses) reports NOTHING",
      ambigScan('await supabase.from("contacts").select("id, transactions!transactions_contact_id_fkey(id, status)")').embedAmbiguous.length === 0)
    check("SCAN: a single-FK embed reports nothing but is still COUNTED in the denominator",
      (() => { const s = ambigScan('await supabase.from("listings").select("id, brokerages(name)")')
               return s.embedAmbiguous.length === 0 && s.bareTableEmbeds === 1 && s.ambiguityPairsConsulted.size === 1 })())
    check("SCAN: ambiguity findings never become a Violation, so they cannot reach ANY baseline file",
      scanFile("test.ts", 'await supabase.from("contacts").select("id, transactions(id, status)")').length === 0)
  }

  // ── the .or() / .filter() FILTER DSL ────────────────────────────────────────────────
  // Two halves, and BOTH must hold or the check is worthless: the NEGATIVE CONTROLS prove a
  // phantom column is caught in every syntactic position it can hide in, and the SPECIFICITY
  // CONTROLS prove the parser does not invent columns out of values, interpolations or embed
  // refs. A checker that fails the second half gets switched off within a week.
  {
    // ── string recovery ──────────────────────────────────────────────────────────────
    check("readJsStringLiteral: reads a plain double-quoted argument",
      readJsStringLiteral(`"a.eq.1"`, 0)?.text === "a.eq.1")
    check("readJsStringLiteral: reads a BACKTICK literal and marks its ${…} (a [\"']-only regex misses this entirely)",
      readJsStringLiteral('`created_at.lt.${cutoff}`', 0)?.text === `created_at.lt.${INTERP}`)
    check("readJsStringLiteral: a comma INSIDE an interpolation is not DSL text (${xs.join(\",\")})",
      readJsStringLiteral('`role.in.(${ROLES.join(",")})`', 0)?.text === `role.in.(${INTERP})`)
    check("staticFilterString: a non-literal argument yields NOTHING (skip, never guess)",
      staticFilterString("builtFilterString") === null)
    check("staticFilterString: a ternary's literal branches are fenced by markers, never spliced into one term",
      (staticFilterString(`cond ? "a.eq.1" : "b.eq.2"`) ?? "").includes(INTERP))

    // ── the grammar ──────────────────────────────────────────────────────────────────
    check("splitTopLevel: commas inside an in.(…) list do NOT split terms (the naive-split mangle)",
      JSON.stringify(splitTopLevel("status.in.(a,b,c),other.eq.1", ",")) ===
        JSON.stringify(["status.in.(a,b,c)", "other.eq.1"]))
    check("splitTopLevel: a dot inside a quoted value does not split the column path",
      splitTopLevel(`col.eq."a.b"`, ".").length === 3)
    check("parseFilterDsl: reads column + operator, ignoring the value",
      JSON.stringify(parseFilterDsl("status.eq.hot,lead_score.gte.50").refs.map((r) => r.column)) ===
        JSON.stringify(["status", "lead_score"]))
    check("parseFilterDsl: a `not.` negation prefix closes the column path (bio_text.not.is.null)",
      parseFilterDsl("bio_text.not.is.null").refs[0]?.column === "bio_text")
    check("parseFilterDsl: an and(…) group is recursed into, not read as a column",
      JSON.stringify(parseFilterDsl("status.eq.submitted,and(status.eq.approved,broker_approved_at.is.null)").refs.map((r) => r.column)) ===
        JSON.stringify(["status", "status", "broker_approved_at"]))
    check("parseFilterDsl: nested groups resolve at any depth",
      parseFilterDsl("or(and(a_col.eq.1,or(deep_col.is.null)))").refs.some((r) => r.column === "deep_col"))

    // ── NEGATIVE CONTROLS — a phantom column MUST be caught in every position ─────────
    const contactCols = new Set(SCHEMA_SNAPSHOT.contacts)
    const phantomsOf = (dsl: string) => parseFilterDsl(dsl).refs.filter((r) => !r.relation && !contactCols.has(r.column)).map((r) => r.column)

    check("NEGATIVE CONTROL: phantom column in a PLAIN .or() string is caught",
      phantomsOf("last_interaction_date.is.null,first_name.eq.x").join() === "last_interaction_date")
    // The live miss, verbatim: app/actions/ai-calendar-management.ts:449 filters `contacts` on a
    // `last_interaction_date` the table does not have (the real column is `last_contacted_at`).
    const calendarCall = '`last_interaction_date.is.null,last_interaction_date.lt.${new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString()}`'
    const calendarDsl = parseOrCallArgs(calendarCall)
    check("NEGATIVE CONTROL: the live ai-calendar-management TEMPLATE-LITERAL .or() is caught (contacts has no last_interaction_date)",
      !!calendarDsl && calendarDsl.refs.length === 2 &&
      calendarDsl.refs.every((r) => r.column === "last_interaction_date") &&
      !contactCols.has("last_interaction_date") && contactCols.has("last_contacted_at"),
      JSON.stringify(calendarDsl?.refs.map((r) => r.column)))
    check("NEGATIVE CONTROL: phantom column nested inside an and(…) group is caught",
      phantomsOf("status.eq.x,and(first_name.eq.y,phantom_nested_col.is.null)").join() === "phantom_nested_col")
    check("NEGATIVE CONTROL: phantom column carrying an in.(a,b,c) list is caught, and the list members are not read as columns",
      phantomsOf("status.in.(hot,warm,cold),phantom_list_col.in.(a,b,c)").join() === "phantom_list_col")

    // ── SPECIFICITY CONTROLS — these must stay GREEN ─────────────────────────────────
    check("SPECIFICITY: a REAL column passes (contacts.last_contacted_at — the live miss's true column)",
      phantomsOf("last_contacted_at.is.null,last_contacted_at.lte.2026-01-01").length === 0)
    check("SPECIFICITY: a VALUE that merely looks like a column is never read as one (status.eq.contact_id)",
      JSON.stringify(parseFilterDsl("status.eq.contact_id,lead_source.in.(email,phone)").refs.map((r) => r.column)) ===
        JSON.stringify(["status", "lead_source"]))
    const interpCol = parseOrCallArgs('`${sortColumn}.eq.1,first_name.eq.x`')
    check("SPECIFICITY: an INTERPOLATED column name is skipped and COUNTED, never guessed at",
      !!interpCol && interpCol.refs.length === 1 && interpCol.refs[0].column === "first_name" &&
      interpCol.skipped.length === 1 && interpCol.skipped[0].reason === "interpolated")
    check("SPECIFICITY: an interpolated VALUE does not disqualify its static column",
      parseOrCallArgs('`created_at.gte.${since}`')?.refs[0]?.column === "created_at")
    const embRef = parseFilterDsl("agents.first_name.ilike.%x%,first_name.ilike.%x%")
    check("SPECIFICITY: an EMBEDDED relation.column ref is bound to its relation, not to the parent table",
      embRef.refs.length === 2 && embRef.refs[0].relation === "agents" && embRef.refs[0].column === "first_name" &&
      embRef.refs[1].relation === null)
    check("SPECIFICITY: an embed ref resolves through the SAME machinery as embedded selects (listings.agent_id → agents)",
      resolveEmbedTable("listings", "agent_id") === "agents" &&
      parseFilterDsl("agent_id.first_name.eq.x").refs[0]?.relation === "agent_id")
    check("SPECIFICITY: a .or(str, { referencedTable }) 2nd argument re-points the whole string — skipped, not checked",
      parseOrCallArgs(`"a_col.eq.1", { referencedTable: "agents" }`) === null)
    check("SPECIFICITY: a TRAILING comma is not a second argument (the multi-line .or(`…`,\\n) shape)",
      parseOrCallArgs('`contact_id.eq.${id},buyer_contact_id.eq.${id}`,\n    ')?.refs.map((r) => r.column).join() === "contact_id,buyer_contact_id")
    check("staticJoinedArray: `[ \"a.eq.1\", \"b.is.null\" ].join(\",\")` reconstructs exactly",
      staticJoinedArray(`[\n  "event_type.like.buyer.%",\n  "event_type.like.seller.%",\n].join(",")`) ===
        "event_type.like.buyer.%,event_type.like.seller.%")
    check("staticJoinedArray: one non-literal element disqualifies the whole array (skip, never guess)",
      staticJoinedArray(`["a.eq.1", buildTerm].join(",")`) === null)
    // `.in("id", xs.filter(Boolean))` is Array.prototype, not a query filter. Matching it would
    // put JS built-ins into a report about database columns.
    {
      const chain = `.select("*").in("id", ids.filter(Boolean)).or("real_col.is.null")`
      const calls = topLevelChainCalls(chain)
      check("topLevelChainCalls: a .filter( INSIDE another call's arguments is NOT a chained query filter",
        JSON.stringify(calls.map((c) => c.name)) === JSON.stringify(["select", "in", "or"]))
    }
    check("SPECIFICITY: a path deeper than relation.column is skipped, never guessed",
      parseFilterDsl("a.b.c.eq.1").refs.length === 0 && parseFilterDsl("a.b.c.eq.1").skipped.length === 1)

    // ── .filter(column, op, value) — the first argument IS a column reference ─────────
    check("parseDslColumnPath: a json path checks its BASE column (metadata->>flag_key → metadata)",
      JSON.stringify(parseDslColumnPath("metadata->>flag_key")) === JSON.stringify({ ok: true, relation: null, column: "metadata" }))
    check("parseDslColumnPath: an interpolated json KEY still proves the base column (metadata->>${K})",
      JSON.stringify(parseDslColumnPath(`metadata->>${INTERP}`)) === JSON.stringify({ ok: true, relation: null, column: "metadata" }))
    check("parseDslColumnPath: an interpolated COLUMN name is skipped as interpolated",
      JSON.stringify(parseDslColumnPath(`${INTERP}->>k`)) === JSON.stringify({ ok: false, reason: "interpolated" }))

    // ── END-TO-END, through the real scanner ─────────────────────────────────────────
    // A correct parser is not a correct CHECK: attribution, the op label and the snapshot
    // lookup all live in scanFile. These drive synthetic source through it and assert on the
    // violations it actually returns.
    const scanOf = (src: string) => scanFile("test.ts", src)
    const calendarScan = scanOf('await supabase.from("contacts").select("id").or(`last_interaction_date.is.null,last_interaction_date.lt.${cut}`)')
    check("SCAN: the live template-literal .or() miss is reported against contacts (both terms)",
      calendarScan.length === 2 && calendarScan.every((x) => x.table === "contacts" && x.op === "or" && x.column === "last_interaction_date"),
      JSON.stringify(calendarScan))
    check("SCAN: the REAL column (last_contacted_at) reports nothing",
      scanOf('await supabase.from("contacts").select("id").or(`last_contacted_at.is.null,last_contacted_at.lt.${cut}`)').length === 0)
    check("SCAN: a phantom column nested in an and(…) group is reported, its siblings are not",
      scanOf('supabase.from("contacts").select("id").or("status.eq.x,and(first_name.eq.y,phantom_col.is.null)")')
        .map((x) => x.column).join() === "phantom_col")
    check("SCAN: a phantom column carrying an in.(…) list is reported and the list members are not",
      scanOf('supabase.from("contacts").select("id").or("status.in.(hot,warm),phantom_col.in.(a,b)")')
        .map((x) => x.column).join() === "phantom_col")
    // THE MIS-ATTRIBUTION CONTROL. `teams` really does have bio_text and `notifications` really
    // does not, so a "nearest preceding .from()" heuristic reports the phantom pair
    // notifications.bio_text for a filter that runs on teams. A reassigned query variable is a
    // separate statement belonging to no chain: it must be skipped and counted, never blamed
    // on whichever .from() happened to be typed last.
    check("SCAN: a reassigned-variable .or() is attributed to NOTHING (the notifications.bio_text census nonsense)",
      scanOf('let q = supabase.from("teams").select("id")\n  const other = supabase.from("notifications").select("id").eq("user_id", u)\n  q = q.or("bio_text.not.is.null")').length === 0)
    check("SCAN: .filter(Boolean) inside another call's arguments is not read as a query filter",
      scanOf('supabase.from("contacts").select("id").in("id", ids.filter(Boolean))').length === 0)
    check("SCAN: .filter(\"jsonb->>key\", op, v) checks the BASE column, not the json key",
      scanOf('supabase.from("contacts").select("id").filter("metadata->>k", "eq", v)').length === 0 &&
      scanOf('supabase.from("contacts").select("id").filter("not_a_column->>k", "eq", v)')
        .map((x) => `${x.op}:${x.table}.${x.column}`).join() === "filter:contacts.not_a_column")

    // ── PROSE IS NOT CODE. Both directions, both measured on live files. ──────
    // Direction 1 — the FALSE ACCUSATION. A comment that quotes a select, sitting
    // downstream of an unrelated from(), was read as that from()'s select. This
    // is campaign-drain.ts's `.select("id, unsubscribe_token")` explanation,
    // reduced: the column belongs to a different table entirely, and reporting it
    // against `contacts` is an accusation against code that is correct.
    check("SCAN: a select quoted inside a // comment is NOT attributed to an earlier from()",
      scanOf('await supabase.from("contacts").update({ first_name: n }).eq("id", id)\n  // That is why `.select("id, phantom_col")` and not just "id".').length === 0)
    check("SCAN: a select quoted inside a /* block */ comment is not attributed either",
      scanOf('await supabase.from("contacts").update({ first_name: n }).eq("id", id)\n  /* explains `.select("id, phantom_col")` above */').length === 0)
    // Direction 2 — the MISSED DEFECT, and the more dangerous of the two. An
    // apostrophe in a trailing comment ("the script's agent") opened a string
    // literal for the object-key parser, which then swallowed every key after it.
    // That is exactly how video_assets.status and .video_type stayed invisible.
    check("SCAN: an apostrophe in a trailing comment does not hide the keys BELOW it",
      scanOf('await supabase.from("contacts").insert({\n    first_name: a,  // use the script\'s agent, not the approver\n    phantom_col: b,\n  })')
        .map((x) => `${x.op}:${x.table}.${x.column}`).join() === "insert:contacts.phantom_col")
    // …and a REAL column in that position still reports nothing, so the control
    // above is proving the comment handling and not just a noisy parser.
    check("SCAN: the same shape with a REAL column below the apostrophe reports nothing",
      scanOf('await supabase.from("contacts").insert({\n    first_name: a,  // use the script\'s agent, not the approver\n    last_name: b,\n  })').length === 0)
    // The mirror control: a from() that exists ONLY in prose must not enrol a
    // table or mint violations of its own.
    check("SCAN: a from() written only inside a comment contributes nothing",
      scanOf('// legacy: supabase.from("contacts").select("phantom_col")\nconst x = 1').length === 0)
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

/** What the scan measured — printed so the embed check's COVERAGE is visible, not implied.
 *  "unresolved" is the honest edge of the check: those embeds were skipped, not passed. */
interface ScanStats {
  directColumns: number
  embedColumns: number
  embedsResolved: number
  embedsUnresolved: number
  embedTargetUnguarded: number
  unresolved: Array<{ file: string; relation: string; parent: string | null }>
  /** ── .or()/.filter() DSL coverage. Every one of these is printed, because the only honest
   *  way to publish a coverage number is to publish what it EXCLUDES alongside it. */
  dslStrings: number            // filter-DSL strings statically recovered and parsed
  dslTerms: number              // condition terms inside them
  dslColumns: number            // column refs actually checked against a snapshot
  dslTargetUnguarded: number    // refs whose table has no column list — cannot check, do not guess
  dslUnattributed: number       // DSL-shaped call sites not on any guarded .from() chain
  dslSkipped: Array<{ file: string; kind: string; text: string; reason: string }>
  dslUnattributedSites: Array<{ file: string; text: string }>
  /** ── PGRST201 embed-ambiguity coverage. Same honesty rule as the two blocks above: the
   *  denominator (how many bare table-name embeds were actually put to the pair test, and how
   *  many distinct pairs that consulted) is printed next to the finding count, and everything
   *  that could NOT be tested is counted rather than assumed fine. Ambiguity findings are held
   *  HERE and deliberately never turned into a `Violation`: the three baseline files are all at
   *  zero, and a new check that can reach a baseline is a new check that can be absorbed into
   *  one. This one structurally cannot. */
  bareTableEmbeds: number
  ambiguityPairsConsulted: Set<string>
  ambiguityUnknownParent: number
  embedAmbiguous: Array<AmbiguousEmbed & { file: string }>
  /** ── COMPUTED WRITE KEYS — `{ [X]: v }`. Same honesty rule as every block above.
   *  `computedKeysResolved` were checked exactly like literal keys (X is a module-level
   *  string const, or the key was quoted). `computedKeysUnresolved` could NOT be turned
   *  into a column name and were therefore NEVER CHECKED — they are printed rather than
   *  dropped, because these used to vanish in total silence and a column written this way
   *  could drift for its whole life without the guard noticing. */
  computedKeysResolved: number
  computedKeysUnresolved: Array<{ file: string; table: string; expr: string }>
}
const newStats = (): ScanStats => ({
  directColumns: 0, embedColumns: 0, embedsResolved: 0, embedsUnresolved: 0, embedTargetUnguarded: 0, unresolved: [],
  dslStrings: 0, dslTerms: 0, dslColumns: 0, dslTargetUnguarded: 0, dslUnattributed: 0, dslSkipped: [], dslUnattributedSites: [],
  computedKeysResolved: 0, computedKeysUnresolved: [],
  bareTableEmbeds: 0, ambiguityPairsConsulted: new Set(), ambiguityUnknownParent: 0, embedAmbiguous: [],
})

/** Violation ops produced by the filter-DSL check. They are kept OUT of both legacy baselines:
 *  the direct-column baseline is held at zero and the embedded-column baseline at a hard zero,
 *  and folding a brand-new check's findings into either would erase those standards. */
const DSL_OPS = new Set(["or", "filter", "or(embed)", "filter(embed)"])

function scanFile(file: string, rawSrc: string, stats: ScanStats = newStats()): Violation[] {
  // ── COMMENTS ARE BLANKED BEFORE ANYTHING IS SCANNED. ────────────────────────
  // This guard read RAW SOURCE for its whole life, so a query written inside a
  // comment was indistinguishable from one that runs. Two live consequences,
  // both measured:
  //
  //   FALSE ACCUSATION. lib/direct-mail/campaign-drain.ts explains its own
  //   insert with the line ``That is why `.select("id, unsubscribe_token")` and
  //   not just "id":``. The guard read that quoted fragment as a live select,
  //   attached it to the nearest preceding from() — direct_mail_campaigns, a
  //   DIFFERENT table — and reported direct_mail_campaigns.unsubscribe_token as
  //   drift. The column is real and sits on direct_mail_recipients, which the
  //   actual code queries correctly. A guard reading prose, accusing code.
  //
  //   MISSED DEFECT, the same blindness pointing the other way. A trailing
  //   comment with an apostrophe — `agent_id: x,  // use the script's agent` —
  //   opened a string literal for the object-key parser, which swallowed every
  //   key after it. app/api/video-scripts/[id]/approve/route.ts inserted
  //   `status` and `video_type` into video_assets, a table that has neither, and
  //   the guard never saw them. That insert could only ever raise PGRST204.
  //
  // blankComments, not stripComments: every position here is computed from a
  // match index (collectSelectArg walks forward from the from() offset), so the
  // replacement must preserve character offsets, not merely line numbers.
  // Idempotent — blanking already-blanked source is a no-op — so a caller that
  // pre-blanks is not double-charged.
  const src = blankComments(rawSrc)
  // Module-level string consts, so a COMPUTED write key `{ [NAME]: v }` can be resolved
  // to the column it actually names. Computed once per file, not per write site — a file
  // has one set of module bindings.
  const fileConsts: ComputedKeyResolver = new Map<string, string | string[]>(moduleStringConsts(src))
  // …and the loop-over-columns idiom, which is how `transactions.agent_id` /
  // `.buyer_agent_id` / `.seller_agent_id` are written in two files.
  for (const [k, v] of loopStringSets(src)) if (!fileConsts.has(k)) fileConsts.set(k, v)
  const v: Violation[] = []
  /** Absolute source indices of `.or(`/`.filter(` sites a guarded from()-chain reached. */
  const dslAttributed = new Set<number>()
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
      for (const c of parseSelectColumns(sel)) { stats.directColumns++; if (!set.has(c)) v.push({ file, table, op: "select", column: c }) }
      // Embedded relations are a DIFFERENT table's columns — checked against that table's
      // snapshot, because ONE bad embed column fails the whole query. Resolution starts
      // from THIS from() table so `alias:fk_column(...)` embeds (and nested embeds, which
      // resolve against their own parent) are checked instead of silently dropped.
      const emb = resolveEmbeddedSelects(sel, table)
      stats.embedsResolved += emb.resolvedCount
      stats.embedsUnresolved += emb.unresolved.length
      for (const u of emb.unresolved) stats.unresolved.push({ file, relation: u.relation, parent: u.parent })
      // PGRST201: a bare table-name embed across a pair joined by more than one FK. Not a
      // column problem and not a phantom-relation problem — the whole request 400s anyway.
      stats.bareTableEmbeds += emb.bareTableEmbeds
      stats.ambiguityUnknownParent += emb.ambiguityUnknownParent
      for (const p of emb.pairsConsulted) stats.ambiguityPairsConsulted.add(p)
      for (const a of emb.ambiguous) stats.embedAmbiguous.push({ file, ...a })
      for (const e of emb.refs) {
        // Target is a real table we simply have no column list for — cannot check, do
        // not guess. Counted as unresolved so the coverage number stays honest.
        if (!GUARDED.has(e.table)) { stats.embedTargetUnguarded++; continue }
        // `related_table(count)` is PostgREST's related-row aggregate, not a column.
        if (e.column === "count") continue
        stats.embedColumns++
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
        const parsed = parseObjectTopLevelKeysDetailed(obj, fileConsts)
        stats.computedKeysResolved += parsed.resolvedComputed.length
        for (const e of parsed.unresolvedComputed) stats.computedKeysUnresolved.push({ file, table, expr: e })
        for (const k of parsed.keys) if (!set.has(k)) v.push({ file, table, op: opM[1], column: k })
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
            const rowObj = src.slice(i, bc + 1)
            const rowParsed = parseObjectTopLevelKeysDetailed(rowObj, fileConsts)
            stats.computedKeysResolved += rowParsed.resolvedComputed.length
            for (const e of rowParsed.unresolvedComputed) stats.computedKeysUnresolved.push({ file, table, expr: e })
            for (const k of rowParsed.keys) if (!set.has(k)) v.push({ file, table, op: arrM[1], column: k })
            i = bc
          }
        }
      }
    }
    // `update` belongs in this list as much as insert/upsert does. It was missing,
    // and `.update(VARIABLE)` was therefore the one write shape the guard could not
    // see at all — the inline-literal block above covers `.update({…})`, but a write
    // object built into a variable first slipped straight through. That blind spot
    // hid two live PGRST204 refusals: `contacts.preferred_cities` in
    // lib/services/contact-management.service.ts (silently swallowed — the merge
    // reported success over a write that never happened) and the three phantom
    // columns in app/actions/ai-lead-scoring.ts that broke the CRM "Run AI Score"
    // button. A refused UPDATE is refused ENTIRELY, so one phantom key voids every
    // real column beside it — exactly the bug class this guard exists to stop.
    const varM = chain.match(/\.(insert|upsert|update)\(\s*([a-zA-Z_$][\w$]*)\s*\)/)
    if (varM && varM.index != null && !["true", "false", "null"].includes(varM[2])) {
      for (const k of resolveVariableInsertKeys(src, varM[2], m.index + varM.index)) if (!set.has(k)) v.push({ file, table, op: `${varM[1]}(var)`, column: k })
    }
    // FILTER / order column args (the first string arg is a real column). A filter on a
    // phantom column errors the query the same way a select does. Scope to the CONTIGUOUS
    // method chain hanging directly off this .from() — a `query = query.eq("col", …)`
    // reassignment is a separate statement (not directly chained) and must NOT be
    // attributed to the most-recent from() (that mis-attributed agent_id/transaction_id/
    // user_id to the wrong table). Skip embed paths (col with a `.`) here; `.or()`/`.filter()`
    // are excluded from THIS block because their column names live inside a string — they are
    // parsed by the filter-DSL block immediately below, off the very same chain.
    const chainStart = m.index + m[0].length
    const filterChain = contiguousChain(src, chainStart)
    for (const fm of filterChain.matchAll(/\.(eq|neq|gt|gte|lt|lte|like|ilike|in|is|contains|containedBy|order|not)\(\s*["'`]([a-zA-Z_][a-zA-Z0-9_.]*)["'`]/g)) {
      const col = fm[2]
      if (col.includes(".")) continue
      if (!set.has(col)) v.push({ file, table, op: fm[1], column: col })
    }

    // ── FILTER-DSL columns: `.or("col.op.val,…")` and `.filter("col", op, val)` ──────────
    // Same attribution as the block above — the CONTIGUOUS chain hanging off this .from(),
    // nothing else. Attribution matters more here than the parser does: a "nearest preceding
    // .from() within N characters" heuristic pairs a query on `teams` with a column from
    // `notifications` and reports it as drift, which is how a guard earns its way to being
    // switched off. A site the chain does not reach is counted as unattributed, never guessed.
    const checkDslRef = (relation: string | null, column: string, op: string, term: string) => {
      let target = table
      if (relation) {
        // `relation.column.op.value` addresses an EMBEDDED relation, not the parent — resolved
        // through the same FK machinery as embedded selects, and SKIPPED when it cannot be named.
        const resolved = resolveEmbedTable(table, relation)
        if (!resolved) { stats.dslSkipped.push({ file, kind: op, text: term, reason: `embed relation "${relation}" unresolvable from ${table}` }); return }
        target = resolved
      }
      if (!GUARDED.has(target)) { stats.dslTargetUnguarded++; return }
      stats.dslColumns++
      if (!new Set(SCHEMA_SNAPSHOT[target]).has(column)) {
        v.push({ file, table: target, op: relation ? `${op}(embed)` : op, column })
      }
    }
    for (const call of topLevelChainCalls(filterChain)) {
      if (call.name !== "or" && call.name !== "filter") continue
      dslAttributed.add(chainStart + call.index)
      const argsText = call.args
      if (call.name === "filter") {
        // `.filter(column, operator, value)` — the first argument is a plain column reference
        // (here, always a `jsonb->>key` path), NOT the or() DSL.
        const lit = staticFilterString(firstArg(argsText))
        if (lit === null) { stats.dslSkipped.push({ file, kind: "filter", text: firstArg(argsText).trim().slice(0, 60), reason: "not a static string" }); continue }
        stats.dslStrings++
        stats.dslTerms++
        const p = parseDslColumnPath(lit)
        if (!p.ok) { stats.dslSkipped.push({ file, kind: "filter", text: lit, reason: p.reason }); continue }
        checkDslRef(p.relation, p.column, "filter", lit)
      } else {
        const parsed = parseOrCallArgs(argsText)
        if (!parsed) { stats.dslSkipped.push({ file, kind: "or", text: argsText.trim().slice(0, 60), reason: "not a single static string argument" }); continue }
        stats.dslStrings++
        stats.dslTerms += parsed.terms
        for (const s of parsed.skipped) stats.dslSkipped.push({ file, kind: "or", text: s.term, reason: s.reason })
        for (const r of parsed.refs) checkDslRef(r.relation, r.column, "or", r.term)
      }
    }
  }
  // Coverage honesty: a DSL-shaped call site (`.or("…"` / `.filter("…"`) that no guarded
  // .from() chain reached was NOT checked. Counting them is the difference between "we check
  // the .or() DSL" and "we check the .or() DSL where we can prove which table it runs against".
  for (const sm of src.matchAll(/\.(?:or|filter)\s*\(\s*["'`]/g)) {
    if (dslAttributed.has(sm.index!)) continue
    stats.dslUnattributed++
    stats.dslUnattributedSites.push({ file, text: src.slice(sm.index!, sm.index! + 70).split("\n")[0] })
  }
  return v
}

function testScan() {
  console.log("\n[Layer 2 · repo scan against the live-schema snapshot]")
  const root = process.cwd()
  const files: string[] = []
  for (const d of runtimeRoots(root)) { try { walk(join(root, d), files) } catch {} }
  const all: Violation[] = []
  const stats = newStats()
  for (const f of files) {
    let src = ""
    // Blanked here as well as inside scanFile, because the cheap `hit` precheck
    // below decides whether the file is scanned AT ALL: a from("guarded_table")
    // appearing only in a comment must not enrol a file, and a real one must not
    // be missed. Same rule, applied at both gates.
    try { src = blankComments(readFileSync(f, "utf8")) } catch { continue }
    let hit = false
    for (const t of GUARDED) if (src.includes(`from("${t}")`) || src.includes(`from('${t}')`)) { hit = true; break }
    if (!hit) continue
    all.push(...scanFile(f.replace(root + "/", ""), src, stats))
  }

  // COVERAGE, stated out loud. A guard that reports only failures hides its own blind
  // spots; the embed check's blind spot is every embed whose target it could not name.
  console.log(`  · ${stats.directColumns} direct column refs + ${stats.embedColumns} embedded column refs checked`)
  console.log(`  · embeds: ${stats.embedsResolved} resolved to a table, ${stats.embedTargetUnguarded} embedded columns skipped (target table not column-guarded)`)
  console.log(`  · unresolved embeds: ${stats.embedsUnresolved} (skipped, never failed — set GUARD_EMBED_REPORT=1 to list them)`)
  // ── PGRST201 ambiguity coverage, stated out loud (same rule as every other block here) ──
  console.log(`  · embed ambiguity: ${stats.bareTableEmbeds} bare table-name embeds checked against ${stats.ambiguityPairsConsulted.size} distinct table pairs`)
  console.log(`               (${Object.keys(SCHEMA_FK_PAIR_CARDINALITY).length} pairs in the schema carry >1 FK; ${stats.ambiguityUnknownParent} embeds skipped for an unknown parent table)`)
  // ── .or()/.filter() FILTER-DSL coverage, stated out loud (same rule as the embeds above) ──
  console.log(`  · filter DSL: ${stats.dslStrings} .or()/.filter() strings scanned (${stats.dslTerms} terms) — ${stats.dslColumns} column refs checked`)
  console.log(`  · filter DSL: ${stats.dslSkipped.length} terms/strings unparseable or unresolvable, ${stats.dslUnattributed} call sites not attributable to a guarded .from() chain`)
  console.log(`               (all skipped, never failed — set GUARD_DSL_REPORT=1 to list them)`)
  if (process.env.GUARD_EMBED_REPORT === "1" && stats.embedsUnresolved > 0) {
    const byRel = new Map<string, { parents: Set<string>; files: Set<string> }>()
    for (const u of stats.unresolved) {
      if (!byRel.has(u.relation)) byRel.set(u.relation, { parents: new Set(), files: new Set() })
      const e = byRel.get(u.relation)!
      e.parents.add(u.parent ?? "?")
      e.files.add(u.file)
    }
    console.log("    unresolved embed relations (name — parent tables — files):")
    for (const [rel, e] of [...byRel.entries()].sort((a, b) => b[1].files.size - a[1].files.size)) {
      console.log(`      ${rel}  ← ${[...e.parents].sort().join(", ")}  (${e.files.size} file${e.files.size === 1 ? "" : "s"}, e.g. ${[...e.files].sort()[0]})`)
    }
  }

  // Baseline ratchet: known PRE-EXISTING legacy violations are tolerated (burn-down list);
  // any NEW violation fails the guard immediately. Regenerate with GUARD_WRITE_BASELINE=1.
  // The honest edge of the filter-DSL check, itemised: every string it could not read and
  // every call site no guarded chain reached. Coverage that does not publish its exclusions
  // is just a number that rounds up.
  //
  // COMPUTED WRITE KEYS. Printed for the same reason: `{ [X]: v }` names a column, and
  // until this line existed the parser could not see one at all — it started a key only
  // at a letter, and a computed key starts at `[`, which went straight onto the bracket
  // stack. Nothing was recorded and nothing was reported, so a column written this way
  // was outside the guard entirely. contact_suppression_list.mailing_address_key was the
  // proof: added by m503, written through exactly this shape, absent from the snapshot,
  // and the guard green throughout. The resolved half is now checked like any literal
  // key; the unresolved half is named here rather than dropped, because the whole lesson
  // of that column is that a silent skip and a pass look identical from the outside.
  console.log(
    `  · computed write keys: ${stats.computedKeysResolved} resolved and checked, ` +
      `${stats.computedKeysUnresolved.length} unresolvable (never checked — listed with GUARD_DSL_REPORT=1)`,
  )
  if (process.env.GUARD_DSL_REPORT === "1" && stats.computedKeysUnresolved.length) {
    console.log("    unresolvable computed write keys (table — expression — file):")
    for (const c of [...new Set(stats.computedKeysUnresolved.map((c) => `${c.table}  [${c.expr}]  ${c.file}`))].sort()) {
      console.log(`      ${c}`)
    }
  }
  if (process.env.GUARD_DSL_REPORT === "1") {
    const byReason = new Map<string, string[]>()
    for (const s of stats.dslSkipped) {
      const key = s.reason
      if (!byReason.has(key)) byReason.set(key, [])
      byReason.get(key)!.push(`${s.file}  .${s.kind}(  ${JSON.stringify(s.text)}`)
    }
    console.log("    skipped filter-DSL terms (reason — count — sites):")
    for (const [reason, sites] of [...byReason.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`      ${reason}  ×${sites.length}`)
      for (const s of [...new Set(sites)].sort()) console.log(`         ${s}`)
    }
    console.log(`    unattributed .or()/.filter() sites (×${stats.dslUnattributed}):`)
    for (const s of stats.dslUnattributedSites) console.log(`      ${s.file}  ${s.text.trim()}`)
  }

  if (process.env.GUARD_WRITE_BASELINE === "1") {
    const legacyDirect = all.filter((v) => v.op !== "select(embed)" && !DSL_OPS.has(v.op))
    writeFileSync(BASELINE_PATH, JSON.stringify(legacyDirect.map(vkey).sort(), null, 2) + "\n")
    console.log(`  ⚙  wrote baseline: ${legacyDirect.length} known direct-column violations → scripts/schema-drift-baseline.json`)
  }
  // Embedded-relation columns are a NEWLY added check (see parseEmbeddedSelects). They
  // get their OWN ratchet: the direct-column baseline is held at zero-zero on purpose,
  // and folding a new check's pre-existing findings into it would erase that standard.
  // New check, own burn-down, same rule — nothing new may be added.
  const embedAll = all.filter((v) => v.op === "select(embed)")
  const dslAll = all.filter((v) => DSL_OPS.has(v.op))
  const directAll = all.filter((v) => v.op !== "select(embed)" && !DSL_OPS.has(v.op))

  if (process.env.GUARD_WRITE_BASELINE === "1") {
    writeFileSync(EMBED_BASELINE_PATH, JSON.stringify(embedAll.map(vkey).sort(), null, 2) + "\n")
    console.log(`  ⚙  wrote embed baseline: ${embedAll.length} known embedded-column violations`)
  }
  const embedBaseline = new Set<string>(existsSync(EMBED_BASELINE_PATH) ? JSON.parse(readFileSync(EMBED_BASELINE_PATH, "utf8")) : [])
  const embedFresh = embedAll.filter((v) => !embedBaseline.has(vkey(v)))
  check(`no NEW embedded-relation column drift (burn-down: ${embedBaseline.size} pre-existing — each one fails its ENTIRE query)`,
    embedFresh.length === 0,
    embedFresh.slice(0, 20).map((x) => `${x.file}: ${x.table}.${x.column}`).join(" | ") + (embedFresh.length > 20 ? ` … +${embedFresh.length - 20} more (full list above)` : ""))
  if (embedFresh.length > 0) {
    // Never truncate this one. A truncated list of dead queries is a list someone fixes
    // the first twenty of and then declares done.
    console.log(`  ⚠  ${embedFresh.length} embedded-column references name a column their table does not have.`)
    console.log("     PostgREST rejects the WHOLE query for each — every one is a silently dead read:")
    const byFile = new Map<string, string[]>()
    for (const x of embedFresh) {
      if (!byFile.has(x.file)) byFile.set(x.file, [])
      byFile.get(x.file)!.push(`${x.table}.${x.column}`)
    }
    for (const [file, cols] of [...byFile.entries()].sort()) {
      console.log(`       ${file}`)
      for (const c of [...new Set(cols)].sort()) console.log(`         ✗ ${c}   [owner: ${resolveTableManager(c.split(".")[0]).label}]`)
    }
  }
  if (embedBaseline.size > 0) {
    console.log(`  ⚠  ${embedBaseline.size} embedded-column violations remain. PostgREST rejects the WHOLE`)
    console.log("     query when an embed names a missing column, so each is a silent dead surface:")
    for (const k of [...embedBaseline].sort()) console.log(`       ${k.replace("::select(embed)", "")}`)
  }

  // ── PGRST201 embed-ambiguity check ───────────────────────────────────────────────────
  // NO BASELINE, NO ALLOW-LIST, NO BURN-DOWN — on purpose, and it is the whole point. The
  // embedded-column and filter-DSL checks are both held at a hard zero; a new check that ships
  // with a tolerated list starts life already hollowed out, and "zero" stops meaning zero the
  // day it is seeded. Every entry below is a request PostgREST rejects in full: fix the embed
  // (add `!<fk_constraint>`, or name the FK column instead of the table), never the check.
  check(`no AMBIGUOUS bare-table embed — PGRST201 (${stats.bareTableEmbeds} bare table-name embeds over ${stats.ambiguityPairsConsulted.size} pairs, no allow-list)`,
    stats.embedAmbiguous.length === 0,
    stats.embedAmbiguous.length === 0 ? undefined
      : `${stats.embedAmbiguous.length} occurrences across ${new Set(stats.embedAmbiguous.map((a) => `${a.file}::${a.parent}|${a.target}`)).size} file/pair sites (full list below)`)
  if (stats.embedAmbiguous.length > 0) {
    // Never truncated, for the same reason the other two are not: a truncated list of dead
    // reads is a list someone fixes the top of and then calls done.
    console.log(`  ⚠  ${stats.embedAmbiguous.length} embeds name their target by TABLE NAME across a pair joined by MORE THAN ONE`)
    console.log("     foreign key, with no !hint to choose one. PostgREST answers PGRST201 and rejects the")
    console.log("     WHOLE request — the relation is real, the columns are real, and the read is still dead:")
    const byFile = new Map<string, string[]>()
    for (const a of stats.embedAmbiguous) {
      if (!byFile.has(a.file)) byFile.set(a.file, [])
      byFile.get(a.file)!.push(`.from("${a.parent}") ⟶ ${a.relation}(…)   [${a.fkCount} FKs join ${a.parent}↔${a.target}]`)
    }
    for (const [f, sites] of [...byFile.entries()].sort()) {
      console.log(`       ${f}`)
      for (const s of [...new Set(sites)].sort()) console.log(`         ✗ ${s}`)
    }
  }

  // ── filter-DSL ratchet ───────────────────────────────────────────────────────────────
  // A brand-new check gets its OWN burn-down, never a seat in an existing baseline file:
  // the direct-column baseline and the embedded-column baseline are both held at zero, and
  // absorbing new findings into either would silently redefine what "zero" means.
  //
  // This list is EXPLICIT, NAMED and SHRINK-ONLY. Every entry is a dead read that PostgREST
  // rejects in full. Entries may only be REMOVED (by fixing the column); adding one is how
  // the check gets quietly hollowed out, so the assertion below fails on any new hit.
  const DSL_BURN_DOWN: string[] = []
  const dslAllowed = new Set(DSL_BURN_DOWN)
  const dslFresh = dslAll.filter((x) => !dslAllowed.has(vkey(x)))
  check(`no phantom column inside a .or()/.filter() filter string (burn-down: ${DSL_BURN_DOWN.length} allowed)`,
    dslFresh.length === 0,
    dslFresh.map((x) => `${x.file}: ${x.table}.${x.column} (${x.op})`).join(" | "))
  if (dslFresh.length > 0) {
    // Never truncated. PostgREST errors the WHOLE request on an unknown column inside an
    // .or() string, exactly as it does for a phantom column in a select — each line is a
    // read that has been returning nothing and will keep returning nothing.
    console.log(`  ⚠  ${dslFresh.length} filter-DSL column references name a column their table does not have.`)
    console.log("     PostgREST rejects the WHOLE request for each — every one is a silently dead read:")
    const byFile = new Map<string, string[]>()
    for (const x of dslFresh) {
      if (!byFile.has(x.file)) byFile.set(x.file, [])
      byFile.get(x.file)!.push(`${x.table}.${x.column}  (.${x.op})`)
    }
    for (const [f, cols] of [...byFile.entries()].sort()) {
      console.log(`       ${f}`)
      for (const c of [...new Set(cols)].sort()) console.log(`         ✗ ${c}   [owner: ${resolveTableManager(c.split(".")[0]).label}]`)
    }
  }
  const dslFixed = DSL_BURN_DOWN.filter((k) => !dslAll.some((x) => vkey(x) === k))
  if (dslFixed.length > 0) console.log(`  ↘  ${dslFixed.length} filter-DSL burn-down entries are now fixed — delete them from DSL_BURN_DOWN.`)

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
    // Comments blanked here too, for the mirror-image reason: a `.from("x").select(…)`
    // written in a comment would enrol table x in the coverage ratchet, demanding a
    // snapshot entry for a table no query touches. Layer 2 and Layer 3 must agree on
    // what counts as code.
    try { src = blankComments(readFileSync(f, "utf8")) } catch { continue }
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

// ── IMPORTED AS A LIBRARY, RUN AS A GUARD ───────────────────────────────────
// Twenty-two of the parsers above are exported, and they are the only correct
// readers of a PostgREST call chain in this repo — column lists, embed
// resolution, object keys, variable-shaped inserts, the filter DSL. A second
// analyzer that needs them had exactly two options: import this file (which ran
// the ENTIRE guard as a side effect of the import, printing a second report and
// exiting non-zero mid-scan on any failure) or hand-roll its own copies. The
// second option is how a repo ends up with two parsers that disagree, and it is
// precisely what this codebase's doctrine exists to prevent.
//
// So the guard's ENTRY POINT is gated, and nothing else changes: with the
// variable unset — every CI run, every `npm run test:schema-drift`, every bare
// `tsx scripts/schema-drift-guard.ts` — main() runs exactly as it did before.
// scripts/opposite-missing-census.ts sets it to "1" before its dynamic import,
// so it gets the parsers WITHOUT the report.
if (process.env.SCHEMA_DRIFT_AS_LIBRARY !== "1") main()
