#!/usr/bin/env tsx
/**
 * scripts/demo-seed-vocabulary-simulator.ts   (npm run test:demo-seed-vocabulary) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DEMO TENANT COULD NOT SEED ITSELF.
 *
 * seedDemoData inserts seven row sets in FK-safe order and bails on the first
 * error:
 *
 *   for (const [table, rows] of inserts) {
 *     const { error } = await svc.from(table).insert(rows as never)
 *     if (error) return { ok: false, error: `Seed failed on ${table}: ${error.message}` }
 *   }
 *
 * `contacts` first, then `leads`. Six literals in that plan were outside their
 * columns' live CHECK vocabularies:
 *
 *   leads.urgency_level     'high' | 'medium' | 'low'   →  cold | cool | hot | warm
 *   leads.lifecycle_state   'new' | 'converted'         →  raw … representation
 *   listings.property_type  'townhome'                  →  townhouse
 *
 * Verified live: a lead with urgency_level='high', lifecycle_state='new' raises
 * check_violation; the corrected row inserts. Same for 'townhome' vs 'townhouse'.
 * So every demo brokerage seeded contacts, died on leads, and left the tenant
 * half-populated — contacts present, no leads, no listings, no transactions, no
 * conversations, no messages, no activities. The failure was returned honestly by
 * seedDemoData; nothing downstream had ever exercised it.
 *
 * WHY THE VOCABULARY GUARD MISSED IT. scripts/check-vocabulary-guard.ts resolves a
 * literal's owning table from the nearest preceding `.from("<table>")`. This
 * seeder writes `svc.from(table).insert(rows)` with the table name in a variable
 * and the row literals declared a hundred lines earlier, so there is no `.from(`
 * to resolve against and the whole file is invisible to it. That is a real blind
 * spot in the scanner, not a bug in this file — and this guard is the answer for
 * this seeder: it maps each `const <name> = [...]` block in the plan to its table
 * by name and checks every string literal against the generated snapshot.
 */
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CHECK_VOCABULARIES } from "./check-vocabularies"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const SEEDER = "lib/platform/demo-tenant.ts"

/** The plan arrays, and the table each one is inserted into by seedDemoData. */
export const PLAN_BLOCKS = [
  "contacts",
  "leads",
  "listings",
  "transactions",
  "conversations",
  "messages",
  "activities",
] as const

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}

/** PURE — slice the balanced [...] that follows `const <name> = [`. */
export function arrayBlock(src: string, name: string): string {
  const at = src.indexOf(`const ${name} = [`)
  if (at === -1) return ""
  const open = src.indexOf("[", at)
  let depth = 0
  for (let j = open; j < src.length; j++) {
    if (src[j] === "[") depth++
    else if (src[j] === "]") { depth--; if (depth === 0) return src.slice(open, j + 1) }
  }
  return ""
}

/** PURE — `key: "value"` pairs in a block whose key is an enum column of `table`. */
export function vocabularyViolations(
  block: string,
  table: string,
  vocabularies: Record<string, Record<string, string[]>>,
): string[] {
  const vocab = vocabularies[table] ?? {}
  const out = new Set<string>()
  for (const m of block.matchAll(/(\w+):\s*"([^"]*)"/g)) {
    const [, col, val] = m
    const allowed = vocab[col]
    if (!allowed) continue
    if (!allowed.includes(val)) out.add(`${table}.${col}="${val}"`)
  }
  return [...out].sort()
}

console.log("\n[pure — the block slicer and the checker]")
{
  const fixture = `const rows = [\n  { a: [1, 2], status: "bogus" },\n]\nconst other = [ { status: "open" } ]`
  const block = arrayBlock(fixture, "rows")
  check("slices past a nested array without ending early", block.includes(`status: "bogus"`))
  check("does not swallow the next declaration", !block.includes(`status: "open"`))
  check("returns empty for a name that is not there", arrayBlock(fixture, "nope") === "")

  const vocabs = { t: { status: ["open", "closed"] } }
  check("flags a literal outside the vocabulary",
    vocabularyViolations(`{ status: "bogus" }`, "t", vocabs)[0] === `t.status="bogus"`)
  check("accepts one inside it",
    vocabularyViolations(`{ status: "open" }`, "t", vocabs).length === 0)
  check("ignores a column with no CHECK",
    vocabularyViolations(`{ notes: "anything at all" }`, "t", vocabs).length === 0)
  check("reports each distinct violation once",
    vocabularyViolations(`{ status: "bogus" }, { status: "bogus" }`, "t", vocabs).length === 1)
}

console.log("\n[the seeder still has the shape this guard assumes]")
{
  const src = readFileSync(join(root, SEEDER), "utf8")
  check("seedDemoData still inserts with a variable table name",
    /svc\.from\(table\)\.insert\(rows as never\)/.test(src))
  check("it still bails on the first failing table",
    /Seed failed on \$\{table\}/.test(src))
  for (const name of PLAN_BLOCKS) {
    check(`the '${name}' plan block is still found by name`, arrayBlock(src, name).length > 0)
  }
}

console.log("\n[every demo row matches its column's live CHECK]")
{
  const src = readFileSync(join(root, SEEDER), "utf8")
  let total = 0
  for (const table of PLAN_BLOCKS) {
    const v = vocabularyViolations(arrayBlock(src, table), table, CHECK_VOCABULARIES)
    total += v.length
    check(`${table} — 0 literals outside the vocabulary${v.length ? ` (${v.join(", ")})` : ""}`,
      v.length === 0)
  }
  check(`the demo tenant can seed all ${PLAN_BLOCKS.length} tables (${total} violations)`, total === 0)

  // The six that were actually there. Named so a revert is unmistakable.
  check("leads.urgency_level no longer uses the high/medium/low scale",
    !/urgency_level: "(high|medium|low)"/.test(arrayBlock(src, "leads")))
  check("leads.lifecycle_state no longer uses 'new' or 'converted'",
    !/lifecycle_state: "(new|converted)"/.test(arrayBlock(src, "leads")))
  check("listings.property_type spells townhouse the way the CHECK does",
    !/property_type: "townhome"/.test(arrayBlock(src, "listings")))
}

console.log("\n──────────────────────────────────────────────────")
if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ DEMO_SEED_VOCABULARY_FAIL"); process.exit(1) }
console.log(" ✅ DEMO_SEED_VOCABULARY_PASS — the demo tenant can seed every table it claims to")
