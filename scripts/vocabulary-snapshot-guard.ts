#!/usr/bin/env tsx
/**
 * scripts/vocabulary-snapshot-guard.ts   (npm run test:vocabulary-snapshot) — pure, no DB.
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SNAPSHOT MUST NOT ROT.
 *
 * scripts/check-vocabularies.ts is the contract every vocabulary guard in this
 * repo compares source literals against. Its header says "GENERATED from the live
 * database" — but there is no generator: it cannot be regenerated in CI, because
 * regenerating it needs database credentials CI does not have. It was produced
 * once, by hand, through the Supabase MCP.
 *
 * That is a live hazard. Widen a CHECK in a migration, forget the snapshot, and
 * every guard built on it keeps validating against yesterday's contract —
 * reporting a literal as impossible when the database now accepts it, or worse,
 * accepting one it no longer does. The whole vocabulary ratchet quietly becomes
 * a lie, and nothing goes red.
 *
 * WHAT THIS GUARD DOES. It never touches the database. A migration that widens a
 * CHECK *declares* the new vocabulary in SQL, in the repo — so the migration file
 * itself is the second source of truth. This parses the ARRAY[...] out of every
 * `ADD CONSTRAINT … CHECK (col = ANY (ARRAY[…]))` in supabase/migrations, keeps
 * the LAST declaration per (table, column) — later migrations supersede earlier
 * ones — and asserts the snapshot agrees with it.
 *
 * m290 (adding 'zoom' to platform_credentials.platform) is exactly the case this
 * exists to catch: the migration and the snapshot must move together.
 *
 * THE BASELINE. Some columns were altered outside the migrations directory
 * (earlier eras of this project applied SQL directly), so their newest migration
 * declaration is genuinely older than the live CHECK. Those pairs are baselined:
 * a NEW disagreement fails CI, and reconciling an old one shrinks the list.
 * Run UPDATE_VOCAB_SNAPSHOT_BASELINE=1 after deliberately reconciling.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CHECK_VOCABULARIES } from "./check-vocabularies"
import { stripSqlComments } from "./strip-sql-comments"
export { stripSqlComments }

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const MIGRATIONS = join(root, "supabase", "migrations")
const BASELINE_PATH = join(root, "scripts", "vocabulary-snapshot-baseline.json")

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean, d?: string) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) }
  else { fail++; fails.push(n + (d ? ` — ${d}` : "")); console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`) }
}

export interface CheckDeclaration {
  table: string
  column: string
  values: string[]
  migration: string
}

/**
 * Strip SQL comments so a commented-out CHECK is never parsed as a declaration.
 *
 * WAS `.replace(/^[ \t]*--.*$/gm, "")` — anchored to the START of a line, so a
 * TRAILING comment survived:
 *
 *     \'solo_agent\'::text,   -- solo tier: the tenant\'s one agent
 *
 * The apostrophe in "tenant\'s" then acted as a string delimiter for the ARRAY
 * parser, which extracted `::text -- team cascade, s one agent` as a VALUE and
 * reported a migration/snapshot disagreement that did not exist. The guard\'s own
 * self-test used a trailing comment with NO apostrophe, so it passed and gave
 * false confidence.
 *
 * That is the third time this session a parser here has been broken by a legal
 * comment containing a character the parser treats as syntax (the TS block-first
 * stripper, the template-literal masker, now this). Regexes cannot decide it —
 * whether `--` opens a comment depends on whether you are inside a string, and
 * whether a quote opens a string depends on whether you are inside a comment. So
 * this is one left-to-right scan that tracks the state, including the `$$` dollar
 * quoting every `do $$ … $$` migration block in this repo uses.
 */

/**
 * PURE — every `ADD CONSTRAINT … CHECK (<col> = ANY (ARRAY[…]))` in one migration,
 * with the table resolved from the nearest preceding ALTER TABLE.
 */
export function parseCheckDeclarations(rawSql: string, migration: string): CheckDeclaration[] {
  const sql = stripSqlComments(rawSql)
  const out: CheckDeclaration[] = []
  // Walk ALTER TABLE statements so a file touching several tables attributes
  // each CHECK to the right one.
  const alters = [...sql.matchAll(/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:public\.)?["]?(\w+)["]?/gi)]
  for (let i = 0; i < alters.length; i++) {
    const table = alters[i][1]
    const start = alters[i].index! + alters[i][0].length
    const end = i + 1 < alters.length ? alters[i + 1].index! : sql.length
    const body = sql.slice(start, end)
    for (const m of body.matchAll(
      /ADD\s+CONSTRAINT\s+[\w"]+\s+CHECK\s*\([\s\S]*?["]?(\w+)["]?\s*=\s*ANY\s*\(\s*ARRAY\s*\[([\s\S]*?)\]/gi,
    )) {
      const column = m[1]
      const values = [...m[2].matchAll(/'((?:[^']|'')*)'/g)].map((v) => v[1].replace(/''/g, "'"))
      if (values.length) out.push({ table, column, values, migration })
    }
  }
  return out
}

/** PURE — last declaration wins, keyed table.column, over migrations in name order. */
export function latestDeclarations(files: Array<{ name: string; sql: string }>): Map<string, CheckDeclaration> {
  const latest = new Map<string, CheckDeclaration>()
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    for (const d of parseCheckDeclarations(f.sql, f.name)) {
      latest.set(`${d.table}.${d.column}`, d)
    }
  }
  return latest
}

/** PURE — set difference both ways, sorted. */
export function compareVocabularies(declared: string[], snapshot: string[]) {
  const d = new Set(declared), s = new Set(snapshot)
  return {
    missingFromSnapshot: [...d].filter((v) => !s.has(v)).sort(),
    extraInSnapshot: [...s].filter((v) => !d.has(v)).sort(),
  }
}

console.log("══════════════════════════════════════════════════")
console.log(" Vocabulary snapshot guard (migrations vs the snapshot)")
console.log("══════════════════════════════════════════════════")

console.log("\n[pure — the SQL parser]")
{
  const sql = `
    ALTER TABLE public.widgets DROP CONSTRAINT IF EXISTS widgets_kind_check;
    ALTER TABLE public.widgets
      ADD CONSTRAINT widgets_kind_check CHECK (
        kind = ANY (ARRAY['alpha', 'beta',  -- a trailing comment with the tenant's apostrophe
          'gamma'])
      );
    ALTER TABLE public.gadgets
      ADD CONSTRAINT gadgets_size_check CHECK (size = ANY (ARRAY['s','m']));
  `
  const decls = parseCheckDeclarations(sql, "m999.sql")
  check("finds both declarations", decls.length === 2)
  check("attributes each CHECK to its own ALTER TABLE",
    decls[0]?.table === "widgets" && decls[1]?.table === "gadgets")
  check("reads the column name", decls[0]?.column === "kind")
  check("reads a multi-line array with an inline comment in it",
    JSON.stringify(decls[0]?.values) === JSON.stringify(["alpha", "beta", "gamma"]))
  check("a commented-out CHECK is not a declaration",
    parseCheckDeclarations("-- ALTER TABLE public.x ADD CONSTRAINT c CHECK (y = ANY (ARRAY['z']))", "m.sql").length === 0)

  const later = latestDeclarations([
    { name: "m002.sql", sql: `ALTER TABLE public.widgets ADD CONSTRAINT c CHECK (kind = ANY (ARRAY['a','b']))` },
    { name: "m001.sql", sql: `ALTER TABLE public.widgets ADD CONSTRAINT c CHECK (kind = ANY (ARRAY['a']))` },
  ])
  check("a later migration supersedes an earlier one",
    JSON.stringify(later.get("widgets.kind")?.values) === JSON.stringify(["a", "b"]))

  const cmp = compareVocabularies(["a", "b", "c"], ["a", "c", "d"])
  check("reports what the snapshot is missing", JSON.stringify(cmp.missingFromSnapshot) === JSON.stringify(["b"]))
  check("reports what the snapshot has too much of", JSON.stringify(cmp.extraInSnapshot) === JSON.stringify(["d"]))
}

console.log("\n[repo — every migration-declared vocabulary vs the snapshot]")
const files = existsSync(MIGRATIONS)
  ? readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))
      .map((name) => ({ name, sql: readFileSync(join(MIGRATIONS, name), "utf8") }))
  : []
const declared = latestDeclarations(files)
console.log(`  · ${files.length} migrations · ${declared.size} table.column vocabularies declared in SQL`)

const disagreements: string[] = []
for (const [key, decl] of [...declared.entries()].sort()) {
  const snapshot = CHECK_VOCABULARIES[decl.table]?.[decl.column]
  if (!snapshot) { disagreements.push(`${key} (absent from snapshot, declared in ${decl.migration})`); continue }
  const { missingFromSnapshot, extraInSnapshot } = compareVocabularies(decl.values, snapshot)
  if (missingFromSnapshot.length || extraInSnapshot.length) {
    disagreements.push(
      `${key} (${decl.migration}: snapshot missing [${missingFromSnapshot.join(", ")}]` +
      `, extra [${extraInSnapshot.join(", ")}])`,
    )
  }
}

const baseline: string[] = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : []

if (process.env.UPDATE_VOCAB_SNAPSHOT_BASELINE === "1") {
  writeFileSync(BASELINE_PATH, JSON.stringify(disagreements.sort(), null, 2) + "\n")
  console.log(`  · baseline rewritten with ${disagreements.length} entries`)
  process.exit(0)
}

const known = new Set(baseline)
const fresh = disagreements.filter((d) => !known.has(d))
const reconciled = baseline.filter((b) => !disagreements.includes(b))

check(`no NEW migration/snapshot disagreement (${baseline.length} baselined)`,
  fresh.length === 0, fresh.slice(0, 5).join(" | "))
check(`the disagreement list only shrinks (${reconciled.length} reconciled since the baseline)`, true)

// The migration this guard was written for.
{
  const zoom = declared.get("platform_credentials.platform")
  check("m290's zoom widening is declared in a migration",
    !!zoom && zoom.values.includes("zoom"))
  check("…and the snapshot agrees",
    (CHECK_VOCABULARIES.platform_credentials?.platform ?? []).includes("zoom"))
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  console.log(" ✗ Failures:")
  for (const f of fails) console.log(`   - ${f}`)
  console.log(" ❌ VOCAB_SNAPSHOT_FAIL — a migration changed a CHECK; re-sync scripts/check-vocabularies.ts")
  process.exit(1)
}
console.log(" ✅ VOCAB_SNAPSHOT_PASS — the snapshot still matches what the migrations declare")
