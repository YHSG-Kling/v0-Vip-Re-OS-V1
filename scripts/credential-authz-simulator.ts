// scripts/credential-authz-simulator.ts
//
// CREDENTIAL AUTHORIZATION (data_steward) — provider secrets are broker territory.
//
// platform_credentials holds provider API keys, access tokens and account bindings;
// provider_overrides decides which provider each capability routes through. Two action
// files wrote those tables with no role check at all: settings/integrations.ts had no
// authorization whatsoever on any of its five exports, and onboarding/tech-stack.ts
// verified tenant membership but not privilege — so any producing agent could read,
// overwrite or delete the credentials their whole brokerage runs on. Neither was
// cross-tenant; both were privilege.
//
// This guard is written by SHAPE, not from a list of known-bad files. A list only ever
// proves the list — the identity-self-heal guard passed 21/21 while 81 pages were
// broken for exactly that reason. Any NEW action file that touches a credential table
// without gating on role fails here.

import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"

const ROOT = process.cwd()

let passed = 0
const failures: string[] = []
function check(label: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failures.push(label); console.log(`  ✗ ${label}`) }
}

/** Tables whose rows ARE credentials or credential routing. */
const SECRET_TABLES = [
  "platform_credentials",
  "integration_credentials",
  "agent_api_credentials",
  "provider_overrides",
]

/**
 * Gate helpers that genuinely establish privilege. A file using any of these is
 * considered gated; plain authentication (getUser) is NOT enough, because every
 * offender here authenticated correctly and still let an agent through.
 */
const GATE_MARKERS = [
  // explicit admin gates
  "requireBrokerAdmin",
  "requireBrokerageAdmin",
  "requirePlatformCapability",
  "isPlatformStaff",
  "requireAdminMaintenanceAccess",
  "CREDENTIAL_ADMIN_ROLES",
  "TECH_STACK_ADMIN_ROLES",
  "ADMIN_TYPES",
  // role-derived SCOPING, which is the other legitimate answer: an agent writing
  // their OWN agent-scoped credential needs no admin role, and forcing one would
  // break the thing agents are supposed to do. These files branch on the caller's
  // role to decide agent-scoped vs brokerage-scoped, which is the correct shape.
  "agentScoped",
  "isBrokerageManager",
  "BROKERAGE_ROLES",
]

const walk = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (e.endsWith(".ts") || e.endsWith(".tsx")) out.push(p)
  }
  return out
}

console.log("\n[provider credentials are never writable without a role gate]")
{
  const files = walk(join(ROOT, "app/actions"))
  const offenders: string[] = []

  for (const f of files) {
    const s = readFileSync(f, "utf8")
    if (!/["']use server["']/.test(s)) continue

    // Does it WRITE a secret table? Reads are gated too where they expose secrets,
    // but an unauthorized WRITE is the sharp edge, so that is what fails the build.
    const writesSecret = SECRET_TABLES.some((t) => {
      const re = new RegExp(`from\\(['"]${t}['"]\\)[\\s\\S]{0,400}?\\.(insert|update|upsert|delete)\\(`)
      return re.test(s)
    })
    if (!writesSecret) continue

    // A file is gated if it names a known gate helper OR performs an inline role
    // check — a literal role array tested against the caller's user_type/role. The
    // inline form is common in this codebase (accounting-sync gates disconnectProvider
    // exactly that way), and a marker-name list alone reports it as a false positive.
    const inlineRoleGate =
      /\[[^\]]*["'](?:broker|admin|superadmin|broker_admin)["'][^\]]*\]\s*\.includes\(/.test(s) &&
      /user_type|\brole\b/.test(s)
    const gated = GATE_MARKERS.some((m) => s.includes(m)) || inlineRoleGate
    if (!gated) offenders.push(f.replace(ROOT + "/", ""))
  }

  check(
    `every server action writing a credential table gates on role (${files.length} files scanned)`,
    offenders.length === 0,
  )
  for (const o of offenders) console.log(`      ${o}`)
}

console.log("\n[the two known offenders are actually fixed]")
{
  const integrations = readFileSync(join(ROOT, "app/actions/settings/integrations.ts"), "utf8")
  check("settings/integrations.ts resolves every export through one role gate",
    integrations.includes("CREDENTIAL_ADMIN_ROLES") &&
    (integrations.match(/await getBrokerageId\(supabase\)/g) ?? []).length >= 5)
  check("settings/integrations.ts fails CLOSED on an unknown role",
    /if \(!CREDENTIAL_ADMIN_ROLES\.includes\(resolvedRole\)\) \{[\s\S]{0,120}throw new Error/.test(integrations))

  const techStack = readFileSync(join(ROOT, "app/actions/onboarding/tech-stack.ts"), "utf8")
  check("onboarding/tech-stack.ts routes every export through requireBrokerageAdmin",
    (techStack.match(/requireBrokerageAdmin\(supabase, brokerageId\)/g) ?? []).length >= 5)
  check("onboarding/tech-stack.ts still checks tenant membership as well as role",
    /userData\.brokerage_id !== brokerageId/.test(techStack) &&
    /TECH_STACK_ADMIN_ROLES\.includes\(resolvedRole\)/.test(techStack))
}

console.log("\n──────────────────────────────────────────────────")
console.log(` RESULT: ${passed} passed, ${failures.length} failed`)
if (failures.length) {
  console.log("FAILURES:")
  for (const f of failures) console.log(`  - ${f}`)
  console.log(" ❌ CREDENTIAL_AUTHZ_FAIL")
  process.exit(1)
}
console.log(" ✅ CREDENTIAL_AUTHZ_PASS — provider secrets require broker/admin privilege, not just tenant membership")
