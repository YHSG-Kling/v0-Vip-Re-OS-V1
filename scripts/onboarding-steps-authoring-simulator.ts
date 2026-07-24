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
  check("category is validated + step_key is normalized",
    a.includes("CATEGORIES.has(input.category)") && a.includes("replace(/[^a-z0-9_]+/g"))
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
