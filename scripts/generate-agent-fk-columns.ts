#!/usr/bin/env tsx
/**
 * scripts/generate-agent-fk-columns.ts   (npm run schema:regen:agent-fk)
 * ─────────────────────────────────────────────────────────────────────────────
 * Writes scripts/agent-fk-columns.ts FROM THE LIVE DATABASE — the identity-class map that
 * scripts/agent-id-class-guard.ts reads: which columns hold an agents(id), which hold a users(id)
 * while being NAMED like an agents(id), and which tables carry a contacts(id) on `contact_id`.
 *
 * WHY THIS GENERATOR EXISTS. That file said "snapshotted from the live database" and carried a
 * block of REGENERATE SQL, and no generator in the repo ran it — so the only way to update it was
 * the hand-edit its own banner forbade. schema-fk-map.ts had exactly this shape before m485 and
 * had fallen 6 edges behind; this one had fallen further, and in BOTH directions:
 *
 *   • it named 6 agents(id) columns the live schema no longer has (a stale entry makes the guard
 *     police a column that is not there — harmless noise), and
 *   • it listed 56 of the 165 tables whose `contact_id` FKs contacts(id) — the guard was blind to
 *     109 tables it exists to watch, and a blind guard reports zero and reads as a clean bill of
 *     health.
 *
 * TWO WAYS IN, matching its two sibling generators:
 *   • CREDENTIALED (default): SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, through the
 *     service-role-only public.live_foreign_keys_json() RPC (m485). pg_constraint is not reachable
 *     through PostgREST — supabase-js `.from()` only sees exposed schemas — so the RPC is the door.
 *   • PIPED (bootstrap): the same rows on stdin, as
 *     `[{ "src_table": …, "src_col": …, "tgt_table": …, "name": … }, …]`. The payload may be
 *     narrowed to the three targets this file describes; a foreign key has exactly one target
 *     table, so filtering by target cannot split a constraint or change its column count.
 *
 *       select con.conrelid::regclass::text as src_table, a.attname as src_col,
 *              con.confrelid::regclass::text as tgt_table, con.conname::text as name
 *       from pg_constraint con
 *       join lateral unnest(con.conkey) k(attnum) on true
 *       join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
 *       where con.contype = 'f'
 *         and con.connamespace = 'public'::regnamespace
 *         and con.confrelid in ('public.agents'::regclass, 'public.users'::regclass,
 *                               'public.contacts'::regclass);
 *
 * THE SAME RPC AS THE FK MAP, deliberately. Two files describing the same edges must not be able
 * to disagree about one, and a second reading would compare two different moments of the database.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { AGENT_FK_SOURCE, LiveFk, agentFkHeader, buildAgentFkColumns } from "./schema-cache-builders"
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
  return { rows: (await fetchLiveJson("live_foreign_keys_json", creds)) as LiveFk[], via: AGENT_FK_SOURCE }
}

async function main() {
  const root = process.cwd()
  const { rows, via } = await loadLiveForeignKeys()
  if (!Array.isArray(rows) || rows.length === 0) {
    console.error("✗ the live foreign keys came back empty — refusing to write an identity map from nothing")
    process.exit(1)
  }

  const { body, facts } = buildAgentFkColumns(rows)
  if (facts.agentColumns === 0 || facts.contactTables === 0) {
    // A payload that reached us but named none of these targets is a NARROWED read, not a schema
    // in which nothing FKs agents — and writing the empty answer would blind the guard silently.
    console.error(
      `✗ the payload carries no agents(id) or contacts(id) edges (${facts.agentColumns} / ${facts.contactTables}) — refusing to write`,
    )
    process.exit(1)
  }

  const path = join(root, "scripts/agent-fk-columns.ts")
  let previous: string | null = null
  try {
    previous = readFileSync(path, "utf8")
  } catch {
    /* first generation */
  }

  writeFileSync(path, stamp(agentFkHeader(facts), body, AGENT_FK_SOURCE, previous))
  console.log(
    `✅ identity map: ${facts.agentColumns} agents(id) columns / ${facts.agentTables} tables · ` +
      `${facts.usersAgentishColumns} agent-ish users(id) columns / ${facts.usersAgentishTables} tables · ` +
      `${facts.contactTables} contact_id tables · ${facts.compositeSkipped} composite FK(s) skipped (read via ${via})`,
  )
}

main().catch((e) => {
  console.error(`✗ identity map generation failed: ${e?.message ?? e}`)
  process.exit(1)
})
