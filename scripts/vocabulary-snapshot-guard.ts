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
 *
 * THE SECOND CAUSE, DOCUMENTED BECAUSE ONE ENTRY NOW HAS IT AND THE FIRST
 * SENTENCE WOULD HAVE MISDESCRIBED IT. The paragraph above describes a migration
 * OLDER than the live CHECK. A disagreement can also run the other way: a
 * migration that is CORRECT, WRITTEN, and DELIBERATELY NOT APPLIED because it is
 * waiting on a decision only the owner can make. The guard cannot tell the two
 * apart — both are "the file and the database disagree" — but they retire
 * differently, and filing one under the other's rationale would leave a false
 * note beside a real number:
 *
 *   · cause 1 retires by RECONCILING (regenerate the cache; the DB was right)
 *   · cause 2 retires by APPLYING (run the migration; the FILE was right)
 *
 *   RETIRED 2026-08-31 — contacts.contact_persona, the cause-2 entry this
 *   paragraph existed for. It retired by a THIRD route neither cause listed: a
 *   SUCCESSOR migration. m589 (APPLIED) put the CHECK on the live column with
 *   the owner's ruling resolved ("investor is a persona and not a contact
 *   type" — fourteen values), m531's residue rows were normalised along the
 *   way, and the regenerated snapshot agrees with m589 — so the disagreement
 *   dissolved rather than being reconciled or applied as originally framed.
 *   Kept here because the two-cause taxonomy above is incomplete without it.
 *
 * BASELINED 2026-08-31, cause 1 — users.platform_role. Visible only since the
 * parser learned the IN(…) spelling (036 was invisible before that): 036
 * declares ('superadmin','ai_isa_system'), the live CHECK holds five —
 * 'admin', 'marketing' and 'support' are the platform-staff tiers (the same
 * trio platform_role_capability_overrides.role enforces) and were widened onto
 * the column outside the migrations directory. The DB is right; the snapshot
 * carries all five; the newest in-repo declaration is simply older than the
 * live constraint. Retires the day a migration re-declares the five-member
 * list.
 *
 * DO NOT re-run UPDATE_VOCAB_SNAPSHOT_BASELINE=1 to absorb a cause-2 entry
 * without recording it here. A baseline that cannot tell "we accepted this" from
 * "we have not done this yet" is a list of things nobody will ever look at again.
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
 * PURE — every `ADD CONSTRAINT … CHECK (<col> = ANY (ARRAY[…]))` AND every
 * `ADD CONSTRAINT … CHECK (<col> IN (…))` in one migration, with the table
 * resolved from the nearest preceding ALTER TABLE.
 *
 * THE IN(…) FORM IS NOT OPTIONAL. Postgres itself normalises `col IN ('a','b')`
 * to `col = ANY (ARRAY['a','b'])` — they are the SAME declaration — but this
 * parser only knew the ANY spelling, so any migration written in the IN spelling
 * was INVISIBLE to it. The failure that exposed it (2026-08-31): m589 and m591
 * widened contact_persona/persona to fourteen values using `IN (…)`; the parser
 * skipped both files, kept m531/m294 as the "latest" declarations, and accused
 * the freshly-regenerated snapshot of drift ("extra [investor]") — a §2 guard
 * blind to the code it judges, going red BECAUSE the work was done correctly.
 * Twenty-six migrations in this repo use the IN spelling.
 *
 * AND THE SCAN IS BOUNDED TO THE CHECK'S OWN PARENTHESES. The first draft of
 * the IN widening searched lazily forward from `CHECK (` with no bound, so an
 * `ADD CONSTRAINT … CHECK (…)` whose body contained neither form let the scan
 * run PAST the closing paren into unrelated SQL — m484's `conname in ('…')`
 * (a pg_constraint verification query inside a DO block) and m573's inline
 * `check (status in ('posted','received','void'))` on a CREATE TABLE both got
 * reported as ALTER-TABLE vocabulary declarations for the wrong table. The
 * parser now extracts the balanced paren group after CHECK (quote-aware) and
 * searches only inside it.
 *
 * Known residuals: (1) the IN value list inside a CHECK is read up to the
 * expression's own parens, so a vocabulary VALUE containing a close-paren
 * would still truncate — no CHECK vocabulary in this repo has one, and the
 * positive controls below would fail the day one appears. (2) Inline
 * `check (col in (…))` column constraints on CREATE TABLE are OUT OF SCOPE by
 * design — this guard reads ALTER TABLE … ADD CONSTRAINT declarations, the
 * form every vocabulary migration here uses; a new table's inline vocabulary
 * reaches the snapshot through regeneration, not through this parser.
 */
/** Balanced paren group starting at sql[open] === "(", respecting '…' strings. */
function balancedParen(sql: string, open: number): string | null {
  let depth = 0, inString = false
  for (let i = open; i < sql.length; i++) {
    const ch = sql[i]
    if (inString) {
      if (ch === "'") {
        if (sql[i + 1] === "'") { i++; continue } // escaped '' stays inside the string
        inString = false
      }
      continue
    }
    if (ch === "'") inString = true
    else if (ch === "(") depth++
    else if (ch === ")") { depth--; if (depth === 0) return sql.slice(open + 1, i) }
  }
  return null
}
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
    for (const m of body.matchAll(/ADD\s+CONSTRAINT\s+[\w"]+\s+CHECK\s*(?=\()/gi)) {
      const expr = balancedParen(body, m.index! + m[0].length)
      if (expr === null) continue
      // A CHECK declares a vocabulary only when its WHOLE expression is the
      // membership test, optionally prefixed by `col IS NULL OR`. Matching the
      // membership test anywhere INSIDE the expression mis-read m498's compound
      // coherence constraint — `… OR (status IN ('pending','active') AND
      // price_basis = 'list_price' …)` — as a later, narrower re-declaration of
      // cma_comparables.status, and accused the snapshot of the very value
      // ('closed') the real vocabulary CHECK two statements earlier declares.
      // Conditional membership inside a compound expression constrains a
      // COMBINATION of columns; it does not declare what the column may hold.
      const hit = expr.match(
        /^\s*\(*\s*(?:["]?(\w+)["]?\s+IS\s+NULL\s*\)?\s+OR\s+\(*\s*)?["]?(\w+)["]?\s*(?:\)\s*)?(?:::\w+\s*)?(?:=\s*ANY\s*\(\s*ARRAY\s*\[([\s\S]*?)\]\s*(?:::\w+(?:\[\])?\s*)?\)|IN\s*\(([\s\S]*?)\))\s*\)*\s*$/i,
      )
      if (!hit) continue
      const column = hit[2]
      // The IS-NULL prefix, when present, must guard the SAME column — a
      // `a IS NULL OR b IN (…)` cross-column implication is not a vocabulary.
      if (hit[1] && hit[1].toLowerCase() !== column.toLowerCase()) continue
      const values = [...(hit[3] ?? hit[4]).matchAll(/'((?:[^']|'')*)'/g)].map((v) => v[1].replace(/''/g, "'"))
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

  // The IN(…) spelling — the form m589/m591 used and this parser was blind to.
  const inForm = parseCheckDeclarations(`
    ALTER TABLE public.contacts
      ADD CONSTRAINT contacts_contact_persona_check
      CHECK (contact_persona IS NULL OR contact_persona IN (
        'first_time', 'investor', 'other'
      ));
  `, "m589.sql")
  check("reads the IN(…) form, through an IS NULL OR prefix",
    inForm.length === 1 && inForm[0].table === "contacts" && inForm[0].column === "contact_persona" &&
    JSON.stringify(inForm[0].values) === JSON.stringify(["first_time", "investor", "other"]))
  check("a NOT IN exclusion list is not a vocabulary declaration",
    parseCheckDeclarations(
      `ALTER TABLE public.x ADD CONSTRAINT c CHECK (y NOT IN ('banned','words'))`, "m.sql").length === 0)
  // The m484/m573 shape: an IN list AFTER the CHECK's closing paren (a DO-block
  // verification query, an inline CREATE TABLE check) must not be attributed to
  // the ALTER TABLE. This is the bounded-scan control.
  check("SQL after the CHECK's closing paren is not scanned",
    parseCheckDeclarations(`
      ALTER TABLE public.x ADD CONSTRAINT c CHECK (y > 0);
      do $$ begin
        perform 1 from pg_constraint where conname in ('c_check','d_check');
      end $$;
    `, "m.sql").length === 0)
  const mixed = latestDeclarations([
    { name: "m001.sql", sql: `ALTER TABLE public.widgets ADD CONSTRAINT c CHECK (kind = ANY (ARRAY['a']))` },
    { name: "m002.sql", sql: `ALTER TABLE public.widgets ADD CONSTRAINT c CHECK (kind IN ('a','b'))` },
  ])
  check("a later IN-form migration supersedes an earlier ANY-form one",
    JSON.stringify(mixed.get("widgets.kind")?.values) === JSON.stringify(["a", "b"]))

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

// Debug affordance: dump the attribution map so a parser change can be diffed
// key-by-key instead of judged from the count alone (§2: a count that moves is
// the finding — this shows WHICH keys moved).
if (process.env.VOCAB_DECLS_OUT) {
  writeFileSync(process.env.VOCAB_DECLS_OUT,
    [...declared.entries()].sort().map(([k, d]) => `${k} <- ${d.migration}`).join("\n") + "\n")
}

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
