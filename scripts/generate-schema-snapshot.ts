#!/usr/bin/env tsx
/**
 * scripts/generate-schema-snapshot.ts   (npm run schema:regen:snapshot)
 * ─────────────────────────────────────────────────────────────────────────────
 * Writes scripts/schema-snapshot.ts and scripts/schema-drift-unguarded-baseline.json FROM THE LIVE
 * DATABASE. Run after any schema change; run it rather than editing either file, which is what the
 * provenance stamp is there to enforce.
 *
 * TWO WAYS IN, ONE OF THEM PREFERRED:
 *   • CREDENTIALED (default): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, read through the
 *     service-role-only public.live_schema_json() RPC. information_schema is not reachable through
 *     PostgREST — supabase-js `.from()` only sees exposed schemas — so the RPC is the whole door.
 *   • PIPED (fallback): the same JSON on stdin. This is how the snapshot was built before the RPC
 *     existed, and it is how scripts/check-live-schema-drift.ts feeds this generator, so it stays.
 *     Stdin wins when both are available, because a caller who piped meant it.
 *
 *       SELECT json_object_agg(table_name, cols) AS schema FROM (
 *         SELECT table_name, json_agg(column_name ORDER BY column_name) AS cols
 *         FROM information_schema.columns WHERE table_schema='public' GROUP BY table_name) t;
 *
 * What it writes:
 *   • scripts/schema-snapshot.ts                   — column-guarded tables (referenced AND live)
 *   • scripts/schema-drift-unguarded-baseline.json — tables referenced in code but ABSENT from the
 *     live schema (RPC names / phantom tables); the guard ratchets these so a new one can't sneak in.
 *   • scripts/live-tables.ts                       — EVERY live relation, referenced or not. One
 *     read produces all three deliberately: the snapshot is `referenced ∩ live`, so "is this name
 *     live?" cannot be answered from it, and answering it from a SECOND read would compare two
 *     different moments of the database.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  LIVE_TABLES_SOURCE,
  LiveSchema,
  SNAPSHOT_SOURCE,
  buildLiveTables,
  buildSnapshot,
  embeddedTables,
  liveTablesHeader,
  referencedTables,
  snapshotHeader,
} from "./schema-cache-builders"
import { fetchLiveJson, liveCredentials, readStdinJson, readStdinRaw, stamp } from "./schema-cache-provenance"

export async function loadLiveSchema(): Promise<{ schema: LiveSchema; via: string }> {
  const piped = readStdinRaw()
  if (piped.trim()) return { schema: readStdinJson(piped, "schema") as LiveSchema, via: "stdin" }

  const creds = liveCredentials()
  if (!creds) {
    throw new Error(
      "no live schema: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or pipe the schema JSON in (see header).",
    )
  }
  return { schema: (await fetchLiveJson("live_schema_json", creds)) as LiveSchema, via: SNAPSHOT_SOURCE }
}

async function main() {
  const root = process.cwd()
  const { schema, via } = await loadLiveSchema()
  if (!schema || typeof schema !== "object" || Object.keys(schema).length === 0) {
    console.error("✗ the live schema came back empty — refusing to write a snapshot from nothing")
    process.exit(1)
  }

  const { body, guarded, unguarded } = buildSnapshot(schema, referencedTables(root), embeddedTables(root))
  const snapshotPath = join(root, "scripts/schema-snapshot.ts")
  let previous: string | null = null
  try {
    previous = readFileSync(snapshotPath, "utf8")
  } catch {
    /* first generation */
  }

  writeFileSync(snapshotPath, stamp(snapshotHeader(guarded.length), body, SNAPSHOT_SOURCE, previous))
  writeFileSync(join(root, "scripts/schema-drift-unguarded-baseline.json"), JSON.stringify(unguarded, null, 2) + "\n")

  // The FULL relation list, from this same reading. It is written here rather than by a generator
  // of its own so the two files can never be built from two different moments of the database:
  // `referenced ∩ live` and `live` have to come out of one read or the difference between them —
  // which is exactly what "retired" means — is measured across a gap.
  const liveTablesPath = join(root, "scripts/live-tables.ts")
  let previousLiveTables: string | null = null
  try {
    previousLiveTables = readFileSync(liveTablesPath, "utf8")
  } catch {
    /* first generation */
  }
  const live = buildLiveTables(schema)
  writeFileSync(
    liveTablesPath,
    stamp(liveTablesHeader(live.tables.length), live.body, LIVE_TABLES_SOURCE, previousLiveTables),
  )

  console.log(
    `✅ snapshot: ${guarded.length} guarded tables (read via ${via}, ${Object.keys(schema).length} live relations) | unguarded baseline: ${unguarded.length} | live-tables: ${live.tables.length}`,
  )
}

main().catch((e) => {
  console.error(`✗ snapshot generation failed: ${e?.message ?? e}`)
  process.exit(1)
})
