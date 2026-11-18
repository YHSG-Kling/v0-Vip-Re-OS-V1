#!/usr/bin/env tsx
/**
 * UPSERT CONFLICT TARGETS ARE INFERABLE (wave 154 — owner ruling R7: audit the whole OS, not what one wave built).
 *
 * THE DEFECT THIS EXISTS FOR. supabase-js `.upsert(row, { onConflict: "a,b" })` becomes `ON CONFLICT (a, b)` with NO
 * predicate. Postgres can only use a unique index whose columns are exactly that set AND that is not partial and not an
 * expression index. When the only matching index is PARTIAL (`… WHERE a IS NOT NULL`), the WHOLE statement is refused with
 * 42P10 — not "the row was skipped": nothing is written, on every call, forever. supabase-js RESOLVES that refusal
 * (CLAUDE.md §3), so a caller that logs and moves on has a writer that has never written.
 *
 * MEASURED LIVE 2026-11-18: 7 of 141 distinct (table, target) pairs were in that state — competitor_ads (0 rows since it
 * shipped), brand_voice_profile (the admin brand screen's Save), outcome_reconciliations, ai_daily_briefings, showings,
 * transaction_documents, and a legacy two-column fallback on closing_cost_accuracy_observations. Fixed by m987, m988 and two
 * code changes; this guard holds the rule against the generated cache of live unique indexes (scripts/unique-indexes.ts —
 * GENERATED, never hand-edited; `npx tsx scripts/generate-unique-indexes.ts --sql` prints the query). *
 * THE SURVIVOR IT EXTENDS. An earlier pass ("PASS 10", registry row upsert_and_rpc_integrity_pass10, proved in
 * scripts/doc-kernel-simulator.ts) ran this same cross-check against pg_index ONCE, by hand, found 21 broken upserts, fixed
 * them and pinned the 21 corrected spellings. A pin of yesterday's fixes cannot see tomorrow's upsert — seven more arrived
 * after it. This guard is that cross-check made permanent: the RULE over every call site, against a generated cache. The
 * PASS 10 pins stay where they are (they also hold RPC existence and the phantom-table fix, which this guard does not judge).
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { blankComments, blankStrings } from "./strip-comments"
import { INFERABLE_UNIQUE_SETS, UNIQUE_INDEX_TABLES_READ } from "./unique-indexes"

export interface UpsertSite { file: string; table: string | null; cols: string }
const normalize = (cols: string) => cols.split(",").map((c) => c.trim()).filter(Boolean).sort().join(",")

/**
 * Every `onConflict` that is CODE, with the nearest preceding `.from("table")` that is code. Positions come from the masked
 * source (comments and string CONTENTS blanked, offsets intact) so prose that merely mentions an upsert — a registry row, a
 * tombstone, an error message — is never a call site; the literal values are then read at the same offsets from the source
 * with only comments blanked.
 */
export function upsertSitesIn(file: string, raw: string): UpsertSite[] {
  const masked = blankStrings(raw)
  const text = blankComments(raw)
  const literalAt = (i: number): string | null => /^\s*(["'`])([^"'`$]*)\1/.exec(text.slice(i, i + 400))?.[2] ?? null
  const out: UpsertSite[] = []
  const re = /\bonConflict\s*:/g
  let m: RegExpExecArray | null
  while ((m = re.exec(masked))) {
    const cols = literalAt(m.index + m[0].length)
    if (cols === null) continue // not a string literal: counted as a dynamic target by the census
    const start = Math.max(0, m.index - 6000)
    let table: string | null = null
    for (const f of masked.slice(start, m.index).matchAll(/\.from\(/g)) {
      const t = literalAt(start + (f.index ?? 0) + f[0].length)
      if (t && /^[a-z0-9_]+$/.test(t)) table = t
    }
    out.push({ file, table, cols: normalize(cols) })
  }
  return out
}

export function censusUpserts(root: string): { sites: UpsertSite[]; files: number; bareUpserts: number; dynamicTargets: number } {
  const sites: UpsertSite[] = []
  let files = 0, bareUpserts = 0, dynamicTargets = 0
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (n === "node_modules" || n.startsWith(".")) continue
      const p = join(d, n)
      if (statSync(p).isDirectory()) { walk(p); continue }
      if (!/\.(ts|tsx)$/.test(n)) continue
      files++
      const raw = readFileSync(p, "utf8")
      if (!raw.includes(".upsert(") && !raw.includes("onConflict")) continue
      const src = blankStrings(raw)
      const literal = upsertSitesIn(p.slice(root.length + 1), raw)
      sites.push(...literal)
      const all = (src.match(/\bonConflict\s*:/g) ?? []).length + (src.match(/[,{]\s*onConflict\s*[,}]/g) ?? []).length
      dynamicTargets += Math.max(0, all - literal.length)
      bareUpserts += Math.max(0, (src.match(/\.upsert\(/g) ?? []).length - all)
    }
  }
  for (const d of ["app", "lib"]) walk(join(root, d))
  return { sites, files, bareUpserts, dynamicTargets }
}

/** Why a (table, target) pair cannot be inferred — null when it can. */
export function conflictTargetProblem(table: string | null, cols: string, cache: Readonly<Record<string, readonly string[]>> = INFERABLE_UNIQUE_SETS): string | null {
  if (!table) return "the table of this upsert could not be resolved (no .from(\"…\") literal before it)"
  const sets = cache[table]
  if (!sets) return `table '${table}' is not in the unique-index cache — regenerate scripts/unique-indexes.ts (the generator prints the SQL)`
  return sets.includes(normalize(cols)) ? null : `no NON-PARTIAL unique index on (${cols}) — live has: ${sets.join(" | ") || "none"}. PostgREST cannot infer a partial or expression index: the whole upsert is refused (42P10)`
}

let passed = 0, failed = 0
const fails: string[] = []
function check(label: string, ok: boolean, detail = "") { if (ok) { passed++; console.log(`  ✓ ${label}`) } else { failed++; fails.push(label); console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`) } }

function main() {
  const ROOT = process.cwd()
  console.log("UPSERT CONFLICT TARGETS ARE INFERABLE")
  const { sites, files, bareUpserts, dynamicTargets } = censusUpserts(ROOT)
  const pairs = [...new Set(sites.map((s) => `${s.table}|${s.cols}`))]
  console.log(`  denominator: ${files} files under app/ + lib/ · ${sites.length} upsert call sites with a literal onConflict · ${pairs.length} distinct (table, target) pairs · cache: ${Object.keys(INFERABLE_UNIQUE_SETS).length} tables (${UNIQUE_INDEX_TABLES_READ} read live)`)
  const bad = sites.map((s) => ({ s, why: conflictTargetProblem(s.table, s.cols) })).filter((x) => x.why)
  for (const b of bad) console.log(`      · ${b.s.file}: ${b.s.table} (${b.s.cols}) — ${b.why}`)
  check(`every upsert's conflict target is a NON-PARTIAL unique index on exactly those columns (${sites.length} call sites)`, bad.length === 0, `${bad.length} cannot be inferred`)
  check("the census is not empty (a scan that finds nothing proves nothing)", sites.length > 50 && pairs.length > 50, `${sites.length} sites`)

  // POSITIVE CONTROLS — the finder and the judge both still recognise the defect.
  const specimen = `const { error } = await svc.from("competitor_ads").upsert({ a: 1 }, { onConflict: "source_platform, provider_ad_id" })`
  const seen = upsertSitesIn("specimen.ts", specimen)
  check("POSITIVE CONTROL: the finder reads a planted upsert's table and target (order and spacing normalized)", seen.length === 1 && seen[0].table === "competitor_ads" && seen[0].cols === "provider_ad_id,source_platform")
  check("POSITIVE CONTROL: the old GLOBAL PARTIAL target on competitor_ads is judged NOT inferable against the live cache", !!conflictTargetProblem("competitor_ads", "source_platform,provider_ad_id"))
  check("POSITIVE CONTROL: a partial-only table (brand_voice_profile by brokerage_id) is judged NOT inferable", !!conflictTargetProblem("brand_voice_profile", "brokerage_id"))
  check("NEGATIVE CONTROL: the tenant-led competitor_ads target IS inferable (m987)", conflictTargetProblem("competitor_ads", "brokerage_id,source_platform,provider_ad_id") === null)
  check("NEGATIVE CONTROL: a tombstone COMMENT naming an onConflict is not a call site", upsertSitesIn("t.ts", `// was: .from("x").upsert(r, { onConflict: "a,b" })\nconst y = 1`).length === 0)
  check("NEGATIVE CONTROL: PROSE inside a string literal that mentions an upsert is not a call site (a registry row, an error message)", upsertSitesIn("t.ts", `const what = "the old .from('x').upsert(r, { onConflict: 'a,b' }) was refused"`).length === 0)
  check("FAIL CLOSED: a table missing from the cache is a failure that names the remedy, never a pass", /regenerate/.test(conflictTargetProblem("a_table_nobody_cached", "id") ?? ""))
  check("FAIL CLOSED: an unresolved table is a failure, never a pass", !!conflictTargetProblem(null, "id"))

  console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
  console.log(` blind spots: ${bareUpserts} upsert(s) with NO onConflict ride the primary key and are not judged here · ${dynamicTargets} conflict target(s) are not string literals (a variable or a template) and are not judged ·`)
  console.log("   the table is the nearest preceding .from(\"…\") literal within 6000 characters (a query builder passed in from elsewhere is unresolved = a failure) ·")
  console.log("   scripts/ and supabase/functions are not scanned · raw SQL and .rpc() bodies are not seen · the cache is the live database at the time it was generated.")
  if (failed) { console.log(`FAILURES:\n${fails.map((x) => ` - ${x}`).join("\n")}\n ❌ UPSERT_CONFLICT_TARGET_FAIL`); process.exit(1) }
  console.log(" ✅ UPSERT_CONFLICT_TARGET_PASS — every upsert names a key the database can actually match")
}
if (process.argv[1] && /upsert-conflict-target-guard/.test(process.argv[1])) main()
