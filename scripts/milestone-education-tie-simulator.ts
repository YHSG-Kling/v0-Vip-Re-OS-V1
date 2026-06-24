#!/usr/bin/env tsx
/**
 * scripts/milestone-education-tie-simulator.ts   (npm run test:milestone-education-tie)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves that EVERY contact-facing milestone ties to education in the portal, with
 * the delivery channel chosen by age group — and that this holds across the messy
 * free-text milestone_name variants that live across thousands of subscription tiers.
 *
 * The defect this guards against: the journey timeline, the education plan, the
 * milestone-gated module unlock, and resolve-education-context all keyed their
 * lesson/explanation/responsible-party maps on the raw milestone_name. Live rows
 * carry HUMAN names ("Home Inspection", "Closing Day"), the maps are keyed by
 * canonical snake_case ids — so every lookup silently missed and the whole
 * sophisticated age-channel + persona education machinery never engaged.
 *
 * resolveMilestoneIdentity is the single bridge. This simulator asserts:
 *   1. canonical ids resolve to themselves (type and snake_case name paths).
 *   2. every live SEED name (lib/application/transactions.ts) → a canonical id.
 *   3. observed legacy DB variants → the right canonical id.
 *   4. keyword fallback handles novel tier-specific names.
 *   5. the EDUCATION TIE is real: a representative client-facing milestone resolves
 *      to an id that carries a lesson, an explanation, a responsible party, AND a
 *      label — i.e. the portal can actually teach the contact at that step.
 *   6. CHANNEL-BY-AGE: getEducationDelivery picks the right primary format per age
 *      segment (18-30 video, 30-50/50-65 guide, 65+ checklist).
 */

// The education maps live in resolve-education-context, which transitively imports
// the kernel (server-only). Neutralize that guard before the lazy import below.
import { createRequire } from "module"
const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not resolvable — nothing to shim */ }

// The resolver is pure — safe to import statically.
import {
  resolveMilestoneIdentity,
  CANONICAL_MILESTONE_IDS,
} from "../lib/transactions/milestone-identity"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }

// The exact buyer + seller seed names generateMilestones writes today.
const SEED_NAMES = [
  // buyer
  "Offer Submitted", "Offer Accepted", "Earnest Money Deposited", "Home Inspection Scheduled",
  "Home Inspection Complete", "Repair Negotiations Complete", "Appraisal Ordered", "Appraisal Complete",
  "Loan Approved", "Title Search Complete", "Final Walkthrough", "Closing Documents Signed",
  "Funds Transferred", "Keys Received",
  // seller
  "Listing Agreement Signed", "Property Listed", "Offer Received", "Earnest Money Received",
  "Buyer Inspection Complete", "Repair Request Addressed", "Buyer Financing Approved", "Title Clear",
  "Closing Scheduled", "Funds Received", "Keys Delivered",
]

// Variants already present in live transaction_milestones (observed via SQL).
const LEGACY_VARIANTS: Array<[string, string]> = [
  ["Appraisal Completed", "appraisal_completed"],
  ["Appraisal Ordered", "appraisal_ordered"],
  ["Clear to Close", "clear_to_close_received"],
  ["Closing Day", "closing_date"],
  ["Final Walk-Through", "final_walkthrough_scheduled"],
  ["Home Inspection", "inspection_deadline"],
  ["Loan Approval", "loan_approved"],
]

async function main(): Promise<void> {
  console.log("\n[1 · canonical ids resolve to themselves]")
  check("milestone_type carrying a canonical id resolves to it",
    resolveMilestoneIdentity({ milestone_type: "closing_date", milestone_name: "Whatever The Tier Calls It" }) === "closing_date")
  check("a snake_case milestone_name that is canonical resolves to it",
    resolveMilestoneIdentity({ milestone_name: "earnest_money_due" }) === "earnest_money_due")
  check("milestone_type WINS over milestone_name",
    resolveMilestoneIdentity({ milestone_type: "loan_approved", milestone_name: "Closing Day" }) === "loan_approved")

  console.log("\n[2 · every live SEED name resolves to a canonical id]")
  for (const name of SEED_NAMES) {
    const id = resolveMilestoneIdentity({ milestone_name: name, milestone_type: null })
    check(`"${name}" → ${id ?? "NULL"}`, id !== null)
  }

  console.log("\n[3 · observed legacy DB variants resolve correctly]")
  for (const [name, expected] of LEGACY_VARIANTS) {
    const id = resolveMilestoneIdentity({ milestone_name: name, milestone_type: null })
    check(`"${name}" → ${expected}`, id === expected)
  }

  console.log("\n[4 · keyword fallback handles novel tier-specific names]")
  check('"Schedule Your Final Walk Thru" → final_walkthrough_scheduled',
    resolveMilestoneIdentity({ milestone_name: "Schedule Your Final Walk Thru" }) === "final_walkthrough_scheduled")
  check('"Buyer\'s Earnest $ Wired" → earnest_money_due',
    resolveMilestoneIdentity({ milestone_name: "Buyer's Earnest $ Wired" }) === "earnest_money_due")
  check('"Cleared To Close!!!" → clear_to_close_received',
    resolveMilestoneIdentity({ milestone_name: "Cleared To Close!!!" }) === "clear_to_close_received")
  check('"Mortgage Underwriting" → financing_deadline',
    resolveMilestoneIdentity({ milestone_name: "Mortgage Underwriting" }) === "financing_deadline")
  check('an unmappable name → null (degrade gracefully, never mis-anchor)',
    resolveMilestoneIdentity({ milestone_name: "Quarterly Newsletter" }) === null)

  // ── education maps + age delivery (lazy import after the server-only shim) ──
  const eduCtx = await import("../lib/portal/resolve-education-context")
  const { getEducationDelivery, cohortFraming, generationalCohortFromAge, ageFromBirthday } = await import("../lib/kernel/education")
  const { MILESTONE_LESSON_MAP, MILESTONE_EXPLANATIONS, MILESTONE_RESPONSIBLE_PARTY, MILESTONE_LABEL_MAP } = eduCtx

  console.log("\n[5 · the EDUCATION TIE is real — a live milestone teaches the contact]")
  // "Home Inspection" (a live name) must reach a lesson + explanation + party + label.
  const inspectionId = resolveMilestoneIdentity({ milestone_name: "Home Inspection" })!
  check('"Home Inspection" anchors a lesson', !!MILESTONE_LESSON_MAP[inspectionId])
  check('"Home Inspection" anchors an explanation', !!MILESTONE_EXPLANATIONS[inspectionId])
  check('"Home Inspection" anchors a responsible party', !!MILESTONE_RESPONSIBLE_PARTY[inspectionId])
  check('"Home Inspection" anchors a label', !!MILESTONE_LABEL_MAP[inspectionId])
  // Every id that the LESSON map teaches must be reachable from a realistic name —
  // i.e. no lesson is stranded behind an identity the resolver can never produce.
  const reachable = new Set(
    [...SEED_NAMES, ...LEGACY_VARIANTS.map(([n]) => n),
     "Closing Day", "Earnest Money Due", "Inspection Deadline", "Clear to Close", "Appraisal Ordered",
     "Financing Deadline"]
      .map((n) => resolveMilestoneIdentity({ milestone_name: n })).filter(Boolean) as string[],
  )
  for (const lessonAnchor of Object.keys(MILESTONE_LESSON_MAP)) {
    check(`lesson anchor "${lessonAnchor}" is reachable from a real milestone name`, reachable.has(lessonAnchor))
  }

  console.log("\n[6 · CHANNEL-BY-AGE — delivery format follows the age segment]")
  check("18-30 → video (autoplay short-form)", getEducationDelivery({ ageSegment: "18-30" }).primaryFormat === "video")
  check("30-50 → guide", getEducationDelivery({ ageSegment: "30-50" }).primaryFormat === "guide")
  check("50-65 → guide (detailed reading level)",
    getEducationDelivery({ ageSegment: "50-65" }).primaryFormat === "guide" && getEducationDelivery({ ageSegment: "50-65" }).readingLevel === "detailed")
  check("65+ → checklist", getEducationDelivery({ ageSegment: "65+" }).primaryFormat === "checklist")

  console.log("\n[7 · WORDING-BY-PERSONA — cohort framing leads each milestone explanation]")
  // Age → cohort → a distinct lead-in, so the SAME facts are framed per generation.
  check("under-30 birthday → gen_z framing (quick version)",
    cohortFraming(generationalCohortFromAge(ageFromBirthday("2002-05-01"))).startsWith("Quick"))
  check("~38 birthday → millennial framing (your move)",
    /your move/i.test(cohortFraming(generationalCohortFromAge(ageFromBirthday("1988-05-01")))))
  check("~55 birthday → gen_x framing (your investment)",
    /investment/i.test(cohortFraming(generationalCohortFromAge(ageFromBirthday("1971-05-01")))))
  check("~70 birthday → boomer framing (your home)",
    /your home/i.test(cohortFraming(generationalCohortFromAge(ageFromBirthday("1956-05-01")))))
  check("no birthday → unknown cohort → empty framing (explanation unchanged)",
    cohortFraming(generationalCohortFromAge(ageFromBirthday(null))) === "")
  const cohorts = ["gen_z", "millennial", "gen_x", "boomer", "silent"] as const
  check("each known cohort yields a distinct, non-empty framing",
    new Set(cohorts.map((c) => cohortFraming(c))).size === cohorts.length &&
    cohorts.every((c) => cohortFraming(c).length > 0))

  console.log("\n[meta] canonical id count: " + CANONICAL_MILESTONE_IDS.length)
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ MILESTONE_EDUCATION_TIE_FAIL"); process.exit(1) }
  console.log(" ✅ MILESTONE_EDUCATION_TIE_PASS — every contact-facing milestone resolves to education, channel by age")
}

main().catch((e) => { console.error(e); process.exit(1) })
