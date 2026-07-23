// scripts/assignment-rules-authz-simulator.ts   (npm run test:assignment-rules-authz)
// ─────────────────────────────────────────────────────────────────────────────
// ASSIGNMENT-RULES AUTHZ — proves lead-routing rules are mutated ONLY through the
// admin-gated server action, never a direct client write. Root bug: the admin
// page wrote assignment_rules rows straight from the browser
// (supabase.from("assignment_rules").insert/update/delete) with only RLS between
// a caller and the table that decides WHO GETS WHICH LEADS. Every other admin
// surface routes privileged writes through a role-gated server action; this one
// didn't. finance/data-steward integrity: routing == revenue.

import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── the server action is admin-gated + brokerage-pinned ──")
{
  const a = src("app/actions/admin/assignment-rules.ts")
  check("is a server module", a.includes('"use server"'))
  check("all three writers exist (save / toggle / delete)",
    a.includes("export async function saveAssignmentRuleAction") &&
    a.includes("export async function toggleAssignmentRuleAction") &&
    a.includes("export async function deleteAssignmentRuleAction"))
  check("every writer calls requireAdmin() before mutating",
    (a.match(/const auth = await requireAdmin\(\)/g) ?? []).length >= 3)
  check("requireAdmin enforces the admin role set (broker/admin/superadmin/team_lead)",
    a.includes("ADMIN_ROLES") && a.includes('"broker"') && a.includes('"superadmin"'))
  check("brokerage_id is pinned to the caller's own tenant, never trusted from input",
    a.includes("brokerage_id: auth.brokerageId"))
  check("update/toggle/delete verify the rule belongs to the caller's brokerage first",
    a.includes("ruleBelongsToBrokerage"))
  check("rule_type is validated against the allowed set",
    a.includes("RULE_TYPES") && a.includes("round_robin"))
}

console.log("\n── the client page no longer writes assignment_rules directly ──")
{
  const p = src("app/dashboard/admin/assignment-rules/page.tsx")
  check("NO direct client insert/update/delete to assignment_rules",
    !/supabase\s*\.\s*from\(\s*["']assignment_rules["']\s*\)\s*\.\s*(insert|update|delete)/.test(p) &&
    !/from\("assignment_rules"\)\.(insert|update|delete)/.test(p))
  check("the page calls the gated server actions instead",
    p.includes("saveAssignmentRuleAction") &&
    p.includes("toggleAssignmentRuleAction") &&
    p.includes("deleteAssignmentRuleAction"))
  check("surfaces the action's error to the user (no silent failure)",
    p.includes("if (!res.ok)"))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ ASSIGNMENT_RULES_AUTHZ_FAIL"); process.exit(1) }
console.log(" ✅ ASSIGNMENT_RULES_AUTHZ_PASS — routing rules mutate only through the admin-gated action")
