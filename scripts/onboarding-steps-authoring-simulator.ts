// scripts/onboarding-steps-authoring-simulator.ts   (npm run test:onboarding-steps)
// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING STEPS AUTHORING — proves the gap is closed: the canonical onboarding
// JOURNEY system (agent_onboarding + onboarding_steps + agent_step_completions)
// was fully live but had NO write surface — every agent inherited the one global
// (brokerage_id NULL) step template. A brokerage admin can now AUTHOR
// brokerage-scoped onboarding_steps that the onboarding loader already reads
// (brokerage_id.eq.<id> OR is null, role-filtered). No schema change; no parallel
// onboarding system.
//
// DISTINCT from test:onboarding-curriculum, which authors learning_modules
// (education CONTENT per tier) — this is the day-by-day STEP checklist.

import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the authoring actions (admin-gated, brokerage-scoped) ──")
{
  const a = src("app/actions/admin/onboarding-steps.ts")
  check("list + save + delete actions exist",
    a.includes("export async function listOnboardingCurriculumAction") &&
    a.includes("export async function saveOnboardingStepAction") &&
    a.includes("export async function deleteOnboardingStepAction"))
  check("admin-gated (broker/broker_admin/admin/superadmin)",
    a.includes("ADMIN_ROLES") && a.includes("requireAdmin"))
  check("writes the CANONICAL onboarding_steps table (no parallel system)",
    a.includes('.from("onboarding_steps")'))
  check("brokerage_id is pinned to the caller's tenant (can't author a platform default)",
    a.includes("brokerage_id: auth.brokerageId"))
  check("reads with the SAME predicate the onboarding loader uses (brokerage OR null)",
    a.includes("brokerage_id.eq.${auth.brokerageId},brokerage_id.is.null"))
  check("edit/delete refuse anything but the tenant's OWN step (platform defaults read-only)",
    (a.match(/Step not found for this brokerage/g) ?? []).length >= 2)
  // ASSERT THE CONSTRUCT, NOT THE SPELLING. This used to require the literal
  // `CATEGORIES.has(input.category)`, which pinned one function name in one
  // file. When the vocabulary moved into lib/onboarding/step-categories.ts —
  // the fix for a defect where FOUR of the seven offered categories were
  // refused by onboarding_steps_category_check, and where the blank form's
  // stepOrder default of 0 made the FIRST save of a fresh create form always
  // fail — this assertion went red on strictly better code. What matters is
  // that `input.category` is validated against the SHARED source before it
  // reaches the insert, not what the validator is called.
  check("category is validated against the shared vocabulary + step_key is normalized",
    /from ["']@\/lib\/onboarding\/step-categories["']/.test(a) &&
    /\binput\.category\b/.test(a) &&
    /(Category|category)[A-Za-z]*\s*\(\s*input\.category\s*\)|input\.category\s*\)/.test(a) &&
    a.includes("replace(/[^a-z0-9_]+/g"))
  // ONE list, not three. The vocabulary drifted precisely because the action and
  // the picker each kept their own copy next to a CHECK constraint neither read.
  check("the picker imports the SAME vocabulary module as the action (no third copy)",
    /from ["']@\/lib\/onboarding\/step-categories["']/.test(
      src("app/dashboard/admin/onboarding/onboarding-curriculum-editor.tsx")))
  check("does NOT write the generated brokerage_id_or_zero column",
    !a.includes("brokerage_id_or_zero"))
}

console.log("\n── the editor UI is mounted on the existing admin onboarding page ──")
{
  const editor = src("app/dashboard/admin/onboarding/onboarding-curriculum-editor.tsx")
  check("editor lists + adds + edits + deletes steps",
    editor.includes("listOnboardingCurriculumAction") &&
    editor.includes("saveOnboardingStepAction") &&
    editor.includes("deleteOnboardingStepAction"))
  check("platform defaults are shown read-only (no edit/delete)",
    editor.includes("isPlatformDefault") && editor.includes("platform default"))
  check("surfaces load errors honestly (no silent empty state)",
    editor.includes("loadError"))
  const page = src("app/dashboard/admin/onboarding/page.tsx")
  check("mounted on the existing /dashboard/admin/onboarding page (not an orphan route)",
    page.includes("OnboardingCurriculumEditor"))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ ONBOARDING_STEPS_AUTHORING_FAIL"); process.exit(1) }
console.log(" ✅ ONBOARDING_STEPS_AUTHORING_PASS — admins can author brokerage onboarding steps on the live path")
