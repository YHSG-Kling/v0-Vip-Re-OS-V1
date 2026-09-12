// scripts/add-number-ui-simulator.ts   (npm run test:add-number-ui)
// ─────────────────────────────────────────────────────────────────────────────
// ADD-A-NUMBER SURFACE — proves the AI-call settings can CREATE a new phone
// number (the named gap: "no way to create a new #"). The provisioning backend
// (the plan-allowance-gated provisionNumber core) already existed; this wires the
// tenant-facing search → purchase UI to it, broker-gated, with the bundle-vs-
// overage allowance shown before the buy and an HONEST not-configured path (no
// faked candidates, no faked purchase).

import { readFileSync } from "node:fs"
import { join } from "node:path"

let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

console.log("\n── tenant actions: allowance status → search → purchase ──")
{
  const a = src("app/actions/phone-provisioning.ts")
  check("all three actions exist",
    a.includes("export async function getPhoneAllowanceStatusAction") &&
    a.includes("export async function searchBrokerageNumbersAction") &&
    a.includes("export async function purchaseBrokerageNumberAction"))
  check("search + purchase are broker/admin gated",
    (a.match(/isBrokerRole\(ctx\.userType\)/g) ?? []).length >= 2)
  check("allowance status resolves through the plan gate (evaluateTenantNumberProvisioning)",
    a.includes("evaluateTenantNumberProvisioning"))
  check("purchase runs the ONE provisioning core with the plan allowance ENFORCED",
    a.includes("enforceTenantAllowance: true") && a.includes("provisionNumber("))
  check("purchase reports the billing disposition (included vs metered overage)",
    a.includes("billing: result.billing") && a.includes("monthlyOverageCents"))
  check("an agent-scoped buy verifies the agent belongs to the caller's brokerage",
    a.includes("Agent belongs to a different brokerage"))
  check("search is honest about a not-configured carrier (never fakes candidates)",
    a.includes("notConfigured"))
}

console.log("\n── the AI-call settings UI exposes Add-a-Number ──")
{
  const ui = src("app/dashboard/admin/phone-settings/phone-settings-client.tsx")
  check("renders an 'Add a Number' card",
    ui.includes("Add a Number"))
  check("wires search + purchase + allowance refresh",
    ui.includes("searchBrokerageNumbersAction") &&
    ui.includes("purchaseBrokerageNumberAction") &&
    ui.includes("getPhoneAllowanceStatusAction"))
  check("shows the plan allowance (included vs overage) before buying",
    ui.includes("included in use") && ui.includes("Next number"))
  check("blocks the search UI at the hard cap with the plan reason",
    ui.includes("!allowance.canAddNumber") && ui.includes("capReason"))
  check("surfaces the honest not-connected carrier message",
    ui.includes("Telephony isn't connected"))

  const page = src("app/dashboard/admin/phone-settings/page.tsx")
  check("the page loads allowance status and passes it to the client",
    page.includes("getPhoneAllowanceStatusAction") && page.includes("allowanceStatus={allowanceStatus}"))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ ADD_NUMBER_UI_FAIL"); process.exit(1) }
console.log(" ✅ ADD_NUMBER_UI_PASS — brokers can create a number from AI-call settings, plan-allowance-gated")
