#!/usr/bin/env tsx
/**
 * scripts/content-lane-ledger-simulator.ts  (npm run test:content-lane-ledger)
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO CONTENT-GENERATION LANES ANSWER THE SAME QUESTION THE SAME WAY.
 *
 * There are two content lanes and they are NOT duplicates — docs/content-generation-audit.md
 * establishes that one is a draft-only generator carrying a guard-enforced Fair
 * Housing video path, and the other is a persisted lifecycle system across seven
 * tables. Deleting either loses real capability. What they WERE was disconnected,
 * in two specific and measurable ways:
 *
 *   1. TWO FEATURE VOCABULARIES. Every AI call stamps `feature` onto ai_tool_usage
 *      (lib/ai/cost-tracking.ts logAIUsage, reached from generateAIResponse). Lane B
 *      stamped real AI_TASK_ROUTING keys; Lane A stamped synthesized strings
 *      (`content_generation_${type}`) that are in NO registry. Measured before this
 *      work: Lane B 5/5 routed, Lane A 0/10. So (a) selectModelForTask missed on
 *      every Lane A call and it never got the model its task is designated, and
 *      (b) no single query could ask "content generation" and span both lanes.
 *
 *      The worst instance was `content_generation_video` — the FIFTH guarded Fair
 *      Housing script path (scripts/video-script-compliance-guard.ts names the
 *      file) — missing `video_script_generation`.
 *
 *   2. TWO PRICE TABLES. ai_tool_usage is priced by lib/ai/cost-tracking.ts
 *      calculateCost, keyed on the AIModel union the system actually emits, with
 *      dated provider pricing. Lane B ALSO booked the same call into
 *      content_generation_logs via its own inline table keyed on a
 *      provider-prefixed namespace ("anthropic/claude-sonnet-4.5") that the system
 *      never emits. Measured overlap between the two key namespaces: ZERO. Every
 *      real model fell through to gpt-4o-mini rates — a 25.6x understatement on
 *      claude-sonnet, the platform default for content, and 119.7x on claude-opus.
 *
 * This guard is the ratchet on both. It is DELIBERATELY TEXTUAL: lib/ai/models.ts
 * is `server-only`, so importing it from a plain script throws. The routing table
 * is extracted by brace-matching the source, which is also why the parse itself is
 * asserted first — a silently-empty extraction would make every membership check
 * pass vacuously, which is exactly how a guard becomes decoration.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  CONTENT_TYPE_FEATURE,
  CONTENT_GENERATION_FEATURES,
  contentFeatureForType,
  isContentFeature,
} from "../lib/ai/content-features"

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), "utf8")

let passed = 0
let failed = 0
const fail = (name: string, detail: string) => {
  console.log(`  ✗ ${name}\n      ${detail}`)
  failed++
}
const ok = (name: string) => {
  console.log(`  ✓ ${name}`)
  passed++
}
const check = (name: string, cond: boolean, detail: string) => (cond ? ok(name) : fail(name, detail))

console.log("\n══════════════════════════════════════════════════")
console.log(" CONTENT LANE LEDGER — one vocabulary, one price table")
console.log("══════════════════════════════════════════════════\n")

// ── Extract AI_TASK_ROUTING's keys by brace-matching the object literal. ──────
function routingKeys(): Set<string> {
  const src = read("lib/ai/models.ts")
  const decl = src.indexOf("export const AI_TASK_ROUTING")
  if (decl < 0) return new Set()
  const open = src.indexOf("= {", decl)
  if (open < 0) return new Set()
  let depth = 0
  let end = -1
  for (let i = open + 2; i < src.length; i++) {
    if (src[i] === "{") depth++
    else if (src[i] === "}") {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) return new Set()
  const body = src.slice(open + 2, end)
  return new Set([...body.matchAll(/^ {2}([A-Za-z0-9_]+):\s*\{/gm)].map((m) => m[1]))
}

const KEYS = routingKeys()

console.log("[1 · the extraction itself is sound]")
// Asserted FIRST and with a real floor. If brace-matching ever breaks, KEYS is
// empty, every `has()` below returns false and the suite fails loudly — but a
// future refactor could just as easily make it return a handful of keys and let
// the real checks pass on a truncated table. 40 is well under the 50 present
// today and well above any partial parse.
check("AI_TASK_ROUTING parsed", KEYS.size >= 40, `extracted only ${KEYS.size} keys — the parse is broken, not the code under test`)
check("a known key is present", KEYS.has("video_script_generation"), "video_script_generation missing from the extracted table")

console.log("\n[2 · every feature this module names is a REAL routing key]")
// The rule content-features.ts states about itself. An unrouted feature is the
// exact bug it exists to close, so it must not be able to introduce one.
for (const f of CONTENT_GENERATION_FEATURES) {
  check(`CONTENT_GENERATION_FEATURES: ${f}`, KEYS.has(f), `"${f}" is not a key in AI_TASK_ROUTING — add it there first`)
}
for (const [type, feature] of Object.entries(CONTENT_TYPE_FEATURE)) {
  check(`CONTENT_TYPE_FEATURE: ${type} → ${feature}`, KEYS.has(feature), `"${feature}" is not a key in AI_TASK_ROUTING`)
}
check(
  "the fallback is a real key too",
  KEYS.has(contentFeatureForType("a-content-type-that-does-not-exist")),
  "contentFeatureForType's fallback resolves to a feature that is not in AI_TASK_ROUTING",
)

console.log("\n[3 · every content_type Lane A accepts has a mapping]")
// Source of truth is Lane A's own union, read from source — so adding a
// content_type without mapping it fails here instead of silently synthesizing
// an unrouted feature at runtime.
const generatorSrc = read("lib/content-generation/content-generator.ts")
const unionMatch = generatorSrc.match(/content_type:\s*((?:"[a-z_]+"\s*\|\s*)+"[a-z_]+")/)
check("Lane A's content_type union was found in source", !!unionMatch, "could not locate ContentGenerationParams['content_type'] — this guard is blind, fix the pattern")
if (unionMatch) {
  const types = [...unionMatch[1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1])
  check("union is non-trivial", types.length >= 8, `parsed only ${types.length} content types`)
  for (const t of types) {
    check(`${t} is mapped`, t in CONTENT_TYPE_FEATURE, `content_type "${t}" has no CONTENT_TYPE_FEATURE entry — it would fall back to the generic feature`)
  }
}

console.log("\n[4 · Lane A no longer synthesizes unrouted feature strings]")
// The specific regression: `feature: \`content_generation_${...}\`` and its
// three literal siblings. Checked in BOTH Lane A files.
// COMMENTS STRIPPED. The repoint deliberately leaves `// WAS: feature:
// "content_generation_video" — not an AI_TASK_ROUTING key` at each site, which
// is the record of what was wrong and why. A guard that fails on that record
// pressures the next reader to delete the explanation to get green — the same
// mistake this check made on its first pass, and the same one section 5 made.
// Only a LIVE stamp counts.
for (const f of ["lib/content-generation/content-generator.ts", "app/actions/content-generation-engine.ts"]) {
  const code = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
  const synthesized = [...code.matchAll(/["'`]content_generation_[a-z_${}.\s]*["'`]/g)].map((m) => m[0])
  check(
    `${f} stamps no content_generation_* feature`,
    synthesized.length === 0,
    `still synthesizes ${synthesized.join(", ")} — these are in no registry, so selectModelForTask misses and the ledger cannot join`,
  )
}
// …and the resolver is actually reached, so "no synthesized string" cannot be
// satisfied by simply deleting the feature stamp altogether.
check(
  "content-generator.ts resolves its feature through the shared map",
  /contentFeatureForType\(/.test(read("lib/content-generation/content-generator.ts")),
  "lib/content-generation/content-generator.ts no longer calls contentFeatureForType — the lanes are unjoined again",
)

console.log("\n[5 · ONE price table — no rival pricer for AI spend]")
// calculateAICost's 4-row table shared ZERO keys with the canonical one, so
// every real model booked at gpt-4o-mini rates. The survivor is
// lib/ai/cost-tracking.ts::calculateCost.
const laneBSrc = read("app/actions/ai-content-generation.tsx")
check(
  "calculateAICost is gone from the content lane",
  !/export\s+async\s+function\s+calculateAICost/.test(laneBSrc),
  "app/actions/ai-content-generation.tsx still defines calculateAICost — the rival price table is back",
)
// COMMENTS STRIPPED FIRST, and the pattern is PRICE-SHAPED, not name-shaped.
// Two ways this check was wrong on the first pass and would have taught the
// wrong lesson:
//   · The record of the deleted table is a comment naming those very keys. A
//     guard that fails on its own documentation pressures the next reader to
//     delete the explanation to get green. Never that.
//   · "openai/gpt-4o" is ALSO the legitimate MODEL-RESOLUTION namespace —
//     resolveModel("openai/gpt-4o") is correct and used across the repo. The
//     defect was never the string; it was a string used as a PRICING key.
// So this looks for a rival price TABLE — a key mapped to a {prompt, completion}
// rate pair — which is the only shape that can misprice anything.
const laneBCode = laneBSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
check(
  "no rival price table in the content lane",
  !/\{\s*prompt:\s*[\d.]+\s*,\s*completion:\s*[\d.]+\s*\}/.test(laneBCode),
  "a {prompt, completion} rate pair is back in app/actions/ai-content-generation.tsx — pricing belongs to lib/ai/cost-tracking.ts::calculateCost alone",
)
const costSrc = read("lib/ai/cost-tracking.ts")
check("the canonical pricer still exists", /export function calculateCost/.test(costSrc), "lib/ai/cost-tracking.ts::calculateCost is missing — that is the survivor")
check("canonical pricing is still dated", /lastUpdated/.test(costSrc), "getModelPricing lost its lastUpdated stamps — undated pricing silently rots")

console.log("\n[6 · ONE deterministic Them-First pronoun ratio]")
// Two byte-identical private copies existed (rule-evaluators + kernel/compliance).
// The survivor is exported from rule-evaluators; the kernel imports it.
const evalSrc = read("lib/compliance-rules/rule-evaluators.ts")
const kernelSrc = read("lib/kernel/compliance.ts")
check(
  "the survivor is exported",
  /export function calculateThemFirstScore/.test(evalSrc),
  "lib/compliance-rules/rule-evaluators.ts must export calculateThemFirstScore",
)
check(
  "the kernel imports it rather than redefining it",
  /calculateThemFirstScore/.test(kernelSrc) && !/function calculatePronounRatio/.test(kernelSrc),
  "lib/kernel/compliance.ts has re-grown its own pronoun-ratio copy — the gate and the report will drift",
)
// The word lists are a compliance threshold. Exactly one copy of each.
const buyerLists = (evalSrc + kernelSrc).match(/imagine\|feel\|enjoy\|benefit\|discover\|experience/g) ?? []
check("exactly one buyer-word list across both files", buyerLists.length === 1, `found ${buyerLists.length} copies of the buyer-word list`)

console.log("\n[7 · quality_score is measured, not self-reported]")
// The prompt used to specify `"qualityScore": 85` and then read it back.
const svcSrc = read("lib/services/content-generation.service.ts")
check(
  "the prompt no longer dictates a score",
  !/"qualityScore":\s*\d+/.test(svcSrc.replace(/^\s*\/\/.*$/gm, "")),
  "the generation prompt still asks the model to emit a literal qualityScore — that is a constant, not an assessment",
)
check(
  "no hardcoded score fallback survives",
  !/qualityScore:\s*\d+/.test(svcSrc.replace(/^\s*\/\/.*$/gm, "")),
  "a hardcoded qualityScore fallback is back in lib/services/content-generation.service.ts",
)
check(
  "the score is derived from the returned text",
  /calculateThemFirstScore/.test(svcSrc),
  "content-generation.service.ts no longer measures the score it stores",
)

console.log("\n[8 · isContentFeature is a real predicate]")
check("accepts a content feature", isContentFeature("listing_description"), "listing_description should count as content")
check("rejects a non-content feature", !isContentFeature("lead_analysis"), "lead_analysis is not content generation and must not be counted in the content panel")
check("rejects tag_classification", !isContentFeature("tag_classification"), "tag_classification classifies, it does not generate")
check("rejects null/empty", !isContentFeature(null) && !isContentFeature(""), "a row with no feature must not count as content")

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log(" ❌ CONTENT_LANE_LEDGER_FAIL — the two lanes have drifted apart again")
  process.exit(1)
}
console.log(" ✅ CONTENT_LANE_LEDGER_PASS — one feature vocabulary, one price table, one Them-First measure")
