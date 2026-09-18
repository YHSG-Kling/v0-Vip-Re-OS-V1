// scripts/vendor-trade-vocab-source.ts
//
// READING THE VENDOR TRADE VOCABULARY OUT OF THE MIGRATIONS — ONE PARSER, NOT TWO.
//
// Two guards need the same three answers: which migration currently DEFINES a
// piece of vendor-trade DDL, what the state-licensed trade list inside it says,
// and what the trade_category CHECK inside it admits.
// scripts/vendor-service-area-simulator.ts asked them first;
// scripts/appraiser-bench-simulator.ts needs the same ones. They live here
// rather than being imported across guards, because those files end in
// `main().catch(...)` at module scope — importing one from the other would RUN
// it, printing a second guard's output inside the first and letting its
// process.exit decide the caller's fate. And they live here rather than being
// copied, because two copies of a parser are two parsers that can disagree about
// what the migration says (CLAUDE.md §6).
//
// EVERY FUNCTION HERE PAIRS WITH A NON-EMPTY ASSERTION AT ITS CALL SITE. A regex
// that has gone blind and a repo with nothing to find both return [] — so the
// guards assert length > 0 beside every comparison (CLAUDE.md §2).

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * PURE — the trade list inside vendor_trade_requires_state_license.
 *
 * ANCHORED ON THE `create` STATEMENT, not on an occurrence count. The first
 * version of this split the file on the function NAME and took chunk [2], which
 * silently returned [] because the name appears in prose comments as well as in
 * the DDL.
 */
export function sqlLicensedTrades(migrationSql: string): string[] {
  const fn = migrationSql.match(
    /create or replace function public\.vendor_trade_requires_state_license[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/i,
  )
  if (!fn) return []
  const arr = fn[1].match(/array\s*\[([\s\S]*?)\]/i)
  if (!arr) return []
  return [...arr[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
}

/** PURE — the trade vocabulary inside a vendor_service_areas trade_category
 *  CHECK. Anchored on the `add constraint`, for the same reason. */
export function sqlTradeVocabulary(migrationSql: string): string[] {
  const chunk = migrationSql.match(
    /add constraint vendor_service_areas_trade_category_check[\s\S]*?array\s*\[([\s\S]*?)\]/i,
  )
  if (!chunk) return []
  return [...chunk[1].matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1])
}

/**
 * The migration file that most recently DEFINES `needle`, by m-number.
 *
 * WHY THIS EXISTS. Both parsers above used to be pointed at m551 by name. That
 * was a WAYPOINT (CLAUDE.md §2): m551 defined the licensed-trade list and the
 * trade CHECK when it was written, and m554 redefined BOTH — so a guard pinned
 * to m551 would report the TypeScript side as drifted when in fact the database
 * and the module agreed and only the guard was reading a superseded file. The
 * RULE is "the definition in force is the one in the highest-numbered migration
 * that states it", and this derives that rather than naming it.
 *
 * Returns the file's TEXT plus its basename, so a caller can say which file it
 * actually read — a guard that cannot name its source cannot be checked.
 */
export function latestMigrationDefining(
  root: string,
  needle: RegExp,
): { name: string; sql: string } | null {
  const dir = join(root, "supabase/migrations")
  if (!existsSync(dir)) return null
  const ranked = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ f, n: Number((f.match(/^m(\d+)/) ?? [])[1] ?? -1) }))
    .filter((x) => x.n >= 0)
    .sort((a, b) => b.n - a.n)
  for (const { f } of ranked) {
    const sql = readFileSync(join(dir, f), "utf8")
    // Strip SQL line comments: every one of these migrations QUOTES the previous
    // definition in its rationale prose, so a raw scan would pick the file that
    // merely TALKS about the definition over the one that states it (CLAUDE.md
    // §2 — a tombstone is not a call site).
    if (needle.test(sql.replace(/^--.*$/gm, ""))) return { name: f, sql }
  }
  return null
}

/** The two needles both guards look for, named once so they cannot drift. */
export const LICENSED_TRADE_FN_DDL =
  /create or replace function public\.vendor_trade_requires_state_license/i
export const TRADE_CATEGORY_CHECK_DDL =
  /add constraint vendor_service_areas_trade_category_check/i
