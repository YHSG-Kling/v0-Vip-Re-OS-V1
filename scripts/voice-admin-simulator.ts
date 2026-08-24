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
import { stripComments } from "./strip-comments"

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
  // ASSERT THE RULE, NOT THE SPELLING (CLAUDE.md §2 — "do not pin an assertion to
  // a WAYPOINT"). This pinned the literal `user_type === "superadmin" ||
  // platform_role === "superadmin"`, so it could only pass while the discriminator
  // was RE-SPELLED at the gate — it went red the moment that duplicate was merged
  // onto the one survivor (owner ruling 1, 2026-08-24), i.e. because the work was
  // FINISHED. The rule is: the gate is superadmin-only AND the superadmin decision
  // is made from BOTH identity columns. The roster module is read too, because
  // pinning only the call would let the survivor decay to one column unnoticed.
  // STRIPPED, NOT RAW. The roster's header quotes the both-columns expression in
  // prose (it is the tombstone §1 requires), so a raw read is satisfied by the
  // COMMENT and stays green while the code decays to one column — proved by
  // mutation, 2026-08-24. CLAUDE.md §2: "a TOMBSTONE IS NOT A CALL SITE".
  const vaRoster = stripComments(src("lib/platform/platform-staff-roster.ts"))
  check("it is SUPERADMIN-gated before executing (BOTH identity columns, via the one definition)",
    /intent === "create_tenant_user"[\s\S]*isPlatformSuperadminIdentity\(profile\.user_type, \(profile as any\)\.platform_role\)/.test(route) &&
    /export function isPlatformSuperadminIdentity\(/.test(vaRoster) &&
    /userType === "superadmin" \|\| platformRole === "superadmin"/.test(vaRoster))
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
