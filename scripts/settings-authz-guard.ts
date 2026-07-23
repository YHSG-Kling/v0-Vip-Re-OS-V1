// scripts/settings-authz-guard.ts   (npm run test:settings-authz)
// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS AUTHZ GUARD — brokerage-wide settings config must never be read or
// written with the RLS-bypassing SERVICE client behind a brokerage_id check
// ALONE. Any settings action that reaches for createServiceClient() must also
// carry a ROLE gate (user_type), or be explicitly exempted with a named reason.
//
// This is the generalized fix for the leak class found in the tier-access sweep:
// list-commission-structures / list-email-templates / update-email-template /
// brokerage-fees.listFeeTypes / global-settings widget-scope all read or wrote
// brokerage-wide config with the service client but gated only by brokerage_id,
// so any plain agent could read/mutate admin config. New ungated service-client
// settings actions now fail CI here.

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}

// Role-gate signals — any ONE proves the file enforces a role, not just brokerage.
const GATE_TOKENS = [
  "isAdminOrBroker", "isBrokerRole", "requireBrokerAdmin", "requireSuperadmin",
  "resolveBrokerAdmin", "principalGate", "isTenancyPrincipal", "CREATE_ROLES",
  "UPDATE_ROLES", "VIEW_ROLES", "user_type",
]

// Files that legitimately use the service client WITHOUT a role gate, each with a
// verified reason (the read is genuinely public/personal, not brokerage-admin config).
const EXEMPT: Record<string, string> = {
  "public-site-links.ts": "reads only PUBLIC slugs/names (the tenant's own public-site URLs)",
}

const dir = join(process.cwd(), "app/actions/settings")
const files = readdirSync(dir).filter((f) => f.endsWith(".ts"))

// brokerage-fees lives outside the settings dir but is the same config class.
const extra = ["app/actions/brokerage-fees.ts"]

console.log("\n── settings actions that use the RLS-bypassing service client must gate by role ──")
const targets: Array<{ label: string; path: string }> = [
  ...files.map((f) => ({ label: f, path: join("app/actions/settings", f) })),
  ...extra.map((p) => ({ label: p.split("/").pop()!, path: p })),
]

for (const t of targets) {
  const body = readFileSync(join(process.cwd(), t.path), "utf8")
  if (!body.includes("createServiceClient")) continue // RLS-respecting client → fine
  if (EXEMPT[t.label]) {
    check(`${t.label} — EXEMPT (${EXEMPT[t.label]})`, true)
    continue
  }
  const gated = GATE_TOKENS.some((tok) => body.includes(tok))
  check(`${t.label} — service-client access carries a role gate`, gated,
    "add a user_type/isAdminOrBroker gate, or add to EXEMPT with a reason")
}

// The shared broker-level gate must admit the live legacy variants (broker_admin
// canonicalizes to broker; super_admin to superadmin), or broker-admins get
// wrongly denied everywhere isAdminOrBroker is used.
console.log("\n── isAdminOrBroker admits the live legacy role variants ──")
{
  const helper = readFileSync(join(process.cwd(), "lib/auth/resolve-user-role.ts"), "utf8")
  check("isAdminOrBroker includes broker_admin", helper.includes("broker_admin"))
  check("isAdminOrBroker includes super_admin", helper.includes("super_admin"))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ SETTINGS_AUTHZ_FAIL"); process.exit(1) }
console.log(" ✅ SETTINGS_AUTHZ_PASS — no brokerage-config action reads/writes via the service client without a role gate")
