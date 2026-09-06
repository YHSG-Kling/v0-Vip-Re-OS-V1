#!/usr/bin/env tsx
/**
 * scripts/generate-check-vocabularies.ts   (npm run schema:regen:vocabularies)
 * ─────────────────────────────────────────────────────────────────────────────
 * Writes scripts/check-vocabularies.ts FROM THE LIVE DATABASE.
 *
 * Line 1 of that file read "GENERATED from the live database. Do not hand-edit." and there was no
 * generator, no documented SQL, and no way to obey it. It was hand-edited — most recently in the
 * m484 wave — and its own header's counts (428 tables / 730 columns) had drifted from its own
 * contents (427 / 736). An unenforceable banner is worse than none: it tells the next reader the
 * file can be trusted.
 *
 * TWO WAYS IN:
 *   • CREDENTIALED (default): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, through the
 *     service-role-only public.live_check_constraints_json() RPC (m485). pg_constraint is not
 *     reachable through PostgREST, so the RPC is the door.
 *   • PIPED (bootstrap): the same rows on stdin, as
 *     `[{ "table": …, "column": …, "name": …, "def": … }, …]` —
 *
 *       SELECT jsonb_agg(jsonb_build_object('table',tbl,'column',col,'name',conname,'def',def)
 *                        ORDER BY tbl, col, conname)
 *       FROM (
 *         SELECT r.relname AS tbl, a.attname AS col, con.conname::text AS conname,
 *                pg_get_constraintdef(con.oid) AS def
 *         FROM pg_constraint con
 *         JOIN pg_class r ON r.oid = con.conrelid
 *         JOIN pg_namespace n ON n.oid = r.relnamespace
 *         JOIN pg_attribute a ON a.attrelid = r.oid AND a.attnum = con.conkey[1]
 *         WHERE con.contype='c' AND n.nspname='public' AND r.relkind='r'
 *           AND array_length(con.conkey,1) = 1
 *       ) t;
 *
 * The RAW CONSTRAINT DEFINITIONS cross the wire, not a pre-chewed vocabulary map: which shapes
 * count as a vocabulary is a rule this repo owns (scripts/schema-cache-builders.ts), reviewable in
 * a pull request and fixable without DDL.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { LiveCheck, VOCAB_SOURCE, buildVocabularies, vocabHeader } from "./schema-cache-builders"
import { fetchLiveJson, liveCredentials, readStdinJson, readStdinRaw, stamp } from "./schema-cache-provenance"

export async function loadLiveChecks(): Promise<{ checks: LiveCheck[]; via: string }> {
  const piped = readStdinRaw()
  if (piped.trim()) return { checks: readStdinJson(piped, "rows") as LiveCheck[], via: "stdin" }

  const creds = liveCredentials()
  if (!creds) {
    throw new Error(
      "no live CHECK constraints: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or pipe the rows in (see header).",
    )
  }
  return { checks: (await fetchLiveJson("live_check_constraints_json", creds)) as LiveCheck[], via: VOCAB_SOURCE }
}

async function main() {
  const root = process.cwd()
  const { checks, via } = await loadLiveChecks()
  if (!Array.isArray(checks) || checks.length === 0) {
    console.error("✗ the live CHECK constraints came back empty — refusing to write a vocabulary from nothing")
    process.exit(1)
  }

  const { body, tables, columns, unparsed, conflicts } = buildVocabularies(checks)
  const path = join(root, "scripts/check-vocabularies.ts")
  let previous: string | null = null
  try {
    previous = readFileSync(path, "utf8")
  } catch {
    /* first generation */
  }

  writeFileSync(path, stamp(vocabHeader(tables, columns), body, VOCAB_SOURCE, previous))
  console.log(`✅ vocabularies: ${tables} tables, ${columns} columns from ${checks.length} single-column CHECKs (read via ${via})`)
  for (const u of unparsed) console.log(`   · a text ANY-array this generator could not read: ${u}`)
  for (const c of conflicts) console.log(`   · ${c}`)
}

main().catch((e) => {
  console.error(`✗ vocabulary generation failed: ${e?.message ?? e}`)
  process.exit(1)
})
