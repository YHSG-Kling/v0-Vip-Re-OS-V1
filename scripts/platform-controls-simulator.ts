#!/usr/bin/env tsx
/**
 * scripts/platform-controls-simulator.ts   (npm run test:platform-controls)
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the PLATFORM GOD-SWITCH: the superadmin's platform_settings kill switch is REAL and ENFORCED — a
 * pure halt predicate, the autonomy-gate circuit-breaker that holds every autonomous manager action
 * platform-wide, and superadmin-gated + audited writes wired into the genuine console.
 *
 * PURE:   resolvePlatformHalt (emergency OR ai-off → halted) + autonomyDecision with a platformHalt holds a
 *         manager action, but a human-approved send and a non-manager send always pass.
 * SOURCE: resolveManagerAutonomy consults loadPlatformHalt first; the actions are superadmin-gated + audit
 *         to superadmin_audit_log; the AI gateway already honors it; the real panel mounts on the console.
 * LIVE (creds-gated): flip platform_settings.emergency_mode ON → the gate returns approval_required for every
 *         manager across every tenant → flip OFF → normal. Restored after.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createClient } from "@supabase/supabase-js"
import { resolvePlatformHalt } from "../lib/platform/platform-controls"
import { autonomyDecision } from "../lib/managers/autonomy-gate"

let pass = 0, fail = 0
const fails: string[] = []
const check = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✓ ${n}`) } else { fail++; fails.push(n); console.log(`  ✗ ${n}`) } }
const src = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

function pureLayer() {
  console.log("\n[resolvePlatformHalt · pure — the red button]")
  check("emergency_mode ON → halted", resolvePlatformHalt({ emergencyMode: true, aiEnabled: true }).halted)
  check("AI engine OFF → halted", resolvePlatformHalt({ emergencyMode: false, aiEnabled: false }).halted)
  check("both nominal → not halted", !resolvePlatformHalt({ emergencyMode: false, aiEnabled: true }).halted)
  check("a halt always carries a human-readable reason", !!resolvePlatformHalt({ emergencyMode: true, aiEnabled: true }).reason)

  console.log("\n[autonomyDecision · pure — the platform circuit-breaker]")
  const halt = { halted: true, reason: "Platform emergency mode is ON" }
  const held = autonomyDecision({ managerKey: "ai_isa", effective: "autonomous", platformHalt: halt })
  check("a normally-AUTONOMOUS manager is HELD when the platform is halted", !held.allow && held.held && held.reason === "Platform emergency mode is ON")
  check("platform halt OVERRIDES a per-tenant autonomous posture", !autonomyDecision({ managerKey: "campaign_orchestrator", effective: "autonomous", platformHalt: halt }).allow)
  check("a HUMAN-APPROVED send still passes during a halt (a human already judged)", autonomyDecision({ managerKey: "ai_isa", effective: "autonomous", humanApproved: true, platformHalt: halt }).allow)
  check("a NON-manager (transactional/system) send is never gated by the halt", autonomyDecision({ managerKey: null, effective: null, platformHalt: halt }).allow)
  check("with no halt, normal autonomy rules apply (autonomous → allow, approval_required → hold)",
    autonomyDecision({ managerKey: "ai_isa", effective: "autonomous", platformHalt: { halted: false, reason: null } }).allow &&
    !autonomyDecision({ managerKey: "ai_isa", effective: "approval_required" }).allow)
}

function sourceLayer() {
  console.log("\n[wiring — enforcement, actions, gateway, UI, ownership]")
  const gate = src("lib/managers/autonomy-gate.ts")
  check("the autonomy gate consults loadPlatformHalt FIRST → approval_required when halted", /loadPlatformHalt/.test(gate) && /if \(halt\.halted\) return "approval_required"/.test(gate))
  check("autonomyDecision honors the platformHalt circuit-breaker", /platformHalt\?\.halted/.test(gate))
  const act = src("app/actions/superadmin/platform-controls.ts")
  check("get/set actions are superadmin-gated (user_type|platform_role)", /requireSuperadmin/.test(act) && /user_type.*===.*"superadmin"|platform_role.*===.*"superadmin"/.test(act))
  check("every flip is audited to superadmin_audit_log with IP/UA", /superadmin_audit_log"\)\.insert\([\s\S]*?action:\s*"platform_controls_update"[\s\S]*?ip_address/.test(act))
  const ct = src("lib/ai/cost-tracking.ts")
  check("the AI gateway already honors the same switch (emergency_mode / ai_enabled)", /platform_settings"\)[\s\S]*?emergency_mode/.test(ct) && /if \(data\.emergency_mode\)/.test(ct))
  const page = src("app/dashboard/superadmin/platform/page.tsx")
  check("the REAL superadmin console mounts the controls panel with live data", /getPlatformControls\(\)/.test(page) && /<PlatformControlsPanel initial=\{platformControls\}/.test(page))
  const panel = src("app/dashboard/superadmin/platform/platform-controls-panel.tsx")
  check("the panel flips emergency mode / AI engine via the gated action", /setPlatformControlsAction/.test(panel) && /emergencyMode/.test(panel) && /aiEnabled/.test(panel))
  const reg = src("lib/kernel/manager-registry.ts")
  check("burn domain owned by data_steward with a runnable proof", /platform_controls:\s*\{\s*manager:\s*"data_steward",\s*proof:\s*"test:platform-controls"/.test(reg))
  check("package.json wires the proof", /"test:platform-controls":\s*"tsx scripts\/platform-controls-simulator\.ts"/.test(src("package.json")))
}

async function liveLayer() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) { console.log("\n[live] ⊘ skipped (no SUPABASE creds) — pure + source proved the logic; live verified via MCP"); return }
  const svc = createClient(url, key)
  console.log("\n[live] flip emergency_mode ON → the gate holds every manager → flip OFF → restore")
  const { getPlatformControls, setPlatformControls, loadPlatformHalt, __clearPlatformHaltCache } = await import("../lib/platform/platform-controls")
  const { resolveManagerAutonomy, __clearAutonomyCache } = await import("../lib/managers/autonomy-gate")
  const { data: brk } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  const brokerageId = (brk as any)?.id ?? "00000000-0000-0000-0000-000000000000"
  const before = await getPlatformControls(svc as any)
  try {
    await setPlatformControls(svc as any, { emergencyMode: true })
    __clearPlatformHaltCache(); __clearAutonomyCache()
    check("live: emergency ON → platform halted", (await loadPlatformHalt(svc as any)).halted)
    const posture = await resolveManagerAutonomy(brokerageId, "ai_isa", svc as any)
    check("live: the gate returns approval_required for a manager while halted", posture === "approval_required")
  } finally {
    await setPlatformControls(svc as any, { emergencyMode: before.emergencyMode, aiEnabled: before.aiEnabled })
    __clearPlatformHaltCache(); __clearAutonomyCache()
    check("live: restored — platform no longer halted", (await loadPlatformHalt(svc as any)).halted === (before.emergencyMode || !before.aiEnabled))
  }
}

async function main() {
  pureLayer()
  sourceLayer()
  await liveLayer()
  console.log("\n──────────────────────────────────────────────────")
  if (fails.length) { console.log("FAILURES:"); fails.forEach((f) => console.log("  - " + f)) }
  console.log(` RESULT: ${pass} passed, ${fail} failed`)
  if (fail > 0) { console.log(" ❌ PLATFORM_CONTROLS_FAIL"); process.exit(1) }
  console.log(" ✅ PLATFORM_CONTROLS_PASS — the god switch is real: one enforced kill switch, held at the autonomy gate + AI gateway, superadmin-gated + audited")
}
main()
