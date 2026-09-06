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
import { isAdminOrBroker, TENANT_ADMIN_USER_TYPES } from "../lib/auth/resolve-user-role"

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

// The shared broker-level gate must admit every role the owner calls admin-class,
// or those seats get wrongly denied everywhere isAdminOrBroker is used.
//
// ── THIS BLOCK USED TO PROVE NOTHING, AND WOULD HAVE GONE ON PASSING ────────
//
// It read the helper's SOURCE TEXT and asserted `helper.includes("broker_admin")`
// / `helper.includes("super_admin")`. That is a probe pinned to PROSE: the two
// words appear in that file's comments as well as its code, so the checks passed
// on the strength of the documentation. When `super_admin` was deliberately
// removed from the tenant roster — it is not a storable user_type, and platform
// identity moved to its own gate — the assertion became FALSE while still
// reporting green, because the comment explaining the removal contains the word.
// A check that cannot tell a change from its own changelog is not a check.
//
// Replaced with the BEHAVIOUR. Now the gate itself is asked, so the answer
// changes when the gate changes, whatever anyone writes about it.
console.log("\n── isAdminOrBroker admits the owner's admin-class roster ──")
{
  // DERIVED from the roster, not a five-name copy of it. The copy would not have
  // gone RED when the owner's 2026-09-04 ruling added `compliance_officer` — it
  // only asserts inclusions — but it would have stopped COVERING the new seat,
  // which is the quieter half of the same defect: a proof that keeps passing
  // while the thing it proves grows past it.
  check("POSITIVE CONTROL — the roster is non-empty, so the loop below is not vacuous",
    TENANT_ADMIN_USER_TYPES.size > 0)
  for (const t of [...TENANT_ADMIN_USER_TYPES].sort()) {
    check(`isAdminOrBroker admits '${t}'`, isAdminOrBroker({ user_type: t }))
  }
  // Paired negative control: an assertion that everything is admitted would pass
  // the five above just as happily.
  check("…and still refuses a non-admin seat", !isAdminOrBroker({ user_type: "agent" }))
}

console.log(`\n RESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) { console.log(" ❌ SETTINGS_AUTHZ_FAIL"); process.exit(1) }
console.log(" ✅ SETTINGS_AUTHZ_PASS — no brokerage-config action reads/writes via the service client without a role gate")
