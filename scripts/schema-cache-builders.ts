/**
 * scripts/schema-cache-builders.ts — the PURE half of the schema cache.
 * ─────────────────────────────────────────────────────────────────────────────
 * Turns a live-database reading into the exact bytes of a committed cache file. The generators
 * call these to WRITE; scripts/schema-cache-drift-guard.ts calls the same functions to REBUILD in
 * memory and compare. One implementation, so the guard can never disagree with the generator about
 * what the file should have said — the way a guard with its own private copy of the rule always
 * eventually does.
 *
 * Nothing here touches the network or the clock. The only I/O is the code scan that decides which
 * tables the snapshot covers, and that reads the repo, not the database.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { runtimeRoots, walkTs } from "./runtime-roots"

/** `{ table: [column, …] }` — the shape of live_schema_json(). */
export type LiveSchema = Record<string, string[]>
/** One single-column foreign key as live_foreign_keys_json() reports it. */
export type LiveFk = { src_table: string; src_col: string; tgt_table: string; name: string }
/** One single-column CHECK constraint as live_check_constraints_json() reports it. */
export type LiveCheck = { table: string; column: string; name: string; def: string }

// ─────────────────────────────────────────────────────────────────────────────
// WHICH TABLES THE SNAPSHOT COVERS
// ─────────────────────────────────────────────────────────────────────────────

const PG_VERB =
  /^\s*(?:\.\s*)?(select|insert|upsert|update|delete|eq|neq|gt|gte|lt|lte|like|ilike|in|is|or|order|limit|range|match|single|maybeSingle|rpc|contains|filter|not|count)\b/

/**
 * Tables the code queries via Supabase — `.from("x")` chained to a PostgREST verb, excluding
 * Buffer.from/Array.from.
 *
 * THE CORPUS IS runtimeRoots(), NOT ["app", "lib"]. scripts/runtime-roots.ts exists because two
 * guards independently hard-coded that pair and went blind to eight other TypeScript directories;
 * the snapshot generator was a third copy of the same mistake, and it cost real coverage. When this
 * generator was first pointed at the live schema it dropped 37 tables the schema-drift guard's own
 * ratchet still counts as referenced — credit_status, journey_blueprints, keywords and user_activity
 * among them, all queried from directories neither name reaches. The generator and the guard must
 * scan the same files or the guard's coverage line is a number about a different repo.
 */
export function referencedTables(root: string): string[] {
  const files = runtimeRoots(root).flatMap((d) => walkTs(join(root, d)))
  const tables = new Set<string>()
  const fromRe = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/g
  for (const f of files) {
    let src = ""
    try {
      src = readFileSync(f, "utf8")
    } catch {
      continue
    }
    if (!src.includes(".from(")) continue
    let m: RegExpExecArray | null
    while ((m = fromRe.exec(src))) {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 40)
      if (PG_VERB.test(after)) tables.add(m[1])
    }
  }
  return [...tables].sort()
}

/**
 * Names that appear as an EMBED TARGET inside a `.select("…")` string — `relation(col, col)`.
 *
 * A table can be named by the code without ever being a `.from()` target: the drift guard resolves
 * a bare embed against SCHEMA_SNAPSHOT's keys, so a live table missing from the snapshot makes the
 * whole embed unresolvable and the guard skips it. `users.select("user_profiles(…)")` is the live
 * instance, and generating strictly from `.from()` would have dropped it.
 *
 * This is a deliberate SUPERSET — every identifier followed by `(` inside a select string. A name
 * that is not a live table is discarded by the caller, so over-collecting costs nothing and
 * under-collecting costs a skipped embed.
 */
export function embeddedTables(root: string): string[] {
  const files = runtimeRoots(root).flatMap((d) => walkTs(join(root, d)))
  const names = new Set<string>()
  const selectRe = /\.select\(\s*(["'`])([\s\S]*?)\1/g
  for (const f of files) {
    let src = ""
    try {
      src = readFileSync(f, "utf8")
    } catch {
      continue
    }
    if (!src.includes(".select(")) continue
    let m: RegExpExecArray | null
    while ((m = selectRe.exec(src))) {
      for (const n of m[2].matchAll(/([a-z_][a-z0-9_]*)\s*\(/g)) names.add(n[1])
    }
  }
  return [...names].sort()
}

/** Every table the code names — as a query target or as an embed target. */
export function namedTables(root: string): string[] {
  return [...new Set([...referencedTables(root), ...embeddedTables(root)])].sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. THE COLUMN SNAPSHOT
// ─────────────────────────────────────────────────────────────────────────────

export const SNAPSHOT_SOURCE = "public.live_schema_json()"

export function snapshotHeader(guardedCount: number): string {
  return `/**
 * scripts/schema-snapshot.ts
 *
 * The column half of the schema cache: \`{ table: [column, …] }\` for every table the code
 * actually queries. The schema-drift guard checks the codebase's column references against it so
 * the "code references a column the table doesn't have → query silently errors" bug class (which
 * broke buyer matching, lead-magnet capture, and the agents-identity selects) can't come back.
 *
 * COVERAGE: ${guardedCount} tables — those the code queries AND the live schema has. Tables
 * referenced in code but ABSENT from the live schema (RPC names / phantom tables) go to
 * scripts/schema-drift-unguarded-baseline.json instead, which the guard ratchets.
 *
 * This file is a CACHE OF THE LIVE DATABASE, not a second opinion about it. CI holds no database
 * credentials, so without the cache every schema guard here goes blind — that is the only reason
 * it is committed.`
}

/**
 * PURE — the snapshot body plus the unguarded baseline.
 *
 * GUARDED: any table the code names — queried or embedded — that the live schema has columns for.
 * UNGUARDED: only names the code QUERIES that the live schema does not have (RPC names, phantom
 * tables). Embed names never enter that list: `embeddedTables()` is a deliberate superset, and a
 * ratchet fed by a superset stops meaning anything.
 */
export function buildSnapshot(
  schema: LiveSchema,
  queried: string[],
  embedded: string[] = [],
): { body: string; guarded: string[]; unguarded: string[] } {
  const named = [...new Set([...queried, ...embedded])].sort()
  const guarded = named.filter((t) => (schema[t]?.length ?? 0) > 0).sort()
  const unguarded = queried.filter((t) => (schema[t]?.length ?? 0) === 0).sort()

  let body = "export const SCHEMA_SNAPSHOT: Record<string, string[]> = {\n"
  for (const t of guarded) {
    const cols = schema[t]
      .slice()
      .sort()
      .map((c) => JSON.stringify(c))
      .join(", ")
    body += `  ${t}: [${cols}],\n`
  }
  body += "}\n"
  return { body, guarded, unguarded }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE FOREIGN-KEY MAP
// ─────────────────────────────────────────────────────────────────────────────

export const FK_MAP_SOURCE = "public.live_foreign_keys_json()"

export function fkMapHeader(f: FkFacts): string {
  return `/**
 * scripts/schema-fk-map.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * The FOREIGN-KEY half of the schema cache — \`SCHEMA_FK_MAP[sourceTable][fkColumn] = targetTable\`.
 *
 * WHY THIS FILE EXISTS
 * scripts/schema-snapshot.ts answers "does table T have column C?". It cannot answer
 * "what table does this PostgREST embed point at?", and that question is the whole
 * reason embedded selects went unchecked for so long. PostgREST lets an embed name its
 * target three ways:
 *
 *     brokerages(name, city)                 — by TABLE name        → resolved by SCHEMA_SNAPSHOT
 *     brokerage_id(name, city)               — by FK COLUMN name    → resolved by THIS map
 *     brokerage:brokerage_id(name, city)     — aliased FK column    → resolved by THIS map
 *
 * Only the first form is resolvable from the column snapshot alone. The other two need
 * the FK graph, so it is committed here rather than read from a live connection: the
 * guard must keep running offline, with no credentials, exactly as it does today.
 *
 * SAFETY PROPERTY
 * A missing or stale entry can only cause the guard to SKIP an embed (reported on the
 * "unresolved embeds" line), never to fail one. Staleness costs coverage, not trust.
 *
 * ── FK CARDINALITY PER TABLE PAIR ───────────────────────────────────────────────────
 * Generated from the same scan, in the same pass, because it answers the question the map
 * cannot: "how many different ways can these two tables be joined?" — which is what produces
 * PostgREST's PGRST201:
 *
 *     "Could not embed because more than one relationship was found for 'contacts' and
 *      'transactions'" — hint: use \`!<constraint>\` to disambiguate
 *
 * \`transactions\` carries THREE foreign keys to \`contacts\` (contact_id, buyer_contact_id,
 * seller_contact_id). A \`.from("contacts").select("transactions(id)")\` names a relation that
 * genuinely exists and columns that genuinely exist, and PostgREST still refuses the WHOLE
 * request — the same silent-dead-read outcome as a phantom column, out of a schema that is
 * entirely valid. Neither SCHEMA_FK_MAP nor SCHEMA_SNAPSHOT can see it: both are keyed by a
 * single table, and ambiguity is a property of the PAIR.
 *
 * THE KEY IS AN UNORDERED PAIR, and that is the whole point. PostgREST resolves an embed by
 * collecting every relationship between the two tables REGARDLESS OF DIRECTION — the M2O side
 * of each FK the parent holds AND the O2M side of each FK the target holds. So
 * \`contacts.select("transactions(…)")\` and \`transactions.select("contacts(…)")\` are ambiguous
 * for the same reason and by the same count. Sorting the two names and joining with "|" makes
 * that symmetry structural instead of something every caller has to remember. \`|\` is safe as a
 * separator: every relname in this schema matches /^[a-z0-9_]+$/.
 *
 * ONLY PAIRS ABOVE ONE ARE STORED. A pair with exactly one FK is unambiguous and is the
 * overwhelming majority (${f.pairs - f.ambiguousPairs} of ${f.pairs} pairs) — storing them would be
 * many times the bytes to encode "nothing to see here". An absent key therefore means "one FK or
 * none", i.e. NOT ambiguous. A self-referential pair (a === b) is stored under "t|t" and is
 * included: two self-FKs on one table are ambiguous exactly like two FKs between different
 * tables. One self-FK is a pair count of 1 and is correctly absent.
 *
 * DELIBERATELY NOT COUNTED — each of these makes the number an UNDER-estimate, never an over-
 * estimate, so the failure mode stays "missed detection" and never "false alarm":
 *   • many-to-many relationships PostgREST infers THROUGH a junction table. Those add further
 *     candidate relationships to a pair, so a pair recorded here as 1 can still be ambiguous.
 *   • foreign keys crossing out of \`public\` (a reference to auth.users cannot be embedded from
 *     the REST surface anyway).
 *
 * MEASURED AT GENERATION: ${f.edges} edges across ${f.tables} source tables — every foreign key
 * single-column, and no (table, column) pair carrying FKs to two different targets, so the map is
 * total and unambiguous. ${f.pairs} unordered table pairs carry at least one FK; ${f.ambiguousPairs}
 * carry more than one and are listed below. ${f.selfRefs} of the edges are self-referential.`
}

/** What the FK scan measured, for the header and the generator's console line. */
export type FkFacts = { tables: number; edges: number; pairs: number; ambiguousPairs: number; selfRefs: number }

/** PURE — key for the unordered table pair, the encoding fkPairCount() hides from its callers. */
function pairKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * PURE — the whole FK file body: the map, the pair cardinality, and the reader over it.
 * Everything is sorted, so the bytes are a function of the schema and nothing else.
 */
export function buildFkMap(rows: LiveFk[]): {
  body: string
  facts: FkFacts
  map: Record<string, Record<string, string>>
  ambiguous: Record<string, number>
} {
  const map: Record<string, Record<string, string>> = {}
  const pairCounts = new Map<string, number>()
  let selfRefs = 0
  for (const r of rows) {
    ;(map[r.src_table] ??= {})[r.src_col] = r.tgt_table
    const k = pairKey(r.src_table, r.tgt_table)
    pairCounts.set(k, (pairCounts.get(k) ?? 0) + 1)
    if (r.src_table === r.tgt_table) selfRefs++
  }

  const tables = Object.keys(map).sort()
  let edges = 0
  let body = `/** \`SCHEMA_FK_MAP[sourceTable][fkColumn] = targetTable\` */\nexport const SCHEMA_FK_MAP: Record<string, Record<string, string>> = {\n`
  for (const t of tables) {
    const cols = Object.keys(map[t]).sort()
    edges += cols.length
    body += `  ${JSON.stringify(t)}: { ${cols.map((c) => `${JSON.stringify(c)}: ${JSON.stringify(map[t][c])}`).join(", ")} },\n`
  }
  body += "}\n\n"

  const ambiguous: Record<string, number> = {}
  for (const [k, n] of [...pairCounts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) if (n > 1) ambiguous[k] = n

  body += `/** \`SCHEMA_FK_PAIR_CARDINALITY["a|b"] = n\` for the SORTED pair (a <= b), n > 1 only.
 *  Read it through fkPairCount() — the key encoding is this file's business, not its callers'. */
export const SCHEMA_FK_PAIR_CARDINALITY: Record<string, number> = {\n`
  for (const [k, n] of Object.entries(ambiguous)) body += `  ${JSON.stringify(k)}: ${n},\n`
  body += `}\n
/** How many distinct foreign keys join these two tables, in EITHER direction.
 *  Returns 1 for any pair not in the table above — see the "only pairs above one are stored"
 *  note: absent means "one FK or none", and both are unambiguous to PostgREST. Argument order
 *  is irrelevant by construction. */
export function fkPairCount(t1: string, t2: string): number {
  const key = t1 <= t2 ? \`\${t1}|\${t2}\` : \`\${t2}|\${t1}\`
  return SCHEMA_FK_PAIR_CARDINALITY[key] ?? 1
}\n`

  return {
    body,
    facts: { tables: tables.length, edges, pairs: pairCounts.size, ambiguousPairs: Object.keys(ambiguous).length, selfRefs },
    map,
    ambiguous,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE CHECK VOCABULARIES
// ─────────────────────────────────────────────────────────────────────────────

export const VOCAB_SOURCE = "public.live_check_constraints_json()"

/**
 * The three shapes a fixed-value CHECK takes once Postgres has normalised it. `IN (…)` is
 * rewritten to `= ANY (ARRAY[…])` by pg_get_constraintdef, so these cover the declared forms too.
 * The nullable variants are included because NULL is not a value — permitting it does not widen
 * the vocabulary — and both operand orders occur live.
 */
const CHECK_SHAPES = [
  /^CHECK \((\w+) = ANY \(ARRAY\[(.*)\]\)\)$/,
  /^CHECK \(\((\w+) IS NULL\) OR \(\1 = ANY \(ARRAY\[(.*)\]\)\)\)$/,
  /^CHECK \(\((\w+) = ANY \(ARRAY\[(.*)\]\)\) OR \(\1 IS NULL\)\)$/,
  // A CHECK that admits exactly ONE value is still a vocabulary, and Postgres writes it as plain
  // equality rather than a one-element ARRAY. Three live constraints take this form; the hand-kept
  // snapshot carried one of them and missed the other two, which is what a rule applied by hand
  // does. ai_identity_profiles.voice_provider is the one that mattered: m354 declares it as
  // `= ANY (ARRAY['elevenlabs'])` and the database still carries m353's `= 'elevenlabs'`, so
  // dropping the shape would have read as "the migration's CHECK is missing entirely".
  /^CHECK \((\w+) = ('(?:[^']|'')*'::text)\)$/,
  /^CHECK \(\((\w+) IS NULL\) OR \(\1 = ('(?:[^']|'')*'::text)\)\)$/,
  /^CHECK \(\((\w+) = ('(?:[^']|'')*'::text)\) OR \(\1 IS NULL\)\)$/,
]
const TEXT_LITERAL = /^'((?:[^']|'')*)'::text$/

/**
 * PURE — the admitted text values of one CHECK definition, or null when the constraint is not a
 * fixed set of text values (a range, a length test, a cross-column rule, or an integer set such as
 * ai_feedback_log.rating's `ANY (ARRAY['-1'::integer, 1])` — a vocabulary of numbers is not a
 * vocabulary of source literals and belongs to no guard here).
 */
export function parseCheckVocabulary(def: string): { column: string; values: string[] } | null {
  // pg_get_constraintdef wraps the whole predicate in one redundant paren pair.
  const inner = /^CHECK \(\((.*)\)\)$/s.exec(def)
  if (!inner) return null
  const normalised = `CHECK (${inner[1]})`

  for (const shape of CHECK_SHAPES) {
    const m = shape.exec(normalised)
    if (!m) continue
    const values: string[] = []
    for (const part of m[2].split(", ")) {
      const lit = TEXT_LITERAL.exec(part.trim())
      if (!lit) return null
      values.push(lit[1].replace(/''/g, "'"))
    }
    return { column: m[1], values: [...new Set(values)].sort() }
  }
  return null
}

export function vocabHeader(tableCount: number, columnCount: number): string {
  return `/**
 * scripts/check-vocabularies.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Every single-column CHECK constraint in public that admits a fixed set of text values,
 * snapshotted so a pure guard can compare source literals against what the database will actually
 * accept. Nullable variants (\`col IS NULL OR col = ANY (…)\`) are included — the NULL case is not
 * a value, so it does not widen the vocabulary. CHECKs over numbers, ranges, lengths or several
 * columns are not vocabularies of source literals and are left out.
 *
 * WHY THIS EXISTS. supabase-js resolves with \`{ error }\` rather than throwing, and most writes
 * here are best-effort, so a literal the CHECK rejects loses the row in silence. Four shipped
 * defects in one sweep came from exactly this: a "stalled" onboarding status the CHECK forbids
 * (a permanently-zero metric), "watch"/"warning" fatigue levels (the whole middle band of scores
 * vanished), a "fatigue_critical" alert type (critical alerts rendered as warnings), and a listing
 * sweep filtering lifecycle_stage="active" and status="closed" — neither of which exists — so it
 * matched zero rows on every run since it shipped.
 *
 * MEASURED AT GENERATION: ${tableCount} tables, ${columnCount} columns.`
}

/**
 * PURE — the vocabulary body, from the live single-column CHECK constraints.
 *
 * `unparsed` lists constraints that LOOK like fixed-value sets but did not parse, and `conflicts`
 * lists any (table, column) carrying two of them. Both are empty against the schema as measured;
 * they are returned rather than swallowed because a silent drop is how a cache starts lying.
 */
export function buildVocabularies(checks: LiveCheck[]): {
  body: string
  tables: number
  columns: number
  map: Record<string, Record<string, string[]>>
  unparsed: string[]
  conflicts: string[]
} {
  const map: Record<string, Record<string, string[]>> = {}
  const unparsed: string[] = []
  const conflicts: string[] = []
  for (const c of checks) {
    const parsed = parseCheckVocabulary(c.def)
    if (!parsed || parsed.column !== c.column) {
      // A TEXT ANY-array we could not read is a coverage hole worth naming. Anything else
      // (ranges, lengths, cross-column rules, and integer sets such as `ANY (ARRAY['-1'::integer,
      // 1])` — where the quoting is Postgres's, not a string) is simply not a vocabulary.
      if (/= ANY \(ARRAY\[/.test(c.def) && /'::text/.test(c.def)) {
        unparsed.push(`${c.table}.${c.column} (${c.name}): ${c.def}`)
      }
      continue
    }
    if (map[c.table]?.[c.column]) conflicts.push(`${c.table}.${c.column} — a second CHECK: ${c.name}`)
    ;(map[c.table] ??= {})[c.column] = parsed.values
  }

  let columns = 0
  let body = "export const CHECK_VOCABULARIES: Record<string, Record<string, string[]>> = {\n"
  for (const t of Object.keys(map).sort()) {
    body += `  ${t}: {\n`
    for (const col of Object.keys(map[t]).sort()) {
      columns++
      body += `    ${col}: [${map[t][col].map((v) => JSON.stringify(v)).join(", ")}],\n`
    }
    body += "  },\n"
  }
  body += "}\n"
  return { body, tables: Object.keys(map).length, columns, map, unparsed, conflicts }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. THE LIVE RELATION LIST
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Same read as the column snapshot, kept deliberately: SCHEMA_SNAPSHOT is `referenced ∩ live`, so
 * its key set answers "is this table live?" in ONE direction only — present proves live, absent
 * proves nothing. Every guard that read absence as "retired" was guessing, and one of them
 * (legacy-tables-retired) guessed wrong about long_form_videos, which is live and queried nowhere.
 * This is the other half of the same reading, thrown away until now.
 */
export const LIVE_TABLES_SOURCE = SNAPSHOT_SOURCE

export function liveTablesHeader(count: number): string {
  return `/**
 * scripts/live-tables.ts
 *
 * EVERY relation the live public schema exposes — ${count} of them — as a flat sorted list.
 *
 * This is the oracle for "does this name exist in the database", which SCHEMA_SNAPSHOT cannot be:
 * that file holds only the tables the code QUERIES and the database HAS (\`referenced ∩ live\`), so a
 * live table nothing queries is simply missing from it. Reading that absence as "dropped" is what
 * made scripts/legacy-tables-retired-simulator.ts classify long_form_videos — live, unqueried —
 * as retired.
 *
 * TABLES AND VIEWS ALIKE. It is built from information_schema.columns, which does not separate
 * them, and the question every reader asks is whether a name still resolves to something
 * queryable. A table replaced by a view of the same name has not been retired.
 *
 * This file is a CACHE OF THE LIVE DATABASE, not a second opinion about it. CI holds no database
 * credentials, so without the cache every schema guard here goes blind — that is the only reason
 * it is committed.`
}

/** PURE — the relation list, sorted, from the same live schema reading the snapshot is built on. */
export function buildLiveTables(schema: LiveSchema): { body: string; tables: string[] } {
  const tables = Object.keys(schema).sort()
  let body = "export const LIVE_TABLES: readonly string[] = [\n"
  for (const t of tables) body += `  ${JSON.stringify(t)},\n`
  body += "]\n"
  return { body, tables }
}
