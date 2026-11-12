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

  // The manual kernel path. generateAIEducation was merged onto
  // createEducationalResource (wave 26 — it wrote a placeholder body, and the
  // real model path already reached the survivor); the survivor now carries the
  // AI-draft branch (isAiGenerated → pending_review) BEHIND the same dedup. The
  // checks read the survivor's FUNCTION BODY, not the whole file, so the
  // tombstone that names the deleted function can never count as a call site
  // (CLAUDE.md §2 — a tombstone is not a call site).
  const kernel = src("lib/kernel/education.ts")
  const bodyStart = kernel.indexOf("export async function createEducationalResource")
  const bodyEnd = bodyStart >= 0 ? kernel.indexOf("\nexport ", bodyStart + 1) : -1
  const survivorBody = bodyStart >= 0 ? kernel.slice(bodyStart, bodyEnd > bodyStart ? bodyEnd : undefined) : ""
  // POSITIVE CONTROL: the slice must be the real function, not an empty string
  // that would make every `.includes` below trivially false and read as a clean miss.
  check("createEducationalResource is present in the kernel (control for the body slice)",
    survivorBody.length > 200 && survivorBody.includes(".from(\"learning_modules\")"))
  check("the manual AI path (isAiGenerated) lands pending_review through the survivor, behind the dedup",
    survivorBody.includes("isAiGenerated") && survivorBody.includes('"pending_review"') &&
    survivorBody.includes("is_ai_generated") && survivorBody.indexOf("findNearDuplicateModule") < survivorBody.indexOf(".from(\"learning_modules\")"))
  check("createEducationalResource dedups before publishing",
    survivorBody.includes("findNearDuplicateModule(") && survivorBody.includes("input.title"))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ EDUCATION_DEDUP_FAIL"); process.exit(1) }
console.log(" ✅ EDUCATION_DEDUP_PASS — no cross-path duplicate modules; manual paths idempotent")
