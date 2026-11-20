#!/usr/bin/env tsx
/**
 * scripts/cron-status-vocabulary-simulator.ts   (npm run test:cron-status-vocabulary)
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE VOCABULARY FOR cron_health_snapshot, AND A 7-DAY COUNT THAT CAN MOVE.
 *
 * WHAT THIS EXISTS BECAUSE OF. `cron_health_snapshot.last_status` carries NO
 * CHECK constraint (verified against pg_constraint on hrvaqgvukzxfskkcrwbt,
 * 2026-08-23: the table has zero check constraints), so nothing in the database
 * held writers and readers to the same words. The DDL comment in
 * scripts/1053-pl-truth-engine-cron-health.sql claimed four
 * ('success'|'failure'|'partial'|'running'); the only two writers in the tree
 * wrote two. Both surplus words had live readers:
 *
 *   · app/actions/superadmin/platform-overview.ts counted
 *     `last_status === "running"` into a `totals.running` tile that could
 *     therefore only ever render 0.
 *   · app/dashboard/superadmin/platform/page.tsx rendered a `running` badge and
 *     a `partial` badge, neither of which any row could satisfy.
 *   · lib/platform/ai-ops.ts classified `last_status === "error"` as failing —
 *     a word borrowed from a DIFFERENT table's vocabulary
 *     (system_health_checks.status, widened by m371).
 *
 * The resolution was NOT symmetric, and this proof holds both halves:
 *   'running' was BUILT (createCronRunContext stamps it at the start choke),
 *   'partial' and 'error' were DELETED at their read sites with tombstones.
 *
 * SECOND DEFECT, SAME TABLE. `run_count_7d` / `failure_count_7d` are
 * `int NOT NULL DEFAULT 0`, seeded 0 by the 1053 script, and were incremented
 * by nothing — so the platform board's "failures in 7d" column and the AI-ops
 * console's failure7d were pinned to zero forever, and the `failure_count_7d > 0`
 * disjunct in `totals.failing` was dead. recomputeCronSevenDayCounts is the
 * missing half; this proof holds that it exists, recomputes (never increments),
 * counts the LEDGER's failure words rather than the SNAPSHOT's, refuses to
 * write a zero over a refused read, and is actually invoked from a cron that
 * lib/kernel/cron-dispatch.ts really schedules.
 *
 * MEASUREMENT DISCIPLINE (CLAUDE.md §2). The reader sweep is tree-wide rather
 * than a hand-kept list, and it masks through scripts/strip-comments.ts in BOTH
 * directions — blankComments so the tombstones documenting the deleted words are
 * not counted as live readers, and blankStrings so PROSE QUOTING a deleted
 * comparison is not either. The second mask is not hypothetical: this guard's
 * first real run failed on lib/kernel/manager-registry.ts, whose
 * MAINTENANCE_DOMAINS entry for this very domain quotes the deleted
 * `error` comparison inside a string while explaining that it was removed. Every
 * absence assertion below is paired with a POSITIVE CONTROL that re-runs the
 * same finder against a synthetic defect — eight of them, including both
 * directions of that string case.
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { stripComments, blankComments, blankStrings } from "./strip-comments"
import { CRON_SNAPSHOT_STATUSES, LEDGER_FAILURE_STATUSES } from "../lib/kernel/cron-logging"
import { CRON_REGISTRY } from "../lib/kernel/cron-dispatch"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => {
  if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) }
}
const ROOT = process.cwd()
const src = (p: string) => readFileSync(join(ROOT, p), "utf8")

const SCAN_DIRS = ["app", "lib", "components"]
const EXT = /\.(ts|tsx)$/

// TOMBSTONE (orphan doctrine §1.1) — the private walker that stood here was one of
// 82 copies of the same readdirSync walker. The survivor is
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// It enumerated DIRECTORIES, and a root-level FILE is not a directory, so
// `proxy.ts` — the Next 16 edge middleware, which gates auth and queries four
// tables with a SERVICE client on EVERY request — was outside this guard's corpus.
// A file that is never opened reports green, which is the failure shape §2 of
// CLAUDE.md names. `rootRuntimeFiles()` from the same survivor supplies it.

const FILES = [...SCAN_DIRS.flatMap((d) => walkTs(join(ROOT, d))), ...rootRuntimeFiles(ROOT)].filter((p) => EXT.test(p))

// ─── THE FINDER ───────────────────────────────────────────────────────────────
//
// Every place the tree compares `last_status` to a string literal. `.last_status`
// is unique to cron_health_snapshot in this schema — no other table in
// scripts/schema-snapshot.ts carries the column — so an unqualified sweep is
// safe here, and the control below proves the regex still fires.
const READER_RE = /last_status\s*(?:!==?|===?)\s*["']([^"']+)["']/g

interface ReaderHit { word: string; file: string }

const LAST_STATUS = "last_status"

function findReaders(files: string[]): ReaderHit[] {
  const hits: ReaderHit[] = []
  for (const f of files) {
    // TWO MASKS, BOTH OFFSET-PRESERVING, AND THE CHOICE IS CLAUDE.md §2's RULE:
    // `blankComments` (not `stripComments`) because the position of each match
    // is load-bearing below, and `blankStrings` because a quoted literal would
    // otherwise confuse the parse.
    //
    // WHY BOTH ARE NEEDED — this guard failed on its own first real run and the
    // failure was correct behaviour finding an incorrect finder:
    //
    //   · COMMENTS: the tombstones this change added NAME the deleted words in
    //     prose. Counting them as live readers would make the guard accuse its
    //     own documentation of being the defect it documents.
    //   · STRINGS: lib/kernel/manager-registry.ts carries a MAINTENANCE_DOMAINS
    //     entry whose `what:` text quotes `last_status === 'error'` while
    //     explaining that that reader was deleted. It is a string literal, not a
    //     comment, so comment-blanking alone left it visible and the guard
    //     reported a reintroduced reader that does not exist.
    //
    // The word itself must survive masking (it is the capture), so the string
    // check cannot simply run the regex on the string-blanked text. Instead the
    // match's START offset is tested: in real code `last_status` sits in CODE
    // and survives blankStrings; inside a prose string the whole expression is
    // string CONTENT and is blanked, so the identifier is gone at that offset.
    const raw    = readFileSync(f, "utf8")
    const code   = blankComments(raw)
    const masked = blankStrings(code)
    for (const m of code.matchAll(READER_RE)) {
      if (m.index == null) continue
      if (masked.slice(m.index, m.index + LAST_STATUS.length) !== LAST_STATUS) continue
      hits.push({ word: m[1], file: relative(ROOT, f) })
    }
  }
  return hits
}

const readers = findReaders(FILES)
const readerWords = [...new Set(readers.map((r) => r.word))].sort()

// ─── THE WRITER SET, DERIVED NOT DECLARED ────────────────────────────────────
const kernel = stripComments(src("lib/kernel/cron-logging.ts"))
const writerWords = [...new Set(
  [...kernel.matchAll(/last_status:\s*["']([^"']+)["']/g)].map((m) => m[1]),
)].sort()

function vocabularyLayer() {
  console.log("\n[vocabulary — writers and readers of cron_health_snapshot.last_status]")
  console.log(`      writers found: ${writerWords.join(", ") || "(none)"}`)
  console.log(`      reader words:  ${readerWords.join(", ") || "(none)"}`)
  console.log(`      declared:      ${[...CRON_SNAPSHOT_STATUSES].join(", ")}`)

  check(
    "the finder sees real writers at all (denominator, not a silent zero)",
    writerWords.length >= 2,
  )
  check(
    "the finder sees real readers at all (denominator, not a silent zero)",
    readers.length >= 4,
  )

  // THE CENTRAL INVARIANT, BOTH DIRECTIONS.
  const unwritten = readerWords.filter((w) => !writerWords.includes(w))
  check(
    `every word a reader branches on has a writer (orphan reads: ${unwritten.join(", ") || "none"})`,
    unwritten.length === 0,
  )
  const unread = writerWords.filter((w) => !readerWords.includes(w))
  check(
    `every word a writer produces reaches a reader (orphan writes: ${unread.join(", ") || "none"})`,
    unread.length === 0,
  )
  check(
    "the exported CRON_SNAPSHOT_STATUSES is the same set the writers actually write",
    [...CRON_SNAPSHOT_STATUSES].sort().join("|") === writerWords.join("|"),
  )

  // THE TWO SPECIFIC WORDS THIS ROUND RESOLVED, held so they cannot come back
  // by the door they left through.
  check(
    "'running' is BUILT — createCronRunContext stamps it at the start choke",
    /last_status:\s*"running"/.test(kernel) && /createCronRunContext/.test(kernel),
  )
  check(
    "the 'running' stamp does NOT touch last_run_at (a hung cron must not look fresh)",
    (() => {
      const i = kernel.indexOf('last_status: "running"')
      if (i < 0) return false
      // The upsert object the start-stamp writes: from the nearest preceding
      // `.upsert({` to the closing `})`. last_run_at must not appear inside it.
      const openIdx = kernel.lastIndexOf(".upsert({", i)
      const closeIdx = kernel.indexOf("}", i)
      return openIdx >= 0 && !kernel.slice(openIdx, closeIdx).includes("last_run_at")
    })(),
  )
  check(
    "'partial' is gone from every read site (deleted, tombstoned, no producer)",
    !readerWords.includes("partial"),
  )
  check(
    "'error' no longer classifies a cron as failing (that word is system_health_checks')",
    !stripComments(src("lib/platform/ai-ops.ts")).includes('last_status === "error"'),
  )
  check(
    "the deletions left tombstones naming the surviving vocabulary",
    src("app/dashboard/superadmin/platform/page.tsx").includes("TOMBSTONE")
      && src("app/dashboard/superadmin/platform/page.tsx").includes("CRON_SNAPSHOT_STATUSES")
      && src("lib/platform/ai-ops.ts").includes("TOMBSTONE"),
  )
  check(
    "the DDL comment no longer claims a vocabulary the writers do not produce",
    !/last_status\s+text,\s*--.*partial/.test(src("scripts/1053-pl-truth-engine-cron-health.sql")),
  )
}

function sevenDayLayer() {
  console.log("\n[the 7-day counts — a number that could only ever be zero]")
  const k = kernel

  check(
    "recomputeCronSevenDayCounts exists and writes BOTH counts",
    /export async function recomputeCronSevenDayCounts/.test(k)
      && /run_count_7d:\s*run7d/.test(k)
      && /failure_count_7d:\s*fail7d/.test(k),
  )
  check(
    "it RECOMPUTES rather than increments — a 7d window has to decay",
    !/run_count_7d:\s*\(?[^)]*\+\s*1/.test(k) && /\.update\(\{\s*run_count_7d/.test(k),
  )
  check(
    "it counts the LEDGER's failure words, not the SNAPSHOT's",
    LEDGER_FAILURE_STATUSES.includes("failed" as never)
      && LEDGER_FAILURE_STATUSES.includes("timeout" as never)
      && !(LEDGER_FAILURE_STATUSES as readonly string[]).includes("failure"),
  )
  check(
    "a refused count is NOT written as a zero (a blind guard must not read clean)",
    /if \(runR\.error \|\| failR\.error\)/.test(k) && /return false/.test(k),
  )
  check(
    "it uses exact counts, not a page that could silently truncate to an undercount",
    /count:\s*"exact",\s*head:\s*true/.test(k),
  )

  const route = stripComments(src("app/api/cron/health-check/route.ts"))
  check(
    "the recompute is actually INVOKED (a writer nothing calls is the same defect)",
    /await recomputeCronSevenDayCounts\(\)/.test(route),
  )
  check(
    "its host route is a cron lib/kernel/cron-dispatch.ts really schedules",
    CRON_REGISTRY.some((r) => r.path === "/api/cron/health-check"),
  )
  check(
    "a refused recompute does not flip the health sweep itself to failed",
    /NOT counted into `writeFailures`/.test(src("app/api/cron/health-check/route.ts")),
  )
  check(
    "the recompute is NOT published as a \"use server\" export (§4: that is a public endpoint)",
    !/recomputeCronSevenDayCounts/.test(src("app/actions/cron-kernel.ts")),
  )

  // The consequence, at the two surfaces that were reading the permanent zero.
  check(
    "platform-overview still counts failure_count_7d into `failing` (now that it can move)",
    /failure_count_7d > 0/.test(stripComments(src("app/actions/superadmin/platform-overview.ts"))),
  )
  check(
    "ai-ops still hands failure7d to the console (now that it can move)",
    /failure7d:\s*c\.failure_count_7d/.test(stripComments(src("lib/platform/ai-ops.ts"))),
  )
}

// ─── POSITIVE CONTROLS ────────────────────────────────────────────────────────
//
// A broken regex and a clean tree both report zero. Each control re-runs the
// finder against a synthetic file carrying the exact defect the finder exists
// for, and asserts it is caught.
function controls() {
  console.log("\n[positive controls — prove each finder still recognises its defect]")

  const dir = mkdtempSync(join(tmpdir(), "cron-vocab-control-"))
  try {
    // C1 — a reader branching on a word no writer writes.
    const f1 = join(dir, "reintroduced.ts")
    writeFileSync(f1, 'export const x = (r: any) => r.last_status === "partial"\n')
    const c1 = findReaders([f1])
    check("C1 the reader finder catches a reintroduced 'partial' comparison", c1.some((h) => h.word === "partial"))

    // C2 — the same word, but only inside a comment. Must NOT be counted, or
    // every tombstone in this change would read as a live reader.
    const f2 = join(dir, "tombstone-only.ts")
    writeFileSync(f2, '// TOMBSTONE: last_status === "partial" is deleted\nexport const y = 1\n')
    check("C2 a word named only in a comment is NOT counted a reader", findReaders([f2]).length === 0)

    // C3 — the strict-inequality spelling is caught too, not just `===`.
    const f3 = join(dir, "negated.ts")
    writeFileSync(f3, 'export const z = (r: any) => r.last_status !== "bogus_word"\n')
    check("C3 the finder catches `!==` comparisons, not only `===`", findReaders([f3]).some((h) => h.word === "bogus_word"))

    // C4 — single-quoted literal (the tree mixes both).
    const f4 = join(dir, "single-quoted.ts")
    writeFileSync(f4, "export const w = (r: any) => r.last_status === 'other_word'\n")
    check("C4 the finder catches single-quoted literals", findReaders([f4]).some((h) => h.word === "other_word"))

    // C7 — the STRING case, which is what actually broke this guard's first
    // run. A word quoted inside a string literal (registry prose, a log line, a
    // test fixture) is not a reader, and must not be counted as one — while a
    // real comparison in the SAME file still is.
    const f7 = join(dir, "prose-in-a-string.ts")
    // Backticks, because the fixture must contain BOTH quote kinds — this is the
    // literal shape of the MAINTENANCE_DOMAINS prose that tripped the first run.
    writeFileSync(f7, [
      `export const doc = { what: "we deleted last_status === 'error' here" }`,
      `export const real = (r: any) => r.last_status === "failure"`,
      ``,
    ].join("\n"))
    const c7 = findReaders([f7])
    check("C7 a word quoted inside a STRING is not counted a reader",
      !c7.some((h) => h.word === "error"))
    check("C7 …and a real comparison in the same file still IS counted",
      c7.some((h) => h.word === "failure"))

    // C5 — the writer finder. A new writer word must be seen, or the
    // reader⊆writer assertion would pass by being blind on the wrong side.
    const synthetic = stripComments('.upsert({ last_status: "quarantined", cron_name: n })')
    check("C5 the writer finder catches a newly-introduced writer word",
      [...synthetic.matchAll(/last_status:\s*["']([^"']+)["']/g)].some((m) => m[1] === "quarantined"))

    // C6 — the corpus is non-empty. If SCAN_DIRS ever stopped resolving, every
    // absence assertion above would pass on an empty file list.
    check(`C6 the sweep actually walked the tree (${FILES.length} .ts/.tsx files)`, FILES.length > 500)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log("══════════════════════════════════════════════════")
console.log(" cron_health_snapshot — one status vocabulary, and 7d counts that move")
console.log("══════════════════════════════════════════════════")
console.log(`  corpus: ${FILES.length} source files · ${readers.length} last_status comparison(s)`)
console.log("  BLIND SPOTS, stated beside the numbers:")
console.log("   · a comparison built from a VARIABLE (`last_status === s`) is invisible to this sweep;")
console.log("     0 such sites exist today, and a new one would pass unexamined.")
console.log("   · the sweep covers app/ lib/ components/ only — a status word compared inside")
console.log("     scripts/ or supabase/ is out of corpus by design (neither renders to a user).")
console.log("   · the table carries NO CHECK constraint, so this guard is the ONLY thing holding")
console.log("     the vocabulary; the database will accept any string a future writer invents.")

vocabularyLayer()
sevenDayLayer()
controls()

console.log("\n──────────────────────────────────────────────────")
console.log(` ${pass} passed · ${fail} failed`)
if (fail > 0) {
  for (const f of fails) console.log(`   ✗ ${f}`)
  console.log(" ❌ CRON_STATUS_VOCABULARY_FAIL")
  process.exit(1)
}
console.log(" ✅ CRON_STATUS_VOCABULARY_PASS — writers and readers speak the same words")
