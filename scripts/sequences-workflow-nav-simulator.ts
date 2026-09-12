// scripts/sequences-workflow-nav-simulator.ts   (npm run test:sequences-workflow-nav)
// ─────────────────────────────────────────────────────────────────────────────
// SEQUENCES ↔ WORKFLOWS NAV CONSOLIDATION (owner: campaign sequences and a
// separate "workflows" menu link should not be two menu items). The audit found
// THREE surfaces, and the drift was nav-level, not data:
//   • "Automation Sequences" (/dashboard/campaigns/sequences) — the drip list
//   • "Workflow Builder" (/dashboard/campaigns/workflows) — the SAME
//     campaign_sequences editor with a different label (a duplicate nav entry)
//   • "Workflows" (/workflows) — a genuinely SEPARATE orchestration MONITOR
//     (workflow_executions) that only shares the word "steps"
// The fix (zero data risk): drop the duplicate "Workflow Builder" nav entry (the
// editor stays reachable via the sequences list's Edit), and relabel the separate
// monitor to "Workflow Monitor" so it no longer collides. NO data-model merge —
// the two engines stay independent (that would be a risky migration).

import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the duplicate 'Workflow Builder' nav entry is gone ──")
{
  const nav = src("app/config/navigation-config.ts")
  check("no 'Workflow Builder' nav label remains",
    !nav.includes("label: 'Workflow Builder'"))
  check("no 'workflow-builder' nav id remains",
    !nav.includes("id: 'workflow-builder'"))
  check("the sequences list entry survives (the single entry point)",
    nav.includes("label: 'Automation Sequences', href: '/dashboard/campaigns/sequences'"))
  check("the separate orchestration monitor is relabeled to disambiguate",
    nav.includes("label: 'Workflow Monitor', href: '/workflows'") && !nav.includes("label: 'Workflows', href: '/workflows'"))
}

console.log("\n── the editor route stays live + reachable (not deleted, not orphaned) ──")
{
  const list = src("app/dashboard/campaigns/sequences/SequencesListClient.tsx")
  check("the sequences list Edit still opens the builder route (/campaigns/workflows?id=)",
    list.includes("/dashboard/campaigns/workflows?id="))
  // The route + its editor client must still exist on disk.
  check("the builder route/page still exists (data domain untouched)",
    src("app/dashboard/campaigns/workflows/page.tsx").length > 0)
  check("the builder still writes the SAME campaign_sequences system (no data merge)",
    src("app/dashboard/campaigns/workflows/workflow-builder-client.tsx").includes("campaign-sequences"))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ SEQUENCES_WORKFLOW_NAV_FAIL"); process.exit(1) }
console.log(" ✅ SEQUENCES_WORKFLOW_NAV_PASS — one sequence entry point; the separate monitor disambiguated; no data merge")
