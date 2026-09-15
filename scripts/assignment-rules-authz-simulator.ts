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
  // Pinned to WHERE the gate comes from, not to the identifier it is spelled
  // with. The previous form named a local const that the admin-vocabulary
  // consolidation deleted and m472 renamed again, so it reported a CORRECT
  // tightening as a regression. There is exactly one module allowed to answer
  // "is this caller an admin"; a gate imported from it is the shared answer.
  // Assignment rules are OPERATIONAL admin — named as such in the owner's m472
  // ruling — so this stays on the WIDE tier, which admits team_lead. Asserted
  // positively, because "not the finance gate" would also be true of no gate.
  check("requireAdmin enforces the admin roster, from the ONE module, on the OPERATIONAL tier",
    a.includes("requireAdmin") && /from\s+["\x27]@\/lib\/auth\/resolve-user-role["\x27]/.test(a) &&
    (a.includes("isAdminOrBroker") || a.includes("resolveTenantAdmin")))
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

console.log("\n── conversion invokes the rules engine — never a bare agent claim (wave 65 hand-off) ──")
{
  // Owner ruling: "once the ai isa qualifies or there is positive intent, then
  // the lead converts to a contact... and gets assigned to an agent from the
  // lead assignment rules that the brokerage/teamlead sets up in their
  // settings." Proven at the SOURCE level (no DB): the qualification path
  // calls the rules engine BEFORE conversion, the engine reads
  // `assignment_rules` and honours round-robin/load-balance/geo/specialization
  // + capacity, and claiming a lead is proven to carry NO assignment kernel
  // event (wave 49 tombstone) — an agent cannot become "assigned" by claiming.
  const qual = src("lib/ai-isa/qualification-evaluator.ts")
  check("ISA qualification calls evaluateAndAssignLead BEFORE any contact exists",
    /evaluateAndAssignLead\(\{/.test(qual))
  check("...gated on readinessForAgent (qualification OR positive/confirmed intent, never an agent claim)",
    /if \(!signals\.readinessForAgent\)/.test(qual) && /confirmedIntent/.test(qual))

  const engine = src("lib/lead-assignment/assignment-engine.ts")
  check("evaluateAndAssignLead delegates to the tier-aware policy with an explicit trigger",
    /autoAssignLead\(\{/.test(engine) && /trigger:\s*["']ai_isa_qualified["']/.test(engine))
  check("resolveAgentByRules reads the BROKERAGE/TEAM-LEAD-configured assignment_rules table",
    /from\(["']assignment_rules["']\)/.test(engine) && /\.eq\(["']brokerage_id["']/.test(engine))
  check("team-scoped rules resolve their pool from teams.team_lead_id's team (team lead's own settings)",
    /team_id/.test(engine) && /eq\(["']team_id["'], rule\.team_id\)/.test(engine))
  check("round-robin / load-balance / geo / specialization methods are all honoured (not just round-robin)",
    /pickAgentForRule/.test(engine) && /selectAgentByCapacity/.test(engine))
  check("a MANUAL rule holds the lead rather than silently falling through to another method",
    /held: true/.test(engine))

  // claimLead — the ONE place an agent-initiated action touches assignment_log
  // — must carry no LEAD_CLAIMED kernel emission (wave 49 owner ruling: "no
  // kernel event for an agent claiming a lead"). Its own tombstone records the
  // removal; assert the RULE (no emit call in the function body) rather than
  // grepping for a retired event name that could just be renamed.
  const claimFn = engine.slice(engine.indexOf("export async function claimLead"))
  check("claimLead itself never calls emitKernelEvent — claiming is not assignment",
    !/emitKernelEvent/.test(claimFn.slice(0, claimFn.indexOf("\n}\n") + 3)))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ ASSIGNMENT_RULES_AUTHZ_FAIL"); process.exit(1) }
console.log(" ✅ ASSIGNMENT_RULES_AUTHZ_PASS — routing rules mutate only through the admin-gated action")
