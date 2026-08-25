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
const rawImporters = files.filter((f) => rawImportRe.test(readFileSync(join(root, f), "utf8"))).sort()

let pass = 0, fail = 0
const check = (n: string, c: boolean, extra?: string) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; console.log(`  ✗ ${n}${extra ? ` — ${extra}` : ""}`) } }

console.log("\n[1 · every redacting chokepoint scrubs before the raw model call]")
const models = readFileSync(join(root, "lib/ai/models.ts"), "utf8")
check("models.ts imports the Data Guard", /redactSensitive/.test(models) && /@\/lib\/data-guard/.test(models))
check("executeModelCall uses the redacted system+prompt", /system:\s*safeSystem[\s\S]*?prompt:\s*safePrompt/.test(models))
check("the routed fns redact prompt+system (≥2 sites: generateTextRouted + generateObjectRouted)",
  (models.match(/request\.prompt\s*=\s*redactSensitive/g) ?? []).length >= 2)
const gen = readFileSync(join(root, "lib/ai/generate.ts"), "utf8")
check("generate.ts redacts in generateObject + generateAIObject (≥2 sites)",
  (gen.match(/redactSensitive\(/g) ?? []).length >= 2)
const wrap = readFileSync(join(root, "lib/data-guard/guarded-generate.ts"), "utf8")
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
