#!/usr/bin/env tsx
/**
 * scripts/check-vocabulary-guard.ts   (npm run test:check-vocabulary) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE LITERAL THE DATABASE WILL NOT ACCEPT.
 *
 * Postgres CHECK constraints are live vocabularies. supabase-js resolves with
 * `{ error }` instead of throwing, and most writes in this app are best-effort,
 * so a value outside the admitted set does not crash anything — it loses the row
 * in silence. On the READ side it is worse: a filter on a value the column can
 * never hold returns zero rows and looks like "no data yet" forever.
 *
 * FOUR shipped defects in a single sweep came from exactly this:
 *
 *   agent_onboarding.status = 'stalled'         → not in (in_progress|completed|paused).
 *                                                 The console's Stalled card was permanently 0
 *                                                 and the intervention branch behind it was
 *                                                 unreachable code.
 *   buyer_fatigue_scores.risk_level watch/warning → the entire 35-79 band of scores failed to
 *                                                 persist, and two dashboards filtered on values
 *                                                 the table cannot hold.
 *   fatigue_alerts.alert_type = 'fatigue_critical' → a critical alert always rendered as a warning.
 *   listings lifecycle_stage='active' + status='closed' → an hourly sweep that matched zero rows
 *                                                 on every run since it shipped.
 *
 * There is an existing `test:vocabulary-drift`, but it compares handler-switch cases against
 * TypeScript enums — code against code. Nothing compared code against the DATABASE. This does.
 *
 * WHAT IT CHECKS. For every `.from(t)` chain, any literal assigned to or compared against a
 * column of `t` that carries an enum CHECK must be a member of that column's admitted set —
 * on inserts/upserts/updates AND on .eq/.neq/.in/.or filters.
 *
 * The window is cut at the NEXT `.from(` — the same discipline the id-class guard learned the
 * hard way. A fixed-size window spills into the following query and mis-attributes its payload,
 * which matters doubly here because names like `status` and `type` exist on hundreds of tables.
 *
 * Pre-existing violations are baselined and may only SHRINK. A new one fails CI.
 * Run UPDATE_CHECK_VOCAB_BASELINE=1 after deliberately retiring a baselined entry.
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASELINE_PATH = join(root, "scripts", "check-vocabulary-baseline.json")

export interface VocabViolation {
  file: string
  table: string
  column: string
  value: string
  /** "write" (payload key) or "filter" (.eq/.neq/.in/.or). */
  kind: "write" | "filter"
}

/** Comments quote the dead literals they retired — never scan them. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
}

function* walk(dir: string): Generator<string> {
  let entries: string[]
  try { entries = readdirSync(dir) } catch { return }
  for (const n of entries) {
    if (n === "node_modules" || n === ".next" || n.startsWith(".")) continue
    const p = join(dir, n)
    if (statSync(p).isDirectory()) yield* walk(p)
    else if (/\.(ts|tsx)$/.test(n)) yield p
  }
}

/**
 * TOP-LEVEL keys of an object literal, as `name: "literal"` pairs. Values that are
 * themselves objects or arrays are skipped entirely.
 *
 * This matters more than it sounds. Rows here routinely carry a `metadata` /
 * `settings` / `payload` JSONB bag, and those bags contain arbitrary keys — `source`,
 * `status`, `type` — that collide with real column names. `lifecycle_events.source`
 * is a four-value provenance CHECK (ui|webhook|system|cron), and every one of the
 * eight "violations" this guard first reported for it was a `source:` inside a
 * `metadata: { ... }`, which is free-form JSON the constraint never sees.
 */
export function topLevelPairs(objText: string): Array<{ key: string; value: string }> {
  const out: Array<{ key: string; value: string }> = []
  let depth = 0
  let i = 0
  while (i < objText.length) {
    const c = objText[i]
    if (c === "{" || c === "[") { depth++; i++; continue }
    if (c === "}" || c === "]") { depth--; i++; continue }
    if (depth === 1) {
      const m = /^([A-Za-z_$][\w$]*)\s*:\s*(["'])([^"'\n]*)\2/.exec(objText.slice(i))
      if (m) { out.push({ key: m[1], value: m[3] }); i += m[0].length; continue }
    }
    i++
  }
  return out
}

/**
 * The balanced argument text of every `.insert(` / `.upsert(` / `.update(` in a chain
 * window. Brace/paren matching, so a nested object stays inside its own payload and an
 * unrelated literal that merely sits nearby does not leak in.
 */
export function mutationArgs(win: string): string[] {
  const out: string[] = []
  const re = /\.(insert|upsert|update)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(win))) {
    let depth = 0
    for (let i = m.index + m[0].length - 1; i < win.length; i++) {
      const c = win[i]
      if (c === "(") depth++
      else if (c === ")") {
        depth--
        if (depth === 0) { out.push(win.slice(m.index + m[0].length, i)); break }
      }
    }
  }
  return out
}

/** PURE — exported so the checks below can exercise it directly. */
export function scanCheckVocabulary(rawSrc: string, file: string): VocabViolation[] {
  const src = stripComments(rawSrc)
  const out: VocabViolation[] = []

  for (const [table, columns] of Object.entries(CHECK_VOCABULARIES)) {
    for (const quote of ['"', "'"]) {
      const needle = `.from(${quote}${table}${quote})`
      let i = src.indexOf(needle)
      while (i !== -1) {
        const rest = src.slice(i + needle.length)
        const nextFrom = rest.search(/\.from\(/)
        const win = nextFrom >= 0 ? rest.slice(0, nextFrom) : rest.slice(0, 1500)

        for (const [column, allowed] of Object.entries(columns)) {
          const ok = new Set(allowed)
          const flag = (value: string, kind: "write" | "filter") => {
            if (!ok.has(value)) out.push({ file, table, column, value, kind })
          }

          // Payload literal: `column: "value"` — ONLY inside the balanced argument of
          // this chain's own .insert/.upsert/.update. Scanning the whole window was
          // wrong: a plain object literal built nearby (a Dotloop API request body, a
          // transaction_milestones row assembled before its own .from()) contributed
          // keys that belong to something else entirely. Three of this guard's first
          // findings were exactly that, so the payload scan is now argument-scoped.
          for (const arg of mutationArgs(win)) {
            for (const pair of topLevelPairs(arg)) {
              if (pair.key === column) flag(pair.value, "write")
            }
          }

          // Filters: .eq("column", "value") / .neq(...)
          const eqRe = new RegExp(`\\.(?:eq|neq)\\(\\s*["']${column}["']\\s*,\\s*["']([^"'\\n]*)["']\\s*\\)`, "g")
          let m: RegExpExecArray | null
          while ((m = eqRe.exec(win))) flag(m[1], "filter")

          // .in("column", ["a", "b"]) — every element.
          const inRe = new RegExp(`\\.in\\(\\s*["']${column}["']\\s*,\\s*\\[([^\\]]*)\\]`, "g")
          while ((m = inRe.exec(win))) {
            for (const lit of m[1].matchAll(/["']([^"'\n]*)["']/g)) flag(lit[1], "filter")
          }

          // .or("column.eq.value,other.eq.x") — PostgREST filter grammar.
          const orRe = /\.or\(\s*["'`]([^"'`\n]*)["'`]/g
          while ((m = orRe.exec(win))) {
            for (const clause of m[1].split(",")) {
              const parts = clause.split(".")
              if (parts.length >= 3 && parts[0] === column && (parts[1] === "eq" || parts[1] === "neq")) {
                flag(parts.slice(2).join("."), "filter")
              }
            }
          }
        }
        i = src.indexOf(needle, i + 1)
      }
    }
  }
  return out
}

const key = (v: VocabViolation) => `${v.file}::${v.table}.${v.column}=${v.value}`

// ── Run ─────────────────────────────────────────────────────────────────────
let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const tableCount = Object.keys(CHECK_VOCABULARIES).length
const columnCount = Object.values(CHECK_VOCABULARIES).reduce((n, c) => n + Object.keys(c).length, 0)

console.log("══════════════════════════════════════════════════")
console.log(" CHECK-vocabulary guard (no literal the database rejects)")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure — the detector]")
check("flags a write literal outside the CHECK set",
  scanCheckVocabulary(`svc.from("agent_onboarding").update({ status: "stalled" })`, "t").length === 1)
check("accepts an admitted write literal",
  scanCheckVocabulary(`svc.from("agent_onboarding").update({ status: "paused" })`, "t").length === 0)
check("flags a FILTER on a value the column can never hold",
  scanCheckVocabulary(`svc.from("agent_onboarding").select("*").eq("status", "stalled")`, "t").length === 1)
check("flags every bad element of an .in() list",
  scanCheckVocabulary(`svc.from("listings").select("*").in("status", ["active", "closed"])`, "t").length === 1)
check("parses PostgREST .or() clauses",
  scanCheckVocabulary(`svc.from("listings").select("*").or("lifecycle_stage.eq.active,status.eq.sold")`, "t").length === 1)
check("accepts the corrected .or()",
  scanCheckVocabulary(`svc.from("listings").select("*").or("lifecycle_stage.eq.MLS_ACTIVE,status.eq.active")`, "t").length === 0)
check("does NOT spill into the next query's payload",
  scanCheckVocabulary(
    `svc.from("agent_onboarding").select("id")\nsvc.from("listings").update({ status: "sold" })`, "t").length === 0)
check("ignores a variable (only literals are checkable)",
  scanCheckVocabulary(`svc.from("agent_onboarding").update({ status: nextStatus })`, "t").length === 0)
check("never reads its own documentation",
  scanCheckVocabulary(`// svc.from("agent_onboarding").eq("status", "stalled")`, "t").length === 0)
check("a payload for ANOTHER table nearby is not attributed to this one",
  scanCheckVocabulary(
    `const rows = milestones.map((m) => ({ milestone_name: m.name, status: "pending" }))\n` +
    `await svc.from("transactions").select("id").eq("id", txId)`, "t").length === 0)
check("but the chain's OWN payload is still scanned",
  scanCheckVocabulary(`svc.from("transactions").insert({ status: "pending" })`, "t").length === 1)
check("a key inside a metadata bag is NOT treated as a column",
  scanCheckVocabulary(
    `svc.from("lifecycle_events").insert({ event_type: "x", metadata: { source: "qr_scan" } })`, "t").length === 0)
check("but the same key AS a column is still flagged",
  scanCheckVocabulary(`svc.from("lifecycle_events").insert({ source: "qr_scan" })`, "t").length === 1)
check("topLevelPairs skips nested objects and arrays",
  topLevelPairs(`{ a: "1", bag: { a: "2" }, list: ["a"], b: "3" }`).map((p) => p.key).join(",") === "a,b")

check("mutationArgs keeps a nested object inside its own payload",
  mutationArgs(`.insert({ a: { b: 1 }, status: "x" })`).length === 1)

check("leaves a column with no CHECK alone",
  scanCheckVocabulary(`svc.from("agent_onboarding").update({ current_day: "12" })`, "t").length === 0)

console.log("\n[repo scan]")
const files: string[] = []
for (const d of ["app", "lib", "services"]) for (const f of walk(join(root, d))) files.push(f)

const found: VocabViolation[] = []
for (const f of files) {
  let src = ""
  try { src = readFileSync(f, "utf8") } catch { continue }
  if (!src.includes(".from(")) continue
  found.push(...scanCheckVocabulary(src, relative(root, f).replace(/\\/g, "/")))
}
console.log(`  · ${files.length} files scanned · ${columnCount} enum columns across ${tableCount} tables`)

const baseline: string[] = existsSync(BASELINE_PATH)
  ? JSON.parse(readFileSync(BASELINE_PATH, "utf8"))
  : []

if (process.env.UPDATE_CHECK_VOCAB_BASELINE === "1") {
  const next = [...new Set(found.map(key))].sort()
  writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n")
  console.log(`  · baseline rewritten with ${next.length} entries`)
  process.exit(0)
}

const baselineSet = new Set(baseline)
const fresh = found.filter((v) => !baselineSet.has(key(v)))
const stillPresent = new Set(found.map(key))
const fixed = baseline.filter((b) => !stillPresent.has(b))

check(`no NEW literal outside a live CHECK vocabulary (${found.length} total, ${baseline.length} baselined)`,
  fresh.length === 0,
  fresh.slice(0, 8).map((v) => `${v.file}: ${v.table}.${v.column} ${v.kind} "${v.value}"`).join("; "))
check(`the baseline only shrinks (${fixed.length} retired this run)`, true)

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" ✗ Failures:")
  for (const f of failures) console.log(`   - ${f}`)
  console.log(" ❌ CHECK_VOCABULARY_FAIL — that value is not in the column's CHECK; the write is lost or the filter matches nothing")
  process.exit(1)
}
console.log(" ✅ CHECK_VOCABULARY_PASS — every literal the code writes or filters on is one the database admits")
