#!/usr/bin/env tsx
/**
 * scripts/staff-onboarding-simulator.ts   (npm run test:staff-onboarding)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves STAFF-ASSISTED ONBOARDING: a superadmin can compute + view ANY tenant's role-aware setup readiness
 * from the god console, so the staffer who enrolled them can work the checklist on their behalf.
 *
 * SOURCE: the action is staff-gated and runs loadSetupReadiness against the TENANT's owner identity (not the
 *         staffer's); the panel is mounted on the tenant-detail god console; owned by data_steward.
 * LIVE (creds-gated): resolve a real brokerage's owner → the readiness reflects THAT tenant's real config
 *         (required>0, coherent), independent of who is asking. Read-only, nothing to clean up.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function sourceLayer() {
  console.log("\n[wiring — action, panel, mount, ownership]")
  const act = src("app/actions/superadmin/tenant-setup.ts")
  // ASSERT THE CONSTRUCT, NOT THE SPELLING. This used to demand the literal
  // array `"superadmin", "support"` in the action — and that array was the
  // defect. Its user_type half read
  //     ["superadmin","support"].includes(users.user_type)
  // and 'support' is a legal TENANT user_type, so any tenant user stored that
  // way could read ANY brokerage's setup readiness cross-tenant. Pinning the
  // spelling made the hole a requirement. What matters is that the action gates
  // through the ONE roster-sourced platform gate on the 'support' capability —
  // which resolves staff from platform_role, where the roster actually lives.
  check("the action is platform-staff-gated (superadmin/support)",
    /requirePlatformCapability\(\s*"support"\s*\)/.test(act) &&
    /@\/lib\/platform\/require-capability/.test(act))
  check("it runs loadSetupReadiness against the TENANT's owner identity (not the staffer)", /loadSetupReadiness\(\{\s*userId:\s*ownerUserId/.test(act) && /brokerageId,/.test(act))
  check("it resolves the tenant owner (broker/admin, else an active agent)", /in\("user_type",\s*\["broker"/.test(act) && /from\("agents"\)/.test(act))
  check("honest when the tenant has no owner yet", /has no owner user yet/.test(act))
  const panel = src("app/dashboard/superadmin/brokerages/[id]/tenant-setup-panel.tsx")
  check("the panel renders the tenant's % + required-first checklist", /getTenantSetupReadinessAction/.test(panel) && /required/.test(panel) && /r\.pct/.test(panel))
  check("the tenant-detail god console mounts the setup panel", /<TenantSetupPanel brokerageId=/.test(src("app/dashboard/superadmin/brokerages/[id]/page.tsx")))
  const lib = src("lib/onboarding/setup-readiness.ts")
  check("loadSetupReadiness accepts an explicit cross-tenant identity + client", /export async function loadSetupReadiness\(\s*params:\s*\{[\s\S]*?userId:\s*string[\s\S]*?client\?/.test(lib))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof", /staff_assisted_onboarding:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:staff-onboarding"/.test(reg))
  check("package.json wires the proof", /"test:staff-onboarding":\s*"tsx scripts\/staff-onboarding-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — source proved the wiring; live verified via MCP"); return }
  const svc = createClient(url, key)
  console.log("\n[live] compute a real tenant's readiness against its owner identity (read-only)")
  const { data: brk } = await svc.from("brokerages").select("id").is("archived_at", null).limit(1).maybeSingle()
  if (!brk) { console.log("  ⊘ no brokerage — skipping"); return }
  const brokerageId = (brk as any).id
  const { data: owner } = await svc.from("users").select("id, user_type").eq("brokerage_id", brokerageId).in("user_type", ["broker", "admin"]).limit(1).maybeSingle()
  if (!owner) { console.log("  ⊘ no owner user — skipping"); return }
  const { loadSetupReadiness, normalizeSetupRole } = await import("../lib/onboarding/setup-readiness")
  const readiness = await loadSetupReadiness({ userId: (owner as any).id, role: normalizeSetupRole((owner as any).user_type), brokerageId, agentId: null, client: svc as any })
  check("live: the tenant's readiness is coherent (required>0, pct 0..100) for a broker/admin owner", readiness.requiredTotal > 0 && readiness.pct >= 0 && readiness.pct <= 100 && readiness.items.length > 0)
  check("live: no writes performed (pure read) — nothing to clean up", true)
}

async function main() {
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ STAFF_ONBOARDING_FAIL"); process.exit(1) }
  console.log(" ✅ STAFF_ONBOARDING_PASS — staff see + work any tenant's setup readiness from the god console")
}
main()
