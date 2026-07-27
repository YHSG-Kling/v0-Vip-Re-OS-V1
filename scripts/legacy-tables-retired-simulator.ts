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
 *   RETIRED  = every table named in a `DROP TABLE` across the migrations, minus any
 *              table still present in the live-schema snapshot (that difference is
 *              what makes a drop-then-recreate a non-event, automatically).
 *   ROOTS    = every top-level directory that contains TypeScript, minus the
 *              non-shipping ones named below.
 *
 * So a future drop is covered the moment its migration lands, and a future
 * directory is covered the moment it holds a .ts file.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"
import { SCHEMA_SNAPSHOT } from "./schema-snapshot"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

// Directories that hold TypeScript but do not ship as application runtime. Every
// entry names why, because this is the one list left and it is how the guard's reach
// can still be narrowed by accident.
const NON_RUNTIME_ROOTS = new Set([
  "scripts",  // guards, migrations and codemods — they name dropped tables on purpose
  "e2e",      // test harness, not served
])
const NEVER_WALK = new Set(["node_modules", ".next", ".git", ".vercel"])
const SQL_KEYWORDS = new Set(["IF", "EXISTS", "TABLE", "CASCADE", "ONLY", "RESTRICT"])

/** Every top-level dir that contains .ts/.tsx and ships as runtime. */
function runtimeRoots(): string[] {
  return readdirSync(".").filter((name) => {
    if (name.startsWith(".")) return false   // .claude / .agents / .github — config, not runtime
    if (NEVER_WALK.has(name) || NON_RUNTIME_ROOTS.has(name)) return false
    let st
    try { st = statSync(name) } catch { return false }
    if (!st.isDirectory()) return false
    return walk(name).length > 0
  }).sort()
}

/** Recursively collect .ts/.tsx under a dir. */
function walk(dir: string, out: string[] = []): string[] {
  let entries: string[] = []
  try { entries = readdirSync(dir) } catch { return out }
  for (const e of entries) {
    if (NEVER_WALK.has(e)) continue
    const p = join(dir, e)
    let st
    try { st = statSync(p) } catch { continue }
    if (st.isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(e)) out.push(p)
  }
  return out
}

/** Table names from every `DROP TABLE [IF EXISTS] x [CASCADE]` in the SQL we ship. */
function droppedTables(): string[] {
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

const live = new Set(Object.keys(SCHEMA_SNAPSHOT))
const allDropped = droppedTables()
// A table that was dropped but is back in the live snapshot was re-created later —
// it is not retired, and referencing it is correct.
const RETIRED = allDropped.filter((t) => !live.has(t))
const ROOTS = runtimeRoots()

console.log(`\n── derivation ──`)
console.log(`  · ${allDropped.length} tables named in a DROP TABLE; ${RETIRED.length} of them are absent from the live snapshot (retired)`)
console.log(`  · runtime roots walked: ${ROOTS.join(", ")}`)

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
}

console.log("\n── retired tables have ZERO runtime .from() references (no reader/writer) ──")
{
  const files = ROOTS.flatMap((r) => walk(r))
  const sources = files.map((f) => ({ f, src: readFileSync(f, "utf8") }))
  console.log(`  · ${sources.length} runtime files scanned`)
  for (const t of RETIRED) {
    const re = new RegExp(`\\.from\\(\\s*["'\`]${t}["'\`]`)
    const hits = sources.filter(({ src }) => re.test(src)).map(({ f }) => f)
    check(`no runtime code queries ${t}`, hits.length === 0)
    if (hits.length) console.log(`      ↳ ${hits.slice(0, 5).join(", ")}`)
  }
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
