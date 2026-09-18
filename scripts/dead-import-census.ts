#!/usr/bin/env tsx
/**
 * scripts/dead-import-census.ts   (npm run test:dead-imports — NOT YET REGISTERED,
 * see the report that shipped this file for the exact package.json/guard/
 * MAINTENANCE_DOMAINS lines an integrator must add)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE NAMED IMPORT NOBODY IN THE FILE EVER NAMES AGAIN.
 *
 * A full `tsc --noEmit --noUnusedLocals` run OOMs this repo (CLAUDE.md §7), so
 * this is the grep-based substitute the census asked for: for every
 * `import { X, Y as Z } from "…"` clause under app/ and lib/, does the LOCAL
 * binding (`X`, or `Z` for an aliased one) appear anywhere else in that same
 * file? If not, the import is dead weight — a symbol dragged in and never
 * spent, which either used to be called and stopped (a tombstone left the
 * import behind), or was never called at all.
 *
 * SCOPE, ON PURPOSE. Only the `{ … }` NAMED clause is scanned — a default
 * import (`import Foo from …`) or a namespace import (`import * as ns from …`)
 * is not, because a default export's local name is caller-chosen and far more
 * often re-exported or spread than a named one, which would raise the false-
 * positive rate for a lightweight scan not worth the complexity here. Type-only
 * specifiers (`import { type X }` or a whole `import type { X }` statement)
 * ARE scanned — an unused type import is exactly as dead as an unused value
 * one, and TypeScript accepts both spellings.
 *
 * ── MEASUREMENT DISCIPLINE (§2) ────────────────────────────────────────────
 * Parsed from `stripComments` (a commented-out import is not a live import,
 * and line numbers must survive so the report can be acted on) and matched
 * against `blankStrings` (a mention of the same name inside a string or
 * template — an error message, a narrative comment-turned-string — is not a
 * USE; blanking strings is what stops that from reading as "referenced").
 * The import clause's own span is excised from the haystack before the
 * search, so the declaration itself is never mistaken for a second use.
 *
 * BLIND SPOTS, published beside the number:
 *   · A name used only inside JSX TEXT (`<p>Something}</p>` mentioning it as
 *     prose) still counts as "used" — blankStrings deliberately never masks
 *     JSX text (see strip-comments.ts's own stated blind spot), so this scan
 *     inherits it. Under-accusing, not over-accusing.
 *   · A name re-exported bare (`export { X }`) or used only in a JSDoc `@see`
 *     counts as used — the word-boundary search does not distinguish an
 *     `export { X }` from a real call site. Re-exporting is a legitimate use.
 *   · Two import statements naming the same local twice in one file (a rare,
 *     already-invalid-TS shape) are not modelled specially; each clears the
 *     other as a "use" of itself. Not observed in this tree.
 *   · A file that imports the SAME name from two different modules is legal
 *     TypeScript only when one is `import type` and the type is never used as
 *     a value — this scan does not attempt to disambiguate which import a use
 *     resolves to, so both are treated as used the moment the name appears
 *     anywhere outside either import span. Under-accusing.
 *
 * SCRAPING IS FROZEN (wave 55 lane rules): findings under any path this repo's
 * scraping freeze names are reported separately as excluded debt, never
 * counted against PASS/FAIL, and never auto-fixed by this file.
 */
import { readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { walkTs } from "./runtime-roots"
import { stripComments, blankStrings } from "./strip-comments"

const root = process.cwd()

/** The wave-55 scraping freeze, restated here rather than imported — this file
 *  has no reason to depend on frozen code, and the freeze list is short enough
 *  to keep in sync by eye against CLAUDE.md's lane rules. A path matches if it
 *  STARTS WITH one of these (file) or CONTAINS one as a path segment (dir). */
const SCRAPING_PATH_PREFIXES = [
  "lib/lead-pipeline/",
  "lib/external/",
  "app/actions/lead-intelligence.ts",
  "lib/kernel/intent-campaign.ts",
  "lib/kernel/scraping.ts",
  "app/actions/lead-scraping-config.ts",
  "app/api/cron/lead-scraping/",
]

function isScrapingPath(relPath: string): boolean {
  return SCRAPING_PATH_PREFIXES.some((p) => relPath === p || relPath.startsWith(p))
}

export interface DeadImport {
  file: string
  line: number
  name: string
  source: string
}

/** Matches a full named-import statement, `type` prefix optional, one optional
 *  default binding before the brace optional, multi-line clauses included. */
const IMPORT_RE = /import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g

/** One `{ … }` clause split into its specifiers, alias resolved to the LOCAL
 *  binding the rest of the file would actually reference. */
function specifiers(clause: string): string[] {
  return clause
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^type\s+/, ""))
    .map((s) => {
      const asMatch = s.match(/^([\w$]+)\s+as\s+([\w$]+)$/)
      return asMatch ? asMatch[2] : s
    })
    .filter((s) => /^[A-Za-z_$][\w$]*$/.test(s))
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++
  return line
}

/** Every dead named import in one file's source. */
export function deadImportsInSource(src: string): DeadImport[] {
  const stripped = stripComments(src)
  const masked = blankStrings(src)
  const out: DeadImport[] = []
  IMPORT_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = IMPORT_RE.exec(stripped))) {
    const [full, clause, source] = m
    const start = m.index
    const end = start + full.length
    const rest = masked.slice(0, start) + masked.slice(end)
    for (const name of specifiers(clause)) {
      const used = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(rest)
      if (!used) out.push({ file: "", line: lineOf(stripped, start), name, source })
    }
  }
  return out
}

function scan(dirs: string[]): DeadImport[] {
  const findings: DeadImport[] = []
  for (const dir of dirs) {
    for (const abs of walkTs(join(root, dir))) {
      const rel = relative(root, abs).split(sep).join("/")
      let src: string
      try { src = readFileSync(abs, "utf8") } catch { continue }
      for (const f of deadImportsInSource(src)) findings.push({ ...f, file: rel })
    }
  }
  return findings
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE CONTROLS (§2 — an absence claim is worthless without one)
// ─────────────────────────────────────────────────────────────────────────────
function positiveControls(): string[] {
  const problems: string[] = []
  const expect = (name: string, cond: boolean) => { if (!cond) problems.push(name) }

  expect(
    "an unused named import is flagged",
    deadImportsInSource('import { useEffect } from "react"\nconst x = 1\n').some((d) => d.name === "useEffect"),
  )
  expect(
    "a used named import is NOT flagged",
    deadImportsInSource('import { useEffect } from "react"\nuseEffect(() => {}, [])\n').length === 0,
  )
  expect(
    "an aliased import is checked under its LOCAL name, not the exported one",
    (() => {
      const found = deadImportsInSource('import { foo as bar } from "./x"\nbar()\n')
      return found.length === 0
    })(),
  )
  expect(
    "an aliased import that is never called under its local name IS flagged",
    deadImportsInSource('import { foo as bar } from "./x"\nconst y = 1\n').some((d) => d.name === "bar"),
  )
  expect(
    "a type-only specifier is scanned like any other",
    deadImportsInSource('import { type Foo } from "./types"\nconst y = 1\n').some((d) => d.name === "Foo"),
  )
  expect(
    "a mention inside a STRING does not count as a use (blankStrings, not raw source)",
    deadImportsInSource('import { widgetLabel } from "./labels"\nconst msg = "widgetLabel is a helper"\n').some(
      (d) => d.name === "widgetLabel",
    ),
  )
  expect(
    "a mention inside a COMMENT does not count as a use",
    deadImportsInSource('import { widgetLabel } from "./labels"\n// widgetLabel used to live here\nconst y = 1\n').some(
      (d) => d.name === "widgetLabel",
    ),
  )
  expect(
    "a JSX use of the imported component counts as a use",
    deadImportsInSource('import { Panel } from "./panel"\nfunction C() { return <Panel /> }\n').length === 0,
  )
  expect(
    "a default import is out of scope (not flagged either way)",
    deadImportsInSource('import Foo from "./foo"\nconst y = 1\n').length === 0,
  )
  return problems
}

// ─────────────────────────────────────────────────────────────────────────────
if (typeof process !== "undefined" && /dead-import-census\.ts$/.test(process.argv[1] ?? "")) {
  const listMode = process.argv.includes("--list")
  const problems = positiveControls()
  if (problems.length) {
    console.log("✗ dead-import-census positive controls — the scanner no longer recognises:")
    for (const p of problems) console.log("   - " + p)
    process.exit(1)
  }

  const findings = scan(["app", "lib"]).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  const scraping = findings.filter((f) => isScrapingPath(f.file))
  const live = findings.filter((f) => !isScrapingPath(f.file))

  console.log("═".repeat(70))
  console.log(" DEAD-IMPORT CENSUS — a named import nothing in its file uses again")
  console.log("═".repeat(70))
  console.log(`  ${findings.length} dead named import(s) across app/ + lib/`)
  console.log(`  ${scraping.length} under the wave-55 scraping freeze — excluded from PASS/FAIL, never auto-fixed`)
  console.log(`  ${live.length} live (non-scraping) — the burn-down list`)
  console.log("")
  console.log("  BLIND SPOTS: JSX-text mentions and bare re-exports read as USED (under-")
  console.log("  accusing); a default/namespace import is out of scope entirely; two")
  console.log("  same-named imports from different modules in one file both read as used.")

  if (findings.length > 0 || listMode) {
    console.log("")
    for (const f of live) console.log(`  ✗ ${f.file}:${f.line}  ${f.name}  (from "${f.source}")`)
    for (const f of scraping) console.log(`  ⏭ ${f.file}:${f.line}  ${f.name}  (from "${f.source}") — FROZEN, excluded`)
  }

  console.log("")
  if (live.length > 0) {
    console.log(`✗ DEAD_IMPORT_CENSUS_FAIL — ${live.length} non-scraping dead import(s) to remove`)
    process.exit(listMode ? 0 : 1)
  }
  console.log("✅ DEAD_IMPORT_CENSUS_PASS — no non-scraping dead named import")
}
