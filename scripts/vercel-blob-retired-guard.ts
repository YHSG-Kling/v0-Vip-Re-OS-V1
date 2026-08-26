// scripts/vercel-blob-retired-guard.ts   (npm run test:vercel-blob-retired)
// ─────────────────────────────────────────────────────────────────────────────
// PROVES VERCEL BLOB IS GONE, AND PROVES THE FINDER WOULD NOTICE IF IT CAME BACK.
//
// Owner ruling (2026-08-26): "supabase buckets should be used for any file
// storage." Nineteen files imported @vercel/blob when that ruling landed; this
// guard is the ratchet that keeps the number at zero.
//
// ── WHY THIS FILE IS SHAPED THE WAY IT IS (CLAUDE.md §2) ────────────────────
//
// 1. IT READS COMMENT-STRIPPED SOURCE. Every deletion in this migration left a
//    tombstone naming its survivor, as §1 requires, and a tombstone for THIS
//    migration necessarily spells `@vercel/blob`. A guard reading raw source
//    would count all ~24 of those tombstones as live importers and report the
//    migration as un-done — going red BECAUSE the orphan doctrine was followed.
//    That is not hypothetical; §2 records five guards failing exactly this way
//    in one wave on one JSDoc block. stripComments is the one correct scanner.
//
// 2. IT ALSO BLANKS STRINGS for the import scan. scripts/cda-storage-simulator.ts
//    contains the literal `'await import("@vercel/blob")'` inside an assertion
//    that the string is ABSENT from a source file. That is a specimen, not an
//    import, and counting it would make this guard permanently red with nothing
//    to fix. blankStrings is what tells the two apart.
//
// 3. IT CARRIES A POSITIVE CONTROL. "0 importers found" is what a clean tree and
//    a broken regex both print. So --negative writes a real importer into a
//    scratch file, re-runs the finder, and requires it to go RED. An absence
//    assertion with no positive control is decoration.
//
// 4. IT ASSERTS THE RULE, NOT A WAYPOINT. It does not hardcode "19 files
//    migrated" or the names of the survivors — those were true on one day. It
//    asserts that ZERO importers exist and that the dependency is absent, both
//    of which stay true as the tree changes around them.

import { readFileSync, readdirSync, statSync, writeFileSync, unlinkSync, existsSync } from "node:fs"
import { join, relative } from "node:path"
import { blankComments, blankStrings } from "./strip-comments"

const ROOT = process.cwd()
const RUN_NEGATIVE = process.argv.includes("--negative")

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

const SKIP = new Set(["node_modules", ".next", ".git", "dist", "build", ".vercel", "coverage"])

function sourceFiles(): string[] {
  const out: string[] = []
  ;(function walk(dir: string) {
    for (const entry of readdirSync(dir)) {
      if (SKIP.has(entry)) continue
      const p = join(dir, entry)
      if (statSync(p).isDirectory()) walk(p)
      else if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry)) out.push(p)
    }
  })(ROOT)
  return out
}

/**
 * An IMPORT SITE, not a mention. Static `from "@vercel/blob"`, `require(...)`
 * and dynamic `import(...)` are all real wiring; the same text in a comment or
 * a string literal is not, and is masked out before this runs.
 */
const IMPORT_SITE =
  /(?:from\s*["'`]@vercel\/blob(?:\/[^"'`]*)?["'`]|require\(\s*["'`]@vercel\/blob(?:\/[^"'`]*)?["'`]\s*\)|import\(\s*["'`]@vercel\/blob(?:\/[^"'`]*)?["'`]\s*\))/g

/**
 * The finder, isolated so the positive control can re-run exactly this and
 * nothing else. Returns `file:line` for every live import site.
 *
 * The mask is blankComments THEN blankStrings, both from the one scanner: the
 * first removes tombstones, the second removes specimens. A module specifier is
 * itself a string, so blankStrings alone would blank every real import too —
 * which is why the regex is run against the COMMENT-stripped text and
 * string-blanking is used only to decide whether a hit sits inside a literal.
 */
function findImporters(files: string[]): string[] {
  const hits: string[] = []
  for (const file of files) {
    const raw = readFileSync(file, "utf8")
    if (!raw.includes("@vercel/blob")) continue

    const noComments = blankComments(raw)
    const noStrings = blankStrings(noComments)

    IMPORT_SITE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = IMPORT_SITE.exec(noComments))) {
      // DISCRIMINATE ON THE KEYWORD, NOT ON THE SPECIFIER. The specifier is
      // itself a string literal, so blankStrings erases it for a REAL import
      // exactly as it does for a specimen — testing it cannot tell them apart,
      // and a first cut of this guard that did so reported both as clean and
      // then flagged its own fixtures. What separates them is where the
      // `from` / `import(` / `require(` KEYWORD lives: real wiring has it in
      // code, a specimen has it inside a quoted literal. If the character the
      // match starts on survives string-blanking, the keyword is code.
      const startChar = noComments[m.index]
      const keywordIsCode = startChar !== undefined && noStrings[m.index] === startChar
      if (!keywordIsCode) continue
      hits.push(`${relative(ROOT, file)}:${noComments.slice(0, m.index).split("\n").length}`)
    }
  }
  return hits
}

console.log("\n── no source file imports @vercel/blob ──")
const files = sourceFiles()
const importers = findImporters(files)
check(
  `zero @vercel/blob import sites across ${files.length} source files`,
  importers.length === 0,
  importers.join(" · "),
)

console.log("\n── the dependency is out of package.json ──")
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const inDeps = "@vercel/blob" in (pkg.dependencies ?? {})
  const inDev = "@vercel/blob" in (pkg.devDependencies ?? {})
  check("@vercel/blob is not a dependency", !inDeps && !inDev, inDeps ? "still in dependencies" : "still in devDependencies")

  // The dependency may ONLY be absent when nothing imports it. Removing it while
  // an importer survives is a broken build, not a completed migration — so the
  // two facts are checked together rather than as independent good news.
  check(
    "…and that is safe, because there are no importers",
    !(!inDeps && !inDev && importers.length > 0),
    "the dependency was removed while importers remain",
  )
}

console.log("\n── the browser upload survivor is wired ──")
{
  const helper = join(ROOT, "lib/storage/browser-upload.ts")
  const route = join(ROOT, "app/api/storage/signed-upload/route.ts")
  check("lib/storage/browser-upload.ts exists", existsSync(helper))
  check("app/api/storage/signed-upload/route.ts exists", existsSync(route))
  check("the deleted Vercel Blob route is gone", !existsSync(join(ROOT, "app/api/blob/upload/route.ts")))

  if (existsSync(route)) {
    const src = blankComments(readFileSync(route, "utf8"))
    // The tenant must come from the SESSION (CLAUDE.md §4). Asserted on the
    // resolver's NAME because that is the seam — a route that stopped calling it
    // would be trusting the request body again.
    check("the mint route resolves the tenant from the session", /resolveWriteContextForTenant\s*\(/.test(src))
    check("the mint route does not read a bucket or path from the body", !/body\.(bucket|path|pathname|brokerageId)/.test(src))
  }
}

// ═══ POSITIVE CONTROL ═══════════════════════════════════════════════════════
// Without this, a regex that matches nothing and a tree with nothing to match
// print the identical line.
if (RUN_NEGATIVE) {
  console.log("\nPOSITIVE CONTROL (the finder must go RED on a real importer)")
  const fixture = join(ROOT, "lib/storage/__blob-control-fixture.ts")
  try {
    writeFileSync(fixture, 'import { put } from "@vercel/blob"\nexport const x = put\n', "utf8")
    const found = findImporters([fixture])
    check("a planted `import { put } from \"@vercel/blob\"` IS detected", found.length === 1, `found ${found.length}`)
  } finally {
    if (existsSync(fixture)) unlinkSync(fixture)
  }
  check("the fixture was removed again", !existsSync(fixture))

  // And the counterpart: the finder must NOT be fooled by a tombstone or a
  // string specimen, which is the failure mode that would make it useless.
  const tombstone = join(ROOT, "lib/storage/__blob-tombstone-fixture.ts")
  try {
    writeFileSync(
      tombstone,
      '// Was `import { put } from "@vercel/blob"`. Survivor: lib/remotion/media-host.ts\n' +
        'const specimen = \'await import("@vercel/blob")\'\nexport const y = specimen\n',
      "utf8",
    )
    const found = findImporters([tombstone])
    check("a tombstone comment and a string specimen are NOT counted", found.length === 0, found.join(" · "))
  } finally {
    if (existsSync(tombstone)) unlinkSync(tombstone)
  }
}

console.log(
  `\n RESULT: ${passed} passed, ${failed} failed` +
    `\n  denominator: ${files.length} source files scanned (excluded: ${[...SKIP].join(", ")}).` +
    "\n  Import sites are counted on COMMENT-STRIPPED source with string literals masked," +
    "\n  so tombstones and guard fixtures naming @vercel/blob are correctly not counted." +
    (RUN_NEGATIVE ? "" : "\n  Run with --negative to exercise the positive control."),
)
if (failed > 0) { console.log(" ❌ VERCEL_BLOB_RETIRED_FAIL"); process.exit(1) }
console.log(" ✅ VERCEL_BLOB_RETIRED_PASS — all file storage is Supabase buckets")
