#!/usr/bin/env tsx
/**
 * scripts/data-guard-guard.ts  (npm run test:data-guard-guard) — pure, no DB.
 *
 * THE DATA GUARD ratchet — the model-boundary twin of the egress-send-guard. The Data Guard
 * (lib/data-guard) redacts high-confidence secrets (SSN/ITIN, EIN, card PAN, bank account/routing)
 * from any system/prompt before it reaches an LLM. Two things must hold for the guard to be REAL:
 *
 *   1. Every REDACTING CHOKEPOINT actually redacts before it calls the raw SDK:
 *        · lib/ai/models.ts        — executeModelCall + generateTextRouted + generateObjectRouted
 *        · lib/ai/generate.ts      — generateObject + generateAIObject
 *        · lib/data-guard/guarded-generate.ts — the wrapper
 *   2. No NEW code imports the raw AI SDK call (`generateText` / `streamText` / `generateObject`
 *      from "ai") outside those chokepoints. Every such file must route through a chokepoint OR be
 *      in the baseline (known legacy direct-importers, tracked debt). A NEW direct importer FAILS CI.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join, relative } from "node:path"
import { walkTs, rootRuntimeFiles } from "./runtime-roots"
import { blankComments, blankStrings } from "./strip-comments"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BASELINE_PATH = join(root, "scripts", "data-guard-baseline.json")

// The redacting chokepoints — allowed to import the raw SDK because they apply the Data Guard.
const GUARDED = new Set<string>([
  "lib/ai/models.ts",
  "lib/ai/generate.ts",
  "lib/data-guard/guarded-generate.ts",
])

// TOMBSTONE (orphan doctrine §1.1) — the private `walk(dir, out)` that stood here
// was one of 82 copies of the same readdirSync walker. The survivor is
// scripts/runtime-roots.ts:61 (`walkTs`), imported above.
//
// The copy was not a style problem. It enumerated DIRECTORIES, and a root-level
// FILE is not a directory, so `proxy.ts` — the Next 16 edge middleware that gates
// auth on every request — sat outside this guard's corpus. A file that is never
// opened reports green, which is the failure shape §2 of CLAUDE.md names.
// `rootRuntimeFiles()` from the same survivor supplies the root files.
const files = [
  ...walkTs(join(root, "app")),
  ...walkTs(join(root, "lib")),
  ...rootRuntimeFiles(root),
]
  .filter((p) => !/\.test\.tsx?$/.test(p))
  .map((p) => relative(root, p).replace(/\\/g, "/"))

// The RAW model boundary: a file that imports a model-call fn directly from "ai".
const rawImportRe = /import\s*\{[^}]*\b(generateText|streamText|generateObject|streamObject)\b[^}]*\}\s*from\s*['"]ai['"]/

// ── WHY THIS SCAN READS STRIPPED SOURCE (CLAUDE.md §2) ───────────────────────
// It did not, and that was a live defect. `readFileSync(...)` fed RAW source to
// `rawImportRe`, so a COMMENT naming the pattern registered as a live raw-SDK
// import. Two real casualties, one already sitting in the baseline:
//
//   · lib/ai/resolve-model.ts:21 — a `// Usage:` block whose example line reads
//     `import { generateText } from "ai"`. That file imports nothing from "ai".
//     It was pinned in data-guard-baseline.json as legacy DEBT that never existed,
//     and being a doc comment it is meant to STAY — so the phantom was permanent.
//   · the AI-spend lane wrote a tombstone quoting the same pattern and nearly
//     froze a MIGRATED file into this baseline as unmigrated, forever.
//
// This is §2's headline failure ("A TOMBSTONE IS NOT A CALL SITE"), which burned
// five guards in the 2026-08-23 wave. `blankComments` (not stripComments) is used
// so the offsets below still line up with the text matched against.
//
// ── AND WHY IT DOES *NOT* USE blankStrings ───────────────────────────────────
// §2 says reach for `blankStrings` "where a fixture or a specimen could match".
// Here that advice inverts: the pattern's own anchor — `from "ai"` — IS a quoted
// literal, so blanking string CONTENTS deletes the module specifier and the regex
// stops matching anything at all. Measured on this corpus: 18 raw matches →
// 0 under blankStrings. A guard that reports zero reads as a clean bill of health,
// which is the exact shape §2 opens with. blankStrings is used ONLY to classify a
// match already found, never to find one.
const codeOf = (f: string) => blankComments(readFileSync(join(root, f), "utf8"))
const rawImporters = files.filter((f) => rawImportRe.test(codeOf(f))).sort()

/**
 * BLIND SPOT, measured rather than assumed: a raw-SDK import written INSIDE a
 * string or template literal (a codegen emitter, a fixture) is code-shaped to the
 * regex but is not an import. It cannot be excluded by blanking strings (see
 * above), so it is classified after the fact — blankStrings blanks the identifier
 * itself iff the match sat in string content — and reported beside the count.
 */
const stringEmbedded = rawImporters.filter((f) => {
  const code = codeOf(f)
  const masked = blankStrings(readFileSync(join(root, f), "utf8"))
  const m = rawImportRe.exec(code)
  if (!m || m.index === undefined) return false
  const at = m.index + m[0].indexOf(m[1])
  return masked.slice(at, at + m[1].length).trim() === ""
})

let pass = 0, fail = 0
const check = (n: string, c: boolean, extra?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}${extra ? ` — ${extra}` : ""}`) } }

console.log("\n[0 · POSITIVE CONTROL — the finder still recognises the defect, and still ignores a tombstone]")
{
  // A live import must be FOUND. A tombstone quoting it must NOT be.
  const liveSpecimen = `import { generateObject } from 'ai'\nexport const x = 1\n`
  const tombstoneSpecimen = [
    "// TOMBSTONE (orphan doctrine §1.1) — this file used to carry",
    "//   import { generateObject } from 'ai'",
    "// and now routes through lib/ai/models.ts:executeModelCall.",
    "export const x = 1",
  ].join("\n")
  const blockTombstone = `/**\n * Usage:\n *   import { generateText } from "ai"\n */\nexport const x = 1\n`
  check("a LIVE raw-SDK import is detected", rawImportRe.test(blankComments(liveSpecimen)))
  check("a `//` TOMBSTONE quoting it is NOT detected", !rawImportRe.test(blankComments(tombstoneSpecimen)))
  check("a `/** */` usage-doc quoting it is NOT detected", !rawImportRe.test(blankComments(blockTombstone)))
  check("the corpus finder is live (≥1 real chokepoint still found)",
    rawImporters.some((f) => GUARDED.has(f)), `found ${rawImporters.length} importers in ${files.length} files`)
  // Regression pin for the phantom this fix removed: a doc comment, not an import.
  const resolveModel = "lib/ai/resolve-model.ts"
  check(`${resolveModel} is a doc comment, not a raw importer`,
    !rawImporters.includes(resolveModel) && rawImportRe.test(readFileSync(join(root, resolveModel), "utf8")),
    "the usage-doc example at :21 must stay a comment and stay uncounted")
}

console.log("\n[1 · every redacting chokepoint scrubs before the raw model call]")
const models = codeOf("lib/ai/models.ts")
check("models.ts imports the Data Guard", /redactSensitive/.test(models) && /@\/lib\/data-guard/.test(models))
check("executeModelCall uses the redacted system+prompt", /system:\s*safeSystem[\s\S]*?prompt:\s*safePrompt/.test(models))
check("the routed fns redact prompt+system (≥2 sites: generateTextRouted + generateObjectRouted)",
  (models.match(/request\.prompt\s*=\s*redactSensitive/g) ?? []).length >= 2)
const gen = codeOf("lib/ai/generate.ts")
check("generate.ts redacts in generateObject + generateAIObject (≥2 sites)",
  (gen.match(/redactSensitive\(/g) ?? []).length >= 2)
const wrap = codeOf("lib/data-guard/guarded-generate.ts")
check("guardedGenerateText redacts system + prompt + messages",
  /a\.system[\s\S]*redactSensitive/.test(wrap) && /a\.prompt[\s\S]*redactSensitive/.test(wrap) && /messages[\s\S]*redactMessage/.test(wrap))

console.log("\n[2 · no NEW file imports the raw model SDK outside the chokepoints]")
let baseline: string[] = []
try { baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as string[] } catch { /* none yet */ }
const baseSet = new Set(baseline)
const unguarded = rawImporters.filter((f) => !GUARDED.has(f))
const newBypass = unguarded.filter((f) => !baseSet.has(f))
const burnedDown = baseline.filter((b) => !unguarded.includes(b))

console.log(`  raw-SDK importers: ${rawImporters.length} · chokepoints: ${rawImporters.filter((f) => GUARDED.has(f)).length} · baseline debt: ${baseline.length}`)
console.log(`  corpus: ${files.length} files (app/ + lib/ + root runtime files, *.test.* excluded) · comments stripped before scanning`)
console.log(`  blind spot — matches sitting inside a string/template literal: ${stringEmbedded.length}${stringEmbedded.length ? ` (${stringEmbedded.join(", ")})` : ""}`)
if (burnedDown.length > 0) {
  console.log(`  ↓ ${burnedDown.length} baseline importer(s) migrated — run with UPDATE_DATA_GUARD_BASELINE=1 to shrink:`)
  for (const b of burnedDown.slice(0, 20)) console.log(`     · ${b}`)
}

if (process.env.UPDATE_DATA_GUARD_BASELINE === "1") {
  writeFileSync(BASELINE_PATH, JSON.stringify(unguarded, null, 2) + "\n")
  console.log(`  ✎ baseline rewritten to ${unguarded.length} entries.`)
  console.log("\n RESULT: 1 passed, 0 failed")
  process.exit(0)
}

check(`no NEW raw-SDK importer outside the chokepoints (${newBypass.length} new)`, newBypass.length === 0, newBypass.join(", "))

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${pass} passed, ${fail} failed`)
if (fail > 0) { console.log(" ❌ DATA_GUARD_FAIL"); process.exit(1) }
console.log(` ✅ DATA_GUARD_PASS — chokepoints redact; no new raw-SDK importer (${unguarded.length} legacy to burn down)`)
