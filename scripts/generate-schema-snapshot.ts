#!/usr/bin/env tsx
/**
 * scripts/generate-schema-snapshot.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Regenerates scripts/schema-snapshot.ts from the LIVE Postgres schema so the schema-drift guard
 * (scripts/schema-drift-guard.ts) column-checks every table the code actually queries. Run after ANY
 * schema change (add/drop/rename a column or table).
 *
 * It is creds-free: you pipe in the live schema as JSON, it does the code scan + file writing. Get the
 * schema JSON by running this SQL (Supabase SQL editor / psql / MCP) and saving the single-row result:
 *
 *   SELECT json_object_agg(table_name, cols) AS schema FROM (
 *     SELECT table_name, json_agg(column_name ORDER BY column_name) AS cols
 *     FROM information_schema.columns WHERE table_schema='public' GROUP BY table_name) t;
 *
 * Then:  cat schema.json | npx tsx scripts/generate-schema-snapshot.ts
 *
 * Accepts either the raw object  { "table": ["col", …], … }  or the wrapped row  [{ "schema": {…} }].
 *
 * What it writes:
 *   • scripts/schema-snapshot.ts                  — column-guarded tables (referenced AND in live schema)
 *   • scripts/schema-drift-unguarded-baseline.json — tables referenced in code but ABSENT from the live
 *     schema (RPC names / phantom tables); the guard ratchets these so a new one can't sneak in.
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const PG_VERB = /^\s*(?:\.\s*)?(select|insert|upsert|update|delete|eq|neq|gt|gte|lt|lte|like|ilike|in|is|or|order|limit|range|match|single|maybeSingle|rpc|contains|filter|not|count)\b/

function walk(dir: string, acc: string[]) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, acc)
    else if (/\.(ts|tsx)$/.test(name)) acc.push(p)
  }
}

/** Tables the code queries via Supabase — `.from("x")` chained to a PostgREST verb (same detector as
 *  the guard's coverage ratchet; excludes Buffer.from/Array.from). */
function referencedTables(root: string): string[] {
  const files: string[] = []
  for (const d of ["app", "lib"]) { try { walk(join(root, d), files) } catch {} }
  const tables = new Set<string>()
  const fromRe = /\.from\(\s*["'`]([a-z_][a-z0-9_]*)["'`]\s*\)/g
  for (const f of files) {
    let src = ""
    try { src = readFileSync(f, "utf8") } catch { continue }
    if (!src.includes(".from(")) continue
    let m: RegExpExecArray | null
    while ((m = fromRe.exec(src))) {
      const after = src.slice(m.index + m[0].length, m.index + m[0].length + 40)
      if (PG_VERB.test(after)) tables.add(m[1])
    }
  }
  return [...tables].sort()
}

/** Pull the { table: [cols] } map out of stdin, tolerating MCP/SQL wrappers. */
export function parseSchemaInput(raw: string): Record<string, string[]> {
  const start = raw.indexOf("{")
  // wrapped row shape: [{ "schema": {…} }] (possibly inside other text) — find the [{ … }] span.
  const arrStart = raw.indexOf("[{")
  if (arrStart >= 0 && (arrStart < start || start < 0)) {
    const arrEnd = raw.lastIndexOf("}]") + 2
    const rows = JSON.parse(raw.slice(arrStart, arrEnd))
    if (rows[0]?.schema) return rows[0].schema
  }
  // raw object shape
  return JSON.parse(raw.slice(start, raw.lastIndexOf("}") + 1))
}

function main() {
  const raw = readFileSync(0, "utf8") // stdin
  if (!raw.trim()) { console.error("Pipe the live-schema JSON in (see header for the SQL)."); process.exit(1) }
  const schema = parseSchemaInput(raw)
  const root = process.cwd()
  const referenced = referencedTables(root)
  const guarded = referenced.filter((t) => (schema[t]?.length ?? 0) > 0).sort()
  const missing = referenced.filter((t) => (schema[t]?.length ?? 0) === 0).sort()

  const today = new Date().toISOString().slice(0, 10)
  let out = `/**
 * scripts/schema-snapshot.ts
 *
 * GENERATED from the live Postgres schema (public) by scripts/generate-schema-snapshot.ts.
 * The schema-drift guard checks the codebase's column references against this snapshot so the
 * "code references a column the table doesn't have → query silently errors" bug class (which broke
 * buyer matching, lead-magnet capture, and the agents-identity selects) can't come back.
 *
 * COVERAGE: every table the code actually queries is column-guarded here — ${guarded.length} tables.
 * Tables referenced in code but absent from the live schema (RPC names / phantom tables) stay on
 * scripts/schema-drift-unguarded-baseline.json.
 *
 * REGENERATE after any schema change (see header for the SQL):
 *   cat schema.json | npx tsx scripts/generate-schema-snapshot.ts
 *
 * Last synced: ${today}.
 */
export const SCHEMA_SNAPSHOT: Record<string, string[]> = {
`
  for (const t of guarded) {
    const cols = schema[t].slice().sort().map((c) => JSON.stringify(c)).join(", ")
    out += `  ${t}: [${cols}],\n`
  }
  out += `}\n`
  writeFileSync(join(root, "scripts/schema-snapshot.ts"), out)
  writeFileSync(join(root, "scripts/schema-drift-unguarded-baseline.json"), JSON.stringify(missing, null, 2) + "\n")
  console.log(`✅ snapshot: ${guarded.length} guarded tables | unguarded baseline: ${missing.length} (referenced but not in live schema)`)
}

main()
