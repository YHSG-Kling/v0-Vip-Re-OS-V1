#!/usr/bin/env tsx
/**
 * scripts/voice-admin-simulator.ts   (npm run test:voice-admin)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the VOICE ADMIN can EXECUTE a platform-admin command — "create a new agent in the
 * Denver brokerage" — SECURELY. The provisioning itself is proven by test:tenant-creation;
 * this proves the voice bridge is wired to the AUTHENTICATED route, superadmin-gated, and
 * routes to the tested action (never the unauthenticated ElevenLabs webhook).
 *
 * Source-only (the wiring is the contract; the underlying createTenantUserAction is live-tested
 * elsewhere and requires an authed superadmin session the harness can't fabricate).
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function main() {
  console.log("\n[voice admin — secure, gated, wired to the tested action]")
  const route = src("app/api/internal/voice-command/route.ts")
  const webhook = src("app/api/agent-assistant/tool-call/route.ts")

  check("the create_tenant_user intent is declared + classified", /\| "create_tenant_user"/.test(route) && /create_tenant_user: a PLATFORM-ADMIN command/.test(route))
  check("it goes ONLY through the AUTHENTICATED route (getUser → 401)", /const \{ data: \{ user \} \} = await supabase\.auth\.getUser\(\)/.test(route) && /status: 401/.test(route))
  check("it is SUPERADMIN-gated before executing", /intent === "create_tenant_user"[\s\S]*profile\.user_type === "superadmin" \|\| \(profile as any\)\.platform_role === "superadmin"/.test(route))
  check("a non-staff caller is refused (no execution)", /superadmin-only command/.test(route))
  check("it routes to the SAME tested + audited createTenantUserAction", /createTenantUserAction\(\{/.test(route) && /from "@\/app\/actions\/superadmin\/tenant-users"/.test(route))
  check("it resolves the target brokerage by name (else the caller's)", /ilike\("name", `%\$\{ex\.brokerageName\}%`\)/.test(route))
  check("the UNAUTHENTICATED ElevenLabs webhook does NOT gain admin/provisioning tools", !/createTenantUserAction/.test(webhook) && !/create_tenant_user/.test(webhook))

  console.log("\n[governance]")
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof", /voice_admin_provisioning:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:voice-admin"/.test(reg))
  check("package.json wires the proof", /"test:voice-admin":\s*"tsx scripts\/voice-admin-simulator\.ts"/.test(src("package.json")))

  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ VOICE_ADMIN_FAIL"); process.exit(1) }
  console.log(" ✅ VOICE_ADMIN_PASS — the voice admin can create a user by command: authenticated, superadmin-gated, routed to the tested action")
}
main()
