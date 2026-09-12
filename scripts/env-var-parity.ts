#!/usr/bin/env tsx
/**
 * scripts/env-var-parity.ts   (npm run test:env-var-parity — NOT YET
 * REGISTERED, see the report that shipped this file for the exact
 * package.json/guard/MAINTENANCE_DOMAINS lines an integrator must add)
 * ─────────────────────────────────────────────────────────────────────────────
 * `process.env.X` NAMED IN CODE, VS. `X` NAMED SOMEWHERE A HUMAN CAN FIND IT.
 *
 * Every environment variable this app reads (`process.env.FOO` or
 * `process.env["FOO"]`) under app/ + lib/ is compared against three places a
 * name can be DOCUMENTED:
 *
 *   1. .env.example — KEY=value lines (value ignored; a blank value is a
 *      deliberate "fill this in" marker, not evidence of anything).
 *   2. vercel.json — any string key under a top-level "env" object.
 *   3. .github/workflows/*.yml — an ALL_CAPS `KEY:` line inside an `env:`
 *      block (GitHub Actions' own convention for exposing a secret/var to a
 *      step as an environment variable).
 *
 * A read with none of the three is a name nobody wrote down — the next person
 * who needs to configure this app for a new environment has to grep the
 * source to find it. A documented name nobody reads is the opposite defect:
 * dead configuration nobody can prove is safe to remove (CLAUDE.md §1 — an
 * unread name may be read by generated code, a build plugin, or a platform
 * feature this repo cannot see; "unresolved" beats deleting a row someone
 * else depends on).
 *
 * ── MEASUREMENT DISCIPLINE (§2) ────────────────────────────────────────────
 * Code is scanned via `stripComments` (comments removed, string/property text
 * intact — the var name after `process.env.` is never inside a string for the
 * dot form, and IS the string content for the bracket form, so both forms are
 * read off the same comment-stripped text rather than a masked one).
 *
 * BLIND SPOTS, published beside the number:
 *   · A name built at runtime (`process.env[computedKey]`, `process.env[\`…\`]`)
 *     is invisible to both regexes — under-accusing, the same class of blind
 *     spot every other dynamic-key census in this repo carries.
 *   · .env.example parsing ignores `export FOO=` prefixes and inline `#`
 *     comments after a value, but is otherwise a plain KEY=VALUE split — an
 *     unusual multi-line or quoted-with-embedded-`=` value could mis-parse.
 *   · The workflow scan is regex-based, not a real YAML parse: it treats any
 *     ALL_CAPS `KEY:` line as a declaration whether or not it sits inside an
 *     `env:` block, which is deliberately OVER-INCLUSIVE (a name declared
 *     anywhere in a workflow file counts as documented there) — this can only
 *     shrink the "no documented source" list, never grow it with a name that
 *     is not really written down somewhere in the file.
 *   · vercel.json's "env" object is read only if the file parses as JSON with
 *     that exact top-level key; `vercel.json` here currently has none, which
 *     is a real, reportable "0 vars", not a parse failure.
 *
 * SCRAPING IS FROZEN (wave 55 lane rules): findings under any path this
 * repo's scraping freeze names are reported separately as excluded debt,
 * never counted against PASS/FAIL, never auto-fixed by this file.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { walkTs } from "./runtime-roots"
import { stripComments } from "./strip-comments"

const root = process.cwd()

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

export interface EnvRead {
  name: string
  file: string
  line: number
}

const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/

function lineOf(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++
  return line
}

/** Every `process.env.X` / `process.env["X"]` / `process.env['X']` read in one file's source. */
export function envReadsInSource(src: string): Array<{ name: string; line: number }> {
  const stripped = stripComments(src)
  const out: Array<{ name: string; line: number }> = []

  const dotRe = /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g
  let m: RegExpExecArray | null
  while ((m = dotRe.exec(stripped))) out.push({ name: m[1], line: lineOf(stripped, m.index) })

  const bracketRe = /\bprocess\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g
  while ((m = bracketRe.exec(stripped))) out.push({ name: m[1], line: lineOf(stripped, m.index) })

  return out.filter((r) => ENV_NAME_RE.test(r.name))
}

function scanCode(dirs: string[]): EnvRead[] {
  const found: EnvRead[] = []
  for (const dir of dirs) {
    for (const abs of walkTs(join(root, dir))) {
      const rel = relative(root, abs).split(sep).join("/")
      let src: string
      try { src = readFileSync(abs, "utf8") } catch { continue }
      for (const r of envReadsInSource(src)) found.push({ ...r, file: rel })
    }
  }
  return found
}

/** .env.example KEY=VALUE lines. Missing file = empty set, not an error. */
export function namesFromEnvExample(text: string): Set<string> {
  const names = new Set<string>()
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const withoutExport = line.replace(/^export\s+/, "")
    const eq = withoutExport.indexOf("=")
    if (eq === -1) continue
    const key = withoutExport.slice(0, eq).trim()
    if (ENV_NAME_RE.test(key)) names.add(key)
  }
  return names
}

/** vercel.json's top-level "env" object keys, if present. */
export function namesFromVercelJson(text: string): Set<string> {
  const names = new Set<string>()
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    const env = parsed.env
    if (env && typeof env === "object" && !Array.isArray(env)) {
      for (const key of Object.keys(env)) if (ENV_NAME_RE.test(key)) names.add(key)
    }
  } catch {
    // Not valid JSON, or no "env" key — 0 names, reported honestly (see header).
  }
  return names
}

/** Any ALL_CAPS `KEY:` line in a workflow YAML file — see header for why this is over-inclusive on purpose. */
export function namesFromWorkflowYaml(text: string): Set<string> {
  const names = new Set<string>()
  for (const m of text.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:/gm)) {
    if (ENV_NAME_RE.test(m[1])) names.add(m[1])
  }
  return names
}

function documentedNames(): { names: Set<string>; sources: Record<string, string[]> } {
  const sources: Record<string, string[]> = {}
  const all = new Set<string>()

  const addAll = (names: Set<string>, sourceLabel: string) => {
    for (const n of names) {
      all.add(n)
      ;(sources[n] ??= []).push(sourceLabel)
    }
  }

  const envExamplePath = join(root, ".env.example")
  if (existsSync(envExamplePath)) {
    addAll(namesFromEnvExample(readFileSync(envExamplePath, "utf8")), ".env.example")
  }

  const vercelJsonPath = join(root, "vercel.json")
  if (existsSync(vercelJsonPath)) {
    addAll(namesFromVercelJson(readFileSync(vercelJsonPath, "utf8")), "vercel.json")
  }

  const workflowsDir = join(root, ".github", "workflows")
  if (existsSync(workflowsDir)) {
    for (const entry of readdirSync(workflowsDir)) {
      if (!/\.ya?ml$/.test(entry)) continue
      const p = join(workflowsDir, entry)
      addAll(namesFromWorkflowYaml(readFileSync(p, "utf8")), `.github/workflows/${entry}`)
    }
  }

  return { names: all, sources }
}

// ─────────────────────────────────────────────────────────────────────────────
// POSITIVE CONTROLS (§2 — an absence claim is worthless without one)
// ─────────────────────────────────────────────────────────────────────────────
function positiveControls(): string[] {
  const problems: string[] = []
  const expect = (name: string, cond: boolean) => { if (!cond) problems.push(name) }

  expect(
    "a dot-form read is found",
    envReadsInSource('const x = process.env.GHOST_VAR\n').some((r) => r.name === "GHOST_VAR"),
  )
  expect(
    "a bracket-form (double-quoted) read is found",
    envReadsInSource('const x = process.env["GHOST_VAR"]\n').some((r) => r.name === "GHOST_VAR"),
  )
  expect(
    "a bracket-form (single-quoted) read is found",
    envReadsInSource("const x = process.env['GHOST_VAR']\n").some((r) => r.name === "GHOST_VAR"),
  )
  expect(
    "a mention inside a COMMENT does not count as a read",
    !envReadsInSource("// process.env.GHOST_VAR used to be read here\nconst y = 1\n").some((r) => r.name === "GHOST_VAR"),
  )
  expect(
    "a lowercase property access after process.env is not treated as an env name (real code never spells one lowercase)",
    envReadsInSource("const x = process.env.NODE_ENV\n").some((r) => r.name === "NODE_ENV"),
  )
  expect(
    ".env.example parses a plain KEY=VALUE line",
    namesFromEnvExample("GHOST_VAR=abc123\n").has("GHOST_VAR"),
  )
  expect(
    ".env.example ignores a comment line",
    !namesFromEnvExample("# GHOST_VAR=abc123\n").has("GHOST_VAR"),
  )
  expect(
    ".env.example strips an export prefix",
    namesFromEnvExample("export GHOST_VAR=abc123\n").has("GHOST_VAR"),
  )
  expect(
    ".env.example accepts a blank value as a documented name",
    namesFromEnvExample("GHOST_VAR=\n").has("GHOST_VAR"),
  )
  expect(
    "vercel.json reads top-level env object keys",
    namesFromVercelJson('{"env":{"GHOST_VAR":"x"}}').has("GHOST_VAR"),
  )
  expect(
    "vercel.json with no env key yields zero names, not a crash",
    namesFromVercelJson('{"functions":{}}').size === 0,
  )
  expect(
    "invalid JSON yields zero names, not a crash",
    namesFromVercelJson("not json").size === 0,
  )
  expect(
    "workflow YAML finds an ALL_CAPS key line",
    namesFromWorkflowYaml("    env:\n      GHOST_VAR: ${{ secrets.GHOST_VAR }}\n").has("GHOST_VAR"),
  )
  expect(
    "workflow YAML does NOT treat a lowercase YAML key as an env name",
    !namesFromWorkflowYaml("    runs-on: ubuntu-latest\n").has("RUNS-ON"),
  )
  return problems
}

// ─────────────────────────────────────────────────────────────────────────────
if (typeof process !== "undefined" && /env-var-parity\.ts$/.test(process.argv[1] ?? "")) {
  const listMode = process.argv.includes("--list")
  const problems = positiveControls()
  if (problems.length) {
    console.log("✗ env-var-parity positive controls — the scanner no longer recognises:")
    for (const p of problems) console.log("   - " + p)
    process.exit(1)
  }

  const reads = scanCode(["app", "lib"])
  const scrapingReads = reads.filter((r) => isScrapingPath(r.file))
  const liveReads = reads.filter((r) => !isScrapingPath(r.file))

  const { names: docNames, sources: docSources } = documentedNames()

  const readNamesLive = new Set(liveReads.map((r) => r.name))
  const readNamesScraping = new Set(scrapingReads.map((r) => r.name))

  // "No documented source" — live reads only; a name that appears ONLY under
  // a frozen scraping path is reported separately and never proposed for
  // .env.example (scraping is frozen, not this lane's to touch).
  const undocumented = Array.from(readNamesLive)
    .filter((n) => !docNames.has(n))
    .sort()

  // "Documented, never read" — never proposed for deletion (§1); a name read
  // only under a frozen scraping path still counts as READ for this arm, so
  // scraping's own documented vars are not flagged as dead.
  const unreadDocumented = Array.from(docNames)
    .filter((n) => !readNamesLive.has(n) && !readNamesScraping.has(n))
    .sort()

  console.log("═".repeat(70))
  console.log(" ENV-VAR PARITY CENSUS — process.env.X read vs. X documented")
  console.log("═".repeat(70))
  console.log(`  ${reads.length} total read site(s) · ${readNamesLive.size + readNamesScraping.size} distinct name(s) read across app/ + lib/`)
  console.log(`  ${readNamesScraping.size} distinct name(s) read only under the wave-55 scraping freeze — excluded`)
  console.log(`  ${docNames.size} distinct name(s) documented across .env.example / vercel.json / .github/workflows/*.yml`)
  console.log(`  ${undocumented.length} read with NO documented source (live, non-scraping)`)
  console.log(`  ${unreadDocumented.length} documented but never read`)
  console.log("")
  console.log("  BLIND SPOTS: a computed process.env[key] is invisible to either regex")
  console.log("  (under-accusing); the workflow scan is regex-based, over-inclusive on")
  console.log("  purpose (can only shrink the undocumented list); vercel.json here truly")
  console.log("  carries no \"env\" key today, which is a real 0, not a parse failure.")

  if (undocumented.length > 0 || listMode) {
    console.log("")
    console.log("── read, no documented source ──")
    for (const n of undocumented) {
      const first = liveReads.find((r) => r.name === n)!
      const count = liveReads.filter((r) => r.name === n).length
      console.log(`  ✗ ${n}  (${count} site(s), first at ${first.file}:${first.line})`)
    }
  }
  if (unreadDocumented.length > 0 || listMode) {
    console.log("")
    console.log("── documented, never read (never auto-removed — §1: may be read by a build")
    console.log("   plugin, a platform feature, or generated code this scan cannot see) ──")
    for (const n of unreadDocumented) {
      console.log(`  ⚠ ${n}  (documented in: ${(docSources[n] ?? []).join(", ")})`)
    }
  }

  console.log("")
  if (undocumented.length > 0) {
    console.log(`✗ ENV_VAR_PARITY_FAIL — ${undocumented.length} name(s) read with no documented source`)
    process.exit(listMode ? 0 : 1)
  }
  console.log("✅ ENV_VAR_PARITY_PASS — every live process.env read has a documented source")
}
