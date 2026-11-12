#!/usr/bin/env tsx
/**
 * scripts/generate-schema-fk-map.ts   (npm run schema:regen:fk-map)
 * ─────────────────────────────────────────────────────────────────────────────
 * Writes scripts/schema-fk-map.ts FROM THE LIVE DATABASE.
 *
 * That file used to carry a "GENERATED from the live Postgres schema" banner and a block of
 * REGENERATE SQL — with no generator anywhere in the repo. The only way to update it was to
 * hand-edit the thing that says it is machine-written, which is how it fell 6 edges behind the
 * database (three FK columns on tables dropped by m480/m484, three on tables added by m479/m481).
 * This is that generator.
 *
 * TWO WAYS IN:
 *   • CREDENTIALED (default): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, through the
 *     service-role-only public.live_foreign_keys_json() RPC (m485). pg_constraint is not reachable
 *     through PostgREST, so the RPC is the door.
 *   • PIPED (bootstrap): the same rows on stdin, as
 *     `[{ "src_table": …, "src_col": …, "tgt_table": …, "name": … }, …]` —
 *
 *       SELECT jsonb_agg(jsonb_build_object('src_table',src_table,'src_col',src_col,
 *                                           'tgt_table',tgt_table,'name',name)
 *                        ORDER BY src_table, src_col, name)
 *       FROM (
 *         SELECT src.relname AS src_table, a.attname AS src_col, tgt.relname AS tgt_table,
 *                c.conname::text AS name
 *         FROM pg_constraint c
 *         JOIN pg_class src ON src.oid = c.conrelid
 *         JOIN pg_namespace sn ON sn.oid = src.relnamespace
 *         JOIN pg_class tgt ON tgt.oid = c.confrelid
 *         JOIN pg_namespace tn ON tn.oid = tgt.relnamespace
 *         JOIN unnest(c.conkey) AS k(attnum) ON true
 *         JOIN pg_attribute a ON a.attrelid = src.oid AND a.attnum = k.attnum
 *         WHERE c.contype='f' AND sn.nspname='public' AND tn.nspname='public'
 *       ) t;
 *
 * The RAW EDGES cross the wire, not a pre-aggregated map: the file carries TWO derived structures
 * (the column→table map and the per-table-pair cardinality behind PGRST201), and deriving both
 * from one reading is what keeps them from disagreeing.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { FK_MAP_SOURCE, LiveFk, buildFkMap, fkMapHeader } from "./schema-cache-builders"
import { fetchLiveJson, liveCredentials, readStdinJson, readStdinRaw, stamp } from "./schema-cache-provenance"

export async function loadLiveForeignKeys(): Promise<{ rows: LiveFk[]; via: string }> {
  const piped = readStdinRaw()
  if (piped.trim()) return { rows: readStdinJson(piped, "rows") as LiveFk[], via: "stdin" }

  const creds = liveCredentials()
  if (!creds) {
    throw new Error(
      "no live foreign keys: set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, or pipe the FK rows in (see header).",
    )
  }
  return { rows: (await fetchLiveJson("live_foreign_keys_json", creds)) as LiveFk[], via: FK_MAP_SOURCE }
}

async function main() {
  const root = process.cwd()
  const { rows, via } = await loadLiveForeignKeys()
  if (!Array.isArray(rows) || rows.length === 0) {
    console.error("✗ the live foreign keys came back empty — refusing to write a map from nothing")
    process.exit(1)
  }

  const { body, facts } = buildFkMap(rows)
  const path = join(root, "scripts/schema-fk-map.ts")
  let previous: string | null = null
  try {
    previous = readFileSync(path, "utf8")
  } catch {
    /* first generation */
  }

  writeFileSync(path, stamp(fkMapHeader(facts), body, FK_MAP_SOURCE, previous))
  console.log(
    `✅ fk map: ${facts.edges} edges across ${facts.tables} source tables · ${facts.pairs} table pairs, ${facts.ambiguousPairs} ambiguous, ${facts.selfRefs} self-referential (read via ${via})`,
  )
}

main().catch((e) => {
  console.error(`✗ FK map generation failed: ${e?.message ?? e}`)
  process.exit(1)
})
