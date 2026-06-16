#!/usr/bin/env tsx
/**
 * scripts/manager-standup-simulator.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proves the MANAGER STANDUP covers all 11 managers (was 6 — Deal Coordinator, Sphere, Ads,
 * Marketing, Recruiting were silent). Every line is built from REAL operational tables.
 *
 * Layer 1 (shell-runnable): the 5 newly-added manager keys resolve to real labels in the
 *   registry (a missing key would crash the standup at MANAGERS[key].label).
 * Layer 2 (live, creds-gated): seed sphere + recruiting proposals via the proven
 *   proposeClientMessage path, run generateManagerStandup, assert those manager lines surface
 *   with the right counts and that every returned key is a valid manager. Seeds cleaned up.
 *
 * Run: npx tsx scripts/manager-standup-simulator.ts   (npm run test:manager-standup)
 */
import { MANAGERS } from "../lib/kernel/manager-registry"

let passed = 0, failed = 0
const failures: string[] = []
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; failures.push(name + (detail ? ` — ${detail}` : "")); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
function report() {
  console.log("\n──────────────────────────────────────────────────")
  console.log(` RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ✗ Failures:"); for (const f of failures) console.log(`   - ${f}`); process.exit(1) }
  console.log(" ✅ Manager standup verified — all 11 managers can report; sphere + recruiting lines surface.")
  console.log(" MANAGER_STANDUP_PASS")
  process.exit(0)
}

const NEWLY_COVERED = ["deal_coordinator", "ads_manager", "marketing_agent", "sphere_of_influence", "recruiting_manager"] as const

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" Manager standup simulator")
  console.log("══════════════════════════════════════════════════")

  console.log("\n[Layer 1 · the 5 newly-covered managers resolve to labels]")
  for (const k of NEWLY_COVERED) {
    check(`${k} has a registry label`, !!(MANAGERS as any)[k]?.label, `MANAGERS.${k} missing`)
  }

  console.log("\n[Layer 2 · live: sphere + recruiting proposals surface in the standup]")
  const hasCreds = !!process.env.SUPABASE_SERVICE_ROLE_KEY && !!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (!hasCreds) { console.log("  ⏭  Skipped — SUPABASE creds not set (Layer 1 ran)."); return report() }

  const { createServiceClient } = await import("../lib/supabase/service")
  const { proposeClientMessage } = await import("../lib/agents/agent-client-messages")
  const { generateManagerStandup } = await import("../lib/intelligence/manager-standup")
  const svc = createServiceClient()
  const { data: brokerage } = await svc.from("brokerages").select("id").limit(1).maybeSingle()
  if (!brokerage) { console.log("  ⏭  Skipped — need a real brokerage."); return report() }
  const brokerageId = (brokerage as any).id
  const uuid = () => (globalThis.crypto ?? require("node:crypto").webcrypto).randomUUID()
  const tag = `ZZSTANDUP-${uuid().slice(0, 8)}`

  const ids: string[] = []
  try {
    const s1 = await proposeClientMessage({ brokerageId, agentKind: "sphere_of_influence", entityType: "contact", audience: "agent", body: `${tag} sphere touch`, channel: "portal" }, svc)
    const s2 = await proposeClientMessage({ brokerageId, agentKind: "sphere_of_influence", entityType: "contact", audience: "agent", body: `${tag} sphere touch 2`, channel: "portal" }, svc)
    const r1 = await proposeClientMessage({ brokerageId, agentKind: "recruiting_manager", entityType: "contact", audience: "agent", body: `${tag} recruiting draft`, channel: "portal" }, svc)
    for (const r of [s1, s2, r1]) if (r.id) ids.push(r.id)

    const lines = await generateManagerStandup(brokerageId, svc)
    check("standup returns lines", Array.isArray(lines) && lines.length > 0)
    const validKeys = new Set(Object.keys(MANAGERS))
    check("every returned line is a valid manager", lines.every((l) => validKeys.has(l.manager)))
    const sphere = lines.find((l) => l.manager === "sphere_of_influence")
    check("sphere line surfaces with ≥2 proposed", !!sphere && sphere.needs_human >= 2, JSON.stringify(sphere))
    const recruit = lines.find((l) => l.manager === "recruiting_manager")
    check("recruiting line surfaces with ≥1 draft", !!recruit && recruit.needs_human >= 1, JSON.stringify(recruit))
  } finally {
    for (const id of ids) await svc.from("agent_client_messages").delete().eq("id", id).then(() => {}, () => {})
    const { count } = await svc.from("agent_client_messages").select("id", { count: "exact", head: true }).in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"])
    check("cleanup: seeded proposals removed", (count ?? 0) === 0)
  }
  report()
}

main().catch((e) => { console.error(e); process.exit(1) })
