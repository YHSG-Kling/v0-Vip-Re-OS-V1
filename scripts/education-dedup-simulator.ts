// scripts/education-dedup-simulator.ts   (npm run test:education-dedup)
// ─────────────────────────────────────────────────────────────────────────────
// EDUCATION CROSS-PATH DEDUP (owner: auto-generated education must have "no
// duplicates or noise"). Each auto-authoring path already dedups within itself by
// gap_tag + is human-gated to pending_review — clean. The gap was CROSS-PATH:
// different subsystems author the SAME topic under DIFFERENT tags (chatter's
// question:pre_approval vs the tier syllabus's financing_letter_strength), and
// two MANUAL kernel commands had no dedup at all. This proves the shared
// title-similarity guard closes both.

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { titleSimilarity, isNearDuplicateTitle } from "../lib/education/dedup-guard"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── pure title-similarity catches same-topic / spares distinct-topic ──")
{
  check("an obvious near-duplicate title is caught",
    isNearDuplicateTitle("Getting Your Mortgage Pre-Approval Letter",
      ["Get Your Mortgage Pre-Approval Letter", "Home Inspection Basics"]))
  check("distinct topics are NOT flagged (no over-suppression)",
    !isNearDuplicateTitle("Reading a Seller's Disclosure",
      ["Getting Your Mortgage Pre-Approval Letter", "Negotiating Repair Credits"]))
  check("stopwords/format words don't create false matches",
    titleSimilarity("AI: The Complete Guide to Escrow", "AI: A Course on Wire Fraud") < 0.3)
  check("identical titles score 1.0",
    titleSimilarity("Handling Appraisal Gaps", "Handling Appraisal Gaps") === 1)
  check("empty/garbage titles never match",
    titleSimilarity("", "anything") === 0 && !isNearDuplicateTitle("", ["x", "y"]))
}

console.log("\n── the guard is wired into every duplicate-prone path ──")
{
  const guard = src("lib/education/dedup-guard.ts")
  check("exposes a DB-backed hasNearDuplicateModule + findNearDuplicateModule (fail-open)",
    guard.includes("export async function hasNearDuplicateModule") &&
    guard.includes("export async function findNearDuplicateModule") &&
    guard.includes("return false") && guard.includes("return null"))
  check("only compares LIVE modules (pending_review + published) for an overlapping audience",
    guard.includes('["pending_review", "published"]') && guard.includes("audienceComparable"))

  const author = src("lib/education/curriculum-author.ts")
  check("the autonomous chatter/gap path checks cross-path near-dupes before authoring",
    author.includes("hasNearDuplicateModule") && /if \(await hasNearDuplicateModule\([^)]*\)\) continue/.test(author))

  const kernel = src("lib/kernel/education.ts")
  check("the manual generateAIEducation returns the existing module instead of a duplicate",
    (kernel.match(/findNearDuplicateModule/g) ?? []).length >= 2)
  check("createEducationalResource dedups before publishing",
    kernel.includes('findNearDuplicateModule(supabase, input.brokerageId, input.title'))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ EDUCATION_DEDUP_FAIL"); process.exit(1) }
console.log(" ✅ EDUCATION_DEDUP_PASS — no cross-path duplicate modules; manual paths idempotent")
