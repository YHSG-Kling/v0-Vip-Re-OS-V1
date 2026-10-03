#!/usr/bin/env tsx
/**
 * scripts/legacy-tables-retired-simulator.ts   (npm run test:legacy-tables-retired)
 * ─────────────────────────────────────────────────────────────────────────────
 * DROPPED TABLES STAY DROPPED — no runtime code may read or write a table the
 * migrations have removed.
 *
 * WHY THIS WAS REWRITTEN
 * The first version of this guard passed for months while two live service methods
 * queried a dropped table. It failed in the two ways a guard can fail:
 *
 *   1. Its list of retired tables was HAND-WRITTEN. `commissions` was dropped in
 *      m284 and nobody added it here, so the guard was not looking for the thing
 *      that was actually broken. A guard whose coverage is a list only ever covers
 *      what someone remembered to type.
 *   2. It walked `lib` and `app` ONLY. The offending calls were in `services/`,
 *      which no guard in this repo was reading. Ten top-level directories ship
 *      TypeScript; two were being checked.
 *
 * Both inputs are now derived from the repo instead of typed into it:
 *
 *   RETIRED  = every table named in a `DROP TABLE` across the SQL we ship, minus every
 *              relation the LIVE DATABASE still has (scripts/live-tables.ts). That
 *              difference is what makes a drop-then-recreate — or a DROP that was
 *              written and never run — a non-event, automatically.
 *   ROOTS    = every top-level directory that contains TypeScript, minus the
 *              non-shipping ones named below.
 *
 * So a future drop is covered the moment its migration lands, and a future
 * directory is covered the moment it holds a .ts file.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { LIVE_TABLES } from "./live-tables"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"
import { runtimeFiles, runtimeRoots } from "./runtime-roots"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

const SQL_KEYWORDS = new Set(["IF", "EXISTS", "TABLE", "CASCADE", "ONLY", "RESTRICT"])

// TOMBSTONE (orphan doctrine §1.1) — this file used to carry its own private copies
// of NON_RUNTIME_ROOTS, NEVER_WALK, runtimeRoots() and walk(). They were a
// character-for-character duplicate of the survivor, scripts/runtime-roots.ts:26-95,
// which is now imported above instead.
//
// The duplicate was not a style problem. `runtimeFiles()` was fixed on 2026-08-25 to
// include ROOT-LEVEL runtime files (proxy.ts — the edge auth gate — and types.ts were
// in no guard's corpus, because the walk enumerated directories and a root file is
// not a directory). This guard would NOT have inherited that fix: it walked its own
// copy, so a `.from("<dropped table>")` inside proxy.ts would have stayed invisible
// here no matter how many times the shared module was corrected. Two walkers is two
// answers to "what ships", and only one of them gets maintained.

/** Table names from every `DROP TABLE [IF EXISTS] x [CASCADE]` in the SQL we ship. */
function droppedTables(): string[] {
  // BOTH directories, deliberately — and I tried restricting this to supabase/migrations first,
  // which the live database disproved. Some scripts/*.sql WERE executed by hand: training_courses,
  // agent_courses and training_course_steps are gone from the live schema and their only DROP is in
  // scripts/L60-S02-retire-legacy-dead-tables.sql. Meanwhile long_form_videos is STILL LIVE and its
  // only DROP is in scripts/050-enhance-video-content-studio.sql. Same directory, opposite
  // outcomes: where a DROP is written says nothing about whether it ran. Only the database knows,
  // which is what LIVE_TABLES below is.
  const sqlDirs = ["supabase/migrations", "scripts"]
  const found = new Set<string>()
  for (const dir of sqlDirs) {
    if (!existsSync(dir)) continue
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".sql")) continue
      let src = ""
      try { src = readFileSync(join(dir, f), "utf8") } catch { continue }
      for (const m of src.matchAll(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-zA-Z0-9_."]+)/gi)) {
        const raw = m[1].replace(/"/g, "").trim()
        const bare = raw.includes(".") ? raw.split(".").pop()! : raw   // strip `public.`
        // `DROP TABLE IF\n  EXISTS x` and friends can leave a keyword in the capture.
        if (bare && !SQL_KEYWORDS.has(bare.toUpperCase())) found.add(bare)
      }
    }
  }
  return [...found].sort()
}

// THE ORACLE IS THE DATABASE, NOT THE SNAPSHOT. This filter read SCHEMA_SNAPSHOT for most of its
// life, which is `referenced ∩ live` — so a table that EXISTS but is queried nowhere is absent from
// it and looked dropped. long_form_videos is exactly that: live, unqueried, DROPped only by a
// scripts/*.sql that was never run. It was classified retired, and the ownership check below then
// failed on a row that is correct. scripts/live-tables.ts is the whole live relation list, from the
// same read as the snapshot, so absence from it now means what this guard always assumed it meant.
const live = new Set(LIVE_TABLES)
const allDropped = droppedTables()
const RETIRED = allDropped.filter((t) => !live.has(t))
const ROOTS = runtimeRoots()
// The FILE list, from the survivor. It is `ROOTS` walked PLUS the root-level runtime
// files, which the private copy this guard used to carry could never see.
const RUNTIME_FILES = runtimeFiles()
const ROOT_LEVEL_FILES = RUNTIME_FILES.filter((f) => !f.includes("/"))

console.log(`\n── derivation ──`)
console.log(`  · ${allDropped.length} tables named in a DROP TABLE; ${RETIRED.length} of them are absent from the ${LIVE_TABLES.length} live relations (retired)`)
console.log(`  · runtime roots walked: ${ROOTS.join(", ")}`)
console.log(`  · plus ${ROOT_LEVEL_FILES.length} root-level runtime file(s): ${ROOT_LEVEL_FILES.join(", ") || "none"}`)

// A DERIVED list can silently become an EMPTY list — a parser regression would make
// every check below vacuously true. These two are canaries on the derivation, not the
// guard's coverage: `commissions` is the drop this guard was rewritten for, and the
// training spine is the drop it originally shipped for.
console.log("\n── the derivation actually resolved (canary against a vacuous pass) ──")
{
  check("DROP TABLE parsing found tables at all", allDropped.length > 0)
  check("the commission twin dropped in m284 is derived as retired", RETIRED.includes("commissions"))
  check("the legacy training spine is derived as retired",
    ["training_courses", "agent_courses", "training_course_steps"].every((t) => RETIRED.includes(t)))
  check("more than app/ and lib/ are walked", ROOTS.length > 2 && ROOTS.includes("services"))
  // The reach now includes files that live at the repository root. Asserted as the
  // RULE (a root-level runtime file is in the corpus, a *.config.ts is not) rather
  // than as a count, so adding a root file cannot silently narrow this guard again.
  check("the corpus reaches root-level runtime files (proxy.ts is the edge auth gate)",
    RUNTIME_FILES.includes("proxy.ts"))
  check("…and still excludes root-level *.config.ts (toolchain, not runtime)",
    !ROOT_LEVEL_FILES.some((f) => /\.config\.[cm]?tsx?$/.test(f)))
}

console.log("\n── retired tables have ZERO runtime .from() references (no reader/writer) ──")
{
  // COMMENT-STRIPPED, AND THE REASON IS A DEFECT THIS SCAN ACTUALLY SHIPPED.
  // Reading raw source made a TOMBSTONE read as a live query: retiring a table
  // correctly means leaving a comment naming its survivor (§1), and
  // lib/listing-health/health-scorer.ts:211 does exactly that inside a JSDoc
  // block — ` * WAS: .from("open_houses")…`. This scan then reported the table
  // as still queried, i.e. it accused the repo of the very thing the tombstone
  // records having fixed, and would have done so FOREVER, since the tombstone is
  // meant to stay. Following the doctrine made the guard fail.
  //
  // `stripComments`, not `blankComments`: this reports FILE NAMES, not positions
  // computed from match indices (CLAUDE.md §2 names which helper each case wants).
  // Never hand-rolled — the recurring defect is stripping /* */ before //, where
  // one // containing an apostrophe or a URL makes the block regex swallow real
  // code and the scan then accuses live code of being absent.
  const files = RUNTIME_FILES
  const sources = files.map((f) => ({ f, src: stripComments(readFileSync(f, "utf8")) }))
  console.log(`  · ${sources.length} runtime files scanned (comments stripped)`)
  for (const t of RETIRED) {
    const re = new RegExp(`\\.from\\(\\s*["'\`]${t}["'\`]`)
    const hits = sources.filter(({ src }) => re.test(src)).map(({ f }) => f)
    check(`no runtime code queries ${t}`, hits.length === 0)
    if (hits.length) console.log(`      ↳ ${hits.slice(0, 5).join(", ")}`)
  }
  // POSITIVE CONTROL (§2) — a scanner that finds nothing because it is broken and
  // one that finds nothing because the tree is clean report the same zero. Prove
  // this finder still sees a real query, and still ignores a commented one.
  const probeLive = `const x = await sb.from("listings").select("id")`
  const probeBlock = `/** WAS: .from("listings").select("id") */`
  const probeLine = `// .from("listings").select("id")`
  const seesFrom = (s: string) => /\.from\(\s*["'`]listings["'`]/.test(stripComments(s))
  check("CONTROL — the finder still sees a REAL .from(\"listings\")", seesFrom(probeLive))
  check("CONTROL — …and ignores one inside a /* */ tombstone", !seesFrom(probeBlock))
  check("CONTROL — …and ignores one behind a // line comment", !seesFrom(probeLine))
}

console.log("\n── retired tables are absent from the schema snapshot ──")
{
  // Guaranteed by construction above (RETIRED excludes anything in `live`), asserted
  // here so the invariant is visible in the output rather than implied by the filter.
  const snap = readFileSync(join("scripts", "schema-snapshot.ts"), "utf8")
  const leaked = RETIRED.filter((t) => new RegExp(`\\n\\s*${t}:\\s*\\[`).test(snap))
  check("no retired table is declared in SCHEMA_SNAPSHOT", leaked.length === 0)
  if (leaked.length) console.log(`      ↳ ${leaked.join(", ")}`)
}

console.log("\n── the retirement is recorded in the manager registry ──")
{
  const reg = readFileSync(join("lib", "kernel", "manager-registry.ts"), "utf8")
  check("a legacy_tables_retired burn domain records it", reg.includes("legacy_tables_retired:"))
  const owned = RETIRED.filter((t) => new RegExp(`\\n\\s*${t}:\\s*"`).test(reg))
  check("no retired table still carries a TABLE_MANAGER ownership row", owned.length === 0)
  if (owned.length) console.log(`      ↳ ${owned.join(", ")}`)
}

console.log(`\n RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)); console.log(" ❌ LEGACY_TABLES_RETIRED_FAIL"); process.exit(1) }
console.log(" ✅ LEGACY_TABLES_RETIRED_PASS — every dropped table is unreferenced across all runtime roots; drift cannot silently return")
