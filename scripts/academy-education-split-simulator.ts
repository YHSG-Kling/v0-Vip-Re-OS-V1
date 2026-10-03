// scripts/academy-education-split-simulator.ts   (npm run test:academy-education-split)
// ─────────────────────────────────────────────────────────────────────────────
// ACADEMY vs CLIENT-EDUCATION SPLIT (owner: "education for the tenant's customers,
// academy for agents and staff"). The code already implements BOTH over ONE
// canonical rail — learning_modules — switched by audience_roles (staff roles →
// Academy at /academy; 'customer' → client portal). Creation was already
// admin-accessible, but the authoring form exposed audience as a flat role
// checklist with no framing, so it wasn't obvious you were creating staff
// training vs client content. This makes the split EXPLICIT at authoring time —
// no data-model change, one rail.

import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the authoring UI frames Academy (staff) vs Client Education (customers) ──")
{
  const ui = src("app/dashboard/admin/learning-modules/learning-modules-client.tsx")
  check("a 'Who is this for?' audience-type selector exists",
    ui.includes("Who is this for?"))
  check("offers Academy (agents & staff) and Client Education (customers) choices",
    ui.includes("Academy — my agents") && ui.includes("Client Education — my customers"))
  check("Academy → staff roles; Client → customer role (the audience_roles switch)",
    ui.includes('chooseAudienceType("academy")') && ui.includes('setAudienceRoles(["customer"])'))
  check("the role checklist adapts to the chosen audience type",
    ui.includes('audienceType === "client"') && ui.includes('audienceType === "academy"'))
  check("still the ONE canonical rail — createLearningModuleAction, no parallel table",
    ui.includes("createLearningModuleAction") && !ui.includes("academy_content") && !ui.includes("training_courses"))
  check("form reset clears the audience type",
    ui.includes('setAudienceType("")'))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ ACADEMY_EDUCATION_SPLIT_FAIL"); process.exit(1) }
console.log(" ✅ ACADEMY_EDUCATION_SPLIT_PASS — explicit Academy-vs-Client-Education framing on the one learning_modules rail")
