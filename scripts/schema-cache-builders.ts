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
 * ── COMPOSITE FOREIGN KEYS, AND WHY THIS MAP IS NOT TOTAL ───────────────────────────
 * This header used to claim "every foreign key single-column, and no (table, column) pair carrying
 * FKs to two different targets, so the map is total and unambiguous". That was true when written
 * and is FALSE now: ${f.compositeFks} foreign key${f.compositeFks === 1 ? " spans" : "s span"} more than one column.
 * \`live_foreign_keys_json()\` unnests \`conkey\`, so a composite FK arrives once PER COLUMN, and one
 * column can carry a single-column FK to one table AND be part of a composite FK to another.
 *
 * THE LIVE CASE: m497 added
 *     vendor_subscriptions_plan_in_same_brokerage_fkey (plan_id, brokerage_id)
 *         REFERENCES vendor_plans (id, brokerage_id)
 * next to the older single-column \`vendor_subscriptions_brokerage_id_fkey (brokerage_id)
 * REFERENCES brokerages (id)\`. \`vendor_subscriptions.brokerage_id\` therefore has TWO candidate
 * targets. Such a column is left OUT of the map and published in SCHEMA_FK_COLUMN_AMBIGUOUS with
 * all of its candidates — the map holds one target per column and cannot say "two", so it says
 * nothing, which the SAFETY PROPERTY above turns into a skipped embed rather than a wrong answer.
 * ${f.ambiguousColumns} column${f.ambiguousColumns === 1 ? " is" : "s are"} in that state.
 *
 * MEASURED AT GENERATION: ${f.edges} edges across ${f.tables} source tables — one target per
 * (table, column), every ambiguous column excluded and listed separately. ${f.pairs} unordered
 * table pairs carry at least one FK; ${f.ambiguousPairs}
 * carry more than one and are listed below. ${f.selfRefs} of the constraints are self-referential.
 * THE PAIR COUNT COUNTS CONSTRAINTS, NOT COLUMNS: a composite FK is ONE relationship to PostgREST
 * however many columns it spans, so counting its unnested rows separately would flag an
 * unambiguous pair as ambiguous.`
}

/** What the FK scan measured, for the header and the generator's console line. */
export type FkFacts = {
  tables: number
  edges: number
  pairs: number
  ambiguousPairs: number
  selfRefs: number
  /** (table, column) pairs carrying candidate FKs to MORE THAN ONE target — omitted from the
   *  map and published in SCHEMA_FK_COLUMN_AMBIGUOUS instead. See resolveColumnTarget(). */
  ambiguousColumns: number
  /** foreign keys spanning more than one column. Each is emitted once PER COLUMN by the source
   *  RPC, which is the whole reason the two counting rules below exist. */
  compositeFks: number
}

/** PURE — key for the unordered table pair, the encoding fkPairCount() hides from its callers. */
function pairKey(a: string, b: string): string {
  return a <= b ? `${a}|${b}` : `${b}|${a}`
}

/** PURE — identity of a CONSTRAINT, as opposed to one of the rows it produced. Constraint names
 *  are unique per table in Postgres, so (src_table, name) names exactly one foreign key. */
function constraintKey(r: LiveFk): string {
  return `${r.src_table} ${r.name}`
}

/**
 * ── THE RULE FOR A COLUMN CARRYING MORE THAN ONE FOREIGN KEY ────────────────────────
 *
 * `live_foreign_keys_json()` unnests `conkey`, so a COMPOSITE foreign key is emitted once per
 * column. One column can therefore appear with two different targets — it can hold a
 * single-column FK to one table AND be part of a composite FK to another.
 *
 * WORKED EXAMPLE, and the reason this function exists: m497 added
 *     vendor_subscriptions_plan_in_same_brokerage_fkey (plan_id, brokerage_id)
 *         REFERENCES vendor_plans (id, brokerage_id)
 * alongside the pre-existing single-column `vendor_subscriptions_brokerage_id_fkey
 * (brokerage_id) REFERENCES brokerages (id)`. So `vendor_subscriptions.brokerage_id` yields two
 * candidate targets: `brokerages` and `vendor_plans`.
 *
 * THE OLD BEHAVIOUR WAS LAST-WRITE-WINS over rows ordered by (src_table, src_col, name), which
 * silently resolved that column to `vendor_plans` purely because "…plan_in_same_brokerage_fkey"
 * sorts after "…brokerage_id_fkey". A constraint-NAME sort deciding a schema question is not a
 * rule, it is an accident, and it happened to land on the target a reader is least likely to mean.
 *
 * WHAT WE DO INSTEAD: refuse to choose. The column is left OUT of SCHEMA_FK_MAP and published in
 * SCHEMA_FK_COLUMN_AMBIGUOUS with every candidate. This is the direction the file's SAFETY
 * PROPERTY already promises — a missing entry makes the guard SKIP the embed and count it as
 * unresolved, whereas a WRONG entry makes it check the embed's columns against the wrong table,
 * which can fail live code or pass broken code. Absent is recoverable; wrong is not.
 *
 * WHY NOT PREFER THE SINGLE-COLUMN FK? Because that requires knowing how PostgREST resolves a
 * bare column-name embed on such a column, and that could not be VERIFIED from this environment:
 * postgrest.org and supabase.com are blocked by the egress proxy, the project's own REST endpoint
 * is likewise unreachable (CONNECT tunnel 403), and the Supabase docs reachable through the MCP
 * do not document the bare FK-column-name embed target at all — they document `!hint` instead.
 * The day someone can demonstrate the behaviour, the change is small and local: buildFkMap already
 * computes `constraintArity` (for the pair count), so preferring the single-column FK means passing
 * it in here and filtering `candidates` to the lowest arity before the distinct-target test — plus
 * the tests in scripts/schema-cache-drift-guard.ts that pin the current answer. Until then an
 * honest "ambiguous" beats a confident guess, and the guess had already been wrong once.
 */
export function resolveColumnTarget(candidates: LiveFk[]): { target: string | null; targets: string[] } {
  const targets = [...new Set(candidates.map((r) => r.tgt_table))].sort()
  return { target: targets.length === 1 ? targets[0] : null, targets }
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
  ambiguousColumns: Record<string, Record<string, string[]>>
} {
  // How many columns each CONSTRAINT spans — the row count sharing (src_table, name).
  const constraintArity = new Map<string, number>()
  for (const r of rows) constraintArity.set(constraintKey(r), (constraintArity.get(constraintKey(r)) ?? 0) + 1)
  const compositeFks = [...constraintArity.values()].filter((n) => n > 1).length

  // Every candidate row per (table, column), so the rule sees the whole picture rather than
  // whichever row happened to be written last.
  const candidates = new Map<string, Map<string, LiveFk[]>>()
  for (const r of rows) {
    const byCol = candidates.get(r.src_table) ?? candidates.set(r.src_table, new Map()).get(r.src_table)!
    ;(byCol.get(r.src_col) ?? byCol.set(r.src_col, []).get(r.src_col)!).push(r)
  }

  // PAIR CARDINALITY COUNTS CONSTRAINTS, NOT ROWS. PGRST201 fires on the number of distinct
  // RELATIONSHIPS between two tables; a composite FK is ONE relationship however many columns it
  // spans. Counting rows over-counted it and could flag an unambiguous pair as ambiguous.
  const pairConstraints = new Map<string, Set<string>>()
  const selfRefConstraints = new Set<string>()
  for (const r of rows) {
    const k = pairKey(r.src_table, r.tgt_table)
    ;(pairConstraints.get(k) ?? pairConstraints.set(k, new Set()).get(k)!).add(constraintKey(r))
    if (r.src_table === r.tgt_table) selfRefConstraints.add(constraintKey(r))
  }

  const map: Record<string, Record<string, string>> = {}
  const ambiguousColumns: Record<string, Record<string, string[]>> = {}
  for (const [src, byCol] of candidates) {
    for (const [col, rowsForCol] of byCol) {
      const { target, targets } = resolveColumnTarget(rowsForCol)
      if (target !== null) (map[src] ??= {})[col] = target
      else (ambiguousColumns[src] ??= {})[col] = targets
    }
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

  const ambiguousColTables = Object.keys(ambiguousColumns).sort()
  let ambiguousColumnCount = 0
  body += `/** \`SCHEMA_FK_COLUMN_AMBIGUOUS[table][column] = [everyCandidateTarget]\` — the columns
 *  DELIBERATELY ABSENT from SCHEMA_FK_MAP above because they carry foreign keys to more than one
 *  table (a single-column FK plus a composite FK over the same column). The map cannot express
 *  "two answers", so it holds none, and the candidates are published here rather than one of them
 *  being picked silently. A consumer that meets one of these columns must SKIP the embed, not
 *  guess — see resolveColumnTarget() in scripts/schema-cache-builders.ts for why. */
export const SCHEMA_FK_COLUMN_AMBIGUOUS: Record<string, Record<string, string[]>> = {\n`
  for (const t of ambiguousColTables) {
    const cols = Object.keys(ambiguousColumns[t]).sort()
    ambiguousColumnCount += cols.length
    body += `  ${JSON.stringify(t)}: { ${cols.map((c) => `${JSON.stringify(c)}: ${JSON.stringify(ambiguousColumns[t][c])}`).join(", ")} },\n`
  }
  body += `}\n
/** Every candidate target for an FK column that has more than one, or [] when the column is
 *  unambiguous. \`[]\` and a single-target column are both "nothing to disambiguate here". */
export function fkColumnCandidates(table: string, column: string): readonly string[] {
  return SCHEMA_FK_COLUMN_AMBIGUOUS[table]?.[column] ?? []
}\n\n`

  const ambiguous: Record<string, number> = {}
  for (const [k, s] of [...pairConstraints].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    if (s.size > 1) ambiguous[k] = s.size

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
    facts: {
      tables: tables.length,
      edges,
      pairs: pairConstraints.size,
      ambiguousPairs: Object.keys(ambiguous).length,
      selfRefs: selfRefConstraints.size,
      ambiguousColumns: ambiguousColumnCount,
      compositeFks,
    },
    map,
    ambiguous,
    ambiguousColumns,
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
  // A `character varying` column's CHECK is rendered by Postgres with the column
  // CAST and the array cast too — `((col)::text = ANY ((ARRAY[…])::text[]))` — and
  // the bare-identifier shapes above cannot match it. SIX live constraints take this
  // form and FIVE of them had never once been read into the vocabulary cache:
  // closing_disclosure_agreement.status (8 values), conversation_insights'
  // escalation_urgency / overall_sentiment / sentiment_trajectory, messages.sentiment.
  // A vocabulary guard blind to a column's CHECK cannot tell you when the code writes
  // a value the database will refuse — which is the entire job.
  /^CHECK \(\((\w+)\)::text = ANY \(\(ARRAY\[(.*)\]\)::text\[\]\)\)$/,
  /^CHECK \(\((\w+) IS NULL\) OR \(\(\1\)::text = ANY \(ARRAY\[(.*)\]\)\)\)$/,
]
// `::character varying` appears wherever the column is varchar rather than text;
// the VALUE is the same string either way.
const TEXT_LITERAL = /^'((?:[^']|'')*)'::(?:text|character varying)$/

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

// ─────────────────────────────────────────────────────────────────────────────
// 5. THE IDENTITY-CLASS MAP (agents(id) vs users(id) vs contacts(id))
// ─────────────────────────────────────────────────────────────────────────────

/**
 * scripts/agent-fk-columns.ts answers "which id class does this column hold?" — the question
 * SCHEMA_FK_MAP cannot be read for, because that map is keyed for PostgREST embed resolution and
 * scripts/agent-id-class-guard.ts needs the three sets sliced the other way round.
 *
 * IT WAS THE LAST HAND-KEPT CACHE. It carried "snapshotted from the live database" and a block of
 * REGENERATE SQL with no generator behind it — the same shape schema-fk-map.ts had before m485,
 * and it drifted the same way: measured against live on 2026-08-23 it named 6 agents(id) columns
 * the database no longer has, and MISSED 109 tables whose contact_id FKs contacts(id) — a guard
 * blind to 109 of the 165 tables it exists to watch.
 *
 * The rows come from the SAME RPC as the FK map, live_foreign_keys_json(), so the two files cannot
 * disagree about an edge.
 */
export const AGENT_FK_SOURCE = FK_MAP_SOURCE

/**
 * A users(id) FK column is listed only when its NAME could be mistaken for an agents.id — the
 * whole point of the reverse half. The rule is mechanical and published rather than curated:
 * the column name CONTAINS "agent". `created_by` and `uploaded_by` are users ids too and nobody
 * would write an agents.id into them, so listing every users FK would bury the ones that mislead.
 *
 * BLIND SPOT, stated beside the number: a misleading users column whose name does NOT contain
 * "agent" is not listed. `teams.team_lead_id` and `closing_disclosure_agreement.broker_id` are the
 * live examples — both users ids, both plausible places to write the wrong class, neither matched
 * by this rule.
 */
const AGENTISH = /agent/i

/** The three target tables this file describes. Anything else in the FK payload is ignored. */
const IDENTITY_TARGETS = new Set(["agents", "users", "contacts"])

export type AgentFkFacts = {
  agentTables: number
  agentColumns: number
  usersAgentishTables: number
  usersAgentishColumns: number
  contactTables: number
  /** FKs to these three targets that span more than one column — excluded, and counted so a
   *  "0 composite" line is a measurement rather than an unexercised branch going unmentioned. */
  compositeSkipped: number
}

export function agentFkHeader(f: AgentFkFacts): string {
  return `/**
 * scripts/agent-fk-columns.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * WHICH ID CLASS DOES THIS COLUMN HOLD? The schema is split-brain: some columns named agent_id
 * FK agents(id) and others FK users(id) — activities.agent_user_id is a users.id,
 * net_sheet_calculations.agent_id is an agents.id. You cannot tell from the column NAME, which is
 * exactly how wrong-class writes keep shipping, and \`agents.id\` and \`users.id\` are DISJOINT id
 * spaces (23503), not two names for one row. scripts/agent-id-class-guard.ts reads the three maps
 * below; m366 re-pointed 20 columns from users(id) to agents(id) and this map went stale the
 * moment it landed — a stale map makes the guard flag correct writes and, worse, bless wrong ones.
 *
 * Built from the same live reading as scripts/schema-fk-map.ts — ${AGENT_FK_SOURCE} — so the two
 * files cannot disagree about an edge. SINGLE-COLUMN foreign keys only: a composite FK constrains
 * a TUPLE, and no one column in it carries the target's id on its own. ${f.compositeSkipped} composite FK(s)
 * to these three targets were skipped at this reading.
 *
 * This file is a CACHE OF THE LIVE DATABASE, not a second opinion about it. CI holds no database
 * credentials, so without the cache the identity-class guard goes blind — that is the only reason
 * it is committed.
 *
 * MEASURED AT GENERATION: ${f.agentColumns} agents(id) columns across ${f.agentTables} tables, ${f.usersAgentishColumns} agent-ish users(id) columns across ${f.usersAgentishTables} tables, ${f.contactTables} contact_id tables.`
}

/** PURE — a key as an object literal writes it: bare when it is a valid identifier. */
function objKey(k: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : JSON.stringify(k)
}

/**
 * PURE — the whole identity-class file body, from the live FK rows.
 *
 * `rows` may be the full live_foreign_keys_json() payload or a narrowing of it to these three
 * targets: a foreign key has exactly ONE target table, so filtering by target cannot split a
 * constraint and cannot change the per-constraint column count computed here.
 */
export function buildAgentFkColumns(rows: LiveFk[]): {
  body: string
  facts: AgentFkFacts
  /** The same three structures the body encodes, so the drift guard can DIFF rather than only
   *  compare bytes — a byte mismatch says "regenerate", a diff says which column moved. */
  agents: Record<string, string[]>
  usersAgentish: Record<string, string[]>
  contacts: string[]
} {
  const relevant = rows.filter((r) => IDENTITY_TARGETS.has(r.tgt_table))

  // Arity per CONSTRAINT — live_foreign_keys_json() unnests conkey, so a composite FK arrives
  // once per column and is recognised by (src_table, name) appearing more than once.
  const arity = new Map<string, number>()
  for (const r of relevant) arity.set(constraintKey(r), (arity.get(constraintKey(r)) ?? 0) + 1)
  const compositeSkipped = [...arity.values()].filter((n) => n > 1).length
  const single = relevant.filter((r) => arity.get(constraintKey(r)) === 1)

  const agents: Record<string, Set<string>> = {}
  const usersAgentish: Record<string, Set<string>> = {}
  const contactIdTables = new Set<string>()
  for (const r of single) {
    if (r.tgt_table === "agents") (agents[r.src_table] ??= new Set()).add(r.src_col)
    else if (r.tgt_table === "users" && AGENTISH.test(r.src_col))
      (usersAgentish[r.src_table] ??= new Set()).add(r.src_col)
    else if (r.tgt_table === "contacts" && r.src_col === "contact_id") contactIdTables.add(r.src_table)
  }

  const emitMap = (name: string, doc: string, m: Record<string, Set<string>>) => {
    let out = `${doc}\nexport const ${name}: Record<string, string[]> = {\n`
    let columns = 0
    for (const t of Object.keys(m).sort()) {
      const cols = [...m[t]].sort()
      columns += cols.length
      out += `  ${objKey(t)}: [${cols.map((c) => JSON.stringify(c)).join(", ")}],\n`
    }
    out += "}\n"
    return { out, tables: Object.keys(m).length, columns }
  }

  const a = emitMap(
    "AGENT_FK_COLUMNS",
    `/** \`AGENT_FK_COLUMNS[table] = [column, …]\` — every column that FOREIGN KEYs public.agents(id).
 *  Anything else named \`agent_id\` is a different animal; check the map below before assuming. */`,
    agents,
  )
  const u = emitMap(
    "USERS_FK_AGENTISH_COLUMNS",
    `/** \`USERS_FK_AGENTISH_COLUMNS[table] = [column, …]\` — columns that FK public.users(id) whose
 *  NAME contains "agent", so they read as agents(id) and are not. The REVERSE-direction hazard:
 *  writing a resolved agents.id here is as broken as the forward case. \`contacts.source_agent_id\`
 *  is the sharpest — it sits on the same row as \`contacts.agent_id\`, which IS an agents.id.
 *  A misleading users column whose name lacks "agent" (teams.team_lead_id,
 *  closing_disclosure_agreement.broker_id) is deliberately NOT here — see AGENTISH in
 *  scripts/schema-cache-builders.ts. */`,
    usersAgentish,
  )

  const contacts = [...contactIdTables].sort()
  let contactsBlock = `/** Tables whose \`contact_id\` FKs public.contacts(id).
 *  A LEAD is not a CONTACT: writing a lead id here is FK-rejected and the row is silently lost,
 *  because supabase-js RESOLVES a refusal. The repo's correct shape for a lead-era row is
 *  \`contact_id: null, entity_type: "lead", entity_id: <leadId>\`.
 *  Only \`contact_id\` is listed — the other columns that FK contacts (seller_contact_id,
 *  buyer_contact_id, viewer_contact_id, …) name their side and do not read as a lead id. */
export const CONTACT_FK_TABLES: string[] = [\n`
  for (const t of contacts) contactsBlock += `  ${JSON.stringify(t)},\n`
  contactsBlock += "]\n"

  const sorted = (m: Record<string, Set<string>>): Record<string, string[]> =>
    Object.fromEntries(Object.keys(m).sort().map((t) => [t, [...m[t]].sort()]))

  return {
    body: `${a.out}\n${u.out}\n${contactsBlock}`,
    facts: {
      agentTables: a.tables,
      agentColumns: a.columns,
      usersAgentishTables: u.tables,
      usersAgentishColumns: u.columns,
      contactTables: contacts.length,
      compositeSkipped,
    },
    agents: sorted(agents),
    usersAgentish: sorted(usersAgentish),
    contacts,
  }
}
